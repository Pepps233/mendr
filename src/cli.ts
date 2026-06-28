import type { AgentName } from "./agents/types.js";

export type CliParseResult =
  | {
      ok: true;
      command: "start";
      agent: AgentName;
      pr: string;
      maxRounds: number;
    }
  | {
      ok: false;
      exitCode: 1;
      error: string;
    };

const agents = new Set<AgentName>(["claude", "codex"]);

export function parseCliArgs(argv: string[]): CliParseResult {
  const args = argv.slice(2);
  const startArgs = args[0] === "start" ? args.slice(1) : args;
  const [agent, prArg, ...flags] = startArgs;

  if (!isAgent(agent)) {
    return {
      ok: false,
      exitCode: 1,
      error: "Unsupported agent. Expected claude or codex."
    };
  }

  const pr = normalizePr(prArg);

  if (!pr) {
    return {
      ok: false,
      exitCode: 1,
      error: "Expected a pull request number or GitHub pull request URL."
    };
  }

  const rounds = parseRounds(flags);

  if (!rounds.ok) {
    return rounds;
  }

  return {
    ok: true,
    command: "start",
    agent,
    pr,
    maxRounds: rounds.maxRounds
  };
}

function isAgent(value: string | undefined): value is AgentName {
  return value !== undefined && agents.has(value as AgentName);
}

function normalizePr(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (/^\d+$/.test(value)) {
    return value;
  }

  const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#].*)?$/.exec(value);

  return match?.[1];
}

function parseRounds(
  flags: string[]
): { ok: true; maxRounds: number } | { ok: false; exitCode: 1; error: string } {
  let maxRounds = 3;

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];

    if (flag !== "--rounds" && flag !== "-r") {
      return {
        ok: false,
        exitCode: 1,
        error: `Unsupported option: ${flag}`
      };
    }

    const rawRounds = flags[index + 1];
    const parsed = rawRounds ? Number(rawRounds) : NaN;

    if (!Number.isInteger(parsed) || parsed < 1) {
      return {
        ok: false,
        exitCode: 1,
        error: "Invalid rounds value. Expected a positive integer."
      };
    }

    maxRounds = parsed;
    index += 1;
  }

  return {
    ok: true,
    maxRounds
  };
}
