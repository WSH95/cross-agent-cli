import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { create, read, update, list, scan, InvalidRecordError, isProcessAlive, isTerminal, readProcessStat, currentBootId, writeAtomic } from "../src/ledger.ts";
import type { CreateTask, EngineIdentity, TaskPatch, TaskRecord, TaskStatus, UpdateOptions } from "../src/ledger.ts";
import { acquire, lockPath, recordLockName } from "../src/locks.ts";
import { poll } from "./helpers/project.ts";

const now = 1_000_000;
const statuses: TaskStatus[] = ["launching", "running", "stalled", "orphaned", "cancelling", "done", "failed", "cancelled"];

// Design section 2, E1: every status change update may write. Anything else is a bug
// in a writer, not a race to tolerate, so update throws instead of refusing.
const legalTransitions: Record<TaskStatus, TaskStatus[]> = {
  launching: ["running", "cancelling", "failed", "orphaned"],
  running: ["stalled", "cancelling", "orphaned", "done", "failed"],
  stalled: ["running", "cancelling", "orphaned", "done", "failed"],
  // orphaned -> done is reconciliation settling a record from the result an engine that
  // finished left behind, which no runner was left to write (bead atc-s96.30).
  orphaned: ["done", "failed", "cancelled"],
  cancelling: ["cancelled", "failed"],
  done: [],
  failed: [],
  cancelled: [],
};

// One legal path from launching to each status, so a test can start anywhere.
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
  const root = fs.mkdtempSync(path.join(tmpdir(), "cross-agent-ledger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function input(cwd: string): CreateTask {
  return { role: "implementer", brief: "Implement the ledger.\nKeep task state durable.", cwd, engine: "codex", model: "test-model" };
}

function tasks(root: string): string {
  return path.join(root, ".cross-agent", "tasks");
}

function bootId(): string {
  return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

function liveIdentity(): EngineIdentity {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return { pid: process.pid, startTime: fields[19], pgid: Number(fields[2]), bootId: bootId() };
}

function deadIdentity(): EngineIdentity {
  const live = liveIdentity();
  return { ...live, startTime: String(BigInt(live.startTime) + 1n) };
}

/** update, asserting it applied, for the many callers that only want the new record. */
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

test("isTerminal names the three settled statuses, and nothing else", () => {
  // One definition of settled, shared by every reader: the reservation asks it whether a
  // task has let its workspace go, and the runner and reconciler judge the same way.
  for (const status of statuses) {
    assert.equal(isTerminal(status), ["done", "failed", "cancelled"].includes(status), status);
  }
});

test("writeAtomic replaces a whole file by rename and leaves no temporary behind", (t) => {
  const root = project(t);
  const file = path.join(root, "value.json");
  writeAtomic(file, { one: 1 });
  assert.equal(fs.readFileSync(file, "utf8"), `${JSON.stringify({ one: 1 }, null, 2)}\n`);
  const first = fs.statSync(file).ino;
  writeAtomic(file, { two: 2 });
  assert.notEqual(fs.statSync(file).ino, first, "a reader sees the whole old file or the whole new one");
  assert.deepEqual(fs.readdirSync(root), ["value.json"]);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => writeAtomic(file, circular));
  assert.deepEqual(fs.readdirSync(root), ["value.json"], "a value that cannot be written leaves nothing behind");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { two: 2 });
});

