import { lockWaitSeconds } from "./config.ts";
import { currentBootId, isProcessAlive, scan, update } from "./ledger.ts";
import type { InvalidRecord, ProcessIdentity, TaskPatch, TaskRecord } from "./ledger.ts";
import {
  groupAlive, killStrays, ownGroup, selfLast, settlement, strandedEngine,
  terminateGroup, terminateGroupByPid, terminateOrphans,
} from "./process.ts";
import type { FoundProcess, Skipped } from "./process.ts";

export interface TaskError {
  id: string;
  reason: string;
}

export interface Reconciled {
  /** What this pass wrote, as written. A refused write is not a change. */
  changed: TaskRecord[];
  /** Record files that could not be read, by name (design section 2, A4-a and E2). */
  invalid: InvalidRecord[];
  /**
   * Per record, one of two kinds. A judgement this pass deferred, the record left as it
   * was for the next pass: an engine group that would not die, an environment the scan
   * could not read, an engine of this reconciler's own session, a launch decision another
   * writer overtook, a judgement that threw. Or a diagnostic beside a write that applied,
   * the record in `changed`: what the cleanup after the write could not finish, a stray
   * the pass could not signal or an engine of its own session left running (`adopt`,
   * `settleCancelled`). A `running`, `stalled` or `cancelling` record another writer
   * moved on before the write is that writer's and is not reported (`judge`,
   * `settleCancelled`), and one record's trouble never stops the others being judged
   * (`judgeAll`).
   */
  errors: TaskError[];
}

type Judgement = { changed: TaskRecord[]; errors: TaskError[] };

/**
 * How long past its launch deadline a record may be held open by an environment the scan
 * could not read. Waiting is the right answer to an unreadable plausible candidate — one
 * of them could be the engine (design section 2, B5) — but a same-uid non-dumpable leader
 * started during the task would hold the record `launching` for as long as it lived,
 * which is no bound at all. Five minutes is far past any launch and short enough that the
 * operator's task settles while they are still looking at it (bead atc-s96.31).
 */
const unreadableHoldMs = 5 * 60 * 1000;

/** The one sentence both halves of the unreadable case report, counted as it reads. */
function plural(unreadable: number): string {
  return `environ unreadable for ${unreadable} process${unreadable === 1 ? "" : "es"}`;
}

const nothing: Judgement = { changed: [], errors: [] };

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

/**
 * A `launching` record past its deadline that no runner ever acknowledged. The engine may
 * still exist: a runner killed between the spawn and the acknowledgement leaves one that
 * nothing else knows about. It is found by the `CROSS_AGENT_TASK` assignment the server
 * put in its environment (design section 2, B5-i).
 *
 * The conditional write is the decision point, and nothing is signalled before it: a
 * runner that acknowledges between the scan and the write owns the task, and killing what
 * this pass found would then be killing that runner's own engine. Only a group leader can
 * be adopted, because only a leader can be an engineIdentity, and only the lowest pid of
 * them, because a task has at most one engine; everything else carrying the id is a stray
 * and is killed once the write has applied. A forged CROSS_AGENT_TASK can therefore get a
 * process killed — the operator's own foot — but it can never grant authority.
 */
