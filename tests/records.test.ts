import "./child-check.mjs";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CONFIG_PATH, loadConfig } from "../src/config.ts";
import { create } from "../src/ledger.ts";
import { acquire, gitLockName, lockPath, repositoryLockPath } from "../src/locks.ts";
import { builtInModesDir, loadMode } from "../src/modes.ts";
import { readRunJournal, record } from "../src/records.ts";
import type { RecordChange, RecordRequest, RecordResult } from "../src/records.ts";
import { createServer, projectTools } from "../src/server.ts";
import { git, gitShim, holdersOf } from "./helpers/git.ts";
import { poll } from "./helpers/project.ts";

// `record` is the root commit procedure of design section 4 for the project's own record
// files: a declared file read, or a batch written and committed at the root under the git
// locks and journaled in the run journal. Every test here runs real git against a root of
// its own, wholly clean, because `record` refuses any other.

const handoff = ".project-steward/HANDOFF.md";
const progress = ".project-steward/PROGRESS.md";
const decisions = ".project-steward/DECISIONS.md";

/** The approved example block (design section 6). */
function recordsBlock(): Record<string, unknown> {
  return {
    files: [handoff, progress, decisions],
    tracker: {
      ready: ["bd", "ready"],
      show: ["bd", "show", "{id}"],
      create: ["bd", "create", "--title={title}", "--description={text}", "--parent={parent}"],
      file: ["bd", "create", "--title={title}", "--description={text}"],
      epic: ["bd", "create", "--type=epic", "--title={title}", "--description={text}"],
      claim: ["bd", "update", "{id}", "--claim"],
      close: ["bd", "close", "{id}", "--reason={text}"],
      depend: ["bd", "dep", "add", "{id}", "{on}"],
      files: [".beads/interactions.jsonl"],
    },
  };
}

/**
 * A wholly clean root of its own, committed on `main`: the handoff and the progress file
 * tracked, the decisions file declared and absent, and `.cross-agent/` ignored.
 */
async function repository(t: TestContext, records: unknown = recordsBlock(), extra: Record<string, unknown> = {}): Promise<string> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "cross-agent-records-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.name", "Cross Agent Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "commit.gpgSign", "false");
  fs.writeFileSync(path.join(root, ".gitignore"), ".cross-agent/\n.worktrees/\n");
  fs.writeFileSync(path.join(root, "README.md"), "# A project\n");
  fs.mkdirSync(path.join(root, ".project-steward"));
  fs.writeFileSync(path.join(root, handoff), "The handoff.\n");
  fs.writeFileSync(path.join(root, progress), "- began\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "initial");
  fs.mkdirSync(path.join(root, ".cross-agent"));
  fs.writeFileSync(path.join(root, CONFIG_PATH), JSON.stringify({ roles: {}, project: { testCommand: "none" }, records, ...extra }));
  return root;
}

