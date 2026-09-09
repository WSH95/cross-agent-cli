import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { create, scan, update, writeSpec } from "../src/ledger.ts";
import type { LaunchSpec, TaskRecord, TaskStatus } from "../src/ledger.ts";
import { reservations, reservedBy } from "../src/reservation.ts";

const now = 1_000_000;

// One legal path from launching to each status, as tests/ledger.test.ts uses.
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
const unsettled: TaskStatus[] = ["launching", "running", "stalled", "orphaned", "cancelling"];
const settled: TaskStatus[] = ["done", "failed", "cancelled"];

function project(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cross-agent-reservation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function launchSpec(sandbox: string): LaunchSpec {
  return {
    role: "implementer", brief: "Implement the reservation.", rolePrompt: "prompt", cwd: "/unused",
    // Grok's `workspace` is not in SpawnRequest's three profiles yet; S5 replaces the
    // string with {mode, profile}, and the reservation reads the mode instead.
    sandbox: sandbox as LaunchSpec["sandbox"], sessionId: "session", denyTargets: [], env: {},
    engine: "codex", adapterModule: "/adapters/codex.ts",
  };
}

/** A task at `status` on `cwd`, with the launch spec that says whether it may write. */
async function task(root: string, cwd: string, status: TaskStatus, sandbox: string | null): Promise<TaskRecord> {
  const record = create(root, { role: "implementer", brief: `brief ${cwd} ${status}`, cwd, engine: "codex" }, now);
  if (sandbox !== null) writeSpec(root, record.id, launchSpec(sandbox));
  let current = record;
  for (const step of routes[status]) {
    const result = await update(root, record.id, { status: step }, now + 1);
    assert.equal(result.applied, true);
    current = result.record;
  }
  assert.equal(current.status, status);
  return current;
}

function workspace(root: string, name: string): string {
  const directory = path.join(root, ".worktrees", name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

test("a writable task reserves its cwd for as long as it is unsettled", async (t) => {
  const root = project(t);
  for (const status of unsettled) {
    const cwd = workspace(root, `unsettled-${status}`);
    const record = await task(root, cwd, status, "workspace-write");
    assert.deepEqual(reservedBy(root, cwd), record, `${status} reserves its workspace`);
    assert.deepEqual(reservations(root).reserved.get(cwd), record);
  }
  for (const status of settled) {
    const cwd = workspace(root, `settled-${status}`);
    await task(root, cwd, status, "workspace-write");
    assert.equal(reservedBy(root, cwd), null, `${status} has released its workspace`);
    assert.equal(reservations(root).reserved.has(cwd), false);
  }
  // Every unsettled workspace, and only those, and each answers for its own path.
  assert.deepEqual([...reservations(root).reserved.keys()].sort(), unsettled.map((status) => workspace(root, `unsettled-${status}`)).sort());
  assert.equal(reservedBy(root, path.join(root, ".worktrees", "never-used")), null);
});

test("every profile but the read-only ones reserves the workspace", async (t) => {
  const root = project(t);
  // `off` is the least constrained task there is — no sandbox at all, so it can write
  // anywhere — and it holds its workspace exactly as a workspace-write task does.
  for (const sandbox of ["workspace-write", "workspace", "off"]) {
    const cwd = workspace(root, `write-${sandbox}`);
    const record = await task(root, cwd, "running", sandbox);
    assert.deepEqual(reservedBy(root, cwd), record, `${sandbox} may write`);
  }
  for (const sandbox of ["read-only", "strict"]) {
    const cwd = workspace(root, `read-${sandbox}`);
    await task(root, cwd, "running", sandbox);
    assert.equal(reservedBy(root, cwd), null, `${sandbox} may not write`);
  }
});

test("a running task whose launch spec cannot be read keeps its workspace", async (t) => {
  const root = project(t);
  const missing = workspace(root, "no-spec");
  const record = await task(root, missing, "running", null);
  // Its mode is unknown, and an unknown mode can never be shown to have freed the path.
  assert.deepEqual(reservedBy(root, missing), record);

  const damaged = workspace(root, "damaged-spec");
  const other = await task(root, damaged, "running", "read-only");
  fs.writeFileSync(path.join(root, ".cross-agent", "tasks", `${other.id}.spec.json`), "{not json");
  assert.deepEqual(reservedBy(root, damaged), other);

  // A settled task is settled whatever its spec says: the status is read first.
  const done = workspace(root, "done-without-spec");
  await task(root, done, "done", null);
  assert.equal(reservedBy(root, done), null);
});

test("an unreadable record is reported as unknown, verbatim from the ledger scan", async (t) => {
  const root = project(t);
  const cwd = workspace(root, "valid");
  const record = await task(root, cwd, "running", "workspace-write");
  assert.deepEqual(reservations(root).unknown, []);

  const broken = path.join(root, ".cross-agent", "tasks", "broken.json");
  fs.writeFileSync(broken, "{not json");
  const misnamed = path.join(root, ".cross-agent", "tasks", "misnamed.json");
  fs.writeFileSync(misnamed, JSON.stringify({ ...record, id: "someone-else" }));

  const { reserved, unknown } = reservations(root);
  assert.deepEqual(unknown, scan(root).invalid);
  assert.deepEqual(unknown.map((entry) => entry.file).sort(), [broken, misnamed].sort());
  for (const entry of unknown) assert.equal(typeof entry.reason, "string");
  // The valid records are still read: one damaged file hides nothing.
  assert.deepEqual([...reserved.keys()], [cwd]);
});

test("reservations compare paths canonically", async (t) => {
  const root = project(t);
  const real = workspace(root, "canonical");
  const alias = path.join(root, "alias");
  fs.symlinkSync(path.join(root, ".worktrees"), alias, "dir");
  const record = await task(root, path.join(alias, "canonical"), "running", "workspace-write");

  assert.deepEqual([...reservations(root).reserved.keys()], [fs.realpathSync(real)]);
  assert.deepEqual(reservedBy(root, real), record, "the record's aliased cwd answers for the real path");
  assert.deepEqual(reservedBy(root, path.join(alias, "canonical")), record);
  assert.deepEqual(reservedBy(root, path.join(root, ".worktrees", ".", "canonical")), record);
  assert.deepEqual(reservedBy(root, path.join(real, "..", "canonical")), record);
  assert.equal(reservedBy(root, path.join(alias, "other")), null);
});

test("a removed workspace is still reserved by the task that has not settled", async (t) => {
  const root = project(t);
  const cwd = workspace(root, "removed");
  const record = await task(root, cwd, "running", "workspace-write");
  fs.rmSync(cwd, { recursive: true, force: true });
  assert.deepEqual(reservedBy(root, cwd), record);
});
