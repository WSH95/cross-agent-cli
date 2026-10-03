import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { builtInModesDir, CONSULT_ROLE, declaresWorktreeProvider, describeMode, findRole, gitPolicy, loadMode } from "../src/modes.ts";
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
  // The declared roles; the built-in `consult` role every mode gains is its own test.
  assert.deepEqual(mode.roles.slice(0, 2), [
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

// @anchor loadmodeRefusesMode
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

// @anchor loadmodeRefusesDocument
test("loadMode refuses every document it cannot trust, naming the field and the rule", (t) => {
  const modes = modesRoot(t);
  const roles = [{ key: "planner" }, { key: "implementer", workspace: "worktree" as const }];
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    // The identity is the directory: a mode copied under another name is a different mode.
    [modeDocument("other", roles) as Record<string, unknown>, /id/],
    [modeDocument("m", roles, { unexpected: "field" }), /unexpected/],
    [modeDocument("m", roles, { roles: [] }), /roles/],
    [modeDocument("m", [{ key: "planner" }, { key: "planner" }]), /declared twice/],
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
    // A role key names a config entry, a prompt file and a record's role, so it is one
    // path segment of a small alphabet.
    [modeDocument("m", [{ key: "Planner" }]), /roles\.Planner\.key/],
    [modeDocument("m", [{ key: "plan reviewer" }]), /key/],
    [modeDocument("m", [{ key: "../escape" }]), /key/],
    [modeDocument("m", roles, {
      git: { worktreeDir: ".worktrees", branchPattern: "task /*" },
      roles: [{ key: "i", title: "I", promptFile: "roles/i.md", workspace: { kind: "worktree", branchPattern: "task /*", dir: ".worktrees" }, sandboxDefault: "read-only" }],
    }), /branchPattern/],
    // A worktree directory that climbs out of the project by another spelling.
    [modeDocument("m", roles, {
      git: { worktreeDir: "trees/../..", branchPattern: "task/*" },
      roles: [{ key: "i", title: "I", promptFile: "roles/i.md", workspace: { kind: "worktree", branchPattern: "task/*", dir: "trees/../.." }, sandboxDefault: "read-only" }],
    }), /dir/],
    // Unknown fields inside every object the document nests, not only at its top.
    [modeDocument("m", roles, { lead: { placement: "host", extra: 1 } }), /lead\.extra/],
    [modeDocument("m", roles, { requires: { engines: [], extra: 1 } }), /requires\.extra/],
    [modeDocument("m", roles, { git: { worktreeDir: ".worktrees", branchPattern: "task/*", extra: 1 } }), /git\.extra/],
    [modeDocument("m", roles, {
      roles: [{ key: "p", title: "P", promptFile: "roles/p.md", workspace: { kind: "root", dir: "x" }, sandboxDefault: "read-only" }],
    }), /workspace\.dir/],
    // The two text caps no other case reaches.
    [modeDocument("m", roles, {
      // Long as a path rather than as one name, so the cap is what refuses it and not the
      // file system's own limit on a single component.
      roles: [{ key: "p", title: "P", promptFile: `roles/${"p".repeat(200)}/${"p".repeat(50)}.md`, workspace: { kind: "root" }, sandboxDefault: "read-only" }],
    }), /promptFile/],
    [modeDocument("m", roles, {
      git: { worktreeDir: "w".repeat(201), branchPattern: "task/*" },
      roles: [{ key: "i", title: "I", promptFile: "roles/i.md", workspace: { kind: "worktree", branchPattern: "task/*", dir: "w".repeat(201) }, sandboxDefault: "read-only" }],
    }), /dir/],
  ];
  for (const [document, expected] of cases) {
    writeMode(modes, "m", document);
    assert.match(refusal(modes, "m"), expected, JSON.stringify(document).slice(0, 160));
    fs.rmSync(path.join(modes, "m"), { recursive: true, force: true });
  }
});

// @anchor loadmodeRefusesPrompt
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

// @anchor worktreeDirectoryProject
test("a worktree directory the project needs for itself is not one a role may work in", (t) => {
  const modes = modesRoot(t);
  for (const dir of [".", "./", ".cross-agent", ".cross-agent/trees", ".git", ".git/worktrees"]) {
    writeMode(modes, "m", modeDocument("m", [{ key: "i", workspace: "worktree" }], {
      git: { worktreeDir: dir, branchPattern: "task/*" },
      roles: [{ key: "i", title: "I", promptFile: "roles/i.md", workspace: { kind: "worktree", branchPattern: "task/*", dir }, sandboxDefault: "read-only" }],
    }));
    // The project root itself holds the ledger and the config, and `.git` is the
    // repository: a worktree the implementer can write must be neither.
    assert.match(refusal(modes, "m"), /dir/, dir);
    fs.rmSync(path.join(modes, "m"), { recursive: true, force: true });
  }
});

// @anchor enginePlacedLead
test("an engine-placed lead is a role that works at the project root", (t) => {
  const modes = modesRoot(t);
  writeMode(modes, "m", modeDocument("m", [{ key: "lead", workspace: "worktree", sandboxDefault: "read-only" }, { key: "planner" }], {
    lead: { placement: "engine", role: "lead" },
  }));
  // The lead model gives an engine lead `git_root` and `run_command` precisely because it
  // is read-only at the root; a lead inside one task's worktree could not run the loop.
  const reason = refusal(modes, "m");
  assert.match(reason, /lead\.role/);
  assert.match(reason, /root/);

  writeMode(modes, "ok", modeDocument("ok", [{ key: "lead" }, { key: "planner" }], {
    lead: { placement: "engine", role: "lead" },
  }));
  assert.equal(loadMode(modes, "ok").lead.role, "lead");
});

// @anchor loopFileContained
test("the loop file is contained and readable like every prompt file, at load", (t) => {
  const modes = modesRoot(t);
  const outside = path.join(modes, "outside.md");
  fs.writeFileSync(outside, "A loop the mode does not own.\n");

  // Missing: a mode with no loop would load at start and fail only at the launcher's
  // first call, which is the one call that must not fail half-way.
  writeMode(modes, "m", modeDocument("m", [{ key: "planner" }]), { loop: null });
  assert.match(refusal(modes, "m"), /SKILL\.md/);

  // A symlink out of the mode is the same escape as a `..` in a prompt file name.
  fs.symlinkSync(outside, path.join(modes, "m", "SKILL.md"));
  assert.match(refusal(modes, "m"), /SKILL\.md/);

  // A directory where the file belongs.
  fs.rmSync(path.join(modes, "m"), { recursive: true, force: true });
  writeMode(modes, "m", modeDocument("m", [{ key: "planner" }]), { loop: null });
  fs.mkdirSync(path.join(modes, "m", "SKILL.md"));
  assert.match(refusal(modes, "m"), /SKILL\.md/);

  // The resolved path is kept on the mode, and it is the file `describeMode` reads.
  fs.rmSync(path.join(modes, "m"), { recursive: true, force: true });
  writeMode(modes, "m", modeDocument("m", [{ key: "planner" }]), { loop: "The loop.\n" });
  const mode = loadMode(modes, "m");
  assert.equal(mode.loopFile, path.join(mode.dir, "SKILL.md"));
  const described = describeMode(modes, "m");
  assert.ok(!("reason" in described));
  assert.equal(described.loop, "The loop.\n");
});

// @anchor promptFileDirectory
test("a prompt file that is a directory is refused at load, not read at description", (t) => {
  const modes = modesRoot(t);
  writeMode(modes, "m", modeDocument("m", [{ key: "planner" }]), { prompts: { planner: null } });
  fs.mkdirSync(path.join(modes, "m", "roles", "planner.md"));
  assert.match(refusal(modes, "m"), /roles\.planner\.promptFile/);
});

// @anchor modeDirectorySymlink
test("a mode directory that is a symlink out of the shelf is not a mode of that shelf", (t) => {
  const modes = modesRoot(t);
  const elsewhere = modesRoot(t);
  writeMode(elsewhere, "smuggled", modeDocument("smuggled", [{ key: "planner" }]));
  fs.symlinkSync(path.join(elsewhere, "smuggled"), path.join(modes, "smuggled"));
  // The shelf is what `describe_mode` serves from, and a mode outside it is not text this
  // build ships whatever the directory entry says.
  assert.match(refusal(modes, "smuggled"), /modes/);
});

// @anchor modeCarriesBuilt
test("every mode carries the built-in consult role, which a mode may retitle and reprompt alone", (t) => {
  const modes = modesRoot(t);
  // A mode that says nothing about it still has it: read-only at the project root, with
  // this build's own text rather than a file of the mode's, listed after the mode's own
  // roles (design, "Modes").
  writeMode(modes, "team", modeDocument("team", [{ key: "planner" }, { key: "implementer", workspace: "worktree" }]));
  const team = loadMode(modes, "team");
  assert.deepEqual(team.roles.map((role) => role.key), ["planner", "implementer", CONSULT_ROLE]);
  const consult = findRole(team, CONSULT_ROLE);
  assert.ok(consult);
  assert.deepEqual(consult.workspace, { kind: "root" });
  assert.equal(consult.sandboxDefault, "read-only");
  assert.equal(consult.title, "Consultant");
  assert.equal(consult.promptFile, undefined, "a built-in role carries its own text, not a file the mode owns");
  assert.match(consult.prompt ?? "", /read-only/);
  const described = describeMode(modes, "team");
  assert.ok(!("reason" in described), JSON.stringify(described));
  assert.deepEqual(described.roles.map((role) => role.key), ["planner", "implementer", CONSULT_ROLE]);
  assert.equal(described.roles[2].prompt, consult.prompt, "the built-in text is served where a prompt file would be read");

  // A mode that declares it keeps its own title and its own prompt file, and the role is
  // where the mode declared it rather than appended.
  writeMode(modes, "own", modeDocument("own", [{ key: CONSULT_ROLE, title: "House critic" }, { key: "planner" }]), {
    prompts: { consult: "Read this project and answer the brief.\n" },
  });
  const own = loadMode(modes, "own");
  assert.deepEqual(own.roles.map((role) => [role.key, role.title, role.promptFile]), [
    [CONSULT_ROLE, "House critic", "roles/consult.md"],
    ["planner", "planner", "roles/planner.md"],
  ]);
  assert.equal(findRole(own, CONSULT_ROLE)?.prompt, undefined);
  const describedOwn = describeMode(modes, "own");
  assert.ok(!("reason" in describedOwn), JSON.stringify(describedOwn));
  assert.equal(describedOwn.roles[0].prompt, "Read this project and answer the brief.\n");
});

// @anchor declaredConsultRole
test("a declared consult role that is not read-only at the project root is refused", (t) => {
  const modes = modesRoot(t);
  // The two things a mode may not change about it. Each names the rule rather than the
  // generic one, because a mode author is overriding a role this build supplies.
  writeMode(modes, "m", modeDocument("m", [{ key: CONSULT_ROLE, workspace: "worktree" }]));
  assert.match(refusal(modes, "m"), /roles\.consult\.workspace: .*title and prompt/);
  writeMode(modes, "n", modeDocument("n", [{ key: CONSULT_ROLE, sandboxDefault: "off" }]));
  assert.match(refusal(modes, "n"), /roles\.consult\.sandboxDefault: .*title and prompt/);
});

/** A worktree role's own document, with `extra` fields over it: a shape `modeDocument` would not write. */
function worktreeRole(key: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    key, title: key, promptFile: `roles/${key}.md`,
    workspace: { kind: "worktree", branchPattern: "task/*", dir: ".worktrees" }, sandboxDefault: "read-only", ...extra,
  };
}

