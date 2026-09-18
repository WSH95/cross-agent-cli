import { execFile } from "node:child_process";
import fs from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CONFIG_PATH } from "./config.ts";
import { gitEnvironment } from "./worktree.ts";

export type Discovery = { root: string } | { reason: string };

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
 * The canonical root of the project this server serves (design, "Which project"):
 * `--project <root>` first, then `CROSS_AGENT_PROJECT`, then the nearest directory at or
 * above the working directory holding `.cross-agent/config.json`. Every answer holds a
 * config; where none does, the answer is the reason, never a guess.
 */
export async function discoverProject(argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>, cwd: string): Promise<Discovery> {
  if (argv.length > 0) {
    if (argv.length !== 2 || argv[0] !== "--project" || argv[1] === "") return { reason: `expected [--project <root>], got ${argv.join(" ")}` };
    return named(path.resolve(cwd, argv[1]), "--project");
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
    if (path.dirname(dir) === dir) return { reason: `no ${CONFIG_PATH} in ${start} or any directory above it` };
  }
}
