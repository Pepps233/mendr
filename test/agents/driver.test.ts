import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentTimeoutMs,
  defaultEffortForAgent,
  defaultModelForAgent,
  createAgentDriver
} from "../../src/agents/driver.js";

const tmpRoots: string[] = [];

const issue = {
  title: "Persist agent IO",
  file: "src/agents/driver.ts",
  line: 12,
  severity: "medium",
  description: "Agent stdout and stderr should be saved for debugging."
};

async function makeOutputDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mendr-agent-driver-"));
  tmpRoots.push(root);

  return root;
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("agent defaults", () => {
  it("uses requested default models and efforts", () => {
    const env = snapshotAgentEnv();

    try {
      clearAgentEnv();

      expect(defaultModelForAgent("codex")).toBe("gpt-5.5");
      expect(defaultEffortForAgent("codex")).toBe("xhigh");
      expect(defaultModelForAgent("claude")).toBe("claude-opus-4-8");
      expect(defaultEffortForAgent("claude")).toBe("high");
      expect(agentTimeoutMs()).toBe(600000);
    } finally {
      restoreAgentEnv(env);
    }
  });

  it("honors model and effort environment overrides", () => {
    const env = snapshotAgentEnv();

    try {
      process.env.MENDR_CODEX_MODEL = "gpt-5.4";
      process.env.MENDR_CODEX_EFFORT = "medium";
      process.env.MENDR_CLAUDE_MODEL = "sonnet";
      process.env.MENDR_CLAUDE_EFFORT = "xhigh";
      process.env.MENDR_AGENT_TIMEOUT_MS = "30000";

      expect(defaultModelForAgent("codex")).toBe("gpt-5.4");
      expect(defaultEffortForAgent("codex")).toBe("medium");
      expect(defaultModelForAgent("claude")).toBe("sonnet");
      expect(defaultEffortForAgent("claude")).toBe("xhigh");
      expect(agentTimeoutMs()).toBe(30000);
    } finally {
      restoreAgentEnv(env);
    }
  });
});

describe("agent driver IO logging", () => {
  it("writes Claude stdout and stderr logs", async () => {
    const outputDir = await makeOutputDir();
    const driver = createAgentDriver({
      agent: "claude",
      outputDir,
      exec: async () => ({
        stdout: JSON.stringify({
          result: JSON.stringify([issue])
        }),
        stderr: "claude warning",
        exitCode: 0
      })
    });

    await expect(
      driver.review({
        repo: "/work/mendr",
        pr: "42",
        model: "claude-opus-4-8",
        effort: "high",
        diff: "diff",
        reviewMarkdown: "# PR",
        reportMarkdown: "## Summary"
      })
    ).resolves.toEqual([issue]);

    await expect(readFile(join(outputDir, "claude-review-1.stdout.log"), "utf8")).resolves.toContain(
      "Persist agent IO"
    );
    await expect(readFile(join(outputDir, "claude-review-1.stderr.log"), "utf8")).resolves.toContain(
      "claude warning"
    );
  });

  it("writes Codex stdout, stderr, and final message logs", async () => {
    const outputDir = await makeOutputDir();
    const driver = createAgentDriver({
      agent: "codex",
      outputDir,
      exec: async (_command, args) => {
        const outputFile = args[args.indexOf("--output-last-message") + 1];

        await writeFile(outputFile, JSON.stringify([issue]), "utf8");

        return {
          stdout: "codex stdout",
          stderr: "codex stderr",
          exitCode: 0
        };
      }
    });

    await expect(
      driver.review({
        repo: "/work/mendr",
        pr: "42",
        model: "gpt-5.5",
        effort: "xhigh",
        diff: "diff",
        reviewMarkdown: "# PR",
        reportMarkdown: "## Summary"
      })
    ).resolves.toEqual([issue]);

    await expect(readFile(join(outputDir, "codex-review-1.stdout.log"), "utf8")).resolves.toBe(
      "codex stdout"
    );
    await expect(readFile(join(outputDir, "codex-review-1.stderr.log"), "utf8")).resolves.toBe(
      "codex stderr"
    );
    await expect(
      readFile(join(outputDir, "codex-review-1.final-message.md"), "utf8")
    ).resolves.toContain("Persist agent IO");
  });

  it("records partial agent output when an invocation times out", async () => {
    const env = snapshotAgentEnv();
    const outputDir = await makeOutputDir();

    try {
      process.env.MENDR_AGENT_TIMEOUT_MS = "50";

      const driver = createAgentDriver({
        agent: "claude",
        outputDir,
        exec: async (_command, _args, options) => {
          expect(options).toMatchObject({
            cwd: "/work/mendr",
            timeoutMs: 50,
            stdoutFile: join(outputDir, "claude-review-1.stdout.log"),
            stderrFile: join(outputDir, "claude-review-1.stderr.log")
          });

          return {
            stdout: "partial stdout before timeout",
            stderr: "",
            exitCode: 124,
            timedOut: true
          };
        }
      });

      await expect(
        driver.review({
          repo: "/work/mendr",
          pr: "42",
          model: "claude-opus-4-8",
          effort: "high",
          diff: "diff",
          reviewMarkdown: "# PR",
          reportMarkdown: "## Summary"
        })
      ).rejects.toThrow(/timed out/i);

      await expect(
        readFile(join(outputDir, "claude-review-1.stdout.log"), "utf8")
      ).resolves.toBe("partial stdout before timeout");
      await expect(
        readFile(join(outputDir, "claude-review-1.stderr.log"), "utf8")
      ).resolves.toBe("");
    } finally {
      restoreAgentEnv(env);
    }
  });
});

function snapshotAgentEnv(): Record<string, string | undefined> {
  return {
    MENDR_CODEX_MODEL: process.env.MENDR_CODEX_MODEL,
    MENDR_CODEX_EFFORT: process.env.MENDR_CODEX_EFFORT,
    MENDR_CLAUDE_MODEL: process.env.MENDR_CLAUDE_MODEL,
    MENDR_CLAUDE_EFFORT: process.env.MENDR_CLAUDE_EFFORT,
    MENDR_AGENT_TIMEOUT_MS: process.env.MENDR_AGENT_TIMEOUT_MS
  };
}

function clearAgentEnv(): void {
  delete process.env.MENDR_CODEX_MODEL;
  delete process.env.MENDR_CODEX_EFFORT;
  delete process.env.MENDR_CLAUDE_MODEL;
  delete process.env.MENDR_CLAUDE_EFFORT;
  delete process.env.MENDR_AGENT_TIMEOUT_MS;
}

function restoreAgentEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
