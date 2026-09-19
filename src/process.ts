import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { lockWaitSeconds } from "./config.ts";
import { currentBootId, list, readOutcome, readProcessStat, update } from "./ledger.ts";
import type { EngineIdentity, ProcessIdentity, TaskPatch, TaskRecord } from "./ledger.ts";

// Process start times are ticks since boot, at Linux's fixed USER_HZ of 100, and btime
// is the wall clock of that boot. Both are constant for this boot, so both are read once.
const bootTimeMs = Number(/^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1] ?? 0) * 1000;

/** Wall-clock milliseconds at which a process with this start time began. */
function startedAt(startTime: string): number {
  return bootTimeMs + Number(startTime) * 10;
}

/**
 * How much of a second the candidate bound gives back. `btime` is the boot's wall clock
 * in whole seconds, so every start time computed from it can fall up to a second before
 * the moment the process really started — 981 ms out on the machine this was measured
 * on. An engine is spawned within its own record's second, which is the normal case, so
 * without the margin it computes as older than the record and an unreadable one is not
 * counted at all: the rule that an unreadable environment never yields `failed: launch`
 * would have its hole exactly where it matters most (bead atc-1p0).
 */
const btimeMarginMs = 1000;

function ownedByThisUser(pid: number): boolean {
  try {
    return fs.statSync(`/proc/${pid}`).uid === process.getuid!();
  } catch {
    return false;
  }
}

export function identityOf(pid: number): ProcessIdentity | null {
  const stat = readProcessStat(pid);
  return stat && /^\d+$/.test(stat.startTime) ? { pid, startTime: stat.startTime, bootId: currentBootId } : null;
}

const live = (state: string) => state !== "Z" && state !== "X";

// X is the engine leader's pid. A detached spawn made X the leader of both process
// group X and session X, and a descendant can hold pgid X only inside session X, so a
// member is any live process with pgid X and sid X. The kernel keeps X reserved while
// any process holds it as pgid or sid, so no earlier scan needs remembering.
//
// Guarantee: while any original member lives, the scan finds all of them and nothing
// foreign. Limitation: once the whole group is dead, X can be reallocated at once. A
// live replacement leader is vetoed by its start time, pgid, or sid, but a replacement
// session X whose own leader has exited leaves descendants the scan cannot tell from
// ours and would signal. No timing bound is claimed. Descendants that leave the group
// with setpgid or setsid are not members and are not signalled.
// A live process holding pgid as both its group and its session: a member of the group
// a detached spawn created, whether or not the leader itself still exists.
function hasMember(pgid: number): boolean {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readProcessStat(Number(entry));
    if (stat && stat.pgid === pgid && stat.sid === pgid && live(stat.state)) return true;
  }
  return false;
}

function inspectGroup(identity?: EngineIdentity | null): "invalid" | "reused" | "alive" | "dead" {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 1
    || !Number.isInteger(identity.pgid) || identity.pgid <= 1 || identity.pgid !== identity.pid
    || !/^\d+$/.test(identity.startTime)) return "invalid";
  // A pid, start time and group from an earlier boot can all match a live process by
  // chance, so an identity from another boot is dead rather than reused: its record
  // settles instead of being skipped for as long as that unrelated process lives.
  if (identity.bootId !== currentBootId) return "dead";
  const leader = readProcessStat(identity.pid);
  if (leader && (leader.startTime !== identity.startTime || leader.pgid !== identity.pid || leader.sid !== identity.pid)) {
    return "reused";
  }
  if (leader && live(leader.state)) return "alive";
  return hasMember(identity.pid) ? "alive" : "dead";
}

export function groupAlive(identity?: EngineIdentity | null): boolean {
  return inspectGroup(identity) === "alive";
}

export interface Skipped {
  id: string;
  reason: string;
}

export interface FoundProcess {
  pid: number;
  startTime: string;
  pgid: number;
  sid: number;
  /** pid === pgid === sid: the only shape that can be recorded as an engine identity. */
  leader: boolean;
  /**
   * This process, or one sharing its group or session. Exclusion belongs to signalling,
   * never to seeing: a caller must know such a process exists — it may be the very engine
   * a record is waiting for — and must never signal it, because that is itself.
   */
  self: boolean;
}

