import fs from "node:fs";
import path from "node:path";
import {
  bindConfig, boundDocument, checkConfigDocument, CONFIG_PATH, configBytes, DEFAULT_MODE, engineLeadRole, isSeated, mergePolicies,
  parseConfig, recordPathFault, recordPathLink, stateEntries, substituteBinding, unignored,
} from "./config.ts";
import type { CrossAgentConfig, RecordsConfig, RoleBinding, RoleConfig } from "./config.ts";
import { writableProfiles } from "./delegate.ts";
import { commandPath, engineBin } from "./engines/binaries.ts";
import { profileFault } from "./engines/registry.ts";
import { engineNames } from "./engines/types.ts";
import type { EngineName } from "./engines/types.ts";
import { run } from "./gitmutate.ts";
import { matchesPattern, nameFault, trackedStateFault } from "./gitroot.ts";
import { builtInModesDir, gitPolicy, loadMode } from "./modes.ts";
import type { Mode, ModeRole } from "./modes.ts";

// `cross-agent init --propose` (setup spec, section 2): a look at a project — the engines
// found as the server finds them, its default branch, its test and setup commands, each with
// where it came from — and the team rule that proposes each built-in mode from what was
// found. Nothing here writes: it reads fixed names at the root, lists the one directory
// `.project-steward/` and never walks the tree, looks `bd` up on `PATH` without running it,
// runs no program of the project's, and the only programs it runs are read-only git
// commands the server's root tools already run.

/**
 * The repository `init --propose` looks at: its git directory and work tree, verified by
 * `init`'s own checks (`src/cli.ts#initTarget`), and for a branch project — a linked
 * worktree initialized as a project of its own — the branch it has checked out and its main
 * checkout, where there is one.
 */
export interface ProjectRepository {
  gitDir: string;
  workTree: string;
  worktree: { branch: string; main: string | null } | null;
}

/** One thing detection looked for: its value and where it came from, or not found. */
export type Fact = { found: true; value: string; from: string } | { found: false; value: null; from: null };

/**
 * One engine as the server would start it: the command it would spawn, where that resolves,
 * and what named the command — `engines.<e>.bin`, `CROSS_AGENT_<E>_BIN`, or the name on `PATH`.
 */
export interface EngineFinding {
  found: boolean;
  command: string;
  path: string | null;
  from: string;
}

const NOT_FOUND: Fact = { found: false, value: null, from: null };

function found(value: string, from: string): Fact {
  return { found: true, value, from };
}

/** The most of `package.json` or a `Makefile` detection reads: a project file is far smaller. */
const READ_LIMIT = 1024 * 1024;

/**
 * Whether `name`, at the root and nowhere else, is a regular file, and its size. A
 * directory, a FIFO and a device are no project file, and a FIFO is never opened, which
 * would block until a writer came; anything that cannot be read is not found.
 */
function regularFile(root: string, name: string): fs.Stats | null {
  try {
    const stats = fs.statSync(path.join(root, name), { throwIfNoEntry: false });
    return stats?.isFile() === true ? stats : null;
  } catch {
    return null;
  }
}

/** The text of a regular file at the root of at most `READ_LIMIT` bytes, or null. */
function smallFile(root: string, name: string): string | null {
  const stats = regularFile(root, name);
  if (stats === null || stats.size > READ_LIMIT) return null;
  try {
    return fs.readFileSync(path.join(root, name), "utf8");
  } catch {
    return null;
  }
}

/** Whether `package.json` declares a non-empty `scripts.test`; JSON that does not parse declares nothing. */
function declaresTestScript(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const scripts = parsed !== null && typeof parsed === "object" ? (parsed as { scripts?: unknown }).scripts : undefined;
  const script = scripts !== null && typeof scripts === "object" ? (scripts as { test?: unknown }).test : undefined;
  return typeof script === "string" && script !== "";
}

/**
 * The project's test command, by the first rule that holds, in the spec's order:
 * `package.json` with `scripts.test`, a `Makefile` with a `test` target (never a `test :=`
 * variable), then `pyproject.toml`, `pytest.ini`, `Cargo.toml` and `go.mod` by existence.
 */
export function detectTestCommand(root: string): Fact {
  const manifest = smallFile(root, "package.json");
  if (manifest !== null && declaresTestScript(manifest)) return found("npm test", "package.json scripts.test");
  const makefile = smallFile(root, "Makefile");
  if (makefile !== null && /^test[ \t]*:(?!=)/m.test(makefile)) return found("make test", "Makefile test target");
  for (const [name, command] of [["pyproject.toml", "pytest"], ["pytest.ini", "pytest"], ["Cargo.toml", "cargo test"], ["go.mod", "go test ./..."]]) {
    if (regularFile(root, name) !== null) return found(command, name);
  }
  return NOT_FOUND;
}

