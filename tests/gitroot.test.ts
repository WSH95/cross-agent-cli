import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gitMutate } from "../src/gitmutate.ts";
import { gitRoot } from "../src/gitroot.ts";
import type { GitRootResult } from "../src/gitroot.ts";
import { readJournal } from "../src/journal.ts";
import { update } from "../src/ledger.ts";
import { acquire, gitLockName, lockPath, spawnLockName } from "../src/locks.ts";
import { git, gitShim, holderOf } from "./helpers/git.ts";
import { poll, project, reserve } from "./helpers/project.ts";
import type { TestProject } from "./helpers/project.ts";

// `git_root` is the root half of design section 4: one whitelisted verb at the project
// root, under `git.lock`, with the step it completes written to the task's journal. Every
// test here runs real git against a real repository, because the whitelist exists to keep
// a lead away from a repository it could otherwise reach in full.

/** A project whose repository can commit: `git_root` and `git_mutate` both refuse `-c`. */
async function repository(t: TestContext): Promise<TestProject> {
  const created = await project(t, { roles: {} }, [{ key: "implementer", workspace: "worktree" }]);
  await git(created.root, "config", "user.name", "Cross Agent Test");
  await git(created.root, "config", "user.email", "test@example.invalid");
  await git(created.root, "config", "commit.gpgSign", "false");
  return created;
}

function accepted(result: GitRootResult): Extract<GitRootResult, { ok: true }> {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<GitRootResult, { ok: true }>;
}

function refusal(result: GitRootResult): string {
  assert.equal(result.ok, false, JSON.stringify(result));
  const { reason } = result as Extract<GitRootResult, { ok: false }>;
  assert.equal(typeof reason, "string");
  assert.ok(reason.trim().length > 0);
  return reason;
}

/** The whole repository as a test can compare it: every branch and every worktree. */
async function state(root: string): Promise<{ branches: string; worktrees: number; status: string }> {
  return {
    branches: await git(root, "branch", "--list", "--format=%(refname:short) %(objectname)"),
    worktrees: (await git(root, "worktree", "list")).split("\n").filter(Boolean).length,
    // The harness's own files are untracked, so what a test compares is the tracked state.
    status: await git(root, "status", "--porcelain", "--untracked-files=no"),
  };
}

test("git_root runs one whitelisted verb and refuses every other, before git runs", async (t) => {
  const source = await repository(t);
  const root = source.root;
  const before = await state(root);
  const directory = path.join(root, ".worktrees", "alpha");

  // The whitelist is the whole security argument for handing an engine any root git
  // access at all (design section 4), so a verb it does not name never reaches git — and
  // neither does a whitelisted verb in a shape it does not name.
  const outside: string[][] = [
    ["push", "origin", "main"],
    ["reset", "--hard", "main"],
    ["commit", "--allow-empty", "-m", "at the root"],
    ["checkout", "task/alpha"],
    ["worktree", "prune"],
    ["worktree", "add", "--detach", directory],
    ["branch", "-D", "task/alpha"],
    ["branch", "-m", "main", "trunk"],
    ["merge", "task/alpha"],
    ["merge", "--no-ff", "task/alpha"],
    ["rebase", "main"],
    ["rebase", "--continue"],
    ["status", "--short"],
    ["worktree", "add", "-b", "task/alpha", directory, "main", "--force"],
    ["worktree", "remove", directory, "--force"],
    ["gc", "--prune=now"],
  ];
  for (const args of outside) {
    const reason = refusal(await gitRoot(root, { args, slug: "alpha" }, { waitSeconds: 5 }));
    assert.match(reason, /git_root/, args.join(" "));
  }
  assert.deepEqual(await state(root), before, "nothing on that list touched the repository");
  assert.equal(readJournal(root, "alpha"), null);

  // An empty argument list and an argument that is not a string are the same refusal.
  refusal(await gitRoot(root, { args: [] }, { waitSeconds: 5 }));
  refusal(await gitRoot(root, { args: [1 as unknown as string] }, { waitSeconds: 5 }));
});

