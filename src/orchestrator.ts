import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentDriver, defaultModelForAgent } from "./agents/driver.js";
import {
  dedupeIssues,
  issueFingerprint,
  type AgentDriver,
  type AgentName,
  type FixIssueResult,
  type Issue,
  type ReviewContext
} from "./agents/types.js";
import { defaultExec, type ExecFn } from "./exec.js";
import { pushBranch, verifyCommitSha } from "./git.js";
import {
  fetchPullRequestDetails,
  fetchPullRequestDiff,
  postPullRequestComment,
  renderReviewMarkdown
} from "./github.js";
import {
  appendFailureNote,
  appendIssueResult,
  appendNoIssuesFound,
  appendRoundCapNote
} from "./report.js";
import { reviewDir } from "./paths.js";
import { appendEvent, readMeta, writeState, type ReviewState } from "./state.js";

export type RunOrchestratorOptions = {
  mendrHome: string;
  reviewId: string;
  agentDriver?: AgentDriver;
  exec?: ExecFn;
};

type RoundOutcome = {
  report: string;
  fixedCount: number;
  pushed: boolean;
};

export async function runOrchestrator(options: RunOrchestratorOptions): Promise<void> {
  const exec = options.exec ?? defaultExec;
  const meta = await readMeta(options.mendrHome, options.reviewId);
  const dir = reviewDir(options.mendrHome, options.reviewId);
  const reviewPath = join(dir, "review.md");
  const reportPath = join(dir, "report.md");
  const agent = parseAgentName(meta.agent);
  const model = defaultModelForAgent(agent);
  const agentDriver =
    options.agentDriver ??
    createAgentDriver({
      agent,
      exec,
      outputDir: join(dir, "agent-io")
    });
  let state: ReviewState = {
    phase: "reviewing",
    currentStatus: "Discovering bugs",
    issuesFound: 0,
    issuesFixed: 0,
    done: false,
    capReached: false
  };

  await mkdir(dir, { recursive: true });
  await writeState(options.mendrHome, options.reviewId, state);

  try {
    const details = await fetchPullRequestDetails(exec, meta.repo, meta.pr);
    await writeFile(reviewPath, renderReviewMarkdown(meta.pr, details), "utf8");

    let report = await readReport(reportPath);
    let openIssues: Issue[] = [];

    for (let round = 1; round <= meta.maxRounds; round += 1) {
      state = await updateStatus(options, state, {
        phase: "reviewing",
        currentStatus: "Discovering bugs"
      });
      await appendEvent(options.mendrHome, options.reviewId, {
        status: "Discovering bugs",
        detail: `review round ${round}`
      });

      const diff = await fetchPullRequestDiff(exec, meta.repo, meta.pr);
      const reviewMarkdown = await readFile(reviewPath, "utf8");
      const ctx = buildContext({
        repo: meta.repo,
        pr: meta.pr,
        model,
        diff,
        reviewMarkdown,
        reportMarkdown: report
      });
      let issues: Issue[] = [];

      try {
        issues = dedupeIssues(await agentDriver.review(ctx));
      } catch (error) {
        await fail(options, state, "Review failed", error);
        return;
      }

      state = await updateStatus(options, state, {
        issuesFound: state.issuesFound + issues.length
      });

      if (issues.length === 0) {
        if (report.trim().length === 0) {
          report = appendNoIssuesFound(report);
          await writeFile(reportPath, report, "utf8");
        }

        openIssues = [];
        break;
      }

      openIssues = issues;
      state = await updateStatus(options, state, {
        phase: "fixing",
        currentStatus: "Resolving issues"
      });
      await appendEvent(options.mendrHome, options.reviewId, {
        status: "Resolving issues",
        detail: `fix round ${round} with ${issues.length} issues`
      });

      const outcome = await runFixRound({
        options,
        exec,
        agentDriver,
        ctx: {
          ...ctx,
          reportMarkdown: report
        },
        issues,
        report,
        reportPath,
        branch: meta.branch,
        state
      });

      report = outcome.report;
      state = await updateStatus(options, state, {
        issuesFixed: state.issuesFixed + outcome.fixedCount
      });

      if (round === meta.maxRounds) {
        report = appendRoundCapNote(report, {
          maxRounds: meta.maxRounds,
          openIssues
        });
        await writeFile(reportPath, report, "utf8");
        state = await updateStatus(options, state, {
          capReached: true
        });
      }
    }

    if (openIssues.length === 0) {
      state = await updateStatus(options, state, {
        capReached: false
      });
    }

    await postReportWithRetry(options, exec, meta.repo, meta.pr, reportPath, state);

    await updateStatus(options, state, {
      phase: "complete",
      currentStatus: "Complete",
      done: true
    });
    await appendEvent(options.mendrHome, options.reviewId, {
      status: "Complete",
      detail: "done"
    });
  } catch (error) {
    if (isAlreadyRecordedFailure(state, error)) {
      throw error;
    }

    await fail(options, state, "Orchestrator failed", error);
  }
}

