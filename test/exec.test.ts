import { describe, expect, it } from "vitest";

import { defaultExec, execOk } from "../src/exec.js";

describe("default exec", () => {
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
