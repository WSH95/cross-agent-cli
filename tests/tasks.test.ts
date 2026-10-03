import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Authority } from "../src/authority.ts";
import { delegate } from "../src/delegate.ts";
import { create, read, update, writeSpec } from "../src/ledger.ts";
import type { TaskRecord } from "../src/ledger.ts";
import { acquire, lockPath, recordLockName } from "../src/locks.ts";
import { answerAsk, createAsk, readAsk } from "../src/mailbox.ts";
import { cancel, check, lineageIds, listTasks, ownedBy, result } from "../src/tasks.ts";
import type { Outcome } from "../src/tasks.ts";
import { sandboxFor } from "../src/engines/registry.ts";
import { git } from "./helpers/git.ts";
import type { RoleSpec } from "./helpers/mode.ts";
import { alive, engineEnv, poll, waitForRecord, project, proc, strandedEngine } from "./helpers/project.ts";
import { deadIdentity, snapshot } from "./helpers/seed.ts";
import type { TestProject } from "./helpers/project.ts";

const operator: Authority = { row: "operator", reason: "operator: no CROSS_AGENT_* variable and no engine ancestor", depth: 0 };

function leadRow(taskId: string, depth = 1): Authority {
  return { row: "lead", reason: `lead by ancestry: task ${taskId} (lead, running)`, taskId, depth };
}

// Grok's own write profile is `workspace`; the lead is engine-placed, as a cascade needs.
const modeRoles: RoleSpec[] = [
  { key: "lead" },
  { key: "planner" },
  { key: "implementer", workspace: "worktree", sandboxDefault: "workspace" },
];
const modePatch = { lead: { placement: "engine", role: "lead" } };

function configFor(bin: string, limits: Record<string, number> = {}): Record<string, unknown> {
  return {
    roles: {
      // The mode places its lead in an engine, and grok cannot carry one (P9), so the
      // fixture binds it to codex, whose sandbox check is its binary resolving.
      lead: { engine: "codex" },
      planner: { engine: "grok" },
      implementer: { engine: "grok" },
    },
    engines: { grok: { bin }, codex: { bin } },
    // The two wall-clock budgets these tools ride on, set far past anything the tests
    // below need: how long a write waits for a record another writer holds, and how long
    // a cancel gives a runner to settle. Left small they are margins a loaded machine can
    // miss, and the test then fails for the load rather than for the behaviour. Each test
    // that is about one of the budgets sets its own.
    limits: { maxDepth: 3, lockWaitSeconds: 30, duplicateWindowMinutes: 10, cancelGraceSeconds: 30, ...limits },
    billing: "subscription",
  };
}

async function projectWithRoles(t: TestContext, limits: Record<string, number> = {}): Promise<TestProject> {
  const created = await project(t, configFor("placeholder", limits), modeRoles, modePatch);
  fs.writeFileSync(path.join(created.root, ".cross-agent", "config.json"), JSON.stringify(configFor(created.bin, limits)));
  return created;
}

/** A launched task of this project, stalling until it is cancelled. */
async function launch(
  p: TestProject,
  values: { role: string; cwd: string; branch?: string; authority?: Authority; script?: string; brief?: string },
): Promise<TaskRecord> {
  const result = await delegate(p.root, {
    role: values.role, brief: values.brief ?? `work for ${values.role} in ${values.cwd}`, cwd: values.cwd, branch: values.branch,
  }, {
    authority: values.authority ?? operator, mode: p.mode,
    env: engineEnv(p, { FAKE_ENGINE_SCRIPT: values.script ?? "stall" }),
  });
  assert.equal(result.ok, true, `delegate refused: ${JSON.stringify(result)}`);
  return waitForRecord(p, result.taskId, (record) => record.status === "running");
}

/** A record written straight to the ledger, with the launch spec a real one would carry. */
async function seed(
  root: string,
  values: { role: string; cwd: string; status?: TaskRecord["status"]; parentTaskId?: string; resumedFrom?: string; identity?: boolean },
): Promise<TaskRecord> {
  const record = create(root, {
    role: values.role, brief: `seeded ${values.role} ${values.cwd}`, cwd: values.cwd, engine: "grok",
    depth: 1, parentTaskId: values.parentTaskId, resumedFrom: values.resumedFrom,
  });
  writeSpec(root, record.id, {
    role: values.role, brief: "seeded", rolePrompt: "seeded", cwd: values.cwd, engine: "grok",
    sandbox: sandboxFor("grok", "read-only"), sessionId: "seeded-session", denyTargets: [], env: {},
    scratchDir: path.dirname(record.logPath),
    adapterModule: path.join(fs.realpathSync(path.join(import.meta.dirname, "..")), "src", "engines", "grok.ts"),
  });
  const patch = values.identity ? { engineIdentity: await deadIdentity() } : {};
  if (!values.status || values.status === "launching") {
    if (values.identity) assert.equal((await update(root, record.id, patch)).applied, true);
    return read(root, record.id);
  }
  const moved = await update(root, record.id, { status: values.status, ...patch });
  assert.equal(moved.applied, true, `seed could not reach ${values.status}`);
  return moved.record;
}

