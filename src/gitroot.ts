import { realpath } from "node:fs/promises";
import path from "node:path";
import { loadConfig, repositoryLockWait } from "./config.ts";
import { GitRunError, globalOptions, hostConfigPathspecs, hostTreeLinks, revision, run } from "./gitmutate.ts";
import { appendStep, readJournal } from "./journal.ts";
import type { Journal, JournalEntry, JournalStep } from "./journal.ts";
import { projectLock } from "./ledger.ts";
import { acquire, gitLockName, repositoryLockPath, spawnLockName } from "./locks.ts";
import type { Lock } from "./locks.ts";
import { reservations, reservedBy } from "./reservation.ts";
import { locateRepository, rootWriteFault } from "./worktree.ts";

export interface GitRootRequest {
  args: string[];
  /**
   * The task whose journal this call's step belongs to, named and never inferred: a
   * slug's worktree may carry another slug's branch (design section 7), so no argument
   * here says which journal a step is for. A verb that journals nothing takes none.
   */
  slug?: string;
}

export interface GitRootOptions {
  /** How long to wait for `git.lock` before refusing; `limits.lockWaitSeconds`. */
  waitSeconds: number;
  /**
   * The active mode's `git.worktreeDir`: the one directory a worktree may be created in
   * or removed from. The default is the built-in team's, for a caller with no mode.
   */
  dir?: string;
  /** The active mode's `git.branchPattern`, which a new task branch must match. */
  branchPattern?: string;
  now?: number;
}

