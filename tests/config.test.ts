import "./child-check.mjs";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../src/config.ts";
import { adapterFor, adapters } from "../src/engines/registry.ts";
import type { EngineName } from "../src/engines/types.ts";
import { builtInModesDir, loadMode } from "../src/modes.ts";
import { buildMode, modeDocument, modesRoot } from "./helpers/mode.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDefaults = { defaultBranch: "main", testCommand: "npm test", setupCommand: "none", mergePolicy: "auto" };
const limitDefaults = {
  maxDepth: 1, stallMinutes: 15, waitDefaultSeconds: 600, duplicateWindowMinutes: 10, lockWaitSeconds: 5,
  cancelGraceSeconds: 5, planReviewRounds: 3,
};
const reviewDefaults = { afterResolver: "ask" };
const sectionSixDefaults = {
  mode: "dev-team",
  project: projectDefaults,
  roles: {
    planner: { engine: "claude", model: "claude-opus-5-5", effort: "xhigh" },
    "plan-reviewer": { engine: "codex", model: "gpt-6-astra", effort: "xhigh" },
    implementer: { engine: "claude", model: "claude-opus-5-5", effort: "xhigh" },
    // One seat per engine: a starting point the operator edits.
    "code-reviewer": [
      { engine: "claude", model: "claude-opus-5-5", effort: "xhigh", sandbox: "read-only" },
      { engine: "codex", model: "gpt-6.1-sol", effort: "xhigh", sandbox: "read-only" },
      { engine: "grok", model: "grok-4.7", effort: "xhigh", sandbox: "read-only" },
    ],
    resolver: { engine: "codex", model: "gpt-6-astra", effort: "max" },
    // The role every mode carries, bound to a starting engine this call may override.
    consult: { engine: "codex", model: "gpt-6-astra" },
  },
  engines: { claude: {}, codex: {}, grok: {} },
  limits: limitDefaults,
  review: reviewDefaults,
  billing: "subscription",
};

function project(t: TestContext, parent = tmpdir()): string {
  const root = mkdtempSync(path.join(parent, "cross-agent-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeConfig(root: string, value: unknown): string {
  const file = path.join(root, config.CONFIG_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  return file;
}

function validationError(root: string, field: string): void {
  assert.throws(() => config.loadConfig(root), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(path.join(root, config.CONFIG_PATH)), error.message);
    assert.ok(error.message.includes(field), error.message);
    return true;
  });
}

function setTmpdir(t: TestContext, value: string): void {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = value;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
}

function assertWarning(warning: string | undefined): void {
  assert.equal(typeof warning, "string");
  assert.match(warning!, /Codex/);
  assert.match(warning!, /Grok/);
  assert.match(warning!, /writable/);
  assert.match(warning!, /not isolated/);
}

test("loadConfig applies every default", (t) => {
  const root = project(t);
  writeConfig(root, { roles: { planner: { engine: "codex" } } });
  const loaded = config.loadConfig(root);
  assert.deepEqual(loaded.project, projectDefaults);
  assert.equal(loaded.mode, "dev-team", "the mode a config does not name");
  // No sandbox and no workspace: both belong to the mode, and a role that overrides
  // neither carries neither here.
  assert.deepEqual(loaded.roles, { planner: { engine: "codex" } });
  assert.deepEqual(loaded.limits, limitDefaults);
  assert.deepEqual(loaded.review, reviewDefaults);
  assert.equal(loaded.billing, "subscription");

  writeConfig(root, {
    mode: "solo",
    project: { defaultBranch: "trunk" },
    roles: { reviewer: { engine: "grok" }, helper: { engine: "claude", sandbox: "off" } },
    limits: { maxDepth: 0 },
  });
  const partial = config.loadConfig(root);
  assert.equal(partial.mode, "solo");
  assert.deepEqual(partial.project, { ...projectDefaults, defaultBranch: "trunk" });
  assert.deepEqual(partial.roles, { reviewer: { engine: "grok" }, helper: { engine: "claude", sandbox: "off" } });
  assert.deepEqual(partial.limits, { ...limitDefaults, maxDepth: 0 });
});

test("loadConfig preserves explicit values and custom or empty role maps", (t) => {
  const root = project(t);
  const explicit = {
    mode: "dev-team",
    project: { defaultBranch: "trunk", testCommand: "node --test", setupCommand: "node setup.mjs", mergePolicy: "manual" },
    roles: {
      "custom-role": { engine: "grok", model: "custom-model", effort: "custom-effort", sandbox: "workspace" },
      strict: { engine: "grok", sandbox: "strict" },
      workspace: { engine: "grok", sandbox: "workspace" },
    },
    engines: { claude: { bin: "/custom/claude" }, codex: {}, grok: { bin: "custom-grok" } },
    limits: {
      maxDepth: 2, stallMinutes: 0.5, waitDefaultSeconds: 0, duplicateWindowMinutes: 0, lockWaitSeconds: 0,
      cancelGraceSeconds: 1.5, planReviewRounds: 5,
    },
    review: { afterResolver: "lead-decides" },
    billing: "api",
  };
  writeConfig(root, explicit);
  assert.deepEqual(config.loadConfig(root), explicit);
  writeConfig(root, { roles: {} });
  assert.deepEqual(config.loadConfig(root).roles, {});
  writeConfig(root, JSON.parse('{"roles":{"__proto__":{"engine":"claude"}}}'));
  assert.deepEqual(Object.keys(config.loadConfig(root).roles), ["__proto__"]);
  assert.equal(config.loadConfig(root).roles.__proto__.engine, "claude");
});

// @anchor roleMayBind
test("a role may bind the prompt its specialist is launched with", (t) => {
  const root = project(t);
  writeConfig(root, { roles: { planner: { engine: "codex", prompt: "You are the planner. Report a plan." } } });
  assert.deepEqual(config.loadConfig(root).roles.planner, {
    engine: "codex", prompt: "You are the planner. Report a plan.",
  });
  // A role that binds none is launched with the mode's own prompt for that role
  // (`src/modes.ts#rolePrompt`), so the key is optional and nothing fills it in here.
  writeConfig(root, { roles: { planner: { engine: "codex" } } });
  assert.equal("prompt" in config.loadConfig(root).roles.planner, false);
});

// @anchor sandboxProfileEngine
test("a role's sandbox profile must be one its own engine accepts", (t) => {
  const root = project(t);
  // Nothing checked the pair before: every engine accepted every profile, so
  // {engine: "codex", sandbox: "workspace"} reached the Codex adapter unchallenged.
  const mismatched: Array<[EngineName, string]> = [
    ["codex", "workspace"], ["codex", "strict"], ["claude", "strict"], ["claude", "workspace"], ["grok", "workspace-write"],
  ];
  for (const [engine, sandbox] of mismatched) {
    writeConfig(root, { roles: { planner: { engine, sandbox } } });
    assert.throws(() => config.loadConfig(root), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("roles.planner.sandbox"), error.message);
      // The refusal names the engine and the profiles that engine does accept.
      assert.ok(error.message.includes(engine), error.message);
      for (const profile of Object.keys(adapterFor(engine).sandboxProfiles)) {
        assert.ok(error.message.includes(profile), error.message);
      }
      return true;
    });
  }
  for (const [engine, adapter] of Object.entries(adapters)) {
    for (const sandbox of Object.keys(adapter.sandboxProfiles)) {
      writeConfig(root, { roles: { planner: { engine, sandbox } } });
      assert.deepEqual(config.loadConfig(root).roles.planner, { engine, sandbox }, `${engine} accepts ${sandbox}`);
    }
  }
});

test("loadConfig rejects an unknown or missing engine naming its path and file", (t) => {
  const root = project(t);
  for (const role of ["planner", "custom-reviewer"]) {
    for (const engine of ["unknown", undefined, null, 3]) {
      writeConfig(root, { roles: { [role]: { engine } } });
      validationError(root, `roles.${role}.engine`);
    }
  }
});

