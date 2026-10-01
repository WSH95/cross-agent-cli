import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, lockWaitSeconds } from "./config.ts";
import { newTaskId, projectLock, writeAtomic } from "./ledger.ts";
import { askLockName } from "./locks.ts";

// The mailbox an engine-placed lead asks its operator through (design, "The lead model",
// item 3). One JSON document per question under `<root>/.cross-agent/asks/`, written by the
// server or the operator CLI and by nothing else: no engine has a tool that writes here,
// and no role may combine the project root with a writable sandbox. A lead blocks on its
// own question for one call's budget at most and asks again by id, which is what keeps a
// long wait inside its host's tool timeout; the first answer wins, and cancelling a lead
// cancels its open questions.

export type AskStatus = "open" | "answered" | "cancelled";

export const askStatuses: readonly AskStatus[] = ["open", "answered", "cancelled"];

export interface AskRecord {
  id: string;
  /** The lead task that asked. A lead sees, waits on and is answered through its own lineage's asks. */
  taskId: string;
  question: string;
  createdAt: number;
  status: AskStatus;
  answer?: string;
  answeredAt?: number;
  cancelledAt?: number;
}

export interface InvalidAsk {
  file: string;
  reason: string;
  /** The task a damaged file still names, when it parses that far; absent, it could be anyone's. */
  taskId?: string;
}

/** An open ask a cancel could not settle: by its id when it was read, by its file when it could not be. */
export type AskNotCancelled = { id: string; reason: string } | { file: string; reason: string };

/** Where the asks live. */
export function asksDirectory(projectRoot: string): string {
  return path.resolve(projectRoot, ".cross-agent", "asks");
}

/** A damaged ask, and the task it still names when it names one. */
class AskFault extends Error {
  taskId: string | undefined;
  constructor(message: string, taskId: string | undefined) {
    super(message);
    this.taskId = taskId;
  }
}

/**
 * Whether `id` could name an ask file: the ledger's alphabet, letters, digits, `-` and `_`,
 * so no id leaves the mailbox. Every reader of an id a caller supplied asks this first and
 * refuses by value; only a caller's own misuse reaches the throw in `askPath`.
 */
export function isAskId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
}

/** The refusal of an id `isAskId` rejects: it names no ask, as an unknown one does. */
function notAnAskId(id: string): string {
  return `no ask ${JSON.stringify(id)}: an ask id is letters, digits, "-" and "_"`;
}

/** Where an ask lives. Resolving it writes nothing; an id that could leave the directory is refused. */
function askPath(projectRoot: string, id: string): string {
  if (!isAskId(id)) throw new Error(`invalid ask id ${JSON.stringify(id)}`);
  return path.join(asksDirectory(projectRoot), `${id}.json`);
}

// Every field a reader dereferences, checked once: a damaged file is named, never trusted.
function askFault(value: unknown, file: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "not a JSON object";
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id !== path.basename(file, ".json")) return "id does not name its own file";
  for (const field of ["taskId", "question"] as const) {
    if (typeof record[field] !== "string") return `${field} must be a string`;
  }
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return "createdAt must be a finite number";
  if (!askStatuses.includes(record.status as AskStatus)) return `status must be one of ${askStatuses.join(", ")}`;
  if (record.answer !== undefined && typeof record.answer !== "string") return "answer must be a string";
  for (const field of ["answeredAt", "cancelledAt"] as const) {
    if (record[field] !== undefined && (typeof record[field] !== "number" || !Number.isFinite(record[field]))) {
      return `${field} must be a finite number`;
    }
  }
  if (record.status === "answered" && (typeof record.answer !== "string" || record.answeredAt === undefined)) {
    return "an answered ask carries its answer and answeredAt";
  }
  return null;
}

function parseAsk(file: string): AskRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new AskFault(`invalid ask ${file}: unparsable JSON: ${(error as Error).message}`, undefined);
  }
  const fault = askFault(parsed, file);
  if (fault !== null) {
    const taskId = (parsed as { taskId?: unknown } | null)?.taskId;
    throw new AskFault(`invalid ask ${file}: ${fault}`, typeof taskId === "string" ? taskId : undefined);
  }
  return parsed as AskRecord;
}