export type GitRootResult =
  | {
    ok: true; exitCode: 0; stdout: string; stderr: string;
    /** The default branch's SHA before and after the call: what a root verb moves. */
    before?: string; after?: string;
    /** `git.lock` was lost while the command ran: it is done, its exclusivity is not. */
    lockLost?: true;
    /** The step as written, for a verb that completes one. */
    journal?: JournalEntry;
  }
  | { ok: false; reason: string; exitCode?: number; stdout?: string; stderr?: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a positional argument of a verb must be, and who decides it. */
type Positional =
  // A new task branch: it must match the mode's pattern.
  | "branch"
  // A branch the journal names: the slug's record decides, not the pattern.
  | "ref"
  // What a worktree is created from: the default branch and nothing else.
  | "base"
  // A directory inside the mode's worktree directory.
  | "dir"
  // A branch a read may name: the pattern or the default branch.
  | "read-ref"
  // A `--list` pattern, which may be the mode's own pattern with its `*`.
  | "list-pattern";

interface Verb {
  /** The verb as section 4 writes it; a refusal quotes this. */
  form: string;
  /** The leading arguments that name it, matched exactly. */
  head: string[];
  /** The arguments that follow, in order. */
  tail: Positional[];
  /** How many trailing positionals may be left out. */
  optional?: number;
  /** The options this verb also accepts, anywhere after its head. */
  options?: RegExp;
  /** The step it completes; a verb with one takes a slug and journals it. */
  step?: JournalStep;
}

/**
 * The whitelist of design section 4, in code and never in config: it is the whole security
 * argument for handing an engine any root git access at all. Each entry is a verb *and*
 * the shape it is accepted in — `worktree add` without `-b` is not this verb, and
 * `--force` belongs to no verb here, so a worktree that still holds work is refused on
 * git's own terms.
 */
const whitelist: Verb[] = [
  {
    form: "worktree add -b <branch> <dir> <base>", head: ["worktree", "add", "-b"],
    tail: ["branch", "dir", "base"], step: "worktree-created",
  },
  { form: "worktree remove <dir>", head: ["worktree", "remove"], tail: ["dir"], step: "worktree-removed" },
  { form: "worktree list [--porcelain] [-z]", head: ["worktree", "list"], tail: [], options: /^(--porcelain|-z)$/ },
  { form: "branch -d <branch>", head: ["branch", "-d"], tail: ["ref"], step: "branch-deleted" },
  { form: "branch --list [<pattern>]", head: ["branch", "--list"], tail: ["list-pattern"], optional: 1 },
  { form: "merge --ff-only <branch>", head: ["merge", "--ff-only"], tail: ["ref"], step: "merged" },
  { form: "rebase --abort", head: ["rebase", "--abort"], tail: [] },
  {
    form: "status [--porcelain] [--untracked-files=<mode>]", head: ["status"], tail: [],
    options: /^(--porcelain|--untracked-files=(normal|no|all))$/,
  },
  {
    form: "log [--oneline] [--max-count=<n>] [<branch>]", head: ["log"], tail: ["read-ref"], optional: 1,
    options: /^(--oneline|--max-count=[0-9]{1,5})$/,
  },
  // Before the generic `rev-parse`, which would take `--abbrev-ref` for an option it refuses:
  // the root's own branch, what the loop's first step reads (design section 7).
  { form: "rev-parse --abbrev-ref HEAD", head: ["rev-parse", "--abbrev-ref", "HEAD"], tail: [] },
  { form: "rev-parse [--verify] <branch>", head: ["rev-parse"], tail: ["read-ref"], options: /^--verify$/ },
  { form: "merge-base <branch> <branch>", head: ["merge-base"], tail: ["read-ref", "read-ref"] },
];

const forms = whitelist.map((verb) => verb.form).join("; ");

function argumentFault(args: unknown): string | null {
  if (!Array.isArray(args) || args.length === 0) return "git_root needs a git verb: args is empty";
  if (args.some((argument) => typeof argument !== "string")) return "every git argument must be a string";
  for (const argument of args as string[]) {
    // The same set `git_mutate` refuses, for the same reason: each turns a whitelisted
    // verb into an arbitrary one against an arbitrary repository (design section 4).
    if (globalOptions.has(argument) || argument.startsWith("--git-dir=") || argument.startsWith("--work-tree=")) {
      return `git_root supplies the project root's own --git-dir and --work-tree; ${argument} is refused`;
    }
  }
  return null;
}

interface Call {
  verb: Verb;
  /** The positional arguments, in the order the verb's `tail` names them. */
  values: string[];
  /** Where each of those sat in `args`, so a judged path can replace its own token. */
  at: number[];
}

/** The one verb these arguments are, in the shape it is whitelisted in, or a refusal. */
function parse(args: string[]): Call | { reason: string } {
  const verb = whitelist.find((candidate) => candidate.head.every((token, index) => args[index] === token));
  if (verb === undefined) {
    return { reason: `git_root runs one whitelisted verb and ${JSON.stringify(args.join(" "))} is none of them; they are: ${forms}` };
  }
  const values: string[] = [];
  const at: number[] = [];
  for (const [offset, token] of args.slice(verb.head.length).entries()) {
    if (verb.options?.test(token) === true) continue;
    if (token.startsWith("-")) return { reason: `git_root runs ${JSON.stringify(verb.form)}; ${JSON.stringify(token)} is no part of it` };
    values.push(token);
    at.push(verb.head.length + offset);
  }
  const least = verb.tail.length - (verb.optional ?? 0);
  if (values.length < least || values.length > verb.tail.length) {
    return { reason: `git_root runs ${JSON.stringify(verb.form)}; ${JSON.stringify(args.join(" "))} does not match it` };
  }
  return { verb, values, at };
}

/** The mode's pattern with its one `*` standing for a non-empty name. */
function matchesPattern(value: string, pattern: string): boolean {
  const star = pattern.indexOf("*");
  if (star === -1) return value === pattern;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return value.length > prefix.length + suffix.length && value.startsWith(prefix) && value.endsWith(suffix);
}

/** A branch argument is a branch name: never a path, a range, a revision or an option. */
function nameFault(value: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..") || value.endsWith("/") || value.endsWith(".lock")) {
    return `${JSON.stringify(value)} is not a branch name`;
  }
  return null;
}

