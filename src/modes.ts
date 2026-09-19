import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxProfiles } from "./engines/registry.ts";
import type { SandboxProfile } from "./engines/registry.ts";
import { engineNames } from "./engines/types.ts";
import type { EngineName } from "./engines/types.ts";

// A mode is `modes/<name>/{mode.json, SKILL.md, roles/*.md}`: the roles a team has, where
// each of them works, and the loop its lead runs — portable text, hand-validated here in
// the style of `src/config.ts` (design, "Modes"). Which engine runs which role is the
// bind-time layer and lives in `.cross-agent/config.json`, never here.

export const MODE_FILE = "mode.json";
export const LOOP_FILE = "SKILL.md";

/**
 * A cap on every text field, so nothing rides through the mode boundary as a payload in a
 * name. The numbers are generous for what each field is for and small enough that a
 * refusal is the answer long before memory is: an id names a directory, a title names a
 * role in one line, and a summary is a paragraph. The loop and the role prompts are not
 * capped — they are the mode's content, served whole by `describeMode`.
 */
const caps = {
  id: 64, release: 32, name: 200, summary: 4000,
  key: 64, title: 200, promptFile: 256, dir: 200, branchPattern: 200,
} as const;

/** Where a role works. Arbitrary paths are deferred with a reason (design, "Not built"). */
export type Workspace = { kind: "root" } | { kind: "worktree"; branchPattern: string; dir: string };

export interface ModeRole {
  key: string;
  title: string;
  /** Relative to the mode directory, which it must resolve inside. */
  promptFile: string;
  workspace: Workspace;
  /** The profile this role runs under unless config overrides it (design section 6). */
  sandboxDefault: SandboxProfile;
}

/** The worktree provider's own policy: where its worktrees live and what its branches are called. */
export interface GitPolicy {
  worktreeDir: string;
  branchPattern: string;
}

export interface ModeLead {
  placement: "host" | "engine";
  /** The role the loop runs as, named exactly when a spawned engine holds it. */
  role?: string;
}

export interface Mode {
  id: string;
  release: string;
  name: string;
  summary: string;
  lead: ModeLead;
  roles: ModeRole[];
  /** Present exactly when a role works in a worktree. */
  git?: GitPolicy;
  requires: { engines: EngineName[] };
  /** The canonical mode directory: where `SKILL.md` and every prompt file were resolved. */
  dir: string;
}

