import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { render } from "ink";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeReview,
  ReviewView,
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

function makeTtyInput(): NodeJS.ReadStream & {
  write: (chunk: string) => boolean;
  setRawMode: (enabled: boolean) => NodeJS.ReadStream;
} {
  const input = new PassThrough() as NodeJS.ReadStream & {
    write: (chunk: string) => boolean;
    isTTY: boolean;
    setRawMode: (enabled: boolean) => NodeJS.ReadStream;
    ref: () => NodeJS.ReadStream;
    unref: () => NodeJS.ReadStream;
  };

  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;

  return input;
}

function makeTtyOutput(): NodeJS.WriteStream {
  const output = new PassThrough() as NodeJS.WriteStream & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };

  output.columns = 80;
  output.rows = 24;
  output.isTTY = true;

  return output;
}

async function expectLiveViewExitOnInput(inputChunk: string): Promise<void> {
  const stdin = makeTtyInput();
  const stdout = makeTtyOutput();
  const stderr = makeTtyOutput();
  const app = render(
    React.createElement(ReviewView, {
      reviewId: "1",
      pollIntervalMs: 60_000,
      loadSnapshot: async () => ({
        reviewId: "1",
        agent: "claude",
        pr: "42",
        phase: "fixing",
        currentStatus: "Resolving issues",
        issuesFound: 2,
        issuesFixed: 1,
        done: false,
        capReached: false,
        recentEvents: [],
        frame: "",
        spinner: "."
      })
    }),
    {
      stdin,
      stdout,
      stderr
    }
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.write(inputChunk);
    await withTimeout(app.waitUntilExit(), 500);
  } finally {
    app.unmount();
  }
}

async function expectLiveViewAcceptsDuplicateEventText(): Promise<void> {
  const stdin = makeTtyInput();
  const stdout = makeTtyOutput();
  const stderr = makeTtyOutput();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const duplicateEvent =
    "Fix failed: The fixer reported this issue as fixed, but its commit message is invalid.";
  const app = render(
    React.createElement(ReviewView, {
      reviewId: "1",
      pollIntervalMs: 60_000,
      loadSnapshot: async () => ({
        reviewId: "1",
        agent: "codex",
        pr: "42",
        phase: "complete",
        currentStatus: "Complete",
        issuesFound: 2,
        issuesFixed: 1,
        done: true,
        capReached: true,
        recentEvents: [duplicateEvent, duplicateEvent],
        frame: "",
        spinner: ""
      })
    }),
    {
      stdin,
      stdout,
      stderr
    }
  );

  try {
    await withTimeout(app.waitUntilExit(), 500);
    const duplicateKeyWarning = consoleError.mock.calls.some((call) =>
      call.some((part) => String(part).includes("Encountered two children with the same key"))
    );

    expect(duplicateKeyWarning).toBe(false);
  } finally {
    consoleError.mockRestore();
    app.unmount();
  }
}

class FakePreflightExec {
  readonly calls: ExecCall[] = [];

