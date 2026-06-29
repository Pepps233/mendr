import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { AgentName } from "./agents/types.js";
import { defaultExec, execOk, type ExecFn } from "./exec.js";
import { getCurrentBranch, getRepoRoot } from "./git.js";
import { validatePullRequest } from "./github.js";
import { defaultMendrHome, reviewDir, reviewsDir } from "./paths.js";
import {
  closeReviewSession,
  ensureMendrHome,
  readEvents,
  readMeta,
  readState,
  writeMeta,
  writeState,
  type ReviewState
} from "./state.js";

export type CliParseResult =
  | {
      ok: true;
      command: "start";
      agent: AgentName;
      pr: string;
      maxRounds: number;
    }
  | {
      ok: true;
      command: "ls";
    }
  | {
      ok: true;
      command: "view" | "close" | "stop";
      reviewId: string;
    }
  | {
      ok: false;
      exitCode: 1;
      error: string;
    };

export type StartReviewOptions = {
  mendrHome?: string;
  cwd?: string;
  agent: AgentName;
  pr: string;
  maxRounds: number;
  exec?: ExecFn;
  createId?: () => string;
  spawnDaemon?: (args: SpawnDaemonArgs) => SpawnedDaemon;
};

export type SpawnDaemonArgs = {
  mendrHome: string;
  reviewId: string;
};

export type SpawnedDaemon = {
  pid: number;
  unref: () => void;
};

export type StartReviewResult = {
  id: string;
  reviewDir: string;
};

export type RenderReviewListOptions = {
  mendrHome?: string;
};

export type RenderReviewViewOptions = {
  mendrHome?: string;
  reviewId: string;
};

export type ReviewViewSnapshot = ReviewState & {
  frame: string;
  spinner: string;
};

const agents = new Set<AgentName>(["claude", "codex"]);

export function parseCliArgs(argv: string[]): CliParseResult {
  const args = argv.slice(2);

  if (args[0] === "ls") {
    return {
      ok: true,
      command: "ls"
    };
  }

  if (args[0] === "view" || args[0] === "close" || args[0] === "stop") {
    const reviewId = args[1];

    if (!reviewId) {
      return {
        ok: false,
        exitCode: 1,
        error: `Expected a review id for ${args[0]}.`
      };
    }

    return {
      ok: true,
      command: args[0],
      reviewId
    };
  }

  const startArgs = args[0] === "start" ? args.slice(1) : args;
  const [agent, prArg, ...flags] = startArgs;

  if (!isAgent(agent)) {
    return {
      ok: false,
      exitCode: 1,
      error: "Unsupported agent. Expected claude or codex."
    };
  }

  const pr = normalizePr(prArg);

  if (!pr) {
    return {
      ok: false,
      exitCode: 1,
      error: "Expected a pull request number or GitHub pull request URL."
    };
  }

  const rounds = parseRounds(flags);

  if (!rounds.ok) {
    return rounds;
  }

  return {
    ok: true,
    command: "start",
    agent,
    pr,
    maxRounds: rounds.maxRounds
  };
}

export async function startReview(options: StartReviewOptions): Promise<StartReviewResult> {
  const exec = options.exec ?? defaultExec;
  const mendrHome = options.mendrHome ?? defaultMendrHome();
  const cwd = options.cwd ?? process.cwd();

  await preflight({
    exec,
    cwd,
    agent: options.agent,
    pr: options.pr
  });

  const repo = await getRepoRoot(exec, cwd);
  const branch = await getCurrentBranch(exec, repo);
  const id = options.createId?.() ?? createReviewId();
  const dir = reviewDir(mendrHome, id);
  const initialState: ReviewState = {
    phase: "starting",
    currentStatus: "Starting",
    issuesFound: 0,
    issuesFixed: 0,
    done: false,
    capReached: false
  };

  await ensureMendrHome(mendrHome);
  await writeMeta(mendrHome, id, {
    id,
    agent: options.agent,
    pr: options.pr,
    repo,
    branch,
    startedAt: new Date().toISOString(),
    pid: 0,
    maxRounds: options.maxRounds
  });
  await writeState(mendrHome, id, initialState);

  const daemon = (options.spawnDaemon ?? defaultSpawnDaemon)({
    mendrHome,
    reviewId: id
  });

  daemon.unref();
  await writeMeta(mendrHome, id, {
    id,
    agent: options.agent,
    pr: options.pr,
    repo,
    branch,
    startedAt: new Date().toISOString(),
    pid: daemon.pid,
    maxRounds: options.maxRounds
  });

  return {
    id,
    reviewDir: dir
  };
}

