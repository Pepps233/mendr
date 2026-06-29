import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runOrchestrator } from "../../src/orchestrator.js";

type Issue = {
  title: string;
  file: string;
  line: number;
  severity: string;
  description: string;
};

type ReviewContext = {
  repo: string;
  pr: string;
  diff: string;
  reviewMarkdown: string;
  reportMarkdown: string;
};

type FixResult = {
  status?: "fixed" | "failed";
  sha?: string;
  summary: string;
};

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

const tmpRoots: string[] = [];

const rangeIssue: Issue = {
  title: "Prevent off-by-one diff ranges",
  file: "src/range.ts",
  line: 42,
  severity: "high",
  description: "The changed range excludes the final modified line."
};

const staleStateIssue: Issue = {
  title: "Refresh stale state reads",
  file: "src/state.ts",
  line: 31,
  severity: "medium",
  description: "The view command can render a stale status after a write failure."
};

function issueFingerprint(issue: Issue): string {
  return [
    issue.title.trim().replace(/\s+/g, " ").toLowerCase(),
    issue.file.trim().replace(/\s+/g, " ").toLowerCase(),
    String(issue.line),
    issue.description.trim().replace(/\s+/g, " ").toLowerCase()
  ].join("|");
}

async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), "mendr-orchestrator-edge-"));
  tmpRoots.push(root);
  return root;
}

async function seedReview(
  home: string,
  id: string,
  overrides: Record<string, unknown> = {}
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
        branch: "feature/range-fix",
        startedAt: "2026-06-28T17:00:00.000Z",
        pid: 12345,
        maxRounds: 3,
        ...overrides
      },
      null,
      2
    )
  );

  return reviewDir;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readEvents(reviewDir: string) {
  const raw = await readFile(join(reviewDir, "events.log"), "utf8");

  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { status: string; detail?: string });
}

function findCalls(calls: ExecCall[], command: string, args: string[]) {
  return calls.filter(
    (call) =>
      call.command === command &&
      args.every((arg, index) => call.args[index] === arg)
  );
}

function findCall(calls: ExecCall[], command: string, args: string[]) {
  return findCalls(calls, command, args)[0];
}

class AgentParseFailure extends Error {
  constructor(message = "Malformed agent JSON") {
    super(message);
    this.name = "AgentParseError";
  }
}

class ScriptedExec {
  readonly calls: ExecCall[] = [];

  private shaIndex = 0;

  private pushAttempts = 0;

  private commentAttempts = 0;

  constructor(
    private readonly options: {
      prView?: Record<string, unknown>;
      diff?: string;
      shas?: Array<string | Error | null>;
      pushFailures?: number;
      commentFailures?: number;
    } = {}
  ) {}

