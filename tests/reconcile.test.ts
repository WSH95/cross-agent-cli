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
import { create, currentBootId, list, read, readProcessStat, update } from "../src/ledger.ts";
import type { CreateTask, EngineIdentity, TaskPatch, TaskRecord, TaskStatus, UpdateOptions } from "../src/ledger.ts";
import { findByEnvironment, groupAlive, terminateOrphans } from "../src/process.ts";
import { acquire, lockPath, recordLockName } from "../src/locks.ts";
import { reconcile, reconcileAndCleanup } from "../src/reconcile.ts";
import type { Reconciled } from "../src/reconcile.ts";

// A real wall clock: reconciliation compares a record's createdAt with the start times of
// live processes, so a task from 1970 would be older than everything on the machine.
const worktree = fileURLToPath(new URL("../", import.meta.url));

const now = Date.now();
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

/** A project whose config sets one limit; the rest are the documented defaults. */
function configure(root: string, lockWaitSeconds: number): void {
  fs.mkdirSync(path.join(root, ".cross-agent"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cross-agent", "config.json"), JSON.stringify({ roles: {}, limits: { lockWaitSeconds } }));
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
    leader(env: NodeJS.ProcessEnv = {}, script = fixture, argv: string[] = []): { pid: number; identity: EngineIdentity; child: ChildProcess } {
      const child = spawn(process.execPath, ["-e", script, ...argv], { detached: true, stdio: "ignore", env });
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
  assert.deepEqual(await reconcile(root, record.launchDeadline - 1), { changed: [], invalid: [], errors: [] });
  assert.deepEqual(read(root, record.id), record);
  assert.deepEqual(await reconcile(root, record.launchDeadline), { changed: [], invalid: [], errors: [] });
  assert.deepEqual(read(root, record.id), record);

  const after = record.launchDeadline + 1;
  const expected = { ...record, status: "failed", reason: "launch", updatedAt: after };
  assert.deepEqual(await reconcile(root, after), { changed: [expected], invalid: [], errors: [] });
  assert.deepEqual(read(root, record.id), expected);
  assert.deepEqual(await reconcile(root, after + 1), { changed: [], invalid: [], errors: [] });
});

test("reconcile fails running and stalled tasks when no member of the engine group is alive", async (t) => {
  const root = project(t);
  const dead = deadIdentity();
  for (const status of ["running", "stalled"] as const) {
    for (const identities of [{}, { runnerIdentity: dead, engineIdentity: dead }]) {
      const record = await started(root, status, now);
      const active = await change(root, record.id, identities, now + 1);
      const expected = { ...active, status: "failed", reason: "runner lost", updatedAt: now + 2 };
      assert.deepEqual(await reconcile(root, now + 2), { changed: [expected], invalid: [], errors: [] });
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
    assert.deepEqual(await reconcile(root, now + 2), { changed: [expected], invalid: [], errors: [] });
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
  const { changed: cleaned } = await terminateOrphans(root);
  // Cleanup is what ended the group, so the settlement says so: the member was alive
  // when the pass met it (finding T3b-2).
  assert.deepEqual(cleaned.map((value) => [value.id, value.status, value.reason]),
    [[record.id, "failed", "runner lost; engine group terminated"]]);
  await poll(() => running(member), (alive) => !alive);
  assert.equal(read(root, record.id).status, "failed");
});

test("a cancelling record with no runner is settled only once the engine its environment names is ended", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  // The failure this closes: a cancel inside the launch window claims `cancelling` on a
  // record that never acknowledged, so there is no runner to judge and no identity to
  // terminate — and the engine a dead runner left behind is found only by the assignment
  // it carries (design section 2, B5-i).
  const record = await started(root, "cancelling");
  const engine = zoo.leader({ CROSS_AGENT_TASK: record.id });
  await poll(() => findByEnvironment(record.id, record.createdAt).found, (found) => found.length === 1);

  const { changed, errors } = await reconcileAndCleanup(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(changed.map((value) => [value.id, value.status]), [[record.id, "cancelled"]]);
  const settled = read(root, record.id);
  assert.deepEqual(settled.engineIdentity, engine.identity, "the record names the group this pass ended");
  assert.equal(running(engine.pid), false, "the engine is dead before the record is terminal");
  assert.match(settled.reason ?? "", /cancel/);
});

test("a cancelling record whose environment names nothing settles, and one it cannot read waits", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  // Nothing carries the id: there is no engine, so the record settles with no identity.
  const alone = await started(root, "cancelling");
  const first = await reconcileAndCleanup(root);
  assert.deepEqual(first.errors, []);
  assert.equal(read(root, alone.id).status, "cancelled");
  assert.equal(read(root, alone.id).engineIdentity ?? null, null);

  // A stray that is not a leader cannot be an engine identity, but it carries the id and
  // is killed with the settlement, exactly as adoption kills one.
  const record = await started(root, "cancelling");
  const pidFile = path.join(root, "stray.pid");
  const engine = zoo.leader({ CROSS_AGENT_TASK: record.id, CHILD_PID_FILE: pidFile, CHILD_TASK: record.id });
  const stray = await zoo.member(pidFile);
  await poll(() => findByEnvironment(record.id, record.createdAt).found, (found) => found.length === 2);

  const { changed, errors } = await reconcileAndCleanup(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(changed.map((value) => value.status), ["cancelled"]);
  assert.deepEqual(read(root, record.id).engineIdentity, engine.identity);
  await poll(() => running(engine.pid) || running(stray), (alive) => !alive);
});

test("a launching record past its deadline adopts the group leader carrying its task id", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const record = create(root, input(root), now);
  const engine = zoo.leader({ CROSS_AGENT_TASK: record.id });
  await poll(() => findByEnvironment(record.id, record.createdAt).found, (found) => found.length === 1);

  const after = record.launchDeadline + 1;
  const { changed, errors } = await reconcile(root, after);
  assert.deepEqual(errors, []);
  assert.deepEqual(changed.map((value) => [value.id, value.status]), [[record.id, "orphaned"]]);
  const adopted = read(root, record.id);
  assert.deepEqual(adopted.engineIdentity, engine.identity, "the record now names the group cleanup must terminate");
  assert.equal(adopted.runnerIdentity ?? null, null);
  assert.equal(groupAlive(adopted.engineIdentity), true);

  const { changed: cleaned } = await terminateOrphans(root);
  assert.deepEqual(cleaned.map((value) => [value.status, value.reason]), [["failed", "runner lost; engine group terminated"]]);
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
  await poll(() => findByEnvironment(record.id, record.createdAt).found, (found) => found.length === 1);
  assert.deepEqual(findByEnvironment(record.id, record.createdAt).found.map((entry) => [entry.pid, entry.leader]),
    [[stray, false]]);

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
    assert.deepEqual(await reconcile(root, now + 2), { changed: [expected], invalid: [], errors: [] });
    assert.deepEqual(read(root, record.id), expected);
    assert.equal(groupAlive(engine), false, "the group is verified dead before the terminal write");
  }
  assert.deepEqual((await reconcile(root, now + 3)).changed, []);
});

test("adoption is one write: the record is never running with an engine it does not own", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const record = create(root, input(root), now);
  const engine = zoo.leader({ CROSS_AGENT_TASK: record.id });
  await poll(() => findByEnvironment(record.id, record.createdAt).found, (found) => found.length === 1);
  const file = path.join(tasks(root), `${record.id}.json`);
  const written: TaskStatus[] = [];
  // A record that is `running` with an engine identity satisfies every clause of the
  // authority match, so adoption must never pass through it, however briefly.
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
    if (to === file) written.push((JSON.parse(fs.readFileSync(from, "utf8")) as TaskRecord).status);
    return rename(from as string, to as string);
  }) as typeof fs.renameSync);
  const { changed, errors } = await reconcile(root, record.launchDeadline + 1);
  mock.mock.restore();

  assert.deepEqual(written, ["orphaned"]);
  assert.deepEqual(changed.map((value) => value.status), ["orphaned"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(read(root, record.id).engineIdentity, engine.identity);
});

