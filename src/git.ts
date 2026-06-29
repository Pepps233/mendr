import { execOk, type ExecFn } from "./exec.js";

export async function getRepoRoot(exec: ExecFn, cwd: string): Promise<string> {
  const result = await execOk(exec, "git", ["rev-parse", "--show-toplevel"], { cwd });

  return result.stdout.trim();
}

export async function getCurrentBranch(exec: ExecFn, repo: string): Promise<string> {
  const result = await execOk(exec, "git", ["branch", "--show-current"], { cwd: repo });

  return result.stdout.trim();
}

export async function verifyCommitSha(
  exec: ExecFn,
  repo: string,
  sha: string
): Promise<string> {
  const result = await execOk(exec, "git", ["rev-parse", "--verify", `${sha}^{commit}`], {
    cwd: repo
  });

  return result.stdout.trim();
}

export async function pushBranch(exec: ExecFn, repo: string, branch: string): Promise<void> {
  await execOk(exec, "git", ["push", "origin", branch], { cwd: repo });
}
