import { createHash } from "node:crypto";
import fs, { appendFileSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adapterFor, sandboxFor, sandboxProfiles } from "./engines/registry.ts";
import type { SandboxProfile } from "./engines/registry.ts";
import { engineNames } from "./engines/types.ts";
import type { EngineName } from "./engines/types.ts";
import { isHostConfigPath } from "./gitmutate.ts";
import { builtInModesDir, findRole, gitPolicy, loadMode } from "./modes.ts";
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
   * An override for the system-level prompt this role's specialist is launched with. The
   * prompt itself belongs to the mode (design section 8): a role that binds none here is
   * launched with the mode's own text for it (`src/modes.ts#rolePrompt`), and this key is
   * how one project adjusts one role without editing a portable mode.
   */
  prompt?: string;
  /**
   * Overrides the mode's `sandboxDefault` for this role. The only override config has:
   * where the role works is the mode's, and a `{kind: "root"}` role stays read-only
   * whatever is written here (`loadConfigWithMode`).
   */
  sandbox?: SandboxProfile;
}

/**
 * One binding, or one per seat for a role its mode marks `seats: "many"` (design section
 * 6). A seat is the binding's 1-based position in the list; an object is one reviewer, as
 * every config written before seats existed binds it.
 */
export type RoleBinding = RoleConfig | RoleConfig[];

/**
 * The tracker's verbs, fixed in code (design section 6, "The `records` block"): whether each
 * writes, the placeholders its template names, every one of them exactly once, and whether a
 * tracker must declare it.
 */
export const trackerVerbs = {
  ready: { writes: false, placeholders: [], required: true },
  show: { writes: false, placeholders: ["id"], required: true },
  create: { writes: true, placeholders: ["title", "text", "parent"], required: true },
  file: { writes: true, placeholders: ["title", "text"], required: true },
  claim: { writes: true, placeholders: ["id"], required: true },
  close: { writes: true, placeholders: ["id", "text"], required: true },
  epic: { writes: true, placeholders: ["title", "text"], required: false },
  depend: { writes: true, placeholders: ["id", "on"], required: false },
} as const;
export type TrackerVerb = keyof typeof trackerVerbs;
/** Placeholders that carry an id: a whole argument or the part after an `=`; every other fills only after an `=`. */
export const idPlaceholders: readonly string[] = ["id", "parent", "on"];

/**
 * The project's records: the files `record` reads and commits, and the tracker's commands
 * with the files its writes change. A config has both halves or no block at all.
 */
export interface RecordsConfig {
  files: string[];
  tracker: { [verb in TrackerVerb]?: string[] } & { files: string[] };
}

export interface CrossAgentConfig {
  /** The active mode, one directory under the modes shelf (design, "Modes"). */
  mode: string;
  project: { defaultBranch: string; testCommand: string; setupCommand: string; mergePolicy: string };
  roles: Record<string, RoleBinding>;
  engines?: Record<string, { bin?: string }>;
  limits: {
    maxDepth: number; stallMinutes: number; waitDefaultSeconds: number; duplicateWindowMinutes: number;
    lockWaitSeconds: number;
    /** How long `cancel` gives a runner to settle a task before it terminates the engine group itself. */
    cancelGraceSeconds: number;
    /** Consecutive plan-review rounds ending `major issues` before the team loop asks the user (D2). */
    planReviewRounds: number;
  };
  /** What the team loop does with a Critical or Important finding still standing after the resolver's round (D3). */
  review: { afterResolver: AfterResolver };
  billing: "subscription" | "api";
  /** The project's record files and tracker, where it keeps them through `record` (design section 6). */
  records?: RecordsConfig;
}

export interface InitConfigResult {
  wrote: boolean;
  /** The `.gitignore` entries this call added; empty when the file already had them. */
  ignored: string[];
  warning?: string;
  /** Set when `expect` named the stored bytes and the document replaced them. */
  replaced?: boolean;
  /** Set when `expect` did not name the stored bytes, or a check of the replacement failed: nothing was written. */
  stale?: boolean;
  /** Where the replaced file was kept: `config.json.prev`. */
  previous?: string;
}

