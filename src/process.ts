import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { lockWaitSeconds } from "./config.ts";
import { currentBootId, list, readProcessStat, update } from "./ledger.ts";
import type { EngineIdentity, ProcessIdentity, TaskRecord } from "./ledger.ts";

// Process start times are ticks since boot, at Linux's fixed USER_HZ of 100, and btime
// is the wall clock of that boot. Both are constant for this boot, so both are read once.
const bootTimeMs = Number(/^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1] ?? 0) * 1000;

/** Wall-clock milliseconds at which a process with this start time began. */
function startedAt(startTime: string): number {
  return bootTimeMs + Number(startTime) * 10;
}

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

export function findByEnvironment(taskId: string, since = 0): EnvironmentScan {
  const assignment = `CROSS_AGENT_TASK=${taskId}`;
  const self = readProcessStat(process.pid);
  const found: FoundProcess[] = [];
  let unreadable = 0;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const before = readProcessStat(pid);
    if (!before || !live(before.state)) continue;
    let environ: string;
    try {
      environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(code!)) throw error;
      // Unreadable environments are ordinary: another user's processes, and this user's
      // own non-dumpable ones (systemd --user, ssh-agent), can never be read. Only a
      // process that could be the engine of the task being judged is counted: this
      // user's, no older than the task, and leading its own group and session, which is
      // the only shape a detached engine spawn can have.
      const candidate = before.pgid === pid && before.sid === pid
        && startedAt(before.startTime) >= since && ownedByThisUser(pid);
      if (code !== "ENOENT" && code !== "ESRCH" && candidate) unreadable++;
      continue;
    }
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

// SIGTERM, a grace, SIGKILL, a shorter grace. It answers whether the group is gone and
// never throws: a caller judging many records reports the survivor and carries on, and
// an EPERM or a group that will not die is that answer, not an exception.
async function terminate(pgid: number, alive: () => boolean, options: TerminateOptions): Promise<boolean> {
  const signal = (value: NodeJS.Signals) => {
    try {
      if (alive()) process.kill(-pgid, value);
    } catch { /* ESRCH is a group that died first; EPERM is answered by the wait below. */ }
  };
  if (!alive()) return true;
  signal("SIGTERM");
  if (await waitFor(() => !alive(), options.termGrace ?? 2000)) return true;
  signal("SIGKILL");
  return waitFor(() => !alive(), options.killGrace ?? 500);
}

/** The verified group of a recorded engine identity. */
export function terminateGroup(identity: EngineIdentity, options: TerminateOptions = {}): Promise<boolean> {
  return terminate(identity.pgid, () => groupAlive(identity), options);
}

// The group a detached spawn created, known only by the pid it made the group and session
// id — the case where the engine's identity could never be captured. The kernel keeps that
// id reserved while any member holds it, so the members are exactly what the scan finds.
export function terminateGroupByPid(pid: number, options: TerminateOptions = {}): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return Promise.resolve(true);
  return terminate(pid, () => hasMember(pid), options);
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
  for (const record of list(projectRoot, "orphaned")) {
    const identity = record.engineIdentity;
    const state = inspectGroup(identity);
    // A record left orphaned on purpose is not silently left: an operator reading a task
    // that never settles has to be told which identity cleanup would not act on.
    if (!identity) { skipped.push({ id: record.id, reason: "no engine identity" }); continue; }
    if (state === "invalid" || state === "reused") { skipped.push({ id: record.id, reason: `engine identity ${state}` }); continue; }
    if (state === "alive" && !await terminateGroup(identity)) {
      skipped.push({ id: record.id, reason: `engine group ${identity.pgid} did not terminate` });
      continue;
    }
    // A record settled by another writer since the listing is refused: not changed.
    const result = await update(projectRoot, record.id, { status: "failed", reason: "runner lost" }, Date.now(), { unlessTerminal: true, waitSeconds });
    if (result.applied) changed.push(result.record);
  }
  return { changed, skipped };
}