// @anchor roleSeats
test("loadMode reads a role's seats: many where declared, nothing where not, and refuses any other value", (t) => {
  const modes = modesRoot(t);
  writeMode(modes, "m", modeDocument("m", [
    { key: "planner" }, { key: "reviewer", workspace: "worktree", sandboxDefault: "read-only", seats: "many" },
  ]));
  const mode = loadMode(modes, "m");
  // How many of a role may sit is the mode's fact, as where it works is: config binds a
  // list of seats only to a role marked so.
  assert.equal(findRole(mode, "reviewer")?.seats, "many");
  assert.equal(Object.hasOwn(findRole(mode, "planner")!, "seats"), false, "an unmarked role seats one and carries no key");

  for (const seats of ["one", 2, true]) {
    writeMode(modes, "n", modeDocument("n", [{ key: "planner" }], { roles: [worktreeRole("reviewer", { seats })], git: { worktreeDir: ".worktrees", branchPattern: "task/*" } }));
    assert.match(refusal(modes, "n"), /roles\.reviewer\.seats/, JSON.stringify(seats));
    fs.rmSync(path.join(modes, "n"), { recursive: true, force: true });
  }
});

// @anchor leadSeatsOne
test("an engine-placed lead seats one, and so does the built-in consult", (t) => {
  const modes = modesRoot(t);
  // One lead runs one loop: a lead role bound to a list would be several sessions each
  // believing it owns the run.
  writeMode(modes, "led", modeDocument("led", [{ key: "lead" }, { key: "planner" }], {
    lead: { placement: "engine", role: "lead" },
    roles: [
      { key: "lead", title: "Lead", promptFile: "roles/lead.md", workspace: { kind: "root" }, sandboxDefault: "read-only", seats: "many" },
      { key: "planner", title: "Planner", promptFile: "roles/planner.md", workspace: { kind: "root" }, sandboxDefault: "read-only" },
    ],
  }));
  const lead = refusal(modes, "led");
  assert.match(lead, /lead\.role/);
  assert.match(lead, /one session running one loop/);

  // The consultant is the one role every mode carries, and a mode may retitle it alone.
  writeMode(modes, "consulting", modeDocument("consulting", [{ key: "planner" }], {
    roles: [{ key: "consult", title: "Consultant", promptFile: "roles/consult.md", workspace: { kind: "root" }, sandboxDefault: "read-only", seats: "many" }],
  }));
  assert.match(refusal(modes, "consulting"), /roles\.consult\.seats: .*seats one.*title and prompt/);
});

