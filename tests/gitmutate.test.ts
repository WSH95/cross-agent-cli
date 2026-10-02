import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { initConfig } from "../src/config.ts";
import { gitMutate, hostConfigPaths } from "../src/gitmutate.ts";
import type { GitMutateResult } from "../src/gitmutate.ts";
import { appendStep, readJournal } from "../src/journal.ts";
import { update } from "../src/ledger.ts";
import { acquire, gitLockName, lockPath, spawnLockName } from "../src/locks.ts";
import { verifyWorktree } from "../src/worktree.ts";
import { gitShim, holderOf } from "./helpers/git.ts";
import { reserve } from "./helpers/project.ts";

const exec = promisify(execFile);
const sources = fileURLToPath(new URL("../", import.meta.url));
const locksModule = pathToFileURL(path.join(sources, "src", "locks.ts")).href;

// The harness's own git, with a clean environment of its own: a test that poisons the
// process's GIT_* variables to see what reaches the child must still be able to look at
// the repository afterwards.
async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8", env });
  return stdout.replace(/\n$/, "");
}

async function repository(t: TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), "cross-agent-gitmutate-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  // git_mutate refuses `-c`, so the identity a commit needs lives in the repository.
  await git(root, "config", "user.name", "Cross Agent Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "commit.gpgSign", "false");
  await git(root, "commit", "--allow-empty", "-m", "initial");
  initConfig(root);
  async function add(slug: string, at = path.join(".worktrees", slug)): Promise<string> {
    const worktree = path.resolve(root, at);
    await git(root, "worktree", "add", "-b", `task/${slug}`, worktree);
    return worktree;
  }
  return { temporary, root, add };
}

function accepted(result: GitMutateResult): Extract<GitMutateResult, { ok: true }> {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<GitMutateResult, { ok: true }>;
}

function refusal(result: GitMutateResult): string {
  assert.equal(result.ok, false, JSON.stringify(result));
  const { reason } = result as Extract<GitMutateResult, { ok: false }>;
  assert.equal(typeof reason, "string");
  assert.ok(reason.trim().length > 0);
  return reason;
}

