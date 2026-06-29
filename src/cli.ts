import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { Box, Text, render, useApp } from "ink";
import Spinner from "ink-spinner";
import React, { useEffect, useState } from "react";

import {
  allowedEffortsForAgent,
  defaultEffortForAgent,
  defaultModelForAgent,
  isEffortForAgent
} from "./agents/driver.js";
import type { AgentName, EffortLevel } from "./agents/types.js";
import { defaultExec, execOk, type ExecFn } from "./exec.js";
import { getCurrentBranch, getRepoRoot } from "./git.js";
import { validatePullRequest } from "./github.js";
import { defaultMendrHome, reviewDir, reviewsDir } from "./paths.js";
import {
  appendEvent,
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
      model?: string;
      effort?: EffortLevel;
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
  model?: string;
  effort?: EffortLevel;
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
  reviewId: string;
  agent: string;
  pr: string;
  recentEvents: string[];
  frame: string;
  spinner: string;
};

export type StopReviewOptions = RenderReviewViewOptions & {
  killProcess?: (pid: number, signal?: NodeJS.Signals) => boolean;
};

export type LiveReviewViewOptions = RenderReviewViewOptions & {
  pollIntervalMs?: number;
  loadSnapshot?: (options: RenderReviewViewOptions) => Promise<ReviewViewSnapshot>;
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

  const startOptions = parseStartFlags(agent, flags);

  if (!startOptions.ok) {
    return startOptions;
  }

  return {
    ok: true,
    command: "start",
    agent,
    pr,
    maxRounds: startOptions.maxRounds,
    ...(startOptions.model ? { model: startOptions.model } : {}),
    ...(startOptions.effort ? { effort: startOptions.effort } : {})
  };
}

export async function startReview(options: StartReviewOptions): Promise<StartReviewResult> {
  const exec = options.exec ?? defaultExec;
  const mendrHome = options.mendrHome ?? defaultMendrHome();
  const cwd = options.cwd ?? process.cwd();
  const model = options.model ?? defaultModelForAgent(options.agent);
  const effort = options.effort ?? defaultEffortForAgent(options.agent);

  if (!isEffortForAgent(options.agent, effort)) {
    throw new Error(
      `Invalid ${options.agent} effort "${effort}". Expected one of: ${allowedEffortsForAgent(options.agent).join(", ")}.`
    );
  }

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
    model,
    effort,
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
    model,
    effort,
    maxRounds: options.maxRounds
  });

  return {
    id,
    reviewDir: dir
  };
}

export async function renderReviewList(options: RenderReviewListOptions = {}): Promise<string> {
  const mendrHome = options.mendrHome ?? defaultMendrHome();
  const rows: string[] = ["ID                  Agent   PR    Phase      Status                 Found  Fixed"];
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
          state.phase.padEnd(10),
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
    .map((event) => `${event.status}: ${event.detail}`);
  const frame = [
    `Review ${meta.id}`,
    `Agent: ${meta.agent}`,
    `PR: ${meta.pr}`,
    `Status: ${state.currentStatus}`,
    `Issues: ${state.issuesFound} found, ${state.issuesFixed} fixed`,
    state.capReached ? "Round cap reached" : "",
    recentEvents.join("\n")
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ...state,
    reviewId: meta.id,
    agent: meta.agent,
    pr: meta.pr,
    recentEvents,
    frame,
    spinner: state.done ? "" : "."
  };
}

export async function closeReview(options: RenderReviewViewOptions): Promise<void> {
  await closeReviewSession(options.mendrHome ?? defaultMendrHome(), options.reviewId);
}

