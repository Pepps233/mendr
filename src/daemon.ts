import { defaultMendrHome } from "./paths.js";
import { runOrchestrator } from "./orchestrator.js";
import { appendEvent, readState, writeState, type ReviewState } from "./state.js";

type DaemonArgs =
  | {
      ok: true;
      mendrHome: string;
      reviewId: string;
    }
  | {
      ok: false;
      error: string;
    };

export async function runDaemon(argv: string[] = process.argv): Promise<void> {
  const parsed = parseDaemonArgs(argv);

  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  try {
    await runOrchestrator({
      mendrHome: parsed.mendrHome,
      reviewId: parsed.reviewId
    });
  } catch (error) {
    await recordDaemonFailure(parsed.mendrHome, parsed.reviewId, error);
    throw error;
  }
}

function parseDaemonArgs(argv: string[]): DaemonArgs {
  const args = argv.slice(2);
  let mendrHome = defaultMendrHome();
  let reviewId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];

    if (arg === "--home" && value) {
      mendrHome = value;
      index += 1;
      continue;
    }

    if (arg === "--id" && value) {
      reviewId = value;
      index += 1;
      continue;
    }

    return {
      ok: false,
      error: `Unsupported daemon argument: ${arg}`
    };
  }

  if (!reviewId) {
    return {
      ok: false,
      error: "Expected --id for daemon review session."
    };
  }

  return {
    ok: true,
    mendrHome,
    reviewId
  };
}

async function recordDaemonFailure(
  mendrHome: string,
  reviewId: string,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  let state: ReviewState = {
    phase: "failed",
    currentStatus: "Daemon failed",
    issuesFound: 0,
    issuesFixed: 0,
    done: false,
    capReached: false,
    error: message
  };

  try {
    const existing = await readState(mendrHome, reviewId);

    if (existing.phase === "failed" && existing.error) {
      return;
    }

    state = {
      ...existing,
      phase: "failed",
      currentStatus: "Daemon failed",
      done: false,
      error: message
    };
  } catch {
    // If state cannot be read, write a minimal terminal failure record below.
  }

  await writeState(mendrHome, reviewId, state);
  await appendEvent(mendrHome, reviewId, {
    status: "Daemon failed",
    detail: message
  });
}

if (process.argv[1] && process.argv[1].endsWith("daemon.js")) {
  runDaemon().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
