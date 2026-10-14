import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH, loadConfigWithMode, recordPathLink, repositoryLockWait } from "./config.ts";
import type { RecordsConfig } from "./config.ts";
import { GitRunError, revision, run, uncommitted } from "./gitmutate.ts";
import { trackedStateFault } from "./gitroot.ts";
import { projectLock, writeAtomic } from "./ledger.ts";
import { acquire, gitLockName, repositoryLockPath } from "./locks.ts";
import type { Lock } from "./locks.ts";
import { locateRepository, rootWriteFault } from "./worktree.ts";
import type { Repository } from "./worktree.ts";

/** One file of a write: its new bytes whole, or text appended, and the sha256 it was read at. */
export interface RecordChange {
  path: string;
  mode: "replace" | "append";
  text: string;
  /** The sha256 the read form answered, or null for a file that does not exist yet. A replace needs it. */
  expect?: string | null;
}

/** The read form, one declared path; or the write form, a batch committed as one commit with this message. */
export type RecordRequest = { path: string } | { changes: RecordChange[]; message: string };

export interface RecordOptions {
  /** `limits.lockWaitSeconds`: how long `git.lock` is waited for; the repository lock waits `repositoryLockWait` of it. */
  waitSeconds: number;
  /** The run journal this call's commit is journaled in: `operator`, or a lead's first lineage id. */
  run: string;
  modesDir?: string;
}

/** A commit `record` landed at the root, whatever its verification found. */
export interface RecordedStep {
  step: "recorded";
  at: number;
  before: string;
  after: string;
  /** The paths the commit was asked to carry: the entries the root showed after the write. */
  paths: string[];
  /** The message the call asked for. */
  message: string;
  /** Whether the commit carries exactly those paths and left the root clean. */
  verified: boolean;
  problems?: string[];
}

/** `.cross-agent/runs/<run>.json`: the operator's audit trail of the root commits one run made (design section 7). */
export interface RunJournal {
  run: string;
  defaultBranch: string;
  steps: RecordedStep[];
}

export type RecordResult =
  | { ok: true; path: string; exists: boolean; text?: string; sha256?: string }
  | { ok: true; paths: string[]; commit?: string; journal?: RecordedStep; lockLost?: true }
  | {
    ok: false; reason: string; paths?: string[]; commit?: string; journal?: RecordedStep;
    exitCode?: number; stdout?: string; stderr?: string; lockLost?: true;
  };

type Refusal = Extract<RecordResult, { ok: false }>;

/** The most the read form answers with: a record is text a lead reads whole. */
const maxReadBytes = 1024 * 1024;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function literal(file: string): string {
  return `:(literal)${file}`;
}

/** Where a run's journal lives; the run id is one file name of the task alphabet. */
function runFile(projectRoot: string, run: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(run)) throw new Error(`invalid run id ${JSON.stringify(run)}`);
  return path.join(path.resolve(projectRoot, ".cross-agent", "runs"), `${run}.json`);
}

/**
 * A run's journal, or null where it has none. A file that does not parse, or whose shape is
 * not a journal's, is a throw naming it. A step is checked only for its name and its time, so
 * a journal holding steps of another kind still reads.
 */
export function readRunJournal(projectRoot: string, run: string): RunJournal | null {
  const file = runFile(projectRoot, run);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const invalid = (reason: string): never => {
    throw new Error(`invalid run journal ${file}: ${reason}`);
  };
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    invalid(`not JSON: ${message(error)}`);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) invalid("not an object");
  const journal = document as Record<string, unknown>;
  if (typeof journal.run !== "string") invalid("run is not a string");
  if (typeof journal.defaultBranch !== "string") invalid("defaultBranch is not a string");
  if (!Array.isArray(journal.steps)) invalid("steps is not a list");
  for (const [index, step] of (journal.steps as unknown[]).entries()) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) invalid(`steps[${index}] is not an object`);
    const { step: name, at } = step as Record<string, unknown>;
    if (typeof name !== "string") invalid(`steps[${index}].step is not a string`);
    if (typeof at !== "number" || !Number.isFinite(at)) invalid(`steps[${index}].at is not a finite number`);
  }
  return journal as unknown as RunJournal;
}