test("git_root refuses a global git option anywhere in its arguments", async (t) => {
  const { root } = await repository(t);
  const before = await state(root);

  // Each of these turns a whitelisted verb into an arbitrary one against an arbitrary
  // repository, which is what the whitelist exists to prevent.
  const refused: string[][] = [
    ["-c", "core.hooksPath=/tmp/hooks", "status"],
    ["-C", "/tmp", "status"],
    ["--git-dir=/tmp/elsewhere/.git", "status"],
    ["--work-tree=/tmp", "status"],
    ["status", "-c", "core.pager=cat"],
    ["worktree", "list", "--git-dir=/tmp/elsewhere/.git"],
    ["branch", "--list", "--work-tree=/tmp"],
    ["merge", "--ff-only", "-C", "/tmp"],
  ];
  for (const args of refused) {
    assert.match(refusal(await gitRoot(root, { args }, { waitSeconds: 5 })), /refused|git_root/, args.join(" "));
  }
  assert.deepEqual(await state(root), before);
});

test("a journaled verb needs a slug and a read-only one refuses it", async (t) => {
  const { root } = await repository(t);
  const directory = path.join(root, ".worktrees", "alpha");

  // The journal a step belongs to is named, never inferred from a branch or a directory:
  // one slug's worktree may carry another's branch (design section 7).
  for (const args of [
    ["worktree", "add", "-b", "task/alpha", directory, "main"],
    ["merge", "--ff-only", "task/alpha"],
    ["branch", "-d", "task/alpha"],
    ["worktree", "remove", directory],
  ]) {
    assert.match(refusal(await gitRoot(root, { args }, { waitSeconds: 5 })), /slug/, args.join(" "));
  }
  // A verb that journals nothing takes no slug: silence would let a lead believe its
  // reconciliation read was recorded.
  for (const args of [["status", "--porcelain"], ["worktree", "list"], ["rebase", "--abort"]]) {
    assert.match(refusal(await gitRoot(root, { args, slug: "alpha" }, { waitSeconds: 5 })), /journals nothing/, args.join(" "));
  }
  assert.equal(readJournal(root, "alpha"), null);
  // A slug that is not a file name of its own is refused before anything runs.
  refusal(await gitRoot(root, { args: ["worktree", "add", "-b", "task/alpha", directory, "main"], slug: "../escape" }, { waitSeconds: 5 }));
  assert.equal(fs.existsSync(directory), false);
});

