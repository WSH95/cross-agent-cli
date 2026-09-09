import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { verifyWorktree } from "../src/worktree.ts";
import type { WorktreeResult } from "../src/worktree.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.replace(/\n$/, "");
}

async function repository(t: TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), "cross-agent-worktree-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "initial");
  async function add(name: string, relativePath = name): Promise<string> {
    const worktree = path.join(temporary, "linked", relativePath);
    await git(root, "worktree", "add", "-b", `task/${name}`, worktree);
    return worktree;
  }
  return { temporary, root, add };
}

function refusal(result: WorktreeResult): string {
  assert.ok("reason" in result, JSON.stringify(result));
  assert.deepEqual(Object.keys(result), ["reason"]);
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.trim().length > 0);
  return result.reason;
}

test("verifyWorktree accepts a linked worktree on its exact branch", async (t) => {
  const { root, add } = await repository(t);
  const candidate = await add("feature", "different-directory-name");
  const before = await readFile(path.join(candidate, ".git"), "utf8");
  assert.deepEqual(await verifyWorktree(root, candidate, "task/feature"), {
    gitDir: await realpath(path.join(root, ".git", "worktrees", "different-directory-name")),
    workTree: await realpath(candidate),
    branch: "task/feature",
  });
  assert.equal(await readFile(path.join(candidate, ".git"), "utf8"), before);
  assert.equal(await git(root, "status", "--porcelain"), "");
  assert.equal(await git(candidate, "status", "--porcelain"), "");

  const sameBasename = await add("second", "nested/different-directory-name");
  const gitDir = await realpath(await git(sameBasename, "rev-parse", "--git-dir"));
  assert.notEqual(path.basename(gitDir), path.basename(sameBasename));
  assert.deepEqual(await verifyWorktree(root, sameBasename, "task/second"), {
    gitDir, workTree: await realpath(sameBasename), branch: "task/second",
  });
});

test("verifyWorktree accepts canonical-equivalent symlink paths", async (t) => {
  const { temporary, root, add } = await repository(t);
  const candidate = await add("symlink");
  const alias = path.join(temporary, "alias");
  await symlink(temporary, alias, "dir");
  assert.deepEqual(await verifyWorktree(path.join(alias, "project"), path.join(alias, "linked", "symlink"), "task/symlink"), {
    gitDir: await realpath(path.join(root, ".git", "worktrees", "symlink")),
    workTree: await realpath(candidate),
    branch: "task/symlink",
  });
});

test("verifyWorktree handles porcelain paths containing whitespace, quotes, backslashes, and Unicode", async (t) => {
  const { root, add } = await repository(t);
  const candidate = await add("encoding", 'sp ace\t"quoted"\\slash\n雪 ');
  assert.deepEqual(await verifyWorktree(root, candidate, "task/encoding"), {
    gitDir: await realpath(await git(candidate, "rev-parse", "--git-dir")),
    workTree: await realpath(candidate),
    branch: "task/encoding",
  });
});

test("verifyWorktree resolves relative Git paths against the command cwd", async (t) => {
  const { root, add } = await repository(t);
  const candidate = await add("relative");
  const gitDir = await realpath(await git(candidate, "rev-parse", "--git-dir"));
  const pointer = path.join(candidate, ".git");
  const original = await readFile(pointer, "utf8");
  try {
    await writeFile(pointer, `gitdir: ${path.relative(candidate, gitDir)}\n`);
    assert.deepEqual(await verifyWorktree(path.relative(process.cwd(), root), path.relative(process.cwd(), candidate), "task/relative"), {
      gitDir, workTree: await realpath(candidate), branch: "task/relative",
    });
  } finally {
    await writeFile(pointer, original);
  }
});

for (const name of ["repository root", "root subdirectory", "unrelated repository", "different branch", "missing path"]) {
  test(`verifyWorktree refuses ${name} with a reason`, async (t) => {
    const { temporary, root, add } = await repository(t);
    let candidate = await add("accepted");
    let branch = "task/accepted";
    if (name === "repository root") {
      candidate = root;
      branch = "main";
    } else if (name === "root subdirectory") {
      candidate = path.join(root, "subdirectory");
      await mkdir(candidate);
      branch = "main";
    } else if (name === "unrelated repository") {
      const other = await repository(t);
      candidate = await other.add("accepted");
    } else if (name === "different branch") {
      branch = "task/other";
    } else {
      candidate = path.join(temporary, "missing");
    }
    refusal(await verifyWorktree(root, candidate, branch));
  });
}

test("verifyWorktree ignores what the server's own environment says about a repository", async (t) => {
  const { root, add } = await repository(t);
  const candidate = await add("inherited");
  // A server started from a hook, or from `git rebase --exec`, inherits these. Reading
  // them would answer every question about the wrong repository — GIT_DIR alone makes
  // `rev-parse --git-dir` report the root's, and the worktree is then refused.
  const poisoned: Record<string, string> = {
    GIT_DIR: path.join(root, ".git"),
    GIT_WORK_TREE: root,
    GIT_INDEX_FILE: path.join(root, "elsewhere.index"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
  };
  for (const [name, value] of Object.entries(poisoned)) {
    const original = process.env[name];
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
    process.env[name] = value;
  }
  assert.deepEqual(await verifyWorktree(root, candidate, "task/inherited"), {
    gitDir: await realpath(path.join(root, ".git", "worktrees", "inherited")),
    workTree: await realpath(candidate),
    branch: "task/inherited",
  });
});

test("verifyWorktree refuses a rewritten .git pointer", async (t) => {
  const { temporary, root, add } = await repository(t);
  const candidate = await add("a");
  const sibling = await add("b");
  const pointer = path.join(candidate, ".git");
  const original = await readFile(pointer, "utf8");
  const siblingGitDir = await git(sibling, "rev-parse", "--git-dir");
  try {
    await writeFile(pointer, `gitdir: ${path.join(temporary, "missing-admin")}\n`);
    refusal(await verifyWorktree(root, candidate, "task/a"));
    await writeFile(pointer, `gitdir: ${siblingGitDir}\n`);
    assert.equal(await git(candidate, "rev-parse", "--abbrev-ref", "HEAD"), "task/b");
    refusal(await verifyWorktree(root, candidate, "task/b"));
  } finally {
    await writeFile(pointer, original);
  }
});

test("verifyWorktree refuses a .git symlink to a sibling pointer", async (t) => {
  const { root, add } = await repository(t);
  const candidate = await add("a");
  const sibling = await add("b");
  const pointer = path.join(candidate, ".git");
  const original = await readFile(pointer, "utf8");
  try {
    await rm(pointer);
    await symlink(path.join(sibling, ".git"), pointer);
    assert.equal(await git(candidate, "rev-parse", "--abbrev-ref", "HEAD"), "task/b");
    refusal(await verifyWorktree(root, candidate, "task/b"));
  } finally {
    await rm(pointer, { force: true });
    await writeFile(pointer, original);
  }
});
