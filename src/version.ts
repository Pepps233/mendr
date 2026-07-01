import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { defaultMendrHome } from "./paths.js";

type PackageManifest = {
  name: string;
  version: string;
};

type RegistryMetadata = {
  "dist-tags"?: {
    latest?: unknown;
  };
};

type PromptState = {
  currentVersion: string;
  latestVersion: string;
  response: "accepted" | "declined";
  promptedAt: string;
};

type SemverParts = {
  main: number[];
  prerelease: string[];
};

export type MendrVersionStatus = {
  packageName: string;
  currentVersion: string;
  latestVersion?: string;
  isOutdated: boolean;
  error?: string;
};

export type FetchLatestVersion = (packageName: string) => Promise<string>;

export type InstallLatestPackage = (packageName: string) => Promise<void>;

export type AskForUpgrade = (input: {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
}) => Promise<boolean>;

export type UpgradePromptOptions = {
  packageName?: string;
  currentVersion?: string;
  mendrHome?: string;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  now?: () => Date;
  fetchLatestVersion?: FetchLatestVersion;
  askForUpgrade?: AskForUpgrade;
  installLatestPackage?: InstallLatestPackage;
};

export type VersionStatusOptions = {
  packageName?: string;
  currentVersion?: string;
  fetchLatestVersion?: FetchLatestVersion;
};

type RegistryFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type RegistryFetch = (
  url: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }
) => Promise<RegistryFetchResponse>;

type FetchPackageVersionOptions = {
  fetch?: RegistryFetch;
  timeoutMs?: number;
};

const require = createRequire(import.meta.url);
const manifest = require("../package.json") as PackageManifest;
const promptStateFile = "version-check.json";

export const mendrPackageName = manifest.name;
export const mendrVersion = manifest.version;

export async function getMendrVersionStatus(
  options: VersionStatusOptions = {}
): Promise<MendrVersionStatus> {
  const packageName = options.packageName ?? mendrPackageName;
  const currentVersion = options.currentVersion ?? mendrVersion;

  try {
    const latestVersion = await (options.fetchLatestVersion ?? fetchLatestPackageVersion)(
      packageName
    );

    return {
      packageName,
      currentVersion,
      latestVersion,
      isOutdated: compareNpmVersions(currentVersion, latestVersion) < 0
    };
  } catch (error) {
    return {
      packageName,
      currentVersion,
      isOutdated: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function formatMendrVersionStatus(status: MendrVersionStatus): string {
  const lines = [`Installed: ${status.packageName}@${status.currentVersion}`];

  if (status.latestVersion) {
    lines.push(`Latest: ${status.latestVersion}`);
    lines.push(status.isOutdated ? "Status: update available" : "Status: up to date");
    return lines.join("\n");
  }

  lines.push("Latest: unavailable");

  if (status.error) {
    lines.push(`Status: unable to check npm registry (${status.error})`);
  }

  return lines.join("\n");
}

export async function maybePromptForMendrUpgrade(
  options: UpgradePromptOptions = {}
): Promise<void> {
  const env = options.env ?? process.env;

  if (isUpdateCheckDisabled(env)) {
    return;
  }

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;

  if (!isInteractive(input, output)) {
    return;
  }

  const packageName = options.packageName ?? mendrPackageName;
  const currentVersion = options.currentVersion ?? mendrVersion;
  const status = await getMendrVersionStatus({
    packageName,
    currentVersion,
    fetchLatestVersion: options.fetchLatestVersion
  });

  if (!status.latestVersion || !status.isOutdated) {
    return;
  }

  const mendrHome = options.mendrHome ?? defaultMendrHome(env);
  const existingState = await readPromptState(mendrHome);

  if (
    existingState?.currentVersion === currentVersion &&
    existingState.latestVersion === status.latestVersion
  ) {
    return;
  }

  const askForUpgrade =
    options.askForUpgrade ??
    ((context) =>
      askYesNoUpgrade({
        ...context,
        input,
        output
      }));
  const shouldUpgrade = await askForUpgrade({
    packageName,
    currentVersion,
    latestVersion: status.latestVersion
  });

  if (!shouldUpgrade) {
    await writePromptState(mendrHome, {
      currentVersion,
      latestVersion: status.latestVersion,
      response: "declined",
      promptedAt: (options.now ?? (() => new Date()))().toISOString()
    });
    return;
  }

  try {
    await (options.installLatestPackage ?? installLatestPackage)(packageName);
    await writePromptState(mendrHome, {
      currentVersion,
      latestVersion: status.latestVersion,
      response: "accepted",
      promptedAt: (options.now ?? (() => new Date()))().toISOString()
    });
  } catch (error) {
    output.write(
      `Upgrade failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    output.write(`Continuing with ${packageName}@${currentVersion}.\n`);
  }
}

export async function fetchLatestPackageVersion(
  packageName: string,
  options: FetchPackageVersionOptions = {}
): Promise<string> {
  const fetchFn = options.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2000);

  try {
    const response = await fetchFn(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      {
        headers: {
          accept: "application/vnd.npm.install-v1+json, application/json"
        },
        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status}`);
    }

    const metadata = (await response.json()) as RegistryMetadata;
    const latest = metadata["dist-tags"]?.latest;

    if (typeof latest !== "string" || latest.length === 0) {
      throw new Error("npm registry response did not include dist-tags.latest");
    }

    return latest;
  } finally {
    clearTimeout(timeout);
  }
}

export async function installLatestPackage(packageName: string): Promise<void> {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmCommand, ["install", "-g", `${packageName}@latest`], {
      stdio: "inherit"
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `npm install -g ${packageName}@latest stopped with ${signal}`
            : `npm install -g ${packageName}@latest exited with code ${code ?? 1}`
        )
      );
    });
  });
}