function call(root: string, request: RecordRequest, waitSeconds = 1): Promise<RecordResult> {
  return record(root, request, { waitSeconds, run: "operator" });
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function accepted(result: RecordResult): Extract<RecordResult, { ok: true }> {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<RecordResult, { ok: true }>;
}

function refused(result: RecordResult): Extract<RecordResult, { ok: false }> {
  assert.equal(result.ok, false, JSON.stringify(result));
  const failed = result as Extract<RecordResult, { ok: false }>;
  assert.ok(failed.reason.trim().length > 0);
  return failed;
}

function contents(root: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join(root, file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** What a refusal must leave as it was: the files, HEAD, and a clean root. */
async function unchanged(root: string, before: string, message: string): Promise<void> {
  assert.equal(contents(root, handoff), "The handoff.\n", message);
  assert.equal(contents(root, progress), "- began\n", message);
  assert.equal(contents(root, decisions), null, message);
  assert.equal(await git(root, "rev-parse", "HEAD"), before, message);
}

const appendToHandoff: RecordRequest = { changes: [{ path: handoff, mode: "append", text: "- more\n" }], message: "records: more" };

/** An executable `pre-commit` hook in the repository's own hooks directory. */
function hook(root: string, script: string): void {
  const file = path.join(root, ".git", "hooks", "pre-commit");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, script, { mode: 0o755 });
}

test("record reads a declared file with its sha256 and refuses an undeclared path", async (t) => {
  const root = await repository(t);
  assert.deepEqual(await call(root, { path: handoff }), {
    ok: true, path: handoff, exists: true, text: "The handoff.\n", sha256: sha256("The handoff.\n"),
  });
  assert.deepEqual(await call(root, { path: decisions }), { ok: true, path: decisions, exists: false });
  // The tracker's own files are `track`'s, and every other path is no record at all.
  for (const undeclared of ["README.md", ".beads/interactions.jsonl", "../outside.md"]) {
    assert.match(refused(await call(root, { path: undeclared })).reason, /is not a record file/, undeclared);
  }
  // Up to 1 MiB whole, and a byte more is refused by its size.
  fs.writeFileSync(path.join(root, decisions), Buffer.alloc(1024 * 1024, "a"));
  const whole = accepted(await call(root, { path: decisions })) as { text?: string; sha256?: string };
  assert.equal(whole.text!.length, 1024 * 1024);
  assert.equal(whole.sha256, sha256(Buffer.alloc(1024 * 1024, "a")));
  fs.writeFileSync(path.join(root, decisions), Buffer.alloc(1024 * 1024 + 1, "a"));
  assert.match(refused(await call(root, { path: decisions })).reason, /1048577 bytes/);
});

test("replace writes only while expect matches; append adds the missing newline", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  const stale = refused(await call(root, {
    changes: [{ path: handoff, mode: "replace", text: "New.\n", expect: sha256("another handoff\n") }], message: "stale",
  }));
  assert.match(stale.reason, /expect/);
  await unchanged(root, before, "a stale expect changes nothing");

  accepted(await call(root, { changes: [{ path: handoff, mode: "replace", text: "New.\n", expect: sha256("The handoff.\n") }], message: "replace" }));
  assert.equal(contents(root, handoff), "New.\n");
  // `null` creates, and only where nothing is.
  accepted(await call(root, { changes: [{ path: decisions, mode: "replace", text: "D1.\n", expect: null }], message: "create" }));
  assert.equal(contents(root, decisions), "D1.\n");
  assert.match(refused(await call(root, { changes: [{ path: decisions, mode: "replace", text: "D2.\n", expect: null }], message: "again" })).reason, /expect/);
  assert.equal(contents(root, decisions), "D1.\n");

  // A file that lacks its final newline gets one before the appended text, and one that has it gets none.
  accepted(await call(root, { changes: [{ path: progress, mode: "replace", text: "- began", expect: sha256("- began\n") }], message: "no newline" }));
  accepted(await call(root, { changes: [{ path: progress, mode: "append", text: "- next\n" }], message: "append" }));
  assert.equal(contents(root, progress), "- began\n- next\n");
  accepted(await call(root, { changes: [{ path: progress, mode: "append", text: "- third\n", expect: sha256("- began\n- next\n") }], message: "append again" }));
  assert.equal(contents(root, progress), "- began\n- next\n- third\n");
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=all"), "");
});

// @anchor recordBatchWritesNothing
test("a batch with one invalid entry writes nothing", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  const first: RecordChange = { path: handoff, mode: "replace", text: "Changed.\n", expect: sha256("The handoff.\n") };
  const seconds: Array<[string, RecordChange]> = [
    ["an undeclared second entry", { path: "README.md", mode: "append", text: "x\n" }],
    ["a stale expect", { path: progress, mode: "replace", text: "x\n", expect: sha256("stale\n") }],
    ["a replace without expect", { path: progress, mode: "replace", text: "x\n" }],
    ["the same path twice", { path: handoff, mode: "append", text: "x\n" }],
    ["an expect that is no sha256", { path: progress, mode: "append", text: "x\n", expect: "ABC" }],
  ];
  for (const [name, second] of seconds) {
    refused(await call(root, { changes: [first, second], message: "a batch" }));
    await unchanged(root, before, name);
  }
  for (const message of ["", "a\0b"]) {
    refused(await call(root, { changes: [first], message }));
    await unchanged(root, before, JSON.stringify(message));
  }
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=all"), "");
});

