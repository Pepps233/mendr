import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compareNpmVersions,
  formatMendrVersionStatus,
  getMendrVersionStatus,
  maybePromptForMendrUpgrade
} from "../src/version.js";

const tmpRoots: string[] = [];

async function makeHome() {
  const root = await mkdtemp(join(tmpdir(), "mendr-version-"));
  tmpRoots.push(root);
  return root;
}

function makeTtyInput(): NodeJS.ReadStream & {
  write: (chunk: string) => boolean;
  setRawMode: (enabled: boolean) => NodeJS.ReadStream;
} {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & {
    write: (chunk: string) => boolean;
    isTTY: boolean;
    setRawMode: (enabled: boolean) => NodeJS.ReadStream;
    ref: () => NodeJS.ReadStream;
    unref: () => NodeJS.ReadStream;
  };

  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;

  return input;
}

function makeTtyOutput(): NodeJS.WriteStream {
  const output = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };

  output.columns = 80;
  output.rows = 24;
  output.isTTY = true;

  return output;
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("mendr version status", () => {
  it("formats installed and latest version status", async () => {
    const status = await getMendrVersionStatus({
      packageName: "mendr-test",
      currentVersion: "1.0.0",
      fetchLatestVersion: async () => "1.2.0"
    });

    expect(status).toMatchObject({
      packageName: "mendr-test",
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
      isOutdated: true
    });
    expect(formatMendrVersionStatus(status)).toBe(
      ["Installed: mendr-test@1.0.0", "Latest: 1.2.0", "Status: update available"].join("\n")
    );
  });

  it("compares stable and prerelease npm versions", () => {
    expect(compareNpmVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareNpmVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareNpmVersions("1.0.0", "1.0.0-beta.10")).toBeGreaterThan(0);
    expect(compareNpmVersions("v1.0.0+build.1", "1.0.0")).toBe(0);
  });
});

describe("mendr upgrade prompt", () => {
  it("prompts once for the same installed and latest version pair", async () => {
    const home = await makeHome();
    const askForUpgrade = vi.fn(async () => false);
    const installLatestPackage = vi.fn(async () => undefined);

    for (let index = 0; index < 2; index += 1) {
      await maybePromptForMendrUpgrade({
        packageName: "mendr-test",
        currentVersion: "1.0.0",
        mendrHome: home,
        env: {},
        input: makeTtyInput(),
        output: makeTtyOutput(),
        fetchLatestVersion: async () => "1.1.0",
        askForUpgrade,
        installLatestPackage,
        now: () => new Date("2026-06-30T12:00:00.000Z")
      });
    }

    expect(askForUpgrade).toHaveBeenCalledTimes(1);
    expect(installLatestPackage).not.toHaveBeenCalled();
  });

  it("runs the npm upgrade when the user accepts the prompt", async () => {
    const home = await makeHome();
    const input = makeTtyInput();
    const output = makeTtyOutput();
    const installLatestPackage = vi.fn(async () => undefined);
    const prompt = maybePromptForMendrUpgrade({
      packageName: "mendr-test",
      currentVersion: "1.0.0",
      mendrHome: home,
      env: {},
      input,
      output,
      fetchLatestVersion: async () => "1.1.0",
      installLatestPackage
    });

    setImmediate(() => {
      input.write("yes\n");
    });

    await prompt;

    expect(installLatestPackage).toHaveBeenCalledWith("mendr-test");
  });

  it("skips the registry check when the command is not interactive", async () => {
    const home = await makeHome();
    const input = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean };
    const output = makeTtyOutput();
    const fetchLatestVersion = vi.fn(async () => "1.1.0");

    input.isTTY = false;

    await maybePromptForMendrUpgrade({
      packageName: "mendr-test",
      currentVersion: "1.0.0",
      mendrHome: home,
      env: {},
      input,
      output,
      fetchLatestVersion
    });

    expect(fetchLatestVersion).not.toHaveBeenCalled();
  });
});