// @anchor roleGates
test("a role gates the merge only from a worktree, and gates nothing else", (t) => {
  const modes = modesRoot(t);
  const gitPolicy = { git: { worktreeDir: ".worktrees", branchPattern: "task/*" } };
  writeMode(modes, "m", modeDocument("m", [{ key: "reviewer", workspace: "worktree", sandboxDefault: "read-only", gates: "merge" }]));
  // The role whose finished reviews of a branch head the merge reads (`src/review.ts`).
  assert.equal(findRole(loadMode(modes, "m"), "reviewer")?.gates, "merge");
  assert.equal(Object.hasOwn(findRole(loadMode(modes, "m"), "consult")!, "gates"), false);

  const cases: Array<[Record<string, unknown>, RegExp]> = [
    // A root role reads the whole project, and the merge is held to reviews of a branch.
    [modeDocument("n", [{ key: "planner" }], {
      roles: [{ key: "planner", title: "P", promptFile: "roles/planner.md", workspace: { kind: "root" }, sandboxDefault: "read-only", gates: "merge" }],
    }), /roles\.planner\.gates: a role that gates the merge reviews a task branch in its worktree; planner works at the root/],
    // An engine-placed lead works at the root, so the same rule holds it.
    [modeDocument("n", [{ key: "lead" }], {
      lead: { placement: "engine", role: "lead" },
      roles: [{ key: "lead", title: "L", promptFile: "roles/lead.md", workspace: { kind: "root" }, sandboxDefault: "read-only", gates: "merge" }],
    }), /roles\.lead\.gates/],
    [modeDocument("n", [{ key: "consult" }], {
      roles: [{ key: "consult", title: "C", promptFile: "roles/consult.md", workspace: { kind: "root" }, sandboxDefault: "read-only", gates: "merge" }],
    }), /roles\.consult\.gates/],
    [modeDocument("n", [{ key: "reviewer" }], { roles: [worktreeRole("reviewer", { gates: "x" })], ...gitPolicy }), /roles\.reviewer\.gates/],
  ];
  for (const [document, expected] of cases) {
    writeMode(modes, "n", document);
    assert.match(refusal(modes, "n"), expected, JSON.stringify(document.roles));
    fs.rmSync(path.join(modes, "n"), { recursive: true, force: true });
  }
});