test("create persists a launching record that read returns", (t) => {
  const root = project(t);
  const data = input(root);
  const record = create(root, data, now);
  assert.match(record.id, /^[A-Za-z0-9_-]+$/);
  assert.equal("launchToken" in record, false, "ownership is the runner lock, not a token in a readable file");
  assert.equal(record.role, data.role);
  assert.equal(record.briefHash, createHash("sha256").update(data.brief).digest("hex"));
  assert.equal(record.cwd, root);
  assert.equal(record.engine, data.engine);
  assert.equal(record.model, data.model);
  assert.equal(record.status, "launching");
  assert.equal(record.createdAt, now);
  assert.equal(record.updatedAt, now);
  assert.equal(record.launchDeadline, now + 30_000);
  assert.equal(record.runnerIdentity, undefined);
  assert.equal(record.engineIdentity, undefined);
  assert.equal(record.resultPath, path.join(tasks(root), `${record.id}.out`));
  assert.equal(record.logPath, path.join(tasks(root), `${record.id}.ndjson`));
  assert.equal(fs.existsSync(record.resultPath), false);
  assert.equal(fs.existsSync(record.logPath), false);
  assert.deepEqual(read(root, record.id), record);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tasks(root), `${record.id}.json`), "utf8")), record);
  assert.equal("brief" in record, false);

  const second = create(path.relative(process.cwd(), root), { ...data, model: undefined }, now);
  assert.notEqual(second.id, record.id);
  assert.equal(path.isAbsolute(second.resultPath), true);
  assert.equal(path.isAbsolute(second.logPath), true);
  assert.deepEqual(read(root, second.id), second);
});

test("update merges fields, advances updatedAt, and reports that it applied", async (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  const patch: TaskPatch = {
    status: "running", runnerIdentity: liveIdentity(), engineIdentity: liveIdentity(),
    lastEventAt: now + 10, exitCode: null, sessionId: "engine-session",
  };
  const changed = { ...record, ...patch, updatedAt: now + 20 };
  assert.deepEqual(await update(root, record.id, patch, now + 20), { applied: true, record: changed });
  assert.deepEqual(read(root, record.id), changed);

  const protectedFields = { id: "replacement", createdAt: 0, updatedAt: 0, reason: "metadata" };
  const metadata = await change(root, record.id, protectedFields, now + 30);
  assert.deepEqual(metadata, { ...changed, reason: "metadata", updatedAt: now + 30 });
  assert.equal(fs.existsSync(path.join(tasks(root), "replacement.json")), false);
});

test("update writes only the legal status transitions and throws on the rest", async (t) => {
  const root = project(t);
  for (const from of statuses) {
    for (const to of statuses) {
      const record = await started(root, from, now);
      const before = read(root, record.id);
      assert.equal(before.status, from);
      if (to === from || legalTransitions[from].includes(to)) {
        const after = await change(root, record.id, { status: to, reason: "moved" }, now + 5);
        assert.deepEqual(after, { ...before, status: to, reason: "moved", updatedAt: now + 5 });
        continue;
      }
      await assert.rejects(
        update(root, record.id, { status: to }, now + 5),
        (error: Error) => new RegExp(`cannot change.*task .* from ${from} to ${to}`).test(error.message)
          && (["done", "failed", "cancelled"].includes(from) ? /terminal/.test(error.message) : true),
      );
      assert.deepEqual(read(root, record.id), before, "a refused transition leaves the record alone");
    }
  }
});

test("update refuses every patch to a terminal record when unlessTerminal is set", async (t) => {
  const root = project(t);
  for (const terminal of ["done", "failed", "cancelled"] as const) {
    const record = await started(root, terminal, now);
    const settled = await change(root, record.id, { reason: "settled" }, now + 1);
    const file = path.join(tasks(root), `${record.id}.json`);
    const bytes = fs.readFileSync(file);
    const entries = fs.readdirSync(tasks(root));
    const listing = list(root);
    const patches: TaskPatch[] = [
      { status: terminal }, { status: terminal, exitCode: 0 }, { reason: "overwritten" }, { lastEventAt: now + 5 },
      { status: terminal, reason: "overwritten", updatedAt: 0 } as TaskPatch,
      ...statuses.filter((status) => status !== terminal).map((status) => ({ status })),
    ];
    for (const patch of patches) {
      assert.deepEqual(
        await update(root, record.id, patch, now + 2, { unlessTerminal: true }),
        { applied: false, record: settled, reason: "terminal" },
        "an illegal transition is refused, not thrown, once the record is terminal",
      );
      assert.deepEqual(fs.readFileSync(file), bytes, "the terminal record's bytes are untouched");
    }
    assert.deepEqual(fs.readdirSync(tasks(root)), entries, "no temporary file was created");
    assert.deepEqual(list(root), listing);
  }

  const active = create(root, input(root), now);
  const running = await change(root, active.id, { status: "running", lastEventAt: now + 1 }, now + 1, { unlessTerminal: true });
  assert.deepEqual(running, { ...active, status: "running", lastEventAt: now + 1, updatedAt: now + 1 });
  assert.deepEqual(read(root, active.id), running);
  const finished = await change(root, active.id, { status: "done", exitCode: 0 }, now + 2, { unlessTerminal: true });
  assert.deepEqual(read(root, active.id), { ...running, status: "done", exitCode: 0, updatedAt: now + 2 });
  assert.deepEqual(await update(root, active.id, { exitCode: 1 }, now + 3, { unlessTerminal: true }),
    { applied: false, record: finished, reason: "terminal" });
  assert.deepEqual(read(root, active.id), finished);
  assert.equal((await change(root, active.id, { exitCode: 1 }, now + 4)).exitCode, 1,
    "without the option, T1's same-status metadata permission stands");
});

