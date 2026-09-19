import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Authority } from "../src/authority.ts";
import { delegate } from "../src/delegate.ts";
import { create, update } from "../src/ledger.ts";
import type { TaskRecord } from "../src/ledger.ts";
import { acquire, lockPath, recordLockName } from "../src/locks.ts";
import { findByEnvironment } from "../src/process.ts";
import { createServer, projectTools } from "../src/server.ts";
import { check } from "../src/tasks.ts";
import { observeStall, wait } from "../src/wait.ts";
import { alive, engineEnv, poll, waitForRecord, project, strandedEngine, suiteEnv } from "./helpers/project.ts";
import type { TestProject } from "./helpers/project.ts";

const exec = promisify(execFile);
const worktreeRoot = fileURLToPath(new URL("../", import.meta.url));
const operator: Authority = { row: "operator", reason: "operator: no CROSS_AGENT_* variable and no engine ancestor", depth: 0 };

// A fraction of a minute is a valid `stallMinutes`, and 0.02 of one is 1.2 seconds: what
// keeps a stall test a second of silence rather than a quarter of an hour of it.
const stallMinutes = 0.02;
const stallMs = stallMinutes * 60_000;

function configFor(bin: string, limits: Record<string, number> = {}): Record<string, unknown> {
  return {
    roles: {
      lead: { engine: "grok", cwd: "root", sandbox: "read-only" },
      planner: { engine: "grok", cwd: "root", sandbox: "read-only" },
    },
    engines: { grok: { bin } },
    // The two wall-clock budgets these tools ride on, set far past anything the tests
    // below need: how long a write waits for a record another writer holds, and how long
    // a cancel gives a runner to settle. Left small they are margins a loaded machine can
    // miss, and the test then fails for the load rather than for the behaviour. Each test
    // that is about one of the budgets sets its own.
    limits: { maxDepth: 3, lockWaitSeconds: 30, stallMinutes, ...limits },
    billing: "subscription",
  };
}

/** A project whose engine binary is the fake engine, with this test's own limits. */
async function waitProject(t: TestContext, limits: Record<string, number> = {}): Promise<TestProject> {
  const created = await project(t, configFor("placeholder", limits));
  fs.writeFileSync(path.join(created.root, ".cross-agent", "config.json"), JSON.stringify(configFor(created.bin, limits)));
  return created;
}

/** A real task of this project, returned once its runner has acknowledged it. */
async function launch(p: TestProject, env: Record<string, string>): Promise<TaskRecord> {
  const started = await delegate(p.root, { role: "planner", brief: "work for planner", cwd: p.root }, {
    authority: operator, env: engineEnv(p, env),
  });
  assert.equal(started.ok, true, `delegate refused: ${JSON.stringify(started)}`);
  const id = started.ok ? started.taskId : "";
  return waitForRecord(p, id, (record) => record.status !== "launching");
}

/** A record nobody launched: a `launching` task with no runner and no engine. */
function seed(p: TestProject): TaskRecord {
  return create(p.root, { role: "planner", brief: "seeded", cwd: p.root, engine: "grok" });
}

/**
 * A launch nobody ever acknowledged, past its deadline, with the engine a killed runner
 * would have left. The record is dated a clear five seconds back because a start time read
 * from `/proc` can name a start up to a second before the real one, and the environ scan
 * takes only candidates that started after the record did (`tests/reconcile.test.ts`).
 */
async function overdueLaunch(t: TestContext, p: TestProject): Promise<{ record: TaskRecord; engine: ReturnType<typeof strandedEngine> }> {
  const record = create(p.root, { role: "planner", brief: "seeded", cwd: p.root, engine: "grok" }, Date.now() - 5_000);
  assert.equal((await update(p.root, record.id, { launchDeadline: Date.now() - 1_000 })).applied, true);
  const engine = strandedEngine(t, p, record.id);
  await poll(() => findByEnvironment(record.id, record.createdAt).found, (found) => found.length === 1);
  return { record, engine };
}

