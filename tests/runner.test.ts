import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ledger from "../src/ledger.ts";
import { acquire, lockPath, recordLockName, runnerLockName } from "../src/locks.ts";
import { reconcile } from "../src/reconcile.ts";
import type { LaunchSpec, TaskPatch, TaskRecord, TaskStatus, UpdateResult } from "../src/ledger.ts";
import { poll, pollDeadlineMs } from "./helpers/project.ts";

// What this file's own /proc reading yields. It deliberately does not carry the boot
// id the implementation records: these helpers judge liveness for cleanup, so they
// must keep working even when the implementation's own notion of identity is broken.
type Inspected = { pid: number; startTime: string; pgid: number; state: string };

const worktree = fileURLToPath(new URL("../", import.meta.url));
const fixtures = path.join(worktree, "tests", "fixtures");
const fake = path.join(fixtures, "fake-engine.mjs");
const terminal = (record: TaskRecord) => ["done", "failed", "cancelled"].includes(record.status);

/** ledger.update, asserting it applied, for callers that only want the new record. */
async function applied(result: Promise<UpdateResult>): Promise<TaskRecord> {
  const value = await result;
  assert.equal(value.applied, true, `update was refused: ${JSON.stringify(value)}`);
  return value.record;
}

// Design section 2, E1: only some status changes are legal, so a test that wants a
// record in a given state walks there the way a real writer would.
const routes: Record<string, TaskStatus[]> = {
  running: ["running"], orphaned: ["running", "orphaned"], cancelling: ["cancelling"],
  done: ["running", "done"], failed: ["failed"], cancelled: ["cancelling", "cancelled"],
};

/** Another writer settling or moving a record, through legal transitions only. */
async function writeAs(root: string, id: string, status: TaskStatus, patch: TaskPatch = {}): Promise<TaskRecord> {
  const steps = routes[status] ?? [status];
  let record: TaskRecord | undefined;
  for (const [index, step] of steps.entries()) {
    record = await applied(ledger.update(root, id, index === steps.length - 1 ? { status: step, ...patch } : { status: step }));
  }
  return record!;
}

// Independent proc inspection lets cleanup work even when the implementation is broken.
function proc(pid: number) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
    return { pid, startTime: fields[19], pgid: Number(fields[2]), state: fields[0] };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code!)) return null;
    throw error;
  }
}

function living(identity: { pid: number; startTime: string }) {
  const current = proc(identity.pid);
  return current?.startTime === identity.startTime && !["Z", "X"].includes(current.state);
}

function ownedProcesses(root: string): Inspected[] {
  const identities: Inspected[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const env = fs.readFileSync(`/proc/${entry}/environ`, "utf8");
      if (!env.split("\0").includes(`RUNNER_TEST_ROOT=${root}`)) continue;
      const identity = proc(Number(entry));
      if (identity && living(identity)) identities.push(identity);
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES"].includes((error as NodeJS.ErrnoException).code!)) throw error;
    }
  }
  return identities;
}

function harness(options: {
  named?: boolean; delayedImport?: boolean; delayedPlan?: boolean; refusal?: boolean; race?: string; failure?: string;
  leadingHyphen?: boolean; competitor?: "at-write" | "before-write";
} = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cross-agent-runner-"));
  const token = randomUUID();
  const adapterModule = path.join(fixtures, `runner-${token}.mjs`);
  const engineModule = path.join(fixtures, `runner-engine-${token}.mjs`);
  const children: {
    child: ChildProcess; identity: Inspected | null; closed: boolean;
    code: number | null; signal: NodeJS.Signals | null; error: Error | null;
  }[] = [];
  const cleanups = new Set<() => Promise<void>>();
  const record = ledger.create(root, { role: "implementer", brief: "finish T5", cwd: root, engine: "claude" });
  if (options.leadingHyphen) {
    const originalFile = path.join(root, ".cross-agent", "tasks", `${record.id}.json`);
    record.id = `-${record.id}`;
    record.resultPath = path.join(path.dirname(originalFile), `${record.id}.out`);
    record.logPath = path.join(path.dirname(originalFile), `${record.id}.ndjson`);
    fs.writeFileSync(path.join(path.dirname(originalFile), `${record.id}.json`), JSON.stringify(record));
    fs.rmSync(originalFile);
  }
  // Every runner of this file waits this long for a record lock, written into the project
  // so that no test rides on the default. A test that holds the lock while it sets a scene
  // holds it for as long as that scene takes on the machine it is running on, and a runner
  // that gave up at the five-second default would fail for the load rather than for the
  // behaviour under test. The one test that is about the limit writes its own config.
  fs.writeFileSync(path.join(root, ".cross-agent", "config.json"),
    JSON.stringify({ roles: {}, limits: { lockWaitSeconds: 60 } }));
  const recordFile = path.join(root, ".cross-agent", "tasks", `${record.id}.json`);
  const auditFile = path.join(root, "writes.ndjson");
  const release = path.join(root, "release");
  const importReady = path.join(root, "import-ready");
  const importRelease = path.join(root, "import-release");
  const planReady = path.join(root, "plan-ready");
  const planRelease = path.join(root, "plan-release");
  const invocation = path.join(root, "invocation.json");
  const invocations = path.join(root, "invocations");
  const descendantFile = path.join(root, "descendant.json");
  const inheritedFile = path.join(root, "descendant-inherited");
  const competitorScript = path.join(root, "competitor.mjs");
  const outcomeFile = path.join(root, "competitor-outcome.json");
  const markers = {
    atWrite: path.join(root, "competitor-at-write"), beforeWrite: path.join(root, "settled-before-write"),
    cancelled: path.join(root, "runner-claimed-the-cancel"),
  };
  const spec: LaunchSpec = {
    role: "implementer", brief: "finish T5", rolePrompt: "Implement this brief.", cwd: root, engine: "claude",
    model: "fixture-model", effort: "high", sandbox: { mode: "write", profile: "workspace-write" },
    denyTargets: ["claude", "codex", "grok"], scratchDir: path.join(root, ".cross-agent", "tasks"),
    sessionId: "requested-session", resumeSessionId: "previous-session", adapterModule,
    env: { RUNNER_TEST_ROOT: root, FAKE_ENGINE_SCRIPT: "ok", FAKE_ENGINE_RECORD: invocation },
  };
  // The engine leader. DESCENDANT=1 leaves a group member behind that shares no
  // pipe with the runner; ACTIVITY_AFTER=<file> holds all output until that file exists.
  fs.writeFileSync(engineModule, `
import fs from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const env = process.env;
if (env.INVOCATIONS) fs.appendFileSync(env.INVOCATIONS, process.pid + "\\n");
if (env.FILE_RESULT) fs.writeFileSync(env.FILE_RESULT, "engine file result");
if (env.RACE_EXIT === "1") process.on("exit", () => { try { process.kill(process.ppid, "SIGTERM"); } catch {} });
// An engine that outlives the cancel's grace, so the teardown below it lasts longer than
// one turn of the runner's activity interval.
if (env.IGNORE_TERM === "1") process.on("SIGTERM", () => {});
// DESCENDANT_INHERIT=1 leaves a member that shares the runner's pipe, so the engine's
// own exit can never close it.
if (env.DESCENDANT_INHERIT === "1") {
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }).unref();
  fs.writeFileSync(${JSON.stringify(inheritedFile)}, "spawned");
}
if (env.DESCENDANT === "1") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const stat = fs.readFileSync("/proc/" + descendant.pid + "/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\\s+/);
  fs.writeFileSync(${JSON.stringify(descendantFile)}, JSON.stringify({
    pid: descendant.pid, startTime: fields[19], pgid: Number(fields[2]), sid: Number(fields[3]),
  }));
  descendant.unref();
}
if (env.HOLD === "1") {
  if (env.ACTIVITY_AFTER) while (!fs.existsSync(env.ACTIVITY_AFTER)) await delay(30);
  console.log(JSON.stringify({ type: "event", text: "fixture ready" }));
  while (!fs.existsSync(${JSON.stringify(release)})) {
    if (env.ACTIVITY === "1") console.log(JSON.stringify({ type: "event", text: "tick" }));
    await delay(30);
  }
}
await import(${JSON.stringify(pathToFileURL(fake).href)});
`);
  // A second writer using the public ledger API from its own process. It writes its
  // marker on entry, optionally waits for a gate so two of them contend, then records
  // what update answered. The outcome file is renamed into place so a reader never
  // sees half of it.
  fs.writeFileSync(competitorScript, `
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import * as ledger from ${JSON.stringify(pathToFileURL(path.join(worktree, "src", "ledger.ts")).href)};
const [root, id, patch, now, marker, outcome, expected, gate] = process.argv.slice(2);
if (marker) fs.writeFileSync(marker, String(Date.now()));
if (gate) while (!fs.existsSync(gate)) await delay(5);
let result;
try {
  result = await ledger.update(root, id, JSON.parse(patch), Number(now), expected
    ? { expect: (record) => record.status === expected }
    : { unlessTerminal: true });
} catch (error) {
  result = { error: String(error) };
}
fs.writeFileSync(outcome + ".tmp", JSON.stringify(result));
fs.renameSync(outcome + ".tmp", outcome);
`);
  fs.writeFileSync(adapterModule, `
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const target = ${JSON.stringify(recordFile)};
const audit = ${JSON.stringify(auditFile)};
// The runner registers its own SIGTERM handler before it imports this module, and
// listeners run in registration order: this marker therefore appears only after the
// runner has claimed the teardown, which is a fact no test can read from outside the
// process.
process.on("SIGTERM", () => { try { fs.writeFileSync(${JSON.stringify(markers.cancelled)}, "settling"); } catch {} });
const terminal = (record) => ["done", "failed", "cancelled"].includes(record.status);
const args = (patch, now, marker) => [
  ${JSON.stringify(competitorScript)}, ${JSON.stringify(root)}, ${JSON.stringify(record.id)},
  JSON.stringify(patch), String(now), marker, ${JSON.stringify(outcomeFile)},
];
const stdio = () => ["ignore", "ignore", fs.openSync(${JSON.stringify(path.join(root, "competitor.err"))}, "a")];
// Blocking: the competitor's write lands before this process writes anything more.
function compete(patch, now, marker) {
  const result = spawnSync(process.execPath, args(patch, now, marker), { stdio: stdio() });
  if (result.status !== 0) throw new Error("competitor exited " + result.status);
}
// Non-blocking: the competitor starts here but takes the record lock only once this
// process releases it, so waiting for it inside the lock would deadlock both.
function competeLater(patch, now, marker) {
  spawn(process.execPath, args(patch, now, marker), { stdio: stdio(), detached: true }).unref();
}
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (to !== target) return rename(from, to);
  // The audit records the incoming record itself, before anyone else can touch the target.
  const record = JSON.parse(fs.readFileSync(from, "utf8"));
  ${options.failure === "ledger" ? 'throw new Error("fixture ledger write failed");' : ""}
  ${options.failure === "ledger-terminal" ? `{
    const current = JSON.parse(fs.readFileSync(target, "utf8"));
    fs.writeFileSync(target + ".external", JSON.stringify({ ...current, status: "failed", reason: "external settlement" }));
    rename(target + ".external", target);
    throw new Error("fixture ledger write failed after external settlement");
  }` : ""}
  // Appended before the rename, not after it: the rename is what publishes the record a
  // test is polling for, and a runner descheduled between the two would leave a reader
  // that has already seen the new record with an audit that has not caught up yet.
  fs.appendFileSync(audit, JSON.stringify({ at: Date.now(), record }) + "\\n");
  const result = rename(from, to);
  ${options.competitor === "at-write" ? `if (terminal(record)) competeLater({ status: "done", reason: "competitor" }, 456, ${JSON.stringify(markers.atWrite)});` : ""}
  return result;
};
${options.delayedImport ? `fs.writeFileSync(${JSON.stringify(importReady)}, "ready");
while (!fs.existsSync(${JSON.stringify(importRelease)})) await delay(10);` : ""}
const originalRead = fs.readFileSync;
function externalSettlement() {
  const record = JSON.parse(originalRead(target, "utf8"));
  fs.writeFileSync(target + ".external", JSON.stringify({ ...record, status: "${options.race === "same-status" ? "done" : "failed"}", reason: "external settlement", updatedAt: 123 }));
  fs.renameSync(target + ".external", target);
}
let request;
const adapter = {
  name: "claude",
  sandboxSupport: () => (${options.refusal ? '{ ok: false, reason: "fixture sandbox missing" }' : "{ ok: true }"}),
  plan(value) {
    request = value;
    ${options.delayedPlan ? `fs.writeFileSync(${JSON.stringify(planReady)}, "ready");
    while (!fs.existsSync(${JSON.stringify(planRelease)})) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }` : ""}
    ${["identity", "identity-late"].includes(options.failure!) ? `fs.readFileSync = function(file, ...args) {
      if (typeof file === "string" && /^\\/proc\\/\\d+\\/stat$/.test(file) && file !== "/proc/" + process.pid + "/stat") {
        ${options.failure === "identity-late" ? `while (!fs.existsSync(${JSON.stringify(inheritedFile)})) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }` : ""}
        fs.readFileSync = originalRead;
        throw Object.assign(new Error("missing engine identity"), { code: "ENOENT" });
      }
      return originalRead(file, ...args);
    };` : ""}
    fs.writeFileSync(${JSON.stringify(path.join(root, "request.json"))}, JSON.stringify(value));
    return { bin: ${options.failure === "spawn" ? JSON.stringify(path.join(root, "missing-engine")) : "process.execPath"}, argv: [${JSON.stringify(engineModule)}, value.brief], cwd: value.cwd, env: value.env };
  },
  parseLine(line) {
    let value;
    try { value = JSON.parse(line); } catch { return null; }
    if (value.type === "session") return { kind: "session", sessionId: value.session_id };
    if (value.type === "event") return { kind: "activity", text: value.text };
    if (value.type === "error") return { kind: "error", text: value.text };
    if (value.type === "result" && request.env.NO_RESULT !== "1") return { kind: "result", text: value.text };
    return null;
  },
  finalMessage(events, text) {
    ${["settlement", "same-status"].includes(options.race!) ? "externalSettlement();" : ""}
    ${options.competitor === "before-write" ? `compete({ status: "done", reason: "external settlement" }, 123, ${JSON.stringify(markers.beforeWrite)});` : ""}
    return events.findLast((event) => event.kind === "result")?.text ?? text ?? "";
  },
};
${options.named ? "export { adapter };" : "export default adapter;"}
`);
  /** `patch` overrides the spec, whose `env` is the engine's; `runnerEnv` is the runner's own. */
  function start(patch: Partial<LaunchSpec> = {}, capture = false, runnerEnv = process.env) {
    ledger.writeSpec(root, record.id, { ...spec, ...patch });
    const child = spawn(process.execPath, ["src/runner.ts", "--project", root, "--task", record.id], {
      cwd: worktree, detached: true, env: runnerEnv, stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
    });
    return track(child);
  }
  function track(child: ChildProcess) {
    const tracked = {
      child, identity: child.pid ? proc(child.pid) : null, closed: false,
      code: null as number | null, signal: null as NodeJS.Signals | null, error: null as Error | null,
    };
    children.push(tracked);
    child.once("error", (error) => { tracked.error = error; });
    child.once("close", (code, signal) => { Object.assign(tracked, { closed: true, code, signal }); });
    return tracked;
  }
  return {
    root, record, spec, recordFile, auditFile, release, importReady, importRelease, planReady, planRelease, invocation, invocations,
    adapterModule, markers, start, track,
    onCleanup(cleanup: () => Promise<void>) {
      cleanups.add(cleanup);
      return () => { cleanups.delete(cleanup); };
    },
    engineLaunches: () => (fs.existsSync(invocations) ? fs.readFileSync(invocations, "utf8").trim().split("\n").filter(Boolean) : []),
    read: () => ledger.read(root, record.id),
    audit: () => fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { at: number; record: TaskRecord }) : [],
    descendant: () => poll(
      () => fs.existsSync(descendantFile) ? JSON.parse(fs.readFileSync(descendantFile, "utf8")) as Inspected & { sid: number } : null,
      (identity) => identity !== null,
    ).then((identity) => identity!),
    outcome: async (file = outcomeFile) => JSON.parse(await poll(
      () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""),
      (text) => text.length > 0,
    )) as UpdateResult | { error: string },
    competitor(name: string, patch: TaskPatch, at: number, expected?: TaskStatus, gate?: string) {
      const marker = path.join(root, `${name}.marker`);
      const outcome = path.join(root, `${name}.outcome.json`);
      const child = spawn(process.execPath, [
        competitorScript, root, record.id, JSON.stringify(patch), String(at), marker, outcome, expected ?? "", gate ?? "",
      ], { stdio: ["ignore", "ignore", fs.openSync(path.join(root, "competitor.err"), "a")] });
      return { tracked: track(child), marker, outcome };
    },
    runnerLog: () => fs.readFileSync(path.join(path.dirname(recordFile), `${record.id}.runner.log`), "utf8"),
    async cleanup() {
      const errors: unknown[] = [];
      try {
        // Unreadable probes need their own retirement path: an environ scan cannot find them.
        for (const cleanup of cleanups) {
          try { await cleanup(); } catch (error) { errors.push(error); }
        }
        const tracked = new Map<number, Inspected>();
        for (const entry of children) {
          if (entry.identity && !entry.closed) tracked.set(entry.identity.pid, entry.identity);
        }
        const signalErrors = new Set<string>();
        const deadline = Date.now() + pollDeadlineMs;
        while (true) {
          // The inherited marker also finds engines and descendants after their parent exits.
          for (const identity of ownedProcesses(root)) tracked.set(identity.pid, identity);
          const live = [...tracked.values()].filter(living);
          for (const identity of live) {
            try { process.kill(identity.pgid === identity.pid ? -identity.pgid : identity.pid, "SIGKILL"); }
            catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === "ESRCH") continue;
              const key = `${identity.pid}:${code}`;
              if (!signalErrors.has(key)) { signalErrors.add(key); errors.push(error); }
            }
          }
          if (live.length === 0 && children.every((entry) => entry.closed)) break;
          assert.ok(Date.now() < deadline, `cleanup left processes: ${live.map((identity) => identity.pid)}`);
          await delay(10);
        }
      } catch (error) {
        errors.push(error);
      } finally {
        for (const file of [adapterModule, engineModule, root]) {
          try { fs.rmSync(file, { recursive: true, force: true }); }
          catch (error) { errors.push(error); }
        }
      }
      if (errors.length) throw new AggregateError(errors, "runner cleanup failed");
    },
  };
}