test("expect decides inside the lock, after the terminal check, and refuses without writing", async (t) => {
  const root = project(t);
  const record = await started(root, "running", now);
  const running = read(root, record.id);
  const seen: TaskRecord[] = [];
  assert.deepEqual(
    await update(root, record.id, { status: "done" }, now + 1, { expect: (current) => { seen.push(current); return false; } }),
    { applied: false, record: running, reason: "expect" },
  );
  assert.deepEqual(seen, [running], "expect saw the record as read inside the lock");
  assert.deepEqual(read(root, record.id), running, "a refused write changes nothing");

  const stalled = await change(root, record.id, { status: "stalled" }, now + 2, { expect: (current) => current.status === "running" });
  assert.equal(stalled.status, "stalled");

  // The record a refusal carries is the state that beat the caller, so a caller can act on it.
  const cancelling = await change(root, record.id, { status: "cancelling" }, now + 3);
  const refused = await update(root, record.id, { status: "running" }, now + 4, { expect: (current) => current.status === "stalled" });
  assert.deepEqual(refused, { applied: false, record: cancelling, reason: "expect" });

  const cancelled = await change(root, record.id, { status: "cancelled" }, now + 5);
  let evaluated = false;
  assert.deepEqual(
    await update(root, record.id, { reason: "late" }, now + 6, { unlessTerminal: true, expect: () => { evaluated = true; return true; } }),
    { applied: false, record: cancelled, reason: "terminal" },
    "the terminal check precedes expect, so a terminal record is always reason terminal",
  );
  assert.equal(evaluated, false);
});

