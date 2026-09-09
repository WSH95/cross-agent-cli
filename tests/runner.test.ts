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
import { acquire, lockPath, recordLockName } from "../src/locks.ts";
import type { EngineIdentity, LaunchSpec, TaskPatch, TaskRecord, TaskStatus, UpdateResult } from "../src/ledger.ts";

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

async function poll<T>(read: () => T, accepts: (value: T) => boolean, timeout = 4000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = read();
    if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for state: ${JSON.stringify(value)}`);
    await delay(10);
  }
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

function living(identity: EngineIdentity) {
  const current = proc(identity.pid);
  return current?.startTime === identity.startTime && !["Z", "X"].includes(current.state);
}

function ownedProcesses(root: string): EngineIdentity[] {
  const identities: EngineIdentity[] = [];
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
  named?: boolean; delayedImport?: boolean; refusal?: boolean; race?: string; failure?: string; leadingHyphen?: boolean;
  competitor?: "at-write" | "before-write";
} = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cross-agent-runner-"));
  const token = randomUUID();
  const adapterModule = path.join(fixtures, `runner-${token}.mjs`);
  const engineModule = path.join(fixtures, `runner-engine-${token}.mjs`);
  const children: { child: ChildProcess; closed: boolean; code: number | null; signal: NodeJS.Signals | null }[] = [];
  const record = ledger.create(root, { role: "implementer", brief: "finish T5", cwd: root, engine: "claude" });
  if (options.leadingHyphen) {
    const originalFile = path.join(root, ".cross-agent", "tasks", `${record.id}.json`);
    record.id = `-${record.id}`;
    record.resultPath = path.join(path.dirname(originalFile), `${record.id}.out`);
    record.logPath = path.join(path.dirname(originalFile), `${record.id}.ndjson`);
    fs.writeFileSync(path.join(path.dirname(originalFile), `${record.id}.json`), JSON.stringify(record));
    fs.rmSync(originalFile);
  }
  const recordFile = path.join(root, ".cross-agent", "tasks", `${record.id}.json`);
  const auditFile = path.join(root, "writes.ndjson");
  const release = path.join(root, "release");
  const importReady = path.join(root, "import-ready");
  const importRelease = path.join(root, "import-release");
  const invocation = path.join(root, "invocation.json");
  const invocations = path.join(root, "invocations");
  const descendantFile = path.join(root, "descendant.json");
  const competitorScript = path.join(root, "competitor.mjs");
  const outcomeFile = path.join(root, "competitor-outcome.json");
  const markers = { atWrite: path.join(root, "competitor-at-write"), beforeWrite: path.join(root, "settled-before-write") };
  const spec: LaunchSpec = {
    role: "implementer", brief: "finish T5", rolePrompt: "Implement this brief.", cwd: root, engine: "claude",
    model: "fixture-model", effort: "high", sandbox: "workspace-write", denyTargets: ["claude", "codex", "grok"],
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
  const result = rename(from, to);
  fs.appendFileSync(audit, JSON.stringify({ at: Date.now(), record }) + "\\n");
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
    ${options.failure === "identity" ? `fs.readFileSync = function(file, ...args) {
      if (typeof file === "string" && /^\\/proc\\/\\d+\\/stat$/.test(file) && file !== "/proc/" + process.pid + "/stat") {
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
  function start(patch: Partial<LaunchSpec> = {}, capture = false) {
    ledger.writeSpec(root, record.id, { ...spec, ...patch });
    const child = spawn(process.execPath, ["src/runner.ts", "--project", root, "--task", record.id], {
      cwd: worktree, detached: true, stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
    });
    return track(child);
  }
  function track(child: ChildProcess) {
    const tracked = { child, closed: false, code: null as number | null, signal: null as NodeJS.Signals | null };
    children.push(tracked);
    child.once("error", () => {});
    child.once("close", (code, signal) => { Object.assign(tracked, { closed: true, code, signal }); });
    return tracked;
  }
  return {
    root, record, spec, recordFile, auditFile, release, importReady, importRelease, invocation, invocations,
    adapterModule, markers, start, track,
    engineLaunches: () => (fs.existsSync(invocations) ? fs.readFileSync(invocations, "utf8").trim().split("\n").filter(Boolean) : []),
    read: () => ledger.read(root, record.id),
    audit: () => fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { at: number; record: TaskRecord }) : [],
    descendant: () => poll(
      () => fs.existsSync(descendantFile) ? JSON.parse(fs.readFileSync(descendantFile, "utf8")) as EngineIdentity & { sid: number } : null,
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
      const tracked = new Map<number, EngineIdentity>();
      for (const entry of children) {
        if (entry.child.pid && !entry.closed) {
          const identity = proc(entry.child.pid);
          if (identity) tracked.set(identity.pid, identity);
        }
      }
      const deadline = Date.now() + 4000;
      while (true) {
        // The inherited marker finds engines even if the runner died before writing identities,
        // and descendants whose parent was reaped before this finally block.
        for (const identity of ownedProcesses(root)) tracked.set(identity.pid, identity);
        const live = [...tracked.values()].filter(living);
        for (const identity of live) {
          try { process.kill(identity.pgid === identity.pid ? -identity.pgid : identity.pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        if (live.length === 0 && children.every((entry) => entry.closed)) break;
        assert.ok(Date.now() < deadline, `cleanup left processes: ${live.map((identity) => identity.pid)}`);
        await delay(10);
      }
      fs.rmSync(adapterModule, { force: true });
      fs.rmSync(engineModule, { force: true });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

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
    const { engine, adapterModule, ...expected } = { ...h.spec, env: { ...h.spec.env, HOLD: "1" } };
    assert.deepEqual(request, { ...expected, resultPath: done.resultPath, logPath: done.logPath });
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
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
    for (const invalid of [
      { ...identity, startTime: "0" }, { ...identity, pid: 0 }, { ...identity, pid: -1 },
      { ...identity, pgid: process.pid }, { ...identity, pgid: 0 }, { ...identity, pgid: 1 },
      { ...identity, pid: 1.5 }, { ...identity, startTime: "bad" },
    ]) {
      assert.equal(helpers.groupAlive(invalid), false);
      assert.equal(helpers.killGroup(invalid, "SIGKILL"), false);
    }
    assert.equal(living(identity), true);
    assert.equal(helpers.identityOf(-1), null);
    assert.equal(helpers.identityOf(2_147_483_647), null);
    // Verify the group while the leader exists, then reap only the leader.
    child.child.kill("SIGKILL");
    await poll(() => child.closed, Boolean);
    assert.equal(living(descendant), true);
    assert.equal(helpers.groupAlive(identity), true, "surviving verified descendants keep the group alive");
    assert.equal(helpers.killGroup(identity, "SIGKILL"), true);
    await poll(() => helpers.groupAlive(identity), (alive) => !alive);
    assert.equal(living(descendant), false);
    assert.equal(helpers.killGroup(identity, "SIGKILL"), false);
    await t.test("disappearing processes and unexpected errors", () => {
      const current = proc(process.pid)!;
      const missing = Object.assign(new Error("gone"), { code: "ESRCH" });
      const denied = Object.assign(new Error("denied"), { code: "EACCES" });
      const mocked = t.mock.method(process, "kill", () => { throw missing; });
      assert.equal(helpers.killGroup(current, "SIGTERM"), false);
      mocked.mock.restore();
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
    const missing = Object.assign(new Error("gone"), { code: "ESRCH" });
    const mocked = t.mock.method(process, "kill", () => { throw missing; });
    assert.equal(helpers.killGroup(identity, "SIGKILL"), false, "a group gone between the scan and the signal is not an error");
    mocked.mock.restore();
    assert.equal(living(descendant), true);
    assert.equal(helpers.killGroup(identity, "SIGKILL"), true);
    await poll(() => living(descendant), (alive) => !alive);
    assert.equal(helpers.groupAlive(identity), false);
    assert.equal(helpers.killGroup(identity, "SIGKILL"), false);
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
    await poll(h.audit, (writes) => writes.filter(({ record }) => record.lastEventAt != null).length >= 2, 5500);
    const writes = h.audit().filter(({ record }) => record.status === "running");
    assert.equal(writes.length, 3, "running acknowledgement plus two activity writes");
    for (let i = 1; i < writes.length; i++) {
      assert.ok(writes[i].at - writes[i - 1].at >= 1990, "no burst of persistence writes");
      assert.ok(writes[i].record.lastEventAt! > (writes[i - 1].record.lastEventAt ?? 0));
    }
    fs.writeFileSync(h.release, "go");
    const done = await poll(h.read, terminal);
    assert.equal(done.status, "done");
    assert.ok(done.lastEventAt! >= writes.at(-1)!.record.lastEventAt!);
  } finally { await h.cleanup(); }
});

async function orphan(h: ReturnType<typeof harness>, script: string, env: Record<string, string> = {}) {
  const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: script, ...env } });
  const running = await poll(h.read, (record) => record.status === "running");
  await poll(() => fs.readFileSync(running.logPath, "utf8"), (log) => log.includes('"working"'));
  child.child.kill("SIGKILL");
  await poll(() => child.closed, Boolean);
  assert.equal(living(running.engineIdentity!), true);
  assert.equal((await ledger.reconcile(h.root))[0]?.status, "orphaned");
  return running.engineIdentity!;
}

test("SIGKILL leaves a live engine that reconciliation orphans and cleanup terminates", async () => {
  const { terminateOrphans } = await import("../src/process.ts");
  const h = harness();
  try {
    const identity = await orphan(h, "stall");
    const changed = await terminateOrphans(h.root);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].status, "failed");
    assert.equal(changed[0].reason, "runner lost");
    await poll(() => proc(identity.pid), (current) => current === null);
  } finally { await h.cleanup(); }
});

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
    const changed = await terminateOrphans(h.root);
    assert.deepEqual(changed.map((record) => [record.id, record.status, record.reason]), [[h.record.id, "failed", "runner lost"]]);
    assert.equal(living(descendant), false);
    assert.equal(h.read().status, "failed");
    assert.deepEqual(await terminateOrphans(h.root), []);
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
    const changed = await terminateOrphans(h.root);
    assert.ok(Date.now() - before < 1500, "nothing to signal means nothing to wait for");
    assert.deepEqual(changed.map((record) => [record.id, record.status, record.reason]), [[h.record.id, "failed", "runner lost"]]);
    assert.equal(h.read().status, "failed");
    assert.equal(h.read().reason, "runner lost");
    assert.deepEqual(await terminateOrphans(h.root), []);
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
      const cancelled = await poll(h.read, terminal, 6000);
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
      const changed = await terminateOrphans(h.root);
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
    cleanup = terminateOrphans(h.root);
    await delay(150);
    assert.equal(living(identity), true);
    await delay(1650);
    assert.equal(living(identity), true, "engine survives almost all of the two-second grace period");
    assert.equal(h.read().status, "orphaned");
    const changed = await cleanup;
    assert.ok(Date.now() - before >= 2000);
    assert.deepEqual(changed.map((record) => record.id), [h.record.id]);
    assert.equal(changed[0].status, "failed");
    assert.equal(changed[0].reason, "runner lost");
    await poll(() => proc(identity.pid), (current) => current === null);
    // ledger.list returns newest first, so the stale record was inspected before the
    // engine died, while its mismatched leader still lived: skipped, not settled.
    assert.equal(ledger.read(h.root, stale.id).status, "orphaned");
    assert.equal(ledger.read(h.root, settled.id).status, "cancelled");
    // Now nothing holds that pid as process group or session: the group is dead, so
    // the stale record settles, and a further pass finds nothing left to change.
    const second = await terminateOrphans(h.root);
    assert.deepEqual(second.map((record) => [record.id, record.status, record.reason]), [[stale.id, "failed", "runner lost"]]);
    assert.deepEqual(await terminateOrphans(h.root), []);
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
    await poll(() => child.closed, Boolean, 8000);
    assert.equal(child.code, 0);
    assert.deepEqual(h.read(), external);
    assert.match(fs.readFileSync(running.logPath, "utf8"), /fixture ready/, "the engine did emit the event");
    const writes = h.audit();
    assert.equal(writes.length, 1, "the running acknowledgement is the only rename; the activity write was refused");
    assert.equal(writes[0].record.status, "running");
    assert.ok(writes[0].at <= external.updatedAt);
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
    cleanup = terminateOrphans(h.root);
    const settled = await writeAs(h.root, h.record.id, "failed", { reason: "external settlement" });
    assert.deepEqual(await cleanup, []);
    assert.deepEqual(h.read(), settled);
    assert.equal(living(identity), false);
  } finally { await h.cleanup(); await cleanup; }
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

