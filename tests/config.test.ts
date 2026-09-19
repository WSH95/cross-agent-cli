import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../src/config.ts";
import { adapterFor, adapters } from "../src/engines/registry.ts";
import type { EngineName } from "../src/engines/types.ts";
import { builtInModesDir, loadMode } from "../src/modes.ts";
import { buildMode, modesRoot } from "./helpers/mode.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDefaults = { defaultBranch: "main", testCommand: "npm test", setupCommand: "none", mergePolicy: "auto" };
const limitDefaults = {
  maxDepth: 1, stallMinutes: 15, waitDefaultSeconds: 600, duplicateWindowMinutes: 10, lockWaitSeconds: 5,
  cancelGraceSeconds: 5,
};
const sectionSixDefaults = {
  mode: "dev-team",
  project: projectDefaults,
  roles: {
    planner: { engine: "codex", model: "gpt-6-astra", effort: "high" },
    "plan-reviewer": { engine: "claude", model: "claude-opus-5" },
    implementer: { engine: "codex", model: "gpt-6-astra" },
    "code-reviewer": { engine: "claude", model: "claude-opus-5", sandbox: "read-only" },
    // The role every mode carries, bound to a starting engine this call may override.
    consult: { engine: "codex", model: "gpt-6-astra" },
  },
  engines: { claude: {}, codex: {}, grok: {} },
  limits: limitDefaults,
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
      cancelGraceSeconds: 1.5,
    },
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

test("loadConfig rejects malformed JSON, invalid shapes, and invalid field types", (t) => {
  const root = project(t);
  const file = writeConfig(root, {});
  writeFileSync(file, "{broken");
  validationError(root, "$");

  const invalid: Array<[unknown, string]> = [
    [null, "$"], [[], "$"], [true, "$"], ["config", "$"], [{}, "roles"],
  ];
  for (const field of ["project", "roles", "engines", "limits"]) {
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
    mode: "solo", project: projectDefaults, roles: {}, limits: limitDefaults, billing: "subscription",
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
  assert.deepEqual(led.config.roles.lead, { engine: "claude", model: "claude-opus-5", effort: "high" });
  assert.deepEqual(Object.keys(led.config.roles), ["lead", "planner", "plan-reviewer", "implementer", "code-reviewer", "consult"]);
  // The cap the mode needs is written, because the derived cap is the lower of the two.
  assert.equal(led.config.limits.maxDepth, 2);
  assert.equal(config.effectiveMaxDepth(led.mode, led.config), 2);

  // Every role the mode declares is bound, and every binding names a role it declares.
  for (const name of ["dev-team", "dev-team-engine", "solo"]) {
    const each = project(t);
    config.initConfig(each, { mode: name });
    const bound = config.loadConfigWithMode(each, builtInModesDir());
    assert.deepEqual(Object.keys(bound.config.roles), bound.mode.roles.map((role) => role.key), name);
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
  const temporary = project(t, "/tmp");
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
