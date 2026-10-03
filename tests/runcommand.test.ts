import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gitMutate } from "../src/gitmutate.ts";
import { gitRoot } from "../src/gitroot.ts";
import { readJournal } from "../src/journal.ts";
import { create, update } from "../src/ledger.ts";
import { acquire, gitLockName, lockPath } from "../src/locks.ts";
import { groupAlive } from "../src/process.ts";
import { setupMarkerPath } from "../src/review.ts";
import { runCommand } from "../src/runcommand.ts";
import type { RunCommandResult } from "../src/runcommand.ts";
import { git } from "./helpers/git.ts";
import { layoutRoot, poll, proc, project } from "./helpers/project.ts";
import type { LayoutName, LayoutRoot, TestProject } from "./helpers/project.ts";

// `run_command` takes a selector, never a command string: the project's configured
// `testCommand` or `setupCommand`, at the root or in a verified worktree (design section
// 4). Every test here runs a real shell, because what the command sees is half the
// contract.

async function repository(t: TestContext, commands: Record<string, string> = {}): Promise<TestProject> {
  const created = await project(t, { roles: {}, project: commands }, [{ key: "implementer", workspace: "worktree" }]);
  await git(created.root, "config", "user.name", "Cross Agent Test");
  await git(created.root, "config", "user.email", "test@example.invalid");
  await git(created.root, "config", "commit.gpgSign", "false");
  return created;
}

/** The configured commands, rewritten mid-test: a config may change under a server. */
function configure(root: string, commands: Record<string, string>): void {
  fs.writeFileSync(path.join(root, ".cross-agent", "config.json"), JSON.stringify({ roles: {}, project: commands }));
}

function accepted(result: RunCommandResult): Extract<RunCommandResult, { ok: true }> {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<RunCommandResult, { ok: true }>;
}

function refusal(result: RunCommandResult): string {
  assert.equal(result.ok, false, JSON.stringify(result));
  const { reason } = result as Extract<RunCommandResult, { ok: false }>;
  assert.ok(typeof reason === "string" && reason.trim().length > 0);
  return reason;
}

/** A task with a worktree and one commit on its branch, through the loop's own tools. */
async function committedTask(root: string, slug: string): Promise<string> {
  const directory = path.join(root, ".worktrees", slug);
  const created = await gitRoot(root, {
    args: ["worktree", "add", "-b", `task/${slug}`, directory, "main"], slug,
  }, { waitSeconds: 5 });
  assert.equal(created.ok, true, JSON.stringify(created));
  const committed = await gitMutate(root, { slug, args: ["commit", "--allow-empty", "-m", "work"] }, { waitSeconds: 5 });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  return fs.realpathSync(directory);
}

/** A task with a worktree and a merge behind it: what a root test run is journaled after. */
async function merged(root: string, slug: string): Promise<string> {
  const directory = await committedTask(root, slug);
  // The suite on the branch head, as the loop's gate runs it before a merge.
  const tested = await runCommand(root, { which: "test", where: directory, slug });
  assert.equal(tested.ok, true, JSON.stringify(tested));
  const done = await gitRoot(root, { args: ["merge", "--ff-only", `task/${slug}`], slug }, { waitSeconds: 5 });
  assert.equal(done.ok, true, JSON.stringify(done));
  return directory;
}

test("run_command runs the command its selector names, and refuses anything but the two selectors", async (t) => {
  const { root } = await repository(t, { testCommand: "echo the suite ran", setupCommand: "echo the setup ran" });

  const tested = accepted(await runCommand(root, { which: "test", where: "root" }));
  assert.equal(tested.exitCode, 0);
  assert.match(tested.tail, /the suite ran/);
  assert.equal(tested.journal, undefined, "a root run with no slug journals nothing");
  assert.match(accepted(await runCommand(root, { which: "setup", where: "root" })).tail, /the setup ran/);

  // A selector, never a command string: nothing the lead composes reaches a shell.
  for (const which of ["build", "", "TEST", "test; rm -rf /"]) {
    assert.match(refusal(await runCommand(root, { which: which as "test", where: "root" })), /which/, which);
  }
  for (const where of ["", "  "]) {
    refusal(await runCommand(root, { which: "test", where }));
  }
  // A failing suite is an answer the lead has to read, not a refusal: the repair path
  // starts from the exit code (design section 7).
  configure(root, { testCommand: "echo it failed >&2; exit 3" });
  const failed = accepted(await runCommand(root, { which: "test", where: "root" }));
  assert.equal(failed.exitCode, 3);
  assert.match(failed.tail, /it failed/);
});

