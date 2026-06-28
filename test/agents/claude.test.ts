import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildClaudeReviewInvocation, parseClaudeIssues } from "../../src/agents/claude.js";
import { AgentParseError } from "../../src/agents/types.js";

const issue = {
  title: "Validate PR URLs",
  file: "src/cli.ts",
  line: 44,
  severity: "medium",
  description: "The parser accepts malformed pull request URLs."
};

const reviewContext = {
  repo: "/work/mendr",
  pr: "42",
  model: "claude-3-5-sonnet-latest",
  diff: "diff --git a/src/cli.ts b/src/cli.ts",
  reviewMarkdown: "# PR 42\n\nBody text.",
  reportMarkdown: "## Summary\n- Issue: Already fixed\n- Resolved by: abc1234"
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

  it("builds the documented one-shot Claude review invocation", () => {
    const invocation = buildClaudeReviewInvocation(reviewContext);
    const promptIndex = invocation.args.indexOf("-p") + 1;
    const systemPromptIndex = invocation.args.indexOf("--append-system-prompt") + 1;
    const prompt = invocation.args[promptIndex];
    const systemPrompt = invocation.args[systemPromptIndex];

    expect(invocation.command).toBe("claude");
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "-p",
        expect.any(String),
        "--output-format",
        "json",
        "--model",
        reviewContext.model,
        "--permission-mode",
        "acceptEdits",
        "--add-dir",
        reviewContext.repo,
        "--append-system-prompt",
        expect.any(String)
      ])
    );
    expect(invocation.args).not.toEqual(expect.arrayContaining(["--continue", "--resume"]));
    expect(systemPrompt).toContain("review agent");
    expect(systemPrompt).toContain("respond ONLY with JSON");
    expect(prompt).toContain(reviewContext.diff);
    expect(prompt).toContain(reviewContext.reportMarkdown);
  });
});