test("a cancel that lands before acknowledgement is a cancel, not a stranger's settlement", async () => {
  const { groupAlive } = await import("../src/process.ts");
  const h = harness({ delayedImport: true });
  try {
    const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall" } });
    await poll(() => fs.existsSync(h.importReady), Boolean);
    // The server's cancel, written while the runner is still importing its adapter:
    // by the time the runner has an engine to acknowledge, the record is cancelling.
    await writeAs(h.root, h.record.id, "cancelling");
    // Holding the record lock makes the acknowledgement wait, so the engine is fully
    // up when the runner learns it was cancelled, and the settlement it writes carries
    // real evidence rather than whatever the engine managed before it was signalled.
    const held = await acquire(lockPath(h.root, recordLockName(h.record.id)), { operation: "test writer", waitSeconds: 5 });
    fs.writeFileSync(h.importRelease, "go");
    await poll(
      () => (fs.existsSync(h.record.logPath) ? fs.readFileSync(h.record.logPath, "utf8") : ""),
      (log) => log.includes('"working"'),
    );
    await held.release();
    const cancelled = await poll(h.read, terminal, 8000);
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
    assert.match(h.runnerLog(), /cancelled before acknowledgement/);
    await poll(() => child.closed, Boolean);
    assert.equal(child.code, 0);
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

test("a SIGTERM after the server has already written cancelling still settles cancelled", async () => {
  const h = harness();
  try {
    const child = h.start({ env: { ...h.spec.env, FAKE_ENGINE_SCRIPT: "stall" } });
    const running = await poll(h.read, (record) => record.status === "running");
    await poll(() => fs.readFileSync(running.logPath, "utf8"), (log) => log.includes('"working"'));
    const cancelling = await writeAs(h.root, h.record.id, "cancelling");
    child.child.kill("SIGTERM");
    const cancelled = await poll(h.read, terminal, 6000);
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
    const changed = await helpers.terminateOrphans(h.root);
    assert.deepEqual(changed.map((record) => [record.id, record.status, record.reason]), [[h.record.id, "failed", "runner lost"]]);
    assert.equal(living(identity), true, "the live process holding that pid was never signalled");
  } finally { await h.cleanup(); }
});
