import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildClaudeFixInvocation,
  buildClaudeReviewInvocation,
  parseClaudeFixResults,
  parseClaudeIssues
} from "../../src/agents/claude.js";
import {
  buildFixPrompt,
  buildFixSystemPrompt,
  buildReviewPrompt,
  buildReviewSystemPrompt
} from "../../src/agents/prompts.js";
import { AgentParseError } from "../../src/agents/types.js";

const issue = {
  title: "Validate PR URLs",
  file: "src/cli.ts",
  line: 44,
  severity: "medium",
  description: "The parser accepts malformed pull request URLs."
};

const fixResult = {
  title: "Validate PR URLs",
  fingerprint:
    "validate pr urls|src/cli.ts|44|the parser accepts malformed pull request urls.",
  status: "fixed",
  sha: "abc1234",
  commitMessage: [
    "fix(cli): validate pull request urls",
    "",
    "- Rejects malformed pull request URLs before review setup",
    "- Covers parser behavior for invalid GitHub PR inputs"
  ].join("\n"),
  summary:
    "Tightened pull request URL parsing. Added coverage for malformed GitHub pull request URLs."
};

const reviewContext = {
  repo: "/work/mendr",
  pr: "42",
  model: "claude-opus-4-8",
  effort: "high" as const,
  diff: "diff --git a/src/cli.ts b/src/cli.ts",
  reviewMarkdown: "# PR 42\n\nBody text.",
  reportMarkdown: "## Summary by Mendr\n\n### Resolved Issues\n\n#### Already fixed\n**Commit:** `abc1234`"
};

describe("Claude agent driver", () => {
  it("parses a clean JSON issue array from the result field", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: JSON.stringify([issue])
    });

    expect(parseClaudeIssues(envelope)).toEqual([issue]);
  });

  it("parses a raw JSON issue array when Claude omits the result envelope", () => {
    expect(parseClaudeIssues(JSON.stringify([issue]))).toEqual([issue]);
  });

  it("extracts a fenced JSON issue array wrapped in prose", async () => {
    const fixture = await readFile(
      join(process.cwd(), "test/fixtures/agent-io/claude-review-fenced.json"),
      "utf8"
    );

    expect(parseClaudeIssues(fixture)).toEqual([issue]);
  });

  it("returns an empty issue list without error", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "No changed-scope issues.\n\n[]"
    });

    expect(parseClaudeIssues(envelope)).toEqual([]);
  });

  it("throws AgentParseError when no JSON can be extracted", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "No structured payload here."
    });

    expect(AgentParseError).toBeTypeOf("function");
    expect(AgentParseError.name).toBe("AgentParseError");
    expect(() => parseClaudeIssues(envelope)).toThrow(AgentParseError);
  });

  it("parses fix results from the result field", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: JSON.stringify([fixResult])
    });

    expect(parseClaudeFixResults(envelope)).toEqual([fixResult]);
  });

  it("parses raw JSON fix result arrays when Claude omits the result envelope", () => {
    expect(parseClaudeFixResults(JSON.stringify([fixResult]))).toEqual([fixResult]);
  });

  it("throws AgentParseError when Claude fix output has no result payload", () => {
    const envelope = JSON.stringify({
      type: "assistant",
      message: "No structured payload here."
    });

    expect(() => parseClaudeFixResults(envelope)).toThrow(AgentParseError);
  });

  it("builds the documented one-shot Claude review invocation", () => {
    const invocation = buildClaudeReviewInvocation(reviewContext);
    const promptIndex = invocation.args.indexOf("-p") + 1;
    const prompt = invocation.args[promptIndex];

    expect(invocation.command).toBe("claude");
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "-p",
        expect.any(String),
        "--output-format",
        "json",
        "--model",
        reviewContext.model,
        "--effort",
        reviewContext.effort,
        "--permission-mode",
        "acceptEdits",
        "--add-dir",
        reviewContext.repo
      ])
    );
    expect(invocation.args).not.toEqual(expect.arrayContaining(["--continue", "--resume"]));
    expect(invocation.args).toEqual(
      expect.arrayContaining(["--append-system-prompt", buildReviewSystemPrompt()])
    );
    expect(prompt).toBe(buildReviewPrompt(reviewContext));
    expect(prompt).toContain("security issues");
    expect(prompt).not.toContain("changed-scope bugs");
    expect(prompt).toContain("specific enough to stand alone in the final summary");
    expect(prompt).toContain("exactly two concise sentences for each issue description");
    expect(prompt).toContain(reviewContext.diff);
    expect(prompt).toContain(reviewContext.reportMarkdown);
  });

  it("builds the documented one-shot Claude fix invocation from the shared prompt", () => {
    const invocation = buildClaudeFixInvocation([issue], reviewContext);
    const promptIndex = invocation.args.indexOf("-p") + 1;
    const prompt = invocation.args[promptIndex];

    expect(invocation.command).toBe("claude");
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "-p",
        expect.any(String),
        "--output-format",
        "json",
        "--model",
        reviewContext.model,
        "--effort",
        reviewContext.effort,
        "--permission-mode",
        "acceptEdits",
        "--add-dir",
        reviewContext.repo
      ])
    );
    expect(invocation.args).not.toEqual(expect.arrayContaining(["--continue", "--resume"]));
    expect(invocation.args).toEqual(
      expect.arrayContaining(["--append-system-prompt", buildFixSystemPrompt()])
    );
    expect(prompt).toBe(buildFixPrompt([issue], reviewContext));
    expect(prompt).toContain("fixer agent");
    expect(prompt).toContain("Do not create commits");
    expect(prompt).toContain("\"commitMessage\"");
    expect(prompt).toContain("mendr will stage, commit with your commitMessage");
    expect(prompt).not.toContain("sha\":\"commit sha");
  });
});
