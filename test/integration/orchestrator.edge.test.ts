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
  commitMessage?: string;
  omitCommitMessage?: boolean;
  createUnrecordedCommit?: boolean;
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

function callInput(call: ExecCall): string | undefined {
  return (call.options as { input?: string } | undefined)?.input;
}

function defaultCommitMessageForIssue(issue: Issue): string {
  if (issue.file.includes("state")) {
    return [
      "fix(state): refresh status reads",
      "",
      "- Keeps rendered state aligned with the latest persisted write",
      "- Covers stale reads through the parent-created commit"
    ].join("\n");
  }

  return [
    "fix(range): include changed range end",
    "",
    "- Keeps the final modified line inside the reviewed diff range",
    "- Covers boundary handling through the parent-created commit"
  ].join("\n");
}

class AgentParseFailure extends Error {
  constructor(message = "Malformed agent JSON") {
    super(message);
    this.name = "AgentParseError";
  }
}

class ScriptedExec {
  readonly calls: ExecCall[] = [];

  private readonly commitShas: string[];

  private currentHead: string;

  private statusIndex = 0;

  private commitIndex = 0;

  private pushAttempts = 0;

  private commentAttempts = 0;

  constructor(
    private readonly options: {
      prView?: Record<string, unknown>;
      diff?: string;
      shas?: Array<string | Error | null>;
      headReads?: Array<string | Error | null>;
      statusOutputs?: string[];
      commitFailures?: number;
      emptyRevList?: boolean;
      invalidVerifyShas?: string[];
      pushFailures?: number;
      commentFailures?: number;
    } = {}
  ) {
    const shas = options.shas?.filter((sha): sha is string => typeof sha === "string") ?? [
      "abc1234"
    ];

    this.currentHead = shas.length > 1 ? shas[0] : "base0000";
    this.commitShas = shas.length > 1 ? shas.slice(1) : shas;
  }

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

    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      return { stdout: this.currentHead, stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "status" && args[1] === "--porcelain") {
      const status =
        this.options.statusOutputs?.[
          Math.min(this.statusIndex, this.options.statusOutputs.length - 1)
        ] ?? " M src/range.ts";

      this.statusIndex += 1;

      return { stdout: status, stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "add" && args[1] === "-A") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "commit") {
      this.commitIndex += 1;

      if (this.commitIndex <= (this.options.commitFailures ?? 0)) {
        return {
          stdout: "",
          stderr: "nothing to commit",
          exitCode: 1
        };
      }

      this.currentHead =
        this.commitShas[Math.min(this.commitIndex - 1, this.commitShas.length - 1)] ?? "abc1234";

      return { stdout: `[detached HEAD ${this.currentHead}] fix`, stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "reset" && args[1] === "--hard") {
      this.currentHead = args[2] ?? this.currentHead;

      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "clean" && args[1] === "-fdx") {
      return { stdout: "", stderr: "", exitCode: 0 };
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
}

class ScriptedAgentDriver {
  readonly reviewContexts: ReviewContext[] = [];

  readonly fixContexts: Array<{ issues: Issue[]; ctx: ReviewContext }> = [];

  private reviewIndex = 0;

  private fixIndex = 0;

  constructor(
    private readonly reviews: Array<Issue[] | Error>,
    private readonly fixes: Array<FixResult | FixResult[] | Error> = [],
    private readonly exec?: ScriptedExec
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

    if (Array.isArray(result) && result.length === 0) {
      return [];
    }

    const mappedResults: Array<FixResult & {
      title: string;
      fingerprint: string;
      status: "fixed" | "failed";
    }> = [];

    for (const [index, issue] of issues.entries()) {
      const defaultResult = {
        summary:
          "Fixed the changed range calculation. Added coverage for the boundary case."
      };
      const scripted = Array.isArray(result)
        ? result[index] ?? defaultResult
        : result ?? defaultResult;
      const hasExplicitSha = Object.prototype.hasOwnProperty.call(scripted, "sha");
      const commitMessage = scripted.omitCommitMessage
        ? undefined
        : scripted.commitMessage ?? defaultCommitMessageForIssue(issue);

      if (scripted.createUnrecordedCommit && scripted.status !== "failed") {
        await this.exec?.run("git", ["commit", "-m", "fixer-owned"], { cwd: ctx.repo });
      }

      mappedResults.push({
        title: issue.title,
        fingerprint: issueFingerprint(issue),
        status: scripted.status ?? "fixed",
        sha: scripted.status === "failed" ? undefined : hasExplicitSha ? scripted.sha : "abc1234",
        commitMessage: scripted.status === "failed" ? undefined : commitMessage,
        summary: scripted.summary
      });
    }

    return mappedResults;
  }
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("orchestrator edge and failure handling", () => {
  it("rejects invalid persisted effort before starting review work", async () => {
    const home = await makeHome();
    const id = "invalid-effort-8be3";
    const reviewDir = await seedReview(home, id, {
      agent: "codex",
      effort: "max"
    });
    const exec = new ScriptedExec();
    const driver = new ScriptedAgentDriver([[]]);

    await expect(
      runOrchestrator({
        mendrHome: home,
        reviewId: id,
        agentDriver: driver,
        exec: exec.run
      })
    ).rejects.toThrow(/invalid codex effort/i);

    const state = await readJson<{ currentStatus: string; error: string }>(
      join(reviewDir, "state.json")
    );

    expect(state.currentStatus).toMatch(/orchestrator failed/i);
    expect(state.error).toContain('Invalid codex effort "max"');
    expect(driver.reviewContexts).toHaveLength(0);
    expect(findCall(exec.calls, "gh", ["pr", "view"])).toBeUndefined();
  });

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

  it("uses a valid persisted effort override in review contexts", async () => {
    const home = await makeHome();
    const id = "valid-effort-codex-0db4";
    await seedReview(home, id, {
      agent: "codex",
      effort: "high"
    });
    const exec = new ScriptedExec();
    const driver = new ScriptedAgentDriver([[]]);

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    expect(driver.reviewContexts).toHaveLength(1);
    expect(driver.reviewContexts[0].effort).toBe("high");
  });

  it("records unexpected report read failures as orchestrator failures", async () => {
    const home = await makeHome();
    const id = "report-read-fails-d240";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec();
    const driver = new ScriptedAgentDriver([[]]);

    await mkdir(join(reviewDir, "report.md"));

    await expect(
      runOrchestrator({
        mendrHome: home,
        reviewId: id,
        agentDriver: driver,
        exec: exec.run
      })
    ).rejects.toThrow(/directory|EISDIR|illegal operation/i);

    const state = await readJson<{ currentStatus: string; error: string }>(
      join(reviewDir, "state.json")
    );

    expect(state.currentStatus).toBe("Orchestrator failed");
    expect(state.error).toMatch(/directory|EISDIR|illegal operation/i);
    expect(driver.reviewContexts).toHaveLength(0);
    expect(findCall(exec.calls, "gh", ["pr", "comment", "42"])).toBeUndefined();
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

  it("records mixed per-issue results from separate fixer invocations", async () => {
    const home = await makeHome();
    const id = "partial-fix-fail-1b76";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ shas: ["base0000", "ok2222"] });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue, staleStateIssue], []],
      [
        {
          status: "failed",
          summary:
            "The fixer reported that this issue failed with exit code one. Manual follow-up is required."
        },
        {
          summary:
            "Fixed stale state rendering. Added coverage for file-backed status reads."
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
    const state = await readJson<{ issuesFound: number; issuesFixed: number }>(
      join(reviewDir, "state.json")
    );
    const events = await readEvents(reviewDir);

    expect(driver.fixContexts).toHaveLength(2);
    expect(driver.fixContexts[0].issues.map((issue) => issue.title)).toEqual([
      "Prevent off-by-one diff ranges"
    ]);
    expect(driver.fixContexts[1].issues.map((issue) => issue.title)).toEqual([
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

  it("keeps distinct parent-created SHAs from multiple issue fixes", async () => {
    const home = await makeHome();
    const id = "multi-commit-batch-51dc";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({
      shas: ["base0000", "range111", "state222"]
    });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue, staleStateIssue], []],
      [
        {
          summary:
            "Fixed the changed range calculation. Added coverage for the final modified line."
        },
        {
          summary:
            "Fixed stale state rendering. Added coverage for file-backed status reads."
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
    const fixRecords = (await readFile(join(reviewDir, "fixes.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { issueIndex: number; commitSha?: string });
    const state = await readJson<{ issuesFixed: number }>(join(reviewDir, "state.json"));

    expect(reportMarkdown).toContain("- Issue: Prevent off-by-one diff ranges");
    expect(reportMarkdown).toContain("- Resolved by: range111");
    expect(reportMarkdown).toContain("- Issue: Refresh stale state reads");
    expect(reportMarkdown).toContain("- Resolved by: state222");
    expect(fixRecords).toEqual([
      expect.objectContaining({ issueIndex: 1, commitSha: "range111" }),
      expect.objectContaining({ issueIndex: 2, commitSha: "state222" })
    ]);
    expect(state.issuesFixed).toBe(2);
    expect(findCall(exec.calls, "git", ["push"])?.args).toEqual([
      "push",
      "origin",
      "HEAD:feature/range-fix"
    ]);
  });

  it("keeps issue 1 committed when issue 2 fails and resets to the last successful commit", async () => {
    const home = await makeHome();
    const id = "second-issue-fails-2ab9";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ shas: ["base0000", "first111"] });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue, staleStateIssue], []],
      [
        {
          summary:
            "Fixed the first issue. Added coverage for the changed range calculation."
        },
        {
          status: "failed",
          summary:
            "Could not safely fix the stale state issue. Manual follow-up is required."
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
    const fixRecords = (await readFile(join(reviewDir, "fixes.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { issueIndex: number; status: string; commitSha?: string });
    const state = await readJson<{ issuesFixed: number }>(join(reviewDir, "state.json"));
    const resetCall = findCall(exec.calls, "git", ["reset", "--hard"]);
    const cleanCall = findCall(exec.calls, "git", ["clean"]);

    expect(reportMarkdown).toContain("- Resolved by: first111");
    expect(reportMarkdown).toContain("Could not safely fix the stale state issue");
    expect(fixRecords[0]).toEqual(
      expect.objectContaining({ issueIndex: 1, status: "fixed", commitSha: "first111" })
    );
    expect(fixRecords[1]).toEqual(
      expect.objectContaining({ issueIndex: 2, status: "failed" })
    );
    expect(fixRecords[1]).not.toHaveProperty("commitSha");
    expect(resetCall?.args).toEqual(["reset", "--hard", "first111"]);
    expect(cleanCall?.args).toEqual(["clean", "-fdx"]);
    expect(state.issuesFixed).toBe(1);
    expect(findCall(exec.calls, "git", ["push"])?.args).toEqual([
      "push",
      "origin",
      "HEAD:feature/range-fix"
    ]);
  });

  it("ignores reported fix SHAs outside the fixer session and records the parent commit", async () => {
    const home = await makeHome();
    const id = "out-of-range-sha-30af";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({
      shas: ["base0000", "valid111"]
    });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          sha: "old9999",
          summary:
            "Reported a fix from a commit outside this batch. Expected mendr to reject that attribution."
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
    expect(reportMarkdown).toContain("- Resolved by: valid111");
    expect(state.issuesFixed).toBe(1);
    expect(findCall(exec.calls, "git", ["push"])?.args).toEqual([
      "push",
      "origin",
      "HEAD:feature/range-fix"
    ]);
  });

  it("does not verify agent-reported SHAs because mendr owns the final commit", async () => {
    const home = await makeHome();
    const id = "invalid-fix-sha-7a90";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({
      invalidVerifyShas: ["bad9999"],
      shas: ["base0000", "valid111"]
    });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          sha: "bad9999",
          summary:
            "Reported a fix from an unverifiable commit. Expected mendr to reject that attribution."
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
    expect(reportMarkdown).toContain("- Resolved by: valid111");
    expect(state.issuesFixed).toBe(1);
    expect(findCall(exec.calls, "git", ["push"])).toBeDefined();
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

  it("marks reported fixes unresolved when the fixer leaves no diff", async () => {
    const home = await makeHome();
    const id = "unchanged-head-4e29";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ statusOutputs: [""] });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          summary:
            "Reported the range fix as complete. Expected mendr to verify that a file diff exists."
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
    expect(reportMarkdown).toMatch(/file changes to commit/i);
    expect(state.issuesFixed).toBe(0);
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
  });

  it("marks fixed results without commit messages unresolved", async () => {
    const home = await makeHome();
    const id = "missing-commit-message-14ea";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ shas: ["base0000", "missingmsg"] });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          omitCommitMessage: true,
          summary:
            "Reported the range fix as complete. Expected mendr to require a commit message."
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
    expect(reportMarkdown).toMatch(/did not provide a commit message/i);
    expect(state.issuesFixed).toBe(0);
    expect(findCall(exec.calls, "git", ["commit"])).toBeUndefined();
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
  });

  it("stops with an infrastructure error when the parent commit fails", async () => {
    const home = await makeHome();
    const id = "parent-commit-fails-95fd";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ commitFailures: 1 });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
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
    ).rejects.toThrow(/commit|nothing to commit/i);

    const state = await readJson<{ currentStatus: string; error: string }>(
      join(reviewDir, "state.json")
    );

    expect(state.currentStatus).toBe("Commit failed");
    expect(state.error).toMatch(/nothing to commit|git commit/i);
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
    expect(findCall(exec.calls, "gh", ["pr", "comment", "42"])).toBeUndefined();
  });

  it("marks fixes unresolved when the fixer omits a result for an issue", async () => {
    const home = await makeHome();
    const id = "missing-fix-result-8c10";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec();
    const driver = new ScriptedAgentDriver([[rangeIssue], []], [[]]);

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
    expect(reportMarkdown).toContain("did not return a result");
    expect(state.issuesFixed).toBe(0);
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
  });

  it("records a parent commit when the fixer reports fixed without a SHA", async () => {
    const home = await makeHome();
    const id = "missing-fix-sha-9df2";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({
      shas: ["base0000", "missing555"]
    });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          sha: undefined,
          summary:
            "Reported the range fix without a commit SHA. Expected mendr to keep the issue unresolved."
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
    expect(reportMarkdown).toContain("- Resolved by: missing555");
    expect(state.issuesFixed).toBe(1);
    expect(findCall(exec.calls, "git", ["push"])).toBeDefined();
  });

  it("does not depend on fixer commit ranges when recording a parent commit", async () => {
    const home = await makeHome();
    const id = "empty-commit-range-40cf";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({
      emptyRevList: true,
      shas: ["base0000", "empty666"]
    });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          sha: "empty666",
          summary:
            "Reported a fixed range commit. Expected mendr to use its own parent commit."
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
    expect(reportMarkdown).toContain("- Resolved by: empty666");
    expect(state.issuesFixed).toBe(1);
    expect(findCall(exec.calls, "git", ["push"])).toBeDefined();
  });

  it("uses the fixer-provided commit message for the parent commit", async () => {
    const home = await makeHome();
    const id = "fixer-commit-message-45ac";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ shas: ["base0000", "msg777"] });
    const commitMessage = [
      "fix(range): include final changed line",
      "",
      "- Updates range parsing to keep the upper bound in scope",
      "- Makes the parent-created commit describe the actual code change"
    ].join("\n");
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          commitMessage,
          summary:
            "Updated the parser boundary handling so changed ranges include the final modified line and remain stable across retries."
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
    const commitCall = findCall(exec.calls, "git", ["commit"]);

    expect(commitCall?.args).toEqual(["commit", "-F", "-"]);
    expect(callInput(commitCall!)).toBe(`${commitMessage}\n`);
    expect(callInput(commitCall!)).not.toContain(issueFingerprint(rangeIssue));
    expect(reportMarkdown).toContain("- Issue: Prevent off-by-one diff ranges");
    expect(reportMarkdown).toContain("Updated the parser boundary handling");
  });

  it("marks fixed results with unsafe commit messages unresolved", async () => {
    const home = await makeHome();
    const id = "unsafe-commit-message-6c21";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ shas: ["base0000", "unsafe888"] });
    const commitMessage = [
      "fix(range): include final changed line",
      "",
      "- Updates range parsing to keep the upper bound in scope",
      "- Makes the parent-created commit describe the actual code change",
      "Co-authored-by: Claude <claude@example.com>"
    ].join("\n");
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          commitMessage,
          summary:
            "Updated the parser boundary handling so changed ranges include the final modified line and remain stable across retries."
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
    expect(reportMarkdown).toMatch(/commit message/i);
    expect(state.issuesFixed).toBe(0);
    expect(findCall(exec.calls, "git", ["commit"])).toBeUndefined();
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
  });

  it("resets and fails a fix when the fixer creates an unrecorded commit", async () => {
    const home = await makeHome();
    const id = "fixer-created-commit-94c1";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ shas: ["base0000", "fixer111", "parent222"] });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          createUnrecordedCommit: true,
          summary:
            "Fixed the range calculation after creating a local commit. Left an extra file edit for mendr to commit."
        }
      ],
      exec
    );

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    const reportMarkdown = await readFile(join(reviewDir, "report.md"), "utf8");
    const fixRecords = (await readFile(join(reviewDir, "fixes.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string; commitSha?: string });
    const state = await readJson<{ issuesFixed: number }>(join(reviewDir, "state.json"));
    const parentCommitCall = findCall(exec.calls, "git", ["commit", "-F", "-"]);
    const resetCall = findCall(exec.calls, "git", ["reset", "--hard"]);

    expect(reportMarkdown).toContain("- Issue: Prevent off-by-one diff ranges");
    expect(reportMarkdown).toContain("- Resolved by: (failed)");
    expect(reportMarkdown).toMatch(/moved HEAD from base0000 to fixer111/i);
    expect(fixRecords[0]).toEqual(expect.objectContaining({ status: "failed" }));
    expect(fixRecords[0]).not.toHaveProperty("commitSha");
    expect(state.issuesFixed).toBe(0);
    expect(parentCommitCall).toBeUndefined();
    expect(resetCall?.args).toEqual(["reset", "--hard", "base0000"]);
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
  });

  it("retries a rejected push once and completes when the retry succeeds", async () => {
    const home = await makeHome();
    const id = "push-retry-success-70be";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ pushFailures: 1, shas: ["base0000", "retry777"] });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue], []],
      [
        {
          sha: "retry777",
          summary:
            "Fixed the range calculation. Added a regression test for the final line."
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
    const state = await readJson<{ done: boolean; error?: string }>(join(reviewDir, "state.json"));

    expect(findCalls(exec.calls, "git", ["push"])).toHaveLength(2);
    expect(reportMarkdown).toContain("- Resolved by: retry777");
    expect(reportMarkdown).not.toMatch(/push failed/i);
    expect(state).toMatchObject({ done: true });
    expect(state.error).toBeUndefined();
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

  it("retries a failed PR comment once and completes when the retry succeeds", async () => {
    const home = await makeHome();
    const id = "comment-retry-success-3ea7";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({ commentFailures: 1 });
    const driver = new ScriptedAgentDriver([[]]);

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    const state = await readJson<{ done: boolean; currentStatus: string; error?: string }>(
      join(reviewDir, "state.json")
    );

    expect(findCalls(exec.calls, "gh", ["pr", "comment", "42"])).toHaveLength(2);
    expect(state).toMatchObject({ done: true, currentStatus: "Complete" });
    expect(state.error).toBeUndefined();
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
