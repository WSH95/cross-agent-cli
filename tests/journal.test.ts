import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendStep, listJournals, readJournal } from "../src/journal.ts";
import type { Journal } from "../src/journal.ts";

function project(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cross-agent-journal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function directory(root: string): string {
  return path.join(root, ".cross-agent", "journal");
}

function file(root: string, slug: string): string {
  return path.join(directory(root), `${slug}.json`);
}

test("a missing journal is created by the first step and read back", (t) => {
  const root = project(t);
  assert.equal(readJournal(root, "alpha"), null);
  assert.deepEqual(listJournals(root), []);

  const created = appendStep(root, "alpha", "worktree-created", { at: 10, branch: "task/alpha", defaultBranch: "main" });
  const expected: Journal = {
    slug: "alpha", branch: "task/alpha", defaultBranch: "main",
    steps: [{ step: "worktree-created", at: 10 }],
  };
  assert.deepEqual(created, expected);
  assert.deepEqual(readJournal(root, "alpha"), expected);
  assert.deepEqual(listJournals(root), ["alpha"]);
  assert.equal(fs.existsSync(file(root, "alpha")), true);
});

test("a first step that names no branch is refused rather than invented", (t) => {
  const root = project(t);
  assert.throws(() => appendStep(root, "alpha", "committed", { at: 1 }), /branch/);
  assert.equal(readJournal(root, "alpha"), null, "and nothing was written");
  // Once the journal carries them, later steps inherit both.
  appendStep(root, "alpha", "worktree-created", { at: 1, branch: "task/alpha", defaultBranch: "trunk" });
  const journal = appendStep(root, "alpha", "committed", { at: 2 });
  assert.equal(journal.branch, "task/alpha");
  assert.equal(journal.defaultBranch, "trunk");
});

test("steps accumulate in the order they were appended, with only the fields they carry", (t) => {
  const root = project(t);
  appendStep(root, "beta", "worktree-created", { at: 1, branch: "task/beta", defaultBranch: "main" });
  appendStep(root, "beta", "committed", { at: 2, before: "a".repeat(40), after: "b".repeat(40) });
  appendStep(root, "beta", "git", { at: 3, before: "b".repeat(40), after: "c".repeat(40), args: ["status", "--porcelain"] });
  appendStep(root, "beta", "tests-passed", { at: 4 });
  const journal = readJournal(root, "beta")!;
  assert.deepEqual(journal.steps, [
    { step: "worktree-created", at: 1 },
    { step: "committed", at: 2, before: "a".repeat(40), after: "b".repeat(40) },
    { step: "git", at: 3, before: "b".repeat(40), after: "c".repeat(40), args: ["status", "--porcelain"] },
    { step: "tests-passed", at: 4 },
  ]);
  assert.deepEqual(journal.steps.map((entry) => entry.step), ["worktree-created", "committed", "git", "tests-passed"]);

  // Fifty appends keep every step, in order, and the file stays a parseable document.
  for (let index = 5; index <= 54; index += 1) {
    appendStep(root, "beta", "git", { at: index, args: [`step-${index}`] });
    JSON.parse(fs.readFileSync(file(root, "beta"), "utf8"));
  }
  assert.deepEqual(readJournal(root, "beta")!.steps.map((entry) => entry.at), Array.from({ length: 54 }, (_, index) => index + 1));
});

test("the merge SHAs and the branch head are journal fields, kept until they are replaced", (t) => {
  const root = project(t);
  appendStep(root, "gamma", "worktree-created", { at: 1, branch: "task/gamma", defaultBranch: "main" });
  const merged = appendStep(root, "gamma", "merged", {
    at: 2, defaultShaBeforeMerge: "d".repeat(40), branchHead: "e".repeat(40),
  });
  assert.equal(merged.defaultShaBeforeMerge, "d".repeat(40));
  assert.equal(merged.branchHead, "e".repeat(40));
  const later = appendStep(root, "gamma", "tests-passed", { at: 3 });
  assert.equal(later.defaultShaBeforeMerge, "d".repeat(40), "the revert target survives the next step");
  assert.equal(later.branchHead, "e".repeat(40));
  assert.equal(appendStep(root, "gamma", "committed", { at: 4, branchHead: "f".repeat(40) }).branchHead, "f".repeat(40));
  assert.deepEqual(Object.keys(readJournal(root, "gamma")!), ["slug", "branch", "defaultBranch", "defaultShaBeforeMerge", "branchHead", "steps"]);
});

test("each append replaces the file by rename and leaves no temporary behind", (t) => {
  const root = project(t);
  appendStep(root, "delta", "worktree-created", { at: 1, branch: "task/delta", defaultBranch: "main" });
  const first = fs.statSync(file(root, "delta")).ino;
  appendStep(root, "delta", "committed", { at: 2 });
  const second = fs.statSync(file(root, "delta")).ino;
  // A rename swaps a whole new file into place: a reader either sees the old document or
  // the new one, never a truncated one.
  assert.notEqual(first, second);
  assert.deepEqual(fs.readdirSync(directory(root)), ["delta.json"]);
});

test("listJournals names every journal and ignores anything that is not one", (t) => {
  const root = project(t);
  for (const slug of ["zeta", "epsilon", "a-b_c.d"]) {
    appendStep(root, slug, "worktree-created", { at: 1, branch: `task/${slug}`, defaultBranch: "main" });
  }
  fs.writeFileSync(path.join(directory(root), ".zeta.json.Ai8fQ2.tmp"), "{partial");
  fs.writeFileSync(path.join(directory(root), "notes.txt"), "not a journal");
  fs.mkdirSync(path.join(directory(root), "nested.json"));
  assert.deepEqual(listJournals(root), ["a-b_c.d", "epsilon", "zeta"]);
  for (const slug of listJournals(root)) assert.equal(readJournal(root, slug)!.slug, slug);
});

test("a slug that is not a file name of its own is refused", (t) => {
  const root = project(t);
  for (const slug of ["../escape", "a/b", "", ".", "..", ".hidden", "with space"]) {
    assert.throws(() => appendStep(root, slug, "committed", { branch: "task/x", defaultBranch: "main" }), /slug/, slug);
    assert.throws(() => readJournal(root, slug), /slug/, slug);
  }
  assert.equal(fs.existsSync(directory(root)) && fs.readdirSync(directory(root)).length > 0, false);
});

test("a damaged journal is named rather than silently replaced", (t) => {
  const root = project(t);
  appendStep(root, "eta", "worktree-created", { at: 1, branch: "task/eta", defaultBranch: "main" });
  fs.writeFileSync(file(root, "eta"), "{not json");
  assert.throws(() => readJournal(root, "eta"), (error: Error) => error.message.includes(file(root, "eta")));
  assert.throws(() => appendStep(root, "eta", "committed", { at: 2 }), (error: Error) => error.message.includes(file(root, "eta")));
  fs.writeFileSync(file(root, "eta"), JSON.stringify({ slug: "eta", branch: "task/eta", defaultBranch: "main", steps: "none" }));
  assert.throws(() => readJournal(root, "eta"), /steps/);
});