test("a quiet engine stalls and keeps running; check revives it, a second wait stalls again, a third settles", async (t) => {
  const p = await waitProject(t);
  const task = await launch(p, {
    FAKE_ENGINE_SCRIPT: "quiet-then-active", FAKE_ENGINE_QUIET_MS: "3000", FAKE_ENGINE_LINGER_MS: "4000",
  });

  // The engine has emitted nothing at all, so the clock this stall is read from is the
  // acknowledgement rather than a last event (design section 2). The assertions below hold
  // because this answer comes from inside the fixture's 3-second silence: the threshold is
  // 1.2 s, and the wall time is asserted rather than assumed.
  const quiet = performance.now();
  const first = await wait(p.root, task.id, { timeoutSeconds: 10, pollMs: 100 });
  assert.ok(performance.now() - quiet < 3000, `the first wait answered after ${Math.round(performance.now() - quiet)}ms, past the quiet window`);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.ok && first.status, "stalled");
  assert.equal(first.ok && first.stalled, true);
  assert.equal(first.ok && first.lastActivity, null);
  assert.equal(first.ok && first.resultTail, null);
  assert.equal(first.ok && first.hint, `stalled: read ${task.logPath}, keep waiting, or cancel`);
  const record = p.record(task.id);
  assert.equal(record.status, "stalled", "the stall is written, not merely reported");
  assert.equal(record.lastEventAt ?? null, null, "nothing has been emitted");
  assert.equal(typeof record.acknowledgedAt, "number", "so the clock is the acknowledgement");
  assert.equal(alive(record.engineIdentity), true, "a stalled task is still running");

  // The engine emits, the runner persists it on its own interval, and `check` is the other
  // reader of that clock: it writes the task back to running.
  const revived = await poll(() => check(p.root, task.id), (answer) => answer.ok && answer.status === "running", 9000);
  assert.equal(revived.ok && revived.status, "running");
  assert.equal(p.record(task.id).status, "running", "check wrote the revival it read");

  // A second wait on the task keeps polling: the engine's linger is silence again, so the
  // task stalls again rather than answering the moment this call arrives.
  const second = await wait(p.root, task.id, { timeoutSeconds: 10, pollMs: 100 });
  assert.equal(second.ok && second.status, "stalled");
  assert.ok(second.ok && second.lastActivity?.includes("working"), JSON.stringify(second));

  // And a third returns the settlement, with the tail of the engine's final message.
  const third = await wait(p.root, task.id, { timeoutSeconds: 10, pollMs: 100 });
  assert.equal(third.ok && third.status, "done", JSON.stringify(third));
  assert.equal(third.ok && third.stalled, false);
  assert.equal(third.ok && third.hint, "settled: call result");
  assert.ok(third.ok && third.resultTail?.startsWith("DONE"), JSON.stringify(third));
});

test("a settled task is answered on the first read, with the tail of its result", async (t) => {
  const p = await waitProject(t);
  const task = await launch(p, { FAKE_ENGINE_SCRIPT: "ok" });
  await poll(() => p.record(task.id).status, (status) => status === "done");

  const started = performance.now();
  const answer = await wait(p.root, task.id, { timeoutSeconds: 30 });
  assert.ok(performance.now() - started < 10_000, "a terminal record is answered by the pass, not polled for 30s");
  assert.equal(answer.ok && answer.status, "done");
  assert.equal(answer.ok && answer.stalled, false);
  assert.equal(answer.ok && answer.hint, "settled: call result");
  assert.equal(answer.ok && answer.task_id, task.id);
  assert.equal(answer.ok && answer.resultTail, fs.readFileSync(p.record(task.id).resultPath, "utf8").slice(-2000));
  assert.ok(answer.ok && answer.resultTail?.startsWith("DONE"), JSON.stringify(answer));
  // The activity is the last line of the engine's own event stream, as `check` reads it.
  assert.equal(answer.ok && answer.lastActivity, fs.readFileSync(task.logPath, "utf8").trim().split("\n").at(-1));
  assert.deepEqual(await wait(p.root, "no-such-task", { timeoutSeconds: 1 }), { ok: false, reason: "no task no-such-task" });
});