test("one pass adopts the leader carrying the task id and kills everything else that does", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const record = create(root, input(root), now);
  const pidFile = path.join(root, "stray.pid");
  const engine = zoo.leader({ CROSS_AGENT_TASK: record.id, CHILD_PID_FILE: pidFile, CHILD_TASK: record.id });
  const stray = await zoo.member(pidFile);
  const second = zoo.leader({ CROSS_AGENT_TASK: record.id });
  await poll(() => findByEnvironment(record.id, record.createdAt).found, (found) => found.length === 3);

  const { changed, errors } = await reconcile(root, record.launchDeadline + 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(changed.map((value) => value.status), ["orphaned"]);
  // At most one engine per task: the lowest pid is the one adopted, and a second leader
  // carrying the same id is a stray like any other.
  const adopted = [engine, second].reduce((left, right) => (left.pid < right.pid ? left : right));
  const extra = engine.pid === adopted.pid ? second : engine;
  assert.deepEqual(read(root, record.id).engineIdentity, adopted.identity);
  await poll(() => running(stray), (alive) => !alive);
  await poll(() => running(extra.pid), (alive) => !alive);
  assert.equal(running(adopted.pid), true, "the adopted engine is left for cleanup to terminate");
});

test("a launch decision refused at the write signals nothing and is reported", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const record = create(root, input(root), now);
  const pidFile = path.join(root, "stray.pid");
  const parent = zoo.leader({ CHILD_PID_FILE: pidFile, CHILD_TASK: record.id });
  const stray = await zoo.member(pidFile);
  await poll(() => findByEnvironment(record.id, record.createdAt).found, (found) => found.length === 1);
  const file = path.join(tasks(root), `${record.id}.json`);
  const acknowledged: TaskRecord = {
    ...record, status: "running", runnerIdentity: liveIdentity(), engineIdentity: liveIdentity(), updatedAt: now + 1,
  };
  const original = fs.readFileSync;
  let reads = 0;
  // The runner acknowledges between the scan and the write. The write is the decision
  // point: because it was refused, nothing this pass found may be signalled.
  const mock = t.mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (target === file && ++reads === 2) {
      mock.mock.restore();
      fs.writeFileSync(`${file}.external`, JSON.stringify(acknowledged, null, 2) + "\n");
      fs.renameSync(`${file}.external`, file);
    }
    return (original as (target: fs.PathOrFileDescriptor, options?: unknown) => string | Buffer)(target, options);
  }) as typeof fs.readFileSync);
  const { changed, errors } = await reconcile(root, record.launchDeadline + 1);

  assert.deepEqual(changed, [], "nothing was written for this record");
  assert.deepEqual(errors.map((entry) => entry.id), [record.id]);
  assert.match(errors[0].reason, /refused/);
  assert.deepEqual(read(root, record.id), acknowledged);
  await delay(100);
  assert.equal(running(stray), true, "the acknowledged runner's engine kept its descendants");
  assert.equal(running(parent.pid), true);
});