async function adopt(projectRoot: string, record: TaskRecord, now: number, waitSeconds: number): Promise<Judgement> {
  // The same preconditions, re-read inside the lock, so the decision is taken on the
  // record as it is when it is written, not as it was when it was listed.
  const expect = (current: TaskRecord) =>
    current.status === "launching" && !current.runnerIdentity && now > current.launchDeadline;
  const { leader, strays, own, unreadable } = strandedEngine(record.id, record.createdAt);

  if (!leader && own) {
    // The only engine carrying this id is the one this server runs inside. Adopting it
    // would have cleanup kill the group this process lives in; calling it a stray would
    // do it directly; settling the launch would leave a terminal record with no identity
    // and a live engine nothing could ever reach. Another server judges it.
    return {
      changed: [],
      errors: [{ id: record.id, reason: `engine ${own.pid} shares this reconciler's session; adoption deferred to another server` }],
    };
  }
  if (!leader && unreadable > 0 && now <= record.launchDeadline + unreadableHoldMs) {
    // One of those could have been this engine, and calling the launch failed would leave
    // it running with no record accounting for it. The next pass tries again — until the
    // hold runs out, because a process that can never be read would otherwise keep the
    // record launching for as long as it lived.
    return { changed: [], errors: [{ id: record.id, reason: plural(unreadable) }] };
  }
  // What the failure says is what the operator has to work from: the strays this pass is
  // about to kill, and the count it waited out without ever being able to read it.
  const failed = ["launch"];
  if (strays.length > 0) failed.push(`killed stray ${strays.map((entry) => entry.pid).join(", ")}`);
  if (unreadable > 0) failed.push(plural(unreadable));
  const patch: TaskPatch = leader
    ? { status: "orphaned", engineIdentity: { pid: leader.pid, startTime: leader.startTime, pgid: leader.pid, bootId: currentBootId } }
    : { status: "failed", reason: failed.join("; ") };

  const result = await update(projectRoot, record.id, patch, now, { unlessTerminal: true, expect, waitSeconds });
  if (!result.applied) {
    return { changed: [], errors: [{ id: record.id, reason: `launch decision refused: the record is ${result.record.status}` }] };
  }
  // An engine in this reconciler's own session is neither adopted nor killed, and when
  // another was adopted beside it nothing else would ever mention it: the record now
  // names a different engine, and a live process carrying this task id is left for an
  // operator to find on their own. So the survivor is named (bead atc-s96.32).
  const survivor = own
    ? [{ id: record.id, reason: `engine ${own.pid} shares this reconciler's session and was left running` }]
    : [];
  return {
    changed: [result.record],
    errors: [...survivor, ...(await killStrays(strays)).map((reason) => ({ id: record.id, reason }))],
  };
}

/**
 * The terminal half of the `cancelling` case: the group is already dead by the time this
 * runs, so the record is written and whatever else carried the id is killed after it —
 * losing the write to report a failed signal would drop a settled record from `changed`.
 */
async function settleCancelled(
  projectRoot: string, record: TaskRecord, patch: TaskPatch, strays: readonly FoundProcess[], now: number, waitSeconds: number,
): Promise<Judgement> {
  const result = await update(projectRoot, record.id, { status: "cancelled", reason: "runner lost during cancel", ...patch }, now, {
    unlessTerminal: true, waitSeconds, expect: (current) => current.status === "cancelling",
  });
  if (!result.applied) return nothing;
  return { changed: [result.record], errors: (await killStrays(strays)).map((reason) => ({ id: record.id, reason })) };
}

