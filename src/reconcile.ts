import { setTimeout as delay } from "node:timers/promises";
import { currentBootId, isProcessAlive, readProcessStat, scan, update } from "./ledger.ts";
import type { EngineIdentity, InvalidRecord, ProcessIdentity, TaskRecord } from "./ledger.ts";
import { findByEnvironment, groupAlive, terminateGroup, terminateOrphans } from "./process.ts";
import type { FoundProcess, Skipped } from "./process.ts";

export interface Reconciled {
  /** What this pass wrote, as written. A refused write is not a change. */
  changed: TaskRecord[];
  /** Record files that could not be read, by name (design section 2, A4-a and E2). */
  invalid: InvalidRecord[];
}

// The runner is one process, so its identity is judged by pid and start time; the engine
// is a whole process group, so it is judged by the group scan. A leader that was reaped
// while a descendant kept the group alive is an orphan to clean up, not a lost task.
function runnerAlive(record: TaskRecord): boolean {
  return isProcessAlive(record.runnerIdentity);
}

function sameRunner(left?: ProcessIdentity | null, right?: ProcessIdentity | null): boolean {
  if (!left || !right) return !left && !right;
  return left.pid === right.pid && left.startTime === right.startTime && left.bootId === right.bootId;
}

// A zombie is not a running process, and its parent may never reap it, so waiting for
// the /proc entry itself to disappear could wait for ever.
function stillRunning(entry: FoundProcess): boolean {
  const stat = readProcessStat(entry.pid);
  return stat !== null && stat.startTime === entry.startTime && stat.state !== "Z" && stat.state !== "X";
}

async function killStrays(strays: FoundProcess[]): Promise<number[]> {
  const killed: number[] = [];
  for (const stray of strays) {
    // Verified immediately before the signal, as killGroup verifies a group: a pid that
    // left between the scan and here can already belong to an unrelated process.
    if (!stillRunning(stray)) continue;
    try {
      process.kill(stray.pid, "SIGTERM");
      killed.push(stray.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const deadline = performance.now() + 2000;
  while (strays.some(stillRunning) && performance.now() < deadline) await delay(20);
  for (const stray of strays.filter(stillRunning)) {
    try {
      process.kill(stray.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return killed;
}

/**
 * A `launching` record past its deadline that no runner ever acknowledged. The engine
 * may still exist: a runner killed between the spawn and the acknowledgement leaves one
 * that nothing else knows about. It is found by the `CROSS_AGENT_TASK` assignment the
 * server put in its environment (design section 2, B5-i).
 *
 * Only a group leader can be adopted, because only a leader can be an engineIdentity;
 * anything else carrying the id is a stray and is killed. A forged CROSS_AGENT_TASK can
 * therefore get a process killed — the operator's own foot — but never grant authority.
 */
async function adopt(projectRoot: string, record: TaskRecord, now: number): Promise<TaskRecord[]> {
  // The same preconditions, re-read inside the lock: a runner that acknowledged between
  // the listing and this write owns the task, and this pass must leave it alone.
  const expect = (current: TaskRecord) => current.status === "launching" && !current.runnerIdentity;
  const { found } = findByEnvironment(record.id, record.createdAt);
  const leader = found.find((entry) => entry.leader);
  const killed = await killStrays(found.filter((entry) => !entry.leader));

  if (leader) {
    const engineIdentity: EngineIdentity = {
      pid: leader.pid, startTime: leader.startTime, pgid: leader.pid, bootId: currentBootId,
    };
    // `launching -> orphaned` is not an edge of the transition table (design section 2,
    // E1), so adoption walks the two edges that are. The intermediate record states
    // exactly what was found — this engine is running and no runner owns it — which is
    // the B1 case, so a pass interrupted between the two writes leaves work its
    // successor finishes rather than a state nothing can reach.
    const adopted = await update(projectRoot, record.id, { status: "running", engineIdentity }, now, { unlessTerminal: true, expect });
    if (!adopted.applied) return [];
    const orphaned = await update(projectRoot, record.id, { status: "orphaned" }, now, {
      unlessTerminal: true, expect: (current) => current.status === "running" && !current.runnerIdentity,
    });
    return [orphaned.applied ? orphaned.record : adopted.record];
  }

  const reason = killed.length > 0 ? `launch; killed stray ${killed.join(", ")}` : "launch";
  const result = await update(projectRoot, record.id, { status: "failed", reason }, now, { unlessTerminal: true, expect });
  return result.applied ? [result.record] : [];
}

async function judge(projectRoot: string, record: TaskRecord, now: number): Promise<TaskRecord[]> {
  if (record.status === "launching") {
    if (now <= record.launchDeadline || record.runnerIdentity) return [];
    return adopt(projectRoot, record, now);
  }

  if ((record.status === "running" || record.status === "stalled") && !runnerAlive(record)) {
    const patch = groupAlive(record.engineIdentity)
      ? { status: "orphaned" as const }
      : { status: "failed" as const, reason: "runner lost" };
    const result = await update(projectRoot, record.id, patch, now, {
      unlessTerminal: true,
      expect: (current) => current.status === record.status && sameRunner(current.runnerIdentity, record.runnerIdentity),
    });
    return result.applied ? [result.record] : [];
  }

  if (record.status === "cancelling" && !runnerAlive(record)) {
    // The cancel outlives the runner that started it: the group is terminated by the
    // identity the record carries, and only then is the record settled.
    const identity = record.engineIdentity;
    if (identity && !await terminateGroup(identity)) throw new Error(`engine group ${identity.pgid} did not terminate`);
    const result = await update(projectRoot, record.id, { status: "cancelled", reason: "runner lost during cancel" }, now, {
      unlessTerminal: true, expect: (current) => current.status === "cancelling",
    });
    return result.applied ? [result.record] : [];
  }

  return [];
}

/**
 * Brings the ledger back in step with the kernel: a `launching` record past its deadline
 * with no runner, and a `running`, `stalled` or `cancelling` record whose runner is gone.
 * Every other record, terminal or live, is left alone — in particular the reconciler
 * never revives a task, so `stalled -> running` when events resume is not its business.
 *
 * Every decision is taken twice: once on the listed record, and once inside the record
 * lock through `expect`, on the record as it is then. A record another writer moved in
 * between is refused, and a refusal is not a change.
 */
export async function reconcile(projectRoot: string, now = Date.now()): Promise<Reconciled> {
  const { records, invalid } = scan(projectRoot);
  const changed: TaskRecord[] = [];
  for (const record of records) changed.push(...await judge(projectRoot, record, now));
  return { changed, invalid };
}

/**
 * Reconciliation and orphan cleanup in one pass, so no caller can observe an `orphaned`
 * record whose group is still being decided. `changed` is what reconciliation wrote,
 * `cleaned` what cleanup settled after it, and `invalid` the files neither could read.
 */
export async function reconcileAndCleanup(
  projectRoot: string, now = Date.now(),
): Promise<Reconciled & { cleaned: TaskRecord[]; skipped: Skipped[] }> {
  const { changed, invalid } = await reconcile(projectRoot, now);
  const { changed: cleaned, skipped } = await terminateOrphans(projectRoot);
  return { changed, invalid, cleaned, skipped };
}
