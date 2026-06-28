import {
  type AgentInvocation,
  type Issue,
  type ReviewContext,
  parseIssueArrayFromText
} from "./types.js";

export type CodexReviewInvocationOptions = {
  outputFile: string;
};

export function parseCodexIssues(output: string): Issue[] {
  return parseIssueArrayFromText(output);
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
      "--sandbox",
      "workspace-write",
      "-C",
      ctx.repo,
      "--output-last-message",
      options.outputFile
    ]
  };
}

function buildReviewPrompt(ctx: ReviewContext): string {
  return [
    "You are a review agent for a GitHub pull request.",
    "Review only changes in the provided PR diff.",
    "Do not report issues outside the changed scope.",
    "respond ONLY with JSON matching this schema:",
    '[{"title":"short title","file":"path","line":1,"severity":"low|medium|high|critical","description":"specific finding"}]',
    "",
    `Review PR ${ctx.pr}.`,
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