/** The project's setup command, from the first lockfile at the root, in the spec's order; `Cargo.lock` needs none. */
export function detectSetupCommand(root: string): Fact {
  for (const [name, command] of [
    ["package-lock.json", "npm ci"], ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"], ["yarn.lock", "yarn install --frozen-lockfile"],
    ["uv.lock", "uv sync"], ["poetry.lock", "poetry install"], ["Cargo.lock", "none"],
  ]) {
    if (regularFile(root, name) !== null) return found(command, name);
  }
  return NOT_FOUND;
}

/**
 * The project's default branch. A branch project's is its own branch, as `init` makes it
 * (`src/cli.ts#initWorktree`). Anywhere else it is the remote's default, `origin/HEAD`, else
 * the branch checked out — an unborn one included, in a repository `git init` just made —
 * else `main`. An `origin/HEAD` naming a branch this clone lacks is proposed as it is.
 */
export async function detectDefaultBranch(repository: ProjectRepository): Promise<Fact> {
  if (repository.worktree !== null) return found(repository.worktree.branch, "worktree branch");
  const { gitDir, workTree } = repository;
  const remote = await run(gitDir, workTree, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const named = remote.stdout.trim().replace(/^origin\//, "");
  if (remote.exitCode === 0 && named !== "") return found(named, "origin/HEAD");
  const head = await run(gitDir, workTree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.exitCode === 0 && head.stdout.trim() !== "") return found(head.stdout.trim(), "current branch");
  return found("main", "default");
}

/**
 * Each engine looked up as the server looks it up when it starts one: the config's
 * `engines.<e>.bin` laid over the environment as `CROSS_AGENT_<E>_BIN`, as `delegate` lays it
 * (`src/delegate.ts#binEnvironment`), then `engineBin` and `commandPath`. A configured bin
 * that is missing is not found, whatever `PATH` holds, because the server would fail to
 * spawn it.
 */
export function findEngines(config: CrossAgentConfig | null, env: Readonly<NodeJS.ProcessEnv>): Record<EngineName, EngineFinding> {
  return Object.fromEntries(engineNames.map((engine): [EngineName, EngineFinding] => {
    const variable = `CROSS_AGENT_${engine.toUpperCase()}_BIN`;
    const bin = config?.engines?.[engine]?.bin;
    const overlaid = bin === undefined ? env : { ...env, [variable]: bin };
    const command = engineBin(engine, overlaid);
    const resolved = commandPath(command, overlaid);
    const from = bin !== undefined ? `engines.${engine}.bin` : env[variable] !== undefined ? variable : "PATH";
    return [engine, { found: resolved !== null, command, path: resolved, from }];
  })) as Record<EngineName, EngineFinding>;
}

/**
 * The tracker a beads project is proposed: bd's own commands (bd 1.2). `--silent` makes each
 * create print only the new item's id, as the tracker contract needs, and
 * `.beads/interactions.jsonl` is the tracked file bd's writes change.
 */
const BEADS_TRACKER: RecordsConfig["tracker"] = {
  ready: ["bd", "ready"],
  show: ["bd", "show", "{id}"],
  create: ["bd", "create", "--title={title}", "--description={text}", "--parent={parent}", "--silent"],
  file: ["bd", "create", "--title={title}", "--description={text}", "--silent"],
  epic: ["bd", "create", "--type=epic", "--title={title}", "--description={text}", "--silent"],
  claim: ["bd", "update", "{id}", "--claim"],
  close: ["bd", "close", "{id}", "--reason={text}"],
  depend: ["bd", "dep", "add", "{id}", "{on}"],
  files: [".beads/interactions.jsonl"],
};

/**
 * The `records` block a project keeping beads and project-steward is proposed (design section
 * 6, "The `records` block"), or null: both halves are found or nothing is proposed. The
 * tracker half is a real `.beads/` holding `config.yaml` or `metadata.json`, and `bd` on
 * `PATH`, looked up and never run; the files half is every regular `.md` file directly under a
 * real `.project-steward/` that the path rules admit. A declared path through a symbolic link
 * proposes nothing, since the server would refuse that config at start.
 */
export function detectRecords(root: string, env: Readonly<NodeJS.ProcessEnv>): RecordsConfig | null {
  if (commandPath("bd", env) === null) return null;
  if (regularFile(root, ".beads/config.yaml") === null && regularFile(root, ".beads/metadata.json") === null) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, ".project-steward"), { withFileTypes: true });
  } catch {
    return null;
  }
  // A `Dirent` reports a symbolic link as no file.
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `.project-steward/${entry.name}`).filter((file) => recordPathFault(file) === null).sort();
  if (files.length === 0) return null;
  const records: RecordsConfig = { files, tracker: structuredClone(BEADS_TRACKER) };
  return [...records.files, ...records.tracker.files].every((file) => recordPathLink(root, file) === null) ? records : null;
}