test("the whole task loop through git_root journals one named step per verb with the default branch's SHAs", async (t) => {
  const { root } = await repository(t);
  const directory = path.join(root, ".worktrees", "alpha");
  const initial = await git(root, "rev-parse", "main");

  const created = accepted(await gitRoot(root, {
    args: ["worktree", "add", "-b", "task/alpha", directory, "main"], slug: "alpha",
  }, { waitSeconds: 5, now: 10 }));
  assert.equal(created.exitCode, 0);
  assert.equal(created.before, initial);
  assert.equal(created.after, initial, "creating a worktree moves no branch");
  assert.equal(created.journal!.step, "worktree-created");
  const journal = readJournal(root, "alpha")!;
  assert.equal(journal.branch, "task/alpha");
  assert.equal(journal.defaultBranch, "main");
  // The journal is bound to the directory the verb created, which is what a later
  // `worktree remove` and a worktree `run_command` are held to.
  assert.equal(journal.worktree, fs.realpathSync(directory));

  // The implementer's work, through the tool that owns a worktree's git metadata.
  fs.writeFileSync(path.join(directory, "notes.md"), "the implementer's edit\n");
  accepted(await gitMutate(root, { slug: "alpha", args: ["add", "-A"] }, { waitSeconds: 5, now: 20 }));
  accepted(await gitMutate(root, { slug: "alpha", args: ["commit", "-m", "task work"] }, { waitSeconds: 5, now: 30 }));
  const head = await git(root, "rev-parse", "task/alpha");

  const merged = accepted(await gitRoot(root, { args: ["merge", "--ff-only", "task/alpha"], slug: "alpha" }, { waitSeconds: 5, now: 40 }));
  assert.equal(merged.before, initial);
  assert.equal(merged.after, head, "the default branch fast-forwarded to the task branch");
  assert.equal(merged.journal!.step, "merged");
  const afterMerge = readJournal(root, "alpha")!;
  // The two merge fields, taken inside the same lock the merge ran under: the revert
  // target the repair path names, and the head it merged (design section 7).
  assert.equal(afterMerge.defaultShaBeforeMerge, initial);
  assert.equal(afterMerge.branchHead, head);

  const removed = accepted(await gitRoot(root, { args: ["worktree", "remove", directory], slug: "alpha" }, { waitSeconds: 5, now: 50 }));
  assert.equal(removed.journal!.step, "worktree-removed");
  assert.equal(fs.existsSync(directory), false);
  const deleted = accepted(await gitRoot(root, { args: ["branch", "-d", "task/alpha"], slug: "alpha" }, { waitSeconds: 5, now: 60 }));
  assert.equal(deleted.journal!.step, "branch-deleted");

  const complete = readJournal(root, "alpha")!;
  assert.deepEqual(complete.steps.map((step) => step.step),
    ["worktree-created", "git", "committed", "merged", "worktree-removed", "branch-deleted"]);
  assert.deepEqual(complete.steps.map((step) => step.at), [10, 20, 30, 40, 50, 60]);
  // Every step of a root verb records the default branch it saw, beside the SHAs around
  // the call: for these three that is the branch they moved or left alone.
  for (const step of complete.steps.filter((entry) => entry.step !== "git" && entry.step !== "committed")) {
    assert.equal(step.defaultSha, step.before, step.step);
    assert.equal(typeof step.after, "string", step.step);
  }
  assert.equal(complete.steps.find((step) => step.step === "branch-deleted")!.before, head);
  assert.deepEqual(complete.steps.filter((step) => step.args !== undefined).map((step) => step.step),
    ["git", "committed"], "a named root step is its name; only a plain git_mutate records its arguments");

  // The loop's own end state: one worktree, no task branch, a clean root.
  assert.equal((await state(root)).worktrees, 1);
  assert.equal(await git(root, "branch", "--list", "task/*"), "");
  assert.equal((await state(root)).status, "", "and the merge left nothing behind at the root");
});

test("the merge fields are written once and a second merge on one slug is refused", async (t) => {
  const { root } = await repository(t);
  const directory = path.join(root, ".worktrees", "once");
  accepted(await gitRoot(root, { args: ["worktree", "add", "-b", "task/once", directory, "main"], slug: "once" }, { waitSeconds: 5 }));
  accepted(await gitMutate(root, { slug: "once", args: ["commit", "--allow-empty", "-m", "work"] }, { waitSeconds: 5 }));
  const head = await git(root, "rev-parse", "task/once");
  const initial = accepted(await gitRoot(root, { args: ["merge", "--ff-only", "task/once"], slug: "once" }, { waitSeconds: 5 })).before;
  assert.equal(readJournal(root, "once")!.defaultShaBeforeMerge, initial);

  // A task merges once: the second call is refused before git runs, and neither merge
  // field moves — they are the repair path's evidence.
  const reason = refusal(await gitRoot(root, { args: ["merge", "--ff-only", "task/once"], slug: "once" }, { waitSeconds: 5 }));
  assert.match(reason, /merged/);
  const journal = readJournal(root, "once")!;
  assert.equal(journal.defaultShaBeforeMerge, initial);
  assert.equal(journal.branchHead, head);
  assert.equal(journal.steps.filter((step) => step.step === "merged").length, 1);
});

