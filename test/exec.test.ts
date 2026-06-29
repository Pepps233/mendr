import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { defaultExec, execOk } from "../src/exec.js";

const tmpRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mendr-exec-"));
  tmpRoots.push(root);

  return root;
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("default exec", () => {
  it("closes child stdin when no input is provided", async () => {
    const result = await defaultExec(
      process.execPath,
      [
        "-e",
        [
          "process.stdin.resume();",
          "process.stdin.on('end', () => process.stdout.write('stdin closed'));"
        ].join(" ")
      ],
      { timeoutMs: 1000 }
    );

    expect(result).toMatchObject({
      stdout: "stdin closed",
      stderr: "",
      exitCode: 0
    });
  });

  it("streams child stdout and stderr to files before the process exits", async () => {
    const outputDir = await makeTempDir();
    const stdoutFile = join(outputDir, "agent.stdout.log");
    const stderrFile = join(outputDir, "agent.stderr.log");
    const execPromise = defaultExec(
      process.execPath,
      [
        "-e",
        [
          "process.stdout.write('early stdout\\n');",
          "process.stderr.write('early stderr\\n');",
          "setTimeout(() => process.stdout.write('late stdout\\n'), 250);"
        ].join(" ")
      ],
      {
        stdoutFile,
        stderrFile
      }
    );

    await delay(100);

    await expect(readFile(stdoutFile, "utf8")).resolves.toContain("early stdout");
    await expect(readFile(stderrFile, "utf8")).resolves.toContain("early stderr");

    const result = await execPromise;

    expect(result.stdout).toContain("late stdout");
    await expect(readFile(stdoutFile, "utf8")).resolves.toContain("late stdout");
  });

  it("marks timed out child processes and preserves captured stdout", async () => {
    const result = await defaultExec(
      process.execPath,
      ["-e", "console.log('started'); setTimeout(() => {}, 1000);"],
      { timeoutMs: 50 }
    );

    expect(result).toMatchObject({
      stdout: "started",
      stderr: "",
      exitCode: 124,
      timedOut: true
    });
  });

  it("surfaces timeout failures through execOk", async () => {
    await expect(
      execOk(
        defaultExec,
        process.execPath,
        ["-e", "console.log('started'); setTimeout(() => {}, 1000);"],
        { timeoutMs: 50 }
      )
    ).rejects.toThrow(/timed out/i);
  });
});