function outcomeOf(outcomes: Outcome[], id: string): Outcome {
  const found = outcomes.find((entry) => entry.id === id);
  assert.ok(found, `no outcome for ${id} in ${JSON.stringify(outcomes)}`);
  return found;
}

function cancelled(result: Awaited<ReturnType<typeof cancel>>): Outcome[] {
  assert.equal(result.ok, true, `cancel refused: ${JSON.stringify(result)}`);
  return result.outcomes;
}

function record(id: string, values: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id, role: "implementer", briefHash: "hash", cwd: "/w", engine: "grok", status: "running",
    createdAt: 0, updatedAt: 0, launchDeadline: 0, resultPath: `/t/${id}.out`, logPath: `/t/${id}.ndjson`,
    depth: 1, ...values,
  };
}

test("lineage ids are a resume chain, and ownership is the parent chain that reaches one", () => {
  // A lead resumed twice, a child delegated under the first record, and a grandchild.
  const records = [
    record("L1", { role: "lead" }), record("L2", { role: "lead", resumedFrom: "L1" }),
    record("L3", { role: "lead", resumedFrom: "L2" }),
    record("C", { parentTaskId: "L1" }), record("C2", { parentTaskId: "L1", resumedFrom: "C" }),
    record("G", { parentTaskId: "C2" }), record("stranger", {}), record("other", { parentTaskId: "stranger" }),
  ];
  assert.deepEqual(lineageIds(records, "L3"), ["L3", "L2", "L1"]);
  assert.deepEqual(lineageIds(records, "L1"), ["L1"]);
  assert.deepEqual(lineageIds(records, "unknown"), ["unknown"]);

  // The last record of the chain owns what the earlier ones were delegated, which is what
  // keeps a cascade complete across a resume (the lead model, item 2).
  for (const id of ["C", "C2", "G"]) assert.equal(ownedBy(records, "L3", id), true, id);
  assert.equal(ownedBy(records, "L1", "G"), true, "ownership is transitive through the parent chain");
  // An earlier record of the chain does not own what a later one was delegated.
  assert.equal(ownedBy(records, "L2", "L3"), false);
  assert.equal(ownedBy(records, "L3", "other"), false);
  assert.equal(ownedBy(records, "L3", "L3"), false, "a task is not its own descendant");

  // A damaged ledger is answered, not hung on.
  const cycle = [record("A", { resumedFrom: "B", parentTaskId: "B" }), record("B", { resumedFrom: "A", parentTaskId: "A" })];
  assert.deepEqual(lineageIds(cycle, "A").sort(), ["A", "B"]);
  assert.equal(ownedBy(cycle, "A", "B"), true);
});

// @anchor checkReportsTask
test("check reports the task, what is running it, and the tail of its own event stream", async (t) => {
  const p = await projectWithRoles(t);
  const running = await launch(p, { role: "planner", cwd: p.root });
  await poll(() => fs.readFileSync(running.logPath, "utf8"), (log) => log.includes("working"));
  // The runner persists the engine's activity on its own 2-second interval.
  await poll(() => p.record(running.id).lastEventAt, (value) => Boolean(value));

  const answer = await check(p.root, running.id, { now: running.createdAt + 90_000 });
  assert.equal(answer.ok, true);
  assert.equal(answer.ok && answer.status, "running");
  assert.equal(answer.ok && answer.role, "planner");
  assert.equal(answer.ok && answer.engine, "grok");
  assert.equal(answer.ok && answer.model, null);
  assert.equal(answer.ok && answer.effort, null);
  assert.equal(answer.ok && answer.elapsedSeconds, 90);
  assert.equal(answer.ok && answer.depth, 1);
  assert.ok(answer.ok && answer.lastEventAt, "the runner persists the engine's last event on the record");
  // The activity is the engine's own lines, as the runner tees them.
  const activity = answer.ok ? answer.lastActivity : [];
  assert.ok(activity.length > 0);
  assert.ok(activity.some((line) => line.includes("working")), JSON.stringify(activity));
  assert.equal(activity.at(-1), fs.readFileSync(running.logPath, "utf8").trim().split("\n").at(-1));
  const one = await check(p.root, running.id, { lines: 1 });
  assert.equal(one.ok && one.lastActivity.length, 1);
  // A count that is not a whole number of lines is refused rather than read as "all of
  // them": 0, a fraction and an infinity would each hand back the whole window.
  for (const lines of [0, -1, 2.5, Number.NaN, Infinity]) {
    const refused = await check(p.root, running.id, { lines });
    assert.equal(refused.ok, false, String(lines));
    assert.match(refused.ok === false ? refused.reason : "", /lines/, String(lines));
  }

  // A settled task's elapsed time stops at its settlement, and a task nobody has is named.
  assert.equal((await update(p.root, running.id, { status: "cancelling" })).applied, true);
  const done = (await update(p.root, running.id, { status: "cancelled" }, running.createdAt + 5_000)).record;
  const after = await check(p.root, running.id, { now: done.updatedAt + 600_000 });
  assert.equal(after.ok && after.elapsedSeconds, 5);
  const missing = await check(p.root, "no-such-task");
  assert.deepEqual(missing, { ok: false, reason: "no task no-such-task" });
});

