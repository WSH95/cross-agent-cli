import "./child-check.mjs";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as config from "../src/config.ts";
import { boundDocument, CONFIG_PATH, loadConfigWithMode } from "../src/config.ts";
import type { CrossAgentConfig } from "../src/config.ts";
import type { EngineName } from "../src/engines/types.ts";
import { builtInModesDir, loadMode } from "../src/modes.ts";
import type { Mode } from "../src/modes.ts";
import { projectTools } from "../src/server.ts";
import * as setup from "../src/setup.ts";
import { git } from "./helpers/git.ts";
import { enginePath, mainCheckout } from "./helpers/project.ts";

// `init --propose`'s look at a project (setup spec, section 2): the engines found as the
// server finds them, the default branch, the test and setup commands, each with where it
// came from, read from fixed names at the root and never by running anything.

const exec = promisify(execFile);

function scratch(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "cross-agent-setup-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A directory holding exactly `files`, each a name and its text. */
function holding(t: TestContext, files: Record<string, string>): string {
  const root = scratch(t);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return root;
}

const notFound = { found: false, value: null, from: null };
const scripted = JSON.stringify({ scripts: { test: "node --test" } });

// @anchor detectTestCommand
test("detectTestCommand finds each project type, the first in the spec's order, and none", (t) => {
  const rows: Array<[Record<string, string>, unknown]> = [
    [{ "package.json": scripted }, { found: true, value: "npm test", from: "package.json scripts.test" }],
    [{ Makefile: "build:\n\tcc main.c\n\ntest: build\n\t./a.out\n" }, { found: true, value: "make test", from: "Makefile test target" }],
    [{ Makefile: "test :\n\ttrue\n" }, { found: true, value: "make test", from: "Makefile test target" }],
    [{ "pyproject.toml": "[project]\nname = \"x\"\n" }, { found: true, value: "pytest", from: "pyproject.toml" }],
    [{ "pytest.ini": "[pytest]\n" }, { found: true, value: "pytest", from: "pytest.ini" }],
    [{ "Cargo.toml": "[package]\n" }, { found: true, value: "cargo test", from: "Cargo.toml" }],
    [{ "go.mod": "module x\n" }, { found: true, value: "go test ./...", from: "go.mod" }],
    [{}, notFound],
    // A variable named test is no target, and a package.json with no test script falls through.
    [{ Makefile: "test := x\ntest:= y\n" }, notFound],
    [{ "package.json": JSON.stringify({ scripts: { build: "tsc" } }), "go.mod": "module x\n" }, { found: true, value: "go test ./...", from: "go.mod" }],
    [{ "package.json": JSON.stringify({ scripts: { test: "" } }), "pytest.ini": "" }, { found: true, value: "pytest", from: "pytest.ini" }],
    // The first in the spec's order wins.
    [{ "package.json": scripted, Makefile: "test:\n\ttrue\n", "go.mod": "" }, { found: true, value: "npm test", from: "package.json scripts.test" }],
    [{ Makefile: "test:\n\ttrue\n", "pyproject.toml": "", "Cargo.toml": "" }, { found: true, value: "make test", from: "Makefile test target" }],
    [{ "pytest.ini": "", "pyproject.toml": "" }, { found: true, value: "pytest", from: "pyproject.toml" }],
    [{ "go.mod": "", "Cargo.toml": "" }, { found: true, value: "cargo test", from: "Cargo.toml" }],
  ];
  for (const [files, expected] of rows) assert.deepEqual(setup.detectTestCommand(holding(t, files)), expected, Object.keys(files).join(", "));
});

// @anchor detectionReadsOnly
test("detection reads only small regular files at the root and runs nothing", { timeout: 10_000 }, async (t) => {
  // A directory, a FIFO, a file past 1 MiB and JSON that does not parse: none is a project
  // file, and a FIFO is never opened, which would block until a writer came.
  const directory = scratch(t);
  fs.mkdirSync(path.join(directory, "package.json"));
  fs.mkdirSync(path.join(directory, "yarn.lock"));
  const fifo = scratch(t);
  await exec("mkfifo", [path.join(fifo, "Makefile")]);
  await exec("mkfifo", [path.join(fifo, "package-lock.json")]);
  const large = holding(t, { "package.json": JSON.stringify({ scripts: { test: "node --test" }, padding: "x".repeat(2 * 1024 * 1024) }) });
  const largeMakefile = holding(t, { Makefile: `test:\n\ttrue\n#${"x".repeat(2 * 1024 * 1024)}\n` });
  const invalid = holding(t, { "package.json": "{ \"scripts\": { \"test\": " });
  for (const root of [directory, fifo, large, largeMakefile, invalid]) {
    assert.deepEqual(setup.detectTestCommand(root), notFound, root);
    assert.deepEqual(setup.detectSetupCommand(root), notFound, root);
  }
  // Read, never run: a recipe that would leave a marker leaves none.
  const recipes = holding(t, {
    "package.json": JSON.stringify({ scripts: { test: "touch npm-ran", preinstall: "touch npm-ran" } }),
    Makefile: "test:\n\ttouch make-ran\n",
    "package-lock.json": "{}",
  });
  assert.equal(setup.detectTestCommand(recipes).value, "npm test");
  assert.equal(setup.detectSetupCommand(recipes).value, "npm ci");
  assert.deepEqual(fs.readdirSync(recipes).sort(), ["Makefile", "package-lock.json", "package.json"]);
});

// @anchor detectSetupCommand
test("detectSetupCommand reads each lockfile; Cargo.lock needs none", (t) => {
  const rows: Array<[Record<string, string>, unknown]> = [
    [{ "package-lock.json": "{}" }, { found: true, value: "npm ci", from: "package-lock.json" }],
    [{ "pnpm-lock.yaml": "" }, { found: true, value: "pnpm install --frozen-lockfile", from: "pnpm-lock.yaml" }],
    [{ "yarn.lock": "" }, { found: true, value: "yarn install --frozen-lockfile", from: "yarn.lock" }],
    [{ "uv.lock": "" }, { found: true, value: "uv sync", from: "uv.lock" }],
    [{ "poetry.lock": "" }, { found: true, value: "poetry install", from: "poetry.lock" }],
    [{ "Cargo.lock": "" }, { found: true, value: "none", from: "Cargo.lock" }],
    [{ "package.json": scripted }, notFound],
    [{}, notFound],
    // The first in the spec's order wins.
    [{ "package-lock.json": "{}", "yarn.lock": "" }, { found: true, value: "npm ci", from: "package-lock.json" }],
    [{ "pnpm-lock.yaml": "", "yarn.lock": "" }, { found: true, value: "pnpm install --frozen-lockfile", from: "pnpm-lock.yaml" }],
    [{ "uv.lock": "", "poetry.lock": "", "Cargo.lock": "" }, { found: true, value: "uv sync", from: "uv.lock" }],
    [{ "poetry.lock": "", "Cargo.lock": "" }, { found: true, value: "poetry install", from: "poetry.lock" }],
  ];
  for (const [files, expected] of rows) assert.deepEqual(setup.detectSetupCommand(holding(t, files)), expected, Object.keys(files).join(", "));
});

/** The repository `init --propose` reads at a main checkout. */
function mainRepository(root: string): { gitDir: string; workTree: string; worktree: null } {
  return { gitDir: path.join(root, ".git"), workTree: root, worktree: null };
}

// @anchor detectDefaultBranch
test("detectDefaultBranch: origin/HEAD, then the current branch, then main, and a branch worktree's own branch", async (t) => {
  const dir = scratch(t);
  const origin = path.join(dir, "origin");
  fs.mkdirSync(origin);
  await git(origin, "init", "-b", "trunk");
  await git(origin, "commit", "--allow-empty", "-m", "initial");
  const clone = path.join(dir, "clone");
  await git(dir, "clone", "--quiet", origin, clone);
  await git(clone, "checkout", "-b", "feature");
  assert.deepEqual(await setup.detectDefaultBranch(mainRepository(clone)), { found: true, value: "trunk", from: "origin/HEAD" });
  // An origin with no HEAD of its own recorded: the branch checked out.
  await git(clone, "remote", "set-head", "origin", "--delete");
  assert.deepEqual(await setup.detectDefaultBranch(mainRepository(clone)), { found: true, value: "feature", from: "current branch" });
  // A repository `git init` just made: its unborn branch.
  const empty = path.join(dir, "empty");
  fs.mkdirSync(empty);
  await git(empty, "init", "-b", "trunk");
  assert.deepEqual(await setup.detectDefaultBranch(mainRepository(empty)), { found: true, value: "trunk", from: "current branch" });
  // A detached main checkout names no branch: the default.
  const detached = await mainCheckout(dir, "detached");
  await git(detached, "checkout", "--detach");
  assert.deepEqual(await setup.detectDefaultBranch(mainRepository(detached)), { found: true, value: "main", from: "default" });
  // A branch worktree's default branch is its own, whatever its remote says.
  assert.deepEqual(
    await setup.detectDefaultBranch({ gitDir: path.join(clone, ".git"), workTree: clone, worktree: { branch: "feature/one", main: null } }),
    { found: true, value: "feature/one", from: "worktree branch" },
  );
});

// @anchor findEngines
test("findEngines looks up each engine as the server does", (t) => {
  const installed = enginePath(t, ["claude", "codex"]);
  // A file that is not executable is no engine, as `commandPath` says for a spawn.
  fs.writeFileSync(path.join(installed, "grok"), "#!/bin/sh\n");
  fs.chmodSync(path.join(installed, "grok"), 0o644);
  const env = { PATH: installed };
  assert.deepEqual(setup.findEngines(null, env), {
    claude: { found: true, command: "claude", path: path.join(installed, "claude"), from: "PATH" },
    codex: { found: true, command: "codex", path: path.join(installed, "codex"), from: "PATH" },
    grok: { found: false, command: "grok", path: null, from: "PATH" },
  });

  // A configured bin wins over PATH and over the environment's own override, and one that
  // is missing is not found, as the server would fail to spawn it.
  const elsewhere = enginePath(t, ["grok-build"]);
  const configured = {
    mode: "solo", project: { defaultBranch: "main", testCommand: "none", setupCommand: "none", mergePolicy: "auto" }, roles: {},
    engines: { claude: { bin: path.join(elsewhere, "absent") }, codex: {}, grok: { bin: path.join(elsewhere, "grok-build") } },
    limits: { maxDepth: 1, stallMinutes: 15, waitDefaultSeconds: 600, duplicateWindowMinutes: 10, lockWaitSeconds: 5, cancelGraceSeconds: 5, planReviewRounds: 3 },
    review: { afterResolver: "ask" as const }, billing: "subscription" as const,
  };
  const overridden = { PATH: installed, CROSS_AGENT_CODEX_BIN: path.join(elsewhere, "grok-build"), CROSS_AGENT_GROK_BIN: "/nowhere/grok" };
  assert.deepEqual(setup.findEngines(configured, overridden), {
    claude: { found: false, command: path.join(elsewhere, "absent"), path: null, from: "engines.claude.bin" },
    codex: { found: true, command: path.join(elsewhere, "grok-build"), path: path.join(elsewhere, "grok-build"), from: "CROSS_AGENT_CODEX_BIN" },
    grok: { found: true, command: path.join(elsewhere, "grok-build"), path: path.join(elsewhere, "grok-build"), from: "engines.grok.bin" },
  });
});

// The team rule (setup spec, section 2): a role keeps its binding where its engine is found,
// and otherwise takes the first found engine able to do it; with Claude or Codex found, Grok
// never writes or leads; with only Grok, dev-team is all Grok and there is no background team.

const modes = Object.fromEntries(["dev-team", "dev-team-engine", "solo"].map((name) => [name, loadMode(builtInModesDir(), name)]));
const freshProject = { defaultBranch: "main", testCommand: "npm test", setupCommand: "none", mergePolicy: "auto" };
const claude = { engine: "claude", model: "claude-opus-5-5", effort: "xhigh" };
const codex = { engine: "codex", model: "gpt-6-astra", effort: "xhigh" };
const grok = { engine: "grok", model: "grok-4.7", effort: "xhigh" };
const seats = {
  claude: { engine: "claude", model: "claude-opus-5-5", effort: "xhigh", sandbox: "read-only" },
  codex: { engine: "codex", model: "gpt-6.1-sol", effort: "xhigh", sandbox: "read-only" },
  grok: { engine: "grok", model: "grok-4.7", effort: "xhigh", sandbox: "read-only" },
};
const builtInResolver = { engine: "codex", model: "gpt-6-astra", effort: "max" };
const builtInConsult = { engine: "codex", model: "gpt-6-astra" };

/** Each built-in mode's fresh proposal for the engines found. */
function proposeAll(
  found: readonly EngineName[], options: Parameters<typeof setup.proposeMode>[3] = {}, project = freshProject,
): Record<string, setup.Proposal> {
  return Object.fromEntries(Object.entries(modes).map(([name, mode]) => [name, setup.proposeMode(mode, new Set(found), project, options)]));
}

/** An available proposal's document, asserted available. */
function documentOf(proposal: setup.Proposal): CrossAgentConfig {
  assert.equal(proposal.available, true, JSON.stringify(proposal));
  return proposal.document!;
}

// @anchor teamAllEngines
test("all three engines keep init's bindings", () => {
  for (const [name, proposal] of Object.entries(proposeAll(["claude", "codex", "grok"]))) {
    assert.deepEqual(documentOf(proposal), boundDocument(modes[name], name, "main"), name);
    assert.deepEqual(proposal.substitutions, [], name);
    assert.deepEqual(proposal.notes, [], name);
    assert.equal(proposal.copiedFrom, null, name);
  }
});

// @anchor teamClaudeOnly
test("Claude only", () => {
  const proposed = proposeAll(["claude"]);
  const team = { planner: claude, "plan-reviewer": claude, implementer: claude, "code-reviewer": [seats.claude], resolver: claude, consult: claude };
  assert.deepEqual(documentOf(proposed["dev-team"]).roles, team);
  assert.deepEqual(documentOf(proposed["dev-team-engine"]).roles, { lead: claude, ...team });
  assert.deepEqual(documentOf(proposed.solo).roles, { consult: claude });
  const swapped = [
    { role: "plan-reviewer", from: "codex", to: "claude" },
    { role: "code-reviewer", seat: 2, from: "codex", to: null }, { role: "code-reviewer", seat: 3, from: "grok", to: null },
    { role: "resolver", from: "codex", to: "claude" }, { role: "consult", from: "codex", to: "claude" },
  ];
  assert.deepEqual(proposed["dev-team"].substitutions, swapped);
  assert.deepEqual(proposed["dev-team-engine"].substitutions, swapped);
  assert.deepEqual(proposed.solo.substitutions, [{ role: "consult", from: "codex", to: "claude" }]);
  for (const proposal of Object.values(proposed)) assert.deepEqual(proposal.notes, []);
});

// @anchor teamCodexOnly
test("Codex only", () => {
  const proposed = proposeAll(["codex"]);
  const team = {
    planner: codex, "plan-reviewer": codex, implementer: codex, "code-reviewer": [seats.codex], resolver: builtInResolver, consult: builtInConsult,
  };
  assert.deepEqual(documentOf(proposed["dev-team"]).roles, team);
  assert.deepEqual(documentOf(proposed["dev-team-engine"]).roles, { lead: codex, ...team });
  assert.deepEqual(documentOf(proposed.solo).roles, { consult: builtInConsult });
  const swapped = [
    { role: "planner", from: "claude", to: "codex" }, { role: "implementer", from: "claude", to: "codex" },
    { role: "code-reviewer", seat: 1, from: "claude", to: null }, { role: "code-reviewer", seat: 3, from: "grok", to: null },
  ];
  assert.deepEqual(proposed["dev-team"].substitutions, swapped);
  assert.deepEqual(proposed["dev-team-engine"].substitutions, [{ role: "lead", from: "claude", to: "codex" }, ...swapped]);
  assert.deepEqual(proposed.solo.substitutions, []);
});

// @anchor teamClaudeGrok
test("Claude and Grok", () => {
  const proposed = proposeAll(["claude", "grok"]);
  const team = {
    planner: claude, "plan-reviewer": claude, implementer: claude, "code-reviewer": [seats.claude, seats.grok], resolver: claude, consult: claude,
  };
  assert.deepEqual(documentOf(proposed["dev-team"]).roles, team);
  assert.deepEqual(documentOf(proposed["dev-team-engine"]).roles, { lead: claude, ...team });
  assert.deepEqual(proposed["dev-team"].substitutions, [
    { role: "plan-reviewer", from: "codex", to: "claude" }, { role: "code-reviewer", seat: 2, from: "codex", to: null },
    { role: "resolver", from: "codex", to: "claude" }, { role: "consult", from: "codex", to: "claude" },
  ]);
  for (const proposal of Object.values(proposed)) assert.deepEqual(proposal.notes, []);
});

// @anchor teamCodexGrok
test("Codex and Grok", () => {
  const proposed = proposeAll(["codex", "grok"]);
  const team = {
    planner: codex, "plan-reviewer": codex, implementer: codex, "code-reviewer": [seats.codex, seats.grok], resolver: builtInResolver, consult: builtInConsult,
  };
  assert.deepEqual(documentOf(proposed["dev-team"]).roles, team);
  assert.deepEqual(documentOf(proposed["dev-team-engine"]).roles, { lead: codex, ...team });
  assert.deepEqual(proposed["dev-team"].substitutions, [
    { role: "planner", from: "claude", to: "codex" }, { role: "implementer", from: "claude", to: "codex" },
    { role: "code-reviewer", seat: 1, from: "claude", to: null },
  ]);
  for (const proposal of Object.values(proposed)) assert.deepEqual(proposal.notes, []);
});

// @anchor teamGrokOnly
test("Grok only: a Grok dev-team with the note, no background team, a Grok consultant", () => {
  const proposed = proposeAll(["grok"]);
  const writer = { ...grok, sandbox: "workspace" };
  assert.deepEqual(documentOf(proposed["dev-team"]).roles, {
    planner: grok, "plan-reviewer": grok, implementer: writer, "code-reviewer": [seats.grok], resolver: writer, consult: grok,
  });
  assert.deepEqual(proposed["dev-team"].notes, [setup.GROK_GIT_NOTE]);
  assert.equal(setup.GROK_GIT_NOTE, "Grok's sandbox cannot protect the repository's git files, so cross-agent checks them after each step instead.");
  assert.deepEqual(proposed["dev-team-engine"], {
    mode: "dev-team-engine", available: false, reason: "the background team's lead must be Claude or Codex",
    document: null, substitutions: [], notes: [], copiedFrom: null,
  });
  assert.deepEqual(documentOf(proposed.solo).roles, { consult: grok });
  assert.deepEqual(proposed.solo.substitutions, [{ role: "consult", from: "codex", to: "grok" }]);
  assert.deepEqual(proposed.solo.notes, []);
});

// @anchor teamNoEngine
test("no engine: nothing available", () => {
  for (const [name, proposal] of Object.entries(proposeAll([]))) {
    assert.deepEqual(proposal, {
      mode: name, available: false, reason: "no engine found: install Claude Code, Codex or Grok",
      document: null, substitutions: [], notes: [], copiedFrom: null,
    });
  }
});

/** Every binding in a document, by role, with whether its mode has the role write or lead. */
function bindingsOf(document: CrossAgentConfig, mode: Mode): Array<{ key: string; writes: boolean; lead: boolean; binding: Record<string, unknown> }> {
  return mode.roles.flatMap((role) => {
    const bound = document.roles[role.key];
    return (Array.isArray(bound) ? bound : [bound]).map((binding) => ({
      key: role.key, writes: role.sandboxDefault !== "read-only", lead: role.key === mode.lead.role, binding: binding as unknown as Record<string, unknown>,
    }));
  });
}

// @anchor teamEverySubset
test("over every non-empty subset of engines, fresh proposals keep the Grok rule and pass the gate", (t) => {
  const subsets = [["claude"], ["codex"], ["grok"], ["claude", "codex"], ["claude", "grok"], ["codex", "grok"], ["claude", "codex", "grok"]] as EngineName[][];
  for (const found of subsets) {
    const grokAlone = found.length === 1 && found[0] === "grok";
    for (const [name, proposal] of Object.entries(proposeAll(found))) {
      const label = `${found.join("+")}: ${name}`;
      if (grokAlone && name === "dev-team-engine") {
        assert.equal(proposal.available, false, label);
        continue;
      }
      const document = documentOf(proposal);
      assert.equal(config.checkConfigDocument(JSON.stringify(document), "proposal").mode.id, name, label);
      const root = scratch(t);
      fs.mkdirSync(path.join(root, ".cross-agent"));
      fs.writeFileSync(path.join(root, CONFIG_PATH), JSON.stringify(document));
      assert.equal(loadConfigWithMode(root).config.mode, name, label);
      for (const { key, writes, lead, binding } of bindingsOf(document, modes[name])) {
        assert.ok(found.includes(binding.engine as EngineName), `${label}: ${key} is on an engine found`);
        if (!grokAlone) {
          if (writes || lead) assert.notEqual(binding.engine, "grok", `${label}: ${key}`);
          if (writes) assert.equal("sandbox" in binding, false, `${label}: ${key}`);
        } else if (writes) {
          assert.deepEqual(binding, { ...grok, sandbox: "workspace" }, `${label}: ${key}`);
        }
      }
      assert.deepEqual(proposal.notes, grokAlone && name === "dev-team" ? [setup.GROK_GIT_NOTE] : [], label);
    }
  }
});

// @anchor teamKeepsBins
test("proposals keep the lookup config's engine bins", () => {
  for (const [name, proposal] of Object.entries(proposeAll(["claude", "codex", "grok"], { engines: { codex: { bin: "/opt/codex/bin/codex" } } }))) {
    assert.deepEqual(documentOf(proposal).engines, { claude: {}, codex: { bin: "/opt/codex/bin/codex" }, grok: {} }, name);
  }
});

// @anchor defaultBranchGate
test("defaultBranchFault gates every proposal", () => {
  const devTeam = modes["dev-team"];
  assert.equal(setup.defaultBranchFault(devTeam, "main", null), null);
  assert.equal(setup.defaultBranchFault(devTeam, "feature/one", "feature/one"), null);
  // In order: another branch than a branch project's own, then a name git_root cannot read,
  // then a branch the mode's task pattern matches.
  assert.match(setup.defaultBranchFault(devTeam, "task/x", "feature")!, /^"task\/x" is not this worktree's own branch "feature"/);
  assert.match(setup.defaultBranchFault(devTeam, "task/../x", null)!, /^"task\/\.\.\/x" is not a branch name/);
  assert.match(setup.defaultBranchFault(devTeam, "feature+one", "feature+one")!, /^"feature\+one" is not a branch name/);
  const pattern = setup.defaultBranchFault(devTeam, "task/x", null)!;
  assert.match(pattern, /^"task\/x" matches mode dev-team's task branch pattern task\/\*/);
  assert.match(pattern, /a project's default branch is never a task's/);
  // Solo declares no worktree role, and its one-shots use the implicit pattern.
  assert.match(setup.defaultBranchFault(modes.solo, "task/x", null)!, /task branch pattern task\/\*/);
  for (const [name, proposal] of Object.entries(proposeAll(["claude", "codex", "grok"], {}, { ...freshProject, defaultBranch: "task/x" }))) {
    assert.equal(proposal.available, false, name);
    assert.equal(proposal.reason, setup.defaultBranchFault(modes[name], "task/x", null), name);
  }
});

test("defaultBranchFault refuses a default branch ending in '.', naming the trailing '.' in its rule", () => {
  const fault = setup.defaultBranchFault(modes["dev-team"], "main.", null)!;
  assert.match(fault, /^"main\." is not a branch name: /);
  assert.match(fault, /no trailing "\.", "\/" or "\.lock"/);
});

/** `init`'s config for `mode` as an operator adjusted it: a main checkout's, a branch project's base. */
function baseConfig(mode = "dev-team"): CrossAgentConfig {
  const document = boundDocument(modes[mode], mode, "main");
  (document.roles.consult as Record<string, unknown>).model = "a-model-of-this-project";
  document.project.testCommand = "pytest";
  document.limits.stallMinutes = 7;
  document.review.afterResolver = "lead-decides";
  return document;
}

// @anchor teamBase
test("a base config goes through the same rule and gate", () => {
  const branch = { ...freshProject, defaultBranch: "feature" };
  const based = (found: EngineName[], base: CrossAgentConfig) =>
    setup.proposeMode(modes[base.mode], new Set(found), branch, { base, engines: base.engines, worktreeBranch: "feature" });
  const passes = (proposal: setup.Proposal) => config.checkConfigDocument(JSON.stringify(documentOf(proposal)), "proposal");

  // Every engine found: the base itself, on the worktree's branch, and nothing to say.
  const base = baseConfig();
  const all = based(["claude", "codex", "grok"], base);
  assert.deepEqual(documentOf(all), { ...base, project: { ...base.project, defaultBranch: "feature" } });
  assert.deepEqual([all.substitutions, all.notes], [[], []]);
  assert.deepEqual(base, baseConfig(), "the base is never changed");

  // Claude only: the base's Claude roles and settings kept, the rest substituted.
  const claudeOnly = based(["claude"], base);
  const document = documentOf(claudeOnly);
  assert.deepEqual(document.roles, {
    planner: claude, "plan-reviewer": claude, implementer: claude, "code-reviewer": [seats.claude], resolver: claude, consult: claude,
  });
  assert.deepEqual(claudeOnly.substitutions, [
    { role: "plan-reviewer", from: "codex", to: "claude" },
    { role: "code-reviewer", seat: 2, from: "codex", to: null }, { role: "code-reviewer", seat: 3, from: "grok", to: null },
    { role: "resolver", from: "codex", to: "claude" }, { role: "consult", from: "codex", to: "claude" },
  ]);
  assert.equal(document.project.testCommand, "pytest");
  assert.equal(document.limits.stallMinutes, 7);
  assert.deepEqual(document.review, { afterResolver: "lead-decides" });
  passes(claudeOnly);

  // A base's Grok writer is replaced where Claude or Codex is found, by the built-in binding.
  const grokWriter = baseConfig();
  grokWriter.roles.implementer = { engine: "grok", sandbox: "workspace" };
  const replaced = based(["claude", "grok"], grokWriter);
  assert.deepEqual(documentOf(replaced).roles.implementer, claude);
  assert.deepEqual(replaced.substitutions.find((each) => each.role === "implementer"), { role: "implementer", from: "grok", to: "claude" });
  assert.deepEqual(replaced.notes, []);
  passes(replaced);

  // A merge policy the write would refuse becomes auto, and says so.
  const yolo = baseConfig();
  yolo.project.mergePolicy = "yolo";
  const adjusted = based(["claude", "codex", "grok"], yolo);
  assert.equal(documentOf(adjusted).project.mergePolicy, "auto");
  assert.deepEqual(adjusted.notes, ["The main checkout's merge policy \"yolo\" is not auto or manual; this proposal uses auto."]);
  passes(adjusted);

  // A role the base leaves unbound is bound by the rule, from nothing.
  const unbound = baseConfig();
  delete unbound.roles.resolver;
  const bound = based(["claude", "codex", "grok"], unbound);
  assert.deepEqual(documentOf(bound).roles.resolver, builtInResolver);
  assert.deepEqual(bound.substitutions, [{ role: "resolver", from: null, to: "codex" }]);
  passes(bound);

  // Only Grok: writers on Grok with its profile and the note; no lead for a background team.
  const grokOnly = based(["grok"], base);
  const writer = { ...grok, sandbox: "workspace" };
  assert.deepEqual(documentOf(grokOnly).roles, {
    planner: grok, "plan-reviewer": grok, implementer: writer, "code-reviewer": [seats.grok], resolver: writer, consult: grok,
  });
  assert.deepEqual(grokOnly.notes, [setup.GROK_GIT_NOTE]);
  passes(grokOnly);
  const engineBase = based(["grok"], baseConfig("dev-team-engine"));
  assert.equal(engineBase.available, false);
  assert.equal(engineBase.reason, "the background team's lead must be Claude or Codex");
});

// The `records` block `init --propose` gives the background team (design section 6, "The
// `records` block"): beads' own commands where `.beads/` and `bd` are found, and
// project-steward's Markdown files, or nothing.

/** The tracker a beads project is proposed: bd's own commands, each create printing only the new id. */
const beadsTracker = {
  ready: ["bd", "ready"],
  show: ["bd", "show", "{id}"],
  create: ["bd", "create", "--title={title}", "--description={text}", "--parent={parent}", "--silent"],
  file: ["bd", "create", "--title={title}", "--description={text}", "--silent"],
  epic: ["bd", "create", "--type=epic", "--title={title}", "--description={text}", "--silent"],
  claim: ["bd", "update", "{id}", "--claim"],
  close: ["bd", "close", "{id}", "--reason={text}"],
  depend: ["bd", "dep", "add", "{id}", "{on}"],
  files: [".beads/interactions.jsonl"],
};

/** Each file under `root`, by its path there, with its text; a directory on the way is made. */
function lay(root: string, files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

/** A beads directory and a project-steward one, as a project that keeps both holds them. */
const beadsAndSteward = {
  ".beads/config.yaml": "issue-prefix: P\n", ".beads/interactions.jsonl": "",
  ".project-steward/PROGRESS.md": "# Progress\n", ".project-steward/HANDOFF.md": "# Handoff\n", ".project-steward/DECISIONS.md": "# Decisions\n",
};

/**
 * A main checkout keeping beads and project-steward, on a `PATH` holding Claude, Codex and an
 * executable `bd` that would leave a marker outside the repository if anything ran it. The
 * marker is the shell's own redirection, since that `PATH` holds no `touch`.
 */
async function recordsProject(t: TestContext): Promise<{ root: string; PATH: string; marker: string }> {
  const root = lay(await mainCheckout(scratch(t), "P"), beadsAndSteward);
  const PATH = enginePath(t, ["claude", "codex"]);
  const marker = path.join(scratch(t), "bd-ran");
  fs.writeFileSync(path.join(PATH, "bd"), `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
  fs.chmodSync(path.join(PATH, "bd"), 0o755);
  return { root, PATH, marker };
}

// @anchor proposeRecords
test("proposes records for the background team where it finds beads, bd on PATH and project-steward", async (t) => {
  const { root, PATH, marker } = await recordsProject(t);
  const expected = {
    files: [".project-steward/DECISIONS.md", ".project-steward/HANDOFF.md", ".project-steward/PROGRESS.md"], tracker: beadsTracker,
  };
  const proposed = await setup.propose(root, mainRepository(root), { env: { PATH } });
  const byMode = Object.fromEntries(proposed.proposals.map((proposal) => [proposal.mode, proposal]));
  const project = { defaultBranch: "main", testCommand: "none", setupCommand: "none", mergePolicy: "auto" };
  assert.deepEqual(documentOf(byMode["dev-team-engine"]), {
    ...setup.proposeMode(modes["dev-team-engine"], new Set(["claude", "codex"]), project).document, records: expected,
  });
  // Detection never gives the host-placed team or one-off help a block.
  assert.equal("records" in documentOf(byMode["dev-team"]), false);
  assert.equal("records" in documentOf(byMode.solo), false);
  // A base's own block stands over the one detected.
  const own = { files: [".project-steward/NOTES.md"], tracker: beadsTracker };
  const base = { ...baseConfig("dev-team-engine"), records: own };
  assert.deepEqual(documentOf(setup.proposeMode(modes["dev-team-engine"], new Set(["claude", "codex"]), project, { base, records: expected })).records, own);
  // A beads directory with only `metadata.json` is beads too.
  fs.rmSync(path.join(root, ".beads", "config.yaml"));
  fs.writeFileSync(path.join(root, ".beads", "metadata.json"), "{}\n");
  assert.deepEqual(setup.detectRecords(root, { PATH }), expected);
  // `bd` is looked up, never run.
  assert.equal(fs.existsSync(marker), false, "bd ran");
});

// @anchor proposeNoRecords
test("proposes no records block where either half is missing", async (t) => {
  const withBd = { PATH: enginePath(t, ["bd"]) };
  const withoutBd = { PATH: enginePath(t, ["claude", "codex"]) };
  const steward = { ".project-steward/HANDOFF.md": "# Handoff\n" };
  const beads = { ".beads/config.yaml": "issue-prefix: P\n" };
  assert.notEqual(setup.detectRecords(lay(scratch(t), { ...beads, ...steward }), withBd), null, "a complete project proposes a block");
  const linkedTo = (name: string, files: Record<string, string>): string => {
    const real = lay(scratch(t), files);
    const root = scratch(t);
    fs.symlinkSync(path.join(real, name), path.join(root, name), "dir");
    return root;
  };
  const cases: Array<[string, string, NodeJS.ProcessEnv]> = [
    ["no .beads/", lay(scratch(t), steward), withBd],
    [".beads/ holding only README.md", lay(scratch(t), { ".beads/README.md": "beads\n", ...steward }), withBd],
    ["no bd on PATH", lay(scratch(t), { ...beads, ...steward }), withoutBd],
    ["no .project-steward/", lay(scratch(t), beads), withBd],
    [".project-steward/ with only its state, config and backend", lay(scratch(t), {
      ...beads, ".project-steward/state.json": "{}\n", ".project-steward/config.toml": "", ".project-steward/backend.json": "{}\n",
    }), withBd],
    [".beads a symbolic link", lay(linkedTo(".beads", beads), steward), withBd],
    [".project-steward a symbolic link", lay(linkedTo(".project-steward", steward), beads), withBd],
  ];
  for (const [what, root, env] of cases) assert.equal(setup.detectRecords(root, env), null, what);

  // Without bd the background team is still proposed, with no block.
  const root = lay(await mainCheckout(scratch(t), "P"), { ...beads, ...steward });
  const engine = (await setup.propose(root, mainRepository(root), { env: withoutBd })).proposals.find((proposal) => proposal.mode === "dev-team-engine")!;
  assert.equal("records" in documentOf(engine), false);
});

// @anchor proposeRecordsStewardState
test("never proposes the steward's state, config, backend or runtime", async (t) => {
  const root = lay(scratch(t), {
    ".beads/config.yaml": "issue-prefix: P\n",
    ".project-steward/HANDOFF.md": "# Handoff\n", ".project-steward/state.json": "{}\n", ".project-steward/config.toml": "",
    ".project-steward/backend.json": "{}\n", ".project-steward/runtime/NOTES.md": "# Notes\n",
    ".project-steward/my notes.md": "outside the path alphabet\n", ".project-steward/AGENTS.md": "an instruction file\n",
  });
  fs.mkdirSync(path.join(root, ".project-steward", "notes.md"));
  fs.symlinkSync("HANDOFF.md", path.join(root, ".project-steward", "LINK.md"));
  assert.deepEqual(setup.detectRecords(root, { PATH: enginePath(t, ["bd"]) })?.files, [".project-steward/HANDOFF.md"]);
});

// @anchor proposedRecordsRegister
test("the proposed block passes init --config's checks and registers both tools", async (t) => {
  const { root, PATH } = await recordsProject(t);
  const proposed = (await setup.propose(root, mainRepository(root), { env: { PATH } })).proposals.find((proposal) => proposal.mode === "dev-team-engine")!;
  const document = documentOf(proposed);
  assert.equal(config.checkConfigDocument(JSON.stringify(document), "proposal").mode.id, "dev-team-engine");
  fs.mkdirSync(path.join(root, ".cross-agent"));
  fs.writeFileSync(path.join(root, CONFIG_PATH), JSON.stringify(document));
  const loaded = loadConfigWithMode(root);
  assert.deepEqual(loaded.config.records, document.records);
  const names = projectTools(root, { mode: loaded.mode, records: loaded.config.records }).map((tool) => tool.name);
  for (const name of ["record", "track"]) assert.ok(names.includes(name), `${name} is registered: ${names.join(", ")}`);
});