/** A file no reader could judge, named the same way whichever reader met it. */
function invalidAsk(file: string, error: unknown): InvalidAsk {
  const taskId = error instanceof AskFault ? error.taskId : undefined;
  return { file, reason: error instanceof Error ? error.message : String(error), ...(taskId === undefined ? {} : { taskId }) };
}

/**
 * One ask read by id: its record, or no record and the damaged file where there is one —
 * named as `listAsks` names it, with the task it still names — or null where nobody asked
 * it. Every reader by id refuses both kinds of absence by value.
 */
export type AskRead = { ask: AskRecord } | { ask: null; invalid: InvalidAsk | null };

/**
 * The ask by id, as a value: a damaged file is an answer about the mailbox, not an error in
 * the reader, so `ask`, `answer` and `cross-agent answer` refuse it as they refuse an ask
 * nobody wrote. A read creates nothing, the mailbox directory included; only an id that
 * could leave the mailbox, a caller's own misuse, throws.
 */
export function readAsk(projectRoot: string, id: string): AskRead {
  const file = askPath(projectRoot, id);
  try {
    return { ask: parseAsk(file) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ask: null, invalid: null };
    return { ask: null, invalid: invalidAsk(file, error) };
  }
}

/** Why a read by id found no ask to act on: the damaged file's reason, or that nobody asked it. */
function noAsk(id: string, read: { invalid: InvalidAsk | null }): string {
  return read.invalid?.reason ?? `no ask ${id}`;
}

export interface AskFilter {
  /** Only the asks these tasks asked: a lead's lineage ids. Absent for the operator, who sees every ask. */
  taskIds?: readonly string[];
  status?: AskStatus;
}

/**
 * Every ask the filter keeps, in the order they were asked — a conversation reads in that
 * order — with the files no reader could judge named beside them rather than hiding the rest.
 */
export function listAsks(projectRoot: string, filter: AskFilter = {}): { asks: AskRecord[]; invalid: InvalidAsk[] } {
  const directory = asksDirectory(projectRoot);
  const asks: AskRecord[] = [];
  const invalid: InvalidAsk[] = [];
  let listing: fs.Dirent[];
  try {
    listing = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { asks, invalid };
    throw error;
  }
  for (const entry of listing) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
    const file = path.join(directory, entry.name);
    try {
      asks.push(parseAsk(file));
    } catch (error) {
      // A file that vanished between the listing and its read is gone, not invalid.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      invalid.push(invalidAsk(file, error));
    }
  }
  return {
    asks: asks
      .filter((record) => filter.taskIds === undefined || filter.taskIds.includes(record.taskId))
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    invalid,
  };
}

/**
 * One lineage's asks, and the damaged files that may be its own: a file that names a task
 * of the lineage is, and so is one that names no task a reader could find, because it
 * could be anyone's. A resume told a lead's history without them would be told a part of
 * it as the whole, and a cancel that skipped them would claim a lineage asks nothing more.
 */
export function lineageAsks(
  projectRoot: string, taskIds: readonly string[], status?: AskStatus,
): { asks: AskRecord[]; unreadable: InvalidAsk[] } {
  const { asks, invalid } = listAsks(projectRoot, { taskIds, ...(status === undefined ? {} : { status }) });
  return { asks, unreadable: invalid.filter((entry) => entry.taskId === undefined || taskIds.includes(entry.taskId)) };
}

/** A new open question, written whole. Its id is fresh, so no other writer can hold it yet. */
export function createAsk(projectRoot: string, input: { taskId: string; question: string }, now = Date.now()): AskRecord {
  const record: AskRecord = { id: newTaskId(), taskId: input.taskId, question: input.question, createdAt: now, status: "open" };
  const file = askPath(projectRoot, record.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, record);
  return record;
}

export interface WriteOptions {
  now?: number;
  /** How long to wait for the ask's lock; the project's `limits.lockWaitSeconds` when absent. */
  waitSeconds?: number;
}

/**
 * Whether this write happened, as a value: a refused answer is the operator's to read, and
 * the record it carries is the one read inside the lock, so a second operator sees the
 * answer that beat theirs.
 */
export type AnswerResult =
  | { applied: true; ask: AskRecord }
  | { applied: false; reason: string; ask: AskRecord | null };

function when(at: number): string {
  return `${new Date(at).toISOString()} (answeredAt ${at})`;
}