// @anchor viewCarriesSeat
test("list_tasks and check carry seat and underReview, and only when a record has them", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "cross-agent-view-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const head = "0123456789abcdef0123456789abcdef01234567";
  const seated = create(root, { role: "code-reviewer", brief: "review seat two", cwd: root, engine: "codex", seat: 2, underReview: head });
  const plain = create(root, { role: "planner", brief: "plan", cwd: root, engine: "codex" });

  const listed = await listTasks(root, undefined, { reconcile: false });
  const byId = new Map(listed.tasks.map((task) => [task.id, task]));
  assert.equal(byId.get(seated.id)?.seat, 2);
  assert.equal(byId.get(seated.id)?.underReview, head);
  for (const key of ["seat", "underReview"]) assert.equal(Object.hasOwn(byId.get(plain.id)!, key), false, key);

  const checked = await check(root, seated.id);
  assert.equal(checked.ok && checked.seat, 2);
  assert.equal(checked.ok && checked.underReview, head);
  const unseated = await check(root, plain.id);
  assert.ok(unseated.ok);
  for (const key of ["seat", "underReview"]) assert.equal(Object.hasOwn(unseated, key), false, key);
});

// @anchor checkWritesStall
test("check writes the stall its clock reads, and writes the task back when events resume", async (t) => {
  // 0.02 of a minute is 1.2 seconds: a fraction is a valid `stallMinutes` and the reading
  // is the same one a quarter of an hour would give.
  const p = await projectWithRoles(t, { stallMinutes: 0.02 });
  const running = await launch(p, { role: "planner", cwd: p.root });
  const eventAt = await poll(() => p.record(running.id).lastEventAt, (value) => Boolean(value)) as number;

  // Past the threshold the engine has gone quiet, and a stall a reader finds is a stall it
  // writes: the next reader of this record inherits the reading instead of taking it again.
  const stalled = await check(p.root, running.id, { now: eventAt + 1_300 });
  assert.equal(stalled.ok && stalled.status, "stalled");
  assert.equal(p.record(running.id).status, "stalled");

  // The runner persists a fresh event, and the reader writes the task back to running:
  // reviving a task is `wait`'s and `check`'s, never the reconciler's (design section 2).
  assert.equal((await update(p.root, running.id, { lastEventAt: Date.now() })).applied, true);
  const revived = await check(p.root, running.id);
  assert.equal(revived.ok && revived.status, "running");
  assert.equal(p.record(running.id).status, "running");
});

// @anchor resultFinalMessage
test("result is the final message in full, and a task still running has only its status", async (t) => {
  const p = await projectWithRoles(t);
  const started = await delegate(p.root, { role: "planner", brief: "Say something.", cwd: p.root }, {
    authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }),
  });
  assert.equal(started.ok, true);
  const id = started.ok ? started.taskId : "";
  const running = await waitForRecord(p, id, (value) => value.status === "running");
  assert.deepEqual(result(p.root, id), { ok: true, id, status: "running", settled: false });

  // The runner writes the final message itself, which is what `result` reads back.
  fs.writeFileSync(running.resultPath, "the final message, in full\nwith a second line\n");
  assert.equal((await update(p.root, id, { status: "done", sessionId: "fake-7" })).applied, true);
  assert.deepEqual(result(p.root, id), {
    ok: true, id, status: "done", sessionId: "fake-7", result: "the final message, in full\nwith a second line\n",
  });
  // A settled task whose result file never arrived says so rather than inventing one.
  fs.rmSync(running.resultPath);
  assert.equal(result(p.root, id).ok && (result(p.root, id) as { result: string | null }).result, null);
  assert.deepEqual(result(p.root, "no-such-task"), { ok: false, reason: "no task no-such-task" });
});

