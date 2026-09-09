import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { initConfig } from "../src/config.ts";
import { gitMutate } from "../src/gitmutate.ts";
import type { GitMutateResult } from "../src/gitmutate.ts";
import { readJournal } from "../src/journal.ts";
import { create, update, writeSpec } from "../src/ledger.ts";
import type { LaunchSpec } from "../src/ledger.ts";
import { acquire, gitLockName, lockPath, spawnLockName } from "../src/locks.ts";
import { verifyWorktree } from "../src/worktree.ts";

const exec = promisify(execFile);
const sources = fileURLToPath(new URL("../", import.meta.url));
const locksModule = pathToFileURL(path.join(sources, "src", "locks.ts")).href;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
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

/** A task at `status` holding `cwd`, with the launch spec that says it may write. */
async function reserve(root: string, cwd: string, sandbox = "workspace-write") {
  const record = create(root, { role: "implementer", brief: "hold the workspace", cwd, engine: "codex" });
  writeSpec(root, record.id, {
    role: "implementer", brief: "hold the workspace", rolePrompt: "prompt", cwd,
    sandbox: sandbox as LaunchSpec["sandbox"], sessionId: "session", denyTargets: [], env: {},
    engine: "codex", adapterModule: "/adapters/codex.ts",
  });
  assert.equal((await update(root, record.id, { status: "running" })).applied, true);
  return record;
}

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
  assert.equal(journal.slug, "alpha");
  assert.equal(journal.branch, "task/alpha");
  assert.equal(journal.defaultBranch, "main");
  assert.equal(journal.branchHead, head);
  assert.equal(journal.defaultShaBeforeMerge, await git(root, "rev-parse", "refs/heads/main"));
  assert.deepEqual(journal.steps, [
    { step: "git", at: 100, before: initial, after: initial, args: ["add", "-A"] },
    { step: "git", at: 200, before: initial, after: head, args: ["commit", "-m", "task work"] },
  ]);
  assert.deepEqual(committed.journal, journal.steps[1], "the result carries the step it appended");
});

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
  await reserve(root, worktree, "read-only");
  assert.equal(refusal(await gitMutate(root, { slug: "held", args: ["commit", "--allow-empty", "-m", "x"] }, { waitSeconds: 5 })), reason);
  assert.equal((await update(root, record.id, { status: "done" })).applied, true);
  accepted(await gitMutate(root, { slug: "held", args: ["commit", "--allow-empty", "-m", "after it settled"] }, { waitSeconds: 5 }));
  assert.equal(await git(root, "rev-list", "--count", "task/held"), "2");
});

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
  assert.equal(journal.branchHead, result.after);
  assert.deepEqual(journal.steps.map((step) => step.after), [result.after]);

  // A journal belongs to one branch, so the next call under this slug has to be on it.
  // The refusal comes before anything runs, not after the branch has moved.
  const second = await gitMutate(root, { slug: "a", args: ["commit", "--allow-empty", "-m", "in a"] }, { waitSeconds: 5, now: 8 });
  assert.equal(refusal(second), "slug a is journaled on task/b; refusing task/a");
  assert.equal(await git(root, "rev-parse", "refs/heads/task/a"), beforeA, "and task/a still never moved");
  assert.deepEqual(readJournal(root, "a")!.steps.length, 1);
  accepted(await gitMutate(root, { slug: "a", path: b, branch: "task/b", args: ["commit", "--allow-empty", "-m", "in b again"] }, { waitSeconds: 5, now: 9 }));
});

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

test("git_mutate passes the verified directories explicitly and hands the child no GIT_DIR", async (t) => {
  const { temporary, root, add } = await repository(t);
  const b = await add("b");
  const realGit = (await exec("sh", ["-c", "command -v git"], { encoding: "utf8" })).stdout.trim();
  const shimDirectory = path.join(temporary, "shim");
  const log = path.join(temporary, "invocations.txt");
  await mkdir(shimDirectory);
  await writeFile(path.join(shimDirectory, "git"), `#!/bin/sh
case "$1" in
  --git-dir=*)
    { for argument in "$@"; do printf 'argv %s\\n' "$argument"; done; env | sed 's/^/env /'; } >> ${JSON.stringify(log)}
    ;;
esac
exec ${JSON.stringify(realGit)} "$@"
`);
  await chmod(path.join(shimDirectory, "git"), 0o755);

  const originalPath = process.env.PATH;
  const originalGitDir = process.env.GIT_DIR;
  const originalWorkTree = process.env.GIT_WORK_TREE;
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = originalGitDir;
    if (originalWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = originalWorkTree;
  });
  process.env.PATH = `${shimDirectory}${path.delimiter}${originalPath}`;
  // What a server started from a hook inside that worktree inherits. Neither may reach
  // the child: the directories a mutation runs against are the verifier's answer alone.
  process.env.GIT_DIR = await realpath(path.join(root, ".git", "worktrees", "b"));
  process.env.GIT_WORK_TREE = temporary;

  const result = accepted(await gitMutate(root, { slug: "a", path: b, branch: "task/b", args: ["commit", "--allow-empty", "-m", "explicit"] }, { waitSeconds: 5 }));
  assert.equal(result.exitCode, 0);
  const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
  const argv = lines.filter((line) => line.startsWith("argv ")).map((line) => line.slice("argv ".length));
  const gitDir = await realpath(path.join(root, ".git", "worktrees", "b"));
  assert.deepEqual(argv.slice(0, 2), [`--git-dir=${gitDir}`, `--work-tree=${await realpath(b)}`]);
  assert.ok(argv.every((argument) => !argument.includes(path.join("worktrees", "a"))), argv.join(" "));
  for (const variable of ["GIT_DIR", "GIT_WORK_TREE"]) {
    assert.equal(lines.some((line) => line.startsWith(`env ${variable}=`)), false, `${variable} reached the child`);
  }
  assert.equal(lines.some((line) => line.startsWith("env PATH=")), true, "the rest of the environment is the server's own");
});

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

test("git_mutate waits on git.lock, and two calls serialize on it", async (t) => {
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
    assert.ok(elapsed < 1500, `the whole mutation took ${elapsed}ms`);
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
});
