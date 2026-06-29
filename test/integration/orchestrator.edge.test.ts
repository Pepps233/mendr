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
      headReads?: Array<string | Error | null>;
      emptyRevList?: boolean;
      invalidVerifyShas?: string[];
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
      const sha = args[2]?.replace(/\^\{commit\}$/, "") ?? "";

      if (this.options.invalidVerifyShas?.includes(sha)) {
        return { stdout: "", stderr: "unknown revision", exitCode: 1 };
      }

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

    if (command === "git" && args[0] === "rev-list") {
      if (this.options.emptyRevList) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      return { stdout: this.readCommitRange(args[1] ?? ""), stderr: "", exitCode: 0 };
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
    const headReads = this.options.headReads ?? this.options.shas;

    if (headReads) {
      const scripted = headReads[Math.min(this.shaIndex, headReads.length - 1)];

      return scripted === undefined ? "abc1234" : scripted;
    }

    const fixIndex = Math.floor(this.shaIndex / 2);
    const isAfterFix = this.shaIndex % 2 === 1;

    if (!isAfterFix) {
      return fixIndex === 0 ? "base0000" : "abc1234";
    }

    return "abc1234";
  }

  private readCommitRange(range: string): string {
    const [beforeSha, afterSha] = range.split("..");
    const shas = this.options.shas?.filter((sha): sha is string => typeof sha === "string") ?? [
      "abc1234"
    ];
    const afterIndex = shas.indexOf(afterSha);

    if (afterIndex === -1) {
      return afterSha;
    }

    const beforeIndex = shas.indexOf(beforeSha);
    const startIndex = beforeIndex === -1 ? 0 : beforeIndex + 1;

    return shas.slice(startIndex, afterIndex + 1).reverse().join("\n");
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

    if (Array.isArray(result) && result.length === 0) {
      return [];
    }

    return issues.map((issue, index) => {
      const defaultResult = {
        summary:
          "Fixed the changed range calculation. Added coverage for the boundary case."
      };
      const scripted = Array.isArray(result)
        ? result[index] ?? defaultResult
        : result ?? defaultResult;
      const hasExplicitSha = Object.prototype.hasOwnProperty.call(scripted, "sha");

      return {
        title: issue.title,
        fingerprint: issueFingerprint(issue),
        status: scripted.status ?? "fixed",
        sha: scripted.status === "failed" ? undefined : hasExplicitSha ? scripted.sha : "abc1234",
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

  it("keeps distinct per-issue SHAs from multiple commits in one fixer batch", async () => {
    const home = await makeHome();
    const id = "multi-commit-batch-51dc";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({
      shas: ["base0000", "range111", "state222"],
      headReads: ["base0000", "state222"]
    });
    const driver = new ScriptedAgentDriver(
      [[rangeIssue, staleStateIssue], []],
      [
        [
          {
            sha: "range111",
            summary:
              "Fixed the changed range calculation. Added coverage for the final modified line."
          },
          {
            sha: "state222",
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
    const state = await readJson<{ issuesFixed: number }>(join(reviewDir, "state.json"));

    expect(reportMarkdown).toContain("- Issue: Prevent off-by-one diff ranges");
    expect(reportMarkdown).toContain("- Resolved by: range111");
    expect(reportMarkdown).toContain("- Issue: Refresh stale state reads");
    expect(reportMarkdown).toContain("- Resolved by: state222");
    expect(state.issuesFixed).toBe(2);
    expect(findCall(exec.calls, "git", ["push"])).toBeDefined();
  });

  it("marks reported fix SHAs outside the fixer commit range unresolved", async () => {
    const home = await makeHome();
    const id = "out-of-range-sha-30af";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({
      shas: ["base0000", "valid111"],
      headReads: ["base0000", "valid111"]
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
    expect(reportMarkdown).toContain("- Resolved by: (failed)");
    expect(reportMarkdown).toMatch(/not created in this batch|valid111/i);
    expect(state.issuesFixed).toBe(0);
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
  });

  it("marks reported fix SHAs unresolved when git cannot verify them", async () => {
    const home = await makeHome();
    const id = "invalid-fix-sha-7a90";
    const reviewDir = await seedReview(home, id);
    const exec = new ScriptedExec({
      invalidVerifyShas: ["bad9999"],
      shas: ["base0000", "valid111"],
      headReads: ["base0000", "valid111"]
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
    expect(reportMarkdown).toContain("- Resolved by: (failed)");
    expect(reportMarkdown).toMatch(/could not verify|unknown revision/i);
    expect(state.issuesFixed).toBe(0);
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
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

  it("marks fixes unresolved when the fixer reports fixed without a SHA", async () => {
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
    expect(reportMarkdown).toContain("- Resolved by: (failed)");
    expect(reportMarkdown).toMatch(/without a commit SHA/i);
    expect(state.issuesFixed).toBe(0);
    expect(findCall(exec.calls, "git", ["push"])).toBeUndefined();
  });

  it("marks fixes unresolved when the commit range is empty", async () => {
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
            "Reported a fixed range commit. Expected mendr to reject an empty commit range."
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
    expect(reportMarkdown).toMatch(/rev-list did not return/i);
    expect(state.issuesFixed).toBe(0);
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
