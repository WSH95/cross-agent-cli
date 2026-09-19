import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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

/** Verifies a linked worktree without changing its files or Git metadata. */
export async function verifyWorktree(projectRoot: string, worktreePath: string, branch: string): Promise<WorktreeResult> {
  let operation = "resolve the project root and worktree path";
  try {
    const root = await realpath(projectRoot);
    const workTree = await realpath(worktreePath);
    operation = "list the project's linked worktrees";
    // NUL-delimited porcelain disables C-style quoting, even for newlines in paths.
    const listing = await git(root, "worktree", "list", "--porcelain", "-z");
    const entries = listing.split("\0\0").filter(Boolean);
    let linked = false;
    for (const entry of entries.slice(1)) {
      const field = entry.split("\0").find((line) => line.startsWith("worktree "));
      if (!field) continue;
      try {
        if (await realpath(path.resolve(root, field.slice("worktree ".length))) === workTree) {
          linked = true;
          break;
        }
      } catch (error) {
        // Stale registrations do not prevent checking another, existing worktree.
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    if (!linked) return { reason: `${workTree} is not a linked worktree of ${root}; the main worktree and subdirectories are not accepted.` };

    operation = "inspect the worktree's .git pointer file";
    // Following a pointer symlink could make a sibling's backlink look valid.
    if (!(await lstat(path.join(workTree, ".git"))).isFile()) {
      return { reason: `${workTree}/.git must be a regular worktree pointer file.` };
    }

    operation = "resolve the worktree's Git directories and HEAD branch";
    const gitDir = await realpath(path.resolve(workTree, withoutNewline(await git(workTree, "rev-parse", "--git-dir"))));
    const commonDir = await realpath(path.resolve(workTree, withoutNewline(await git(workTree, "rev-parse", "--git-common-dir"))));
    const actualBranch = withoutNewline(await git(workTree, "rev-parse", "--abbrev-ref", "HEAD"));
    const expectedCommon = await realpath(path.join(root, ".git"));
    const adminRoot = await realpath(path.join(expectedCommon, "worktrees"));
    if (path.dirname(gitDir) !== adminRoot) {
      return { reason: `Git directory ${gitDir} is not an administrative directory directly under ${adminRoot}.` };
    }
    if (commonDir !== expectedCommon) {
      return { reason: `Git common directory ${commonDir} does not match ${expectedCommon}.` };
    }
    if (actualBranch !== branch) {
      return { reason: `Worktree branch ${actualBranch} does not match the requested branch ${branch}.` };
    }

    operation = "verify the administrative directory's gitdir backlink";
    const backlink = withoutNewline(await readFile(path.join(gitDir, "gitdir"), "utf8"));
    const linkedPointer = await realpath(path.resolve(gitDir, backlink));
    const candidatePointer = await realpath(path.join(workTree, ".git"));
    if (linkedPointer !== candidatePointer) {
      return { reason: `Git directory ${gitDir} points back to ${linkedPointer}, not ${candidatePointer}.` };
    }
    return { gitDir, workTree, branch: actualBranch, commonDir };
  } catch (error) {
    return { reason: `Cannot ${operation}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
