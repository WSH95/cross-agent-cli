import { execFile } from "node:child_process";
import fs from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CONFIG_PATH } from "./config.ts";
import { gitEnvironment } from "./worktree.ts";

export type Discovery = { root: string } | { reason: string };

export type Flags = { values: Record<string, string> } | { reason: string };

const exec = promisify(execFile);

function holdsConfig(dir: string): boolean {
  return fs.statSync(path.join(dir, CONFIG_PATH), { throwIfNoEntry: false })?.isFile() ?? false;
}

async function named(value: string, source: string): Promise<Discovery> {
  let root: string;
  try {
    root = await realpath(value);
  } catch (error) {
    return { reason: `cannot resolve ${source} ${value}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return holdsConfig(root) ? { root } : { reason: `${source} ${root} holds no ${CONFIG_PATH}` };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnvironment() });
  // Git paths may contain trailing whitespace, so remove only the record terminator.
  return path.resolve(cwd, stdout.replace(/\n$/, ""));
}

// The ledger lives in the main checkout, and a linked worktree — `.worktrees/<slug>` or
// one anywhere else on disk — is the same project, so its directories are read as the
// same places in the main worktree. Anything git cannot answer for is read as it is.
async function inMainWorktree(cwd: string): Promise<string> {
  try {
    const top = await git(cwd, "rev-parse", "--show-toplevel");
    const gitDir = await git(cwd, "rev-parse", "--git-dir");
    const commonDir = await git(cwd, "rev-parse", "--git-common-dir");
    if (gitDir === commonDir || path.basename(commonDir) !== ".git") return cwd;
    return path.join(path.dirname(commonDir), path.relative(top, cwd));
  } catch {
    return cwd;
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
  let start: string;
  try {
    start = await inMainWorktree(await realpath(cwd));
  } catch (error) {
    return { reason: `cannot resolve the working directory ${cwd}: ${error instanceof Error ? error.message : String(error)}` };
  }
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (holdsConfig(dir)) return { root: dir };
    if (path.dirname(dir) === dir) break;
  }
  // No config above it, so the project is the repository the working directory is in, read
  // at its main checkout as every other answer is. A directory in no repository is still a
  // reason: there is nothing for a ledger, a journal or a worktree to belong to.
  try {
    return { root: await inMainWorktree(await git(await realpath(cwd), "rev-parse", "--show-toplevel")) };
  } catch {
    return {
      reason: `no ${CONFIG_PATH} in ${start} or any directory above it, and ${start} is in no git repository: `
        + "without a config the project is the working directory's git toplevel",
    };
  }
}