export async function stopReview(options: StopReviewOptions): Promise<void> {
  const mendrHome = options.mendrHome ?? defaultMendrHome();
  const killProcess = options.killProcess ?? process.kill;
  const [meta, state] = await Promise.all([
    readMeta(mendrHome, options.reviewId),
    readState(mendrHome, options.reviewId)
  ]);
  let detail = "No daemon pid was recorded.";

  if (meta.pid > 0) {
    try {
      killProcess(meta.pid, "SIGTERM");
      detail = `Sent SIGTERM to daemon pid ${meta.pid}.`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        detail = `Daemon pid ${meta.pid} was not running.`;
      } else {
        throw error;
      }
    }
  }

  await writeState(mendrHome, options.reviewId, {
    ...state,
    phase: "stopped",
    currentStatus: "Stopped",
    done: true
  });
  await appendEvent(mendrHome, options.reviewId, {
    status: "Stopped",
    detail
  });
}

export async function startLiveReviewView(options: LiveReviewViewOptions): Promise<void> {
  const app = render(
    React.createElement(ReviewView, {
      mendrHome: options.mendrHome,
      reviewId: options.reviewId,
      pollIntervalMs: options.pollIntervalMs,
      loadSnapshot: options.loadSnapshot
    })
  );

  await app.waitUntilExit();
}

export function ReviewView(props: LiveReviewViewOptions): React.ReactElement {
  const { exit } = useApp();
  const loadSnapshot = props.loadSnapshot ?? renderReviewViewSnapshot;
  const [snapshot, setSnapshot] = useState<ReviewViewSnapshot | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    let shouldExit = false;

    async function refresh(): Promise<void> {
      try {
        const next = await loadSnapshot({
          mendrHome: props.mendrHome,
          reviewId: props.reviewId
        });

        if (!active) {
          return;
        }

        setSnapshot(next);
        setError(undefined);

        if (next.done && !shouldExit) {
          shouldExit = true;
          setTimeout(() => exit(), 0);
        }
      } catch (refreshError) {
        if (!active) {
          return;
        }

        setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      }
    }

    void refresh();
    const interval = setInterval(refresh, props.pollIntervalMs ?? 1000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [exit, loadSnapshot, props.mendrHome, props.pollIntervalMs, props.reviewId]);

  if (error) {
    return React.createElement(Text, { color: "red" }, error);
  }

  if (!snapshot) {
    return React.createElement(
      Text,
      null,
      React.createElement(Spinner, { type: "dots" }),
      " Loading review..."
    );
  }

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, { bold: true }, `Review ${snapshot.reviewId}`),
    React.createElement(Text, null, `Agent: ${snapshot.agent}`),
    React.createElement(Text, null, `PR: ${snapshot.pr}`),
    React.createElement(
      Text,
      null,
      snapshot.done ? "" : React.createElement(Spinner, { type: "dots" }),
      snapshot.done ? "" : " ",
      snapshot.currentStatus
    ),
    React.createElement(
      Text,
      null,
      `Issues: ${snapshot.issuesFound} found, ${snapshot.issuesFixed} fixed`
    ),
    snapshot.capReached
      ? React.createElement(Text, { color: "yellow" }, "Round cap reached")
      : null,
    ...snapshot.recentEvents.map((event) =>
      React.createElement(Text, { key: event, dimColor: true }, event)
    )
  );
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

type StartFlagParseResult =
  | {
      ok: true;
      maxRounds: number;
      model?: string;
      effort?: EffortLevel;
    }
  | { ok: false; exitCode: 1; error: string };

