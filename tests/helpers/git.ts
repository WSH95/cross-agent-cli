import { execFile } from "node:child_process";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

// What a test needs to watch the two git tools from outside: who holds a lock, and a git
// that can be made slow. Both tools run `git --git-dir=<…> --work-tree=<…> <args>`, so one
// shim serves either.

const exec = promisify(execFile);

/**
 * The harness's own git, with a clean environment of its own: a test that poisons the
 * process's GIT_* variables to see what reaches a child must still be able to look at the
 * repository afterwards. The identity is on the command line, where no tool under test
 * would accept it.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  const identity = ["-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false"];
  const { stdout } = await exec("git", ["-C", cwd, ...identity, ...args], { encoding: "utf8", env });
  return stdout.replace(/\n$/, "");
}

/** The util-linux child that actually holds a lock, found by the file on its command line. */
export function holderOf(file: string): number | null {
  return holdersOf(file)[0] ?? null;
}

/** Every util-linux child holding a lock or waiting for it, found by the file on its command line. */
export function holdersOf(file: string): number[] {
  const found: number[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const argv = cmdline.split("\0");
    if (argv[0]?.endsWith("flock") && argv.includes(file)) found.push(Number(entry));
  }
  return found;
}

export interface GitShim {
  /** Every line the shim recorded, `argv <value>` and `env <NAME>=<value>` alike. */
  lines(): Promise<string[]>;
  argv(): Promise<string[]>;
}

/**
 * A `git` first on `PATH` that records every explicit-directory invocation — its argv and
 * its whole environment — and, when asked, sleeps or kills itself for the invocation whose
 * arguments carry a marker. Only a tool's own command is intercepted: the verifier's reads
 * use `-C`, which this passes straight through.
 */
export async function gitShim(
  t: TestContext, options: { sleepOn?: string; signalOn?: string } = {},
): Promise<GitShim> {
  const realGit = (await exec("sh", ["-c", "command -v git"], { encoding: "utf8" })).stdout.trim();
  const temporary = await mkdtemp(path.join(tmpdir(), "cross-agent-gitshim-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, "shim");
  const log = path.join(temporary, "invocations.txt");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "git"), `#!/bin/sh
case "$1" in
  --git-dir=*)
    { for argument in "$@"; do printf 'argv %s\\n' "$argument"; done; env | sed 's/^/env /'; } >> ${JSON.stringify(log)}
    ${options.sleepOn ? `case " $* " in *${options.sleepOn}*) sleep 2 ;; esac` : ""}
    ${options.signalOn ? `case " $* " in *${options.signalOn}*) kill -TERM $$ ;; esac` : ""}
    ;;
esac
exec ${JSON.stringify(realGit)} "$@"
`);
  await chmod(path.join(directory, "git"), 0o755);
  const original = process.env.PATH;
  t.after(() => { process.env.PATH = original; });
  process.env.PATH = `${directory}${path.delimiter}${original}`;
  async function lines(): Promise<string[]> {
    try {
      return (await readFile(log, "utf8")).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
  return { lines, argv: async () => (await lines()).filter((line) => line.startsWith("argv ")).map((line) => line.slice("argv ".length)) };
}