export async function renderReviewList(options: RenderReviewListOptions = {}): Promise<string> {
  const mendrHome = options.mendrHome ?? defaultMendrHome();
  const rows: string[] = ["ID                  Agent   PR    Status                 Found  Fixed"];
  let entries: string[];

  try {
    entries = await readdir(reviewsDir(mendrHome));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "No review sessions.";
    }

    throw error;
  }

  for (const id of entries.sort()) {
    try {
      const [meta, state] = await Promise.all([
        readMeta(mendrHome, id),
        readState(mendrHome, id)
      ]);

      rows.push(
        [
          meta.id.padEnd(19),
          meta.agent.padEnd(7),
          meta.pr.padEnd(5),
          state.currentStatus.padEnd(22),
          `${state.issuesFound} found`.padEnd(7),
          `${state.issuesFixed} fixed`
        ].join(" ")
      );
    } catch {
      // Incomplete directories are ignored so ls remains useful after crashes.
    }
  }

  return rows.length === 1 ? "No review sessions." : rows.join("\n");
}

export async function renderReviewViewSnapshot(
  options: RenderReviewViewOptions
): Promise<ReviewViewSnapshot> {
  const mendrHome = options.mendrHome ?? defaultMendrHome();
  const [meta, state, events] = await Promise.all([
    readMeta(mendrHome, options.reviewId),
    readState(mendrHome, options.reviewId),
    readEvents(mendrHome, options.reviewId)
  ]);
  const recentEvents = events
    .slice(-5)
    .map((event) => `${event.status}: ${event.detail}`)
    .join("\n");
  const frame = [
    `Review ${meta.id}`,
    `Agent: ${meta.agent}`,
    `PR: ${meta.pr}`,
    `Status: ${state.currentStatus}`,
    `Issues: ${state.issuesFound} found, ${state.issuesFixed} fixed`,
    state.capReached ? "Round cap reached" : "",
    recentEvents
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ...state,
    frame,
    spinner: state.done ? "" : "."
  };
}

export async function closeReview(options: RenderReviewViewOptions): Promise<void> {
  await closeReviewSession(options.mendrHome ?? defaultMendrHome(), options.reviewId);
}

function isAgent(value: string | undefined): value is AgentName {
  return value !== undefined && agents.has(value as AgentName);
}

function normalizePr(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (/^\d+$/.test(value)) {
    return value;
  }

  const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#].*)?$/.exec(value);

  return match?.[1];
}

function parseRounds(
  flags: string[]
): { ok: true; maxRounds: number } | { ok: false; exitCode: 1; error: string } {
  let maxRounds = 3;

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];

    if (flag !== "--rounds" && flag !== "-r") {
      return {
        ok: false,
        exitCode: 1,
        error: `Unsupported option: ${flag}`
      };
    }

    const rawRounds = flags[index + 1];
    const parsed = rawRounds ? Number(rawRounds) : NaN;

    if (!Number.isInteger(parsed) || parsed < 1) {
      return {
        ok: false,
        exitCode: 1,
        error: "Invalid rounds value. Expected a positive integer."
      };
    }

    maxRounds = parsed;
    index += 1;
  }

  return {
    ok: true,
    maxRounds
  };
}

async function preflight(input: {
  exec: ExecFn;
  cwd: string;
  agent: AgentName;
  pr: string;
}): Promise<void> {
  await assertBinary(input.exec, "git", ["--version"], input.cwd);
  await assertBinary(input.exec, "gh", ["--version"], input.cwd);
  await assertBinary(input.exec, input.agent, ["--version"], input.cwd);

  const auth = await input.exec("gh", ["auth", "status"], { cwd: input.cwd });

  if (auth.exitCode !== 0) {
    throw new Error("GitHub CLI is not authenticated. Run gh auth login before starting mendr.");
  }

  const repo = await getRepoRoot(input.exec, input.cwd);

  await validatePullRequest(input.exec, repo, input.pr);
}

async function assertBinary(
  exec: ExecFn,
  command: string,
  args: string[],
  cwd: string
): Promise<void> {
  try {
    await execOk(exec, command, args, { cwd });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${command} not found. Install ${command} before starting mendr.`);
    }

    throw error;
  }
}

function defaultSpawnDaemon(args: SpawnDaemonArgs): SpawnedDaemon {
  const daemonPath = fileURLToPath(new URL("./daemon.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [daemonPath, "--home", args.mendrHome, "--id", args.reviewId],
    {
      detached: true,
      stdio: "ignore"
    }
  );

  return {
    pid: child.pid ?? 0,
    unref: () => child.unref()
  };
}

function createReviewId(): string {
  return `review-${randomUUID().slice(0, 8)}`;
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseCliArgs(argv);

  if (!parsed.ok) {
    console.error(parsed.error);
    process.exitCode = parsed.exitCode;
    return;
  }

  if (parsed.command === "ls") {
    console.log(await renderReviewList());
    return;
  }

  if (parsed.command === "view") {
    const snapshot = await renderReviewViewSnapshot({ reviewId: parsed.reviewId });

    console.log(snapshot.frame);
    return;
  }

  if (parsed.command === "close" || parsed.command === "stop") {
    await closeReview({ reviewId: parsed.reviewId });
    console.log(`Closed ${parsed.reviewId}`);
    return;
  }

  if (parsed.command === "start") {
    const result = await startReview({
      agent: parsed.agent,
      pr: parsed.pr,
      maxRounds: parsed.maxRounds
    });

    console.log(`Started ${result.id}`);
    console.log(result.reviewDir);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
