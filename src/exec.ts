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
  const result = await execa(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    timeout: options.timeoutMs,
    reject: false
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? (result.timedOut ? 124 : 0),
    timedOut: result.timedOut
  };
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
