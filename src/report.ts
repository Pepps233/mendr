import type { Issue } from "./agents/types.js";

export type ResolvedIssueEntry = {
  issue: Issue;
  sha: string;
  summary: string;
};

export type IssueResultEntry = ResolvedIssueEntry;

export type RoundCapNote = {
  maxRounds: number;
  openIssues: Issue[];
};

const REPORT_HEADING = "## Summary by Mendr";
const LEGACY_REPORT_HEADING = "## Summary";
const RESOLVED_ISSUES_HEADING = "### Resolved Issues";
const ROUND_CAP_HEADING = "### Round Cap";

export function appendResolvedIssue(report: string, entry: ResolvedIssueEntry): string {
  let normalized = ensureSummary(report);
  const issueLine = `#### ${entry.issue.title}`;
  const shaLine = `**Commit:** ${entry.sha}`;
  const legacyIssueLine = `- Issue: ${entry.issue.title}`;
  const legacyShaLine = `- Resolved by: ${entry.sha}`;

  if (
    normalized.includes(`${issueLine}\n${shaLine}`) ||
    normalized.includes(`${legacyIssueLine}\n${legacyShaLine}`)
  ) {
    return report;
  }

  normalized = ensureSection(normalized, RESOLVED_ISSUES_HEADING);

  return appendBlock(normalized, [issueLine, shaLine, entry.summary]);
}

export function appendIssueResult(report: string, entry: IssueResultEntry): string {
  return appendResolvedIssue(report, entry);
}

export function appendNoIssuesFound(report: string): string {
  const normalized = ensureSummary(report);
  const line = "- No changed-scope issues found.";

  if (normalized.includes(line)) {
    return report;
  }

  return appendBlock(normalized, [line]);
}

export function appendFailureNote(report: string, message: string): string {
  const normalized = ensureSummary(report);
  const line = `- Failure: ${message}`;

  if (normalized.includes(line)) {
    return report;
  }

  return appendBlock(normalized, [line]);
}

export function appendRoundCapNote(report: string, note: RoundCapNote): string {
  let normalized = ensureSummary(report);
  const round = note.maxRounds === 1 ? "round" : "rounds";
  const issue = note.openIssues.length === 1 ? "issue" : "issues";
  const capLine = `Reached after ${note.maxRounds} ${round} with ${note.openIssues.length} open ${issue}:`;
  const legacyCapLine = `- Round cap reached after ${note.maxRounds} ${round} with ${note.openIssues.length} open ${issue}.`;
  const openIssueLines = note.openIssues.map((openIssue) => `- ${openIssue.title}`);

  if (normalized.includes(capLine) || normalized.includes(legacyCapLine)) {
    return report;
  }

  normalized = ensureSection(normalized, ROUND_CAP_HEADING);

  return appendBlock(normalized, [capLine, ...openIssueLines]);
}

function ensureSummary(report: string): string {
  const trimmed = report.trim();

  if (trimmed.length === 0) {
    return `${REPORT_HEADING}\n`;
  }

  if (hasLine(trimmed, REPORT_HEADING)) {
    return `${trimmed}\n`;
  }

  if (hasLine(trimmed, LEGACY_REPORT_HEADING)) {
    return `${trimmed.replace(/^## Summary$/m, REPORT_HEADING)}\n`;
  }

  return `${REPORT_HEADING}\n${trimmed}\n`;
}

function ensureSection(report: string, sectionHeading: string): string {
  if (hasLine(report, sectionHeading)) {
    return report;
  }

  return appendBlock(report, [sectionHeading]);
}

function appendBlock(report: string, lines: string[]): string {
  const base = report.trimEnd();
  const separator = base.length === 0 ? "" : "\n\n";

  return `${base}${separator}${lines.join("\n")}\n`;
}

function hasLine(text: string, line: string): boolean {
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(`^${escaped}$`, "m").test(text);
}
