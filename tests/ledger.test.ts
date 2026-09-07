import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { create, read, update, list, reconcile, isProcessAlive } from "../src/ledger.ts";
import type { CreateTask, EngineIdentity, TaskPatch, TaskStatus } from "../src/ledger.ts";

const now = 1_000_000;
const statuses: TaskStatus[] = ["launching", "running", "stalled", "orphaned", "cancelling", "done", "failed", "cancelled"];

function project(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), "dev-team-ledger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function input(cwd: string): CreateTask {
  return { role: "implementer", brief: "Implement the ledger.\nKeep task state durable.", cwd, engine: "codex", model: "test-model" };
}

function tasks(root: string): string {
  return path.join(root, ".dev-team", "tasks");
}

function liveIdentity(): EngineIdentity {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return { pid: process.pid, startTime: fields[19], pgid: Number(fields[2]) };
}

function deadIdentity(): EngineIdentity {
  const live = liveIdentity();
  return { ...live, startTime: String(BigInt(live.startTime) + 1n) };
}

test("create persists a launching record that read returns", (t) => {
  const root = project(t);
  const data = input(root);
  const record = create(root, data, now);
  assert.match(record.id, /^[A-Za-z0-9_-]+$/);
  assert.match(record.launchToken, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(record.launchToken, record.id);
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
  assert.notEqual(second.launchToken, record.launchToken);
  assert.equal(path.isAbsolute(second.resultPath), true);
  assert.equal(path.isAbsolute(second.logPath), true);
  assert.deepEqual(read(root, second.id), second);
});

test("update merges fields and advances updatedAt", (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  const patch: TaskPatch = {
    status: "running", runnerIdentity: liveIdentity(), engineIdentity: liveIdentity(),
    lastEventAt: now + 10, exitCode: null, sessionId: "engine-session",
  };
  const changed = update(root, record.id, patch, now + 20);
  assert.deepEqual(changed, { ...record, ...patch, updatedAt: now + 20 });
  assert.deepEqual(read(root, record.id), changed);

  const protectedFields = { id: "replacement", createdAt: 0, updatedAt: 0, launchToken: "replacement", reason: "metadata" };
  const metadata = update(root, record.id, protectedFields, now + 30);
  assert.deepEqual(metadata, { ...changed, reason: "metadata", updatedAt: now + 30 });
  assert.equal(fs.existsSync(path.join(tasks(root), "replacement.json")), false);
});

test("update refuses status changes from terminal records", (t) => {
  const root = project(t);
  for (const terminal of ["done", "failed", "cancelled"] as const) {
    const record = create(root, input(root), now);
    const settled = update(root, record.id, { status: terminal }, now + 1);
    for (const status of statuses.filter((status) => status !== terminal)) {
      assert.throws(() => update(root, record.id, { status }, now + 2), /terminal/i);
      assert.deepEqual(read(root, record.id), settled);
    }
    const metadata = update(root, record.id, { status: terminal, exitCode: 0 }, now + 3);
    assert.equal(metadata.status, terminal);
    assert.equal(metadata.exitCode, 0);
    assert.equal(metadata.updatedAt, now + 3);
    assert.equal(update(root, record.id, { status: undefined, sessionId: "finished" }, now + 4).status, terminal);
  }
});

test("update rejects unknown statuses", (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  assert.throws(() => update(root, record.id, { status: "unknown" as TaskStatus }, now + 1), /status/i);
  assert.deepEqual(read(root, record.id), record);
});

test("update atomically replaces the record and leaves no temporary files", (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  const file = path.join(tasks(root), `${record.id}.json`);
  const previous = fs.openSync(file, "r");
  try {
    const changed = update(root, record.id, { status: "running" }, now + 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(previous, "utf8")), record, "the old inode stays intact");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), changed);
    assert.deepEqual(fs.readdirSync(tasks(root)), [`${record.id}.json`]);
  } finally {
    fs.closeSync(previous);
  }
});

test("failed atomic writes preserve the record and clean up temporary files", (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  const failure = Object.assign(new Error("rename refused"), { code: "EACCES" });
  t.mock.method(fs, "renameSync", () => { throw failure; });
  assert.throws(() => update(root, record.id, { status: "running" }, now + 1), (error) => error === failure);
  assert.deepEqual(read(root, record.id), record);
  assert.deepEqual(fs.readdirSync(tasks(root)), [`${record.id}.json`]);
});

test("read and update reject IDs that could escape the task directory", (t) => {
  const root = project(t);
  for (const id of ["", ".", "..", "../outside", "/absolute", "nested/id", "nested\\id", "id.json", "bad id"]) {
    assert.throws(() => read(root, id), /id/i);
    assert.throws(() => update(root, id, { status: "running" }), /id/i);
  }
});

