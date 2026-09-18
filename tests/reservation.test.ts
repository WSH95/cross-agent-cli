import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { create, scan, update, writeSpec } from "../src/ledger.ts";
import type { LaunchSpec, TaskRecord, TaskStatus } from "../src/ledger.ts";
import { reservations, reservedBy } from "../src/reservation.ts";
import { adapters, sandboxFor } from "../src/engines/registry.ts";
import type { EngineName } from "../src/engines/types.ts";

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
// Two of the {mode, profile} pairs design section 3 declares; the test below covers all of them.
const writable: LaunchSpec["sandbox"] = { mode: "write", profile: "workspace-write" };
const readOnly: LaunchSpec["sandbox"] = { mode: "read-only", profile: "read-only" };

function project(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cross-agent-reservation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function launchSpec(sandbox: LaunchSpec["sandbox"], engine: EngineName = "codex"): LaunchSpec {
  return {
    role: "implementer", brief: "Implement the reservation.", rolePrompt: "prompt", cwd: "/unused",
    sandbox, sessionId: "session", denyTargets: [], env: {}, scratchDir: "/unused",
    engine, adapterModule: `/adapters/${engine}.ts`,
  };
}

/** A task at `status` on `cwd`, with the launch spec that says whether it may write. */
async function task(
  root: string, cwd: string, status: TaskStatus, sandbox: LaunchSpec["sandbox"] | null, engine: EngineName = "codex",
  createdAt = now,
): Promise<TaskRecord> {
  const record = create(root, { role: "implementer", brief: `brief ${cwd} ${status}`, cwd, engine }, createdAt);
  if (sandbox !== null) writeSpec(root, record.id, launchSpec(sandbox, engine));
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
    const record = await task(root, cwd, status, writable);
    assert.deepEqual(reservedBy(root, cwd), record, `${status} reserves its workspace`);
    assert.deepEqual(reservations(root).reserved.get(cwd), record);
  }
  for (const status of settled) {
    const cwd = workspace(root, `settled-${status}`);
    await task(root, cwd, status, writable);
    assert.equal(reservedBy(root, cwd), null, `${status} has released its workspace`);
    assert.equal(reservations(root).reserved.has(cwd), false);
  }
  // Every unsettled workspace, and only those, and each answers for its own path.
  assert.deepEqual([...reservations(root).reserved.keys()].sort(), unsettled.map((status) => workspace(root, `unsettled-${status}`)).sort());
  assert.equal(reservedBy(root, path.join(root, ".worktrees", "never-used")), null);
});

test("every profile but the read-only ones reserves the workspace", async (t) => {
  const root = project(t);
  // Every profile every adapter declares, paired with its own engine. `off` is the least
  // constrained task there is — no sandbox at all, so it can write anywhere — and it
  // holds its workspace exactly as a workspace-write task does.
  for (const [engine, adapter] of Object.entries(adapters)) {
    for (const profile of Object.keys(adapter.sandboxProfiles)) {
      const sandbox = sandboxFor(engine as EngineName, profile);
      const cwd = workspace(root, `${engine}-${profile}`);
      const record = await task(root, cwd, "running", sandbox, engine as EngineName);
      if (sandbox.mode === "read-only") assert.equal(reservedBy(root, cwd), null, `${engine} ${profile} may not write`);
      else assert.deepEqual(reservedBy(root, cwd), record, `${engine} ${profile} may write`);
    }
  }
});

test("a mode the engine's own map contradicts holds the workspace", async (t) => {
  const root = project(t);
  // The spec is a claim, not a fact: what the engine does with the profile it names is
  // the engine's map's to say, and a task that may write cannot free a workspace by
  // labelling itself read-only.
  const contradicted = workspace(root, "contradicted");
  const record = await task(root, contradicted, "running", { mode: "read-only", profile: "workspace-write" });
  assert.deepEqual(reservedBy(root, contradicted), record);

  // A profile its engine does not declare leaves the mode underivable, and so does an
  // engine no adapter answers for.
  const foreign = workspace(root, "foreign-profile");
  const other = await task(root, foreign, "running", { mode: "read-only", profile: "strict" });
  assert.deepEqual(reservedBy(root, foreign), other, "codex declares no strict profile");

  const unknown = workspace(root, "unknown-engine");
  const third = create(root, { role: "implementer", brief: "brief unknown", cwd: unknown, engine: "nosuch" }, now);
  writeSpec(root, third.id, { ...launchSpec(readOnly), engine: "nosuch" as EngineName });
  assert.equal((await update(root, third.id, { status: "running" }, now + 1)).applied, true);
  assert.equal(reservedBy(root, unknown)?.id, third.id);
});

