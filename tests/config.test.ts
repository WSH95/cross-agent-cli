import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../src/config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDefaults = { defaultBranch: "main", testCommand: "npm test", setupCommand: "none", mergePolicy: "auto" };
const limitDefaults = { maxDepth: 1, stallMinutes: 15, waitDefaultSeconds: 600, duplicateWindowMinutes: 10 };
const sectionSixDefaults = {
  project: projectDefaults,
  roles: {
    planner: { engine: "codex", model: "gpt-6-astra", effort: "high", cwd: "root", sandbox: "read-only" },
    "plan-reviewer": { engine: "claude", model: "claude-opus-5", cwd: "root", sandbox: "read-only" },
    implementer: { engine: "codex", model: "gpt-6-astra", cwd: "worktree", sandbox: "workspace-write" },
    "code-reviewer": { engine: "claude", model: "claude-opus-5", cwd: "worktree", sandbox: "read-only" },
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
  assert.deepEqual(loaded.roles, { planner: { engine: "codex", cwd: "root", sandbox: "read-only" } });
  assert.deepEqual(loaded.limits, limitDefaults);
  assert.equal(loaded.billing, "subscription");

  writeConfig(root, {
    project: { defaultBranch: "trunk" },
    roles: { reviewer: { engine: "grok", cwd: "worktree" }, helper: { engine: "claude", sandbox: "off" } },
    limits: { maxDepth: 0 },
  });
  const partial = config.loadConfig(root);
  assert.deepEqual(partial.project, { ...projectDefaults, defaultBranch: "trunk" });
  assert.deepEqual(partial.roles, {
    reviewer: { engine: "grok", cwd: "worktree", sandbox: "read-only" },
    helper: { engine: "claude", cwd: "root", sandbox: "off" },
  });
  assert.deepEqual(partial.limits, { ...limitDefaults, maxDepth: 0 });
});

test("loadConfig preserves explicit values and custom or empty role maps", (t) => {
  const root = project(t);
  const explicit = {
    project: { defaultBranch: "trunk", testCommand: "node --test", setupCommand: "node setup.mjs", mergePolicy: "manual" },
    roles: {
      "custom-role": { engine: "grok", model: "custom-model", effort: "custom-effort", cwd: "root", sandbox: "workspace-write" },
      strict: { engine: "grok", cwd: "worktree", sandbox: "strict" },
      workspace: { engine: "grok", cwd: "worktree", sandbox: "workspace" },
    },
    engines: { claude: { bin: "/custom/claude" }, codex: {}, grok: { bin: "custom-grok" } },
    limits: { maxDepth: 2, stallMinutes: 0.5, waitDefaultSeconds: 0, duplicateWindowMinutes: 0 },
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
  for (const field of ["model", "effort", "cwd", "sandbox"]) {
    invalid.push([{ roles: { planner: { engine: "codex", [field]: null } } }, `roles.planner.${field}`]);
    invalid.push([{ roles: { planner: { engine: "codex", [field]: 1 } } }, `roles.planner.${field}`]);
  }
  invalid.push([{ roles: { planner: { engine: "codex", cwd: "elsewhere" } } }, "roles.planner.cwd"]);
  invalid.push([{ roles: { planner: { engine: "codex", sandbox: "unknown" } } }, "roles.planner.sandbox"]);
  for (const value of [null, [], "binary"]) invalid.push([{ roles: {}, engines: { codex: value } }, "engines.codex"]);
  for (const value of [null, 2]) invalid.push([{ roles: {}, engines: { grok: { bin: value } } }, "engines.grok.bin"]);
  for (const field of Object.keys(limitDefaults)) {
    for (const value of [null, "1", true, []]) invalid.push([{ roles: {}, limits: { [field]: value } }, `limits.${field}`]);
  }
  for (const value of [null, "unknown", 1]) invalid.push([{ roles: {}, billing: value }, "billing"]);
  for (const [value, field] of invalid) {
    writeConfig(root, value);
    validationError(root, field);
  }
  writeFileSync(file, '{"roles":{},"limits":{"stallMinutes":1e999}}');
  validationError(root, "limits.stallMinutes");
});

test("loadConfig retains missing-config guidance", (t) => {
  const root = project(t);
  assert.throws(() => config.loadConfig(root), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(path.join(root, config.CONFIG_PATH)));
    assert.match(error.message, /cross-agent init/);
    return true;
  });
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
  assert.deepEqual(config.initConfig(sibling), { wrote: true });
  assert.deepEqual(config.initConfig(sibling), { wrote: false });
});