function parseStartFlags(agent: AgentName, flags: string[]): StartFlagParseResult {
  let maxRounds = 3;
  let model: string | undefined;
  let effort: EffortLevel | undefined;

  for (let index = 0; index < flags.length; index += 1) {
    const parsedFlag = parseOptionFlag(flags[index]);
    const flag = parsedFlag.name;

    if (
      flag !== "--rounds" &&
      flag !== "-r" &&
      flag !== "--model" &&
      flag !== "-m" &&
      flag !== "--effort" &&
      flag !== "-e"
    ) {
      return {
        ok: false,
        exitCode: 1,
        error: `Unsupported option: ${flag}`
      };
    }

    const hasInlineValue = parsedFlag.value !== undefined;
    const rawValue = parsedFlag.value ?? flags[index + 1];

    if (!rawValue) {
      return {
        ok: false,
        exitCode: 1,
        error: `Missing value for ${flag}.`
      };
    }

    if (
      !hasInlineValue &&
      (flag === "--model" || flag === "-m" || flag === "--effort" || flag === "-e") &&
      rawValue.startsWith("-")
    ) {
      return {
        ok: false,
        exitCode: 1,
        error: `Missing value for ${flag}.`
      };
    }

    if (!hasInlineValue) {
      index += 1;
    }

    if (flag === "--rounds" || flag === "-r") {
      const parsed = Number(rawValue);

      if (!Number.isInteger(parsed) || parsed < 1) {
        return {
          ok: false,
          exitCode: 1,
          error: "Invalid rounds value. Expected a positive integer."
        };
      }

      maxRounds = parsed;
      continue;
    }

    if (flag === "--model" || flag === "-m") {
      model = rawValue;
      continue;
    }

    if (!isEffortForAgent(agent, rawValue)) {
      return {
        ok: false,
        exitCode: 1,
        error: `Invalid ${agent} effort. Expected one of: ${allowedEffortsForAgent(agent).join(", ")}.`
      };
    }

    effort = rawValue;
  }

  return {
    ok: true,
    maxRounds,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  };
}

function parseOptionFlag(raw: string): { name: string; value?: string } {
  const equalsIndex = raw.indexOf("=");

  if (equalsIndex === -1) {
    return { name: raw };
  }

  return {
    name: raw.slice(0, equalsIndex),
    value: raw.slice(equalsIndex + 1)
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
  const program = new Command();

  program
    .name("mendr")
    .description("Run an autonomous agentic review loop on a GitHub pull request.")
    .argument("[agent]", "agent CLI to use: claude or codex")
    .argument("[pr]", "pull request number or GitHub pull request URL")
    .option("-r, --rounds <n>", "maximum review and fix iterations", "3")
    .option("-m, --model <model>", "agent model override")
    .option("-e, --effort <effort>", "agent effort override")
    .action(
      async (
        agent: string | undefined,
        prArg: string | undefined,
        options: { rounds: string; model?: string; effort?: string }
      ) => {
        if (!agent && !prArg) {
          program.help();
        }

        if (!isAgent(agent)) {
          throw new Error("Unsupported agent. Expected claude or codex.");
        }

        const pr = normalizePr(prArg);

        if (!pr) {
          throw new Error("Expected a pull request number or GitHub pull request URL.");
        }

        const flags = [
          "--rounds",
          options.rounds,
          ...(options.model ? ["--model", options.model] : []),
          ...(options.effort ? ["--effort", options.effort] : [])
        ];
        const parsedOptions = parseStartFlags(agent, flags);

        if (!parsedOptions.ok) {
          throw new Error(parsedOptions.error);
        }

        const result = await startReview({
          agent,
          pr,
          maxRounds: parsedOptions.maxRounds,
          model: parsedOptions.model,
          effort: parsedOptions.effort
        });

        console.log(`Started ${result.id}`);
        console.log(`View status: mendr view ${result.id}`);
        console.log(result.reviewDir);
      }
    );

  program
    .command("ls")
    .description("List review sessions.")
    .action(async () => {
      console.log(await renderReviewList());
    });

  program
    .command("view")
    .description("Watch a live review status view.")
    .argument("<id>", "review id")
    .action(async (reviewId: string) => {
      await startLiveReviewView({ reviewId });
    });

  program
    .command("stop")
    .description("Stop a running review daemon and keep its state on disk.")
    .argument("<id>", "review id")
    .action(async (reviewId: string) => {
      await stopReview({ reviewId });
      console.log(`Stopped ${reviewId}`);
    });

  program
    .command("close")
    .description("Remove a review session from local state.")
    .argument("<id>", "review id")
    .action(async (reviewId: string) => {
      await closeReview({ reviewId });
      console.log(`Closed ${reviewId}`);
    });

  await program.parseAsync(argv);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
