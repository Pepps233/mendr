import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
  ensureMergeableWithRef,
  fetchRemoteBranch,
  getHeadCommitSha,
  getPorcelainStatus,
  pushHeadToBranch,
  resetWorktreeToCommit,
  stageAll
} from "./git.js";
import {
  fetchPullRequestDetails,
  fetchPullRequestDiff,
  fetchPullRequestReadinessRefs,
  postPullRequestComment,
  renderReviewMarkdown,
  type PullRequestReadinessRefs,
  waitForPullRequestChecks
} from "./github.js";
import {
  appendFailureNote,
  appendIssueResult,
  appendNoIssuesFound,
  appendRoundCapNote,
  appendUnresolvedIssue
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
  state: ReviewState;
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

type SummaryValidationFailure = {
  status: string;
  error: unknown;
};

type SummaryValidationResult = {
  state: ReviewState;
  failure?: SummaryValidationFailure;
};

type CommitMessageValidation =
  | {
      valid: true;
      message: string;
    }
  | {
      valid: false;
      reason: string;
    };

class PullRequestHeadChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestHeadChangedError";
  }
}

const PR_HEAD_PROPAGATION_TIMEOUT_MS = 30_000;
const PR_HEAD_PROPAGATION_POLL_MS = 2_000;

type ValidatePullRequestMergeabilityOptions = {
  expectedHeadSha?: string;
  waitForLocalHead?: boolean;
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
          branchPushRemote: normalizeBranchPushRemote(meta.branchPushRemote),
          state,
          setState: (nextState) => {
            state = nextState;
          }
        });

        report = outcome.report;
        state = outcome.state;
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

    const validationResult = await validatePullRequestReadyForSummary(
      options,
      exec,
      sessionRepo,
      meta.pr,
      state
    );
    state = validationResult.state;

    if (validationResult.failure) {
      report = appendValidationFailureNote(report, validationResult.failure);
      await writeFile(reportPath, report, "utf8");
    }

    state = await postReportWithRetry(options, exec, sessionRepo, meta.pr, reportPath, state);

    if (validationResult.failure) {
      await fail(
        options,
        state,
        validationResult.failure.status,
        validationResult.failure.error
      );
    }

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
  branchPushRemote: string;
  state: ReviewState;
  setState: (state: ReviewState) => void;
}): Promise<RoundOutcome> {
  let report = input.report;
  let fixedCount = 0;
  let lastSuccessfulSha = await getHeadCommitSha(input.exec, input.ctx.repo);
  let state = input.state;

  for (const attempt of input.issues) {
    const outcome = await runSingleIssueFix({
      ...input,
      ctx: {
        ...input.ctx,
        reportMarkdown: report
      },
      attempt,
      lastSuccessfulSha,
      state
    });

    if (outcome.status === "fixed" && outcome.sha) {
      report = appendIssueResult(report, {
        issue: attempt.issue,
        sha: outcome.sha,
        summary: outcome.summary
      });
    } else {
      report = appendUnresolvedIssue(report, {
        issue: attempt.issue,
        summary: outcome.summary
      });
    }

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
    await writeFile(input.reportPath, report, "utf8");

    if (outcome.status === "fixed" && outcome.sha) {
      fixedCount += 1;
      lastSuccessfulSha = outcome.sha;
      state = await updateStatus(input.options, state, {
        issuesFixed: state.issuesFixed + 1
      });
      input.setState(state);
    } else {
      await appendEvent(input.options.mendrHome, input.options.reviewId, {
        status: "Fix failed",
        detail: `${attempt.issue.title}: ${outcome.summary}`
      });
    }
  }

  if (fixedCount > 0) {
    try {
      await pushWithRetry(input.exec, input.ctx.repo, input.branchPushRemote, input.branch);
    } catch (error) {
      const message = errorToMessage(error);
      const failedReport = appendFailureNote(report, `push failed: ${message}`);

      await writeFile(input.reportPath, failedReport, "utf8");
      await fail(input.options, state, "Push failed", error);
    }
  }

  return {
    report,
    fixedCount,
    pushed: fixedCount > 0,
    state
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

  const movedHeadOutcome = await failIfFixerMovedHead(input);

  if (movedHeadOutcome) {
    return movedHeadOutcome;
  }

  const result = normalizeFixResults([attempt.issue], rawResults)[0];

  if (result.status === "failed") {
    await resetFailedIssue(input);

    return {
      status: "failed",
      summary: result.summary
    };
  }

  const commitMessage = validateCommitMessage(result.commitMessage);

  if (!commitMessage.valid) {
    await resetFailedIssue(input);

    return {
      status: "failed",
      summary: invalidCommitMessageSummary(commitMessage.reason)
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
      commitMessage.message
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

async function failIfFixerMovedHead(input: {
  options: RunOrchestratorOptions;
  exec: ExecFn;
  ctx: ReviewContext;
  lastSuccessfulSha: string;
  state: ReviewState;
}): Promise<SingleFixOutcome | undefined> {
  const currentHead = await getHeadCommitSha(input.exec, input.ctx.repo);

  if (currentHead === input.lastSuccessfulSha) {
    return undefined;
  }

  await resetFailedIssue(input);

  return {
    status: "failed",
    summary: fixerMovedHeadSummary(input.lastSuccessfulSha, currentHead)
  };
}

function fixerCrashedSummary(message: string): string {
  return `The fixer failed before returning structured results. ${message}`;
}

function fixerMovedHeadSummary(expectedSha: string, actualSha: string): string {
  return `The fixer moved HEAD from ${expectedSha} to ${actualSha} before returning. mendr reset the worktree so unrecorded fixer commits are not pushed.`;
}

function noDiffSummary(): string {
  return "The fixer reported this issue as fixed, but did not leave any file changes to commit. Manual follow-up is required to determine whether the issue still needs a code change.";
}

function appendValidationFailureNote(
  report: string,
  failure: SummaryValidationFailure
): string {
  return appendFailureNote(report, `${failure.status}: ${errorToMessage(failure.error)}`);
}

function validateCommitMessage(message: string | undefined): CommitMessageValidation {
  const normalized = message?.replace(/\r\n?/g, "\n").trim();

  if (!normalized) {
    return {
      valid: false,
      reason: "the fixer did not provide a commit message"
    };
  }

  if (normalized.includes("\0")) {
    return {
      valid: false,
      reason: "commit messages must not contain NUL bytes"
    };
  }

  const forbiddenReason = forbiddenCommitMessageReason(normalized);

  if (forbiddenReason) {
    return {
      valid: false,
      reason: forbiddenReason
    };
  }

  const lines = normalized.split("\n");

  if (lines.length !== 4) {
    return {
      valid: false,
      reason:
        "commit messages must contain a subject, a blank line, and exactly two bullet lines"
    };
  }

  if (lines[1] !== "") {
    return {
      valid: false,
      reason: "commit messages must separate the subject from the body with a blank line"
    };
  }

  const subject = parseCommitSubject(lines[0]);

  if (!subject) {
    return {
      valid: false,
      reason:
        "commit message subjects must match <type>(<scope>): <short imperative summary>"
    };
  }

  if (subject.summary.endsWith(".")) {
    return {
      valid: false,
      reason: "commit message summaries must not end with a period"
    };
  }

  if (looksNonImperative(subject.summary)) {
    return {
      valid: false,
      reason: "commit message summaries must be imperative"
    };
  }

  if (!lines[2].startsWith("- ") || lines[2].trim() === "-") {
    return {
      valid: false,
      reason: "commit message bodies must use a non-empty first bullet"
    };
  }

  if (!lines[3].startsWith("- ") || lines[3].trim() === "-") {
    return {
      valid: false,
      reason: "commit message bodies must use a non-empty second bullet"
    };
  }

  return {
    valid: true,
    message: normalized
  };
}

function invalidCommitMessageSummary(reason: string): string {
  return `The fixer reported this issue as fixed, but its commit message is invalid: ${reason}. Manual follow-up is required before Mendr can safely record and push the fix.`;
}

function forbiddenCommitMessageReason(message: string): string | undefined {
  const lines = message.split("\n");

  if (lines.some((line) => /^co-authored-by\s*:/i.test(line.trim()))) {
    return "commit messages must not include co-author lines";
  }

  if (/\b(?:ai|a\.i\.|openai|chatgpt|claude|anthropic|codex|providers?)\b/i.test(message)) {
    return "commit messages must not include AI or provider references";
  }

  return undefined;
}

function parseCommitSubject(
  line: string
): { type: string; scope: string; summary: string } | undefined {
  const match = /^([a-z][a-z0-9-]*)\(([a-z0-9._/-]+)\): ([A-Za-z][^\n]*)$/.exec(line);

  if (!match) {
    return undefined;
  }

  const [, type, scope, summary] = match;

  if (!summary.trim()) {
    return undefined;
  }

  return {
    type,
    scope,
    summary
  };
}

function looksNonImperative(summary: string): boolean {
  const firstWord = summary.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

  return [
    "added",
    "adding",
    "adds",
    "changed",
    "changing",
    "changes",
    "created",
    "creating",
    "creates",
    "fixed",
    "fixing",
    "fixes",
    "handled",
    "handling",
    "handles",
    "made",
    "makes",
    "prevented",
    "preventing",
    "prevents",
    "recorded",
    "recording",
    "records",
    "rejected",
    "rejecting",
    "rejects",
    "updated",
    "updating",
    "updates",
    "used",
    "using",
    "uses",
    "validated",
    "validating",
    "validates"
  ].includes(firstWord);
}

async function pushWithRetry(
  exec: ExecFn,
  repo: string,
  remote: string,
  branch: string
): Promise<void> {
  try {
    await pushHeadToBranch(exec, repo, remote, branch);
  } catch {
    await pushHeadToBranch(exec, repo, remote, branch);
  }
}

function normalizeBranchPushRemote(remote: string | undefined): string {
  const normalized = remote?.trim();

  return normalized && normalized.length > 0 ? normalized : "origin";
}

async function postReportWithRetry(
  options: RunOrchestratorOptions,
  exec: ExecFn,
  repo: string,
  pr: string,
  reportPath: string,
  state: ReviewState
): Promise<ReviewState> {
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

  return postingState;
}

async function validatePullRequestReadyForSummary(
  options: RunOrchestratorOptions,
  exec: ExecFn,
  repo: string,
  pr: string,
  state: ReviewState
): Promise<SummaryValidationResult> {
  const validationState = await updateStatus(options, state, {
    phase: "validating",
    currentStatus: "Validating PR"
  });
  await appendEvent(options.mendrHome, options.reviewId, {
    status: "Validating PR",
    detail: "checking merge conflicts and CI"
  });

  let expectedHeadSha = "";

  try {
    expectedHeadSha = (
      await validateCurrentPullRequestMergeability(exec, repo, pr, {
        waitForLocalHead: true
      })
    ).headSha;
  } catch (error) {
    return mergeabilityValidationResult(options, validationState, error);
  }

  try {
    await waitForPullRequestChecks(exec, repo, pr);
  } catch (error) {
    return {
      state: validationState,
      failure: {
        status: "CI failed",
        error
      }
    };
  }

  try {
    await validateCurrentPullRequestMergeability(exec, repo, pr, {
      expectedHeadSha
    });
  } catch (error) {
    return mergeabilityValidationResult(options, validationState, error);
  }

  return {
    state: validationState
  };
}

async function validateCurrentPullRequestMergeability(
  exec: ExecFn,
  repo: string,
  pr: string,
  options: ValidatePullRequestMergeabilityOptions = {}
): Promise<PullRequestReadinessRefs> {
  const localHeadSha = await getHeadCommitSha(exec, repo);
  const readinessRefs = options.waitForLocalHead
    ? await waitForPullRequestHeadToMatchLocal(exec, repo, pr, localHeadSha)
    : await fetchPullRequestReadinessRefs(exec, repo, pr);

  if (options.expectedHeadSha !== undefined) {
    assertPullRequestHeadUnchanged(options.expectedHeadSha, readinessRefs.headSha);
  }

  assertPullRequestHeadMatchesLocal(localHeadSha, readinessRefs.headSha);

  const baseRef = await fetchRemoteBranch(exec, repo, "origin", readinessRefs.baseBranch);

  await ensureMergeableWithRef(exec, repo, baseRef);

  return readinessRefs;
}

async function waitForPullRequestHeadToMatchLocal(
  exec: ExecFn,
  repo: string,
  pr: string,
  localHeadSha: string
): Promise<PullRequestReadinessRefs> {
  const deadline = Date.now() + PR_HEAD_PROPAGATION_TIMEOUT_MS;
  let attempt = 0;
  let lastObservedHeadSha = "";

  while (Date.now() <= deadline) {
    const readinessRefs = await fetchPullRequestReadinessRefs(exec, repo, pr);
    lastObservedHeadSha = readinessRefs.headSha;

    if (readinessRefs.headSha === localHeadSha) {
      return readinessRefs;
    }

    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
      break;
    }

    const waitMs =
      attempt === 0 ? 0 : Math.min(PR_HEAD_PROPAGATION_POLL_MS, remainingMs);
    attempt += 1;

    if (waitMs > 0) {
      await delay(waitMs);
    }
  }

  throw new PullRequestHeadChangedError(
    `Local session HEAD ${localHeadSha} does not match current PR head ${lastObservedHeadSha} after waiting for GitHub to report the pushed head. Re-run Mendr so the final summary is posted only after validating the current PR head.`
  );
}

async function mergeabilityValidationResult(
  options: RunOrchestratorOptions,
  state: ReviewState,
  error: unknown
): Promise<SummaryValidationResult> {
  if (error instanceof PullRequestHeadChangedError) {
    await fail(options, state, "PR head changed", error);
  }

  return {
    state,
    failure: {
      status: "Merge conflict check failed",
      error
    }
  };
}

function assertPullRequestHeadMatchesLocal(localHeadSha: string, prHeadSha: string): void {
  if (localHeadSha === prHeadSha) {
    return;
  }

  throw new PullRequestHeadChangedError(
    `Local session HEAD ${localHeadSha} does not match current PR head ${prHeadSha}. Re-run Mendr so the final summary is posted only after validating the current PR head.`
  );
}

function assertPullRequestHeadUnchanged(expectedHeadSha: string, currentHeadSha: string): void {
  if (expectedHeadSha === currentHeadSha) {
    return;
  }

  throw new PullRequestHeadChangedError(
    `Pull request head changed from ${expectedHeadSha} to ${currentHeadSha} while Mendr was validating readiness. Re-run Mendr so the final summary is posted only after validating the current PR head.`
  );
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
