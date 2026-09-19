import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { builtInModesDir, declaresWorktreeProvider, describeMode, findRole, loadMode } from "../src/modes.ts";
import { modeDocument, modesRoot, writeMode } from "./helpers/mode.ts";

// A mode is portable text: everything a team needs except which engine runs which role.
// The loader is hand-written like `src/config.ts`, so every rule it enforces is named
// here, with the refusal a mode author reads.

function refusal(modesDir: string, name: string): string {
  try {
    loadMode(modesDir, name);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail(`loadMode(${name}) was expected to refuse`);
}

test("loadMode reads a mode's identity, lead, roles, git policy and requirements", (t) => {
  const modes = modesRoot(t);
  writeMode(modes, "dev-team-like", modeDocument("dev-team-like", [
    { key: "planner", title: "Planner" },
    { key: "implementer", workspace: "worktree" },
  ], { requires: { engines: ["codex"] } }));

  const mode = loadMode(modes, "dev-team-like");
  assert.equal(mode.id, "dev-team-like");
  assert.equal(mode.release, "0.1.0");
  assert.deepEqual(mode.lead, { placement: "host" });
  assert.deepEqual(mode.roles, [
    {
      key: "planner", title: "Planner", promptFile: "roles/planner.md",
      workspace: { kind: "root" }, sandboxDefault: "read-only",
    },
    {
      key: "implementer", title: "implementer", promptFile: "roles/implementer.md",
      workspace: { kind: "worktree", branchPattern: "task/*", dir: ".worktrees" }, sandboxDefault: "workspace-write",
    },
  ]);
  assert.deepEqual(mode.git, { worktreeDir: ".worktrees", branchPattern: "task/*" });
  assert.deepEqual(mode.requires, { engines: ["codex"] });
  assert.equal(mode.dir, path.join(modes, "dev-team-like"));
  // The two questions every caller asks of a mode: does it register the worktree
  // provider, and what does it say about this role.
  assert.equal(declaresWorktreeProvider(mode), true);
  assert.equal(findRole(mode, "implementer")?.title, "implementer");
  assert.equal(findRole(mode, "nobody"), undefined);

  writeMode(modes, "rootish", modeDocument("rootish", [{ key: "solo" }]));
  const rootOnly = loadMode(modes, "rootish");
  assert.equal(rootOnly.git, undefined);
  assert.equal(declaresWorktreeProvider(rootOnly), false);
  assert.deepEqual(rootOnly.requires, { engines: [] });
});

test("loadMode refuses a mode nothing can read, naming the mode and its directory", (t) => {
  const modes = modesRoot(t);
  const missing = refusal(modes, "absent");
  assert.match(missing, /absent/);
  assert.match(missing, new RegExp(path.join(modes, "absent").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  writeMode(modes, "broken", "{not json");
  assert.match(refusal(modes, "broken"), /mode\.json/);
  // A name that is not one directory under the shelf never reaches the file system: it
  // would resolve somewhere the modes directory does not own.
  for (const name of ["", ".", "..", "../elsewhere", "dev/team", "/etc"]) {
    assert.match(refusal(modes, name), /one directory/, name);
  }
});

test("loadMode refuses every document it cannot trust, naming the field and the rule", (t) => {
  const modes = modesRoot(t);
  const roles = [{ key: "planner" }, { key: "implementer", workspace: "worktree" as const }];
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    // The identity is the directory: a mode copied under another name is a different mode.
    [modeDocument("other", roles) as Record<string, unknown>, /id/],
    [modeDocument("m", roles, { unexpected: "field" }), /unexpected/],
    [modeDocument("m", roles, { roles: [] }), /roles/],
    [modeDocument("m", [{ key: "planner" }, { key: "planner" }]), /planner/],
    [modeDocument("m", roles, {
      roles: [{ key: "planner", title: "P", promptFile: "roles/planner.md", workspace: { kind: "root" }, sandboxDefault: "read-only", extra: 1 }],
    }), /extra/],
    // `lead.role` exactly when the loop runs in a spawned engine.
    [modeDocument("m", roles, { lead: { placement: "engine" } }), /lead\.role/],
    [modeDocument("m", roles, { lead: { placement: "host", role: "planner" } }), /lead\.role/],
    [modeDocument("m", roles, { lead: { placement: "engine", role: "nobody" } }), /nobody/],
    [modeDocument("m", roles, { lead: { placement: "sideways" } }), /lead\.placement/],
    // No role may combine the project root with a sandbox that can write to it.
    [modeDocument("m", [{ key: "planner", sandboxDefault: "workspace-write" }]), /read-only/],
    [modeDocument("m", [{ key: "planner", sandboxDefault: "off" }]), /read-only/],
    [modeDocument("m", [{ key: "planner", sandboxDefault: "no-such-profile" }]), /sandboxDefault/],
    // Two workspace kinds and no others (design, "Not built": arbitrary paths).
    [modeDocument("m", roles, { roles: [{ key: "p", title: "P", promptFile: "roles/p.md", workspace: { kind: "anywhere" }, sandboxDefault: "read-only" }] }), /workspace/],
    [modeDocument("m", roles, { roles: [{ key: "p", title: "P", promptFile: "roles/p.md", workspace: { kind: "worktree", dir: ".worktrees" }, sandboxDefault: "read-only" }] }), /branchPattern/],
    [modeDocument("m", roles, { git: undefined }), /git/],
    [modeDocument("m", [{ key: "planner" }], { git: { worktreeDir: ".worktrees", branchPattern: "task/*" } }), /git/],
    [modeDocument("m", roles, { git: { worktreeDir: "elsewhere", branchPattern: "task/*" } }), /worktreeDir/],
    [modeDocument("m", roles, { git: { worktreeDir: ".worktrees", branchPattern: "work/*" } }), /branchPattern/],
    // The slug fills the star, so there has to be exactly one; the directory is inside
    // the project, because section 4's containment is written for a linked worktree there.
    [modeDocument("m", roles, {
      git: { worktreeDir: ".worktrees", branchPattern: "task/" },
      roles: [{ key: "i", title: "I", promptFile: "roles/i.md", workspace: { kind: "worktree", branchPattern: "task/", dir: ".worktrees" }, sandboxDefault: "read-only" }],
    }), /branchPattern/],
    [modeDocument("m", roles, {
      git: { worktreeDir: "/tmp", branchPattern: "task/*" },
      roles: [{ key: "i", title: "I", promptFile: "roles/i.md", workspace: { kind: "worktree", branchPattern: "task/*", dir: "/tmp" }, sandboxDefault: "read-only" }],
    }), /dir/],
    [modeDocument("m", roles, { requires: { engines: ["nosuch"] } }), /requires\.engines/],
    [modeDocument("m", roles, { requires: { engines: "codex" } }), /requires\.engines/],
    // Every text field has a cap, so no mode can carry a payload through a field name.
    [modeDocument("m", roles, { name: "n".repeat(201) }), /name/],
    [modeDocument("m", roles, { summary: "s".repeat(4001) }), /summary/],
    [modeDocument("m", roles, { release: "r".repeat(33) }), /release/],
    [modeDocument("m", roles, { id: "m".repeat(65) }), /id/],
    [modeDocument("m", [{ key: "planner", title: "t".repeat(201) }]), /title/],
    [modeDocument("m", [{ key: "k".repeat(65) }]), /key/],
    [modeDocument("m", roles, { lead: null }), /lead/],
    [modeDocument("m", roles, { roles: "planner" }), /roles/],
  ];
  for (const [document, expected] of cases) {
    writeMode(modes, "m", document);
    assert.match(refusal(modes, "m"), expected, JSON.stringify(document).slice(0, 160));
    fs.rmSync(path.join(modes, "m"), { recursive: true, force: true });
  }
});

test("loadMode refuses a prompt file that is missing or resolves outside the mode", (t) => {
  const modes = modesRoot(t);
  const outside = path.join(modes, "outside.md");
  fs.writeFileSync(outside, "A prompt the mode does not own.\n");

  writeMode(modes, "m", modeDocument("m", [{ key: "planner" }]), { prompts: { planner: null } });
  assert.match(refusal(modes, "m"), /roles\.planner\.promptFile/);

  for (const promptFile of ["../outside.md", outside, "roles/../../outside.md"]) {
    writeMode(modes, "m", modeDocument("m", [{ key: "planner" }], {
      roles: [{ key: "planner", title: "P", promptFile, workspace: { kind: "root" }, sandboxDefault: "read-only" }],
    }));
    assert.match(refusal(modes, "m"), /promptFile/, promptFile);
  }
  // A symlink inside the mode pointing out of it is the same escape, and realpath is
  // what sees it.
  writeMode(modes, "m", modeDocument("m", [{ key: "planner" }]), { prompts: { planner: null } });
  fs.symlinkSync(outside, path.join(modes, "m", "roles", "planner.md"));
  assert.match(refusal(modes, "m"), /promptFile/);
});

test("the three built-in modes validate, and each declares what its loop needs", () => {
  const modes = builtInModesDir();
  assert.equal(fs.statSync(modes).isDirectory(), true);

  const devTeam = loadMode(modes, "dev-team");
  assert.deepEqual(devTeam.lead, { placement: "host" });
  assert.deepEqual(devTeam.roles.map((role) => [role.key, role.workspace.kind, role.sandboxDefault]), [
    ["planner", "root", "read-only"],
    ["plan-reviewer", "root", "read-only"],
    ["implementer", "worktree", "workspace-write"],
    ["code-reviewer", "worktree", "read-only"],
  ]);
  assert.deepEqual(devTeam.git, { worktreeDir: ".worktrees", branchPattern: "task/*" });

  const solo = loadMode(modes, "solo");
  assert.deepEqual(solo.roles.map((role) => [role.key, role.workspace.kind, role.sandboxDefault]), [["solo", "root", "read-only"]]);
  assert.equal(solo.git, undefined);
  assert.equal(declaresWorktreeProvider(solo), false, "solo yields a tools/list without the worktree tools");

  const engine = loadMode(modes, "dev-team-engine");
  assert.deepEqual(engine.lead, { placement: "engine", role: "lead" });
  assert.deepEqual(engine.roles.map((role) => role.key), ["lead", "planner", "plan-reviewer", "implementer", "code-reviewer"]);
  assert.deepEqual(findRole(engine, "lead")?.workspace, { kind: "root" }, "an engine lead is read-only at the root");
  assert.equal(findRole(engine, "lead")?.sandboxDefault, "read-only");
});

test("describeMode returns the loop and every role prompt verbatim, with no file copied", (t) => {
  const modes = modesRoot(t);
  const loop = "# The loop\n\nWhat this mode's lead does, in its own words.\n";
  const prompt = "You are the planner.\n\nRead at the root and report a plan.\n";
  writeMode(modes, "m", modeDocument("m", [{ key: "planner" }, { key: "implementer", workspace: "worktree" }]), {
    loop, prompts: { planner: prompt },
  });

  const described = describeMode(modes, "m");
  assert.ok(!("reason" in described), JSON.stringify(described));
  assert.deepEqual(described.mode, {
    id: "m", release: "0.1.0", name: "m", summary: "The m mode, written for a test.", lead: { placement: "host" },
  });
  // Byte for byte: the launcher reads this text, and a mode's loop is never copied into a
  // host's skill directory (design section 7).
  assert.equal(described.loop, loop);
  assert.equal(described.loop, fs.readFileSync(path.join(modes, "m", "SKILL.md"), "utf8"));
  assert.deepEqual(described.roles[0], {
    key: "planner", title: "planner", workspace: { kind: "root" }, sandboxDefault: "read-only", prompt,
  });
  assert.equal(described.roles[1].prompt, fs.readFileSync(path.join(modes, "m", "roles", "implementer.md"), "utf8"));
  assert.deepEqual(described.git, { worktreeDir: ".worktrees", branchPattern: "task/*" });
  // Nothing is written anywhere: the mode directory holds what it held.
  assert.deepEqual(fs.readdirSync(path.join(modes, "m")).sort(), ["SKILL.md", "mode.json", "roles"]);

  const described3 = describeMode(builtInModesDir(), "solo");
  assert.ok(!("reason" in described3));
  assert.equal(described3.git, undefined, "a mode with no worktree role describes no git policy");
  assert.ok(described3.loop.length > 0);
});

test("describeMode answers a missing or invalid mode with a reason rather than a throw", (t) => {
  const modes = modesRoot(t);
  const reasonOf = (name: string): string => {
    const described = describeMode(modes, name);
    assert.ok("reason" in described, `expected a refusal for ${name}`);
    return described.reason;
  };
  assert.match(reasonOf("absent"), /absent/);

  writeMode(modes, "no-loop", modeDocument("no-loop", [{ key: "planner" }]), { loop: null });
  assert.match(reasonOf("no-loop"), /SKILL\.md/);

  writeMode(modes, "invalid", modeDocument("invalid", [{ key: "planner", sandboxDefault: "off" }]));
  assert.match(reasonOf("invalid"), /read-only/);

  writeMode(modes, "no-prompt", modeDocument("no-prompt", [{ key: "planner" }]), { prompts: { planner: null } });
  assert.match(reasonOf("no-prompt"), /promptFile/);
});
