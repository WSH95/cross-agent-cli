import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.ts";
import { appendStep, readJournal } from "./journal.ts";
import type { Journal, JournalEntry } from "./journal.ts";
import { acquire, gitLockName, lockPath, spawnLockName } from "./locks.ts";
import type { Lock } from "./locks.ts";
import { reservations, reservedBy } from "./reservation.ts";
import { gitEnvironment, verifyWorktree } from "./worktree.ts";

export interface GitMutateRequest {
  slug: string;
  /** Defaults to `<projectRoot>/.worktrees/<slug>`, the worktree provider's own default. */
  path?: string;
  /** Defaults to `task/<slug>`. The worktree's HEAD must be exactly this branch. */
  branch?: string;
  args: string[];
}

export interface GitMutateOptions {
  /**
   * How long to wait for each of `spawn.lock` and `git.lock` before refusing;
   * `limits.lockWaitSeconds` of the loaded config.
   */
  waitSeconds: number;
  now?: number;
}

export type GitMutateResult =
  | {
    ok: true; exitCode: 0; stdout: string; stderr: string; before?: string; after?: string;
    /** A lock was lost while the command ran: the mutation is done, its exclusivity is not. */
    lockLost?: true;
    journal: JournalEntry;
  }
  | { ok: false; reason: string; exitCode?: number; stdout?: string; stderr?: string };

/** git could not be run at all — no exit code to report, so there is nothing to judge. */
class GitRunError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GitRunError";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
// the ones the verifier resolved. The child's environment is the allowlist every git
// invocation in this project gets, so nothing the server inherited can redirect it.
async function run(gitDir: string, workTree: string, args: string[]): Promise<Ran> {
  const env = gitEnvironment();
  const argv = [`--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args];
  try {
    const { stdout, stderr } = await exec("git", argv, { cwd: workTree, env, encoding: "utf8", maxBuffer });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    // No numeric code means the child never reported one: git was not found, or it died on
    // a signal. That is not a git failure the lead can read, so it is named as its own.
    if (typeof failure.code !== "number") throw new GitRunError(`git ${args.join(" ")} could not run in ${workTree}: ${message(error)}`);
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
 * verifier returned, and journal the step with the SHAs around it. This function judges
 * the request, which needs no lock at all, and then takes `spawn.lock` for the four.
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
    return { ok: false, reason: message(error) };
  }
  const slug = request.slug;
  const branch = request.branch ?? `task/${slug}`;
  const target = path.resolve(projectRoot, request.path ?? path.join(".worktrees", slug));

  // The lock order is always spawn.lock and then git.lock. `delegate` holds spawn.lock
  // around validate-and-spawn (T10), so holding it across this whole call is what keeps
  // the reservation check below from racing a delegation about to take this workspace.
  let claim: Lock;
  try {
    claim = await acquire(lockPath(projectRoot, spawnLockName()), {
      waitSeconds: options.waitSeconds, operation: `git_mutate ${slug} ${request.args[0]}`,
    });
  } catch (error) {
    // A caller that could not even take the lock is told so, like every other refusal: the
    // lead has one thing to read whatever stopped its mutation.
    return { ok: false, reason: message(error) };
  }
  try {
    return await mutate(projectRoot, request, options, { slug, branch, target, claim });
  } finally {
    await claim.release();
  }
}

/** The four steps, with `spawn.lock` held for all of them. */
async function mutate(
  projectRoot: string, request: GitMutateRequest, options: GitMutateOptions,
  { slug, branch, target, claim }: { slug: string; branch: string; target: string; claim: Lock },
): Promise<GitMutateResult> {
  // A journal belongs to one branch: every step's SHAs were recorded against it, so a call
  // on another branch under the same slug is refused before anything runs. The journal is
  // read here, under the lock, because two first calls on one slug would otherwise both
  // find no journal and both commit, on two different branches.
  let journalled: Journal | null;
  try {
    journalled = readJournal(projectRoot, slug);
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  if (journalled !== null && journalled.branch !== branch) {
    return { ok: false, reason: `slug ${slug} is journaled on ${journalled.branch}; refusing ${branch}` };
  }

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
  let defaultBranch: string;
  try {
    defaultBranch = loadConfig(projectRoot).project.defaultBranch;
  } catch (error) {
    return { ok: false, reason: message(error) };
  }

  // 3. One mutation at a time across the project.
  let lock: Lock;
  try {
    lock = await acquire(lockPath(projectRoot, gitLockName()), {
      waitSeconds: options.waitSeconds, operation: `git_mutate ${slug} ${request.args[0]}`,
    });
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  try {
    const before = await revision(gitDir, workTree, verified.branch);
    const defaultSha = await revision(gitDir, workTree, defaultBranch);
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
        // What the default branch was for this step, and nothing more: the journal's own
        // revert target is the SHA it has at the merge, which the lead's merge step writes.
        ...(defaultSha === undefined ? {} : { defaultSha }),
      });
    } catch (error) {
      // The mutation happened; only the record of it did not. Saying `ok` would tell the
      // lead its journal is current, and saying nothing would hide a completed commit.
      return {
        ok: false,
        reason: `git ${request.args.join(" ")} ran in ${workTree}, but its journal step could not be written: ${message(error)}`,
        exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr,
      };
    }
    return {
      ok: true, exitCode: 0, stdout: ran.stdout, stderr: ran.stderr,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      // The command ran and is journaled, but if the kernel dropped either lock while it
      // did, another mutation or a delegate may already have started: the caller is told
      // rather than left to believe the whole call was exclusive.
      ...(lock.lost || claim.lost ? { lockLost: true as const } : {}),
      journal: journal.steps[journal.steps.length - 1],
    };
  } catch (error) {
    if (error instanceof GitRunError) return { ok: false, reason: error.message };
    throw error;
  } finally {
    await lock.release();
  }
}
