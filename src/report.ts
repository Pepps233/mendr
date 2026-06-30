import { Buffer } from "node:buffer";

import { issueFingerprint, type Issue } from "./agents/types.js";

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
const ISSUE_FINGERPRINT_PREFIX = "<!-- mendr-issue-fingerprint: ";
const ISSUE_FINGERPRINT_SUFFIX = " -->";

export function appendResolvedIssue(report: string, entry: ResolvedIssueEntry): string {
  const original = ensureSummary(report);
  let normalized = removeUnresolvedIssue(original, entry.issue);
  const issueLine = `#### ${entry.issue.title}`;
  const fingerprintLine = issueFingerprintLine(entry.issue);
  const shaLine = `**Commit:** ${entry.sha}`;
  const legacyBacktickedShaLine = `**Commit:** \`${entry.sha}\``;
  const legacyIssueLine = `- Issue: ${entry.issue.title}`;
  const legacyShaLine = `- Resolved by: ${entry.sha}`;

  if (
    hasResolvedIssueEntry(normalized, entry) ||
    normalized.includes(`${issueLine}\n${shaLine}`) ||
    normalized.includes(`${issueLine}\n${legacyBacktickedShaLine}`) ||
    normalized.includes(`${legacyIssueLine}\n${legacyShaLine}`)
  ) {
    return normalized === original ? report : normalized;
  }

  normalized = ensureSection(normalized, RESOLVED_ISSUES_HEADING);

  return appendBlock(normalized, [issueLine, fingerprintLine, shaLine, entry.summary]);
}

export function appendIssueResult(report: string, entry: IssueResultEntry): string {
  return appendResolvedIssue(report, entry);
}

export function appendUnresolvedIssue(report: string, entry: UnresolvedIssueEntry): string {
  let normalized = ensureSummary(report);
  const issueLine = `#### ${entry.issue.title}`;
  const fingerprintLine = issueFingerprintLine(entry.issue);

  if (
    hasResolvedIssue(normalized, entry.issue) ||
    hasUnresolvedIssue(normalized, entry.issue)
  ) {
    return report;
  }

  normalized = ensureSection(normalized, UNRESOLVED_ISSUES_HEADING);

  return appendBlock(normalized, [issueLine, fingerprintLine, entry.summary]);
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

function hasResolvedIssue(report: string, issue: Issue): boolean {
  return hasIssueBlock(report, RESOLVED_ISSUES_HEADING, issue);
}

function hasResolvedIssueEntry(report: string, entry: ResolvedIssueEntry): boolean {
  const shaLine = `**Commit:** ${entry.sha}`;
  const legacyBacktickedShaLine = `**Commit:** \`${entry.sha}\``;

  return readHeadingBlocks(report, RESOLVED_ISSUES_HEADING).some((block) => {
    const blockText = block.join("\n");

    return (
      hasIssueFingerprint(block, entry.issue) &&
      (hasLine(blockText, shaLine) || hasLine(blockText, legacyBacktickedShaLine))
    );
  });
}

function hasUnresolvedIssue(report: string, issue: Issue): boolean {
  return hasIssueBlock(report, UNRESOLVED_ISSUES_HEADING, issue);
}

function hasIssueBlock(report: string, sectionHeading: string, issue: Issue): boolean {
  return readHeadingBlocks(report, sectionHeading).some((block) =>
    hasIssueFingerprint(block, issue)
  );
}

function hasIssueFingerprint(block: string[], issue: Issue): boolean {
  return hasLine(block.join("\n"), issueFingerprintLine(issue));
}

function removeUnresolvedIssue(report: string, issue: Issue): string {
  return removeHeadingBlocks(report, UNRESOLVED_ISSUES_HEADING, (block) =>
    hasIssueFingerprint(block, issue)
  );
}

function removeHeadingBlocks(
  report: string,
  sectionHeading: string,
  shouldRemoveBlock: (block: string[]) => boolean
): string {
  const lines = report.split("\n");
  const sectionIndex = lines.findIndex((line) => line === sectionHeading);

  if (sectionIndex === -1) {
    return report;
  }

  const ranges: Array<{ start: number; end: number }> = [];
  let index = sectionIndex + 1;

  while (index < lines.length && !isSectionHeading(lines[index])) {
    if (!isIssueHeading(lines[index])) {
      index += 1;
      continue;
    }

    const blockStart = index;
    const blockEnd = findHeadingBlockEnd(lines, blockStart);

    if (shouldRemoveBlock(lines.slice(blockStart, blockEnd))) {
      ranges.push({ start: blockStart, end: blockEnd });
    }

    index = blockEnd;
  }

  if (ranges.length === 0) {
    return report;
  }

  const next = [...lines];

  for (const range of ranges.reverse()) {
    next.splice(range.start, range.end - range.start);
  }

  return removeEmptySection(`${next.join("\n").trimEnd()}\n`, sectionHeading);
}

function removeEmptySection(report: string, sectionHeading: string): string {
  const lines = report.split("\n");
  const sectionIndex = lines.findIndex((line) => line === sectionHeading);

  const nextSectionIndex = lines.findIndex(
    (line, index) => index > sectionIndex && isSectionHeading(line)
  );
  const endIndex = nextSectionIndex === -1 ? lines.length : nextSectionIndex;
  const hasBlock = lines
    .slice(sectionIndex + 1, endIndex)
    .some((line) => isIssueHeading(line));

  if (hasBlock) {
    return report;
  }

  return `${[...lines.slice(0, sectionIndex), ...lines.slice(endIndex)].join("\n").trimEnd()}\n`;
}

function readHeadingBlocks(report: string, sectionHeading: string): string[][] {
  const lines = report.split("\n");
  const sectionIndex = lines.findIndex((line) => line === sectionHeading);

  if (sectionIndex === -1) {
    return [];
  }

  const blocks: string[][] = [];
  let index = sectionIndex + 1;

  while (index < lines.length && !isSectionHeading(lines[index])) {
    if (!isIssueHeading(lines[index])) {
      index += 1;
      continue;
    }

    const blockStart = index;
    const blockEnd = findHeadingBlockEnd(lines, blockStart);

    blocks.push(lines.slice(blockStart, blockEnd));
    index = blockEnd;
  }

  return blocks;
}

function issueFingerprintLine(issue: Issue): string {
  const encodedFingerprint = encodeIssueFingerprint(issueFingerprint(issue));

  return `${ISSUE_FINGERPRINT_PREFIX}${encodedFingerprint}${ISSUE_FINGERPRINT_SUFFIX}`;
}

function encodeIssueFingerprint(fingerprint: string): string {
  return Buffer.from(fingerprint, "utf8").toString("base64url");
}

function isSectionHeading(line: string): boolean {
  return /^### /.test(line);
}

function isIssueHeading(line: string): boolean {
  return /^#### /.test(line);
}

function findHeadingBlockEnd(lines: string[], blockStart: number): number {
  for (let index = blockStart + 1; index < lines.length; index += 1) {
    if (isHeading(lines[index])) {
      return index;
    }
  }

  return lines.length;
}

function isHeading(line: string): boolean {
  return /^#{1,4} /.test(line);
}

function hasLine(text: string, line: string): boolean {
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(`^${escaped}$`, "m").test(text);
}
