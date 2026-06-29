import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildClaudeFixInvocation,
  buildClaudeReviewInvocation,
  parseClaudeFixResults,
  parseClaudeIssues
} from "./claude.js";
import {
  buildCodexFixInvocation,
  buildCodexReviewInvocation,
  parseCodexFixResults,
  parseCodexIssues
} from "./codex.js";
import type {
  AgentDriver,
  AgentInvocation,
  AgentName,
  EffortLevel,
  FixIssueResult,
  Issue,
  ReviewContext
} from "./types.js";
import { CommandFailedError, type ExecFn, type ExecResult } from "../exec.js";

export type CreateAgentDriverOptions = {
  agent: AgentName;
  exec: ExecFn;
  outputDir: string;
};

const codexEfforts = ["low", "medium", "high", "xhigh"] as const;
const claudeEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
const defaultAgentTimeoutMs = 10 * 60 * 1000;

export function defaultModelForAgent(agent: AgentName): string {
  if (agent === "codex") {
    return process.env.MENDR_CODEX_MODEL ?? "gpt-5.5";
  }

  return process.env.MENDR_CLAUDE_MODEL ?? "claude-opus-4-8";
}

export function defaultEffortForAgent(agent: AgentName): EffortLevel {
  const effort =
    agent === "codex" ? process.env.MENDR_CODEX_EFFORT : process.env.MENDR_CLAUDE_EFFORT;

  if (effort) {
    if (isEffortForAgent(agent, effort)) {
      return effort;
    }

    throw new Error(
      `Invalid ${agent} effort "${effort}". Expected one of: ${allowedEffortsForAgent(agent).join(", ")}.`
    );
  }

  return agent === "codex" ? "xhigh" : "high";
}

export function allowedEffortsForAgent(agent: AgentName): readonly EffortLevel[] {
  return agent === "codex" ? codexEfforts : claudeEfforts;
}

export function isEffortForAgent(agent: AgentName, effort: string): effort is EffortLevel {
  return (allowedEffortsForAgent(agent) as readonly string[]).includes(effort);
}

export function agentTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const rawTimeout = env.MENDR_AGENT_TIMEOUT_MS;

  if (rawTimeout === undefined) {
    return defaultAgentTimeoutMs;
  }

  const timeout = Number(rawTimeout);

  if (!Number.isInteger(timeout) || timeout < 0) {
    throw new Error("Invalid MENDR_AGENT_TIMEOUT_MS. Expected a non-negative integer.");
  }

  return timeout === 0 ? undefined : timeout;
}

export function createAgentDriver(options: CreateAgentDriverOptions): AgentDriver {
  if (options.agent === "codex") {
    return new CodexAgentDriver(options.exec, options.outputDir);
  }

  return new ClaudeAgentDriver(options.exec, options.outputDir);
}

class ClaudeAgentDriver implements AgentDriver {
  private outputIndex = 0;

  constructor(
    private readonly exec: ExecFn,
    private readonly outputDir: string
  ) {}

  async review(ctx: ReviewContext): Promise<Issue[]> {
    const label = this.nextLabel("claude", "review");
    const invocation = buildClaudeReviewInvocation(ctx);
    const result = await runAgentInvocation(this.exec, invocation, {
      cwd: ctx.repo,
      outputDir: this.outputDir,
      label
    });

    return parseClaudeIssues(result.stdout);
  }

  async fix(issues: Issue[], ctx: ReviewContext): Promise<FixIssueResult[]> {
    const label = this.nextLabel("claude", "fix");
    const invocation = buildClaudeFixInvocation(issues, ctx);
    const result = await runAgentInvocation(this.exec, invocation, {
      cwd: ctx.repo,
      outputDir: this.outputDir,
      label
    });

    return parseClaudeFixResults(result.stdout);
  }

  private nextLabel(agent: AgentName, kind: "review" | "fix"): string {
    this.outputIndex += 1;

    return `${agent}-${kind}-${this.outputIndex}`;
  }
}

class CodexAgentDriver implements AgentDriver {
  private outputIndex = 0;

  constructor(
    private readonly exec: ExecFn,
    private readonly outputDir: string
  ) {}

  async review(ctx: ReviewContext): Promise<Issue[]> {
    const label = this.nextLabel("codex", "review");
    const outputFile = await this.outputFile(label);
    const invocation = buildCodexReviewInvocation(ctx, { outputFile });
    const result = await runAgentInvocation(this.exec, invocation, {
      cwd: ctx.repo,
      outputDir: this.outputDir,
      label
    });
    const finalMessage = await readFile(outputFile, "utf8");

    await writeAgentIo(this.outputDir, label, result, {
      "final-message.md": finalMessage
    });

    return parseCodexIssues(finalMessage);
  }

  async fix(issues: Issue[], ctx: ReviewContext): Promise<FixIssueResult[]> {
    const label = this.nextLabel("codex", "fix");
    const outputFile = await this.outputFile(label);
    const invocation = buildCodexFixInvocation(issues, ctx, { outputFile });
    const result = await runAgentInvocation(this.exec, invocation, {
      cwd: ctx.repo,
      outputDir: this.outputDir,
      label
    });
    const finalMessage = await readFile(outputFile, "utf8");

    await writeAgentIo(this.outputDir, label, result, {
      "final-message.md": finalMessage
    });

    return parseCodexFixResults(finalMessage);
  }

  private nextLabel(agent: AgentName, kind: "review" | "fix"): string {
    this.outputIndex += 1;

    return `${agent}-${kind}-${this.outputIndex}`;
  }

  private async outputFile(label: string): Promise<string> {
    await mkdir(this.outputDir, { recursive: true });

    return join(this.outputDir, `${label}.final-message.md`);
  }
}

async function runAgentInvocation(
  exec: ExecFn,
  invocation: AgentInvocation,
  options: {
    cwd: string;
    outputDir: string;
    label: string;
  }
): Promise<ExecResult> {
  const stdoutFile = join(options.outputDir, `${options.label}.stdout.log`);
  const stderrFile = join(options.outputDir, `${options.label}.stderr.log`);
  const result = await exec(invocation.command, invocation.args, {
    cwd: options.cwd,
    timeoutMs: agentTimeoutMs(),
    stdoutFile,
    stderrFile
  });

  await writeAgentIo(options.outputDir, options.label, result);

  if (result.exitCode !== 0) {
    throw new CommandFailedError(invocation.command, invocation.args, result);
  }

  return result;
}

async function writeAgentIo(
  outputDir: string,
  label: string,
  result: ExecResult,
  extraFiles: Record<string, string> = {}
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, `${label}.stdout.log`), result.stdout, "utf8"),
    writeFile(join(outputDir, `${label}.stderr.log`), result.stderr, "utf8"),
    ...Object.entries(extraFiles).map(([suffix, content]) =>
      writeFile(join(outputDir, `${label}.${suffix}`), content, "utf8")
    )
  ]);
}
