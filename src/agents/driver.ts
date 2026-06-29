import { mkdir, readFile } from "node:fs/promises";
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
import type { AgentDriver, AgentName, FixIssueResult, Issue, ReviewContext } from "./types.js";
import { execOk, type ExecFn } from "../exec.js";

export type CreateAgentDriverOptions = {
  agent: AgentName;
  exec: ExecFn;
  outputDir: string;
};

export function defaultModelForAgent(agent: AgentName): string {
  if (agent === "codex") {
    return process.env.MENDR_CODEX_MODEL ?? "gpt-5-codex";
  }

  return process.env.MENDR_CLAUDE_MODEL ?? "claude-3-5-sonnet-latest";
}

export function createAgentDriver(options: CreateAgentDriverOptions): AgentDriver {
  if (options.agent === "codex") {
    return new CodexAgentDriver(options.exec, options.outputDir);
  }

  return new ClaudeAgentDriver(options.exec);
}

class ClaudeAgentDriver implements AgentDriver {
  constructor(private readonly exec: ExecFn) {}

  async review(ctx: ReviewContext): Promise<Issue[]> {
    const invocation = buildClaudeReviewInvocation(ctx);
    const result = await execOk(this.exec, invocation.command, invocation.args, {
      cwd: ctx.repo
    });

    return parseClaudeIssues(result.stdout);
  }

  async fix(issues: Issue[], ctx: ReviewContext): Promise<FixIssueResult[]> {
    const invocation = buildClaudeFixInvocation(issues, ctx);
    const result = await execOk(this.exec, invocation.command, invocation.args, {
      cwd: ctx.repo
    });

    return parseClaudeFixResults(result.stdout);
  }
}

class CodexAgentDriver implements AgentDriver {
  private outputIndex = 0;

  constructor(
    private readonly exec: ExecFn,
    private readonly outputDir: string
  ) {}

  async review(ctx: ReviewContext): Promise<Issue[]> {
    const outputFile = await this.nextOutputFile("review");
    const invocation = buildCodexReviewInvocation(ctx, { outputFile });

    await execOk(this.exec, invocation.command, invocation.args, { cwd: ctx.repo });

    return parseCodexIssues(await readFile(outputFile, "utf8"));
  }

  async fix(issues: Issue[], ctx: ReviewContext): Promise<FixIssueResult[]> {
    const outputFile = await this.nextOutputFile("fix");
    const invocation = buildCodexFixInvocation(issues, ctx, { outputFile });

    await execOk(this.exec, invocation.command, invocation.args, { cwd: ctx.repo });

    return parseCodexFixResults(await readFile(outputFile, "utf8"));
  }

  private async nextOutputFile(kind: "review" | "fix"): Promise<string> {
    await mkdir(this.outputDir, { recursive: true });
    this.outputIndex += 1;

    return join(this.outputDir, `codex-${kind}-${this.outputIndex}.json`);
  }
}
