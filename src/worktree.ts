import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export type WorktreeResult = { gitDir: string; workTree: string; branch: string } | { reason: string };

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
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
    return { gitDir, workTree, branch: actualBranch };
  } catch (error) {
    return { reason: `Cannot ${operation}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
