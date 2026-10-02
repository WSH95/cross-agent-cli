import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gitEnvironment, locateRepository, verifyWorktree } from "../src/worktree.ts";
import type { Located, Repository, WorktreeResult } from "../src/worktree.ts";
import { bareDotGitProject, bareProject, linkedProject, mainCheckout, rootInsideCommonDir, separatedMainProject, submoduleProject, symlinkedAncestor, symlinkedGitProject, umbrellaProject } from "./helpers/project.ts";

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
  // Under the project root, where a task's worktree belongs (design section 4), and excluded
  // there as a project excludes its worktree directory.
  await writeFile(path.join(root, ".git", "info", "exclude"), ".worktrees/\n");
  async function add(name: string, relativePath = name): Promise<string> {
    const worktree = path.join(root, ".worktrees", relativePath);
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
    // The repository's own git directory, which every linked worktree shares and no
    // specialist may write: `delegate` puts it in the spec's `protectedPaths`.
    commonDir: await realpath(path.join(root, ".git")),
  });
  assert.equal(await readFile(path.join(candidate, ".git"), "utf8"), before);
  assert.equal(await git(root, "status", "--porcelain"), "");
  assert.equal(await git(candidate, "status", "--porcelain"), "");

  const sameBasename = await add("second", "nested/different-directory-name");
  const gitDir = await realpath(await git(sameBasename, "rev-parse", "--git-dir"));
  assert.notEqual(path.basename(gitDir), path.basename(sameBasename));
  assert.deepEqual(await verifyWorktree(root, sameBasename, "task/second"), {
    gitDir, workTree: await realpath(sameBasename), branch: "task/second",
    commonDir: await realpath(path.join(root, ".git")),
  });
});

test("verifyWorktree accepts canonical-equivalent symlink paths", async (t) => {
  const { temporary, root, add } = await repository(t);
  const candidate = await add("symlink");
  const alias = path.join(temporary, "alias");
  await symlink(temporary, alias, "dir");
  assert.deepEqual(await verifyWorktree(path.join(alias, "project"), path.join(alias, "project", ".worktrees", "symlink"), "task/symlink"), {
    gitDir: await realpath(path.join(root, ".git", "worktrees", "symlink")),
    workTree: await realpath(candidate),
    branch: "task/symlink",
    commonDir: await realpath(path.join(root, ".git")),
  });
});

test("verifyWorktree handles porcelain paths containing whitespace, quotes, backslashes, and Unicode", async (t) => {
  const { root, add } = await repository(t);
  const candidate = await add("encoding", 'sp ace\t"quoted"\\slash\n雪 ');
  assert.deepEqual(await verifyWorktree(root, candidate, "task/encoding"), {
    gitDir: await realpath(await git(candidate, "rev-parse", "--git-dir")),
    workTree: await realpath(candidate),
    branch: "task/encoding",
    commonDir: await realpath(path.join(root, ".git")),
  });
});