// Every live process whose environment carries exactly `CROSS_AGENT_TASK=<taskId>`, the
// assignment the server puts in an engine's environment (guard.childEnv). It is how a
// stranded engine is found when its runner died before writing an identity. Entries
// that cannot be read are skipped: /proc/<pid>/environ is readable only by the process
// owner, and a pid can leave between the listing and the read.
//
// This is evidence, not authority. A process that forges CROSS_AGENT_TASK can only get
// itself adopted-and-terminated or killed as a stray — the operator's own foot. It
// cannot grant anything, because authority also requires an engineIdentity the server
// itself wrote.
export interface EnvironmentScan {
  found: FoundProcess[];
  /**
   * Live processes of this user, started no earlier than `since`, whose environment
   * could not be read. Each could have been the engine, so a caller that would conclude
   * "no engine exists" must not conclude it while this is non-zero.
   */
  unreadable: number;
}

/**
 * How long a process that may not be read is given to finish starting, and the step the
 * wait takes. Between the kernel's `begin_new_exec` and `setup_new_exec` a process has
 * the new image's memory but neither its argv nor its dumpable flag, so
 * `/proc/<pid>/cmdline` is empty and `/proc/<pid>/environ` answers EACCES: for those few
 * milliseconds every detached spawn on the machine wears the exact shape of an engine
 * nobody may read, and counting one stands a launch, a cancel or an adoption down over a
 * process that is nothing yet (bead atc-s96.46).
 *
 * The budget is generous on purpose. Measured on an idle machine the window closes
 * within 40 ms; under a loaded one — a full test suite beside a process spawned every
 * 10 ms — it was seen to outlast 55 ms, because the exec itself waits on disk and each
 * 5 ms step of this wait takes 8. Overrunning costs only a stand-down that a later pass
 * retries, so the cap is where a machine in real trouble stops this scan, not where a
 * busy one does.
 *
 * It is the budget of **one scan**, not of one candidate: the wait blocks the thread of
 * whatever called the scan — a runner about to spawn, a cancel, a reconciliation pass —
 * so a sweep that met ten candidates mid-exec would otherwise hold that thread for ten
 * budgets. A candidate the deadline has already passed is judged on what it looks like
 * now, which is the same answer as before this wait existed (finding T3b-4).
 */
const execWaitMs = 250;
const execWaitStepMs = 5;

// The scan is synchronous — every caller reads its answer as a value — so the wait
// between retries blocks this thread, and `Atomics.wait` is the one sleep that does that
// without burning the CPU. The value never changes, so its buffer is made once. Only a
// plausible candidate whose argv the kernel has not published yet ever waits at all.
const execClock = new Int32Array(new SharedArrayBuffer(4));

/**
 * The argv the kernel has published for a process: empty for one still inside `execve`,
 * and `null` for one that is gone.
 */
function publishedArgv(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
}

/** A process's environment, `null` when it is gone, and `denied` when it may not be read. */
type EnvironmentRead = { text: string } | { text: null; denied: boolean };

/** A process gone between the listing and this read; anything but a permission rethrows. */
function vanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ESRCH") return true;
  if (code !== "EACCES" && code !== "EPERM") throw error;
  return false;
}

function readEnvironment(
  pid: number, before: { startTime: string }, plausible: () => boolean, deadline: number,
): EnvironmentRead {
  const gone: EnvironmentRead = { text: null, denied: false };
  try {
    return { text: fs.readFileSync(`/proc/${pid}/environ`, "utf8") };
  } catch (error) {
    if (vanished(error)) return gone;
    // Decided once, and before anything is waited for: a kernel thread and another
    // user's process are unreadable for ever, and neither could be this engine.
    if (!plausible()) return gone;
  }
  // The argv is read **before** the environment on every turn, so the read that decides
  // is the one taken after it: an argv published between the two would otherwise count a
  // process whose environment had just become readable (finding T3b-10).
  while (true) {
    const argv = publishedArgv(pid);
    // A pid that left, died, or came back as another process while this waited is no
    // engine to stand down for, whatever its environment would have said — the same
    // answer the scan gives a process that was already gone or a zombie when it came to
    // it. A process killed inside execve is the case that makes the check worth its
    // read: it keeps the empty argv and the unreadable environment for as long as its
    // zombie entry lasts.
    if (argv === null) return gone;
    const current = readProcessStat(pid);
    if (!current || !live(current.state) || current.startTime !== before.startTime) return gone;
    try {
      return { text: fs.readFileSync(`/proc/${pid}/environ`, "utf8") };
    } catch (error) {
      if (vanished(error)) return gone;
    }
    if (argv !== "" || performance.now() >= deadline) return { text: null, denied: true };
    Atomics.wait(execClock, 0, 0, execWaitStepMs);
  }
}

