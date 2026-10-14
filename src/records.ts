import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH, idPlaceholders, loadConfigWithMode, recordPathLink, repositoryLockWait, trackerVerbs } from "./config.ts";
import type { CrossAgentConfig, RecordsConfig, TrackerVerb } from "./config.ts";
import { GitRunError, revision, run, uncommitted } from "./gitmutate.ts";
import { trackedStateFault } from "./gitroot.ts";
import { projectLock, writeAtomic } from "./ledger.ts";
import { acquire, gitLockName, repositoryLockPath } from "./locks.ts";
import type { Lock } from "./locks.ts";
import { commandEnv, runArgv } from "./runcommand.ts";
import type { Ran } from "./runcommand.ts";
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

/** A writing verb `track` ran at the root: the commit of the tracker's files it landed, or none where they did not change. */
export interface TrackedStep {
  step: "tracked";
  at: number;
  verb: string;
  /** The ids the call filled, in the verb's placeholder order: `[id]`, `[parent]`, `[id, on]`, or none. */
  ids: string[];
  before: string;
  /** The commit as it landed; absent where the tracker changed nothing to commit. */
  after?: string;
  /** The tracker's files the commit was asked to carry: the entries the root showed after the run. */
  paths: string[];
  /** The message the call asked for. */
  message: string;
  /** Whether the commit carries exactly those paths and left the root clean; absent with no commit. */
  verified?: boolean;
  problems?: string[];
}

export type RunStep = RecordedStep | TrackedStep;

/** `.cross-agent/runs/<run>.json`: the operator's audit trail of the root commits one run made (design section 7). */
export interface RunJournal {
  run: string;
  defaultBranch: string;
  steps: RunStep[];
}

/** One tracker verb and the values its template's placeholders are filled with; `message` is a writing verb's commit message. */
export interface TrackRequest {
  verb: string;
  id?: string;
  parent?: string;
  on?: string;
  title?: string;
  text?: string;
  message?: string;
}

export interface TrackOptions {
  /** `limits.lockWaitSeconds`, as `record` waits it. */
  waitSeconds: number;
  /** The run journal a writing verb's step goes to, as `record`'s does. */
  run: string;
  modesDir?: string;
  /** The server's own environment, which the tracker's is derived from (`src/runcommand.ts#commandEnv`). */
  env?: NodeJS.ProcessEnv;
  /** The caller's depth in the delegation chain: the tracker runs one below it. */
  depth?: number;
  /** How long the tracker may run before it is killed; `trackTimeoutSeconds`, which the server never overrides. */
  timeoutSeconds?: number;
}

/** Git's own words for a commit it refused, kept apart from the tracker's exit code and output. */
export interface GitOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type TrackResult =
  | {
    ok: true; verb: string; exitCode: 0;
    /** The last 64 KB of the tracker's output, both streams as they interleaved. */
    output: string;
    paths?: string[]; commit?: string; journal?: TrackedStep; lockLost?: true;
  }
  | {
    ok: false; reason: string; verb?: string; exitCode?: number; output?: string;
    paths?: string[]; commit?: string; journal?: TrackedStep; git?: GitOutput; lockLost?: true;
  };

export type RecordResult =
  | { ok: true; path: string; exists: boolean; text?: string; sha256?: string }
  | { ok: true; paths: string[]; commit?: string; journal?: RecordedStep; lockLost?: true }
  | {
    ok: false; reason: string; paths?: string[]; commit?: string; journal?: RecordedStep;
    exitCode?: number; stdout?: string; stderr?: string; lockLost?: true;
  };

type Refusal = Extract<RecordResult, { ok: false }>;
type Failure = { ok: false; reason: string };

/** The most the read form answers with: a record is text a lead reads whole. */
const maxReadBytes = 1024 * 1024;
/**
 * How long a tracker command may run before it is killed: with the commit's hooks, the bound
 * on how long a writing verb holds both git locks.
 */
