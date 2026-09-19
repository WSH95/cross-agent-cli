import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adapterFor, sandboxFor, sandboxProfiles } from "./engines/registry.ts";
import type { SandboxProfile } from "./engines/registry.ts";
import { engineNames } from "./engines/types.ts";
import type { EngineName } from "./engines/types.ts";
import { builtInModesDir, findRole, loadMode } from "./modes.ts";
import type { Mode } from "./modes.ts";

export const CONFIG_PATH = ".cross-agent/config.json";

// The engine names are the contract's, so nothing the adapters need imports this file.
export type { EngineName };
// Every profile name a built-in engine accepts, derived from the adapters' own maps.
// Which engine accepts which is the adapter's, and a role's pair is checked below.
export type { SandboxProfile };

export interface RoleConfig {
  engine: EngineName;
  model?: string;
  effort?: string;
  /**
   * The system-level prompt this role's specialist is launched with. It belongs to the
   * mode (design section 8), and config carries it until the mode's own role prompts are
   * written (step 9); a role that binds none is launched with a one-line default.
   */
  prompt?: string;
  /**
   * Overrides the mode's `sandboxDefault` for this role. The only override config has:
   * where the role works is the mode's, and a `{kind: "root"}` role stays read-only
   * whatever is written here (`loadConfigWithMode`).
   */
  sandbox?: SandboxProfile;
}

export interface CrossAgentConfig {
  /** The active mode, one directory under the modes shelf (design, "Modes"). */
  mode: string;
  project: { defaultBranch: string; testCommand: string; setupCommand: string; mergePolicy: string };
  roles: Record<string, RoleConfig>;
  engines?: Record<string, { bin?: string }>;
  limits: {
    maxDepth: number; stallMinutes: number; waitDefaultSeconds: number; duplicateWindowMinutes: number;
    lockWaitSeconds: number;
    /** How long `cancel` gives a runner to settle a task before it terminates the engine group itself. */
    cancelGraceSeconds: number;
  };
  billing: "subscription" | "api";
}

export interface InitConfigResult {
  wrote: boolean;
  warning?: string;
}

export interface InitConfigOptions {
  /** The mode to bind. Every role it declares gets a binding, in the order it declares them. */
  mode?: string;
  modesDir?: string;
}

/** A config and the mode it binds, checked against each other (design section 6). */
export interface BoundConfig {
  config: CrossAgentConfig;
  mode: Mode;
}

export const DEFAULT_MODE = "dev-team";

const projectDefaults: CrossAgentConfig["project"] = {
  defaultBranch: "main", testCommand: "npm test", setupCommand: "none", mergePolicy: "auto",
};
const limitDefaults: CrossAgentConfig["limits"] = {
  maxDepth: 1, stallMinutes: 15, waitDefaultSeconds: 600, duplicateWindowMinutes: 10, lockWaitSeconds: 5,
  cancelGraceSeconds: 5,
};
const devTeamBindings: Record<string, RoleConfig> = {
  planner: { engine: "codex", model: "gpt-6-astra", effort: "high" },
  "plan-reviewer": { engine: "claude", model: "claude-opus-5" },
  implementer: { engine: "codex", model: "gpt-6-astra" },
  "code-reviewer": { engine: "claude", model: "claude-opus-5", sandbox: "read-only" },
};

/**
 * What `cross-agent init --mode <name>` binds each built-in mode's roles to. Binding is a
 * local act (design, "Modes"), so this table is a starting point an operator edits, and a
 * mode this build ships no bindings for is refused by name rather than bound by guess.
 */
