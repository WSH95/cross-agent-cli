import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendStep, readJournal } from "../src/journal.ts";
import { create, update } from "../src/ledger.ts";
import { acquire, gitLockName, lockPath } from "../src/locks.ts";
import { groupAlive, identityOf } from "../src/process.ts";
import { markSetup, reviewHold, setupMarkerPath, setupRunning, verdictOf, waiveReview } from "../src/review.ts";
import { git, holdersOf } from "./helpers/git.ts";
import { poll, project, track } from "./helpers/project.ts";

// The merge's review guard reads what the server wrote — the result a review ended on, the
// records of the reviews still running, the marker a running setup left — and never a
// lead's account of any of them (design section 4).

function scratch(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "cross-agent-review-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("verdictOf reads the last non-empty line and nothing else", () => {
  assert.equal(verdictOf("Two findings, both minor.\n\nVERDICT: no major issues\n\n\n"), "no major issues");
  assert.equal(verdictOf("VERDICT: major issues"), "major issues");
  assert.equal(verdictOf("The base moved.\nVERDICT: needs rebase\n"), "needs rebase");
  assert.equal(verdictOf("Wrong approach.\r\n  VERDICT: discard  \r\n"), "discard", "the line's own surrounding blanks are set aside");
  // A verdict quoted mid-text is not the one the review ends on, and nothing else is a verdict.
  assert.equal(verdictOf("VERDICT: no major issues\nbut on reflection, one more thing.\n"), null);
  assert.equal(verdictOf("Looks fine.\nVERDICT: ok\n"), null);
  assert.equal(verdictOf("**VERDICT: no major issues**\n"), null);
  assert.equal(verdictOf(""), null);
  assert.equal(verdictOf("\n \n"), null);
});

test("reviewHold names an active gating review on that worktree and nothing settled, read-only or elsewhere", async (t) => {
  const root = scratch(t);
  const worktree = path.join(root, ".worktrees", "held");
  const elsewhere = path.join(root, ".worktrees", "other");
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  const head = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(reviewHold(root, worktree), null, "an empty ledger holds nothing");

  // A read-only task on the worktree that reviews nothing for the merge, and a review of another one.
  const reader = create(root, { role: "consult", brief: "read", cwd: worktree, engine: "codex" });
  await update(root, reader.id, { status: "running" });
  const other = create(root, { role: "code-reviewer", brief: "review", cwd: elsewhere, engine: "codex", underReview: head });
  await update(root, other.id, { status: "running" });
  assert.equal(reviewHold(root, worktree), null);

  const review = create(root, { role: "code-reviewer", brief: "review", cwd: worktree, engine: "codex", seat: 1, underReview: head });
  assert.equal(reviewHold(root, worktree), `${worktree} is under review by task ${review.id} (launching) at ${head}; wait or cancel first`);
  await update(root, review.id, { status: "running" });
  assert.match(reviewHold(root, worktree)!, new RegExp(`task ${review.id} \\(running\\)`));
  // A settled review has let it go.
  await update(root, review.id, { status: "done" });
  assert.equal(reviewHold(root, worktree), null);
});

// @anchor setupMarker
test("setupRunning holds while the marker's group lives, clears a marker whose group is gone, and names a marker it cannot read", async (t) => {
  const root = scratch(t);
  const worktree = path.join(root, ".worktrees", "set-up");
  fs.mkdirSync(worktree, { recursive: true });
  assert.equal(setupRunning(root, worktree), null, "no marker holds nothing");

  // A setup command is a detached group leader, as `run_command` starts one.
  const child = track(t, spawn("sleep", ["60"], { detached: true, stdio: "ignore" }));
  const identity = identityOf(child.pid!);
  assert.ok(identity);
  const file = markSetup(root, worktree, "set-up", identity);
  assert.equal(file, setupMarkerPath(root, worktree));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    pid: identity.pid, startTime: identity.startTime, bootId: identity.bootId, pgid: identity.pid,
    workTree: worktree, slug: "set-up", at: JSON.parse(fs.readFileSync(file, "utf8")).at,
  });
  assert.equal(setupRunning(root, worktree),
    `the setup command of task set-up is running in ${worktree} (process group ${identity.pid}); wait for it, or end that group`);
  assert.equal(setupRunning(root, path.join(root, ".worktrees", "elsewhere")), null, "a marker holds its own worktree alone");

  // The group ends: the marker holds nothing, and the reader clears it.
  process.kill(-child.pid!, "SIGKILL");
  await poll(() => groupAlive({ ...identity, pgid: identity.pid }), (alive) => !alive);
  assert.equal(setupRunning(root, worktree), null);
  assert.equal(fs.existsSync(file), false);

  // A marker nobody can read may still be a setup's, so it holds, by name.
  fs.writeFileSync(file, "{not json");
  const unread = setupRunning(root, worktree);
  assert.ok(unread !== null && unread.includes(file), unread ?? "null");
  assert.equal(fs.existsSync(file), true);
});

