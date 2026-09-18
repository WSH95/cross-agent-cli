import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scan } from "../../src/ledger.ts";
import type { TaskRecord } from "../../src/ledger.ts";

// A project the delegation tools can be run against: a git repository with a config, an
// engine binary that is the fake engine, and a cleanup that leaves no process behind.

const exec = promisify(execFile);
const worktreeRoot = fileURLToPath(new URL("../../", import.meta.url));
export const fakeEngine = path.join(worktreeRoot, "tests", "fixtures", "fake-engine.mjs");

/** Nothing of the suite's own CROSS_AGENT_* reaches a task: the suite may be one itself. */
export const suiteEnv: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("CROSS_AGENT_")),
);

export function proc(pid: number): { pid: number; startTime: string; pgid: number; sid: number; state: string } | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
    return { pid, startTime: fields[19], pgid: Number(fields[2]), sid: Number(fields[3]), state: fields[0] };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code!)) return null;
    throw error;
  }
}

export function alive(identity?: { pid: number; startTime: string } | null): boolean {
  if (!identity) return false;
  const current = proc(identity.pid);
  return current !== null && current.startTime === identity.startTime && !["Z", "X"].includes(current.state);
}

export function environOf(pid: number): string[] | null {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/** Every live process this project's tasks put a marker in, runners and engines alike. */
function markedProcesses(marker: string): number[] {
  const pids: number[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (environOf(pid)?.includes(marker) && proc(pid) !== null) pids.push(pid);
  }
  return pids;
}

export async function poll<T>(read: () => T, accepts: (value: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for state: ${JSON.stringify(value)}`);
    await delay(15);
  }
}

/**
 * A stand-in for an engine binary, reached the way a configured `engines.<e>.bin` is. It
 * runs the fake engine in its own process, so the argv the adapter built is the argv the
 * fixture records.
 */
export function engineShim(directory: string, name: string): string {
  const file = path.join(directory, `${name}-shim.mjs`);
  fs.writeFileSync(file, `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(fakeEngine).href)});\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

export interface TestProject {
  root: string;
  /** The marker every runner and engine of this project carries, for cleanup. */
  marker: string;
  /** The environment a server of this project would have: the parent of every child env. */
  env: NodeJS.ProcessEnv;
  bin: string;
  worktree(branch: string, slug?: string): Promise<string>;
  records(): TaskRecord[];
  record(id: string): TaskRecord;
}

/**
 * A git project with `.cross-agent/config.json`, ready for a delegation. `t.after` kills
 * every process the tasks left, so a test that fails still leaves no engine running.
 */
export async function project(t: TestContext, config: Record<string, unknown>): Promise<TestProject> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "cross-agent-tools-")));
  const marker = `AGENT_TEAM_TEST_PROJECT=${root}`;
  await exec("git", ["-C", root, "init", "-b", "main"]);
  await exec("git", ["-C", root, "-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "initial"]);
  const bin = engineShim(root, "engine");
  fs.mkdirSync(path.join(root, ".cross-agent"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cross-agent", "config.json"), JSON.stringify(config));

  t.after(async () => {
    const deadline = Date.now() + 5000;
    while (true) {
      const pids = markedProcesses(marker);
      for (const pid of pids) {
        const stat = proc(pid);
        try { process.kill(stat && stat.pgid === pid ? -pid : pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      if (pids.length === 0) break;
      assert.ok(Date.now() < deadline, `cleanup left processes: ${pids}`);
      await delay(20);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    root, marker, bin,
    env: { ...suiteEnv, [marker.split("=")[0]]: root },
    async worktree(branch: string, slug = branch.replace(/[^A-Za-z0-9_-]/g, "-")) {
      const directory = path.join(root, ".worktrees", slug);
      await exec("git", ["-C", root, "worktree", "add", "-b", branch, directory]);
      return fs.realpathSync(directory);
    },
    records: () => scan(root).records,
    record(id: string) {
      const found = scan(root).records.find((value) => value.id === id);
      assert.ok(found, `no record ${id}`);
      return found;
    },
  };
}

/** The environment a delegation's engine is told to run the fake engine with. */
export function engineEnv(project: TestProject, values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...project.env, FAKE_ENGINE_FORMAT: "grok", FAKE_ENGINE_SCRIPT: "ok", ...values };
}

/**
 * An engine a dead runner left behind: a detached leader of its own group and session
 * carrying `CROSS_AGENT_TASK=<id>`, which is the only thing that identifies one
 * (design section 2, B5-i). It carries the project marker too, so cleanup finds it.
 */
export function strandedEngine(project: TestProject, taskId: string): { pid: number; identity: { pid: number; startTime: string; pgid: number; bootId: string } } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore", env: { ...project.env, CROSS_AGENT_TASK: taskId },
  });
  child.once("error", () => {});
  child.unref();
  const pid = child.pid!;
  const stat = proc(pid)!;
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return { pid, identity: { pid, startTime: stat.startTime, pgid: pid, bootId } };
}

/** Runs the `flock` helper child of a lock file to death, the way a killed holder dies. */
export function killLockHolder(file: string): boolean {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const args = cmdline.split("\0");
    if (args[0] !== "flock" || !args.includes(file)) continue;
    if (proc(Number(entry))?.sid !== proc(process.pid)?.sid) continue;
    try {
      process.kill(Number(entry), "SIGKILL");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return false;
}

/** A detached child of this test process, tracked so nothing survives the test. */
export function track(t: TestContext, child: ReturnType<typeof spawn>): ReturnType<typeof spawn> {
  child.once("error", () => {});
  t.after(() => {
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  });
  return child;
}