/**
 * The operator's answer to one ask. The first one wins: under the ask's own lock the record
 * is read again, and an ask already answered or cancelled refuses, naming when the first
 * answer landed. An ask nobody wrote, and a damaged file, are refused before anything is
 * locked, so answering in a project with no mailbox writes nothing at all.
 */
export async function answerAsk(projectRoot: string, id: string, answer: string, options: WriteOptions = {}): Promise<AnswerResult> {
  if (!isAskId(id)) return { applied: false, reason: notAnAskId(id), ask: null };
  const found = readAsk(projectRoot, id);
  if (found.ask === null) return { applied: false, reason: noAsk(id, found), ask: null };
  const lock = await projectLock(projectRoot, askLockName(id), {
    operation: `answer ask ${id}`, waitSeconds: options.waitSeconds ?? lockWaitSeconds(projectRoot),
  });
  try {
    const read = readAsk(projectRoot, id);
    if (read.ask === null) return { applied: false, reason: noAsk(id, read), ask: null };
    const current = read.ask;
    if (current.status === "answered") {
      return { applied: false, reason: `refused answer to ask ${id}: it was answered at ${when(current.answeredAt!)}, and the first answer stands`, ask: current };
    }
    if (current.status === "cancelled") {
      const at = current.cancelledAt === undefined ? "" : ` at ${new Date(current.cancelledAt).toISOString()}`;
      return { applied: false, reason: `refused answer to ask ${id}: it was cancelled${at} with the task that asked it`, ask: current };
    }
    const record: AskRecord = { ...current, status: "answered", answer, answeredAt: options.now ?? Date.now() };
    writeAtomic(askPath(projectRoot, id), record);
    return { applied: true, ask: record };
  } finally {
    await lock.release();
  }
}

/**
 * The open asks of these tasks, cancelled: a cancelled lead asks nothing any more. Each is
 * read again under its own lock, so an answer that landed first is kept, and one ask that
 * cannot be written is that ask's failure, reported, and never the end of the rest. A
 * damaged file that may be one of these tasks' asks, and a mailbox that cannot be listed,
 * are failures of the same kind: named, and never thrown, because a cancel reports its
 * cascade's outcomes after this and a mailbox's trouble must not take them with it.
 */