// @anchor runnerCleanupAfterSignalError
test("runner cleanup continues after a signal error and removes every fixture", async (t) => {
  const h = harness();
  const first = h.track(spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { detached: true, stdio: "ignore" }));
  const second = h.track(spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { detached: true, stdio: "ignore" }));
  const denied = Object.assign(new Error("fixture signal denied"), { code: "EACCES" });
  const kill = process.kill.bind(process);
  let refuse = true;
  const mocked = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (refuse && pid === -first.child.pid!) { refuse = false; throw denied; }
    return kill(pid, signal);
  });
  try {
    await assert.rejects(h.cleanup(), (error: unknown) => error instanceof AggregateError && error.errors.includes(denied));
    assert.equal(first.closed, true);
    assert.equal(second.closed, true, "one denial did not prevent the other child being reaped");
    assert.equal(fs.existsSync(h.root), false);
    assert.equal(fs.existsSync(h.adapterModule), false);
    assert.equal(fs.existsSync(h.adapterModule.replace("runner-", "runner-engine-")), false);
  } finally {
    mocked.mock.restore();
    await h.cleanup();
  }
});

// @anchor launchSpecsRound
test("launch specs round-trip atomically and remain separate from task records", async (t) => {
  const h = harness();
  try {
    ledger.writeSpec(h.root, h.record.id, h.spec);
    const file = path.join(h.root, ".cross-agent", "tasks", `${h.record.id}.spec.json`);
    assert.deepEqual(ledger.readSpec(h.root, h.record.id), h.spec);
    const previous = fs.openSync(file, "r");
    const replacement = { ...h.spec, brief: "replacement", model: undefined, effort: undefined, resumeSessionId: undefined };
    try {
      ledger.writeSpec(h.root, h.record.id, replacement);
      assert.deepEqual(JSON.parse(fs.readFileSync(previous, "utf8")), h.spec, "old inode remains intact");
      assert.deepEqual(ledger.readSpec(h.root, h.record.id), JSON.parse(JSON.stringify(replacement)));
    } finally { fs.closeSync(previous); }
    assert.deepEqual(ledger.list(h.root), [h.record]);
    for (const id of ["", ".", "..", "../escape", "/absolute", "nested/id", "nested\\id", "id.spec", "bad id"]) {
      assert.throws(() => ledger.writeSpec(h.root, id, h.spec), /id/i);
      assert.throws(() => ledger.readSpec(h.root, id), /id/i);
    }
    assert.throws(() => ledger.writeSpec(h.root, h.record.id, { ...h.spec, adapterModule: "relative.mjs" }), /absolute/i);
    const before = fs.readdirSync(path.dirname(file));
    const failure = new Error("rename refused");
    const mock = t.mock.method(fs, "renameSync", () => { throw failure; });
    assert.throws(() => ledger.writeSpec(h.root, h.record.id, h.spec), (error) => error === failure);
    mock.mock.restore();
    assert.deepEqual(fs.readdirSync(path.dirname(file)), before);
    assert.deepEqual(ledger.readSpec(h.root, h.record.id), JSON.parse(JSON.stringify(replacement)));
  } finally { await h.cleanup(); }
});

test("the runner waits the configured lockWaitSeconds for its record writes", async () => {
  const h = harness();
  try {
    fs.writeFileSync(path.join(h.root, ".cross-agent", "config.json"),
      JSON.stringify({ roles: {}, limits: { lockWaitSeconds: 0 } }));
    // The record lock is held for as long as this test wants it. A runner that took the
    // helper's own five-second default would still be blocked here; one that reads the
    // project's limit refuses at once and says how long it waited.
    const lock = await acquire(lockPath(h.root, recordLockName(h.record.id)), { operation: "a competing writer", waitSeconds: 5 });
    try {
      h.start();
      const diagnostic = path.join(h.root, ".cross-agent", "tasks", `${h.record.id}.runner.log`);
      await poll(
        () => (fs.existsSync(diagnostic) ? fs.readFileSync(diagnostic, "utf8") : ""),
        (text) => /waited 0s/.test(text),
      );
      assert.equal(h.read().status, "launching", "and nothing was written past the lock");
    } finally {
      await lock.release();
    }
  } finally { await h.cleanup(); }
});

test("normal runner records both identities while running and finishes done with output", async () => {
  const h = harness();
  try {
    const child = h.start({ env: { ...h.spec.env, HOLD: "1" } });
    const running = await poll(h.read, (record) => record.status === "running");
    assert.equal(running.runnerIdentity?.pid, child.child.pid);
    assert.equal(running.runnerIdentity?.startTime, proc(child.child.pid!)?.startTime);
    assert.ok(running.engineIdentity);
    assert.equal(running.engineIdentity.pgid, running.engineIdentity.pid);
    assert.equal(living(running.engineIdentity), true);
    fs.writeFileSync(h.release, "go");
    const done = await poll(h.read, terminal);
    assert.equal(done.status, "done");
    assert.equal(done.exitCode, 0);
    assert.match(done.sessionId!, /^fake-\d+$/);
    assert.equal(fs.readFileSync(done.resultPath, "utf8"), "DONE finish T5");
    assert.ok(done.lastEventAt! >= running.updatedAt);
    assert.deepEqual(done.runnerIdentity, running.runnerIdentity);
    assert.deepEqual(done.engineIdentity, running.engineIdentity);
    const request = JSON.parse(fs.readFileSync(path.join(h.root, "request.json"), "utf8"));
    // Only the adapter module is the runner's own; the engine travels with the request.
    // Three fields come from the record instead of the spec: both paths and the task id.
    const { adapterModule, ...expected } = {
      ...h.spec, env: { ...h.spec.env, HOLD: "1", CROSS_AGENT_TASK: h.record.id },
    };
    assert.deepEqual(request, { ...expected, resultPath: done.resultPath, logPath: done.logPath });
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
  } finally { await h.cleanup(); }
});

test("the acknowledgement stamps acknowledgedAt once, and nothing later moves it", async () => {
  const h = harness();
  try {
    assert.equal(h.record.acknowledgedAt, undefined, "a launching record has not been answered yet");
    const child = h.start({ env: { ...h.spec.env, HOLD: "1", ACTIVITY: "1" } });
    const running = await poll(h.read, (record) => record.status === "running");
    assert.equal(typeof running.acknowledgedAt, "number");
    assert.ok(running.acknowledgedAt! >= running.createdAt);
    assert.ok(running.acknowledgedAt! <= Date.now());
    // The stall clock measures from this moment, so the activity writes that follow, and
    // the settlement itself, must leave it exactly where the acknowledgement put it.
    await poll(h.read, (record) => Boolean(record.lastEventAt && record.lastEventAt > running.acknowledgedAt!));
    fs.writeFileSync(h.release, "go");
    const done = await poll(h.read, terminal);
    assert.equal(done.status, "done");
    assert.equal(done.acknowledgedAt, running.acknowledgedAt);
    await poll(() => child.closed, Boolean);
  } finally { await h.cleanup(); }
});

