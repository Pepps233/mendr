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

async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), "mendr-orchestrator-"));
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
    .map((line) => JSON.parse(line) as { status: string });
}

function findCall(calls: ExecCall[], command: string, args: string[]) {
  return calls.find(
    (call) =>
      call.command === command &&
      args.every((arg, index) => call.args[index] === arg)
  );
}

class FakeExec {
  readonly calls: ExecCall[] = [];

  private shaIndex = 0;

  constructor(private readonly shas: string[] = ["abc1234"]) {}

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
          ]
        }),
        stderr: "",
        exitCode: 0
      };
    }

    if (command === "gh" && args[0] === "pr" && args[1] === "diff") {
      return {
        stdout: [
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
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      const sha = this.shas[Math.min(this.shaIndex, this.shas.length - 1)];
      this.shaIndex += 1;

      return { stdout: sha, stderr: "", exitCode: 0 };
    }

    if (command === "claude") {
      return { stdout: "{}", stderr: "", exitCode: 0 };
    }

    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
}

class FakeAgentDriver {
  readonly reviewContexts: ReviewContext[] = [];

  readonly fixContexts: Array<{ issue: Issue; ctx: ReviewContext }> = [];

  readonly callLog: Array<"review" | "fix"> = [];

  private reviewIndex = 0;

  private fixIndex = 0;

  constructor(
    private readonly reviews: Issue[][],
    private readonly fixes: FixResult[],
    private readonly exec?: FakeExec
  ) {}

  async review(ctx: ReviewContext): Promise<Issue[]> {
    this.callLog.push("review");
    this.reviewContexts.push(ctx);

    if (this.exec) {
      await this.exec.run("claude", [
        "-p",
        `review round ${this.reviewIndex + 1}`,
        "--output-format",
        "json",
        "--add-dir",
        ctx.repo,
        "--permission-mode",
        "acceptEdits"
      ]);
    }

    const issues = this.reviews[Math.min(this.reviewIndex, this.reviews.length - 1)] ?? [];
    this.reviewIndex += 1;

    return issues;
  }

  async fix(issue: Issue, ctx: ReviewContext): Promise<FixResult> {
    this.callLog.push("fix");
    this.fixContexts.push({ issue, ctx });

    if (this.exec) {
      await this.exec.run("claude", [
        "-p",
        `fix ${issue.title}`,
        "--output-format",
        "json",
        "--add-dir",
        ctx.repo,
        "--permission-mode",
        "acceptEdits"
      ]);
    }

    const result =
      this.fixes[Math.min(this.fixIndex, this.fixes.length - 1)] ?? {
        summary:
          "Fixed the changed range calculation. Added coverage for the boundary case."
      };
    this.fixIndex += 1;

    return result;
  }
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("orchestrator integration", () => {
  it("runs the happy path and posts the generated report", async () => {
    const home = await makeHome();
    const id = "swift-otter-3f9a";
    const reviewDir = await seedReview(home, id);
    const exec = new FakeExec(["abc1234"]);
    const driver = new FakeAgentDriver(
      [[rangeIssue], []],
      [
        {
          summary:
            "Made the changed range inclusive at the upper bound. Added a regression check for the final modified line."
        }
      ]
    );

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    const reviewMarkdown = await readFile(join(reviewDir, "review.md"), "utf8");
    const reportMarkdown = await readFile(join(reviewDir, "report.md"), "utf8");
    const state = await readJson<{ done: boolean; currentStatus: string }>(
      join(reviewDir, "state.json")
    );
    const events = await readEvents(reviewDir);
    const commentCall = findCall(exec.calls, "gh", ["pr", "comment", "42"]);

    expect(reviewMarkdown).toContain("Fix changed range parsing");
    expect(reviewMarkdown).toContain("The parser currently drops the final changed line.");
    expect(reviewMarkdown).toContain(
      "Please make sure empty comments do not break the review."
    );
    expect(reportMarkdown.match(/^## Summary$/gm)).toHaveLength(1);
    expect(reportMarkdown).toContain("- Issue: Prevent off-by-one diff ranges");
    expect(reportMarkdown).toContain("- Resolved by: abc1234");
    expect(commentCall?.args).toEqual(
      expect.arrayContaining(["--body-file", join(reviewDir, "report.md")])
    );
    expect(state).toMatchObject({ done: true, currentStatus: "Complete" });
    expect(events.map((event) => event.status)).toEqual([
      "Discovering bugs",
      "Resolving issues",
      "Discovering bugs",
      "Posting review",
      "Complete"
    ]);
  });

  it("passes the growing report markdown into each later review round", async () => {
    const home = await makeHome();
    const id = "steady-moon-2ab1";
    const reviewDir = await seedReview(home, id);
    const exec = new FakeExec(["aaa1111", "bbb2222"]);
    const driver = new FakeAgentDriver(
      [[rangeIssue], [rangeIssue], []],
      [
        {
          summary:
            "Fixed the first changed range path. Added a regression test around the upper bound."
        },
        {
          summary:
            "Closed the remaining changed range path. Added a second assertion for repeated reviews."
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

    expect(driver.reviewContexts).toHaveLength(3);
    expect(driver.fixContexts).toHaveLength(2);
    expect(driver.reviewContexts[1].reportMarkdown).toContain("aaa1111");
    expect(driver.reviewContexts[2].reportMarkdown).toContain("aaa1111");
    expect(driver.reviewContexts[2].reportMarkdown).toContain("bbb2222");
    expect(reportMarkdown.match(/- Issue: Prevent off-by-one diff ranges/g)).toHaveLength(2);
    expect(reportMarkdown).toContain("- Resolved by: aaa1111");
    expect(reportMarkdown).toContain("- Resolved by: bbb2222");
  });

  it("records the round cap and still posts the report when issues remain", async () => {
    const home = await makeHome();
    const id = "capped-river-18ce";
    const reviewDir = await seedReview(home, id, { maxRounds: 1 });
    const exec = new FakeExec(["cap1111"]);
    const driver = new FakeAgentDriver(
      [[rangeIssue]],
      [
        {
          summary:
            "Applied the attempted changed range fix. Left the issue visible for the capped run summary."
        }
      ]
    );

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    const state = await readJson<{ done: boolean; capReached: boolean }>(
      join(reviewDir, "state.json")
    );
    const reportMarkdown = await readFile(join(reviewDir, "report.md"), "utf8");

    expect(driver.reviewContexts).toHaveLength(1);
    expect(state).toMatchObject({ done: true, capReached: true });
    expect(reportMarkdown).toContain("- Round cap reached after 1 round with 1 open issue.");
    expect(reportMarkdown).toContain("- Open issue: Prevent off-by-one diff ranges");
    expect(findCall(exec.calls, "gh", ["pr", "comment", "42"])).toBeDefined();
  });

  it("uses one fresh agent invocation per review and fix step", async () => {
    const home = await makeHome();
    const id = "fresh-brook-7c2d";
    await seedReview(home, id);
    const exec = new FakeExec(["fresh123"]);
    const driver = new FakeAgentDriver([[rangeIssue], []], [], exec);

    await runOrchestrator({
      mendrHome: home,
      reviewId: id,
      agentDriver: driver,
      exec: exec.run
    });

    const agentCalls = exec.calls.filter((call) => call.command === "claude");
    const agentArgs = agentCalls.flatMap((call) => call.args);

    expect(driver.callLog).toEqual(["review", "fix", "review"]);
    expect(agentCalls).toHaveLength(3);
    expect(agentArgs).not.toEqual(expect.arrayContaining(["--continue", "--resume"]));
  });
});
