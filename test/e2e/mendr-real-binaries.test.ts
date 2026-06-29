import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type AgentName = "claude" | "codex";

type LinkedCli = {
  env: NodeJS.ProcessEnv;
  prefix: string;
};

type ReviewRun = {
  agent: AgentName;
  branch: string;
  defaultBranch: string;
  env: NodeJS.ProcessEnv;
  events: Array<{ status: string; detail?: string }>;
  id: string;
  prNumber: string;
  report: string;
  reviewDir: string;
  state: {
    done: boolean;
    phase: string;
    currentStatus: string;
    issuesFixed: number;
    error?: string;
  };
  worktree: string;
};

type PullRequestCleanupTarget = {
  env: NodeJS.ProcessEnv;
  prNumber: string;
  worktree: string;
};

const e2eEnabled = process.env.MENDR_E2E === "1";
const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const e2eTimeoutMs = Number(process.env.MENDR_E2E_TIMEOUT_MS ?? 1_200_000);
const targetRepo = process.env.MENDR_E2E_REPO;
const agents: AgentName[] = ["claude", "codex"];
const availableAgents = e2eEnabled
  ? agents.filter((agent) => commandAvailable(agent))
  : [];
const describeE2E = e2eEnabled ? describe : describe.skip;
const tmpRoots: string[] = [];

let linkedCli: LinkedCli;

