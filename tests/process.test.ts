import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentBootId, readProcessStat } from "../src/ledger.ts";
import type { EngineIdentity } from "../src/ledger.ts";
import { findByEnvironment, groupAlive, terminateGroup, terminateGroupByPid } from "../src/process.ts";

const worktree = fileURLToPath(new URL("../", import.meta.url));

async function poll<T>(read: () => T, accepts: (value: T) => boolean, timeout = 4000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = read();
    if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for state: ${JSON.stringify(value)}`);
    await delay(10);
  }
}

/** Independent of the implementation, so cleanup works even when the code under test does not. */
function running(pid: number): boolean {
  const stat = readProcessStat(pid);
  return stat !== null && stat.state !== "Z" && stat.state !== "X";
}

// A detached node process — a leader of its own group and session, as a spawned engine
// is — which optionally spawns one plain child that stays inside that group.
const fixture = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (process.env.CHILD_PID_FILE) {
  const env = { ...process.env };
  delete env.CHILD_PID_FILE;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env });
  fs.writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));
}
setInterval(() => {}, 1000);
`;

function processes(t: TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cross-agent-process-"));
  const tracked: { pid: number; leader: boolean }[] = [];
  t.after(async () => {
    const deadline = Date.now() + 4000;
    while (true) {
      const alive = tracked.filter((entry) => running(entry.pid));
      for (const entry of alive) {
        try { process.kill(entry.leader ? -entry.pid : entry.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      if (alive.length === 0) break;
      assert.ok(Date.now() < deadline, `cleanup left processes: ${alive.map((entry) => entry.pid)}`);
      await delay(10);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    leader(env: NodeJS.ProcessEnv = {}): { pid: number; identity: EngineIdentity; child: ChildProcess } {
      const child = spawn(process.execPath, ["-e", fixture], { detached: true, stdio: "ignore", env });
      child.once("error", () => {});
      const pid = child.pid!;
      tracked.push({ pid, leader: true });
      const stat = readProcessStat(pid)!;
      return { pid, identity: { pid, startTime: stat.startTime, pgid: pid, bootId: currentBootId }, child };
    },
    async member(pidFile: string): Promise<number> {
      const text = await poll(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : ""), (value) => value.length > 0);
      const pid = Number(text);
      tracked.push({ pid, leader: false });
      return pid;
    },
    async reap(leader: { pid: number; child: ChildProcess }): Promise<void> {
      leader.child.kill("SIGKILL");
      await once(leader.child, "close");
      await poll(() => readProcessStat(leader.pid), (stat) => stat === null);
    },
  };
}

test("the environment scan finds a task's own processes, leaders apart from strays", async (t) => {
  const zoo = processes(t);
  const taskId = `task-${process.pid}-${Date.now()}`;
  const recent = Date.now() - 1000;
  const pidFile = path.join(zoo.root, "stray.pid");
  // A detached leader carrying the task id and a plain child of it carrying the same id:
  // the two shapes reconciliation must tell apart, one adopted and one killed.
  const leader = zoo.leader({ CROSS_AGENT_TASK: taskId, CHILD_PID_FILE: pidFile });
  const stray = await zoo.member(pidFile);
  const { found, unreadable } = await poll(() => findByEnvironment(taskId, recent), (scan) => scan.found.length === 2);

  assert.equal(unreadable, 0, "nothing this user started since the task could not be read");
  assert.deepEqual(found.find((entry) => entry.pid === leader.pid), {
    pid: leader.pid, startTime: readProcessStat(leader.pid)!.startTime,
    pgid: leader.pid, sid: leader.pid, leader: true, self: false,
  });
  assert.deepEqual(found.find((entry) => entry.pid === stray), {
    pid: stray, startTime: readProcessStat(stray)!.startTime, pgid: leader.pid, sid: leader.pid, leader: false, self: false,
  });
  assert.deepEqual(findByEnvironment(`${taskId}-other`, recent).found, [], "another task's id finds nothing");
  assert.deepEqual(findByEnvironment(taskId.slice(0, 8), recent).found, [], "the assignment must match whole, not by prefix");

  process.kill(-leader.pid, "SIGKILL");
  await poll(() => findByEnvironment(taskId, recent).found, (entries) => entries.length === 0);
});

test("the environment scan marks what shares the scanner's own group or session", async (t) => {
  const zoo = processes(t);
  const taskId = `self-${process.pid}-${Date.now()}`;
  const outcome = path.join(zoo.root, "scan.json");
  const pidFile = path.join(zoo.root, "engine.pid");
  // The scanner carries the task id itself, as an MCP server that inherited it from its
  // engine does, and so does a plain child of it. Every match is reported — a reconciler
  // that could not see an engine would settle its record over a live process — but the
  // ones sharing the scanner's own group or session are marked, because those are the
  // ones it must never signal.
  const script = `
import fs from "node:fs";
import { spawn } from "node:child_process";
import { findByEnvironment } from ${JSON.stringify(pathToFileURL(path.join(worktree, "src", "process.ts")).href)};
const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const engine = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
engine.unref();
fs.writeFileSync(process.argv[2], String(engine.pid));
await new Promise((resolve) => setTimeout(resolve, 100));
const scan = findByEnvironment(process.env.CROSS_AGENT_TASK);
fs.writeFileSync(process.argv[3], JSON.stringify({ ...scan, self: process.pid, sibling: sibling.pid, engine: engine.pid }));
sibling.kill("SIGKILL");
`;
  const file = path.join(zoo.root, "scanner.mjs");
  fs.writeFileSync(file, script);
  const scanner = spawn(process.execPath, [file, pidFile, outcome], {
    stdio: "ignore", env: { ...process.env, CROSS_AGENT_TASK: taskId },
  });
  const engine = Number(await poll(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : ""), (text) => text.length > 0));
  t.after(async () => {
    try { process.kill(-engine, "SIGKILL"); } catch { /* already gone */ }
    scanner.kill("SIGKILL");
    await poll(() => running(engine), (alive) => !alive);
  });
  const [code] = await once(scanner, "close");
  assert.equal(code, 0, "the scanner survived its own scan");
  const result = JSON.parse(fs.readFileSync(outcome, "utf8")) as {
    found: { pid: number; self: boolean; leader: boolean }[]; unreadable: number;
    self: number; sibling: number; engine: number;
  };
  const byPid = new Map(result.found.map((entry) => [entry.pid, entry]));
  assert.deepEqual([...byPid.keys()].sort(), [result.self, result.sibling, result.engine].sort(),
    "everything carrying the id is seen, the scanner included");
  assert.equal(byPid.get(result.self)!.self, true);
  assert.equal(byPid.get(result.sibling)!.self, true, "a child in the scanner's own group is the scanner's own");
  assert.equal(byPid.get(result.engine)!.self, false);
  assert.equal(byPid.get(result.engine)!.leader, true);
});

test("the environment scan reports what it could not read and binds each match to one identity", async (t) => {
  const zoo = processes(t);
  const taskId = `bound-${process.pid}-${Date.now()}`;
  const since = Date.now() - 1000;
  const leader = zoo.leader({ CROSS_AGENT_TASK: taskId });
  await poll(() => findByEnvironment(taskId, since).found, (found) => found.length === 1);
  const environ = `/proc/${leader.pid}/environ`;
  const stat = `/proc/${leader.pid}/stat`;
  const original = fs.readFileSync;
  const real = (target: fs.PathOrFileDescriptor, options?: unknown) =>
    (original as (target: fs.PathOrFileDescriptor, options?: unknown) => string)(target, options);

  // A process this scan may not read could be the engine it is looking for, so it is
  // counted rather than passed over in silence.
  const denied = t.mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (target === environ) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return real(target, options);
  }) as typeof fs.readFileSync);
  const blind = findByEnvironment(taskId, since);
  const older = findByEnvironment(taskId, Date.now() + 60_000);
  denied.mock.restore();
  assert.deepEqual(blind.found, []);
  assert.equal(blind.unreadable, 1, "one process of ours, started since the task, could not be judged");
  assert.equal(older.unreadable, 0,
    "the bound is what makes the count mean anything: a process older than the task is not its engine");

  // A pid reused between the two stats is a different process: the match is dropped
  // rather than recorded against a foreign start time.
  let stats = 0;
  const reused = t.mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    const text = real(target, options);
    if (target !== stat || ++stats !== 2) return text;
    const head = text.slice(0, text.lastIndexOf(")") + 1);
    const fields = text.slice(text.lastIndexOf(")") + 1).trim().split(/\s+/);
    fields[19] = String(BigInt(fields[19]) + 1n);
    return `${head} ${fields.join(" ")}\n`;
  }) as typeof fs.readFileSync);
  const raced = findByEnvironment(taskId, since);
  reused.mock.restore();
  assert.equal(stats, 2, "the identity is read before the environment and again after it");
  assert.deepEqual(raced.found, []);
  assert.equal(raced.unreadable, 0);

  assert.deepEqual(findByEnvironment(taskId, since).found.map((entry) => entry.pid), [leader.pid], "the mocks changed nothing else");
});

