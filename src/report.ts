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

export function appendResolvedIssue(report: string, entry: ResolvedIssueEntry): string {
  const normalized = ensureSummary(report);
  const issueLine = `- Issue: ${entry.issue.title}`;
  const shaLine = `- Resolved by: ${entry.sha}`;

  if (normalized.includes(`${issueLine}\n${shaLine}`)) {
    return report;
  }

  return appendLines(normalized, [issueLine, shaLine, `- ${entry.summary}`]);
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

  return appendLines(normalized, [line]);
}

export function appendFailureNote(report: string, message: string): string {
  const normalized = ensureSummary(report);
  const line = `- Failure: ${message}`;

  if (normalized.includes(line)) {
    return report;
  }

  return appendLines(normalized, [line]);
}

export function appendRoundCapNote(report: string, note: RoundCapNote): string {
  const normalized = ensureSummary(report);
  const round = note.maxRounds === 1 ? "round" : "rounds";
  const issue = note.openIssues.length === 1 ? "issue" : "issues";
  const capLine = `- Round cap reached after ${note.maxRounds} ${round} with ${note.openIssues.length} open ${issue}.`;
  const openIssueLines = note.openIssues.map((openIssue) => `- Open issue: ${openIssue.title}`);

  if (normalized.includes(capLine)) {
    return report;
  }

  return appendLines(normalized, [capLine, ...openIssueLines]);
}

function ensureSummary(report: string): string {
  const trimmed = report.trim();

  if (trimmed.length === 0) {
    return "## Summary\n";
  }

  if (/^## Summary$/m.test(trimmed)) {
    return `${trimmed}\n`;
  }

  return `## Summary\n${trimmed}\n`;
}

function appendLines(report: string, lines: string[]): string {
  const base = report.endsWith("\n") ? report : `${report}\n`;
  const separator = base.trimEnd() === "## Summary" ? "" : "\n";

  return `${base}${separator}${lines.join("\n")}\n`;
}
