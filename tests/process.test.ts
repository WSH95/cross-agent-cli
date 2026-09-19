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
import { currentBootId, readProcessStat } from "../src/ledger.ts";
import type { EngineIdentity } from "../src/ledger.ts";
import { findByEnvironment, foreignEngine, groupAlive, terminateGroup, terminateGroupByPid } from "../src/process.ts";
import type { FoundProcess } from "../src/process.ts";
import { poll, pollDeadlineMs } from "./helpers/project.ts";

const worktree = fileURLToPath(new URL("../", import.meta.url));

/**
 * `fs.readFileSync`, with `answer` consulted first and one thing changed under it: a
 * process this test did not start, whose environment may not be read, reads as empty.
 * `unreadable` is otherwise a property of the whole machine rather than of this test —
 * every detached spawn on it wears the shape of a plausible candidate nobody may read
 * for the few milliseconds it spends inside execve — and no count could then be
 * attributed to the processes the test made (bead atc-s96.33). `ours` names the pids
 * whose real denial the scan must still see.
 */
function scanReads(
  t: TestContext,
  answer: (target: string, real: () => string) => string | undefined,
  ours: (pid: number) => boolean = () => false,
): { restore(): void } {
  const module = fs as { readFileSync: typeof fs.readFileSync };
  const original = fs.readFileSync;
  const real = (target: fs.PathOrFileDescriptor, options?: unknown) =>
    (original as (target: fs.PathOrFileDescriptor, options?: unknown) => string)(target, options);
  // A plain swap rather than `t.mock.method`: one scan reads every environment on the
  // machine, and a mock that recorded each call would hold all of them in memory.
  module.readFileSync = ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    const answered = typeof target === "string" ? answer(target, () => real(target, options)) : undefined;
    if (answered !== undefined) return answered;
    const environ = typeof target === "string" ? /^\/proc\/(\d+)\/environ$/.exec(target) : null;
    if (environ === null) return real(target, options);
    try {
      return real(target, options);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A stranger that may not be read reads as an environment carrying nothing: seen,
      // and never counted. ENOENT still means gone, which is the scan's own case.
      if ((code === "EACCES" || code === "EPERM") && !ours(Number(environ[1]))) return "";
      throw error;
    }
  }) as typeof fs.readFileSync;
  const restore = () => { module.readFileSync = original; };
  t.after(restore);
  return { restore };
}

/** Independent of the implementation, so cleanup works even when the code under test does not. */
function running(pid: number): boolean {
  const stat = readProcessStat(pid);
  return stat !== null && stat.state !== "Z" && stat.state !== "X";
}

// A detached node process — a leader of its own group and session, as a spawned engine
// is — which optionally spawns one plain child that stays inside that group.
const fixture = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (process.env.CHILD_PID_FILE) {
  const env = { ...process.env };
  delete env.CHILD_PID_FILE;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env });
  fs.writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));
}
setInterval(() => {}, 1000);
`;

// The churn a busy machine makes: a separate process spawning a detached leader every
// `stormStepMs`, each carrying the task id and each inside execve for the first
// milliseconds of its life. Every child is appended to a file with the start time it was
// spawned at, so the test ends what it started — and only what it started, since a pid
// it has left can already belong to something else on a machine spawning this fast.
const storm = `
import fs from "node:fs";
import { spawn } from "node:child_process";
const [pidFile, taskId, lifetimeMs, stepMs, capMs] = process.argv.slice(2);
// This is the one fixture in the suite that makes processes faster than it makes
// anything else, so it ends itself: a test run killed between the spawn and the sweep
// would otherwise leave it spawning a detached child every few milliseconds for ever.
setTimeout(() => process.exit(0), Number(capMs));
setInterval(() => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, " + lifetimeMs + ")"],
    { detached: true, stdio: "ignore", env: { ...process.env, CROSS_AGENT_TASK: taskId } });
  child.once("error", () => {});
  child.unref();
  if (child.pid === undefined) return;
  try {
    const stat = fs.readFileSync("/proc/" + child.pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\\s+/);
    fs.appendFileSync(pidFile, child.pid + " " + fields[19] + "\\n");
  } catch { /* Gone before it could be recorded: there is nothing left to clean up. */ }
}, Number(stepMs));
`;

/**
 * The storm's shape. A child lives `stormChildMs` and one starts every `stormStepMs`, so
 * about six are alive at a time: enough for the scans below to meet children at every
 * stage of their start, and few enough that this test is not itself the reason another
 * file's launch stands down — a process inside execve is a candidate nobody can read to
 * every scan on the machine, not only to these (`src/process.ts#foreignEngine`). Neither
 * number is a bound an assertion rests on; what the rounds below need is to have met
 * `stormChildrenMet` children, and how long that takes is the machine's business.
 */
