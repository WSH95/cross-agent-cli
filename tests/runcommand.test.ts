import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gitMutate } from "../src/gitmutate.ts";
import { gitRoot } from "../src/gitroot.ts";
import { readJournal } from "../src/journal.ts";
import { acquire, gitLockName, lockPath } from "../src/locks.ts";
import { runCommand } from "../src/runcommand.ts";
import type { RunCommandResult } from "../src/runcommand.ts";
import { git } from "./helpers/git.ts";
import { poll, proc, project } from "./helpers/project.ts";
import type { TestProject } from "./helpers/project.ts";

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

/** A task with a worktree and a merge behind it: what a root test run is journaled after. */
async function merged(root: string, slug: string): Promise<string> {
  const directory = path.join(root, ".worktrees", slug);
  const created = await gitRoot(root, {
    args: ["worktree", "add", "-b", `task/${slug}`, directory, "main"], slug,
  }, { waitSeconds: 5 });
  assert.equal(created.ok, true, JSON.stringify(created));
  const committed = await gitMutate(root, { slug, args: ["commit", "--allow-empty", "-m", "work"] }, { waitSeconds: 5 });
  assert.equal(committed.ok, true, JSON.stringify(committed));
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
    ["worktree-created", "committed", "merged", "tests-passed"]);
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
  const { root } = await repository(t);
  const marker = path.join(root, "the-suite-ran");
  configure(root, { testCommand: `touch ${JSON.stringify(marker)}; echo the suite ran` });
  await merged(root, "locked");

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
