import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { renderReviewList, renderReviewViewSnapshot } from "../../src/cli.js";

type ReviewState = {
  phase: string;
  currentStatus: string;
  issuesFound: number;
  issuesFixed: number;
  done: boolean;
  capReached?: boolean;
};

type ReviewMeta = {
  id: string;
  agent: "claude" | "codex";
  pr: string;
  repo: string;
  branch: string;
  startedAt: string;
  pid: number;
  maxRounds: number;
};

const tmpRoots: string[] = [];

async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), "mendr-cli-"));
  tmpRoots.push(root);
  return root;
}

async function seedReview(
  home: string,
  id: string,
  meta: Partial<ReviewMeta>,
  state?: ReviewState
) {
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
        pid: 1111,
        maxRounds: 3,
        ...meta
      },
      null,
      2
    )
  );

  if (state) {
    await writeFile(join(reviewDir, "state.json"), JSON.stringify(state, null, 2));
  }

  return reviewDir;
}

async function appendEvents(
  reviewDir: string,
  events: Array<{ status: string; detail: string; ts: string }>
) {
  await writeFile(
    join(reviewDir, "events.log"),
    events.map((event) => JSON.stringify(event)).join("\n")
  );
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("CLI file-backed integration", () => {
  it("renders ls output from review state files and skips incomplete dirs", async () => {
    const home = await makeHome();

    await seedReview(
      home,
      "swift-otter-3f9a",
      { agent: "claude", pr: "42", pid: 1001 },
      {
        phase: "reviewing",
        currentStatus: "Discovering bugs",
        issuesFound: 2,
        issuesFixed: 1,
        done: false,
        capReached: false
      }
    );
    await seedReview(
      home,
      "steady-moon-2ab1",
      { agent: "codex", pr: "77", pid: 1002 },
      {
        phase: "posting",
        currentStatus: "Posting review",
        issuesFound: 3,
        issuesFixed: 3,
        done: true,
        capReached: false
      }
    );
    await seedReview(home, "missing-state-9999", { agent: "claude", pr: "88" });

    const table = await renderReviewList({ mendrHome: home });

    expect(table).toContain("swift-otter-3f9a");
    expect(table).toContain("claude");
    expect(table).toContain("42");
    expect(table).toContain("Discovering bugs");
    expect(table).toMatch(/2\s+found/i);
    expect(table).toMatch(/1\s+fixed/i);
    expect(table).toContain("steady-moon-2ab1");
    expect(table).toContain("codex");
    expect(table).toContain("77");
    expect(table).toContain("Posting review");
    expect(table).not.toContain("missing-state-9999");
  });

  it("renders view status from events and reports done when state is complete", async () => {
    const home = await makeHome();
    const id = "eventful-brook-7c2d";
    const reviewDir = await seedReview(
      home,
      id,
      { agent: "claude", pr: "42" },
      {
        phase: "fixing",
        currentStatus: "Resolving issues",
        issuesFound: 2,
        issuesFixed: 1,
        done: false,
        capReached: false
      }
    );
    await appendEvents(reviewDir, [
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
    ]);

    const activeSnapshot = await renderReviewViewSnapshot({
      mendrHome: home,
      reviewId: id
    });

    expect(activeSnapshot).toMatchObject({
      done: false,
      currentStatus: "Resolving issues"
    });
    expect(activeSnapshot.frame).toContain("Resolving issues");
    expect(activeSnapshot.frame).toMatch(/2\s+found/i);
    expect(activeSnapshot.frame).toMatch(/1\s+fixed/i);
    expect(activeSnapshot.spinner).toEqual(expect.any(String));
    expect(activeSnapshot.spinner.length).toBeGreaterThan(0);

    await writeFile(
      join(reviewDir, "state.json"),
      JSON.stringify(
        {
          phase: "complete",
          currentStatus: "Complete",
          issuesFound: 2,
          issuesFixed: 2,
          done: true,
          capReached: false
        },
        null,
        2
      )
    );
    await appendEvents(reviewDir, [
      {
        status: "Resolving issues",
        detail: "fixing issue 2",
        ts: "2026-06-28T17:00:02.000Z"
      },
      {
        status: "Complete",
        detail: "done",
        ts: "2026-06-28T17:00:03.000Z"
      }
    ]);

    const doneSnapshot = await renderReviewViewSnapshot({
      mendrHome: home,
      reviewId: id
    });

    expect(doneSnapshot).toMatchObject({
      done: true,
      currentStatus: "Complete"
    });
    expect(doneSnapshot.frame).toContain("Complete");
    expect(doneSnapshot.frame).toMatch(/2\s+fixed/i);
  });
});