test("a launching record with an environment it could not read waits for the next pass", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  // Dated at the moment the leader below is spawned, which is the case that matters: a
  // start time read from /proc is ticks since a boot whose wall clock `/proc/stat` gives
  // in whole seconds, so the engine of a record can compute as older than the record
  // itself, and the candidate bound gives that second back (`src/process.ts` btimeMarginMs).
  const record = create(root, input(root), now);
  const hidden = zoo.leader({ CROSS_AGENT_TASK: record.id });
  await poll(() => findByEnvironment(record.id, record.createdAt).found, (found) => found.length === 1);
  const original = fs.readFileSync;
  const mock = t.mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (target === `/proc/${hidden.pid}/environ`) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return (original as (target: fs.PathOrFileDescriptor, options?: unknown) => string | Buffer)(target, options);
  }) as typeof fs.readFileSync);
  const blind = await reconcile(root, record.launchDeadline + 1);
  mock.mock.restore();

  // Declaring the launch failed would leave that engine running with nothing to own it.
  assert.deepEqual(blind.changed, []);
  assert.deepEqual(blind.errors.map((entry) => entry.id), [record.id]);
  assert.match(blind.errors[0].reason, /environ unreadable for 1 process/);
  assert.equal(read(root, record.id).status, "launching");
  assert.equal(running(hidden.pid), true);

  const seeing = await reconcile(root, record.launchDeadline + 2);
  assert.deepEqual(seeing.errors, []);
  assert.deepEqual(seeing.changed.map((value) => value.status), ["orphaned"], "the next pass judges it");
});

test("a record held open by an environment it could not read is failed once the hold expires", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const record = create(root, input(root), now);
  // A same-uid non-dumpable leader started during the task is answered by waiting, and
  // waiting for ever is no answer: past the hold the launch is failed, and the count of
  // what could not be read is on the record for the operator who has to explain it.
  const hidden = zoo.leader({ CROSS_AGENT_TASK: record.id });
  await poll(() => findByEnvironment(record.id, record.createdAt).found, (found) => found.length === 1);
  const original = fs.readFileSync;
  const mock = t.mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (target === `/proc/${hidden.pid}/environ`) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return (original as (target: fs.PathOrFileDescriptor, options?: unknown) => string | Buffer)(target, options);
  }) as typeof fs.readFileSync);
  const held = await reconcile(root, record.launchDeadline + 5 * 60 * 1000);
  const expired = await reconcile(root, record.launchDeadline + 5 * 60 * 1000 + 1);
  mock.mock.restore();

  assert.deepEqual(held.changed, [], "the hold is not over until it is over");
  assert.deepEqual(expired.changed.map((value) => [value.status, value.reason]), [["failed", "launch; environ unreadable for 1 process"]]);
  assert.deepEqual(expired.errors, []);
  assert.equal(read(root, record.id).engineIdentity, undefined, "nothing was adopted: nothing could be read");
  assert.equal(running(hidden.pid), true, "and the process it could not read is left alone");
});

