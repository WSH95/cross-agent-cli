import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { discoverProject } from "../src/project.ts";

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
test("a working directory inside a linked worktree resolves to the main project", async (t) => {
  const root = scratch(t);
  const main = project(path.join(root, "main"));
  const git = (...args: string[]) => execFileSync("git", ["-C", main, ...args], { stdio: "ignore" });
  git("init", "-b", "main");
  git("-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false",
    "commit", "--allow-empty", "-m", "initial");
  // Outside the project, where walking up from it never reaches the main checkout, and
  // with a config of its own, which is not the ledger's home.
  const worktree = path.join(root, "elsewhere", "task-x");
  git("worktree", "add", "-b", "task/x", worktree);
  project(worktree);
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
