import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.ts";
import { find, isProcessAlive, isTerminal, tailLines, update } from "./ledger.ts";
import type { TaskRecord, TaskStatus } from "./ledger.ts";
import { reconcileAndCleanup } from "./reconcile.ts";

// `wait`: the one blocking delegation tool. It polls a record until the task settles, its
// engine has been silent for `stallMinutes`, or the caller's timeout passes, and it answers
// with the next call to make (design section 1, "Time limits, as agreed"). A stall is a
// reading of a clock rather than an event anyone emits, so it is taken here and in `check`,
// the two tools that read that clock — and never by the reconciler, which never revives a
// task (design section 2).

export interface WaitOptions {
  /** Defaults to `limits.waitDefaultSeconds`; the design leaves the upper bound to the caller. */
  timeoutSeconds?: number;
  /** This call's own signal, which `notifications/cancelled` aborts (design section 1). */
  signal?: AbortSignal;
  /** How long between reads of the record. One second, unless a caller wants otherwise. */
  pollMs?: number;
}

export interface WaitReport {
  ok: true;
  task_id: string;
  status: TaskStatus;
  stalled: boolean;
  elapsedSeconds: number;
  /** The last line of the engine's own event stream, as `check` reads it. */
  lastActivity: string | null;
  /** The end of the final message, once there is one to read. */
  resultTail: string | null;
  /** The call this answer asks for next, named so a lead never has to infer it. */
  hint: string;
  /** This call was aborted; the task is untouched and still whatever `status` says. */
  cancelled?: true;
}

export type WaitResult = WaitReport | { ok: false; reason: string };

/** The end of the result file is enough to act on; `result` is where the whole of it lives. */
const resultTailChars = 2000;

/**
 * The moment this task was last heard from: its engine's last event, else the
 * acknowledgement that answered for the engine. A record with neither has never been heard
 * from at all, and silence that was never broken is the reconciler's deadline to judge,
 * not a stall (design section 2).
 */
function stallClock(record: TaskRecord): number | null {
  return record.lastEventAt ?? record.acknowledgedAt ?? null;
}

function quiet(record: TaskRecord, now: number, stallMs: number): boolean {
  const clock = stallClock(record);
  return clock !== null && now - clock >= stallMs;
}

export interface ObserveOptions {
  now?: number;
  /** The threshold in milliseconds, read from `limits.stallMinutes` when absent. */
  stallMs?: number;
}

/**
 * The stall as this reader finds it, written. `running → stalled` when the clock says the
 * engine has gone quiet and `stalled → running` when it says events have resumed, each
 * conditional on the record still saying inside the lock what it said outside it, so a
 * reading that another writer has already overtaken changes nothing. The record returned is
 * the record as it stands after the write, refused or applied.
 */
export async function observeStall(projectRoot: string, record: TaskRecord, options: ObserveOptions = {}): Promise<TaskRecord> {
  // Every other status is someone else's: `launching` has no clock of its own, a settled
  // task has stopped, and `orphaned` and `cancelling` are being decided elsewhere.
  if (record.status !== "running" && record.status !== "stalled") return record;
  const now = options.now ?? Date.now();
  const stallMs = options.stallMs ?? loadConfig(projectRoot).limits.stallMinutes * 60_000;
  const silent = quiet(record, now, stallMs);
  if (silent === (record.status === "stalled")) return record;
  const written = await update(projectRoot, record.id, { status: silent ? "stalled" : "running" }, now, {
    expect: (current) => current.status === record.status && quiet(current, now, stallMs) === silent,
  });
  return written.record;
}

/**
 * Whether this record's own evidence says the ledger is out of step with the kernel: a
 * launch nobody answered by its deadline, or an active task whose runner is gone. One
 * reconciliation pass answers both, and `wait` runs at most one of them per call.
 */
function adrift(record: TaskRecord, now: number): boolean {
  if (record.status === "launching") return now > record.launchDeadline;
  return !isProcessAlive(record.runnerIdentity);
}

function hintFor(record: TaskRecord): string {
  if (isTerminal(record.status)) return "settled: call result";
  if (record.status === "stalled") return `stalled: read ${record.logPath}, keep waiting, or cancel`;
  if (record.status === "orphaned") return "orphaned: list_tasks reconciles; cancel terminates the engine";
  return "call wait again";
}

function resultTail(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").slice(-resultTailChars);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function report(record: TaskRecord, cancelled = false): WaitReport {
  const terminal = isTerminal(record.status);
  // A settled task's elapsed time stops at its settlement, as `check` reports it.
  const until = terminal ? record.updatedAt : Date.now();
  return {
    ok: true,
    task_id: record.id,
    status: record.status,
    stalled: record.status === "stalled",
    elapsedSeconds: Math.max(0, Math.round((until - record.createdAt) / 1000)),
    lastActivity: tailLines(record.logPath, 1)[0] ?? null,
    resultTail: terminal ? resultTail(record.resultPath) : null,
    hint: hintFor(record),
    ...(cancelled ? { cancelled: true as const } : {}),
  };
}

/**
 * Returns when the task settles, when this call observes it stall, when the ledger has been
 * brought back in step and the task turns out to be over, or when the timeout passes.
 *
 * A stall this call observed is an answer; a stall it arrived to is not, or a second `wait`
 * on a stalled task would return the same reading for ever instead of waiting for the task
 * to move. So a task that was already stalled is polled like any other: it answers when it
 * settles, when it stalls again after another `stallMinutes` of silence, or at the timeout.
 */
export async function wait(projectRoot: string, taskId: string, options: WaitOptions = {}): Promise<WaitResult> {
  const { limits } = loadConfig(projectRoot);
  const stallMs = limits.stallMinutes * 60_000;
  const pollMs = Math.max(1, options.pollMs ?? 1000);
  const deadline = Date.now() + (options.timeoutSeconds ?? limits.waitDefaultSeconds) * 1000;
  // One pass per call and no more: reconciliation scans processes and writes records, and a
  // waiter that ran it every second would spend the task's lifetime judging it.
  let reconciled = false;

  while (true) {
    const found = find(projectRoot, taskId);
    if (found === null) return { ok: false, reason: `no task ${taskId}` };
    const now = Date.now();
    const record = await observeStall(projectRoot, found, { now, stallMs });
    if (isTerminal(record.status)) return report(record);
    if (found.status === "running" && record.status === "stalled") return report(record);

    if (!reconciled && adrift(record, now)) {
      reconciled = true;
      await reconcileAndCleanup(projectRoot);
      continue;
    }
    // An orphan has no runner to settle it, so waiting on one waits for nothing: the pass
    // above is the only thing that could have moved it, and it did not.
    if (record.status === "orphaned") return report(record);

    const remaining = deadline - Date.now();
    if (options.signal?.aborted || remaining <= 0) return report(record, options.signal?.aborted === true);
    try {
      await delay(Math.min(pollMs, remaining), undefined, { signal: options.signal });
    } catch {
      // The abort is the caller's, not the task's: the record is read once more so the
      // answer carries the status as it is now, and nothing about the task is written.
      const current = find(projectRoot, taskId);
      return current === null ? { ok: false, reason: `no task ${taskId}` } : report(current, true);
    }
  }
}
