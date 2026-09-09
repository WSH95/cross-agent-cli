import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adapterFor, sandboxProfiles } from "./engines/registry.ts";
import type { SandboxProfile } from "./engines/registry.ts";

export const CONFIG_PATH = ".cross-agent/config.json";

const engineNames = ["claude", "codex", "grok"] as const;

export type EngineName = typeof engineNames[number];
// Every profile name a built-in engine accepts, derived from the adapters' own maps.
// Which engine accepts which is the adapter's, and a role's pair is checked below.
export type { SandboxProfile };

export interface RoleConfig {
  engine: EngineName;
  model?: string;
  effort?: string;
  cwd: "root" | "worktree";
  sandbox: SandboxProfile;
}

export interface CrossAgentConfig {
  project: { defaultBranch: string; testCommand: string; setupCommand: string; mergePolicy: string };
  roles: Record<string, RoleConfig>;
  engines?: Record<string, { bin?: string }>;
  limits: { maxDepth: number; stallMinutes: number; waitDefaultSeconds: number; duplicateWindowMinutes: number; lockWaitSeconds: number };
  billing: "subscription" | "api";
}

export interface InitConfigResult {
  wrote: boolean;
  warning?: string;
}

const projectDefaults: CrossAgentConfig["project"] = {
  defaultBranch: "main", testCommand: "npm test", setupCommand: "none", mergePolicy: "auto",
};
const limitDefaults: CrossAgentConfig["limits"] = {
  maxDepth: 1, stallMinutes: 15, waitDefaultSeconds: 600, duplicateWindowMinutes: 10, lockWaitSeconds: 5,
};
const defaultConfig: CrossAgentConfig = {
  project: projectDefaults,
  roles: {
    planner: { engine: "codex", model: "gpt-6-astra", effort: "high", cwd: "root", sandbox: "read-only" },
    "plan-reviewer": { engine: "claude", model: "claude-opus-5", cwd: "root", sandbox: "read-only" },
    implementer: { engine: "codex", model: "gpt-6-astra", cwd: "worktree", sandbox: "workspace-write" },
    "code-reviewer": { engine: "claude", model: "claude-opus-5", cwd: "worktree", sandbox: "read-only" },
  },
  engines: { claude: {}, codex: {}, grok: {} },
  limits: limitDefaults,
  billing: "subscription",
};

/** Validates the documented fields and fills only absent defaults. */
export function loadConfig(projectRoot: string): CrossAgentConfig {
  const file = path.join(projectRoot, CONFIG_PATH);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no config at ${file}; run "cross-agent init" in the project root`);
    }
    throw new Error(`${file}: cannot read config: ${error instanceof Error ? error.message : String(error)}`);
  }

  function invalid(field: string, expected: string): never {
    throw new Error(`${file}: ${field}: expected ${expected}`);
  }
  function object(value: unknown, field: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(field, "an object");
    return value as Record<string, unknown>;
  }
  function oneOf<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
    if (typeof value !== "string" || !choices.includes(value as T)) invalid(field, choices.join(" | "));
    return value as T;
  }
  function optionalString(record: Record<string, unknown>, key: string, field: string): void {
    if (record[key] !== undefined && typeof record[key] !== "string") invalid(`${field}.${key}`, "a string");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid("$", "valid JSON");
  }
  const document = object(parsed, "$");
  const project = { ...projectDefaults, ...object(document.project === undefined ? {} : document.project, "project") };
  for (const key of Object.keys(projectDefaults)) optionalString(project, key, "project");

  const roles = Object.fromEntries(Object.entries(object(document.roles, "roles")).map(([name, value]) => {
    const field = `roles.${name}`;
    const role = object(value, field);
    const engine = oneOf(role.engine, `${field}.engine`, engineNames);
    optionalString(role, "model", field);
    optionalString(role, "effort", field);
    const cwd = oneOf(role.cwd === undefined ? "root" : role.cwd, `${field}.cwd`, ["root", "worktree"] as const);
    const sandbox = oneOf(role.sandbox === undefined ? "read-only" : role.sandbox, `${field}.sandbox`, sandboxProfiles);
    // A profile means nothing apart from the engine that declares it: `workspace` is
    // Grok's name and `workspace-write` is Claude's and Codex's, and an engine handed
    // another engine's profile would otherwise reach its adapter unchallenged.
    const profiles = adapterFor(engine).sandboxProfiles;
    if (!Object.hasOwn(profiles, sandbox)) {
      invalid(`${field}.sandbox`, `one of the ${engine} profiles: ${Object.keys(profiles).join(" | ")}`);
    }
    return [name, { ...role, engine, cwd, sandbox }];
  }));

  if (document.engines !== undefined) {
    for (const [name, value] of Object.entries(object(document.engines, "engines"))) {
      const field = `engines.${name}`;
      optionalString(object(value, field), "bin", field);
    }
  }

  const limits = { ...limitDefaults, ...object(document.limits === undefined ? {} : document.limits, "limits") };
  for (const key of Object.keys(limitDefaults)) {
    const value = limits[key as keyof typeof limitDefaults];
    if (typeof value !== "number" || !Number.isFinite(value)) invalid(`limits.${key}`, "a finite number");
  }
  // Every lock waits this long and then refuses (design section 2). `flock -w -1` sets no
  // timer at all and exits 71 before it ever looks at the file, which this helper would
  // read as "held by another process": a negative wait would refuse every lock in the
  // project and blame a holder that does not exist.
  if (limits.lockWaitSeconds < 0) invalid("limits.lockWaitSeconds", "a finite number of seconds, not negative");
  const billing = oneOf(document.billing === undefined ? "subscription" : document.billing, "billing", ["subscription", "api"] as const);
  return { ...document, project, roles, limits, billing } as CrossAgentConfig;
}

/**
 * How long every lock in this project waits before it refuses (design section 2). Locks
 * are taken on paths that run before anyone has a readable config — a runner in a project
 * that was never initialized, a reconciliation of a half-written one — so a config that
 * cannot be read answers with the documented default rather than throwing at a caller
 * whose only question was how long to wait.
 */
export function lockWaitSeconds(projectRoot: string): number {
  try {
    return loadConfig(projectRoot).limits.lockWaitSeconds;
  } catch {
    return limitDefaults.lockWaitSeconds;
  }
}

function temporaryLocationWarning(projectRoot: string): string | undefined {
  const root = realpathSync(projectRoot);
  for (const temporary of ["/tmp", process.env.TMPDIR]) {
    if (!temporary) continue;
    let canonical: string;
    try {
      canonical = realpathSync(temporary);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    const relative = path.relative(canonical, root);
    if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      return `Codex and Grok sandboxes treat ${canonical} as writable; the project at ${root} is not isolated.`;
    }
  }
  return undefined;
}

/** Creates the section 6 config exclusively, without reading or replacing an existing file. */
export function initConfig(projectRoot: string): InitConfigResult {
  const file = path.join(projectRoot, CONFIG_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  const warning = temporaryLocationWarning(projectRoot);
  let wrote = false;
  try {
    writeFileSync(file, JSON.stringify(defaultConfig, null, 2) + "\n", { flag: "wx" });
    wrote = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return warning === undefined ? { wrote } : { wrote, warning };
}
