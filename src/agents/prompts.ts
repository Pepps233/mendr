import { issueFingerprint, type Issue, type ReviewContext } from "./types.js";

const issueSchema =
  '[{"title":"specific standalone title","file":"path","line":1,"severity":"low|medium|high|critical","description":"two concise sentences describing the finding"}]';

const fixSchema =
  '[{"title":"issue title","fingerprint":"issue fingerprint","status":"fixed","commitMessage":"<type>(<scope>): <short imperative summary>\\n\\n- <why this change was needed>\\n- <why this approach or impact matters>","summary":"exactly two sentences"},{"title":"issue title","fingerprint":"issue fingerprint","status":"failed","summary":"exactly two sentences explaining the failure"}]';

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
    "Use issue titles that are specific enough to stand alone in the final summary.",
    "Use exactly two concise sentences for each issue description.",
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
    "For fixed issues, write the exact commitMessage mendr should use after your process exits.",
    "The commitMessage must describe what the commit changed, not restate the reviewed issue.",
    "Commit messages must use exactly this format:",
    "<type>(<scope>): <short imperative summary>",
    "",
    "- <why this change was needed>",
    "- <why this approach or impact matters>",
    "",
    "Commit-message summaries must be imperative and must not end with a period.",
    "Do not include co-author lines, AI references, provider references, or non-imperative summaries.",
    "mendr will stage, commit with your commitMessage, record, and push successful fixes after your process exits.",
    "After fixing, respond ONLY with JSON matching this schema:",
    fixSchema,
    "",
    "The result must include the issue title and fingerprint shown in the issue payload.",
    "For fixed issues, summarize the concrete code changes you made, not the issue title.",
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
