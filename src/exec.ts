import { execa } from "execa";

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
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
    reject: false
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 0
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

  return `${command} ${args.join(" ")} failed: ${detail}`;
}