test("a branch or a directory that is not the slug's journal is refused", async (t) => {
  const { root } = await repository(t);
  const directory = path.join(root, ".worktrees", "bound");
  accepted(await gitRoot(root, { args: ["worktree", "add", "-b", "task/bound", directory, "main"], slug: "bound" }, { waitSeconds: 5 }));
  accepted(await gitRoot(root, { args: ["worktree", "add", "-b", "task/other", path.join(root, ".worktrees", "other"), "main"], slug: "other" }, { waitSeconds: 5 }));
  const before = await state(root);

  // The journal says which branch and which directory are this task's; the arguments do
  // not get to say otherwise.
  for (const args of [["merge", "--ff-only", "task/other"], ["branch", "-d", "task/other"]]) {
    assert.match(refusal(await gitRoot(root, { args, slug: "bound" }, { waitSeconds: 5 })), /journaled on task\/bound/, args.join(" "));
  }
  assert.match(
    refusal(await gitRoot(root, { args: ["worktree", "remove", path.join(root, ".worktrees", "other")], slug: "bound" }, { waitSeconds: 5 })),
    /journaled on worktree/,
  );
  // And a second `worktree add` on a slug that already has one: the journal is the record
  // of the worktree this task was given.
  assert.match(
    refusal(await gitRoot(root, { args: ["worktree", "add", "-b", "task/bound", path.join(root, ".worktrees", "again"), "main"], slug: "bound" }, { waitSeconds: 5 })),
    /worktree-created/,
  );
  assert.deepEqual(await state(root), before);
  assert.deepEqual(readJournal(root, "bound")!.steps.map((step) => step.step), ["worktree-created"]);
});

test("a journal git_mutate bound to another worktree's branch still merges and cleans up", async (t) => {
  const { root } = await repository(t);
  // Design section 4's A3 binding: slug `a`, the worktree at `path`, the branch `task/b`.
  // `git_mutate` created this journal, so `git_root` follows what it recorded and not the
  // names it could derive from the slug.
  const directory = path.join(root, ".worktrees", "b-dir");
  await git(root, "worktree", "add", "-b", "task/b", directory);
  accepted(await gitMutate(root, { slug: "a", path: directory, branch: "task/b", args: ["commit", "--allow-empty", "-m", "work"] }, { waitSeconds: 5 }));
  const journal = readJournal(root, "a")!;
  assert.equal(journal.branch, "task/b");
  assert.equal(journal.worktree, fs.realpathSync(directory));

  accepted(await gitRoot(root, { args: ["merge", "--ff-only", "task/b"], slug: "a" }, { waitSeconds: 5 }));
  accepted(await gitRoot(root, { args: ["worktree", "remove", directory], slug: "a" }, { waitSeconds: 5 }));
  accepted(await gitRoot(root, { args: ["branch", "-d", "task/b"], slug: "a" }, { waitSeconds: 5 }));
  assert.deepEqual(readJournal(root, "a")!.steps.map((step) => step.step),
    ["committed", "merged", "worktree-removed", "branch-deleted"]);
  assert.equal(await git(root, "branch", "--list", "task/*"), "");
  assert.equal((await state(root)).worktrees, 1);
});

test("git_root refuses a path outside the mode's worktree directory, a base that is not the default branch, and a branch the pattern does not match", async (t) => {
  const { root } = await repository(t);
  const outside = path.join(path.dirname(root), "outside-the-project");
  await git(root, "branch", "side", "main");
  const before = await state(root);

  for (const [args, expected] of [
    [["worktree", "add", "-b", "task/x", outside, "main"], /worktree directory/],
    [["worktree", "add", "-b", "task/x", path.join(root, "src", "x"), "main"], /worktree directory/],
    [["worktree", "add", "-b", "task/x", path.join(root, ".worktrees"), "main"], /worktree directory/],
    [["worktree", "add", "-b", "task/x", path.join(root, ".worktrees", "x"), "side"], /default branch/],
    [["worktree", "add", "-b", "feature/x", path.join(root, ".worktrees", "x"), "main"], /branch pattern/],
    [["worktree", "remove", outside], /worktree directory/],
  ] as Array<[string[], RegExp]>) {
    const reason = refusal(await gitRoot(root, { args, slug: "x" }, { waitSeconds: 5 }));
    assert.match(reason, expected, args.join(" "));
  }
  // A read names a branch under the same rule, and takes no slug to name it with.
  for (const args of [["branch", "--list", "*"], ["rev-parse", "side"], ["merge-base", "main", "side"]]) {
    assert.match(refusal(await gitRoot(root, { args }, { waitSeconds: 5 })), /branch pattern|default branch/, args.join(" "));
  }
  assert.deepEqual(await state(root), before);
  assert.equal(fs.existsSync(outside), false);

  // A symlinked worktree directory is the same escape as a `..`, so what exists of the
  // path is resolved before it is judged.
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, ".worktrees"));
  assert.match(
    refusal(await gitRoot(root, { args: ["worktree", "add", "-b", "task/x", path.join(root, ".worktrees", "x"), "main"], slug: "x" }, { waitSeconds: 5 })),
    /worktree directory/,
  );
  assert.equal(fs.existsSync(path.join(outside, "x")), false);
});

