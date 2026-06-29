import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeReview,
  renderReviewList,
  renderReviewViewSnapshot,
  startReview,
  stopReview
} from "../../src/cli.js";

type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type ExecCall = {
  command: string;
  args: string[];
  options?: unknown;
};

type StartReviewOptions = {
  mendrHome: string;
  cwd: string;
  agent: "claude" | "codex";
  pr: string;
  maxRounds: number;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  exec: FakePreflightExec["run"];
  createId?: () => string;
  spawnDaemon: (args: unknown) => { pid: number; unref: () => void };
};

const tmpRoots: string[] = [];

async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), "mendr-cli-edge-"));
  tmpRoots.push(root);
  return root;
}

async function listReviewDirs(home: string) {
  try {
    return await readdir(join(home, "reviews"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function seedReview(home: string, id: string) {
  const reviewDir = join(home, "reviews", id);

  await mkdir(reviewDir, { recursive: true });
  await writeFile(
    join(reviewDir, "meta.json"),
    JSON.stringify(
      {
        id,
        agent: "claude",
        pr: "42",
        repo: "/work/mendr",
        branch: "feature/review",
        startedAt: "2026-06-28T17:00:00.000Z",
        pid: 999999,
        maxRounds: 3
      },
      null,
      2
    )
  );
  await writeFile(
    join(reviewDir, "state.json"),
    JSON.stringify(
      {
        phase: "fixing",
        currentStatus: "Resolving issues",
        issuesFound: 2,
        issuesFixed: 1,
        done: false,
        capReached: false
      },
      null,
      2
    )
  );
  await writeFile(
    join(reviewDir, "events.log"),
    [
      {
        status: "Discovering bugs",
        detail: "review round 1",
        ts: "2026-06-28T17:00:00.000Z"
      },
      {
        status: "Resolving issues",
        detail: "fixing issue 1",
        ts: "2026-06-28T17:00:01.000Z"
      }
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")
  );

  return reviewDir;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 100) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for file-backed view")), timeoutMs);
    })
  ]);
}

class FakePreflightExec {
  readonly calls: ExecCall[] = [];

  constructor(
    private readonly options: {
      missingBinary?: string;
      ghUnauthenticated?: boolean;
    } = {}
  ) {}

  run = async (
    command: string,
    args: string[],
    options?: unknown
  ): Promise<ExecResult> => {
    this.calls.push({ command, args, options });

    if (command === this.options.missingBinary) {
      throw Object.assign(new Error(`${command} not found`), {
        code: "ENOENT"
      });
    }

    if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { stdout: "/work/mendr", stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "branch" && args[1] === "--show-current") {
      return { stdout: "feature/review", stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "worktree" && args[1] === "add") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (command === "gh" && args[0] === "auth" && args[1] === "status") {
      return {
        stdout: "",
        stderr: this.options.ghUnauthenticated ? "not logged in" : "",
        exitCode: this.options.ghUnauthenticated ? 1 : 0
      };
    }

    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          number: 42,
          url: "https://github.com/acme/mendr/pull/42"
        }),
        stderr: "",
        exitCode: 0
      };
    }

    if (
      (command === "gh" || command === "git" || command === "claude" || command === "codex") &&
      args[0] === "--version"
    ) {
      return { stdout: `${command} version 1.0.0`, stderr: "", exitCode: 0 };
    }

    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
}

