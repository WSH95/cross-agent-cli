#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH, DEFAULT_MODE, ignoreEntries, initConfig, loadConfig, loadConfigWithMode, lockWaitSeconds } from "./config.ts";
import type { CrossAgentConfig } from "./config.ts";
import type { SandboxProfile } from "./engines/registry.ts";
import { gitMutate } from "./gitmutate.ts";
import type { GitMutateRequest, GitMutateResult } from "./gitmutate.ts";
import { gitRoot, matchesPattern, nameFault } from "./gitroot.ts";
import type { GitRootResult } from "./gitroot.ts";
import { listJournals, readJournal } from "./journal.ts";
import type { Journal } from "./journal.ts";
import { find, isProcessAlive, isTaskId, isTerminal, readOutcome, runnerLogPath, scan, tailLines, taskStatuses } from "./ledger.ts";
import type { TaskOutcome, TaskRecord, TaskStatus } from "./ledger.ts";
import { answerAsk, askStatuses, listAsks } from "./mailbox.ts";
import type { AskStatus } from "./mailbox.ts";
import { builtInModesDir, gitPolicy, loadMode } from "./modes.ts";
import type { EffectiveGitPolicy, Mode, ModeLead, Workspace } from "./modes.ts";
import { discoverProject, holdsConfig, isMainModule, parseFlags } from "./project.ts";
import { cancel, listTasks, result } from "./tasks.ts";
import type { Outcome } from "./tasks.ts";
import { enclosingWorktree, locateRepository, nestedReason, ownGit, verifyWorktree } from "./worktree.ts";
import type { Repository } from "./worktree.ts";

// `cross-agent`, the operator's own entry point (design section 10): a table of verbs over
// one parser and one exit protocol. Each verb calls the function its tool calls, with the
// options the tool's handler passes, and a verb that only reads writes nothing: `tasks`
// lists without a reconciliation pass unless `--reconcile` asks for one, and `show` reports
// the stall `wait` and `check` wrote rather than taking a reading of its own. `init` writes
// the bind-time config for a mode; `answer` replies to an engine-placed lead's question
// without a host session; `report` renders the per-task log from the ledger, which is where
// that log comes from under engine placement. Every verb that writes is the operator's, and
// is refused inside a task's environment (`taskMarker`).

/** The exit protocol, one for every verb. */
export const EXIT = { ok: 0, error: 1, usage: 2, precondition: 3, running: 4, needsOperator: 5, stalled: 6 } as const;

/** The exit protocol as help prints it, in either form. */
const PROTOCOL: ReadonlyArray<{ code: number; meaning: string }> = [
  { code: EXIT.ok, meaning: "ok" },
  { code: EXIT.error, meaning: "error: something this command did not anticipate failed" },
  { code: EXIT.usage, meaning: "usage: the command line could not be read" },
  { code: EXIT.precondition, meaning: "precondition: the project, the mode, the ask or the task is not in the state the verb needs" },
  { code: EXIT.running, meaning: "still running: a task the verb names has not settled" },
  { code: EXIT.needsOperator, meaning: "needs the operator: a lead is waiting on an open ask" },
  { code: EXIT.stalled, meaning: "stalled: a task's engine has been silent past limits.stallMinutes" },
];

/** The codes whose text is the answer itself, and goes to stdout: a verdict, not a failure. */
const VERDICTS = new Set<number>([EXIT.ok, EXIT.running, EXIT.needsOperator, EXIT.stalled]);

/** Which project a verb reads when no `--project` names one. */
const PROJECT_RULE = "Without --project, init writes in the current directory, and every other verb reads the project "
  + "the server would find: CROSS_AGENT_PROJECT, then the nearest .cross-agent/config.json, then the git toplevel.";

/**
 * The variables `childEnv` sets to mark a task's process tree (`src/guard.ts#childEnv`). The
 * fourth one it sets, `CROSS_AGENT_PROJECT`, is no marker: it is also the operator's own way
 * to name a project (`PROJECT_RULE`).
 */
const TASK_MARKERS = ["CROSS_AGENT_TASK", "CROSS_AGENT_DEPTH", "CROSS_AGENT_LINEAGE"] as const;

export interface CliOutput {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface Parsed {
  positionals: string[];
  values: Record<string, string>;
  /** The flags given that take no value. */
  booleans: ReadonlySet<string>;
  /** What followed `--`, for a verb that takes a variadic tail; empty for every other verb. */
  rest: string[];
  json: boolean;
}

interface Context {
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
}

/** What a verb answers: its exit code, the one document `--json` prints, and what a person reads. */
interface Answer {
  code: number;
  document: unknown;
  text: string;
  /**
   * Where `text` goes without `--json`: stdout for an answer that carries a verdict — 0, 4,
   * 5 and 6 — and stderr for 1, 2 and 3, unless the verb says otherwise.
   */
  stream?: "stdout" | "stderr";
  /** For stderr whatever the code, and never under `--json`, where the document carries it. */
  notes?: string;
}

export interface Verb {
  /** The line usage prints for it, without the global flags. */
  usage: string;
  summary: string;
  positionals: string[];
  /** Positionals that may follow the required ones, in order. */
  optional?: string[];
  /** Value flags beyond `--project`, as `parseFlags` takes them. */
  flags: Record<string, string>;
  /** Flags that take no value, each given at most once. */
  booleans?: string[];
  /** A variadic tail, named: everything after `--`, verbatim and never read as flags, and at least one word of it. */
  rest?: string;
  /** A value on the command line this verb cannot read, judged before anything runs: a 2, as a wrong flag is. */
  check?(parsed: Parsed): string | null;
  /**
   * Whether this command line writes the project — a config, an ask, a record, a lock, git
   * metadata. Writing is an operator's power, refused inside a task's environment.
   */
  writes: boolean | ((parsed: Parsed) => boolean);
  run(parsed: Parsed, context: Context): Promise<Answer>;
}

/**
 * A command-line argument only the function it reaches can judge, refused there: a 2 like
 * any other command line this build cannot read, rather than the 1 of a throw.
 */
class UsageError extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refused(reason: string, document: unknown = { ok: false, reason }): Answer {
  return { code: EXIT.precondition, document, text: `cross-agent: ${reason}\n` };
}

/** The project every verb but `init` reads, found as the server finds it (design, "Which project"). */
async function project(parsed: Parsed, context: Context): Promise<{ root: string } | { reason: string }> {
  const named = parsed.values["--project"];
  return discoverProject(named === undefined ? [] : ["--project", named], context.env, context.cwd);
}

/**
 * A time as ISO-8601, or the number itself where no date can stand for it: the readers bound
 * a time by finiteness alone, and a renderer never throws on a time it was handed.
 */
function iso(at: number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? String(at) : date.toISOString();
}

/** A time as `iso` gives it, with how long ago it was where it is a date at all. */
function stamp(at: number, now: number): string {
  return Number.isNaN(new Date(at).getTime()) ? iso(at) : `${iso(at)} (${Math.max(0, Math.round((now - at) / 1000))}s ago)`;
}

/**
 * How long a task has run: to now while it is active, and to its settlement once it is not,
 * as `check` reckons `elapsedSeconds` (`src/tasks.ts#check`).
 */
function elapsedSeconds(task: { status: TaskStatus; createdAt: number; updatedAt: number }, now: number): number {
  const until = isTerminal(task.status) ? task.updatedAt : now;
  return Math.max(0, Math.round((until - task.createdAt) / 1000));
}

/** Seconds as a person reads a span: `45s`, `12m05s`, `3h04m`, `2d03h`. */
function span(seconds: number): string {
  const two = (value: number) => String(value).padStart(2, "0");
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m${two(seconds % 60)}s`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h${two(Math.floor(seconds / 60) % 60)}m`;
  return `${Math.floor(seconds / 86_400)}d${two(Math.floor(seconds / 3_600) % 24)}h`;
}

/** What runs a task, as one cell: `engine/model/effort`, `-` for what is not set. */
function runsOn(task: { engine: string; model?: string | null; effort?: string | null }): string {
  return `${task.engine}/${task.model ?? "-"}/${task.effort ?? "-"}`;
}

/** Rows as columns two spaces apart, each padded to its widest cell but the last. */
function columns(rows: string[][]): string {
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
  return rows.map((row) => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]))).join("  ").trimEnd())
    .map((line) => `${line}\n`).join("");
}