  constructor(
    private readonly options: {
      missingBinary?: string;
      ghUnauthenticated?: boolean;
      currentBranch?: string;
      headRefName?: string;
      headRepository?: {
        nameWithOwner: string;
        url: string;
      };
      baseRepository?: {
        nameWithOwner: string;
      };
      isCrossRepository?: boolean;
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
      return { stdout: this.options.currentBranch ?? "feature/review", stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "fetch") {
      return { stdout: "", stderr: "", exitCode: 0 };
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
      const jsonFields = args[args.indexOf("--json") + 1]?.split(",") ?? [];

      if (jsonFields.includes("baseRepository")) {
        return {
          stdout: "",
          stderr: 'Unknown JSON field: "baseRepository"',
          exitCode: 1
        };
      }

      return {
        stdout: JSON.stringify({
          number: 42,
          url: "https://github.com/acme/mendr/pull/42",
          headRefName: this.options.headRefName ?? "feature/review",
          headRepository: this.options.headRepository ?? {
            nameWithOwner: "acme/mendr",
            url: "https://github.com/acme/mendr"
          },
          baseRepository: this.options.baseRepository ?? {
            nameWithOwner: "acme/mendr"
          },
          isCrossRepository: this.options.isCrossRepository ?? false
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
  it("exits the live view when q or escape is pressed", async () => {
    await expectLiveViewExitOnInput("q");
    await expectLiveViewExitOnInput("\u001B");
  });

  it("renders duplicate event text without key collisions", async () => {
    await expectLiveViewAcceptsDuplicateEventText();
  });

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

  it("creates the session worktree from the PR head when the caller is on another branch", async () => {
    const home = await makeHome();
    const exec = new FakePreflightExec({
      currentBranch: "main",
      headRefName: "feature/review"
    });

    await startReview(
      makeStartOptions({
        mendrHome: home,
        exec: exec.run
      })
    );

    const meta = JSON.parse(
      await readFile(join(home, "reviews", "1", "meta.json"), "utf8")
    ) as { branch?: string; branchPushRemote?: string };
    const prHeadCall = exec.calls.find(
      (call) =>
        call.command === "gh" &&
        call.args[0] === "pr" &&
        call.args[1] === "view" &&
        call.args[2] === "42" &&
        call.args.some((arg) => arg.includes("headRepository"))
    );

    expect(meta.branch).toBe("feature/review");
    expect(meta.branchPushRemote).toBe("origin");
    expect(prHeadCall?.args).toEqual([
      "pr",
      "view",
      "42",
      "--json",
      "headRefName,headRepository,headRepositoryOwner,isCrossRepository"
    ]);
    expect(
      exec.calls.find((call) => call.command === "git" && call.args[0] === "fetch")?.args
    ).toEqual(["fetch", "origin", "+refs/pull/42/head:refs/mendr/pr-42/head"]);
    expect(
      exec.calls.find(
        (call) => call.command === "git" && call.args[0] === "worktree" && call.args[1] === "add"
      )?.args
    ).toEqual([
      "worktree",
      "add",
      "--detach",
      join(home, "worktrees", "session-1-pr-42"),
      "refs/mendr/pr-42/head"
    ]);
  });

  it("removes the session worktree when daemon startup fails", async () => {
    const home = await makeHome();
    const exec = new FakePreflightExec();
    const spawnDaemon = vi.fn(() => {
      throw new Error("daemon failed to start");
    });

    await expect(
      startReview(
        makeStartOptions({
          mendrHome: home,
          exec: exec.run,
          spawnDaemon
        })
      )
    ).rejects.toThrow(/daemon failed to start/i);

    await expect(listReviewDirs(home)).resolves.toEqual([]);
    expect(
      exec.calls.find(
        (call) => call.command === "git" && call.args[0] === "worktree" && call.args[1] === "remove"
      )?.args
    ).toEqual(["worktree", "remove", "--force", join(home, "worktrees", "session-1-pr-42")]);
  });

  it("persists the fork head repository push remote", async () => {
    const home = await makeHome();
    const exec = new FakePreflightExec({
      headRefName: "feature/review",
      headRepository: {
        nameWithOwner: "contributor/mendr",
        url: "https://github.com/contributor/mendr"
      },
      baseRepository: {
        nameWithOwner: "acme/mendr"
      },
      isCrossRepository: true
    });

    await startReview(
      makeStartOptions({
        mendrHome: home,
        exec: exec.run
      })
    );

    const meta = JSON.parse(
      await readFile(join(home, "reviews", "1", "meta.json"), "utf8")
    ) as { branchPushRemote?: string };

    expect(meta.branchPushRemote).toBe("https://github.com/contributor/mendr.git");
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

  it("closes a failed worktree-backed session", async () => {
    const home = await makeHome();
    const exec = new FakePreflightExec();

    await startReview(
      makeStartOptions({
        mendrHome: home,
        exec: exec.run
      })
    );
    await writeFile(
      join(home, "reviews", "1", "state.json"),
      JSON.stringify(
        {
          phase: "failed",
          currentStatus: "Daemon failed",
          issuesFound: 0,
          issuesFixed: 0,
          done: true,
          capReached: false,
          error: "orchestrator crashed"
        },
        null,
        2
      )
    );

    await closeReview({ mendrHome: home, reviewId: "1", exec: exec.run });

    await expect(listReviewDirs(home)).resolves.toEqual([]);
    expect(
      exec.calls.find(
        (call) => call.command === "git" && call.args[0] === "worktree" && call.args[1] === "remove"
      )?.args
    ).toEqual(["worktree", "remove", "--force", join(home, "worktrees", "session-1-pr-42")]);
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
        args: ["worktree", "add", "--detach", join(home, "worktrees", "session-1-pr-42"), "refs/mendr/pr-42/head"]
      }),
      expect.objectContaining({
        args: ["worktree", "add", "--detach", join(home, "worktrees", "session-2-pr-77"), "refs/mendr/pr-77/head"]
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
