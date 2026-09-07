import { readFileSync } from "node:fs";
import path from "node:path";

export const CONFIG_PATH = ".dev-team/config.json";

export interface RoleConfig {
  engine: string;
  model?: string;
  effort?: string;
  cwd?: "root" | "worktree";
  sandbox?: string;
}

export interface DevTeamConfig {
  project?: { defaultBranch?: string; testCommand?: string; setupCommand?: string; mergePolicy?: string };
  roles: Record<string, RoleConfig>;
  engines?: Record<string, { bin?: string }>;
  limits?: { maxDepth?: number; stallMinutes?: number; waitDefaultSeconds?: number; duplicateWindowMinutes?: number };
  billing?: "subscription" | "api";
}

/** Reads `.dev-team/config.json` under the project root. Full validation and `dev-team init` arrive with T2. */
export function loadConfig(projectRoot: string): DevTeamConfig {
  const file = path.join(projectRoot, CONFIG_PATH);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`no config at ${file}; run "dev-team init" in the project root`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !("roles" in parsed) || typeof (parsed as { roles: unknown }).roles !== "object") {
    throw new Error(`${file}: expected an object with a "roles" map`);
  }
  return parsed as DevTeamConfig;
}
