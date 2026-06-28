import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildCodexReviewInvocation, parseCodexIssues } from "../../src/agents/codex";
import { AgentParseError } from "../../src/agents/types";

const issue = {
  title: "Preserve report context",
  file: "src/orchestrator.ts",
  line: 88,
  severity: "high",
  description: "The next review round must receive the updated report markdown."
};

const reviewContext = {
  repo: "/work/mendr",
  pr: "42",
  model: "gpt-5-codex",
  diff: "diff --git a/src/orchestrator.ts b/src/orchestrator.ts",
  reviewMarkdown: "# PR 42\n\nBody text.",
  reportMarkdown: "## Summary\n- Issue: Already fixed\n- Resolved by: abc1234"
};

describe("Codex agent driver", () => {
  it("parses a clean JSON issue array from the final message", () => {
    expect(parseCodexIssues(JSON.stringify([issue]))).toEqual([issue]);
  });

  it("extracts a fenced JSON issue array wrapped in prose", async () => {
    const fixture = await readFile(
      join(process.cwd(), "test/fixtures/agent-io/codex-review-prose.md"),
      "utf8"
    );

    expect(parseCodexIssues(fixture)).toEqual([issue]);
  });

  it("returns an empty issue list without error", () => {
    expect(parseCodexIssues("No changed-scope issues.\n\n[]")).toEqual([]);
  });

  it("throws AgentParseError when no JSON can be extracted", () => {
    expect(AgentParseError).toBeTypeOf("function");
    expect(AgentParseError.name).toBe("AgentParseError");
    expect(() => parseCodexIssues("No structured payload here.")).toThrow(AgentParseError);
  });

  it("builds the documented one-shot Codex review invocation", () => {
    const outputFile = "/tmp/mendr-codex-final-message.json";
    const invocation = buildCodexReviewInvocation(reviewContext, { outputFile });
    const prompt = invocation.args[1];

    expect(invocation.command).toBe("codex");
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "exec",
        expect.any(String),
        "-m",
        reviewContext.model,
        "--sandbox",
        "workspace-write",
        "-C",
        reviewContext.repo,
        "--output-last-message",
        outputFile
      ])
    );
    expect(invocation.args).not.toEqual(expect.arrayContaining(["--continue", "--resume"]));
    expect(prompt).toContain("review agent");
    expect(prompt).toContain("respond ONLY with JSON");
    expect(prompt).toContain(reviewContext.diff);
    expect(prompt).toContain(reviewContext.reportMarkdown);
  });
});