test("the worktree directory and the branch pattern are the mode's own", async (t) => {
  const created = await project(t, { roles: {} }, [{ key: "implementer", workspace: "worktree" }], {
    git: { worktreeDir: "trees", branchPattern: "work/*" },
    roles: [{
      key: "implementer", title: "Implementer", promptFile: "roles/implementer.md",
      workspace: { kind: "worktree", branchPattern: "work/*", dir: "trees" }, sandboxDefault: "workspace-write",
    }],
  });
  const { root } = created;
  const policy = { waitSeconds: 5, dir: created.mode.git!.worktreeDir, branchPattern: created.mode.git!.branchPattern };
  assert.deepEqual(created.mode.git, { worktreeDir: "trees", branchPattern: "work/*" });

  // Under this mode `.worktrees` and `task/*` are the ones that are refused.
  refusal(await gitRoot(root, { args: ["worktree", "add", "-b", "task/one", path.join(root, "trees", "one"), "main"], slug: "one" }, policy));
  refusal(await gitRoot(root, { args: ["worktree", "add", "-b", "work/one", path.join(root, ".worktrees", "one"), "main"], slug: "one" }, policy));
  accepted(await gitRoot(root, { args: ["worktree", "add", "-b", "work/one", path.join(root, "trees", "one"), "main"], slug: "one" }, policy));
  assert.equal(readJournal(root, "one")!.branch, "work/one");
  assert.equal(readJournal(root, "one")!.worktree, fs.realpathSync(path.join(root, "trees", "one")));
});

test("the read-only verbs answer from the root and journal nothing", async (t) => {
  const { root } = await repository(t);
  accepted(await gitRoot(root, { args: ["worktree", "add", "-b", "task/read", path.join(root, ".worktrees", "read"), "main"], slug: "read" }, { waitSeconds: 5 }));
  const steps = readJournal(root, "read")!.steps.length;

  // What section 7's reconciliation pass reads, verbatim.
  assert.equal(accepted(await gitRoot(root, { args: ["status", "--porcelain", "--untracked-files=no"] }, { waitSeconds: 5 })).stdout, "");
  assert.match(accepted(await gitRoot(root, { args: ["status", "--porcelain", "--untracked-files=normal"] }, { waitSeconds: 5 })).stdout, /\?\? /);
  assert.match(accepted(await gitRoot(root, { args: ["branch", "--list", "task/*"] }, { waitSeconds: 5 })).stdout, /task\/read/);
  assert.match(accepted(await gitRoot(root, { args: ["worktree", "list", "--porcelain"] }, { waitSeconds: 5 })).stdout, /worktree /);
  assert.equal(accepted(await gitRoot(root, { args: ["rev-parse", "main"] }, { waitSeconds: 5 })).stdout.trim(), await git(root, "rev-parse", "main"));
  assert.match(accepted(await gitRoot(root, { args: ["log", "--oneline", "--max-count=1", "main"] }, { waitSeconds: 5 })).stdout, /\w/);
  assert.equal(accepted(await gitRoot(root, { args: ["merge-base", "main", "task/read"] }, { waitSeconds: 5 })).stdout.trim(), await git(root, "rev-parse", "main"));
  assert.equal(readJournal(root, "read")!.steps.length, steps, "a read journals nothing");

  // `rebase --abort` with no rebase in progress is git's own failure, reported as one.
  const aborted = await gitRoot(root, { args: ["rebase", "--abort"] }, { waitSeconds: 5 });
  assert.equal(aborted.ok, false);
  assert.equal((aborted as Extract<GitRootResult, { ok: false }>).exitCode, 128);
});