/** A team project with a two-seat reviewer and a task worktree `x` whose journal is open. */
async function waivable(t: TestContext, afterResolver = "ask"): Promise<{ root: string; worktree: string; head: string }> {
  const created = await project(t, {
    roles: { reviewer: [{ engine: "grok" }, { engine: "codex" }] }, review: { afterResolver },
  }, [{ key: "reviewer", workspace: "worktree", sandboxDefault: "read-only", seats: "many", gates: "merge" }]);
  const worktree = await created.worktree("task/x", "x");
  const head = await git(worktree, "rev-parse", "HEAD");
  appendStep(created.root, "x", "worktree-created", { before: head, after: head, branch: "task/x", worktree, defaultBranch: "main" });
  return { root: created.root, worktree, head };
}

test("waiveReview refuses a slug with no journal, a closed journal, a commit that is not the branch head, and an abbreviation under seven characters, and records the full head", async (t) => {
  const { root, head } = await waivable(t);
  const by = ["operator", "cli"] as const;
  const waive = (slug: string, commit: string) => waiveReview(root, { slug, commit, by: [...by] }, { waitSeconds: 5 });
  const refusalOf = async (slug: string, commit: string) => {
    const answer = await waive(slug, commit);
    assert.equal(answer.ok, false, JSON.stringify(answer));
    return (answer as { reason: string }).reason;
  };
  assert.match(await refusalOf("nobody", head), /slug nobody has no journal/);
  assert.match(await refusalOf("x", head.slice(0, 6)), /hex of at least 7 characters/);
  assert.match(await refusalOf("x", "zzzzzzz"), /hex of at least 7 characters/);
  const other = "0".repeat(40);
  assert.match(await refusalOf("x", other), new RegExp(`the branch task/x is at ${head}, which ${other} does not name; a waiver names the branch head as it stands`));
  assert.equal(readJournal(root, "x")!.steps.length, 1, "no refusal journaled anything");

  // An abbreviation of the head names it, and the step records the head whole.
  const waived = await waive("x", head.slice(0, 7));
  assert.equal(waived.ok, true, JSON.stringify(waived));
  const step = (waived as { journal: { step: string; before?: string; after?: string; args?: string[] } }).journal;
  assert.deepEqual([step.step, step.before, step.after, step.args], ["review-waived", head, head, ["operator", "cli"]]);
  assert.equal(readJournal(root, "x")!.steps.at(-1)!.step, "review-waived");

  // A journal its merge or its branch's deletion closed takes no waiver.
  for (const closing of ["merged", "branch-deleted"] as const) {
    appendStep(root, "x", closing, { before: head, after: head });
    assert.match(await refusalOf("x", head), new RegExp(closing));
  }
});

// @anchor waiverRevalidatesUnderLock
test("a waiver re-reads the head under git.lock and refuses when the branch moved while it waited", async (t) => {
  for (const lead of [false, true]) {
    const { root, worktree, head } = await waivable(t, lead ? "lead-decides" : "ask");
    if (lead) {
      // A complete round at the old head, as the lead row's own rule asks before it waives.
      for (const seat of [1, 2]) {
        const record = create(root, { role: "reviewer", brief: `review ${seat}`, cwd: worktree, engine: "grok", seat, underReview: head });
        await update(root, record.id, { status: "running" });
        await update(root, record.id, { status: "done" });
        fs.writeFileSync(record.resultPath, "VERDICT: major issues\n");
      }
    }
    const { loadConfig } = await import("../src/config.ts");
    const held = await acquire(lockPath(root, gitLockName()), { operation: "a test holding git.lock", waitSeconds: 5 });
    t.after(() => held.release());
    const pending = waiveReview(root, { slug: "x", commit: head, by: lead ? ["lead", "a-lead-task"] : ["operator", "tool"] },
      { waitSeconds: 30, ...(lead ? { lead: { config: loadConfig(root), role: "reviewer" } } : {}) });
    await poll(() => holdersOf(lockPath(root, gitLockName())).length, (count) => count >= 2);
    await git(worktree, "commit", "--allow-empty", "-m", "the branch moves while the waiver waits");
    const moved = await git(worktree, "rev-parse", "HEAD");
    await held.release();
    const answer = await pending;
    assert.equal(answer.ok, false, JSON.stringify(answer));
    const reason = (answer as { reason: string }).reason;
    assert.ok(reason.includes(moved) && reason.includes(head), reason);
    assert.equal(readJournal(root, "x")!.steps.some((step) => step.step === "review-waived"), false, lead ? "lead" : "operator");
  }
});
