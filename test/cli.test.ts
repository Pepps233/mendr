import { describe, expect, it } from "vitest";

import { parseCliArgs } from "../src/cli.js";

describe("CLI argument parsing", () => {
  it("defaults the start command to three rounds", () => {
    expect(parseCliArgs(["node", "mendr", "claude", "42"])).toEqual({
      ok: true,
      command: "start",
      agent: "claude",
      pr: "42",
      maxRounds: 3
    });
  });

  it("honors explicit long and short rounds values", () => {
    expect(parseCliArgs(["node", "mendr", "codex", "42", "--rounds", "5"])).toMatchObject({
      ok: true,
      command: "start",
      agent: "codex",
      pr: "42",
      maxRounds: 5
    });
    expect(parseCliArgs(["node", "mendr", "codex", "42", "-r", "2"])).toMatchObject({
      ok: true,
      command: "start",
      agent: "codex",
      pr: "42",
      maxRounds: 2
    });
  });

  it("honors model and effort overrides", () => {
    expect(
      parseCliArgs([
        "node",
        "mendr",
        "codex",
        "42",
        "--model",
        "gpt-5.4",
        "--effort",
        "high"
      ])
    ).toMatchObject({
      ok: true,
      command: "start",
      agent: "codex",
      pr: "42",
      maxRounds: 3,
      model: "gpt-5.4",
      effort: "high"
    });
    expect(
      parseCliArgs(["node", "mendr", "claude", "42", "-m", "sonnet", "-e", "max"])
    ).toMatchObject({
      ok: true,
      command: "start",
      agent: "claude",
      pr: "42",
      model: "sonnet",
      effort: "max"
    });
  });

  it("rejects unsupported effort values for the selected agent", () => {
    expect(parseCliArgs(["node", "mendr", "codex", "42", "--effort", "max"])).toEqual({
      ok: false,
      exitCode: 1,
      error: expect.stringContaining("low, medium, high, xhigh")
    });
    expect(parseCliArgs(["node", "mendr", "claude", "42", "--effort", "minimal"])).toEqual({
      ok: false,
      exitCode: 1,
      error: expect.stringContaining("low, medium, high, xhigh, max")
    });
  });

  it("rejects missing model and effort values", () => {
    expect(parseCliArgs(["node", "mendr", "codex", "42", "--model", "--effort", "high"])).toEqual({
      ok: false,
      exitCode: 1,
      error: "Missing value for --model."
    });
    expect(parseCliArgs(["node", "mendr", "codex", "42", "--effort"])).toEqual({
      ok: false,
      exitCode: 1,
      error: "Missing value for --effort."
    });
  });

  it("accepts GitHub pull request URLs and normalizes them to PR numbers", () => {
    expect(
      parseCliArgs(["node", "mendr", "claude", "https://github.com/acme/widgets/pull/123"])
    ).toMatchObject({
      ok: true,
      command: "start",
      agent: "claude",
      pr: "123",
      maxRounds: 3
    });
  });

  it("rejects unsupported agent names with a non-zero parse result", () => {
    expect(parseCliArgs(["node", "mendr", "gemini", "42"])).toEqual({
      ok: false,
      exitCode: 1,
      error: expect.stringContaining("agent")
    });
  });

  it("rejects non-numeric rounds with a non-zero parse result", () => {
    expect(parseCliArgs(["node", "mendr", "claude", "42", "--rounds", "many"])).toEqual({
      ok: false,
      exitCode: 1,
      error: expect.stringContaining("rounds")
    });
  });
});