export const trackTimeoutSeconds = 120;
/** What one `{title}` and one `{text}` may carry, in bytes: a title is a line, a text an item's whole body. */
const maxTitleBytes = 256;
const maxTextBytes = 64 * 1024;
/** The value of an id placeholder: one argument, or the part after an `=`, that no tracker reads as a flag. */
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Every placeholder a call can fill, in the order a call's values are judged. */
const valueNames = ["id", "parent", "on", "title", "text"] as const;

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
export function appendRunStep(projectRoot: string, run: string, defaultBranch: string, step: RunStep): RunJournal {
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
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(target);
  } catch (error) {
    return { ok: false, reason: `${JSON.stringify(file)} cannot be read: ${message(error)}` };
  }
  return { ok: true, path: file, exists: true, text: bytes.toString("utf8"), sha256: sha256(bytes) };
}

/**
 * The project's record files (design section 4, "`record`: the root commit procedure"): a
 * declared file read, or a batch written and committed at the root as the batch's files that
 * changed, and nothing outside it. The
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

  return underLocks(projectRoot, located.commonDir, options.waitSeconds, "record", true,
    () => commitRecords(projectRoot, request, located, records, defaultBranch, options.run));
}

/**
 * The words `rootReady` and `landCommit` use for the tool they serve, so that each tool's
 * answers name its own files and say what a commit that did not land leaves behind.
 */
interface Label {
  tool: string;
  /** The files whose marks are read, as a refusal names them. */
  files: string;
  /** One of them, as a refusal names it. */
  file: string;
  /** What a commit that did not land leaves, as the refusal says it. */
  asWas: string;
}

const recordLabel: Label = { tool: "record", files: "the record files", file: "a record file", asWas: "the index and the files are as they were" };
// What stays after a failed commit is named by `trackWrite`, from what the root shows.
const trackLabel: Label = { tool: "track", files: "the tracker's files", file: "a tracker file", asWas: "the index is as it was" };

/**
 * `body` under `git.lock`, and under the repository lock inside it where `repository` asks
 * for it (design section 4): a lock that cannot be had, or a git that cannot run at all, is a
 * refusal, and a lock the kernel dropped while `body` ran is `lockLost: true` on its answer.
 */