test("a record whose group will not die is reported, and the pass judges the rest", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const stubborn = zoo.leader();
  const cancelling = await started(root, "cancelling", now);
  await change(root, cancelling.id, { runnerIdentity: deadIdentity(), engineIdentity: stubborn.identity }, now + 1);
  const other = await started(root, "running", now);
  await change(root, other.id, { runnerIdentity: deadIdentity(), engineIdentity: deadIdentity() }, now + 1);

  const denied = Object.assign(new Error("not permitted"), { code: "EPERM" });
  // The original, captured before the mock replaces it: reading `process.kill` from
  // inside the mock would read the mock, and the fallback would signal nothing at all.
  const kill = process.kill.bind(process) as (pid: number, signal?: string | number) => true;
  const mocked = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid === -stubborn.pid) throw denied;
    return kill(pid, signal);
  });
  const { changed, errors } = await reconcile(root, now + 2);
  mocked.mock.restore();

  assert.deepEqual(errors.map((entry) => entry.id), [cancelling.id]);
  assert.match(errors[0].reason, /did not terminate/);
  assert.equal(read(root, cancelling.id).status, "cancelling", "the record keeps its status for the next pass");
  assert.equal(groupAlive(stubborn.identity), true);
  // One record's failure is not the pass's: every other record was still judged.
  assert.deepEqual(changed.map((value) => [value.id, value.status]), [[other.id, "failed"]]);
});

test("a reconciler carrying the task id in its own environment never signals itself", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const record = create(root, input(root), now);
  const engine = zoo.leader({ CROSS_AGENT_TASK: record.id });
  await poll(() => findByEnvironment(record.id, record.createdAt).found, (found) => found.length === 1);
  const outcome = path.join(root, "reconciled.json");
  const siblingFile = path.join(root, "sibling.pid");
  // The MCP server inherits CROSS_AGENT_TASK from the engine that started it, and
  // reconciliation runs on every listing: this is a server reconciling the very task it
  // was launched for. Finding itself, or a child in its own group, and calling it a
  // stray would kill the server mid-pass.
  const script = `
import fs from "node:fs";
import { spawn } from "node:child_process";
import { reconcile } from ${JSON.stringify(pathToFileURL(path.join(worktree, "src", "reconcile.ts")).href)};
const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.argv[4], String(sibling.pid));
await new Promise((resolve) => setTimeout(resolve, 100));
const result = await reconcile(process.argv[2], Number(process.argv[3]));
fs.writeFileSync(process.argv[5], JSON.stringify({ ...result, self: process.pid, sibling: sibling.pid }));
sibling.kill("SIGKILL");
`;
  const file = path.join(root, "reconciler.mjs");
  fs.writeFileSync(file, script);
  const reconciler = spawn(process.execPath, [file, root, String(record.launchDeadline + 1), siblingFile, outcome], {
    stdio: "ignore", env: { ...process.env, CROSS_AGENT_TASK: record.id },
  });
  const sibling = Number(await poll(() => (fs.existsSync(siblingFile) ? fs.readFileSync(siblingFile, "utf8") : ""), (text) => text.length > 0));
  t.after(async () => {
    try { process.kill(sibling, "SIGKILL"); } catch { /* already gone */ }
    reconciler.kill("SIGKILL");
    await poll(() => running(sibling), (alive) => !alive);
  });
  const [code] = await once(reconciler, "close");

  assert.equal(code, 0, "the reconciler survived its own pass");
  const result = JSON.parse(fs.readFileSync(outcome, "utf8")) as { changed: TaskRecord[]; errors: unknown[] };
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.changed.map((value) => value.status), ["orphaned"]);
  assert.deepEqual(read(root, record.id).engineIdentity, engine.identity, "the detached engine is still what was adopted");
});

test("a reconciler inside the engine's own session defers the launch instead of settling it", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const record = create(root, input(root), now);
  const outcome = path.join(root, "reconciled.json");
  const pidFile = path.join(root, "reconciler.pid");
  const exitFile = path.join(root, "reconciler.exit");
  // An MCP server started by an engine lives in that engine's session and inherits its
  // CROSS_AGENT_TASK. Reconciling from there, this server can neither adopt the engine
  // — cleanup would then kill the group it is running in — nor call it a stray. What it
  // must never do is settle the record: that would leave a terminal record with no
  // identity and a live engine nothing can reach.
  const reconciler = path.join(root, "reconciler.mjs");
  fs.writeFileSync(reconciler, `
import fs from "node:fs";
import { reconcile } from ${JSON.stringify(pathToFileURL(path.join(worktree, "src", "reconcile.ts")).href)};
const result = await reconcile(process.argv[2], Number(process.argv[3]));
fs.writeFileSync(process.argv[4], JSON.stringify(result));
`);
  // The leader is the only process that can say how its own child ended, because it is
  // the one that reaps it. It records that exit for the assertion below.
  const leaderScript = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [process.argv[1], process.argv[2], process.argv[3], process.argv[4]], { stdio: "ignore" });