test("a mode with no worktree role still has the git policy its one-shots use, marked implicit", (t) => {
  const modes = modesRoot(t);
  writeMode(modes, "rootish", modeDocument("rootish", [{ key: "solo" }]));
  const rootOnly = loadMode(modes, "rootish");
  // Nothing is declared, so nothing registers the worktree provider; the policy a
  // `delegate` one-shot creates its worktree under is this build's own (design, "Modes").
  assert.equal(rootOnly.git, undefined);
  assert.equal(declaresWorktreeProvider(rootOnly), false);
  assert.deepEqual(gitPolicy(rootOnly), { worktreeDir: ".worktrees", branchPattern: "task/*", implicit: true });

  writeMode(modes, "team", modeDocument("team", [{ key: "implementer", workspace: "worktree" }]));
  const team = loadMode(modes, "team");
  assert.deepEqual(gitPolicy(team), { worktreeDir: ".worktrees", branchPattern: "task/*" },
    "a mode that declares one is held to it, and nothing is implicit about it");
});

// @anchor devTeamModes
test("the two dev-team modes carry the same role prompts, byte for byte", () => {
  const modes = builtInModesDir();
  for (const key of ["planner", "plan-reviewer", "implementer", "code-reviewer", "resolver"]) {
    assert.equal(
      fs.readFileSync(path.join(modes, "dev-team-engine", "roles", `${key}.md`), "utf8"),
      fs.readFileSync(path.join(modes, "dev-team", "roles", `${key}.md`), "utf8"),
      `${key}: the engine-placed team's specialists are the host-placed team's; step 9 generates both from one source`,
    );
  }
});