/** The words of `text` in lines of at most `width` characters, a longer word on a line of its own. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter((each) => each !== "")) {
    if (lines.length > 0 && `${lines[lines.length - 1]} ${word}`.length <= width) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  return lines;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0];
}

/** `--status` checked against the statuses the function it reaches filters by. */
function statusCheck(allowed: readonly string[]): (parsed: Parsed) => string | null {
  return (parsed) => {
    const status = parsed.values["--status"];
    return status === undefined || allowed.includes(status) ? null : `--status must be one of ${allowed.join(", ")}, not ${JSON.stringify(status)}`;
  };
}

/**
 * `--lines` as `check` takes it: a positive whole number, written as one. A count that is not
 * one has no reading, and `tailLines` would answer the whole window for it (`src/tasks.ts#check`).
 */
function linesCheck(parsed: Parsed): string | null {
  const value = parsed.values["--lines"];
  if (value === undefined || (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0)) return null;
  return `--lines must be a positive whole number, not ${JSON.stringify(value)}`;
}

function lineCount(parsed: Parsed, fallback: number): number {
  const value = parsed.values["--lines"];
  return value === undefined ? fallback : Number(value);
}

/**
 * The record `id` names, or null when it names none. An id outside the ledger's alphabet
 * names none either, and is answered as an unknown one is rather than thrown at
 * (`src/ledger.ts#find`, whose path refuses it).
 */
function taskNamed(root: string, id: string): TaskRecord | null {
  return isTaskId(id) ? find(root, id) : null;
}

/** A damaged ask file's reason, less the file name the mailbox already put at its head (`src/mailbox.ts#listAsks`). */
function askFault(file: string, reason: string): string {
  const named = `invalid ask ${file}: `;
  return reason.startsWith(named) ? reason.slice(named.length) : reason;
}

/** A journal's steps, one line each: when, which step, the SHAs around it, and what it ran. */
function journalSteps(journal: Journal): string[] {
  return journal.steps.map((entry) => [
    iso(entry.at), entry.step, `${entry.before ?? "-"}→${entry.after ?? "-"}`,
    ...(entry.defaultSha === undefined ? [] : [`defaultSha ${entry.defaultSha}`]),
    ...(entry.args === undefined ? [] : [`args ${entry.args.join(" ")}`]),
  ].join("  "));
}