/** The one line a proposal carries when one of its writing roles is on Grok. */
export const GROK_GIT_NOTE = "Grok's sandbox cannot protect the repository's git files, so cross-agent checks them after each step instead.";
const NO_ENGINE = "no engine found: install Claude Code, Codex or Grok";
const LEAD_ENGINE = "the background team's lead must be Claude or Codex";

/** The modes `init --propose` proposes, in the order it lists them: the built-in ones. */
const PROPOSED_MODES = ["dev-team", "dev-team-engine", "solo"] as const;

/**
 * One role, or one seat, that does not keep the binding it started from: `from` is the
 * engine it had, null for a role the base left unbound or a seat added, and `to` the engine
 * it has now, null for a seat dropped.
 */
export interface Substitution {
  role: string;
  seat?: number;
  from: EngineName | null;
  to: EngineName | null;
}

/** One mode's proposal: a full config `init --config` accepts, or the reason there is none. */
export interface Proposal {
  mode: string;
  available: boolean;
  /** Why the mode is not proposed; present exactly when it is unavailable. */
  reason?: string;
  document: CrossAgentConfig | null;
  substitutions: Substitution[];
  notes: string[];
  /** The main checkout's config this proposal was built on, or null for one built fresh. */
  copiedFrom: string | null;
}

