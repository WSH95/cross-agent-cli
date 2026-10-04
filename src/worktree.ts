import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CONFIG_PATH } from "./config.ts";
import { run } from "./gitmutate.ts";
import { gitdirOf, withoutLineEnds } from "./ledger.ts";

/**
 * What a verified linked worktree is: its administrative directory, its work tree, the
 * branch it is on, and `commonDir`, the repository's own git directory that every worktree
 * of it shares. `commonDir` is here because a writable specialist must be kept out of it —
 * it is half of the spec's `protectedPaths` (design section 3) — and this is the one place
 * that resolves it from the worktree itself rather than guessing `<root>/.git`.
 */
export type VerifiedWorktree = { gitDir: string; workTree: string; branch: string; commonDir: string };
export type WorktreeResult = VerifiedWorktree | { reason: string };

const exec = promisify(execFile);

// Design section 4: what git works on is decided here and by `git_mutate`, never by what
// the process happens to have inherited — a server started from a hook or from `git rebase
// --exec` carries GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
// GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_NAMESPACE, GIT_CEILING_DIRECTORIES, and
// GIT_CONFIG_* would put back exactly the `-c` settings `git_mutate` refuses. So this is an
// allowlist and not a deny list: a variable nobody has thought about does not reach git.
const passedVariables = [
  "PATH", "HOME", "USER", "LANG", "TZ", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "SSH_AUTH_SOCK", "GIT_TERMINAL_PROMPT",
  // git's own documented fallbacks for who is committing and where its helpers live.
  "EMAIL", "GIT_EXEC_PATH",
];
const passedPrefixes = ["LC_", "GIT_AUTHOR_", "GIT_COMMITTER_", "GIT_SSH"];

/**
 * The environment every git invocation in this project gets: where to find git and the
 * user's own config, who is committing, how to talk to a remote, and nothing that could
 * point git at another repository, index, object store, or configuration.
 */
export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (passedVariables.includes(name) || passedPrefixes.some((prefix) => name.startsWith(prefix))) env[name] = value;
  }
  return env;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnvironment() });
  return stdout;
}