function makeStartOptions(
  overrides: Partial<StartReviewOptions> & {
    mendrHome: string;
    exec: FakePreflightExec["run"];
  }
): StartReviewOptions {
  return {
    mendrHome: overrides.mendrHome,
    cwd: "/work/mendr",
    agent: "claude",
    pr: "42",
    maxRounds: 3,
    createId: () => "1",
    spawnDaemon: () => ({
      pid: 43210,
      unref: vi.fn()
    }),
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("CLI edge and failure handling", () => {
  it.each([
    { missingBinary: "gh", agent: "claude" as const, expected: /gh.*not found/i },
    { missingBinary: "git", agent: "claude" as const, expected: /git.*not found/i },
    { missingBinary: "claude", agent: "claude" as const, expected: /claude.*not found/i },
    { missingBinary: "codex", agent: "codex" as const, expected: /codex.*not found/i }
  ])(
    "fails preflight without creating a review dir when $missingBinary is unavailable",
    async ({ missingBinary, agent, expected }) => {
      const home = await makeHome();
      const exec = new FakePreflightExec({ missingBinary });

      await expect(
        startReview(
          makeStartOptions({
            mendrHome: home,
            agent,
            exec: exec.run
          })
        )
      ).rejects.toThrow(expected);

      await expect(listReviewDirs(home)).resolves.toEqual([]);
    }
  );

  it("fails preflight with an actionable auth message when gh is not logged in", async () => {
    const home = await makeHome();
    const exec = new FakePreflightExec({ ghUnauthenticated: true });

    await expect(
      startReview(
        makeStartOptions({
          mendrHome: home,
          exec: exec.run
        })
      )
    ).rejects.toThrow(/gh auth login/i);

    await expect(listReviewDirs(home)).resolves.toEqual([]);
  });

  it("persists selected model and effort for the daemon", async () => {
    const home = await makeHome();
    const exec = new FakePreflightExec();

    await startReview(
      makeStartOptions({
        mendrHome: home,
        agent: "codex",
        model: "gpt-5.4",
        effort: "high",
        exec: exec.run
      })
    );

    const meta = JSON.parse(
      await readFile(join(home, "reviews", "1", "meta.json"), "utf8")
    ) as { model?: string; effort?: string; worktreePath?: string };

    expect(meta.model).toBe("gpt-5.4");
    expect(meta.effort).toBe("high");
    expect(meta.worktreePath).toBe(join(home, "worktrees", "session-1-pr-42"));
  });

  it("uses file-backed state so view and ls do not hang after a daemon crash", async () => {
    const home = await makeHome();
    const id = "crashed-daemon-6e21";

    await seedReview(home, id);

    const table = await withTimeout(renderReviewList({ mendrHome: home }));
    const snapshot = await withTimeout(
      renderReviewViewSnapshot({
        mendrHome: home,
        reviewId: "1"
      })
    );

    expect(table).toContain("1: claude");
    expect(table).not.toContain(id);
    expect(table).toContain("Resolving issues");
    expect(snapshot).toMatchObject({
      reviewId: "1",
      done: false,
      currentStatus: "Resolving issues"
    });
    expect(snapshot.frame).toContain("Resolving issues");
  });

  it("stops the daemon pid while preserving review state files", async () => {
    const home = await makeHome();
    const id = "stoppable-daemon-7f13";
    const reviewDir = await seedReview(home, id);
    const killProcess = vi.fn(() => true);

    await stopReview({
      mendrHome: home,
      reviewId: "1",
      killProcess
    });

    const state = JSON.parse(await readFile(join(reviewDir, "state.json"), "utf8")) as {
      phase: string;
      currentStatus: string;
      done: boolean;
    };
    const events = await readFile(join(reviewDir, "events.log"), "utf8");
    const table = await renderReviewList({ mendrHome: home });

    expect(killProcess).toHaveBeenCalledWith(-999999, "SIGTERM");
    expect(state).toMatchObject({
      phase: "stopped",
      currentStatus: "Stopped",
      done: true
    });
    expect(events).toContain("Stopped");
    expect(table).toContain("1: claude");
    expect(table).not.toContain(id);
    expect(table).toContain("Stopped");
  });

  it("refuses to close an active worktree-backed session", async () => {
    const home = await makeHome();
    const exec = new FakePreflightExec();

    await startReview(
      makeStartOptions({
        mendrHome: home,
        exec: exec.run
      })
    );

    await expect(
      closeReview({ mendrHome: home, reviewId: "1", exec: exec.run })
    ).rejects.toThrow(/stop|complete/i);

    await expect(listReviewDirs(home)).resolves.toEqual(["1"]);
    expect(
      exec.calls.find(
        (call) => call.command === "git" && call.args[0] === "worktree" && call.args[1] === "remove"
      )
    ).toBeUndefined();
  });

  it("allocates integer ids and resets after all sessions are closed", async () => {
    const home = await makeHome();
    const exec = new FakePreflightExec();
    const spawnDaemon = vi.fn(() => ({
      pid: 43210,
      unref: vi.fn()
    }));

    const first = await startReview(
      makeStartOptions({
        mendrHome: home,
        createId: undefined,
        exec: exec.run,
        spawnDaemon
      })
    );
    const second = await startReview(
      makeStartOptions({
        mendrHome: home,
        pr: "77",
        createId: undefined,
        exec: exec.run,
        spawnDaemon
      })
    );

    expect(first.id).toBe("1");
    expect(second.id).toBe("2");
    await expect(listReviewDirs(home).then((dirs) => dirs.sort())).resolves.toEqual(["1", "2"]);
    expect(
      exec.calls.filter((call) => call.command === "git" && call.args[0] === "worktree" && call.args[1] === "add")
    ).toEqual([
      expect.objectContaining({
        args: ["worktree", "add", "--detach", join(home, "worktrees", "session-1-pr-42"), "feature/review"]
      }),
      expect.objectContaining({
        args: ["worktree", "add", "--detach", join(home, "worktrees", "session-2-pr-77"), "feature/review"]
      })
    ]);

    await stopReview({ mendrHome: home, reviewId: "1", killProcess: vi.fn(() => true) });
    await stopReview({ mendrHome: home, reviewId: "2", killProcess: vi.fn(() => true) });
    await closeReview({ mendrHome: home, reviewId: "1", exec: exec.run });
    await closeReview({ mendrHome: home, reviewId: "2", exec: exec.run });

    const reset = await startReview(
      makeStartOptions({
        mendrHome: home,
        createId: undefined,
        exec: exec.run,
        spawnDaemon
      })
    );

    expect(reset.id).toBe("1");
    await expect(listReviewDirs(home).then((dirs) => dirs.sort())).resolves.toEqual(["1"]);
  });

  it("creates distinct state directories for concurrent reviews", async () => {
    const home = await makeHome();
    const exec = new FakePreflightExec();
    const spawnDaemon = vi.fn(() => ({
      pid: 43210,
      unref: vi.fn()
    }));

    await Promise.all([
      startReview(
        makeStartOptions({
          mendrHome: home,
          pr: "42",
          createId: () => "swift-otter-3f9a",
          exec: exec.run,
          spawnDaemon
        })
      ),
      startReview(
        makeStartOptions({
          mendrHome: home,
          pr: "77",
          createId: () => "steady-moon-2ab1",
          exec: exec.run,
          spawnDaemon
        })
      )
    ]);

    const dirs = await listReviewDirs(home);
    const firstMeta = JSON.parse(
      await readFile(join(home, "reviews", "swift-otter-3f9a", "meta.json"), "utf8")
    );
    const secondMeta = JSON.parse(
      await readFile(join(home, "reviews", "steady-moon-2ab1", "meta.json"), "utf8")
    );
    const table = await renderReviewList({ mendrHome: home });

    expect(dirs.sort()).toEqual(["steady-moon-2ab1", "swift-otter-3f9a"]);
    expect(firstMeta).toMatchObject({ id: "swift-otter-3f9a", pr: "42" });
    expect(secondMeta).toMatchObject({ id: "steady-moon-2ab1", pr: "77" });
    expect(table).toContain("(PR 42)");
    expect(table).toContain("(PR 77)");
    expect(table).not.toContain("swift-otter-3f9a");
    expect(table).not.toContain("steady-moon-2ab1");
    expect(spawnDaemon).toHaveBeenCalledTimes(2);
  });
});