test("process helpers reject stale identities and signal only the verified group", async (t) => {
  const helpers = await import("../src/process.ts");
  const h = harness();
  try {
    const descendantFile = path.join(h.root, "descendant.json");
    const child = h.track(spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(process.argv[1], JSON.stringify(child.pid));
      setInterval(() => {}, 1000);
    `, descendantFile], { detached: true, stdio: "ignore", env: { RUNNER_TEST_ROOT: h.root } }));
    await poll(() => fs.existsSync(descendantFile), Boolean);
    const descendant = proc(JSON.parse(fs.readFileSync(descendantFile, "utf8")))!;
    const identity = { ...helpers.identityOf(child.child.pid!)!, pgid: child.child.pid! };
    assert.equal(identity.startTime, proc(identity.pid)?.startTime);
    assert.equal(helpers.groupAlive(identity), true);
    // A stale or malformed identity names no group, so the ladder answers `dead` without
    // sending anything: a signal to it could reach whatever now holds that pid or group.
    const unsent = t.mock.method(process, "kill", () => { throw new Error("signalled an unverified identity"); });
    for (const invalid of [
      { ...identity, startTime: "0" }, { ...identity, pid: 0 }, { ...identity, pid: -1 },
      { ...identity, pgid: process.pid }, { ...identity, pgid: 0 }, { ...identity, pgid: 1 },
      { ...identity, pid: 1.5 }, { ...identity, startTime: "bad" },
    ]) {
      assert.equal(helpers.groupAlive(invalid), false);
      assert.equal(await helpers.terminateGroup(invalid, { termGrace: 0, killGrace: 0 }), "dead");
    }
    assert.equal(unsent.mock.callCount(), 0);
    unsent.mock.restore();
    assert.equal(living(identity), true);
    assert.equal(helpers.identityOf(-1), null);
    assert.equal(helpers.identityOf(2_147_483_647), null);
    // Verify the group while the leader exists, then reap only the leader.
    child.child.kill("SIGKILL");
    await poll(() => child.closed, Boolean);
    assert.equal(living(descendant), true);
    assert.equal(helpers.groupAlive(identity), true, "surviving verified descendants keep the group alive");
    // The descendant ignores SIGTERM, so it is the ladder's SIGKILL that ends the group.
    assert.equal(await helpers.terminateGroup(identity, { termGrace: 0, killGrace: 2000 }), "dead");
    assert.equal(living(descendant), false);
    assert.equal(helpers.groupAlive(identity), false);
    const after = t.mock.method(process, "kill", () => { throw new Error("signalled a dead group"); });
    assert.equal(await helpers.terminateGroup(identity, { termGrace: 0, killGrace: 0 }), "dead");
    assert.equal(after.mock.callCount(), 0);
    after.mock.restore();
    await t.test("a non-leader identity is never signalled, and proc errors propagate", async () => {
      // This process is not a group leader, so its own identity names no group and must
      // reach no signal at all. (An ESRCH between the scan and the signal of a real
      // group is the next test's; mocking it here would test nothing, because the
      // identity is refused before any kill.)
      const current = { ...proc(process.pid)!, bootId: ledger.currentBootId };
      assert.notEqual(current.pgid, current.pid);
      const mocked = t.mock.method(process, "kill", () => { throw new Error("signalled a non-leader identity"); });
      assert.equal(await helpers.terminateGroup(current, { termGrace: 0, killGrace: 0 }), "dead");
      assert.equal(mocked.mock.callCount(), 0);
      mocked.mock.restore();
      const denied = Object.assign(new Error("denied"), { code: "EACCES" });
      const deniedMock = t.mock.method(fs, "readFileSync", () => { throw denied; });
      assert.throws(() => helpers.identityOf(process.pid), (error) => error === denied);
      deniedMock.mock.restore();
    });
  } finally { await h.cleanup(); }
});

test("group helpers find descendants of a reaped leader without a prior scan", async (t) => {
  const helpers = await import("../src/process.ts");
  const h = harness();
  try {
    const descendantFile = path.join(h.root, "descendant.json");
    const leader = h.track(spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(process.argv[1], JSON.stringify(child.pid));
      setInterval(() => {}, 1000);
    `, descendantFile], { detached: true, stdio: "ignore", env: { RUNNER_TEST_ROOT: h.root } }));
    await poll(() => fs.existsSync(descendantFile), Boolean);
    const descendant = proc(JSON.parse(fs.readFileSync(descendantFile, "utf8")))!;
    const identity = { ...helpers.identityOf(leader.child.pid!)!, pgid: leader.child.pid! };
    assert.equal(descendant.pgid, identity.pid);
    // Reap the leader before any helper has looked at this group.
    leader.child.kill("SIGKILL");
    await poll(() => leader.closed, Boolean);
    assert.equal(proc(identity.pid), null);
    assert.equal(living(descendant), true);
    assert.equal(helpers.groupAlive(identity), true, "the kernel scan finds the member by process group and session");
    // A group gone between the scan and the signal is not an error: the signal's ESRCH is
    // the group having died first. The stand-in ends the group for real and then answers
    // the way the kernel answers for a group that has already gone, and both ladders —
    // by identity and by the pid a detached spawn made its group — take that as the end.
    const kill = process.kill.bind(process);
    const vanishing = (pid: number) => {
      kill(pid, "SIGKILL");
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    };
    const first = t.mock.method(process, "kill", vanishing);
    assert.equal(await helpers.terminateGroupByPid(identity.pid, { termGrace: 0, killGrace: 2000 }), true);
    assert.ok(first.mock.callCount() >= 1, "the ladder signalled the group it found");
    first.mock.restore();
    await poll(() => living(descendant), (alive) => !alive);
    assert.equal(helpers.groupAlive(identity), false);
    const unsent = t.mock.method(process, "kill", () => { throw new Error("signalled a dead group"); });
    assert.equal(await helpers.terminateGroup(identity, { termGrace: 0, killGrace: 0 }), "dead");
    assert.equal(await helpers.terminateGroupByPid(identity.pid, { termGrace: 0, killGrace: 0 }), true);
    assert.equal(unsent.mock.callCount(), 0);
    unsent.mock.restore();
  } finally { await h.cleanup(); }
});

test("fail script finishes failed with exit code 2", async () => {
  const h = harness();
  try {
    h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "fail" } });
    const failed = await poll(h.read, terminal);
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 2);
    assert.match(failed.sessionId!, /^fake-/);
    assert.ok(failed.lastEventAt);
    assert.equal(failed.resultPath, h.record.resultPath);
    assert.equal(failed.logPath, h.record.logPath);
  } finally { await h.cleanup(); }
});

test("runner accepts a valid task ID beginning with a hyphen", async () => {
  const h = harness({ leadingHyphen: true });
  try {
    const child = h.start();
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.equal(h.read().status, "done");
  } finally { await h.cleanup(); }
});

// @anchor symlinkedRunner
test("a runner started through a linked checkout runs its task, rather than exiting 0 unheard", async (t) => {
  // Node runs a main module at its real path, so an entry check that compared the path it
  // was started by with its own URL did nothing through a link; the runner's compares real
  // paths, as the server's and the CLI's do (`src/project.ts#isMainModule`).
  const h = harness();
  const links = fs.mkdtempSync(path.join(tmpdir(), "runner-link-"));
  t.after(() => fs.rmSync(links, { recursive: true, force: true }));
  fs.symlinkSync(worktree, path.join(links, "checkout"));
  try {
    ledger.writeSpec(h.root, h.record.id, h.spec);
    const child = h.track(spawn(process.execPath, [path.join(links, "checkout", "src", "runner.ts"), "--project", h.root, "--task", h.record.id], {
      cwd: worktree, detached: true, env: process.env, stdio: "ignore",
    }));
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.equal(h.read().status, "done");
  } finally { await h.cleanup(); }
});

test("zero exit without a result fails", async () => {
  const h = harness();
  try {
    h.start({ env: { ...h.spec.env, NO_RESULT: "1" } });
    const failed = await poll(h.read, terminal);
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 0);
    assert.equal(fs.readFileSync(failed.resultPath, "utf8"), "");
    assert.match(failed.reason!, /result/i);
  } finally { await h.cleanup(); }
});

test("sandbox refusal records its reason", async () => {
  const h = harness({ refusal: true });
  try {
    h.start();
    const failed = await poll(h.read, terminal);
    assert.equal(failed.status, "failed");
    assert.match(failed.reason!, /sandbox.*fixture sandbox missing/);
    assert.equal(failed.exitCode, null);
    assert.equal(failed.sessionId, null);
    assert.equal(failed.lastEventAt, null);
    assert.equal(failed.resultPath, h.record.resultPath);
    assert.equal(failed.logPath, h.record.logPath);
    assert.equal(fs.existsSync(h.invocation), false);
  } finally { await h.cleanup(); }
});

test("adapter default and named exports are supported", async (t) => {
  for (const named of [false, true]) await t.test(named ? "named" : "default", async () => {
    const h = harness({ named });
    try {
      h.start();
      assert.equal((await poll(h.read, terminal)).status, "done");
      const writes = h.audit();
      assert.equal(writes[0].record.status, "running");
      assert.ok(writes[0].record.runnerIdentity && writes[0].record.engineIdentity);
      assert.equal(writes.filter(({ record }) => terminal(record)).length, 1);
    } finally { await h.cleanup(); }
  });
});

test("activity persistence is throttled to once per two seconds", async () => {
  const h = harness();
  try {
    h.start({ env: { ...h.spec.env, HOLD: "1", ACTIVITY: "1" } });
    await poll(h.read, (record) => record.status === "running");
    await poll(h.audit, (writes) => writes.filter(({ record }) => record.lastEventAt != null).length >= 2);
    const writes = h.audit().filter(({ record }) => record.status === "running");
    assert.equal(writes.length, 3, "running acknowledgement plus two activity writes");
    for (let i = 1; i < writes.length; i++) {
      // Measured by what the interval stamped on each record, not by when the rename
      // that published it landed: the lock and the rename take as long as the machine
      // takes, and the throttle is the interval, which is what `updatedAt` records.
      assert.ok(writes[i].record.updatedAt - writes[i - 1].record.updatedAt >= 1990,
        `no burst of persistence writes: ${writes[i].record.updatedAt - writes[i - 1].record.updatedAt}ms apart`);
      assert.ok(writes[i].record.lastEventAt! > (writes[i - 1].record.lastEventAt ?? 0));
    }
    fs.writeFileSync(h.release, "go");
    const done = await poll(h.read, terminal);
    assert.equal(done.status, "done");
    assert.ok(done.lastEventAt! >= writes.at(-1)!.record.lastEventAt!);
  } finally { await h.cleanup(); }
});

