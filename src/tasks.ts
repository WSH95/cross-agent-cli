import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, lockWaitSeconds } from "./config.ts";
import type { CrossAgentConfig } from "./config.ts";
import { currentBootId, find, isProcessAlive, isTerminal, read, scan, tailLines, update } from "./ledger.ts";
import type { TaskPatch, TaskRecord, TaskStatus } from "./ledger.ts";
import { acquire, lockPath, spawnLockName } from "./locks.ts";
import { reconcileAndCleanup } from "./reconcile.ts";
import type { FoundProcess } from "./process.ts";
import { killStrays, strandedEngine, terminateGroup, terminateGroupByPid } from "./process.ts";
import { observeStall } from "./wait.ts";

// The read tools and the cascade cancel. Ownership lives here too, because `wait`
// (`src/wait.ts`) and the operator CLI (S11) answer the same question: which tasks are
// this lead's.

/** A task's own id and the ids of the records it continues, nearest first. */
export function lineageIds(records: readonly TaskRecord[], id: string): string[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const ids: string[] = [];
  const seen = new Set<string>();
  // A `resumedFrom` cycle is a damaged ledger, not a reason to hang.
  for (let current: string | null | undefined = id; current && !seen.has(current); current = byId.get(current)?.resumedFrom) {
    seen.add(current);
    ids.push(current);
  }
  return ids;
}

/**
 * How many `parentTaskId` hops separate `taskId` from a lineage id of `leadId`, or null
 * when the chain never reaches one. A resumed lead owns what its earlier records were
 * delegated, because `parentTaskId` is preserved across a resume and the lead's own
 * lineage is the chain behind it (the lead model, item 2).
 */
function generations(records: readonly TaskRecord[], leadId: string, taskId: string): number | null {
  const byId = new Map(records.map((record) => [record.id, record]));
  const lineage = new Set(lineageIds(records, leadId));
  const seen = new Set<string>([taskId]);
  let hops = 0;
  for (let current = byId.get(taskId)?.parentTaskId; current && !seen.has(current); current = byId.get(current)?.parentTaskId) {
    seen.add(current);
    hops++;
    if (lineage.has(current)) return hops;
  }
  return null;
}

/** Whether `taskId`'s parent chain reaches `leadId` or any record `leadId` continues. */
export function ownedBy(records: readonly TaskRecord[], leadId: string, taskId: string): boolean {
  return generations(records, leadId, taskId) !== null;
}

const activeStatuses = new Set<TaskStatus>(["launching", "running", "stalled", "orphaned", "cancelling"]);
/** The statuses a cancel may claim; `orphaned` may only go to `failed | cancelled`. */
const claimable = new Set<TaskStatus>(["launching", "running", "stalled"]);

/** The tasks `taskId` owns, leaves first, so no task is settled while a child of it runs. */
function descendants(records: readonly TaskRecord[], taskId: string): TaskRecord[] {
  return records
    .filter((record) => record.id !== taskId && ownedBy(records, taskId, record.id))
    .map((record) => ({ record, hops: generations(records, taskId, record.id)! }))
    .sort((left, right) => right.hops - left.hops)
    .map((entry) => entry.record);
}

export interface TaskView {
  id: string;
  role: string;
  status: TaskStatus;
  /** Which harness, model and effort is running this task, always, for every listing. */
  engine: string;
  model: string | null;
  effort: string | null;
  cwd: string;
  depth: number;
  parentTaskId: string | null;
  resumedFrom: string | null;
  createdAt: number;
  updatedAt: number;
  lastEventAt: number | null;
  reason?: string;
}

function view(record: TaskRecord): TaskView {
  return {
    id: record.id, role: record.role, status: record.status,
    engine: record.engine, model: record.model ?? null, effort: record.effort ?? null,
    cwd: record.cwd, depth: record.depth ?? 0,
    parentTaskId: record.parentTaskId ?? null, resumedFrom: record.resumedFrom ?? null,
    createdAt: record.createdAt, updatedAt: record.updatedAt, lastEventAt: record.lastEventAt ?? null,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  };
}