test("update takes the record lock, refuses to guess when it cannot, and releases it", async (t) => {
  const root = project(t);
  const record = await started(root, "running", now);
  const file = lockPath(root, recordLockName(record.id));
  assert.equal(fs.existsSync(file), true, "the record lock was taken for the writes so far");
  // The competitor is a process of its own, the way every real one is, and its stderr is
  // kept rather than ignored: a refusal below has to be contention, and `flock` saying
  // anything at all would mean it was something else. Its `held` line is the barrier —
  // nothing here runs before the kernel has granted it the lock.
  const holder = spawn("flock", ["-w", "30", file, "sh", "-c", "echo held; read _"],
    { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { holder.kill("SIGKILL"); });
  let noise = "";
  holder.stderr.on("data", (chunk: Buffer) => { noise += chunk.toString("utf8"); });
  let granted = "";
  holder.stdout.on("data", (chunk: Buffer) => { granted += chunk.toString("utf8"); });
  await poll(() => granted, (text) => text.includes("held"));

  // A caller that could not even look at the record must not read that as a refusal.
  await assert.rejects(
    update(root, record.id, { status: "done" }, now + 1, { waitSeconds: 0 }),
    (error: Error) => error.message === `update task ${record.id}: lock ${file} is held by another process (waited 0s)`,
  );
  assert.equal(read(root, record.id).status, "running");

  // The newline alone releases it. `Lock.release` writes one before the pipe it wrote it
  // on is closed, so a caller that blocks its own loop straight after releasing still
  // frees the lock (`src/locks.ts#acquire`); here the pipe is left open to prove it.
  holder.stdin.write("\n");
  const [code] = await once(holder, "close");
  assert.equal(code, 0);
  assert.equal(noise, "", "flock said nothing: what refused the write above was contention");
  assert.equal((await change(root, record.id, { status: "done" }, now + 2)).status, "done");
  const second = await acquire(file, { operation: "test holder", waitSeconds: 1 });
  await second.release();
});

test("a record carrying a status this build does not know is named, and no writer crashes on it", async (t) => {
  const root = project(t);
  const record = await started(root, "running", now);
  fs.writeFileSync(path.join(tasks(root), `${record.id}.json`), JSON.stringify({ ...record, status: "quiesced" }));
  // A later build's status reaches this one through the record file. Reading the record
  // names it, and a write over it is refused by the same sentence rather than by a
  // TypeError out of a transition table that has no row for it.
  assert.throws(() => read(root, record.id), /status must be one of/);
  await assert.rejects(update(root, record.id, { status: "done" }, now + 1), /status must be one of/);
  const { records, invalid } = scan(root);
  assert.deepEqual(records, [], "a record nobody can judge is not listed as one that can be");
  assert.deepEqual(invalid.map((entry) => path.basename(entry.file)), [`${record.id}.json`]);
  assert.match(invalid[0].reason, /status must be one of/);
});

test("update rejects unknown statuses", async (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  await assert.rejects(update(root, record.id, { status: "unknown" as TaskStatus }, now + 1), /status/i);
  assert.deepEqual(read(root, record.id), record);
});

test("update atomically replaces the record and leaves no temporary files", async (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  const file = path.join(tasks(root), `${record.id}.json`);
  const previous = fs.openSync(file, "r");
  try {
    const changed = await change(root, record.id, { status: "running" }, now + 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(previous, "utf8")), record, "the old inode stays intact");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), changed);
    assert.deepEqual(fs.readdirSync(tasks(root)), [`${record.id}.json`]);
  } finally {
    fs.closeSync(previous);
  }
});

test("failed atomic writes preserve the record, clean up, and still release the lock", async (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  const failure = Object.assign(new Error("rename refused"), { code: "EACCES" });
  const mock = t.mock.method(fs, "renameSync", () => { throw failure; });
  await assert.rejects(update(root, record.id, { status: "running" }, now + 1), (error) => error === failure);
  assert.deepEqual(read(root, record.id), record);
  assert.deepEqual(fs.readdirSync(tasks(root)), [`${record.id}.json`]);
  mock.mock.restore();
  assert.equal((await change(root, record.id, { status: "running" }, now + 2)).status, "running");
});

test("read and update reject IDs that could escape the task directory", async (t) => {
  const root = project(t);
  for (const id of ["", ".", "..", "../outside", "/absolute", "nested/id", "nested\\id", "id.json", "bad id"]) {
    assert.throws(() => read(root, id), /id/i);
    await assert.rejects(update(root, id, { status: "running" }), /id/i);
  }
  assert.equal(fs.existsSync(path.join(root, ".cross-agent", "locks")), false, "no lock is named after an invalid id");
});

test("process identity rejects missing processes and reused PIDs", () => {
  assert.equal(isProcessAlive(), false);
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive({ pid: 2_147_483_647, startTime: "0", bootId: bootId() }), false);
  assert.equal(isProcessAlive(deadIdentity()), false);
  assert.equal(isProcessAlive(liveIdentity()), true);
});

test("an identity from another boot is dead however well its pid and start time match", () => {
  const live = liveIdentity();
  assert.equal(currentBootId, bootId());
  assert.equal(isProcessAlive({ ...live, bootId: "3a1e0e6c-0000-4000-8000-000000000000" }), false);
  assert.equal(isProcessAlive({ pid: live.pid, startTime: live.startTime } as EngineIdentity), false,
    "a record written before bootId existed is from another boot");
});