// @anchor loadconfigRejectsMalformed
test("loadConfig rejects malformed JSON, invalid shapes, and invalid field types", (t) => {
  const root = project(t);
  const file = writeConfig(root, {});
  writeFileSync(file, "{broken");
  validationError(root, "$");

  const invalid: Array<[unknown, string]> = [
    [null, "$"], [[], "$"], [true, "$"], ["config", "$"], [{}, "roles"],
  ];
  for (const field of ["project", "roles", "engines", "limits", "review"]) {
    for (const value of [null, [], "invalid", 1, false]) {
      invalid.push([{ roles: {}, [field]: value }, field]);
    }
  }
  for (const value of [null, [], "codex", 1]) invalid.push([{ roles: { planner: value } }, "roles.planner"]);
  for (const field of ["defaultBranch", "testCommand", "setupCommand", "mergePolicy"]) {
    invalid.push([{ roles: {}, project: { [field]: null } }, `project.${field}`]);
    invalid.push([{ roles: {}, project: { [field]: 1 } }, `project.${field}`]);
  }
  for (const field of ["model", "effort", "prompt", "sandbox"]) {
    invalid.push([{ roles: { planner: { engine: "codex", [field]: null } } }, `roles.planner.${field}`]);
    invalid.push([{ roles: { planner: { engine: "codex", [field]: 1 } } }, `roles.planner.${field}`]);
  }
  invalid.push([{ roles: { planner: { engine: "codex", sandbox: "unknown" } } }, "roles.planner.sandbox"]);
  for (const value of [null, "", 1, []]) invalid.push([{ roles: {}, mode: value }, "mode"]);
  for (const value of [null, [], "binary"]) invalid.push([{ roles: {}, engines: { codex: value } }, "engines.codex"]);
  for (const value of [null, 2]) invalid.push([{ roles: {}, engines: { grok: { bin: value } } }, "engines.grok.bin"]);
  for (const field of Object.keys(limitDefaults)) {
    for (const value of [null, "1", true, []]) invalid.push([{ roles: {}, limits: { [field]: value } }, `limits.${field}`]);
  }
  // A wait cannot run backwards, and flock would take -1 as an argument it never refuses.
  for (const value of [-1, -0.5]) invalid.push([{ roles: {}, limits: { lockWaitSeconds: value } }, "limits.lockWaitSeconds"]);
  // A depth cap is a whole number of hops and cannot be negative: `readDepth` compares a
  // record's own depth against it, and 1.5 or -3 is a cap no walk can be judged by. Zero
  // stays legal — it is the fail-closed cap that offers the specialist row to everyone.
  for (const value of [-1, -3, 1.5, 0.5]) invalid.push([{ roles: {}, limits: { maxDepth: value } }, "limits.maxDepth"]);
  for (const value of [null, "unknown", 1]) invalid.push([{ roles: {}, billing: value }, "billing"]);
  for (const [value, field] of invalid) {
    writeConfig(root, value);
    validationError(root, field);
  }
  writeFileSync(file, '{"roles":{},"limits":{"stallMinutes":1e999}}');
  validationError(root, "limits.stallMinutes");
});

// @anchor lockwaitsecondsReadsConfigured
test("lockWaitSeconds reads the configured wait, and answers even when it cannot", (t) => {
  const root = project(t);
  writeConfig(root, { roles: {} });
  assert.equal(config.lockWaitSeconds(root), 5);
  writeConfig(root, { roles: {}, limits: { lockWaitSeconds: 0 } });
  assert.equal(config.lockWaitSeconds(root), 0);
  writeConfig(root, { roles: {}, limits: { lockWaitSeconds: 12.5 } });
  assert.equal(config.lockWaitSeconds(root), 12.5);
  // Locks are taken on paths that run before anyone has a config to read — a runner in a
  // project that was never initialized, a reconciliation of a half-written one — and every
  // one of them still has to wait for something rather than refuse or throw.
  rmSync(path.join(root, config.CONFIG_PATH));
  assert.equal(config.lockWaitSeconds(root), 5);
  writeConfig(root, { roles: {}, limits: { lockWaitSeconds: -1 } });
  assert.equal(config.lockWaitSeconds(root), 5);
  writeFileSync(path.join(root, config.CONFIG_PATH), "{broken");
  assert.equal(config.lockWaitSeconds(root), 5);
});

test("a project with no config file loads solo's defaults, bound to nothing and writing nothing", (t) => {
  const root = project(t);
  // The no-config default of design, "Modes": `discoverProject` answers with the git
  // toplevel, and what runs there is this — solo, the documented project and limit
  // defaults, and no role binding, because binding is `cross-agent init`'s to write and
  // an engine named in the call is what a one-shot uses instead.
  assert.deepEqual(config.loadConfig(root), {
    mode: "solo", project: projectDefaults, roles: {}, limits: limitDefaults, review: reviewDefaults, billing: "subscription",
  });
  assert.deepEqual(config.loadConfig(root), config.defaultConfig());
  assert.deepEqual(readdirSync(root), [], "reading a project that has no config writes none");
  // The mode that default names loads, and it carries the one role a one-shot needs.
  const bound = config.loadConfigWithMode(root, builtInModesDir());
  assert.equal(bound.mode.id, "solo");
  assert.deepEqual(bound.mode.roles.map((role) => role.key), ["consult"]);
  // A file that exists and cannot be read is still a throw: absence is the only default.
  mkdirSync(path.join(root, ".cross-agent"));
  writeFileSync(path.join(root, config.CONFIG_PATH), "{broken");
  assert.throws(() => config.loadConfig(root), /valid JSON/);
});

// @anchor initconfigWritesSection
test("initConfig writes the section 6 defaults once and preserves existing bytes", (t) => {
  const root = project(t);
  assert.equal(config.initConfig(root).wrote, true);
  const file = path.join(root, config.CONFIG_PATH);
  const original = readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(original), sectionSixDefaults);
  assert.deepEqual(config.loadConfig(root), sectionSixDefaults);
  assert.equal(config.initConfig(root).wrote, false);
  assert.equal(readFileSync(file, "utf8"), original);
  const custom = "  custom bytes, even if this is not JSON\n";
  writeFileSync(file, custom);
  assert.equal(config.initConfig(root).wrote, false);
  assert.equal(readFileSync(file, "utf8"), custom);
});

// @anchor initconfigIgnoresProject
test("initConfig ignores the project's own state, once, and leaves a hand-written entry alone", (t) => {
  const root = project(t);
  // `run_command` and `git_root` refuse to work in a project that tracks `.cross-agent/`,
  // so the verb that creates one is where the ignore belongs (design section 4).
  assert.deepEqual(config.initConfig(root).ignored, [".cross-agent/", ".worktrees/"]);
  assert.equal(readFileSync(path.join(root, ".gitignore"), "utf8"), ".cross-agent/\n.worktrees/\n");
  assert.deepEqual(config.initConfig(root).ignored, [], "a second run adds nothing");
  assert.equal(readFileSync(path.join(root, ".gitignore"), "utf8"), ".cross-agent/\n.worktrees/\n");

  // An existing file keeps its bytes, gains only what it lacks, and a spelling without
  // the trailing slash is the same entry.
  const other = project(t);
  writeFileSync(path.join(other, ".gitignore"), "node_modules/\n.worktrees\n");
  assert.deepEqual(config.initConfig(other).ignored, [".cross-agent/"]);
  assert.equal(readFileSync(path.join(other, ".gitignore"), "utf8"), "node_modules/\n.worktrees\n.cross-agent/\n");

  // A file with no final newline is not joined onto.
  const third = project(t);
  writeFileSync(path.join(third, ".gitignore"), "node_modules/");
  config.initConfig(third);
  assert.equal(readFileSync(path.join(third, ".gitignore"), "utf8"), "node_modules/\n.cross-agent/\n.worktrees/\n");

  // A mode that declares no worktree role ignores the directory its own `worktree: true`
  // one-shots would create, which is the implicit policy's (design, "Modes").
  const solo = project(t);
  assert.deepEqual(config.initConfig(solo, { mode: "solo" }).ignored, [".cross-agent/", ".worktrees/"]);
});