child.on("exit", (code, signal) => fs.writeFileSync(process.argv[6], JSON.stringify({ code, signal })));
fs.writeFileSync(process.argv[5], String(child.pid));
setInterval(() => {}, 1000);
`;
  const engine = zoo.leader({ CROSS_AGENT_TASK: record.id }, leaderScript,
    [reconciler, root, String(record.launchDeadline + 1), outcome, pidFile, exitFile]);
  const child = await zoo.member(pidFile);
  const result = JSON.parse(await poll(
    () => (fs.existsSync(outcome) ? fs.readFileSync(outcome, "utf8") : ""), (text) => text.length > 0,
  )) as Reconciled;

  assert.deepEqual(result.changed, [], "nothing was written over a live engine");
  assert.deepEqual(result.errors.map((entry) => entry.id), [record.id]);
  assert.match(result.errors[0].reason, new RegExp(`engine ${engine.pid} shares this reconciler's session`));
  assert.equal(read(root, record.id).status, "launching");
  assert.equal(running(engine.pid), true, "and the engine it could not judge is untouched");
  // The reconciler did not signal itself. Its own liveness cannot be read once the
  // outcome file exists — writing that file is its last act, and it exits and is reaped
  // immediately after — so the evidence is the exit its leader saw: no signal, code 0.
  assert.deepEqual(JSON.parse(await poll(
    () => (fs.existsSync(exitFile) ? fs.readFileSync(exitFile, "utf8") : ""), (text) => text.length > 0,
  )), { code: 0, signal: null }, `reconciler ${child} ended of its own accord`);

  // A server in another session has no such conflict, and adopts it.
  const { changed, errors } = await reconcile(root, record.launchDeadline + 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(changed.map((value) => value.status), ["orphaned"]);
  assert.deepEqual(read(root, record.id).engineIdentity, engine.identity);
});

test("cleanup judges the records of its own group last, so the rest are settled before it dies", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  // Two orphaned records: one whose engine is a group this server is not in, and one
  // whose engine is the very engine this server runs inside. Cleanup terminates an
  // orphan's group, and terminating the second kills this process with it — so the pass
  // takes that record last, and everything it can settle is settled first. The record of
  // its own group is left orphaned for another server, which is the only honest answer a
  // process that is about to die can give.
  const foreign = await started(root, "orphaned", now);
  const stranger = zoo.leader();
  await change(root, foreign.id, { runnerIdentity: deadIdentity(), engineIdentity: stranger.identity }, now + 1);

  const pidFile = path.join(root, "reconciler.pid");
  const start = path.join(root, "start");
  const cleaner = path.join(root, "cleaner.mjs");
  // The pass runs on the ledger as the test leaves it, never on a half-written one: the
  // record naming this cleaner's own engine cannot exist before the engine does, so the
  // cleaner waits to be told both records are there.
  fs.writeFileSync(cleaner, `
import fs from "node:fs";
import { terminateOrphans } from ${JSON.stringify(pathToFileURL(path.join(worktree, "src", "process.ts")).href)};
while (!fs.existsSync(process.argv[3])) await new Promise((resolve) => setTimeout(resolve, 10));
await terminateOrphans(process.argv[2]);
`);
  const leaderScript = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [process.argv[1], process.argv[2], process.argv[3]], { stdio: "ignore" });
fs.writeFileSync(process.argv[4], String(child.pid));
setInterval(() => {}, 1000);
`;
  // Listed newest first, so the record of this server's own engine is the one the pass
  // would reach first if nothing ordered it.
  const engine = zoo.leader({}, leaderScript, [cleaner, root, start, pidFile]);
  const own = await started(root, "orphaned", now + 2);
  await change(root, own.id, { runnerIdentity: deadIdentity(), engineIdentity: engine.identity }, now + 3);
  const child = await zoo.member(pidFile);
  fs.writeFileSync(start, "");

  await poll(() => read(root, foreign.id).status, (status) => status === "failed", 8000);
  assert.equal(read(root, foreign.id).reason, "runner lost; engine group terminated", "the record it could settle was settled");
  // The group goes down together, but not in one instant: the leader and the pass inside
  // it are two processes, and which of them the kernel reaps first is not the point.
  await poll(() => running(engine.pid) || running(child), (alive) => !alive, 8000);
  assert.equal(read(root, own.id).status, "orphaned", "and left its own record for another server");
});

test("a pass settles every record it can before it judges its own group", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  // One record this server can settle — an orphan of a group that is already gone — and
  // one it can only die on: a `cancelling` record whose engine is the engine this server
  // runs inside, which the pass terminates by the identity the record carries. Judging
  // that one inside reconciliation's own loop killed the pass before cleanup ever ran,
  // so the orphan it could have settled was left for another server (finding T3b-6).
  const settleable = await started(root, "orphaned", now);
  const stranger = zoo.leader();
  await zoo.reap(stranger);
  await change(root, settleable.id, { runnerIdentity: deadIdentity(), engineIdentity: stranger.identity }, now + 1);

  const pidFile = path.join(root, "reconciler.pid");
  const start = path.join(root, "start");
  const passFile = path.join(root, "pass.mjs");
  fs.writeFileSync(passFile, `