export interface ModeDescription {
  mode: { id: string; release: string; name: string; summary: string; lead: ModeLead };
  /** `SKILL.md` verbatim: the mode's loop, served rather than copied (design section 7). */
  loop: string;
  roles: Array<{ key: string; title: string; workspace: Workspace; sandboxDefault: SandboxProfile; prompt: string }>;
  git?: GitPolicy;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The modes this build ships: `dev-team`, `dev-team-engine` and `solo`. */
export function builtInModesDir(): string {
  return fileURLToPath(new URL("../modes", import.meta.url));
}

/** Whether this mode registers the worktree provider — `verify_worktree` and `git_mutate`. */
export function declaresWorktreeProvider(mode: Mode): boolean {
  return mode.roles.some((role) => role.workspace.kind === "worktree");
}

/** What the mode says about one role key, or undefined when it declares none. */
export function findRole(mode: Mode, key: string): ModeRole | undefined {
  return mode.roles.find((role) => role.key === key);
}

/**
 * The mode `name` under `modesDir`, validated in full or refused with the field and the
 * rule. Every refusal names the file it read, because a mode author fixes one line.
 */
export function loadMode(modesDir: string, name: string): Mode {
  // The name reaches the file system as one directory under the shelf and nothing else:
  // a name with a separator in it would resolve somewhere `modesDir` does not own.
  if (name === "" || name === "." || name === ".." || name !== path.basename(name)) {
    throw new Error(`mode ${JSON.stringify(name)}: a mode is one directory under ${modesDir}`);
  }
  const dir = path.join(modesDir, name);
  const file = path.join(dir, MODE_FILE);
  let raw: string;
  let canonicalDir: string;
  try {
    canonicalDir = realpathSync(dir);
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new Error(`no mode ${JSON.stringify(name)} at ${dir}: it holds no ${MODE_FILE}`);
    throw new Error(`${file}: cannot read the mode: ${message(error)}`);
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
  function text(value: unknown, field: string, cap: number): string {
    if (typeof value !== "string" || value === "") invalid(field, "a non-empty string");
    if (value.length > cap) reject(field, `at most ${cap} characters, not ${value.length}`);
    return value;
  }
  // Unknown fields are refused rather than stripped: a mode that carries a field this
  // build does not know is a mode this build cannot honour, and silence would hide it.
  function only(record: Record<string, unknown>, field: string, keys: readonly string[]): void {
    for (const key of Object.keys(record)) {
      if (!keys.includes(key)) reject(field === "$" ? key : `${field}.${key}`, `unknown field; this build reads ${keys.join(", ")}`);
    }
  }
  /** A directory a worktree may live in: inside the project, named relative to its root. */
  function relativeDir(value: unknown, field: string): string {
    const dirValue = text(value, field, caps.dir);
    const normalized = path.normalize(dirValue);
    if (path.isAbsolute(dirValue) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      reject(field, `a worktree directory is relative to the project root and inside it, not ${JSON.stringify(dirValue)}`);
    }
    return dirValue;
  }
  /** A branch pattern whose one `*` the task slug fills (`task/*` → `task/<slug>`). */
  function branchPattern(value: unknown, field: string): string {
    const pattern = text(value, field, caps.branchPattern);
    if (pattern.split("*").length !== 2 || /\s/.test(pattern)) {
      reject(field, `a branch pattern names a task branch with exactly one "*" for the slug, not ${JSON.stringify(pattern)}`);
    }
    return pattern;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid("$", "valid JSON");
  }
  const document = object(parsed, "$");
  only(document, "$", ["id", "release", "name", "summary", "lead", "roles", "git", "requires"]);

  const id = text(document.id, "id", caps.id);
  // The directory is the identity: a mode copied under another name is another mode, and
  // config names this one by its directory.
  if (id !== name) reject("id", `a mode's id is its own directory name, so ${JSON.stringify(id)} cannot live in ${name}`);
  const release = text(document.release, "release", caps.release);
  const modeName = text(document.name, "name", caps.name);
  const summary = text(document.summary, "summary", caps.summary);

  if (!Array.isArray(document.roles) || document.roles.length === 0) invalid("roles", "a non-empty array of roles");
  const roles = document.roles.map((value, index): ModeRole => {
    const at = `roles[${index}]`;
    const record = object(value, at);
    const field = typeof record.key === "string" && record.key !== "" ? `roles.${record.key}` : at;
    only(record, field, ["key", "title", "promptFile", "workspace", "sandboxDefault"]);
    const key = text(record.key, `${field}.key`, caps.key);
    // A role key names a config entry, a prompt file and a task record's role, so it is
    // one path segment of a small alphabet and never a traversal.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
      reject(`${field}.key`, `a role key is lower-case letters, digits and hyphens, not ${JSON.stringify(key)}`);
    }
    const title = text(record.title, `${field}.title`, caps.title);

    const workspaceRecord = object(record.workspace, `${field}.workspace`);
    const kind = oneOf(workspaceRecord.kind, `${field}.workspace.kind`, ["root", "worktree"] as const);
    let workspace: Workspace;
    if (kind === "root") {
      only(workspaceRecord, `${field}.workspace`, ["kind"]);
      workspace = { kind };
    } else {
      only(workspaceRecord, `${field}.workspace`, ["kind", "branchPattern", "dir"]);
      workspace = {
        kind,
        branchPattern: branchPattern(workspaceRecord.branchPattern, `${field}.workspace.branchPattern`),
        dir: relativeDir(workspaceRecord.dir, `${field}.workspace.dir`),
      };
    }

    const sandboxDefault = oneOf(record.sandboxDefault, `${field}.sandboxDefault`, sandboxProfiles);
    // No role may combine `{kind: "root"}` with a writable sandbox (design, "Modes"): a
    // writable root role could edit `.cross-agent/` itself. The rule is stated portably —
    // the profile has to be `read-only`, which is the one name every engine accepts for
    // it — because a mode is bound to engines elsewhere and cannot know which.
    if (workspace.kind === "root" && sandboxDefault !== "read-only") {
      reject(`${field}.sandboxDefault`, `a {kind: "root"} role works at the project root, where only "read-only" is portable across engines; ${JSON.stringify(sandboxDefault)} is not`);
    }

    const promptFile = text(record.promptFile, `${field}.promptFile`, caps.promptFile);
    if (path.isAbsolute(promptFile)) reject(`${field}.promptFile`, `a prompt file is named relative to the mode directory, not ${JSON.stringify(promptFile)}`);
    let resolved: string;
    try {
      resolved = realpathSync(path.resolve(canonicalDir, promptFile));
    } catch (error) {
      reject(`${field}.promptFile`, `cannot read ${promptFile}: ${message(error)}`);
    }
    // Realpath, so a symlink inside the mode pointing out of it is the same escape as a
    // `..` in the name: a mode serves its own text and no other file on this machine.
    if (!resolved.startsWith(canonicalDir + path.sep)) {
      reject(`${field}.promptFile`, `${promptFile} resolves to ${resolved}, outside the mode directory ${canonicalDir}`);
    }
    return { key, title, promptFile, workspace, sandboxDefault };
  });
  for (const [index, role] of roles.entries()) {
    if (roles.findIndex((other) => other.key === role.key) !== index) {
      reject(`roles.${role.key}`, "declared twice; each role key is declared once");
    }
  }

  const leadRecord = object(document.lead, "lead");
  only(leadRecord, "lead", ["placement", "role"]);
  const placement = oneOf(leadRecord.placement, "lead.placement", ["host", "engine"] as const);
  let lead: ModeLead;
  if (placement === "engine") {
    // An engine-placed mode cannot resolve the lead's own row without it; a host-placed
    // one has no lead role to name, because the loop runs in the operator's session.
    const role = text(leadRecord.role, "lead.role", caps.key);
    if (!roles.some((declared) => declared.key === role)) {
      reject("lead.role", `${JSON.stringify(role)} names no role of this mode; it declares ${roles.map((declared) => declared.key).join(", ")}`);
    }
    lead = { placement, role };
  } else {
    if (leadRecord.role !== undefined) reject("lead.role", "only an engine-placed mode names a lead role; this one is host-placed");
    lead = { placement };
  }

  const worktreeRoles = roles.filter((role) => role.workspace.kind === "worktree");
  let git: GitPolicy | undefined;
  if (document.git === undefined) {
    if (worktreeRoles.length > 0) {
      reject("git", `a mode with a worktree role declares the provider's policy: {"worktreeDir": ..., "branchPattern": ...}`);
    }
  } else {
    if (worktreeRoles.length === 0) reject("git", "only a mode whose roles work in worktrees has a git policy");
    const record = object(document.git, "git");
    only(record, "git", ["worktreeDir", "branchPattern"]);
    git = {
      worktreeDir: relativeDir(record.worktreeDir, "git.worktreeDir"),
      branchPattern: branchPattern(record.branchPattern, "git.branchPattern"),
    };
    // The policy is what `git_mutate` defaults `path` and `branch` from, so a role that
    // works somewhere else would be mutated somewhere else (design section 4).
    for (const role of worktreeRoles) {
      const workspace = role.workspace as { kind: "worktree"; branchPattern: string; dir: string };
      if (workspace.dir !== git.worktreeDir) reject("git.worktreeDir", `role ${role.key} works in ${workspace.dir}, which the policy does not name`);
      if (workspace.branchPattern !== git.branchPattern) reject("git.branchPattern", `role ${role.key} is branched ${workspace.branchPattern}, which the policy does not name`);
    }
  }

  // What a mode needs of the machine it runs on. Nothing enforces it at load: an engine
  // preflight is deferred with a reason (design, "Not built"), and the sandbox-or-refuse
  // rule already fails closed at spawn time.
  const requires = { engines: [] as EngineName[] };
  if (document.requires !== undefined) {
    const record = object(document.requires, "requires");
    only(record, "requires", ["engines"]);
    if (record.engines !== undefined) {
      if (!Array.isArray(record.engines)) invalid("requires.engines", `an array of ${engineNames.join(" | ")}`);
      requires.engines = record.engines.map((value, index) => oneOf(value, `requires.engines[${index}]`, engineNames));
    }
  }

  return { id, release, name: modeName, summary, lead, roles, ...(git === undefined ? {} : { git }), requires, dir: canonicalDir };
}

/**
 * The active mode as `describe_mode` answers it (design, "Modes"): the loop and every role
 * prompt verbatim, so a launcher reads the mode's own text without a file being copied
 * anywhere. A mode that cannot be read is a reason, never a throw — the launcher's first
 * call is this one, and it has to fail loudly at step one with something to act on.
 */
export function describeMode(modesDir: string, name: string): ModeDescription | { reason: string } {
  let mode: Mode;
  try {
    mode = loadMode(modesDir, name);
  } catch (error) {
    return { reason: message(error) };
  }
  try {
    const loop = readFileSync(path.join(mode.dir, LOOP_FILE), "utf8");
    const roles = mode.roles.map(({ key, title, workspace, sandboxDefault, promptFile }) => ({
      key, title, workspace, sandboxDefault, prompt: readFileSync(path.join(mode.dir, promptFile), "utf8"),
    }));
    return {
      mode: { id: mode.id, release: mode.release, name: mode.name, summary: mode.summary, lead: mode.lead },
      loop,
      roles,
      ...(mode.git === undefined ? {} : { git: mode.git }),
    };
  } catch (error) {
    return { reason: `mode ${JSON.stringify(name)}: ${message(error)}` };
  }
}
