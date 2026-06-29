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

export async function stageAll(exec: ExecFn, repo: string): Promise<void> {
  await execOk(exec, "git", ["add", "-A"], { cwd: repo });
}

export async function commitStaged(
  exec: ExecFn,
  repo: string,
  subject: string,
  body: string
): Promise<string> {
  await execOk(exec, "git", ["commit", "-m", subject, "-m", body], { cwd: repo });

  return getHeadCommitSha(exec, repo);
}

export async function resetWorktreeToCommit(
  exec: ExecFn,
  repo: string,
  sha: string
): Promise<void> {
  await execOk(exec, "git", ["reset", "--hard", sha], { cwd: repo });
  await execOk(exec, "git", ["clean", "-fd"], { cwd: repo });
}

export async function pushHeadToBranch(
  exec: ExecFn,
  repo: string,
  branch: string
): Promise<void> {
  await execOk(exec, "git", ["push", "origin", `HEAD:${branch}`], { cwd: repo });
}