export function findByEnvironment(taskId: string, since = 0): EnvironmentScan {
  const assignment = `CROSS_AGENT_TASK=${taskId}`;
  const self = readProcessStat(process.pid);
  const found: FoundProcess[] = [];
  let unreadable = 0;
  // One budget for the whole sweep: what the wait blocks is the caller's thread, so it
  // is the scan that has to be bounded, not each candidate in it.
  const deadline = performance.now() + execWaitMs;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const before = readProcessStat(pid);
    if (!before || !live(before.state)) continue;
    // Unreadable environments are ordinary: another user's processes, and this user's own
    // non-dumpable ones (systemd --user, ssh-agent), can never be read. Only a process
    // that could be the engine of the task being judged is counted: this user's, no older
    // than the task, and leading its own group and session, which is the only shape a
    // detached engine spawn can have.
    const read = readEnvironment(pid, before, () => before.pgid === pid && before.sid === pid
      && startedAt(before.startTime) >= since - btimeMarginMs && ownedByThisUser(pid), deadline);
    if (read.text === null) {
      if (read.denied) unreadable++;
      continue;
    }
    const environ = read.text;
    if (!environ.split("\0").includes(assignment)) continue;
    // The identity is read again after the environment: a pid reused between the two
    // reads is a different process, and its start time would bind the record to it.
    const after = readProcessStat(pid);
    if (!after || !live(after.state) || after.startTime !== before.startTime) continue;
    found.push({
      pid, startTime: after.startTime, pgid: after.pgid, sid: after.sid,
      leader: pid === after.pgid && pid === after.sid,
      // The MCP server inherits CROSS_AGENT_TASK from the engine that started it, so a
      // reconciler can find itself, its own children, and the engine it lives inside.
      // All three are reported; what a caller may do with them is its own decision.
      self: pid === process.pid || (self !== null && (after.pgid === self.pgid || after.sid === self.sid)),
    });
  }
  return { found: found.sort((left, right) => left.pid - right.pid), unreadable };
}

/**
 * What the environment still carries for a task whose record names no engine: the leader
 * carrying `CROSS_AGENT_TASK=<id>` is the engine (the lowest pid of them, since the scan
 * is in pid order and a task has at most one), everything else carrying the id is a stray,
 * and `own` is the engine this very process runs inside — which nothing here may signal.
 * Two callers read it the same way: reconciliation adopting a stranded engine
 * (`src/reconcile.ts#adopt`) and a cancel settling a record that never acknowledged
 * (`src/reconcile.ts#judge`, `src/tasks.ts#terminate`).
 */
export function strandedEngine(taskId: string, since: number): {
  leader?: FoundProcess; strays: FoundProcess[]; own?: FoundProcess; unreadable: number;
} {
  const { found, unreadable } = findByEnvironment(taskId, since);
  const leaders = found.filter((entry) => entry.leader);
  const [leader] = leaders.filter((entry) => !entry.self);
  return {
    leader,
    // Nothing this process is part of is ever signalled: those pids are its own process,
    // its own children, or the engine whose session it lives in.
    strays: found.filter((entry) => entry !== leader && !entry.self),
    own: leaders.find((entry) => entry.self),
    unreadable,
  };
}