// @anchor recordCommitsExactPaths
test("a write commits exactly its paths and journals recorded", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  const result = accepted(await call(root, {
    changes: [
      { path: progress, mode: "append", text: "- task 1 merged\n" },
      { path: handoff, mode: "replace", text: "Next: task 2.\n", expect: sha256("The handoff.\n") },
      { path: decisions, mode: "replace", text: "D1: two shapes.\n", expect: null },
    ],
    message: "records: task 1",
  })) as { paths: string[]; commit?: string; journal?: Record<string, unknown> };
  const after = await git(root, "rev-parse", "HEAD");
  assert.notEqual(after, before);
  assert.equal(result.commit, after);
  assert.deepEqual(result.paths, [progress, handoff, decisions], "the batch's paths, in request order");
  assert.equal(await git(root, "rev-parse", `${after}^`), before);
  assert.deepEqual((await git(root, "diff-tree", "-r", "--name-only", before, after)).split("\n").sort(), [decisions, handoff, progress]);
  assert.equal((await git(root, "log", "-1", "--format=%B", after)).trim(), "records: task 1");
  assert.equal(await git(root, "show", `${after}:${handoff}`), "Next: task 2.");
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=all"), "");

  const journal = readRunJournal(root, "operator")!;
  assert.equal(journal.run, "operator");
  assert.equal(journal.defaultBranch, "main");
  assert.equal(journal.steps.length, 1);
  const [step] = journal.steps;
  assert.deepEqual(result.journal, step);
  assert.equal(typeof step.at, "number");
  assert.deepEqual({ ...step, at: 0, paths: [...step.paths].sort() }, {
    step: "recorded", at: 0, before, after, paths: [decisions, handoff, progress], message: "records: task 1", verified: true,
  });
  // A second write is a second step of the same journal.
  accepted(await call(root, appendToHandoff));
  assert.deepEqual(readRunJournal(root, "operator")!.steps.map((each) => each.before), [before, after]);
});

test("a write that leaves the root clean commits and journals nothing", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  const result = await call(root, { changes: [{ path: handoff, mode: "replace", text: "The handoff.\n", expect: sha256("The handoff.\n") }], message: "the same bytes" });
  assert.deepEqual(result, { ok: true, paths: [handoff] });
  await unchanged(root, before, "nothing was committed");
  assert.equal(fs.existsSync(path.join(root, ".cross-agent", "runs", "operator.json")), false);
});

// @anchor recordRefusesUncleanRoot
test("record refuses a root with a staged, unstaged, untracked or assume-unchanged change", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  const readme = path.join(root, "README.md");
  const restore = async () => {
    await git(root, "reset", "-q", "--", "README.md");
    await git(root, "checkout", "--", "README.md");
  };
  const cases: Array<[string, RegExp, () => Promise<void>, () => Promise<void>]> = [
    ["staged", /README\.md/, async () => { fs.writeFileSync(readme, "staged\n"); await git(root, "add", "README.md"); }, restore],
    ["unstaged", /README\.md/, async () => { fs.writeFileSync(readme, "changed\n"); }, restore],
    ["untracked", /notes\.txt/, async () => { fs.writeFileSync(path.join(root, "notes.txt"), "x\n"); }, async () => { fs.rmSync(path.join(root, "notes.txt")); }],
    ["assume-unchanged", /README\.md/, async () => {
      await git(root, "update-index", "--assume-unchanged", "README.md");
      fs.writeFileSync(readme, "hidden\n");
    }, async () => {
      await git(root, "update-index", "--no-assume-unchanged", "README.md");
      await restore();
    }],
  ];
  for (const [name, named, make, undo] of cases) {
    await make();
    const reason = refused(await call(root, appendToHandoff)).reason;
    assert.match(reason, named, name);
    assert.match(reason, /clean/, name);
    await unchanged(root, before, name);
    await undo();
  }
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=all"), "");
  accepted(await call(root, appendToHandoff));
});