test("a tracked .cross-agent/ is refused by every verb, naming .gitignore", async (t) => {
  const { root } = await repository(t);
  // What runs and what is journaled are config: with `.cross-agent/` tracked, a
  // specialist's commit inside its worktree reaches the root through the lead's own
  // merge, and `testCommand` is what the lead then runs there.
  await git(root, "add", "-f", ".cross-agent/config.json");
  await git(root, "commit", "-m", "track the project's own configuration");

  for (const args of [["status", "--porcelain"], ["worktree", "list"]]) {
    const reason = refusal(await gitRoot(root, { args }, { waitSeconds: 5 }));
    assert.match(reason, /\.cross-agent/, args.join(" "));
    assert.match(reason, /\.gitignore/, args.join(" "));
  }
  refusal(await gitRoot(root, { args: ["worktree", "add", "-b", "task/x", path.join(root, ".worktrees", "x"), "main"], slug: "x" }, { waitSeconds: 5 }));
  assert.equal(fs.existsSync(path.join(root, ".worktrees", "x")), false);

  // Untracked again — the lead's own repair — and the tools work.
  await git(root, "rm", "-r", "--cached", ".cross-agent");
  await git(root, "commit", "-m", "stop tracking it");
  accepted(await gitRoot(root, { args: ["status", "--porcelain", "--untracked-files=no"] }, { waitSeconds: 5 }));
});

test("git_root holds git.lock for the call and takes no spawn.lock", async (t) => {
  const { root } = await repository(t);
  const directory = path.join(root, ".worktrees", "locked");

  const competitor = await acquire(lockPath(root, gitLockName()), { operation: "a competing mutation", waitSeconds: 5 });
  t.after(() => competitor.release());
  const blocked = gitRoot(root, { args: ["worktree", "add", "-b", "task/locked", directory, "main"], slug: "locked" }, { waitSeconds: 20 });
  await delay(400);
  assert.equal(fs.existsSync(directory), false, "nothing ran while git.lock was held");
  await competitor.release();
  accepted(await blocked);

  // No reservation is consulted at the root, so nothing here waits on `spawn.lock`: a
  // delegation in flight neither blocks a root verb nor is blocked by one.
  const claim = await acquire(lockPath(root, spawnLockName()), { operation: "a delegate", waitSeconds: 5 });
  t.after(() => claim.release());
  accepted(await gitRoot(root, { args: ["status", "--porcelain"] }, { waitSeconds: 20 }));
  await claim.release();

  // And a lock that cannot be taken is a refusal like any other, never an exception.
  const held = await acquire(lockPath(root, gitLockName()), { operation: "a competing mutation", waitSeconds: 5 });
  t.after(() => held.release());
  assert.match(refusal(await gitRoot(root, { args: ["status", "--porcelain"] }, { waitSeconds: 0 })), /held by another process/);
});

