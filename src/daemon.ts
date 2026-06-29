import { defaultMendrHome } from "./paths.js";
import { runOrchestrator } from "./orchestrator.js";

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

  await runOrchestrator({
    mendrHome: parsed.mendrHome,
    reviewId: parsed.reviewId
  });
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

if (process.argv[1] && process.argv[1].endsWith("daemon.js")) {
  runDaemon().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