// @anchor recordRefusesMarkedRecord
test("record refuses a declared path carrying an assume-unchanged mark, before writing", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  // A mark on a batch path whose bytes are unchanged: nothing is uncommitted, and a write
  // there would be one git status could not see.
  await git(root, "update-index", "--assume-unchanged", handoff);
  let reason = refused(await call(root, appendToHandoff)).reason;
  assert.match(reason, /\.project-steward\/HANDOFF\.md/);
  assert.match(reason, /--no-assume-unchanged/);
  await unchanged(root, before, "a marked batch path");
  await git(root, "update-index", "--no-assume-unchanged", handoff);
  // A mark on a declared file outside the batch refuses the batch too.
  await git(root, "update-index", "--assume-unchanged", progress);
  reason = refused(await call(root, appendToHandoff)).reason;
  assert.match(reason, /\.project-steward\/PROGRESS\.md/);
  assert.doesNotMatch(reason, /HANDOFF/);
  await unchanged(root, before, "a marked declared path outside the batch");
  await git(root, "update-index", "--no-assume-unchanged", progress);
  accepted(await call(root, appendToHandoff));
});

// @anchor recordRefusesLinkAtWrite
test("record refuses off the default branch and a link on its path at write time", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  await git(root, "checkout", "-q", "-b", "other");
  assert.match(refused(await call(root, appendToHandoff)).reason, /record commits on main; the root is on other/);
  await unchanged(root, before, "off the default branch");
  await git(root, "checkout", "-q", "main");

  // A link made after the config was loaded, while the call waits for `git.lock`.
  const linkedAfterLoad = async (request: RecordRequest, link: () => void): Promise<RecordResult> => {
    const held = await acquire(lockPath(root, gitLockName()), { operation: "a test holding the git lock", waitSeconds: 5 });
    t.after(() => held.release());
    const pending = call(root, request, 20);
    await poll(() => holdersOf(lockPath(root, gitLockName())).length, (count) => count >= 2);
    link();
    await held.release();
    return pending;
  };
  const elsewhere = path.join(root, "..", `${path.basename(root)}-elsewhere`);
  fs.mkdirSync(elsewhere);
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  // The directory itself, re-made as a link to an empty one.
  const kept = path.join(root, "..", `${path.basename(root)}-kept`);
  t.after(() => fs.rmSync(kept, { recursive: true, force: true }));
  const remade = await linkedAfterLoad(appendToHandoff, () => {
    fs.renameSync(path.join(root, ".project-steward"), kept);
    fs.symlinkSync(elsewhere, path.join(root, ".project-steward"));
  });
  assert.match(refused(remade).reason, /\.project-steward/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing was written through the link");
  fs.unlinkSync(path.join(root, ".project-steward"));
  fs.renameSync(kept, path.join(root, ".project-steward"));
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
  // A link at a declared path git does not see — excluded, so the root stays clean — is
  // refused by the write's own check, and its target is never created.
  fs.appendFileSync(path.join(root, ".git", "info", "exclude"), `${decisions}\n`);
  const target = path.join(elsewhere, "DECISIONS.md");
  const excluded = await linkedAfterLoad({ changes: [{ path: decisions, mode: "replace", text: "D1.\n", expect: null }], message: "through a link" }, () => {
    fs.symlinkSync(target, path.join(root, decisions));
  });
  assert.match(refused(excluded).reason, /"\.project-steward\/DECISIONS\.md" is a symbolic link/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
});

// @anchor recordHookRefusalRestores
test("a hook that refuses the commit leaves the index and the files as they were", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  hook(root, "#!/bin/sh\necho 'refused by the hook' >&2\nexit 1\n");
  const result = refused(await call(root, {
    changes: [{ path: handoff, mode: "append", text: "- more\n" }, { path: decisions, mode: "replace", text: "D1.\n", expect: null }],
    message: "records: refused",
  }));
  assert.match(result.reason, /git commit exited 1; the index and the files are as they were/);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /refused by the hook/);
  await unchanged(root, before, "the created file is removed and the changed one restored");
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(fs.existsSync(path.join(root, ".cross-agent", "runs", "operator.json")), false);
});