test("worktree remove refuses a workspace an unsettled task is holding", async (t) => {
  const { root } = await repository(t);
  const directory = path.join(root, ".worktrees", "held");
  accepted(await gitRoot(root, { args: ["worktree", "add", "-b", "task/held", directory, "main"], slug: "held" }, { waitSeconds: 5 }));
  const resolved = fs.realpathSync(directory);

  // Git removes a clean worktree whatever is running in it, so the reservation is what
  // stops a task's own directory being taken out from under it (design section 2).
  const record = await reserve(root, resolved);
  assert.equal(refusal(await gitRoot(root, { args: ["worktree", "remove", directory], slug: "held" }, { waitSeconds: 5 })),
    `${resolved} is reserved by task ${record.id} (running); wait or cancel first`);
  assert.equal(fs.existsSync(directory), true);
  assert.deepEqual(readJournal(root, "held")!.steps.map((step) => step.step), ["worktree-created"]);

  // A settled task has let it go — but a record nobody can read clears no workspace at
  // all, because its own cwd is unknown.
  assert.equal((await update(root, record.id, { status: "done" })).applied, true);
  const damaged = path.join(root, ".cross-agent", "tasks", "damaged.json");
  fs.writeFileSync(damaged, "{not json");
  assert.match(refusal(await gitRoot(root, { args: ["worktree", "remove", directory], slug: "held" }, { waitSeconds: 5 })), /damaged\.json/);
  fs.rmSync(damaged);

  accepted(await gitRoot(root, { args: ["worktree", "remove", directory], slug: "held" }, { waitSeconds: 5 }));
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(readJournal(root, "held")!.steps.map((step) => step.step), ["worktree-created", "worktree-removed"]);
});

test("worktree remove takes spawn.lock and then git.lock; the other verbs take neither", async (t) => {
  const { root } = await repository(t);
  const directory = path.join(root, ".worktrees", "ordered");
  accepted(await gitRoot(root, { args: ["worktree", "add", "-b", "task/ordered", directory, "main"], slug: "ordered" }, { waitSeconds: 5 }));

  // `delegate` holds spawn.lock around validate-and-spawn, so a removal that holds it too
  // cannot have its reservation check race a delegation taking the same workspace.
  const claim = await acquire(lockPath(root, spawnLockName()), { operation: "a delegate", waitSeconds: 5 });
  t.after(() => claim.release());
  const blocked = gitRoot(root, { args: ["worktree", "remove", directory], slug: "ordered" }, { waitSeconds: 20 });
  await delay(400);
  assert.equal(fs.existsSync(directory), true, "nothing ran while spawn.lock was held");
  // A verb that touches no workspace reads no reservation and waits for nothing.
  accepted(await gitRoot(root, { args: ["worktree", "list"] }, { waitSeconds: 20 }));
  await claim.release();
  accepted(await blocked);
  assert.equal(fs.existsSync(directory), false);

  // And the order is always spawn.lock then git.lock: a removal waiting for git.lock is
  // already holding spawn.lock, which is why no delegate can slip in behind it.
  const second = path.join(root, ".worktrees", "second");
  accepted(await gitRoot(root, { args: ["worktree", "add", "-b", "task/second", second, "main"], slug: "second" }, { waitSeconds: 5 }));
  const competitor = await acquire(lockPath(root, gitLockName()), { operation: "a competing mutation", waitSeconds: 5 });
  t.after(() => competitor.release());
  const waiting = gitRoot(root, { args: ["worktree", "remove", second], slug: "second" }, { waitSeconds: 20 });
  await delay(400);
  await assert.rejects(
    acquire(lockPath(root, spawnLockName()), { operation: "a delegate", waitSeconds: 0 }),
    /held by another process/,
  );
  await competitor.release();
  accepted(await waiting);
});

test("a root command that fails returns its exit code and output, and journals nothing", async (t) => {
  const { root } = await repository(t);
  const directory = path.join(root, ".worktrees", "diverged");
  accepted(await gitRoot(root, { args: ["worktree", "add", "-b", "task/diverged", directory, "main"], slug: "diverged" }, { waitSeconds: 5 }));
  accepted(await gitMutate(root, { slug: "diverged", args: ["commit", "--allow-empty", "-m", "on the task branch"] }, { waitSeconds: 5 }));
  await git(root, "commit", "--allow-empty", "-m", "on the default branch");
  const head = await git(root, "rev-parse", "main");

  // A merge that cannot fast-forward is git's refusal, reported with both streams: any
  // `ok: false` is a reconciliation trigger, so no step claims a merge that did not happen.
  const result = await gitRoot(root, { args: ["merge", "--ff-only", "task/diverged"], slug: "diverged" }, { waitSeconds: 5 });
  const failed = result as Extract<GitRootResult, { ok: false }>;
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 128);
  assert.match(`${failed.stdout}${failed.stderr}`, /fast-forward/);
  assert.equal(await git(root, "rev-parse", "main"), head, "the default branch did not move");
  const journal = readJournal(root, "diverged")!;
  assert.deepEqual(journal.steps.map((step) => step.step), ["worktree-created", "committed"]);
  assert.equal(journal.defaultShaBeforeMerge, undefined);
  assert.equal(journal.branchHead, undefined);

  // An unmerged branch is git's refusal too, and `branch -d` is the only delete there is.
  const unmerged = await gitRoot(root, { args: ["branch", "-d", "task/diverged"], slug: "diverged" }, { waitSeconds: 5 });
  assert.equal(unmerged.ok, false);
  assert.match(await git(root, "branch", "--list", "task/*"), /task\/diverged/);
});