test("process stat reports the parent, process group and session of a live process", () => {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  assert.deepEqual(readProcessStat(process.pid), {
    startTime: fields[19], ppid: process.ppid, pgid: Number(fields[2]), sid: Number(fields[3]), state: fields[0],
  });
  assert.equal(readProcessStat(2_147_483_647), null);
});

test("process identity parses command names containing spaces and closing parentheses", (t) => {
  const startTime = "12345678901234567890";
  const fields = ["S", ...Array(18).fill("0"), startTime, "0"];
  t.mock.method(fs, "readFileSync", () => `123 (worker ) with (spaces)) ${fields.join(" ")}\n`);
  assert.equal(isProcessAlive({ pid: 123, startTime, bootId: currentBootId }), true);
  assert.equal(isProcessAlive({ pid: 123, startTime: "0", bootId: currentBootId }), false);
});

test("process identity propagates unexpected proc access errors", (t) => {
  const failure = Object.assign(new Error("proc read refused"), { code: "EACCES" });
  t.mock.method(fs, "readFileSync", () => { throw failure; });
  assert.throws(() => isProcessAlive({ pid: process.pid, startTime: "0", bootId: currentBootId }), (error) => error === failure);
});

test("read validates the shape every reader depends on and names the file and the fault", (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  const file = path.join(tasks(root), `${record.id}.json`);
  const complete = { ...record, runnerIdentity: liveIdentity(), engineIdentity: liveIdentity(), reason: "kept" };
  const put = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value));

  for (const valid of [
    record as object,
    complete,
    { ...complete, runnerIdentity: null, engineIdentity: null },
    // An identity written before bootId existed is dead, not malformed (design section 2).
    { ...complete, runnerIdentity: { pid: 7, startTime: "1" }, engineIdentity: { pid: 7, startTime: "1", pgid: 7 } },
    // A record a later build wrote carries fields this one does not know.
    { ...complete, depth: 2, truncated: true, parentTaskId: "abc" },
  ]) {
    put(valid);
    assert.deepEqual(read(root, record.id), valid);
  }

  const faults: [string, Record<string, unknown>][] = [
    ["id", { id: undefined }], ["id", { id: "" }], ["id", { id: "bad id" }], ["id", { id: "../escape" }], ["id", { id: 5 }],
    ["status", { status: "wandering" }], ["status", { status: undefined }], ["status", { status: 5 }],
    ["createdAt", { createdAt: "1000" }], ["createdAt", { createdAt: undefined }],
    ["updatedAt", { updatedAt: Number.NaN }], ["launchDeadline", { launchDeadline: Infinity }],
    ...["resultPath", "logPath", "role", "cwd", "engine", "briefHash"].flatMap((field): [string, Record<string, unknown>][] =>
      [[field, { [field]: undefined }], [field, { [field]: 5 }]]),
    ["runnerIdentity", { runnerIdentity: 5 }],
    ["runnerIdentity", { runnerIdentity: { pid: "7", startTime: "1", bootId: "b" } }],
    ["runnerIdentity", { runnerIdentity: { pid: 7, bootId: "b" } }],
    ["runnerIdentity", { runnerIdentity: { pid: 7, startTime: 1, bootId: "b" } }],
    ["runnerIdentity", { runnerIdentity: { pid: 7, startTime: "1", bootId: 5 } }],
    ["engineIdentity", { engineIdentity: { pid: 7, startTime: "1", bootId: "b" } }],
    ["engineIdentity", { engineIdentity: { ...liveIdentity(), pgid: "7" } }],
  ];
  for (const [field, fault] of faults) {
    put({ ...complete, ...fault });
    assert.throws(() => read(root, record.id), (error: unknown) => {
      assert.ok(error instanceof InvalidRecordError, `${JSON.stringify(fault)} was accepted`);
      assert.equal(error.file, file);
      assert.match(error.reason, new RegExp(field));
      assert.match(error.message, new RegExp(`${file}.*${field}`));
      return true;
    }, JSON.stringify(fault));
  }
  for (const contents of ['"a string"', "[]", "null", "5", "{", ""]) {
    fs.writeFileSync(file, contents);
    assert.throws(() => read(root, record.id), InvalidRecordError, contents);
  }
});