async function runFixRound(input: {
  options: RunOrchestratorOptions;
  exec: ExecFn;
  agentDriver: AgentDriver;
  ctx: ReviewContext;
  issues: Issue[];
  report: string;
  reportPath: string;
  branch: string;
  state: ReviewState;
}): Promise<RoundOutcome> {
  let rawResults: FixIssueResult[] = [];

  try {
    rawResults = await input.agentDriver.fix(input.issues, input.ctx);
  } catch (error) {
    await fail(input.options, input.state, "Fix failed", error);
    return {
      report: input.report,
      fixedCount: 0,
      pushed: false
    };
  }

  const results = normalizeFixResults(input.issues, rawResults);
  const fixedResults = results.filter(
    (result): result is FixIssueResult & { sha: string } =>
      result.status === "fixed" && typeof result.sha === "string"
  );
  let report = input.report;

  for (const result of fixedResults) {
    try {
      await verifyCommitSha(input.exec, input.ctx.repo, result.sha);
    } catch (error) {
      await fail(input.options, input.state, "Fix failed", error);
    }
  }

  for (const issue of input.issues) {
    const result = results.find((candidate) => candidate.fingerprint === issueFingerprint(issue));
    const sha = result?.status === "fixed" && result.sha ? result.sha : "(failed)";
    const summary = result?.summary ?? "The fixer did not report a result. Manual follow-up is required.";

    report = appendIssueResult(report, {
      issue,
      sha,
      summary
    });

    if (result?.status === "failed") {
      await appendEvent(input.options.mendrHome, input.options.reviewId, {
        status: "Fix failed",
        detail: `${issue.title}: ${summary}`
      });
    }
  }

  await writeFile(input.reportPath, report, "utf8");

  if (fixedResults.length > 0) {
    try {
      await pushWithRetry(input.exec, input.ctx.repo, input.branch);
    } catch (error) {
      const message = errorToMessage(error);
      const failedReport = appendFailureNote(report, `push failed: ${message}`);

      await writeFile(input.reportPath, failedReport, "utf8");
      await fail(input.options, input.state, "Push failed", error);
    }
  }

  return {
    report,
    fixedCount: fixedResults.length,
    pushed: fixedResults.length > 0
  };
}

async function pushWithRetry(exec: ExecFn, repo: string, branch: string): Promise<void> {
  try {
    await pushBranch(exec, repo, branch);
  } catch {
    await pushBranch(exec, repo, branch);
  }
}

async function postReportWithRetry(
  options: RunOrchestratorOptions,
  exec: ExecFn,
  repo: string,
  pr: string,
  reportPath: string,
  state: ReviewState
): Promise<void> {
  const postingState = await updateStatus(options, state, {
    phase: "posting",
    currentStatus: "Posting review"
  });
  await appendEvent(options.mendrHome, options.reviewId, {
    status: "Posting review",
    detail: "posting report comment"
  });

  try {
    await postPullRequestComment(exec, repo, pr, reportPath);
  } catch {
    try {
      await postPullRequestComment(exec, repo, pr, reportPath);
    } catch (error) {
      await fail(options, postingState, "Posting review failed", error);
    }
  }
}

function normalizeFixResults(issues: Issue[], results: FixIssueResult[]): FixIssueResult[] {
  const byFingerprint = new Map(results.map((result) => [result.fingerprint, result]));

  return issues.map((issue) => {
    const fingerprint = issueFingerprint(issue);
    const byExactFingerprint = byFingerprint.get(fingerprint);
    const byTitle = results.find((result) => result.title === issue.title);
    const result = byExactFingerprint ?? byTitle;

    if (result) {
      return {
        ...result,
        fingerprint
      };
    }

    return {
      title: issue.title,
      fingerprint,
      status: "failed",
      summary: "The fixer did not return a result for this issue. Manual follow-up is required."
    };
  });
}

async function updateStatus(
  options: RunOrchestratorOptions,
  previous: ReviewState,
  patch: Partial<ReviewState>
): Promise<ReviewState> {
  const next = {
    ...previous,
    ...patch
  };

  await writeState(options.mendrHome, options.reviewId, next);

  return next;
}

async function fail(
  options: RunOrchestratorOptions,
  state: ReviewState,
  status: string,
  error: unknown
): Promise<never> {
  const message = errorToMessage(error);

  await writeState(options.mendrHome, options.reviewId, {
    ...state,
    phase: "failed",
    currentStatus: status,
    done: false,
    error: message
  });
  await appendEvent(options.mendrHome, options.reviewId, {
    status,
    detail: message
  });

  const recordedError = error instanceof Error ? error : new Error(message);

  Object.defineProperty(recordedError, "mendrFailureRecorded", {
    value: true,
    configurable: true
  });

  throw recordedError;
}

async function readReport(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function buildContext(ctx: ReviewContext): ReviewContext {
  return ctx;
}

function parseAgentName(agent: string): AgentName {
  if (agent === "claude" || agent === "codex") {
    return agent;
  }

  throw new Error(`Unsupported agent: ${agent}`);
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyRecordedFailure(state: ReviewState, error: unknown): boolean {
  return (
    state.phase === "failed" ||
    (typeof error === "object" &&
      error !== null &&
      "mendrFailureRecorded" in error &&
      (error as { mendrFailureRecorded?: unknown }).mendrFailureRecorded === true)
  );
}