test("a merge is refused unless the root is on the default branch", async (t) => {
  const { root } = await repository(t);
  const directory = path.join(root, ".worktrees", "elsewhere");
  accepted(await gitRoot(root, { args: ["worktree", "add", "-b", "task/elsewhere", directory, "main"], slug: "elsewhere" }, { waitSeconds: 5 }));
  accepted(await gitMutate(root, { slug: "elsewhere", args: ["commit", "--allow-empty", "-m", "work"] }, { waitSeconds: 5 }));
  await git(root, "checkout", "-b", "side");

  // `merge` merges into HEAD, and both merge fields are read from the default branch: a
  // merge taken anywhere else would journal a revert target that never existed.
  const reason = refusal(await gitRoot(root, { args: ["merge", "--ff-only", "task/elsewhere"], slug: "elsewhere" }, { waitSeconds: 5 }));
  assert.match(reason, /main/);
  assert.equal(await git(root, "rev-parse", "side"), await git(root, "rev-parse", "main"));
  assert.equal(readJournal(root, "elsewhere")!.steps.filter((step) => step.step === "merged").length, 0);
});

test("a journal step that cannot be written after the command ran is reported as such", async (t) => {
  const { root } = await repository(t);
  const directory = path.join(root, ".worktrees", "unwritable");
  accepted(await gitRoot(root, { args: ["worktree", "add", "-b", "task/unwritable", directory, "main"], slug: "unwritable" }, { waitSeconds: 5 }));
  const journals = path.join(root, ".cross-agent", "journal");
  fs.chmodSync(journals, 0o500);

  // The command happened; only the record of it did not. `ok: true` would tell the lead
  // its journal is current when it is not.
  const result = await gitRoot(root, { args: ["worktree", "remove", directory], slug: "unwritable" }, { waitSeconds: 5 });
  fs.chmodSync(journals, 0o700);
  assert.equal(result.ok, false);
  assert.match((result as Extract<GitRootResult, { ok: false }>).reason, /ran|could not be written/);
  assert.equal(fs.existsSync(directory), false, "and the reason says so because the worktree is gone");
});

test("a lock lost while the root command ran is reported, and the step is still journaled", async (t) => {
  const { root } = await repository(t);
  const recorder = await gitShim(t, { sleepOn: "slow-marker" });
  const directory = path.join(root, ".worktrees", "slow-marker");

  const pending = gitRoot(root, {
    args: ["worktree", "add", "-b", "task/slow-marker", directory, "main"], slug: "slow",
  }, { waitSeconds: 5, now: 7 });
  const holder = await poll(() => holderOf(lockPath(root, gitLockName())), (pid) => pid !== null);
  await poll(async () => (await recorder.argv()).some((argument) => argument.includes("slow-marker")), Boolean);
  // The kernel hands the lock to the next waiter the moment its holder dies, so a caller
  // that carried on silently would be acting on exclusivity it no longer has.
  process.kill(holder!, "SIGKILL");

  const result = accepted(await pending);
  assert.equal(result.lockLost, true);
  assert.equal(fs.existsSync(directory), true, "the command had already run, so its step is journaled");
  assert.deepEqual(readJournal(root, "slow")!.steps.map((step) => step.at), [7]);
});
