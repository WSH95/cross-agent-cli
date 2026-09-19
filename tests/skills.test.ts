import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { builtInModesDir, CONSULT_ROLE, describeMode, findRole, loadMode } from "../src/modes.ts";

// The loop a host reads for the zero-ceremony mode, and the text `describe_mode` serves
// rather than copies (design section 7). `skills/cross-agent/SKILL.md` — the launcher, the
// one skill a host loads, identical on all three — arrives with step 9 of the work plan
// and carries these same paragraphs; until it exists this is where they live.

/** The loop as one line: what it says, rather than where the paragraph wrapped. */
function soloLoop(): string {
  const described = describeMode(builtInModesDir(), "solo");
  assert.ok(!("reason" in described), JSON.stringify(described));
  return described.loop.replace(/\s+/g, " ");
}

test("the solo loop names every step a worktree one-shot settles under, and who applies them", () => {
  const loop = soloLoop();
  // The work is committed before anything merges it: a specialist writes no git metadata,
  // so what it left in the worktree is still uncommitted when its task settles.
  assert.match(loop, /git_mutate \{slug, args: \["commit"/);
  // `auto`, in order: the suite in the worktree, the fast-forward merge, the suite at the
  // root, the worktree, the branch, the report (design section 4).
  const steps = [
    'run_command {which: "test", where: <worktree path>, slug}',
    'git_root {args: ["merge", "--ff-only", "task/<id>"], slug}',
    'run_command {which: "test", where: "root", slug}',
    '"worktree", "remove"',
    '"branch", "-d"',
  ];
  let at = loop.indexOf("project.mergePolicy");
  assert.ok(at > 0, "the loop names the policy it applies");
  for (const step of steps) {
    const found = loop.indexOf(step, at);
    assert.ok(found > at, `the loop names ${step} after the step before it`);
    at = found;
  }
  assert.match(loop, /nobody merges by hand under `auto`/, "the launcher applies the policy, not the user");
  assert.match(loop, /\*\*`manual`, or any failure.{0,80}?leave the branch/, "the other half of the policy");
  assert.match(loop, /git revert --no-edit/, "and the repair path when the root suite fails after the merge");
});

test("the solo loop documents review and critique as verbs it composes, each naming its engine", () => {
  const loop = soloLoop();
  assert.match(loop, /verbs of this loop, not tools of the server/);
  assert.match(loop, /\*\*review\*\* — attach the diff/);
  assert.match(loop, /git diff <base>\.\.\.HEAD/);
  assert.match(loop, /findings by severity, each with `file:line`/);
  assert.match(loop, /\*\*critique\*\* — name the plan or design file/);
  assert.match(loop, /adversarial/);
  assert.match(loop, /each is one `delegate` that names its own engine/);
});

test("the mode that declares the consultant says exactly what the built-in role says", () => {
  const modes = builtInModesDir();
  const solo = loadMode(modes, "solo");
  const role = findRole(solo, CONSULT_ROLE);
  assert.equal(role?.promptFile, "roles/consult.md", "solo declares the role, so its own file documents it");
  const declared = fs.readFileSync(path.join(solo.dir, "roles", "consult.md"), "utf8");
  // Two copies of one role's text: the file a mode may override, and the text every mode
  // that overrides nothing is given. They say the same thing or one of them is stale.
  assert.equal(findRole(loadMode(modes, "dev-team"), CONSULT_ROLE)?.prompt, declared);
});