test("check answers while a wait is pending, and an aborted wait returns the status it found", async (t) => {
  // Nothing stalls in this test: it is about the two calls living side by side.
  const p = await waitProject(t, { stallMinutes: 60 });
  const task = await launch(p, { FAKE_ENGINE_SCRIPT: "stall" });

  const controller = new AbortController();
  let done = false;
  const pending = wait(p.root, task.id, { timeoutSeconds: 30, signal: controller.signal })
    .then((value) => { done = true; return value; });
  const answer = await check(p.root, task.id);
  assert.equal(answer.ok && answer.status, "running");
  assert.equal(done, false, "the wait is still pending");

  const aborted = performance.now();
  controller.abort();
  const result = await pending;
  assert.ok(performance.now() - aborted < 100, "an aborted wait returns at once");
  assert.equal(result.ok && result.cancelled, true);
  assert.equal(result.ok && result.status, "running");
  assert.equal(result.ok && result.hint, "call wait again");
  assert.equal(p.record(task.id).status, "running", "an aborted wait settles nothing");
});

test("a launching record never stalls: its deadline is the reconciler's", async (t) => {
  const p = await waitProject(t);
  const record = seed(p);
  // An event time older than any threshold, on a record no runner has acknowledged.
  const aged = (await update(p.root, record.id, { lastEventAt: Date.now() - 3_600_000 })).record;
  assert.equal((await observeStall(p.root, aged)).status, "launching");

  const answer = await wait(p.root, record.id, { timeoutSeconds: 0.3, pollMs: 50 });
  assert.equal(answer.ok && answer.status, "launching");
  assert.equal(answer.ok && answer.stalled, false);
  assert.equal(answer.ok && answer.hint, "call wait again");
  assert.equal(p.record(record.id).status, "launching");
});

test("the default timeout is the project's waitDefaultSeconds", async (t) => {
  const p = await waitProject(t, { waitDefaultSeconds: 0.4 });
  const record = seed(p);
  const started = performance.now();
  const answer = await wait(p.root, record.id, {});
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 350, `returned after ${Math.round(elapsed)}ms, before the configured timeout`);
  assert.ok(elapsed < 15_000, `waited ${Math.round(elapsed)}ms, not the 600s the helper would default to`);
  assert.equal(answer.ok && answer.hint, "call wait again");
});

test("a runner killed during a wait is settled by one reconciliation pass and reported", async (t) => {
  const p = await waitProject(t, { stallMinutes: 60 });
  const task = await launch(p, { FAKE_ENGINE_SCRIPT: "stall" });

  const pending = wait(p.root, task.id, { timeoutSeconds: 20, pollMs: 100 });
  process.kill(task.runnerIdentity!.pid, "SIGKILL");
  const answer = await pending;

  assert.equal(answer.ok && answer.status, "failed", JSON.stringify(answer));
  assert.equal(answer.ok && answer.hint, "settled: call result");
  // Which half of the pass ended the engine is genuinely a race, and both answers are
  // right: this runner was SIGKILLed with the engine's stdout pipe open, so the engine
  // may take SIGPIPE on its next write and be gone before the pass reaches it, or it may
  // still be there and be killed by cleanup, which says so. Those two reasons are the
  // whole set — anything else would be a third answer nobody expected.
  assert.match(p.record(task.id).reason!, /^runner lost(; engine group terminated)?$/);
  assert.equal(alive(task.engineIdentity), false, "the pass ended the engine the dead runner left");
});

