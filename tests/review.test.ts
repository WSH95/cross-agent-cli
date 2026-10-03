import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { create, update } from "../src/ledger.ts";
import { groupAlive, identityOf } from "../src/process.ts";
import { markSetup, reviewHold, setupMarkerPath, setupRunning, verdictOf } from "../src/review.ts";
import { poll, track } from "./helpers/project.ts";

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
