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
import { create, currentBootId, list, read, readProcessStat, update } from "../src/ledger.ts";
import type { CreateTask, EngineIdentity, TaskPatch, TaskRecord, TaskStatus, UpdateOptions } from "../src/ledger.ts";
import { findByEnvironment, groupAlive, terminateOrphans } from "../src/process.ts";
import { reconcile, reconcileAndCleanup } from "../src/reconcile.ts";

const now = 1_000_000;
const statuses: TaskStatus[] = ["launching", "running", "stalled", "orphaned", "cancelling", "done", "failed", "cancelled"];

// One legal path from launching to each status (design section 2, E1), so a test can
// start anywhere without writing a transition the ledger forbids.
const routes: Record<TaskStatus, TaskStatus[]> = {
  launching: [],
  running: ["running"],
  stalled: ["running", "stalled"],
  orphaned: ["running", "orphaned"],
  cancelling: ["cancelling"],
  done: ["running", "done"],
  failed: ["failed"],
  cancelled: ["cancelling", "cancelled"],
};

function project(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cross-agent-reconcile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function input(cwd: string): CreateTask {
  return { role: "implementer", brief: "Reconcile the ledger with the kernel.", cwd, engine: "codex", model: "test-model" };
}

function tasks(root: string): string {
  return path.join(root, ".cross-agent", "tasks");
}

/** This process: alive, and never a group leader under the test runner. */
function liveIdentity(): EngineIdentity {
  const stat = readProcessStat(process.pid)!;
  return { pid: process.pid, startTime: stat.startTime, pgid: stat.pgid, bootId: currentBootId };
}

function deadIdentity(): EngineIdentity {
  const live = liveIdentity();
  return { ...live, startTime: String(BigInt(live.startTime) + 1n) };
}

/** update, asserting it applied, for the callers that only want the new record. */
async function change(root: string, id: string, patch: TaskPatch, at?: number, options?: UpdateOptions): Promise<TaskRecord> {
  const result = await update(root, id, patch, at, options);
  assert.equal(result.applied, true, `update was refused: ${JSON.stringify(result)}`);
  return result.record;
}

/** A record in the requested status, reached only through legal transitions. */
async function started(root: string, status: TaskStatus, at = now): Promise<TaskRecord> {
  let record = create(root, input(root), at);
  for (const step of routes[status]) record = await change(root, record.id, { status: step }, at);
  return record;
}

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

// Reconciliation judges the kernel, so its tests use real processes. Each fixture is a
// detached node process — a leader of its own group and session, exactly as a spawned
// engine is — which optionally spawns one plain child that stays in that group.
const fixture = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (process.env.CHILD_PID_FILE) {
  const env = { ...process.env };
  delete env.CHILD_PID_FILE;
  delete env.CROSS_AGENT_TASK;
  if (process.env.CHILD_TASK) env.CROSS_AGENT_TASK = process.env.CHILD_TASK;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env });
  fs.writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));
}
setInterval(() => {}, 1000);
`;

function processes(t: TestContext) {
  const tracked: { pid: number; leader: boolean }[] = [];
  const children: ChildProcess[] = [];
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
    for (const child of children) child.unref();
  });
  return {
    /** A live engine group: one detached leader, and its identity as the runner would record it. */
    leader(env: NodeJS.ProcessEnv = {}): { pid: number; identity: EngineIdentity; child: ChildProcess } {
      const child = spawn(process.execPath, ["-e", fixture], { detached: true, stdio: "ignore", env });
      child.once("error", () => {});
      children.push(child);
      const pid = child.pid!;
      tracked.push({ pid, leader: true });
      const stat = readProcessStat(pid)!;
      return { pid, identity: { pid, startTime: stat.startTime, pgid: pid, bootId: currentBootId }, child };
    },
    /** The pid the leader's own child wrote, once it exists. */
    async member(pidFile: string): Promise<number> {
      const text = await poll(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : ""), (value) => value.length > 0);
      const pid = Number(text);
      tracked.push({ pid, leader: false });
      return pid;
    },
    /** Kills a leader and waits for it to be reaped, leaving its group members behind. */
    async reap(leader: { pid: number; child: ChildProcess }): Promise<void> {
      leader.child.kill("SIGKILL");
      await once(leader.child, "close");
      await poll(() => readProcessStat(leader.pid), (stat) => stat === null);
    },
  };
}

test("reconcile fails unacknowledged launches only after their deadline", async (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  assert.deepEqual(await reconcile(root, record.launchDeadline - 1), { changed: [], invalid: [] });
  assert.deepEqual(read(root, record.id), record);
  assert.deepEqual(await reconcile(root, record.launchDeadline), { changed: [], invalid: [] });
  assert.deepEqual(read(root, record.id), record);

  const after = record.launchDeadline + 1;
  const expected = { ...record, status: "failed", reason: "launch", updatedAt: after };
  assert.deepEqual(await reconcile(root, after), { changed: [expected], invalid: [] });
  assert.deepEqual(read(root, record.id), expected);
  assert.deepEqual(await reconcile(root, after + 1), { changed: [], invalid: [] });
});

test("reconcile fails running and stalled tasks when no member of the engine group is alive", async (t) => {
  const root = project(t);
  const dead = deadIdentity();
  for (const status of ["running", "stalled"] as const) {
    for (const identities of [{}, { runnerIdentity: dead, engineIdentity: dead }]) {
      const record = await started(root, status, now);
      const active = await change(root, record.id, identities, now + 1);
      const expected = { ...active, status: "failed", reason: "runner lost", updatedAt: now + 2 };
      assert.deepEqual(await reconcile(root, now + 2), { changed: [expected], invalid: [] });
      assert.deepEqual(read(root, record.id), expected);
    }
  }
});

test("reconcile orphans running and stalled tasks with a dead runner and a live engine group", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const engine = zoo.leader();
  for (const status of ["running", "stalled"] as const) {
    const record = await started(root, status, now);
    const active = await change(root, record.id, { runnerIdentity: deadIdentity(), engineIdentity: engine.identity }, now + 1);
    const expected = { ...active, status: "orphaned", updatedAt: now + 2 };
    assert.deepEqual(await reconcile(root, now + 2), { changed: [expected], invalid: [] });
    assert.deepEqual(read(root, record.id), expected);
    assert.equal(groupAlive(engine.identity), true, "an orphaned record's engine is left running for cleanup");
  }
});

test("reconcile judges the engine by its group, so a reaped leader with a live member is orphaned", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const pidFile = path.join(root, "member.pid");
  const engine = zoo.leader({ CHILD_PID_FILE: pidFile });
  const member = await zoo.member(pidFile);
  const record = await started(root, "running", now);
  await change(root, record.id, { runnerIdentity: deadIdentity(), engineIdentity: engine.identity }, now + 1);
  // The leader is gone and nothing has looked at this group before: judging the engine
  // by its leader alone would settle the record and leave the member running for ever.
  await zoo.reap(engine);
  assert.equal(running(member), true);
  assert.equal(readProcessStat(engine.pid), null);

  const { changed } = await reconcile(root, now + 2);
  assert.deepEqual(changed.map((value) => [value.id, value.status]), [[record.id, "orphaned"]]);
  const cleaned = await terminateOrphans(root);
  assert.deepEqual(cleaned.map((value) => [value.id, value.status, value.reason]), [[record.id, "failed", "runner lost"]]);
  await poll(() => running(member), (alive) => !alive);
  assert.equal(read(root, record.id).status, "failed");
});

test("a launching record past its deadline adopts the group leader carrying its task id", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const record = create(root, input(root), now);
  const engine = zoo.leader({ CROSS_AGENT_TASK: record.id });
  await poll(() => findByEnvironment(record.id), (found) => found.length === 1);

  const after = record.launchDeadline + 1;
  const { changed } = await reconcile(root, after);
  assert.deepEqual(changed.map((value) => [value.id, value.status]), [[record.id, "orphaned"]]);
  const adopted = read(root, record.id);
  assert.deepEqual(adopted.engineIdentity, engine.identity, "the record now names the group cleanup must terminate");
  assert.equal(adopted.runnerIdentity ?? null, null);
  assert.equal(groupAlive(adopted.engineIdentity), true);

  const cleaned = await terminateOrphans(root);
  assert.deepEqual(cleaned.map((value) => [value.status, value.reason]), [["failed", "runner lost"]]);
  await poll(() => running(engine.pid), (alive) => !alive);
});

test("a launching record past its deadline kills a stray that leads nothing and names it", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const record = create(root, input(root), now);
  const pidFile = path.join(root, "stray.pid");
  // Only the child carries the task id, so there is no leader to adopt: an engine
  // identity must be a group leader, and a stray can only be killed.
  const parent = zoo.leader({ CHILD_PID_FILE: pidFile, CHILD_TASK: record.id });
  const stray = await zoo.member(pidFile);
  await poll(() => findByEnvironment(record.id), (found) => found.length === 1);
  assert.deepEqual(findByEnvironment(record.id).map((entry) => [entry.pid, entry.leader]), [[stray, false]]);

  const { changed } = await reconcile(root, record.launchDeadline + 1);
  assert.deepEqual(changed.map((value) => [value.status, value.reason]), [["failed", `launch; killed stray ${stray}`]]);
  await poll(() => running(stray), (alive) => !alive);
  assert.equal(running(parent.pid), true, "a process that does not carry the task id is never signalled");
});

test("a cancelling record whose runner is dead terminates the group and settles cancelled", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  for (const engine of [zoo.leader().identity, deadIdentity()]) {
    const record = await started(root, "cancelling", now);
    const cancelling = await change(root, record.id, { runnerIdentity: deadIdentity(), engineIdentity: engine }, now + 1);
    const expected = { ...cancelling, status: "cancelled", reason: "runner lost during cancel", updatedAt: now + 2 };
    assert.deepEqual(await reconcile(root, now + 2), { changed: [expected], invalid: [] });
    assert.deepEqual(read(root, record.id), expected);
    assert.equal(groupAlive(engine), false, "the group is verified dead before the terminal write");
  }
  assert.deepEqual((await reconcile(root, now + 3)).changed, []);
});

test("reconcile skips a record settled between listing and its write", async (t) => {
  const root = project(t);
  const dead = deadIdentity();
  const record = await started(root, "running", now);
  const active = await change(root, record.id, { runnerIdentity: dead, engineIdentity: dead }, now + 1);
  const file = path.join(tasks(root), `${record.id}.json`);
  const original = fs.readFileSync;
  let reads = 0;
  const external: TaskRecord = { ...active, status: "failed", reason: "external settlement", updatedAt: now + 2 };
  // The first read of this record is the listing; the second is the one update makes
  // inside the record lock. A settlement landing between them must be seen by that
  // second read. It is written here as another process would: whole file, one rename.
  const mock = t.mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (target === file && ++reads === 2) {
      mock.mock.restore();
      fs.writeFileSync(`${file}.external`, JSON.stringify(external, null, 2) + "\n");
      fs.renameSync(`${file}.external`, file);
    }
    return (original as (target: fs.PathOrFileDescriptor, options?: unknown) => string | Buffer)(target, options);
  }) as typeof fs.readFileSync);
  assert.deepEqual(await reconcile(root, now + 3), { changed: [], invalid: [] });
  assert.equal(reads, 2);
  assert.deepEqual(read(root, record.id), external);
});

test("a launch acknowledged between the listing and the write is left running", async (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  const file = path.join(tasks(root), `${record.id}.json`);
  const acknowledged: TaskRecord = {
    ...record, status: "running", runnerIdentity: liveIdentity(), engineIdentity: liveIdentity(), updatedAt: now + 1,
  };
  const original = fs.readFileSync;
  let reads = 0;
  // B3: the runner wins the race for its own record. The reconciler's decision is stale
  // by the time it takes the lock, and its expect refuses the write rather than failing
  // a task that is running.
  const mock = t.mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (target === file && ++reads === 2) {
      mock.mock.restore();
      fs.writeFileSync(`${file}.external`, JSON.stringify(acknowledged, null, 2) + "\n");
      fs.renameSync(`${file}.external`, file);
    }
    return (original as (target: fs.PathOrFileDescriptor, options?: unknown) => string | Buffer)(target, options);
  }) as typeof fs.readFileSync);
  assert.deepEqual(await reconcile(root, record.launchDeadline + 1), { changed: [], invalid: [] });
  assert.equal(reads, 2, "one read for the listing, one inside the record lock");
  assert.deepEqual(read(root, record.id), acknowledged);
});

test("reconcile preserves live-runner tasks and all other states", async (t) => {
  const root = project(t);
  const live = liveIdentity();
  const dead = deadIdentity();
  for (const status of statuses) {
    const record = await started(root, status, now);
    // A runner that is alive owns its task, whatever the record says; only the states
    // reconciliation judges need one, and every other state is left alone regardless.
    const runnerIdentity = ["running", "stalled", "cancelling"].includes(status) ? live : dead;
    await change(root, record.id, { runnerIdentity, engineIdentity: dead }, now + 1);
  }
  const before = list(root);
  assert.deepEqual(await reconcile(root, now + 60_000), { changed: [], invalid: [] });
  assert.deepEqual(list(root), before);
});

test("reconciliation reports unreadable record files and judges the rest", async (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  fs.writeFileSync(path.join(tasks(root), "damaged.json"), "{ not json");
  const after = record.launchDeadline + 1;
  const { changed, invalid } = await reconcile(root, after);
  assert.deepEqual(changed.map((value) => [value.id, value.status]), [[record.id, "failed"]]);
  assert.deepEqual(invalid.map((entry) => path.basename(entry.file)), ["damaged.json"]);
  assert.ok(invalid[0].reason.length > 0);
  assert.deepEqual(await terminateOrphans(root), []);
  assert.deepEqual(await reconcileAndCleanup(root, after + 1), { changed: [], invalid, cleaned: [] });
});

test("reconcileAndCleanup settles the orphans of its own pass", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const engine = zoo.leader();
  const record = await started(root, "running", now);
  await change(root, record.id, { runnerIdentity: deadIdentity(), engineIdentity: engine.identity }, now + 1);
  const result = await reconcileAndCleanup(root, now + 2);
  assert.deepEqual(result.changed.map((value) => value.status), ["orphaned"]);
  assert.deepEqual(result.cleaned.map((value) => [value.status, value.reason]), [["failed", "runner lost"]]);
  assert.deepEqual(result.invalid, []);
  assert.equal(read(root, record.id).status, "failed");
  assert.equal(groupAlive(engine.identity), false, "no caller can see an orphan whose group is still being decided");
});
