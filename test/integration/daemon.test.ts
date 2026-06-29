import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runDaemon } from "../../src/daemon.js";

const tmpRoots: string[] = [];

async function makeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mendr-daemon-"));

  tmpRoots.push(root);

  return root;
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("daemon failure recording", () => {
  it("writes failed state when startup cannot load review metadata", async () => {
    const home = await makeHome();
    const id = "missing-meta-65fa";

    await expect(
      runDaemon(["node", "daemon.js", "--home", home, "--id", id])
    ).rejects.toThrow(/meta\.json|no such file/i);

    const state = JSON.parse(
      await readFile(join(home, "reviews", id, "state.json"), "utf8")
    ) as { phase: string; currentStatus: string; error: string };

    expect(state.phase).toBe("failed");
    expect(state.currentStatus).toBe("Orchestrator failed");
    expect(state.error).toMatch(/meta\.json|no such file/i);
  });
});