export async function cancelAsks(
  projectRoot: string, taskIds: readonly string[], options: WriteOptions = {},
): Promise<{ cancelled: string[]; failures: AskNotCancelled[] }> {
  const cancelled: string[] = [];
  const failures: AskNotCancelled[] = [];
  let asks: AskRecord[];
  try {
    const found = lineageAsks(projectRoot, taskIds, "open");
    asks = found.asks;
    failures.push(...found.unreadable.map((entry) => ({ file: entry.file, reason: entry.reason })));
  } catch (error) {
    return { cancelled, failures: [{ file: asksDirectory(projectRoot), reason: `the mailbox cannot be listed: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  for (const open of asks) {
    try {
      const lock = await projectLock(projectRoot, askLockName(open.id), {
        operation: `cancel ask ${open.id}`, waitSeconds: options.waitSeconds ?? lockWaitSeconds(projectRoot),
      });
      try {
        const read = readAsk(projectRoot, open.id);
        // Damaged since it was listed: this ask's failure, named. Gone, or no longer open: not this cancel's.
        if (read.ask === null && read.invalid !== null) failures.push({ id: open.id, reason: read.invalid.reason });
        const current = read.ask;
        if (current?.status !== "open") continue;
        writeAtomic(askPath(projectRoot, open.id), { ...current, status: "cancelled", cancelledAt: options.now ?? Date.now() } satisfies AskRecord);
        cancelled.push(open.id);
      } finally {
        await lock.release();
      }
    } catch (error) {
      failures.push({ id: open.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { cancelled, failures };
}

export interface AskOptions {
  /** The lead task asking: a new question is recorded under it. */
  taskId: string;
  /** The asker's lineage ids (`src/tasks.ts#lineageIds`): the asks it may wait on again by id. */
  lineageIds: readonly string[];
  /** The question, for a new ask. A call naming `id` continues that one and needs none. */
  question?: string;
  /** An ask this lineage already put, to keep waiting on. */
  id?: string;
  /** Defaults to `limits.waitDefaultSeconds`, as `wait`'s does. */
  timeoutSeconds?: number;
  /** This call's own signal, which `notifications/cancelled` aborts. */
  signal?: AbortSignal;
  /** How long between reads of the record. One second unless a caller wants otherwise. */
  pollMs?: number;
}

export type AskResult =
  | { ok: true; id: string; status: "answered"; answer: string }
  | { ok: true; id: string; status: "cancelled" }
  | { ok: true; id: string; status: "open"; hint: string }
  | { ok: true; id: string; status: AskStatus; answer?: string; cancelled: true }
  | { ok: false; reason: string };

/** What a reader of this record is told now: the answer, the cancellation, or nothing yet. */
function settledAnswer(record: AskRecord): AskResult | null {
  if (record.status === "answered") return { ok: true, id: record.id, status: "answered", answer: record.answer! };
  if (record.status === "cancelled") return { ok: true, id: record.id, status: "cancelled" };
  return null;
}

function aborted(record: AskRecord): AskResult {
  return {
    ok: true, id: record.id, status: record.status,
    ...(record.answer === undefined ? {} : { answer: record.answer }), cancelled: true,
  };
}

/**
 * `ask`: put a question to the operator, or keep waiting on one this lineage already put,
 * and block until it is answered or cancelled, until the timeout, or until the caller
 * gives up. A timeout answers `open` with the id to ask again by; an aborted call answers
 * with the record as it stands and writes nothing (design, "The lead model", item 3).
 */
export async function ask(projectRoot: string, options: AskOptions): Promise<AskResult> {
  let waitDefaultSeconds: number;
  try {
    waitDefaultSeconds = loadConfig(projectRoot).limits.waitDefaultSeconds;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  let record: AskRecord;
  if (options.id !== undefined) {
    if (!isAskId(options.id)) return { ok: false, reason: notAnAskId(options.id) };
    const found = readAsk(projectRoot, options.id);
    if (found.ask === null) return { ok: false, reason: noAsk(options.id, found) };
    // A lead waits on its own lineage's questions and nobody else's: a resumed lead's
    // lineage reaches the record it continues, so the original's question is still its own.
    if (!options.lineageIds.includes(found.ask.taskId)) {
      return { ok: false, reason: `refused ask ${options.id}: it was asked by task ${found.ask.taskId}, which is not in task ${options.taskId}'s lineage` };
    }
    record = found.ask;
  } else {
    if (typeof options.question !== "string" || options.question.trim() === "") {
      return { ok: false, reason: "ask needs a question, or the id of one this task already asked" };
    }
    record = createAsk(projectRoot, { taskId: options.taskId, question: options.question });
  }
  const pollMs = Math.max(1, options.pollMs ?? 1000);
  const deadline = Date.now() + (options.timeoutSeconds ?? waitDefaultSeconds) * 1000;
  while (true) {
    const read = readAsk(projectRoot, record.id);
    if (read.ask === null) return { ok: false, reason: noAsk(record.id, read) };
    const current = read.ask;
    const settled = settledAnswer(current);
    if (settled !== null) return settled;
    if (options.signal?.aborted) return aborted(current);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: true, id: current.id, status: "open", hint: `call ask again with id ${current.id}` };
    try {
      await delay(Math.min(pollMs, remaining), undefined, { signal: options.signal });
    } catch {
      // The abort is the caller's: the record is read once more so the answer carries it as
      // it is now, and nothing about it is written.
      const now = readAsk(projectRoot, record.id);
      return now.ask === null ? { ok: false, reason: noAsk(record.id, now) } : aborted(now.ask);
    }
  }
}

/**
 * The asks a resumed lead's brief carries (design, "The lead model", item 3): every
 * question its lineage put, with its status and the answer where there is one, which is how
 * an answer reaches a lead that was killed while it waited. An empty list adds nothing.
 */
export function asksSection(asks: readonly AskRecord[]): string {
  if (asks.length === 0) return "";
  const indent = (text: string) => text.replace(/\n/g, "\n    ");
  const entries = asks.map((record) => [
    `- ask ${record.id}: ${record.status}`,
    `  question: ${indent(record.question)}`,
    ...(record.status === "answered" ? [`  answer: ${indent(record.answer ?? "")}`] : []),
  ].join("\n"));
  return `\n\n## Asks so far\n${entries.join("\n")}\n`;
}
