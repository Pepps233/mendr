import { issueFingerprint, type Issue, type ReviewContext } from "./types.js";

const issueSchema =
  '[{"title":"short title","file":"path","line":1,"severity":"low|medium|high|critical","description":"specific finding"}]';

const fixSchema =
  '[{"title":"issue title","fingerprint":"issue fingerprint","status":"fixed","summary":"exactly two sentences"},{"title":"issue title","fingerprint":"issue fingerprint","status":"failed","summary":"exactly two sentences explaining the failure"}]';

export function buildReviewSystemPrompt(): string {
  return [
    "You are the REVIEW agent in the mendr pull request review loop.",
    "Report only issues that are strictly inside the provided PR diff scope.",
    "Respond only with JSON matching the requested issue schema."
  ].join("\n");
}

export function buildFixSystemPrompt(): string {
  return [
    "You are the FIX agent in the mendr pull request review loop.",
    "Fix only the supplied issue batch and stay inside the changed PR scope.",
    "Respond only with JSON matching the requested fix-result schema."
  ].join("\n");
}

export function buildReviewPrompt(ctx: ReviewContext): string {
  return [
    "You are a code review agent for a GitHub pull request.",
    "Review only changes in the provided PR diff.",
    "Do not report issues outside the changed scope.",
    "Look for security issues, correctness issues, maintainability issues, and unnecessary redundancies.",
    "Return an empty JSON array when there are no changed-scope issues.",
    "respond ONLY with JSON matching this schema:",
    issueSchema,
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

export function buildFixPrompt(issues: Issue[], ctx: ReviewContext): string {
  const issuePayload = issues.map((issue) => ({
    ...issue,
    fingerprint: issueFingerprint(issue)
  }));

  return [
    "You are a code fixer agent for a GitHub pull request.",
    "Fix only the issues listed below and stay inside the changed PR scope.",
    "Use one fresh session to fix the full issue batch.",
    "Create incremental commits as you work, with one or more commits mapped back to the issues.",
    "Commit messages must use exactly this format:",
    "<type>(<scope>): <short imperative summary>",
    "",
    "- <why this change was needed>",
    "- <why this approach or impact matters>",
    "",
    "Commit-message summaries must be imperative and must not end with a period.",
    "Do not include co-author lines, AI references, provider references, or non-imperative summaries.",
    "After fixing, respond ONLY with JSON matching this schema:",
    fixSchema,
    "",
    "Each result must include the issue title and fingerprint shown in the issue batch.",
    "For fixed issues, commit the fix before returning; mendr will capture the resulting commit SHA.",
    "For failed issues, set status to failed and explain why in two sentences.",
    "",
    `Fix PR ${ctx.pr}.`,
    "",
    "Issue batch:",
    JSON.stringify(issuePayload, null, 2),
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
