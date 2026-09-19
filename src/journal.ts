import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "./ledger.ts";

/**
 * The named steps of design section 7, plus `git` for any other `git_mutate` call, which
 * records the arguments it ran instead of a name.
 */
export type JournalStep =
  | "worktree-created" | "committed" | "rebased" | "merged"
  | "tests-passed" | "worktree-removed" | "branch-deleted" | "git";

export interface JournalEntry {
  step: JournalStep;
  at: number;
  before?: string;
  after?: string;
  /** What the default branch pointed at when this step ran. */
  defaultSha?: string;
  args?: string[];
}

export interface Journal {
  slug: string;
  branch: string;
  /**
   * The work tree every step of this task ran in, as the verifier resolved it or as
   * `git_root worktree add` created it. Write-once like `branch`, and absent only until a
   * step names one.
   */
  worktree?: string;
  defaultBranch: string;
  /**
   * What the default branch pointed at before the merge: the lead's revert target. The
   * default branch moves under a task, so this is not what it pointed at when the task
   * started — only the `merged` step knows it, and only that step writes it.
   */
  defaultShaBeforeMerge?: string;
  /** The task branch as it was merged; written by the `merged` step. */
  branchHead?: string;
  steps: JournalEntry[];
}

export interface StepData {
  /** Defaults to now; a caller with its own clock passes the one it already read. */
  at?: number;
  before?: string;
  after?: string;
  /** What the default branch pointed at when this step ran; every step may record it. */
  defaultSha?: string;
  args?: string[];
  /** The journal's own fields. Both branches are required by the step that creates it. */
  branch?: string;
  /** The work tree this step ran in; kept from the first step that names one. */
  worktree?: string;
  defaultBranch?: string;
  /** Read only from a `merged` step: the revert target and the head it merged. */
  defaultShaBeforeMerge?: string;
  branchHead?: string;
}

// A slug names a file here, a directory under .worktrees, and a branch, so it is one path
// segment of the same alphabet the ledger allows an id, and never `.` or `..`.
function journalFile(projectRoot: string, slug: string): string {
  if (typeof slug !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(slug)) {
    throw new Error(`invalid slug ${JSON.stringify(slug)}: expected [A-Za-z0-9._-], starting with a letter, digit, or underscore`);
  }
  return path.resolve(projectRoot, ".cross-agent", "journal", `${slug}.json`);
}

function fault(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "not a JSON object";
  const journal = value as Record<string, unknown>;
  for (const field of ["slug", "branch", "defaultBranch"] as const) {
    if (typeof journal[field] !== "string") return `${field} must be a string`;
  }
  if (!Array.isArray(journal.steps)) return "steps must be an array";
  return null;
}

/** The journal for `slug`, or null when the task has none yet. */
export function readJournal(projectRoot: string, slug: string): Journal | null {
  const file = journalFile(projectRoot, slug);
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`invalid journal ${file}: unparsable JSON: ${(error as Error).message}`);
  }
  const reason = fault(parsed);
  // Damage is named, never repaired in passing: an append that started from an empty
  // journal would drop every step the file still holds.
  if (reason !== null) throw new Error(`invalid journal ${file}: ${reason}`);
  return parsed as Journal;
}

/** The slug of every journal in the project, sorted; partial writes are not journals. */
export function listJournals(projectRoot: string): string[] {
  const directory = path.resolve(projectRoot, ".cross-agent", "journal");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && /^[A-Za-z0-9_][A-Za-z0-9._-]*\.json$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -".json".length))
    .sort();
}

/**
 * Appends one step to `slug`'s journal, creating it if this is the first, and returns the
 * journal as written. The write is the ledger's own atomic write, so a reader sees the
 * whole previous document or the whole new one. Ordering across processes is the
 * caller's: `git_mutate` appends while it still holds `git.lock`.
 */
export function appendStep(projectRoot: string, slug: string, step: JournalStep, data: StepData = {}): Journal {
  const file = journalFile(projectRoot, slug);
  const existing = readJournal(projectRoot, slug);
  // A journal belongs to one branch: every step's SHAs were recorded against it, so a
  // later step naming another does not move it. The default branch's name follows the
  // project's config.
  const branch = existing?.branch ?? data.branch;
  // The same rule for the path: a journal belongs to one work tree, and its steps' SHAs
  // were read there. The tool that took the call refuses a step naming another before git
  // runs (`src/gitmutate.ts#mutate`, `src/gitroot.ts#journalFault`); here the first wins.
  const worktree = existing?.worktree ?? data.worktree;
  const defaultBranch = data.defaultBranch ?? existing?.defaultBranch;
  if (branch === undefined || defaultBranch === undefined) {
    throw new Error(`journal ${slug}: the step that creates a journal must name its branch and defaultBranch`);
  }
  // The revert target is the SHA the default branch had **at the merge**, and the merge is
  // the only step that knows it: the branch moves under a task, so a value recorded by the
  // task's first commit would aim a revert at a point before other tasks' merges. Every
  // other step records what it saw in its own step instead, and a task merges once.
  const merging = step === "merged";
  if (merging && (existing?.steps ?? []).some((entry) => entry.step === "merged")) {
    throw new Error(`journal ${slug}: a merged step is already recorded; a task merges once`);
  }
  const defaultShaBeforeMerge = merging ? data.defaultShaBeforeMerge ?? existing?.defaultShaBeforeMerge : existing?.defaultShaBeforeMerge;
  const branchHead = merging ? data.branchHead ?? existing?.branchHead : existing?.branchHead;
  const entry: JournalEntry = {
    step,
    at: data.at ?? Date.now(),
    ...(data.before === undefined ? {} : { before: data.before }),
    ...(data.after === undefined ? {} : { after: data.after }),
    ...(data.defaultSha === undefined ? {} : { defaultSha: data.defaultSha }),
    ...(data.args === undefined ? {} : { args: [...data.args] }),
  };
  const journal: Journal = {
    slug,
    branch,
    ...(worktree === undefined ? {} : { worktree }),
    defaultBranch,
    ...(defaultShaBeforeMerge === undefined ? {} : { defaultShaBeforeMerge }),
    ...(branchHead === undefined ? {} : { branchHead }),
    steps: [...(existing?.steps ?? []), entry],
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, journal);
  return journal;
}
