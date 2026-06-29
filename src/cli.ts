#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
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
  type ReviewMetaWithDefaults,
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
  terminalColumns?: number;
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

type ReviewSessionRecord = {
  storageId: string;
  meta: ReviewMetaWithDefaults;
  state: ReviewState;
};

type ReviewSession = ReviewSessionRecord & {
  displayId: number;
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
  await ensureMendrHome(mendrHome);

  const id = options.createId?.() ?? (await createReviewId(mendrHome));
  const dir = reviewDir(mendrHome, id);
  const initialState: ReviewState = {
    phase: "starting",
    currentStatus: "Starting",
    issuesFound: 0,
    issuesFixed: 0,
    done: false,
    capReached: false
  };

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
  const sessions = await readReviewSessions(mendrHome);

  if (sessions.length === 0) {
    return "No review sessions.";
  }

  const terminalColumns = normalizeTerminalColumns(options.terminalColumns);

  return sessions.map((session) => formatReviewListItem(session, terminalColumns)).join("\n");
}

export async function renderReviewViewSnapshot(
  options: RenderReviewViewOptions
): Promise<ReviewViewSnapshot> {
  const mendrHome = options.mendrHome ?? defaultMendrHome();
  const identity = await resolveReviewSessionId(mendrHome, options.reviewId);
  const [meta, state, events] = await Promise.all([
    readMeta(mendrHome, identity.storageId),
    readState(mendrHome, identity.storageId),
    readEvents(mendrHome, identity.storageId)
  ]);
  const recentEvents = events
    .slice(-5)
    .map((event) => `${event.status}: ${event.detail}`);
  const frame = [
    `Review ${identity.displayId}`,
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
    reviewId: identity.displayId,
    agent: meta.agent,
    pr: meta.pr,
    recentEvents,
    frame,
    spinner: state.done ? "" : "."
  };
}

export async function closeReview(options: RenderReviewViewOptions): Promise<void> {
  const mendrHome = options.mendrHome ?? defaultMendrHome();
  const identity = await resolveReviewSessionId(mendrHome, options.reviewId);

  await closeReviewSession(mendrHome, identity.storageId);
}

