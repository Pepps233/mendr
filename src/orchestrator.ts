import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  allowedEffortsForAgent,
  createAgentDriver,
  defaultEffortForAgent,
  defaultModelForAgent,
  isEffortForAgent
} from "./agents/driver.js";
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
import { getHeadCommitSha, listCommitShasInRange, pushBranch, verifyCommitSha } from "./git.js";
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

type FixCommitWindow = {
  afterSha: string;
  commitShas: Set<string>;
};

export async function runOrchestrator(options: RunOrchestratorOptions): Promise<void> {
  const exec = options.exec ?? defaultExec;
  const dir = reviewDir(options.mendrHome, options.reviewId);
  const reviewPath = join(dir, "review.md");
  const reportPath = join(dir, "report.md");
  let state: ReviewState = {
    phase: "starting",
    currentStatus: "Starting",
    issuesFound: 0,
    issuesFixed: 0,
    done: false,
    capReached: false
  };

  try {
    await mkdir(dir, { recursive: true });
    await writeState(options.mendrHome, options.reviewId, state);

    const meta = await readMeta(options.mendrHome, options.reviewId);
    const agent = parseAgentName(meta.agent);
    const model = meta.model ?? defaultModelForAgent(agent);
    const effort = resolveEffort(agent, meta.effort);
    const agentDriver =
      options.agentDriver ??
      createAgentDriver({
        agent,
        exec,
        outputDir: join(dir, "agent-io")
      });
    const details = await fetchPullRequestDetails(exec, meta.repo, meta.pr);
    await writeFile(reviewPath, renderReviewMarkdown(meta.pr, details), "utf8");

    let report = await readReport(reportPath);
    let openIssues: Issue[] = [];
    const attemptedIssueFingerprints = new Set<string>();

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
        effort,
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
      const newIssues = issues.filter(
        (issue) => !attemptedIssueFingerprints.has(issueFingerprint(issue))
      );
      const repeatedIssues = issues.filter((issue) =>
        attemptedIssueFingerprints.has(issueFingerprint(issue))
      );

      state = await updateStatus(options, state, {
        phase: "fixing",
        currentStatus: "Resolving issues"
      });
      await appendEvent(options.mendrHome, options.reviewId, {
        status: "Resolving issues",
        detail:
          newIssues.length > 0
            ? `fix round ${round} with ${newIssues.length} new issues`
            : `fix round ${round} skipped because all ${issues.length} issues were already attempted`
      });

      for (const issue of repeatedIssues) {
        await appendEvent(options.mendrHome, options.reviewId, {
          status: "Issue still open",
          detail: `${issue.title} was already sent to the fixer in an earlier round`
        });
      }

      if (newIssues.length > 0) {
        for (const issue of newIssues) {
          attemptedIssueFingerprints.add(issueFingerprint(issue));
        }

        const outcome = await runFixRound({
          options,
          exec,
          agentDriver,
          ctx: {
            ...ctx,
            reportMarkdown: report
          },
          issues: newIssues,
          report,
          reportPath,
          branch: meta.branch,
          state
        });

        report = outcome.report;
        state = await updateStatus(options, state, {
          issuesFixed: state.issuesFixed + outcome.fixedCount
        });
      }

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
  const beforeSha = await getHeadCommitSha(input.exec, input.ctx.repo);
  let rawResults: FixIssueResult[] = [];

  try {
    rawResults = await input.agentDriver.fix(input.issues, input.ctx);
  } catch (error) {
    return recordFailedFixBatch(input, error);
  }

  let results = normalizeFixResults(input.issues, rawResults);
  const reportedFixedResults = results.filter((result) => result.status === "fixed");

  if (reportedFixedResults.length > 0) {
    try {
      const commitWindow = await captureFixCommitWindow(input.exec, input.ctx.repo, beforeSha);

      results = await validateFixResultShas(input.exec, input.ctx.repo, results, commitWindow);
    } catch (error) {
      const message = errorToMessage(error);

      results = results.map((result) =>
        result.status === "fixed"
          ? {
              ...result,
              status: "failed",
              sha: undefined,
              summary: fixedButUncommittedSummary(message)
            }
          : result
      );
    }
  }

  const fixedResults = results.filter(
    (result): result is FixIssueResult & { sha: string } =>
      result.status === "fixed" && typeof result.sha === "string"
  );
  let report = input.report;

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

async function recordFailedFixBatch(
  input: {
    options: RunOrchestratorOptions;
    issues: Issue[];
    report: string;
    reportPath: string;
  },
  error: unknown
): Promise<RoundOutcome> {
  const message = errorToMessage(error);
  let report = input.report;

  for (const issue of input.issues) {
    const summary = fixerCrashedSummary(message);

    report = appendIssueResult(report, {
      issue,
      sha: "(failed)",
      summary
    });
    await appendEvent(input.options.mendrHome, input.options.reviewId, {
      status: "Fix failed",
      detail: `${issue.title}: ${summary}`
    });
  }

  await writeFile(input.reportPath, report, "utf8");

  return {
    report,
    fixedCount: 0,
    pushed: false
  };
}

async function captureFixCommitWindow(
  exec: ExecFn,
  repo: string,
  beforeSha: string
): Promise<FixCommitWindow> {
  const afterSha = await getHeadCommitSha(exec, repo);

  if (afterSha.length === 0) {
    throw new Error("git rev-parse HEAD returned an empty commit SHA.");
  }

  if (afterSha === beforeSha) {
    throw new Error("the fixer reported fixed issues, but HEAD did not change.");
  }

  const verifiedAfterSha = await verifyCommitSha(exec, repo, afterSha);
  const commitShas = new Set(await listCommitShasInRange(exec, repo, beforeSha, verifiedAfterSha));

  if (commitShas.size === 0) {
    throw new Error("git rev-list did not return any commits created by the fixer.");
  }

  return {
    afterSha: verifiedAfterSha,
    commitShas
  };
}

async function validateFixResultShas(
  exec: ExecFn,
  repo: string,
  results: FixIssueResult[],
  commitWindow: FixCommitWindow
): Promise<FixIssueResult[]> {
  const validated: FixIssueResult[] = [];

  for (const result of results) {
    if (result.status !== "fixed") {
      validated.push(result);
      continue;
    }

    if (!result.sha) {
      validated.push({
        ...result,
        status: "failed",
        summary: missingFixShaSummary()
      });
      continue;
    }

    try {
      const verifiedSha = await verifyCommitSha(exec, repo, result.sha);

      if (!commitWindow.commitShas.has(verifiedSha)) {
        validated.push({
          ...result,
          status: "failed",
          sha: undefined,
          summary: outOfRangeFixShaSummary(result.sha, commitWindow.afterSha)
        });
        continue;
      }

      validated.push({
        ...result,
        sha: verifiedSha
      });
    } catch (error) {
      validated.push({
        ...result,
        status: "failed",
        sha: undefined,
        summary: invalidFixShaSummary(errorToMessage(error))
      });
    }
  }

  return validated;
}

function fixerCrashedSummary(message: string): string {
  return `The fixer failed before returning structured results. ${message}`;
}

function fixedButUncommittedSummary(message: string): string {
  return `The fixer reported a fix, but mendr could not capture a new commit SHA. ${message}`;
}

function missingFixShaSummary(): string {
  return "The fixer reported this issue as fixed without a commit SHA. Manual follow-up is required.";
}

function invalidFixShaSummary(message: string): string {
  return `The fixer reported a commit SHA that mendr could not verify. ${message}`;
}

function outOfRangeFixShaSummary(sha: string, afterSha: string): string {
  return `The fixer reported commit ${sha}, but it was not created in this batch. The batch ended at ${afterSha}.`;
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

function resolveEffort(agent: AgentName, effort: string | undefined): ReviewContext["effort"] {
  if (!effort) {
    return defaultEffortForAgent(agent);
  }

  if (isEffortForAgent(agent, effort)) {
    return effort;
  }

  throw new Error(
    `Invalid ${agent} effort "${effort}" in review metadata. Expected one of: ${allowedEffortsForAgent(agent).join(", ")}.`
  );
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