// @anchor builtInModesValidate
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
    ["resolver", "worktree", "workspace-write"],
    ["consult", "root", "read-only"],
  ]);
  assert.deepEqual(devTeam.git, { worktreeDir: ".worktrees", branchPattern: "task/*" });

  const solo = loadMode(modes, "solo");
  assert.deepEqual(solo.roles.map((role) => [role.key, role.workspace.kind, role.sandboxDefault]), [["consult", "root", "read-only"]]);
  assert.equal(solo.git, undefined);
  assert.equal(declaresWorktreeProvider(solo), false, "no role of it works in a worktree, which is what git.implicit reports");

  const engine = loadMode(modes, "dev-team-engine");
  assert.deepEqual(engine.lead, { placement: "engine", role: "lead" });
  assert.deepEqual(engine.roles.map((role) => role.key), ["lead", "planner", "plan-reviewer", "implementer", "code-reviewer", "resolver", "consult"]);
  assert.deepEqual(findRole(engine, "lead")?.workspace, { kind: "root" }, "an engine lead is read-only at the root");
  assert.equal(findRole(engine, "lead")?.sandboxDefault, "read-only");

  // Both team modes seat the code reviewer many times, and its reviews gate the merge.
  for (const team of [devTeam, engine]) {
    assert.equal(findRole(team, "code-reviewer")?.seats, "many", team.id);
    assert.equal(findRole(team, "code-reviewer")?.gates, "merge", team.id);
    assert.deepEqual(team.roles.filter((role) => role.seats !== undefined || role.gates !== undefined).map((role) => role.key), ["code-reviewer"], team.id);
  }
});

// @anchor describemodeReturnsLoop
test("describeMode returns the loop and every role prompt verbatim, with no file copied", (t) => {
  const modes = modesRoot(t);
  const loop = "# The loop\n\nWhat this mode's lead does, in its own words.\n";
  const prompt = "You are the planner.\n\nRead at the root and report a plan.\n";
  writeMode(modes, "m", modeDocument("m", [
    { key: "planner" }, { key: "implementer", workspace: "worktree" },
    { key: "reviewer", workspace: "worktree", sandboxDefault: "read-only", seats: "many", gates: "merge" },
  ]), {
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
  // `seats` and `gates` reach a launcher only where the mode declares them.
  for (const key of ["seats", "gates"]) assert.equal(Object.hasOwn(described.roles[1], key), false, key);
  assert.deepEqual(described.roles[2], {
    key: "reviewer", title: "reviewer", workspace: { kind: "worktree", branchPattern: "task/*", dir: ".worktrees" },
    sandboxDefault: "read-only", seats: "many", gates: "merge",
    prompt: fs.readFileSync(path.join(modes, "m", "roles", "reviewer.md"), "utf8"),
  });
  assert.deepEqual(described.git, { worktreeDir: ".worktrees", branchPattern: "task/*" });
  // Nothing is written anywhere: the mode directory holds what it held.
  assert.deepEqual(fs.readdirSync(path.join(modes, "m")).sort(), ["SKILL.md", "mode.json", "roles"]);

  const described3 = describeMode(builtInModesDir(), "solo");
  assert.ok(!("reason" in described3));
  assert.deepEqual(described3.git, { worktreeDir: ".worktrees", branchPattern: "task/*", implicit: true },
    "a mode with no worktree role describes the policy its one-shots use, as implicit");
  assert.ok(described3.loop.length > 0);
});

// @anchor describemodeAnswersMissing
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
