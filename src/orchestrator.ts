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
import {
  commitStaged,
  getHeadCommitSha,
  getPorcelainStatus,
  pushHeadToBranch,
  resetWorktreeToCommit,
  stageAll
} from "./git.js";
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
import {
  appendEvent,
  appendFixAttempt,
  appendIssueRecord,
  readMeta,
  writeState,
  type ReviewState
} from "./state.js";

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

type IssueAttempt = {
  issue: Issue;
  round: number;
  issueIndex: number;
};

type SingleFixOutcome = {
  status: "fixed" | "failed";
  summary: string;
  sha?: string;
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
    const sessionRepo = meta.worktreePath ?? meta.repo;
    const agentDriver =
      options.agentDriver ??
      createAgentDriver({
        agent,
        exec,
        outputDir: join(dir, "agent-io")
      });
    const details = await fetchPullRequestDetails(exec, sessionRepo, meta.pr);
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

      const diff = await fetchPullRequestDiff(exec, sessionRepo, meta.pr);
      const reviewMarkdown = await readFile(reviewPath, "utf8");
      const ctx = buildContext({
        repo: sessionRepo,
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

      await persistIssueRecords(options, round, issues);

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
      const issueAttempts = issues.map((issue, index): IssueAttempt => ({
        issue,
        round,
        issueIndex: index + 1
      }));
      const newIssues = issueAttempts.filter(
        (attempt) => !attemptedIssueFingerprints.has(issueFingerprint(attempt.issue))
      );
      const repeatedIssues = issueAttempts.filter((attempt) =>
        attemptedIssueFingerprints.has(issueFingerprint(attempt.issue))
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

      for (const { issue } of repeatedIssues) {
        await appendEvent(options.mendrHome, options.reviewId, {
          status: "Issue still open",
          detail: `${issue.title} was already sent to the fixer in an earlier round`
        });
      }

      if (newIssues.length > 0) {
        for (const { issue } of newIssues) {
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

    await postReportWithRetry(options, exec, sessionRepo, meta.pr, reportPath, state);

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
  issues: IssueAttempt[];
  report: string;
  reportPath: string;
  branch: string;
  state: ReviewState;
}): Promise<RoundOutcome> {
  let report = input.report;
  let fixedCount = 0;
  let lastSuccessfulSha = await getHeadCommitSha(input.exec, input.ctx.repo);

  for (const attempt of input.issues) {
    const outcome = await runSingleIssueFix({
      ...input,
      attempt,
      lastSuccessfulSha
    });
    const sha = outcome.status === "fixed" && outcome.sha ? outcome.sha : "(failed)";

    report = appendIssueResult(report, {
      issue: attempt.issue,
      sha,
      summary: outcome.summary
    });
    await appendFixAttempt(input.options.mendrHome, input.options.reviewId, {
      sessionId: input.options.reviewId,
      round: attempt.round,
      issueIndex: attempt.issueIndex,
      fingerprint: issueFingerprint(attempt.issue),
      title: attempt.issue.title,
      status: outcome.status,
      summary: outcome.summary,
      ...(outcome.sha ? { commitSha: outcome.sha } : {})
    });

    if (outcome.status === "fixed" && outcome.sha) {
      fixedCount += 1;
      lastSuccessfulSha = outcome.sha;
    } else {
      await appendEvent(input.options.mendrHome, input.options.reviewId, {
        status: "Fix failed",
        detail: `${attempt.issue.title}: ${outcome.summary}`
      });
    }
  }

  await writeFile(input.reportPath, report, "utf8");

  if (fixedCount > 0) {
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
    fixedCount,
    pushed: fixedCount > 0
  };
}

async function runSingleIssueFix(input: {
  options: RunOrchestratorOptions;
  exec: ExecFn;
  agentDriver: AgentDriver;
  ctx: ReviewContext;
  attempt: IssueAttempt;
  lastSuccessfulSha: string;
  state: ReviewState;
}): Promise<SingleFixOutcome> {
  const { attempt } = input;
  let rawResults: FixIssueResult[];

  try {
    rawResults = await input.agentDriver.fix([attempt.issue], input.ctx);
  } catch (error) {
    await resetFailedIssue(input);

    return {
      status: "failed",
      summary: fixerCrashedSummary(errorToMessage(error))
    };
  }

  const result = normalizeFixResults([attempt.issue], rawResults)[0];

  if (result.status === "failed") {
    await resetFailedIssue(input);

    return {
      status: "failed",
      summary: result.summary
    };
  }

  const status = await getPorcelainStatus(input.exec, input.ctx.repo);

  if (status.length === 0) {
    await resetFailedIssue(input);

    return {
      status: "failed",
      summary: noDiffSummary()
    };
  }

  try {
    await stageAll(input.exec, input.ctx.repo);

    const sha = await commitStaged(
      input.exec,
      input.ctx.repo,
      commitSubject(attempt.issue),
      commitBody(attempt.issue)
    );

    return {
      status: "fixed",
      summary: result.summary,
      sha
    };
  } catch (error) {
    return fail(input.options, input.state, "Commit failed", error);
  }
}

async function resetFailedIssue(input: {
  options: RunOrchestratorOptions;
  exec: ExecFn;
  ctx: ReviewContext;
  lastSuccessfulSha: string;
  state: ReviewState;
}): Promise<void> {
  try {
    await resetWorktreeToCommit(input.exec, input.ctx.repo, input.lastSuccessfulSha);
  } catch (error) {
    await fail(input.options, input.state, "Worktree reset failed", error);
  }
}

function fixerCrashedSummary(message: string): string {
  return `The fixer failed before returning structured results. ${message}`;
}

function noDiffSummary(): string {
  return "The fixer reported this issue as fixed, but did not leave any file changes to commit.";
}

function commitSubject(issue: Issue): string {
  return `fix(${commitScope(issue.file)}): resolve ${sanitizeCommitText(issue.title)}`;
}

function commitBody(issue: Issue): string {
  return [
    `- Resolve reviewed issue: ${sanitizeCommitText(issue.title)}`,
    `- Record mendr issue fingerprint: ${issueFingerprint(issue)}`
  ].join("\n");
}

function commitScope(file: string): string {
  const firstSegment = file.split("/").find((segment) => segment.trim().length > 0);

  return sanitizeCommitText(firstSegment ?? "repo").slice(0, 32) || "repo";
}

function sanitizeCommitText(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[.\n\r]+$/g, "");
}

async function pushWithRetry(exec: ExecFn, repo: string, branch: string): Promise<void> {
  try {
    await pushHeadToBranch(exec, repo, branch);
  } catch {
    await pushHeadToBranch(exec, repo, branch);
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

async function persistIssueRecords(
  options: RunOrchestratorOptions,
  round: number,
  issues: Issue[]
): Promise<void> {
  for (const [index, issue] of issues.entries()) {
    await appendIssueRecord(options.mendrHome, options.reviewId, {
      sessionId: options.reviewId,
      round,
      issueIndex: index + 1,
      fingerprint: issueFingerprint(issue),
      title: issue.title,
      file: issue.file,
      line: issue.line,
      severity: issue.severity,
      description: issue.description
    });
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