/** The outcome file a runner records beside the task, if it wrote one. */
function outcomeOf(h: ReturnType<typeof harness>): Record<string, unknown> | null {
  const file = path.join(h.root, ".cross-agent", "tasks", `${h.record.id}.outcome.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

test("the runner records the engine's verdict beside the task before it settles", async () => {
  for (const [script, kind] of [["ok", "done"], ["fail", "failed"]] as const) {
    const h = harness();
    try {
      h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: script } });
      const settled = await poll(h.read, terminal);
      const recorded = outcomeOf(h)!;
      // The same verdict the ledger write carries, written first and by itself, because
      // the ledger write may be refused by a record this runner no longer owns.
      assert.equal(recorded.kind, kind);
      assert.equal(recorded.exitCode, settled.exitCode);
      assert.equal(recorded.sessionId, settled.sessionId);
      assert.equal(recorded.reason, settled.reason);
      assert.ok(typeof recorded.at === "number" && recorded.at >= h.record.createdAt);
    } finally { await h.cleanup(); }
  }
});

test("an engine that failed while its record was adopted settles failed, with its own reason", async () => {
  const { terminateOrphans } = await import("../src/process.ts");
  const h = harness();
  try {
    // The adoption race: reconciliation orphans the record while the engine is still
    // running, so the runner's terminal write is refused and it settles nothing. The
    // result file holds the failure's text by then, and reading that as a completed run
    // settled a failed task `done` (finding T3b-1).
    const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "fail", HOLD: "1" } });
    const running = await poll(h.read, (record) => record.status === "running");
    await applied(ledger.update(h.root, h.record.id, { status: "orphaned" }));
    fs.writeFileSync(h.release, "go");
    await poll(() => outcomeOf(h), (recorded) => recorded !== null);
    await poll(() => living(running.engineIdentity!), (alive) => !alive);

    const { changed } = await terminateOrphans(h.root);
    assert.deepEqual(changed.map((record) => [record.status, record.reason]), [["failed", "fake failure"]]);
    assert.equal(h.read().exitCode, 2, "the exit code the runner saw, which the record never got");
    // The diagnostic is the runner's last act before it exits, so its exit is what says
    // the line is there; a settled record only says the write before it landed.
    await poll(() => child.closed, Boolean);
    assert.match(h.runnerLog(), /someone else settled the task/);
  } finally { await h.cleanup(); }
});

test("an engine that finished while its record was adopted settles done, with its exit code", async () => {
  const { terminateOrphans } = await import("../src/process.ts");
  const h = harness();
  try {
    h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "ok", HOLD: "1" } });
    const running = await poll(h.read, (record) => record.status === "running");
    await applied(ledger.update(h.root, h.record.id, { status: "orphaned" }));
    fs.writeFileSync(h.release, "go");
    await poll(() => outcomeOf(h), (recorded) => recorded !== null);
    await poll(() => living(running.engineIdentity!), (alive) => !alive);

    const { changed } = await terminateOrphans(h.root);
    assert.deepEqual(changed.map((record) => [record.status, record.exitCode]), [["done", 0]]);
    assert.match(h.read().sessionId!, /^fake-\d+$/, "and the session the engine announced");
  } finally { await h.cleanup(); }
});

async function orphan(h: ReturnType<typeof harness>, script: string, env: Record<string, string> = {}) {
  const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: script, ...env } });
  const running = await poll(h.read, (record) => record.status === "running");
  await poll(() => fs.readFileSync(running.logPath, "utf8"), (log) => log.includes('"working"'));
  child.child.kill("SIGKILL");
  await poll(() => child.closed, Boolean);
  assert.equal(living(running.engineIdentity!), true);
  assert.equal((await reconcile(h.root)).changed[0]?.status, "orphaned");
  return running.engineIdentity!;
}

test("SIGKILL leaves a live engine that reconciliation orphans and cleanup terminates", async () => {
  const { terminateOrphans } = await import("../src/process.ts");
  const h = harness();
  try {
    const identity = await orphan(h, "stall");
    const { changed } = await terminateOrphans(h.root);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].status, "failed");
    assert.equal(changed[0].reason, "runner lost; engine group terminated");
    await poll(() => proc(identity.pid), (current) => current === null);
  } finally { await h.cleanup(); }
});

// @anchor descendantHoldingEngine
test("a descendant holding the engine's stdout delays settlement by the drain and marks it truncated", async () => {
  const h = harness();
  try {
    const started = Date.now();
    const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "fail", DESCENDANT_INHERIT: "1" } });
    const failed = await poll(h.read, terminal);
    assert.ok(Date.now() - started >= 2000, "the engine's own exit starts a two-second drain, not an unbounded wait");
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 2);
    assert.match(failed.reason!, /fake failure; output truncated/,
      "an operator reading the failure is told the evidence may be incomplete");
    assert.equal(failed.truncated, true, "and the record carries it as a field, not only as prose");
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    // Group cleanup still precedes the terminal write, so the descendant that held the
    // pipe open is dead by the time the record settles.
    assert.deepEqual(ownedProcesses(h.root), []);
  } finally { await h.cleanup(); }
});

test("a task that succeeds with truncated output is done, and says so", async () => {
  const h = harness();
  try {
    const child = h.start({ env: { ...h.spec.env, DESCENDANT_INHERIT: "1" } });
    const done = await poll(h.read, terminal);
    assert.equal(done.status, "done", "a drained tail is not a failure: the engine finished");
    assert.equal(done.truncated, true);
    assert.equal(done.exitCode, 0);
    assert.equal(done.reason, undefined, "nothing failed, so nothing is explained away");
    assert.equal(fs.readFileSync(done.resultPath, "utf8"), "DONE finish T5");
    await poll(() => child.closed, Boolean);
    assert.deepEqual(ownedProcesses(h.root), []);
  } finally { await h.cleanup(); }
});

// @anchor completionKillsDescendants
test("completion kills descendants the engine left behind in its group", async () => {
  const h = harness();
  try {
    const child = h.start({ env: { ...h.spec.env, HOLD: "1", DESCENDANT: "1" } });
    const running = await poll(h.read, (record) => record.status === "running");
    const descendant = await h.descendant();
    assert.equal(descendant.pgid, running.engineIdentity!.pid);
    assert.equal(descendant.sid, running.engineIdentity!.pid);
    assert.equal(living(descendant), true);
    fs.writeFileSync(h.release, "go");
    const done = await poll(h.read, terminal);
    assert.equal(done.status, "done");
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.equal(living(descendant), false, "the leader exited on its own; the member it left died with the settlement");
    assert.deepEqual(ownedProcesses(h.root), []);
  } finally { await h.cleanup(); }
});

test("orphan cleanup terminates descendants whose leader died before cleanup began", async () => {
  const { terminateOrphans } = await import("../src/process.ts");
  const h = harness();
  try {
    const identity = await orphan(h, "stall", { DESCENDANT: "1" });
    const descendant = await h.descendant();
    assert.equal(living(descendant), true);
    // The leader exits on SIGTERM; the member keeps its process group and session.
    process.kill(identity.pid, "SIGTERM");
    await poll(() => proc(identity.pid), (current) => current === null || current.state === "Z");
    assert.equal(living(descendant), true);
    const { changed } = await terminateOrphans(h.root);
    assert.deepEqual(changed.map((record) => [record.id, record.status, record.reason]), [[h.record.id, "failed", "runner lost; engine group terminated"]]);
    assert.equal(living(descendant), false);
    assert.equal(h.read().status, "failed");
    assert.deepEqual(await terminateOrphans(h.root), { changed: [], skipped: [] });
  } finally { await h.cleanup(); }
});

test("reconciliation orphans a task whose engine leader is gone but whose group lives", async () => {
  const { terminateOrphans } = await import("../src/process.ts");
  const h = harness();
  try {
    const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall", DESCENDANT: "1" } });
    const running = await poll(h.read, (record) => record.status === "running");
    const descendant = await h.descendant();
    await poll(() => fs.readFileSync(running.logPath, "utf8"), (log) => log.includes('"working"'));
    child.child.kill("SIGKILL");
    await poll(() => child.closed, Boolean);
    // The leader exits before anything has looked at this group, so the record's engine
    // identity names a pid that no longer exists. Judging it by that pid alone would
    // settle the task and leave the member it spawned running for ever.
    process.kill(running.engineIdentity!.pid, "SIGTERM");
    await poll(() => proc(running.engineIdentity!.pid), (current) => current === null || current.state === "Z");
    assert.equal(living(descendant), true);

    const { changed } = await reconcile(h.root);
    assert.deepEqual(changed.map((record) => [record.id, record.status]), [[h.record.id, "orphaned"]]);
    const { changed: cleaned } = await terminateOrphans(h.root);
    assert.deepEqual(cleaned.map((record) => [record.id, record.status, record.reason]), [[h.record.id, "failed", "runner lost; engine group terminated"]]);
    assert.equal(living(descendant), false);
    assert.deepEqual(ownedProcesses(h.root), []);
  } finally { await h.cleanup(); }
});

test("a runner killed before it acknowledges leaves an engine reconciliation adopts by task id", async (t) => {
  const { findByEnvironment, terminateOrphans } = await import("../src/process.ts");
  const h = harness();
  try {
    // Holding the record lock stops this runner exactly where B5-i names it: the engine
    // is spawned and running, and nothing has been written about it.
    const held = await acquire(lockPath(h.root, recordLockName(h.record.id)), { operation: "test writer", waitSeconds: 5 });
    // Given up however the barriers below end: a lock a failed wait left held would
    // keep the runner waiting on it for the rest of this test.
    t.after(() => held.release());
    const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall", CROSS_AGENT_TASK: h.record.id } });
    const [engine] = await poll(() => findByEnvironment(h.record.id, h.record.createdAt).found,
      (found) => found.length === 1);
    // The engine's first output must reach the runner's log before the runner dies: an
    // engine still flushing into a pipe whose reader has gone takes SIGPIPE with it, and
    // this test is about the engine that survives.
    await poll(() => (fs.existsSync(h.record.logPath) ? fs.readFileSync(h.record.logPath, "utf8") : ""),
      (log) => log.includes('"working"'));
    child.child.kill("SIGKILL");
    await poll(() => child.closed, Boolean);
    await held.release();
    const launching = h.read();
    assert.equal(launching.status, "launching");
    assert.equal(launching.runnerIdentity ?? null, null, "no identity was ever written");
    assert.equal(launching.engineIdentity ?? null, null);
    assert.equal(engine.leader, true);
    assert.equal(living(engine), true, "the engine outlived the runner that spawned it");

    const { changed } = await reconcile(h.root, launching.launchDeadline + 1);
    assert.deepEqual(changed.map((record) => [record.id, record.status]), [[h.record.id, "orphaned"]]);
    assert.deepEqual(h.read().engineIdentity,
      { pid: engine.pid, startTime: engine.startTime, pgid: engine.pid, bootId: ledger.currentBootId });
    const { changed: cleaned } = await terminateOrphans(h.root);
    assert.deepEqual(cleaned.map((record) => [record.status, record.reason]), [["failed", "runner lost; engine group terminated"]]);
    await poll(() => proc(engine.pid), (current) => current === null || current.state === "Z");
    assert.deepEqual(ownedProcesses(h.root), []);
  } finally { await h.cleanup(); }
});

test("a replacement runner refuses to start a second engine for one task", async (t) => {
  const { findByEnvironment } = await import("../src/process.ts");
  const h = harness();
  try {
    const env = { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall", CROSS_AGENT_TASK: h.record.id, INVOCATIONS: h.invocations };
    // Runner A dies after spawning and before acknowledging, so the kernel frees its
    // lock and the record is still `launching`: exactly the state in which a second
    // runner would take the lock, believe nothing had started, and spawn engine B.
    const held = await acquire(lockPath(h.root, recordLockName(h.record.id)), { operation: "test writer", waitSeconds: 5 });
    // Given up however the barriers below end: a lock a failed wait left held would
    // keep the runner waiting on it for the rest of this test.
    t.after(() => held.release());
    const first = h.start({ env });
    await poll(() => h.engineLaunches(), (launches) => launches.length === 1);
    await poll(() => (fs.existsSync(h.record.logPath) ? fs.readFileSync(h.record.logPath, "utf8") : ""),
      (log) => log.includes('"working"'));
    first.child.kill("SIGKILL");
    await poll(() => first.closed, Boolean);
    await held.release();
    assert.equal(h.read().status, "launching");
    const engine = findByEnvironment(h.record.id, h.record.createdAt).found;
    assert.equal(engine.length, 1);

    const second = h.start({ env });
    await poll(() => second.closed, Boolean);
    assert.equal(second.code, 1, "the replacement exits rather than owning a second engine");
    assert.deepEqual(h.engineLaunches().length, 1, "it spawned nothing");
    assert.equal(h.read().status, "launching", "and left the record for reconciliation to adopt");
    assert.match(h.runnerLog(), new RegExp(`not launching task ${h.record.id}: engine ${engine[0].pid} already carries task`));
    assert.equal(living(engine[0]), true);
  } finally { await h.cleanup(); }
});

test("a runner carrying its own task id in its environment launches all the same", async () => {
  const h = harness();
  try {
    // The server starts a runner with the environment `guard.childEnv` built, so the
    // runner's own environment carries `CROSS_AGENT_TASK=<id>`, and the `flock` child
    // holding `runner-<id>.lock` inherits it and stays in the runner's session. A stand-down
    // that counted those two would refuse every launch for an engine that is the runner.
    const child = h.start({ env: { ...h.spec.env, HOLD: "1", INVOCATIONS: h.invocations } }, false,
      { ...process.env, CROSS_AGENT_TASK: h.record.id });
    const running = await poll(h.read, (record) => record.status === "running");
    assert.ok(running.engineIdentity, "it spawned an engine and acknowledged it");
    assert.doesNotMatch(h.runnerLog(), /not launching/);
    fs.writeFileSync(h.release, "go");
    const done = await poll(h.read, terminal);
    assert.equal(done.status, "done");
    assert.equal(h.engineLaunches().length, 1, "one engine, and its own runner did not count itself twice");
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.deepEqual(ownedProcesses(h.root), []);
  } finally { await h.cleanup(); }
});

test("the runner puts the record's own id in the engine's environment", async () => {
  const { findByEnvironment } = await import("../src/process.ts");
  const h = harness();
  try {
    // Everything B5 rests on is this assignment: a stranded engine is found by it, and a
    // replacement runner stands down on it. The spec need not carry it — the record, not
    // the spec, names what this runner spawns — so the runner sets it from the record id.
    assert.equal(h.spec.env.CROSS_AGENT_TASK, undefined);
    const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall" } });
    const running = await poll(h.read, (record) => record.status === "running");
    const found = await poll(() => findByEnvironment(h.record.id, h.record.createdAt).found,
      (entries) => entries.length === 1);
    assert.equal(found[0].self, false, "a session of its own, not this test's");
    assert.equal(found[0].leader, true, "and the shape an engineIdentity can be recorded from");
    assert.equal(found[0].pid, running.engineIdentity!.pid);

    child.child.kill("SIGTERM");
    const cancelled = await poll(h.read, terminal);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(living(running.engineIdentity!), false);
  } finally { await h.cleanup(); }
});

test("a runner that cannot capture its engine's identity still ends the group it spawned", async () => {
  const h = harness({ failure: "identity-late" });
  try {
    // The engine leads a group, leaves a descendant holding its pipe, and exits; the
    // identity read fails, so the record can name no group. The pid the detached spawn
    // made the group and session id is all the runner has, and it is enough.
    const child = h.start({ env: { ...h.spec.env, DESCENDANT_INHERIT: "1" } });
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    const failed = h.read();
    assert.equal(failed.status, "failed");
    assert.match(failed.reason!, /identit/);
    assert.deepEqual(ownedProcesses(h.root), [], "no member of the group it spawned is left running");
  } finally { await h.cleanup(); }
});

test("orphan cleanup settles a group with no live member", async () => {
  const { terminateOrphans } = await import("../src/process.ts");
  const h = harness();
  try {
    const identity = await orphan(h, "stall");
    process.kill(identity.pid, "SIGKILL");
    await poll(() => proc(identity.pid), (current) => current === null || current.state === "Z");
    const before = Date.now();
    const { changed } = await terminateOrphans(h.root);
    assert.ok(Date.now() - before < 1500, "nothing to signal means nothing to wait for");
    assert.deepEqual(changed.map((record) => [record.id, record.status, record.reason]), [[h.record.id, "failed", "runner lost"]]);
    assert.equal(h.read().status, "failed");
    assert.equal(h.read().reason, "runner lost");
    assert.deepEqual(await terminateOrphans(h.root), { changed: [], skipped: [] });
  } finally { await h.cleanup(); }
});

test("group members of a live leader die with it on cancel and on orphan cleanup", async (t) => {
  const { terminateOrphans } = await import("../src/process.ts");
  await t.test("cancel", async () => {
    const h = harness();
    try {
      const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall", DESCENDANT: "1" } });
      const running = await poll(h.read, (record) => record.status === "running");
      const descendant = await h.descendant();
      await poll(() => fs.readFileSync(running.logPath, "utf8"), (log) => log.includes('"working"'));
      child.child.kill("SIGTERM");
      const cancelled = await poll(h.read, terminal);
      assert.equal(cancelled.status, "cancelled");
      await poll(() => child.closed, Boolean);
      assert.equal(child.code, 0);
      assert.equal(living(running.engineIdentity!), false);
      assert.equal(living(descendant), false);
    } finally { await h.cleanup(); }
  });
  await t.test("orphan cleanup", async () => {
    const h = harness();
    try {
      const identity = await orphan(h, "stall", { DESCENDANT: "1" });
      const descendant = await h.descendant();
      assert.equal(living(descendant), true);
      const { changed } = await terminateOrphans(h.root);
      assert.deepEqual(changed.map((record) => record.status), ["failed"]);
      assert.equal(living(identity), false);
      assert.equal(living(descendant), false);
    } finally { await h.cleanup(); }
  });
});

test("orphan cleanup escalates after two seconds and returns only changed records", async () => {
  const { terminateOrphans } = await import("../src/process.ts");
  const h = harness();
  let cleanup: Promise<TaskRecord[]> | undefined;
  try {
    const identity = await orphan(h, "stall-ignore-term");
    const stale = ledger.create(h.root, h.spec);
    await writeAs(h.root, stale.id, "orphaned", { engineIdentity: { ...identity, startTime: "0" } });
    const settled = ledger.create(h.root, h.spec);
    await writeAs(h.root, settled.id, "cancelled", { engineIdentity: identity });
    const before = Date.now();
    let skipped: { id: string; reason: string }[] = [];
    cleanup = terminateOrphans(h.root).then((result) => { skipped = result.skipped; return result.changed; });
    await delay(150);
    assert.equal(living(identity), true);
    await delay(1650);
    assert.equal(living(identity), true, "engine survives almost all of the two-second grace period");
    assert.equal(h.read().status, "orphaned");
    const changed = await cleanup;
    assert.ok(Date.now() - before >= 2000);
    assert.deepEqual(changed.map((record) => record.id), [h.record.id]);
    assert.deepEqual(skipped, [{ id: stale.id, reason: "engine identity reused" }],
      "an identity cleanup will not act on is named, not passed over in silence");
    assert.equal(changed[0].status, "failed");
    assert.equal(changed[0].reason, "runner lost; engine group terminated");
    await poll(() => proc(identity.pid), (current) => current === null);
    // ledger.list returns newest first, so the stale record was inspected before the
    // engine died, while its mismatched leader still lived: skipped, not settled.
    assert.equal(ledger.read(h.root, stale.id).status, "orphaned");
    assert.equal(ledger.read(h.root, settled.id).status, "cancelled");
    // Now nothing holds that pid as process group or session: the group is dead, so
    // the stale record settles, and a further pass finds nothing left to change.
    const second = (await terminateOrphans(h.root)).changed;
    assert.deepEqual(second.map((record) => [record.id, record.status, record.reason]), [[stale.id, "failed", "runner lost"]]);
    assert.deepEqual(await terminateOrphans(h.root), { changed: [], skipped: [] });
  } finally { await h.cleanup(); await cleanup; }
});

test("SIGTERM cancels and leaves a dead engine group within six seconds", async (t) => {
  const { groupAlive } = await import("../src/process.ts");
  for (const script of ["stall", "stall-ignore-term"]) await t.test(script, async () => {
    const h = harness();
    try {
      const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: script } });
      const running = await poll(h.read, (record) => record.status === "running");
      await poll(() => fs.readFileSync(running.logPath, "utf8"), (log) => log.includes('"working"'));
      const before = Date.now();
      child.child.kill("SIGTERM");
      if (script === "stall-ignore-term") {
        await poll(h.read, (record) => record.status === "cancelling");
        child.child.kill("SIGTERM");
        await delay(4700);
        assert.equal(living(running.engineIdentity!), true, "engine survives the five-second grace period");
        assert.equal(h.read().status, "cancelling");
      }
      const cancelled = await poll(h.read, terminal, Math.max(100, 5900 - (Date.now() - before)));
      assert.equal(cancelled.status, "cancelled");
      assert.equal(groupAlive(running.engineIdentity!), false);
      assert.ok(Date.now() - before < 6000);
      assert.equal(cancelled.exitCode, script === "stall" ? 143 : null);
      assert.match(cancelled.sessionId!, /^fake-/);
      assert.ok(cancelled.lastEventAt);
      assert.equal(h.audit().filter(({ record }) => terminal(record)).length, 1);
      await poll(() => child.closed, Boolean);
      assert.equal(child.code, 0);
    } finally { await h.cleanup(); }
  });
});

test("SIGTERM racing normal exit produces exactly one terminal write", async () => {
  for (let i = 0; i < 5; i++) {
    const h = harness();
    try {
      const child = h.start({ env: { ...h.spec.env, HOLD: "1", RACE_EXIT: "1" } });
      await poll(h.read, (record) => record.status === "running");
      fs.writeFileSync(h.release, "exit and signal runner");
      await poll(() => child.closed, Boolean);
      assert.equal(child.code, 0);
      const writes = h.audit().filter(({ record }) => terminal(record));
      assert.equal(writes.length, 1, "fixture-side rename audit detects even brief overwrites");
      assert.ok(["done", "cancelled"].includes(writes[0].record.status));
      assert.deepEqual(h.read(), writes[0].record);
    } finally { await h.cleanup(); }
  }
});

test("a competitor that starts inside the runner's terminal write is refused", async () => {
  const h = harness({ competitor: "at-write" });
  try {
    const child = h.start();
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    // The competitor started while the runner held the record lock, so its own read
    // could only happen after the runner released it, and by then the record was terminal.
    const outcome = await h.outcome();
    assert.ok(fs.existsSync(h.markers.atWrite), "the competitor started at the runner's terminal rename");
    const writes = h.audit().filter(({ record }) => terminal(record));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].record.status, "done");
    assert.deepEqual(h.read(), writes[0].record, "the record is the runner's write; the competitor changed nothing");
    assert.deepEqual(outcome, { applied: false, reason: "terminal", record: writes[0].record },
      "the refusal carries the record the competitor found");
  } finally { await h.cleanup(); }
});

test("the runner never renames over a record that was terminal at its read", async () => {
  const h = harness({ competitor: "before-write" });
  try {
    const child = h.start();
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.ok(fs.existsSync(h.markers.beforeWrite), "the competitor settled before the runner's terminal write");
    assert.match(fs.readFileSync(h.markers.beforeWrite, "utf8"), /^\d+$/, "the competitor itself wrote the marker when it called update");
    const outcome = await h.outcome();
    const final = h.read();
    assert.deepEqual(outcome, { applied: true, record: final });
    assert.equal(final.status, "done");
    assert.equal(final.reason, "external settlement");
    assert.equal(final.updatedAt, 123);
    assert.equal(h.audit().filter(({ record }) => terminal(record)).length, 0, "the runner made no terminal rename");
    assert.equal(living(final.engineIdentity!), false);
    assert.match(h.runnerLog(), /someone else settled/);
  } finally { await h.cleanup(); }
});

test("an activity write after an external settlement is refused and the runner exits 0", async () => {
  const h = harness();
  try {
    const activityRelease = path.join(h.root, "activity-release");
    const child = h.start({ env: { ...h.spec.env, HOLD: "1", ACTIVITY_AFTER: activityRelease } });
    const running = await poll(h.read, (record) => record.status === "running");
    assert.equal(running.lastEventAt, null);
    const external = await writeAs(h.root, h.record.id, "failed", { reason: "external settlement" });
    fs.writeFileSync(activityRelease, "emit the first activity event now");
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.deepEqual(h.read(), external);
    assert.match(fs.readFileSync(running.logPath, "utf8"), /fixture ready/, "the engine did emit the event");
    const writes = h.audit();
    assert.equal(writes.length, 1, "the running acknowledgement is the only rename; the activity write was refused");
    assert.equal(writes[0].record.status, "running");
    // Compared by what each writer stamped on the record, not by the audit's own clock:
    // the audit line is appended after the rename, and on a loaded machine the runner can
    // be descheduled between the two for longer than it took this test to see the record
    // and settle it. What the acknowledgement being first means is that it was decided
    // first, and `updatedAt` is that decision.
    assert.ok(writes[0].record.updatedAt <= external.updatedAt,
      `acknowledged at ${writes[0].record.updatedAt}, settled at ${external.updatedAt}`);
    assert.equal(living(running.engineIdentity!), false);
    assert.deepEqual(ownedProcesses(h.root), []);
    assert.match(h.runnerLog(), /someone else settled/);
  } finally { await h.cleanup(); }
});

test("already terminal records remain unchanged and runner exits zero", async (t) => {
  for (const race of ["startup", "delayed import", "settlement", "same-status"]) await t.test(race, async () => {
    const h = harness({ delayedImport: race === "delayed import", race });
    try {
      let expected: TaskRecord | undefined;
      if (race === "startup") expected = await writeAs(h.root, h.record.id, "done", { reason: "external settlement" });
      const child = h.start();
      if (race === "delayed import") {
        await poll(() => fs.existsSync(h.importReady), Boolean);
        expected = await writeAs(h.root, h.record.id, "cancelled", { reason: "external settlement" });
        fs.writeFileSync(h.importRelease, "go");
      }
      await poll(() => child.closed, Boolean);
      assert.equal(child.code, 0);
      const final = h.read();
      assert.equal(final.reason, "external settlement");
      if (expected) assert.deepEqual(final, expected);
      else {
        assert.equal(final.updatedAt, 123);
        assert.equal(h.audit().filter(({ record }) => terminal(record)).length, 1);
      }
      if (final.engineIdentity) assert.equal(living(final.engineIdentity), false);
      else assert.equal(fs.existsSync(h.invocation), false);
      assert.deepEqual(ownedProcesses(h.root), []);
    } finally { await h.cleanup(); }
  });
});

test("cancellation during adapter import settles without launching an engine", async () => {
  const h = harness({ delayedImport: true });
  try {
    const child = h.start();
    await poll(() => fs.existsSync(h.importReady), Boolean);
    child.child.kill("SIGTERM");
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.equal(h.read().status, "cancelled");
    assert.equal(h.read().exitCode, null);
    assert.equal(h.read().sessionId, null);
    assert.equal(h.read().lastEventAt, null);
    assert.equal(fs.existsSync(h.invocation), false);
  } finally { await h.cleanup(); }
});

test("engine-written result text is result evidence without a parsed result event", async () => {
  const h = harness();
  try {
    h.start({ env: { ...h.spec.env, NO_RESULT: "1", FILE_RESULT: h.record.resultPath } });
    const done = await poll(h.read, terminal);
    assert.equal(done.status, "done");
    assert.equal(fs.readFileSync(done.resultPath, "utf8"), "engine file result");
  } finally { await h.cleanup(); }
});

test("spawn and identity failures do not leave an owned child running", async (t) => {
  for (const failure of ["spawn", "identity"]) await t.test(failure, async () => {
    const h = harness({ failure });
    try {
      const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall" } });
      await poll(() => child.closed, Boolean);
      assert.equal(child.code, 0);
      assert.equal(h.read().status, "failed");
      assert.match(h.read().reason!, failure === "spawn" ? /ENOENT/ : /identit/);
      assert.deepEqual(ownedProcesses(h.root), []);
    } finally { await h.cleanup(); }
  });
});

test("unrelated ledger write errors are logged and terminate the owned engine", async (t) => {
  for (const failure of ["ledger", "ledger-terminal"]) await t.test(failure, async () => {
    const h = harness({ failure });
    try {
      const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall" } });
      await poll(() => child.closed, Boolean);
      assert.equal(child.code, failure === "ledger" ? 1 : 0);
      assert.equal(h.read().status, failure === "ledger" ? "launching" : "failed");
      assert.match(fs.readFileSync(path.join(path.dirname(h.recordFile), `${h.record.id}.runner.log`), "utf8"), /fixture ledger write failed/);
      assert.deepEqual(ownedProcesses(h.root), []);
    } finally { await h.cleanup(); }
  });
});

test("orphan cleanup preserves a record settled during its grace period", async () => {
  const { terminateOrphans } = await import("../src/process.ts");
  const h = harness();
  let cleanup: Promise<TaskRecord[]> | undefined;
  try {
    const identity = await orphan(h, "stall-ignore-term");
    cleanup = terminateOrphans(h.root).then((result) => result.changed);
    const settled = await writeAs(h.root, h.record.id, "failed", { reason: "external settlement" });
    assert.deepEqual(await cleanup, []);
    assert.deepEqual(h.read(), settled);
    assert.equal(living(identity), false);
  } finally { await h.cleanup(); await cleanup; }
});

/** Every `flock` child of this machine queued on one lock file, holder and waiters alike. */
function lockChildren(file: string): number[] {
  const pids: number[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const argv = cmdline.split("\0");
    if (argv[0]?.endsWith("flock") && argv.includes(file)) pids.push(Number(entry));
  }
  return pids;
}

/** The util-linux child that actually holds a lock, found by the file on its command line. */
function holderOf(file: string): number | null {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const argv = cmdline.split("\0");
    if (argv[0]?.endsWith("flock") && argv.includes(file)) return Number(entry);
  }
  return null;
}

test("a runner that loses its lock settles failed and leaves no engine group", async () => {
  const { groupAlive } = await import("../src/process.ts");
  const h = harness();
  try {
    const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall" } });
    const running = await poll(h.read, (record) => record.status === "running");
    const holder = await poll(() => holderOf(lockPath(h.root, runnerLockName(h.record.id))), (pid) => pid !== null);
    // The lock is this runner's claim to be the only one for the task. Once the kernel
    // has dropped it another runner may start, so this one must own nothing afterwards.
    process.kill(holder!, "SIGKILL");
    const failed = await poll(h.read, terminal);
    assert.equal(failed.status, "failed");
    assert.equal(failed.reason, "runner lock lost");
    assert.equal(groupAlive(running.engineIdentity!), false);
    await poll(() => child.closed, Boolean);
    assert.match(h.runnerLog(), /runner lock lost/);
    assert.deepEqual(ownedProcesses(h.root), []);
  } finally { await h.cleanup(); }
});

test("runner diagnostics are written to runner.log without stdout output", async () => {
  const h = harness();
  try {
    const child = h.start({ adapterModule: path.join(fixtures, `missing-${randomUUID()}.mjs`) }, true);
    let stdout = "";
    let stderr = "";
    child.child.stdout!.on("data", (data) => { stdout += data; });
    child.child.stderr!.on("data", (data) => { stderr += data; });
    await poll(() => child.closed, Boolean);
    const failed = h.read();
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, null);
    assert.equal(failed.sessionId, null);
    assert.equal(failed.lastEventAt, null);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
    assert.match(fs.readFileSync(path.join(path.dirname(h.recordFile), `${h.record.id}.runner.log`), "utf8"), /Cannot find module/);
  } finally { await h.cleanup(); }
});

test("a second runner for one task takes no lock, touches no record, and exits 1", async () => {
  const h = harness({ delayedImport: true });
  try {
    const first = h.start({ env: { ...h.spec.env, INVOCATIONS: h.invocations } });
    await poll(() => fs.existsSync(h.importReady), Boolean);
    const before = h.read();
    // Spawned while the first runner still holds runner-<id>.lock and its engine is
    // not yet launched: without the lock this second runner would launch a second one.
    const second = h.start({ env: { ...h.spec.env, INVOCATIONS: h.invocations } });
    await poll(() => second.closed, Boolean);
    assert.equal(second.code, 1);
    assert.deepEqual(h.read(), before, "the second runner exited without touching the record");
    assert.ok(h.runnerLog().includes(`another runner owns task ${h.record.id}`));
    fs.writeFileSync(h.importRelease, "go");
    const done = await poll(h.read, terminal);
    assert.equal(done.status, "done");
    assert.equal(h.engineLaunches().length, 1, "one task, one engine");
    await poll(() => first.closed, Boolean);
    assert.equal(first.code, 0);
    assert.deepEqual(ownedProcesses(h.root), []);
  } finally { await h.cleanup(); }
});

// @anchor runnerStartsAgainst
test("a runner that starts against a cancelling record settles it and spawns no engine", async (t) => {
  for (const when of ["before the record read", "during the adapter import"] as const) await t.test(when, async () => {
    const h = harness(when === "during the adapter import" ? { delayedImport: true } : {});
    try {
      // The cancel reached the record first. An engine spawned now would be one the cancel
      // has already accounted for, and nothing would ever settle it.
      if (when === "before the record read") await writeAs(h.root, h.record.id, "cancelling");
      const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall" } });
      if (when === "during the adapter import") {
        await poll(() => fs.existsSync(h.importReady), Boolean);
        await writeAs(h.root, h.record.id, "cancelling");
        fs.writeFileSync(h.importRelease, "go");
      }
      const settled = await poll(h.read, terminal);
      assert.equal(settled.status, "cancelled");
      assert.equal(settled.engineIdentity ?? null, null, "no engine was spawned, so none is recorded");
      assert.deepEqual(h.engineLaunches(), []);
      assert.equal(fs.existsSync(h.invocation), false);
      await poll(() => child.closed, Boolean);
      assert.equal(child.code, 0);
      assert.match(h.runnerLog(), /cancelled before acknowledgement/);
    } finally { await h.cleanup(); }
  });
});

// @anchor cancelLandsAcknowledgement
test("a cancel that lands before acknowledgement is a cancel, not a stranger's settlement", async (t) => {
  const { groupAlive } = await import("../src/process.ts");
  // The window the runner cannot stand down in: it read the record, found it `launching`,
  // and is building its spawn when the cancel lands. The fixture holds `plan` there, so
  // the engine is started and owned by a runner whose acknowledgement is already doomed.
  const h = harness({ delayedPlan: true });
  try {
    const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall" } });
    await poll(() => fs.existsSync(h.planReady), Boolean);
    await writeAs(h.root, h.record.id, "cancelling");
    // Holding the record lock makes the acknowledgement wait, so the engine is fully up
    // when the runner learns it was cancelled, and the settlement it writes carries real
    // evidence rather than whatever the engine managed before it was signalled.
    const held = await acquire(lockPath(h.root, recordLockName(h.record.id)), { operation: "test writer", waitSeconds: 5 });
    // Given up however the barriers below end: a lock a failed wait left held would
    // keep the runner waiting on it for the rest of this test.
    t.after(() => held.release());
    fs.writeFileSync(h.planRelease, "go");
    await poll(
      () => (fs.existsSync(h.record.logPath) ? fs.readFileSync(h.record.logPath, "utf8") : ""),
      (log) => log.includes('"working"'),
    );
    await held.release();
    const cancelled = await poll(h.read, terminal);
    assert.equal(cancelled.status, "cancelled");
    // The identities are written even though the acknowledgement never applied, so
    // cleanup can verify the group this runner owned.
    assert.equal(cancelled.runnerIdentity?.pid, child.child.pid);
    assert.equal(cancelled.runnerIdentity?.bootId, ledger.currentBootId);
    assert.ok(cancelled.engineIdentity);
    assert.equal(cancelled.engineIdentity.pgid, cancelled.engineIdentity.pid);
    assert.equal(cancelled.engineIdentity.bootId, ledger.currentBootId);
    assert.equal(cancelled.exitCode, 143);
    assert.match(cancelled.sessionId!, /^fake-/);
    assert.ok(cancelled.lastEventAt);
    assert.equal(groupAlive(cancelled.engineIdentity), false);
    assert.deepEqual(ownedProcesses(h.root), []);
    assert.deepEqual(h.audit().map(({ record }) => record.status), ["cancelled"],
      "the runner never claimed running, and never rewrote the cancelling it did not own");
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.match(h.runnerLog(), /cancelled before acknowledgement/);
  } finally { await h.cleanup(); }
});

test("a cancel that beat the acknowledgement leaves no activity interval behind it", async (t) => {
  // The guard before the interval (`src/runner.ts`): a cancel that arrived while the
  // acknowledgement was in flight already owns the teardown and has cleared an interval
  // that this would otherwise start behind it — which would then persist `lastEventAt`
  // over a record being cancelled, for as long as the engine took to die.
  const h = harness({ delayedPlan: true });
  try {
    const child = h.start({ env: { ...h.spec.env, HOLD: "1", ACTIVITY: "1", IGNORE_TERM: "1" } });
    await poll(() => fs.existsSync(h.planReady), Boolean);
    const file = lockPath(h.root, recordLockName(h.record.id));
    const held = await acquire(file, { operation: "test writer", waitSeconds: 60 });
    t.after(() => held.release());
    fs.writeFileSync(h.planRelease, "go");
    // Two `flock` children on the record's lock: this test's, and the one the runner's
    // acknowledgement is queued behind. That is the state this test needs — the cancel
    // below has to land while that write is in flight — and waiting for it is what makes
    // the race a certainty rather than a matter of how fast the machine is.
    await poll(() => lockChildren(file).length, (count) => count === 2);
    await poll(() => (fs.existsSync(h.record.logPath) ? fs.readFileSync(h.record.logPath, "utf8") : ""),
      (log) => log.includes("fixture ready"));
    child.child.kill("SIGTERM");
    // The cancel has claimed the teardown, and the acknowledgement is still queued behind
    // this lock: the state the guard is about, reached by waiting rather than by hoping
    // that a signal beat a write.
    await poll(() => fs.existsSync(h.markers.cancelled), Boolean);
    assert.equal(h.read().status, "launching", "nothing was written while the lock was held");
    await held.release();

    const cancelled = await poll(h.read, terminal);
    assert.equal(cancelled.status, "cancelled");
    const writes = h.audit();
    assert.deepEqual(writes.map(({ record }) => record.status), ["running", "cancelling", "cancelled"],
      "the acknowledgement, the cancel and the settlement: no activity write behind them");
    // What makes that a test rather than a coincidence: the engine ignored SIGTERM, so the
    // teardown outlasted a turn of the two-second interval, and it kept emitting events
    // the whole time, so an interval left running would have had something to persist.
    const teardown = writes[2].record.updatedAt - writes[1].record.updatedAt;
    assert.ok(teardown >= 2000, `the teardown was ${teardown}ms, less than a turn of the interval`);
    assert.ok(cancelled.lastEventAt! > writes[0].record.lastEventAt!, "the engine went on talking through it");
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.deepEqual(ownedProcesses(h.root), []);
  } finally { await h.cleanup(); }
});

test("a runner that cannot acknowledge because another writer owns the record settles nothing", async () => {
  const h = harness({ delayedImport: true });
  try {
    const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall" } });
    await poll(() => fs.existsSync(h.importReady), Boolean);
    const owned = await writeAs(h.root, h.record.id, "running");
    fs.writeFileSync(h.importRelease, "go");
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.deepEqual(h.read(), owned, "a record another writer owns is left exactly as it was");
    assert.deepEqual(h.audit(), [], "the runner made no rename at all");
    assert.deepEqual(ownedProcesses(h.root), [], "its own engine group was stopped immediately");
    assert.match(h.runnerLog(), /someone else settled the task/);
  } finally { await h.cleanup(); }
});

test("a SIGTERM over an orphaned record settles cancelled, the one edge the ledger allows", async () => {
  const { groupAlive } = await import("../src/process.ts");
  const h = harness();
  try {
    const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall" } });
    const running = await poll(h.read, (record) => record.status === "running");
    await poll(() => fs.readFileSync(running.logPath, "utf8"), (log) => log.includes('"working"'));
    // Reconciliation adopting a stranded engine is what writes this status; from here the
    // ledger allows orphaned -> failed | cancelled | done and nothing else, so the
    // teardown may not claim the record with a `cancelling` write of its own.
    const orphaned = await applied(ledger.update(h.root, h.record.id, { status: "orphaned" }));
    child.child.kill("SIGTERM");
    const cancelled = await poll(h.read, terminal);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.updatedAt >= orphaned.updatedAt);
    assert.equal(groupAlive(running.engineIdentity!), false);
    assert.deepEqual(cancelled.engineIdentity, running.engineIdentity);
    assert.deepEqual(cancelled.runnerIdentity, running.runnerIdentity);
    assert.deepEqual(h.audit().map(({ record }) => record.status), ["running", "cancelled"]);
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0, "a settlement, not a crash");
    assert.match(h.runnerLog(), /settled cancelled/);
    assert.doesNotMatch(h.runnerLog(), /cannot change task/);
  } finally { await h.cleanup(); }
});

test("a SIGTERM during startup settles the task or leaves it, and never exits through fatal", async () => {
  // The handler is registered as soon as this runner owns the task, before the record it
  // settles has been read, so a cancel arriving there must still settle rather than crash
  // on a record it has not loaded (atc-s96.29). The delay walks the whole startup.
  for (const delayMs of [0, 1, 2, 3, 5, 8, 13, 21]) {
    const h = harness();
    try {
      const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall" } });
      await delay(delayMs);
      child.child.kill("SIGTERM");
      await poll(() => child.closed, Boolean);
      const record = await poll(h.read, (value) => value.status !== "cancelling");
      // Either the signal arrived before this runner had a handler, which is the kernel's
      // default and leaves the record for reconciliation, or the runner answered it.
      assert.ok(["launching", "cancelled"].includes(record.status), `${delayMs}ms: ${record.status}`);
      assert.ok([0, null].includes(child.code), `${delayMs}ms: exit ${child.code}`);
      if (fs.existsSync(path.join(path.dirname(h.recordFile), `${h.record.id}.runner.log`))) {
        assert.doesNotMatch(h.runnerLog(), /TypeError/, `${delayMs}ms`);
      }
    } finally { await h.cleanup(); }
  }
});

test("a SIGTERM after the server has already written cancelling still settles cancelled", async () => {
  const h = harness();
  try {
    const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall" } });
    const running = await poll(h.read, (record) => record.status === "running");
    await poll(() => fs.readFileSync(running.logPath, "utf8"), (log) => log.includes('"working"'));
    const cancelling = await writeAs(h.root, h.record.id, "cancelling");
    child.child.kill("SIGTERM");
    const cancelled = await poll(h.read, terminal);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.updatedAt >= cancelling.updatedAt);
    assert.equal(living(running.engineIdentity!), false);
    assert.deepEqual(h.audit().map(({ record }) => record.status), ["running", "cancelled"],
      "the refused cancelling write is the server's, so the runner continued the cancel without rewriting it");
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
  } finally { await h.cleanup(); }
});

test("two writers with contradictory expectations: exactly one applies, the other is refused", async () => {
  // A race, so it is run as one: what each round asserts is the invariant the record lock
  // gives — one of two contradictory writers applies and the other is refused, whichever
  // of them the kernel let in first — and never an order.
  for (let round = 0; round < 5; round++) {
    const h = harness();
    try {
      // Both read `launching` and both intend to move it, so at most one can be right.
      // The gate releases them together; the record lock decides which.
      const gate = path.join(h.root, "race-go");
      const first = h.competitor("claims-running", { status: "running", reason: "first" }, 111, "launching", gate);
      const second = h.competitor("claims-cancelling", { status: "cancelling", reason: "second" }, 222, "launching", gate);
      await poll(() => fs.existsSync(first.marker) && fs.existsSync(second.marker), Boolean);
      fs.writeFileSync(gate, "go");
      await poll(() => first.tracked.closed && second.tracked.closed, Boolean);
      const results = [await h.outcome(first.outcome), await h.outcome(second.outcome)];
      for (const result of results) assert.ok("applied" in result, `competitor threw: ${JSON.stringify(result)}`);
      const applied = results.filter((result) => "applied" in result && result.applied);
      const refused = results.filter((result) => "applied" in result && !result.applied);
      assert.equal(applied.length, 1, `exactly one writer applied: ${JSON.stringify(results)}`);
      assert.equal(refused.length, 1);
      assert.equal((refused[0] as { reason: string }).reason, "expect");
      const final = h.read();
      assert.deepEqual((applied[0] as { record: TaskRecord }).record, final, "the record holds the winner's write");
      assert.deepEqual((refused[0] as { record: TaskRecord }).record, final,
        "the loser read the winner's record inside the lock, so it can act on what beat it");
      assert.equal(final.reason, final.status === "running" ? "first" : "second");
      assert.equal(final.updatedAt, final.status === "running" ? 111 : 222);
    } finally { await h.cleanup(); }
  }
});

test("an engine identity from another boot is dead, not a reused pid", async () => {
  const helpers = await import("../src/process.ts");
  const h = harness();
  try {
    const child = h.track(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true, stdio: "ignore", env: { RUNNER_TEST_ROOT: h.root },
    }));
    const identity = { ...helpers.identityOf(child.child.pid!)!, pgid: child.child.pid! };
    assert.equal(helpers.groupAlive(identity), true);
    const foreign = { ...identity, bootId: "3a1e0e6c-0000-4000-8000-000000000000" };
    assert.equal(helpers.groupAlive(foreign), false, "a pid and start time from another boot are not this group");
    // A stale identity whose pid a live process has taken over is skipped for as long
    // as that process lives. One from another boot is simply dead, so cleanup settles
    // its record instead of leaving it orphaned for good — and signals nothing.
    await writeAs(h.root, h.record.id, "orphaned", { engineIdentity: { ...foreign, startTime: "0" } });
    const { changed } = await helpers.terminateOrphans(h.root);
    assert.deepEqual(changed.map((record) => [record.id, record.status, record.reason]), [[h.record.id, "failed", "runner lost"]]);
    assert.equal(living(identity), true, "the live process holding that pid was never signalled");
  } finally { await h.cleanup(); }
});

test("an engine that completes while the server is cancelling settles cancelled, not done", async (t) => {
  const { groupAlive } = await import("../src/process.ts");
  // The cancel lands while the runner is building its spawn, which is the one window it
  // cannot stand down in: past that point the engine is this runner's to settle.
  const h = harness({ delayedPlan: true });
  try {
    const child = h.start();
    await poll(() => fs.existsSync(h.planReady), Boolean);
    await writeAs(h.root, h.record.id, "cancelling");
    // Holding the record lock keeps the acknowledgement pending until the engine has
    // already finished, so completion claims the settlement first. That is the order in
    // which a terminal status taken from the engine's outcome alone would write
    // `cancelling -> done`, which the ledger forbids: the write throws and the record
    // is stranded `cancelling` with no identities.
    const held = await acquire(lockPath(h.root, recordLockName(h.record.id)), { operation: "test writer", waitSeconds: 5 });
    // Given up however the barriers below end: a lock a failed wait left held would
    // keep the runner waiting on it for the rest of this test.
    t.after(() => held.release());
    fs.writeFileSync(h.planRelease, "go");
    await poll(() => fs.existsSync(h.record.resultPath), Boolean);
    await held.release();
    const cancelled = await poll(h.read, terminal);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.reason, "engine completed during cancel");
    assert.equal(cancelled.exitCode, 0);
    assert.match(cancelled.sessionId!, /^fake-/);
    assert.ok(cancelled.lastEventAt);
    assert.equal(fs.readFileSync(cancelled.resultPath, "utf8"), "DONE finish T5", "the engine's own output is kept");
    assert.equal(cancelled.runnerIdentity?.pid, child.child.pid);
    assert.ok(cancelled.engineIdentity);
    assert.equal(groupAlive(cancelled.engineIdentity), false);
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.deepEqual(ownedProcesses(h.root), []);
  } finally { await h.cleanup(); }
});

test("a completion over a record another writer orphaned settles nothing", async () => {
  const h = harness();
  try {
    const child = h.start({ env: { ...h.spec.env, HOLD: "1" } });
    const running = await poll(h.read, (record) => record.status === "running");
    await writeAs(h.root, h.record.id, "orphaned");
    fs.writeFileSync(h.release, "go");
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.equal(h.read().status, "orphaned", "the record belongs to whoever orphaned it");
    assert.equal(h.audit().filter(({ record }) => terminal(record)).length, 0, "the runner made no terminal write");
    assert.equal(living(running.engineIdentity!), false, "its own group was stopped all the same");
    assert.match(h.runnerLog(), /someone else settled the task/);
  } finally { await h.cleanup(); }
});

/**
 * A same-user, unreadable session leader holds the runner's re-scan open (atc-s96.49).
 * ssh-agent owns a bounded command, so even a denied signal can retire it by closing
 * that command's stdin. A sacrificial agent proves SIGKILL works before a test uses one.
 * ping is unsuitable: AppArmor can allow it to start but deny every cleanup signal.
 */
async function unreadableCandidate(h: ReturnType<typeof harness>): Promise<{ pid: number; clear(): Promise<void> } | { skip: string }> {
  const describe = (error: unknown) => {
    const value = error as NodeJS.ErrnoException;
    return `${value.code ? `${value.code}: ` : ""}${value.message ?? error}`;
  };
  for (const preflight of [true, false]) {
    const ready = path.join(h.root, `agent-${randomUUID()}`);
    // In command mode the spawned pid becomes this command; SSH_AGENT_PID names the
    // actual agent. Publish its start time too, so retirement never trusts a reused pid.
    const command = `
      const fs = require("node:fs");
      setTimeout(() => process.exit(0), 60_000);
      process.stdin.on("end", () => process.exit(0));
      process.stdin.resume();
      const pid = Number(process.env.SSH_AGENT_PID);
      const raw = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      const startTime = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\\s+/)[19];
      fs.writeFileSync(${JSON.stringify(`${ready}.tmp`)}, JSON.stringify({ pid, startTime }));
      fs.renameSync(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});
    `;
    const tracked = h.track(spawn("ssh-agent", ["-a", `${ready}.sock`, process.execPath, "-e", command], {
      detached: true, stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, RUNNER_TEST_ROOT: h.root },
    }));
    let identity: { pid: number; startTime: string } | null = null;
    let retired = false;
    let clearing: Promise<void> | undefined;
    const recoverIdentity = () => {
      if (identity || tracked.child.pid === undefined) return;
      // A command may die before publishing ready. The daemon keeps its argv, including
      // this probe's unique socket path, even after reparenting. Locate it without environ.
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry) || Number(entry) === tracked.child.pid) continue;
        const stat = ledger.readProcessStat(Number(entry));
        if (!stat || stat.pgid !== Number(entry) || stat.sid !== Number(entry) || ["Z", "X"].includes(stat.state)) continue;
        if (tracked.identity && BigInt(stat.startTime) < BigInt(tracked.identity.startTime)) continue;
        try {
          if (fs.statSync(`/proc/${entry}`).uid !== process.getuid!()) continue;
          const argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
          if (path.basename(argv[0]) === "ssh-agent" && argv[1] === "-a" && argv[2] === `${ready}.sock`) {
            identity = { pid: Number(entry), startTime: stat.startTime };
            return;
          }
        } catch (error) {
          if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code!)) throw error;
        }
      }
    };
    const signal = () => {
      if (!identity) return false;
      const current = proc(identity.pid);
      if (!current || current.startTime !== identity.startTime || ["Z", "X"].includes(current.state)) return false;
      process.kill(current.pgid === current.pid ? -current.pid : current.pid, "SIGKILL");
      return true;
    };
    const clear = (): Promise<void> => {
      if (retired) return Promise.resolve();
      return clearing ??= (async () => {
        let signalError: unknown;
        const stop = () => {
          recoverIdentity();
          try { signal(); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") signalError = error; }
        };
        try { stop(); } finally { tracked.child.stdin?.end(); }
        await poll(() => {
          if (!identity) stop(); // Also catch a fork between the initial scan and stdin closure.
          return { commandClosed: tracked.closed, agentAlive: identity !== null && living(identity) };
        }, (state) => state.commandClosed && !state.agentAlive);
        retired = true;
        unregister();
        if (signalError) throw new Error(`ssh-agent SIGKILL failed: ${describe(signalError)}`, { cause: signalError });
      })().finally(() => { clearing = undefined; });
    };
    const unregister = h.onCleanup(clear);
    const skip = async (reason: string) => {
      try { await clear(); }
      catch (error) {
        if (!retired) throw error; // A live probe is a cleanup failure, never a successful skip.
        reason += `; ${describe(error)}`;
      }
      return { skip: reason };
    };
    try {
      try {
        await poll(() => tracked.error !== null || tracked.closed || fs.existsSync(ready), Boolean);
      } catch {
        return await skip("ssh-agent timed out before publishing its identity");
      }
      if (tracked.error) return await skip(`ssh-agent spawn failed: ${describe(tracked.error)}`);
      if (!fs.existsSync(ready)) return await skip(`ssh-agent exited before ready (code ${tracked.code}, signal ${tracked.signal})`);
      identity = JSON.parse(fs.readFileSync(ready, "utf8"));
      const { pid, startTime } = identity!;
      const stat = await poll(() => ledger.readProcessStat(pid),
        (value) => !value || value.startTime !== startTime || ["Z", "X"].includes(value.state)
          || (value.pgid === pid && value.sid === pid));
      if (!stat || stat.startTime !== startTime || ["Z", "X"].includes(stat.state)) {
        return await skip("ssh-agent exited before its environment could be checked");
      }
      if (fs.statSync(`/proc/${pid}`).uid !== process.getuid!()) return await skip("ssh-agent is not owned by this user");
      let denied = false;
      try { fs.readFileSync(`/proc/${pid}/environ`); }
      catch (error) {
        if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code!)) {
          return await skip(`ssh-agent environ check failed: ${describe(error)}`);
        }
        denied = true;
      }
      if (!denied) return await skip("ssh-agent environ is readable in this environment");
      if (!preflight) return { pid, clear };
      try {
        if (!signal()) return await skip("ssh-agent exited before its SIGKILL preflight");
      } catch (error) {
        return await skip(`ssh-agent SIGKILL preflight failed: ${describe(error)}`);
      }
      await clear();
    } catch (error) {
      return await skip(`ssh-agent probe failed: ${describe(error)}`);
    }
  }
  throw new Error("ssh-agent probe did not produce a candidate");
}

// @anchor missingUnreadableProbe
test("an unavailable unreadable probe names ssh-agent and its spawn error", async () => {
  const h = harness();
  const previousPath = process.env.PATH;
  // No privileged binary can be spawned by either the old or new helper in this case.
  process.env.PATH = h.root;
  try {
    const candidate = await unreadableCandidate(h);
    assert.ok("skip" in candidate);
    assert.match(candidate.skip, /ssh-agent.*ENOENT/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await h.cleanup();
  }
});

// @anchor unusableUnreadableProbe
for (const [label, source, reason] of [
  ["exits before becoming ready", "process.exit(23);", /ssh-agent.*exited.*23/],
  ["has a readable environment", `
    const { spawn } = require("node:child_process");
    setTimeout(() => process.exit(0), 2000);
    if (process.argv[4] === process.execPath) {
      const command = spawn(process.argv[4], process.argv.slice(5), {
        env: { ...process.env, SSH_AGENT_PID: String(process.pid) }, stdio: "inherit",
      });
      command.on("exit", () => process.exit(0));
    }
  `, /ssh-agent.*environ.*readable/],
] as const) {
  test(`an unreadable probe that ${label} skips with the actual reason and retires`, async () => {
    const h = harness();
    const previousPath = process.env.PATH;
    // Only this bounded, unprivileged stand-in is on PATH; the old helper cannot run ping.
    fs.writeFileSync(path.join(h.root, "ssh-agent"), `#!${process.execPath}\n${source}`, { mode: 0o755 });
    process.env.PATH = h.root;
    try {
      const candidate = await unreadableCandidate(h);
      assert.ok("skip" in candidate);
      assert.match(candidate.skip, reason);
      assert.deepEqual(ownedProcesses(h.root), [], "a rejected probe has already retired");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await h.cleanup();
    }
  });
}

