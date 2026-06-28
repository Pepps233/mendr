import { describe, expect, it } from "vitest";

import { appendResolvedIssue, appendRoundCapNote } from "../src/report.js";

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
  it("starts with exactly one Summary header while appending multiple issues", () => {
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

    expect(third.trimStart().startsWith("## Summary\n")).toBe(true);
    expect(third.match(/^## Summary$/gm)).toHaveLength(1);
    expect(third).toContain("- Issue: Prevent off-by-one diff ranges");
    expect(third).toContain("- Issue: Handle empty PR comments");
    expect(third).toContain("- Issue: Keep report context between rounds");
  });

  it("renders each entry as Issue, Resolved by, then the two-sentence body", () => {
    const report = appendResolvedIssue("", baseEntry);
    const meaningfulLines = report.split("\n").filter((line: string) => line.length > 0);

    expect(meaningfulLines).toEqual([
      "## Summary",
      "- Issue: Prevent off-by-one diff ranges",
      "- Resolved by: abc1234",
      "- Added an inclusive upper-bound check for changed ranges. Covered the boundary case with a regression test."
    ]);
  });

  it("does not double-write the same issue and commit", () => {
    const once = appendResolvedIssue("", baseEntry);
    const twice = appendResolvedIssue(once, baseEntry);

    expect(twice).toBe(once);
    expect(twice.match(/Prevent off-by-one diff ranges/g)).toHaveLength(1);
    expect(twice.match(/abc1234/g)).toHaveLength(1);
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

    expect(report.match(/^## Summary$/gm)).toHaveLength(1);
    expect(report).toContain("- Round cap reached after 1 round with 2 open issues.");
    expect(report).toContain("- Open issue: Prevent off-by-one diff ranges");
    expect(report).toContain("- Open issue: Retry rejected pushes");
  });
});