// @anchor initconfigLeavesConfig
test("initConfig leaves the config directory holding the config and nothing else", (t) => {
  const root = project(t);
  assert.equal(config.initConfig(root).wrote, true);
  // The file appears whole or not at all, and the temporary it was written through is
  // gone: a leftover would be a half-written config a re-run calls "already exists".
  assert.deepEqual(readdirSync(path.join(root, ".cross-agent")), ["config.json"]);
  assert.equal(config.initConfig(root).wrote, false);
  assert.deepEqual(readdirSync(path.join(root, ".cross-agent")), ["config.json"]);
  assert.throws(() => config.initConfig(root, { mode: "no-such-mode" }), /no-such-mode/);
  assert.deepEqual(readdirSync(path.join(root, ".cross-agent")), ["config.json"]);
});

// @anchor configNamesWhere
test("a config that names where a role works, rather than binding it, is refused by key and rule", (t) => {
  const root = project(t);
  for (const key of ["workspace", "cwd"]) {
    writeConfig(root, { roles: { planner: { engine: "codex", [key]: "root" } } });
    assert.throws(() => config.loadConfig(root), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`roles.planner.${key}`), error.message);
      // The rule, not just the key: where a role works belongs to the mode, and a local
      // binding that could move a read-only reviewer into a worktree would take the
      // mode's own containment argument with it.
      assert.match(error.message, /mode/, error.message);
      return true;
    });
  }
});

// @anchor loadconfigwithmodeBindsEvery
test("loadConfigWithMode binds every role the mode declares and refuses every key it does not", (t) => {
  const root = project(t);
  const modes = modesRoot(t);
  const mode = buildMode(modes, "team", [{ key: "planner" }, { key: "implementer", workspace: "worktree" }]);
  writeConfig(root, { mode: "team", roles: { planner: { engine: "codex" }, implementer: { engine: "codex" } } });

  const bound = config.loadConfigWithMode(root, modes);
  assert.deepEqual(bound.mode, mode);
  assert.deepEqual(bound.config.roles, { planner: { engine: "codex" }, implementer: { engine: "codex" } });
  // The effective profile of a role that overrides none is the mode's default.
  assert.equal(config.roleProfile(bound.mode, bound.config, "implementer"), "workspace-write");
  assert.equal(config.roleProfile(bound.mode, bound.config, "planner"), "read-only");

  writeConfig(root, { mode: "team", roles: { planner: { engine: "codex" }, designer: { engine: "codex" } } });
  assert.throws(() => config.loadConfigWithMode(root, modes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes("roles.designer"), error.message);
    assert.ok(error.message.includes("planner, implementer"), error.message);
    return true;
  });

  // A mode the shelf does not hold is the loader's own refusal, whatever named it.
  writeConfig(root, { mode: "absent", roles: {} });
  assert.throws(() => config.loadConfigWithMode(root, modes), /no mode "absent"/);
  writeConfig(root, { mode: "../elsewhere", roles: {} });
  assert.throws(() => config.loadConfigWithMode(root, modes), /one directory/);
});

// @anchor overrideMayMake
test("an override may not make a root role writable, and must be a profile its engine accepts", (t) => {
  const root = project(t);
  const modes = modesRoot(t);
  buildMode(modes, "team", [{ key: "planner" }, { key: "implementer", workspace: "worktree" }]);

  for (const [engine, sandbox] of [["codex", "workspace-write"], ["codex", "off"], ["grok", "workspace"], ["claude", "off"]] as const) {
    writeConfig(root, { mode: "team", roles: { planner: { engine, sandbox } } });
    assert.throws(() => config.loadConfigWithMode(root, modes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("roles.planner.sandbox"), error.message);
      // `.cross-agent/` is the server's to write, and a writable root role could edit the
      // ledger, the mailbox and the journal out from under it.
      assert.match(error.message, /root/, error.message);
      return true;
    });
  }
  // A profile that is read-only under its own engine is not a write: Grok's `strict` is
  // one, and the rule is about what the sandbox permits, not what it is called.
  writeConfig(root, { mode: "team", roles: { planner: { engine: "grok", sandbox: "strict" } } });
  assert.equal(config.roleProfile(config.loadConfigWithMode(root, modes).mode, config.loadConfig(root), "planner"), "strict");

  // The mode's own default has to reach the bound engine too: `workspace-write` is
  // Claude's and Codex's name for it, and Grok has no such profile.
  writeConfig(root, { mode: "team", roles: { implementer: { engine: "grok" } } });
  assert.throws(() => config.loadConfigWithMode(root, modes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes("roles.implementer"), error.message);
    assert.ok(error.message.includes("workspace-write"), error.message);
    assert.ok(error.message.includes("grok"), error.message);
    return true;
  });
});

// @anchor seatedBinding
test("a many-seat role binds a list, one seat each, and an empty list is refused", (t) => {
  const root = project(t);
  const seats = [
    { engine: "claude", model: "claude-opus-5", sandbox: "read-only" },
    { engine: "codex", model: "gpt-6-astra", effort: "low" },
    { engine: "grok", sandbox: "strict" },
  ];
  writeConfig(root, { roles: { "code-reviewer": seats, planner: { engine: "codex" } } });
  const loaded = config.loadConfig(root);
  assert.deepEqual(loaded.roles["code-reviewer"], seats, "a list round-trips, seat by seat");

  // A list holds at least one seat, and each seat is held to a binding's own rules, by its number.
  for (const [value, field, rule] of [
    [[], "roles.code-reviewer", /non-empty list of bindings, one per seat/],
    [null, "roles.code-reviewer", /non-empty list of bindings, one per seat/],
    ["claude", "roles.code-reviewer", /non-empty list of bindings, one per seat/],
    [[{ engine: "codex" }, { engine: "nope" }], "roles.code-reviewer#2.engine", /claude \| codex \| grok/],
    [[{ engine: "codex", sandbox: "strict" }], "roles.code-reviewer#1.sandbox", /codex profiles/],
  ] as Array<[unknown, string, RegExp]>) {
    writeConfig(root, { roles: { "code-reviewer": value } });
    assert.throws(() => config.loadConfig(root), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`${field}:`), error.message);
      assert.match(error.message, rule);
      return true;
    }, JSON.stringify(value));
  }

  // A seat is a position: an object is one binding, a list is one per entry, and an
  // unbound role has none.
  assert.equal(config.isSeated(loaded.roles["code-reviewer"]), true);
  assert.equal(config.isSeated(loaded.roles.planner), false);
  assert.deepEqual(config.seatsOf(loaded, "code-reviewer"), seats);
  assert.deepEqual(config.seatsOf(loaded, "planner"), [{ engine: "codex" }]);
  assert.equal(config.seatsOf(loaded, "implementer"), undefined);
});

// @anchor listNeedsSeats
test("a list of bindings is refused for a role its mode seats once", (t) => {
  const root = project(t);
  const modes = modesRoot(t);
  buildMode(modes, "team", [
    { key: "planner" },
    { key: "reviewer", workspace: "worktree", sandboxDefault: "read-only", seats: "many" },
  ]);
  writeConfig(root, { mode: "team", roles: { planner: [{ engine: "codex" }] } });
  assert.throws(() => config.loadConfigWithMode(root, modes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes("roles.planner:"), error.message);
    assert.match(error.message, /seats: "many"/);
    assert.match(error.message, /its many-seat roles: reviewer/);
    return true;
  });

  // A legal list, each seat run under its own profile or the mode's default.
  writeConfig(root, { mode: "team", roles: { reviewer: [{ engine: "grok", sandbox: "strict" }, { engine: "codex" }] } });
  const bound = config.loadConfigWithMode(root, modes);
  assert.equal(config.roleProfile(bound.mode, bound.config, "reviewer", 1), "strict");
  assert.equal(config.roleProfile(bound.mode, bound.config, "reviewer", 2), "read-only");
});

