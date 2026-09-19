import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitMutate } from "../src/gitmutate.ts";
import { gitRoot } from "../src/gitroot.ts";
import { readJournal } from "../src/journal.ts";
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
  const { root } = await repository(t);
  const file = path.join(root, "grandchild.pid");
  // The shell backgrounds a child of its own: killing the process leader alone would
  // leave this one running, holding the worktree and the machine.
  configure(root, { testCommand: `sleep 60 & echo $! > ${JSON.stringify(file)}; sleep 60` });

  const started = Date.now();
  const reason = refusal(await runCommand(root, { which: "test", where: "root", timeoutSeconds: 1 }));
  assert.match(reason, /1 second|timeout|killed/i);
  assert.ok(Date.now() - started < 30_000, "the refusal did not wait for the command");
  const pid = Number(fs.readFileSync(file, "utf8").trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `the command recorded a pid: ${pid}`);
  await poll(() => proc(pid), (stat) => stat === null || stat.state === "Z");
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
  assert.deepEqual(readJournal(root, "alpha")!.steps.map((step) => step.step),
    ["worktree-created", "committed", "merged", "tests-passed"]);
  // Once: the journal is a record of what happened, not a counter of runs.
  assert.match(refusal(await runCommand(root, { which: "test", where: "root", slug: "alpha" })), /tests-passed/);
});

test("the command runs in the child environment a specialist gets, carrying no task", async (t) => {
  const { root, env } = await repository(t, {
    testCommand: "printenv CROSS_AGENT_DEPTH; printenv CROSS_AGENT_PROJECT; printenv CROSS_AGENT_TASK;"
      + " printenv CROSS_AGENT_LINEAGE; printenv CLAUDECODE; printenv MCP_SERVER_THING; printenv ANTHROPIC_API_KEY; echo done",
  });
  const result = accepted(await runCommand(root, { which: "test", where: "root" }, {
    env: { ...env, CLAUDECODE: "1", MCP_SERVER_THING: "a host's", ANTHROPIC_API_KEY: "the operator's key", CROSS_AGENT_TASK: "T9" },
    depth: 1,
  }));
  const lines = result.tail.split("\n").filter(Boolean);
  // The loop guard's own two variables and nothing that would make the command a task:
  // a `cross-agent` server started inside the suite resolves as a specialist, never as
  // the operator, and the markers a host puts in its children's environment are gone.
  assert.deepEqual(lines, ["2", root, "done"]);
});