const stormChildMs = 120;
const stormStepMs = 20;
const stormChildrenMet = 20;
const stormRounds = 50;
/** Far past this test, and short enough that a run killed mid-storm leaves nothing for long. */
const stormCapMs = 60_000;

function processes(t: TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cross-agent-process-"));
  const tracked: { pid: number; leader: boolean; startTime: string }[] = [];
  t.after(async () => {
    const deadline = Date.now() + pollDeadlineMs;
    while (true) {
      // By identity, never by pid alone: this file spawns and kills enough processes —
      // the storm beside it spawns one every 20 ms — that a pid one of them has left can
      // belong to something else by the time the sweep reaches it, and signalling a group
      // by that number would be signalling a stranger's. The start time is what tells
      // them apart.
      const alive = tracked.filter((entry) => readProcessStat(entry.pid)?.startTime === entry.startTime
        && running(entry.pid));
      for (const entry of alive) {
        try { process.kill(entry.leader ? -entry.pid : entry.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      if (alive.length === 0) break;
      assert.ok(Date.now() < deadline, `cleanup left processes: ${alive.map((entry) => entry.pid)}`);
      await delay(10);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    leader(env: NodeJS.ProcessEnv = {}, script = fixture): { pid: number; identity: EngineIdentity; child: ChildProcess } {
      const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore", env });
      child.once("error", () => {});
      const pid = child.pid!;
      const stat = readProcessStat(pid)!;
      tracked.push({ pid, leader: true, startTime: stat.startTime });
      return { pid, identity: { pid, startTime: stat.startTime, pgid: pid, bootId: currentBootId }, child };
    },
    async member(pidFile: string): Promise<number> {
      const text = await poll(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : ""), (value) => value.length > 0);
      const pid = Number(text);
      // A member already gone is nothing to clean up, and its pid is no longer its own.
      const stat = readProcessStat(pid);
      if (stat) tracked.push({ pid, leader: false, startTime: stat.startTime });
      return pid;
    },
    async reap(leader: { pid: number; child: ChildProcess }): Promise<void> {
      leader.child.kill("SIGKILL");
      await once(leader.child, "close");
      await poll(() => readProcessStat(leader.pid), (stat) => stat === null);
    },
  };
}

test("the environment scan finds a task's own processes, leaders apart from strays", async (t) => {
  const zoo = processes(t);
  const taskId = `task-${process.pid}-${Date.now()}`;
  const recent = Date.now() - 1000;
  const pidFile = path.join(zoo.root, "stray.pid");
  // A detached leader carrying the task id and a plain child of it carrying the same id:
  // the two shapes reconciliation must tell apart, one adopted and one killed.
  const leader = zoo.leader({ CROSS_AGENT_TASK: taskId, CHILD_PID_FILE: pidFile });
  const stray = await zoo.member(pidFile);
  const { found, unreadable } = await poll(() => findByEnvironment(taskId, recent), (scan) => scan.found.length === 2);

  assert.equal(unreadable, 0, "nothing this user started since the task could not be read");
  assert.deepEqual(found.find((entry) => entry.pid === leader.pid), {
    pid: leader.pid, startTime: readProcessStat(leader.pid)!.startTime,
    pgid: leader.pid, sid: leader.pid, leader: true, self: false,
  });
  assert.deepEqual(found.find((entry) => entry.pid === stray), {
    pid: stray, startTime: readProcessStat(stray)!.startTime, pgid: leader.pid, sid: leader.pid, leader: false, self: false,
  });
  assert.deepEqual(findByEnvironment(`${taskId}-other`, recent).found, [], "another task's id finds nothing");
  assert.deepEqual(findByEnvironment(taskId.slice(0, 8), recent).found, [], "the assignment must match whole, not by prefix");

  process.kill(-leader.pid, "SIGKILL");
  await poll(() => findByEnvironment(taskId, recent).found, (entries) => entries.length === 0);
});

test("the environment scan marks what shares the scanner's own group or session", async (t) => {
  const zoo = processes(t);
  const taskId = `self-${process.pid}-${Date.now()}`;
  const outcome = path.join(zoo.root, "scan.json");
  const pidFile = path.join(zoo.root, "engine.pid");
  // The scanner carries the task id itself, as an MCP server that inherited it from its
  // engine does, and so does a plain child of it. Every match is reported — a reconciler
  // that could not see an engine would settle its record over a live process — but the
  // ones sharing the scanner's own group or session are marked, because those are the
  // ones it must never signal.
  const script = `
import fs from "node:fs";
import { spawn } from "node:child_process";
import { findByEnvironment } from ${JSON.stringify(pathToFileURL(path.join(worktree, "src", "process.ts")).href)};
const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const engine = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
engine.unref();
fs.writeFileSync(process.argv[2], String(engine.pid));
// Both children are still inside execve for a moment after the spawn returns, and how
// long that moment is belongs to the machine. The scan that answers is the first one
// that has met all three; the deadline below is where a machine in trouble gives up.
const deadline = Date.now() + ${pollDeadlineMs};
let scan = findByEnvironment(process.env.CROSS_AGENT_TASK);
while (scan.found.length < 3 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  scan = findByEnvironment(process.env.CROSS_AGENT_TASK);
}
fs.writeFileSync(process.argv[3], JSON.stringify({ ...scan, self: process.pid, sibling: sibling.pid, engine: engine.pid }));
sibling.kill("SIGKILL");
`;
  const file = path.join(zoo.root, "scanner.mjs");
  fs.writeFileSync(file, script);
  const scanner = spawn(process.execPath, [file, pidFile, outcome], {
    stdio: "ignore", env: { ...process.env, CROSS_AGENT_TASK: taskId },
  });
  const engine = Number(await poll(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : ""), (text) => text.length > 0));
  t.after(async () => {
    try { process.kill(-engine, "SIGKILL"); } catch { /* already gone */ }
    scanner.kill("SIGKILL");
    await poll(() => running(engine), (alive) => !alive);
  });
  const [code] = await once(scanner, "close");
  assert.equal(code, 0, "the scanner survived its own scan");
  const result = JSON.parse(fs.readFileSync(outcome, "utf8")) as {
    found: { pid: number; self: boolean; leader: boolean }[]; unreadable: number;
    self: number; sibling: number; engine: number;
  };
  const byPid = new Map(result.found.map((entry) => [entry.pid, entry]));
  assert.deepEqual([...byPid.keys()].sort(), [result.self, result.sibling, result.engine].sort(),
    "everything carrying the id is seen, the scanner included");
  assert.equal(byPid.get(result.self)!.self, true);
  assert.equal(byPid.get(result.sibling)!.self, true, "a child in the scanner's own group is the scanner's own");
  assert.equal(byPid.get(result.engine)!.self, false);
  assert.equal(byPid.get(result.engine)!.leader, true);
});

test("the environment scan reports what it could not read and binds each match to one identity", async (t) => {
  const zoo = processes(t);
  const taskId = `bound-${process.pid}-${Date.now()}`;
  const since = Date.now() - 1000;
  const leader = zoo.leader({ CROSS_AGENT_TASK: taskId });
  await poll(() => findByEnvironment(taskId, since).found, (found) => found.length === 1);
  const environ = `/proc/${leader.pid}/environ`;
  const stat = `/proc/${leader.pid}/stat`;

  // A process this scan may not read could be the engine it is looking for, so it is
  // counted rather than passed over in silence. The count is exactly this leader:
  // `scanReads` answers for the rest of the machine, which is starting processes of its
  // own throughout this run.
  const denied = scanReads(t, (target) => {
    if (target === environ) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return undefined;
  });
  const blind = findByEnvironment(taskId, since);
  const older = findByEnvironment(taskId, Date.now() + 60_000);
  denied.restore();
  assert.deepEqual(blind.found, []);
  assert.equal(blind.unreadable, 1, "one process of ours, started since the task, could not be judged");
  assert.equal(older.unreadable, 0,
    "the bound is what makes the count mean anything: a process older than the task is not its engine");

  // A pid reused between the two stats is a different process: the match is dropped
  // rather than recorded against a foreign start time.
  let stats = 0;
  const reused = scanReads(t, (target, real) => {
    if (target !== stat) return undefined;
    const text = real();
    if (++stats !== 2) return text;
    const head = text.slice(0, text.lastIndexOf(")") + 1);
    const fields = text.slice(text.lastIndexOf(")") + 1).trim().split(/\s+/);
    fields[19] = String(BigInt(fields[19]) + 1n);
    return `${head} ${fields.join(" ")}\n`;
  });
  const raced = findByEnvironment(taskId, since);
  reused.restore();
  assert.equal(stats, 2, "the identity is read before the environment and again after it");
  assert.deepEqual(raced.found, []);
  assert.equal(raced.unreadable, 0);

  assert.deepEqual(findByEnvironment(taskId, since).found.map((entry) => entry.pid), [leader.pid], "the mocks changed nothing else");
});

test("the unreadable-candidate bound allows for the second btime rounds away", async (t) => {
  const zoo = processes(t);
  const taskId = `margin-${process.pid}-${Date.now()}`;
  const leader = zoo.leader({ CROSS_AGENT_TASK: taskId });
  await poll(() => findByEnvironment(taskId, 0).found, (found) => found.length === 1);
  // A start time is ticks since boot on a clock whose zero `/proc/stat` gives in whole
  // seconds, so the moment it computes can fall up to a second before the real one. An
  // engine is spawned within its own record's second — the normal case — and without the
  // margin it computes as older than the record and is not counted at all.
  const bootTimeMs = Number(/^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))![1]) * 1000;
  const startedAt = bootTimeMs + Number(readProcessStat(leader.pid)!.startTime) * 10;
  const denied = scanReads(t, (target) => {
    if (target === `/proc/${leader.pid}/environ`) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return undefined;
  });
  const within = findByEnvironment(taskId, startedAt + 900);
  const beyond = findByEnvironment(taskId, startedAt + 60_000);
  denied.restore();

  assert.equal(within.unreadable, 1, "a candidate the rounding put just before the record is still counted");
  assert.equal(beyond.unreadable, 0, "and the bound still means something past the margin");
});

// A detached spawn leads its own group and session before it has execed, and for the few
// milliseconds it spends inside execve its cmdline is empty and its environ answers
// EACCES: exactly the shape of a plausible engine this scan may not read. Counting one
// would make every machine that starts processes look as if it held an engine nobody can
// see, and every launch, cancel and adoption on it stands down (bead atc-s96.46).
test("the environment scan does not count a process still inside exec as unreadable", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cross-agent-storm-"));
  const taskId = `storm-${process.pid}-${Date.now()}`;
  const since = Date.now() - 1000;
  const pidFile = path.join(root, "storm.pids");
  fs.writeFileSync(pidFile, "");
  const file = path.join(root, "storm.mjs");
  fs.writeFileSync(file, storm);
  const spawned = (): { pid: number; startTime: string }[] => {
    try {
      return fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean)
        .map((line) => ({ pid: Number(line.split(" ")[0]), startTime: line.split(" ")[1] }));
    } catch { return []; }
  };
  // The churn runs in its own process, so the scans below meet children at every stage of
  // their start rather than only in the gaps between spawns of their own.
  const spawner = spawn(process.execPath,
    [file, pidFile, taskId, String(stormChildMs), String(stormStepMs), String(stormCapMs)],
    { detached: true, stdio: "ignore" });
  spawner.once("error", () => {});
  t.after(async () => {
    try { process.kill(-spawner.pid!, "SIGKILL"); } catch { /* already gone */ }
    const deadline = Date.now() + pollDeadlineMs;
    while (true) {
      // Signalled by the identity that was recorded, never by a pid alone: this storm
      // leaves pids behind faster than anything else in the suite, and a group killed by
      // number could be a stranger's by the time the sweep reaches it. The start time is
      // what tells them apart here; the project sweep in `tests/helpers/project.ts` tells
      // them apart by the environment marker its own processes carry, which this storm's
      // children do not.
      const alive = spawned().flatMap((child) => {
        const stat = readProcessStat(child.pid);
        return stat !== null && stat.startTime === child.startTime && stat.state !== "Z" && stat.state !== "X"
          ? [{ ...child, pgid: stat.pgid }] : [];
      });
      for (const child of alive) {
        try { process.kill(child.pgid === child.pid ? -child.pid : child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      if (alive.length === 0) break;
      assert.ok(Date.now() < deadline, `cleanup left processes: ${alive.map((child) => child.pid)}`);
      await delay(10);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  await poll(() => spawned().length, (count) => count >= 2);
  // The scans start once the storm is one the scan can see, rather than after a guess at
  // how long the spawner needs: from here every round meets children at some stage of
  // their start, which is what this test is made of.
  await poll(() => findByEnvironment(taskId, since).found.length, (count) => count >= 1);

  // What this count may include is the storm's own children and nothing else. Every other
  // process on the machine reads as an environment carrying nothing, because the suite
  // beside this test is starting processes that wear the same shape for the few
  // milliseconds they spend inside execve, and a count of those could not be attributed.
  const originalRead = fs.readFileSync;
  const ppidOf = (pid: number): number | null => {
    try {
      const stat = (originalRead as (target: string, options: string) => string)(`/proc/${pid}/stat`, "utf8");
      return Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[1]);
    } catch { return null; }
  };
  const bounded = scanReads(t, () => undefined, (pid) => ppidOf(pid) === spawner.pid);
  // The scan's exec budget is measured on this clock, and with it stopped the budget
  // cannot expire: a candidate is then counted only when the kernel has published its
  // argv and its environment still cannot be read, which is the case this test denies
  // ever happens to a child inside execve. How long an execve takes on a loaded machine
  // is nobody's claim to make, and the budget's own size is the business of the test
  // beside this one ("one scan waits once for everything it cannot read"). Each wait
  // still ends: a storm child either finishes its exec or dies inside `stormChildMs`,
  // and a candidate that left is gone rather than unreadable.
  //
  // The freeze is process-wide for as long as the rounds run — `src/process.ts#waitFor`
  // and node:test's own durations read the same clock — so nothing inside it may wait on
  // an elapsed time, and the `finally` below puts the real clock back whatever happens.
  // The rounds themselves only scan and `delay`, which is a timer and not this clock.
  const clock = performance as { now: () => number };
  const realNow = clock.now.bind(performance);
  clock.now = () => 0;
  let unreadable = 0;
  let seen = 0;
  try {
    for (let round = 0; round < stormRounds; round++) {
      const scan = findByEnvironment(taskId, since);
      unreadable += scan.unreadable;
      seen += scan.found.length;
      await delay(stormStepMs / 2);
    }
  } finally {
    clock.now = realNow;
    bounded.restore();
  }
  assert.ok(seen >= stormChildrenMet,
    `the scans ran while the storm did: ${seen} children carrying the id were read in ${stormRounds} rounds`);
  assert.equal(unreadable, 0,
    "a child still inside execve is retried, never counted as an engine this scan may not read");
});

test("one scan waits once for everything it cannot read, not once for each", async (t) => {
  const zoo = processes(t);
  const taskId = `budget-${process.pid}-${Date.now()}`;
  const since = Date.now() - 1000;
  // Eight processes that look for ever like the one shape this scan waits for: a
  // plausible candidate whose argv the kernel has not published. The wait is the
  // server's own thread, so it belongs to the scan and not to each candidate it meets
  // (finding T3b-4).
  const leaders = Array.from({ length: 8 }, () => zoo.leader({ CROSS_AGENT_TASK: taskId }));
  await poll(() => findByEnvironment(taskId, since).found, (found) => found.length === 8);
  const denied = new Set(leaders.map((leader) => `/proc/${leader.pid}/environ`));
  const starting = new Set(leaders.map((leader) => `/proc/${leader.pid}/cmdline`));
  const mocked = scanReads(t, (target) => {
    if (denied.has(target)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    if (starting.has(target)) return "";
    return undefined;
  });
  const started = performance.now();
  const scan = findByEnvironment(taskId, since);
  const elapsed = performance.now() - started;
  mocked.restore();

  assert.equal(scan.unreadable, 8, "each of them is a candidate this scan could not read");
  assert.ok(elapsed < 1200, `one budget for the scan, not one per candidate: ${Math.round(elapsed)} ms for eight`);
});

test("a candidate is re-verified on every retry, and an environment that opens is read", async (t) => {
  const zoo = processes(t);
  const taskId = `retry-${process.pid}-${Date.now()}`;
  const since = Date.now() - 1000;
  const leader = zoo.leader({ CROSS_AGENT_TASK: taskId });
  await poll(() => findByEnvironment(taskId, since).found, (found) => found.length === 1);
  const environ = `/proc/${leader.pid}/environ`;
  const cmdline = `/proc/${leader.pid}/cmdline`;
  const stat = `/proc/${leader.pid}/stat`;

  // The argv is published while the scan waits, and the environment opens with it: the
  // argv is read before the environment on every turn, so the read that decides is the
  // one taken after it (finding T3b-10).
  let denials = 0;
  let starting = 0;
  const opening = scanReads(t, (target) => {
    if (target === environ && ++denials <= 2) throw Object.assign(new Error("denied"), { code: "EACCES" });
    if (target === cmdline && ++starting <= 2) return "";
    return undefined;
  });
  const opened = findByEnvironment(taskId, since);
  opening.restore();
  assert.deepEqual(opened.found.map((entry) => entry.pid), [leader.pid], "the engine it waited for is the engine it found");
  assert.equal(opened.unreadable, 0);

  // A pid that left and came back as something else during the wait is not this scan's
  // candidate, whatever its environment says now: the identity is read again, and a
  // start time that moved ends the wait rather than the count (finding R-5).
  let stats = 0;
  const reused = scanReads(t, (target, real) => {
    if (target === environ) throw Object.assign(new Error("denied"), { code: "EACCES" });
    if (target === cmdline) return "";
    if (target !== stat) return undefined;
    const text = real();
    if (++stats < 2) return text;
    const head = text.slice(0, text.lastIndexOf(")") + 1);
    const fields = text.slice(text.lastIndexOf(")") + 1).trim().split(/\s+/);
    fields[19] = String(BigInt(fields[19]) + 1n);
    return `${head} ${fields.join(" ")}\n`;
  });
  const raced = findByEnvironment(taskId, since);
  reused.restore();
  assert.equal(raced.unreadable, 0, "a pid reused while the scan waited is nobody's engine");
});

// A leader that answers SIGTERM by ignoring it, so an escalation has to be seen through.
// It says so only once the handler is installed: a SIGTERM before that is the kernel's
// default and would kill it outright.
const stubbornFixture = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(process.env.READY_FILE, "ready");
setInterval(() => {}, 1000);
`;

test("the shared ladder at a zero grace sends SIGTERM and SIGKILL one after the other", async (t) => {
  const zoo = processes(t);
  const ready = path.join(zoo.root, "stubborn.ready");
  const stubborn = zoo.leader({ READY_FILE: ready }, stubbornFixture);
  await poll(() => fs.existsSync(ready), Boolean);
  // The runner's identity branch used to send SIGKILL alone at a zero grace; the shared
  // ladder always opens with SIGTERM and escalates at once, and the two differ only in
  // the signal a process that answers SIGTERM sees first (finding T3b-5).
  const signals: (string | number | undefined)[] = [];
  const kill = process.kill.bind(process) as (pid: number, signal?: string | number) => true;
  const mocked = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid === -stubborn.pid) signals.push(signal);
    return kill(pid, signal);
  });
  const started = performance.now();
  const outcome = await terminateGroup(stubborn.identity, { termGrace: 0, killGrace: 500 });
  const elapsed = performance.now() - started;
  mocked.mock.restore();

  assert.equal(outcome, "dead");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(elapsed < 1000, `a zero grace waits for nothing before the kill: ${Math.round(elapsed)} ms`);
  assert.equal(groupAlive(stubborn.identity), false);
});

// The judgement a runner makes about a scan, taken over synthetic ones: the shapes below
// are what the scan reports, and no process is needed to decide what they mean.
test("foreignEngine names the engine or the blind spot a launch must stand down for", () => {
  const entry = (pid: number, self: boolean): FoundProcess =>
    ({ pid, startTime: "4200", pgid: pid, sid: pid, leader: true, self });

  assert.equal(foreignEngine({ found: [], unreadable: 0 }), null, "nothing carries the id: launch");
  // A runner the server spawned with `guard.childEnv` carries the assignment itself, and
  // the flock child holding runner-<id>.lock inherits it and shares its session. Counting
  // either would have every launch stand down for an engine that is the runner.
  assert.equal(foreignEngine({ found: [entry(1101, true), entry(1102, true)], unreadable: 0 }), null,
    "this runner and its own children are not an engine");

  // Anything else carrying the id is an earlier runner's engine, which reconciliation
  // adopts. The pid is what makes the log line worth reading.
  const foreign = foreignEngine({ found: [entry(1101, true), entry(2202, false)], unreadable: 0 });
  assert.match(foreign!, /\b2202\b/);
  assert.doesNotMatch(foreign!, /\b1101\b/);

  // An environment that could not be read could have been the engine, so it is the same
  // answer as finding one: `adopt` refuses to conclude absence from it, and so does this.
  assert.match(foreignEngine({ found: [], unreadable: 3 })!, /\b3\b/);
  assert.match(foreignEngine({ found: [entry(1101, true)], unreadable: 1 })!, /\b1\b/);
  // Both at once: the engine it can name beats the count it cannot.
  assert.match(foreignEngine({ found: [entry(2202, false)], unreadable: 1 })!, /\b2202\b/);
});

test("terminateGroup escalates, names what it could not end, and never throws", async (t) => {
  const zoo = processes(t);
  const graces = { termGrace: 200, killGrace: 200 };
  assert.equal(await terminateGroup({ pid: 2_147_483_647, startTime: "0", pgid: 2_147_483_647, bootId: currentBootId }, graces), "dead",
    "a group with no live member needs nothing signalled");

  const stubborn = zoo.leader();
  const denied = Object.assign(new Error("not permitted"), { code: "EPERM" });
  const refused = t.mock.method(process, "kill", () => { throw denied; });
  const eperm = await terminateGroup(stubborn.identity, graces);
  refused.mock.restore();
  assert.equal(eperm, "eperm", "a group it may not signal is reported, not thrown");
  assert.equal(groupAlive(stubborn.identity), true);

  // The other failure: every signal was delivered and the group is still there. An
  // operator reading a record that would not settle has to be told which of the two it
  // was, because a permission and a process that will not die are different repairs.
  const swallowed = t.mock.method(process, "kill", () => true);
  const survived = await terminateGroup(stubborn.identity, graces);
  swallowed.mock.restore();
  assert.equal(survived, "survived");
  assert.equal(groupAlive(stubborn.identity), true);

  assert.equal(await terminateGroup(stubborn.identity, graces), "dead");
  assert.equal(groupAlive(stubborn.identity), false);
});

test("terminateGroupByPid ends the group a detached spawn made when no identity was captured", async (t) => {
  const zoo = processes(t);
  const pidFile = path.join(zoo.root, "member.pid");
  const leader = zoo.leader({ CHILD_PID_FILE: pidFile });
  const member = await zoo.member(pidFile);
  // The identity was never captured, and the leader is already gone: all that is left is
  // the pid a detached spawn made the group and session id, which the kernel keeps
  // reserved while any member holds it.
  await zoo.reap(leader);
  assert.equal(running(member), true);
  assert.equal(await terminateGroupByPid(leader.pid, { termGrace: 2000, killGrace: 500 }), true);
  assert.equal(running(member), false);
  assert.equal(await terminateGroupByPid(leader.pid, { termGrace: 200, killGrace: 200 }), true, "nothing left to signal");
});