export async function stopReview(options: StopReviewOptions): Promise<void> {
  const mendrHome = options.mendrHome ?? defaultMendrHome();
  const killProcess = options.killProcess ?? process.kill;
  const identity = await resolveReviewSessionId(mendrHome, options.reviewId);
  const [meta, state] = await Promise.all([
    readMeta(mendrHome, identity.storageId),
    readState(mendrHome, identity.storageId)
  ]);
  let detail = "No daemon pid was recorded.";

  if (meta.pid > 0) {
    try {
      killProcess(-meta.pid, "SIGTERM");
      detail = `Sent SIGTERM to daemon process group ${meta.pid}.`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        detail = `Daemon process group ${meta.pid} was not running.`;
      } else {
        throw error;
      }
    }
  }

  await writeState(mendrHome, identity.storageId, {
    ...state,
    phase: "stopped",
    currentStatus: "Stopped",
    done: true
  });
  await appendEvent(mendrHome, identity.storageId, {
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

async function createReviewId(mendrHome: string): Promise<string> {
  const sessions = await readReviewSessions(mendrHome);
  let candidate =
    sessions.length === 0
      ? 1
      : Math.max(...sessions.map((session) => session.displayId)) + 1;

  for (;;) {
    const id = String(candidate);

    try {
      await mkdir(reviewDir(mendrHome, id));
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        candidate += 1;
        continue;
      }

      throw error;
    }
  }
}

async function readReviewSessions(mendrHome: string): Promise<ReviewSession[]> {
  let entries: string[];

  try {
    entries = await readdir(reviewsDir(mendrHome));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const records = await Promise.all(
    entries.sort().map(async (id): Promise<ReviewSessionRecord | undefined> => {
      try {
        const [meta, state] = await Promise.all([
          readMeta(mendrHome, id),
          readState(mendrHome, id)
        ]);

        return {
          storageId: id,
          meta,
          state
        };
      } catch {
        // Incomplete directories are ignored so ls remains useful after crashes.
        return undefined;
      }
    })
  );

  return assignDisplayIds(records.filter(isReviewSessionRecord));
}

function assignDisplayIds(records: ReviewSessionRecord[]): ReviewSession[] {
  const usedIds = new Set(
    records.flatMap((record) => {
      const numericId = parsePositiveInteger(record.storageId);

      return numericId === undefined ? [] : [numericId];
    })
  );
  let nextLegacyId = 1;
  const sessions = [...records]
    .sort(compareReviewRecords)
    .map((record): ReviewSession => {
      const numericId = parsePositiveInteger(record.storageId);

      if (numericId !== undefined) {
        return {
          ...record,
          displayId: numericId
        };
      }

      while (usedIds.has(nextLegacyId)) {
        nextLegacyId += 1;
      }

      usedIds.add(nextLegacyId);

      return {
        ...record,
        displayId: nextLegacyId++
      };
    });

  return sessions.sort((a, b) => a.displayId - b.displayId);
}

function isReviewSessionRecord(
  record: ReviewSessionRecord | undefined
): record is ReviewSessionRecord {
  return record !== undefined;
}

async function resolveReviewSessionId(
  mendrHome: string,
  requestedId: string
): Promise<{ storageId: string; displayId: string }> {
  const sessions = await readReviewSessions(mendrHome);
  const directMatch = sessions.find(
    (session) => session.storageId === requestedId || session.meta.id === requestedId
  );

  if (directMatch) {
    return {
      storageId: directMatch.storageId,
      displayId: String(directMatch.displayId)
    };
  }

  const numericId = parsePositiveInteger(requestedId);
  const displayMatch =
    numericId === undefined
      ? undefined
      : sessions.find((session) => session.displayId === numericId);

  if (displayMatch) {
    return {
      storageId: displayMatch.storageId,
      displayId: String(displayMatch.displayId)
    };
  }

  return {
    storageId: requestedId,
    displayId: requestedId
  };
}

function formatReviewListItem(session: ReviewSession, terminalColumns: number): string {
  const summary = [
    `${session.displayId}: ${formatAgentLabel(session.meta)}`,
    `(PR ${session.meta.pr})`,
    `(${session.state.currentStatus})`,
    `(Found: ${session.state.issuesFound})`,
    `(Fixed: ${session.state.issuesFixed})`
  ].join(" ");

  if (summary.length <= terminalColumns) {
    return summary;
  }

  return [
    `${session.displayId}: ${formatAgentLabel(session.meta)}`,
    `   PR ${session.meta.pr}`,
    `   Status: ${session.state.currentStatus}`,
    `   Found: ${session.state.issuesFound}`,
    `   Fixed: ${session.state.issuesFixed}`
  ].join("\n");
}

function formatAgentLabel(meta: ReviewMetaWithDefaults): string {
  return meta.effort ? `${meta.agent}(${meta.effort})` : meta.agent;
}

function normalizeTerminalColumns(columns: number | undefined): number {
  const resolved = columns ?? process.stdout.columns ?? 80;

  return Number.isFinite(resolved) && resolved > 0 ? resolved : 80;
}

function compareReviewRecords(a: ReviewSessionRecord, b: ReviewSessionRecord): number {
  const startedAtDiff = parseTimestamp(a.meta.startedAt) - parseTimestamp(b.meta.startedAt);

  return startedAtDiff || a.storageId.localeCompare(b.storageId);
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);

  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) ? parsed : undefined;
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

export function isCliEntrypoint(
  invokedPath: string | undefined,
  modulePath = fileURLToPath(import.meta.url)
): boolean {
  if (!invokedPath) {
    return false;
  }

  if (invokedPath === modulePath) {
    return true;
  }

  try {
    return realpathSync(invokedPath) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isCliEntrypoint(process.argv[1])) {
  main(process.argv).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
