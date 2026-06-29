import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentDriver } from "../../src/agents/driver.js";

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
        model: "claude-3-5-sonnet-latest",
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
        model: "gpt-5-codex",
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
});