import fs from "node:fs";
import { reconcileAndCleanup } from ${JSON.stringify(pathToFileURL(path.join(worktree, "src", "reconcile.ts")).href)};
while (!fs.existsSync(process.argv[3])) await new Promise((resolve) => setTimeout(resolve, 10));
await reconcileAndCleanup(process.argv[2], Number(process.argv[4]));
`);
  const leaderScript = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [process.argv[1], process.argv[2], process.argv[3], process.argv[4]], { stdio: "ignore" });
fs.writeFileSync(process.argv[5], String(child.pid));
setInterval(() => {}, 1000);
`;
  const engine = zoo.leader({}, leaderScript, [passFile, root, start, String(now + 2), pidFile]);
  const own = await started(root, "cancelling", now + 2);
  await change(root, own.id, { runnerIdentity: deadIdentity(), engineIdentity: engine.identity }, now + 3);
  const child = await zoo.member(pidFile);
  fs.writeFileSync(start, "");

  await poll(() => read(root, settleable.id).status, (status) => status === "failed", 8000);
  assert.equal(read(root, settleable.id).reason, "runner lost");
  await poll(() => running(engine.pid) || running(child), (alive) => !alive, 8000);
  assert.equal(read(root, own.id).status, "cancelling", "its own record is left for another server");
});

test("an engine adopted beside one in this reconciler's own session names the survivor", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const record = create(root, input(root), now);
  const outcome = path.join(root, "reconciled.json");
  const pidFile = path.join(root, "reconciler.pid");
  const exitFile = path.join(root, "reconciler.exit");
  // Two processes carry this task id: a detached engine from an earlier runner, and the
  // engine this server is running inside. The first is adopted; the second is neither
  // adopted nor killed, and saying nothing about it would leave a live process carrying
  // a task id that the record now names another engine for.
  const stranded = zoo.leader({ CROSS_AGENT_TASK: record.id });
  const reconciler = path.join(root, "reconciler.mjs");
  fs.writeFileSync(reconciler, `
import fs from "node:fs";
import { reconcile } from ${JSON.stringify(pathToFileURL(path.join(worktree, "src", "reconcile.ts")).href)};
const result = await reconcile(process.argv[2], Number(process.argv[3]));
fs.writeFileSync(process.argv[4], JSON.stringify(result));
`);
  const leaderScript = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [process.argv[1], process.argv[2], process.argv[3], process.argv[4]], { stdio: "ignore" });
