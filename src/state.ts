import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reviewDir, reviewsDir } from "./paths.js";

export type ReviewMeta = {
  id: string;
  agent: string;
  pr: string;
  repo: string;
  branch: string;
  branchPushRemote?: string;
  worktreePath?: string;
  startedAt: string;
  pid: number;
  model?: string;
  effort?: string;
  maxRounds?: number;
};

export type ReviewMetaWithDefaults = ReviewMeta & {
  maxRounds: number;
};

export type ReviewState = {
  phase: string;
  currentStatus: string;
  issuesFound: number;
  issuesFixed: number;
  done: boolean;
  capReached: boolean;
  error?: string;
};

export type ReviewEventInput = {
  status: string;
  detail: string;
};

export type ReviewEvent = ReviewEventInput & {
  ts: string;
};

export type IssueRecord = {
  sessionId: string;
  round: number;
  issueIndex: number;
  fingerprint: string;
  title: string;
  file: string;
  line: number;
  severity: string;
  description: string;
};

export type FixAttemptRecord = {
  sessionId: string;
  round: number;
  issueIndex: number;
  fingerprint: string;
  title: string;
  status: "fixed" | "failed";
  summary: string;
  commitSha?: string;
};

export async function writeMeta(home: string, id: string, meta: ReviewMeta): Promise<void> {
  await ensureMendrHome(home);
  await writeJson(home, id, "meta.json", meta);
}

export async function readMeta(home: string, id: string): Promise<ReviewMetaWithDefaults> {
  const meta = await readJson<ReviewMeta>(home, id, "meta.json");

  return {
    ...meta,
    maxRounds: meta.maxRounds ?? 3
  };
}

export async function writeState(home: string, id: string, state: ReviewState): Promise<void> {
  await ensureMendrHome(home);
  await writeJson(home, id, "state.json", state);
}

export async function readState(home: string, id: string): Promise<ReviewState> {
  return readJson<ReviewState>(home, id, "state.json");
}

export async function appendEvent(
  home: string,
  id: string,
  event: ReviewEventInput
): Promise<void> {
  const dir = reviewDir(home, id);
  const line = JSON.stringify({
    ...event,
    ts: new Date().toISOString()
  });

  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "events.log"), `${line}\n`, "utf8");
}

export async function appendIssueRecord(
  home: string,
  id: string,
  issue: IssueRecord
): Promise<void> {
  await appendJsonl(home, id, "issues.jsonl", issue);
}

export async function appendFixAttempt(
  home: string,
  id: string,
  attempt: FixAttemptRecord
): Promise<void> {
  await appendJsonl(home, id, "fixes.jsonl", attempt);
}

export async function ensureMendrHome(home: string): Promise<void> {
  await mkdir(reviewsDir(home), { recursive: true });
}

export async function closeReviewSession(home: string, id: string): Promise<void> {
  await rm(reviewDir(home, id), { recursive: true, force: true });
}

export async function readEvents(home: string, id: string): Promise<ReviewEvent[]> {
  let raw: string;

  try {
    raw = await readFile(join(reviewDir(home, id), "events.log"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ReviewEvent];
      } catch {
        return [];
      }
    });
}

async function writeJson(
  home: string,
  id: string,
  fileName: string,
  value: unknown
): Promise<void> {
  const dir = reviewDir(home, id);

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendJsonl(
  home: string,
  id: string,
  fileName: string,
  value: unknown
): Promise<void> {
  const dir = reviewDir(home, id);

  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, fileName), `${JSON.stringify(value)}\n`, "utf8");
}

async function readJson<T>(home: string, id: string, fileName: string): Promise<T> {
  return JSON.parse(await readFile(join(reviewDir(home, id), fileName), "utf8")) as T;
}