// @anchor readOnlyReviewer
test("a read-only many-seat role is read-only in every binding, one seat or many", (t) => {
  const root = project(t);
  const modes = modesRoot(t);
  // Seats of a read-only role review beside each other in one worktree, and a read-only
  // task reserves nothing (`src/reservation.ts#reservesWorkspace`): no binding of it, an
  // object included, may take a profile that writes. A writable many-seat role a custom
  // mode declares is its own business.
  buildMode(modes, "team", [
    { key: "reviewer", workspace: "worktree", sandboxDefault: "read-only", seats: "many" },
    { key: "pair", workspace: "worktree", sandboxDefault: "workspace", seats: "many" },
  ]);
  const refused: Array<[unknown, string, RegExp]> = [
    [{ engine: "claude", sandbox: "workspace-write" }, "roles.reviewer.sandbox", /"workspace-write" is write under claude/],
    [[{ engine: "grok", sandbox: "strict" }, { engine: "codex", sandbox: "workspace-write" }], "roles.reviewer#2.sandbox", /under codex/],
    [{ engine: "grok", sandbox: "off" }, "roles.reviewer.sandbox", /"off" is off under grok/],
  ];
  for (const [binding, field, profile] of refused) {
    writeConfig(root, { mode: "team", roles: { reviewer: binding } });
    assert.throws(() => config.loadConfigWithMode(root, modes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`${field}:`), error.message);
      assert.match(error.message, /role "reviewer" reads only — mode team declares it read-only and seats many/);
      assert.match(error.message, profile);
      return true;
    }, JSON.stringify(binding));
  }
  for (const roles of [
    { reviewer: { engine: "grok", sandbox: "strict" } },
    { reviewer: [{ engine: "claude", sandbox: "read-only" }, { engine: "grok" }] },
    { pair: [{ engine: "grok", sandbox: "workspace" }, { engine: "grok" }] },
  ]) {
    writeConfig(root, { mode: "team", roles });
    assert.deepEqual(config.loadConfigWithMode(root, modes).config.roles, roles);
  }
});

// @anchor oldConfigLoads
test("a config written before the resolver existed loads, and lists the resolver unbound", (t) => {
  const root = project(t);
  // The E10 sample's own shape: one code reviewer bound as an object, and no resolver.
  writeConfig(root, {
    mode: "dev-team-engine",
    project: { defaultBranch: "main", testCommand: "python3 -m unittest discover -s tests -t .", setupCommand: "none", mergePolicy: "auto" },
    roles: {
      lead: { engine: "claude", model: "claude-sonnet-5", effort: "medium" },
      planner: { engine: "codex", model: "gpt-6-luna", effort: "medium" },
      "plan-reviewer": { engine: "grok", model: "grok-4.7", effort: "medium" },
      implementer: { engine: "claude", model: "claude-sonnet-5", effort: "medium" },
      "code-reviewer": { engine: "grok", model: "grok-4.7", effort: "medium", sandbox: "read-only" },
      consult: { engine: "claude", model: "claude-sonnet-5", effort: "medium" },
    },
    limits: { maxDepth: 2 },
  });
  const bound = config.loadConfigWithMode(root, builtInModesDir());
  assert.equal(config.roleProfile(bound.mode, bound.config, "resolver"), "workspace-write", "the mode's default, for the delegate that names an engine");
  assert.equal(config.seatsOf(bound.config, "resolver"), undefined, "and no binding, which the loop's first step reads");
  assert.deepEqual(config.seatsOf(bound.config, "code-reviewer"), [{ engine: "grok", model: "grok-4.7", effort: "medium", sandbox: "read-only" }]);
});

// @anchor reviewSettings
test("limits.planReviewRounds is a whole number of rounds from 1, and review.afterResolver one of three values", (t) => {
  const root = project(t);
  // How many consecutive plan reviews may end on major issues before the loop asks, and what
  // the loop does with a significant finding the resolver's round left standing.
  for (const value of [0, -1, 1.5, "3"]) {
    writeConfig(root, { roles: {}, limits: { planReviewRounds: value } });
    validationError(root, "limits.planReviewRounds");
  }
  writeConfig(root, { roles: {}, limits: { planReviewRounds: 0 } });
  assert.throws(() => config.loadConfig(root), /a whole number of plan-review rounds, at least 1/);
  for (const [value, field] of [[[], "review"], [{ afterResolver: "stop" }, "review.afterResolver"], [{ afterResolver: 1 }, "review.afterResolver"]] as const) {
    writeConfig(root, { roles: {}, review: value });
    validationError(root, field);
  }
  writeConfig(root, { roles: {}, review: { afterResolver: "stop" } });
  assert.throws(() => config.loadConfig(root), /ask \| lead-decides \| always-ask/);
  for (const afterResolver of ["ask", "lead-decides", "always-ask"]) {
    writeConfig(root, { roles: {}, limits: { planReviewRounds: 1 }, review: { afterResolver } });
    const loaded = config.loadConfig(root);
    assert.equal(loaded.limits.planReviewRounds, 1);
    assert.deepEqual(loaded.review, { afterResolver });
  }
});

// @anchor grokBoundLead
test("an engine-placed mode whose lead is bound to grok is refused at load", (t) => {
  const root = project(t);
  const modes = modesRoot(t);
  buildMode(modes, "led", [{ key: "lead" }, { key: "planner" }], { lead: { placement: "engine", role: "lead" } });

  writeConfig(root, { mode: "led", roles: { lead: { engine: "grok" }, planner: { engine: "grok" } } });
  assert.throws(() => config.loadConfigWithMode(root, modes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes("roles.lead.engine"), error.message);
    // P9: a Grok child inherits the operator's own servers and has no per-run isolation,
    // so there is no Grok lead — only a Grok specialist, held to its row by ancestry.
    assert.match(error.message, /P9/, error.message);
    return true;
  });
  // The same binding is fine for a specialist, and fine for a lead role under a
  // host-placed mode, where nothing is mounted at all.
  writeConfig(root, { mode: "led", roles: { lead: { engine: "claude" }, planner: { engine: "grok" } } });
  assert.equal(config.loadConfigWithMode(root, modes).config.roles.planner.engine, "grok");
});

// @anchor effectiveMaxDepthLower
test("effectiveMaxDepth comes from the mode's placement and config may only lower it", (t) => {
  const root = project(t);
  const modes = modesRoot(t);
  const host = buildMode(modes, "host-placed", [{ key: "planner" }]);
  const engine = buildMode(modes, "engine-placed", [{ key: "lead" }, { key: "planner" }], { lead: { placement: "engine", role: "lead" } });

  // A lead runs at depth 1 and its specialists at 2, so an engine-placed mode needs 2 —
  // which is what `init --mode dev-team-engine` writes.
  writeConfig(root, { roles: {}, limits: { maxDepth: 2 } });
  const written = config.loadConfig(root);
  assert.equal(config.effectiveMaxDepth(host, written), 1, "a host-placed mode needs 1 however high config sets the cap");
  assert.equal(config.effectiveMaxDepth(engine, written), 2);

  for (const [maxDepth, expected] of [[1, 1], [0, 0]] as const) {
    writeConfig(root, { roles: {}, limits: { maxDepth } });
    const lowered = config.loadConfig(root);
    assert.equal(config.effectiveMaxDepth(host, lowered), expected);
    assert.equal(config.effectiveMaxDepth(engine, lowered), expected, "config lowers the cap, to below what the mode needs if it says so");
  }

  writeConfig(root, { roles: {}, limits: { maxDepth: 9 } });
  const raised = config.loadConfig(root);
  assert.equal(config.effectiveMaxDepth(host, raised), 1, "and never raises it");
  assert.equal(config.effectiveMaxDepth(engine, raised), 2);
});

