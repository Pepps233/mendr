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
  branchPushRemote: string;
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
  const result = await execOk(
    exec,
    "gh",
    [
      "pr",
      "view",
      pr,
      "--json",
      "headRefName,headRepository,headRepositoryOwner,isCrossRepository"
    ],
    {
      cwd: repo
    }
  );
  const parsed = JSON.parse(result.stdout) as {
    headRefName?: unknown;
    headRepository?: unknown;
    baseRepository?: unknown;
    headRepositoryOwner?: unknown;
    isCrossRepository?: unknown;
  };
  const branch = typeof parsed.headRefName === "string" ? parsed.headRefName.trim() : "";

  if (branch.length === 0) {
    throw new Error("Could not resolve the pull request head branch from GitHub.");
  }

  const branchPushRemote = resolveBranchPushRemote(parsed);

  return {
    branch,
    branchPushRemote
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

type RepositoryInfo = {
  nameWithOwner?: string;
  url?: string;
  sshUrl?: string;
};

function resolveBranchPushRemote(input: {
  headRepository?: unknown;
  baseRepository?: unknown;
  headRepositoryOwner?: unknown;
  isCrossRepository?: unknown;
}): string {
  const headRepository = readRepositoryInfo(input.headRepository, input.headRepositoryOwner);
  const baseRepository = readRepositoryInfo(input.baseRepository);
  const isCrossRepository =
    typeof input.isCrossRepository === "boolean" ? input.isCrossRepository : undefined;

  if (!headRepository) {
    throw new Error("Could not resolve the pull request head repository from GitHub.");
  }

  if (isCrossRepository === false) {
    return "origin";
  }

  if (
    isCrossRepository === undefined &&
    headRepository.nameWithOwner &&
    baseRepository?.nameWithOwner &&
    headRepository.nameWithOwner === baseRepository.nameWithOwner
  ) {
    return "origin";
  }

  const remote = headRepository.sshUrl ?? normalizedGitUrl(headRepository.url);

  if (remote) {
    return remote;
  }

  if (headRepository.nameWithOwner) {
    return `https://github.com/${headRepository.nameWithOwner}.git`;
  }

  throw new Error("Could not resolve the pull request head repository push remote from GitHub.");
}

function readRepositoryInfo(
  value: unknown,
  ownerFallback?: unknown
): RepositoryInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nameWithOwner =
    readString(value, "nameWithOwner") ??
    readNameWithOwner(
      readOwnerLogin(value.owner) ?? readOwnerLogin(ownerFallback),
      readString(value, "name")
    );
  const url = readString(value, "url");
  const sshUrl = readString(value, "sshUrl") ?? readString(value, "sshURL");

  if (!nameWithOwner && !url && !sshUrl) {
    return undefined;
  }

  return {
    ...(nameWithOwner ? { nameWithOwner } : {}),
    ...(url ? { url } : {}),
    ...(sshUrl ? { sshUrl } : {})
  };
}

function readNameWithOwner(
  owner: string | undefined,
  name: string | undefined
): string | undefined {
  if (!owner || !name) {
    return undefined;
  }

  return `${owner}/${name}`;
}

function readOwnerLogin(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return readString(value, "login");
}

function normalizedGitUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  if (!/^https?:\/\//i.test(url)) {
    return url;
  }

  return url.endsWith(".git") ? url : `${url}.git`;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];

  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
