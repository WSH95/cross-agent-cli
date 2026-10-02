import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.ts";
import { appendStep, readJournal } from "./journal.ts";
import type { Journal, JournalEntry, JournalStep } from "./journal.ts";
import { projectLock } from "./ledger.ts";
import { gitLockName, spawnLockName } from "./locks.ts";
import type { Lock } from "./locks.ts";
import { reservations, reservedBy } from "./reservation.ts";
import type { Reservations } from "./reservation.ts";
import { gitEnvironment, verifyWorktree } from "./worktree.ts";

export interface GitMutateRequest {
  slug: string;
  /** Defaults to `<projectRoot>/<dir>/<slug>`, the mode's own worktree directory. */
  path?: string;
  /** Defaults to the mode's branch pattern with the slug in it. The worktree's HEAD must be exactly this branch. */
  branch?: string;
  args: string[];
}

export interface GitMutateOptions {
  /**
   * How long to wait for each of `spawn.lock` and `git.lock` before refusing;
   * `limits.lockWaitSeconds` of the loaded config.
   */
  waitSeconds: number;
  /**
   * The active mode's `git.worktreeDir`, which `path` defaults to. Both defaults are the
   * mode's, because `dir` and `branchPattern` are already the mode's (design section 4);
   * the values here are the built-in team's, for a caller that has no mode to hand.
   */
  dir?: string;
  /** The active mode's `git.branchPattern`, whose one `*` the slug fills. */
  branchPattern?: string;
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
export class GitRunError extends Error {
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
// repository, which is exactly what this tool exists to prevent (design section 4). Both
// git tools refuse them; `git_root` reads this same set (`src/gitroot.ts#argumentFault`).
export const globalOptions = new Set(["--git-dir", "--work-tree", "-C", "-c"]);

/**
 * Where each host reads a project's own configuration: Claude Code's `.claude/` (settings
 * and hooks) and `.mcp.json` (MCP servers), Codex's `.codex/`, Grok's `.grok/config.toml`
 * (plugins and servers). Each is loaded by the operator's own host session, outside any
 * sandbox, so none of them reaches the root through a task: `git_root` refuses a merge that
 * would carry one (`src/gitroot.ts#smuggled`), which is the gate, and `git_mutate` a commit
 * (`hostConfigFault`), which is the early warning. `AGENTS.md` and `CLAUDE.md` were
 * considered and are not here: a host reads them as instruction text and starts nothing
 * from them, and they are ordinary team edits the code reviewer reads in the diff.
 */
export const hostConfigPaths: readonly string[] = [".claude", ".codex", ".grok", ".mcp.json"];

/**
 * `hostConfigPaths` as both git tools match them: in any case, since a host on a filesystem
 * that ignores case reads `.Claude/` as `.claude/`, and as these names alone, so
 * `.claude-plugin/`, `.claude.json`, `.mcp.json.bak` and a `.mcp.json` below the root are
 * none of them.
 */
export const hostConfigPathspecs: readonly string[] = hostConfigPaths.map((entry) => `:(icase)${entry}`);

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

// The rebase's own control verbs. Each of them ends or steers a rebase already in
// progress; none of them is the loop's rebase onto the default branch.
const rebaseControls = new Set(["--abort", "--continue", "--skip", "--quit", "--edit-todo", "--show-current-patch"]);

/**
 * Section 7's table: the step a subcommand completes is written under its own name, by
 * the tool that performed it. A step is named for what it **moved** — `git commit
 * --dry-run` and a rebase that replayed nothing leave the branch where it was, and a
 * reconciliation pass reading `committed` would go looking for a commit that is not
 * there. Everything else is a `git` step carrying the arguments it ran instead of a name;
 * a named one carries both, because the lead composed those arguments and the message or
 * the upstream they name is evidence.
 */
function stepName(args: readonly string[], before?: string, after?: string): JournalStep {
  if (before === after) return "git";
  if (args[0] === "commit") return "committed";
  if (args[0] === "rebase" && !rebaseControls.has(args[1] ?? "")) return "rebased";
  return "git";
}

/** Exactly `rebase --abort`, the one command a detached HEAD may run (design section 4). */
function abortsRebase(args: readonly string[]): boolean {
  return args.length === 2 && args[0] === "rebase" && args[1] === "--abort";
}

/**
 * Whether git's own rebase state in this worktree names `branch` as the branch being
 * rebased. A rebase that stops on a conflict leaves HEAD detached, so the verifier's
 * branch check would refuse the one command that can undo it; this file is what says the
 * detached HEAD belongs to this task rather than to something else (design section 4).
 */
async function rebasing(gitDir: string, branch: string): Promise<boolean> {
  for (const directory of ["rebase-merge", "rebase-apply"]) {
    try {
      const head = await readFile(path.join(gitDir, directory, "head-name"), "utf8");
      if (head.trim() === `refs/heads/${branch}`) return true;
    } catch { /* no rebase of that kind is in progress here */ }
  }
  return false;
}

// The explicit form of probe P7: the pointer file is never consulted, and the paths are
// the ones the verifier resolved. The child's environment is the allowlist every git
// invocation in this project gets, so nothing the server inherited can redirect it.
// `git_root` runs through this too, with the root's own directories, so there is one
// place where this project decides what git works on (design section 4).
export async function run(gitDir: string, workTree: string, args: string[]): Promise<Ran> {
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
export async function revision(gitDir: string, workTree: string, branch: string): Promise<string | undefined> {
  const ran = await run(gitDir, workTree, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const sha = ran.stdout.trim();
  return ran.exitCode === 0 && sha.length > 0 ? sha : undefined;
}

/**
 * Whether a tracked file's working-tree bytes differ from its index entry: what a commit
 * naming the path would record, read where git's own view is not to be trusted, under an
 * assume-unchanged mark that `status` takes at its word. A symbolic link's entry (mode
 * `120000`) holds its target's path, so a link is judged by the bytes `readlink` returns,
 * hashed as a blob the way git hashes one; `hash-object` would follow it and hash the file it
 * points at. A file that cannot be read, one gone from the worktree included, one whose kind
 * is no longer its entry's, and one with no single index entry are taken to differ.
 */
async function differsFromIndex(gitDir: string, workTree: string, file: string): Promise<boolean> {
  const staged = await run(gitDir, workTree, ["ls-files", "-s", "-z", "--", `:(literal)${file}`]);
  // `<mode> <object> <stage>\t<path>`, stage 0 for a path with no conflict.
  const entry = /^([0-7]+) ([0-9a-f]+) 0\t/.exec(staged.stdout);
  if (staged.exitCode !== 0 || entry === null) return true;
  const [, mode, object] = entry;
  let onDisk: fs.Stats | undefined;
  try {
    onDisk = fs.lstatSync(path.join(workTree, file), { throwIfNoEntry: false });
  } catch {
    return true;
  }
  if (onDisk === undefined || onDisk.isSymbolicLink() !== (mode === "120000")) return true;
  if (onDisk.isSymbolicLink()) {
    const format = await run(gitDir, workTree, ["rev-parse", "--show-object-format"]);
    if (format.exitCode !== 0) return true;
    const algorithm = format.stdout.trim() === "sha256" ? "sha256" : "sha1";
    // Read after the git call above, so the link may be gone or a file by now: that is a
    // change too, and never an error the caller has to catch.
    let target: Buffer;
    try {
      target = fs.readlinkSync(path.join(workTree, file), { encoding: "buffer" });
    } catch {
      return true;
    }
    const blob = createHash(algorithm).update(Buffer.concat([Buffer.from(`blob ${target.length}\0`), target])).digest("hex");
    return blob !== object;
  }
  const hashed = await run(gitDir, workTree, ["hash-object", "--", file]);
  return hashed.exitCode !== 0 || hashed.stdout.trim() !== object;
}

/**
 * Why a commit in this worktree may not run, or null: it would carry a host's project
 * configuration. The worktree is read, not the index alone, because `commit -a`, `commit
 * --include` and `commit -- <path>` record what the index does not hold: one `status` over
 * the four paths names what is staged, changed or untracked there, and nothing
 * `.gitignore` covers. A tracked file marked assume-unchanged is one `status` takes at its
 * word while a commit naming it records its bytes anyway, so `ls-files -v`, which tags such
 * a file in lowercase, is read beside it, and a marked file is carried when its bytes differ
 * from its index entry: the mark alone carries nothing, since git marks every tracked file so
 * under `core.ignoreStat`. Git sees no empty directory, so an empty `.claude/` an engine
 * leaves behind is never named. This is the early warning; the merge is the gate, and it
 * refuses what this does not see (`src/gitroot.ts#smuggled`).
 */
async function hostConfigFault(gitDir: string, workTree: string): Promise<string | null> {
  const unread = (ran: Ran, verb: string) =>
    `git_mutate could not read what a commit in ${workTree} would carry: ${ran.stderr.trim() || `git ${verb} exited ${ran.exitCode}`}`;
  const status = await run(gitDir, workTree, ["status", "--porcelain", "--untracked-files=all", "--", ...hostConfigPathspecs]);
  if (status.exitCode !== 0) return unread(status, "status");
  const listed = await run(gitDir, workTree, ["ls-files", "-v", "-z", "--", ...hostConfigPathspecs]);
  if (listed.exitCode !== 0) return unread(listed, "ls-files");
  // Each status line is `XY <path>`, a rename's `XY <old> -> <new>`, as git prints it; each
  // `ls-files -v -z` entry is `<tag> <path>`, the path unquoted.
  const carried = status.stdout.split("\n").filter(Boolean).map((line) => line.slice(3));
  const marked: string[] = [];
  for (const entry of listed.stdout.split("\0")) {
    if (!/^[a-z] /.test(entry)) continue;
    const file = entry.slice(2);
    if (carried.includes(file) || !await differsFromIndex(gitDir, workTree, file)) continue;
    marked.push(`${file} (marked assume-unchanged, which hides its changes from git status)`);
  }
  const paths = [...carried, ...marked];
  if (paths.length === 0) return null;
  return `git_mutate refuses to commit in ${workTree}: it would carry ${paths.join(", ")}. `
    + "A host's project configuration — .claude/, .codex/, .grok/ and .mcp.json, in any case — loads hooks, MCP servers "
    + "or plugins in the operator's own host session and is never committed through a task; remove it from the worktree, "
    + "or ignore it if it is the operator's own, clear any assume-unchanged mark on it (update-index --no-assume-unchanged), "
    + "and commit again";
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
  const branch = request.branch ?? (options.branchPattern ?? "task/*").replace("*", slug);
  const target = path.resolve(projectRoot, request.path ?? path.join(options.dir ?? ".worktrees", slug));

  // The lock order is always spawn.lock and then git.lock. `delegate` holds spawn.lock
  // around validate-and-spawn (T10), so holding it across this whole call is what keeps
  // the reservation check below from racing a delegation about to take this workspace.
  let claim: Lock;
  try {
    claim = await projectLock(projectRoot, spawnLockName(), {
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
  let known: Reservations;
  try {
    known = reservations(projectRoot);
  } catch (error) {
    // The scan names a fault in one record file and carries on; the directory holding them
    // faults as a whole — a mode nothing may read, a file where the directory belongs —
    // and nothing below it can read a single record. `mutate` promises the lead a refusal
    // for everything that stops a mutation, so this is one too, and it carries the
    // operating system's own words about the path.
    return {
      ok: false,
      reason: `no workspace can be cleared while no task record can be read: ${message(error)}; repair the task directory first`,
    };
  }
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
  let verified = await verifyWorktree(projectRoot, target, branch);
  if ("reason" in verified && abortsRebase(request.args)) {
    // The conflict path of section 4: HEAD is detached — `--abbrev-ref HEAD` answers
    // `HEAD`, which is no branch name git will take — so every other check the verifier
    // makes still has to pass, and git's own rebase state has to name this journal's
    // branch. The branch the step is recorded against is that one, not the detached HEAD.
    const detached = await verifyWorktree(projectRoot, target, "HEAD");
    if (!("reason" in detached) && await rebasing(detached.gitDir, branch)) verified = { ...detached, branch };
  }
  if ("reason" in verified) return { ok: false, reason: verified.reason };
  const { gitDir, workTree } = verified;
  // The journal is authoritative for its own path as it is for its own branch (section 7):
  // a call on another work tree is refused here, where the verifier's own resolution of
  // this one is in hand, and before anything runs.
  if (journalled?.worktree !== undefined && journalled.worktree !== workTree) {
    return { ok: false, reason: `slug ${slug} is journaled on worktree ${journalled.worktree}; refusing ${workTree}` };
  }
  let defaultBranch: string;
  try {
    defaultBranch = loadConfig(projectRoot).project.defaultBranch;
  } catch (error) {
    return { ok: false, reason: message(error) };
  }

  // 3. One mutation at a time across the project.
  let lock: Lock;
  try {
    lock = await projectLock(projectRoot, gitLockName(), {
      waitSeconds: options.waitSeconds, operation: `git_mutate ${slug} ${request.args[0]}`,
    });
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  try {
    // A commit is where a host's project configuration would leave the worktree for the
    // root. The tree and index it reads are what the commit records, so it is read here,
    // under the lock that orders this command against every other mutation.
    if (request.args[0] === "commit") {
      const carried = await hostConfigFault(gitDir, workTree);
      if (carried !== null) return { ok: false, reason: carried };
    }
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
      journal = appendStep(projectRoot, slug, stepName(request.args, before, after), {
        at: options.now ?? Date.now(), before, after, args: request.args,
        // The work tree is the verifier's answer, so a journal this call creates binds the
        // slug to the directory its steps actually ran in, not to the one the slug names.
        branch: verified.branch, worktree: workTree, defaultBranch,
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