export function killGroup(identity: EngineIdentity, signal: NodeJS.Signals): boolean {
  if (!groupAlive(identity)) return false;
  try {
    process.kill(-identity.pgid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export interface TerminateOptions {
  /** How long SIGTERM is given before SIGKILL. */
  termGrace?: number;
  /** How long SIGKILL is given before the group is reported as surviving. */
  killGrace?: number;
}

async function waitFor(dead: () => boolean, timeout: number): Promise<boolean> {
  const deadline = performance.now() + timeout;
  while (!dead()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(20, remaining));
  }
  return true;
}

/**
 * How a termination ended. `dead` is the group gone; the other two are the two ways it
 * can still be there, and they are different repairs — a permission this process does
 * not have, and a process that took SIGKILL and stayed (bead atc-s96.31).
 */
export type TerminationOutcome = "dead" | "eperm" | "survived";

// SIGTERM, a grace, SIGKILL, a shorter grace. It answers how the group ended and never
// throws: a caller judging many records reports the survivor and carries on, and an EPERM
// or a group that will not die is that answer, not an exception.
async function terminate(pgid: number, alive: () => boolean, options: TerminateOptions): Promise<TerminationOutcome> {
  let denied = false;
  const signal = (value: NodeJS.Signals) => {
    try {
      if (alive()) process.kill(-pgid, value);
    } catch (error) {
      // ESRCH is a group that died first. EPERM is a group this process may not signal,
      // which the wait below cannot tell from one that ignored what it was sent.
      if ((error as NodeJS.ErrnoException).code === "EPERM") denied = true;
    }
  };
  if (!alive()) return "dead";
  signal("SIGTERM");
  if (await waitFor(() => !alive(), options.termGrace ?? 2000)) return "dead";
  signal("SIGKILL");
  if (await waitFor(() => !alive(), options.killGrace ?? 500)) return "dead";
  return denied ? "eperm" : "survived";
}

// A zombie is not a running process, and its parent may never reap it, so waiting for
// the /proc entry itself to disappear could wait for ever.
function stillRunning(entry: FoundProcess): boolean {
  const stat = readProcessStat(entry.pid);
  return stat !== null && stat.startTime === entry.startTime && stat.state !== "Z" && stat.state !== "X";
}

/**
 * SIGTERM, two seconds, SIGKILL, per stray: the escalation a group gets, one pid at a
 * time, for the processes carrying a task's id that are not its engine's group. It answers
 * the strays it could not signal rather than throwing, because both callers run it beside
 * a record they have already written — reconciliation after its adoption
 * (`src/reconcile.ts#adopt`) and `cancel` after the settlement — and losing that write to
 * report a failed signal would drop a settled record from the answer.
 */
export async function killStrays(strays: readonly FoundProcess[]): Promise<string[]> {
  const failed = new Map<number, string>();
  const signal = (stray: FoundProcess, value: NodeJS.Signals) => {
    // Verified immediately before the signal, as killGroup verifies a group: a pid that
    // left between the scan and here can already belong to an unrelated process.
    if (!stillRunning(stray)) return;
    try {
      process.kill(stray.pid, value);
      failed.delete(stray.pid);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (failure.code !== "ESRCH") failed.set(stray.pid, `stray ${stray.pid} could not be signalled: ${failure.message}`);
    }
  };
  for (const stray of strays) signal(stray, "SIGTERM");
  // The same wait the group ladder uses, for the same reason: a grace measured once,
  // polled in small steps, and no longer than it says.
  await waitFor(() => !strays.some(stillRunning), 2000);
  for (const stray of strays) signal(stray, "SIGKILL");
  return [...failed.values()];
}

/** The verified group of a recorded engine identity. */
export function terminateGroup(identity: EngineIdentity, options: TerminateOptions = {}): Promise<TerminationOutcome> {
  return terminate(identity.pgid, () => groupAlive(identity), options);
}

// The group a detached spawn created, known only by the pid it made the group and session
// id — the case where the engine's identity could never be captured. The kernel keeps that
// id reserved while any member holds it, so the members are exactly what the scan finds.
export async function terminateGroupByPid(pid: number, options: TerminateOptions = {}): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  return await terminate(pid, () => hasMember(pid), options) === "dead";
}

/**
 * A recorded engine group that contains this process. The MCP server is started by its
 * engine and lives in that engine's session (`src/guard.ts#childEnv`), so terminating
 * that group ends this process too — the same rule the scan marks a `FoundProcess` self
 * by, read from the identity a record carries rather than from a scan.
 */
export function ownGroup(identity?: EngineIdentity | null): boolean {
  if (!identity) return false;
  const self = readProcessStat(process.pid);
  return self !== null && (identity.pgid === self.pgid || identity.pgid === self.sid);
}

/**
 * The records of a pass with the ones naming this process's own engine group last. The
 * engine of such a record is an orphan and should die, and this process dies with it, so
 * everything the pass can settle is settled before it does (bead atc-s96.32).
 */
export function selfLast<T extends { engineIdentity?: EngineIdentity | null }>(records: readonly T[]): T[] {
  const marked = records.map((record) => ({ record, own: ownGroup(record.engineIdentity) }));
  return [...marked.filter((entry) => !entry.own), ...marked.filter((entry) => entry.own)].map((entry) => entry.record);
}

/**
 * What a record whose runner is gone and whose engine group is dead settles as. `runner
 * lost` is the truth when nothing else is known, but the runner may have recorded the
 * engine's verdict before a terminal write it was no longer allowed to make: an adoption
 * that beat that write leaves the record `orphaned` and the runner settling nothing
 * (`src/ledger.ts#TaskOutcome`, `src/runner.ts`). That record is the evidence, and the
 * result file is not — the pipeline writes an engine's last word there whether the run
 * succeeded or failed, so its text proves only that something ended (bead atc-s96.30).
 * With no outcome recorded the result file is **named** rather than read, so an operator
 * can find what is there without the ledger calling it a success.
 */
export function settlement(projectRoot: string, record: TaskRecord): TaskPatch {
  const outcome = readOutcome(projectRoot, record);
  if (outcome) {
    const evidence = { exitCode: outcome.exitCode, sessionId: outcome.sessionId, truncated: outcome.truncated ?? false };
    return outcome.kind === "done"
      ? { status: "done", ...evidence, reason: "settled by reconciliation from the runner's recorded outcome" }
      : { status: "failed", ...evidence, reason: outcome.reason ?? "settled by reconciliation from the runner's recorded outcome" };
  }
  let result = "";
  try {
    result = fs.readFileSync(record.resultPath, "utf8");
  } catch { /* No result file either: the lost runner is the whole story. */ }
  return {
    status: "failed",
    reason: result.trim() === "" ? "runner lost" : `runner lost; result text present at ${record.resultPath}`,
  };
}

// Each call judges every orphaned record on the current kernel state: an invalid or
// reused identity is left alone, a live group is terminated, and a dead group, one
// with no live member, is settled. A stale identity is therefore skipped while its
// pid lives under another identity and settled once that pid is gone, because the
// pid could only be reallocated after the original group had died.
export async function terminateOrphans(projectRoot: string): Promise<{ changed: TaskRecord[]; skipped: Skipped[] }> {
  const changed: TaskRecord[] = [];
  const skipped: Skipped[] = [];
  // One read of the project's waiting rule for the whole pass, as reconciliation does.
  const waitSeconds = lockWaitSeconds(projectRoot);
  // A record naming this process's own engine group is judged last: terminating that
  // group kills this pass with it, and the records it could have settled would be left
  // for another server for no reason (design section 2).
  for (const record of selfLast(list(projectRoot, "orphaned"))) {
    const identity = record.engineIdentity;
    const state = inspectGroup(identity);
    // A record left orphaned on purpose is not silently left: an operator reading a task
    // that never settles has to be told which identity cleanup would not act on.
    if (!identity) { skipped.push({ id: record.id, reason: "no engine identity" }); continue; }
    if (state === "invalid" || state === "reused") { skipped.push({ id: record.id, reason: `engine identity ${state}` }); continue; }
    if (state === "alive") {
      const outcome = await terminateGroup(identity);
      if (outcome !== "dead") {
        skipped.push({ id: record.id, reason: `engine group ${identity.pgid} did not terminate: ${outcome}` });
        continue;
      }
    }
    // A group this pass had to kill did not end on its own, whatever anyone recorded
    // beside the record: the engine was still running when the pass met it, and settling
    // it from a runner's outcome would report a task this pass has just ended as one that
    // finished (bead atc-s96.30, finding T3b-2).
    const patch: TaskPatch = state === "alive"
      ? { status: "failed", reason: "runner lost; engine group terminated" }
      : settlement(projectRoot, record);
    // A record settled by another writer since the listing is refused: not changed.
    const result = await update(projectRoot, record.id, patch, Date.now(), { unlessTerminal: true, waitSeconds });
    if (result.applied) changed.push(result.record);
  }
  return { changed, skipped };
}

/**
 * Why a launch for this task must not spawn, or null when nothing stands in its way. It is
 * `adopt`'s rule read from the other side (`src/reconcile.ts`): a `self` entry is this
 * process, its own group or its own session — a runner the server started carries the
 * assignment in its own environment, and the `flock` child holding its lock inherits it —
 * so none of them is an engine, while anything else carrying the id is one an earlier
 * runner left for reconciliation to adopt. An environment that could not be read is
 * answered the same way, because one of those could be that engine. The asymmetry is the
 * reason: standing down costs one failed delegate a lead can see and retry, and spawning a
 * second engine costs concurrent work in one worktree that no record accounts for.
 */
export function foreignEngine(scan: EnvironmentScan): string | null {
  // The scan is in pid order, so this is the lowest-pid foreign process — the same one
  // `adopt` would take as the engine, when it is a leader.
  const foreign = scan.found.find((entry) => !entry.self);
  if (foreign) return `engine ${foreign.pid} already carries task`;
  if (scan.unreadable > 0) return `environ unreadable for ${scan.unreadable} processes`;
  return null;
}