const builtInBindings: Record<string, Record<string, RoleConfig>> = {
  "dev-team": devTeamBindings,
  "dev-team-engine": { lead: { engine: "claude", model: "claude-opus-5", effort: "high" }, ...devTeamBindings },
  solo: { solo: { engine: "codex", model: "gpt-6-astra" } },
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

  function reject(field: string, problem: string): never {
    throw new Error(`${file}: ${field}: ${problem}`);
  }
  function invalid(field: string, expected: string): never {
    reject(field, `expected ${expected}`);
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
  const mode = document.mode === undefined ? DEFAULT_MODE : document.mode;
  if (typeof mode !== "string" || mode === "") invalid("mode", "a non-empty string naming a mode");
  const project = { ...projectDefaults, ...object(document.project === undefined ? {} : document.project, "project") };
  for (const key of Object.keys(projectDefaults)) optionalString(project, key, "project");

  const roles = Object.fromEntries(Object.entries(object(document.roles, "roles")).map(([name, value]) => {
    const field = `roles.${name}`;
    const role = object(value, field);
    const engine = oneOf(role.engine, `${field}.engine`, engineNames);
    optionalString(role, "model", field);
    optionalString(role, "effort", field);
    optionalString(role, "prompt", field);
    // Where a role works belongs to the mode (design, "Modes"), and this file is the
    // bind-time layer alone: a workspace named here could move a read-only reviewer into
    // a writable worktree, and the mode's containment argument would no longer be the
    // mode's. The old spelling is refused by its own name, because an existing config
    // carries it.
    for (const key of ["workspace", "cwd"] as const) {
      if (role[key] !== undefined) {
        reject(`${field}.${key}`, `where a role works belongs to the mode, not to this file; declare it in the mode and remove ${key} here`);
      }
    }
    let sandbox: SandboxProfile | undefined;
    if (role.sandbox !== undefined) {
      sandbox = oneOf(role.sandbox, `${field}.sandbox`, sandboxProfiles);
      // A profile means nothing apart from the engine that declares it: `workspace` is
      // Grok's name and `workspace-write` is Claude's and Codex's, and an engine handed
      // another engine's profile would otherwise reach its adapter unchallenged.
      const profiles = adapterFor(engine).sandboxProfiles;
      if (!Object.hasOwn(profiles, sandbox)) {
        invalid(`${field}.sandbox`, `one of the ${engine} profiles: ${Object.keys(profiles).join(" | ")}`);
      }
    }
    return [name, { ...role, engine, ...(sandbox === undefined ? {} : { sandbox }) }];
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
  return { ...document, mode, project, roles, limits, billing } as CrossAgentConfig;
}

/**
 * The config and the mode it names, each valid and the two agreeing (design section 6).
 * `loadConfig` stays the loader for everything that needs bindings alone — a runner, a
 * lock, a reconciliation — because those run where no mode has been read and must not
 * fail for want of one. Everything that launches or offers a tool reads both, here.
 */
export function loadConfigWithMode(projectRoot: string, modesDir: string = builtInModesDir()): BoundConfig {
  const config = loadConfig(projectRoot);
  const mode = loadMode(modesDir, config.mode);
  const fault = bindingFault(mode, config, path.join(projectRoot, CONFIG_PATH));
  if (fault !== null) throw new Error(fault);
  return { config, mode };
}

/**
 * Every rule that needs the config and the mode together, as a reason or null. It is a
 * value rather than a throw because the server reads these files at start and `delegate`
 * reads them again at the launch boundary: a file can change under a running server, and
 * a launch is a refusal to report, not an exception to raise (design section 6).
 */
export function bindingFault(mode: Mode, config: CrossAgentConfig, file: string): string | null {
  for (const [name, role] of Object.entries(config.roles)) {
    const field = `roles.${name}`;
    const declared = findRole(mode, name);
    if (declared === undefined) {
      return `${file}: ${field}: mode ${mode.id} declares no role ${JSON.stringify(name)}; it declares ${mode.roles.map((each) => each.key).join(", ")}`;
    }
    const profile = role.sandbox ?? declared.sandboxDefault;
    let sandbox: ReturnType<typeof sandboxFor>;
    try {
      // The mode's default has to reach the engine config bound it to, exactly as an
      // override does: a portable profile name is not every engine's name for it.
      sandbox = sandboxFor(role.engine, profile);
    } catch (error) {
      return `${file}: ${field}${role.sandbox === undefined ? "" : ".sandbox"}: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (declared.workspace.kind === "root" && sandbox.mode !== "read-only") {
      return `${file}: ${field}.sandbox: role ${JSON.stringify(name)} works at the project root, which only the server may write — the ledger, the mailbox and the journal live there; ${JSON.stringify(profile)} is ${sandbox.mode} under ${role.engine}`;
    }
  }
  // P9: a Grok child inherits the operator's own configuration and has no per-run
  // isolation of any kind, so there is no Grok lead — only a Grok specialist, which
  // ancestry holds to its row ("The lead model", item 4).
  const leadRole = engineLeadRole(mode);
  if (leadRole !== undefined && Object.hasOwn(config.roles, leadRole) && config.roles[leadRole].engine === "grok") {
    return `${file}: roles.${leadRole}.engine: mode ${mode.id} places its lead in an engine, and grok cannot carry one (P9: no per-run isolation); bind ${leadRole} to claude or codex`;
  }
  return null;
}

/** The role a spawned engine runs the loop as, or undefined under host placement. */
export function engineLeadRole(mode: Mode): string | undefined {
  return mode.lead.placement === "engine" ? mode.lead.role : undefined;
}

/**
 * Whether the config now names a different mode than the one being served, as a reason or
 * null. Which tools exist is decided once, when the server loads its mode, so a config
 * that has since been pointed at another mode is answered with a restart rather than
 * served half from each.
 */
export function modeDrift(served: Mode, config: CrossAgentConfig): string | null {
  return config.mode === served.id ? null
    : `mode ${JSON.stringify(config.mode)} in ${CONFIG_PATH}, ${JSON.stringify(served.id)} served; restart the server to change modes`;
}

/** The sandbox profile a role runs under: its mode's default unless config overrides it. */
export function roleProfile(mode: Mode, config: CrossAgentConfig, key: string): SandboxProfile | undefined {
  const override = Object.hasOwn(config.roles, key) ? config.roles[key].sandbox : undefined;
  return override ?? findRole(mode, key)?.sandboxDefault;
}

/**
 * The depth cap this project runs under (design section 5, layer 1). It comes from the
 * mode: an engine-placed lead runs at depth 1 and its specialists at 2, and every other
 * mode needs 1. `limits.maxDepth` may lower that and never raise it, because raising a
 * cap cannot hand `delegate` to anyone new — ancestry is primary — but lowering one is a
 * local decision to run a shorter chain.
 */
export function effectiveMaxDepth(mode: Mode, config: CrossAgentConfig): number {
  return Math.min(placementMaxDepth(mode), config.limits.maxDepth);
}

/** The depth this mode's own placement needs, before config has its say. */
function placementMaxDepth(mode: Mode): number {
  return mode.lead.placement === "engine" ? 2 : 1;
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

/**
 * Creates the section 6 config for a mode, exclusively, without reading or replacing an
 * existing file. The mode is loaded first, so an unknown or invalid one is refused before
 * anything is written, and its roles are bound in the order it declares them.
 */
export function initConfig(projectRoot: string, options: InitConfigOptions = {}): InitConfigResult {
  const name = options.mode ?? DEFAULT_MODE;
  const mode = loadMode(options.modesDir ?? builtInModesDir(), name);
  const bindings = builtInBindings[mode.id];
  if (bindings === undefined) {
    throw new Error(`cross-agent init has no bindings for mode ${JSON.stringify(name)}; write ${CONFIG_PATH} by hand, binding each of ${mode.roles.map((role) => role.key).join(", ")} to an engine`);
  }
  const roles = Object.fromEntries(mode.roles.map((role) => {
    const binding = bindings[role.key];
    if (binding === undefined) throw new Error(`cross-agent init has no binding for role ${JSON.stringify(role.key)} of mode ${JSON.stringify(name)}`);
    return [role.key, binding];
  }));
  const document: CrossAgentConfig = {
    mode: mode.id,
    project: projectDefaults,
    roles,
    engines: { claude: {}, codex: {}, grok: {} },
    // The cap the mode needs, written rather than derived, because `effectiveMaxDepth`
    // takes the lower of the two and the documented default would hold an engine-placed
    // lead's specialists at depth 1.
    limits: { ...limitDefaults, maxDepth: placementMaxDepth(mode) },
    billing: "subscription",
  };
  const file = path.join(projectRoot, CONFIG_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  const warning = temporaryLocationWarning(projectRoot);
  let wrote = false;
  try {
    writeFileSync(file, JSON.stringify(document, null, 2) + "\n", { flag: "wx" });
    wrote = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return warning === undefined ? { wrote } : { wrote, warning };
}