// @anchor listTasksReconciles
test("list_tasks reconciles first: an orphan is settled, an unreadable record is named", async (t) => {
  const p = await projectWithRoles(t);
  const orphan = await seed(p.root, { role: "planner", cwd: p.root, status: "orphaned", identity: true });
  // A real task, because a `running` record whose runner is gone is exactly what this pass
  // settles: the live one has to have a runner for the pass to leave it alone.
  const live = await launch(p, { role: "planner", cwd: p.root });
  const broken = path.join(p.root, ".cross-agent", "tasks", "broken.json");
  fs.writeFileSync(broken, "{not a record");

  const listed = await listTasks(p.root);
  assert.equal(listed.ok, true);
  // Cleanup settled the orphan whose group is gone, and the listing shows what it wrote.
  assert.equal(listed.tasks.find((task) => task.id === orphan.id)?.status, "failed");
  assert.equal(p.record(orphan.id).reason, "runner lost");
  assert.equal(listed.tasks.find((task) => task.id === live.id)?.status, "running");
  assert.deepEqual(listed.invalid.map((entry) => entry.file), [broken]);
  assert.ok(listed.invalid[0].reason.length > 0);
  assert.deepEqual(listed.errors, []);
  assert.deepEqual(listed.skipped, []);

  // Newest first, every task with the engine, model and effort running it, filtered on ask.
  assert.deepEqual(listed.tasks.map((task) => task.id), [live.id, orphan.id]);
  for (const task of listed.tasks) {
    assert.equal(task.engine, "grok");
    assert.equal(task.model, null);
    assert.equal(task.effort, null);
  }
  assert.deepEqual((await listTasks(p.root, "running")).tasks.map((task) => task.id), [live.id]);
  assert.deepEqual((await listTasks(p.root, "done")).tasks, []);
});

// @anchor listTasksWithoutPass
test("listTasks without a pass reads the ledger as it is: nothing is settled, and nothing is written", async (t) => {
  const p = await projectWithRoles(t);
  // A record a pass would settle at once: `running`, and the runner it names is gone.
  const quiet = await seed(p.root, { role: "planner", cwd: p.root, status: "running" });
  assert.equal((await update(p.root, quiet.id, { runnerIdentity: await deadIdentity() })).applied, true);
  const broken = path.join(p.root, ".cross-agent", "tasks", "broken.json");
  fs.writeFileSync(broken, "{not a record");
  const state = path.join(p.root, ".cross-agent");
  const before = snapshot(state);
  assert.ok(Object.hasOwn(before, path.join("tasks", "broken.json")));

  // The operator's read: the record as the ledger holds it, and the damaged file named.
  const read = await listTasks(p.root, undefined, { reconcile: false });
  assert.equal(read.ok, true);
  assert.deepEqual(read.tasks.map((task) => [task.id, task.status]), [[quiet.id, "running"]]);
  assert.deepEqual(read.invalid.map((entry) => entry.file), [broken]);
  assert.ok(read.invalid[0].reason.length > 0, "the damaged file is named with its reason");
  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.skipped, []);
  assert.deepEqual(snapshot(state), before, "a listing without a pass writes nothing under .cross-agent/");
  assert.deepEqual((await listTasks(p.root, "done", { reconcile: false })).tasks, []);

  // The same call without the option is the tool's, and the pass settles what it finds.
  const reconciled = await listTasks(p.root);
  assert.equal(reconciled.tasks.find((task) => task.id === quiet.id)?.status, "failed");
  assert.equal(p.record(quiet.id).reason, "runner lost");
  assert.deepEqual(reconciled.invalid.map((entry) => entry.file), [broken]);
  assert.equal(fs.readFileSync(broken, "utf8"), "{not a record", "a pass names a damaged file and leaves it alone");
});

test("a cancel of a running task is settled by its own runner, with both identities and no live group", async (t) => {
  const p = await projectWithRoles(t);
  const running = await launch(p, { role: "planner", cwd: p.root });
  const outcomes = cancelled(await cancel(p.root, running.id));

  assert.deepEqual(outcomes, [{ id: running.id, outcome: "cancelled" }]);
  const settled = p.record(running.id);
  assert.equal(settled.status, "cancelled");
  assert.deepEqual(settled.engineIdentity, running.engineIdentity);
  assert.deepEqual(settled.runnerIdentity, running.runnerIdentity);
  // The engine group is dead before the record is written — the runner terminates it
  // first — so that one is read on the instant. The runner's own exit is not ordered
  // that way: it writes the record and exits a moment later, and `cancel` returns on
  // the record it has just seen, so the exit is waited for rather than assumed.
  assert.equal(alive(settled.engineIdentity), false);
  await poll(() => alive(settled.runnerIdentity), (value) => value === false);
  // A second cancel of a settled task says so and changes nothing.
  const again = cancelled(await cancel(p.root, running.id));
  assert.deepEqual(again, [{ id: running.id, outcome: "already cancelled" }]);
  assert.equal(p.record(running.id).updatedAt, settled.updatedAt);
});