test("scan reports every unreadable file by name while list returns the valid records", async (t) => {
  const root = project(t);
  const oldest = create(root, input(root), now);
  const newest = create(root, input(root), now + 10);
  const running = await change(root, oldest.id, { status: "running" }, now + 20);
  const directory = tasks(root);
  const damaged = {
    "truncated.json": '{"id":"truncated","status":"runn',
    "unknown-status.json": JSON.stringify({ ...newest, id: "unknown-status", status: "wandering" }),
    "not-an-object.json": '"a string"',
  };
  for (const [name, contents] of Object.entries(damaged)) fs.writeFileSync(path.join(directory, name), contents);

  const scanned = scan(root);
  const byId = (records: TaskRecord[]) => [...records].sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(byId(scanned.records), byId([newest, running]));
  assert.deepEqual(scanned.invalid.map((entry) => entry.file).sort(),
    Object.keys(damaged).map((name) => path.join(directory, name)).sort());
  for (const entry of scanned.invalid) assert.ok(entry.reason.length > 0, `${entry.file} has no reason`);
  assert.match(scanned.invalid.find((entry) => entry.file.endsWith("unknown-status.json"))!.reason, /status/);
  assert.deepEqual(list(root), [newest, running]);
  assert.deepEqual(list(root, "running"), [running]);

  // A record removed between the listing and its read is gone, not malformed.
  const original = fs.readFileSync;
  const mock = t.mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (target === path.join(directory, `${newest.id}.json`)) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return (original as (target: fs.PathOrFileDescriptor, options?: unknown) => string | Buffer)(target, options);
  }) as typeof fs.readFileSync);
  const removed = scan(root);
  mock.mock.restore();
  assert.deepEqual(removed.records, [running]);
  assert.deepEqual(removed.invalid.map((entry) => entry.file).sort(), scanned.invalid.map((entry) => entry.file).sort());
});

test("a zombie is dead however well its pid and start time match", async (t) => {
  const root = project(t);
  const marker = path.join(root, "zombie.pid");
  // The shell starts a background child, records its pid, then execs: nothing is left
  // that will ever wait on it, so the kernel keeps the entry as a zombie.
  const parent = spawn("sh", ["-c", `sleep 0 & echo $! > ${marker}; exec sleep 60`], { stdio: "ignore" });
  t.after(async () => {
    parent.kill("SIGKILL");
    await once(parent, "close");
  });
  const pid = Number(await poll(() => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : ""), (text) => text.length > 0));
  const stat = await poll(() => readProcessStat(pid), (value) => value?.state === "Z");
  assert.equal(isProcessAlive({ pid, startTime: stat!.startTime, bootId: currentBootId }), false,
    "a process that has exited is dead even while its entry survives unreaped");
});

test("a record whose id does not name its own file is invalid", (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  const foreign = path.join(tasks(root), "elsewhere.json");
  fs.writeFileSync(foreign, JSON.stringify({ ...record, id: record.id }));
  // update(root, "elsewhere") would read this file and write the other one.
  assert.throws(() => read(root, "elsewhere"), (error: unknown) => {
    assert.ok(error instanceof InvalidRecordError);
    assert.match(error.reason, /id .*file/);
    return true;
  });
  assert.deepEqual(scan(root).invalid.map((entry) => entry.file), [foreign]);
  assert.deepEqual(list(root), [record]);
  fs.writeFileSync(foreign, JSON.stringify({ ...record, id: "elsewhere" }));
  assert.equal(read(root, "elsewhere").id, "elsewhere");
});

