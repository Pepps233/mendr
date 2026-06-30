import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandFailedError, execOk, type ExecFn } from "./exec.js";

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
  try {
    await execOk(exec, "git", ["merge-tree", "--write-tree", "--quiet", baseRef, "HEAD"], {
      cwd: repo
    });
  } catch (error) {
    if (!isModernMergeTreeUnsupported(error)) {
      throw error;
    }

    await ensureMergeableWithTemporaryWorktree(exec, repo, baseRef);
  }
}

async function ensureMergeableWithTemporaryWorktree(
  exec: ExecFn,
  repo: string,
  baseRef: string
): Promise<void> {
  const worktreePath = await mkdtemp(join(tmpdir(), "mendr-merge-check-"));
  let mergeError: unknown;
  let worktreeCreated = false;

  try {
    await createDetachedWorktree(exec, repo, worktreePath, "HEAD");
    worktreeCreated = true;
    await execOk(exec, "git", ["merge", "--no-commit", "--no-ff", baseRef], {
      cwd: worktreePath
    });
  } catch (error) {
    mergeError = error;
  } finally {
    try {
      if (worktreeCreated) {
        await removeWorktree(exec, repo, worktreePath);
      } else {
        await rm(worktreePath, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      if (mergeError === undefined) {
        throw cleanupError;
      }
    }
  }

  if (mergeError !== undefined) {
    throw mergeError;
  }
}

function isModernMergeTreeUnsupported(error: unknown): boolean {
  if (!(error instanceof CommandFailedError)) {
    return false;
  }

  if (error.command !== "git" || error.args[0] !== "merge-tree") {
    return false;
  }

  const output = `${error.result.stderr}\n${error.result.stdout}`.toLowerCase();

  return (
    output.includes("not a git command") ||
    output.includes("usage: git merge-tree") ||
    output.includes("unknown option") ||
    output.includes("unrecognized option") ||
    output.includes("unknown switch")
  );
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