describeE2E("mendr gated E2E with real binaries", () => {
  beforeAll(async () => {
    assertTargetRepo();
    await assertRequiredBinary("git", ["--version"]);
    await assertRequiredBinary("gh", ["--version"]);
    await assertRequiredBinary("gh", ["auth", "status"]);
    linkedCli = await buildAndLinkCli();
  }, 180_000);

  afterAll(async () => {
    await Promise.all(
      tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("links the built mendr CLI onto PATH", async () => {
    const help = await run("mendr", ["--help"], {
      env: linkedCli.env,
      timeout: 30_000
    });

    expect(help.stdout).toContain("Run an autonomous agentic review loop");
  });

  for (const agent of agents) {
    const maybeIt = availableAgents.includes(agent) ? it : it.skip;

    maybeIt(
      `runs a full detached review loop with ${agent}`,
      async () => {
        const runResult = await runMendrReview(agent);

        try {
          await assertReviewCompleted(runResult, {
            expectFix: true,
            expectRoundCap: false
          });
        } finally {
          await cleanupPullRequest(runResult);
        }
      },
      e2eTimeoutMs
    );
  }

  const capAgent = availableAgents[0] ?? "claude";
  const maybeCapIt = availableAgents.length > 0 ? it : it.skip;

  maybeCapIt(
    "persists the --rounds cap argument in the detached session metadata",
    async () => {
      const runResult = await runMendrReview(capAgent, { rounds: 1 });
      const meta = JSON.parse(await readFile(join(runResult.reviewDir, "meta.json"), "utf8")) as {
        maxRounds: number;
      };

      try {
        expect(meta.maxRounds).toBe(1);
        await assertReviewCompleted(runResult, {
          expectFix: false,
          expectRoundCap: true
        });
      } finally {
        await cleanupPullRequest(runResult);
      }
    },
    e2eTimeoutMs
  );
});

async function runMendrReview(
  agent: AgentName,
  options: {
    rounds?: number;
  } = {}
): Promise<ReviewRun> {
  const sessionRoot = await mkdtemp(join(tmpdir(), `mendr-e2e-${agent}-`));
  tmpRoots.push(sessionRoot);

  const mendrHome = join(sessionRoot, "mendr-home");
  const worktree = join(sessionRoot, "repo");
  const env = {
    ...linkedCli.env,
    MENDR_HOME: mendrHome
  };
  const pullRequest = await createSeededPullRequest({
    agent,
    env,
    worktree
  });

  try {
    const args = [agent, pullRequest.prNumber];

    if (options.rounds !== undefined) {
      args.push("--rounds", String(options.rounds));
    }

    const started = await run("mendr", args, {
      cwd: worktree,
      env,
      timeout: 60_000
    });
    const id = parseStartedReviewId(started.stdout);
    const reviewDir = join(mendrHome, "reviews", id);
    const list = await run("mendr", ["ls"], {
      cwd: worktree,
      env,
      timeout: 30_000
    });

    expect(list.stdout).toContain(id);
    expect(list.stdout).toContain(agent);

    const state = await waitForTerminalState(reviewDir);
    const report = await readFile(join(reviewDir, "report.md"), "utf8");
    const events = await readJsonl(join(reviewDir, "events.log"));

    const view = await run("mendr", ["view", id], {
      cwd: worktree,
      env,
      timeout: 30_000
    });

    expect(view.all ?? view.stdout).toContain(`Review ${id}`);

    return {
      agent,
      branch: pullRequest.branch,
      defaultBranch: pullRequest.defaultBranch,
      env,
      events,
      id,
      prNumber: pullRequest.prNumber,
      report,
      reviewDir,
      state,
      worktree
    };
  } catch (error) {
    await cleanupPullRequest({
      env,
      prNumber: pullRequest.prNumber,
      worktree
    });
    throw error;
  }
}

async function assertReviewCompleted(
  result: ReviewRun,
  options: {
    expectFix: boolean;
    expectRoundCap: boolean;
  }
): Promise<void> {
  if (result.state.error) {
    throw new Error(`mendr ${result.agent} review failed: ${result.state.error}`);
  }

  expect(result.state).toMatchObject({
    done: true,
    currentStatus: "Complete"
  });
  expect(result.report.match(/^## Summary by Mendr$/gm)).toHaveLength(1);
  expect(result.events.map((event) => event.status)).toContain("Discovering bugs");
  expect(result.events.map((event) => event.status)).toContain("Posting review");
  expect(result.events.map((event) => event.status)).toContain("Complete");

  const commentBodies = await readPullRequestCommentBodies({
    env: result.env,
    prNumber: result.prNumber,
    worktree: result.worktree
  });

  expect(commentBodies.map((body) => body.trim())).toContain(result.report.trim());

  if (options.expectFix) {
    expect(result.events.map((event) => event.status)).toContain("Resolving issues");
    expect(result.report).toContain("### Resolved Issues");
    expect(result.report).toMatch(/^#### .+/m);
    expect(result.report).toMatch(/\*\*Commit:\*\* `[0-9a-f]{7,40}`/);
    expect(result.report).toMatch(/^[^\n]+\.\s+[^\n]+\.$/m);

    await run("git", ["fetch", "origin", result.branch], {
      cwd: result.worktree,
      env: result.env,
      timeout: 60_000
    });
    await run("git", ["switch", result.branch], {
      cwd: result.worktree,
      env: result.env,
      timeout: 60_000
    });
    await run("git", ["pull", "--ff-only", "origin", result.branch], {
      cwd: result.worktree,
      env: result.env,
      timeout: 60_000
    });

    const seededSource = await readFile(
      join(result.worktree, "mendr-e2e", result.branch, "lineRange.ts"),
      "utf8"
    );
    const branchCommits = await run("git", ["rev-list", `origin/${result.defaultBranch}..${result.branch}`], {
      cwd: result.worktree,
      env: result.env,
      timeout: 60_000
    });

    expect(seededSource).not.toContain("line < endInclusive");
    expect(branchCommits.stdout.trim().split("\n").filter(Boolean).length).toBeGreaterThan(1);
  }

  if (options.expectRoundCap) {
    expect(result.report).toMatch(/Round cap reached|No changed-scope issues found/);
  }
}

async function createSeededPullRequest(input: {
  agent: AgentName;
  env: NodeJS.ProcessEnv;
  worktree: string;
}): Promise<{
  branch: string;
  defaultBranch: string;
  prNumber: string;
}> {
  const repo = assertTargetRepo();
  const owner = repo.split("/")[0];
  const defaultBranch = await readDefaultBranch(repo, input.env);
  const branch = `mendr-e2e-${input.agent}-${Date.now()}-${randomUUID().slice(0, 8)}`;

  await run("gh", ["repo", "clone", repo, input.worktree], {
    env: input.env,
    timeout: 120_000
  });
  await configureGitIdentity(input.worktree, input.env);
  await ensureDefaultBranch(input.worktree, defaultBranch, input.env);
  await run("git", ["switch", "-c", branch], {
    cwd: input.worktree,
    env: input.env,
    timeout: 60_000
  });

  const seededDir = join(input.worktree, "mendr-e2e", branch);
  await mkdir(seededDir, { recursive: true });
  await writeFile(
    join(seededDir, "lineRange.ts"),
    [
      "export function changedLineNumbers(start: number, endInclusive: number): number[] {",
      "  const result: number[] = [];",
      "  for (let line = start; line < endInclusive; line += 1) {",
      "    result.push(line);",
      "  }",
      "  return result;",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(seededDir, "lineRange.test.ts"),
    [
      "import { strictEqual } from \"node:assert\";",
      "import { changedLineNumbers } from \"./lineRange\";",
      "",
      "strictEqual(changedLineNumbers(4, 6).join(\",\"), \"4,5,6\");",
      ""
    ].join("\n"),
    "utf8"
  );

  await run("git", ["add", "mendr-e2e"], {
    cwd: input.worktree,
    env: input.env,
    timeout: 60_000
  });
  await run("git", ["commit", "-m", "test(e2e): seed changed line range bug"], {
    cwd: input.worktree,
    env: input.env,
    timeout: 60_000
  });
  await run("git", ["push", "--set-upstream", "origin", branch], {
    cwd: input.worktree,
    env: input.env,
    timeout: 120_000
  });

  const created = await run(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      repo,
      "--head",
      `${owner}:${branch}`,
      "--base",
      defaultBranch,
      "--title",
      `mendr e2e ${input.agent} ${branch}`,
      "--body",
      [
        "This disposable E2E PR adds a changed-line range helper.",
        "The test expects the final changed line to be included, but the implementation currently stops before it."
      ].join("\n")
    ],
    {
      cwd: input.worktree,
      env: input.env,
      timeout: 120_000
    }
  );
  const prNumber = extractPullRequestNumber(created.stdout);

  return {
    branch,
    defaultBranch,
    prNumber
  };
}

async function buildAndLinkCli(): Promise<LinkedCli> {
  const prefix = await mkdtemp(join(tmpdir(), "mendr-e2e-npm-prefix-"));
  tmpRoots.push(prefix);

  await run("npm", ["run", "build"], {
    cwd: repoRoot,
    timeout: 120_000
  });
  await run("npm", ["link"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      npm_config_prefix: prefix
    },
    timeout: 120_000
  });

  return {
    env: {
      ...process.env,
      PATH: `${join(prefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      npm_config_prefix: prefix
    },
    prefix
  };
}

async function readDefaultBranch(repo: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await run(
    "gh",
    ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
    {
      env,
      timeout: 60_000
    }
  );

  return result.stdout.trim() || "main";
}

async function configureGitIdentity(worktree: string, env: NodeJS.ProcessEnv): Promise<void> {
  await run("git", ["config", "user.name", "mendr e2e"], {
    cwd: worktree,
    env,
    timeout: 30_000
  });
  await run("git", ["config", "user.email", "mendr-e2e@example.invalid"], {
    cwd: worktree,
    env,
    timeout: 30_000
  });
}

async function ensureDefaultBranch(
  worktree: string,
  defaultBranch: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const head = await run("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: worktree,
    env,
    reject: false,
    timeout: 30_000
  });

  if (head.exitCode === 0) {
    await run("git", ["fetch", "origin", defaultBranch], {
      cwd: worktree,
      env,
      timeout: 60_000
    });
    await run("git", ["switch", defaultBranch], {
      cwd: worktree,
      env,
      timeout: 60_000
    });
    await run("git", ["pull", "--ff-only", "origin", defaultBranch], {
      cwd: worktree,
      env,
      timeout: 60_000
    });
    return;
  }

  await run("git", ["switch", "--orphan", defaultBranch], {
    cwd: worktree,
    env,
    timeout: 60_000
  });
  await writeFile(join(worktree, "README.md"), "# mendr E2E disposable repository\n", "utf8");
  await run("git", ["add", "README.md"], {
    cwd: worktree,
    env,
    timeout: 60_000
  });
  await run("git", ["commit", "-m", "chore: initialize e2e repository"], {
    cwd: worktree,
    env,
    timeout: 60_000
  });
  await run("git", ["push", "--set-upstream", "origin", defaultBranch], {
    cwd: worktree,
    env,
    timeout: 120_000
  });
}

async function cleanupPullRequest(input: PullRequestCleanupTarget): Promise<void> {
  await run("gh", ["pr", "close", input.prNumber, "--delete-branch"], {
    cwd: input.worktree,
    env: input.env,
    reject: false,
    timeout: 60_000
  });
}

async function readPullRequestCommentBodies(input: {
  env: NodeJS.ProcessEnv;
  prNumber: string;
  worktree: string;
}): Promise<string[]> {
  const result = await run("gh", ["pr", "view", input.prNumber, "--json", "comments"], {
    cwd: input.worktree,
    env: input.env,
    timeout: 60_000
  });
  const parsed = JSON.parse(result.stdout) as { comments?: Array<{ body?: string }> };

  return parsed.comments?.map((comment) => comment.body ?? "") ?? [];
}

async function waitForTerminalState(reviewDir: string): Promise<ReviewRun["state"]> {
  const statePath = join(reviewDir, "state.json");
  const deadline = Date.now() + e2eTimeoutMs;
  let lastState: ReviewRun["state"] | undefined;

  while (Date.now() < deadline) {
    try {
      lastState = JSON.parse(await readFile(statePath, "utf8")) as ReviewRun["state"];

      if (lastState.done || lastState.phase === "failed" || lastState.error) {
        return lastState;
      }
    } catch {
      // The daemon may not have written the first state file yet.
    }

    await delay(2_000);
  }

  throw new Error(
    `Timed out waiting for mendr review to finish. Last state: ${JSON.stringify(lastState)}`
  );
}

async function readJsonl(path: string): Promise<Array<{ status: string; detail?: string }>> {
  const raw = await readFile(path, "utf8");

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { status: string; detail?: string });
}

async function assertRequiredBinary(command: string, args: string[]): Promise<void> {
  await run(command, args, {
    timeout: 30_000
  });
}

function assertTargetRepo(): string {
  if (!targetRepo || !/^[^/]+\/[^/]+$/.test(targetRepo)) {
    throw new Error("Set MENDR_E2E_REPO=owner/name to run the gated E2E suite.");
  }

  return targetRepo;
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore"
  });

  return result.status === 0;
}

function parseStartedReviewId(output: string): string {
  const match = /^Started\s+(\S+)/m.exec(output);

  if (!match) {
    throw new Error(`Could not parse review id from mendr output:\n${output}`);
  }

  return match[1];
}

function extractPullRequestNumber(output: string): string {
  const match = /\/pull\/(\d+)/.exec(output);

  if (!match) {
    throw new Error(`Could not parse pull request number from gh output:\n${output}`);
  }

  return match[1];
}

async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    reject?: boolean;
    timeout?: number;
  } = {}
) {
  const result = await execa(command, args, {
    all: true,
    cwd: options.cwd,
    env: options.env,
    reject: false,
    timeout: options.timeout ?? 120_000
  });

  if (result.exitCode !== 0 && options.reject !== false) {
    const output = result.all?.trim() || result.stderr.trim() || result.stdout.trim();

    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.exitCode}.\n${output}`);
  }

  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