/** Keep ping off PATH even when these regressions are run against the old helper. */
function onlySshAgent(h: ReturnType<typeof harness>): (() => void) | null {
  const previous = process.env.PATH;
  const binary = (previous ?? "").split(path.delimiter).map((dir) => path.resolve(dir, "ssh-agent"))
    .find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
  if (!binary) return null;
  fs.symlinkSync(binary, path.join(h.root, "ssh-agent"));
  process.env.PATH = h.root;
  return () => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; };
}

// @anchor unreadableProbeUnpublished
test("an unreadable probe that fails to publish its identity retires its actual agent before skipping", async (t) => {
  const h = harness();
  const restorePath = onlySshAgent(h);
  const witness = path.join(h.root, "unpublished-agent.json");
  let identity: Inspected | null = null;
  try {
    if (!restorePath) return t.skip("ssh-agent is unavailable");
    const shim = path.join(h.root, "ssh-agent");
    const binary = fs.realpathSync(shim);
    fs.unlinkSync(shim);
    // The real agent starts, but its command fails before the helper's readiness write.
    const failure = `
      const fs = require("node:fs");
      const pid = Number(process.env.SSH_AGENT_PID);
      const raw = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\\s+/);
      fs.writeFileSync(${JSON.stringify(witness)}, JSON.stringify({ pid, startTime: fields[19], pgid: Number(fields[2]), state: fields[0] }));
      process.exit(23);
    `;
    fs.writeFileSync(shim, `#!${process.execPath}
      const { spawn } = require("node:child_process");
      const args = process.argv.slice(2);
      args[args.length - 1] = ${JSON.stringify(failure)};
      const child = spawn(${JSON.stringify(binary)}, args, { stdio: "inherit" });
      child.on("error", () => process.exit(24));
      child.on("exit", (code) => process.exit(code ?? 1));
      setTimeout(() => process.exit(0), 60_000);
    `, { mode: 0o755 });
    const candidate = await unreadableCandidate(h);
    identity = JSON.parse(fs.readFileSync(witness, "utf8"));
    assert.ok("skip" in candidate);
    assert.match(candidate.skip, /ssh-agent.*exited.*23/);
    assert.equal(living(identity!), false, "the agent outlives its failed command until explicitly retired");
  } finally {
    // Also makes the regression safe against the implementation that returns too soon.
    if (!identity && fs.existsSync(witness)) identity = JSON.parse(fs.readFileSync(witness, "utf8"));
    if (identity && living(identity)) {
      process.kill(identity.pgid === identity.pid ? -identity.pid : identity.pid, "SIGKILL");
      await poll(() => living(identity!), (alive) => !alive);
    }
    restorePath?.();
    await h.cleanup();
  }
});

