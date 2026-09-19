import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquire, lockPath, recordLockName } from "./locks.ts";
import type { SpawnRequest } from "./engines/types.ts";

export type TaskStatus = "launching" | "running" | "stalled" | "orphaned" | "cancelling" | "done" | "failed" | "cancelled";

export interface ProcessIdentity {
  pid: number;
  startTime: string;
  bootId: string;
}

export interface EngineIdentity extends ProcessIdentity {
  pgid: number;
}

export interface LaunchSpec extends Omit<SpawnRequest, "logPath" | "resultPath"> {
  /** `engine` comes from the request itself, which is what the pipeline checks its adapter against. */
  adapterModule: string;
}

export interface CreateTask {
  role: string;
  brief: string;
  cwd: string;
  engine: string;
  model?: string | null;
  effort?: string | null;
  /** The new task's own depth, which is its caller's plus one. A task nobody delegated is 0. */
  depth?: number;
  /** The lead whose delegation this is, when a lead delegated it (the lead model, cascade ownership). */
  parentTaskId?: string | null;
  /** The record this one continues, when it is a `resume` (design section 2, the reattach rule). */
  resumedFrom?: string | null;
}

export interface TaskRecord {
  id: string;
  role: string;
  briefHash: string;
  cwd: string;
  engine: string;
  /** What the delegation resolved to: the request's override, else the role's binding, else null. */
  model?: string | null;
  effort?: string | null;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  launchDeadline: number;
  runnerIdentity?: ProcessIdentity | null;
  engineIdentity?: EngineIdentity | null;
  lastEventAt?: number | null;
  exitCode?: number | null;
  resultPath: string;
  logPath: string;
  sessionId?: string | null;
  /**
   * Written by `delegate` as its caller's depth plus one, and read by the loop guard's
   * depth cap (design section 5, layer 1). Optional because a record an earlier build
   * wrote carries none, which is why every reader takes it with a default.
   */
  depth?: number;
  /**
   * The lead this task belongs to, preserved across `resume`, and what a cascade cancel
   * follows (the lead model, item 2). Null for a task the operator delegated.
   */
  parentTaskId?: string | null;
  /** The record this one continues; the chain of them is a resume chain (design section 2). */
  resumedFrom?: string | null;
  /**
   * When the runner's `launching → running` acknowledgement landed, written once and never
   * again: the stall clock measures from it rather than from a launch nobody answered.
   */
  acknowledgedAt?: number | null;
  reason?: string;
  /** The engine's stdio drain expired: this record's evidence may be missing its tail. */
  truncated?: boolean;
}

export type TaskPatch = Partial<Omit<TaskRecord, "id" | "createdAt" | "updatedAt">>;

export interface UpdateOptions {
  /** Refuse any write, including same-status metadata, when the record is terminal at the read. */
  unlessTerminal?: boolean;
  /** Refuse the write unless the record read inside the lock satisfies this. */
  expect?: (record: TaskRecord) => boolean;
  /** How long to wait for the record lock before throwing. */
  waitSeconds?: number;
}

/**
 * A write either happened or was refused, and a caller that must tell "I wrote it"
 * from "someone else owns it" needs that as a value rather than an exception. The
 * record is always the one read inside the lock, so a refused caller can act on the
 * state that beat it.
 */
export type UpdateResult =
  | { applied: true; record: TaskRecord }
  | { applied: false; record: TaskRecord; reason: "terminal" | "expect" };

const statuses = new Set<TaskStatus>(["launching", "running", "stalled", "orphaned", "cancelling", "done", "failed", "cancelled"]);
const terminalStatuses = new Set<TaskStatus>(["done", "failed", "cancelled"]);

/** Settled: the task owns nothing any more, and has let its workspace go. */
export function isTerminal(status: TaskStatus): boolean {
  return terminalStatuses.has(status);
}
// Design section 2, E1. Every other status change is a bug in a writer, not a race to
// tolerate, so update throws for it. A patch that keeps the status is not a transition.
const transitions: Record<TaskStatus, TaskStatus[]> = {
  // launching -> orphaned is reconciliation adopting a stranded engine: the record never
  // passes through running, because a record that is running with an engine identity
  // grants that engine authority (design, the lead model).
  launching: ["running", "cancelling", "failed", "orphaned"],
  running: ["stalled", "cancelling", "orphaned", "done", "failed"],
  stalled: ["running", "cancelling", "orphaned", "done", "failed"],
  // orphaned -> done is reconciliation settling a record from the outcome its runner
  // recorded before a write it was no longer allowed to make: the runner's claim was
  // lost, the work was not (`TaskOutcome`, bead atc-s96.30).
  orphaned: ["done", "failed", "cancelled"],
  cancelling: ["cancelled", "failed"],
  done: [],
  failed: [],
  cancelled: [],
};
const patchFields = new Set<string>([
  "role", "briefHash", "cwd", "engine", "model", "effort", "status", "launchDeadline", "runnerIdentity", "engineIdentity",
  "lastEventAt", "exitCode", "resultPath", "logPath", "sessionId", "reason", "truncated",
  "depth", "parentTaskId", "resumedFrom", "acknowledgedAt",
] satisfies (keyof TaskPatch)[]);

