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

function issueFingerprint(issue: Issue): string {
  return [
    issue.title.trim().replace(/\s+/g, " ").toLowerCase(),
    issue.file.trim().replace(/\s+/g, " ").toLowerCase(),
    String(issue.line),
    issue.description.trim().replace(/\s+/g, " ").toLowerCase()
  ].join("|");
}

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

  private headReadIndex = 0;

  constructor(private readonly shas: string[] = ["abc1234"]) {}

  nextSha(): string {
    const sha = this.shas[Math.min(this.shaIndex, this.shas.length - 1)];
    this.shaIndex += 1;

    return sha;
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

    if (command === "git" && args[0] === "rev-parse" && args[1] === "--verify") {
      return { stdout: args[2]?.replace(/\^\{commit\}$/, "") ?? "", stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      return { stdout: this.readHeadSha(), stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "rev-list") {
      return { stdout: this.readCommitRange(args[1] ?? ""), stderr: "", exitCode: 0 };
    }

    if (command === "git" && args[0] === "push") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (command === "claude") {
      return { stdout: "{}", stderr: "", exitCode: 0 };
    }

    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  private readHeadSha(): string {
    const fixIndex = Math.floor(this.headReadIndex / 2);
    const isAfterFix = this.headReadIndex % 2 === 1;
    const previousSha = fixIndex === 0 ? "base0000" : this.shas[Math.min(fixIndex - 1, this.shas.length - 1)];
    const nextSha = this.shas[Math.min(fixIndex, this.shas.length - 1)];

    this.headReadIndex += 1;

    return isAfterFix ? nextSha : previousSha;
  }

  private readCommitRange(range: string): string {
    const [beforeSha, afterSha] = range.split("..");
    const afterIndex = this.shas.indexOf(afterSha);

    if (afterIndex === -1) {
      return afterSha;
    }

    const beforeIndex = this.shas.indexOf(beforeSha);
    const startIndex = beforeIndex === -1 ? 0 : beforeIndex + 1;

    return this.shas.slice(startIndex, afterIndex + 1).reverse().join("\n");
  }
}

class FakeAgentDriver {
  readonly reviewContexts: ReviewContext[] = [];

  readonly fixContexts: Array<{ issues: Issue[]; ctx: ReviewContext }> = [];

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

  async fix(
    issues: Issue[],
    ctx: ReviewContext
  ): Promise<Array<FixResult & { title: string; fingerprint: string; status: "fixed" | "failed" }>> {
    this.callLog.push("fix");
    this.fixContexts.push({ issues, ctx });

    if (this.exec) {
      await this.exec.run("claude", [
        "-p",
        `fix ${issues.map((issue) => issue.title).join(", ")}`,
        "--output-format",
        "json",
        "--add-dir",
        ctx.repo,
        "--permission-mode",
        "acceptEdits"
      ]);
    }

    const scripted =
      this.fixes[Math.min(this.fixIndex, this.fixes.length - 1)] ?? {
        summary:
          "Fixed the changed range calculation. Added coverage for the boundary case."
      };
    this.fixIndex += 1;

    return issues.map((issue) => ({
      title: issue.title,
      fingerprint: issueFingerprint(issue),
      status: scripted.status ?? "fixed",
      sha: scripted.status === "failed" ? undefined : scripted.sha ?? this.exec?.nextSha() ?? "abc1234",
      summary: scripted.summary
    }));
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

  it("passes report markdown into later review rounds without re-fixing repeated issues", async () => {
    const home = await makeHome();
    const id = "steady-moon-2ab1";
    const reviewDir = await seedReview(home, id);
    const exec = new FakeExec(["aaa1111", "bbb2222"]);
    const driver = new FakeAgentDriver(
      [[rangeIssue], [rangeIssue], []],
      [
        {
          sha: "aaa1111",
          summary:
            "Fixed the first changed range path. Added a regression test around the upper bound."
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
    expect(driver.fixContexts).toHaveLength(1);
    expect(driver.reviewContexts[1].reportMarkdown).toContain("aaa1111");
    expect(driver.reviewContexts[2].reportMarkdown).toContain("aaa1111");
    expect(reportMarkdown.match(/- Issue: Prevent off-by-one diff ranges/g)).toHaveLength(1);
    expect(reportMarkdown).toContain("- Resolved by: aaa1111");
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