async function poll<T>(read: () => T | Promise<T>, accepts: (value: T) => boolean, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for state: ${JSON.stringify(value)}`);
    await delay(10);
  }
}

/** Sets environment variables for one test and puts the process's own back afterwards. */
function poison(t: TestContext, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    const original = process.env[name];
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
    process.env[name] = value;
  }
}

// @anchor commitLandsBranch
test("a commit through git_mutate lands on the task branch and is journaled with its SHAs", async (t) => {
  const { root, add } = await repository(t);
  const worktree = await add("alpha");
  const initial = await git(root, "rev-parse", "refs/heads/task/alpha");
  await writeFile(path.join(worktree, "notes.md"), "the implementer's edit\n");

  const staged = accepted(await gitMutate(root, { slug: "alpha", args: ["add", "-A"] }, { waitSeconds: 5, now: 100 }));
  assert.equal(staged.exitCode, 0);
  assert.equal(staged.before, initial);
  assert.equal(staged.after, initial, "staging moves no branch");

  const committed = accepted(await gitMutate(root, { slug: "alpha", args: ["commit", "-m", "task work"] }, { waitSeconds: 5, now: 200 }));
  const head = await git(root, "rev-parse", "refs/heads/task/alpha");
  assert.equal(committed.exitCode, 0);
  assert.equal(committed.before, initial);
  assert.equal(committed.after, head);
  assert.notEqual(head, initial);
  assert.match(await git(root, "ls-tree", "-r", "--name-only", "task/alpha"), /notes\.md/);
  assert.equal(await git(root, "rev-parse", "refs/heads/main"), await git(root, "rev-parse", initial));
  assert.equal(await git(worktree, "status", "--porcelain"), "");

  const journal = readJournal(root, "alpha")!;
  const main = await git(root, "rev-parse", "refs/heads/main");
  assert.equal(journal.slug, "alpha");
  assert.equal(journal.branch, "task/alpha");
  assert.equal(journal.defaultBranch, "main");
  // Each step records what the default branch was when it ran. The journal's own revert
  // target belongs to the merge, which happens at the root and long after these.
  assert.equal(journal.defaultShaBeforeMerge, undefined);
  assert.equal(journal.branchHead, undefined);
  assert.deepEqual(journal.steps, [
    { step: "git", at: 100, before: initial, after: initial, defaultSha: main, args: ["add", "-A"] },
    { step: "committed", at: 200, before: initial, after: head, defaultSha: main, args: ["commit", "-m", "task work"] },
  ]);
  assert.deepEqual(committed.journal, journal.steps[1], "the result carries the step it appended");
});

test("git_mutate names the commit and the rebase, and records the work tree the verifier resolved", async (t) => {
  const { root, add } = await repository(t);
  const worktree = await realpath(await add("named"));
  await writeFile(path.join(worktree, "notes.md"), "the implementer's edit\n");

  // Each named step of section 7's table is written by the tool that performs it: for
  // `git_mutate` that is `committed` and `rebased`, by the subcommand it was given.
  accepted(await gitMutate(root, { slug: "named", args: ["add", "-A"] }, { waitSeconds: 5, now: 1 }));
  assert.equal(accepted(await gitMutate(root, { slug: "named", args: ["commit", "-m", "task work"] }, { waitSeconds: 5, now: 2 })).journal.step, "committed");
  // A rebase that replays the task's commit onto a default branch that has moved: the
  // branch moves, so this is the `rebased` step of the loop.
  await git(root, "commit", "--allow-empty", "-m", "on the default branch");
  assert.equal(accepted(await gitMutate(root, { slug: "named", args: ["rebase", "main"] }, { waitSeconds: 5, now: 3 })).journal.step, "rebased");
  assert.equal(accepted(await gitMutate(root, { slug: "named", args: ["status", "--porcelain"] }, { waitSeconds: 5, now: 4 })).journal.step, "git");

  const journal = readJournal(root, "named")!;
  assert.deepEqual(journal.steps.map((step) => step.step), ["git", "committed", "rebased", "git"]);
  // The path the verifier returned, so `git_root worktree remove` and `run_command` can
  // hold a later call to the work tree this task's steps actually ran in.
  assert.equal(journal.worktree, worktree);
  assert.deepEqual(journal.steps[1].args, ["commit", "-m", "task work"], "a named step still carries what it ran");
});

// @anchor stepNamedBranch
test("a step is named for the branch it moved, not for the subcommand it ran", async (t) => {
  const { root, add } = await repository(t);
  const worktree = await add("moving");
  await writeFile(path.join(worktree, "notes.md"), "the implementer's edit\n");
  accepted(await gitMutate(root, { slug: "moving", args: ["add", "-A"] }, { waitSeconds: 5, now: 1 }));

  // A commit that reports what it would do moves nothing, and a step called `committed`
  // would tell a reconciliation pass this task had a commit to find.
  const dry = accepted(await gitMutate(root, { slug: "moving", args: ["commit", "--dry-run", "-m", "would commit"] }, { waitSeconds: 5, now: 2 }));
  assert.equal(dry.journal.step, "git");
  assert.equal(dry.before, dry.after);
  assert.equal(accepted(await gitMutate(root, { slug: "moving", args: ["commit", "-m", "the real one"] }, { waitSeconds: 5, now: 3 })).journal.step, "committed");

  // A rebase onto a default branch that has not moved replays nothing, so it is no more
  // the loop's `rebased` step than the dry run was its `committed` one.
  const still = accepted(await gitMutate(root, { slug: "moving", args: ["rebase", "main"] }, { waitSeconds: 5, now: 4 }));
  assert.equal(still.journal.step, "git");
  assert.equal(still.before, still.after);
  assert.deepEqual(readJournal(root, "moving")!.steps.map((step) => step.step), ["git", "git", "committed", "git"]);
});

// @anchor rebaseStoppedConflict
test("a rebase stopped on a conflict is aborted through git_mutate, and nothing else may run detached", async (t) => {
  const { root, add } = await repository(t);
  const worktree = await add("conflicted");
  // The same file, added on both branches with different contents: the rebase stops.
  await writeFile(path.join(worktree, "shared.txt"), "from the task branch\n");
  accepted(await gitMutate(root, { slug: "conflicted", args: ["add", "-A"] }, { waitSeconds: 5 }));
  accepted(await gitMutate(root, { slug: "conflicted", args: ["commit", "-m", "the task's line"] }, { waitSeconds: 5 }));
  await writeFile(path.join(root, "shared.txt"), "from the default branch\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "the default branch's line");

  const stopped = await gitMutate(root, { slug: "conflicted", args: ["rebase", "main"] }, { waitSeconds: 5 });
  assert.equal(stopped.ok, false, JSON.stringify(stopped));
  assert.equal(await git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "a stopped rebase leaves HEAD detached");
  const gitDir = await git(worktree, "rev-parse", "--absolute-git-dir");
  assert.equal(fs.readFileSync(path.join(gitDir, "rebase-merge", "head-name"), "utf8").trim(), "refs/heads/task/conflicted");

  // Only this one argv, and only while git's own rebase state names this journal's branch.
  for (const args of [["rebase", "--continue"], ["rebase", "--skip"], ["rebase", "--abort", "--quiet"], ["status"], ["commit", "--allow-empty", "-m", "x"]]) {
    assert.match(refusal(await gitMutate(root, { slug: "conflicted", args }, { waitSeconds: 5 })), /HEAD does not match/, args.join(" "));
  }

  const aborted = accepted(await gitMutate(root, { slug: "conflicted", args: ["rebase", "--abort"] }, { waitSeconds: 5, now: 9 }));
  assert.equal(aborted.journal.step, "git", "an abort completes no step of the loop");
  assert.equal(await git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), "task/conflicted");
  assert.equal(await git(worktree, "status", "--porcelain"), "");
  assert.equal(readJournal(root, "conflicted")!.steps.at(-1)!.at, 9);

  // A HEAD detached for any other reason is not a rebase to abort.
  await git(worktree, "checkout", "--detach");
  assert.match(refusal(await gitMutate(root, { slug: "conflicted", args: ["rebase", "--abort"] }, { waitSeconds: 5 })), /HEAD does not match/);
});

// @anchor gitMutateRefuses
test("git_mutate refuses a work tree that is not the one its journal records", async (t) => {
  const { root, add } = await repository(t);
  const worktree = await realpath(await add("moved"));
  // The journal is authoritative for its own path as it is for its own branch: a step
  // naming another work tree is refused before git runs, and nothing is journaled.
  appendStep(root, "moved", "worktree-created", {
    at: 1, branch: "task/moved", defaultBranch: "main", worktree: path.join(root, ".worktrees", "elsewhere"),
  });
  const reason = refusal(await gitMutate(root, { slug: "moved", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 }));
  assert.equal(reason, `slug moved is journaled on worktree ${path.join(root, ".worktrees", "elsewhere")}; refusing ${worktree}`);
  assert.equal(await git(root, "rev-list", "--count", "task/moved"), "1");
  assert.deepEqual(readJournal(root, "moved")!.steps.map((step) => step.step), ["worktree-created"]);
});

// @anchor gitMutateRefusesWorkspace
test("git_mutate refuses a workspace an unsettled writable task is holding", async (t) => {
  const { root, add } = await repository(t);
  const worktree = await add("held");
  const record = await reserve(root, worktree);

  const result = await gitMutate(root, { slug: "held", args: ["commit", "--allow-empty", "-m", "while it works"] }, { waitSeconds: 5 });
  const reason = refusal(result);
  assert.equal(reason, `${worktree} is reserved by task ${record.id} (running); wait or cancel first`);
  assert.equal(await git(root, "rev-list", "--count", "task/held"), "1", "nothing ran");
  assert.equal(readJournal(root, "held"), null);

  // A read-only task never held it, and a settled one has let it go.
  await reserve(root, worktree, { mode: "read-only", profile: "read-only" });
  assert.equal(refusal(await gitMutate(root, { slug: "held", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 })), reason);
  assert.equal((await update(root, record.id, { status: "done" })).applied, true);
  accepted(await gitMutate(root, { slug: "held", args: ["commit", "--allow-empty", "-m", "after it settled"] }, { waitSeconds: 5 }));
  assert.equal(await git(root, "rev-list", "--count", "task/held"), "2");
});

// @anchor recordCannotBeRead
test("git_mutate refuses every workspace while a task record cannot be read", async (t) => {
  const { root, add } = await repository(t);
  await add("unknown");
  const tasks = path.join(root, ".cross-agent", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  const broken = path.join(tasks, "damaged.json");
  fs.writeFileSync(broken, "{not json");

  // Its cwd cannot be read, so no check can clear any workspace while it exists.
  const reason = refusal(await gitMutate(root, { slug: "unknown", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 }));
  assert.match(reason, new RegExp(broken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(await git(root, "rev-list", "--count", "task/unknown"), "1");

  fs.rmSync(broken);
  accepted(await gitMutate(root, { slug: "unknown", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 }));
});

// @anchor gitMutateRefusesWorktree
test("git_mutate refuses a worktree the verifier rejects, with the verifier's own reason", async (t) => {
  const { temporary, root, add } = await repository(t);
  const worktree = await add("verified");
  const sibling = await add("sibling");
  const pointer = path.join(worktree, ".git");
  const original = await readFile(pointer, "utf8");

  const cases: Array<{ name: string; path: string; branch: string; before?: () => Promise<void> }> = [
    { name: "the main worktree", path: root, branch: "main" },
    { name: "a subdirectory of the root", path: path.join(root, "src"), branch: "main" },
    { name: "the wrong branch", path: worktree, branch: "task/other" },
    { name: "a missing path", path: path.join(temporary, "absent"), branch: "task/verified" },
    {
      name: "a pointer rewritten at a sibling", path: worktree, branch: "task/sibling",
      before: async () => writeFile(pointer, `gitdir: ${await git(sibling, "rev-parse", "--git-dir")}\n`),
    },
  ];
  await mkdir(path.join(root, "src"), { recursive: true });
  for (const value of cases) {
    await value.before?.();
    const verified = await verifyWorktree(root, value.path, value.branch);
    assert.ok("reason" in verified, `${value.name} is refused by the verifier`);
    const result = await gitMutate(root, { slug: "verified", path: value.path, branch: value.branch, args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 });
    assert.equal(refusal(result), verified.reason, value.name);
    assert.equal(readJournal(root, "verified"), null);
  }
  await writeFile(pointer, original);
  assert.equal(await git(root, "rev-list", "--count", "main"), "1", "and the default branch never moved");
});

// @anchor gitMutateRuns
test("git_mutate runs in the worktree the verifier resolved, not the one the slug names", async (t) => {
  const { root, add } = await repository(t);
  const a = await add("a");
  const b = await add("b");
  const beforeA = await git(root, "rev-parse", "refs/heads/task/a");

  // A slug that names one worktree and a path that names another: the verified git-dir of
  // b is what runs, and nothing is ever derived from the slug.
  const result = accepted(await gitMutate(root, { slug: "a", path: b, branch: "task/b", args: ["commit", "--allow-empty", "-m", "in b"] }, { waitSeconds: 5, now: 7 }));
  assert.equal(result.after, await git(root, "rev-parse", "refs/heads/task/b"));
  assert.equal(await git(root, "rev-list", "--count", "task/b"), "2");
  assert.equal(await git(root, "rev-parse", "refs/heads/task/a"), beforeA, "task/a never moved");
  assert.equal(await git(a, "status", "--porcelain"), "");

  const journal = readJournal(root, "a")!;
  assert.equal(journal.branch, "task/b", "the journal records the branch that was verified");
  assert.deepEqual(journal.steps.map((step) => step.after), [result.after]);
  assert.deepEqual(journal.steps.map((step) => step.defaultSha), [await git(root, "rev-parse", "refs/heads/main")]);

  // A journal belongs to one branch, so the next call under this slug has to be on it.
  // The refusal comes before anything runs, not after the branch has moved.
  const second = await gitMutate(root, { slug: "a", args: ["commit", "--allow-empty", "-m", "in a"] }, { waitSeconds: 5, now: 8 });
  assert.equal(refusal(second), "slug a is journaled on task/b; refusing task/a");
  assert.equal(await git(root, "rev-parse", "refs/heads/task/a"), beforeA, "and task/a still never moved");
  assert.deepEqual(readJournal(root, "a")!.steps.length, 1);
  accepted(await gitMutate(root, { slug: "a", path: b, branch: "task/b", args: ["commit", "--allow-empty", "-m", "in b again"] }, { waitSeconds: 5, now: 9 }));
});

// @anchor firstCallsSlug
test("two first calls on one slug settle on one branch, and the other is refused", async (t) => {
  const { root, add } = await repository(t);
  const a = await add("a");
  const b = await add("b");
  // Neither has a journal yet, so the branch a slug belongs to is decided by whichever
  // call takes spawn.lock first — and the other must find that decision, not race past it.
  const results = await Promise.all([
    gitMutate(root, { slug: "shared", path: a, branch: "task/a", args: ["commit", "--allow-empty", "-m", "in a"] }, { waitSeconds: 20, now: 1 }),
    gitMutate(root, { slug: "shared", path: b, branch: "task/b", args: ["commit", "--allow-empty", "-m", "in b"] }, { waitSeconds: 20, now: 2 }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));

  const journal = readJournal(root, "shared")!;
  const refused = journal.branch === "task/a" ? "task/b" : "task/a";
  assert.equal(refusal(results.find((result) => !result.ok)!), `slug shared is journaled on ${journal.branch}; refusing ${refused}`);
  assert.equal(journal.steps.length, 1);
  assert.equal(await git(root, "rev-list", "--count", journal.branch), "2");
  assert.equal(await git(root, "rev-list", "--count", refused), "1", "and the refused branch never moved");
});

// @anchor gitMutateHolds
test("git_mutate holds spawn.lock for the whole call and takes git.lock inside it", async (t) => {
  const { root, add } = await repository(t);
  await add("ordered");
  const initial = await git(root, "rev-parse", "refs/heads/task/ordered");

  // delegate holds spawn.lock around validate-and-spawn (T10), so a mutation that holds
  // it too cannot have its reservation check race a delegation taking the same workspace.
  const held = await acquire(lockPath(root, spawnLockName()), { operation: "a delegate", waitSeconds: 5 });
  t.after(() => held.release());
  const blocked = gitMutate(root, { slug: "ordered", args: ["commit", "--allow-empty", "-m", "waits"] }, { waitSeconds: 20, now: 1 });
  await delay(400);
  assert.equal(await git(root, "rev-parse", "refs/heads/task/ordered"), initial, "nothing ran while spawn.lock was held");
  await held.release();
  accepted(await blocked);

  // And the order is always spawn.lock then git.lock: a mutation waiting for git.lock is
  // already holding spawn.lock, which is why no delegate can slip in behind it.
  const competitor = await acquire(lockPath(root, gitLockName()), { operation: "a competing mutation", waitSeconds: 5 });
  t.after(() => competitor.release());
  const waiting = gitMutate(root, { slug: "ordered", args: ["commit", "--allow-empty", "-m", "second"] }, { waitSeconds: 20, now: 2 });
  await delay(400);
  await assert.rejects(
    acquire(lockPath(root, spawnLockName()), { operation: "a delegate", waitSeconds: 0 }),
    /held by another process/,
  );
  await competitor.release();
  accepted(await waiting);
  assert.equal(await git(root, "rev-list", "--count", "task/ordered"), "3");
});

// @anchor gitMutatePasses
test("git_mutate passes the verified directories explicitly and hands the child no GIT_DIR", async (t) => {
  const { temporary, root, add } = await repository(t);
  const b = await add("b");
  const recorder = await gitShim(t);

  // What a server started from a hook, or from `git rebase --exec`, inherits. None of it
  // may reach the child: the directories a mutation runs against are the verifier's answer
  // alone, and GIT_CONFIG_* would put back exactly the `-c` settings git_mutate refuses.
  const hooks = path.join(temporary, "hooks");
  const marker = path.join(temporary, "the-hook-ran");
  const index = path.join(temporary, "elsewhere.index");
  await mkdir(hooks, { recursive: true });
  await writeFile(path.join(hooks, "pre-commit"), `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
  await chmod(path.join(hooks, "pre-commit"), 0o755);
  poison(t, {
    GIT_DIR: await realpath(path.join(root, ".git", "worktrees", "b")),
    GIT_WORK_TREE: temporary,
    GIT_INDEX_FILE: index,
    GIT_OBJECT_DIRECTORY: path.join(temporary, "elsewhere-objects"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooks,
    CROSS_AGENT_TASK: "the server's own task",
  });

  await writeFile(path.join(b, "notes.md"), "the implementer's edit\n");
  accepted(await gitMutate(root, { slug: "a", path: b, branch: "task/b", args: ["add", "-A"] }, { waitSeconds: 5 }));
  const result = accepted(await gitMutate(root, { slug: "a", path: b, branch: "task/b", args: ["commit", "-m", "explicit"] }, { waitSeconds: 5 }));
  assert.equal(result.exitCode, 0);

  const argv = await recorder.argv();
  const gitDir = await realpath(path.join(root, ".git", "worktrees", "b"));
  assert.deepEqual(argv.slice(0, 2), [`--git-dir=${gitDir}`, `--work-tree=${await realpath(b)}`]);
  assert.ok(argv.every((argument) => !argument.includes(path.join("worktrees", "a"))), argv.join(" "));
  const lines = await recorder.lines();
  for (const variable of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "CROSS_AGENT_TASK"]) {
    assert.equal(lines.some((line) => line.startsWith(`env ${variable}=`)), false, `${variable} reached the child`);
  }
  assert.equal(lines.some((line) => line.startsWith("env PATH=")), true, "git is still found on the server's PATH");

  // And the proof that it never reached git: the index was the worktree's own, and the
  // hook that config would have installed never ran.
  assert.equal(fs.existsSync(index), false, "the inherited index file was never written");
  assert.equal(fs.existsSync(marker), false, "the inherited core.hooksPath never ran");
  assert.match(await git(root, "ls-tree", "-r", "--name-only", "task/b"), /notes\.md/);
});