test("scan reports a record it may not read instead of throwing", (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  const other = create(root, input(root), now + 1);
  const file = path.join(tasks(root), `${record.id}.json`);
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const original = fs.readFileSync;
  const mock = t.mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (target === file) throw denied;
    return (original as (target: fs.PathOrFileDescriptor, options?: unknown) => string | Buffer)(target, options);
  }) as typeof fs.readFileSync);
  const scanned = scan(root);
  mock.mock.restore();
  assert.deepEqual(scanned.records, [other]);
  assert.deepEqual(scanned.invalid, [{ file, reason: "permission denied" }]);
});

test("truncated is a record field the runner may patch", async (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  const running = await change(root, record.id, { status: "running", truncated: true }, now + 1);
  assert.equal(running.truncated, true);
  assert.equal(read(root, record.id).truncated, true);
  assert.equal((await change(root, record.id, { status: "done", truncated: false }, now + 2)).truncated, false);
  const file = path.join(tasks(root), `${record.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...record, truncated: "partly" }));
  assert.throws(() => read(root, record.id), (error: unknown) => {
    assert.ok(error instanceof InvalidRecordError);
    assert.match(error.reason, /truncated/);
    return true;
  });
});

test("list filters statuses, sorts newest first, and ignores output and temporary files", async (t) => {
  const root = project(t);
  assert.deepEqual(list(root), []);
  const oldest = create(root, input(root), now);
  const newest = create(root, input(root), now + 20);
  const middle = create(root, input(root), now + 10);
  const running = await change(root, oldest.id, { status: "running" }, now + 30);
  fs.writeFileSync(oldest.resultPath, "final output");
  fs.writeFileSync(oldest.logPath, "{\"event\":\"started\"}\n");
  fs.writeFileSync(path.join(tasks(root), `.${oldest.id}.pending.tmp`), "partial JSON");
  fs.writeFileSync(path.join(tasks(root), `${oldest.id}.json.tmp`), "partial JSON");
  fs.mkdirSync(path.join(tasks(root), "directory.json"));
  assert.deepEqual(list(root), [newest, middle, running]);
  assert.deepEqual(list(root, "launching"), [newest, middle]);
  assert.deepEqual(list(root, "running"), [running]);
  assert.deepEqual(list(root, "done"), []);
});

test("first ledger use appends each missing exclusion once", async (t) => {
  for (const existing of [undefined, "", "# existing", "# existing\n", ".cross-agent/", ".worktrees/\n", ".cross-agent/\n.worktrees/\n", "# existing\r\n.cross-agent/\r\n"]) {
    const root = project(t);
    const exclude = path.join(root, ".git", "info", "exclude");
    fs.mkdirSync(path.join(root, ".git"));
    if (existing !== undefined) {
      fs.mkdirSync(path.dirname(exclude));
      fs.writeFileSync(exclude, existing);
    }
    assert.deepEqual(list(root), []);
    const first = fs.readFileSync(exclude, "utf8");
    assert.ok(first.startsWith(existing ?? ""), "preserves existing content");
    for (const line of [".cross-agent/", ".worktrees/"]) {
      assert.equal(first.split(/\r?\n/).filter((entry) => entry === line).length, 1);
    }
    const record = create(root, input(root), now);
    read(root, record.id);
    await change(root, record.id, { status: "running" }, now + 1);
    scan(root);
    assert.equal(fs.readFileSync(exclude, "utf8"), first);
  }
});

test("ledger initialization skips absent git directories and worktree pointer files", (t) => {
  const root = project(t);
  create(root, input(root), now);
  assert.equal(fs.existsSync(path.join(root, ".git")), false);

  const linked = project(t);
  const pointer = "gitdir: /nonexistent/common/.git/worktrees/ledger\n";
  fs.writeFileSync(path.join(linked, ".git"), pointer);
  const record = create(linked, input(linked), now);
  assert.deepEqual(read(linked, record.id), record);
  assert.equal(fs.readFileSync(path.join(linked, ".git"), "utf8"), pointer);
});

test("create writes the fields a cascade, a resume and a stall clock read", (t) => {
  const root = project(t);
  const child = create(root, {
    ...input(root), effort: "high", depth: 1, parentTaskId: "lead-task", resumedFrom: "earlier-task",
  }, now);
  assert.equal(child.depth, 1);
  assert.equal(child.parentTaskId, "lead-task");
  assert.equal(child.resumedFrom, "earlier-task");
  assert.equal(child.effort, "high");
  assert.equal(child.acknowledgedAt, undefined, "only the runner's acknowledgement writes it");
  assert.deepEqual(read(root, child.id), child);

  // A task nobody delegated is at depth 0, has no parent and continues nothing. A null
  // model or effort is what `delegate` writes when neither the request nor the role binds
  // one, and it is kept as the answer rather than dropped.
  const top = create(root, { ...input(root), model: null, effort: null }, now);
  assert.equal(top.depth, 0);
  assert.equal("parentTaskId" in top, false);
  assert.equal("resumedFrom" in top, false);
  assert.equal(top.model, null);
  assert.equal(top.effort, null);
  assert.deepEqual(read(root, top.id), top);
});

test("the delegation fields are patchable, and validated as what a reader dereferences", async (t) => {
  const root = project(t);
  const record = create(root, { ...input(root), depth: 1 }, now);
  const running = await change(root, record.id, { status: "running", acknowledgedAt: now + 5 }, now + 5);
  assert.equal(running.acknowledgedAt, now + 5);
  // The stall clock reads it, so an activity write that says nothing about it keeps it.
  assert.equal((await change(root, record.id, { lastEventAt: now + 9 }, now + 9)).acknowledgedAt, now + 5);
  assert.equal((await change(root, record.id, { status: "done", effort: "low", parentTaskId: "p", resumedFrom: "r", depth: 2 }, now + 10)).depth, 2);
  const settled = read(root, record.id);
  assert.deepEqual(
    [settled.effort, settled.parentTaskId, settled.resumedFrom, settled.acknowledgedAt],
    ["low", "p", "r", now + 5],
  );

  const file = path.join(tasks(root), `${record.id}.json`);
  const faults: [string, Record<string, unknown>][] = [
    ["depth", { depth: "1" }], ["depth", { depth: null }], ["depth", { depth: -1 }], ["depth", { depth: 1.5 }],
    ["parentTaskId", { parentTaskId: 5 }], ["resumedFrom", { resumedFrom: [] }],
    ["model", { model: 5 }], ["effort", { effort: true }],
    ["acknowledgedAt", { acknowledgedAt: "soon" }],
  ];
  for (const [field, fault] of faults) {
    fs.writeFileSync(file, JSON.stringify({ ...settled, ...fault }));
    assert.throws(() => read(root, record.id), (error: unknown) => {
      assert.ok(error instanceof InvalidRecordError, `${JSON.stringify(fault)} was accepted`);
      assert.match(error.reason, new RegExp(field));
      return true;
    }, JSON.stringify(fault));
  }
  // JSON has no infinity of its own, so the one spelling that reaches a reader is a
  // literal past the float range, and a clock or a depth that is not finite is a fault.
  for (const field of ["depth", "acknowledgedAt"]) {
    fs.writeFileSync(file, JSON.stringify(settled).replace(/}$/, `,"${field}":1e999}`));
    assert.throws(() => read(root, record.id), (error: unknown) => {
      assert.ok(error instanceof InvalidRecordError, field);
      assert.match(error.reason, new RegExp(field));
      return true;
    }, field);
  }

  // Null is an answer, not a fault: it is what a task with no parent, no resume and no
  // model or effort carries, and a record an earlier build wrote carries none of them.
  for (const value of [
    { ...settled, parentTaskId: null, resumedFrom: null, model: null, effort: null, acknowledgedAt: null },
    { ...settled, depth: undefined, parentTaskId: undefined, resumedFrom: undefined, acknowledgedAt: undefined },
  ]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.deepEqual(read(root, record.id), JSON.parse(JSON.stringify(value)));
  }
});
