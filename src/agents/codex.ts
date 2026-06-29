import {
  type AgentInvocation,
  type FixIssueResult,
  type Issue,
  type ReviewContext,
  parseFixIssueResultArrayFromText,
  parseIssueArrayFromText
} from "./types.js";
import { buildFixPrompt, buildReviewPrompt } from "./prompts.js";

export type CodexReviewInvocationOptions = {
  outputFile: string;
};

export function parseCodexIssues(output: string): Issue[] {
  return parseIssueArrayFromText(output);
}

export function parseCodexFixResults(output: string): FixIssueResult[] {
  return parseFixIssueResultArrayFromText(output);
}

export function buildCodexReviewInvocation(
  ctx: ReviewContext,
  options: CodexReviewInvocationOptions
): AgentInvocation {
  const prompt = buildReviewPrompt(ctx);

  return {
    command: "codex",
    args: [
      "exec",
      prompt,
      "-m",
      ctx.model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(ctx.effort)}`,
      "--sandbox",
      "workspace-write",
      "-C",
      ctx.repo,
      "--output-last-message",
      options.outputFile
    ]
  };
}

export function buildCodexFixInvocation(
  issues: Issue[],
  ctx: ReviewContext,
  options: CodexReviewInvocationOptions
): AgentInvocation {
  const prompt = buildFixPrompt(issues, ctx);

  return {
    command: "codex",
    args: [
      "exec",
      prompt,
      "-m",
      ctx.model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(ctx.effort)}`,
      "--sandbox",
      "workspace-write",
      "-C",
      ctx.repo,
      "--output-last-message",
      options.outputFile
    ]
  };
}