// @anchor recordHookAddedPath
test("a hook that adds a path is journaled verified false and named", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  hook(root, "#!/bin/sh\necho extra > extra.txt\ngit add extra.txt\n");
  const result = refused(await call(root, appendToHandoff));
  const after = await git(root, "rev-parse", "HEAD");
  assert.notEqual(after, before);
  assert.match(result.reason, new RegExp(`^commit ${after} landed, but it is not exactly the call's paths: .*extra\\.txt`));
  assert.equal(result.commit, after);
  assert.deepEqual(result.paths, [handoff]);
  assert.equal(result.journal!.verified, false);
  assert.ok(result.journal!.problems!.some((problem) => problem.includes("extra.txt")), JSON.stringify(result.journal));
  assert.deepEqual(readRunJournal(root, "operator")!.steps, [result.journal]);
  // Nothing is restored once the commit has landed.
  assert.equal(contents(root, handoff), "The handoff.\n- more\n");
  assert.equal(await git(root, "show", `HEAD:${handoff}`), "The handoff.\n- more");
  assert.equal(await git(root, "show", "HEAD:extra.txt"), "extra");
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=all"), "");
});

// @anchor recordDamagedJournal
test("a damaged run journal refuses before anything changes", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  const file = path.join(root, ".cross-agent", "runs", "operator.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{");
  assert.match(refused(await call(root, appendToHandoff)).reason, /runs\/operator\.json/);
  await unchanged(root, before, "a damaged journal");
  assert.equal(fs.readFileSync(file, "utf8"), "{");
});

// @anchor recordJournalWriteFails
test("a journal write that fails after the commit answers that the commit landed", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  const runs = path.join(root, ".cross-agent", "runs");
  fs.mkdirSync(runs);
  fs.chmodSync(runs, 0o500);
  const result = await call(root, appendToHandoff);
  fs.chmodSync(runs, 0o700);
  const failed = refused(result);
  const after = await git(root, "rev-parse", "HEAD");
  assert.notEqual(after, before);
  assert.match(failed.reason, new RegExp(`^commit ${after} landed; its step could not be written: `));
  assert.equal(failed.commit, after);
  assert.deepEqual(failed.paths, [handoff]);
  // The commit and its files stay: the index matches HEAD and the work tree is clean.
  assert.equal(contents(root, handoff), "The handoff.\n- more\n");
  assert.equal(await git(root, "show", `HEAD:${handoff}`), "The handoff.\n- more");
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(readRunJournal(root, "operator"), null);
});

// @anchor recordVerificationThrows
test("a git that cannot run while a landed commit is verified leaves the commit journaled verified false and named", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  // Verification's `diff-tree` dies on a signal, so git reports no exit code at all.
  await gitShim(t, { signalOn: "diff-tree" });
  const failed = refused(await call(root, appendToHandoff));
  const after = await git(root, "rev-parse", "HEAD");
  assert.notEqual(after, before);
  assert.match(failed.reason, new RegExp(`^commit ${after} landed, but .*git diff-tree .* could not run`));
  assert.equal(failed.commit, after);
  assert.deepEqual(failed.paths, [handoff]);
  assert.equal(failed.journal!.verified, false);
  assert.ok(failed.journal!.problems!.some((problem) => /git diff-tree .* could not run/.test(problem)), JSON.stringify(failed.journal));
  assert.deepEqual(readRunJournal(root, "operator")!.steps, [failed.journal]);
  // Nothing is put back once the commit has landed.
  assert.equal(contents(root, handoff), "The handoff.\n- more\n");
  assert.equal(await git(root, "show", `HEAD:${handoff}`), "The handoff.\n- more");
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=all"), "");
});

// @anchor recordUnreadableFile
test("an unreadable declared file is refused by name, in the read form and the write form", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  // A tracked record file nobody may read.
  fs.chmodSync(path.join(root, handoff), 0o000);
  const read = await call(root, { path: handoff });
  fs.chmodSync(path.join(root, handoff), 0o644);
  assert.match(refused(read).reason, /^"\.project-steward\/HANDOFF\.md" cannot be read: /);
  // A declared file git does not see — excluded, so the root stays clean — reaches the batch's own read.
  fs.appendFileSync(path.join(root, ".git", "info", "exclude"), `${decisions}\n`);
  fs.writeFileSync(path.join(root, decisions), "D0.\n", { mode: 0o000 });
  const written = await call(root, { changes: [{ path: decisions, mode: "replace", text: "D1.\n", expect: sha256("D0.\n") }], message: "unreadable" });
  fs.chmodSync(path.join(root, decisions), 0o644);
  assert.match(refused(written).reason, /^"\.project-steward\/DECISIONS\.md" cannot be read: /);
  assert.equal(contents(root, decisions), "D0.\n");
  assert.equal(contents(root, handoff), "The handoff.\n");
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
  // Both locks were released.
  accepted(await call(root, appendToHandoff));
});