test("terminateGroup escalates, reports what survives, and never throws", async (t) => {
  const zoo = processes(t);
  const graces = { termGrace: 200, killGrace: 200 };
  assert.equal(await terminateGroup({ pid: 2_147_483_647, startTime: "0", pgid: 2_147_483_647, bootId: currentBootId }, graces), true,
    "a group with no live member needs nothing signalled");

  const stubborn = zoo.leader();
  const denied = Object.assign(new Error("not permitted"), { code: "EPERM" });
  const mocked = t.mock.method(process, "kill", () => { throw denied; });
  const survived = await terminateGroup(stubborn.identity, graces);
  mocked.mock.restore();
  assert.equal(survived, false, "a group it could not signal is reported, not thrown");
  assert.equal(groupAlive(stubborn.identity), true);

  assert.equal(await terminateGroup(stubborn.identity, graces), true);
  assert.equal(groupAlive(stubborn.identity), false);
});

test("terminateGroupByPid ends the group a detached spawn made when no identity was captured", async (t) => {
  const zoo = processes(t);
  const pidFile = path.join(zoo.root, "member.pid");
  const leader = zoo.leader({ CHILD_PID_FILE: pidFile });
  const member = await zoo.member(pidFile);
  // The identity was never captured, and the leader is already gone: all that is left is
  // the pid a detached spawn made the group and session id, which the kernel keeps
  // reserved while any member holds it.
  await zoo.reap(leader);
  assert.equal(running(member), true);
  assert.equal(await terminateGroupByPid(leader.pid, { termGrace: 2000, killGrace: 500 }), true);
  assert.equal(running(member), false);
  assert.equal(await terminateGroupByPid(leader.pid, { termGrace: 200, killGrace: 200 }), true, "nothing left to signal");
});