test("a cancel whose runner is already dead ends the engine group by the identity the record carries", async (t) => {
  const p = await projectWithRoles(t);
  const running = await launch(p, { role: "planner", cwd: p.root });
  // The runner is gone before the cancel arrives, so nothing will settle the record for it.
  process.kill(running.runnerIdentity!.pid, "SIGKILL");
  await poll(() => alive(running.runnerIdentity), (value) => value === false);
  assert.equal(alive(running.engineIdentity), true, "the engine outlives its runner");

  const outcomes = cancelled(await cancel(p.root, running.id));
  assert.deepEqual(outcomes, [{ id: running.id, outcome: "cancelled" }]);
  const settled = p.record(running.id);
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.reason, "cancelled; the runner did not settle it");
  assert.deepEqual(settled.engineIdentity, running.engineIdentity);
  assert.equal(alive(running.engineIdentity), false);
});

test("a cancel of an orphaned record terminates its group and settles it from where it is", async (t) => {
  const p = await projectWithRoles(t);
  const running = await launch(p, { role: "planner", cwd: p.root });
  process.kill(running.runnerIdentity!.pid, "SIGKILL");
  await poll(() => alive(running.runnerIdentity), (value) => value === false);
  // Reconciliation adopts an engine whose runner is gone; the ledger then allows
  // `orphaned -> failed | cancelled | done` and nothing else.
  assert.equal((await update(p.root, running.id, { status: "orphaned" })).applied, true);

  assert.deepEqual(cancelled(await cancel(p.root, running.id)), [{ id: running.id, outcome: "cancelled" }]);
  const settled = p.record(running.id);
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.reason, "cancelled while orphaned");
  assert.equal(alive(running.engineIdentity), false);
});

test("a cancel inside the launch window ends the engine its environment names before it settles", async (t) => {
  const p = await projectWithRoles(t, { cancelGraceSeconds: 1 });
  // The runner died between its spawn and its acknowledgement: the record is `launching`
  // with no identities, and the engine it left is found only by the assignment it carries.
  const record = await seed(p.root, { role: "planner", cwd: p.root });
  assert.equal(record.status, "launching");
  const engine = strandedEngine(t, p, record.id);
  await poll(() => proc(engine.pid), (value) => value !== null);

  const outcomes = cancelled(await cancel(p.root, record.id));
  assert.deepEqual(outcomes, [{ id: record.id, outcome: "cancelled" }]);
  const settled = p.record(record.id);
  assert.equal(settled.status, "cancelled");
  assert.deepEqual(settled.engineIdentity, engine.identity, "the record names the group this cancel ended");
  assert.equal(alive(engine.identity), false, "the engine is dead before the record is terminal");

  // Nothing is left for reconciliation to find, and it changes nothing.
  const { reconcileAndCleanup } = await import("../src/reconcile.ts");
  const pass = await reconcileAndCleanup(p.root);
  assert.deepEqual(pass.changed, []);
  assert.deepEqual(pass.errors, []);
});

test("a runner that will not settle in time is SIGKILLed and its engine group ended by identity", async (t) => {
  const p = await projectWithRoles(t, { cancelGraceSeconds: 1 });
  // The engine ignores SIGTERM, so the runner is still escalating when the grace expires.
  const running = await launch(p, { role: "planner", cwd: p.root, script: "stall-ignore-term" });
  // Its first output is what says the handler is registered: a SIGTERM before that would
  // be the kernel's default and the engine would die at once (tests/fixtures/fake-engine.mjs).
  await poll(() => fs.readFileSync(running.logPath, "utf8"), (log) => log.includes("working"));
  const outcomes = cancelled(await cancel(p.root, running.id));

  assert.deepEqual(outcomeOf(outcomes, running.id), { id: running.id, outcome: "cancelled" });
  const settled = p.record(running.id);
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.reason, "cancelled; the runner did not settle it");
  assert.deepEqual(settled.engineIdentity, running.engineIdentity, "both identities are on the record");
  assert.deepEqual(settled.runnerIdentity, running.runnerIdentity);
  assert.equal(alive(settled.engineIdentity), false);
  assert.equal(alive(settled.runnerIdentity), false);
});

test("a cascade cancels the leaves first, then the lead, and reports one outcome per task", async (t) => {
  const p = await projectWithRoles(t, { cancelGraceSeconds: 1 });
  const first = await p.worktree("task/one");
  const second = await p.worktree("task/two");
  const lead = await launch(p, { role: "lead", cwd: p.root });
  const childA = await launch(p, { role: "implementer", cwd: first, branch: "task/one", authority: leadRow(lead.id) });
  const childB = await launch(p, { role: "implementer", cwd: second, branch: "task/two", authority: leadRow(lead.id) });
  // A task of a task: ownership is the whole parent chain, not one generation of it.
  const grandchild = await seed(p.root, { role: "planner", cwd: p.root, status: "running", parentTaskId: childA.id, identity: true });

  const outcomes = cancelled(await cancel(p.root, lead.id));
  assert.equal(outcomes.length, 4);
  assert.equal(outcomes[0].id, grandchild.id, "the deepest task is cancelled first");
  assert.equal(outcomes.at(-1)!.id, lead.id, "and the lead itself last");
  for (const id of [grandchild.id, childA.id, childB.id, lead.id]) {
    assert.equal(outcomeOf(outcomes, id).outcome, "cancelled", id);
    assert.equal(p.record(id).status, "cancelled", id);
  }
  for (const identity of [lead, childA, childB].map((value) => value.engineIdentity)) {
    assert.equal(alive(identity), false);
  }
  // The lead was claimed before the descendants were cancelled, so its own settlement is
  // the last write of the cascade.
  for (const id of [childA.id, childB.id, grandchild.id]) {
    assert.ok(p.record(lead.id).updatedAt >= p.record(id).updatedAt, id);
  }
});

