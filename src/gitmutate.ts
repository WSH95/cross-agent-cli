import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.ts";
import { appendStep, readJournal } from "./journal.ts";
import type { JournalEntry } from "./journal.ts";
import { acquire, gitLockName, lockPath } from "./locks.ts";
import { reservations, reservedBy } from "./reservation.ts";
import { verifyWorktree } from "./worktree.ts";

export interface GitMutateRequest {
  slug: string;
  /** Defaults to `<projectRoot>/.worktrees/<slug>`, the worktree provider's own default. */
  path?: string;
  /** Defaults to `task/<slug>`. The worktree's HEAD must be exactly this branch. */
  branch?: string;
  args: string[];
}

export interface GitMutateOptions {
  /** How long to wait for `git.lock`; `limits.lockWaitSeconds` of the loaded config. */
  waitSeconds: number;
  now?: number;
}

export type GitMutateResult =
  | { ok: true; exitCode: 0; stdout: string; stderr: string; before?: string; after?: string; journal: JournalEntry }
  | { ok: false; reason: string; exitCode?: number; stdout?: string; stderr?: string };

const exec = promisify(execFile);
// One git subcommand's output. Larger than anything a lead's mutation produces, and still
// bounded, because exceeding it kills the child — which for a mutation is worse than
// truncation would be.
const maxBuffer = 16 * 1024 * 1024;
// Each of these turns a whitelisted verb into an arbitrary one against an arbitrary
// repository, which is exactly what this tool exists to prevent (design section 4).
const globalOptions = new Set(["--git-dir", "--work-tree", "-C", "-c"]);

function argumentFault(args: unknown): string | null {
  if (!Array.isArray(args) || args.length === 0) return "git_mutate needs a git subcommand: args is empty";
  if (args.some((argument) => typeof argument !== "string")) return "every git argument must be a string";
  const values = args as string[];
  if (values[0].startsWith("-")) {
    return `git_mutate runs one git subcommand in the verified worktree; ${values[0]} is a global option, not a subcommand`;
  }
  for (const argument of values) {
    if (globalOptions.has(argument) || argument.startsWith("--git-dir=") || argument.startsWith("--work-tree=")) {
      return `git_mutate supplies the verified worktree's own --git-dir and --work-tree; ${argument} is refused`;
    }
  }
  return null;
}

interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// The explicit form of probe P7: the pointer file is never consulted, and the paths are
// the ones the verifier resolved. GIT_DIR and GIT_WORK_TREE are dropped from the child's
// environment, because a server started from inside a git command inherits them.
async function run(gitDir: string, workTree: string, args: string[]): Promise<Ran> {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const argv = [`--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args];
  try {
    const { stdout, stderr } = await exec("git", argv, { cwd: workTree, env, encoding: "utf8", maxBuffer });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") throw error;
    return { exitCode: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** A branch's SHA, or undefined when there is no such branch to record. */
async function revision(gitDir: string, workTree: string, branch: string): Promise<string | undefined> {
  const ran = await run(gitDir, workTree, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const sha = ran.stdout.trim();
  return ran.exitCode === 0 && sha.length > 0 ? sha : undefined;
}

/**
 * The lead's only way to mutate git inside a worktree (design section 4). A linked
 * worktree's `.git` is a writable file inside the implementer's sandbox, so nothing here
 * trusts it: the four steps are refuse while the workspace is reserved, verify the
 * worktree from the root, run the command under `git.lock` against the directories the
 * verifier returned, and journal the step with the SHAs around it.
 */
export async function gitMutate(
  projectRoot: string, request: GitMutateRequest, options: GitMutateOptions,
): Promise<GitMutateResult> {
  const fault = argumentFault(request.args);
  // The shape of the request is judged first: it needs no lock, no scan, and no worktree.
  if (fault !== null) return { ok: false, reason: fault };
  // The slug names the journal file, and the step this call appends has to be recordable
  // before the command runs: a slug that is not a file name of its own, or a journal that
  // cannot be read, would otherwise be found only once the mutation had happened.
  try {
    readJournal(projectRoot, request.slug);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const slug = request.slug;
  const branch = request.branch ?? `task/${slug}`;
  const target = path.resolve(projectRoot, request.path ?? path.join(".worktrees", slug));

  // 1. A task that may write there owns it until it settles, and a record nobody can read
  // is a task whose workspace nobody can clear (design section 2, E2).
  const known = reservations(projectRoot);
  const holder = reservedBy(projectRoot, target, known);
  if (holder !== null) {
    return { ok: false, reason: `${target} is reserved by task ${holder.id} (${holder.status}); wait or cancel first` };
  }
  if (known.unknown.length > 0) {
    const files = known.unknown.map((entry) => `${entry.file} (${entry.reason})`).join(", ");
    return {
      ok: false,
      reason: `no workspace can be cleared while a task record cannot be read: ${files}; repair or remove it first`,
    };
  }

  // 2. Verification from the root, and its answer is what step 3 runs against.
  const verified = await verifyWorktree(projectRoot, target, branch);
  if ("reason" in verified) return { ok: false, reason: verified.reason };
  const { gitDir, workTree } = verified;
  const defaultBranch = loadConfig(projectRoot).project.defaultBranch;

  // 3. One mutation at a time across the project.
  const lock = await acquire(lockPath(projectRoot, gitLockName()), {
    waitSeconds: options.waitSeconds, operation: `git_mutate ${slug} ${request.args[0]}`,
  });
  try {
    const before = await revision(gitDir, workTree, verified.branch);
    const defaultShaBeforeMerge = await revision(gitDir, workTree, defaultBranch);
    const ran = await run(gitDir, workTree, request.args);
    if (ran.exitCode !== 0) {
      return {
        ok: false,
        reason: `git ${request.args.join(" ")} exited ${ran.exitCode} in ${workTree}`,
        exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr,
      };
    }
    const after = await revision(gitDir, workTree, verified.branch);

    // 4. The journal is written while the lock is still held, so the steps of two callers
    // are ordered by the same lock that ordered their commands.
    let journal;
    try {
      journal = appendStep(projectRoot, slug, "git", {
        at: options.now ?? Date.now(), before, after, args: request.args,
        branch: verified.branch, defaultBranch,
        // git_mutate mutates a worktree and never merges into the default branch, so the
        // SHA it records is always one from before this journal's merge.
        ...(defaultShaBeforeMerge === undefined ? {} : { defaultShaBeforeMerge }),
        ...(after === undefined ? {} : { branchHead: after }),
      });
    } catch (error) {
      // The mutation happened; only the record of it did not. Saying `ok` would tell the
      // lead its journal is current, and saying nothing would hide a completed commit.
      return {
        ok: false,
        reason: `git ${request.args.join(" ")} ran in ${workTree}, but its journal step could not be written: ${error instanceof Error ? error.message : String(error)}`,
        exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr,
      };
    }
    return {
      ok: true, exitCode: 0, stdout: ran.stdout, stderr: ran.stderr,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      journal: journal.steps[journal.steps.length - 1],
    };
  } finally {
    await lock.release();
  }
}