export interface InitConfigOptions {
  /** The mode to bind. Every role it declares gets a binding, in the order it declares them. */
  mode?: string;
  modesDir?: string;
  /** The project's default branch: `main`, unless the root is a worktree, whose own branch it is. */
  defaultBranch?: string;
  /**
   * A config to write instead of the mode's bindings — another project's, for a worktree
   * initialized as a project of its own — carried whole but for its default branch.
   */
  copy?: CrossAgentConfig;
  /**
   * A whole config to write as given — the document `init --config -` checked
   * (`checkConfigDocument`) — rather than one this function builds. Its mode is the one
   * loaded, and the ignore entries are written only when it is.
   */
  document?: CrossAgentConfig;
  /**
   * The SHA-256 of the config this document replaces. Without it nothing is ever replaced;
   * with it the stored bytes must be exactly those, and the replaced file is kept as
   * `config.json.prev` (`replaceConfig`).
   */
  expect?: string;
}

/** A config and the mode it binds, checked against each other (design section 6). */
export interface BoundConfig {
  config: CrossAgentConfig;
  mode: Mode;
}

export const DEFAULT_MODE = "dev-team";

/**
 * `review.afterResolver`'s three values: ask the user, the default; let the lead rule and
 * record the waiver itself; or ask whatever stands, Minor findings included.
 */
export const afterResolverOptions = ["ask", "lead-decides", "always-ask"] as const;
export type AfterResolver = typeof afterResolverOptions[number];

/**
 * What a project with no config runs as. `discoverProject` answers with the git toplevel
 * where nothing above the working directory holds a config, and this is the config that
 * project has: one role, read-only at the root, and no binding — `delegate` takes the
 * engine from the call (design, "Modes").
 */
export const NO_CONFIG_MODE = "solo";

const projectDefaults: CrossAgentConfig["project"] = {
  defaultBranch: "main", testCommand: "npm test", setupCommand: "none", mergePolicy: "auto",
};
const limitDefaults: CrossAgentConfig["limits"] = {
  maxDepth: 1, stallMinutes: 15, waitDefaultSeconds: 600, duplicateWindowMinutes: 10, lockWaitSeconds: 5,
  cancelGraceSeconds: 5, planReviewRounds: 3,
};
const reviewDefaults: CrossAgentConfig["review"] = { afterResolver: "ask" };
/** The built-in consultant's starting binding; every `delegate` may name another engine. */
const consultBinding: RoleConfig = { engine: "codex", model: "gpt-6-astra" };
const devTeamBindings: Record<string, RoleBinding> = {
  planner: { engine: "claude", model: "claude-opus-5-5", effort: "xhigh" },
  "plan-reviewer": { engine: "codex", model: "gpt-6-astra", effort: "xhigh" },
  implementer: { engine: "claude", model: "claude-opus-5-5", effort: "xhigh" },
  // One seat per engine, every one of them read-only, as the mode's rule for the role is.
  "code-reviewer": [
    { engine: "claude", model: "claude-opus-5-5", effort: "xhigh", sandbox: "read-only" },
    { engine: "codex", model: "gpt-6.1-sol", effort: "xhigh", sandbox: "read-only" },
    { engine: "grok", model: "grok-4.7", effort: "xhigh", sandbox: "read-only" },
  ],
  // The escalation takes the findings two fix rounds leave standing, on the stronger setting.
  resolver: { engine: "codex", model: "gpt-6-astra", effort: "max" },
};

/**
 * What `cross-agent init --mode <name>` binds each built-in mode's roles to. Binding is a
 * local act (design, "Modes"), so this table is a starting point an operator edits, and a
 * mode this build ships no bindings for is refused by name rather than bound by guess.
 */
const builtInBindings: Record<string, Record<string, RoleBinding>> = {
  "dev-team": { ...devTeamBindings, consult: consultBinding },
  "dev-team-engine": {
    lead: { engine: "claude", model: "claude-opus-5-5", effort: "xhigh" }, ...devTeamBindings, consult: consultBinding,
  },
  solo: { consult: consultBinding },
};

/**
 * The binding a role takes on `engine` when its built-in engine is not installed here:
 * each engine's strongest model at its high effort, and Codex's at `max` for the resolver,
 * as the built-in resolver is (`builtInBindings`). `init --propose` substitutes these
 * (`src/setup.ts#proposeMode`), so they sit beside the bindings they stand in for.
 */
export function substituteBinding(engine: EngineName, role: string): RoleConfig {
  if (engine === "claude") return { engine, model: "claude-opus-5-5", effort: "xhigh" };
  if (engine === "codex") return { engine, model: "gpt-6-astra", effort: role === "resolver" ? "max" : "xhigh" };
  return { engine, model: "grok-4.7", effort: "xhigh" };
}