// @anchor cancelledLeadAsks
test("a cancelled lead cancels its open asks, leaves an answered one alone, and names what it cancelled", async (t) => {
  const p = await projectWithRoles(t, { cancelGraceSeconds: 1 });
  const worktree = await p.worktree("task/asking");
  const first = await seed(p.root, { role: "lead", cwd: p.root, status: "failed" });
  const lead = await launch(p, { role: "lead", cwd: p.root, brief: "the lead that asks" });
  // The chain a resume makes: the record this lead continues asked before it died.
  assert.equal((await update(p.root, lead.id, { resumedFrom: first.id })).applied, true);
  await launch(p, { role: "implementer", cwd: worktree, branch: "task/asking", authority: leadRow(lead.id) });
  const open = createAsk(p.root, { taskId: lead.id, question: "Which slug?" });
  const earlier = createAsk(p.root, { taskId: first.id, question: "Before the resume?" });
  const answered = createAsk(p.root, { taskId: lead.id, question: "Merge?" });
  const stranger = createAsk(p.root, { taskId: "another-lead", question: "Not this lead's?" });
  assert.equal((await answerAsk(p.root, answered.id, "yes")).applied, true);

  const result = await cancel(p.root, lead.id);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.asksCancelled.sort(), [open.id, earlier.id].sort());
  assert.equal(result.asksNotCancelled, undefined, "every open ask was written");
  for (const id of [open.id, earlier.id]) {
    const ask = readAsk(p.root, id).ask!;
    assert.equal(ask.status, "cancelled", id);
    assert.equal(typeof ask.cancelledAt, "number", id);
  }
  assert.deepEqual(readAsk(p.root, answered.id).ask, { ...answered, status: "answered", answer: "yes", answeredAt: readAsk(p.root, answered.id).ask!.answeredAt });
  assert.equal(readAsk(p.root, stranger.id).ask!.status, "open", "another lead's question is not this cancel's");

  // A task that never asked anything reports that it cancelled none.
  const planner = await launch(p, { role: "planner", cwd: p.root });
  const quiet = await cancel(p.root, planner.id);
  assert.equal(quiet.ok, true);
  if (quiet.ok) assert.deepEqual(quiet.asksCancelled, []);
});

// @anchor cancelSurvivesMailbox
test("a cancel keeps every outcome over a damaged mailbox, and names what it could not cancel", async (t) => {
  const p = await projectWithRoles(t, { cancelGraceSeconds: 1 });
  const worktree = await p.worktree("task/damaged");
  const lead = await launch(p, { role: "lead", cwd: p.root, brief: "the lead with a damaged mailbox" });
  const child = await launch(p, { role: "implementer", cwd: worktree, branch: "task/damaged", authority: leadRow(lead.id) });
  const open = createAsk(p.root, { taskId: lead.id, question: "Which slug?" });
  const torn = path.join(p.root, ".cross-agent", "asks", "torn.json");
  fs.writeFileSync(torn, "{");

  const result = await cancel(p.root, lead.id);
  assert.deepEqual(cancelled(result).map((outcome) => outcome.id).sort(), [lead.id, child.id].sort());
  assert.equal(outcomeOf(cancelled(result), lead.id).outcome, "cancelled");
  if (!result.ok) return;
  assert.deepEqual(result.asksCancelled, [open.id]);
  assert.deepEqual(result.asksNotCancelled?.map((failure) => ("file" in failure ? failure.file : failure.id)), [torn]);
  assert.match(result.asksNotCancelled![0].reason, /invalid ask/);

  // A mailbox the cancel cannot list loses it no outcome either: the cascade is done by
  // then, and what it could not read is named beside it.
  const second = await launch(p, { role: "lead", cwd: p.root, brief: "the lead whose mailbox is not a directory" });
  const asks = path.join(p.root, ".cross-agent", "asks");
  fs.rmSync(asks, { recursive: true, force: true });
  fs.writeFileSync(asks, "not a directory");
  const blind = await cancel(p.root, second.id);
  assert.equal(outcomeOf(cancelled(blind), second.id).outcome, "cancelled");
  if (!blind.ok) return;
  assert.deepEqual(blind.asksCancelled, []);
  assert.deepEqual(blind.asksNotCancelled?.map((failure) => ("file" in failure ? failure.file : failure.id)), [asks]);
});