/** `init --propose --json`'s document (setup spec, section 2). */
export interface SetupProposal {
  ok: true;
  root: string;
  engines: Record<EngineName, EngineFinding>;
  project: { defaultBranch: Fact; testCommand: Fact; setupCommand: Fact; mergePolicy: Fact };
  existing: {
    /** The stored config as `JSON.parse` reads it, never normalized; null with no file or no JSON. */
    config: unknown;
    sha256: string | null;
    /** Why the server would refuse the stored config, or null. */
    fault: string | null;
    gitignore: { complete: boolean; missing: string[] };
    /** Whether `.cross-agent/` is tracked, which blocks every git step. */
    tracked: boolean;
    trackedReason: string | null;
    mainCheckoutConfig: { file: string; fault: string | null } | null;
  };
  proposals: Proposal[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why `defaultBranch` cannot be a project's default branch under `mode`, or null. In order:
 * a branch project's default branch is the branch it has checked out (`worktreeBranch`, null
 * at a main checkout); `git_root` must be able to name it (`src/gitroot.ts#nameFault`); and
 * the mode's task pattern must not match it, the rule `init` holds a worktree to
 * (`src/cli.ts#initWorktree`). Every proposal and every `init --config` document is held to it.
 */
export function defaultBranchFault(mode: Mode, defaultBranch: string, worktreeBranch: string | null): string | null {
  if (worktreeBranch !== null && defaultBranch !== worktreeBranch) {
    return `${JSON.stringify(defaultBranch)} is not this worktree's own branch ${JSON.stringify(worktreeBranch)}: a branch project's default branch is the branch it has checked out`;
  }
  const name = nameFault(defaultBranch);
  if (name !== null) return `${name}: a branch here is letters, digits, ".", "_", "/" and "-", with no ".." and no trailing ".", "/" or ".lock"`;
  const pattern = gitPolicy(mode).branchPattern;
  if (matchesPattern(defaultBranch, pattern)) {
    return `${JSON.stringify(defaultBranch)} matches mode ${mode.id}'s task branch pattern ${pattern}: a project's default branch is never a task's`;
  }
  return null;
}

/** A binding as a writing role takes it: an engine with no profile for the mode's default writes under its own. */
function writable(role: ModeRole, binding: RoleConfig): RoleConfig {
  const copy = structuredClone(binding);
  if (role.sandboxDefault === "read-only" || profileFault(copy.engine, role.sandboxDefault) === null) return copy;
  return { ...copy, sandbox: writableProfiles[copy.engine] };
}

/**
 * One mode's proposal from the engines found (setup spec, section 2, "The team rule"). It
 * starts from `base` — a main checkout's config, which a branch project's first setup builds
 * on — or with none from `init`'s own bindings (`src/config.ts#boundDocument`), and changes
 * neither. The lead may be Claude or Codex; a writing role Claude or Codex, or Grok when
 * neither is found; any other role any engine. Each single-seat role takes the first of the
 * base's binding, the built-in one, and the substitute (`src/config.ts#substituteBinding`) for
 * the first engine it may take, in the order Claude, Codex, Grok, whose engine is found; a
 * many-seat role keeps the base's seats whose engine is found, or else the built-in ones. A
 * writing role on an engine without the mode's profile takes the engine's own writable
 * profile, which only Grok needs. A base's own `records` block stands, and the `records`
 * given fills only a document with none. The result passes `init --config`'s content checks —
 * `checkConfigDocument` and `defaultBranchFault` — or is unavailable with their reason, so
 * `init --config` never refuses an available proposal for what it says.
 */
export function proposeMode(
  mode: Mode, found: ReadonlySet<EngineName>, project: CrossAgentConfig["project"],
  options: {
    base?: CrossAgentConfig; engines?: CrossAgentConfig["engines"]; worktreeBranch?: string | null; modesDir?: string; records?: RecordsConfig;
  } = {},
): Proposal {
  const unavailable = (reason: string): Proposal => ({
    mode: mode.id, available: false, reason, document: null, substitutions: [], notes: [], copiedFrom: null,
  });
  if (found.size === 0) return unavailable(NO_ENGINE);
  const { base } = options;
  const builtIn = boundDocument(mode, mode.id, project.defaultBranch);
  const lead = engineLeadRole(mode);
  const writersOnGrok = !found.has("claude") && !found.has("codex");
  const substitutions: Substitution[] = [];
  const roles: Record<string, RoleBinding> = {};
  let grokWrites = false;
  for (const role of mode.roles) {
    const writes = role.sandboxDefault !== "read-only";
    const allowed = (engine: EngineName): boolean => {
      if (!found.has(engine)) return false;
      if (engine !== "grok") return true;
      return role.key !== lead && (!writes || writersOnGrok);
    };
    const own = base !== undefined && Object.hasOwn(base.roles, role.key) ? base.roles[role.key] : undefined;
    const initial = builtIn.roles[role.key];
    if (role.seats === "many") {
      // The base's seats whose engine is found, in order, or else the built-in ones.
      const started = base === undefined ? initial : own;
      const source = started === undefined ? [] : isSeated(started) ? started : [started];
      const kept = source.filter((seat) => allowed(seat.engine));
      source.forEach((seat, index) => {
        if (!allowed(seat.engine)) substitutions.push({ role: role.key, seat: index + 1, from: seat.engine, to: null });
      });
      let seated = kept;
      if (kept.length === 0) {
        seated = (isSeated(initial) ? initial : [initial]).filter((seat) => allowed(seat.engine));
        seated.forEach((seat, index) => substitutions.push({ role: role.key, seat: index + 1, from: null, to: seat.engine }));
      }
      if (seated.length === 0) return unavailable(`no engine found can sit as ${role.key}`);
      roles[role.key] = kept.length === source.length && started !== undefined ? structuredClone(started)
        : seated.map((seat) => writable(role, seat));
      grokWrites ||= writes && seated.some((seat) => seat.engine === "grok");
      continue;
    }
    // The binding the role starts from — the base's, which may leave it unbound, or the
    // built-in one — then the built-in one, then each engine's substitute.
    const first = (base === undefined ? initial : own) as RoleConfig | undefined;
    const candidates = [first, initial as RoleConfig, ...engineNames.map((engine) => substituteBinding(engine, role.key))];
    const chosen = candidates.find((candidate) => candidate !== undefined && allowed(candidate.engine));
    if (chosen === undefined) return unavailable(role.key === lead ? LEAD_ENGINE : `no engine found can take ${role.key}`);
    if (chosen !== first) substitutions.push({ role: role.key, from: first?.engine ?? null, to: chosen.engine });
    roles[role.key] = writable(role, chosen);
    grokWrites ||= writes && chosen.engine === "grok";
  }

  const notes = grokWrites ? [GROK_GIT_NOTE] : [];
  let document: CrossAgentConfig;
  if (base === undefined) {
    document = { ...builtIn, project: { ...project }, roles, engines: { ...builtIn.engines, ...structuredClone(options.engines ?? {}) } };
  } else {
    // The main checkout's settings, on this worktree's own branch, with a merge policy the
    // write accepts.
    const section = { ...base.project, defaultBranch: project.defaultBranch };
    if (!(mergePolicies as readonly string[]).includes(section.mergePolicy)) {
      notes.push(`The main checkout's merge policy ${JSON.stringify(section.mergePolicy)} is not auto or manual; this proposal uses auto.`);
      section.mergePolicy = "auto";
    }
    document = { ...structuredClone(base), project: section, roles };
  }
  if (options.records !== undefined && document.records === undefined) document = { ...document, records: structuredClone(options.records) };
  try {
    checkConfigDocument(JSON.stringify(document), "proposal", options.modesDir ?? builtInModesDir());
  } catch (error) {
    return unavailable(message(error));
  }
  const fault = defaultBranchFault(mode, document.project.defaultBranch, options.worktreeBranch ?? null);
  if (fault !== null) return unavailable(fault);
  return { mode: mode.id, available: true, document, substitutions, notes, copiedFrom: null };
}

/** A stored config, read once: the raw document, the hash of the bytes parsed, the config as the server reads it, and its fault. */
function storedConfig(projectRoot: string, modesDir: string): { raw: unknown; sha256: string; parsed: CrossAgentConfig | null; fault: string | null } | null {
  const stored = configBytes(projectRoot);
  if (stored === null) return null;
  const text = stored.bytes.toString("utf8");
  const file = path.join(projectRoot, CONFIG_PATH);
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch { /* Not JSON: its fault says so. */ }
  let parsed: CrossAgentConfig | null = null;
  let fault: string | null = null;
  try {
    parsed = parseConfig(text, file);
    bindConfig(parsed, file, modesDir);
  } catch (error) {
    fault = message(error);
  }
  return { raw, sha256: stored.sha256, parsed, fault };
}

/**
 * `init --propose`'s document for the project at `root` (setup spec, section 2), writing
 * nothing and taking no lock. A branch project with no config of its own, whose main
 * checkout holds one the server would load, has that config as the base of its mode's
 * proposal, so it starts as the same team its main checkout runs, as `init` there copies
 * it (`src/cli.ts#initWorktree`); every other proposal is fresh. Engines are looked up with
 * the root's own config where it parses, else that base. The background team's proposal
 * carries the `records` block `detectRecords` finds, where it finds one.
 */
export async function propose(
  root: string, repository: ProjectRepository, options: { env: Readonly<NodeJS.ProcessEnv>; modesDir?: string },
): Promise<SetupProposal> {
  const modesDir = options.modesDir ?? builtInModesDir();
  const own = storedConfig(root, modesDir);
  let mainCheckoutConfig: SetupProposal["existing"]["mainCheckoutConfig"] = null;
  let base: { config: CrossAgentConfig; file: string } | undefined;
  const mainCheckout = repository.worktree?.main ?? null;
  if (own === null && mainCheckout !== null) {
    const main = storedConfig(mainCheckout, modesDir);
    if (main !== null) {
      const file = path.join(mainCheckout, CONFIG_PATH);
      mainCheckoutConfig = { file, fault: main.fault };
      if (main.fault === null && main.parsed !== null) base = { config: main.parsed, file };
    }
  }
  const lookup = own?.parsed ?? base?.config ?? null;
  const engines = findEngines(lookup, options.env);
  const defaultBranch = await detectDefaultBranch(repository);
  const testCommand = detectTestCommand(root);
  const setupCommand = detectSetupCommand(root);
  const project = {
    defaultBranch: defaultBranch.value ?? "main", testCommand: testCommand.value ?? "none", setupCommand: setupCommand.value ?? "none",
    mergePolicy: "auto",
  };
  const missing = unignored(root, stateEntries(loadMode(modesDir, DEFAULT_MODE)));
  const trackedReason = await trackedStateFault(repository.gitDir, repository.workTree);
  const installed = new Set(engineNames.filter((engine) => engines[engine].found));
  const records = detectRecords(root, options.env);
  const proposals = PROPOSED_MODES.map((name) => {
    const based = base !== undefined && base.config.mode === name;
    const proposal = proposeMode(loadMode(modesDir, name), installed, project, {
      ...(based ? { base: base!.config } : {}), ...(lookup?.engines === undefined ? {} : { engines: lookup.engines }),
      worktreeBranch: repository.worktree?.branch ?? null, modesDir,
      ...(name === "dev-team-engine" && records !== null ? { records } : {}),
    });
    return based ? { ...proposal, copiedFrom: base!.file } : proposal;
  });
  return {
    ok: true, root, engines,
    project: { defaultBranch, testCommand, setupCommand, mergePolicy: found("auto", "default") },
    existing: {
      config: own?.raw ?? null, sha256: own?.sha256 ?? null, fault: own?.fault ?? null,
      gitignore: { complete: missing.length === 0, missing }, tracked: trackedReason !== null, trackedReason, mainCheckoutConfig,
    },
    proposals,
  };
}