// @anchor gitMutateRefusesArguments
test("git_mutate refuses arguments that are not one subcommand in this worktree", async (t) => {
  const { root, add } = await repository(t);
  const worktree = await add("guarded");
  const refused: string[][] = [
    [],
    ["--version"],
    ["-C", "/tmp", "status"],
    ["-c", "user.name=someone", "commit", "--allow-empty", "-m", "x"],
    ["--git-dir=/tmp/elsewhere/.git", "status"],
    ["--work-tree=/tmp", "status"],
    ["commit", "-C", "/tmp"],
    ["commit", "-c", "user.name=someone"],
    ["commit", "--git-dir", "/tmp/elsewhere/.git"],
    ["commit", "--work-tree", "/tmp"],
    ["commit", "--git-dir=/tmp/elsewhere/.git"],
  ];
  for (const args of refused) {
    refusal(await gitMutate(root, { slug: "guarded", args }, { waitSeconds: 5 }));
  }
  assert.equal(await git(root, "rev-list", "--count", "task/guarded"), "1");
  assert.equal(readJournal(root, "guarded"), null);
  assert.equal(await git(worktree, "status", "--porcelain"), "");

  // The shape of the request is judged before anything is locked or looked up.
  const lock = await acquire(lockPath(root, gitLockName()), { operation: "hold the git lock", waitSeconds: 5 });
  t.after(() => lock.release());
  try {
    refusal(await gitMutate(root, { slug: "guarded", args: ["-C", "/tmp", "status"] }, { waitSeconds: 0 }));
  } finally {
    await lock.release();
  }
});