test("an orphan that cleanup cannot settle is reported as orphaned, not polled for", async (t) => {
  const p = await waitProject(t);
  const record = seed(p);
  // Orphaned with no engine identity: cleanup names it and acts on nothing (design section 2).
  assert.equal((await update(p.root, record.id, { status: "orphaned" })).applied, true);

  const started = performance.now();
  const answer = await wait(p.root, record.id, { timeoutSeconds: 30, pollMs: 100 });
  assert.ok(performance.now() - started < 10_000, "an orphan is answered by the pass, not waited on for 30s");
  assert.equal(answer.ok && answer.status, "orphaned");
  assert.equal(answer.ok && answer.stalled, false);
  assert.equal(answer.ok && answer.hint, "orphaned: list_tasks reconciles; cancel terminates the engine");
  // And what cleanup would not act on, which is why the record is still there to answer for.
  assert.equal(answer.ok ? answer.reason : "", "no engine identity");
});

test("a second wait in a fresh process reads the same clock from the ledger", async (t) => {
  const p = await waitProject(t);
  const task = await launch(p, { FAKE_ENGINE_SCRIPT: "stall" });
  const first = await wait(p.root, task.id, { timeoutSeconds: 10, pollMs: 100 });
  assert.equal(first.ok && first.status, "stalled");

  // Nothing of this stall is in memory: another server process reads the record, sees the
  // same silence, keeps polling, and answers with the same reading when its timeout passes.
  const module = JSON.stringify(pathToFileURL(path.join(worktreeRoot, "src", "wait.ts")).href);
  const call = `wait(${JSON.stringify(p.root)}, ${JSON.stringify(task.id)}, { timeoutSeconds: 0.5, pollMs: 100 })`;
  const { stdout } = await exec(process.execPath, [
    "--input-type=module", "--eval", `import { wait } from ${module};\nprocess.stdout.write(JSON.stringify(await ${call}));`,
  ], { env: suiteEnv });
  const answer = JSON.parse(stdout) as { status: string; stalled: boolean; hint: string };
  assert.equal(answer.status, "stalled");
  assert.equal(answer.stalled, true);
  assert.equal(answer.hint, `stalled: read ${task.logPath}, keep waiting, or cancel`);
  assert.equal(alive(task.engineIdentity), true, "a stall is a reading, not a settlement");
  assert.equal(p.record(task.id).status, "stalled");
});

test("a lead waits on the tasks it delegated and is refused by name for any other", async (t) => {
  const p = await waitProject(t);
  const lead = create(p.root, { role: "lead", brief: "lead", cwd: p.root, engine: "grok" });
  const child = create(p.root, { role: "planner", brief: "child", cwd: p.root, engine: "grok", depth: 1, parentTaskId: lead.id });
  const stranger = seed(p);

  const authority: Authority = { row: "lead", reason: `lead by ancestry: task ${lead.id} (lead, running)`, taskId: lead.id, depth: 1 };
  const server = createServer({ tools: projectTools(p.root), authority: () => authority });
  let id = 0;
  const call = async (args: Record<string, unknown>) => await server.handle({
    jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "wait", arguments: args },
  }) as Record<string, Record<string, unknown>>;

  const refused = (await call({ task_id: stranger.id, timeout_seconds: 0.1 })).result;
  assert.equal(refused.isError, true, JSON.stringify(refused));
  assert.deepEqual(JSON.parse((refused.content as Array<{ text: string }>)[0].text), {
    ok: false, reason: `refused wait on task ${stranger.id}: lead task ${lead.id} did not delegate it`,
  });

  // A task nobody has is that, not a task this lead was not given: existence first.
  const missing = (await call({ task_id: "no-such-task", timeout_seconds: 0.1 })).result;
  assert.equal(missing.isError, true, JSON.stringify(missing));
  assert.deepEqual(JSON.parse((missing.content as Array<{ text: string }>)[0].text), { ok: false, reason: "no task no-such-task" });

  const allowed = (await call({ task_id: child.id, timeout_seconds: 0.1 })).result;
  assert.equal(allowed.isError, undefined);
  const payload = JSON.parse((allowed.content as Array<{ text: string }>)[0].text) as { ok: boolean; task_id: string; status: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.task_id, child.id);
  assert.equal(payload.status, "launching");
});