test("an orphaned lead settles its children first, then its own group, from where it is", async (t) => {
  const p = await projectWithRoles(t, { cancelGraceSeconds: 1 });
  const worktree = await p.worktree("task/orphaned-lead");
  const lead = await launch(p, { role: "lead", cwd: p.root });
  const child = await launch(p, { role: "implementer", cwd: worktree, branch: "task/orphaned-lead", authority: leadRow(lead.id) });
  // The lead's runner is gone and reconciliation has adopted its engine; from `orphaned`
  // the ledger allows `failed | cancelled`, so the cascade may not claim it `cancelling`.
  process.kill(lead.runnerIdentity!.pid, "SIGKILL");
  await poll(() => alive(lead.runnerIdentity), (value) => value === false);
  assert.equal((await update(p.root, lead.id, { status: "orphaned" })).applied, true);

  const outcomes = cancelled(await cancel(p.root, lead.id));
  assert.deepEqual(outcomes.map((outcome) => outcome.id), [child.id, lead.id]);
  assert.equal(outcomeOf(outcomes, child.id).outcome, "cancelled");
  assert.equal(outcomeOf(outcomes, lead.id).outcome, "cancelled");
  assert.equal(p.record(lead.id).reason, "cancelled while orphaned");
  assert.equal(alive(lead.engineIdentity), false);
  assert.equal(alive(child.engineIdentity), false);
  // The child was settled before the lead's own group was ended.
  assert.ok(p.record(lead.id).updatedAt >= p.record(child.id).updatedAt);
});

test("a cascade reaches the children of the records a resumed lead continues", async (t) => {
  const p = await projectWithRoles(t, { cancelGraceSeconds: 1 });
  const worktree = await p.worktree("task/resumed-lead");
  const first = await seed(p.root, { role: "lead", cwd: p.root, status: "running" });
  const child = await launch(p, { role: "implementer", cwd: worktree, branch: "task/resumed-lead", authority: leadRow(first.id) });
  // The lead was killed and reattached twice; each resume is a new record of one chain.
  assert.equal((await update(p.root, first.id, { status: "failed" })).applied, true);
  const second = await seed(p.root, { role: "lead", cwd: p.root, status: "failed", resumedFrom: first.id });
  const third = await seed(p.root, { role: "lead", cwd: p.root, status: "running", resumedFrom: second.id });

  // The child was delegated under the first record of the chain; the last record of it is
  // the lead now, and cancelling that lead has to reach the child all the same.
  const outcomes = cancelled(await cancel(p.root, third.id));
  assert.deepEqual(outcomes.map((outcome) => outcome.id), [child.id, third.id]);
  assert.equal(outcomeOf(outcomes, child.id).outcome, "cancelled");
  assert.equal(p.record(child.id).status, "cancelled");
  assert.equal(alive(child.engineIdentity), false);
});

test("a lead may cancel only what it delegated, and a terminal lead still settles what survives it", async (t) => {
  const p = await projectWithRoles(t);
  const worktree = await p.worktree("task/owned");
  const lead = await seed(p.root, { role: "lead", cwd: p.root, status: "running" });
  const child = await launch(p, { role: "implementer", cwd: worktree, branch: "task/owned", authority: leadRow(lead.id) });
  const stranger = await seed(p.root, { role: "planner", cwd: p.root, status: "running" });

  const refused = await cancel(p.root, stranger.id, { leadTaskId: lead.id });
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.reason : "", new RegExp(`refused cancel of task ${stranger.id}`));
  assert.match(refused.ok === false ? refused.reason : "", new RegExp(`lead task ${lead.id} did not delegate it`));
  assert.equal(p.record(stranger.id).status, "running", "a refusal touches nothing");
  // Its own child it may cancel.
  assert.equal(outcomeOf(cancelled(await cancel(p.root, child.id, { leadTaskId: lead.id })), child.id).outcome, "cancelled");

  // A lead that has already failed still has a descendant to settle: this is the retry
  // after a partial failure, and it is what makes a second cancel worth calling.
  const survivor = await launch(p, { role: "planner", cwd: p.root, authority: leadRow(lead.id) });
  assert.equal((await update(p.root, lead.id, { status: "failed" })).applied, true);
  const outcomes = cancelled(await cancel(p.root, lead.id));
  assert.deepEqual(outcomeOf(outcomes, lead.id), { id: lead.id, outcome: "already failed" });
  assert.equal(outcomeOf(outcomes, survivor.id).outcome, "cancelled");
  assert.equal(alive(survivor.engineIdentity), false);
});