test("initConfig writes the bindings of the mode it is given, and refuses a mode it cannot", (t) => {
  const root = project(t);
  assert.equal(config.initConfig(root, { mode: "solo" }).wrote, true);
  const solo = config.loadConfigWithMode(root, builtInModesDir());
  assert.equal(solo.config.mode, "solo");
  assert.deepEqual(solo.config.roles, { consult: { engine: "codex", model: "gpt-6-astra" } });
  assert.equal(config.effectiveMaxDepth(solo.mode, solo.config), 1);

  const engineRoot = project(t);
  assert.equal(config.initConfig(engineRoot, { mode: "dev-team-engine" }).wrote, true);
  const led = config.loadConfigWithMode(engineRoot, builtInModesDir());
  assert.deepEqual(led.config.roles.lead, { engine: "claude", model: "claude-opus-5-5", effort: "xhigh" });
  assert.deepEqual(Object.keys(led.config.roles), ["lead", "planner", "plan-reviewer", "implementer", "code-reviewer", "resolver", "consult"]);
  // The cap the mode needs is written, because the derived cap is the lower of the two.
  assert.equal(led.config.limits.maxDepth, 2);
  assert.equal(config.effectiveMaxDepth(led.mode, led.config), 2);

  // Every role the mode declares is bound, and every binding names a role it declares. The
  // loop's two settings are written for every mode, so an operator finds them to edit.
  for (const name of ["dev-team", "dev-team-engine", "solo"]) {
    const each = project(t);
    config.initConfig(each, { mode: name });
    const bound = config.loadConfigWithMode(each, builtInModesDir());
    assert.deepEqual(Object.keys(bound.config.roles), bound.mode.roles.map((role) => role.key), name);
    const document = JSON.parse(readFileSync(path.join(each, config.CONFIG_PATH), "utf8")) as { limits: Record<string, number>; review: unknown };
    assert.equal(document.limits.planReviewRounds, 3, name);
    assert.deepEqual(document.review, reviewDefaults, name);
  }

  const unknown = project(t);
  assert.throws(() => config.initConfig(unknown, { mode: "no-such-mode" }), /no-such-mode/);
  assert.deepEqual(config.loadConfig(unknown), config.defaultConfig(), "a refused init writes nothing");
  // A mode this build has no bindings for is refused by name rather than invented.
  const modes = modesRoot(t);
  buildMode(modes, "local-team", [{ key: "planner" }]);
  assert.throws(() => config.initConfig(unknown, { mode: "local-team", modesDir: modes }), /local-team/);
});

test("initConfig warns under /tmp and TMPDIR, including symlink aliases", (t) => {
  let temporary: string;
  try {
    temporary = project(t, "/tmp");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EROFS", "EACCES", "EPERM"].includes(code!)) throw error;
    t.skip(`/tmp is not writable here (${code}): a task's sandbox gives its specialist only TMPDIR (${tmpdir()}) to write, so no project can be made under /tmp`);
    return;
  }
  assertWarning(config.initConfig(temporary).warning);
  assertWarning(config.initConfig(temporary).warning);

  const outside = project(t, here);
  const tempAlias = path.join(outside, "tmp-alias");
  symlinkSync(temporary, tempAlias, "dir");
  assertWarning(config.initConfig(tempAlias).warning);

  const designated = path.join(outside, "designated-temp");
  mkdirSync(designated);
  const designatedAlias = path.join(outside, "designated-alias");
  symlinkSync(designated, designatedAlias, "dir");
  setTmpdir(t, designatedAlias);
  assertWarning(config.initConfig(designated).warning);
  const nested = path.join(designated, "nested");
  mkdirSync(nested);
  assertWarning(config.initConfig(nested).warning);
  assertWarning(config.initConfig(path.join(designatedAlias, "nested")).warning);
});

test("initConfig respects temporary directory boundaries", (t) => {
  const outside = project(t, here);
  const designated = path.join(outside, "tmp");
  const sibling = path.join(outside, "tmp-project");
  mkdirSync(designated);
  mkdirSync(sibling);
  setTmpdir(t, designated);
  assert.deepEqual(config.initConfig(sibling), { wrote: true, ignored: [".cross-agent/", ".worktrees/"] });
  assert.deepEqual(config.initConfig(sibling), { wrote: false, ignored: [] });
});

// `init --config -` checks a document read on stdin with the server's own checks, before
// anything is written (setup spec, section 2): the loader's checks on text, the binding
// checks against the mode, and the write-time rules on top.

// @anchor parseConfigLabel
test("parseConfig refuses with the label it is handed, as loadConfig does with its file", (t) => {
  const root = project(t);
  const raw = JSON.stringify({ roles: { planner: { engine: "gpt" } } });
  const file = writeConfig(root, JSON.parse(raw));
  assert.throws(() => config.parseConfig(raw, "stdin"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "stdin: roles.planner.engine: expected claude | codex | grok");
    return true;
  });
  assert.throws(() => config.loadConfig(root), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `${file}: roles.planner.engine: expected claude | codex | grok`);
    return true;
  });
  assert.throws(() => config.parseConfig("{broken", "stdin"), /^Error: stdin: \$: expected valid JSON$/);

  // A document that parses is what the loader makes of the same bytes, defaults filled.
  const valid = JSON.stringify({ mode: "solo", roles: { consult: { engine: "grok" } }, limits: { stallMinutes: 7 } });
  writeFileSync(file, valid);
  assert.deepEqual(config.parseConfig(valid, "stdin"), config.loadConfig(root));
  // And it binds against its mode as the server's loader binds the file, its faults labelled the same way.
  assert.deepEqual(config.bindConfig(config.parseConfig(valid, "stdin"), "stdin"), config.loadConfigWithMode(root));
  const unbound = config.parseConfig(JSON.stringify({ mode: "solo", roles: { critic: { engine: "claude" } } }), "stdin");
  assert.throws(() => config.bindConfig(unbound, "stdin"), /^Error: stdin: roles\.critic: mode solo declares no role "critic"/);
});

// @anchor checkConfigDocument
test("checkConfigDocument names the field and the rule", () => {
  const devTeam = structuredClone(sectionSixDefaults);
  assert.equal(config.checkConfigDocument(JSON.stringify(devTeam), "stdin").mode.id, "dev-team");
  // A Grok writer is the server's to accept once it names the profile Grok writes under.
  const grokWriter = structuredClone(sectionSixDefaults);
  (grokWriter.roles as Record<string, unknown>).implementer = { engine: "grok", sandbox: "workspace" };
  assert.deepEqual(config.checkConfigDocument(JSON.stringify(grokWriter), "stdin").config.roles.implementer, { engine: "grok", sandbox: "workspace" });
  assert.deepEqual(config.mergePolicies, ["auto", "manual"]);

  const engineLed = { ...structuredClone(sectionSixDefaults), mode: "dev-team-engine" };
  (engineLed.roles as Record<string, unknown>) = { lead: { engine: "grok", model: "grok-4.7" }, ...sectionSixDefaults.roles };
  const refusals: Array<[string, unknown, RegExp]> = [
    ["a Grok implementer without the profile", { ...devTeam, roles: { ...devTeam.roles, implementer: { engine: "grok" } } },
      /^stdin: roles\.implementer: engine grok has no sandbox profile "workspace-write"/],
    ["a Grok lead", engineLed, /^stdin: roles\.lead\.engine: mode dev-team-engine places its lead in an engine, and grok cannot carry one/],
    ["an unknown role", { ...devTeam, roles: { ...devTeam.roles, critic: { engine: "claude" } } }, /^stdin: roles\.critic: mode dev-team declares no role "critic"/],
    ["a merge policy outside auto and manual", { ...devTeam, project: { ...devTeam.project, mergePolicy: "yolo" } },
      /^stdin: project\.mergePolicy: expected auto \| manual$/],
    ["a mode this build does not have", { ...devTeam, mode: "absent" }, /^stdin: mode: /],
  ];
  for (const [what, document, reason] of refusals) {
    assert.throws(() => config.checkConfigDocument(JSON.stringify(document), "stdin"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, reason, what);
      return true;
    }, what);
  }
  for (const empty of ["", " \n"]) assert.throws(() => config.checkConfigDocument(empty, "stdin"), /^Error: stdin: \$: the document is empty$/);
  assert.throws(() => config.checkConfigDocument("mode: dev-team", "stdin"), /^Error: stdin: \$: expected valid JSON$/);
});