test("a launch spec whose sandbox this build cannot read keeps the workspace", async (t) => {
  const root = project(t);
  // An older spec's profile string, and a spec with no sandbox at all: neither has ever
  // been shown to be read-only, so both hold the path rather than let a writer in.
  for (const [name, sandbox] of [["string", "read-only"], ["absent", undefined], ["null", null]] as const) {
    const cwd = workspace(root, `unreadable-${name}`);
    const record = create(root, { role: "implementer", brief: `brief ${name}`, cwd, engine: "codex" }, now);
    writeSpec(root, record.id, { ...launchSpec(readOnly), sandbox: sandbox as LaunchSpec["sandbox"] });
    assert.equal((await update(root, record.id, { status: "running" }, now + 1)).applied, true);
    assert.equal(reservedBy(root, cwd)?.id, record.id, `a ${name} sandbox holds the workspace`);
  }
});

test("a running task whose launch spec cannot be read keeps its workspace", async (t) => {
  const root = project(t);
  const missing = workspace(root, "no-spec");
  const record = await task(root, missing, "running", null);
  // Its mode is unknown, and an unknown mode can never be shown to have freed the path.
  assert.deepEqual(reservedBy(root, missing), record);

  const damaged = workspace(root, "damaged-spec");
  const other = await task(root, damaged, "running", readOnly);
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
  const record = await task(root, cwd, "running", writable);
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
  const record = await task(root, path.join(alias, "canonical"), "running", writable);

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
  const record = await task(root, cwd, "running", writable);
  fs.rmSync(cwd, { recursive: true, force: true });
  assert.deepEqual(reservedBy(root, cwd), record);
});

test("a reservation covers its path, everything beneath it, and everything that contains it", async (t) => {
  const root = project(t);
  const held = workspace(root, "held");
  const record = await task(root, held, "running", writable);

  // Two tasks writing to `<w>` and `<w>/src` are writing to one tree.
  assert.deepEqual(reservedBy(root, path.join(held, "src")), record);
  assert.deepEqual(reservedBy(root, path.join(held, "src", "engines")), record);
  // And a task at a directory above it would contain the whole of it.
  assert.deepEqual(reservedBy(root, path.join(root, ".worktrees")), record);
  assert.deepEqual(reservedBy(root, root), record);
  // Segment by segment, never by string prefix: `/a/b` does not cover `/a/bc`.
  assert.equal(reservedBy(root, `${held}c`), null);
  assert.equal(reservedBy(root, path.join(root, ".worktrees", "heldc")), null);
  assert.equal(reservedBy(root, workspace(root, "other")), null);
  // Through a symlink and through a path that does not exist, the comparison is the same.
  const alias = path.join(root, "alias");
  fs.symlinkSync(path.join(root, ".worktrees"), alias, "dir");
  assert.deepEqual(reservedBy(root, path.join(alias, "held", "deep", "not-created")), record);
});

test("the covering reservation answered is the task that took its path first", async (t) => {
  const root = project(t);
  const parent = workspace(root, "parent");
  const child = path.join(parent, "nested");
  fs.mkdirSync(child, { recursive: true });
  // Two writable tasks on nested paths is what the check exists to prevent, but if one is
  // ever seen the answer must not depend on the order the directory happened to list.
  const first = await task(root, parent, "running", writable, "codex", now);
  await task(root, child, "running", writable, "codex", now + 1000);
  assert.deepEqual(reservedBy(root, path.join(child, "src")), first);
  assert.deepEqual(reservedBy(root, parent), first);
});
