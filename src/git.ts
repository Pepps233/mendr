import { execOk, type ExecFn } from "./exec.js";

export async function getRepoRoot(exec: ExecFn, cwd: string): Promise<string> {
  const result = await execOk(exec, "git", ["rev-parse", "--show-toplevel"], { cwd });

  return result.stdout.trim();
}

export async function getCurrentBranch(exec: ExecFn, repo: string): Promise<string> {
  const result = await execOk(exec, "git", ["branch", "--show-current"], { cwd: repo });

  return result.stdout.trim();
}

export async function getHeadCommitSha(exec: ExecFn, repo: string): Promise<string> {
  const result = await execOk(exec, "git", ["rev-parse", "HEAD"], { cwd: repo });

  return result.stdout.trim();
}

export async function fetchPullRequestHeadRef(
  exec: ExecFn,
  repo: string,
  pr: string,
  ref: string
): Promise<void> {
  await execOk(exec, "git", ["fetch", "origin", `+refs/pull/${pr}/head:${ref}`], {
    cwd: repo
  });
}

export async function createDetachedWorktree(
  exec: ExecFn,
  repo: string,
  worktreePath: string,
  ref: string
): Promise<void> {
  await execOk(exec, "git", ["worktree", "add", "--detach", worktreePath, ref], {
    cwd: repo
  });
}

export async function removeWorktree(
  exec: ExecFn,
  repo: string,
  worktreePath: string
): Promise<void> {
  await execOk(exec, "git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repo
  });
}

export async function getPorcelainStatus(exec: ExecFn, repo: string): Promise<string> {
  const result = await execOk(exec, "git", ["status", "--porcelain"], { cwd: repo });

  return result.stdout.trim();
}

export async function fetchRemoteBranch(
  exec: ExecFn,
  repo: string,
  remote: string,
  branch: string
): Promise<string> {
  const remoteRef = `refs/remotes/${remote}/${branch}`;

  await execOk(exec, "git", ["fetch", remote, `+refs/heads/${branch}:${remoteRef}`], {
    cwd: repo
  });

  return remoteRef;
}

export async function ensureMergeableWithRef(
  exec: ExecFn,
  repo: string,
  baseRef: string
): Promise<void> {
  await execOk(exec, "git", ["merge-tree", "--write-tree", "--quiet", baseRef, "HEAD"], {
    cwd: repo
  });
}

export async function stageAll(exec: ExecFn, repo: string): Promise<void> {
  await execOk(exec, "git", ["add", "-A"], { cwd: repo });
}

export async function commitStaged(
  exec: ExecFn,
  repo: string,
  message: string
): Promise<string> {
  await execOk(exec, "git", ["commit", "-F", "-"], {
    cwd: repo,
    input: `${message.trim()}\n`
  });

  return getHeadCommitSha(exec, repo);
}

export async function resetWorktreeToCommit(
  exec: ExecFn,
  repo: string,
  sha: string
): Promise<void> {
  await execOk(exec, "git", ["reset", "--hard", sha], { cwd: repo });
  await execOk(exec, "git", ["clean", "-fdx"], { cwd: repo });
}

export async function pushHeadToBranch(
  exec: ExecFn,
  repo: string,
  remote: string,
  branch: string
): Promise<void> {
  await execOk(exec, "git", ["push", remote, `HEAD:${branch}`], { cwd: repo });
}
