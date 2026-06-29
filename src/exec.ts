import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { execa } from "execa";

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
};

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  stdoutFile?: string;
  stderrFile?: string;
};

export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions
) => Promise<ExecResult>;

export class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly args: string[],
    readonly result: ExecResult
  ) {
    super(formatCommandFailure(command, args, result));
    this.name = "CommandFailedError";
  }
}

export const defaultExec: ExecFn = async (command, args, options = {}) => {
  const logStreams = await createLogStreams(options);
  const subprocess = execa(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    timeout: options.timeoutMs,
    reject: false
  });

  teeStream(subprocess.stdout, logStreams.stdout);
  teeStream(subprocess.stderr, logStreams.stderr);

  try {
    const result = await subprocess;

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? (result.timedOut ? 124 : 0),
      timedOut: result.timedOut
    };
  } finally {
    await closeLogStreams(logStreams);
  }
};

export async function execOk(
  exec: ExecFn,
  command: string,
  args: string[],
  options?: ExecOptions
): Promise<ExecResult> {
  const result = await exec(command, args, options);

  if (result.exitCode !== 0) {
    throw new CommandFailedError(command, args, result);
  }

  return result;
}

function formatCommandFailure(command: string, args: string[], result: ExecResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  const formattedCommand = [command, ...args.map(formatCommandArg)].join(" ");

  if (result.timedOut) {
    return `${formattedCommand} timed out: ${detail}`;
  }

  return `${formattedCommand} failed: ${detail}`;
}

function formatCommandArg(arg: string): string {
  const normalized = arg.replace(/\s+/g, " ");

  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

type LogStreams = {
  stdout?: WriteStream;
  stderr?: WriteStream;
};

async function createLogStreams(options: ExecOptions): Promise<LogStreams> {
  await Promise.all(
    [options.stdoutFile, options.stderrFile]
      .filter((path): path is string => path !== undefined)
      .map((path) => mkdir(dirname(path), { recursive: true }))
  );

  return {
    stdout: options.stdoutFile
      ? createWriteStream(options.stdoutFile, { flags: "w" })
      : undefined,
    stderr: options.stderrFile
      ? createWriteStream(options.stderrFile, { flags: "w" })
      : undefined
  };
}

function teeStream(
  source: NodeJS.ReadableStream | undefined,
  destination: WriteStream | undefined
): void {
  if (!source || !destination) {
    return;
  }

  source.on("data", (chunk: string | Buffer) => {
    destination.write(chunk);
  });
}

async function closeLogStreams(streams: LogStreams): Promise<void> {
  await Promise.all([closeLogStream(streams.stdout), closeLogStream(streams.stderr)]);
}

async function closeLogStream(stream: WriteStream | undefined): Promise<void> {
  if (!stream) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => {
      stream.off("error", reject);
      resolve();
    });
  });
}