// @anchor gitMutateRefusesRuns
test("git_mutate refuses before it runs anything if the step could not be recorded", async (t) => {
  const { root, add } = await repository(t);
  await add("recordable");
  // The slug names the journal file, so a slug that is not a file name of its own would be
  // found only once the command had already run.
  for (const slug of ["../escape", "a/b", "", "."]) {
    refusal(await gitMutate(root, { slug, path: path.join(root, ".worktrees", "recordable"), branch: "task/recordable", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 }));
  }
  assert.equal(await git(root, "rev-list", "--count", "task/recordable"), "1");

  accepted(await gitMutate(root, { slug: "recordable", args: ["commit", "--allow-empty", "-m", "one"] }, { waitSeconds: 5 }));
  const journal = path.join(root, ".cross-agent", "journal", "recordable.json");
  fs.writeFileSync(journal, "{not json");
  const reason = refusal(await gitMutate(root, { slug: "recordable", args: ["commit", "--allow-empty", "-m", "two"] }, { waitSeconds: 5 }));
  assert.match(reason, new RegExp(journal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(await git(root, "rev-list", "--count", "task/recordable"), "2", "the damaged journal stopped the commit");
});

// @anchor failingGitCommand
test("a git command that fails returns its exit code and output, and journals nothing", async (t) => {
  const { root, add } = await repository(t);
  await add("failing");
  const result = await gitMutate(root, { slug: "failing", args: ["commit", "-m", "nothing to commit"] }, { waitSeconds: 5 });
  assert.equal(result.ok, false);
  const failed = result as Extract<GitMutateResult, { ok: false }>;
  assert.equal(failed.exitCode, 1);
  assert.match(`${failed.stdout}${failed.stderr}`, /nothing to commit/);
  assert.equal(readJournal(root, "failing"), null);
  assert.equal(await git(root, "rev-list", "--count", "task/failing"), "1");
});

// @anchor lockLostWhile
test("a lock lost while the command ran is reported, and the step is still journaled", async (t) => {
  const { temporary, root, add } = await repository(t);
  await add("lost");
  const recorder = await gitShim(t, { sleepOn: "slow-marker" });
  const initial = await git(root, "rev-parse", "refs/heads/task/lost");

  const pending = gitMutate(root, { slug: "lost", args: ["commit", "--allow-empty", "-m", "slow-marker"] }, { waitSeconds: 5, now: 42 });
  const holder = await poll(() => holderOf(lockPath(root, gitLockName())), (pid) => pid !== null);
  await poll(async () => (await recorder.argv()).some((argument) => argument.includes("slow-marker")), Boolean);
  // The kernel hands the lock to the next waiter the moment its holder dies, so a caller
  // that carried on silently would be acting on exclusivity it no longer has.
  process.kill(holder!, "SIGKILL");

  const result = accepted(await pending);
  assert.equal(result.lockLost, true);
  assert.notEqual(result.after, initial, "the command had already run, so its step is journaled");
  assert.equal(result.after, await git(root, "rev-parse", "refs/heads/task/lost"));
  assert.deepEqual(readJournal(root, "lost")!.steps.map((step) => step.at), [42]);

  // spawn.lock is the one that keeps a delegate out of this workspace, so losing it is
  // just as much a loss of exclusivity as losing git.lock.
  const second = gitMutate(root, { slug: "lost", args: ["commit", "--allow-empty", "-m", "slow-marker again"] }, { waitSeconds: 5, now: 43 });
  const claim = await poll(() => holderOf(lockPath(root, spawnLockName())), (pid) => pid !== null);
  await poll(async () => (await recorder.argv()).filter((argument) => argument.includes("slow-marker")).length > 1, Boolean);
  process.kill(claim!, "SIGKILL");
  assert.equal(accepted(await second).lockLost, true);
  assert.deepEqual(readJournal(root, "lost")!.steps.map((step) => step.at), [42, 43]);
});

test("the loop's commit step stages the work and never the project's own state", async (t) => {
  const { root, add } = await repository(t);
  const worktree = await add("guarded");
  // What a specialist can do to its own worktree: re-include the two directories the
  // repository's `info/exclude` keeps out, and fill them.
  await writeFile(path.join(worktree, ".gitignore"), "!.cross-agent/\n!.worktrees/\n");
  await mkdir(path.join(worktree, ".cross-agent"), { recursive: true });
  await writeFile(path.join(worktree, ".cross-agent", "config.json"), '{"engines":{"codex":{"bin":"/tmp/not-codex"}}}');
  await mkdir(path.join(worktree, ".worktrees", "nested"), { recursive: true });
  await writeFile(path.join(worktree, ".worktrees", "nested", "tree.txt"), "another task's tree\n");
  await writeFile(path.join(worktree, "work.txt"), "the change the brief asked for\n");

  // The step the loop runs (`modes/solo/SKILL.md`): pathspecs, which `git_mutate` accepts
  // because none of them is a global option.
  accepted(await gitMutate(root, {
    slug: "guarded", args: ["add", "-A", "--", ".", ":(exclude).cross-agent", ":(exclude).worktrees"],
  }, { waitSeconds: 5 }));
  const staged = (await git(worktree, "diff", "--cached", "--name-only")).split("\n").filter(Boolean);
  assert.deepEqual(staged.sort(), [".gitignore", "work.txt"]);
});

// @anchor commitRefusesHostConfig
test("a commit carrying a host's project configuration is refused naming each path, and goes through once the worktree holds none", async (t) => {
  const { root, add } = await repository(t);
  // The root first: the README's recipe ignores `.grok/` beside `init`'s own lines, and the
  // project tracks a `.mcp.json` of its own.
  await writeFile(path.join(root, ".gitignore"), `${await readFile(path.join(root, ".gitignore"), "utf8")}.grok/\n`);
  await writeFile(path.join(root, ".mcp.json"), '{"mcpServers": {}}\n');
  await git(root, "add", ".gitignore", ".mcp.json");
  await git(root, "commit", "-m", "the project's ignore rules and its own servers");
  const worktree = await add("hosted");
  const head = await git(worktree, "rev-parse", "HEAD");

  // What a writable specialist can do in its own worktree: un-ignore `.grok/` and fill it,
  // add Claude Code's settings and change the project's servers, beside the work it was given.
  const ignored = await readFile(path.join(worktree, ".gitignore"), "utf8");
  await writeFile(path.join(worktree, ".gitignore"), ignored.split("\n").filter((line) => line !== ".grok/").join("\n"));
  await mkdir(path.join(worktree, ".grok"));
  await writeFile(path.join(worktree, ".grok", "config.toml"), '[plugins]\npaths = ["/tmp/not-the-checkout"]\nenabled = ["cross-agent"]\n');
  await mkdir(path.join(worktree, ".claude"));
  await writeFile(path.join(worktree, ".claude", "settings.json"), '{"hooks": {}}');
  await writeFile(path.join(worktree, ".mcp.json"), '{"mcpServers": {"elsewhere": {"command": "/tmp/not-a-server"}}}\n');
  await writeFile(path.join(worktree, "work.txt"), "the change the brief asked for\n");

  // The loop's step 6, as it is spelled: the `add` is accepted and stages all five.
  const step6 = ["add", "-A", "--", ".", ":(exclude).cross-agent", ":(exclude).worktrees"];
  accepted(await gitMutate(root, { slug: "hosted", args: step6 }, { waitSeconds: 5 }));
  const staged = (await git(worktree, "diff", "--cached", "--name-only")).split("\n").filter(Boolean);
  assert.deepEqual(staged.sort(), [".claude/settings.json", ".gitignore", ".grok/config.toml", ".mcp.json", "work.txt"]);
  const reason = refusal(await gitMutate(root, { slug: "hosted", args: ["commit", "-m", "work"] }, { waitSeconds: 5 }));
  assert.match(reason, /^git_mutate refuses to commit/);
  for (const carried of [".grok/config.toml", ".claude/settings.json", ".mcp.json"]) assert.ok(reason.includes(carried), `${carried}: ${reason}`);
  assert.equal(await git(worktree, "rev-parse", "HEAD"), head, "nothing was committed");
  assert.equal(readJournal(root, "hosted")!.steps.some((step) => step.step === "committed"), false);

  // Out of the worktree, or back as the branch has it, and the same two steps go through.
  await rm(path.join(worktree, ".grok"), { recursive: true, force: true });
  await rm(path.join(worktree, ".claude"), { recursive: true, force: true });
  await git(worktree, "checkout", "HEAD", "--", ".mcp.json");
  accepted(await gitMutate(root, { slug: "hosted", args: step6 }, { waitSeconds: 5 }));
  const committed = accepted(await gitMutate(root, { slug: "hosted", args: ["commit", "-m", "work"] }, { waitSeconds: 5 }));
  assert.equal(committed.journal.step, "committed");
  assert.deepEqual((await git(worktree, "ls-files")).split("\n").filter(Boolean).sort(), [".gitignore", ".mcp.json", "work.txt"]);

  // The rule reads the worktree, not the index: a host file nothing ignores blocks even a
  // commit that records none of it, and an ignored one is not carried.
  await mkdir(path.join(worktree, ".grok"));
  await writeFile(path.join(worktree, ".grok", "config.toml"), "[plugins]\n");
  const unstaged = refusal(await gitMutate(root, { slug: "hosted", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 }));
  assert.ok(unstaged.includes(".grok/config.toml"), unstaged);
  await writeFile(path.join(worktree, ".gitignore"), `${await readFile(path.join(worktree, ".gitignore"), "utf8")}.grok/\n`);
  accepted(await gitMutate(root, { slug: "hosted", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 }));

  // Taking a tracked one away is carried as well: a server or a hook removed changes the
  // operator's session as much as one added.
  await rm(path.join(worktree, ".mcp.json"));
  const removed = refusal(await gitMutate(root, { slug: "hosted", args: ["commit", "-a", "-m", "x"] }, { waitSeconds: 5 }));
  assert.ok(removed.includes(".mcp.json"), removed);
  assert.equal(await git(worktree, "ls-files", "--", ".mcp.json"), ".mcp.json", "the branch still tracks it");

  assert.deepEqual(hostConfigPaths, [".claude", ".codex", ".grok", ".mcp.json"]);
});

// @anchor hostConfigAnyCase
test("a host's project configuration in another case is refused at the commit, and its lookalikes are not", async (t) => {
  const { root, add } = await repository(t);
  const worktree = await add("cased");
  // Names no host reads as its project's configuration: a commit carrying them goes through.
  await mkdir(path.join(worktree, ".claude-plugin"));
  await writeFile(path.join(worktree, ".claude-plugin", "plugin.json"), "{}\n");
  await writeFile(path.join(worktree, ".claude.json"), "{}\n");
  await writeFile(path.join(worktree, ".mcp.json.bak"), "{}\n");
  await mkdir(path.join(worktree, "docs"));
  await writeFile(path.join(worktree, "docs", ".mcp.json"), "{}\n");
  accepted(await gitMutate(root, { slug: "cased", args: ["add", "-A"] }, { waitSeconds: 5 }));
  accepted(await gitMutate(root, { slug: "cased", args: ["commit", "-m", "lookalikes"] }, { waitSeconds: 5 }));

  // On a filesystem that ignores case, a host reads `.Claude/` as `.claude/`.
  await mkdir(path.join(worktree, ".Claude"));
  await writeFile(path.join(worktree, ".Claude", "settings.json"), '{"hooks": {}}');
  await writeFile(path.join(worktree, ".MCP.json"), "{}\n");
  const reason = refusal(await gitMutate(root, { slug: "cased", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 }));
  for (const carried of [".Claude/settings.json", ".MCP.json"]) assert.ok(reason.includes(carried), `${carried}: ${reason}`);
});

// @anchor commitRefusesAssumeUnchanged
test("a tracked host file marked assume-unchanged is refused at the commit, though git status shows nothing", async (t) => {
  const { root, add } = await repository(t);
  await writeFile(path.join(root, ".mcp.json"), '{"mcpServers": {}}\n');
  await git(root, "add", ".mcp.json");
  await git(root, "commit", "-m", "the project's own servers");
  const worktree = await add("marked");
  const head = await git(worktree, "rev-parse", "HEAD");
  // The mark hides the change from `git status`, and a commit naming the path records it anyway.
  await git(worktree, "update-index", "--assume-unchanged", ".mcp.json");
  await writeFile(path.join(worktree, ".mcp.json"), '{"mcpServers": {"elsewhere": {"command": "/tmp/not-a-server"}}}\n');
  assert.equal(await git(worktree, "status", "--porcelain", "--untracked-files=all"), "");
  const reason = refusal(await gitMutate(root, { slug: "marked", args: ["commit", "-m", "x", "--", ".mcp.json"] }, { waitSeconds: 5 }));
  assert.match(reason, /^git_mutate refuses to commit/);
  assert.match(reason, /\.mcp\.json \(marked assume-unchanged/);
  assert.equal(await git(worktree, "rev-parse", "HEAD"), head, "nothing was committed");
});

// @anchor commitUnderIgnoreStat
test("under core.ignoreStat a host file git marked assume-unchanged blocks a commit only when its bytes differ from the index", async (t) => {
  const { root, add } = await repository(t);
  await writeFile(path.join(root, ".mcp.json"), '{"mcpServers": {}}\n');
  await git(root, "add", ".mcp.json");
  await git(root, "commit", "-m", "the project's own servers");
  // Under this setting git marks every tracked file it checks out assume-unchanged.
  await git(root, "config", "core.ignoreStat", "true");
  const worktree = await add("ignorestat");
  assert.equal(await git(worktree, "ls-files", "-v", "--", ".mcp.json"), "h .mcp.json");

  // The loop's step 6 with the host file untouched: the mark alone carries nothing.
  await writeFile(path.join(worktree, "work.txt"), "the change the brief asked for\n");
  accepted(await gitMutate(root, { slug: "ignorestat", args: ["add", "-A", "--", ".", ":(exclude).cross-agent", ":(exclude).worktrees"] }, { waitSeconds: 5 }));
  assert.equal(accepted(await gitMutate(root, { slug: "ignorestat", args: ["commit", "-m", "work"] }, { waitSeconds: 5 })).journal.step, "committed");

  // The same file changed, which `git status` does not show under this setting: refused, named.
  await writeFile(path.join(worktree, ".mcp.json"), '{"mcpServers": {"elsewhere": {"command": "/tmp/not-a-server"}}}\n');
  assert.equal(await git(worktree, "status", "--porcelain", "--untracked-files=all", "--", ".mcp.json"), "");
  const head = await git(worktree, "rev-parse", "HEAD");
  const reason = refusal(await gitMutate(root, { slug: "ignorestat", args: ["commit", "-m", "x", "--", ".mcp.json"] }, { waitSeconds: 5 }));
  assert.match(reason, /\.mcp\.json \(marked assume-unchanged/);
  assert.equal(await git(worktree, "rev-parse", "HEAD"), head, "nothing was committed");
});

// @anchor commitMarkedSymlink
test("an unchanged marked host-configuration symlink is refused because the whole link class is forbidden", async (t) => {
  const { root, add } = await repository(t);
  // A marked link used to be allowed when its target was unchanged. The escalation
  // forbids every host link; the existing index-byte and type checks still apply too.
  await writeFile(path.join(root, "servers.json"), '{"mcpServers": {}}\n');
  await symlink("servers.json", path.join(root, ".mcp.json"));
  await git(root, "add", "servers.json", ".mcp.json");
  await git(root, "commit", "-m", "the project's own servers, through a link");
  await git(root, "config", "core.ignoreStat", "true");
  const worktree = await add("linked");
  assert.equal(await git(worktree, "ls-files", "-v", "-s", "--", ".mcp.json"), `h 120000 ${await git(worktree, "rev-parse", "HEAD:.mcp.json")} 0\t.mcp.json`);

  // The escalation closes the link class by rule: even unchanged links block unrelated work.
  await writeFile(path.join(worktree, "work.txt"), "the change the brief asked for\n");
  accepted(await gitMutate(root, { slug: "linked", args: ["add", "-A", "--", ".", ":(exclude).cross-agent", ":(exclude).worktrees"] }, { waitSeconds: 5 }));
  const unchanged = refusal(await gitMutate(root, { slug: "linked", args: ["commit", "-m", "work"] }, { waitSeconds: 5 }));
  assert.match(unchanged, /\.mcp\.json.*symbolic link/);
  assert.match(unchanged, /replace.*regular files/i);

  // Pointed somewhere else, which `git status` does not show under the mark: refused, named.
  await rm(path.join(worktree, ".mcp.json"));
  await symlink("/tmp/not-the-project-servers.json", path.join(worktree, ".mcp.json"));
  assert.equal(await git(worktree, "status", "--porcelain", "--untracked-files=all", "--", ".mcp.json"), "");
  const head = await git(worktree, "rev-parse", "HEAD");
  const reason = refusal(await gitMutate(root, { slug: "linked", args: ["commit", "-m", "x", "--", ".mcp.json"] }, { waitSeconds: 5 }));
  assert.match(reason, /\.mcp\.json \(marked assume-unchanged/);
  assert.equal(await git(worktree, "rev-parse", "HEAD"), head, "nothing was committed");

  // A link replaced by a regular file holding the same bytes is a change of type: refused too.
  await rm(path.join(worktree, ".mcp.json"));
  await writeFile(path.join(worktree, ".mcp.json"), "servers.json");
  const typed = refusal(await gitMutate(root, { slug: "linked", args: ["commit", "-m", "x", "--", ".mcp.json"] }, { waitSeconds: 5 }));
  assert.match(typed, /\.mcp\.json \(marked assume-unchanged/);
});

// @anchor linkReplacedMidCheck
test("a marked host link replaced while the commit check reads it differs, rather than throwing", async (t) => {
  const { root, add } = await repository(t);
  await writeFile(path.join(root, "servers.json"), '{"mcpServers": {}}\n');
  await symlink("servers.json", path.join(root, ".mcp.json"));
  await git(root, "add", "servers.json", ".mcp.json");
  await git(root, "commit", "-m", "the project's own servers, through a link");
  await git(root, "config", "core.ignoreStat", "true");
  const worktree = await add("swapped");
  // The check reads the link's kind, then the repository's hash format, then the link: git is
  // held on the second for two seconds, and the link becomes a regular file in between.
  const recorder = await gitShim(t, { sleepOn: "--show-object-format" });
  const pending = gitMutate(root, { slug: "swapped", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 });
  await poll(async () => (await recorder.argv()).includes("--show-object-format"), Boolean);
  await rm(path.join(worktree, ".mcp.json"));
  await writeFile(path.join(worktree, ".mcp.json"), '{"mcpServers": {"elsewhere": {"command": "/tmp/not-a-server"}}}\n');
  assert.match(refusal(await pending), /\.mcp\.json \(marked assume-unchanged/);
});

// @anchor commitGuardsLinkReferent
test("host-configuration links are refused at commit even with unchanged in-repository referents, closing the link class", async (t) => {
  const { root, add } = await repository(t);
  // The project keeps its servers and its Claude settings in files of its own, and the paths
  // the hosts read link to them: one beside the link, one in a directory reached through `..`.
  await writeFile(path.join(root, "servers.json"), '{"mcpServers": {}}\n');
  await symlink("servers.json", path.join(root, ".mcp.json"));
  await mkdir(path.join(root, "config"));
  await writeFile(path.join(root, "config", "claude.json"), '{"permissions": {}}\n');
  await mkdir(path.join(root, ".claude"));
  await symlink("../config/claude.json", path.join(root, ".claude", "settings.json"));
  await git(root, "add", "servers.json", ".mcp.json", "config/claude.json", ".claude/settings.json");
  await git(root, "commit", "-m", "the project's servers and settings, through links");
  const worktree = await add("referent");
  const step6 = ["add", "-A", "--", ".", ":(exclude).cross-agent", ":(exclude).worktrees"];

  // Unchanged referents used to allow the work; the regular-files rule refuses the links.
  await writeFile(path.join(worktree, "work.txt"), "the change the brief asked for\n");
  accepted(await gitMutate(root, { slug: "referent", args: step6 }, { waitSeconds: 5 }));
  const unchanged = refusal(await gitMutate(root, { slug: "referent", args: ["commit", "-m", "work"] }, { waitSeconds: 5 }));
  for (const link of [".mcp.json", ".claude/settings.json"]) assert.ok(unchanged.includes(`${link} (symbolic link)`), unchanged);

  // Changed referents do not change the rule: the host links themselves are named.
  const head = await git(worktree, "rev-parse", "HEAD");
  await writeFile(path.join(worktree, "servers.json"), '{"mcpServers": {"elsewhere": {"command": "/tmp/not-a-server"}}}\n');
  await writeFile(path.join(worktree, "config", "claude.json"), '{"permissions": {"allow": ["Edit"]}}\n');
  const reason = refusal(await gitMutate(root, { slug: "referent", args: ["commit", "-a", "-m", "x"] }, { waitSeconds: 5 }));
  assert.match(reason, /^git_mutate refuses to commit/);
  for (const link of [".mcp.json", ".claude/settings.json"]) assert.ok(reason.includes(`${link} (symbolic link)`), reason);
  assert.equal(await git(worktree, "rev-parse", "HEAD"), head, "nothing was committed");

  // Restoring the referents still leaves links, so it cannot clear the refusal.
  await git(worktree, "checkout", "HEAD", "--", "servers.json", "config/claude.json");
  assert.match(refusal(await gitMutate(root, { slug: "referent", args: ["commit", "--allow-empty", "-m", "y"] }, { waitSeconds: 5 })), /replace.*regular files/i);
});

// @anchor commitRefusesOutsideLink
test("a host-configuration link whose target leaves the repository is refused at the commit outright", async (t) => {
  for (const [slug, target] of [["absolute", "/tmp/not-the-project-servers.json"], ["climbing", "../outside/servers.json"], ["metadata", ".git/servers.json"]] as const) {
    const { root, add } = await repository(t);
    await symlink(target, path.join(root, ".mcp.json"));
    await git(root, "add", ".mcp.json");
    await git(root, "commit", "-m", "the project's servers, outside it");
    const worktree = await add(slug);
    await writeFile(path.join(worktree, "work.txt"), "the change the brief asked for\n");
    accepted(await gitMutate(root, { slug, args: ["add", "--", "work.txt"] }, { waitSeconds: 5 }));
    // No host link is followed, even to diagnose an outside target: the link is the refusal.
    const reason = refusal(await gitMutate(root, { slug, args: ["commit", "-m", "work"] }, { waitSeconds: 5 }));
    assert.ok(reason.includes(".mcp.json (symbolic link)"), `${slug}: ${reason}`);
    assert.match(reason, /replace.*regular files/i);
  }
});

// @anchor commitHostLinksEveryView
test("host links in the commit tree, index or ignored working tree are refused in any case", async (t) => {
  for (const [view, file] of [
    ["tree", ".Claude/settings.json"], ["index", ".CODEX/config.toml"],
    ["disk", ".GrOk"], ["disk", ".MCP.JSON"], ["disk", ".claude/deep/config file.json"],
  ]) await t.test(`${view}: ${file}`, async (t) => {
    const { root, add } = await repository(t);
    if (view === "tree") {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await symlink("missing", path.join(root, file));
      await git(root, "add", "-f", "--", file);
      await git(root, "commit", "-m", "operator's host link");
    }
    const worktree = await add("views");
    const head = await git(worktree, "rev-parse", "HEAD");
    if (view === "tree") await git(worktree, "rm", "--", file);
    else {
      await mkdir(path.dirname(path.join(worktree, file)), { recursive: true });
      await symlink(".", path.join(worktree, file));
      if (view === "index") {
        await git(worktree, "add", "-f", "--", file);
        await rm(path.join(worktree, file));
      } else {
        await writeFile(path.join(worktree, ".gitignore"), `${file.split("/")[0]}\n`);
        assert.equal(await git(worktree, "status", "--porcelain", "--", file), "", "the link is ignored");
      }
    }
    const reason = refusal(await gitMutate(root, { slug: "views", args: ["commit", "--allow-empty", "-m", "work"] }, { waitSeconds: 5 }));
    assert.ok(reason.includes(`${file} (symbolic link)`), reason);
    assert.match(reason, /replace.*regular files/i);
    assert.equal(await git(worktree, "rev-parse", "HEAD"), head);
  });
});

// @anchor commitHostLinkTraversalClass
test("commit refuses host links before a cancelled path component or an aliased directory can hide a referent", async (t) => {
  for (const kind of ["cancelled-component", "aliased-directory"]) await t.test(kind, async (t) => {
    const { root, add } = await repository(t);
    await mkdir(path.join(root, "config"));
    await writeFile(path.join(root, "servers.json"), "{}\n");
    await writeFile(path.join(root, "shared-settings.json"), "{}\n");
    const link = kind === "cancelled-component" ? ".mcp.json" : ".claude";
    await symlink(kind === "cancelled-component" ? "via/../servers.json" : "config", path.join(root, link));
    await symlink("../shared-settings.json", path.join(root, "config", "settings.json"));
    await git(root, "add", "--", link, "servers.json", "shared-settings.json", "config");
    await git(root, "commit", "-m", "operator's host links");
    const worktree = await add("traversal");
    if (kind === "cancelled-component") await symlink("/outside/dir", path.join(worktree, "via"));
    else await writeFile(path.join(worktree, "shared-settings.json"), '{"hooks": {}}\n');
    await git(worktree, "add", "-A");
    const head = await git(worktree, "rev-parse", "HEAD");
    const reason = refusal(await gitMutate(root, { slug: "traversal", args: ["commit", "-m", "work"] }, { waitSeconds: 5 }));
    assert.ok(reason.includes(`${link} (symbolic link)`), reason);
    assert.equal(await git(worktree, "rev-parse", "HEAD"), head);
  });
});

// @anchor configLockGit
test("a config, a lock, or a git that could not run is refused rather than thrown", async (t) => {
  const { temporary, root, add } = await repository(t);
  await add("refused");

  const competitor = await acquire(lockPath(root, gitLockName()), { operation: "a competing mutation", waitSeconds: 5 });
  t.after(() => competitor.release());
  const busy = await gitMutate(root, { slug: "refused", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 0 });
  assert.match(refusal(busy), /git\.lock is held by another process/);
  await competitor.release();

  const delegate = await acquire(lockPath(root, spawnLockName()), { operation: "a delegate", waitSeconds: 5 });
  t.after(() => delegate.release());
  const claimed = await gitMutate(root, { slug: "refused", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 0 });
  assert.match(refusal(claimed), /spawn\.lock is held by another process/);
  await delegate.release();

  // A git that exits by signal reports no exit code at all; the lead is told, not thrown at.
  const recorder = await gitShim(t, { signalOn: "signal-marker" });
  const signalled = await gitMutate(root, { slug: "refused", args: ["commit", "--allow-empty", "-m", "signal-marker"] }, { waitSeconds: 5 });
  assert.match(refusal(signalled), /could not run/);
  assert.ok((await recorder.argv()).some((argument) => argument.includes("signal-marker")));

  // A config that cannot be read leaves no default branch for the journal to record, and
  // is the loader's refusal rather than its throw. A project with no config file at all is
  // not this case: it runs on the documented defaults (`src/config.ts#defaultConfig`).
  fs.writeFileSync(path.join(root, ".cross-agent", "config.json"), "{broken");
  const unreadable = await gitMutate(root, { slug: "refused", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 });
  assert.match(refusal(unreadable), /config/);

  assert.equal(await git(root, "rev-list", "--count", "task/refused"), "1", "and not one of them ran");
  assert.equal(readJournal(root, "refused"), null);
});

// @anchor taskDirectoryCannot
test("a task directory that cannot be read at all is a refusal, not an exception", async (t) => {
  if (process.getuid!() === 0) {
    t.skip("root reads a directory whatever its mode says, so the fault cannot be staged");
    return;
  }
  const { root, add } = await repository(t);
  await add("faulted");
  // The reservation read reports a fault in one record file; the directory holding them
  // can fault too — a mode nothing may read, a file where the directory belongs — and
  // `mutate` answers the lead with every refusal it has, never with an exception.
  const tasks = path.join(root, ".cross-agent", "tasks");
  await mkdir(tasks, { recursive: true });
  await chmod(tasks, 0o000);
  // Restored however the test ends, and only while it is still there: the repository's own
  // cleanup runs first and an empty directory is removable whatever its mode says.
  t.after(async () => { try { await chmod(tasks, 0o755); } catch { /* gone with the repository */ } });

  const refused = await gitMutate(root, { slug: "faulted", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 });
  const reason = refusal(refused);
  assert.match(reason, /task record/, "the refusal says what could not be read");
  assert.match(reason, new RegExp(tasks.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "and names the directory");
  assert.equal(await git(root, "rev-list", "--count", "task/faulted"), "1", "and nothing ran");
  assert.equal(readJournal(root, "faulted"), null);
});

// @anchor mutationWaitsGit
test("a mutation waits for git.lock, and two of them take it one after the other", async (t) => {
  const { root, add } = await repository(t);
  await add("serial");
  const initial = await git(root, "rev-parse", "refs/heads/task/serial");

  const lock = await acquire(lockPath(root, gitLockName()), { operation: "a competing mutation", waitSeconds: 5 });
  // A held lock keeps a live child on a pipe, so a failed assertion must not leave one.
  t.after(() => lock.release());
  const pending = gitMutate(root, { slug: "serial", args: ["commit", "--allow-empty", "-m", "waits"] }, { waitSeconds: 20, now: 1 });
  await delay(400);
  assert.equal(await git(root, "rev-parse", "refs/heads/task/serial"), initial, "nothing ran while the lock was held");
  await lock.release();
  accepted(await pending);

  // Two callers: each reads its own before inside the lock, so the second sees the first's
  // commit, and neither loses its journal step to the other's read-modify-write.
  const [first, second] = await Promise.all([
    gitMutate(root, { slug: "serial", args: ["commit", "--allow-empty", "-m", "one"] }, { waitSeconds: 20, now: 2 }),
    gitMutate(root, { slug: "serial", args: ["commit", "--allow-empty", "-m", "two"] }, { waitSeconds: 20, now: 3 }),
  ]);
  accepted(first);
  accepted(second);
  assert.equal(await git(root, "rev-list", "--count", "task/serial"), "4");
  const steps = readJournal(root, "serial")!.steps;
  assert.equal(steps.length, 3);
  assert.equal(steps[1].before, steps[0].after);
  assert.equal(steps[2].before, steps[1].after, "the second call read what the first had already committed");
  assert.equal(steps[2].after, await git(root, "rev-parse", "refs/heads/task/serial"));
});

// @anchor gitLockHeld
test("git.lock held by a killed process is taken by the next mutation with no reclaim", async (t) => {
  const { temporary, root, add } = await repository(t);
  await add("killed");
  const marker = path.join(temporary, "held");
  const holder = path.join(temporary, "holder.mjs");
  await writeFile(holder, `
import fs from "node:fs";
import { acquire } from ${JSON.stringify(locksModule)};
await acquire(${JSON.stringify(lockPath(root, gitLockName()))}, { operation: "holder", waitSeconds: 5 });
fs.writeFileSync(${JSON.stringify(marker)}, "held");
setInterval(() => {}, 1 << 30);
`);
  const child = spawn(process.execPath, [holder], { stdio: "ignore" });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker)) {
      assert.ok(Date.now() < deadline, "the holder never took the lock");
      await delay(10);
    }
    await assert.rejects(acquire(lockPath(root, gitLockName()), { operation: "waiter", waitSeconds: 0 }), /held by another process/);
    child.kill("SIGKILL");
    await closed;

    const started = Date.now();
    accepted(await gitMutate(root, { slug: "killed", args: ["commit", "--allow-empty", "-m", "after the kill"] }, { waitSeconds: 5 }));
    const elapsed = Date.now() - started;
    // The kernel released it when its holder died: nothing waited out the five seconds and
    // nothing reclaimed anything. What is left is the four git invocations.
    assert.ok(elapsed < 3000, `the whole mutation took ${elapsed}ms`);
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
});

// @anchor gitMutateUninitializedExcluded
test("git_mutate in a repository nobody initialized leaves its lock directory excluded and nothing for git status to show", async (t) => {
  // One empty commit and nothing of this project's: `spawn.lock` is the first thing that
  // could make `.cross-agent/`, ahead of any record.
  const temporary = await mkdtemp(path.join(tmpdir(), "cross-agent-gitmutate-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  await git(root, "init", "-b", "main");
  await git(root, "-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false",
    "commit", "--allow-empty", "-m", "initial");

  refusal(await gitMutate(root, { slug: "s", args: ["status"] }, { waitSeconds: 1 }));
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=all"), "");
  const lines = fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8").split(/\r?\n/);
  assert.ok(lines.includes(".cross-agent/") && lines.includes(".worktrees/"), lines.join("\n"));
});
