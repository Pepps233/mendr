import {
  type AgentInvocation,
  AgentParseError,
  type FixIssueResult,
  type Issue,
  type ReviewContext,
  extractJsonValue,
  parseFixIssueResultArrayFromText,
  parseIssueArrayFromText
} from "./types.js";
import { buildFixPrompt, buildReviewPrompt } from "./prompts.js";

const systemPrompt = [
  "You are a review agent for a GitHub pull request.",
  "Review only changes in the provided PR diff.",
  "Do not report issues outside the changed scope.",
  "Look for changed-scope bugs, correctness issues, maintainability issues, and unnecessary redundancies.",
  "respond ONLY with JSON matching this schema:",
  '[{"title":"short title","file":"path","line":1,"severity":"low|medium|high|critical","description":"specific finding"}]'
].join("\n");

const fixSystemPrompt = [
  "You are a fixer agent for a GitHub pull request.",
  "Fix the full issue batch in one fresh session.",
  "Create incremental commits and map each issue result to a commit SHA or failed status.",
  "Never include co-author lines, AI references, provider references, commit summary periods, or non-imperative commit summaries."
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

export function parseClaudeFixResults(output: string): FixIssueResult[] {
  const envelope = extractJsonValue(output);

  if (isClaudeResultEnvelope(envelope)) {
    return parseFixIssueResultArrayFromText(envelope.result);
  }

  if (Array.isArray(envelope)) {
    return parseFixIssueResultArrayFromText(JSON.stringify(envelope));
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

export function buildClaudeFixInvocation(
  issues: Issue[],
  ctx: ReviewContext
): AgentInvocation {
  const prompt = buildFixPrompt(issues, ctx);

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
      fixSystemPrompt
    ]
  };
}

function isClaudeResultEnvelope(value: unknown): value is { result: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "result" in value &&
    typeof value.result === "string"
  );
}