child.on("exit", (code, signal) => fs.writeFileSync(process.argv[6], JSON.stringify({ code, signal })));
fs.writeFileSync(process.argv[5], String(child.pid));
setInterval(() => {}, 1000);
`;
  const own = zoo.leader({ CROSS_AGENT_TASK: record.id }, leaderScript,
    [reconciler, root, String(record.launchDeadline + 1), outcome, pidFile, exitFile]);
  await zoo.member(pidFile);
  const result = JSON.parse(await poll(
    () => (fs.existsSync(outcome) ? fs.readFileSync(outcome, "utf8") : ""), (text) => text.length > 0,
  )) as Reconciled;

  assert.deepEqual(result.changed.map((value) => value.status), ["orphaned"]);
  assert.deepEqual(read(root, record.id).engineIdentity!.pid, stranded.pid, "the engine of another session is the one adopted");
  assert.deepEqual(result.errors.map((entry) => entry.id), [record.id]);
  assert.match(result.errors[0].reason, new RegExp(`engine ${own.pid}`));
  assert.equal(running(own.pid), true, "and the one it named is left alone");
});

test("a stray that cannot be signalled is reported without losing the write that applied", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const record = create(root, input(root), now);
  const pidFile = path.join(root, "stray.pid");
  const engine = zoo.leader({ CROSS_AGENT_TASK: record.id, CHILD_PID_FILE: pidFile, CHILD_TASK: record.id });
  const stray = await zoo.member(pidFile);
  await poll(() => findByEnvironment(record.id, record.createdAt).found, (found) => found.length === 2);

  const denied = Object.assign(new Error("not permitted"), { code: "EPERM" });
  const kill = process.kill.bind(process) as (pid: number, signal?: string | number) => true;
  const mocked = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid === stray) throw denied;
    return kill(pid, signal);
  });
  const { changed, errors } = await reconcile(root, record.launchDeadline + 1);
  mocked.mock.restore();

  // The decision was written; a stray it then could not signal is news about that
  // record, not a reason to report the adoption as if it had never happened.
  assert.deepEqual(changed.map((value) => value.status), ["orphaned"]);
  assert.deepEqual(read(root, record.id).engineIdentity, engine.identity);
  assert.deepEqual(errors.map((entry) => entry.id), [record.id]);
  assert.match(errors[0].reason, new RegExp(`stray ${stray}.*not permitted`));
  assert.equal(running(stray), true);
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
  assert.deepEqual(await reconcile(root, now + 3), { changed: [], invalid: [], errors: [] });
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
  const { changed, errors } = await reconcile(root, record.launchDeadline + 1);
  assert.deepEqual(changed, []);
  assert.deepEqual(errors, [{ id: record.id, reason: "launch decision refused: the record is running" }]);
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
  assert.deepEqual(await reconcile(root, now + 60_000), { changed: [], invalid: [], errors: [] });
  assert.deepEqual(list(root), before);
});

test("reconciliation reports unreadable record files and judges the rest", async (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  fs.writeFileSync(path.join(tasks(root), "damaged.json"), "{ not json");
  const after = record.launchDeadline + 1;
  const { changed, invalid, errors } = await reconcile(root, after);
  assert.deepEqual(errors, []);
  assert.deepEqual(changed.map((value) => [value.id, value.status]), [[record.id, "failed"]]);
  assert.deepEqual(invalid.map((entry) => path.basename(entry.file)), ["damaged.json"]);
  assert.ok(invalid[0].reason.length > 0);
  assert.deepEqual(await terminateOrphans(root), { changed: [], skipped: [] });
  assert.deepEqual(await reconcileAndCleanup(root, after + 1), { changed: [], invalid, errors: [], cleaned: [], skipped: [] });
});

test("reconcileAndCleanup settles the orphans of its own pass", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  const engine = zoo.leader();
  const record = await started(root, "running", now);
  await change(root, record.id, { runnerIdentity: deadIdentity(), engineIdentity: engine.identity }, now + 1);
  const result = await reconcileAndCleanup(root, now + 2);
  assert.deepEqual(result.changed.map((value) => value.status), ["orphaned"]);
  assert.deepEqual(result.cleaned.map((value) => [value.status, value.reason]), [["failed", "runner lost; engine group terminated"]]);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(read(root, record.id).status, "failed");
  assert.equal(groupAlive(engine.identity), false, "no caller can see an orphan whose group is still being decided");
});

/** The outcome a runner records beside a task before it attempts its terminal write. */
function recordOutcome(root: string, record: TaskRecord, outcome: Record<string, unknown>): void {
  fs.writeFileSync(path.join(tasks(root), `${record.id}.outcome.json`), JSON.stringify(outcome));
}

test("an orphan is settled from the outcome its runner recorded, never from the result file", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  // A runner writes what the engine did beside the record before it tries to settle it,
  // because the record may already belong to an adoption that beat it. That file is the
  // evidence, and the result file is not: the pipeline writes the engine's last word
  // there whether the run succeeded or failed, so text in it proves only that something
  // ended (bead atc-s96.30, finding T3b-1).
  const succeeded = await started(root, "orphaned", now);
  const first = zoo.leader();
  await zoo.reap(first);
  fs.writeFileSync(succeeded.resultPath, "the brief is implemented\n");
  recordOutcome(root, succeeded, { kind: "done", exitCode: 0, sessionId: "session-done", at: now + 1 });
  await change(root, succeeded.id, { runnerIdentity: deadIdentity(), engineIdentity: first.identity }, now + 1);

  // The run the old rule settled `done`: a failed engine's error text is in the result
  // file too, and only the runner's own record tells the two apart.
  const failed = await started(root, "orphaned", now);
  const second = zoo.leader();
  await zoo.reap(second);
  fs.writeFileSync(failed.resultPath, "engine exited 2\n");
  recordOutcome(root, failed, { kind: "failed", exitCode: 2, sessionId: "session-failed", reason: "fake failure", at: now + 1 });
  await change(root, failed.id, { runnerIdentity: deadIdentity(), engineIdentity: second.identity }, now + 1);

  // No outcome file: the runner never got that far. The result file is named rather than
  // read, so an operator can find the text without the ledger calling it a success.
  const lost = await started(root, "orphaned", now);
  const third = zoo.leader();
  await zoo.reap(third);
  fs.writeFileSync(lost.resultPath, "half a sentence from someone\n");
  await change(root, lost.id, { runnerIdentity: deadIdentity(), engineIdentity: third.identity }, now + 1);

  // An outcome file older than the record it sits beside belongs to nothing this record
  // knows about, so it is refused and the record settles as if there were none.
  const stale = await started(root, "orphaned", now);
  const fourth = zoo.leader();
  await zoo.reap(fourth);
  recordOutcome(root, stale, { kind: "done", exitCode: 0, sessionId: "session-stale", at: now - 1 });
  await change(root, stale.id, { runnerIdentity: deadIdentity(), engineIdentity: fourth.identity }, now + 1);

  const { changed, skipped } = await terminateOrphans(root);
  assert.deepEqual(skipped, []);
  const byId = new Map(changed.map((value) => [value.id, value]));
  assert.deepEqual([byId.get(succeeded.id)!.status, byId.get(succeeded.id)!.exitCode, byId.get(succeeded.id)!.sessionId],
    ["done", 0, "session-done"]);
  assert.deepEqual([byId.get(failed.id)!.status, byId.get(failed.id)!.reason, byId.get(failed.id)!.exitCode],
    ["failed", "fake failure", 2]);
  assert.deepEqual([byId.get(lost.id)!.status, byId.get(lost.id)!.reason],
    ["failed", `runner lost; result text present at ${lost.resultPath}`]);
  assert.deepEqual([byId.get(stale.id)!.status, byId.get(stale.id)!.reason], ["failed", "runner lost"]);
});

test("a group the cleanup itself had to kill is a lost runner, whatever any outcome file says", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  // The engine was still running when the pass met it, so it did not end on its own —
  // cleanup ended it. Reading an outcome beside that record would settle a task this
  // pass just killed, and reading the result file would settle a Codex task by the empty
  // file the pipeline pre-creates for `-o` (finding T3b-2).
  const record = await started(root, "orphaned", now);
  const engine = zoo.leader();
  fs.writeFileSync(record.resultPath, "");
  recordOutcome(root, record, { kind: "done", exitCode: 0, sessionId: "session-done", at: now + 1 });
  await change(root, record.id, { runnerIdentity: deadIdentity(), engineIdentity: engine.identity }, now + 1);

  const { changed, skipped } = await terminateOrphans(root);
  assert.deepEqual(skipped, []);
  assert.deepEqual(changed.map((value) => [value.status, value.reason]),
    [["failed", "runner lost; engine group terminated"]]);
  assert.equal(groupAlive(engine.identity), false);
});

test("a running task whose runner and engine are both gone is settled from the same outcome file", async (t) => {
  const root = project(t);
  const zoo = processes(t);
  // `judge` and cleanup meet the same evidence in different states, and an operator
  // cannot be told a task failed by one pass and succeeded by another (finding T3b-3).
  const record = await started(root, "running", now);
  const engine = zoo.leader();
  await zoo.reap(engine);
  recordOutcome(root, record, { kind: "done", exitCode: 0, sessionId: "session-judged", at: now + 1 });
  await change(root, record.id, { runnerIdentity: deadIdentity(), engineIdentity: engine.identity }, now + 1);

  const { changed, errors } = await reconcile(root, now + 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(changed.map((value) => [value.status, value.exitCode, value.sessionId]), [["done", 0, "session-judged"]]);
});

test("a pass waits the configured lockWaitSeconds for a record it cannot write", async (t) => {
  const root = project(t);
  configure(root, 0);
  const record = await started(root, "running", now);
  await change(root, record.id, { runnerIdentity: deadIdentity() }, now + 1);

  // Another writer holds the record lock. Every lock in the project waits
  // limits.lockWaitSeconds and then refuses, so a pass configured not to wait reports the
  // record it could not judge at once instead of blocking on each one in turn.
  const lock = await acquire(lockPath(root, recordLockName(record.id)), { operation: "a competing writer", waitSeconds: 5 });
  t.after(() => lock.release());
  const at = Date.now();
  const { changed, errors } = await reconcile(root, now + 2);
  const elapsed = Date.now() - at;
  assert.deepEqual(changed, []);
  assert.deepEqual(errors.map((entry) => entry.id), [record.id]);
  assert.match(errors[0].reason, /waited 0s/);
  assert.ok(elapsed < 1000, `the pass took ${elapsed}ms`);
  assert.equal(read(root, record.id).status, "running", "and the record it could not take is untouched");
});

test("orphan cleanup waits the configured lockWaitSeconds for each settlement", async (t) => {
  const root = project(t);
  configure(root, 0);
  const record = await started(root, "orphaned", now);
  // An identity from another boot is dead however alive that pid looks now, so cleanup has
  // nothing to signal and goes straight to the settlement this test holds the lock on.
  await change(root, record.id, { engineIdentity: { pid: 2, pgid: 2, startTime: "1", bootId: "an earlier boot" } }, now + 1);

  const lock = await acquire(lockPath(root, recordLockName(record.id)), { operation: "a competing writer", waitSeconds: 5 });
  t.after(() => lock.release());
  const at = Date.now();
  await assert.rejects(terminateOrphans(root), /waited 0s/);
  const elapsed = Date.now() - at;
  assert.ok(elapsed < 1000, `cleanup took ${elapsed}ms`);
});