// @anchor recordKeepsMode
test("a replaced file keeps its mode, and so does one put back after a refused commit", async (t) => {
  const root = await repository(t);
  const file = path.join(root, handoff);
  const mode = () => fs.statSync(file).mode & 0o7777;
  fs.chmodSync(file, 0o600);
  accepted(await call(root, { changes: [{ path: handoff, mode: "replace", text: "Replaced.\n", expect: sha256("The handoff.\n") }], message: "replace" }));
  assert.equal(contents(root, handoff), "Replaced.\n");
  assert.equal(mode(), 0o600, "after a replace");
  hook(root, "#!/bin/sh\nexit 1\n");
  refused(await call(root, appendToHandoff));
  assert.equal(contents(root, handoff), "Replaced.\n");
  assert.equal(mode(), 0o600, "after the bytes were put back");
});

test("record refuses while git.lock is held past its wait", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  const held = await acquire(lockPath(root, gitLockName()), { operation: "another git step", waitSeconds: 5 });
  t.after(() => held.release());
  assert.match(refused(await call(root, appendToHandoff)).reason, /held by another process/);
  await unchanged(root, before, "the lock was never taken");
  await held.release();
  accepted(await call(root, appendToHandoff));
});

// @anchor recordWaitsForRepositoryLock
test("record waits for the repository lock past the project's own lock wait, and commits once it is free", async (t) => {
  const root = await repository(t);
  const before = await git(root, "rev-parse", "HEAD");
  const repositoryLock = repositoryLockPath(path.join(root, ".git"));
  const shared = await acquire(repositoryLock, { operation: "another project's git step", waitSeconds: 5 });
  t.after(() => shared.release());
  const waiting = call(root, appendToHandoff);
  // Waiting on the repository lock, it already holds the project's git lock.
  await poll(() => holdersOf(repositoryLock).length >= 2 && holdersOf(lockPath(root, gitLockName())).length >= 1, Boolean);
  await assert.rejects(acquire(lockPath(root, gitLockName()), { operation: "a probe", waitSeconds: 0 }), /held by another process/);
  await delay(1500);
  await unchanged(root, before, "nothing was written while the repository lock was held");
  await shared.release();
  const result = accepted(await waiting) as { commit?: string };
  assert.equal(result.commit, await git(root, "rev-parse", "HEAD"));
  assert.notEqual(result.commit, before);
});

// @anchor recordResumedLeadJournal
test("a resumed lead's steps go to its chain's run journal", async (t) => {
  const root = await repository(t, recordsBlock(), { mode: "dev-team-engine" });
  const first = create(root, { role: "lead", brief: "the lead's first record", cwd: root, engine: "claude", depth: 1 });
  const resumed = create(root, { role: "lead", brief: "the lead, resumed", cwd: root, engine: "claude", depth: 1, resumedFrom: first.id });
  const server = createServer({
    tools: projectTools(root, { mode: loadMode(builtInModesDir(), "dev-team-engine"), records: loadConfig(root).records! }),
    authority: () => ({ row: "lead", reason: `lead by ancestry: task ${resumed.id} (lead, running)`, taskId: resumed.id, depth: 1 }),
  });
  const reply = await server.handle({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "record", arguments: { changes: [{ path: handoff, mode: "append", text: "- resumed\n" }], message: "records: resumed" } },
  }) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  const answer = JSON.parse(reply.result.content[0].text) as { ok: boolean; commit?: string };
  assert.equal(answer.ok, true, JSON.stringify(answer));
  // The chain's first record names the journal, so a resumed lead continues the same one.
  const journal = readRunJournal(root, first.id)!;
  assert.equal(journal.run, first.id);
  assert.deepEqual(journal.steps.map((step) => step.after), [answer.commit]);
  assert.equal(readRunJournal(root, resumed.id), null);
  assert.equal(readRunJournal(root, "operator"), null);
});