/** A solo document beside `sectionSixDefaults`, so a replacement's bytes differ from the file it replaces. */
const soloDocument = { ...sectionSixDefaults, mode: "solo", roles: { consult: { engine: "claude", model: "claude-opus-5-5", effort: "xhigh" } } };

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What `initConfig` answered, less the warning every project under the temporary directory gets. */
function settled(result: config.InitConfigResult): Omit<config.InitConfigResult, "warning"> {
  const { warning: _warning, ...rest } = result;
  return rest;
}

// @anchor initConfigDocument
test("initConfig writes a given document exclusively and never replaces it without expect", (t) => {
  const root = project(t);
  const file = path.join(root, config.CONFIG_PATH);
  const document = structuredClone(sectionSixDefaults) as unknown as config.CrossAgentConfig;
  assert.equal(config.configBytes(root), null, "no file, no bytes");
  assert.deepEqual(settled(config.initConfig(root, { document })), { wrote: true, ignored: [".cross-agent/", ".worktrees/"] });
  assert.equal(readFileSync(file, "utf8"), `${JSON.stringify(document, null, 2)}\n`);
  assert.equal(readFileSync(path.join(root, ".gitignore"), "utf8"), ".cross-agent/\n.worktrees/\n");
  const stored = config.configBytes(root)!;
  assert.deepEqual(stored, { bytes: readFileSync(file), sha256: sha256(readFileSync(file)) });

  // A config already there is never replaced without the hash it holds, and the refusal
  // writes nothing at all, the ignore entries a hand-edited .gitignore dropped included.
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  const solo = structuredClone(soloDocument) as unknown as config.CrossAgentConfig;
  assert.deepEqual(settled(config.initConfig(root, { document: solo })), { wrote: false, ignored: [] });
  assert.deepEqual(readFileSync(file), stored.bytes);
  assert.equal(readFileSync(path.join(root, ".gitignore"), "utf8"), "node_modules/\n");
  assert.deepEqual(readdirSync(path.join(root, ".cross-agent")), ["config.json"]);
});

// @anchor initConfigReplace
test("initConfig replaces only the bytes expect names, keeping the replaced file as .prev", (t) => {
  const root = project(t);
  const directory = path.join(root, ".cross-agent");
  const file = path.join(root, config.CONFIG_PATH);
  const prev = `${file}.prev`;
  config.initConfig(root, { document: structuredClone(sectionSixDefaults) as unknown as config.CrossAgentConfig });
  writeFileSync(prev, "an older previous config\n");
  const original = config.configBytes(root)!;
  const before = lstatSync(file).ino;
  const solo = structuredClone(soloDocument) as unknown as config.CrossAgentConfig;
  assert.deepEqual(settled(config.initConfig(root, { document: solo, expect: original.sha256 })), {
    wrote: true, replaced: true, previous: prev, ignored: [],
  });
  assert.equal(readFileSync(file, "utf8"), `${JSON.stringify(solo, null, 2)}\n`);
  assert.notEqual(lstatSync(file).ino, before, "the replacement is a new file renamed into place");
  assert.equal(lstatSync(prev).ino, before, ".prev is the replaced file itself");
  assert.deepEqual(readFileSync(prev), original.bytes, "and the older .prev is gone");
  assert.deepEqual(readdirSync(directory).sort(), ["config.json", "config.json.prev"]);

  // A hash other than the file's, and no file at all, are stale: nothing is created or replaced.
  const replaced = config.configBytes(root)!;
  const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");
  const third = { ...structuredClone(soloDocument), project: { ...soloDocument.project, testCommand: "pytest" } } as unknown as config.CrossAgentConfig;
  assert.deepEqual(settled(config.initConfig(root, { document: third, expect: original.sha256 })), { wrote: false, stale: true, ignored: [] });
  assert.deepEqual(readFileSync(file), replaced.bytes);
  assert.deepEqual(readFileSync(prev), original.bytes);
  rmSync(file);
  assert.deepEqual(settled(config.initConfig(root, { document: third, expect: replaced.sha256 })), { wrote: false, stale: true, ignored: [] });
  assert.deepEqual(readdirSync(directory), ["config.json.prev"]);
  assert.deepEqual(readFileSync(prev), original.bytes);
  assert.equal(readFileSync(path.join(root, ".gitignore"), "utf8"), gitignore);
});

// @anchor replaceConfigRaces
test("the replacement catches an edit by content and by pathname, and the edit it cannot catch lands in .prev", (t) => {
  const root = project(t);
  const directory = path.join(root, ".cross-agent");
  const file = path.join(root, config.CONFIG_PATH);
  const prev = `${file}.prev`;
  const edit = '{ "mode": "solo", "roles": {}, "edited": "by hand" }\n';
  const solo = structuredClone(soloDocument) as unknown as config.CrossAgentConfig;
  const temporaries = () => readdirSync(directory).filter((name) => name.endsWith(".tmp"));
  /** A fresh config.json and an older .prev, and the hash a replacement of it would name. */
  const fresh = (): string => {
    rmSync(directory, { recursive: true, force: true });
    config.initConfig(root, { document: structuredClone(sectionSixDefaults) as unknown as config.CrossAgentConfig });
    writeFileSync(prev, "an older previous config\n");
    return config.configBytes(root)!.sha256;
  };
  const matched = () => `${JSON.stringify(sectionSixDefaults, null, 2)}\n`;

  // (a) An in-place write landing right after the link: the linked file's bytes changed.
  let expect = fresh();
  const link = fs.linkSync;
  const linked = t.mock.method(fs, "linkSync", ((from: fs.PathLike, to: fs.PathLike) => {
    link(from, to);
    if (String(to).startsWith(`${prev}.`)) writeFileSync(file, edit);
  }) as typeof fs.linkSync);
  assert.deepEqual(settled(config.initConfig(root, { document: solo, expect })), { wrote: false, stale: true, ignored: [] });
  linked.mock.restore();
  assert.equal(readFileSync(file, "utf8"), edit, "the edit stands");
  assert.deepEqual(temporaries(), []);
  assert.equal(readFileSync(prev, "utf8"), "an older previous config\n", "the older .prev is untouched");

  // (b) An in-place write after the check read the linked file: not caught, and kept in .prev.
  expect = fresh();
  const rename = fs.renameSync;
  const renamed = t.mock.method(fs, "renameSync", ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === prev) writeFileSync(file, edit);
    rename(from, to);
  }) as typeof fs.renameSync);
  assert.deepEqual(settled(config.initConfig(root, { document: solo, expect })), { wrote: true, replaced: true, previous: prev, ignored: [] });
  renamed.mock.restore();
  assert.equal(readFileSync(file, "utf8"), `${JSON.stringify(solo, null, 2)}\n`);
  assert.equal(readFileSync(prev, "utf8"), edit, "the edit is recovered from .prev");

  // (c) A save that renames a new file over config.json before the identity check: caught.
  expect = fresh();
  const lstat = fs.lstatSync;
  let saved = false;
  const statted = t.mock.method(fs, "lstatSync", ((target: fs.PathLike, options?: fs.StatSyncOptions) => {
    if (!saved && String(target) === file) {
      saved = true;
      writeFileSync(`${file}.editor`, edit);
      renameSync(`${file}.editor`, file);
    }
    return lstat(target, options);
  }) as typeof fs.lstatSync);
  assert.deepEqual(settled(config.initConfig(root, { document: solo, expect })), { wrote: false, stale: true, ignored: [] });
  statted.mock.restore();
  assert.equal(saved, true, "the identity check ran");
  assert.equal(readFileSync(file, "utf8"), edit, "the editor's save stands");
  assert.deepEqual(temporaries(), []);
  assert.equal(readFileSync(prev, "utf8"), matched(), ".prev holds the version the check matched");
});

