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
import {
  buildFixPrompt,
  buildFixSystemPrompt,
  buildReviewPrompt,
  buildReviewSystemPrompt
} from "./prompts.js";

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
      "--effort",
      ctx.effort,
      "--permission-mode",
      "acceptEdits",
      "--add-dir",
      ctx.repo,
      "--append-system-prompt",
      buildReviewSystemPrompt()
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
      "--effort",
      ctx.effort,
      "--permission-mode",
      "acceptEdits",
      "--add-dir",
      ctx.repo,
      "--append-system-prompt",
      buildFixSystemPrompt()
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