test("a task a cascade could not write is reported as such, and a later cancel finishes it", async (t) => {
  const p = await projectWithRoles(t, { lockWaitSeconds: 0, cancelGraceSeconds: 1 });
  const lead = await launch(p, { role: "lead", cwd: p.root });
  const child = await seed(p.root, { role: "planner", cwd: p.root, status: "running", parentTaskId: lead.id, identity: true });

  // Another writer holds the child's record lock, and this project waits no time at all,
  // so the cascade cannot write that one task. It must report it rather than abandon the rest.
  const held = await acquire(lockPath(p.root, recordLockName(child.id)), { operation: "the test holds it", waitSeconds: 2 });
  let releasing: Promise<void> | undefined;
  // Released here whatever the assertions do, so a failure leaves no lock behind for the
  // next test of this project to wait on.
  t.after(() => releasing ?? held.release());
  const partial = cancelled(await cancel(p.root, lead.id));
  const failure = outcomeOf(partial, child.id);
  assert.equal(failure.outcome, "running");
  assert.match(failure.reason ?? "", /lock/);
  assert.equal(p.record(child.id).status, "running");
  // The lead is settled all the same: one left running because a child of it could not be
  // written would go on working after it was cancelled.
  assert.equal(outcomeOf(partial, lead.id).outcome, "cancelled");

  releasing = held.release();
  await releasing;
  const retry = cancelled(await cancel(p.root, lead.id));
  assert.equal(outcomeOf(retry, child.id).outcome, "cancelled");
  assert.equal(outcomeOf(retry, lead.id).outcome, "already cancelled");
  assert.equal(p.record(child.id).status, "cancelled");
  assert.equal(p.record(lead.id).status, "cancelled");
});

test("a delegation racing a cascade is either refused or cancelled with the rest", async (t) => {
  const p = await projectWithRoles(t);
  for (let attempt = 0; attempt < 3; attempt++) {
    const worktree = await p.worktree(`task/race-${attempt}`);
    const lead = await launch(p, { role: "lead", cwd: p.root, brief: `lead of round ${attempt}` });
    const [child, outcomes] = await Promise.all([
      delegate(p.root, { role: "implementer", brief: "race", cwd: worktree, branch: `task/race-${attempt}` }, {
        authority: leadRow(lead.id), mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }),
      }),
      cancel(p.root, lead.id),
    ]);
    assert.equal(outcomes.ok, true);
    if (child.ok) {
      // It was written under the same lock the cascade snapshots under, so it is in the
      // cascade; a child the cascade never saw would be an engine nobody cancels.
      const settled = await waitForRecord(p, child.taskId, (record) => ["cancelled", "failed"].includes(record.status));
      assert.equal(settled.status, "cancelled", `${attempt}: ${JSON.stringify(outcomes.ok && outcomes.outcomes)}`);
      assert.ok(outcomes.ok && outcomes.outcomes.some((outcome) => outcome.id === child.taskId));
    } else {
      assert.match(child.reason, new RegExp(`parent task ${lead.id} is cancelling`));
    }
    assert.equal(p.record(lead.id).status, "cancelled");
  }
});

// @anchor unknownTaskReads
test("check and result on an unknown task answer that there is none and write nothing", async (t) => {
  // The helper's repository with its config taken away: a project nothing has configured or
  // delegated in, where a read has no business creating the ledger (atc-s96.51).
  const p = await project(t, { roles: {} }, [{ key: "consult" }]);
  fs.rmSync(path.join(p.root, ".cross-agent"), { recursive: true, force: true });
  const exclude = path.join(p.root, ".git", "info", "exclude");
  const before = fs.readFileSync(exclude, "utf8");
  assert.deepEqual(await check(p.root, "no-such-task"), { ok: false, reason: "no task no-such-task" });
  assert.deepEqual(result(p.root, "no-such-task"), { ok: false, reason: "no task no-such-task" });
  assert.equal(fs.existsSync(path.join(p.root, ".cross-agent")), false, "no ledger directory");
  assert.equal(fs.readFileSync(exclude, "utf8"), before, "no exclusion line");
});

test("a cancel names a task nobody has rather than inventing one", async (t) => {
  const p = await projectWithRoles(t);
  assert.deepEqual(await cancel(p.root, "no-such-task"), { ok: false, reason: "no task no-such-task" });
});

// @anchor cancelUnknownWritesNothing
test("a cancel of a task nobody has, in a repository nobody initialized, locks nothing and writes nothing", async (t) => {
  // One empty commit and nothing of this project's: no config, no ledger, no lock directory.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "cross-agent-uninitialized-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await git(root, "init", "-b", "main");
  await git(root, "commit", "--allow-empty", "-m", "initial");
  const excludeFile = path.join(root, ".git", "info", "exclude");
  const exclude = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile) : null;

  // The config read answers defaults for a project with no file, and the lookup refuses
  // before `spawn.lock` could make `.cross-agent/locks/`.
  assert.deepEqual(await cancel(root, "no-such-task"), { ok: false, reason: "no task no-such-task" });
  assert.equal(fs.existsSync(path.join(root, ".cross-agent")), false, "no lock directory, no ledger");
  assert.deepEqual(fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile) : null, exclude, "the exclude file is as git init left it");
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=all"), "");
});