export type CheckResult =
  | (TaskView & { ok: true; elapsedSeconds: number; lastActivity: string[] })
  | { ok: false; reason: string };

/**
 * What a task is doing, reconciling nothing: an answer a lead may ask for every few seconds
 * inspects no processes and judges no runner. The activity is the tail of the engine's own
 * event stream (`<id>.ndjson`), which is the evidence the runner tees rather than a reading
 * of it. The one thing this does write is the stall its clock reads, because `wait` and
 * `check` are the two readers of that clock and a reading nobody records is one every
 * later reader has to take again (design section 2).
 */
export async function check(projectRoot: string, taskId: string, options: { lines?: number; now?: number } = {}): Promise<CheckResult> {
  const lines = options.lines ?? 10;
  // A count that is not a whole number of lines has no reading: `tailLines` would hand back
  // the whole window for 0 or an infinity, and drop the head for a negative one.
  if (!Number.isSafeInteger(lines) || lines <= 0) {
    return { ok: false, reason: `lines must be a positive whole number, not ${JSON.stringify(options.lines)}` };
  }
  const found = find(projectRoot, taskId);
  if (found === null) return { ok: false, reason: `no task ${taskId}` };
  const now = options.now ?? Date.now();
  let record: TaskRecord;
  try {
    record = await observeStall(projectRoot, found, { now, waitSeconds: lockWaitSeconds(projectRoot) });
  } catch (error) {
    // The stall write is the only thing here that can fail, and a record lock this project
    // would not wait any longer for is a refusal to report rather than a throw.
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const until = isTerminal(record.status) ? record.updatedAt : now;
  return {
    ok: true, ...view(record),
    elapsedSeconds: Math.max(0, Math.round((until - record.createdAt) / 1000)),
    lastActivity: tailLines(record.logPath, lines),
  };
}

export type ResultResult =
  | { ok: true; id: string; status: TaskStatus; sessionId: string | null; result: string | null }
  | { ok: true; id: string; status: TaskStatus; settled: false }
  | { ok: false; reason: string };

/** The final message in full, once there is one. A task still running has only its status. */
export function result(projectRoot: string, taskId: string): ResultResult {
  const record = find(projectRoot, taskId);
  if (record === null) return { ok: false, reason: `no task ${taskId}` };
  if (!isTerminal(record.status)) return { ok: true, id: record.id, status: record.status, settled: false };
  let text: string | null = null;
  try {
    text = fs.readFileSync(record.resultPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { ok: true, id: record.id, status: record.status, sessionId: record.sessionId ?? null, result: text };
}

export interface ListResult {
  ok: true;
  tasks: TaskView[];
  /** Record files no reader could judge; each refuses every writable delegation (E2). */
  invalid: Array<{ file: string; reason: string }>;
  /** What this pass could not decide, and what orphan cleanup would not act on. */
  errors: Array<{ id: string; reason: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * The ledger, brought back in step with the kernel first: every listing reconciles, so an
 * operator never reads a `running` task whose runner died an hour ago (design section 2).
 */
export async function listTasks(projectRoot: string, status?: TaskStatus): Promise<ListResult> {
  const pass = await reconcileAndCleanup(projectRoot);
  const tasks = scan(projectRoot).records
    .filter((record) => status === undefined || record.status === status)
    .sort((left, right) => right.createdAt - left.createdAt)
    .map(view);
  return { ok: true, tasks, invalid: pass.invalid, errors: pass.errors, skipped: pass.skipped };
}

export interface Outcome {
  id: string;
  /** The status the task reached, or `already <status>` for one that was settled already. */
  outcome: string;
  reason?: string;
}

export interface CancelOptions {
  /** The lead whose own tasks may be cancelled. Absent for the operator, who may cancel any. */
  leadTaskId?: string;
}

export type CancelResult = { ok: true; outcomes: Outcome[] } | { ok: false; reason: string };

async function waitForTerminal(projectRoot: string, id: string, timeout: number): Promise<TaskRecord | null> {
  const deadline = performance.now() + timeout;
  while (true) {
    const record = read(projectRoot, id);
    if (isTerminal(record.status)) return record;
    if (performance.now() >= deadline) return null;
    await delay(Math.min(25, Math.max(1, deadline - performance.now())));
  }
}

function signal(pid: number, value: NodeJS.Signals): void {
  try {
    process.kill(pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * One task's termination, from whatever state it is in. The runner owns the engine, so it
 * is asked first — SIGTERM, then the grace to settle the record itself with both
 * identities. A runner that is gone or silent leaves the engine group to this caller, by
 * the identity the record carries and by nothing else.
 */
async function terminate(projectRoot: string, taskId: string, grace: number, waitSeconds: number): Promise<Outcome> {
  let record = read(projectRoot, taskId);
  if (isTerminal(record.status)) return { id: taskId, outcome: `already ${record.status}` };

  if (claimable.has(record.status)) {
    // The claim comes first: from this moment `delegate` refuses a child of this task, and
    // the runner reads the status as its own cancel.
    const claimed = await update(projectRoot, taskId, { status: "cancelling" }, Date.now(), {
      waitSeconds, expect: (current) => claimable.has(current.status),
    });
    record = claimed.record;
    if (!claimed.applied && isTerminal(record.status)) return { id: taskId, outcome: `already ${record.status}` };
  }

  // `orphaned` has no runner by definition; anything else may still have one.
  if (record.status !== "orphaned") {
    const runner = record.runnerIdentity;
    if (isProcessAlive(runner)) signal(runner!.pid, "SIGTERM");
    // A record that has not been acknowledged names no runner yet, and the runner that is
    // starting will read the `cancelling` status as its own cancel, so it is waited for.
    // The wait outlasts the runner's own SIGTERM grace by a second, because a runner that
    // is escalating on an engine ignoring SIGTERM is working, and killing it there would
    // throw away the evidence it is about to write.
    if (isProcessAlive(runner) || !runner) {
      const settled = await waitForTerminal(projectRoot, taskId, grace + 1000);
      if (settled) return { id: taskId, outcome: settled.status };
    }
  }

  // Re-read before escalating: a runner that acknowledged during the grace is a different
  // process from the one this pass claimed the record against.
  record = read(projectRoot, taskId);
  if (isTerminal(record.status)) return { id: taskId, outcome: record.status };
  if (record.status !== "orphaned" && isProcessAlive(record.runnerIdentity)) {
    signal(record.runnerIdentity!.pid, "SIGKILL");
  }

  const refuse = (reason: string): Outcome => ({ id: taskId, outcome: record.status, reason });
  const settle = async (patch: TaskPatch, strays: readonly FoundProcess[]): Promise<Outcome> => {
    const settled = await update(projectRoot, taskId, {
      status: "cancelled", ...patch,
      reason: record.status === "orphaned" ? "cancelled while orphaned" : "cancelled; the runner did not settle it",
    }, Date.now(), { waitSeconds, expect: (current) => ["cancelling", "orphaned"].includes(current.status) });
    if (!settled.applied) return { id: taskId, outcome: settled.record.status, reason: `the record is ${settled.record.status}` };
    const failures = await killStrays(strays);
    return { id: taskId, outcome: "cancelled", ...(failures.length > 0 ? { reason: failures.join("; ") } : {}) };
  };

  const identity = record.engineIdentity;
  if (identity) {
    return await terminateGroup(identity, { termGrace: grace, killGrace: 500 })
      ? settle({ engineIdentity: identity }, [])
      : refuse(`engine group ${identity.pgid} did not terminate`);
  }
  // The record names no engine, which is what a task cancelled inside its launch window
  // looks like — and an engine may still exist, carrying the assignment its runner put in
  // its environment. Settling without looking would release the workspace over a live
  // engine that no record could ever name again (design section 2, B5-i).
  const { leader, strays, own, unreadable } = strandedEngine(taskId, record.createdAt);
  if (!leader && own) return refuse(`engine ${own.pid} shares this server's session; reconciliation settles it`);
  if (!leader && unreadable > 0) return refuse(`environ unreadable for ${unreadable} processes; reconciliation settles it`);
  if (leader && !await terminateGroupByPid(leader.pid, { termGrace: grace, killGrace: 500 })) {
    return refuse(`engine group ${leader.pid} did not terminate`);
  }
  return settle(
    leader ? { engineIdentity: { pid: leader.pid, startTime: leader.startTime, pgid: leader.pid, bootId: currentBootId } } : {},
    strays,
  );
}

/**
 * A cancel is a cascade. The parent is claimed first, under `spawn.lock`, so that from
 * that moment no child may be delegated under it and the descendants this pass will cancel
 * are already all there are; then the descendants are cancelled leaves first, and the
 * parent itself last. Every task gets one outcome, and a partial failure is reported as
 * one so that a later `cancel` retries it (the lead model, item 2).
 */
export async function cancel(projectRoot: string, taskId: string, options: CancelOptions = {}): Promise<CancelResult> {
  let config: CrossAgentConfig;
  try {
    config = loadConfig(projectRoot);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const waitSeconds = config.limits.lockWaitSeconds;
  const grace = Math.max(0, config.limits.cancelGraceSeconds) * 1000;

  let target: TaskRecord;
  let snapshot: TaskRecord[];
  let claim: Awaited<ReturnType<typeof acquire>>;
  try {
    claim = await acquire(lockPath(projectRoot, spawnLockName()), { operation: `cancel task ${taskId}`, waitSeconds });
  } catch (error) {
    // A caller that could not even take the lock is told so, as `delegate` tells it.
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const { records } = scan(projectRoot);
    const record = records.find((value) => value.id === taskId);
    if (!record) return { ok: false, reason: `no task ${taskId}` };
    if (options.leadTaskId !== undefined && !ownedBy(records, options.leadTaskId, taskId)) {
      return {
        ok: false,
        reason: `refused cancel of task ${taskId}: lead task ${options.leadTaskId} did not delegate it`,
      };
    }
    target = record;
    if (claimable.has(record.status)) {
      const claimed = await update(projectRoot, taskId, { status: "cancelling" }, Date.now(), {
        waitSeconds, expect: (current) => claimable.has(current.status),
      });
      target = claimed.record;
    }
    // Taken after the claim and under the same lock a `delegate` validates under, so a
    // concurrent delegation either sees this parent cancelling and is refused, or has
    // already written its record and is in this snapshot.
    snapshot = descendants(records, taskId);
  } finally {
    await claim.release();
  }

  // One task's trouble is that task's: a record this pass could not even write — a lock it
  // could not take, a file that has gone — is reported beside the rest rather than left to
  // abandon the cascade, because the tasks after it are the ones still holding engines.
  async function attempt(id: string): Promise<Outcome> {
    try {
      return await terminate(projectRoot, id, grace, waitSeconds);
    } catch (error) {
      const status = scan(projectRoot).records.find((record) => record.id === id)?.status ?? "unknown";
      return { id, outcome: status, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  const outcomes = new Map<string, Outcome>();
  let pending = snapshot;
  // A descendant that was itself delegating when the snapshot was taken can leave a
  // grandchild behind it, so the ledger is read again until a round finds nothing new.
  for (let round = 0; round < 4 && pending.length > 0; round++) {
    for (const record of pending) outcomes.set(record.id, await attempt(record.id));
    const { records } = scan(projectRoot);
    pending = descendants(records, taskId).filter((record) => !outcomes.has(record.id) && activeStatuses.has(record.status));
  }

  // The parent last, and whatever became of its descendants: a lead left running because a
  // child of it could not be settled would go on working after it was cancelled, and the
  // child is named in the outcomes for the later cancel that retries it.
  outcomes.set(taskId, isTerminal(target.status)
    ? { id: taskId, outcome: `already ${target.status}` }
    : await attempt(taskId));

  // What is still active is what a later cancel retries, and saying so is the whole
  // difference between a partial failure and a cascade that reported success over one.
  for (const record of descendants(scan(projectRoot).records, taskId)) {
    if (!activeStatuses.has(record.status)) continue;
    outcomes.set(record.id, {
      id: record.id, outcome: record.status,
      reason: outcomes.get(record.id)?.reason ?? "still active after the cascade; cancel again to retry",
    });
  }
  return { ok: true, outcomes: [...outcomes.values()] };
}