test("observeStall writes each transition conditionally and returns the record as it stands", async (t) => {
  const p = await waitProject(t);
  const record = seed(p);
  const acknowledged = (await update(p.root, record.id, { status: "running", acknowledgedAt: Date.now() - stallMs - 1 })).record;

  // The clock is `lastEventAt ?? acknowledgedAt`, and a reading past the threshold is a stall.
  const stalled = await observeStall(p.root, acknowledged);
  assert.equal(stalled.status, "stalled");
  assert.equal(p.record(record.id).status, "stalled");
  // A second reading of the same silence writes nothing and answers the same way.
  const again = await observeStall(p.root, stalled);
  assert.equal(again.status, "stalled");
  assert.equal(again.updatedAt, stalled.updatedAt);

  // A fresh event is a revival, and it is the newer clock that decides it.
  const revived = await observeStall(p.root, (await update(p.root, record.id, { lastEventAt: Date.now() })).record);
  assert.equal(revived.status, "running");

  // A record another writer has settled is returned as it is: the write is refused inside
  // the record lock, and the caller reads the state that beat it.
  const stale = { ...revived, lastEventAt: Date.now() - stallMs - 1 };
  assert.equal((await update(p.root, record.id, { status: "done" })).applied, true);
  assert.equal((await observeStall(p.root, stale)).status, "done");
});

test("a stall another reader wrote while this call slept is this call's answer", async (t) => {
  const p = await waitProject(t);
  const task = await launch(p, { FAKE_ENGINE_SCRIPT: "stall" });

  // A slow poll, so the threshold is crossed while this call is asleep and the reader that
  // writes the stall is somebody else. The answer is the crossing, not who recorded it.
  let done = false;
  const started = performance.now();
  const pending = wait(p.root, task.id, { timeoutSeconds: 20, pollMs: 2000 })
    .then((value) => { done = true; return value; });
  await poll(() => check(p.root, task.id), (answer) => answer.ok && answer.status === "stalled", 6000);
  assert.equal(done, false, "check wrote the stall while the wait slept");

  const answer = await pending;
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 8000, `answered after ${Math.round(elapsed)}ms, not at the 20s timeout`);
  assert.equal(answer.ok && answer.status, "stalled");
  assert.equal(answer.ok && answer.stalled, true);
});

test("a quiet task whose runner has died is reconciled, not reported as stalled", async (t) => {
  const p = await waitProject(t);
  const task = await launch(p, { FAKE_ENGINE_SCRIPT: "stall" });
  process.kill(task.runnerIdentity!.pid, "SIGKILL");
  await poll(() => alive(task.runnerIdentity), (value) => value === false);
  // Past the threshold on the record's own clock — the killed runner tees nothing more, so
  // that clock is the acknowledgement — which puts a readable stall in front of the answer.
  await poll(() => {
    const current = p.record(task.id);
    return Date.now() - (current.lastEventAt ?? current.acknowledgedAt ?? current.createdAt);
  }, (age) => age > stallMs);
  assert.equal(p.record(task.id).status, "running");

  const answer = await wait(p.root, task.id, { timeoutSeconds: 15, pollMs: 100 });
  assert.equal(answer.ok && answer.status, "failed", JSON.stringify(answer));
  assert.equal(answer.ok && answer.hint, "settled: call result");
  assert.equal(p.record(task.id).reason, "runner lost");
  assert.equal(alive(task.engineIdentity), false);
});

