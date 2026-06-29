import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCodexFixInvocation,
  buildCodexReviewInvocation,
  parseCodexFixResults,
  parseCodexIssues
} from "../../src/agents/codex.js";
import { buildFixPrompt, buildReviewPrompt } from "../../src/agents/prompts.js";
import { AgentParseError } from "../../src/agents/types.js";

const issue = {
  title: "Preserve report context",
  file: "src/orchestrator.ts",
  line: 88,
  severity: "high",
  description: "The next review round must receive the updated report markdown."
};

const fixResult = {
  title: "Preserve report context",
  fingerprint:
    "preserve report context|src/orchestrator.ts|88|the next review round must receive the updated report markdown.",
  status: "fixed",
  sha: "def5678",
  commitMessage: [
    "fix(orchestrator): pass report context",
    "",
    "- Threads report markdown into the next review context",
    "- Covers multi-round context handoff"
  ].join("\n"),
  summary:
    "Threaded report markdown into the next review context. Added coverage for multi-round context handoff."
};

const reviewContext = {
  repo: "/work/mendr",
  pr: "42",
  model: "gpt-5.5",
  effort: "xhigh" as const,
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

  it("parses fix results from the final message", () => {
    expect(parseCodexFixResults(JSON.stringify([fixResult]))).toEqual([fixResult]);
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
        "-c",
        `model_reasoning_effort=${JSON.stringify(reviewContext.effort)}`,
        "--sandbox",
        "workspace-write",
        "--json",
        "-C",
        reviewContext.repo,
        "--output-last-message",
        outputFile
      ])
    );
    expect(invocation.args).not.toEqual(expect.arrayContaining(["--continue", "--resume"]));
    expect(prompt).toBe(buildReviewPrompt(reviewContext));
    expect(prompt).toContain("review agent");
    expect(prompt).toContain("security issues");
    expect(prompt).not.toContain("changed-scope bugs");
    expect(prompt).toContain("respond ONLY with JSON");
    expect(prompt).toContain(reviewContext.diff);
    expect(prompt).toContain(reviewContext.reportMarkdown);
  });

  it("builds the documented one-shot Codex fix invocation from the shared prompt", () => {
    const outputFile = "/tmp/mendr-codex-final-message.json";
    const invocation = buildCodexFixInvocation([issue], reviewContext, { outputFile });
    const prompt = invocation.args[1];

    expect(invocation.command).toBe("codex");
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "exec",
        expect.any(String),
        "-m",
        reviewContext.model,
        "-c",
        `model_reasoning_effort=${JSON.stringify(reviewContext.effort)}`,
        "--sandbox",
        "workspace-write",
        "--json",
        "-C",
        reviewContext.repo,
        "--output-last-message",
        outputFile
      ])
    );
    expect(invocation.args).not.toEqual(expect.arrayContaining(["--continue", "--resume"]));
    expect(prompt).toBe(buildFixPrompt([issue], reviewContext));
    expect(prompt).toContain("fixer agent");
    expect(prompt).toContain("Do not create commits");
    expect(prompt).toContain("\"commitMessage\"");
    expect(prompt).toContain("mendr will stage, commit with your commitMessage");
    expect(prompt).not.toContain("sha\":\"commit sha");
  });
});