function initialize(projectRoot: string): string {
  const directory = path.resolve(projectRoot, ".cross-agent", "tasks");
  fs.mkdirSync(directory, { recursive: true });
  const gitDirectory = path.resolve(projectRoot, ".git");
  if (!fs.statSync(gitDirectory, { throwIfNoEntry: false })?.isDirectory()) return directory;

  const exclude = path.join(gitDirectory, "info", "exclude");
  let existing = "";
  try {
    existing = fs.readFileSync(exclude, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = new Set(existing.split(/\r?\n/));
  const missing = [".cross-agent/", ".worktrees/"].filter((line) => !lines.has(line));
  if (missing.length > 0) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(exclude, separator + missing.join("\n") + "\n");
  }
  return directory;
}

function recordPath(projectRoot: string, id: string): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("invalid task id");
  return path.join(initialize(projectRoot), `${id}.json`);
}

export class InvalidRecordError extends Error {
  file: string;
  reason: string;
  constructor(file: string, reason: string) {
    super(`invalid task record ${file}: ${reason}`);
    this.name = "InvalidRecordError";
    this.file = file;
    this.reason = reason;
  }
}

// A missing bootId is not malformed: an identity written before bootId existed can
// never match this boot, so it is simply dead (design section 2).
function identityFault(value: unknown, group: boolean): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "must be an object";
  const identity = value as Record<string, unknown>;
  if (!Number.isInteger(identity.pid)) return "needs an integer pid";
  if (typeof identity.startTime !== "string") return "needs a string startTime";
  if (group && !Number.isInteger(identity.pgid)) return "needs an integer pgid";
  if (identity.bootId !== undefined && typeof identity.bootId !== "string") return "bootId must be a string";
  return null;
}

// Every field a reader dereferences without checking, checked once here. Fields this
// build does not know are kept: a record a later build wrote is not malformed.
function recordFault(value: unknown, file: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "not a JSON object";
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(record.id)) return "id must be a [A-Za-z0-9_-] string";
  // Every writer addresses a record by id and reaches <id>.json. A record whose id names
  // another file would be read here and written there.
  if (record.id !== path.basename(file, ".json")) return `id ${record.id} does not name its own file`;
  if (typeof record.status !== "string" || !statuses.has(record.status as TaskStatus)) {
    return `status must be one of ${[...statuses].join(", ")}`;
  }
  for (const field of ["createdAt", "updatedAt", "launchDeadline"] as const) {
    if (typeof record[field] !== "number" || !Number.isFinite(record[field])) return `${field} must be a finite number`;
  }
  for (const field of ["role", "briefHash", "cwd", "engine", "resultPath", "logPath"] as const) {
    if (typeof record[field] !== "string") return `${field} must be a string`;
  }
  for (const field of ["runnerIdentity", "engineIdentity"] as const) {
    const fault = identityFault(record[field], field === "engineIdentity");
    if (fault !== null) return `${field} ${fault}`;
  }
  if (record.truncated !== undefined && typeof record.truncated !== "boolean") return "truncated must be a boolean";
  // The delegation fields. Each is absent from a record an earlier build wrote and null
  // where a task has none, so absence and null are answers and anything else is a fault.
  if (record.depth !== undefined && (!Number.isSafeInteger(record.depth) || (record.depth as number) < 0)) {
    return "depth must be a whole number of delegations, zero or more";
  }
  for (const field of ["model", "effort", "parentTaskId", "resumedFrom"] as const) {
    if (record[field] !== undefined && record[field] !== null && typeof record[field] !== "string") {
      return `${field} must be a string or null`;
    }
  }
  if (record.acknowledgedAt !== undefined && record.acknowledgedAt !== null
    && (typeof record.acknowledgedAt !== "number" || !Number.isFinite(record.acknowledgedAt))) {
    return "acknowledgedAt must be a finite number or null";
  }
  return null;
}

function readRecord(file: string): TaskRecord {
  const contents = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new InvalidRecordError(file, `unparsable JSON: ${(error as Error).message}`);
  }
  const fault = recordFault(parsed, file);
  if (fault !== null) throw new InvalidRecordError(file, fault);
  return parsed as TaskRecord;
}