test("a command configured as none is a no-op success", async (t) => {
  // What this project's own setupCommand is: there is nothing to run, and a lead that had
  // to tell "none" from a command that printed nothing would have to know the config.
  const { root } = await repository(t, { testCommand: "none", setupCommand: "none" });
  for (const which of ["test", "setup"] as const) {
    const result = accepted(await runCommand(root, { which, where: "root" }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.tail, "");
    assert.equal(result.journal, undefined);
  }
  // Not even after a merge: `tests-passed` would claim a suite passed that never ran.
  await merged(root, "none");
  const journaled = accepted(await runCommand(root, { which: "test", where: "root", slug: "none" }));
  assert.equal(journaled.journal, undefined);
  assert.deepEqual(readJournal(root, "none")!.steps.map((step) => step.step), ["worktree-created", "committed", "merged"]);
});

test("the returned output is the tail, capped at 64 KB", async (t) => {
  const { root } = await repository(t, {
    testCommand: `i=1; while [ $i -le 4000 ]; do echo "line $i ${"-".repeat(40)}"; i=$((i + 1)); done`,
  });
  const result = accepted(await runCommand(root, { which: "test", where: "root" }));
  assert.ok(result.tail.length <= 64 * 1024, `tail is ${result.tail.length} bytes`);
  assert.ok(result.tail.length > 32 * 1024, "and it is the tail of a much longer run, not a scrap");
  assert.match(result.tail, /line 4000 /, "the end of the output is what a reader needs");
  assert.doesNotMatch(result.tail, /line 1 /);
});

test("a run past its timeout is refused, and the process group it started is killed", async (t) => {
  const { root, env } = await repository(t);
  const file = path.join(root, "grandchild.pid");
  // The shell backgrounds a child of its own: killing the process leader alone would
  // leave this one running, holding the worktree and the machine.
  configure(root, { testCommand: `echo the suite started; sleep 60 & echo $! > ${JSON.stringify(file)}; sleep 60` });

  const started = Date.now();
  const timedOut = await runCommand(root, { which: "test", where: "root", timeoutSeconds: 1 }, { env });
  const reason = refusal(timedOut);
  assert.match(reason, /1s|timeout|killed/i);
  // The last of what it printed is exactly what a lead needs to see when a suite hangs.
  assert.match((timedOut as { tail?: string }).tail ?? "", /the suite started/);
  assert.ok(Date.now() - started < 30_000, "the refusal did not wait for the command");
  const pid = Number(fs.readFileSync(file, "utf8").trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `the command recorded a pid: ${pid}`);
  await poll(() => proc(pid), (stat) => stat === null || stat.state === "Z");
});

test("a timeout above the timer's own bound is refused rather than silently collapsing", async (t) => {
  const { root } = await repository(t, { testCommand: "echo the suite ran" });
  // Node's timer takes a 32-bit delay: 2^31 ms and above fire immediately, so a lead
  // asking for a month would get a suite killed on the spot.
  for (const timeoutSeconds of [2_147_484, 1e12, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.match(refusal(await runCommand(root, { which: "test", where: "root", timeoutSeconds })), /timeout_seconds/, String(timeoutSeconds));
  }
  accepted(await runCommand(root, { which: "test", where: "root", timeoutSeconds: 2_147_483 }));
});

test("the tail is cut on a character boundary, never inside one", async (t) => {
  // 90 000 bytes of a three-byte character: the 64 KB cut cannot land on a boundary, and
  // a byte-sliced tail would open with a replacement character.
  const { root } = await repository(t, { testCommand: "printf '\u221a%.0s' $(seq 1 30000)" });
  const tail = accepted(await runCommand(root, { which: "test", where: "root" })).tail;
  assert.ok(tail.length > 20_000, `tail is ${tail.length} characters`);
  assert.doesNotMatch(tail, /\uFFFD/);
  assert.equal(tail.replace(/\u221a/g, ""), "");
});

test("a worktree where is verified as git_mutate verifies it, with the branch from its journal", async (t) => {
  const { root } = await repository(t, { testCommand: "pwd", setupCommand: "pwd" });
  const directory = path.join(root, ".worktrees", "alpha");
  const created = await gitRoot(root, { args: ["worktree", "add", "-b", "task/alpha", directory, "main"], slug: "alpha" }, { waitSeconds: 5 });
  assert.equal(created.ok, true, JSON.stringify(created));

  const ran = accepted(await runCommand(root, { which: "setup", where: directory, slug: "alpha" }));
  assert.equal(ran.tail.trim(), fs.realpathSync(directory), "the command ran in the worktree, not at the root");
  assert.equal(ran.journal, undefined, "a worktree run completes no step of the loop");

  // Which journal names the branch is the caller's to say: a worktree may carry a branch
  // of another slug's name (design section 7).
  assert.match(refusal(await runCommand(root, { which: "test", where: directory })), /slug/);
  assert.match(refusal(await runCommand(root, { which: "test", where: directory, slug: "absent" })), /journal/);
  // The verifier's own refusals reach the lead verbatim: the root is not a worktree.
  assert.match(refusal(await runCommand(root, { which: "test", where: root, slug: "alpha" })), /worktree|linked/);

  // Another slug's worktree is on another slug's branch, so the verifier refuses it first.
  const other = path.join(root, ".worktrees", "beta");
  const second = await gitRoot(root, { args: ["worktree", "add", "-b", "task/beta", other, "main"], slug: "beta" }, { waitSeconds: 5 });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.match(refusal(await runCommand(root, { which: "test", where: other, slug: "alpha" })), /task\/beta.*task\/alpha/);

  // And a worktree moved out from under its journal is refused on the path: the branch
  // still verifies there, and the journal is what says which directory is this task's.
  const moved = path.join(root, ".worktrees", "moved");
  await git(root, "worktree", "move", directory, moved);
  const reason = refusal(await runCommand(root, { which: "test", where: moved, slug: "alpha" }));
  assert.match(reason, /journaled on worktree/);
  assert.match(reason, new RegExp(fs.realpathSync(moved).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("tests-passed is journaled for a passing root run, once, and only after the merge", async (t) => {
  const { root } = await repository(t, { testCommand: "echo the suite ran" });
  const directory = path.join(root, ".worktrees", "alpha");
  const created = await gitRoot(root, { args: ["worktree", "add", "-b", "task/alpha", directory, "main"], slug: "alpha" }, { waitSeconds: 5 });
  assert.equal(created.ok, true, JSON.stringify(created));

  // The step records the suite passing **on the default branch after the merge**, which is
  // the state the repair path acts on; before the merge there is nothing it could mean.
  assert.match(refusal(await runCommand(root, { which: "test", where: "root", slug: "alpha" })), /merged/);
  // A run with no slug is still a run: it just journals nothing.
  assert.equal(accepted(await runCommand(root, { which: "test", where: "root" })).journal, undefined);
  // And `setup` completes no step of the loop, so naming a journal for it says nothing.
  assert.match(refusal(await runCommand(root, { which: "setup", where: "root", slug: "alpha" })), /journals nothing|test/);

  const committed = await gitMutate(root, { slug: "alpha", args: ["commit", "--allow-empty", "-m", "work"] }, { waitSeconds: 5 });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  // The gate on the branch head, which the merge is held to.
  assert.equal(accepted(await runCommand(root, { which: "test", where: directory, slug: "alpha" })).journal?.step, "tested");
  const done = await gitRoot(root, { args: ["merge", "--ff-only", "task/alpha"], slug: "alpha" }, { waitSeconds: 5 });
  assert.equal(done.ok, true, JSON.stringify(done));

  // A failing suite after the merge is exactly the case the repair path is for, and it
  // journals nothing: no step says the tests passed.
  configure(root, { testCommand: "echo it failed; exit 1" });
  const failed = accepted(await runCommand(root, { which: "test", where: "root", slug: "alpha" }));
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.journal, undefined);
  assert.equal(readJournal(root, "alpha")!.steps.some((step) => step.step === "tests-passed"), false);

  configure(root, { testCommand: "echo the suite ran" });
  const passed = accepted(await runCommand(root, { which: "test", where: "root", slug: "alpha", timeoutSeconds: 60 }));
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.journal!.step, "tests-passed");
  // What the suite ran on, read before it started: the journal says which commit passed.
  assert.equal(passed.journal!.defaultSha, await git(root, "rev-parse", "main"));
  assert.deepEqual(readJournal(root, "alpha")!.steps.map((step) => step.step),
    ["worktree-created", "committed", "tested", "merged", "tests-passed"]);
  // Once: the journal is a record of what happened, not a counter of runs.
  assert.match(refusal(await runCommand(root, { which: "test", where: "root", slug: "alpha" })), /tests-passed/);
});

test("two passing root runs at once record one tests-passed step, and the second is told", async (t) => {
  const { root } = await repository(t, { testCommand: "echo the suite ran" });
  await merged(root, "alpha");

  // The server dispatches calls concurrently, so two runs can both pass their own check
  // before either records anything: the step is what says the suite passed, and it says
  // it once (`src/journal.ts#appendStep`).
  const both = await Promise.all([
    runCommand(root, { which: "test", where: "root", slug: "alpha" }),
    runCommand(root, { which: "test", where: "root", slug: "alpha" }),
  ]);
  const recorded = both.filter((result) => result.ok && result.journal !== undefined);
  const refused = both.filter((result) => !result.ok);
  assert.equal(recorded.length, 1, JSON.stringify(both));
  assert.equal(refused.length, 1, JSON.stringify(both));
  assert.match(refusal(refused[0]), /tests-passed/);
  assert.equal(readJournal(root, "alpha")!.steps.filter((step) => step.step === "tests-passed").length, 1);
});

test("a tracked .cross-agent/ is refused, because the command it would run is config", async (t) => {
  const { root } = await repository(t, { testCommand: "echo the suite ran" });
  await git(root, "add", "-f", ".cross-agent/config.json");
  await git(root, "commit", "-m", "track the project's own configuration");

  // The command string is config only, which is safe exactly while a specialist cannot
  // commit a change to it.
  const reason = refusal(await runCommand(root, { which: "test", where: "root" }));
  assert.match(reason, /\.cross-agent/);
  assert.match(reason, /\.gitignore/);

  await git(root, "rm", "-r", "--cached", ".cross-agent");
  await git(root, "commit", "-m", "stop tracking it");
  assert.match(accepted(await runCommand(root, { which: "test", where: "root" })).tail, /the suite ran/);
});

test("the tests-passed step is written under git.lock, and the suite runs outside it", async (t) => {
  const { root } = await repository(t, { testCommand: "true" });
  await merged(root, "locked");
  // Set once the merge is done, so the marker says the root run started and nothing earlier.
  const marker = path.join(root, "the-suite-ran");
  configure(root, { testCommand: `touch ${JSON.stringify(marker)}; echo the suite ran` });

  // A suite may run for ten minutes; holding the git lock for it would refuse every
  // mutation in the project for that long. The lock covers the re-check and the append.
  const held = await acquire(lockPath(root, gitLockName()), { operation: "a competing mutation", waitSeconds: 5 });
  t.after(() => held.release());
  const pending = runCommand(root, { which: "test", where: "root", slug: "locked" });
  await poll(() => fs.existsSync(marker), Boolean);
  await delay(300);
  assert.equal(readJournal(root, "locked")!.steps.some((step) => step.step === "tests-passed"), false,
    "the suite ran while the lock was held, and its step waited for it");

  await held.release();
  assert.equal(accepted(await pending).journal!.step, "tests-passed");
});

test("the command runs in the child environment a specialist gets, carrying no task", async (t) => {
  const { root, env } = await repository(t, {
    testCommand: "printenv CROSS_AGENT_DEPTH; printenv CROSS_AGENT_PROJECT; printenv CROSS_AGENT_TASK;"
      + " printenv CROSS_AGENT_LINEAGE; printenv CLAUDECODE; printenv MCP_SERVER_THING; printenv ANTHROPIC_API_KEY;"
      + " printenv GIT_DIR; printenv GIT_WORK_TREE; printenv GIT_INDEX_FILE; printenv GIT_CONFIG_GLOBAL;"
      + " printenv GIT_CEILING_DIRECTORIES; printenv GIT_COMMON_DIR; echo done",
  });
  const result = accepted(await runCommand(root, { which: "test", where: "root" }, {
    env: {
      ...env, CLAUDECODE: "1", MCP_SERVER_THING: "a host's", ANTHROPIC_API_KEY: "the operator's key", CROSS_AGENT_TASK: "T9",
      // What a server started from a git hook or `git rebase --exec` carries: a suite that
      // runs git would be pointed at another repository, index or configuration by these.
      GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere", GIT_INDEX_FILE: "/elsewhere/index",
      GIT_CONFIG_GLOBAL: "/elsewhere/config", GIT_CEILING_DIRECTORIES: "/", GIT_COMMON_DIR: "/elsewhere/.git",
    },
    depth: 1,
  }));
  const lines = result.tail.split("\n").filter(Boolean);
  // The loop guard's own two variables and nothing that would make the command a task:
  // a `cross-agent` server started inside the suite resolves as a specialist, never as
  // the operator, and the markers a host puts in its children's environment are gone.
  assert.deepEqual(lines, ["2", root, "done"]);
});

// At a root that is not its repository's main checkout every run needs the project to be
// initialized there, and the run that journals needs its branch too (design section 4).

/** A root of `layout` that is not its repository's main checkout, with a config when `settings` is given. */
async function nonMainRoot(t: TestContext, layout: LayoutName, settings?: Record<string, string>): Promise<LayoutRoot> {
  const made = await layoutRoot(t, layout);
  if (settings !== undefined) {
    fs.mkdirSync(path.join(made.root, ".cross-agent"), { recursive: true });
    fs.writeFileSync(path.join(made.root, ".cross-agent", "config.json"), JSON.stringify({ roles: {}, project: settings }));
  }
  return made;
}

const notInitialized = /not an initialized project; run "cross-agent init" in /;

// @anchor linkedRootTests
test("an initialized linked root runs its suite in itself, and journals the run after its own merge", async (t) => {
  const { root } = await nonMainRoot(t, "linked", { defaultBranch: "feature", testCommand: "pwd" });
  assert.equal(accepted(await runCommand(root, { which: "test", where: "root" })).tail.trim(), root);
  const directory = path.join(root, ".worktrees", "x");
  assert.equal((await gitRoot(root, { args: ["worktree", "add", "-b", "task/x", directory, "feature"], slug: "x" }, { waitSeconds: 5 })).ok, true);
  assert.equal((await gitMutate(root, { slug: "x", args: ["commit", "--allow-empty", "-m", "work"] }, { waitSeconds: 5 })).ok, true);
  assert.equal(accepted(await runCommand(root, { which: "test", where: directory, slug: "x" })).journal?.step, "tested");
  assert.equal((await gitRoot(root, { args: ["merge", "--ff-only", "task/x"], slug: "x" }, { waitSeconds: 5 })).ok, true);
  const journaled = accepted(await runCommand(root, { which: "test", where: "root", slug: "x" }));
  assert.equal(journaled.tail.trim(), root);
  assert.equal(journaled.journal?.step, "tests-passed");
  assert.equal(journaled.journal?.defaultSha, await git(root, "rev-parse", "feature"));
});

// @anchor noSlugTestConfiglessRefused
test("a test run at a root that is no main checkout and holds no config is refused, slug or none", async (t) => {
  const { root } = await nonMainRoot(t, "bare-linked");
  assert.match(refusal(await runCommand(root, { which: "test", where: "root" })), notInitialized);
});

// @anchor setupConfiglessRefused
test("a setup run at a root that is no main checkout and holds no config is refused", async (t) => {
  const { root } = await nonMainRoot(t, "umbrella");
  assert.match(refusal(await runCommand(root, { which: "setup", where: "root" })), notInitialized);
});

// @anchor initializedNonMainRunsSetup
test("an initialized root runs setup and an unjournaled suite whatever branch it has checked out", async (t) => {
  const { root } = await nonMainRoot(t, "linked", { defaultBranch: "main", setupCommand: "echo set up", testCommand: "echo tested" });
  assert.match(accepted(await runCommand(root, { which: "setup", where: "root" })).tail, /set up/);
  assert.match(accepted(await runCommand(root, { which: "test", where: "root" })).tail, /tested/);
});

// @anchor mainOnOtherBranchRunsSetup
test("an initialized main checkout on another branch runs setup, as it always has", async (t) => {
  const { root } = await repository(t, { setupCommand: "echo set up" });
  await git(root, "checkout", "-b", "elsewhere");
  assert.match(accepted(await runCommand(root, { which: "setup", where: "root" })).tail, /set up/);
});

// @anchor linkedRootWorktreeRun
test("a worktree run at a linked root runs in the worktree it verifies, and needs the root initialized", async (t) => {
  const { root } = await nonMainRoot(t, "linked", { defaultBranch: "feature", testCommand: "pwd" });
  const directory = path.join(root, ".worktrees", "x");
  assert.equal((await gitRoot(root, { args: ["worktree", "add", "-b", "task/x", directory, "feature"], slug: "x" }, { waitSeconds: 5 })).ok, true);
  // The worktree it verifies names the branch; the suite runs in the gate's own checkout of
  // that branch's head, under the linked root's `.cross-agent/gate/`, gone once it ends.
  const ran = accepted(await runCommand(root, { which: "test", where: directory, slug: "x" })).tail.trim();
  assert.ok(ran.startsWith(path.join(root, ".cross-agent", "gate") + path.sep), ran);
  assert.equal(fs.existsSync(ran), false);
  assert.doesNotMatch(await git(root, "worktree", "list", "--porcelain"), /\.cross-agent/);
  fs.rmSync(path.join(root, ".cross-agent", "config.json"));
  assert.match(refusal(await runCommand(root, { which: "test", where: directory, slug: "x" })), notInitialized);
});

// The gate (design section 4): a worktree test run checks the branch head out on its own,
// under the project's `.cross-agent/gate/`, runs the setup command and the suite there, and
// journals `tested` against that head when the suite exits zero.

/** Polls for `marker`, then lets a command waiting on `release` finish. */
async function whileItWaits(marker: string, release: string, act: () => Promise<void> | void): Promise<void> {
  await poll(() => fs.existsSync(marker), Boolean);
  await act();
  fs.writeFileSync(release, "");
}

/**
 * A command that says it started, waits for the test's word, then does `then`. The wait is
 * bounded at thirty seconds, so a test whose word never comes fails rather than hangs.
 */
function waiting(marker: string, release: string, then: string): string {
  return `touch ${JSON.stringify(marker)}; i=0; while [ ! -f ${JSON.stringify(release)} ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done; ${then}`;
}

// @anchor testedStep
test("a passing worktree test run journals tested at the branch head, and nothing else does", async (t) => {
  const { root } = await repository(t, { testCommand: "echo ok", setupCommand: "pwd" });
  const directory = await committedTask(root, "x");
  const head = await git(root, "rev-parse", "task/x");
  const first = accepted(await runCommand(root, { which: "test", where: directory, slug: "x" }));
  assert.equal(first.exitCode, 0);
  assert.equal(first.journal?.step, "tested");
  assert.equal(first.journal?.before, head);
  assert.equal(first.journal?.after, head);
  assert.equal(first.journal?.defaultSha, await git(root, "rev-parse", "main"));
  // A task is tested as often as the loop tests it.
  assert.equal(accepted(await runCommand(root, { which: "test", where: directory, slug: "x" })).journal?.step, "tested");
  const steps = () => readJournal(root, "x")!.steps.map((step) => step.step);
  assert.deepEqual(steps(), ["worktree-created", "committed", "tested", "tested"]);

  configure(root, { testCommand: "exit 1", setupCommand: "pwd" });
  const failed = accepted(await runCommand(root, { which: "test", where: directory, slug: "x" }));
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.journal, undefined);
  configure(root, { testCommand: "none", setupCommand: "pwd" });
  assert.equal(accepted(await runCommand(root, { which: "test", where: directory, slug: "x" })).journal, undefined, "a suite that never ran passed nothing");
  // A setup runs in the worktree it verifies, as before, and completes no step.
  const setup = accepted(await runCommand(root, { which: "setup", where: directory, slug: "x" }));
  assert.equal(setup.tail.trim(), directory);
  assert.equal(setup.journal, undefined);
  configure(root, { testCommand: "echo ok" });
  assert.equal(accepted(await runCommand(root, { which: "test", where: "root" })).journal, undefined);
  assert.deepEqual(steps(), ["worktree-created", "committed", "tested", "tested"]);
});

// @anchor testedIsolatesHead
test("a worktree test run tests a detached checkout of the branch head, not the worktree, runs setup there first, and removes it", async (t) => {
  const { root } = await repository(t, { testCommand: "test -f passing" });
  const directory = await committedTask(root, "x");
  const run = () => runCommand(root, { which: "test", where: directory, slug: "x" });
  const tested = () => readJournal(root, "x")!.steps.filter((step) => step.step === "tested").map((step) => step.after);
  const commit = async (file: string, content: string, message: string): Promise<string> => {
    fs.writeFileSync(path.join(directory, file), content);
    for (const args of [["add", "--", file], ["commit", "-m", message]]) {
      const ran = await gitMutate(root, { slug: "x", args }, { waitSeconds: 5 });
      assert.equal(ran.ok, true, JSON.stringify(ran));
    }
    return git(root, "rev-parse", "task/x");
  };

  // (a) A file the worktree holds and the commit does not is no part of what passes.
  fs.writeFileSync(path.join(directory, "passing"), "");
  assert.equal(accepted(await run()).exitCode, 1);
  assert.deepEqual(tested(), []);
  const added = await commit("passing", "", "the file the suite looks for");
  assert.equal(accepted(await run()).exitCode, 0);
  assert.deepEqual(tested(), [added]);

  // (b) Bytes a mark hides from git status are no part of it either, under either mark.
  configure(root, { testCommand: "grep -q yes passing" });
  const no = await commit("passing", "no\n", "the committed answer is no");
  for (const [mark, clear] of [["--assume-unchanged", "--no-assume-unchanged"], ["--skip-worktree", "--no-skip-worktree"]]) {
    await git(directory, "update-index", mark, "passing");
    fs.writeFileSync(path.join(directory, "passing"), "yes\n");
    assert.equal(await git(directory, "status", "--porcelain", "--untracked-files=all"), "", mark);
    assert.equal(accepted(await run()).exitCode, 1, mark);
    await git(directory, "update-index", clear, "passing");
    fs.writeFileSync(path.join(directory, "passing"), "no\n");
  }
  assert.deepEqual(tested(), [added], `nothing passed at ${no}`);

  // (c) The worktree changing while the suite runs reaches nothing it reads.
  const marker = path.join(root, "the-suite-started");
  const release = path.join(root, "carry-on");
  const yes = await commit("passing", "yes\n", "the committed answer is yes");
  configure(root, { testCommand: waiting(marker, release, "grep -q yes passing") });
  const holding = run();
  await whileItWaits(marker, release, () => fs.writeFileSync(path.join(directory, "passing"), "no\n"));
  assert.equal(accepted(await holding).exitCode, 0);
  assert.deepEqual(tested(), [added, yes]);
  fs.writeFileSync(path.join(directory, "passing"), "yes\n");
  for (const file of [marker, release]) fs.rmSync(file);
  const committedNo = await commit("passing", "no\n", "back to no");
  const swapped = run();
  await whileItWaits(marker, release, () => fs.writeFileSync(path.join(directory, "passing"), "yes\n"));
  assert.equal(accepted(await swapped).exitCode, 1);
  assert.deepEqual(tested(), [added, yes], `nothing passed at ${committedNo}`);
  fs.writeFileSync(path.join(directory, "passing"), "no\n");
  for (const file of [marker, release]) fs.rmSync(file);

  // (d) The setup command runs in the gate's checkout first, and its failure is the run's refusal.
  configure(root, { setupCommand: "touch prepared", testCommand: "test -f prepared" });
  assert.equal(accepted(await run()).exitCode, 0);
  assert.equal(fs.existsSync(path.join(directory, "prepared")), false, "the setup wrote nothing into the worktree");
  configure(root, { setupCommand: "echo not set up; exit 3", testCommand: "true" });
  const unprepared = refusal(await run());
  assert.match(unprepared, /setupCommand exited 3 in the gate's checkout of/);

  // (e) The checkout is the server's, under `.cross-agent/gate/`, and gone once the run ends.
  configure(root, { testCommand: "pwd" });
  const where = accepted(await run()).tail.trim();
  assert.ok(where.startsWith(path.join(root, ".cross-agent", "gate") + path.sep), where);
  assert.equal(fs.existsSync(where), false);
  assert.doesNotMatch(await git(root, "worktree", "list", "--porcelain"), /\.cross-agent/);

  // (f) The branch moving during the run moves nothing the step says.
  configure(root, { testCommand: waiting(marker, release, "true") });
  const before = await git(root, "rev-parse", "task/x");
  const moving = run();
  await whileItWaits(marker, release, async () => { await git(directory, "commit", "--allow-empty", "-m", "a commit the suite never saw"); });
  const result = accepted(await moving);
  assert.equal(result.journal?.after, before);
  const moved = await git(root, "rev-parse", "task/x");
  assert.notEqual(moved, before);
  // The merge is held to the head the suite passed on, and the branch is not there now.
  const merge = await gitRoot(root, { args: ["merge", "--ff-only", "task/x"], slug: "x" }, { waitSeconds: 5 });
  assert.equal(merge.ok, false);
  assert.match((merge as { reason: string }).reason, new RegExp(`at ${moved}: journal x records no tested step at that commit`));
});

// @anchor gateCheckoutOwned
test("the gate's checkout lives under the project's own .cross-agent/gate, and a link out of it is refused with nothing checked out", async (t) => {
  const { root } = await repository(t, { testCommand: "pwd" });
  const directory = await committedTask(root, "x");
  const gate = path.join(root, ".cross-agent", "gate");
  assert.ok(accepted(await runCommand(root, { which: "test", where: directory, slug: "x" })).tail.trim().startsWith(gate + path.sep));
  assert.equal(fs.statSync(gate).mode & 0o777, 0o700, "a directory of the server's own");

  const outside = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "cross-agent-outside-")));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(gate, { recursive: true, force: true });
  fs.symlinkSync(outside, gate);
  const registry = await git(root, "worktree", "list", "--porcelain");
  const steps = readJournal(root, "x")!.steps.length;
  const reason = refusal(await runCommand(root, { which: "test", where: directory, slug: "x" }));
  assert.ok(reason.includes(gate) && reason.includes(outside), reason);
  assert.deepEqual(fs.readdirSync(outside), [], "nothing was checked out there");
  assert.equal(await git(root, "worktree", "list", "--porcelain"), registry);
  assert.equal(readJournal(root, "x")!.steps.length, steps, "and nothing was journaled");
});

// @anchor setupRefusedUnderReview
test("a worktree setup is refused while a gating review of that worktree is active, writes a marker naming its group while it runs, and clears it when it ends", async (t) => {
  const marker = path.join(tmpdir(), `cross-agent-setup-${process.pid}-${Date.now()}`);
  const release = `${marker}.release`;
  t.after(() => { for (const file of [marker, release]) fs.rmSync(file, { force: true }); });
  const { root } = await repository(t, { setupCommand: waiting(marker, release, "echo set up") });
  const directory = await committedTask(root, "x");
  const head = await git(root, "rev-parse", "task/x");
  const review = create(root, { role: "code-reviewer", brief: "review", cwd: directory, engine: "codex", underReview: head });
  await update(root, review.id, { status: "running" });

  // A setup writes the tree a review is reading at a committed head.
  const held = refusal(await runCommand(root, { which: "setup", where: directory, slug: "x" }));
  assert.match(held, new RegExp(`under review by task ${review.id} \\(running\\)`));
  assert.equal(fs.existsSync(marker), false, "the setup command never ran");
  assert.equal(fs.existsSync(path.join(root, ".cross-agent", "setups")) && fs.readdirSync(path.join(root, ".cross-agent", "setups")).length > 0, false);

  await update(root, review.id, { status: "done" });
  const running = runCommand(root, { which: "setup", where: directory, slug: "x" });
  await poll(() => fs.existsSync(marker), Boolean);
  const file = setupMarkerPath(root, directory);
  const written = JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number; pgid: number; startTime: string; bootId: string; slug: string };
  assert.equal(written.pgid, written.pid, "the detached command leads its own group");
  assert.equal(written.slug, "x");
  assert.equal(groupAlive(written), true);
  // One setup at a time: a second is refused naming the first's group.
  assert.match(refusal(await runCommand(root, { which: "setup", where: directory, slug: "x" })), new RegExp(`process group ${written.pgid}`));
  fs.writeFileSync(release, "");
  assert.match(accepted(await running).tail, /set up/);
  assert.equal(fs.existsSync(file), false, "the marker goes with the command");
});