test("verifyWorktree accepts a worktree whose pointer names its gitdir: relative to the worktree", async (t) => {
  const { root, add } = await repository(t);
  const candidate = await add("relative");
  const gitDir = await realpath(await git(candidate, "rev-parse", "--git-dir"));
  const pointer = path.join(candidate, ".git");
  const original = await readFile(pointer, "utf8");
  try {
    // Both paths absolute, so the pointer is the only relative path in play: what it names
    // is the worktree's, wherever the server itself runs.
    await writeFile(pointer, `gitdir: ${path.relative(candidate, gitDir)}\n`);
    assert.deepEqual(await verifyWorktree(root, candidate, "task/relative"), {
      gitDir, workTree: await realpath(candidate), branch: "task/relative",
      commonDir: await realpath(path.join(root, ".git")),
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

// @anchor relativeToProjectRoot
test("verifyWorktree reads a relative worktree path against the project root, not the server's own directory", async (t) => {
  const { root } = await repository(t);
  await git(root, "worktree", "add", "-b", "task/relative", path.join(".worktrees", "relative"));
  // The server's working directory is wherever its host started it — the Codex plugin's is
  // its cached copy — so a path the loop writes relative to the project is the project's.
  assert.notEqual(await realpath(process.cwd()), await realpath(root));
  const verified = await verifyWorktree(root, path.join(".worktrees", "relative"), "task/relative");
  assert.ok(!("reason" in verified), JSON.stringify(verified));
  assert.equal(verified.workTree, await realpath(path.join(root, ".worktrees", "relative")));
});

// @anchor gitenvironmentPassesGit
test("gitEnvironment passes what git needs to run as this user, and nothing else", () => {
  assert.deepEqual(gitEnvironment({
    PATH: "/usr/bin", HOME: "/home/someone", USER: "someone", LANG: "en_GB.UTF-8", LC_ALL: "C",
    TZ: "UTC", TMPDIR: "/tmp", XDG_CONFIG_HOME: "/home/someone/.config", XDG_CACHE_HOME: "/home/someone/.cache",
    SSH_AUTH_SOCK: "/run/agent", GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -F /dev/null",
    GIT_AUTHOR_NAME: "Someone", GIT_COMMITTER_EMAIL: "someone@example.invalid",
    // git's documented ident fallback, and the path a relocated install needs to find its
    // own helpers: both are about who and where git is, not about which repository.
    EMAIL: "someone@example.invalid", GIT_EXEC_PATH: "/opt/git/libexec/git-core",
    // Everything below points git at another repository, index, object store or config.
    GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere", GIT_INDEX_FILE: "/elsewhere/index",
    GIT_OBJECT_DIRECTORY: "/elsewhere/objects", GIT_ALTERNATE_OBJECT_DIRECTORIES: "/elsewhere/alt",
    GIT_NAMESPACE: "other", GIT_CEILING_DIRECTORIES: "/", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/elsewhere/hooks", GIT_CONFIG_GLOBAL: "/elsewhere/config",
    CROSS_AGENT_TASK: "the server's own task", UNRELATED: "whatever",
  }), {
    PATH: "/usr/bin", HOME: "/home/someone", USER: "someone", LANG: "en_GB.UTF-8", LC_ALL: "C",
    TZ: "UTC", TMPDIR: "/tmp", XDG_CONFIG_HOME: "/home/someone/.config", XDG_CACHE_HOME: "/home/someone/.cache",
    SSH_AUTH_SOCK: "/run/agent", GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -F /dev/null",
    GIT_AUTHOR_NAME: "Someone", GIT_COMMITTER_EMAIL: "someone@example.invalid",
    EMAIL: "someone@example.invalid", GIT_EXEC_PATH: "/opt/git/libexec/git-core",
  });
  assert.deepEqual(gitEnvironment({}), {});
});

// @anchor verifyworktreeIgnoresServer
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
    commonDir: await realpath(path.join(root, ".git")),
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

// `locateRepository`: the project's repository, verified once per tool call (design
// section 4). A task worktree is never a project root, and what proves it is the registry
// of an enclosing work tree, read from outside the candidate: the candidate's own `.git`
// plays no part, whether intact, deleted, replaced or rewritten.

/** A canonical temporary directory of this test's own. */
async function scratch(t: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "cross-agent-locate-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** The refusal `locateRepository` answers with, and its kind. */
function refused(located: Located, kind: "refused" | "unsupported" | "none" = "refused"): string {
  assert.ok("reason" in located, JSON.stringify(located));
  assert.equal(located.kind, kind, located.reason);
  return located.reason;
}

function repositoryOf(located: Located): Repository {
  assert.ok(!("reason" in located), JSON.stringify(located));
  return located;
}

/** A main checkout of this test's own and a task worktree under it, at `.worktrees/t` on `task/t`. */
async function mainWithTask(t: TestContext): Promise<{ main: string; task: string }> {
  const temporary = await scratch(t);
  const main = await mainCheckout(temporary, "M");
  const task = path.join(main, ".worktrees", "t");
  await git(main, "worktree", "add", "-b", "task/t", task);
  return { main, task: await realpath(task) };
}

/** The nested refusal names the worktree and the work tree whose registry lists it. */
function nestedIn(reason: string, worktree: string, ancestor: string): void {
  assert.ok(reason.includes(worktree), reason);
  assert.ok(reason.includes(ancestor), reason);
  assert.match(reason, /never a project root/);
}

// @anchor locateRepositoryKinds
test("locateRepository answers a main checkout, a linked root, a bare repository's worktree and a directory with no .git", async (t) => {
  const temporary = await scratch(t);
  const main = await mainCheckout(temporary, "M");
  assert.deepEqual(await locateRepository(main), {
    kind: "main", workTree: main, gitDir: path.join(main, ".git"), commonDir: path.join(main, ".git"),
    branch: "main", main, stanzas: [{ path: main, branch: "main", main: true }],
  });

  const linked = await linkedProject(t, main, "feature");
  const located = repositoryOf(await locateRepository(linked));
  assert.equal(located.kind, "linked");
  assert.equal(located.workTree, linked);
  assert.equal(located.gitDir, await realpath(path.join(main, ".git", "worktrees", path.basename(linked))));
  assert.equal(located.commonDir, path.join(main, ".git"));
  assert.equal(located.branch, "feature");
  assert.equal(located.main, main, "the first stanza is a work tree by its own git: the main checkout");
  assert.deepEqual(located.stanzas.map((stanza) => [stanza.path, stanza.branch, stanza.main]), [[main, "main", true], [linked, "feature", false]]);

  // Detached, the root is still a linked root, with no branch.
  await git(linked, "checkout", "--detach");
  assert.equal(repositoryOf(await locateRepository(linked)).branch, null);

  const bare = await bareProject(t);
  const beside = repositoryOf(await locateRepository(bare.root));
  assert.equal(beside.kind, "bare-linked");
  assert.equal(beside.main, null);
  assert.equal(beside.commonDir, bare.commonDir);
  assert.equal(beside.branch, "feature");

  const plain = path.join(temporary, "plain");
  await mkdir(plain);
  refused(await locateRepository(plain), "none");
});

// @anchor locateRepositoryRefusesNested
test("locateRepository refuses a task worktree, naming it and the work tree whose registry lists it", async (t) => {
  const { main, task } = await mainWithTask(t);
  nestedIn(refused(await locateRepository(task)), task, main);
  // A directory inside it is refused the same way.
  await mkdir(path.join(task, "src"));
  nestedIn(refused(await locateRepository(path.join(task, "src"))), task, main);
});

// @anchor locateRepositoryRemovedPointerStillNested
test("a task worktree whose .git pointer is deleted is still refused as nested", async (t) => {
  const { main, task } = await mainWithTask(t);
  await rm(path.join(task, ".git"));
  nestedIn(refused(await locateRepository(task)), task, main);
});

// @anchor locateRepositoryReplacedPointerStillNested
test("a task worktree whose .git pointer is replaced by a repository of its own is still refused as nested", async (t) => {
  const { main, task } = await mainWithTask(t);
  await rm(path.join(task, ".git"));
  await git(task, "init", "-b", "main");
  assert.equal(await git(task, "rev-parse", "--absolute-git-dir"), path.join(task, ".git"), "its own git now takes it for a main checkout");
  nestedIn(refused(await locateRepository(task)), task, main);
});

// @anchor locateRepositoryRefusesForgedRegistry
test("a registry a task worktree forges inside itself proves nothing against the one that registers it", async (t) => {
  const { main, task } = await mainWithTask(t);
  // Everything a specialist confined to the worktree can write: a common directory of its
  // own, an administrative directory in it backlinked to the worktree, and a pointer to it.
  const forged = path.join(task, ".forged");
  await git(task, "init", "--bare", "-b", "main", forged);
  const tree = await git(forged, "hash-object", "-t", "tree", "-w", "/dev/null");
  const commit = await git(forged, "-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-m", "forged");
  await git(forged, "update-ref", "refs/heads/feature", commit);
  const admin = path.join(forged, "worktrees", "t");
  await mkdir(admin, { recursive: true });
  await writeFile(path.join(admin, "commondir"), "../..\n");
  await writeFile(path.join(admin, "gitdir"), `${path.join(task, ".git")}\n`);
  await writeFile(path.join(admin, "HEAD"), "ref: refs/heads/feature\n");
  await writeFile(path.join(task, ".git"), `gitdir: ${admin}\n`);
  assert.equal(await realpath(await git(task, "rev-parse", "--git-common-dir")), await realpath(forged), "git takes the forgery at its word");
  nestedIn(refused(await locateRepository(task)), task, main);
});

// @anchor locateRepositoryUnrelatedAncestor
test("a linked root inside an unrelated work tree that does not register it is a linked root", async (t) => {
  const temporary = await scratch(t);
  const main = await mainCheckout(temporary, "M");
  const unrelated = await mainCheckout(temporary, "X");
  const root = path.join(unrelated, "sub", "L");
  await git(main, "worktree", "add", "-b", "feature", root);
  const located = repositoryOf(await locateRepository(root));
  assert.equal(located.kind, "linked");
  assert.equal(located.main, main);
});

// @anchor locateRepositoryRefusesRewrittenPointer
test("locateRepository refuses a linked root whose pointer names another worktree's administrative directory", async (t) => {
  const temporary = await scratch(t);
  const main = await mainCheckout(temporary, "M");
  const first = path.join(temporary, "L1");
  const second = path.join(temporary, "L2");
  await git(main, "worktree", "add", "-b", "one", first);
  await git(main, "worktree", "add", "-b", "two", second);
  await writeFile(path.join(first, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "L2")}\n`);
  assert.match(refused(await locateRepository(first)), /points back/);
  await writeFile(path.join(first, ".git"), `gitdir: ${path.join(temporary, "missing-admin")}\n`);
  refused(await locateRepository(first));
  await writeFile(path.join(first, ".git"), "not a pointer\n");
  refused(await locateRepository(first));
});

// @anchor locateRepositoryUmbrellaAllowed
test("the umbrella layout's worktrees are roots: U is no work tree by its own git, and U itself is unsupported", async (t) => {
  const umbrella = await umbrellaProject(t);
  const located = repositoryOf(await locateRepository(umbrella.root));
  assert.equal(located.kind, "bare-linked");
  assert.equal(located.main, null);
  assert.equal(located.commonDir, umbrella.commonDir);
  assert.equal(located.gitDir, path.join(umbrella.commonDir, "worktrees", "feature"));
  const own = await locateRepository(umbrella.umbrella);
  refused(own, "unsupported");
  assert.equal((own as { gitDir: string }).gitDir, umbrella.commonDir);
});

// @anchor locateRepositorySiblingBareAllowed
test("a bare repository's worktrees beside it are roots", async (t) => {
  const bare = await bareProject(t);
  for (const [root, branch] of [[bare.root, "feature"], [path.join(bare.dir, "main"), "main"]]) {
    const located = repositoryOf(await locateRepository(root));
    assert.equal(located.kind, "bare-linked");
    assert.equal(located.branch, branch);
    assert.equal(located.commonDir, bare.commonDir);
  }
});

// @anchor locateRepositorySymlinkedAncestorCanonical
test("a root reached through a symlinked ancestor is located at its canonical path, and nesting is judged there", async (t) => {
  const fixture = await symlinkedAncestor(t);
  nestedIn(refused(await locateRepository(path.join(fixture.alias, "M", ".worktrees", "t"))), fixture.task, fixture.main);
  const located = repositoryOf(await locateRepository(path.join(fixture.alias, "L")));
  assert.equal(located.workTree, fixture.root);
  assert.equal(located.main, fixture.main);
  assert.equal(repositoryOf(await locateRepository(path.join(fixture.alias, "M"))).workTree, fixture.main);
});

// @anchor locateRepositoryRefusesSubmodule
test("a submodule checkout is unsupported: its .git leads to a git directory that is its own common directory", async (t) => {
  const { superproject, submodule } = await submoduleProject(t);
  const located = await locateRepository(submodule);
  refused(located, "unsupported");
  assert.equal((located as { gitDir: string }).gitDir, path.join(superproject, ".git", "modules", "sub"));
  assert.equal((located as { workTree: string }).workTree, submodule);
});

// @anchor locateRepositoryRefusesInsideMainCheckout
test("a linked worktree inside its main checkout, outside the task directory too, is refused", async (t) => {
  const temporary = await scratch(t);
  const main = await mainCheckout(temporary, "M");
  const inside = path.join(main, "branches", "x");
  await git(main, "worktree", "add", "-b", "x", inside);
  nestedIn(refused(await locateRepository(inside)), inside, main);
});

// @anchor locateRepositoryRefusesRootInsideCommonDir
test("a root inside its own common directory is refused, naming the fix", async (t) => {
  const { commonDir, root } = await rootInsideCommonDir(t);
  const reason = refused(await locateRepository(root));
  assert.ok(reason.includes(commonDir), reason);
  assert.match(reason, /beside the git directory/);
});

// @anchor locateRepositoryUnreadableAncestorRefused
test("an ancestor holding a .git its own git cannot read refuses, naming it and git's words", async (t) => {
  const temporary = await scratch(t);
  const main = await mainCheckout(temporary, "M");
  const ancestor = path.join(temporary, "A");
  await mkdir(ancestor);
  await writeFile(path.join(ancestor, ".git"), "not a gitdir line\n");
  const root = path.join(ancestor, "inner", "L");
  await git(main, "worktree", "add", "-b", "feature", root);
  const reason = refused(await locateRepository(root));
  assert.ok(reason.includes(ancestor), reason);
  assert.match(reason, /gitfile/);
});

// @anchor locateRepositorySeparatedMainEnclosesTask
test("a main checkout with a separated git directory encloses its task worktree, whatever the task's pointer", async (t) => {
  const { main } = await separatedMainProject(t);
  const task = path.join(main, ".worktrees", "t");
  await git(main, "worktree", "add", "-b", "task/t", task);
  // The registry names the separated git directory as the main stanza, so the enclosing work
  // tree is found by its own git, never by that stanza.
  nestedIn(refused(await locateRepository(task)), task, main);
  await rm(path.join(task, ".git"));
  nestedIn(refused(await locateRepository(task)), task, main);
  await git(task, "init", "-b", "main");
  nestedIn(refused(await locateRepository(task)), task, main);
});

// @anchor locateRepositorySeparatedMainUnsupported
test("a main checkout with a separated git directory is unsupported, carrying that directory", async (t) => {
  const { main, gitDir } = await separatedMainProject(t);
  const located = await locateRepository(main);
  refused(located, "unsupported");
  assert.equal((located as { gitDir: string }).gitDir, gitDir);
  assert.equal((located as { workTree: string }).workTree, main);
});

// @anchor locateRepositorySymlinkedGitUnsupported
test("a main checkout whose .git links to its own git directory is unsupported, carrying that directory, and any other link is refused", async (t) => {
  const { dir, main, gitDir } = await symlinkedGitProject(t);
  const located = await locateRepository(main);
  assert.match(refused(located, "unsupported"), /symbolic link/);
  assert.equal((located as { gitDir: string }).gitDir, gitDir);
  assert.equal((located as { workTree: string }).workTree, main);
  // Its task worktrees are not verified: the git directory they share lies outside the
  // root, where no task's denial of its cwd reaches.
  const task = path.join(main, ".worktrees", "w");
  await git(main, "worktree", "add", "-b", "task/w", task);
  assert.ok("reason" in await verifyWorktree(main, task, "task/w"), "verify_worktree refuses a task worktree there");

  // A link git does not read as the root's own git directory is refused: one that leads
  // nowhere, one to a directory that is no repository, one to a bare repository, and one
  // to a linked worktree's administrative directory, which is not its own common directory.
  const elsewhere = path.join(dir, "elsewhere");
  await mkdir(elsewhere);
  const bare = path.join(dir, "bare.git");
  await git(dir, "init", "--bare", "-b", "main", bare);
  for (const target of [path.join(dir, "missing"), elsewhere, bare, path.join(gitDir, "worktrees", "w")]) {
    await rm(path.join(main, ".git"));
    await symlink(target, path.join(main, ".git"), "dir");
    refused(await locateRepository(main));
  }
});

// @anchor locateRepositoryNewlinePaths
test("a main checkout and a common directory whose paths hold a newline locate, as the worktree sharing that directory does", async (t) => {
  const temporary = await scratch(t);
  const main = await mainCheckout(temporary, "M\nname ");
  const linked = path.join(temporary, "L");
  await git(main, "worktree", "add", "-b", "feature", linked);
  const own = repositoryOf(await locateRepository(main));
  assert.equal(own.kind, "main");
  assert.equal(own.gitDir, path.join(main, ".git"));
  // The pointer names an administrative directory under that common directory, newline and
  // trailing space included, and git reads it whole.
  const shared = repositoryOf(await locateRepository(linked));
  assert.equal(shared.kind, "linked");
  assert.equal(shared.commonDir, path.join(main, ".git"));
  assert.equal(shared.main, main);
  assert.equal(shared.branch, "feature");
});

// @anchor locateRepositoryBareDotGitAllowed
test("a bare repository at U/.git, its main unlabelled under worktreeConfig, has bare-linked worktrees", async (t) => {
  const fixture = await bareDotGitProject(t);
  const listing = await git(fixture.root, "worktree", "list", "--porcelain");
  assert.doesNotMatch(listing.split("\n\n")[0], /^bare$/m, "the listing from the worktree names U without bare");
  const located = repositoryOf(await locateRepository(fixture.root));
  assert.equal(located.kind, "bare-linked");
  assert.equal(located.main, null);
  assert.equal(located.commonDir, fixture.commonDir);
});

// @anchor locateRepositoryBareDirectoryUnsupported
test("the directory holding a bare repository at .git is unsupported: it is no work tree of that repository", async (t) => {
  const fixture = await bareDotGitProject(t);
  const located = await locateRepository(fixture.bare);
  refused(located, "unsupported");
  assert.equal((located as { gitDir: string }).gitDir, fixture.commonDir);
});

// @anchor locateRepositorySeparatedMainWorktreeMainNull
test("a worktree of a separated main is linked with no main: its main stanza names the git directory", async (t) => {
  const { root, gitDir } = await separatedMainProject(t);
  const located = repositoryOf(await locateRepository(root));
  assert.equal(located.kind, "linked");
  assert.equal(located.main, null);
  assert.equal(located.commonDir, gitDir);
  assert.equal(located.stanzas.find((stanza) => stanza.main)?.path, gitDir);
});

// `verifyWorktree` against a root that is not its repository's main checkout (design
// section 4): identity from the located repository, membership and nesting from a fresh
// listing, and a task worktree only strictly under the project root.

// @anchor verifyWorktreeContainment
test("verifyWorktree accepts a task worktree strictly under the project root and nothing of its siblings'", async (t) => {
  const temporary = await scratch(t);
  const main = await mainCheckout(temporary, "M");
  const root = await linkedProject(t, main, "feature");
  const sibling = await linkedProject(t, main, "other");
  const task = path.join(root, ".worktrees", "x");
  await git(root, "worktree", "add", "-b", "task/x", task);
  const theirs = path.join(sibling, ".worktrees", "y");
  await git(sibling, "worktree", "add", "-b", "task/y", theirs);

  assert.deepEqual(await verifyWorktree(root, task, "task/x"), {
    gitDir: await realpath(path.join(main, ".git", "worktrees", "x")),
    workTree: await realpath(task), branch: "task/x",
    // The repository's common directory, which a linked root shares with its main checkout.
    commonDir: path.join(main, ".git"),
  });
  // The root itself, a sibling project's root and that project's task worktree are all
  // linked worktrees of this repository, and none of them is this project's.
  for (const [candidate, branch] of [[root, "feature"], [sibling, "other"], [theirs, "task/y"]]) {
    assert.match(refusal(await verifyWorktree(root, candidate, branch)), /not under the project root/, candidate);
  }
  // The main checkout is no linked worktree at all.
  assert.match(refusal(await verifyWorktree(root, main, "main")), /is not a linked worktree of/);
  // A worktree nested inside this project's own task worktree is refused, its pointer intact or not.
  const nested = path.join(task, ".worktrees", "z");
  await git(root, "worktree", "add", "-b", "task/z", nested);
  assert.match(refusal(await verifyWorktree(root, nested, "task/z")), /inside .* another worktree/);
  await rm(path.join(task, ".git"));
  assert.match(refusal(await verifyWorktree(root, nested, "task/z")), /inside .* another worktree/);
});

// @anchor verifyWorktreeIgnoresStanzasAboveRoot
test("verifyWorktree reads no stanza at or above the root: a bare main, labelled or not, encloses nothing", async (t) => {
  const fixture = await bareDotGitProject(t);
  const task = path.join(fixture.root, ".worktrees", "x");
  await git(fixture.root, "worktree", "add", "-b", "task/x", task);
  const expected = {
    gitDir: path.join(fixture.commonDir, "worktrees", "x"), workTree: await realpath(task), branch: "task/x",
    commonDir: fixture.commonDir,
  };
  // Unlabelled: `core.bare` lives in the main's own `config.worktree`, which a listing from
  // the root does not read, so `U` is listed as a work tree enclosing the task worktree.
  assert.doesNotMatch((await git(fixture.root, "worktree", "list", "--porcelain")).split("\n\n")[0], /^bare$/m);
  assert.deepEqual(await verifyWorktree(fixture.root, task, "task/x"), expected);
  // Labelled: `core.bare` back in the shared config.
  await git(fixture.commonDir, "config", "--worktree", "--unset", "core.bare");
  await git(fixture.commonDir, "config", "core.bare", "true");
  assert.match((await git(fixture.root, "worktree", "list", "--porcelain")).split("\n\n")[0], /^bare$/m);
  assert.deepEqual(await verifyWorktree(fixture.root, task, "task/x"), expected);
});

// @anchor verifyWorktreeFreshListing
test("verifyWorktree lists the registry afresh, so a repository located before a worktree add verifies it", async (t) => {
  const umbrella = await umbrellaProject(t);
  const located = await locateRepository(umbrella.root);
  assert.ok(!("reason" in located), JSON.stringify(located));
  const task = path.join(umbrella.root, ".worktrees", "x");
  await git(umbrella.root, "worktree", "add", "-b", "task/x", task);
  assert.equal(located.stanzas.some((stanza) => stanza.path === task), false, "the located snapshot predates it");
  assert.deepEqual(await verifyWorktree(umbrella.root, task, "task/x", located), {
    gitDir: path.join(umbrella.commonDir, "worktrees", "x"), workTree: await realpath(task), branch: "task/x",
    commonDir: umbrella.commonDir,
  });
});