async function judge(projectRoot: string, record: TaskRecord, now: number, waitSeconds: number): Promise<Judgement> {
  if (record.status === "launching") {
    if (now <= record.launchDeadline || record.runnerIdentity) return nothing;
    return adopt(projectRoot, record, now, waitSeconds);
  }

  if ((record.status === "running" || record.status === "stalled") && !runnerAlive(record)) {
    // The same evidence cleanup reads for an orphan whose group is gone, read the same
    // way: an operator cannot be told a task failed by one pass and succeeded by another
    // (`src/process.ts#settlement`, finding T3b-3).
    const patch = groupAlive(record.engineIdentity)
      ? { status: "orphaned" as const }
      : settlement(projectRoot, record);
    const result = await update(projectRoot, record.id, patch, now, {
      unlessTerminal: true, waitSeconds,
      expect: (current) => current.status === record.status && sameRunner(current.runnerIdentity, record.runnerIdentity),
    });
    // A record another writer moved on is that writer's, not this pass's business.
    return result.applied ? { changed: [result.record], errors: [] } : nothing;
  }

  if (record.status === "cancelling" && !runnerAlive(record)) {
    // The cancel outlives the runner that started it: the group is terminated first and
    // only then is the record settled. A group that will not die leaves the record
    // cancelling, named, for the next pass.
    const identity = record.engineIdentity;
    const fail = (reason: string): Judgement => ({ changed: [], errors: [{ id: record.id, reason }] });
    if (identity) {
      const outcome = await terminateGroup(identity);
      if (outcome !== "dead") return fail(`engine group ${identity.pgid} did not terminate: ${outcome}`);
      return settleCancelled(projectRoot, record, {}, [], now, waitSeconds);
    }
    // A cancel inside the launch window claims a record that never acknowledged, so there
    // is no identity to terminate and the engine a dead runner left is found the one way a
    // stranded engine ever is: the assignment it carries (design section 2, B5-i).
    // Settling without looking would release the workspace over a live engine that no
    // record could name again.
    const { leader, strays, own, unreadable } = strandedEngine(record.id, record.createdAt);
    if (!leader && own) {
      return fail(`engine ${own.pid} shares this reconciler's session; settlement deferred to another server`);
    }
    if (!leader && unreadable > 0) return fail(`environ unreadable for ${unreadable} processes`);
    if (leader && !await terminateGroupByPid(leader.pid)) return fail(`engine group ${leader.pid} did not terminate`);
    const adopted: TaskPatch = leader
      ? { engineIdentity: { pid: leader.pid, startTime: leader.startTime, pgid: leader.pid, bootId: currentBootId } }
      : {};
    return settleCancelled(projectRoot, record, adopted, strays, now, waitSeconds);
  }

  return nothing;
}

/** Judges the records it is given, in the order it is given them. */
async function judgeAll(
  projectRoot: string, records: readonly TaskRecord[], now: number, waitSeconds: number,
): Promise<Judgement> {
  const changed: TaskRecord[] = [];
  const errors: TaskError[] = [];
  for (const record of records) {
    // One record's trouble is that record's. A pass that stopped at the first would leave
    // every task after it unjudged, and reconciliation runs on every listing.
    try {
      const judgement = await judge(projectRoot, record, now, waitSeconds);
      changed.push(...judgement.changed);
      errors.push(...judgement.errors);
    } catch (error) {
      errors.push({ id: record.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { changed, errors };
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
  // One read of the project's waiting rule for the whole pass: every record write below
  // waits that long for its record lock and then reports the record it could not judge.
  const waitSeconds = lockWaitSeconds(projectRoot);
  // A record whose engine group is this process's own is judged last: this pass can
  // terminate that group — the `cancelling` case does — and it dies with it, so every
  // record it could judge is judged first (design section 2).
  const { changed, errors } = await judgeAll(projectRoot, selfLast(records), now, waitSeconds);
  return { changed, invalid, errors };
}

/**
 * Reconciliation and orphan cleanup in one pass, so no caller can observe an `orphaned`
 * record whose group is still being decided. `changed` is what reconciliation wrote,
 * `cleaned` what cleanup settled after it, `invalid` the files neither could read, and
 * `errors` and `skipped` the records each left for the next pass, with the reason.
 */
export async function reconcileAndCleanup(
  projectRoot: string, now = Date.now(),
): Promise<Reconciled & { cleaned: TaskRecord[]; skipped: Skipped[] }> {
  const { records, invalid } = scan(projectRoot);
  const waitSeconds = lockWaitSeconds(projectRoot);
  // Self-last is a property of the pass, not of either loop inside it: a `cancelling`
  // record of this process's own group is judged by terminating that group, which ends
  // this process, and judging it in reconciliation's loop would kill the pass before
  // cleanup had settled anything. So the records of this server's own engine are held
  // back until both other halves have run (design section 2, finding T3b-6).
  const ours = records.filter((record) => ownGroup(record.engineIdentity));
  const others = records.filter((record) => !ownGroup(record.engineIdentity));
  const first = await judgeAll(projectRoot, others, now, waitSeconds);
  const { changed: cleaned, skipped } = await terminateOrphans(projectRoot);
  const last = await judgeAll(projectRoot, ours, now, waitSeconds);
  return {
    changed: [...first.changed, ...last.changed], invalid,
    errors: [...first.errors, ...last.errors], cleaned, skipped,
  };
}