export function compareNpmVersions(left: string, right: string): number {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);

  if (!leftParts || !rightParts) {
    return left.localeCompare(right);
  }

  const length = Math.max(leftParts.main.length, rightParts.main.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts.main[index] ?? 0) - (rightParts.main[index] ?? 0);

    if (diff !== 0) {
      return diff;
    }
  }

  return comparePrerelease(leftParts.prerelease, rightParts.prerelease);
}

async function askYesNoUpgrade(input: {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}): Promise<boolean> {
  const prompt = `${input.packageName} ${input.latestVersion} is available (installed ${input.currentVersion}). Upgrade now? [y/n] `;
  const readline = createInterface({
    input: input.input,
    output: input.output,
    terminal: true
  });

  try {
    for (;;) {
      const answer = (await readline.question(prompt)).trim().toLowerCase();

      if (answer === "y" || answer === "yes") {
        return true;
      }

      if (answer === "n" || answer === "no") {
        return false;
      }

      input.output.write("Please answer yes or no.\n");
    }
  } finally {
    readline.close();
  }
}

async function readPromptState(mendrHome: string): Promise<PromptState | undefined> {
  try {
    const raw = await readFile(promptStatePath(mendrHome), "utf8");
    const state = JSON.parse(raw) as Partial<PromptState>;

    if (
      typeof state.currentVersion !== "string" ||
      typeof state.latestVersion !== "string" ||
      (state.response !== "accepted" && state.response !== "declined") ||
      typeof state.promptedAt !== "string"
    ) {
      return undefined;
    }

    return state as PromptState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    return undefined;
  }
}

async function writePromptState(mendrHome: string, state: PromptState): Promise<void> {
  await mkdir(mendrHome, { recursive: true });
  await writeFile(promptStatePath(mendrHome), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function promptStatePath(mendrHome: string): string {
  return join(mendrHome, promptStateFile);
}

function isUpdateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.CI === "true" || env.MENDR_SKIP_UPDATE_CHECK === "1";
}

function isInteractive(input: NodeJS.ReadStream, output: NodeJS.WriteStream): boolean {
  return input.isTTY === true && output.isTTY === true;
}

function parseSemver(version: string): SemverParts | undefined {
  const withoutBuildMetadata = version.replace(/^v/, "").split("+", 1)[0];
  const [mainVersion, prereleaseVersion = ""] = withoutBuildMetadata.split("-", 2);
  const main = mainVersion.split(".").map((part) => {
    if (!/^\d+$/.test(part)) {
      return Number.NaN;
    }

    return Number(part);
  });

  if (main.length === 0 || main.some((part) => !Number.isSafeInteger(part))) {
    return undefined;
  }

  return {
    main,
    prerelease: prereleaseVersion.length > 0 ? prereleaseVersion.split(".") : []
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }

  if (left.length === 0) {
    return 1;
  }

  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];

    if (leftPart === undefined) {
      return -1;
    }

    if (rightPart === undefined) {
      return 1;
    }

    const comparison = comparePrereleasePart(leftPart, rightPart);

    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

function comparePrereleasePart(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }

  if (leftNumeric) {
    return -1;
  }

  if (rightNumeric) {
    return 1;
  }

  return left.localeCompare(right);
}