  run = async (
    command: string,
    args: string[],
    options?: unknown
  ): Promise<ExecResult> => {
    this.calls.push({ command, args, options });

    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          title: "Fix changed range parsing",
          body: "The parser currently drops the final changed line.",
          comments: [
            {
              author: { login: "reviewer" },
              body: "Please make sure empty comments do not break the review."
            }
          ],
          ...this.options.prView
        }),
        stderr: "",
        exitCode: 0
      };
    }

    if (command === "gh" && args[0] === "pr" && args[1] === "diff") {
      return {
        stdout:
          this.options.diff ??
          [
            "diff --git a/src/range.ts b/src/range.ts",
            "@@ -40,2 +40,2 @@",
            "-return end - 1;",
            "+return end;"
          ].join("\n"),
        stderr: "",
        exitCode: 0
      };
    }

    if (command === "gh" && args[0] === "pr" && args[1] === "comment") {
      this.commentAttempts += 1;

      if (this.commentAttempts <= (this.options.commentFailures ?? 0)) {
        return {
          stdout: "",
          stderr: "rate limit exceeded",
          exitCode: 1
        };
      }

      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "rev-parse" && args[1] === "--verify") {
      return { stdout: args[2]?.replace(/\^\{commit\}$/, "") ?? "", stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      const value = this.readHeadValue();
      this.shaIndex += 1;

      if (value instanceof Error) {
        throw value;
      }

      if (value === null) {
        return {
          stdout: "",
          stderr: "nothing to commit",
          exitCode: 1
        };
      }

      return { stdout: value, stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "push") {
      this.pushAttempts += 1;

      if (this.pushAttempts <= (this.options.pushFailures ?? 0)) {
        return {
          stdout: "",
          stderr: "non-fast-forward",
          exitCode: 1
        };
      }

      return { stdout: "", stderr: "", exitCode: 0 };
    }

    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  private readHeadValue(): string | Error | null {
    if (this.options.shas) {
      const scripted = this.options.shas[Math.min(this.shaIndex, this.options.shas.length - 1)];

      return scripted === undefined ? "abc1234" : scripted;
    }

    const fixIndex = Math.floor(this.shaIndex / 2);
    const isAfterFix = this.shaIndex % 2 === 1;

    if (!isAfterFix) {
      return fixIndex === 0 ? "base0000" : "abc1234";
    }

    return "abc1234";
  }
}

class ScriptedAgentDriver {
  readonly reviewContexts: ReviewContext[] = [];

  readonly fixContexts: Array<{ issues: Issue[]; ctx: ReviewContext }> = [];

  private reviewIndex = 0;

  private fixIndex = 0;

  constructor(
    private readonly reviews: Array<Issue[] | Error>,
    private readonly fixes: Array<FixResult | FixResult[] | Error> = []
  ) {}

  async review(ctx: ReviewContext): Promise<Issue[]> {
    this.reviewContexts.push(ctx);
    const result = this.reviews[Math.min(this.reviewIndex, this.reviews.length - 1)] ?? [];
    this.reviewIndex += 1;

    if (result instanceof Error) {
      throw result;
    }

    return result;
  }

  async fix(
    issues: Issue[],
    ctx: ReviewContext
  ): Promise<Array<FixResult & { title: string; fingerprint: string; status: "fixed" | "failed" }>> {
    this.fixContexts.push({ issues, ctx });
    const result = this.fixes[Math.min(this.fixIndex, this.fixes.length - 1)];
    this.fixIndex += 1;

    if (result instanceof Error) {
      throw result;
    }

    return issues.map((issue, index) => {
      const scripted = Array.isArray(result)
        ? result[index]
        : result ?? {
            summary:
              "Fixed the changed range calculation. Added coverage for the boundary case."
          };

      return {
        title: issue.title,
        fingerprint: issueFingerprint(issue),
        status: scripted.status ?? "fixed",
        sha: scripted.status === "failed" ? undefined : scripted.sha ?? "abc1234",
        summary: scripted.summary
      };
    });
  }
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("orchestrator edge and failure handling", () => {
  it("writes review markdown and proceeds when the PR has no comments", async () => {
    const home = await makeHome();
    const id = "silent-pr-4c91";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({
      prView: {
        comments: []
      }
    });
    const driver = new ScriptedAgentDriver([[]]);

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    const reviewMarkdown = await readFile(join(reviewDir, "review.md"), "utf8");

    expect(driver.reviewContexts).toHaveLength(1);
    expect(reviewMarkdown).toContain("Fix changed range parsing");
    expect(reviewMarkdown).toContain("The parser currently drops the final changed line.");
    expect(reviewMarkdown).toMatch(/no comments/i);
    expect(findCall(exec.calls, "gh", ["pr", "comment", "42"])).toBeDefined();
  });

  it("handles an empty PR diff by posting a valid no-issues report", async () => {
    const home = await makeHome();
    const id = "empty-diff-6a23";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ diff: "" });
    const driver = new ScriptedAgentDriver([[]]);

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    const reportMarkdown = await readFile(join(reviewDir, "report.md"), "utf8");
    const events = await readEvents(reviewDir);

    expect(driver.reviewContexts).toHaveLength(1);
    expect(driver.reviewContexts[0].diff).toBe("");
    expect(driver.fixContexts).toHaveLength(0);
    expect(reportMarkdown.match(/^## Summary$/gm)).toHaveLength(1);
    expect(reportMarkdown).toMatch(/no changed-scope issues found/i);
    expect(findCall(exec.calls, "gh", ["pr", "comment", "42"])).toBeDefined();
    expect(events.map((event) => event.status)).toEqual([
      "Discovering bugs",
      "Posting review",
      "Complete"
    ]);
  });

  it("records first-round review agent failures without pushing or commenting", async () => {
    const home = await makeHome();
    const id = "review-crash-2f19";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec();
    const driver = new ScriptedAgentDriver([new AgentParseFailure()]);

    await expect(
      runOrchestrator({
        mendrHome: home,
        reviewId: id,
        agentDriver: driver,
        exec: exec.run
      })
    ).rejects.toThrow("Malformed agent JSON");

    const state = await readJson<{ currentStatus: string; error: string }>(
      join(reviewDir, "state.json")
    );
    const events = await readEvents(reviewDir);

    expect(state.currentStatus).toMatch(/review failed/i);
    expect(state.error).toContain("Malformed agent JSON");
    expect(events.at(-1)?.status).toMatch(/failed/i);
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
    expect(findCall(exec.calls, "gh", ["pr", "comment", "42"])).toBeUndefined();
  });

  it("keeps the partial report intact when a later review round fails", async () => {
    const home = await makeHome();
    const id = "late-review-crash-8df0";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ shas: ["base0000", "fixed111"] });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], new AgentParseFailure("Second review emitted malformed JSON")],
      [
        {
          sha: "fixed111",
          summary:
            "Fixed the range calculation. Added coverage for the boundary condition."
        }
      ]
    );

    await expect(
      runOrchestrator({
        mendrHome: home,
        reviewId: id,
        agentDriver: driver,
        exec: exec.run
      })
    ).rejects.toThrow("Second review emitted malformed JSON");

    const reportMarkdown = await readFile(join(reviewDir, "report.md"), "utf8");
    const state = await readJson<{ currentStatus: string; error: string }>(
      join(reviewDir, "state.json")
    );

    expect(reportMarkdown).toContain("- Issue: Prevent off-by-one diff ranges");
    expect(reportMarkdown).toContain("- Resolved by: fixed111");
    expect(state.currentStatus).toMatch(/review failed/i);
    expect(state.error).toContain("Second review emitted malformed JSON");
    expect(findCall(exec.calls, "gh", ["pr", "comment", "42"])).toBeUndefined();
  });

  it("records mixed per-issue results from one fixer batch", async () => {
    const home = await makeHome();
    const id = "partial-fix-fail-1b76";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ shas: ["base0000", "ok2222"] });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue, staleStateIssue], []],
      [
        [
          {
            status: "failed",
            summary:
              "The fixer reported that this issue failed with exit code one. Manual follow-up is required."
          },
          {
            sha: "ok2222",
            summary:
              "Fixed stale state rendering. Added coverage for file-backed status reads."
          }
        ]
      ]
    );

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    const reportMarkdown = await readFile(join(reviewDir, "report.md"), "utf8");
    const state = await readJson<{ issuesFound: number; issuesFixed: number }>(
      join(reviewDir, "state.json")
    );
    const events = await readEvents(reviewDir);

    expect(driver.fixContexts).toHaveLength(1);
    expect(driver.fixContexts[0].issues.map((issue) => issue.title)).toEqual([
      "Prevent off-by-one diff ranges",
      "Refresh stale state reads"
    ]);
    expect(reportMarkdown).toContain("- Issue: Prevent off-by-one diff ranges");
    expect(reportMarkdown).toContain("- Resolved by: (failed)");
    expect(reportMarkdown).toContain("exit code one");
    expect(reportMarkdown).toContain("- Issue: Refresh stale state reads");
    expect(reportMarkdown).toContain("- Resolved by: ok2222");
    expect(state).toMatchObject({ issuesFound: 2, issuesFixed: 1 });
    expect(events.map((event) => event.status)).toEqual(
      expect.arrayContaining(["Fix failed", "Complete"])
    );
  });

  it("records failed fixer results and skips push", async () => {
    const home = await makeHome();
    const id = "commit-fail-2c33";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec();
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          status: "failed",
          summary:
            "Attempted the range fix but git reported nothing to commit. Manual follow-up is required."
        }
      ]
    );

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    const reportMarkdown = await readFile(join(reviewDir, "report.md"), "utf8");
    const events = await readEvents(reviewDir);

    expect(reportMarkdown).toContain("- Issue: Prevent off-by-one diff ranges");
    expect(reportMarkdown).toContain("- Resolved by: (failed)");
    expect(reportMarkdown).toMatch(/nothing to commit/i);
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
    expect(events.map((event) => event.status)).toEqual(
      expect.arrayContaining(["Fix failed"])
    );
  });

  it("records fixer process crashes as unresolved issues and still posts the report", async () => {
    const home = await makeHome();
    const id = "fixer-crash-6d18";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec();
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [new Error("fix agent exited with code 1")]
    );

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    const reportMarkdown = await readFile(join(reviewDir, "report.md"), "utf8");
    const state = await readJson<{ done: boolean; issuesFixed: number; error?: string }>(
      join(reviewDir, "state.json")
    );
    const events = await readEvents(reviewDir);

    expect(reportMarkdown).toContain("- Issue: Prevent off-by-one diff ranges");
    expect(reportMarkdown).toContain("- Resolved by: (failed)");
    expect(reportMarkdown).toContain("fix agent exited with code 1");
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
    expect(findCall(exec.calls, "gh", ["pr", "comment", "42"])).toBeDefined();
    expect(state).toMatchObject({ done: true, issuesFixed: 0 });
    expect(state.error).toBeUndefined();
    expect(events.map((event) => event.status)).toEqual(
      expect.arrayContaining(["Fix failed", "Complete"])
    );
  });

  it("marks reported fixes unresolved when the fixer does not create a new commit", async () => {
    const home = await makeHome();
    const id = "unchanged-head-4e29";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ shas: ["base0000", "base0000"] });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          summary:
            "Reported the range fix as complete. Expected mendr to verify that a new commit exists."
        }
      ]
    );

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    const reportMarkdown = await readFile(join(reviewDir, "report.md"), "utf8");
    const state = await readJson<{ issuesFixed: number }>(join(reviewDir, "state.json"));

    expect(reportMarkdown).toContain("- Issue: Prevent off-by-one diff ranges");
    expect(reportMarkdown).toContain("- Resolved by: (failed)");
    expect(reportMarkdown).toMatch(/HEAD did not change|new commit SHA/i);
    expect(state.issuesFixed).toBe(0);
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
  });

  it("retries a rejected push once and records the push failure", async () => {
    const home = await makeHome();
    const id = "push-fail-0ae4";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ pushFailures: 2, shas: ["base0000", "push3333"] });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          sha: "push3333",
          summary:
            "Fixed the range calculation. Added a regression test for the final line."
        }
      ]
    );

    await expect(
      runOrchestrator({
        mendrHome: home,
        reviewId: id,
        agentDriver: driver,
        exec: exec.run
      })
    ).rejects.toThrow(/push/i);

    const reportMarkdown = await readFile(join(reviewDir, "report.md"), "utf8");
    const state = await readJson<{ currentStatus: string; error: string }>(
      join(reviewDir, "state.json")
    );

    expect(findCalls(exec.calls, "git", ["push"])).toHaveLength(2);
    expect(reportMarkdown).toContain("- Issue: Prevent off-by-one diff ranges");
    expect(reportMarkdown).toContain("- Resolved by: push3333");
    expect(reportMarkdown).toMatch(/push failed|non-fast-forward/i);
    expect(state.currentStatus).toMatch(/push failed/i);
    expect(state.error).toMatch(/non-fast-forward|push/i);
  });

  it("retries a failed PR comment once and preserves the report for manual posting", async () => {
    const home = await makeHome();
    const id = "comment-fail-5d72";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ commentFailures: 2 });
    const driver = new ScriptedAgentDriver([[]]);

    await expect(
      runOrchestrator({
        mendrHome: home,
        reviewId: id,
        agentDriver: driver,
        exec: exec.run
      })
    ).rejects.toThrow(/comment/i);

    const reportMarkdown = await readFile(join(reviewDir, "report.md"), "utf8");
    const state = await readJson<{ currentStatus: string; error: string }>(
      join(reviewDir, "state.json")
    );

    expect(findCalls(exec.calls, "gh", ["pr", "comment", "42"])).toHaveLength(2);
    expect(reportMarkdown.match(/^## Summary$/gm)).toHaveLength(1);
    expect(state.currentStatus).toMatch(/posting review failed/i);
    expect(state.error).toMatch(/rate limit|comment/i);
  });

  it("surfaces malformed agent JSON as an agent failure instead of crashing", async () => {
    const home = await makeHome();
    const id = "malformed-json-81ca";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec();
    const driver = new ScriptedAgentDriver([
      new AgentParseFailure("Could not parse review agent JSON")
    ]);

    await expect(
      runOrchestrator({
        mendrHome: home,
        reviewId: id,
        agentDriver: driver,
        exec: exec.run
      })
    ).rejects.toThrow("Could not parse review agent JSON");

    const state = await readJson<{ currentStatus: string; error: string }>(
      join(reviewDir, "state.json")
    );

    expect(state.currentStatus).toMatch(/review failed|agent failed/i);
    expect(state.error).toContain("Could not parse review agent JSON");
    expect(findCall(exec.calls, "gh", ["pr", "comment", "42"])).toBeUndefined();
  });

  it("deduplicates identical issue fingerprints within a review response", async () => {
    const home = await makeHome();
    const id = "duplicate-issue-39bf";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ shas: ["base0000", "dedupe444"] });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue, { ...rangeIssue }], []],
      [
        {
          sha: "dedupe444",
          summary:
            "Fixed the range calculation once. Added coverage for repeated issue fingerprints."
        }
      ]
    );

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    const reportMarkdown = await readFile(join(reviewDir, "report.md"), "utf8");

    expect(driver.fixContexts).toHaveLength(1);
    expect(reportMarkdown.match(/- Issue: Prevent off-by-one diff ranges/g)).toHaveLength(1);
    expect(reportMarkdown).toContain("- Resolved by: dedupe444");
  });

  it("records startup failures that happen before PR fetching begins", async () => {
    const home = await makeHome();
    const id = "bad-meta-agent-23bb";
    const reviewDir = await seedReview(home, id, { agent: "gemini" });
    const exec = new ScriptedExec();

    await expect(
      runOrchestrator({
        mendrHome: home,
        reviewId: id,
        exec: exec.run
      })
    ).rejects.toThrow(/unsupported agent/i);

    const state = await readJson<{ currentStatus: string; error: string }>(
      join(reviewDir, "state.json")
    );

    expect(state.currentStatus).toBe("Orchestrator failed");
    expect(state.error).toMatch(/unsupported agent/i);
    expect(findCall(exec.calls, "gh", ["pr", "view"])).toBeUndefined();
  });
});