async function underLocks<R extends { ok: boolean }>(
  projectRoot: string, commonDir: string, waitSeconds: number, operation: string, repository: boolean, body: () => Promise<R>,
): Promise<R | Failure> {
  let lock: Lock;
  try {
    lock = await projectLock(projectRoot, gitLockName(), { waitSeconds, operation });
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  let shared: Lock | undefined;
  if (repository) {
    try {
      shared = await acquire(repositoryLockPath(commonDir), { waitSeconds: repositoryLockWait(waitSeconds), operation });
    } catch (error) {
      await lock.release();
      return { ok: false, reason: message(error) };
    }
  }
  try {
    let result: R | Failure;
    try {
      result = await body();
    } catch (error) {
      if (!(error instanceof GitRunError)) throw error;
      result = { ok: false, reason: error.message };
    }
    // The work is done, but if the kernel dropped either lock while it was done, another
    // git write may already have started: the caller is told, as `git_root` tells it.
    return lock.lost || shared?.lost === true ? { ...result, lockLost: true } : result;
  } finally {
    await shared?.release();
    await lock.release();
  }
}

/**
 * Section 4's steps 1 to 3, the same for both tools: the run journal reads, the root is on
 * its default branch at a commit, which is `before`, and it is wholly clean, with none of
 * `marked` carrying an assume-unchanged or skip-worktree mark. An empty `marked` reads no
 * marks, since `ls-files` given no path lists the whole index.
 */
async function rootReady(
  label: Label, projectRoot: string, located: Repository, defaultBranch: string, runId: string, marked: readonly string[],
): Promise<{ before: string } | Failure> {
  const { gitDir, workTree } = located;

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
  if (on !== defaultBranch) return { ok: false, reason: `${label.tool} commits on ${defaultBranch}; the root is on ${on || "no branch"}` };
  const before = await revision(gitDir, workTree, defaultBranch);
  if (before === undefined) return { ok: false, reason: `${label.tool} commits on ${defaultBranch}, which has no commit yet` };

  // 3. Wholly clean, so the commit can carry nothing but the call's own; and none of the
  // declared files marked, since a change under a mark is one `status` would not show.
  const pending = await uncommitted(gitDir, workTree);
  if ("unread" in pending) return { ok: false, reason: pending.unread };
  if (pending.length > 0) {
    return { ok: false, reason: `${label.tool} needs a wholly clean root, and ${workTree} has uncommitted changes: ${pending.join(", ")}; commit or remove them first` };
  }
  if (marked.length === 0) return { before };
  const listed = await run(gitDir, workTree, ["ls-files", "-v", "-z", "--", ...marked.map(literal)]);
  if (listed.exitCode !== 0) {
    return { ok: false, reason: `${label.tool} could not read the marks on ${label.files}: ${listed.stderr.trim() || `git ls-files exited ${listed.exitCode}`}` };
  }
  // Each entry is `<tag> <path>`: a lowercase tag is assume-unchanged, `S` skip-worktree.
  const found = listed.stdout.split("\0").filter((entry) => /^([a-z]|S) /.test(entry)).map((entry) => entry.slice(2));
  if (found.length > 0) {
    return {
      ok: false,
      reason: `${label.tool} refuses while ${label.file} is marked assume-unchanged or skip-worktree, which hides its changes from git status: ${found.join(", ")}; clear the mark (git update-index --no-assume-unchanged / --no-skip-worktree <path>) and call again`,
    };
  }
  return { before };
}

/** What `landCommit` answers: the commit and its step, or why there is none, or why it is not the call's alone. */
type Landed<S extends RunStep> =
  | { ok: true; paths: string[]; commit: string; journal: S }
  | { ok: false; reason: string; paths?: string[]; commit?: string; journal?: S; git?: GitOutput };

/**
 * Section 4's steps 8 to 11, the same for both tools: `entries` staged and committed with
 * `commitMessage`, and nothing else. Until the commit lands, a failure resets the paths this
 * staged and calls `putBack` for what the tool itself changed — the bytes `record` wrote, and
 * nothing for `track`, whose tracker's change is left standing — and git's own words come
 * back under `git`. Once it has landed, nothing is undone: the commit is verified against
 * `entries` and a clean root, and `step` is journaled whatever verification found. Every
 * answer from the read of the branch after the commit on carries `answerPaths`.
 */
async function landCommit<S extends RunStep>(
  label: Label, projectRoot: string, located: Repository, defaultBranch: string, runId: string, before: string,
  entries: string[], commitMessage: string, answerPaths: string[], putBack: () => string[],
  step: (landed: { after: string; problems: string[] }) => S,
): Promise<Landed<S>> {
  const { gitDir, workTree } = located;
  type Unlanded = Extract<Landed<S>, { ok: false }>;
  let added: string[] = [];
  const undone = async (refusal: Unlanded): Promise<Unlanded> => {
    const failures: string[] = [];
    if (added.length > 0) {
      try {
        const reset = await run(gitDir, workTree, ["reset", "-q", "--", ...added.map(literal)]);
        if (reset.exitCode !== 0) failures.push(`git reset exited ${reset.exitCode}: ${reset.stderr.trim()}`);
      } catch (error) {
        failures.push(message(error));
      }
    }
    failures.push(...putBack());
    return failures.length === 0 ? refusal : { ...refusal, reason: `${refusal.reason}; and what it changed could not all be put back: ${failures.join("; ")}` };
  };

  let committed: Awaited<ReturnType<typeof run>> | undefined;
  let commitError: unknown;
  try {
    // 8. Exactly the entries, staged and committed.
    added = entries;
    const add = await run(gitDir, workTree, ["add", "--", ...entries.map(literal)]);
    if (add.exitCode !== 0) {
      return await undone({
        ok: false, reason: `git add exited ${add.exitCode}; ${label.asWas}`,
        git: { exitCode: add.exitCode, stdout: add.stdout, stderr: add.stderr },
      });
    }
    try {
      committed = await run(gitDir, workTree, ["commit", "-m", commitMessage]);
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
    return { ok: false, reason: `${label.tool} could not read ${defaultBranch} after the commit, so whether it landed is unknown`, paths: answerPaths };
  }
  // 9. Not landed: put back, and git's own words.
  if (after === before) {
    const output = committed === undefined ? {} : { git: { exitCode: committed.exitCode, stdout: committed.stdout, stderr: committed.stderr } };
    const cause = committed === undefined ? message(commitError) : `git commit exited ${committed.exitCode}`;
    return await undone({ ok: false, reason: `${cause}; ${label.asWas}`, ...output });
  }

  // 10. Landed, whatever the commit call returned: verified, and left as it is. Two kinds of
  // problem are kept apart: one found — a path in the commit that is not the call's, or an
  // entry left at the root — and a check that could not run, a git that cannot run at all
  // included. Either is a problem, so the step is still journaled.
  const problems: string[] = [];
  let mismatched = false;
  const mismatch = (problem: string): void => {
    mismatched = true;
    problems.push(problem);
  };
  const verify = async (check: () => Promise<void>): Promise<void> => {
    try {
      await check();
    } catch (error) {
      problems.push(message(error));
    }
  };
  await verify(async () => {
    const diff = await run(gitDir, workTree, ["diff-tree", "-r", "--name-only", "-z", before, after]);
    if (diff.exitCode !== 0) {
      problems.push(`git diff-tree exited ${diff.exitCode}: ${diff.stderr.trim()}`);
      return;
    }
    for (const name of diff.stdout.split("\0").filter(Boolean)) {
      if (!entries.includes(name)) mismatch(`${name} is in the commit and was not the call's`);
    }
  });
  await verify(async () => {
    const left = await uncommitted(gitDir, workTree);
    if ("unread" in left) problems.push(left.unread);
    else for (const entry of left) mismatch(`${entry} is left uncommitted at the root`);
  });

  // 11. Journaled whatever verification found.
  let journal: S;
  try {
    const appendedJournal = appendRunStep(projectRoot, runId, defaultBranch, step({ after, problems }));
    journal = appendedJournal.steps[appendedJournal.steps.length - 1] as S;
  } catch (error) {
    return { ok: false, reason: `commit ${after} landed; its step could not be written: ${message(error)}`, paths: answerPaths, commit: after };
  }
  if (problems.length > 0) {
    const reason = mismatched ? `commit ${after} landed, but it is not exactly the call's paths: ${problems.join("; ")}`
      : `commit ${after} landed, but it could not be verified as the call's paths alone: ${problems.join("; ")}`;
    return { ok: false, reason, paths: answerPaths, commit: after, journal };
  }
  return { ok: true, paths: answerPaths, commit: after, journal };
}

/** Section 4's steps, with `git.lock` and the repository lock held for all of them. */
async function commitRecords(
  projectRoot: string, request: { changes: RecordChange[]; message: string }, located: Repository,
  records: RecordsConfig, defaultBranch: string, runId: string,
): Promise<RecordResult> {
  const { gitDir, workTree } = located;
  const paths = request.changes.map((change) => change.path);

  // 1 to 3. The journal reads, and the root is on its default branch, wholly clean, with no
  // record file marked.
  const ready = await rootReady(recordLabel, projectRoot, located, defaultBranch, runId, records.files);
  if ("reason" in ready) return ready;
  const { before } = ready;

  // 4. The whole batch, judged against the disk before the first write.
  const planned: Array<{ change: RecordChange; target: string; previous: Buffer | null; fileMode?: number }> = [];
  for (const change of request.changes) {
    const named = JSON.stringify(change.path);
    const linked = recordPathLink(workTree, change.path);
    if (linked !== null) return { ok: false, reason: `record refuses ${named}: ${linked}` };
    const target = path.join(workTree, change.path);
    let entry: fs.Stats | undefined;
    let previous: Buffer | null = null;
    try {
      entry = fs.lstatSync(target, { throwIfNoEntry: false });
      if (entry?.isFile()) previous = fs.readFileSync(target);
    } catch (error) {
      return { ok: false, reason: `${named} cannot be read: ${message(error)}` };
    }
    if (entry !== undefined && !entry.isFile()) return { ok: false, reason: `${named} is not a regular file` };
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

  // 5. Until the commit lands, every way out puts the bytes back, and `landCommit` the index
  // before them.
  const written: typeof planned = [];
  const putBack = (): string[] => {
    const failures: string[] = [];
    for (const { change, target, previous, fileMode } of [...written].reverse()) {
      try {
        if (previous === null) fs.rmSync(target, { force: true });
        else place(workTree, target, previous, fileMode);
      } catch (error) {
        failures.push(`${change.path}: ${message(error)}`);
      }
    }
    return failures;
  };
  const undone = (refusal: Refusal): Refusal => {
    const failures = putBack();
    return failures.length === 0 ? refusal : { ...refusal, reason: `${refusal.reason}; and what it changed could not all be put back: ${failures.join("; ")}` };
  };

  let entries: string[];
  try {
    for (const each of planned) {
      written.push(each);
      place(workTree, each.target, each.change.mode === "replace" ? Buffer.from(each.change.text, "utf8") : appended(each.previous, each.change.text), each.fileMode);
    }
    // 6. Everything the write changed is one of the batch's paths, compared as strings: the
    // path alphabet is one git never quotes. These entries are what the commit carries.
    const changed = await uncommitted(gitDir, workTree);
    if ("unread" in changed) return undone({ ok: false, reason: changed.unread });
    const strays = changed.filter((entry) => !paths.includes(entry));
    if (strays.length > 0) {
      return undone({ ok: false, reason: `record would commit more than its paths: ${strays.join(", ")}; nothing was committed` });
    }
    // 7. Bytes the files already had: nothing to commit, and nothing to journal.
    if (changed.length === 0) return { ok: true, paths };
    entries = changed;
  } catch (error) {
    return undone({ ok: false, reason: message(error) });
  }

  // 8 to 11. Committed, or put back.
  const landed = await landCommit(recordLabel, projectRoot, located, defaultBranch, runId, before, entries, request.message, paths, putBack,
    ({ after, problems }): RecordedStep => ({
      step: "recorded", at: Date.now(), before, after, paths: entries, message: request.message,
      verified: problems.length === 0, ...(problems.length === 0 ? {} : { problems }),
    }));
  // Git's own words at the top of the answer, where `record` has always put them.
  if (landed.ok || landed.git === undefined) return landed;
  const { git, ...rest } = landed;
  return { ...rest, ...git };
}

/** A verb's command, filled, with what the call is: the ids it names, and whether it writes. */
interface TrackCommand {
  verb: TrackerVerb;
  argv: string[];
  ids: string[];
  writes: boolean;
}

/**
 * Why one value may not fill its placeholder, or null (design section 6, "The `records`
 * block"): an id is of the id alphabet, so no tracker reads it as a flag; a title is one line
 * of at most 256 bytes; a text is at most 64 KiB; and no argument can carry a NUL.
 */
function valueFault(name: string, value: string): string | null {
  if (idPlaceholders.includes(name)) {
    return idPattern.test(value) ? null
      : `{${name}} is an id: a letter or digit, then letters, digits, ".", "_" or "-"; ${JSON.stringify(value)} is not one`;
  }
  if (value.includes("\0")) return `{${name}} holds a NUL, which no argument can carry`;
  const bytes = Buffer.byteLength(value, "utf8");
  if (name === "title") {
    if (/[\r\n]/.test(value)) return "{title} is one line, with no line break";
    if (bytes > maxTitleBytes) return `{title} is ${bytes} bytes, more than the ${maxTitleBytes} a title may be`;
  } else if (bytes > maxTextBytes) {
    return `{${name}} is ${bytes} bytes, more than the ${maxTextBytes} a text may be`;
  }
  return null;
}

/**
 * The verb's argument list with the call's values in it, or why the call cannot have it: a
 * verb the tracker configures, each placeholder it takes supplied and none it does not, each
 * value one `valueFault` passes, and a message exactly where the verb writes. Every
 * placeholder is filled in one pass, so a value holding `{id}` or `$&` arrives as it is.
 */
function trackCommand(records: RecordsConfig, request: TrackRequest): TrackCommand | { reason: string } {
  const verbs = Object.keys(trackerVerbs) as TrackerVerb[];
  if (!(verbs as string[]).includes(request.verb)) {
    return { reason: `track runs one of the verbs ${verbs.join(", ")}, and not ${JSON.stringify(request.verb)}` };
  }
  const verb = request.verb as TrackerVerb;
  const template = records.tracker[verb];
  if (template === undefined) return { reason: `the tracker has no ${verb}: records.tracker in ${CONFIG_PATH} does not configure it` };
  const { writes } = trackerVerbs[verb];
  const takes: readonly string[] = trackerVerbs[verb].placeholders;
  const taken = takes.length === 0 ? "none" : takes.map((name) => `{${name}}`).join(", ");
  const values: Record<string, string> = {};
  for (const name of valueNames) {
    const value = request[name];
    if (value === undefined) {
      if (takes.includes(name)) return { reason: `${verb} needs {${name}}: it takes ${taken}` };
      continue;
    }
    if (!takes.includes(name)) return { reason: `${verb} takes no {${name}}: it takes ${taken}` };
    const fault = valueFault(name, value);
    if (fault !== null) return { reason: fault };
    values[name] = value;
  }
  if (writes && (request.message === undefined || request.message === "" || request.message.includes("\0"))) {
    return { reason: `${verb} writes, so it needs a message, the commit message: non-empty, with no NUL` };
  }
  if (!writes && request.message !== undefined) return { reason: `${verb} reads and commits nothing, so it takes no message` };
  return {
    verb, writes,
    argv: template.map((argument) => argument.replace(/\{([A-Za-z]+)\}/g, (_match, name: string) => values[name])),
    ids: takes.filter((name) => idPlaceholders.includes(name)).map((name) => values[name]),
  };
}

/** One filled command and where and how it runs. */
interface Tracker {
  verb: TrackerVerb;
  argv: string[];
  located: Repository;
  env: NodeJS.ProcessEnv;
  seconds: number;
}

/** The tracker run to its end or its kill, or the refusal for a command that could not be started, so nothing ran. */
async function runTracker({ verb, argv, located, env, seconds }: Tracker): Promise<Ran | Failure & { verb: string }> {
  try {
    return await runArgv(argv, located.workTree, env, seconds);
  } catch (error) {
    return { ok: false, reason: `the tracker's ${verb} command ${JSON.stringify(argv[0])} could not be started: ${message(error)}`, verb };
  }
}

/** Why a tracker run that ended is no success, or null. */
function ranFault(verb: TrackerVerb, ran: Ran, seconds: number): string | null {
  if (ran.timedOut === true) return `the tracker's ${verb} ran longer than ${seconds}s and was killed`;
  return ran.exitCode === 0 ? null : `the tracker's ${verb} exited ${ran.exitCode}`;
}

/**
 * The project's tracker (design section 4, "`track`"): one configured verb, its argument list
 * filled from the call's values and run at the root with no shell, as a plain child of the
 * server, in `run_command`'s environment, killed at `trackTimeoutSeconds`. Every value is
 * judged before anything runs or is locked. A reading verb runs under `git.lock` alone and
 * commits nothing (`trackRead`); a writing verb runs on `record`'s root commit procedure under
 * both locks, and only `tracker.files` are committed (`trackWrite`). `track` never reverses
 * what the tracker changed: a refusal leaves it in place and names it, and the only thing
 * undone is `track`'s own staging when a commit fails.
 */
export async function track(projectRoot: string, request: TrackRequest, options: TrackOptions): Promise<TrackResult> {
  let records: RecordsConfig;
  let defaultBranch: string;
  let billing: CrossAgentConfig["billing"];
  try {
    const { config } = loadConfigWithMode(projectRoot, options.modesDir);
    if (config.records === undefined) return { ok: false, reason: `${CONFIG_PATH} has no records block` };
    records = config.records;
    defaultBranch = config.project.defaultBranch;
    billing = config.billing;
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  const command = trackCommand(records, request);
  if ("reason" in command) return { ok: false, reason: command.reason };
  const { verb, argv, ids, writes } = command;

  const located = await locateRepository(projectRoot);
  if ("reason" in located) return { ok: false, reason: located.reason };
  const unwritable = rootWriteFault(located, projectRoot, defaultBranch, writes ? "write" : "initialized");
  if (unwritable !== null) return { ok: false, reason: unwritable };

  const tracker: Tracker = {
    verb, argv, located,
    env: commandEnv(options.env ?? process.env, options.depth ?? 0, billing, projectRoot),
    seconds: options.timeoutSeconds ?? trackTimeoutSeconds,
  };
  return underLocks(projectRoot, located.commonDir, options.waitSeconds, `track ${verb}`, writes, () => writes
    ? trackWrite(projectRoot, tracker, { ids, message: request.message!, files: records.tracker.files, defaultBranch, runId: options.run })
    : trackRead(tracker));
}

/**
 * A reading verb, under `git.lock` alone: the root needs no clean state and nothing is
 * committed, but a read that moved HEAD or changed what the root shows is refused, naming
 * what it changed, which is left where it is.
 */
async function trackRead(tracker: Tracker): Promise<TrackResult> {
  const { verb, located: { gitDir, workTree } } = tracker;
  const snapshot = async () => {
    const at = await run(gitDir, workTree, ["rev-parse", "--verify", "-q", "HEAD"]);
    return { head: at.exitCode === 0 ? at.stdout.trim() : "no commit", shown: await uncommitted(gitDir, workTree) };
  };
  const before = await snapshot();
  if ("unread" in before.shown) return { ok: false, reason: before.shown.unread };
  const was = before.shown;
  const ran = await runTracker(tracker);
  if ("reason" in ran) return ran;
  const answered = { verb, exitCode: ran.exitCode, output: ran.tail };
  const after = await snapshot();
  if (after.head !== before.head) {
    return { ok: false, reason: `${verb} reads, and the tracker moved HEAD from ${before.head} to ${after.head}; it is left where the tracker put it`, ...answered };
  }
  if ("unread" in after.shown) return { ok: false, reason: after.shown.unread, ...answered };
  const now = after.shown;
  const changed = [...now.filter((entry) => !was.includes(entry)), ...was.filter((entry) => !now.includes(entry))];
  if (changed.length > 0) {
    return { ok: false, reason: `${verb} reads, and the tracker changed what the root shows: ${changed.join(", ")}; the change is left in place`, ...answered };
  }
  const failed = ranFault(verb, ran, tracker.seconds);
  if (failed !== null) return { ok: false, reason: failed, ...answered };
  return { ok: true, verb, exitCode: 0, output: ran.tail };
}

/**
 * A writing verb, on section 4's procedure under both locks: the root wholly clean and no
 * tracker file marked; the tracker run; HEAD still `before`, judged before anything else;
 * a tracker that failed or was killed refused; every entry the root then shows one of
 * `files`; and those entries committed and verified, or, where there are none, the call
 * journaled with no commit.
 */
async function trackWrite(
  projectRoot: string, tracker: Tracker, call: { ids: string[]; message: string; files: string[]; defaultBranch: string; runId: string },
): Promise<TrackResult> {
  const { verb, located } = tracker;
  const { gitDir, workTree } = located;
  const { ids, message: commitMessage, files, defaultBranch, runId } = call;

  const ready = await rootReady(trackLabel, projectRoot, located, defaultBranch, runId, files);
  if ("reason" in ready) return ready;
  const { before } = ready;

  const ran = await runTracker(tracker);
  if ("reason" in ran) return ran;
  const answered = { verb, exitCode: ran.exitCode, output: ran.tail };
  // From here on, what the tracker changed stays where it is: a refusal names what the root
  // shows, for the operator to commit or remove.
  const leftIn = async (reason: string): Promise<string> => {
    let shown: string[] = [];
    try {
      const read = await uncommitted(gitDir, workTree);
      if (!("unread" in read)) shown = read;
    } catch { /* the reason stands without it */ }
    return shown.length === 0 ? reason : `${reason}; the root shows ${shown.join(", ")}, left in place`;
  };
  const refused = async (reason: string): Promise<TrackResult> => ({ ok: false, reason: await leftIn(reason), ...answered });

  // HEAD where it was, before anything else is judged: a tracker that committed for itself
  // has moved the branch past `before`, and no commit of its own is this call's to journal.
  const head = await run(gitDir, workTree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const on = head.exitCode === 0 ? head.stdout.trim() : "";
  if (on !== defaultBranch) return refused(`the tracker moved the root off ${defaultBranch}, to ${on || "no branch"}; nothing was committed`);
  const now = await revision(gitDir, workTree, defaultBranch);
  if (now !== before) return refused(`the tracker moved ${defaultBranch} from ${before} to ${now ?? "no commit"}; nothing was committed`);
  const failed = ranFault(verb, ran, tracker.seconds);
  if (failed !== null) return refused(`${failed}; nothing was committed`);

  // Everything the tracker changed is one of its declared files; these entries are what the
  // commit carries.
  const changed = await uncommitted(gitDir, workTree);
  if ("unread" in changed) return { ok: false, reason: changed.unread, ...answered };
  const strays = changed.filter((entry) => !files.includes(entry));
  if (strays.length > 0) {
    return refused(`track commits only records.tracker.files (${files.join(", ") || "none"}), and the tracker changed ${strays.join(", ")}; nothing was committed`);
  }
  if (changed.length === 0) {
    try {
      const appendedJournal = appendRunStep(projectRoot, runId, defaultBranch, {
        step: "tracked", at: Date.now(), verb, ids, before, paths: [], message: commitMessage,
      });
      return { ok: true, verb, exitCode: 0, output: ran.tail, journal: appendedJournal.steps[appendedJournal.steps.length - 1] as TrackedStep };
    } catch (error) {
      return { ok: false, reason: `the tracker's ${verb} ran and left nothing to commit, but its step could not be written: ${message(error)}`, ...answered };
    }
  }

  const landed = await landCommit(trackLabel, projectRoot, located, defaultBranch, runId, before, changed, commitMessage, changed, () => [],
    ({ after, problems }): TrackedStep => ({
      step: "tracked", at: Date.now(), verb, ids, before, after, paths: changed, message: commitMessage,
      verified: problems.length === 0, ...(problems.length === 0 ? {} : { problems }),
    }));
  if (landed.ok) return { ok: true, verb, exitCode: 0, output: ran.tail, paths: landed.paths, commit: landed.commit, journal: landed.journal };
  // A commit that did not land leaves the tracker's change standing, as every refusal here does.
  return { ...landed, reason: landed.commit === undefined ? await leftIn(landed.reason) : landed.reason, ...answered };
}