// @anchor unreadableProbePreflightDenied
test("an unreadable probe whose SIGKILL preflight is denied retires and names the denial", async (t) => {
  const h = harness();
  const restorePath = onlySshAgent(h);
  const kill = process.kill.bind(process);
  let denied: Inspected | null = null;
  const mocked = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid < 0 && signal === "SIGKILL" && (!denied || pid === -denied.pid)) {
      denied ??= proc(-pid);
      throw Object.assign(new Error("probe signal denied"), { code: "EACCES" });
    }
    return kill(pid, signal);
  });
  try {
    if (!restorePath) return t.skip("ssh-agent is unavailable");
    const candidate = await unreadableCandidate(h);
    if (!denied && "skip" in candidate) return t.skip(candidate.skip);
    assert.ok("skip" in candidate, "a candidate must pass an actual SIGKILL preflight");
    assert.match(candidate.skip, /ssh-agent.*SIGKILL.*EACCES/);
    assert.ok(denied && !living(denied), "closing the command retired the agent despite every signal being denied");
    assert.deepEqual(ownedProcesses(h.root), []);
  } finally {
    mocked.mock.restore();
    restorePath?.();
    await h.cleanup();
  }
});

// @anchor unreadableProbeRetirement
for (const dispose of ["clear", "assertion failure"] as const) {
  test(`an unreadable probe passes a real kill preflight and retires after ${dispose}`, async (t) => {
    const h = harness();
    const restorePath = onlySshAgent(h);
    const kill = process.kill.bind(process);
    const killed: Inspected[] = [];
    const mocked = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
      if (pid < 0 && signal === "SIGKILL") {
        const identity = proc(-pid);
        if (identity) killed.push(identity);
      }
      return kill(pid, signal);
    });
    try {
      if (!restorePath) return t.skip("ssh-agent is unavailable");
      const candidate = await unreadableCandidate(h);
      if ("skip" in candidate) return t.skip(candidate.skip);
      const identity = proc(candidate.pid)!;
      assert.ok(killed.length > 0, "a sacrificial candidate was actually killed before this one was offered");
      assert.ok(killed.every((entry) => !living(entry)));
      if (dispose === "clear") {
        await candidate.clear();
        assert.equal(living(identity), false, "clear waits until the candidate is gone");
        await candidate.clear();
      } else {
        const failure = new Error("test assertion failed");
        await assert.rejects(async () => {
          try { throw failure; } finally { await h.cleanup(); }
        }, (error) => error === failure);
        assert.equal(living(identity), false, "finally cleanup retired the unreadable agent");
        assert.equal(fs.existsSync(h.adapterModule), false);
        assert.equal(fs.existsSync(h.root), false);
      }
      assert.deepEqual(ownedProcesses(h.root), []);
    } finally {
      mocked.mock.restore();
      restorePath?.();
      await h.cleanup();
    }
  });
}

