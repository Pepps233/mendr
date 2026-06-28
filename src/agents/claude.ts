import {
  type AgentInvocation,
  AgentParseError,
  type Issue,
  type ReviewContext,
  extractJsonValue,
  parseIssueArrayFromText
} from "./types.js";

const systemPrompt = [
  "You are a review agent for a GitHub pull request.",
  "Review only changes in the provided PR diff.",
  "Do not report issues outside the changed scope.",
  "respond ONLY with JSON matching this schema:",
  '[{"title":"short title","file":"path","line":1,"severity":"low|medium|high|critical","description":"specific finding"}]'
].join("\n");

export function parseClaudeIssues(output: string): Issue[] {
  const envelope = extractJsonValue(output);

  if (isClaudeResultEnvelope(envelope)) {
    return parseIssueArrayFromText(envelope.result);
  }

  if (Array.isArray(envelope)) {
    return parseIssueArrayFromText(JSON.stringify(envelope));
  }

  throw new AgentParseError("Claude output did not include a result payload.");
}

export function buildClaudeReviewInvocation(ctx: ReviewContext): AgentInvocation {
  const prompt = buildReviewPrompt(ctx);

  return {
    command: "claude",
    args: [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--model",
      ctx.model,
      "--permission-mode",
      "acceptEdits",
      "--add-dir",
      ctx.repo,
      "--append-system-prompt",
      systemPrompt
    ]
  };
}

function buildReviewPrompt(ctx: ReviewContext): string {
  return [
    `Review PR ${ctx.pr}.`,
    "",
    "Use only the PR diff below as the source of code findings.",
    "Ignore pre-existing issues and anything outside changed lines.",
    "Return an empty JSON array when there are no changed-scope issues.",
    "",
    "PR review.md:",
    ctx.reviewMarkdown,
    "",
    "Current report.md:",
    ctx.reportMarkdown,
    "",
    "PR diff:",
    ctx.diff
  ].join("\n");
}

function isClaudeResultEnvelope(value: unknown): value is { result: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "result" in value &&
    typeof value.result === "string"
  );
}
