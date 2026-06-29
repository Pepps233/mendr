import { issueFingerprint, type Issue, type ReviewContext } from "./types.js";

const issueSchema =
  '[{"title":"short title","file":"path","line":1,"severity":"low|medium|high|critical","description":"specific finding"}]';

const fixSchema =
  '[{"title":"issue title","fingerprint":"issue fingerprint","status":"fixed","summary":"exactly two sentences"},{"title":"issue title","fingerprint":"issue fingerprint","status":"failed","summary":"exactly two sentences explaining the failure"}]';

export function buildReviewSystemPrompt(): string {
  return [
    "You are the REVIEW agent in the pull request review loop.",
    "Report only issues that are strictly inside the provided PR diff scope.",
    "Respond only with JSON matching the requested issue schema."
  ].join("\n");
}

export function buildFixSystemPrompt(): string {
  return [
    "You are the FIX agent in the pull request review loop.",
    "Fix only the supplied issue and stay inside the changed PR scope.",
    "Do not create commits or push changes.",
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
    "Fix only the single issue listed below and stay inside the changed PR scope.",
    "Use one fresh session to fix this issue.",
    "Do not create commits, push changes, or include commit SHAs in the result.",
    "mendr will stage, commit, record, and push successful fixes after your process exits.",
    "After fixing, respond ONLY with JSON matching this schema:",
    fixSchema,
    "",
    "The result must include the issue title and fingerprint shown in the issue payload.",
    "For failed issues, set status to failed and explain why in two sentences.",
    "",
    `Fix PR ${ctx.pr}.`,
    "",
    "Issue payload:",
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