const initVerb: Verb = {
  usage: "cross-agent init [--mode <name>] [--from <dir>] [--project <root>]",
  summary: "write .cross-agent/config.json, binding every role of a mode to an engine; in a worktree, its main checkout's config on the worktree's own branch",
  positionals: [],
  flags: { "--mode": "name", "--from": "dir" },
  writes: true,
  async run(parsed, context) {
    let root: string;
    try {
      // An existing directory, resolved before anything is written: `initConfig` creates
      // `.cross-agent/` with its parents, and a typo in `--project` would otherwise leave a
      // project tree somewhere nobody asked for one.
      root = fs.realpathSync(path.resolve(context.cwd, parsed.values["--project"] ?? "."));
      if (!fs.statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
    } catch (error) {
      return refused(`cannot resolve the project: ${message(error)}`);
    }
    // Every target is judged from outside it first, before its own `.git` is looked at: a
    // task worktree is never a project, whatever its pointer holds now (design section 10).
    const enclosure = await enclosingWorktree(root);
    if (enclosure !== null) return refused("reason" in enclosure ? enclosure.reason : nestedReason(root, enclosure));
    const dotGit = fs.lstatSync(path.join(root, ".git"), { throwIfNoEntry: false });
    if (dotGit !== undefined && !dotGit.isDirectory()) {
      // A pointer file or a link. A linked worktree is initialized on its own branch. A
      // checkout whose git directory lies outside it — a separated main's, a submodule, a
      // `.git` linking to the root's git directory — is a work tree by its own git, and
      // takes the mode's defaults below as any main checkout does. Anything else is no project.
      const located = await locateRepository(root);
      if (located.kind === "linked" || located.kind === "bare-linked") return initWorktree(root, located, parsed, context);
      if (located.kind === "refused") return refused(`init makes no project of a root its repository refuses: ${located.reason}`);
      if (located.kind === "unsupported") {
        let workTree = false;
        try {
          workTree = (await ownGit(root)).workTree;
        } catch { /* a git that cannot say is no work tree's */ }
        if (!workTree) return refused(`init makes no project of an unsupported root that is no work tree: ${located.reason}`);
      }
    }
    if (parsed.values["--from"] !== undefined) {
      return refused(`--from copies a project's config into a worktree of its repository, and ${root} is ${dotGit === undefined ? "no repository's checkout" : "a main checkout"}, where init writes the mode's own`);
    }
    if (dotGit?.isDirectory()) {
      // A bare repository at `.git` makes the directory holding it no work tree of it.
      const located = await locateRepository(root);
      if (located.kind === "unsupported") return refused(`init makes no project of an unsupported root that is no work tree: ${located.reason}`);
    }
    const mode = parsed.values["--mode"] ?? DEFAULT_MODE;
    try {
      // The mode first, so a name this build has no mode for, or a mode that does not
      // validate, is the precondition it is rather than an error halfway through a write.
      loadMode(builtInModesDir(), mode);
    } catch (error) {
      return refused(message(error));
    }
    const result = initConfig(root, { mode });
    const file = path.join(root, CONFIG_PATH);
    const lines = [result.wrote ? `cross-agent: wrote ${file} for mode ${mode}` : `cross-agent: ${file} already exists; nothing was written`];
    if (result.ignored.length > 0) lines.push(`cross-agent: added ${result.ignored.join(", ")} to ${path.join(root, ".gitignore")}`);
    return {
      code: EXIT.ok,
      document: { wrote: result.wrote, file, mode, ignored: result.ignored, ...(result.warning === undefined ? {} : { warning: result.warning }) },
      text: `${lines.join("\n")}\n`,
      ...(result.warning === undefined ? {} : { notes: `cross-agent: ${result.warning}\n` }),
    };
  },
};

/**
 * `init` at a worktree, which makes it a project of its own on the branch it has checked
 * out (design section 10). The config is copied from `--from`, or from the main checkout when
 * that holds one, and is the mode's defaults otherwise; every refusal comes before anything
 * is written.
 */
async function initWorktree(root: string, located: Repository, parsed: Parsed, context: Context): Promise<Answer> {
  const branch = located.branch;
  if (branch === null) return refused(`${root} has a detached HEAD, which names no branch to make the project's default; check out its branch first`);
  if (nameFault(branch) !== null) {
    return refused(`${root} has ${branch} checked out, a name git_root would refuse in every read of the default branch: a branch here is letters, digits, ".", "_", "/" and "-", with no ".." and no trailing "/" or ".lock"`);
  }
  const named = parsed.values["--mode"];
  const from = parsed.values["--from"];
  let source: string | undefined;
  if (from !== undefined) {
    try {
      source = fs.realpathSync(path.resolve(context.cwd, from));
    } catch (error) {
      return refused(`cannot resolve --from ${from}: ${message(error)}`);
    }
    if (!holdsConfig(source)) return refused(`--from ${source} holds no ${CONFIG_PATH}`);
  } else if (located.main !== null) {
    if (holdsConfig(located.main)) source = located.main;
  } else if (located.kind === "linked" && named === undefined) {
    return refused(`${root} is a worktree of a main checkout whose git directory is separated, and git records no path to that checkout: pass --from <main checkout> to copy its config, or --mode for the defaults`);
  }
  if (source !== undefined && named !== undefined) {
    throw new UsageError(`--mode names the defaults, and ${path.join(source, CONFIG_PATH)} is the config init copies here; give one of them`);
  }
  let copy: CrossAgentConfig | undefined;
  try {
    if (source !== undefined) copy = loadConfig(source);
  } catch (error) {
    return refused(message(error));
  }
  const modeName = copy?.mode ?? named ?? DEFAULT_MODE;
  let mode: Mode;
  try {
    mode = loadMode(builtInModesDir(), modeName);
  } catch (error) {
    return refused(message(error));
  }
  // Settled once the mode is: every root verb, the verifier's row 2 and a sibling project's
  // journaled `branch -d` act on the task pattern, so a project's own branch is never a task's.
  const pattern = gitPolicy(mode).branchPattern;
  if (matchesPattern(branch, pattern)) {
    return refused(`${root} has ${branch} checked out, which mode ${mode.id}'s task branch pattern ${pattern} matches: a project's default branch is never a task's, so check out another branch first`);
  }
  const result = initConfig(root, { mode: modeName, defaultBranch: branch, ...(copy === undefined ? {} : { copy }) });
  const attach = source === undefined ? null : copyGrokAttach(source, root);
  const ignored = [...result.ignored, ...(attach?.copied === true ? ignoreEntries(root, [".grok/"]) : [])];
  const file = path.join(root, CONFIG_PATH);
  const origin = source === undefined ? null : path.join(source, CONFIG_PATH);
  const lines = [result.wrote
    ? `cross-agent: wrote ${file} from ${origin ?? `mode ${mode.id}'s defaults`}, its default branch ${branch}`
    : `cross-agent: ${file} already exists; nothing was written`];
  if (ignored.length > 0) lines.push(`cross-agent: added ${ignored.join(", ")} to ${path.join(root, ".gitignore")}`);
  if (attach?.copied === true) {
    lines.push(`cross-agent: copied ${attach.from} to ${attach.to}; Grok loads it only in a folder it trusts, and cross-agent never edits ~/.grok/trusted_folders.toml: trust ${root} there or at Grok's own prompt`);
  }
  const notes = [
    ...(result.warning === undefined ? [] : [result.warning]),
    ...(attach !== null && !attach.copied ? [`${attach.to} not written: ${attach.why}`] : []),
  ].map((note) => `cross-agent: ${note}\n`).join("");
  return {
    code: EXIT.ok,
    document: {
      wrote: result.wrote, file, mode: mode.id, defaultBranch: branch, from: origin, ignored,
      ...(attach === null ? {} : { attach }), ...(result.warning === undefined ? {} : { warning: result.warning }),
    },
    text: `${lines.join("\n")}\n`,
    ...(notes === "" ? {} : { notes }),
  };
}

/** What became of the Grok attach a worktree project's source holds. */
type Attach = { copied: true; from: string; to: string } | { copied: false; from: string; to: string; why: string };

/**
 * The source's Grok attach, `.grok/config.toml`, copied byte for byte into the worktree, or
 * why it was not; null where the source holds none (design section 10). It is host
 * configuration, which Grok loads in the operator's own session, so it moves as a regular
 * file and never through a link: both directories and the file are judged by `lstat`,
 * nothing already at the destination is replaced — a dangling link included — and the file
 * is created exclusively, which fails on a link at that path. A source that binds a project
 * through `--project` or `CROSS_AGENT_PROJECT` is not copied: an explicit binding outranks
 * the working directory, so its copy would serve that project from this worktree.
 */
function copyGrokAttach(source: string, root: string): Attach | null {
  const sourceDir = path.join(source, ".grok");
  const from = path.join(sourceDir, "config.toml");
  const toDir = path.join(root, ".grok");
  const to = path.join(toDir, "config.toml");
  const not = (why: string): Attach => ({ copied: false, from, to, why });
  const kind = (entry: fs.Stats) => (entry.isSymbolicLink() ? "a symbolic link" : entry.isDirectory() ? "a directory" : "no regular file");
  const directory = fs.lstatSync(sourceDir, { throwIfNoEntry: false });
  if (directory === undefined) return null;
  if (!directory.isDirectory()) return not(`${sourceDir} is ${kind(directory)}, and host configuration is copied from regular files only`);
  const file = fs.lstatSync(from, { throwIfNoEntry: false });
  if (file === undefined) return null;
  if (!file.isFile()) return not(`${from} is ${kind(file)}, and host configuration is copied from regular files only`);
  const bytes = fs.readFileSync(from);
  const bindings = bytes.toString("utf8").split("\n").map((line) => line.trim())
    .filter((line) => line.includes("--project") || line.includes("CROSS_AGENT_PROJECT"));
  if (bindings.length > 0) {
    return not(`${from} binds a project — ${bindings.join("; ")} — and an explicit binding outranks the working directory, so a copy would serve that project from this worktree; set Grok's attach up for this worktree by hand`);
  }
  const destination = fs.lstatSync(toDir, { throwIfNoEntry: false });
  if (destination === undefined) fs.mkdirSync(toDir);
  else if (!destination.isDirectory()) return not(`${toDir} is ${kind(destination)}, left alone`);
  if (fs.lstatSync(to, { throwIfNoEntry: false }) !== undefined) return not(`${to} already exists, left alone`);
  const descriptor = fs.openSync(to, "wx");
  try {
    fs.writeFileSync(descriptor, bytes);
  } finally {
    fs.closeSync(descriptor);
  }
  return { copied: true, from, to };
}

/** One installed mode as `modes` lists it, or the reason its directory does not load. */
type ListedMode =
  | {
    id: string; release: string; name: string; summary: string; lead: ModeLead;
    roles: Array<{ key: string; title: string; workspace: Workspace; sandboxDefault: SandboxProfile }>;
    active: boolean;
  }
  | { id: string; reason: string };

const modesVerb: Verb = {
  usage: "cross-agent modes [--project <root>]",
  summary: "the installed modes, the active one marked, each with its roles",
  positionals: [],
  flags: {},
  writes: false,
  async run(parsed, context) {
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    // The name `describe_mode` reads, from the config or, with none, the mode a project
    // with no config runs as (`src/config.ts#defaultConfig`).
    let active: string;
    try {
      active = loadConfig(found.root).mode;
    } catch (error) {
      return refused(message(error));
    }
    const shelf = builtInModesDir();
    // A directory that does not load is listed with its reason: a broken mode is reported,
    // not hidden.
    const listed = fs.readdirSync(shelf, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .map((name): ListedMode => {
        try {
          const mode = loadMode(shelf, name);
          return {
            id: mode.id, release: mode.release, name: mode.name, summary: mode.summary, lead: mode.lead,
            roles: mode.roles.map((role) => ({ key: role.key, title: role.title, workspace: role.workspace, sandboxDefault: role.sandboxDefault })),
            active: mode.id === active,
          };
        } catch (error) {
          return { id: name, reason: message(error) };
        }
      });
    const installed = listed.some((entry) => !("reason" in entry) && entry.id === active);
    const text = listed.map((entry) => {
      if ("reason" in entry) return `  ${entry.id}: ${entry.reason}\n`;
      return `${entry.active ? "*" : " "} ${entry.id} ${entry.release} — ${entry.name}\n`
        + wrap(entry.summary, 92).map((line) => `    ${line}\n`).join("")
        + "    roles:\n"
        + entry.roles.map((role) => `      ${role.key} (${role.workspace.kind}, ${role.sandboxDefault})\n`).join("");
    }).join("");
    if (installed) return { code: EXIT.ok, document: { active, installed, modes: listed }, text };
    // The config names a mode this build does not have, so every verb that loads it refuses;
    // the listing is still the answer to what is installed, and the reason says what to fix.
    const broken = listed.find((entry) => "reason" in entry && entry.id === active);
    const reason = broken !== undefined && "reason" in broken ? broken.reason
      : `mode ${JSON.stringify(active)} in ${path.join(found.root, CONFIG_PATH)} is not installed; this build has `
        + listed.filter((entry) => !("reason" in entry)).map((entry) => entry.id).join(", ");
    return {
      code: EXIT.precondition, document: { active, installed, modes: listed, reason }, text,
      stream: "stdout", notes: `cross-agent: ${reason}\n`,
    };
  },
};

const tasksVerb: Verb = {
  usage: "cross-agent tasks [--status <status>] [--reconcile] [--project <root>]",
  summary: "every task, newest first, as the ledger holds it; --reconcile runs list_tasks' reconciliation pass first",
  positionals: [],
  flags: { "--status": "status" },
  booleans: ["--reconcile"],
  check: statusCheck(taskStatuses),
  // The reconciling read writes what `list_tasks` would; the plain one writes nothing.
  writes: (parsed) => parsed.booleans.has("--reconcile"),
  async run(parsed, context) {
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    const reconcile = parsed.booleans.has("--reconcile");
    // Without the flag a read and only a read: no pass, so nothing is settled, killed or
    // locked, and what the next pass would settle is shown as it stands (`src/tasks.ts#listTasks`).
    const listed = await listTasks(found.root, parsed.values["--status"] as TaskStatus | undefined, { reconcile });
    // A task view carries no identity, so whether a runner still lives is one more read of
    // the records the listing viewed, and a `/proc` read per active one.
    const records = new Map(scan(found.root).records.map((record) => [record.id, record]));
    const now = Date.now();
    const lines: string[] = [];
    if (listed.tasks.length === 0) lines.push("no tasks\n");
    else {
      lines.push(columns([
        ["id", "status", "role", "engine/model/effort", "depth", "age", "cwd"],
        ...listed.tasks.map((task) => {
          // A launching record names no runner yet; any other active one whose runner is not
          // alive is what the next reconciliation pass settles.
          const gone = !isTerminal(task.status) && task.status !== "launching" && !isProcessAlive(records.get(task.id)?.runnerIdentity);
          return [
            task.id, gone ? `${task.status} (runner gone)` : task.status, task.role, runsOn(task), String(task.depth),
            span(elapsedSeconds(task, now)), task.cwd,
          ];
        }),
      ]));
    }
    lines.push(...listed.invalid.map((entry) => `invalid task record ${entry.file}: ${entry.reason}\n`));
    lines.push(...listed.errors.map((entry) => `not judged: task ${entry.id}: ${entry.reason}\n`));
    lines.push(...listed.skipped.map((entry) => `not cleaned up: task ${entry.id}: ${entry.reason}\n`));
    lines.push(reconcile ? "reconciled\n" : "not reconciled: pass --reconcile\n");
    return { code: EXIT.ok, document: { ...listed, reconciled: reconcile }, text: lines.join("") };
  },
};

const showVerb: Verb = {
  usage: "cross-agent show <id> [--lines <n>] [--project <root>]",
  summary: "one task: its record, its last activity, its outcome, its journal and its final message",
  positionals: ["id"],
  flags: { "--lines": "n" },
  check: linesCheck,
  writes: false,
  async run(parsed, context) {
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    const [id] = parsed.positionals;
    // What `check` and `result` read, and no stall reading: the status is the one the last
    // `wait` or `check` wrote, because those two are the stall clock's only readers and
    // this command writes nothing (design, "Time limits").
    const record = taskNamed(found.root, id);
    if (record === null) return refused(`no task ${id}`);
    const now = Date.now();
    // Everything shown is this one record's: an unsettled one has no final message whatever
    // its result file holds, and `result` reads the record again, so a runner that settled
    // between the two reads would put its message beside a `running` status.
    const settled = isTerminal(record.status) ? result(found.root, record.id) : null;
    const runnerLog = runnerLogPath(found.root, record.id);
    // A journal that does not read is named beside the record rather than in its place: the
    // record is what the operator came to read, and the journal's file is theirs to repair.
    let journal: Journal | null = null;
    let journalError: string | undefined;
    if (record.worktree !== undefined) {
      try {
        journal = readJournal(found.root, record.worktree.slug);
      } catch (error) {
        journalError = message(error);
      }
    }
    const document: {
      record: TaskRecord; elapsedSeconds: number; lastActivity: string[]; result: string | null;
      outcome: TaskOutcome | null; journal: Journal | null; journalError?: string; runnerLog: string;
    } = {
      record,
      elapsedSeconds: elapsedSeconds(record, now),
      lastActivity: tailLines(record.logPath, lineCount(parsed, 10)),
      result: settled !== null && settled.ok && "result" in settled ? settled.result : null,
      outcome: readOutcome(found.root, record),
      journal,
      ...(journalError === undefined ? {} : { journalError }),
      runnerLog,
    };

    const lines: string[] = [];
    const field = (name: string, value: string | number | null | undefined) => {
      if (value !== undefined && value !== null) lines.push(`${name}: ${value}\n`);
    };
    field("id", record.id);
    field("status", record.status);
    field("role", record.role);
    field("engine", runsOn(record));
    field("depth", record.depth ?? 0);
    field("parentTaskId", record.parentTaskId);
    field("resumedFrom", record.resumedFrom);
    field("cwd", record.cwd);
    if (record.worktree !== undefined) field("worktree", `${record.worktree.path} on ${record.worktree.branch}, slug ${record.worktree.slug}`);
    field("createdAt", stamp(record.createdAt, now));
    field("updatedAt", stamp(record.updatedAt, now));
    if (typeof record.acknowledgedAt === "number") field("acknowledgedAt", stamp(record.acknowledgedAt, now));
    if (typeof record.lastEventAt === "number") field("lastEventAt", stamp(record.lastEventAt, now));
    if (record.runnerIdentity) {
      const gone = !isTerminal(record.status) && !isProcessAlive(record.runnerIdentity);
      field("runner", `pid ${record.runnerIdentity.pid}${gone ? " (gone)" : ""}`);
    }
    if (record.engineIdentity) field("engine process", `pid ${record.engineIdentity.pid}, group ${record.engineIdentity.pgid}`);
    field("sessionId", record.sessionId);
    field("exitCode", record.exitCode);
    field("reason", record.reason);
    if (record.truncated === true) field("truncated", "true: the engine's output may be missing its tail");
    field("log", record.logPath);
    field("runner log", runnerLog);
    field("result", record.resultPath);
    lines.push(document.lastActivity.length === 0 ? "\nno activity yet\n"
      : `\nlast activity:\n${document.lastActivity.map((line) => `  ${line}\n`).join("")}`);
    if (document.outcome !== null) {
      const { kind, exitCode, sessionId, reason, truncated, at } = document.outcome;
      lines.push(`\noutcome: ${[kind, `exit ${exitCode ?? "-"}`, `session ${sessionId ?? "-"}`, `at ${iso(at)}`,
        ...(reason === undefined ? [] : [`reason ${reason}`]), ...(truncated === true ? ["truncated"] : [])].join(", ")}\n`);
    }
    if (document.journal !== null) {
      lines.push(`\njournal ${document.journal.slug} on ${document.journal.branch}:\n${journalSteps(document.journal).map((line) => `  ${line}\n`).join("")}`);
    }
    if (isTerminal(record.status)) {
      lines.push(document.result === null ? "\nfinal message: no result file\n" : `\nfinal message:\n${document.result.replace(/\n*$/, "\n")}`);
    }
    const code = isTerminal(record.status) ? EXIT.ok : record.status === "stalled" ? EXIT.stalled : EXIT.running;
    return { code, document, text: lines.join(""), ...(journalError === undefined ? {} : { notes: `cross-agent: ${journalError}\n` }) };
  },
};

const logVerb: Verb = {
  usage: "cross-agent log <id> [--lines <n>] [--project <root>]",
  summary: "the last lines of one task's engine event stream, as the engine wrote them",
  positionals: ["id"],
  flags: { "--lines": "n" },
  check: linesCheck,
  writes: false,
  async run(parsed, context) {
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    const [id] = parsed.positionals;
    const record = taskNamed(found.root, id);
    if (record === null) return refused(`no task ${id}`);
    // A task whose engine has said nothing yet has an empty log, and that is an answer.
    const lines = tailLines(record.logPath, lineCount(parsed, 50));
    return { code: EXIT.ok, document: { id: record.id, logPath: record.logPath, lines }, text: lines.map((line) => `${line}\n`).join("") };
  },
};

/**
 * An outcome the cascade finished with: the task is settled, by this cancel or before it.
 * Any other outcome — an active status, or `unknown` for a record the cascade could not
 * read back — is a task a second cancel retries.
 */
function settledOutcome(outcome: Outcome): boolean {
  return outcome.outcome.startsWith("already ") || isTerminal(outcome.outcome as TaskStatus);
}

const cancelVerb: Verb = {
  usage: "cross-agent cancel <id> [--project <root>]",
  summary: "cancel a task and every task it delegated, leaves first, and its lineage's open asks",
  positionals: ["id"],
  flags: {},
  writes: true,
  async run(parsed, context) {
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    const [id] = parsed.positionals;
    // A task nobody has is answered as `cancel` answers it, and before its lock.
    if (!scan(found.root).records.some((record) => record.id === id)) return refused(`no task ${id}`);
    // The operator's cancel names no lead, so any task of the project, as the tool cancels
    // for the operator row.
    const cancelled = await cancel(found.root, id);
    if (!cancelled.ok) return refused(cancelled.reason, cancelled);
    const lines = cancelled.outcomes.map((entry) => `${entry.id} ${entry.outcome}${entry.reason === undefined ? "" : ` — ${entry.reason}`}\n`);
    lines.push(`asks cancelled: ${cancelled.asksCancelled.length === 0 ? "none" : cancelled.asksCancelled.join(", ")}\n`);
    // An ask file a cancel could not write is the operator's to repair by hand, and changes
    // no verdict: the cascade's own outcomes are the answer.
    for (const entry of cancelled.asksNotCancelled ?? []) {
      lines.push(`ask not cancelled ${"id" in entry ? `${entry.id}: ${entry.reason}` : `${entry.file}: ${askFault(entry.file, entry.reason)}`}\n`);
    }
    // A task still active after the cascade is what a second cancel retries.
    const code = cancelled.outcomes.every(settledOutcome) ? EXIT.ok : EXIT.running;
    return { code, document: cancelled, text: lines.join("") };
  },
};

const verifyWorktreeVerb: Verb = {
  usage: "cross-agent verify-worktree <path> <branch> [--project <root>]",
  summary: "verify a linked worktree and its exact branch, as verify_worktree does",
  positionals: ["path", "branch"],
  flags: {},
  writes: false,
  async run(parsed, context) {
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    const [target, branch] = parsed.positionals;
    // No drift check: the tool's compares the config with the mode its server serves, and
    // this command serves none.
    const verified = await verifyWorktree(found.root, path.resolve(context.cwd, target), branch);
    if ("reason" in verified) return { code: EXIT.precondition, document: verified, text: `refused: ${verified.reason}\n` };
    return {
      code: EXIT.ok, document: verified,
      text: `verified: ${verified.workTree} on ${verified.branch}\ngit dir: ${verified.gitDir}\ncommon dir: ${verified.commonDir}\n`,
    };
  },
};

const gitVerb: Verb = {
  usage: "cross-agent git <slug> [--path <dir>] [--branch <name>] [--project <root>] -- <git arguments…>",
  summary: "one git subcommand in a verified worktree, under the project's locks and journaled, as git_mutate runs it",
  positionals: ["slug"],
  rest: "git arguments",
  flags: { "--path": "dir", "--branch": "name" },
  writes: true,
  async run(parsed, context) {
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    // The policy the tool acts under: the mode's own, or the implicit one a mode with no
    // worktree role uses (`src/modes.ts#gitPolicy`).
    let policy: EffectiveGitPolicy;
    try {
      policy = gitPolicy(loadConfigWithMode(found.root).mode);
    } catch (error) {
      return refused(message(error));
    }
    const [slug] = parsed.positionals;
    const where = parsed.values["--path"];
    const branch = parsed.values["--branch"];
    const request: GitMutateRequest = {
      slug, args: parsed.rest,
      // A path on the operator's command line is the operator's, read against the working directory.
      ...(where === undefined ? {} : { path: path.resolve(context.cwd, where) }),
      ...(branch === undefined ? {} : { branch }),
    };
    const ran = await gitMutate(found.root, request, {
      waitSeconds: lockWaitSeconds(found.root), dir: policy.worktreeDir, branchPattern: policy.branchPattern,
    });
    return gitAnswer(ran);
  },
};

/** What `git` and `git-root` answer, by one rule, from the answer of the tool each one calls. */
function gitAnswer(ran: GitMutateResult | GitRootResult): Answer {
  const own = (text: string | undefined) => (text === undefined || text === "" || text.endsWith("\n") ? text ?? "" : `${text}\n`);
  if (ran.ok) {
    const journaled = ran.journal !== undefined;
    const notes = own(ran.stderr) + (ran.lockLost
      ? `cross-agent: lock lost while git ran: the command is done${journaled ? " and journaled" : ""}, but another mutation or a delegation may have run beside it\n`
      : "");
    const step = ran.journal === undefined ? "" : `journal: ${ran.journal.step} ${ran.journal.before ?? "-"}→${ran.journal.after ?? "-"}\n`;
    return { code: EXIT.ok, document: ran, text: `${own(ran.stdout)}${step}`, ...(notes === "" ? {} : { notes }) };
  }
  // git ran and said so: its exit code is the answer's, and so are its own words. A step
  // that could not be journaled after a zero exit carries that zero, and is the same 1.
  if (ran.exitCode !== undefined) {
    return { code: EXIT.error, document: ran, text: own(ran.stdout), stream: "stdout", notes: `${own(ran.stderr)}cross-agent: ${ran.reason}\n` };
  }
  // Everything else is a refusal before git ran.
  return refused(ran.reason, ran);
}

const gitRootVerb: Verb = {
  usage: "cross-agent git-root [--slug <slug>] [--project <root>] -- <git arguments…>",
  summary: "one whitelisted git verb at the project root, under the project's locks and the repository lock, journaled as git_root runs it",
  positionals: [],
  rest: "git arguments",
  flags: { "--slug": "slug" },
  // Every call takes `git.lock`, which writes the ledger's exclusions and the lock directory
  // (`src/ledger.ts#projectLock`), so a read here writes the project too, and is refused
  // inside a task's environment: a task reads the root through the tool.
  writes: true,
  async run(parsed, context) {
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    let policy: EffectiveGitPolicy;
    try {
      policy = gitPolicy(loadConfigWithMode(found.root).mode);
    } catch (error) {
      return refused(message(error));
    }
    const slug = parsed.values["--slug"];
    return gitAnswer(await gitRoot(found.root, { args: parsed.rest, ...(slug === undefined ? {} : { slug }) }, {
      waitSeconds: lockWaitSeconds(found.root), dir: policy.worktreeDir, branchPattern: policy.branchPattern,
    }));
  },
};

const journalVerb: Verb = {
  usage: "cross-agent journal [<slug>] [--project <root>]",
  summary: "one task's git journal, step by step, or with no slug the slug of every journal",
  positionals: [],
  optional: ["slug"],
  flags: {},
  writes: false,
  async run(parsed, context) {
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    const [slug] = parsed.positionals;
    if (slug === undefined) {
      const slugs = listJournals(found.root);
      return { code: EXIT.ok, document: { slugs }, text: slugs.map((each) => `${each}\n`).join("") };
    }
    let journal: Journal | null;
    try {
      journal = readJournal(found.root, slug);
    } catch (error) {
      // A slug the journal refuses to name a file by is a command line this build cannot
      // read (`src/journal.ts#journalFile`); any other throw is a journal that does not read,
      // which names its file for the operator to repair, and is the 1 it is.
      if (message(error).startsWith("invalid slug ")) throw new UsageError(message(error));
      throw error;
    }
    if (journal === null) return refused(`no journal ${slug}`);
    const fields = [
      `slug: ${journal.slug}\n`, `branch: ${journal.branch}\n`,
      ...(journal.worktree === undefined ? [] : [`worktree: ${journal.worktree}\n`]),
      `defaultBranch: ${journal.defaultBranch}\n`,
      ...(journal.defaultShaBeforeMerge === undefined ? [] : [`defaultShaBeforeMerge: ${journal.defaultShaBeforeMerge}\n`]),
      ...(journal.branchHead === undefined ? [] : [`branchHead: ${journal.branchHead}\n`]),
    ];
    return { code: EXIT.ok, document: journal, text: `${fields.join("")}steps:\n${journalSteps(journal).map((line) => `  ${line}\n`).join("")}` };
  },
};

const listAsksVerb: Verb = {
  usage: "cross-agent list-asks [--status <open|answered|cancelled>] [--project <root>]",
  summary: "the questions engine-placed leads have put to the operator, in the order asked",
  positionals: [],
  flags: { "--status": "status" },
  check: statusCheck(askStatuses),
  writes: false,
  async run(parsed, context) {
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    const status = parsed.values["--status"] as AskStatus | undefined;
    // The operator's listing: every ask, as `list_asks` answers the operator row.
    const listed = listAsks(found.root, status === undefined ? {} : { status });
    const now = Date.now();
    const text = listed.asks.map((ask) => `${ask.id}  ${ask.status}  task ${ask.taskId}  ${stamp(ask.createdAt, now)}  ${firstLine(ask.question)}\n`
      + (ask.status === "answered" && ask.answer !== undefined && ask.answeredAt !== undefined
        ? `    answer: ${firstLine(ask.answer)}  answeredAt ${stamp(ask.answeredAt, now)}\n`
        : "")).join("");
    // A damaged file is named, never thrown: the asks that do read are still the answer, and
    // the file is the operator's to repair or remove by hand.
    const notes = listed.invalid.map((entry) => `cross-agent: invalid ask file ${entry.file}: ${askFault(entry.file, entry.reason)}`
      + `${entry.taskId === undefined ? "" : ` (task ${entry.taskId})`}\n`).join("");
    // An open ask in what this command printed is a lead waiting on the operator; the
    // filter scopes the verdict as it scopes the listing.
    const code = listed.asks.some((ask) => ask.status === "open") ? EXIT.needsOperator : EXIT.ok;
    return { code, document: listed, text, ...(notes === "" ? {} : { notes }) };
  },
};

const answerVerb: Verb = {
  usage: "cross-agent answer <ask-id> <text> [--project <root>]",
  summary: "answer an engine-placed lead's open question; the first answer stands",
  positionals: ["ask-id", "text"],
  flags: {},
  writes: true,
  async run(parsed, context) {
    const [id, text] = parsed.positionals;
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    // Discovery falls back to a git toplevel with no config, which runs solo and asks
    // nothing: an ask file left there belongs to no lead this project can run, and
    // answering it would write in a project nobody configured. Checked before any write.
    const configFile = path.join(found.root, CONFIG_PATH);
    if (!fs.existsSync(configFile)) return refused(`${found.root} holds no ${CONFIG_PATH}: no engine-placed lead of this project asks anything`);
    try {
      loadConfig(found.root);
    } catch (error) {
      return refused(message(error));
    }
    // An id that could not name a file names no ask either, and `answerAsk` says so by
    // value through the mailbox's own predicate (`src/mailbox.ts#isAskId`).
    const answered = await answerAsk(found.root, id, text);
    if (!answered.applied) return refused(answered.reason, answered);
    const { ask } = answered;
    return {
      code: EXIT.ok, document: answered,
      text: `cross-agent: answered ask ${ask.id} of task ${ask.taskId} at ${iso(ask.answeredAt!)}\n`
        + `  question: ${ask.question}\n  answer: ${ask.answer}\n`,
    };
  },
};

/** One task as the report renders it, in either form. */
interface ReportedTask {
  id: string;
  role: string;
  engine: string;
  model: string | null;
  effort: string | null;
  status: TaskRecord["status"];
  durationSeconds: number;
  /** `passed` for done, `failed` for failed or cancelled, `unknown` until it settles or when its result file is missing. */
  outcome: "passed" | "failed" | "unknown";
  /** The final message in full, or null where there is no result file. */
  result: string | null;
}

/**
 * A final message as the report prints it: every line indented four spaces under its
 * heading, a blank line left blank, so the rows above are the only column-0 lines that hold
 * ` | ` and a Markdown table inside a message is never read as one of them.
 */
function indented(message: string): string {
  return message.replace(/\n+$/, "").split("\n").map((line) => (line === "" ? "" : `    ${line}`)).join("\n");
}

function reported(record: TaskRecord, now: number): ReportedTask {
  let result: string | null = null;
  try {
    result = fs.readFileSync(record.resultPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const terminal = isTerminal(record.status);
  const outcome = !terminal || result === null ? "unknown" : record.status === "done" ? "passed" : "failed";
  return {
    id: record.id, role: record.role, engine: record.engine, model: record.model ?? null, effort: record.effort ?? null,
    // A settled task's duration stops at its settlement, as `check` reports it.
    status: record.status, durationSeconds: elapsedSeconds(record, now), outcome, result,
  };
}

const reportVerb: Verb = {
  usage: "cross-agent report [--since <task id>] [--project <root>]",
  summary: "every task, newest first — role, engine, model, effort, duration, outcome, id — then each final message",
  positionals: [],
  flags: { "--since": "task id" },
  writes: false,
  async run(parsed, context) {
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    // A read and only a read: no reconciliation pass, and nothing created where no ledger is.
    const { records, invalid } = scan(found.root);
    let chosen = records;
    const since = parsed.values["--since"];
    if (since !== undefined) {
      const from = records.find((record) => record.id === since);
      if (from === undefined) return refused(`no task ${since}`);
      chosen = records.filter((record) => record.createdAt >= from.createdAt);
    }
    const now = Date.now();
    const tasks = chosen
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
      .map((record) => reported(record, now));
    const rows = tasks.map((task) => [
      task.role, task.engine, task.model ?? "-", task.effort ?? "-", `${task.durationSeconds}s`, task.outcome, task.id,
    ].join(" | "));
    const messages = tasks.map((task) => {
      const body = indented(task.result ?? "(no result file)");
      return `## ${task.id} — ${task.role}, ${task.outcome}\n${body === "" ? "" : `\n${body}\n`}`;
    });
    return {
      code: EXIT.ok,
      document: { tasks, ...(invalid.length === 0 ? {} : { invalid }) },
      text: tasks.length === 0 ? "" : `${rows.join("\n")}\n\n${messages.join("\n")}`,
      ...(invalid.length === 0 ? {} : { notes: invalid.map((entry) => `cross-agent: invalid task record ${entry.file}: ${entry.reason}\n`).join("") }),
    };
  },
};

/** The verbs, in the order usage lists them. */
const verbs: Record<string, Verb> = {
  init: initVerb,
  modes: modesVerb,
  tasks: tasksVerb,
  show: showVerb,
  log: logVerb,
  cancel: cancelVerb,
  "verify-worktree": verifyWorktreeVerb,
  git: gitVerb,
  "git-root": gitRootVerb,
  journal: journalVerb,
  "list-asks": listAsksVerb,
  answer: answerVerb,
  report: reportVerb,
};

/** Every verb's name, in the order usage lists them: what the docs are held to (`tests/cli.test.ts#cliDocsNameVerbs`). */
export const VERB_NAMES: readonly string[] = Object.freeze(Object.keys(verbs));

/** The usage lines for one verb, or for the whole table: what a 2 prints, as text or as JSON. */
function usageLines(verb?: Verb): string[] {
  if (verb !== undefined) {
    // The global flags go before a tail's `--`, because every word after it is the tail's.
    const tail = verb.rest === undefined ? -1 : verb.usage.indexOf(" -- ");
    return [tail === -1 ? `${verb.usage} [--json] [--help]` : `${verb.usage.slice(0, tail)} [--json] [--help]${verb.usage.slice(tail)}`];
  }
  return ["cross-agent <verb> [arguments] [--project <root>] [--json] [--help]", ...Object.values(verbs).map((each) => each.usage)];
}

function usageOf(verb?: Verb): string {
  const [first, ...rest] = usageLines(verb);
  return `usage: ${first}\n${rest.map((line) => `  ${line}\n`).join("")}`;
}

/** Help, as text or as the one JSON document `--json` asks for: the same verbs, rule and protocol. */
function help(json: boolean): string {
  const usage = usageLines()[0];
  if (json) {
    const document = {
      ok: true, usage, verbs: Object.values(verbs).map((verb) => ({ usage: verb.usage, summary: verb.summary })),
      json: "--json prints one JSON document on stdout, whatever the exit", project: PROJECT_RULE, exit: PROTOCOL,
    };
    return `${JSON.stringify(document, null, 2)}\n`;
  }
  // The rule wrapped as the rest of the help is, at the width it always had.
  const lines = wrap(`--json prints one JSON document on stdout, whatever the exit; --help prints this. ${PROJECT_RULE}`, 96);
  return `usage: ${usage}\n\n`
    + Object.values(verbs).map((verb) => `  ${verb.usage}\n      ${verb.summary}\n`).join("")
    + `\n${lines.join("\n")}\n\n`
    + `exit codes:\n${PROTOCOL.map((entry) => `  ${entry.code}  ${entry.meaning}`).join("\n")}\n`;
}

/** Whether the command line asks for JSON: `--json` anywhere before a `--` that ends the flags. */
function wantsJson(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes("--json");
}

/**
 * The verb, and every other token in the order given: the global flags (`--json`, `--help`,
 * `--project <root>`) may come before the verb as well as after it.
 */
function split(argv: readonly string[]): { verb?: string; rest: string[] } {
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--json" || token === "--help") {
      rest.push(token);
    } else if (token === "--project") {
      rest.push(token, ...argv.slice(index + 1, index + 2));
      index++;
    } else {
      return token.startsWith("--") ? { rest: [...argv] } : { verb: token, rest: [...rest, ...argv.slice(index + 1)] };
    }
  }
  return { rest };
}

/** The arguments a verb takes, as its refusal names them. */
function shape(verb: Verb): string {
  const names = [
    ...verb.positionals.map((each) => `<${each}>`), ...(verb.optional ?? []).map((each) => `[<${each}>]`),
    ...(verb.rest === undefined ? [] : [`-- <${verb.rest}…>`]),
  ];
  return names.length === 0 ? "no arguments" : names.join(" ");
}

/**
 * The marker a task's environment carries, when this command line writes and the
 * environment carries one, or null. A verb that writes is an operator's power, and the deny
 * list keeps only the launch forms it names out of an engine's hands (`src/guard.ts#denyTargets`).
 * It fails closed: only an explicit `false` reads, so a verb that declares nothing — which
 * nothing here type-checks — is refused as the write it may be.
 */
export function taskMarker(verb: Verb, parsed: Parsed, env: Readonly<NodeJS.ProcessEnv>): string | null {
  const writes: unknown = typeof verb.writes === "function" ? verb.writes(parsed) : verb.writes;
  return writes === false ? null : TASK_MARKERS.find((variable) => env[variable] !== undefined) ?? null;
}

/**
 * One verb's command line: its positionals, `--json` and `--help` once each, the verb's
 * boolean flags once each, `--` ending the flags, and every `--flag <value>` pair through
 * `parseFlags` — the parser the server's own argv goes through — so an unknown flag, a
 * missing or empty value and a repeat are each a reason rather than a guess
 * (`src/project.ts#parseFlags`). Then the verb's own check of the values it was given.
 */
function parse(name: string, verb: Verb, argv: readonly string[]): (Parsed & { help: boolean }) | { reason: string } {
  const pairs: string[] = [];
  const positionals: string[] = [];
  const seen = new Set<string>();
  const booleans = new Set<string>();
  let rest: string[] | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--") {
      if (verb.rest === undefined) positionals.push(...argv.slice(index + 1));
      else rest = argv.slice(index + 1);
      break;
    }
    if (token === "--json" || token === "--help") {
      if (seen.has(token)) return { reason: `${token} given twice` };
      seen.add(token);
    } else if (verb.booleans?.includes(token)) {
      if (booleans.has(token)) return { reason: `${token} given twice` };
      booleans.add(token);
    } else if (token.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { reason: `${token} needs a value` };
      pairs.push(token, value);
      index++;
    } else {
      positionals.push(token);
    }
  }
  const flags = parseFlags(pairs, { ...verb.flags, "--project": "root" });
  if ("reason" in flags) return flags;
  const parsed: Parsed = { positionals, values: flags.values, booleans, rest: rest ?? [], json: seen.has("--json") };
  if (seen.has("--help")) return { ...parsed, help: true };
  const most = verb.positionals.length + (verb.optional?.length ?? 0);
  if (positionals.length < verb.positionals.length || positionals.length > most) {
    return { reason: `${name} takes ${shape(verb)}, not ${positionals.length === 0 ? "none" : positionals.map((each) => JSON.stringify(each)).join(" ")}` };
  }
  if (positionals.some((each) => each === "")) {
    return { reason: `${name}'s ${[...verb.positionals, ...(verb.optional ?? [])].join(" and ")} must not be empty` };
  }
  if (verb.rest !== undefined && parsed.rest.length === 0) {
    return { reason: `${name} takes its ${verb.rest} after --, and ${rest === undefined ? "there is no --" : "nothing follows it"}` };
  }
  const fault = verb.check?.(parsed) ?? null;
  if (fault !== null) return { reason: fault };
  return { ...parsed, help: false };
}