test("a launch past its deadline is adopted and settled by this call's own pass", async (t) => {
  const p = await waitProject(t);
  const { record, engine } = await overdueLaunch(t, p);

  const answer = await wait(p.root, record.id, { timeoutSeconds: 10, pollMs: 100 });
  assert.equal(answer.ok && answer.status, "failed", JSON.stringify(answer));
  assert.equal(answer.ok && answer.hint, "settled: call result");
  // Exactly one reason is possible here, unlike the SIGKILLed-runner case above: this
  // engine shares no pipe with anything (`strandedEngine`, stdio "ignore") and handles no
  // signal, so it is alive when the pass adopts it and cleanup is what ends it.
  assert.equal(p.record(record.id).reason, "runner lost; engine group terminated");
  assert.equal(alive(engine.identity), false, "the adopted engine's group was terminated");
});

test("a record the one pass could not settle is answered with the pass's reason, not polled for", async (t) => {
  const p = await waitProject(t);
  const { record, engine } = await overdueLaunch(t, p);
  // The one environment the pass must read, unreadable: it declines rather than declare a
  // launch failed over an engine that may be alive (design section 2, B5-i).
  const original = fs.readFileSync;
  const mock = t.mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (target === `/proc/${engine.pid}/environ`) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return (original as (target: fs.PathOrFileDescriptor, options?: unknown) => string | Buffer)(target, options);
  }) as typeof fs.readFileSync);

  const started = performance.now();
  const answer = await wait(p.root, record.id, { timeoutSeconds: 30, pollMs: 100 });
  mock.mock.restore();

  assert.ok(performance.now() - started < 10_000, "the pass is the answer, not the 30s timeout");
  assert.equal(answer.ok && answer.status, "launching");
  assert.match(answer.ok ? answer.reason ?? "" : "", /environ unreadable for 1 process/);
  assert.match(answer.ok ? answer.hint : "", /list_tasks/);
  assert.equal(p.record(record.id).status, "launching", "the pass wrote nothing");
  assert.equal(alive(engine.identity), true, "and killed nothing");
});

test("a call aborted before it polls answers cancelled and reconciles nothing", async (t) => {
  const p = await waitProject(t);
  // Overdue, with no engine anywhere: a pass would write `failed: launch` at once, so the
  // record still being `launching` is the proof that none ran.
  const record = create(p.root, { role: "planner", brief: "seeded", cwd: p.root, engine: "grok" }, Date.now() - 5_000);
  assert.equal((await update(p.root, record.id, { launchDeadline: Date.now() - 1_000 })).applied, true);

  const answer = await wait(p.root, record.id, { timeoutSeconds: 10, pollMs: 100, signal: AbortSignal.abort() });
  assert.equal(answer.ok && answer.cancelled, true);
  assert.equal(answer.ok && answer.status, "launching");
  assert.equal(p.record(record.id).status, "launching", "no pass ran for a caller that had gone");
});

test("a record lock this project will not wait for refuses both readers by that rule", async (t) => {
  // Every waiter blocks up to `lockWaitSeconds` and then refuses, naming the operation
  // (design section 2); zero is a project that refuses at once.
  const p = await waitProject(t, { lockWaitSeconds: 0 });
  const task = await launch(p, { FAKE_ENGINE_SCRIPT: "stall" });
  const eventAt = await poll(() => p.record(task.id).lastEventAt, (value) => Boolean(value)) as number;
  const held = await acquire(lockPath(p.root, recordLockName(task.id)), { operation: "hold for the test", waitSeconds: 0 });

  try {
    const started = performance.now();
    const refused = await check(p.root, task.id, { now: eventAt + stallMs + 1 });
    assert.ok(performance.now() - started < 3500, "check waited its own project's rule of 0s, not the helper's 5s default");
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.match(refused.ok === false ? refused.reason : "", /is held by another process \(waited 0s\)/);

    const waited = await wait(p.root, task.id, { timeoutSeconds: 10, pollMs: 50 });
    assert.equal(waited.ok, false, JSON.stringify(waited));
    assert.match(waited.ok === false ? waited.reason : "", /is held by another process \(waited 0s\)/);
  } finally {
    await held.release();
  }
});
