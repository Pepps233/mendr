import { homedir } from "node:os";
import { join } from "node:path";

const homeEnvVar = "MENDR_HOME";

export function defaultMendrHome(env: NodeJS.ProcessEnv = process.env): string {
  return env[homeEnvVar] ?? join(homedir(), ".mendr");
}

export function reviewsDir(mendrHome: string): string {
  return join(mendrHome, "reviews");
}

export function reviewDir(mendrHome: string, id: string): string {
  return join(reviewsDir(mendrHome), id);
}