/**
 * `target` with everything that exists of it resolved: a path git has not created yet
 * still has ancestors, and those are where a symlink would point a new worktree somewhere
 * else. A path nothing of which can be resolved is judged as it was written.
 */
async function resolveExisting(target: string): Promise<string> {
  const rest: string[] = [];
  let candidate = target;
  while (true) {
    try {
      return path.join(await realpath(candidate), ...rest);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return target;
      rest.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * A directory argument, resolved and judged: it lies under the mode's own worktree
 * directory, which itself lies under the project root. Both checks are on resolved paths,
 * so a symlinked worktree directory is the same escape as a `..` and is refused as one.
 * A worktree this tool creates must sit **directly** under that directory — the
 * `<worktreeDir>/<slug>` shape `git_mutate` defaults `path` to — because a worktree
 * nested inside another is a tree the outer one's own git would then see.
 */
async function within(
  workTree: string, dir: string, given: string, directly: boolean,
): Promise<string | { reason: string }> {
  const base = await resolveExisting(path.resolve(workTree, dir));
  if (!base.startsWith(workTree + path.sep)) {
    return { reason: `the worktree directory ${JSON.stringify(dir)} resolves to ${base}, outside the project at ${workTree}` };
  }
  const target = await resolveExisting(path.resolve(workTree, given));
  if (!target.startsWith(base + path.sep)) {
    return { reason: `git_root works under ${base}${path.sep}, the mode's own worktree directory; ${given} resolves to ${target}` };
  }
  if (directly && path.dirname(target) !== base) {
    return { reason: `a worktree sits directly under ${base}${path.sep}, one directory per task; ${given} resolves to ${target}` };
  }
  return target;
}

/** The positional arguments a verb's checks and its journal need, once judged. */
interface Parts {
  branch?: string;
  ref?: string;
  dir?: string;
  /** Where the directory sat in `args`, so what runs is the path that was judged. */
  dirAt?: number;
}

async function judge(
  call: Call, workTree: string, defaultBranch: string, dir: string, pattern: string,
): Promise<Parts | { reason: string }> {
  const parts: Parts = {};
  for (const [index, value] of call.values.entries()) {
    const kind = call.verb.tail[index];
    if (kind === "dir") {
      const resolved = await within(workTree, dir, value, call.verb.step === "worktree-created");
      if (typeof resolved !== "string") return resolved;
      parts.dir = resolved;
      parts.dirAt = call.at[index];
      continue;
    }
    if (kind === "base") {
      if (value !== defaultBranch) {
        return { reason: `git_root creates a worktree from the default branch ${defaultBranch}; ${JSON.stringify(value)} is not it` };
      }
      continue;
    }
    if (kind !== "list-pattern") {
      const fault = nameFault(value);
      if (fault !== null) return { reason: `git_root ${call.verb.form}: ${fault}` };
    }
    if (kind === "branch") {
      if (!matchesPattern(value, pattern)) {
        return { reason: `git_root creates task branches matching this mode's branch pattern ${JSON.stringify(pattern)}; ${JSON.stringify(value)} does not` };
      }
      parts.branch = value;
    }
    if (kind === "ref") {
      // The journal decides **which** branch this verb may name; the pattern decides which
      // branches this tool acts on at all. `git_mutate` takes any branch its caller names,
      // so a journal can be bound to one outside the pattern, and the whitelist is what
      // keeps `git_root` from merging or deleting it (design section 4).
      if (!matchesPattern(value, pattern)) {
        return { reason: `git_root acts on branches matching this mode's branch pattern ${JSON.stringify(pattern)}; ${JSON.stringify(value)} does not` };
      }
      parts.ref = value;
    }
    if ((kind === "read-ref" || kind === "list-pattern") && !matchesPattern(value, pattern) && value !== defaultBranch) {
      return { reason: `git_root reads a branch matching this mode's branch pattern ${JSON.stringify(pattern)} or the default branch ${defaultBranch}; ${JSON.stringify(value)} is neither` };
    }
  }
  return parts;
}

/**
 * What the journal already says about this slug, against what this call names. The journal
 * is authoritative for its own branch and path: a worktree `git_mutate` bound to a branch
 * of another name is merged and cleaned up under that name, and nothing else is.
 */
function journalFault(slug: string, journal: Journal | null, verb: Verb, parts: Parts): string | null {
  // A closed journal is terminal: its `branch-deleted` step ended the task, and a branch of
  // that name now — a later task's of this project, or a sibling project's that reused the
  // name — is no branch of its task, so nothing it names is acted on again (design section 6).
  if (journal !== null && journal.steps.some((step) => step.step === "branch-deleted")) {
    return `slug ${slug} is closed by its branch-deleted step, so ${journal.branch} now is no branch of its task; git_root ${verb.form} is refused`;
  }
  if (verb.step === "worktree-created") {
    if (journal === null) return null;
    if (journal.steps.some((step) => step.step === "worktree-created")) {
      return `slug ${slug} already has a worktree-created step; a task is given one worktree`;
    }
    if (journal.branch !== parts.branch) return `slug ${slug} is journaled on ${journal.branch}; refusing ${parts.branch}`;
    if (journal.worktree !== undefined && journal.worktree !== parts.dir) {
      return `slug ${slug} is journaled on worktree ${journal.worktree}; refusing ${parts.dir}`;
    }
    return null;
  }
  if (journal === null) return `slug ${slug} has no journal; its branch and its worktree are what this verb is held to`;
  if (verb.step === "worktree-removed") {
    if (journal.worktree === undefined) return `slug ${slug} records no worktree; there is nothing this verb may remove`;
    if (journal.steps.some((step) => step.step === "worktree-removed")) {
      return `slug ${slug} already has a worktree-removed step: a task's worktree is removed once, and one at ${journal.worktree} now is no worktree of its task`;
    }
    if (journal.worktree !== parts.dir) return `slug ${slug} is journaled on worktree ${journal.worktree}; refusing ${parts.dir}`;
    return null;
  }
  if (journal.branch !== parts.ref) return `slug ${slug} is journaled on ${journal.branch}; refusing ${parts.ref}`;
  if (verb.step === "merged" && journal.steps.some((step) => step.step === "merged")) {
    return `slug ${slug} is already merged; a task merges once`;
  }
  return null;
}

/**
 * Whether a task is holding the workspace this call would remove, in `git_mutate`'s own
 * words (design section 2): git removes a clean worktree whatever is running in it, so
 * the reservation is the only thing between a lead's cleanup and a specialist's own
 * directory. Read while `spawn.lock` is held, so it cannot race a `delegate` about to
 * take the same workspace.
 */
function reservationFault(projectRoot: string, target: string): string | null {
  let known;
  try {
    known = reservations(projectRoot);
  } catch (error) {
    return `no workspace can be cleared while no task record can be read: ${message(error)}; repair the task directory first`;
  }
  const holder = reservedBy(projectRoot, target, known);
  if (holder !== null) return `${target} is reserved by task ${holder.id} (${holder.status}); wait or cancel first`;
  if (known.unknown.length > 0) {
    const files = known.unknown.map((entry) => `${entry.file} (${entry.reason})`).join(", ");
    return `no workspace can be cleared while a task record cannot be read: ${files}; repair or remove it first`;
  }
  return null;
}

/**
 * Whether the project's own `.cross-agent/` is tracked by this repository, as a reason or
 * null. What a root tool runs and what it journals are read from files there, so tracking
 * them hands a specialist a way to reach the root: a change to `testCommand`, or a forged
 * journal, committed inside its own worktree and carried to the default branch by the
 * lead's own merge (design section 4). The refusal names `.gitignore`, because that is
 * the repair.
 */
export async function trackedStateFault(gitDir: string, workTree: string): Promise<string | null> {
  const ran = await run(gitDir, workTree, ["ls-files", "--error-unmatch", "--", ".cross-agent"]);
  const tracked = ran.exitCode === 0 ? ran.stdout.split("\n").filter(Boolean) : [];
  if (tracked.length === 0) return null;
  return `.cross-agent/ is tracked by this repository (${tracked.slice(0, 3).join(", ")}${tracked.length > 3 ? ", …" : ""}): a specialist could then commit what the lead runs at the root. Add .cross-agent/ to .gitignore and "git rm -r --cached .cross-agent" first`;
}

/**
 * One whitelisted git verb at the project root, journaled (design section 4). The request
 * is judged first — the verb, its shape, its arguments, the slug — because none of that
 * needs a lock; then `git.lock` is held for the journal's own checks, the command, and the
 * step. **`spawn.lock` only for `worktree remove`**, taken before `git.lock`: git removes a
 * clean worktree whatever is running in it, so that verb alone reads a reservation, and
 * the lock keeps that read from racing a `delegate` about to take the same workspace
 * (section 2, `#reservationFault`). Every other verb reads none — the project root is no
 * task's workspace to clear.
 */
export async function gitRoot(
  projectRoot: string, request: GitRootRequest, options: GitRootOptions,
): Promise<GitRootResult> {
  const fault = argumentFault(request.args);
  if (fault !== null) return { ok: false, reason: fault };
  const parsed = parse(request.args);
  if ("reason" in parsed) return { ok: false, reason: parsed.reason };
  const { verb } = parsed;

  const slug = request.slug;
  if (verb.step === undefined) {
    if (slug !== undefined) return { ok: false, reason: `git_root ${verb.form} journals nothing, so it takes no slug` };
  } else if (slug === undefined) {
    return { ok: false, reason: `git_root ${verb.form} writes the ${verb.step} step, so it needs the slug whose journal it belongs to` };
  }
  // The step this call will append has to be recordable before the command runs: a slug
  // that is not a file name of its own, or a journal that cannot be read, would otherwise
  // be found only once the repository had already changed.
  if (slug !== undefined) {
    try {
      readJournal(projectRoot, slug);
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
  }

  let defaultBranch: string;
  try {
    defaultBranch = loadConfig(projectRoot).project.defaultBranch;
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  const located = await locateRepository(projectRoot);
  if ("reason" in located) return { ok: false, reason: located.reason };
  // A verb that journals a step writes the root; a read and `rebase --abort`, which undoes
  // a stopped rebase, do not need the root to be a project of its own.
  if (verb.step !== undefined) {
    const unwritable = rootWriteFault(located, projectRoot, defaultBranch, "write");
    if (unwritable !== null) return { ok: false, reason: unwritable };
  }
  const { gitDir, workTree } = located;
  let tracked: string | null;
  try {
    tracked = await trackedStateFault(gitDir, workTree);
  } catch (error) {
    if (error instanceof GitRunError) return { ok: false, reason: error.message };
    throw error;
  }
  if (tracked !== null) return { ok: false, reason: tracked };
  const parts = await judge(parsed, workTree, defaultBranch, options.dir ?? ".worktrees", options.branchPattern ?? "task/*");
  if ("reason" in parts) return { ok: false, reason: parts.reason };

  const operation = `git_root ${verb.head.join(" ")}${slug === undefined ? "" : ` ${slug}`}`;
  // Only the verb that takes a workspace away reads a reservation, and only it needs the
  // lock that orders that read against `delegate` (design section 2). The order is always
  // spawn.lock and then git.lock.
  let claim: Lock | undefined;
  if (verb.step === "worktree-removed") {
    try {
      claim = await projectLock(projectRoot, spawnLockName(), { waitSeconds: options.waitSeconds, operation });
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
  }
  try {
    if (claim !== undefined) {
      const held = reservationFault(projectRoot, parts.dir!);
      if (held !== null) return { ok: false, reason: held };
    }
    let lock: Lock;
    try {
      lock = await projectLock(projectRoot, gitLockName(), { waitSeconds: options.waitSeconds, operation });
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
    try {
      // A verb that changes the repository — every journaled one, and `rebase --abort` —
      // takes the repository lock inside `git.lock`, so no other project of the repository
      // runs git between this one's checks and its command (design section 2).
      let shared: Lock | undefined;
      if (verb.step !== undefined || verb.form === "rebase --abort") {
        try {
          shared = await acquire(repositoryLockPath(located.commonDir), { waitSeconds: repositoryLockWait(options.waitSeconds), operation });
        } catch (error) {
          return { ok: false, reason: message(error) };
        }
      }
      try {
        return await execute(projectRoot, request, options, { parsed, parts, gitDir, workTree, defaultBranch, slug, lock, claim, shared });
      } finally {
        await shared?.release();
      }
    } catch (error) {
      if (error instanceof GitRunError) return { ok: false, reason: error.message };
      throw error;
    } finally {
      await lock.release();
    }
  } finally {
    await claim?.release();
  }
}

interface Held {
  parsed: Call;
  parts: Parts;
  gitDir: string;
  workTree: string;
  defaultBranch: string;
  slug?: string;
  lock: Lock;
  /** `spawn.lock`, held for the verb that removes a workspace. */
  claim?: Lock;
  /** The repository lock, held for a verb that changes the repository. */
  shared?: Lock;
}

/**
 * Why this branch may not be merged, or null. Everything else in this file reads the
 * **root's** own state — `trackedStateFault` reads the root's index — and nothing reads
 * the tree that is about to arrive. A specialist's `.gitignore` in its own worktree
 * outranks the repository's shared `info/exclude`, so the loop's own `add -A` can stage
 * `.cross-agent/` there and a fast-forward would carry the project's own config, journal
 * and ledger to the root, where `delegate` reads them on the next call. So the merge is
 * where the incoming tree is read, and the two directories the project keeps for itself
 * are refused by name (design section 4) — and so is a host's project configuration
 * (`src/gitmutate.ts#hostConfigPaths`, in any case), which the operator's own host session
 * would load, however the branch came to carry it: this is the gate, and `git_mutate`'s
 * refusal of a commit only the early warning. Any symbolic link among the four or below
 * them in the incoming tree is refused, even unchanged: host configuration must be regular
 * files. Only the four pathspecs are listed for links (`src/gitmutate.ts#hostTreeLinks`).
 * Every path is named, so the repair is whole.
 */
async function smuggled(
  gitDir: string, workTree: string, defaultBranch: string, ref: string, dir: string,
): Promise<string | null> {
  const links = await hostTreeLinks(gitDir, workTree, ref);
  const ran = await run(gitDir, workTree, ["diff", "--name-only", `${defaultBranch}...${ref}`, "--", ".cross-agent", dir, ...hostConfigPathspecs]);
  if (ran.exitCode !== 0) return `git_root could not read what ${ref} would merge: ${ran.stderr.trim() || `git diff exited ${ran.exitCode}`}`;
  // A path that is both a change and a link is named once, as the link.
  const linkNames = new Set(links);
  const paths = [...ran.stdout.split("\n").filter(Boolean).filter((file) => !linkNames.has(file)),
    ...links.map((file) => `${file} (symbolic link)`)];
  if (paths.length === 0) return null;
  return `git_root refuses to merge ${ref}: it carries ${paths.join(", ")}. `
    + `The project's own state and ${dir}/ are never merged into the root — a specialist could then commit what the lead runs there — `
    + "and nor is a host's project configuration (.claude/, .codex/, .grok/, .mcp.json, in any case), "
    + "which the operator's own host session would load. "
    + "Host configuration must be regular files: replace symbolic links with regular files at the root by hand. "
    + `Remove the changes from the branch and merge again`;
}

/** The journal's checks, the command and its step, with `git.lock` held for all of them. */
async function execute(
  projectRoot: string, request: GitRootRequest, options: GitRootOptions,
  { parsed, parts, gitDir, workTree, defaultBranch, slug, lock, claim, shared }: Held,
): Promise<GitRootResult> {
  const { verb } = parsed;
  // Read under the lock, because two first calls on one slug would otherwise both find no
  // journal and both create a worktree, and two merges would both find no `merged` step.
  let journal: Journal | null = null;
  if (slug !== undefined) {
    try {
      journal = readJournal(projectRoot, slug);
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
    const bound = journalFault(slug, journal, verb, parts);
    if (bound !== null) return { ok: false, reason: bound };
  }

  const before = await revision(gitDir, workTree, defaultBranch);
  let branchHead: string | undefined;
  if (verb.step === "merged") {
    // A merge moves HEAD, and both merge fields are read from the default branch: taken
    // with the root on any other branch they would name a revert range that never existed.
    const head = await run(gitDir, workTree, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const on = head.stdout.trim();
    if (head.exitCode !== 0 || on !== defaultBranch) {
      return { ok: false, reason: `git_root merges into the root's HEAD, which is on ${on || "no branch"}; check out ${defaultBranch} there first` };
    }
    const carried = await smuggled(gitDir, workTree, defaultBranch, parts.ref!, options.dir ?? ".worktrees");
    if (carried !== null) return { ok: false, reason: carried };
    // The head this call is about to merge, read inside the same lock as the merge itself.
    branchHead = await revision(gitDir, workTree, parts.ref!);
  }

  // What the arguments were judged as is what git is given: the directory positional is
  // the resolved path, not the token the caller wrote (design section 4).
  const argv = parts.dir === undefined || parts.dirAt === undefined
    ? request.args
    : request.args.map((argument, index) => (index === parts.dirAt ? parts.dir! : argument));
  const ran = await run(gitDir, workTree, argv);
  if (ran.exitCode !== 0) {
    return {
      ok: false,
      reason: `git ${argv.join(" ")} exited ${ran.exitCode} at ${workTree}`,
      exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr,
    };
  }
  const after = await revision(gitDir, workTree, defaultBranch);

  let written: JournalEntry | undefined;
  if (verb.step !== undefined && slug !== undefined) {
    try {
      // The directory as it now exists, so what the journal binds this task to is the path
      // its own later verbs and `run_command` are held to.
      const worktree = verb.step === "worktree-created" ? await realpath(parts.dir!) : undefined;
      const appended = appendStep(projectRoot, slug, verb.step, {
        at: options.now ?? Date.now(), before, after,
        // A root step's `before` is the default branch's own SHA, and every step records
        // what it saw of that branch beside its own: one field to read across the journal,
        // whichever tool wrote the step.
        ...(before === undefined ? {} : { defaultSha: before }),
        branch: parts.branch ?? journal?.branch, defaultBranch,
        ...(worktree === undefined ? {} : { worktree }),
        ...(verb.step === "merged" ? { defaultShaBeforeMerge: before, branchHead } : {}),
      });
      written = appended.steps[appended.steps.length - 1];
    } catch (error) {
      // The command happened; only the record of it did not. `ok: true` would tell the
      // lead its journal is current when it is not.
      return {
        ok: false,
        reason: `git ${request.args.join(" ")} ran at ${workTree}, but its journal step could not be written: ${message(error)}`,
        exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr,
      };
    }
  }
  return {
    ok: true, exitCode: 0, stdout: ran.stdout, stderr: ran.stderr,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    // The command ran and is journaled, but if the kernel dropped any lock while it did,
    // another mutation or a delegate may already have started: the caller is told rather
    // than left to believe the whole call was exclusive.
    ...(lock.lost || claim?.lost === true || shared?.lost === true ? { lockLost: true as const } : {}),
    ...(written === undefined ? {} : { journal: written }),
  };
}
