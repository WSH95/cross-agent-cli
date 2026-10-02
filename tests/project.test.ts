import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { discoverProject } from "../src/project.ts";
import { git } from "./helpers/git.ts";
import { bareProject, linkedProject, mainCheckout, separatedMainProject, umbrellaProject } from "./helpers/project.ts";

function scratch(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "cross-agent-project-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A directory holding .cross-agent/config.json, with a subdirectory to start from. */
function project(dir: string): string {
  fs.mkdirSync(path.join(dir, ".cross-agent"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".cross-agent", "config.json"), "{}\n");
  return dir;
}

// @anchor projectWinsCross
test("--project wins over CROSS_AGENT_PROJECT, which wins over the working directory", async (t) => {
  const root = scratch(t);
  const [flagged, exported, walked] = ["flagged", "exported", "walked"].map((name) => project(path.join(root, name)));
  const cwd = path.join(walked, "src");
  const env = { CROSS_AGENT_PROJECT: exported };

  assert.deepEqual(await discoverProject(["--project", flagged], env, cwd), { root: flagged });
  assert.deepEqual(await discoverProject([], env, cwd), { root: exported });
  assert.deepEqual(await discoverProject([], {}, cwd), { root: walked });
  // Each source is canonical: a relative flag resolves against the working directory, and
  // a symlink to a project is that project.
  fs.symlinkSync(flagged, path.join(root, "link"));
  assert.deepEqual(await discoverProject(["--project", "../../link"], {}, cwd), { root: flagged });
  assert.deepEqual(await discoverProject([], { CROSS_AGENT_PROJECT: path.join(root, "link") }, cwd), { root: flagged });
});

// @anchor workingDirectoryResolves
test("the working directory resolves to the nearest directory above it holding a config", async (t) => {
  const root = scratch(t);
  const outer = project(path.join(root, "outer"));
  const inner = project(path.join(outer, "packages", "inner"));
  assert.deepEqual(await discoverProject([], {}, path.join(inner, "src")), { root: inner });
  assert.deepEqual(await discoverProject([], {}, path.join(outer, "packages")), { root: outer });
  fs.symlinkSync(path.join(inner, "src"), path.join(root, "shortcut"));
  assert.deepEqual(await discoverProject([], {}, path.join(root, "shortcut")), { root: inner });
});

// @anchor workingDirectoryInside
test("a working directory inside an uninitialized linked worktree resolves to the main project", async (t) => {
  const root = scratch(t);
  const main = project(path.join(root, "main"));
  const git = (...args: string[]) => execFileSync("git", ["-C", main, ...args], { stdio: "ignore" });
  git("init", "-b", "main");
  git("-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false",
    "commit", "--allow-empty", "-m", "initial");
  // Outside the project, where walking up from it never reaches the main checkout, and
  // with no config of its own: only `cross-agent init` makes a worktree a project of its
  // own (`#linkedWorktreeOwnProject`), and until then it is read at its main checkout.
  const worktree = path.join(root, "elsewhere", "task-x");
  git("worktree", "add", "-b", "task/x", worktree);
  fs.mkdirSync(path.join(worktree, "src"));
  assert.deepEqual(await discoverProject([], {}, path.join(worktree, "src")), { root: main });
  assert.deepEqual(await discoverProject([], {}, worktree), { root: main });
});

// @anchor projectConfigAnywhere
test("a project with no config anywhere is the git toplevel of the working directory", async (t) => {
  const root = scratch(t);
  const repo = path.join(root, "repo");
  const deep = path.join(repo, "src", "deep");
  fs.mkdirSync(deep, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-b", "main");

  // No config above the working directory and no `--project`: the project is the
  // repository, running solo, and nothing is written to find that out — `cross-agent
  // init` stays the only writer of a config (design, "Modes").
  assert.deepEqual(await discoverProject([], {}, deep), { root: repo });
  assert.deepEqual(await discoverProject([], {}, repo), { root: repo });
  assert.equal(fs.existsSync(path.join(repo, ".cross-agent")), false);
  const defaults = loadConfig(repo);
  assert.equal(defaults.mode, "solo");
  assert.deepEqual(defaults.roles, {}, "no binding is guessed: the engine comes per call");

  // A linked worktree of that repository is the same project, read at the main checkout,
  // where the ledger lives.
  git("-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false",
    "commit", "--allow-empty", "-m", "initial");
  const worktree = path.join(root, "elsewhere", "task-x");
  git("worktree", "add", "-b", "task/x", worktree);
  assert.deepEqual(await discoverProject([], {}, worktree), { root: repo });

  // A config that does exist above the working directory still wins over the toplevel.
  project(path.join(repo, "packages", "inner"));
  assert.deepEqual(await discoverProject([], {}, path.join(repo, "packages", "inner", "src")),
    { root: path.join(repo, "packages", "inner") });
});

test("no config and no repository is a reason, never a guess", async (t) => {
  const root = scratch(t);
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  const missing = path.join(root, "missing");
  const usage = (argv: string) => `expected [--project <root>], got ${argv}`;

  assert.deepEqual(await discoverProject([], {}, empty), {
    reason: `no .cross-agent/config.json in ${empty} or any directory above it, and ${empty} is in no git repository: without a config the project is the working directory's git toplevel`,
  });
  assert.deepEqual(await discoverProject(["--project", empty], {}, root), { reason: `--project ${empty} holds no .cross-agent/config.json` });
  assert.deepEqual(await discoverProject(["--project", missing], {}, root),
    { reason: `cannot resolve --project ${missing}: ENOENT: no such file or directory, realpath '${missing}'` });
  assert.deepEqual(await discoverProject([], { CROSS_AGENT_PROJECT: empty }, root),
    { reason: `CROSS_AGENT_PROJECT ${empty} holds no .cross-agent/config.json` });
  for (const value of ["", "relative/project"]) {
    assert.deepEqual(await discoverProject([], { CROSS_AGENT_PROJECT: value }, root),
      { reason: `CROSS_AGENT_PROJECT must be an absolute path, not ${JSON.stringify(value)}` });
  }
  for (const argv of [["--project"], ["--project", ""], ["--projct", empty], ["--project", empty, "--project", empty]]) {
    assert.deepEqual(await discoverProject(argv, {}, root), { reason: usage(argv.join(" ")) });
  }
});

// Design section 2: a cwd inside a worktree that an enclosing work tree registers is read as
// that work tree first, from outside it and before any config is looked at; then the nearest
// `.git` holder's own config, which is local opt-in, comes before today's mapping to the main
// checkout. A worktree project is one `cross-agent init` was run in.

/** A main checkout of this test's own, holding a config, and a task worktree under it on `task/t`. */
async function mainWithTask(t: TestContext): Promise<{ root: string; main: string; task: string }> {
  const root = scratch(t);
  const main = await mainCheckout(root, "M");
  project(main);
  const task = path.join(main, ".worktrees", "t");
  await git(main, "worktree", "add", "-b", "task/t", task);
  return { root, main, task: fs.realpathSync(task) };
}

// @anchor linkedWorktreeOwnProject
test("an initialized linked worktree is a project of its own, from anywhere inside it", async (t) => {
  const root = scratch(t);
  const main = project(await mainCheckout(root, "M"));
  const linked = project(await linkedProject(t, main, "feature"));
  assert.deepEqual(await discoverProject([], {}, path.join(linked, "src")), { root: linked });
  assert.deepEqual(await discoverProject([], {}, linked), { root: linked });
  assert.deepEqual(await discoverProject(["--project", linked], {}, root), { root: linked });
  // The main checkout is still its own.
  assert.deepEqual(await discoverProject([], {}, path.join(main, "src")), { root: main });
});

// @anchor bareWorktreeProject
test("an initialized worktree of a bare repository beside it is a project of its own", async (t) => {
  const bare = await bareProject(t);
  project(bare.root);
  assert.deepEqual(await discoverProject([], {}, path.join(bare.root, "src")), { root: bare.root });
  // Its sibling, uninitialized, has no main checkout to be read at, and is its own toplevel.
  const sibling = path.join(bare.dir, "main");
  assert.deepEqual(await discoverProject([], {}, sibling), { root: sibling });
});

// @anchor umbrellaWorktreeProject
test("an initialized worktree of the umbrella layout is a project of its own: the umbrella is no work tree", async (t) => {
  const umbrella = await umbrellaProject(t);
  project(umbrella.root);
  assert.deepEqual(await discoverProject([], {}, path.join(umbrella.root, "src")), { root: umbrella.root });
  assert.deepEqual(await discoverProject(["--project", umbrella.root], {}, umbrella.dir), { root: umbrella.root });
});

// @anchor cwdInsideTaskWorktreeMapsToRoot
test("a working directory inside a task worktree is read as its enclosing root, before any config", async (t) => {
  const { main, task } = await mainWithTask(t);
  // A config inside the task worktree is not the project's: the enclosing registry decides first.
  project(task);
  assert.deepEqual(await discoverProject([], {}, path.join(task, "src")), { root: main });
  assert.deepEqual(await discoverProject([], {}, task), { root: main });
});

// @anchor removedPointerCwdMapsToRoot
test("a working directory inside a task worktree whose pointer was deleted still maps to its root", async (t) => {
  const { main, task } = await mainWithTask(t);
  project(task);
  fs.rmSync(path.join(task, ".git"));
  assert.deepEqual(await discoverProject([], {}, path.join(task, "src")), { root: main });
});

// @anchor replacedPointerCwdMapsToRoot
test("a working directory inside a task worktree whose pointer was replaced by a repository still maps to its root", async (t) => {
  const { main, task } = await mainWithTask(t);
  project(task);
  fs.rmSync(path.join(task, ".git"));
  await git(task, "init", "-b", "main");
  assert.deepEqual(await discoverProject([], {}, path.join(task, "src")), { root: main });
});

// @anchor remapIsLexical
test("the mapping out of a task worktree is lexical: a path that exists only on its branch still maps", async (t) => {
  const { main, task } = await mainWithTask(t);
  const onBranch = path.join(task, "only", "on", "the", "branch");
  fs.mkdirSync(onBranch, { recursive: true });
  assert.equal(fs.existsSync(path.join(main, "only")), false);
  assert.deepEqual(await discoverProject([], {}, onBranch), { root: main });
});

// @anchor namedTaskWorktreeRefused
test("a task worktree named as the project is refused before its config is read", async (t) => {
  const { main, task } = await mainWithTask(t);
  // A config that could not be parsed: naming the worktree never reaches it.
  fs.mkdirSync(path.join(task, ".cross-agent"), { recursive: true });
  fs.writeFileSync(path.join(task, ".cross-agent", "config.json"), "{ not json");
  fs.mkdirSync(path.join(task, "src"));
  for (const found of [
    await discoverProject(["--project", task], {}, main),
    await discoverProject([], { CROSS_AGENT_PROJECT: task }, main),
    await discoverProject(["--project", path.join(task, "src")], {}, main),
  ]) {
    assert.ok("reason" in found, JSON.stringify(found));
    assert.ok(found.reason.includes(task) && found.reason.includes(main), found.reason);
    assert.match(found.reason, /never a project root/);
  }
});

// @anchor forgedRegistryRefused
test("a task worktree that forges a registry of its own is still refused by name and still mapped from inside", async (t) => {
  const { main, task } = await mainWithTask(t);
  project(task);
  // The pointer replaced by a repository whose own registry lists the worktree as its main.
  fs.rmSync(path.join(task, ".git"));
  await git(task, "init", "-b", "main");
  assert.equal(await git(task, "rev-parse", "--show-toplevel"), task, "its own git takes it for a main checkout");
  const named = await discoverProject(["--project", task], {}, main);
  assert.ok("reason" in named, JSON.stringify(named));
  assert.match(named.reason, /never a project root/);
  assert.deepEqual(await discoverProject([], {}, task), { root: main });
});

// @anchor unrelatedEnclosingRepository
test("a worktree project inside an unrelated work tree that does not register it is found as itself", async (t) => {
  const root = scratch(t);
  const main = await mainCheckout(root, "M");
  const unrelated = project(await mainCheckout(root, "X"));
  const linked = path.join(unrelated, "nested", "L");
  await git(main, "worktree", "add", "-b", "feature", linked);
  project(linked);
  assert.deepEqual(await discoverProject([], {}, path.join(linked, "src")), { root: linked });
  assert.deepEqual(await discoverProject(["--project", linked], {}, root), { root: linked });
});

// @anchor uninitializedWorktreeUnderConfiguredDirectory
test("an uninitialized linked worktree inside a configured directory is read at its main checkout, as today", async (t) => {
  const root = scratch(t);
  const main = project(await mainCheckout(root, "M"));
  // A configured directory that is no repository, holding the worktree: the worktree's own
  // `.git` comes first, and with no config of its own it is the main checkout's.
  const holder = project(path.join(root, "holder"));
  const linked = path.join(holder, "L");
  await git(main, "worktree", "add", "-b", "feature", linked);
  fs.mkdirSync(path.join(linked, "src"));
  assert.deepEqual(await discoverProject([], {}, path.join(linked, "src")), { root: main });
});

// @anchor configuredSubdirectoryUnchanged
test("a configured subdirectory of the main checkout is found from it and from the same place in an uninitialized worktree", async (t) => {
  const root = scratch(t);
  const main = await mainCheckout(root, "M");
  const inner = project(path.join(main, "packages", "inner"));
  assert.deepEqual(await discoverProject([], {}, path.join(inner, "src")), { root: inner });
  const linked = await linkedProject(t, main, "feature");
  fs.mkdirSync(path.join(linked, "packages", "inner", "src"), { recursive: true });
  assert.deepEqual(await discoverProject([], {}, path.join(linked, "packages", "inner", "src")), { root: inner });
});

// @anchor separatedMainCwdUnmapped
test("a worktree of a separated main stays where it is: its main stanza is a git directory, no checkout", async (t) => {
  const { root } = await separatedMainProject(t);
  assert.deepEqual(await discoverProject([], {}, root), { root });
});