// Git paths may contain trailing whitespace, so remove only the record terminator.
function withoutNewline(output: string): string {
  return output.replace(/\n$/, "");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What git said when it failed, or the error itself when git could not run at all. */
function gitFailure(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : message(error);
}

/** Whether `child` lies strictly under `parent`; both canonical. */
function contains(parent: string, child: string): boolean {
  return child !== parent && child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** One registration in a repository's worktree list. */
export interface Stanza {
  /** The registered directory, canonical. */
  path: string;
  /** The branch checked out there, or null: a detached HEAD, or a main with no checkout. */
  branch: string | null;
  /** The listing's first stanza: the main worktree, or the common directory where there is none. */
  main: boolean;
}

/**
 * A worktree list as git prints it under `--porcelain -z`, which disables C-style quoting
 * even for newlines in paths. A registration whose directory is gone is skipped, as git's
 * own pruning would; any other is kept whatever its pointer holds or its annotation says:
 * git marks one `prunable` only when its pointer fails `lstat`, and never a `locked` one.
 */
async function stanzasOf(listing: string, base: string): Promise<Stanza[]> {
  const stanzas: Stanza[] = [];
  for (const [index, entry] of listing.split("\0\0").filter(Boolean).entries()) {
    const fields = entry.split("\0");
    const named = fields.find((line) => line.startsWith("worktree "));
    if (named === undefined) continue;
    let resolved: string;
    try {
      resolved = await realpath(path.resolve(base, named.slice("worktree ".length)));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    const ref = fields.find((line) => line.startsWith("branch refs/heads/"));
    stanzas.push({ path: resolved, branch: ref === undefined ? null : ref.slice("branch refs/heads/".length), main: index === 0 });
  }
  return stanzas;
}

/** The registry the work tree at `dir` lists from its own `.git`, every path canonical. */
export async function worktreeStanzas(dir: string): Promise<Stanza[]> {
  return stanzasOf(await git(dir, "worktree", "list", "--porcelain", "-z"), dir);
}

/**
 * The registry read through a git directory this call has already verified, from `root`:
 * a read like the verifier's others, which run with `-C`, and never one of the commands a
 * tool runs in the explicit form (`src/gitmutate.ts#run`).
 */
async function registryOf(gitDir: string, root: string): Promise<Stanza[]> {
  return stanzasOf(await git(root, `--git-dir=${gitDir}`, "worktree", "list", "--porcelain", "-z"), root);
}

/**
 * What the canonical `dir` is by its own git: a bare repository, and whether it is a work
 * tree at its own top level. This is the one test for a work tree here — of an enclosing
 * ancestor and of a registry's first stanza alike — because a registry cannot answer it:
 * git 2.43 names the main stanza after the common directory with `/.git` stripped
 * (`worktree.c#get_main_worktree`), so a separated main's stanza is its git directory, and
 * under `extensions.worktreeConfig` a listing from a linked worktree reads no `core.bare`
 * and so names a bare main without the label.
 */
export async function ownGit(dir: string): Promise<{ bare: boolean; workTree: boolean }> {
  const [bare, inside] = withoutNewline(await git(dir, "rev-parse", "--is-bare-repository", "--is-inside-work-tree")).split("\n");
  if (inside !== "true") return { bare: bare === "true", workTree: false };
  const top = await realpath(path.resolve(dir, withoutNewline(await git(dir, "rev-parse", "--show-toplevel"))));
  return { bare: bare === "true", workTree: top === dir };
}

/** A work tree whose own registry lists a worktree inside it, and the innermost such worktree holding a candidate. */
export interface Enclosure {
  ancestor: string;
  worktree: string;
}

/**
 * The work tree whose repository registers a worktree holding `candidate`, inside that work
 * tree, or null (design section 4). The candidate is canonical, and its strict ancestors
 * are walked outside-in: one holding a `.git` entry encloses it when it is a work tree by
 * its own git and its own registry lists a worktree strictly under it that is or holds the
 * candidate. Nothing of the candidate's own `.git` is read, so ownership is proven by
 * registries a specialist confined to the candidate cannot write, whatever it did to its
 * pointer. A readable, empty `.git` directory holds no registry and is skipped. Other
 * entries still go through git, and any read or git failure refuses: even an unreadable
 * real repository can make git report "not a git repository".
 */
export async function enclosingWorktree(candidate: string): Promise<Enclosure | { reason: string } | null> {
  const ancestors: string[] = [];
  for (let dir = candidate; path.dirname(dir) !== dir;) {
    dir = path.dirname(dir);
    ancestors.unshift(dir);
  }
  for (const ancestor of ancestors) {
    const pointer = path.join(ancestor, ".git");
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(pointer);
    } catch (error) {
      // A path mapped out of a task worktree is lexical, so an ancestor of it may run through
      // a file or round a symlink loop on the root's branch: no directory, so no work tree.
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      return { reason: `cannot read ${pointer}: ${message(error)}` };
    }
    if (entry.isDirectory()) {
      try {
        if ((await readdir(pointer)).length === 0) continue;
      } catch (error) {
        return { reason: `cannot read ${pointer}: ${message(error)}` };
      }
    }
    let stanzas: Stanza[];
    try {
      if (!(await ownGit(ancestor)).workTree) continue;
      stanzas = await worktreeStanzas(ancestor);
    } catch (error) {
      return { reason: `cannot tell whether ${ancestor} registers ${candidate}, because its git failed: ${gitFailure(error)}` };
    }
    const holding = stanzas.filter((stanza) => contains(ancestor, stanza.path) && (stanza.path === candidate || contains(stanza.path, candidate)));
    if (holding.length > 0) {
      const innermost = holding.reduce((inner, stanza) => (stanza.path.length > inner.path.length ? stanza : inner));
      return { ancestor, worktree: innermost.path };
    }
  }
  return null;
}

/** The refusal for a root inside a worktree its enclosing work tree registers. */
export function nestedReason(candidate: string, { ancestor, worktree }: Enclosure): string {
  const at = candidate === worktree ? worktree : `${candidate}, inside ${worktree},`;
  return `${at} is a worktree of the repository whose work tree at ${ancestor} encloses it, and a worktree inside a work tree of its own repository is never a project root: serve ${ancestor}, or add the worktree beside it for a project of its own`;
}

/**
 * What kind of root a project's repository has (design section 4): its own main checkout,
 * a linked worktree of a repository whose first stanza is a work tree or a separated git
 * directory, or a linked worktree of a bare repository.
 */
export type RepositoryKind = "main" | "linked" | "bare-linked";

export interface Repository {
  kind: RepositoryKind;
  workTree: string;
  /** The root's own git directory: `<root>/.git` for a main checkout, its administrative directory for a linked one. */
  gitDir: string;
  /** The repository's own git directory, which every worktree of it shares. */
  commonDir: string;
  /** The branch the root has checked out, or null when its HEAD is detached. */
  branch: string | null;
  stanzas: Stanza[];
  /** The main checkout: the first stanza when it is a work tree by its own git, and null otherwise. */
  main: string | null;
}

/**
 * `locateRepository`'s answer. `none` is a root with no `.git` at all, a config-only
 * project. `unsupported` is a root whose git directory is its own common directory and lies
 * outside it — a main checkout with a separated git directory or a `.git` linking to its
 * git directory, a submodule, a bare repository's umbrella — or is bare, carrying that
 * directory. `refused` is everything else that does not verify.
 */
export type Located =
  | Repository
  | { kind: "none" | "refused"; reason: string }
  | { kind: "unsupported"; reason: string; workTree: string; gitDir: string };

function refused(reason: string): Located {
  return { kind: "refused", reason };
}

/** One git command through the explicit form every tool uses (`src/gitmutate.ts#run`), its output or a throw. */
async function explicitly(gitDir: string, workTree: string, ...args: string[]): Promise<string> {
  const ran = await run(gitDir, workTree, args);
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${ran.exitCode}: ${ran.stderr.trim()}`);
  return ran.stdout;
}

/**
 * The project's repository, verified once per tool call (design section 4), or why there
 * is none to work on. The root's nesting is decided first and from outside it; then its
 * `.git`: a directory is a main checkout unless its own git calls it bare, and a pointer
 * file is a linked worktree once git confirms it on explicit directories, its
 * administrative directory is its repository's, and the registry lists it.
 */
export async function locateRepository(projectRoot: string): Promise<Located> {
  let workTree: string;
  try {
    workTree = await realpath(projectRoot);
  } catch (error) {
    return refused(`cannot resolve the project root ${projectRoot}: ${message(error)}`);
  }
  // @anchor rootNotNested
  const enclosure = await enclosingWorktree(workTree);
  if (enclosure !== null) return refused("reason" in enclosure ? enclosure.reason : nestedReason(workTree, enclosure));
  const pointer = path.join(workTree, ".git");
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(pointer);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none", reason: `${workTree} holds no .git, so it is no repository's checkout` };
    return refused(`cannot read ${pointer}: ${message(error)}`);
  }
  try {
    if (entry.isDirectory()) return await asMainCheckout(workTree, pointer);
    if (entry.isFile()) return await asLinkedWorktree(workTree, pointer);
    if (entry.isSymbolicLink()) return await asLinkedGitDirectory(workTree, pointer);
  } catch (error) {
    return refused(`cannot verify the repository at ${workTree}: ${gitFailure(error)}`);
  }
  return refused(`${pointer} is neither a git directory nor a worktree pointer file`);
}

async function asMainCheckout(workTree: string, gitDir: string): Promise<Located> {
  // Asked without a work tree named: `--work-tree=<root>` would make a work tree of a bare
  // repository at `<root>/.git`, whose parent is no work tree of it. A path is asked for on
  // its own, since one may hold a newline.
  const bare = withoutNewline(await git(workTree, "rev-parse", "--is-bare-repository"));
  const found = withoutNewline(await git(workTree, "rev-parse", "--absolute-git-dir"));
  if (await realpath(found) !== gitDir) return refused(`git at ${workTree} reads the repository at ${found}, not ${gitDir}`);
  if (bare === "true") {
    return { kind: "unsupported", workTree, gitDir, reason: `${gitDir} is a bare repository, and ${workTree} is no work tree of it: serve one of its worktrees` };
  }
  const stanzas = await registryOf(gitDir, workTree);
  const own = stanzas.find((stanza) => stanza.path === workTree);
  return { kind: "main", workTree, gitDir, commonDir: gitDir, branch: own?.branch ?? null, stanzas, main: workTree };
}

/**
 * A `.git` that is a symbolic link, which git follows to whatever it names. One that git at
 * the root reads as the root's own git directory — the link's target is the git directory
 * and its own common directory, the root is the top level, and nothing is bare — is a main
 * checkout whose git directory lies outside it, as a separated one's does, and is
 * unsupported the same way. Any other link is refused.
 */
async function asLinkedGitDirectory(workTree: string, pointer: string): Promise<Located> {
  let target: string;
  try {
    target = await realpath(pointer);
  } catch (error) {
    return refused(`${pointer} is a symbolic link that cannot be resolved: ${message(error)}`);
  }
  const by = await ownGit(workTree);
  const absolute = await realpath(withoutNewline(await git(workTree, "rev-parse", "--absolute-git-dir")));
  const shared = await realpath(path.resolve(workTree, withoutNewline(await git(workTree, "rev-parse", "--git-common-dir"))));
  if (by.bare || !by.workTree || absolute !== target || shared !== target) {
    return refused(`${pointer} is a symbolic link to ${target}, which git at ${workTree} does not read as the git directory of the work tree there`);
  }
  return {
    kind: "unsupported", workTree, gitDir: target,
    reason: `${pointer} is a symbolic link to ${target}, a git directory outside ${workTree}, and such a root takes no writes`,
  };
}

async function asLinkedWorktree(workTree: string, pointer: string): Promise<Located> {
  // Read as a candidate only, the way git reads a pointer (`gitdirOf`): the path after
  // `gitdir: `, relative to the root. What it claims is confirmed below before anything
  // acts on it.
  const named = gitdirOf(await readFile(pointer, "utf8"));
  if (named === null) return refused(`${pointer} is not a worktree pointer: it holds no gitdir: line`);
  let admin: string;
  try {
    admin = await realpath(path.resolve(workTree, named));
  } catch (error) {
    return refused(`${pointer} names ${named}, which cannot be resolved: ${message(error)}`);
  }
  let common: string | undefined;
  try {
    common = withoutLineEnds(await readFile(path.join(admin, "commondir"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // @anchor rootIsLinked
  if (common === undefined) {
    const absolute = withoutNewline(await git(workTree, "rev-parse", "--absolute-git-dir"));
    const shared = withoutNewline(await git(workTree, "rev-parse", "--git-common-dir"));
    if (await realpath(absolute) === admin && await realpath(path.resolve(workTree, shared)) === admin) {
      return {
        kind: "unsupported", workTree, gitDir: admin,
        reason: `${pointer} leads to ${admin}, a git directory that is its own common directory — a main checkout with a separated git directory, a submodule, or a bare repository's umbrella — and such a root takes no writes`,
      };
    }
    return refused(`${pointer} leads to ${admin}, which names no common directory`);
  }
  const commonDir = await realpath(path.resolve(admin, common));
  const absolute = withoutNewline(await explicitly(admin, workTree, "rev-parse", "--absolute-git-dir"));
  const shared = withoutNewline(await explicitly(admin, workTree, "rev-parse", "--git-common-dir"));
  if (await realpath(absolute) !== admin || await realpath(path.resolve(workTree, shared)) !== commonDir) {
    return refused(`git reads ${admin} as ${absolute} sharing ${shared}, not as ${pointer} claims`);
  }
  // @anchor rootAdministrativeParent
  const adminRoot = await realpath(path.join(commonDir, "worktrees"));
  if (path.dirname(admin) !== adminRoot) return refused(`${admin} is not an administrative directory directly under ${adminRoot}`);
  // @anchor rootGitdirBacklink
  const backlink = await realpath(path.resolve(admin, withoutNewline(await readFile(path.join(admin, "gitdir"), "utf8"))));
  if (backlink !== pointer) return refused(`${admin} points back to ${backlink}, not ${pointer}`);
  // @anchor rootOutsideCommonDir
  // Every task is denied the whole common directory (`src/delegate.ts#delegate`), so a root
  // inside it would deny its own tasks their workspace.
  if (workTree === commonDir || contains(commonDir, workTree)) {
    return refused(`${workTree} lies inside its repository's git directory ${commonDir}: place worktrees beside the git directory, never inside it`);
  }
  // @anchor rootListed
  const stanzas = await registryOf(admin, workTree);
  const own = stanzas.find((stanza) => !stanza.main && stanza.path === workTree);
  if (own === undefined) return refused(`${workTree} is not in its repository's worktree list`);
  const first = stanzas.find((stanza) => stanza.main);
  if (first === undefined) return refused(`the worktree list of ${commonDir} names no main worktree`);
  // The first stanza by its own git, never by the listing's `bare` label (`ownGit`).
  const by = await ownGit(first.path);
  return {
    kind: by.bare ? "bare-linked" : "linked", workTree, gitDir: admin, commonDir, branch: own.branch, stanzas,
    main: !by.bare && by.workTree ? first.path : null,
  };
}

/**
 * Why this root takes no write, or null (design section 4). A main checkout takes writes as
 * it always has. Any other root is a project of its own only once `cross-agent init` ran in
 * it — until then discovery serves it as its main checkout's, or with no main as one nobody
 * configured — and its writes land on its own branch, which is the config's default branch
 * only while the root has it checked out. `"initialized"` asks the first of the three, which
 * every `run_command` at such a root needs; `"write"` asks all three.
 */
export function rootWriteFault(
  repo: Repository, projectRoot: string, defaultBranch: string, scope: "initialized" | "write",
): string | null {
  if (repo.kind === "main") return null;
  const config = path.join(projectRoot, CONFIG_PATH);
  if (!(statSync(config, { throwIfNoEntry: false })?.isFile() ?? false)) {
    return `${repo.workTree} is not an initialized project; run "cross-agent init" in ${repo.workTree}`;
  }
  if (scope === "initialized") return null;
  if (repo.branch === null) return `${repo.workTree} has a detached HEAD; check out ${defaultBranch} there first`;
  if (repo.branch !== defaultBranch) {
    return `project.defaultBranch in ${config} is ${defaultBranch}, and ${repo.workTree} has ${repo.branch} checked out: set project.defaultBranch to ${repo.branch}, or check out ${defaultBranch} there`;
  }
  return null;
}

/** What `verifyWorktree` takes from a located repository: its identity, never its listing. */
export type RepositoryIdentity = Pick<Repository, "kind" | "workTree" | "gitDir" | "commonDir">;

/**
 * Verifies a task worktree of the project at `projectRoot` without changing its files or
 * Git metadata (design section 4). The repository is `repo` where the caller has located it
 * already, and is located here otherwise; it supplies identity alone, because membership
 * and nesting are read from a listing taken on every call — `delegate` locates the
 * repository before `worktree add` and verifies after it.
 */
export async function verifyWorktree(
  projectRoot: string, worktreePath: string, branch: string, repo?: RepositoryIdentity,
): Promise<WorktreeResult> {
  let operation = "locate the project's repository";
  try {
    let identity = repo;
    if (identity === undefined) {
      const located = await locateRepository(projectRoot);
      if ("reason" in located) return { reason: located.reason };
      identity = located;
    }
    const root = identity.workTree;
    operation = "resolve the worktree path";
    // A relative path is the project's: the server's own directory is wherever its host
    // started it, which for the Codex plugin is its cached copy.
    const workTree = await realpath(path.resolve(root, worktreePath));
    // @anchor notProjectState
    // The project's own directory is the server's to write — the ledger, the journal, the
    // locks and the gate's checkouts of a branch head live there — so nothing at or under
    // it is a task's workspace, whatever it has checked out: a detached checkout there would
    // otherwise verify as `branch: "HEAD"` and take a writer, a mutation or a run.
    const state = path.join(root, ".cross-agent");
    let canonicalState = state;
    try {
      canonicalState = await realpath(state);
    } catch { /* no state directory yet: the path itself is the one to compare */ }
    if ([state, canonicalState].some((directory) => workTree === directory || contains(directory, workTree))) {
      return { reason: `${workTree} lies under the project's own .cross-agent/, which the server writes and no task works in.` };
    }
    operation = "list the repository's worktrees";
    const stanzas = await registryOf(identity.gitDir, root);
    // @anchor linkedWorktree
    if (!stanzas.some((stanza) => !stanza.main && stanza.path === workTree)) {
      return { reason: `${workTree} is not a linked worktree of ${root}; the main worktree and subdirectories are not accepted.` };
    }
    // @anchor underProjectRoot
    // A linked root and its siblings are worktrees of one repository: only what lies under
    // this root is this project's.
    if (!contains(root, workTree)) {
      return { reason: `${workTree} is not under the project root ${root}; a worktree outside it is another project's or none.` };
    }
    // @anchor notNestedWorktree
    // Only stanzas strictly under the root are read: the root's own nesting was settled
    // when its repository was located, and a stanza at or above it — a bare main whatever
    // its label, a separated main's git directory — encloses every task of the project.
    const outer = stanzas.find((stanza) => contains(root, stanza.path) && contains(stanza.path, workTree));
    if (outer !== undefined) {
      return { reason: `${workTree} lies inside ${outer.path}, another worktree of this project; a worktree nested in another is a tree the outer one's own git would see.` };
    }

    operation = "inspect the worktree's .git pointer file";
    // Following a pointer symlink could make a sibling's backlink look valid.
    // @anchor pointerIsFile
    if (!(await lstat(path.join(workTree, ".git"))).isFile()) {
      return { reason: `${workTree}/.git must be a regular worktree pointer file.` };
    }

    operation = "resolve the worktree's Git directories and HEAD branch";
    const gitDir = await realpath(path.resolve(workTree, withoutNewline(await git(workTree, "rev-parse", "--git-dir"))));
    const commonDir = await realpath(path.resolve(workTree, withoutNewline(await git(workTree, "rev-parse", "--git-common-dir"))));
    const actualBranch = withoutNewline(await git(workTree, "rev-parse", "--abbrev-ref", "HEAD"));
    const expectedCommon = identity.commonDir;
    const adminRoot = await realpath(path.join(expectedCommon, "worktrees"));
    // @anchor administrativeParent
    if (path.dirname(gitDir) !== adminRoot) {
      return { reason: `Git directory ${gitDir} is not an administrative directory directly under ${adminRoot}.` };
    }
    // @anchor commonDirectory
    if (commonDir !== expectedCommon) {
      return { reason: `Git common directory ${commonDir} does not match ${expectedCommon}.` };
    }
    // @anchor branchMatches
    if (actualBranch !== branch) {
      return { reason: `Worktree branch ${actualBranch} does not match the requested branch ${branch}.` };
    }

    // @anchor gitdirBacklink
    operation = "verify the administrative directory's gitdir backlink";
    const backlink = withoutNewline(await readFile(path.join(gitDir, "gitdir"), "utf8"));
    const linkedPointer = await realpath(path.resolve(gitDir, backlink));
    const candidatePointer = await realpath(path.join(workTree, ".git"));
    if (linkedPointer !== candidatePointer) {
      return { reason: `Git directory ${gitDir} points back to ${linkedPointer}, not ${candidatePointer}.` };
    }
    // @anchor verifiedResult
    return { gitDir, workTree, branch: actualBranch, commonDir };
  } catch (error) {
    return { reason: `Cannot ${operation}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