/**
 * The defaults of a project that has no config file at all: the mode `discoverProject`
 * falls back to, this section's own project and limit values, and no role binding, because
 * binding is a local act nobody has performed here — a `delegate` in this state names its
 * own engine, and `cross-agent init --mode solo` is how it stops having to.
 */
export function defaultConfig(): CrossAgentConfig {
  return {
    mode: NO_CONFIG_MODE, project: { ...projectDefaults }, roles: {}, limits: { ...limitDefaults }, review: { ...reviewDefaults },
    billing: "subscription",
  };
}

/** Validates the documented fields and fills only absent defaults. */
export function loadConfig(projectRoot: string): CrossAgentConfig {
  const file = path.join(projectRoot, CONFIG_PATH);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    // No file is not a failure: it is the project `discoverProject` found at a git
    // toplevel, running solo on these defaults until `cross-agent init` writes a config.
    // A file that exists and cannot be read is still a throw, below.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw new Error(`${file}: cannot read config: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(raw, file);
}

/**
 * Why a declared record path may not be one, or null: the rules `parseConfig` holds every
 * path of a `records` block to, in order. The alphabet keeps a path one git never quotes and
 * never names outside the root; `.git`, the project's own `.cross-agent/`, a host's project
 * configuration and the instruction files a host reads are never a record.
 */
function recordPathFault(file: string): string | null {
  const named = JSON.stringify(file);
  const segments = file.split("/");
  if (!segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment))) {
    return `${named} is not a relative path of "/"-separated segments of letters, digits, ".", "_" and "-"`;
  }
  if (segments.some((segment) => segment === "." || segment === "..")) return `${named} has a "." or ".." segment`;
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return `${named} lies in a .git directory, which is git's own`;
  if (segments[0].toLowerCase() === ".cross-agent") return `${named} lies under .cross-agent/, which only the server writes`;
  if (isHostConfigPath(file)) {
    return `${named} is a host's project configuration (.claude/, .codex/, .grok/, .mcp.json, in any case), which no tool commits`;
  }
  if (segments.some((segment) => ["agents.md", "claude.md"].includes(segment.toLowerCase()))) {
    return `${named} is an instruction file a host reads (AGENTS.md or CLAUDE.md, in any case), which no tool commits`;
  }
  return null;
}

/** Every path a `records` block declares, with the field that declares it: `files`, then `tracker.files`. */
function recordPaths(records: RecordsConfig): { field: string; index: number; path: string }[] {
  return [
    ...records.files.map((file, index) => ({ field: "files", index, path: file })),
    ...records.tracker.files.map((file, index) => ({ field: "tracker.files", index, path: file })),
  ];
}

/**
 * Why a declared path may not be read or written through, or null: an existing component
 * of it, under `root`, that is a symbolic link. The walk ends where nothing exists yet.
 */