test("reconcile fails unacknowledged launches only after their deadline", (t) => {
  const root = project(t);
  const record = create(root, input(root), now);
  assert.deepEqual(reconcile(root, record.launchDeadline - 1), []);
  assert.deepEqual(read(root, record.id), record);
  assert.deepEqual(reconcile(root, record.launchDeadline), []);
  assert.deepEqual(read(root, record.id), record);

  const after = record.launchDeadline + 1;
  const expected = { ...record, status: "failed", reason: "launch", updatedAt: after };
  assert.deepEqual(reconcile(root, after), [expected]);
  assert.deepEqual(read(root, record.id), expected);
  assert.deepEqual(reconcile(root, after + 1), []);
});

test("reconcile fails running and stalled tasks when both identities are dead", (t) => {
  const root = project(t);
  const dead = deadIdentity();
  for (const status of ["running", "stalled"] as const) {
    for (const identities of [{}, { runnerIdentity: dead, engineIdentity: dead }]) {
      const record = create(root, input(root), now);
      const active = update(root, record.id, { status, ...identities }, now + 1);
      const expected = { ...active, status: "failed", reason: "runner lost", updatedAt: now + 2 };
      assert.deepEqual(reconcile(root, now + 2), [expected]);
      assert.deepEqual(read(root, record.id), expected);
    }
  }
});

test("reconcile orphans running and stalled tasks with a dead runner and live engine", (t) => {
  const root = project(t);
  const engine = liveIdentity();
  for (const status of ["running", "stalled"] as const) {
    const record = create(root, input(root), now);
    const active = update(root, record.id, { status, runnerIdentity: deadIdentity(), engineIdentity: engine }, now + 1);
    const expected = { ...active, status: "orphaned", updatedAt: now + 2 };
    assert.deepEqual(reconcile(root, now + 2), [expected]);
    assert.deepEqual(read(root, record.id), expected);
    assert.equal(isProcessAlive(engine), true);
  }
});

test("process identity rejects missing processes and reused PIDs", () => {
  assert.equal(isProcessAlive(), false);
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive({ pid: 2_147_483_647, startTime: "0" }), false);
  assert.equal(isProcessAlive(deadIdentity()), false);
  assert.equal(isProcessAlive(liveIdentity()), true);
});

test("process identity parses command names containing spaces and closing parentheses", (t) => {
  const startTime = "12345678901234567890";
  const fields = ["S", ...Array(18).fill("0"), startTime, "0"];
  t.mock.method(fs, "readFileSync", () => `123 (worker ) with (spaces)) ${fields.join(" ")}\n`);
  assert.equal(isProcessAlive({ pid: 123, startTime }), true);
  assert.equal(isProcessAlive({ pid: 123, startTime: "0" }), false);
});

test("process identity propagates unexpected proc access errors", (t) => {
  const failure = Object.assign(new Error("proc read refused"), { code: "EACCES" });
  t.mock.method(fs, "readFileSync", () => { throw failure; });
  assert.throws(() => isProcessAlive({ pid: process.pid, startTime: "0" }), (error) => error === failure);
});

test("reconcile preserves live-runner tasks and all other states", (t) => {
  const root = project(t);
  const live = liveIdentity();
  const dead = deadIdentity();
  for (const status of statuses) {
    const record = create(root, input(root), now);
    const runnerIdentity = status === "running" || status === "stalled" ? live : dead;
    update(root, record.id, { status, runnerIdentity, engineIdentity: dead }, now + 1);
  }
  const before = list(root);
  assert.deepEqual(reconcile(root, now + 60_000), []);
  assert.deepEqual(list(root), before);
});

test("list filters statuses, sorts newest first, and ignores output and temporary files", (t) => {
  const root = project(t);
  assert.deepEqual(list(root), []);
  const oldest = create(root, input(root), now);
  const newest = create(root, input(root), now + 20);
  const middle = create(root, input(root), now + 10);
  const running = update(root, oldest.id, { status: "running" }, now + 30);
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

test("first ledger use appends each missing exclusion once", (t) => {
  for (const existing of [undefined, "", "# existing", "# existing\n", ".dev-team/", ".worktrees/\n", ".dev-team/\n.worktrees/\n", "# existing\r\n.dev-team/\r\n"]) {
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
    for (const line of [".dev-team/", ".worktrees/"]) {
      assert.equal(first.split(/\r?\n/).filter((entry) => entry === line).length, 1);
    }
    const record = create(root, input(root), now);
    read(root, record.id);
    update(root, record.id, { status: "running" }, now + 1);
    reconcile(root, now + 2);
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
