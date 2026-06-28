import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendEvent,
  readEvents,
  readMeta,
  readState,
  writeMeta,
  writeState
} from "../src/state";

const tmpRoots: string[] = [];

async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), "mendr-state-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.useRealTimers();

  await Promise.all(
    tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("state persistence helpers", () => {
  it("round-trips meta and applies the default maxRounds value", async () => {
    const home = await makeHome();
    const id = "swift-otter-3f9a";
    const meta = {
      id,
      agent: "claude",
      pr: "42",
      repo: "/work/repo",
      branch: "feature/review",
      startedAt: "2026-06-28T17:00:00.000Z",
      pid: 12345
    };

    await writeMeta(home, id, meta);

    await expect(readMeta(home, id)).resolves.toEqual({
      ...meta,
      maxRounds: 3
    });
  });

  it("round-trips review state without changing the schema", async () => {
    const home = await makeHome();
    const id = "steady-moon-2ab1";
    const state = {
      phase: "reviewing",
      currentStatus: "Discovering bugs",
      issuesFound: 2,
      issuesFixed: 1,
      done: false,
      capReached: false
    };

    await writeState(home, id, state);

    await expect(readState(home, id)).resolves.toEqual(state);
  });

  it("appends one valid JSON object per event line with monotonic timestamps", async () => {
    vi.useFakeTimers();

    const home = await makeHome();
    const id = "eventful-brook-7c2d";

    vi.setSystemTime(new Date("2026-06-28T17:00:00.000Z"));
    await appendEvent(home, id, {
      status: "Discovering bugs",
      detail: "review round 1"
    });

    vi.setSystemTime(new Date("2026-06-28T17:00:01.000Z"));
    await appendEvent(home, id, {
      status: "Resolving issues",
      detail: "fixing issue 1"
    });

    const rawLog = await readFile(join(home, "reviews", id, "events.log"), "utf8");
    const events = rawLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      status: "Discovering bugs",
      detail: "review round 1"
    });
    expect(events[1]).toMatchObject({
      status: "Resolving issues",
      detail: "fixing issue 1"
    });
    expect(Date.parse(events[0].ts)).toBeLessThanOrEqual(Date.parse(events[1].ts));
  });

  it("skips corrupt event log lines while preserving valid events", async () => {
    const home = await makeHome();
    const id = "patched-river-18ce";
    const reviewDir = join(home, "reviews", id);
    const firstEvent = {
      status: "Discovering bugs",
      detail: "round 1",
      ts: "2026-06-28T17:00:00.000Z"
    };
    const secondEvent = {
      status: "Complete",
      detail: "done",
      ts: "2026-06-28T17:00:03.000Z"
    };

    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      join(reviewDir, "events.log"),
      [
        JSON.stringify(firstEvent),
        "{this is not valid json",
        "",
        JSON.stringify(secondEvent)
      ].join("\n")
    );

    await expect(readEvents(home, id)).resolves.toEqual([firstEvent, secondEvent]);
  });
});