/** Appends one step to a run's journal, creating it with this default branch, and returns the journal written. */
export function appendRunStep(projectRoot: string, run: string, defaultBranch: string, step: RecordedStep): RunJournal {
  const file = runFile(projectRoot, run);
  const existing = readRunJournal(projectRoot, run);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const journal: RunJournal = { run, defaultBranch: existing?.defaultBranch ?? defaultBranch, steps: [...existing?.steps ?? [], step] };
  writeAtomic(file, journal);
  return journal;
}

/**
 * Bytes put in place whole: written to a temporary under `.cross-agent/tmp/`, with the mode
 * the file had where it had one, and renamed over the target, so a reader sees the old bytes
 * or the new ones and never a part.
 */
function place(root: string, target: string, bytes: Buffer, fileMode: number | undefined): void {
  const directory = path.join(root, ".cross-agent", "tmp");
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `${randomBytes(12).toString("base64url")}.tmp`);
  const fd = fs.openSync(temporary, "wx");
  try {
    try {
      if (fileMode !== undefined) fs.fchmodSync(fd, fileMode);
      fs.writeFileSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** A file's bytes with `text` appended, after a newline where the file has bytes and lacks its last one. */
function appended(previous: Buffer | null, text: string): Buffer {
  const before = previous ?? Buffer.alloc(0);
  const separator = before.length > 0 && before[before.length - 1] !== 0x0a ? "\n" : "";
  return Buffer.concat([before, Buffer.from(separator + text, "utf8")]);
}

/** The declared path's bytes and their sha256, read with no lock: a record changes only by a commit under one. */
function readRecord(projectRoot: string, file: string): RecordResult {
  const linked = recordPathLink(projectRoot, file);
  if (linked !== null) return { ok: false, reason: `record refuses ${JSON.stringify(file)}: ${linked}` };
  const target = path.join(projectRoot, file);
  let entry: fs.Stats | undefined;
  try {
    entry = fs.lstatSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: true, path: file, exists: false };
    return { ok: false, reason: `${JSON.stringify(file)} cannot be read: ${message(error)}` };
  }
  if (!entry.isFile()) return { ok: false, reason: `${JSON.stringify(file)} is not a regular file` };
  if (entry.size > maxReadBytes) {
    return { ok: false, reason: `${JSON.stringify(file)} is ${entry.size} bytes, more than the ${maxReadBytes} bytes record reads` };
  }
  const bytes = fs.readFileSync(target);
  return { ok: true, path: file, exists: true, text: bytes.toString("utf8"), sha256: sha256(bytes) };
}

/**
 * The project's record files (design section 4, "`record`: the root commit procedure"): a
 * declared file read, or a batch written and committed at the root as exactly its paths. The
 * whole batch is judged before the first byte is written; the root must be wholly clean;
 * the commit is made under `git.lock` and then the repository lock, and no `spawn.lock`,
 * because no workspace is claimed or cleared. Until the commit lands, any failure puts the
 * index and the files back as they were; once it has landed, nothing is undone, and the
 * commit is verified and journaled in `.cross-agent/runs/<run>.json`.
 */
export async function record(projectRoot: string, request: RecordRequest, options: RecordOptions): Promise<RecordResult> {
  let records: RecordsConfig;
  let defaultBranch: string;
  try {
    const { config } = loadConfigWithMode(projectRoot, options.modesDir);
    if (config.records === undefined) return { ok: false, reason: `${CONFIG_PATH} has no records block` };
    records = config.records;
    defaultBranch = config.project.defaultBranch;
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  // `record` serves the record files alone; the tracker's own files change only through it.
  const undeclared = (file: string): string | null => records.files.includes(file) ? null
    : `${JSON.stringify(file)} is not a record file: records.files in ${CONFIG_PATH} declares ${records.files.join(", ")}`;

  if ("path" in request) {
    const fault = undeclared(request.path);
    return fault === null ? readRecord(projectRoot, request.path) : { ok: false, reason: fault };
  }

  // The batch's own shape, judged before anything is read or locked.
  const seen = new Set<string>();
  for (const change of request.changes) {
    const fault = undeclared(change.path);
    if (fault !== null) return { ok: false, reason: fault };
    if (seen.has(change.path)) return { ok: false, reason: `${JSON.stringify(change.path)} is named twice in one batch` };
    seen.add(change.path);
    if (change.mode === "replace" && change.expect === undefined) {
      return { ok: false, reason: `a replace of ${JSON.stringify(change.path)} needs expect: the sha256 its read answered, or null for a file that does not exist yet` };
    }
    if (change.expect !== undefined && change.expect !== null && !/^[0-9a-f]{64}$/.test(change.expect)) {
      return { ok: false, reason: `expect for ${JSON.stringify(change.path)} is null or a sha256 of 64 lowercase hex characters` };
    }
  }
  if (request.message === "" || request.message.includes("\0")) {
    return { ok: false, reason: "record's message is the commit message: non-empty, with no NUL" };
  }

  const located = await locateRepository(projectRoot);
  if ("reason" in located) return { ok: false, reason: located.reason };
  const unwritable = rootWriteFault(located, projectRoot, defaultBranch, "write");
  if (unwritable !== null) return { ok: false, reason: unwritable };

  const operation = "record";
  let lock: Lock;
  try {
    lock = await projectLock(projectRoot, gitLockName(), { waitSeconds: options.waitSeconds, operation });
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  let shared: Lock;
  try {
    shared = await acquire(repositoryLockPath(located.commonDir), { waitSeconds: repositoryLockWait(options.waitSeconds), operation });
  } catch (error) {
    await lock.release();
    return { ok: false, reason: message(error) };
  }
  try {
    let result: RecordResult;
    try {
      result = await commitRecords(projectRoot, request, located, records, defaultBranch, options.run);
    } catch (error) {
      if (!(error instanceof GitRunError)) throw error;
      result = { ok: false, reason: error.message };
    }
    // The commit is done, but if the kernel dropped either lock while it was made, another
    // git write may already have started: the caller is told, as `git_root` tells it.
    return lock.lost || shared.lost ? { ...result, lockLost: true } as RecordResult : result;
  } finally {
    await shared.release();
    await lock.release();
  }
}

/** Section 4's steps, with `git.lock` and the repository lock held for all of them. */
async function commitRecords(
  projectRoot: string, request: { changes: RecordChange[]; message: string }, located: Repository,
  records: RecordsConfig, defaultBranch: string, runId: string,
): Promise<RecordResult> {
  const { gitDir, workTree } = located;
  const paths = request.changes.map((change) => change.path);

  // 1. The journal this commit's step goes to has to read before anything changes: a step
  // that could not be appended would otherwise be found only once the commit had landed.
  try {
    readRunJournal(projectRoot, runId);
  } catch (error) {
    return { ok: false, reason: message(error) };
  }

  // 2. The root, on its default branch, at a commit.
  const tracked = await trackedStateFault(gitDir, workTree);
  if (tracked !== null) return { ok: false, reason: tracked };
  const head = await run(gitDir, workTree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const on = head.exitCode === 0 ? head.stdout.trim() : "";
  if (on !== defaultBranch) return { ok: false, reason: `record commits on ${defaultBranch}; the root is on ${on || "no branch"}` };
  const before = await revision(gitDir, workTree, defaultBranch);
  if (before === undefined) return { ok: false, reason: `record commits on ${defaultBranch}, which has no commit yet` };

  // 3. Wholly clean, so the commit can carry nothing but the batch; and no record file
  // marked, since a write under a mark is one `status` would not show.
  const pending = await uncommitted(gitDir, workTree);
  if ("unread" in pending) return { ok: false, reason: pending.unread };
  if (pending.length > 0) {
    return { ok: false, reason: `record needs a wholly clean root, and ${workTree} has uncommitted changes: ${pending.join(", ")}; commit or remove them first` };
  }
  const listed = await run(gitDir, workTree, ["ls-files", "-v", "-z", "--", ...records.files.map(literal)]);
  if (listed.exitCode !== 0) {
    return { ok: false, reason: `record could not read the marks on the record files: ${listed.stderr.trim() || `git ls-files exited ${listed.exitCode}`}` };
  }
  // Each entry is `<tag> <path>`: a lowercase tag is assume-unchanged, `S` skip-worktree.
  const marked = listed.stdout.split("\0").filter((entry) => /^([a-z]|S) /.test(entry)).map((entry) => entry.slice(2));
  if (marked.length > 0) {
    return {
      ok: false,
      reason: `record refuses while a record file is marked assume-unchanged or skip-worktree, which hides its changes from git status: ${marked.join(", ")}; clear the mark (git update-index --no-assume-unchanged / --no-skip-worktree <path>) and call again`,
    };
  }

  // 4. The whole batch, judged against the disk before the first write.
  const planned: Array<{ change: RecordChange; target: string; previous: Buffer | null; fileMode?: number }> = [];
  for (const change of request.changes) {
    const named = JSON.stringify(change.path);
    const linked = recordPathLink(workTree, change.path);
    if (linked !== null) return { ok: false, reason: `record refuses ${named}: ${linked}` };
    const target = path.join(workTree, change.path);
    let entry: fs.Stats | undefined;
    try {
      entry = fs.lstatSync(target, { throwIfNoEntry: false });
    } catch (error) {
      return { ok: false, reason: `${named} cannot be read: ${message(error)}` };
    }
    if (entry !== undefined && !entry.isFile()) return { ok: false, reason: `${named} is not a regular file` };
    const previous = entry === undefined ? null : fs.readFileSync(target);
    if (change.expect === null && previous !== null) {
      return { ok: false, reason: `${named} exists, and expect null names a file that does not; read it and name its sha256` };
    }
    if (typeof change.expect === "string" && (previous === null || sha256(previous) !== change.expect)) {
      return {
        ok: false,
        reason: previous === null ? `${named} does not exist, and expect names bytes it had; expect null creates it`
          : `${named} has changed since it was read: its sha256 is no longer the one expect names; read it again`,
      };
    }
    planned.push({ change, target, previous, ...(entry === undefined ? {} : { fileMode: entry.mode & 0o7777 }) });
  }

  // 5. Until the commit lands, every way out puts the index and the bytes back.
  const written: typeof planned = [];
  let added: string[] = [];
  const undone = async (refusal: Refusal): Promise<Refusal> => {
    const failures: string[] = [];
    if (added.length > 0) {
      try {
        const reset = await run(gitDir, workTree, ["reset", "-q", "--", ...added.map(literal)]);
        if (reset.exitCode !== 0) failures.push(`git reset exited ${reset.exitCode}: ${reset.stderr.trim()}`);
      } catch (error) {
        failures.push(message(error));
      }
    }
    for (const { change, target, previous, fileMode } of written.reverse()) {
      try {
        if (previous === null) fs.rmSync(target, { force: true });
        else place(workTree, target, previous, fileMode);
      } catch (error) {
        failures.push(`${change.path}: ${message(error)}`);
      }
    }
    return failures.length === 0 ? refusal : { ...refusal, reason: `${refusal.reason}; and what it changed could not all be put back: ${failures.join("; ")}` };
  };

  let entries: string[];
  let committed: Awaited<ReturnType<typeof run>> | undefined;
  let commitError: unknown;
  try {
    for (const each of planned) {
      written.push(each);
      place(workTree, each.target, each.change.mode === "replace" ? Buffer.from(each.change.text, "utf8") : appended(each.previous, each.change.text), each.fileMode);
    }
    // 6. What the write changed is the batch's paths and nothing else, compared as strings:
    // the path alphabet is one git never quotes.
    const changed = await uncommitted(gitDir, workTree);
    if ("unread" in changed) return await undone({ ok: false, reason: changed.unread });
    const strays = changed.filter((entry) => !paths.includes(entry));
    if (strays.length > 0) {
      return await undone({ ok: false, reason: `record would commit more than its paths: ${strays.join(", ")}; nothing was committed` });
    }
    // 7. Bytes the files already had: nothing to commit, and nothing to journal.
    if (changed.length === 0) return { ok: true, paths };
    entries = changed;
    // 8. Exactly the entries, staged and committed.
    added = entries;
    const add = await run(gitDir, workTree, ["add", "--", ...entries.map(literal)]);
    if (add.exitCode !== 0) {
      return await undone({
        ok: false, reason: `git add exited ${add.exitCode}; the index and the files are as they were`,
        exitCode: add.exitCode, stdout: add.stdout, stderr: add.stderr,
      });
    }
    try {
      committed = await run(gitDir, workTree, ["commit", "-m", request.message]);
    } catch (error) {
      commitError = error;
    }
  } catch (error) {
    return await undone({ ok: false, reason: message(error) });
  }
  // Whether the commit landed is the branch's own answer. A read that fails here leaves that
  // unknown, so it is answered as it is and nothing is put back.
  const after = await revision(gitDir, workTree, defaultBranch);
  if (after === undefined) {
    return { ok: false, reason: `record could not read ${defaultBranch} after the commit, so whether it landed is unknown`, paths };
  }
  // 9. Not landed: put back, and git's own words.
  if (after === before) {
    const output = committed === undefined ? {} : { exitCode: committed.exitCode, stdout: committed.stdout, stderr: committed.stderr };
    const cause = committed === undefined ? message(commitError) : `git commit exited ${committed.exitCode}`;
    return await undone({ ok: false, reason: `${cause}; the index and the files are as they were`, ...output });
  }

  // 10. Landed, whatever the commit call returned: verified, and left as it is.
  const problems: string[] = [];
  const diff = await run(gitDir, workTree, ["diff-tree", "-r", "--name-only", "-z", before, after]);
  if (diff.exitCode !== 0) {
    problems.push(`git diff-tree exited ${diff.exitCode}: ${diff.stderr.trim()}`);
  } else {
    for (const name of diff.stdout.split("\0").filter(Boolean)) {
      if (!entries.includes(name)) problems.push(`${name} is in the commit and was not the call's`);
    }
  }
  const left = await uncommitted(gitDir, workTree);
  if ("unread" in left) problems.push(left.unread);
  else for (const entry of left) problems.push(`${entry} is left uncommitted at the root`);

  // 11. Journaled whatever verification found.
  let journal: RecordedStep;
  try {
    const appendedJournal = appendRunStep(projectRoot, runId, defaultBranch, {
      step: "recorded", at: Date.now(), before, after, paths: entries, message: request.message,
      verified: problems.length === 0, ...(problems.length === 0 ? {} : { problems }),
    });
    journal = appendedJournal.steps[appendedJournal.steps.length - 1];
  } catch (error) {
    return { ok: false, reason: `commit ${after} landed; its step could not be written: ${message(error)}`, paths, commit: after };
  }
  if (!journal.verified) {
    return { ok: false, reason: `commit ${after} landed, but it is not exactly the call's paths: ${problems.join("; ")}`, paths, commit: after, journal };
  }
  return { ok: true, paths, commit: after, journal };
}
