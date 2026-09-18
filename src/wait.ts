import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, lockWaitSeconds } from "./config.ts";
import type { CrossAgentConfig } from "./config.ts";
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
  /** What the reconciliation pass this call ran could not do, when it could not. */
  reason?: string;
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
  /**
   * How long the transition may wait for the record lock. Both callers pass their project's
   * `limits.lockWaitSeconds`, because every waiter blocks that long and then refuses
   * (design section 2); the fallback reads it here rather than leave a caller on the
   * helper's own default.
   */
  waitSeconds?: number;
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
    waitSeconds: options.waitSeconds ?? lockWaitSeconds(projectRoot),
    expect: (current) => current.status === record.status && quiet(current, now, stallMs) === silent,
  });
  return written.record;
}

/**
 * Whether this record's own evidence says the ledger is out of step with the kernel: a
 * launch nobody answered by its deadline, or a task whose runner is gone — which is what
 * `orphaned` means, so it is named rather than inferred from an identity. One reconciliation
 * pass answers all of them, and `wait` runs at most one per call.
 */
function adrift(record: TaskRecord, now: number): boolean {
  if (record.status === "launching") return now > record.launchDeadline;
  return record.status === "orphaned" || !isProcessAlive(record.runnerIdentity);
}

function hintFor(record: TaskRecord, unsettled: boolean): string {
  if (isTerminal(record.status)) return "settled: call result";
  if (record.status === "orphaned") return "orphaned: list_tasks reconciles; cancel terminates the engine";
  if (unsettled) return "unsettled: list_tasks reconciles again; cancel terminates what it finds";
  if (record.status === "stalled") return `stalled: read ${record.logPath}, keep waiting, or cancel`;
  return "call wait again";
}

/** What the pass said about this record, if it said anything at all. */
function passReason(pass: Awaited<ReturnType<typeof reconcileAndCleanup>>, taskId: string): string {
  return [...pass.errors, ...pass.skipped].find((entry) => entry.id === taskId)?.reason
    ?? "reconciliation did not settle it";
}

/** A refusal a caller can read, for the two things this tool does that can fail. */
function refusal(error: unknown): { ok: false; reason: string } {
  return { ok: false, reason: error instanceof Error ? error.message : String(error) };
}

interface Answer {
  /** The call was aborted; the task is untouched and still whatever `status` says. */
  cancelled?: boolean;
  /** This call's pass left the record where it was, and `reason` says what it could not do. */
  unsettled?: boolean;
  reason?: string;
}

function resultTail(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").slice(-resultTailChars);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function report(record: TaskRecord, answer: Answer = {}): WaitReport {
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
    hint: hintFor(record, answer.unsettled === true),
    ...(answer.reason === undefined ? {} : { reason: answer.reason }),
    ...(answer.cancelled ? { cancelled: true as const } : {}),
  };
}

/**
 * Returns when the task settles, when a stall begins while this call is polling, when the
 * ledger turns out to be out of step with the kernel, or when the timeout passes.
 *
 * The stall this call arrived on is not its answer, or a second `wait` on a stalled task
 * would return the same reading for ever instead of waiting for the task to move. A stall
 * that begins while it polls is its answer whoever wrote it — this call's own `observeStall`
 * or another reader's — because the crossing is the event, not the write. So a task that was
 * already stalled is polled like any other: it answers when it settles, when it stalls again
 * after another `stallMinutes` of silence, or at the timeout. The resolution of all of this
 * is the runner's two-second activity interval, which is how often a live engine's
 * `lastEventAt` reaches the record (`src/runner.ts`).
 */
export async function wait(projectRoot: string, taskId: string, options: WaitOptions = {}): Promise<WaitResult> {
  let limits: CrossAgentConfig["limits"];
  try {
    limits = loadConfig(projectRoot).limits;
  } catch (error) {
    return refusal(error);
  }
  const stallMs = limits.stallMinutes * 60_000;
  const waitSeconds = limits.lockWaitSeconds;
  const pollMs = Math.max(1, options.pollMs ?? 1000);
  const deadline = Date.now() + (options.timeoutSeconds ?? limits.waitDefaultSeconds) * 1000;
  // One pass per call and no more: reconciliation scans processes and writes records, and a
  // waiter that ran it every second would spend the task's lifetime judging it.
  let pass: Awaited<ReturnType<typeof reconcileAndCleanup>> | undefined;
  // Whether the stall this call found was already there when it arrived.
  let arrivedStalled: boolean | undefined;

  while (true) {
    const found = find(projectRoot, taskId);
    if (found === null) return { ok: false, reason: `no task ${taskId}` };
    arrivedStalled ??= found.status === "stalled";
    const now = Date.now();
    let record: TaskRecord;
    try {
      record = await observeStall(projectRoot, found, { now, stallMs, waitSeconds });
    } catch (error) {
      // A record lock this project would not wait any longer for: a refusal to report, not
      // a throw for the dispatcher to render as a bare string.
      return refusal(error);
    }
    // Once the task has been seen running again, the stall it arrived on is over and the
    // next one is this call's to answer.
    if (record.status !== "stalled") arrivedStalled = false;

    if (isTerminal(record.status)) return report(record);
    // The caller's own abort is read before anything is started on its behalf: a
    // reconciliation pass begun for a caller that has gone outlives the answer nobody is
    // waiting for.
    if (options.signal?.aborted) return report(record, { cancelled: true });

    if (adrift(record, now)) {
      // The evidence outranks the stall: a task whose runner is gone is not a task waiting
      // to be read again, however recently its engine spoke.
      if (!pass) {
        pass = await reconcileAndCleanup(projectRoot);
        continue;
      }
      // One pass has run and the record is still adrift, so nothing this call could wait
      // for will move it. The answer carries what the pass could not do.
      return report(record, { unsettled: true, reason: passReason(pass, taskId) });
    }
    if (record.status === "stalled" && !arrivedStalled) return report(record);

    const remaining = deadline - Date.now();
    if (remaining <= 0) return report(record);
    try {
      await delay(Math.min(pollMs, remaining), undefined, { signal: options.signal });
    } catch {
      // The abort is the caller's, not the task's: the record is read once more so the
      // answer carries the status as it is now, and nothing about the task is written.
      const current = find(projectRoot, taskId);
      return current === null ? { ok: false, reason: `no task ${taskId}` } : report(current, { cancelled: true });
    }
  }
}
