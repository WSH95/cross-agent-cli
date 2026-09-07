import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type TaskStatus = "launching" | "running" | "stalled" | "orphaned" | "cancelling" | "done" | "failed" | "cancelled";

export interface ProcessIdentity {
  pid: number;
  startTime: string;
}

export interface EngineIdentity extends ProcessIdentity {
  pgid: number;
}

export interface CreateTask {
  role: string;
  brief: string;
  cwd: string;
  engine: string;
  model?: string;
}

export interface TaskRecord {
  id: string;
  role: string;
  briefHash: string;
  cwd: string;
  engine: string;
  model?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  launchDeadline: number;
  launchToken: string;
  runnerIdentity?: ProcessIdentity | null;
  engineIdentity?: EngineIdentity | null;
  lastEventAt?: number | null;
  exitCode?: number | null;
  resultPath: string;
  logPath: string;
  sessionId?: string | null;
  reason?: string;
}

export type TaskPatch = Partial<Omit<TaskRecord, "id" | "createdAt" | "updatedAt" | "launchToken">>;

const statuses = new Set<TaskStatus>(["launching", "running", "stalled", "orphaned", "cancelling", "done", "failed", "cancelled"]);
const terminalStatuses = new Set<TaskStatus>(["done", "failed", "cancelled"]);
const patchFields = new Set<string>([
  "role", "briefHash", "cwd", "engine", "model", "status", "launchDeadline", "runnerIdentity", "engineIdentity",
  "lastEventAt", "exitCode", "resultPath", "logPath", "sessionId", "reason",
] satisfies (keyof TaskPatch)[]);

function initialize(projectRoot: string): string {
  const directory = path.resolve(projectRoot, ".dev-team", "tasks");
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
  const missing = [".dev-team/", ".worktrees/"].filter((line) => !lines.has(line));
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

function readRecord(file: string): TaskRecord {
  return JSON.parse(fs.readFileSync(file, "utf8")) as TaskRecord;
}

function writeRecord(file: string, record: TaskRecord): void {
  const contents = JSON.stringify(record, null, 2) + "\n";
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
    status: "launching",
    createdAt: now,
    updatedAt: now,
    launchDeadline: now + 30_000,
    launchToken: randomBytes(32).toString("base64url"),
    resultPath: path.join(directory, `${id}.out`),
    logPath: path.join(directory, `${id}.ndjson`),
  };
  writeRecord(path.join(directory, `${id}.json`), record);
  return record;
}

export function read(projectRoot: string, id: string): TaskRecord {
  return readRecord(recordPath(projectRoot, id));
}

export function update(projectRoot: string, id: string, patch: TaskPatch, now = Date.now()): TaskRecord {
  const file = recordPath(projectRoot, id);
  const current = readRecord(file);
  const fields = Object.fromEntries(Object.entries(patch).filter(([key, value]) => patchFields.has(key) && value !== undefined)) as TaskPatch;
  const status = fields.status ?? current.status;
  if (!statuses.has(status)) throw new Error(`invalid task status: ${status}`);
  if (terminalStatuses.has(current.status) && status !== current.status) {
    throw new Error(`cannot change terminal task ${id} from ${current.status} to ${status}`);
  }
  const record: TaskRecord = { ...current, ...fields, status, updatedAt: now };
  writeRecord(file, record);
  return record;
}

export function list(projectRoot: string, status?: TaskStatus): TaskRecord[] {
  const directory = initialize(projectRoot);
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[A-Za-z0-9_-]+\.json$/.test(entry.name))
    .map((entry) => readRecord(path.join(directory, entry.name)))
    .filter((record) => status === undefined || record.status === status)
    .sort((left, right) => right.createdAt - left.createdAt);
}

export function isProcessAlive(identity?: ProcessIdentity | null): boolean {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) return false;
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${identity.pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return false;
    throw error;
  }
  // Field 2 (comm) can contain spaces and parentheses; the suffix begins at field 3.
  const end = stat.lastIndexOf(")");
  if (end < 0) return false;
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  return fields[19] === identity.startTime;
}

export function reconcile(projectRoot: string, now = Date.now()): TaskRecord[] {
  const changed: TaskRecord[] = [];
  for (const record of list(projectRoot)) {
    let patch: TaskPatch | undefined;
    if (record.status === "launching" && now > record.launchDeadline && !record.runnerIdentity) {
      patch = { status: "failed", reason: "launch" };
    } else if ((record.status === "running" || record.status === "stalled") && !isProcessAlive(record.runnerIdentity)) {
      patch = isProcessAlive(record.engineIdentity)
        ? { status: "orphaned" }
        : { status: "failed", reason: "runner lost" };
    }
    if (patch) changed.push(update(projectRoot, record.id, patch, now));
  }
  return changed;
}