// @anchor replaceConfigBeforeLink
test("the replacement refuses a save renamed in before the link, and a config.json gone before the link or the identity check", (t) => {
  const root = project(t);
  const directory = path.join(root, ".cross-agent");
  const file = path.join(root, config.CONFIG_PATH);
  const prev = `${file}.prev`;
  const save = '{ "mode": "solo", "roles": {}, "saved": "by an editor" }\n';
  const solo = structuredClone(soloDocument) as unknown as config.CrossAgentConfig;
  const temporaries = () => readdirSync(directory).filter((name) => name.endsWith(".tmp"));
  /** A fresh config.json and an older .prev, and the hash a replacement of it would name. */
  const fresh = (): string => {
    rmSync(directory, { recursive: true, force: true });
    config.initConfig(root, { document: structuredClone(sectionSixDefaults) as unknown as config.CrossAgentConfig });
    writeFileSync(prev, "an older previous config\n");
    return config.configBytes(root)!.sha256;
  };
  /** `fs[method]` running `before` once, the first time it is handed `target`, then itself. */
  const once = <K extends "linkSync" | "lstatSync">(method: K, target: string, before: () => void) => {
    const original = fs[method] as (...args: unknown[]) => unknown;
    let ran = false;
    return t.mock.method(fs, method, ((...args: unknown[]) => {
      if (!ran && String(args[0]) === target) {
        ran = true;
        before();
      }
      return original(...args);
    }) as typeof fs[K]);
  };

  // A save that renames a new file over config.json before the link: the link takes the new
  // file, whose bytes are not the ones named, so the check of the linked bytes refuses it.
  let expect = fresh();
  let mock = once("linkSync", file, () => {
    writeFileSync(`${file}.editor`, save);
    renameSync(`${file}.editor`, file);
  });
  assert.deepEqual(settled(config.initConfig(root, { document: solo, expect })), { wrote: false, stale: true, ignored: [] });
  mock.mock.restore();
  assert.equal(readFileSync(file, "utf8"), save, "the editor's save stands");
  assert.deepEqual(temporaries(), []);
  assert.equal(readFileSync(prev, "utf8"), "an older previous config\n", "the older .prev is untouched");

  // config.json gone before the link: nothing to link, and nothing created in its place.
  expect = fresh();
  mock = once("linkSync", file, () => rmSync(file));
  assert.deepEqual(settled(config.initConfig(root, { document: solo, expect })), { wrote: false, stale: true, ignored: [] });
  mock.mock.restore();
  assert.deepEqual(readdirSync(directory), ["config.json.prev"]);
  assert.equal(readFileSync(prev, "utf8"), "an older previous config\n");

  // config.json gone before the identity check: no file is put in its place, and .prev holds the version matched.
  expect = fresh();
  mock = once("lstatSync", file, () => rmSync(file));
  assert.deepEqual(settled(config.initConfig(root, { document: solo, expect })), { wrote: false, stale: true, ignored: [] });
  mock.mock.restore();
  assert.deepEqual(readdirSync(directory), ["config.json.prev"]);
  assert.equal(readFileSync(prev, "utf8"), `${JSON.stringify(sectionSixDefaults, null, 2)}\n`);
});

test("a directory the config tests make inside the repository is ignored, so an interrupted run leaves nothing a task commit stages", (t) => {
  // The two tests above need a project under neither /tmp nor TMPDIR, so theirs sit in
  // tests/, and only their own cleanup removes them (atc-s96.129). Neither git command
  // here writes git metadata, which `git status` could by refreshing the index.
  const repository = path.dirname(here);
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repository, encoding: "utf8" });
  if (inside.stdout?.trim() !== "true") {
    t.skip(`${repository} is not a git work tree here, so there are no ignore rules to check`);
    return;
  }
  const leftover = project(t, here);
  config.initConfig(leftover);
  for (const file of [path.join(leftover, ".gitignore"), path.join(leftover, config.CONFIG_PATH)]) {
    const relative = path.relative(repository, file);
    const checked = spawnSync("git", ["check-ignore", "--no-index", "--quiet", relative], { cwd: repository });
    assert.equal(checked.status, 0, `${relative} is not ignored`);
  }
});

// The `records` block (design section 6): absent, or both halves — the project's record files
// and its tracker's commands — each checked whole at load.

type RecordsBlock = { files: string[]; tracker: Record<string, string[]> };

/** The approved example block, a fresh copy on every call so a test that edits one changes nothing else. */
function recordsBlock(): RecordsBlock {
  return {
    files: [".project-steward/HANDOFF.md", ".project-steward/PROGRESS.md", ".project-steward/DECISIONS.md"],
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

/** A config holding `records` is refused by `loadConfig` at exactly `field`, its rule matching each pattern. */
function refusesRecords(root: string, records: unknown, field: string, ...patterns: RegExp[]): void {
  const file = writeConfig(root, { roles: {}, records });
  assert.throws(() => config.loadConfig(root), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.startsWith(`${file}: ${field}: `), `${field}: ${error.message}`);
    for (const pattern of patterns) assert.match(error.message, pattern);
    return true;
  });
}

// @anchor recordsLoadAsBefore
test("a config without records loads as before, and one with files and a tracker loads", (t) => {
  const root = project(t);
  writeConfig(root, { roles: {} });
  assert.equal(Object.hasOwn(config.loadConfig(root), "records"), false);
  assert.equal(Object.hasOwn(config.loadConfigWithMode(root, builtInModesDir()).config, "records"), false);

  writeConfig(root, { roles: {}, records: recordsBlock() });
  assert.deepEqual(config.loadConfig(root).records, recordsBlock());
  assert.deepEqual(config.loadConfigWithMode(root, builtInModesDir()).config.records, recordsBlock());
  // The optional verbs are optional, and the tracker's own files may be none.
  const required = recordsBlock();
  delete required.tracker.epic;
  delete required.tracker.depend;
  required.tracker.files = [];
  writeConfig(root, { roles: {}, records: required });
  assert.deepEqual(config.loadConfig(root).records, required);
});

// @anchor recordsBothHalves
test("a records block missing either half is refused, naming it", (t) => {
  const root = project(t);
  const both = /a records block has both files and a tracker, or the config has none/;
  refusesRecords(root, { files: recordsBlock().files }, "records.tracker", both);
  refusesRecords(root, { tracker: recordsBlock().tracker }, "records.files", both);
  refusesRecords(root, { ...recordsBlock(), files: [] }, "records.files");
  refusesRecords(root, {}, "records.files", both);
  refusesRecords(root, [], "records");
});

// @anchor recordsRequiredPlaceholders
test("a create template without {parent}, or any template missing a placeholder its verb requires, is refused, naming it", (t) => {
  const root = project(t);
  const block = recordsBlock();
  block.tracker.create = ["bd", "create", "--title={title}", "--description={text}"];
  refusesRecords(root, block, "records.tracker.create", /lacks \{parent\}, which create requires/);
  // Every placeholder of every verb, the argument naming it taken out in turn.
  for (const [verb, argv] of Object.entries(recordsBlock().tracker)) {
    if (verb === "files") continue;
    for (const [index, argument] of argv.entries()) {
      const name = /\{([A-Za-z]+)\}/.exec(argument)?.[1];
      if (name === undefined) continue;
      const missing = recordsBlock();
      missing.tracker[verb] = argv.filter((_, at) => at !== index);
      refusesRecords(root, missing, `records.tracker.${verb}`, new RegExp(`lacks \\{${name}\\}, which ${verb} requires`));
    }
  }
  // A required verb is required, and an optional one may be left out (the test above).
  for (const verb of ["ready", "show", "create", "file", "claim", "close"]) {
    const without = recordsBlock();
    delete without.tracker[verb];
    refusesRecords(root, without, `records.tracker.${verb}`);
  }
});

