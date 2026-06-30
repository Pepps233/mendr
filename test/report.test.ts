import { describe, expect, it } from "vitest";

import {
  appendFailureNote,
  appendNoIssuesFound,
  appendResolvedIssue,
  appendRoundCapNote,
  appendUnresolvedIssue
} from "../src/report.js";

const baseIssue = {
  title: "Prevent off-by-one diff ranges",
  file: "src/range.ts",
  line: 42,
  severity: "high",
  description: "The changed range excludes the last modified line."
};

const baseEntry = {
  issue: baseIssue,
  sha: "abc1234",
  summary:
    "Added an inclusive upper-bound check for changed ranges. Covered the boundary case with a regression test."
};

describe("report markdown helpers", () => {
  it("starts with exactly one Mendr summary header while appending multiple issues", () => {
    const first = appendResolvedIssue("", baseEntry);
    const second = appendResolvedIssue(first, {
      ...baseEntry,
      issue: {
        ...baseIssue,
        title: "Handle empty PR comments",
        file: "src/github.ts",
        line: 17
      },
      sha: "def5678"
    });
    const third = appendResolvedIssue(second, {
      ...baseEntry,
      issue: {
        ...baseIssue,
        title: "Keep report context between rounds",
        file: "src/orchestrator.ts",
        line: 91
      },
      sha: "fedcba9"
    });

    expect(third.trimStart().startsWith("## Summary by Mendr\n")).toBe(true);
    expect(third.match(/^## Summary by Mendr$/gm)).toHaveLength(1);
    expect(third.match(/^### Resolved Issues$/gm)).toHaveLength(1);
    expect(third).toContain("#### Prevent off-by-one diff ranges");
    expect(third).toContain("#### Handle empty PR comments");
    expect(third).toContain("#### Keep report context between rounds");
  });

  it("renders each entry as a subsection with commit and two-sentence body", () => {
    const report = appendResolvedIssue("", baseEntry);
    const meaningfulLines = report.split("\n").filter((line: string) => line.length > 0);

    expect(meaningfulLines).toEqual([
      "## Summary by Mendr",
      "### Resolved Issues",
      "#### Prevent off-by-one diff ranges",
      expect.stringMatching(/^<!-- mendr-issue-fingerprint: [A-Za-z0-9_-]+ -->$/),
      "**Commit:** abc1234",
      "Added an inclusive upper-bound check for changed ranges. Covered the boundary case with a regression test."
    ]);
  });

  it("does not double-write the same issue and commit", () => {
    const once = appendResolvedIssue("", baseEntry);
    const twice = appendResolvedIssue(once, baseEntry);

    expect(twice).toBe(once);
    expect(twice.match(/Prevent off-by-one diff ranges/g)).toHaveLength(1);
    expect(twice.match(/abc1234/g)).toHaveLength(1);
  });

  it("does not double-write older backticked commit entries", () => {
    const existing = [
      "## Summary by Mendr",
      "",
      "### Resolved Issues",
      "",
      "#### Prevent off-by-one diff ranges",
      "**Commit:** `abc1234`",
      "Added the previous fix. Preserved historical report context.",
      ""
    ].join("\n");
    const report = appendResolvedIssue(existing, baseEntry);

    expect(report).toBe(existing);
    expect(report.match(/Prevent off-by-one diff ranges/g)).toHaveLength(1);
    expect(report.match(/abc1234/g)).toHaveLength(1);
  });

  it("renders unresolved issues without a failed commit placeholder", () => {
    const report = appendUnresolvedIssue("", {
      issue: baseIssue,
      summary:
        "The fixer exited before returning structured results. Manual follow-up is required."
    });

    expect(report).toContain("### Unresolved Issues");
    expect(report).toContain("#### Prevent off-by-one diff ranges");
    expect(report).not.toContain("**Commit:** (failed)");
    expect(report).toContain("The fixer exited before returning structured results.");
  });

  it("removes stale unresolved entries when the same issue is later resolved", () => {
    const unresolved = appendUnresolvedIssue("", {
      issue: baseIssue,
      summary:
        "The fixer exited before returning structured results. Manual follow-up is required."
    });
    const resolved = appendResolvedIssue(unresolved, baseEntry);

    expect(resolved).toContain("### Resolved Issues");
    expect(resolved).toContain("**Commit:** abc1234");
    expect(resolved).not.toContain("The fixer exited before returning structured results.");
  });

  it("keeps distinct unresolved entries that share the same title", () => {
    const sameTitleIssue = {
      ...baseIssue,
      file: "src/github.ts",
      line: 17,
      description: "The parser skips the final review comment."
    };
    const first = appendUnresolvedIssue("", {
      issue: baseIssue,
      summary:
        "The fixer exited before returning structured results. Manual follow-up is required."
    });
    const second = appendUnresolvedIssue(first, {
      issue: sameTitleIssue,
      summary:
        "The fixer left the review parser unchanged. Manual follow-up is required."
    });

    expect(second.match(/^#### Prevent off-by-one diff ranges$/gm)).toHaveLength(2);
    expect(second).toContain("The fixer exited before returning structured results.");
    expect(second).toContain("The fixer left the review parser unchanged.");
  });

  it("removes only the matching unresolved entry when same-title issues are resolved", () => {
    const sameTitleIssue = {
      ...baseIssue,
      file: "src/github.ts",
      line: 17,
      description: "The parser skips the final review comment."
    };
    const unresolved = appendUnresolvedIssue(
      appendUnresolvedIssue("", {
        issue: baseIssue,
        summary:
          "The fixer exited before returning structured results. Manual follow-up is required."
      }),
      {
        issue: sameTitleIssue,
        summary:
          "The fixer left the review parser unchanged. Manual follow-up is required."
      }
    );
    const resolved = appendResolvedIssue(unresolved, {
      ...baseEntry,
      issue: sameTitleIssue,
      sha: "def5678"
    });

    expect(resolved).toContain("### Resolved Issues");
    expect(resolved).toContain("**Commit:** def5678");
    expect(resolved).toContain("The fixer exited before returning structured results.");
    expect(resolved).not.toContain("The fixer left the review parser unchanged.");
  });

  it("upgrades legacy Summary reports before appending new issue sections", () => {
    const report = appendResolvedIssue(
      [
        "## Summary",
        "- Issue: Already fixed",
        "- Resolved by: old1111",
        "- Preserved the existing legacy entry. Kept historical report context.",
        ""
      ].join("\n"),
      baseEntry
    );

    expect(report.match(/^## Summary by Mendr$/gm)).toHaveLength(1);
    expect(report).not.toContain("## Summary\n");
    expect(report).toContain("- Issue: Already fixed");
    expect(report).toContain("### Resolved Issues");
    expect(report).toContain("#### Prevent off-by-one diff ranges");
    expect(report).toContain("**Commit:** abc1234");
  });

  it("renders open issues when the round cap is reached", () => {
    const report = appendRoundCapNote("", {
      maxRounds: 1,
      openIssues: [
        baseIssue,
        {
          ...baseIssue,
          title: "Retry rejected pushes",
          file: "src/git.ts",
          line: 28,
          severity: "medium"
        }
      ]
    });

    expect(report.match(/^## Summary by Mendr$/gm)).toHaveLength(1);
    expect(report).toContain("### Round Cap");
    expect(report).toContain("Reached after 1 round with 2 open issues:");
    expect(report).toContain("- Prevent off-by-one diff ranges");
    expect(report).toContain("- Retry rejected pushes");
  });

  it("appends no-issue and failure notes only once", () => {
    const noIssues = appendNoIssuesFound("");
    const duplicateNoIssues = appendNoIssuesFound(noIssues);
    const failure = appendFailureNote("Existing report body", "push failed");
    const duplicateFailure = appendFailureNote(failure, "push failed");

    expect(duplicateNoIssues).toBe(noIssues);
    expect(noIssues.match(/No changed-scope issues found/g)).toHaveLength(1);
    expect(failure).toMatch(/^## Summary by Mendr\nExisting report body\n\n- Failure: push failed\n$/);
    expect(duplicateFailure).toBe(failure);
  });

  it("does not duplicate an existing round-cap note", () => {
    const once = appendRoundCapNote("", {
      maxRounds: 2,
      openIssues: [baseIssue]
    });
    const twice = appendRoundCapNote(once, {
      maxRounds: 2,
      openIssues: [baseIssue]
    });

    expect(once).toContain("Reached after 2 rounds with 1 open issue:");
    expect(twice).toBe(once);
  });
});