/** The runner's diagnostic so far, empty before its first line. */
function diagnostics(h: ReturnType<typeof harness>): string {
  const file = path.join(path.dirname(h.recordFile), `${h.record.id}.runner.log`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/**
 * No engine was launched for the task: none announced itself, none recorded its argv, no
 * process of it is alive, the adapter was never asked for a spawn plan, and the runner never
 * said it was launching. The last two are written synchronously at the launch decision, so
 * they witness an engine the settlement ended before its own first line could run.
 */
function noEngineLaunched(h: ReturnType<typeof harness>): void {
  assert.deepEqual(h.engineLaunches(), [], "no engine announced itself");
  assert.equal(fs.existsSync(h.invocation), false, "no engine recorded its argv");
  assert.deepEqual(ownedProcesses(h.root), [], "no process carrying the task's engine environment is alive");
  assert.equal(fs.existsSync(path.join(h.root, "request.json")), false, "the adapter was never asked for a spawn plan");
  assert.doesNotMatch(diagnostics(h), /launching claude/, "the runner never said it was launching");
}

// @anchor cancelDuringRescan
test("a cancel during the pre-spawn re-scan settles cancelled and launches no engine", async (t) => {
  const h = harness();
  try {
    const candidate = await unreadableCandidate(h);
    if ("skip" in candidate) return t.skip(candidate.skip);
    const child = h.start({ env: { ...h.spec.env, INVOCATIONS: h.invocations } });
    await poll(() => diagnostics(h), (text) => /re-scanning: environ unreadable/.test(text));
    // The settlement's first write is held in flight on the record lock until the re-scan
    // has come back clean: settling while the retry still waits would exit before it, and
    // then nothing this test asserts would depend on the re-check after the await.
    const file = lockPath(h.root, recordLockName(h.record.id));
    const held = await acquire(file, { operation: "test writer", waitSeconds: 60 });
    t.after(() => held.release());
    child.child.kill("SIGTERM");
    await poll(() => fs.existsSync(h.markers.cancelled), Boolean);
    await poll(() => lockChildren(file).length, (count) => count === 2);
    await candidate.clear();
    await poll(() => diagnostics(h), (text) => /re-scan clean/.test(text));
    await held.release();
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    const settled = h.read();
    assert.equal(settled.status, "cancelled");
    assert.equal(settled.exitCode, null);
    noEngineLaunched(h);
  } finally { await h.cleanup(); }
});

// @anchor settledDuringRescan
test("a settlement another writer makes during the pre-spawn re-scan is left as written, and no engine launches", async (t) => {
  const h = harness();
  try {
    const candidate = await unreadableCandidate(h);
    if ("skip" in candidate) return t.skip(candidate.skip);
    const child = h.start({ env: { ...h.spec.env, INVOCATIONS: h.invocations } });
    await poll(() => diagnostics(h), (text) => /re-scanning: environ unreadable/.test(text));
    // Durable before the candidate goes: the retry that comes back clean reads it.
    const external = await writeAs(h.root, h.record.id, "failed", { reason: "external settlement" });
    await candidate.clear();
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    assert.deepEqual(h.read(), external);
    assert.match(diagnostics(h), /re-scan clean/);
    assert.match(diagnostics(h), /someone else settled the task/);
    noEngineLaunched(h);
  } finally { await h.cleanup(); }
});

// @anchor lockLostDuringRescan
test("a runner lock lost during the pre-spawn re-scan settles failed and launches no engine", async (t) => {
  const h = harness();
  try {
    const candidate = await unreadableCandidate(h);
    if ("skip" in candidate) return t.skip(candidate.skip);
    // An engine wrongly spawned here would outlive the settlement: the teardown has already
    // stopped the nothing it owned before its `failed` write, so the process witness sees it.
    const child = h.start({ env: { ...h.spec.env, INVOCATIONS: h.invocations, FAKE_ENGINE_SCRIPT: "stall" } });
    await poll(() => diagnostics(h), (text) => /re-scanning: environ unreadable/.test(text));
    const file = lockPath(h.root, recordLockName(h.record.id));
    const held = await acquire(file, { operation: "test writer", waitSeconds: 60 });
    t.after(() => held.release());
    const holder = await poll(() => holderOf(lockPath(h.root, runnerLockName(h.record.id))), (pid) => pid !== null);
    process.kill(holder!, "SIGKILL");
    await poll(() => diagnostics(h), (text) => /runner lock lost/.test(text));
    await poll(() => lockChildren(file).length, (count) => count === 2);
    await candidate.clear();
    await poll(() => diagnostics(h), (text) => /re-scan clean/.test(text));
    await held.release();
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
    const failed = h.read();
    assert.equal(failed.status, "failed");
    assert.equal(failed.reason, "runner lock lost");
    noEngineLaunched(h);
  } finally { await h.cleanup(); }
});

// @anchor clearedDuringRescan
test("a candidate that clears during the pre-spawn re-scan is followed by the launch", async (t) => {
  const h = harness();
  try {
    const candidate = await unreadableCandidate(h);
    if ("skip" in candidate) return t.skip(candidate.skip);
    const child = h.start({ env: { ...h.spec.env, INVOCATIONS: h.invocations } });
    await poll(() => diagnostics(h), (text) => /re-scanning: environ unreadable/.test(text));
    await candidate.clear();
    const done = await poll(h.read, terminal);
    assert.equal(done.status, "done", diagnostics(h));
    // One visible stand-down used to be the price of a process that was unreadable for a
    // moment; the retry is what turns it into the launch the delegation asked for.
    assert.match(diagnostics(h), /re-scanning: environ unreadable for \d+ processes \(attempt 1 of 4\)/);
    assert.match(diagnostics(h), /re-scan clean \(attempt [2-4] of 4\)\n\S+ launching claude\n/);
    assert.equal(h.engineLaunches().length, 1);
    assert.deepEqual(h.audit().map(({ record }) => record.status), ["running", "done"]);
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
  } finally { await h.cleanup(); }
});