test("a template naming a placeholder its verb does not take, or one twice, is refused", (t) => {
  const root = project(t);
  const with_ = (verb: string, argv: string[]): RecordsBlock => {
    const block = recordsBlock();
    block.tracker[verb] = argv;
    return block;
  };
  refusesRecords(root, with_("show", ["bd", "show", "{id}", "--title={title}"]), "records.tracker.show[3]", /\{title\} is no placeholder show takes/);
  refusesRecords(root, with_("ready", ["bd", "ready", "--parent={parent}"]), "records.tracker.ready[2]", /\{parent\} is no placeholder ready takes/);
  refusesRecords(root, with_("claim", ["bd", "update", "{id}", "--also={id}"]), "records.tracker.claim[3]", /\{id\} is named twice, also \[2\]/);
  refusesRecords(root, with_("show", ["{id}", "show"]), "records.tracker.show[0]");
  // A template is a command and its arguments: not a string, not empty, and not an empty command.
  for (const argv of ["bd show {id}", [], ["", "show", "{id}"], ["bd", 5, "{id}"]]) {
    refusesRecords(root, with_("show", argv as string[]), "records.tracker.show");
  }
});

test("free text fills only after an =", (t) => {
  const root = project(t);
  const block = recordsBlock();
  block.tracker.file = ["bd", "create", "{title}", "--description={text}"];
  refusesRecords(root, block, "records.tracker.file[2]", /free text fills only the part after an =/);
  block.tracker.file = ["bd", "create", "--title={title}", "--description=x{text}"];
  refusesRecords(root, block, "records.tracker.file[3]", /free text fills only the part after an =/);
  // An id fills a whole argument or the part after an =, and nothing else.
  block.tracker.file = recordsBlock().tracker.file;
  block.tracker.show = ["bd", "show", "#{id}"];
  refusesRecords(root, block, "records.tracker.show[2]", /an id fills a whole argument or the part after an =/);
  // `--title={title}` and a whole-argument `{id}` load, and so does an id after an =.
  block.tracker.show = ["bd", "show", "--id={id}"];
  writeConfig(root, { roles: {}, records: block });
  assert.deepEqual(config.loadConfig(root).records, block);
  assert.deepEqual(config.loadConfig(root).records!.tracker.claim, ["bd", "update", "{id}", "--claim"]);
});

// @anchor recordsForbiddenPaths
test("declared paths refuse .git, .cross-agent/, host configuration and instruction files", (t) => {
  const root = project(t);
  for (const declared of ["a/.GIT/x", ".git/config", ".cross-agent/x", ".CROSS-AGENT/x", ".Claude/x", ".mcp.json", ".codex/a.md", "docs/agents.md", "CLAUDE.md"]) {
    const named = new RegExp(JSON.stringify(declared).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
    refusesRecords(root, { ...recordsBlock(), files: [declared] }, "records.files[0]", named);
    const tracked = recordsBlock();
    tracked.tracker.files = [declared];
    refusesRecords(root, tracked, "records.tracker.files[0]", named);
  }
});

test("…refuse an absolute path, a .. segment, a duplicate and characters outside the path alphabet", (t) => {
  const root = project(t);
  for (const declared of ["/etc/x", "a/../b", "./a.md", "a//b.md", "a/", "a b.md", "a\\b.md", "~/a.md", ""]) {
    const files = [".project-steward/HANDOFF.md", declared];
    refusesRecords(root, { ...recordsBlock(), files }, "records.files[1]", new RegExp(JSON.stringify(declared).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  }
  refusesRecords(root, { ...recordsBlock(), files: [".project-steward/HANDOFF.md", 7] }, "records.files[1]");
  // A path in both lists, refused at its second occurrence and naming the first.
  const twice = recordsBlock();
  twice.tracker.files = [".beads/interactions.jsonl", ".project-steward/PROGRESS.md"];
  refusesRecords(root, twice, "records.tracker.files[1]", /"\.project-steward\/PROGRESS\.md" is declared twice, also records\.files\[1\]/);
  refusesRecords(root, { ...recordsBlock(), files: ["a.md", "b.md", "a.md"] }, "records.files[2]", /also records\.files\[0\]/);
});

// @anchor recordsWorktreeDir
test("…refuse a path under the mode's worktree directory", (t) => {
  const root = project(t);
  const modes = modesRoot(t);
  const under = ".worktrees/task/HANDOFF.md";
  // The built-in team, and two modes spelling the same directory otherwise: a mode keeps its
  // own spelling, and every role that works in a worktree spells it as the policy does.
  const cases: Array<{ mode?: string; modesDir: string }> = [{ modesDir: builtInModesDir() }];
  for (const [id, spelling] of [["dotted", "./.worktrees"], ["slashed", ".worktrees/"]]) {
    const implementer = [{ key: "implementer", workspace: "worktree" as const }];
    const roles = (modeDocument(id, implementer).roles as Array<Record<string, unknown>>)
      .map((role) => ({ ...role, workspace: { kind: "worktree", branchPattern: "task/*", dir: spelling } }));
    assert.equal(buildMode(modes, id, implementer, { git: { worktreeDir: spelling, branchPattern: "task/*" }, roles }).git!.worktreeDir, spelling);
    cases.push({ mode: id, modesDir: modes });
  }
  const tracked = recordsBlock();
  tracked.tracker.files = [under];
  for (const { mode, modesDir } of cases) {
    for (const [field, records] of [["records.files[0]", { ...recordsBlock(), files: [under] }], ["records.tracker.files[0]", tracked]] as const) {
      const document = { ...(mode === undefined ? {} : { mode }), roles: {}, records };
      const file = writeConfig(root, document);
      const refused = (label: string) => (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.startsWith(`${label}: ${field}: `), `${mode} ${field}: ${error.message}`);
        assert.match(error.message, /"\.worktrees\/task\/HANDOFF\.md" lies under the mode's worktree directory \.worktrees\//);
        return true;
      };
      // The rule needs the mode, so the file alone loads.
      assert.deepEqual(config.loadConfig(root).records, records);
      assert.throws(() => config.loadConfigWithMode(root, modesDir), refused(file));
      assert.throws(() => config.checkConfigDocument(JSON.stringify(document), "stdin", modesDir), refused("stdin"));
    }
  }
  // A path that only begins with the directory's name is not under it.
  writeConfig(root, { roles: {}, records: { ...recordsBlock(), files: [".worktrees-notes.md"] } });
  assert.deepEqual(config.loadConfigWithMode(root, builtInModesDir()).config.records!.files, [".worktrees-notes.md"]);
});

// @anchor recordsSymbolicLink
test("…refuse a symbolic link at load", (t) => {
  const root = project(t);
  mkdirSync(path.join(root, "elsewhere"));
  symlinkSync(path.join(root, "elsewhere"), path.join(root, ".project-steward"));
  const file = writeConfig(root, { roles: {}, records: recordsBlock() });
  // The file alone loads: a link is a fact of the disk, read where the mode is.
  assert.deepEqual(config.loadConfig(root).records, recordsBlock());
  assert.throws(() => config.loadConfigWithMode(root, builtInModesDir()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.startsWith(`${file}: records.files[0]: `), error.message);
    assert.match(error.message, /"\.project-steward" is a symbolic link/);
    return true;
  });
  // A link at the last component is refused too, and a path nothing exists at yet is not.
  fs.unlinkSync(path.join(root, ".project-steward"));
  mkdirSync(path.join(root, ".project-steward"));
  symlinkSync(path.join(root, "elsewhere"), path.join(root, ".project-steward", "PROGRESS.md"));
  assert.throws(() => config.loadConfigWithMode(root, builtInModesDir()), /records\.files\[1\]: "\.project-steward\/PROGRESS\.md" is a symbolic link/);
  fs.unlinkSync(path.join(root, ".project-steward", "PROGRESS.md"));
  assert.deepEqual(config.loadConfigWithMode(root, builtInModesDir()).config.records, recordsBlock());
});

test("records refuses an unknown key", (t) => {
  const root = project(t);
  refusesRecords(root, { ...recordsBlock(), notes: ["x.md"] }, "records.notes");
  const block = recordsBlock();
  block.tracker.archive = ["bd", "archive", "{id}"];
  refusesRecords(root, block, "records.tracker.archive");
});
