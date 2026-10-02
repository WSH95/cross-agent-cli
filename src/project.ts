import { execFile } from "node:child_process";
import fs from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONFIG_PATH } from "./config.ts";
import { enclosingWorktree, gitEnvironment, nestedReason, ownGit, worktreeStanzas } from "./worktree.ts";

export type Discovery = { root: string } | { reason: string };

export type Flags = { values: Record<string, string> } | { reason: string };

const exec = promisify(execFile);

function holdsConfig(dir: string): boolean {
  return fs.statSync(path.join(dir, CONFIG_PATH), { throwIfNoEntry: false })?.isFile() ?? false;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The root as discovery may return it: a root inside a worktree that an enclosing work
 * tree registers is never one, whichever way it was reached (design, "Which project").
 */
async function checked(root: string, source?: string): Promise<Discovery> {
  const enclosure = await enclosingWorktree(root);
  if (enclosure === null) return { root };
  if ("reason" in enclosure) return enclosure;
  return { reason: `${source === undefined ? "" : `${source} names `}${nestedReason(root, enclosure)}` };
}

/** A root a caller names: canonical, never a task worktree, and holding a config, each decided before any config is read. */
async function named(value: string, source: string): Promise<Discovery> {
  let root: string;
  try {
    root = await realpath(value);
  } catch (error) {
    return { reason: `cannot resolve ${source} ${value}: ${message(error)}` };
  }
  const found = await checked(root, source);
  if ("reason" in found) return found;
  return holdsConfig(root) ? found : { reason: `${source} ${root} holds no ${CONFIG_PATH}` };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnvironment() });
  // Git paths may contain trailing whitespace, so remove only the record terminator.
  return path.resolve(cwd, stdout.replace(/\n$/, ""));
}

/** The nearest ancestor-or-self of `dir` holding a `.git` entry, by filesystem reads alone, or null. */
function nearestGit(dir: string): string | null {
  for (let at = dir; ; at = path.dirname(at)) {
    if (fs.lstatSync(path.join(at, ".git"), { throwIfNoEntry: false }) !== undefined) return at;
    if (path.dirname(at) === at) return null;
  }
}

/** The nearest ancestor-or-self of `dir` that exists. */
function nearestExisting(dir: string): string {
  let at = dir;
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  return at;
}

/**
 * Where the config walk starts for a working directory, and the main checkout it was read
 * at when it was read at one (design, "Which project"). The cwd is taken out of every
 * worktree an enclosing work tree registers first, outside-in and before any config is
 * looked at, so a cwd inside a task worktree is read as its root whatever its pointer
 * holds; each pass strips at least one path component, and the mapping is lexical, since
 * the same path need not exist on the root's branch. Then local opt-in comes first: the
 * nearest `.git` holder that holds a config of its own is its own project, and one that
 * does not is read at its main checkout, the registry's first stanza when that is a work
 * tree by its own git and not the holder itself — a separated main's first stanza is its
 * git directory, and a main checkout, a bare repository or a registry that will not read
 * leave the cwd where it is.
 */
async function projectStart(cwd: string): Promise<{ start: string; main?: string } | { reason: string }> {
  let start: string;
  try {
    start = await realpath(cwd);
  } catch (error) {
    return { reason: `cannot resolve the working directory ${cwd}: ${message(error)}` };
  }
  for (let enclosure = await enclosingWorktree(start); enclosure !== null; enclosure = await enclosingWorktree(start)) {
    if ("reason" in enclosure) return enclosure;
    start = path.join(enclosure.ancestor, path.relative(enclosure.worktree, start));
  }
  const holder = nearestGit(start);
  if (holder === null || holdsConfig(holder)) return { start };
  try {
    const first = (await worktreeStanzas(holder)).find((stanza) => stanza.main);
    if (first === undefined || first.path === holder || !(await ownGit(first.path)).workTree) return { start };
    return { start: path.join(first.path, path.relative(holder, start)), main: first.path };
  } catch {
    return { start };
  }
}

/**
 * Whether this process was started to run the module at `moduleUrl`, the entry point's own
 * `import.meta.url`: the script node was given, `argv[1]`, and the module, compared by real
 * path. Node runs a main module at its real path, so the bin link `npm link` installs and a
 * checkout reached through a link are that same file under another name, and an entry point
 * comparing names did nothing and exited 0 (task 12's review).
 */
export function isMainModule(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return fs.realpathSync(script) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/**
 * The `--flag <value>` pairs a caller takes, each at most once, in any order. Anything
 * else — an unknown flag, a missing or empty value, a repeat, a bare argument — is a
 * reason and never a guess, because a command line this build cannot read in full is one
 * it must not act on half of. The server takes `--project` alone; the operator CLI takes
 * its own flags and shares the parser, so a second flag does not break the first.
 */
export function parseFlags(argv: readonly string[], spec: Record<string, string>): Flags {
  const usage = Object.entries(spec).map(([flag, value]) => `[${flag} <${value}>]`).join(" ");
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!Object.hasOwn(spec, flag) || typeof value !== "string" || value === "" || Object.hasOwn(values, flag)) {
      return { reason: `expected ${usage}, got ${argv.join(" ")}` };
    }
    values[flag] = value;
  }
  return { values };
}

/**
 * The canonical root of the project this server serves (design, "Which project"):
 * `--project <root>` first, then `CROSS_AGENT_PROJECT`, then the nearest directory at or
 * above the working directory holding `.cross-agent/config.json`, and — where none does —
 * that directory's own git toplevel, which runs `solo` on the defaults `loadConfig`
 * answers with when there is no file (design, "Modes"). A root a caller **names** still
 * has to hold a config: naming one is a claim about a project, and a typo in that claim is
 * not a new project. Nothing is written to answer this question: `cross-agent init`
 * remains the only writer of a config, and the first `delegate` creates `.cross-agent/`.
 */
export async function discoverProject(argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>, cwd: string): Promise<Discovery> {
  if (argv.length > 0) {
    const flags = parseFlags(argv, { "--project": "root" });
    if ("reason" in flags) return flags;
    return named(path.resolve(cwd, flags.values["--project"]), "--project");
  }
  const exported = env.CROSS_AGENT_PROJECT;
  if (exported !== undefined) {
    if (!path.isAbsolute(exported)) return { reason: `CROSS_AGENT_PROJECT must be an absolute path, not ${JSON.stringify(exported)}` };
    return named(exported, "CROSS_AGENT_PROJECT");
  }
  const begun = await projectStart(cwd);
  if ("reason" in begun) return begun;
  const { start } = begun;
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (holdsConfig(dir)) return checked(await realpath(dir));
    if (path.dirname(dir) === dir) break;
  }
  // No config above it: the main checkout the working directory was read at, or else the
  // repository it is in, at its own toplevel. A directory in no repository is still a
  // reason: there is nothing for a ledger, a journal or a worktree to belong to.
  if (begun.main !== undefined) return checked(begun.main);
  let top: string;
  try {
    top = await realpath(await git(nearestExisting(start), "rev-parse", "--show-toplevel"));
  } catch {
    return {
      reason: `no ${CONFIG_PATH} in ${start} or any directory above it, and ${start} is in no git repository: `
        + "without a config the project is the working directory's git toplevel",
    };
  }
  return checked(top);
}
