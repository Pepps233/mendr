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

export type UnresolvedIssueEntry = {
  issue: Issue;
  summary: string;
};

const REPORT_HEADING = "## Summary by Mendr";
const LEGACY_REPORT_HEADING = "## Summary";
const RESOLVED_ISSUES_HEADING = "### Resolved Issues";
const UNRESOLVED_ISSUES_HEADING = "### Unresolved Issues";
const ROUND_CAP_HEADING = "### Round Cap";

export function appendResolvedIssue(report: string, entry: ResolvedIssueEntry): string {
  let normalized = removeUnresolvedIssue(ensureSummary(report), entry.issue.title);
  const issueLine = `#### ${entry.issue.title}`;
  const shaLine = `**Commit:** ${entry.sha}`;
  const legacyBacktickedShaLine = `**Commit:** \`${entry.sha}\``;
  const legacyIssueLine = `- Issue: ${entry.issue.title}`;
  const legacyShaLine = `- Resolved by: ${entry.sha}`;

  if (
    normalized.includes(`${issueLine}\n${shaLine}`) ||
    normalized.includes(`${issueLine}\n${legacyBacktickedShaLine}`) ||
    normalized.includes(`${legacyIssueLine}\n${legacyShaLine}`)
  ) {
    return normalized === ensureSummary(report) ? report : normalized;
  }

  normalized = ensureSection(normalized, RESOLVED_ISSUES_HEADING);

  return appendBlock(normalized, [issueLine, shaLine, entry.summary]);
}

export function appendIssueResult(report: string, entry: IssueResultEntry): string {
  return appendResolvedIssue(report, entry);
}

export function appendUnresolvedIssue(report: string, entry: UnresolvedIssueEntry): string {
  let normalized = ensureSummary(report);
  const issueLine = `#### ${entry.issue.title}`;

  if (
    hasResolvedIssue(normalized, entry.issue.title) ||
    hasUnresolvedIssue(normalized, entry.issue.title)
  ) {
    return report;
  }

  normalized = ensureSection(normalized, UNRESOLVED_ISSUES_HEADING);

  return appendBlock(normalized, [issueLine, entry.summary]);
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

function hasResolvedIssue(report: string, title: string): boolean {
  return hasSectionHeading(report, RESOLVED_ISSUES_HEADING, title);
}

function hasUnresolvedIssue(report: string, title: string): boolean {
  return hasSectionHeading(report, UNRESOLVED_ISSUES_HEADING, title);
}

function hasSectionHeading(report: string, sectionHeading: string, title: string): boolean {
  const section = readSection(report, sectionHeading);

  return hasLine(section, `#### ${title}`);
}

function removeUnresolvedIssue(report: string, title: string): string {
  return removeHeadingBlock(report, UNRESOLVED_ISSUES_HEADING, `#### ${title}`);
}

function removeHeadingBlock(report: string, sectionHeading: string, blockHeading: string): string {
  const lines = report.split("\n");
  const sectionIndex = lines.findIndex((line) => line === sectionHeading);

  if (sectionIndex === -1) {
    return report;
  }

  const blockStart = lines.findIndex((line, index) => index > sectionIndex && line === blockHeading);

  if (blockStart === -1) {
    return report;
  }

  let blockEnd = lines.length;

  for (let index = blockStart + 1; index < lines.length; index += 1) {
    if (/^#{1,4} /.test(lines[index])) {
      blockEnd = index;
      break;
    }
  }

  const next = [...lines.slice(0, blockStart), ...lines.slice(blockEnd)];

  return removeEmptySection(`${next.join("\n").trimEnd()}\n`, sectionHeading);
}

function removeEmptySection(report: string, sectionHeading: string): string {
  const lines = report.split("\n");
  const sectionIndex = lines.findIndex((line) => line === sectionHeading);

  if (sectionIndex === -1) {
    return report;
  }

  const nextSectionIndex = lines.findIndex(
    (line, index) => index > sectionIndex && /^### /.test(line)
  );
  const endIndex = nextSectionIndex === -1 ? lines.length : nextSectionIndex;
  const hasBlock = lines
    .slice(sectionIndex + 1, endIndex)
    .some((line) => /^#### /.test(line));

  if (hasBlock) {
    return report;
  }

  return `${[...lines.slice(0, sectionIndex), ...lines.slice(endIndex)].join("\n").trimEnd()}\n`;
}

function readSection(report: string, sectionHeading: string): string {
  const lines = report.split("\n");
  const sectionIndex = lines.findIndex((line) => line === sectionHeading);

  if (sectionIndex === -1) {
    return "";
  }

  const nextSectionIndex = lines.findIndex(
    (line, index) => index > sectionIndex && /^### /.test(line)
  );
  const endIndex = nextSectionIndex === -1 ? lines.length : nextSectionIndex;

  return lines.slice(sectionIndex, endIndex).join("\n");
}

function hasLine(text: string, line: string): boolean {
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(`^${escaped}$`, "m").test(text);
}