export function recordPathLink(root: string, relative: string): string | null {
  const segments = relative.split("/");
  for (let end = 1; end <= segments.length; end++) {
    const prefix = segments.slice(0, end).join("/");
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(path.join(root, prefix));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      return `${JSON.stringify(prefix)} cannot be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (entry.isSymbolicLink()) return `${JSON.stringify(prefix)} is a symbolic link`;
  }
  return null;
}

/**
 * `loadConfig`'s checks on the text of a config, each refusal labelled `<file>: <field>:
 * <rule>`. The file is a label only: `init --config -` checks a document read on stdin with
 * the same checks the server's loader applies to the file (`checkConfigDocument`).
 */
export function parseConfig(raw: string, file: string): CrossAgentConfig {
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

  /** One binding, read whole, at `field`: `roles.<name>`, or `roles.<name>#<n>` for a seat. */
  function binding(value: unknown, field: string): RoleConfig {
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
    return { ...role, engine, ...(sandbox === undefined ? {} : { sandbox }) } as RoleConfig;
  }

  // A role is one binding, or a list of them, one per seat: whether the mode lets this role
  // sit more than once is `bindingFault`'s question, which needs the mode.
  const roles = Object.fromEntries(Object.entries(object(document.roles, "roles")).map(([name, value]): [string, RoleBinding] => {
    const field = `roles.${name}`;
    const listOrOne = "a binding, or a non-empty list of bindings, one per seat";
    if (Array.isArray(value)) {
      if (value.length === 0) invalid(field, listOrOne);
      return [name, value.map((entry, index) => binding(entry, `${field}#${index + 1}`))];
    }
    if (value === null || typeof value !== "object") invalid(field, listOrOne);
    return [name, binding(value, field)];
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
  // timer at all and exits 71 before it ever looks at the file: a negative wait would
  // refuse every lock in the project.
  if (limits.lockWaitSeconds < 0) invalid("limits.lockWaitSeconds", "a finite number of seconds, not negative");
  // A cap is a whole number of hops: every depth it is compared against is one, and a
  // negative cap would refuse a row to the operator at depth 0. Zero is legal — it is the
  // fail-closed cap, offering the specialist row to everyone (design section 5, layer 1).
  if (!Number.isInteger(limits.maxDepth) || limits.maxDepth < 0) {
    invalid("limits.maxDepth", "a whole number of delegation hops, not negative");
  }
  // A count of rounds, and the loop asks after the first one at the least.
  if (!Number.isInteger(limits.planReviewRounds) || limits.planReviewRounds < 1) {
    invalid("limits.planReviewRounds", "a whole number of plan-review rounds, at least 1");
  }
  const review = { ...reviewDefaults, ...object(document.review === undefined ? {} : document.review, "review") };
  oneOf(review.afterResolver, "review.afterResolver", afterResolverOptions);
  const billing = oneOf(document.billing === undefined ? "subscription" : document.billing, "billing", ["subscription", "api"] as const);

  /** One list of declared paths at `field`, each held to `recordPathFault`. */
  function pathList(value: unknown, field: string, emptyAllowed: boolean): string[] {
    if (!Array.isArray(value) || (!emptyAllowed && value.length === 0)) {
      invalid(field, emptyAllowed ? "a list of paths, which may be empty" : "a non-empty list of paths");
    }
    return (value as unknown[]).map((entry, index) => {
      if (typeof entry !== "string") invalid(`${field}[${index}]`, "a path relative to the project root");
      const fault = recordPathFault(entry as string);
      if (fault !== null) reject(`${field}[${index}]`, fault);
      return entry as string;
    });
  }

  /** One verb's template: a command and its arguments, each placeholder the verb takes named once and in its place. */
  function template(verb: TrackerVerb, value: unknown): string[] {
    const field = `records.tracker.${verb}`;
    if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string") || value[0] === "") {
      invalid(field, "a non-empty list of strings: the command, then its arguments, run with no shell");
    }
    const argv = value as string[];
    const takes: readonly string[] = trackerVerbs[verb].placeholders;
    const seen = new Map<string, number>();
    for (const [index, argument] of argv.entries()) {
      for (const [, name] of argument.matchAll(/\{([A-Za-z]+)\}/g)) {
        const at = `${field}[${index}]`;
        if (index === 0) reject(at, "the command itself holds no placeholder");
        if (!takes.includes(name)) {
          reject(at, `{${name}} is no placeholder ${verb} takes; it takes ${takes.length === 0 ? "none" : takes.map((each) => `{${each}}`).join(", ")}`);
        }
        const earlier = seen.get(name);
        if (earlier !== undefined) reject(at, `{${name}} is named twice, also [${earlier}]`);
        seen.set(name, index);
        const afterEquals = new RegExp(`^[^{}]*=\\{${name}\\}$`).test(argument);
        if (idPlaceholders.includes(name)) {
          if (argument !== `{${name}}` && !afterEquals) reject(at, `an id fills a whole argument or the part after an =, as {${name}} or --flag={${name}}`);
        } else if (!afterEquals) {
          reject(at, `free text fills only the part after an =, as --flag={${name}}`);
        }
      }
    }
    for (const name of takes) if (!seen.has(name)) reject(field, `lacks {${name}}, which ${verb} requires`);
    return [...argv];
  }

  // Absent, or both halves (design section 6): the project's record files, and its tracker's
  // commands with the files those commands change.
  function records(value: unknown): RecordsConfig {
    const block = object(value, "records");
    for (const key of Object.keys(block)) {
      if (key !== "files" && key !== "tracker") reject(`records.${key}`, "a records block has files and tracker, and nothing else");
    }
    for (const half of ["files", "tracker"] as const) {
      if (block[half] === undefined) reject(`records.${half}`, "a records block has both files and a tracker, or the config has none");
    }
    const files = pathList(block.files, "records.files", false);
    const declared = object(block.tracker, "records.tracker");
    const verbs = Object.keys(trackerVerbs) as TrackerVerb[];
    for (const key of Object.keys(declared)) {
      if (key !== "files" && !(verbs as string[]).includes(key)) {
        reject(`records.tracker.${key}`, `not a tracker verb; the verbs are ${verbs.join(", ")}, and files names the tracker's own files`);
      }
    }
    for (const verb of verbs) {
      if (trackerVerbs[verb].required && declared[verb] === undefined) {
        reject(`records.tracker.${verb}`, `${verb} is required: a tracker declares every one of ${verbs.filter((each) => trackerVerbs[each].required).join(", ")}`);
      }
    }
    const tracker = {} as RecordsConfig["tracker"];
    for (const verb of verbs) if (declared[verb] !== undefined) tracker[verb] = template(verb, declared[verb]);
    tracker.files = pathList(declared.files, "records.tracker.files", true);
    const checked: RecordsConfig = { files, tracker };
    const first = new Map<string, string>();
    for (const { field, index, path: file } of recordPaths(checked)) {
      const at = `records.${field}[${index}]`;
      const earlier = first.get(file);
      if (earlier !== undefined) reject(at, `${JSON.stringify(file)} is declared twice, also ${earlier}`);
      first.set(file, at);
    }
    return checked;
  }
  const recordsBlock = document.records === undefined ? undefined : records(document.records);
  return {
    ...document, mode, project, roles, limits, review, billing, ...(recordsBlock === undefined ? {} : { records: recordsBlock }),
  } as CrossAgentConfig;
}

/**
 * The config and the mode it names, each valid and the two agreeing (design section 6).
 * `loadConfig` stays the loader for everything that needs bindings alone — a runner, a
 * lock, a reconciliation — because those run where no mode has been read and must not
 * fail for want of one. Everything that launches or offers a tool reads both, here. A
 * `records` block's paths are read on disk here too: none may pass through a symbolic link.
 */
export function loadConfigWithMode(projectRoot: string, modesDir: string = builtInModesDir()): BoundConfig {
  const file = path.join(projectRoot, CONFIG_PATH);
  const bound = bindConfig(loadConfig(projectRoot), file, modesDir);
  const records = bound.config.records;
  if (records !== undefined) {
    for (const { field, index, path: declared } of recordPaths(records)) {
      const linked = recordPathLink(projectRoot, declared);
      if (linked !== null) throw new Error(`${file}: records.${field}[${index}]: ${linked}`);
    }
  }
  return bound;
}

/**
 * The merge policies a config may be written with: the loop merges when the tests and the
 * reviews pass, or the user merges. The server's load accepts any string, and only the
 * write `init --config` makes is held to these (setup spec, section 2).
 */
export const mergePolicies = ["auto", "manual"] as const;

/**
 * A whole config document, as `init --config -` reads it, checked before anything is
 * written: the server's load checks, its binding checks against the mode it names — a
 * profile for what each role needs, and no Grok lead — and the write-time merge policy.
 * Every refusal is `<label>: <field>: <rule>`; a mode that does not load is `<label>: mode:`.
 */
export function checkConfigDocument(raw: string, label: string, modesDir: string = builtInModesDir()): BoundConfig {
  if (raw.trim() === "") throw new Error(`${label}: $: the document is empty`);
  const config = parseConfig(raw, label);
  let mode: Mode;
  try {
    mode = loadMode(modesDir, config.mode);
  } catch (error) {
    throw new Error(`${label}: mode: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fault = bindingFault(mode, config, label);
  if (fault !== null) throw new Error(fault);
  if (!(mergePolicies as readonly string[]).includes(config.project.mergePolicy)) {
    throw new Error(`${label}: project.mergePolicy: expected ${mergePolicies.join(" | ")}`);
  }
  return { config, mode };
}

/** A parsed config and the mode it names, checked against each other, a fault labelled with `file`. */
export function bindConfig(config: CrossAgentConfig, file: string, modesDir: string = builtInModesDir()): BoundConfig {
  const mode = loadMode(modesDir, config.mode);
  const fault = bindingFault(mode, config, file);
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
  for (const [name, binding] of Object.entries(config.roles)) {
    const declared = findRole(mode, name);
    if (declared === undefined) {
      return `${file}: roles.${name}: mode ${mode.id} declares no role ${JSON.stringify(name)}; it declares ${mode.roles.map((each) => each.key).join(", ")}`;
    }
    // A list is for a role the mode lets sit more than once: a planner bound to three
    // seats would be three plans nobody asked the loop to reconcile.
    if (isSeated(binding) && declared.seats !== "many") {
      const many = mode.roles.filter((each) => each.seats === "many").map((each) => each.key);
      return `${file}: roles.${name}: a list of bindings is for a role the mode marks seats: "many"; mode ${mode.id} seats ${name} once (its many-seat roles: ${many.length === 0 ? "none" : many.join(", ")})`;
    }
    for (const [index, role] of (isSeated(binding) ? binding : [binding]).entries()) {
      const field = isSeated(binding) ? `roles.${name}#${index + 1}` : `roles.${name}`;
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
      // D-j: the seats of a read-only role review beside each other in one worktree, and a
      // read-only task reserves nothing (`src/reservation.ts#reservesWorkspace`), so no
      // binding of such a role — an object, or any seat of a list — takes a profile that
      // writes. A writable many-seat role a custom mode declares reserves as any writer does.
      if (declared.seats === "many" && declared.sandboxDefault === "read-only" && sandbox.mode !== "read-only") {
        return `${file}: ${field}.sandbox: role ${JSON.stringify(name)} reads only — mode ${mode.id} declares it read-only and seats many, and its reviews run beside each other in one worktree; ${JSON.stringify(profile)} is ${sandbox.mode} under ${role.engine}`;
      }
    }
  }
  // A record under the mode's worktree directory would be a path in some task's checkout,
  // not the root's. The directory is compared in one spelling, the normalization
  // `src/modes.ts` validates it with; the mode keeps its own.
  if (config.records !== undefined) {
    const dir = path.posix.normalize(gitPolicy(mode).worktreeDir).replace(/\/+$/, "");
    for (const { field, index, path: declared } of recordPaths(config.records)) {
      if (declared === dir || declared.startsWith(`${dir}/`)) {
        return `${file}: records.${field}[${index}]: ${JSON.stringify(declared)} lies under the mode's worktree directory ${dir}/`;
      }
    }
  }
  // P9: a Grok child inherits the operator's own configuration and has no per-run
  // isolation of any kind, so there is no Grok lead — only a Grok specialist, which
  // ancestry holds to its row ("The lead model", item 4).
  const leadRole = engineLeadRole(mode);
  if (leadRole !== undefined && seatsOf(config, leadRole)?.[0]?.engine === "grok") {
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

/**
 * Whether the config's `records` block has come or gone since this server started, as a
 * reason or null. `record` and `track` are registered once, from the block the server started
 * with: a block removed since makes both refuse, and one added is a warning `describe_mode`
 * carries.
 */
export function recordsDrift(served: boolean, config: CrossAgentConfig): string | null {
  if (served === (config.records !== undefined)) return null;
  return served
    ? `records was removed from ${CONFIG_PATH} after this server started; restart the server`
    : `records was added to ${CONFIG_PATH} after this server started, so record is not registered; restart the server to serve record and track`;
}

/** Whether a binding is a list, one binding per seat. */
export function isSeated(binding: RoleBinding | undefined): binding is RoleConfig[] {
  return Array.isArray(binding);
}

/**
 * A role's bindings by seat: one for an object, one per entry for a list, and none where
 * config binds the role nothing — the engine a `delegate` call must then name itself.
 */
export function seatsOf(config: CrossAgentConfig, key: string): RoleConfig[] | undefined {
  if (!Object.hasOwn(config.roles, key)) return undefined;
  const binding = config.roles[key];
  return isSeated(binding) ? binding : [binding];
}

/**
 * The sandbox profile a role runs under: its mode's default unless config overrides it,
 * for the seat named, or the first where none is.
 */
export function roleProfile(mode: Mode, config: CrossAgentConfig, key: string, seat?: number): SandboxProfile | undefined {
  return seatsOf(config, key)?.[(seat ?? 1) - 1]?.sandbox ?? findRole(mode, key)?.sandboxDefault;
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

/**
 * How long the repository lock waits (`src/locks.ts#repositoryLockPath`): never less than
 * sixty seconds, whatever `limits.lockWaitSeconds` says. It is the one lock that departs
 * from the waiting rule, because its holder may be another project's git step — a commit
 * whose hooks run as long as they run — and a project whose own wait is a few seconds
 * would refuse a step it only had to wait for. An operator whose hooks run longer raises
 * `limits.lockWaitSeconds`; no key of its own is needed.
 */
export function repositoryLockWait(lockWaitSeconds: number): number {
  return Math.max(lockWaitSeconds, 60);
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
 * The bytes of the project's config as stored, and their SHA-256 in hex, or null with no
 * file: what `init --propose` reports and `init --config --expect` names, hashed from the
 * very bytes a reader parses.
 */
export function configBytes(projectRoot: string): { bytes: Buffer; sha256: string } | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path.join(projectRoot, CONFIG_PATH));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return { bytes, sha256: sha256(bytes) };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The project's own state, added to `.gitignore` when it is not already there, and the
 * entries added. A tracked `.cross-agent/` would let a specialist commit a change to
 * `testCommand` or a journal inside its worktree and have the lead's own merge carry it
 * to the root, which is why `run_command` and `git_root` refuse to work in a project that
 * tracks it (design section 4) and why the verb that creates one writes the ignore. An
 * entry spelled without its trailing slash is the same entry, and a file that does not
 * end in a newline is not joined onto.
 */
function ignoreProjectState(projectRoot: string, mode: Mode): string[] {
  return ignoreEntries(projectRoot, stateEntries(mode));
}

/**
 * The `.gitignore` entries a project of `mode` needs: its state, and the policy a one-shot
 * would use where the mode declares none, so a `solo` project ignores the directory its own
 * `worktree: true` calls create (design, "Modes").
 */
export function stateEntries(mode: Mode): string[] {
  return [".cross-agent/", `${gitPolicy(mode).worktreeDir.replace(/\/+$/, "")}/`];
}

/** The project's `.gitignore` as it stands, and which of `wanted` it lacks, a spelling without the trailing slash counting as the entry. */
function gitignoreState(projectRoot: string, wanted: readonly string[]): { file: string; existing: string; missing: string[] } {
  const file = path.join(projectRoot, ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const present = new Set(existing.split("\n").map((line) => line.trim().replace(/\/+$/, "")));
  return { file, existing, missing: wanted.filter((entry) => !present.has(entry.replace(/\/+$/, ""))) };
}

/** Each of `wanted` the project's `.gitignore` lacks, read and never written: what `init --propose` reports. */
export function unignored(projectRoot: string, wanted: readonly string[]): string[] {
  return gitignoreState(projectRoot, wanted).missing;
}

/** Each of `wanted` added to the project's `.gitignore` where the file lacks it, and those added. */
export function ignoreEntries(projectRoot: string, wanted: readonly string[]): string[] {
  const { file, existing, missing } = gitignoreState(projectRoot, wanted);
  if (missing.length === 0) return [];
  appendFileSync(file, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
  return missing;
}

/**
 * The section 6 config that binds every role of `mode` to its built-in starting engine,
 * each binding a copy of the table's, so a caller that adjusts one changes nothing else.
 */
export function boundDocument(mode: Mode, name: string, defaultBranch: string): CrossAgentConfig {
  const bindings = builtInBindings[mode.id];
  if (bindings === undefined) {
    throw new Error(`cross-agent init has no bindings for mode ${JSON.stringify(name)}; write ${CONFIG_PATH} by hand, binding each of ${mode.roles.map((role) => role.key).join(", ")} to an engine`);
  }
  const roles = Object.fromEntries(mode.roles.map((role) => {
    const binding = bindings[role.key];
    if (binding === undefined) throw new Error(`cross-agent init has no binding for role ${JSON.stringify(role.key)} of mode ${JSON.stringify(name)}`);
    return [role.key, structuredClone(binding)];
  }));
  return {
    mode: mode.id,
    project: { ...projectDefaults, defaultBranch },
    roles,
    engines: { claude: {}, codex: {}, grok: {} },
    // The cap the mode needs, written rather than derived, because `effectiveMaxDepth`
    // takes the lower of the two and the documented default would hold an engine-placed
    // lead's specialists at depth 1.
    limits: { ...limitDefaults, maxDepth: placementMaxDepth(mode) },
    review: { ...reviewDefaults },
    billing: "subscription",
  };
}

/**
 * Creates the section 6 config for a mode, the copy of another project's, or a document
 * given whole, exclusively, without reading or replacing an existing file — unless `expect`
 * names the bytes a given document replaces (`replaceConfig`). The mode is loaded first, so
 * an unknown or invalid one is refused before anything is written, and its roles are bound
 * in the order it declares them.
 */
export function initConfig(projectRoot: string, options: InitConfigOptions = {}): InitConfigResult {
  const name = options.document?.mode ?? options.copy?.mode ?? options.mode ?? DEFAULT_MODE;
  const mode = loadMode(options.modesDir ?? builtInModesDir(), name);
  const document = options.document ?? (options.copy === undefined
    ? boundDocument(mode, name, options.defaultBranch ?? projectDefaults.defaultBranch)
    : { ...options.copy, project: { ...options.copy.project, defaultBranch: options.defaultBranch ?? options.copy.project.defaultBranch } });
  const text = JSON.stringify(document, null, 2) + "\n";
  const file = path.join(projectRoot, CONFIG_PATH);
  const warning = temporaryLocationWarning(projectRoot);
  const warned = (result: InitConfigResult): InitConfigResult => (warning === undefined ? result : { ...result, warning });
  if (options.expect !== undefined) {
    // A replacement needs the file it replaces, so it creates no directory either.
    const replaced = replaceConfig(file, text, options.expect);
    if ("stale" in replaced) return warned({ wrote: false, stale: true, ignored: [] });
    return warned({ wrote: true, replaced: true, previous: replaced.previous, ignored: ignoreProjectState(projectRoot, mode) });
  }
  mkdirSync(path.dirname(file), { recursive: true });
  // Written whole, then linked into place: `link` fails with EEXIST when a config is
  // already there, which is the exclusivity this has always had, and a crash before it
  // leaves a temporary file rather than an empty `config.json` that the next run would
  // call "already exists" and never repair.
  const temporary = `${file}.${process.pid}.tmp`;
  let wrote = false;
  try {
    writeFileSync(temporary, text, { flag: "wx" });
    linkSync(temporary, file);
    wrote = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
  // A document given whole is setup's confirmed write, and a refusal of it writes nothing.
  if (!wrote && options.document !== undefined) return warned({ wrote, ignored: [] });
  // Written whether or not the config was: a project whose config already exists may
  // still be tracking it, and both tools refuse to work in one that does.
  return warned({ wrote, ignored: ignoreProjectState(projectRoot, mode) });
}

/**
 * Replaces the config at `file` with `text`, only while it holds the bytes whose SHA-256 is
 * `expect`, and keeps the replaced file as `config.json.prev`; `stale` where it does not,
 * having changed neither the config nor `.gitignore`. `init --config` calls it under
 * `config.lock` (`src/locks.ts#configLockName`), so two setup runs never both pass the check.
 * Node has no atomic check-and-replace, so the check is made twice over. By content: the
 * bytes read first, and then the bytes of the very file `config.json` names, hard-linked
 * aside, so an in-place edit before that second read is caught. By pathname: after the link
 * is renamed to `.prev`, `config.json` must still be that file, so a save that renamed a new
 * file over it is caught. What neither can catch is an in-place edit after the second read,
 * which lands in `.prev`, the same file, and a rename-style save between the identity check
 * and the final rename, the race the setup spec accepts (decision of 2026-10-13). Every call
 * goes through `node:fs`'s default export, as `src/ledger.ts`'s do.
 */
function replaceConfig(file: string, text: string, expect: string): { replaced: true; previous: string } | { stale: true } {
  const previous = `${file}.prev`;
  const temporary = `${file}.${process.pid}.tmp`;
  const link = `${previous}.${process.pid}.tmp`;
  try {
    // i. The bytes the caller named.
    let stored: Buffer;
    try {
      stored = fs.readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { stale: true };
      throw error;
    }
    if (sha256(stored) !== expect) return { stale: true };
    // ii. The replacement, whole.
    fs.writeFileSync(temporary, text, { flag: "wx" });
    // iii. Whatever `config.json` names at this moment, the file itself.
    try {
      fs.linkSync(file, link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { stale: true };
      throw error;
    }
    // iv. Its bytes, read through the link.
    if (sha256(fs.readFileSync(link)) !== expect) return { stale: true };
    // v. Kept as `.prev`, replacing an older one.
    fs.renameSync(link, previous);
    // vi. `config.json` is still the file that was checked.
    const kept = fs.lstatSync(previous);
    const current = fs.lstatSync(file, { throwIfNoEntry: false });
    if (current === undefined || current.dev !== kept.dev || current.ino !== kept.ino) return { stale: true };
    // vii. The replacement, renamed into place.
    fs.renameSync(temporary, file);
    return { replaced: true, previous };
  } finally {
    // viii. Neither temporary outlives the call: the link is gone once renamed, and the
    // replacement once it is.
    fs.rmSync(temporary, { force: true });
    fs.rmSync(link, { force: true });
  }
}
