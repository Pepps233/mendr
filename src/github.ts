import { execOk, type ExecFn } from "./exec.js";

export type PullRequestComment = {
  author?: {
    login?: string;
  };
  body?: string;
};

export type PullRequestDetails = {
  title: string;
  body: string;
  comments: PullRequestComment[];
};

export type PullRequestHeadBranch = {
  branch: string;
};

export async function fetchPullRequestDetails(
  exec: ExecFn,
  repo: string,
  pr: string
): Promise<PullRequestDetails> {
  const result = await execOk(
    exec,
    "gh",
    ["pr", "view", pr, "--json", "title,body,comments"],
    { cwd: repo }
  );
  const parsed = JSON.parse(result.stdout) as Partial<PullRequestDetails>;

  return {
    title: typeof parsed.title === "string" ? parsed.title : "",
    body: typeof parsed.body === "string" ? parsed.body : "",
    comments: Array.isArray(parsed.comments) ? parsed.comments : []
  };
}

export async function fetchPullRequestDiff(
  exec: ExecFn,
  repo: string,
  pr: string
): Promise<string> {
  const result = await execOk(exec, "gh", ["pr", "diff", pr], { cwd: repo });

  return result.stdout;
}

export async function fetchPullRequestHeadBranch(
  exec: ExecFn,
  repo: string,
  pr: string
): Promise<PullRequestHeadBranch> {
  const result = await execOk(exec, "gh", ["pr", "view", pr, "--json", "headRefName"], {
    cwd: repo
  });
  const parsed = JSON.parse(result.stdout) as { headRefName?: unknown };
  const branch = typeof parsed.headRefName === "string" ? parsed.headRefName.trim() : "";

  if (branch.length === 0) {
    throw new Error("Could not resolve the pull request head branch from GitHub.");
  }

  return {
    branch
  };
}

export async function validatePullRequest(
  exec: ExecFn,
  repo: string,
  pr: string
): Promise<void> {
  await execOk(exec, "gh", ["pr", "view", pr, "--json", "number,url"], { cwd: repo });
}

export async function postPullRequestComment(
  exec: ExecFn,
  repo: string,
  pr: string,
  bodyFile: string
): Promise<void> {
  await execOk(exec, "gh", ["pr", "comment", pr, "--body-file", bodyFile], { cwd: repo });
}

export function renderReviewMarkdown(pr: string, details: PullRequestDetails): string {
  const comments = details.comments.length
    ? details.comments.map(renderComment).join("\n\n")
    : "No comments.";

  return [
    `# PR ${pr}: ${details.title || "(untitled)"}`,
    "",
    "## Body",
    details.body.trim() || "No body.",
    "",
    "## Comments",
    comments,
    ""
  ].join("\n");
}

function renderComment(comment: PullRequestComment): string {
  const author = comment.author?.login ?? "unknown";
  const body = comment.body?.trim() || "(empty comment)";

  return `- @${author}: ${body}`;
}