/**
 * One JSON document, written whole: a temporary file in the same directory and a rename,
 * so a reader sees the whole previous document or the whole new one and never a partial
 * write. A value that cannot be serialized leaves nothing behind, temporary included.
 */
export function writeAtomic(file: string, value: unknown): void {
  const contents = JSON.stringify(value, null, 2) + "\n";
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(12).toString("base64url")}.tmp`);
  const fd = fs.openSync(temporary, "wx");
  try {
    try {
      fs.writeFileSync(fd, contents);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function create(projectRoot: string, input: CreateTask, now = Date.now()): TaskRecord {
  const directory = initialize(projectRoot);
  const id = randomBytes(18).toString("base64url");
  const record: TaskRecord = {
    id,
    role: input.role,
    briefHash: createHash("sha256").update(input.brief).digest("hex"),
    cwd: input.cwd,
    engine: input.engine,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    status: "launching",
    createdAt: now,
    updatedAt: now,
    launchDeadline: now + 30_000,
    resultPath: path.join(directory, `${id}.out`),
    logPath: path.join(directory, `${id}.ndjson`),
    depth: input.depth ?? 0,
    ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
    ...(input.resumedFrom === undefined ? {} : { resumedFrom: input.resumedFrom }),
  };
  writeAtomic(path.join(directory, `${id}.json`), record);
  return record;
}

export function read(projectRoot: string, id: string): TaskRecord {
  return readRecord(recordPath(projectRoot, id));
}

/** The record, or null when the project has no task by that id. */
export function find(projectRoot: string, id: string): TaskRecord | null {
  try {
    return read(projectRoot, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The last `count` lines of a file a record names — its engine's event stream, or its
 * runner's diagnostics — read from the end rather than whole, because a long-running
 * engine's log is unbounded and every reader of it wants only the tail.
 */
export function tailLines(file: string, count: number): string[] {
  const window = 64 * 1024;
  let handle: number;
  try {
    handle = fs.openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, window);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n").filter((line) => line.length > 0);
    // The first line of a window that began mid-file is a fragment, so it is dropped
    // unless the window is the whole file.
    if (length < size) lines.shift();
    return lines.slice(-count);
  } finally {
    fs.closeSync(handle);
  }
}

function validateSpec(spec: LaunchSpec): void {
  if (typeof spec?.adapterModule !== "string" || !path.isAbsolute(spec.adapterModule)) {
    throw new Error("adapterModule must be an absolute path");
  }
}

export function writeSpec(projectRoot: string, id: string, spec: LaunchSpec): void {
  const file = recordPath(projectRoot, id).replace(/\.json$/, ".spec.json");
  validateSpec(spec);
  writeAtomic(file, spec);
}

export function readSpec(projectRoot: string, id: string): LaunchSpec {
  const file = recordPath(projectRoot, id).replace(/\.json$/, ".spec.json");
  const spec = JSON.parse(fs.readFileSync(file, "utf8")) as LaunchSpec;
  validateSpec(spec);
  return spec;
}

/**
 * What the runner saw the engine do, written beside the task before the runner attempts
 * its terminal ledger write. The record may already belong to someone else by then — an
 * adoption that beat the runner's last write leaves it `orphaned` — and this file is
 * then the only account of how the engine ended. It is the runner's, and it is the only
 * evidence reconciliation settles such a record from (design section 2, bead
 * `atc-s96.30`): the result file holds an engine's last word whether the run succeeded
 * or failed, so text in it proves that something ended and nothing more.
 */
export interface TaskOutcome {
  kind: "done" | "failed";
  exitCode: number | null;
  sessionId: string | null;
  /** The failure's own words, which become the settled record's `reason`. */
  reason?: string;
  truncated?: boolean;
  /** When it was written, so a record can refuse an outcome older than itself. */
  at: number;
}

export function outcomePath(projectRoot: string, id: string): string {
  return recordPath(projectRoot, id).replace(/\.json$/, ".outcome.json");
}

export function writeOutcome(projectRoot: string, id: string, outcome: TaskOutcome): void {
  writeAtomic(outcomePath(projectRoot, id), outcome);
}

/**
 * The recorded outcome of a task, or `null` when there is none this record may trust: no
 * file, a file no reader can make sense of, or one written before the record existed. A
 * stale outcome cannot arise on its own — one record has one runner, and a resume gets a
 * record of its own — so the `at` check is a guard against the file being wrong, not a
 * case the design expects.
 */
export function readOutcome(projectRoot: string, record: TaskRecord): TaskOutcome | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(outcomePath(projectRoot, record.id), "utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const outcome = value as Record<string, unknown>;
  if (outcome.kind !== "done" && outcome.kind !== "failed") return null;
  if (typeof outcome.at !== "number" || outcome.at < record.createdAt) return null;
  return {
    kind: outcome.kind,
    exitCode: typeof outcome.exitCode === "number" ? outcome.exitCode : null,
    sessionId: typeof outcome.sessionId === "string" ? outcome.sessionId : null,
    ...(typeof outcome.reason === "string" ? { reason: outcome.reason } : {}),
    ...(typeof outcome.truncated === "boolean" ? { truncated: outcome.truncated } : {}),
    at: outcome.at,
  };
}

export async function update(
  projectRoot: string, id: string, patch: TaskPatch, now = Date.now(), options: UpdateOptions = {},
): Promise<UpdateResult> {
  const file = recordPath(projectRoot, id);
  // One read, one check, one rename, all inside the record lock. The lock is what makes
  // the check mean anything: a predicate without cross-process exclusion still
  // interleaves, so a stale writer could overwrite a fresh one between the two.
  const lock = await acquire(lockPath(projectRoot, recordLockName(id)), {
    operation: `update task ${id}`, waitSeconds: options.waitSeconds,
  });
  try {
    const current = readRecord(file);
    // Terminal first, so a terminal record is always reason "terminal".
    if (options.unlessTerminal && terminalStatuses.has(current.status)) return { applied: false, record: current, reason: "terminal" };
    if (options.expect && !options.expect(current)) return { applied: false, record: current, reason: "expect" };
    const fields = Object.fromEntries(Object.entries(patch).filter(([key, value]) => patchFields.has(key) && value !== undefined)) as TaskPatch;
    const status = fields.status ?? current.status;
    if (!statuses.has(status)) throw new Error(`invalid task status: ${status}`);
    // A record carrying a status this build does not know has no legal transitions, so
    // it is named in the error rather than crashing the writer.
    if (status !== current.status && !(transitions[current.status] ?? []).includes(status)) {
      const kind = terminalStatuses.has(current.status) ? "terminal task" : "task";
      throw new Error(`cannot change ${kind} ${id} from ${current.status} to ${status}`);
    }
    const record: TaskRecord = { ...current, ...fields, status, updatedAt: now };
    writeAtomic(file, record);
    return { applied: true, record };
  } finally {
    await lock.release();
  }
}

export interface InvalidRecord {
  /** The absolute path, so an operator can repair or remove exactly this file. */
  file: string;
  reason: string;
}

/**
 * Every candidate record file, with the unreadable ones named instead of thrown, so
 * one damaged file cannot hide the rest. An entry in `invalid` is an **unknown-active**
 * task: its cwd cannot be read, so it can never free a workspace, and the reservation
 * rule T6 must honour is that a writable delegation is refused while any invalid file
 * exists (design section 2, A4-a and E2). A file that disappeared between the listing
 * and its read is gone, not invalid.
 */
export function scan(projectRoot: string): { records: TaskRecord[]; invalid: InvalidRecord[] } {
  const directory = initialize(projectRoot);
  const records: TaskRecord[] = [];
  const invalid: InvalidRecord[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.json$/.test(entry.name)) continue;
    try {
      records.push(readRecord(path.join(directory, entry.name)));
    } catch (error) {
      // A file that vanished between the listing and its read is gone, not invalid.
      // Anything else — a permission, an I/O error — is a file no reader can judge, and
      // an operator has to be told its name rather than have the whole scan fail.
      if (error instanceof InvalidRecordError) invalid.push({ file: error.file, reason: error.reason });
      else if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        invalid.push({ file: path.join(directory, entry.name), reason: (error as Error).message });
      }
    }
  }
  return { records, invalid };
}

export function list(projectRoot: string, status?: TaskStatus): TaskRecord[] {
  return scan(projectRoot).records
    .filter((record) => status === undefined || record.status === status)
    .sort((left, right) => right.createdAt - left.createdAt);
}

export function readProcessStat(pid: number): { startTime: string; ppid: number; pgid: number; sid: number; state: string } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw error;
  }
  // Field 2 (comm) can contain spaces and parentheses; the suffix begins at field 3.
  const end = stat.lastIndexOf(")");
  if (end < 0) return null;
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  return { startTime: fields[19], ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]), state: fields[0] };
}

// A pid and start time from an earlier boot can collide with a live process, so an
// identity is only ever compared within the boot that captured it. The boot id is
// constant for the life of the kernel, so it is read once, here.
export const currentBootId: string = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

export function isProcessAlive(identity?: ProcessIdentity | null): boolean {
  if (!identity || identity.bootId !== currentBootId) return false;
  const stat = readProcessStat(identity.pid);
  // Z and X are processes that have exited; the entry survives only until someone waits
  // on it, and a runner in that state owns nothing.
  return stat !== null && stat.startTime === identity.startTime && stat.state !== "Z" && stat.state !== "X";
}