/** The exit code this command line earns, by the protocol `EXIT` names. */
export async function runCli(
  argv: readonly string[], cwd: string, write: CliOutput, env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<number> {
  const { verb: name, rest } = split(argv);
  // Under `--json` stdout carries one document for every exit, a 1 and a 2 included, so a
  // script parses what it gets rather than guessing from an empty stream; the person who
  // asked for text reads stderr as before.
  const json = wantsJson(argv);
  const usageError = (error: string, verb?: Verb): number => {
    if (json) write.out(`${JSON.stringify({ ok: false, error, usage: usageLines(verb) }, null, 2)}\n`);
    else write.err(`cross-agent: ${error}\n${usageOf(verb)}`);
    return EXIT.usage;
  };
  if (name === "help" || (name === undefined && rest.includes("--help"))) {
    write.out(help(json));
    return EXIT.ok;
  }
  if (name === undefined || !Object.hasOwn(verbs, name)) {
    return usageError(name === undefined ? "no command" : `unknown command ${JSON.stringify(name)}`);
  }
  const verb = verbs[name];
  const parsed = parse(name, verb, rest);
  if ("reason" in parsed) return usageError(parsed.reason, verb);
  if (parsed.help) {
    write.out(help(json));
    return EXIT.ok;
  }
  // Checked on the command line as read, so a usage error is still a 2 and help is still
  // help, and before the verb runs, so a refused write has written nothing.
  const marker = taskMarker(verb, parsed, env);
  let answered: Answer;
  try {
    answered = marker !== null
      ? refused(`${marker} is set in this environment: ${name} is an operator's command, and an engine reaches the project through its server, never this CLI`)
      : await verb.run(parsed, { cwd, env });
  } catch (error) {
    if (error instanceof UsageError) return usageError(error.message, verb);
    // Nothing a verb anticipated: the message, as the one document under `--json`.
    if (parsed.json) write.out(`${JSON.stringify({ ok: false, error: message(error) }, null, 2)}\n`);
    else write.err(`cross-agent: ${message(error)}\n`);
    return EXIT.error;
  }
  if (parsed.json) {
    write.out(`${JSON.stringify(answered.document, null, 2)}\n`);
  } else {
    if ((answered.stream ?? (VERDICTS.has(answered.code) ? "stdout" : "stderr")) === "stdout") write.out(answered.text);
    else write.err(answered.text);
    if (answered.notes !== undefined) write.err(answered.notes);
  }
  return answered.code;
}

if (isMainModule(import.meta.url)) {
  void runCli(process.argv.slice(2), process.cwd(), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  }).then((code) => { process.exitCode = code; });
}
