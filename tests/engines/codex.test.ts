import "../child-check.mjs";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import codex from "../../src/engines/codex.ts";
import { adapterFor, sandboxFor } from "../../src/engines/registry.ts";
import { commandPath } from "../../src/engines/binaries.ts";
import { canonicalPath } from "../../src/reservation.ts";
import { spawnEngine } from "../../src/engines/spawn.ts";
import { childEnv } from "../../src/guard.ts";
import { loadConfigWithMode } from "../../src/config.ts";
import { builtInModesDir } from "../../src/modes.ts";
import { discoverProject } from "../../src/project.ts";
import type { EngineAdapter, EngineEvent, SpawnRequest } from "../../src/engines/types.ts";
import { configClient } from "../../skills/cross-agent/scripts/codex-config.mjs";
import {
  absentControl, acceptanceOf, armFailures, armsFor, armsFrom, briefFor, canonical, carriersOf, cellA, cellB, cellD, commandsOf, coverageLimitations, coverageTargets,
  expectedInventoryControl, forcedPlugins, isolationArgs, judgeTurn, originOf, ownedProjectKeys, parseRollout, preferenceSubtrees,
  skillsBlocks,
} from "../helpers/codex-isolation.ts";
import type { Arms, TurnEvidence, TurnSpec, TurnVerdict } from "../helpers/codex-isolation.ts";

const fake = fileURLToPath(new URL("../fixtures/fake-engine.mjs", import.meta.url));

const targets = Object.freeze([
  "claude", "codex", "grok", "/opt/custom codex", "node /projects/team/src/server.ts", "node /projects/team/src/cli.ts",
  "/projects/team/bin/cross-agent", "cross-agent",
]);

// The id the ledger holds for the task. Codex never receives it: `codex exec` mints its
// own thread id and reports it on `thread.started`, so this string proves its absence.
const sessionId = "11111111-1111-4111-8111-111111111111";
// P10's thread, the id a resume names.
const threadId = "01a0855f-287a-7f32-85ab-0d336bd260a3";

function reasonFor(support: ReturnType<EngineAdapter["sandboxSupport"]>): string {
  if (support.ok) assert.fail("expected a refusal");
  return support.reason;
}

function scratch(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), "cross-agent-codex-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A task's directories: the project root, a specialist's worktree, and the task's own scratch. */
function layout(t: TestContext) {
  const root = scratch(t);
  const task = path.join(root, "tasks", "t1");
  const worktree = path.join(root, "worktrees", "implementer");
  mkdirSync(task, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return { root, task, worktree, role: path.join(task, "role.md"), result: path.join(task, "task.out") };
}

function requestFor(dirs: ReturnType<typeof layout>, patch: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    role: "implementer",
    brief: "Implement the brief.",
    rolePrompt: "You are the implementer.\n",
    cwd: dirs.worktree,
    engine: "codex",
    sandbox: sandboxFor("codex", "workspace-write"),
    sessionId,
    denyTargets: [...targets],
    env: {},
    scratchDir: dirs.task,
    logPath: path.join(dirs.task, "task.ndjson"),
    resultPath: dirs.result,
    ...patch,
  };
}

/** The TOML the adapter has to emit for a role file, quotes included (P9). */
const instructions = (file: string) => `model_instructions_file=${JSON.stringify(file)}`;

/**
 * A stand-in for the `codex` binary, reached the way a configured one is
 * (`CROSS_AGENT_CODEX_BIN`). It runs the fake engine in its own process, so
 * `process.argv.slice(2)` there is exactly the argv the adapter built; before that it
 * plays the one part the fixture cannot, writing `CODEX_SHIM_LAST` to the file the argv's
 * own `-o` names, as `codex exec` writes its last message there.
 */
function shim(directory: string): string {
  const file = path.join(directory, "codex-shim.mjs");
  writeFileSync(file,
    `#!${process.execPath}\n`
    + 'import { writeFileSync } from "node:fs";\n'
    + 'const out = process.argv[process.argv.indexOf("-o") + 1];\n'
    + 'if (process.env.CODEX_SHIM_LAST) writeFileSync(out, process.env.CODEX_SHIM_LAST);\n'
    + `await import(${JSON.stringify(pathToFileURL(fake).href)});\n`);
  chmodSync(file, 0o755);
  return file;
}

test("the built-in table answers for codex with this adapter", () => {
  assert.equal(adapterFor("codex"), codex);
  assert.equal(codex.name, "codex");
});

// @anchor codexDeclaresOwn
test("codex declares its own profile names and what each one means", () => {
  // `off` is `--sandbox danger-full-access` in argv, which `plan` owns, not this map.
  assert.deepEqual(codex.sandboxProfiles, { "read-only": "read-only", "workspace-write": "write", off: "off" });
});

// @anchor codexCarriesDeny
test("codex carries no deny list: its sandbox's network denial is that layer (P3/P3b)", () => {
  assert.deepEqual(codex.denyArgs(targets), []);
  assert.deepEqual(codex.denyArgs([]), []);
});

// @anchor codexExclusionargsRemoves
test("codex's exclusionArgs removes the operator's own configuration and switches off plugins and remote plugins", () => {
  // The flag drops the user's MCP servers but not the account's remote plugins
  // (`docs/probes.md#codexPluginLeak`), and the CLI's defaults enable both switches.
  assert.deepEqual(codex.exclusionArgs(), ["--ignore-user-config", "-c", "features.plugins=false", "-c", "features.remote_plugin=false"]);
});

// @anchor codexLeadmountSettings
test("codex's leadMount is P9's three -c settings, the per-tool timeout and the markers' whitelist, byte for byte", () => {
  const mount = codex.leadMount({ command: "node", args: ["/projects/team/src/server.ts"] }, "/projects/team/.cross-agent/tasks/task");
  assert.deepEqual(mount.argv, [
    "-c", 'mcp_servers.cross-agent.command="node"',
    "-c", 'mcp_servers.cross-agent.args=["/projects/team/src/server.ts"]',
    "-c", 'mcp_servers.cross-agent.default_tools_approval_mode="approve"',
    // Codex's own default is 60 s a call, and a lead's `wait` and `ask` are 600 s ones.
    "-c", "mcp_servers.cross-agent.tool_timeout_sec=3600",
    // Codex starts a stdio server with a short environment of its own, so the task's four
    // markers reach it only by name; their values are the engine's own (B2).
    "-c", 'mcp_servers.cross-agent.env_vars=["CROSS_AGENT_DEPTH","CROSS_AGENT_TASK","CROSS_AGENT_LINEAGE","CROSS_AGENT_PROJECT"]',
  ]);
  // Nothing to write, and nothing inherited: the mount is entirely in the argv.
  assert.equal(mount.files, undefined);
  assert.equal(mount.inherited, undefined);
  // TOML values, so a value that needs quoting gets it.
  const quoted = codex.leadMount({ command: "/opt/my node", args: ["--project", 'C:\\team"x"'] }, "/scratch");
  assert.deepEqual(quoted.argv.slice(0, 4), [
    "-c", 'mcp_servers.cross-agent.command="/opt/my node"',
    "-c", 'mcp_servers.cross-agent.args=["--project","C:\\\\team\\"x\\""]',
  ]);
});

test("codex's leadMount refuses an environment no probed setting can carry", () => {
  const spec = { command: "node", args: ["/projects/team/src/server.ts"], env: { CROSS_AGENT_PROJECT: "/projects/team" } };
  assert.throws(() => codex.leadMount(spec, "/scratch"), /codex leadMount.*env/i);
  // An empty one asks for nothing, so it is the same mount as none at all.
  assert.deepEqual(codex.leadMount({ ...spec, env: {} }, "/scratch").argv, codex.leadMount({ command: spec.command, args: spec.args }, "/scratch").argv);
});

test("codex's sandbox support reports the binary it cannot resolve, from the spawn's own environment", (t) => {
  const missing = path.join(process.cwd(), "no-such-codex-binary");
  const reason = reasonFor(codex.sandboxSupport({ CROSS_AGENT_CODEX_BIN: missing }));
  assert.match(reason, /no-such-codex-binary/);
  assert.match(reason, /codex/);
  assert.deepEqual(codex.sandboxSupport({ CROSS_AGENT_CODEX_BIN: process.execPath }), { ok: true });
  // The environment handed in is the whole of it: a `codex` on this process's own PATH
  // answers for nothing, because the spawn will run with the environment below.
  const directory = scratch(t);
  assert.match(reasonFor(codex.sandboxSupport({ PATH: directory })), /^codex binary "codex" not found/);
  writeFileSync(path.join(directory, "codex"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(directory, "codex"), 0o755);
  assert.deepEqual(codex.sandboxSupport({ PATH: directory }), { ok: true });
});

// @anchor sandboxforPairsProfile
test("sandboxFor pairs a profile with the mode codex gives it, and refuses any other", () => {
  for (const [profile, mode] of Object.entries(codex.sandboxProfiles)) {
    assert.deepEqual(sandboxFor("codex", profile), { mode, profile });
  }
  // Another engine's profile name, and names only Object.prototype carries.
  for (const profile of ["strict", "workspace", "toString", ""]) {
    assert.throws(() => sandboxFor("codex", profile), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("codex"), error.message);
      assert.ok(error.message.includes(JSON.stringify(profile)), error.message);
      return true;
    });
  }
});

// @anchor readOnlyRole
test("a read-only role's argv is P2's exec line, and the -o file is the pipeline's own", (t) => {
  const dirs = layout(t);
  const request = requestFor(dirs, {
    role: "code-reviewer", brief: "Review the branch.", rolePrompt: "You are the code reviewer.\n",
    cwd: dirs.root, sandbox: sandboxFor("codex", "read-only"), model: "gpt-6-astra",
  });
  const plan = codex.plan(request);
  assert.equal(plan.bin, "codex");
  assert.equal(plan.cwd, dirs.root);
  assert.equal(plan.env, request.env);
  assert.deepEqual(plan.argv, [
    "exec", "--json", "-o", dirs.result, "-C", dirs.root, "--sandbox", "read-only",
    "--ignore-user-config", "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "--skip-git-repo-check",
    "-m", "gpt-6-astra",
    "-c", instructions(dirs.role),
    "-",
  ]);
  // The prompt goes on stdin, with `-` holding its place: a bare positional would be read
  // as a flag the moment a brief began with `-`, and a brief is prose the lead composes.
  assert.equal(plan.stdin, "Review the branch.");
  assert.equal(plan.argv.includes("Review the branch."), false);
  // The `-o` file is the one the pipeline reads back and rewrites with the final message.
  assert.equal(plan.argv[plan.argv.indexOf("-o") + 1], request.resultPath);
});

// @anchor writeRoleArgv
test("a write role's argv names its worktree as the cwd and workspace-write as the sandbox", (t) => {
  const dirs = layout(t);
  const plan = codex.plan(requestFor(dirs, { model: "gpt-6-astra", effort: "high" }));
  assert.equal(plan.cwd, dirs.worktree);
  assert.deepEqual(plan.argv, [
    "exec", "--json", "-o", dirs.result, "-C", dirs.worktree, "--sandbox", "workspace-write",
    "--ignore-user-config", "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "--skip-git-repo-check",
    "-m", "gpt-6-astra",
    "-c", 'model_reasoning_effort="high"',
    "-c", instructions(dirs.role),
    "-",
  ]);
  assert.equal(plan.stdin, "Implement the brief.");
  // No deny layer of any kind reaches the argv: P3 found execpolicy rules unenforced.
  for (const argument of plan.argv) assert.equal(argument.includes("execpolicy"), false, argument);
});

// @anchor offProfileLaunches
test("the off profile launches as danger-full-access, the name Codex gives no sandbox", (t) => {
  const dirs = layout(t);
  const plan = codex.plan(requestFor(dirs, { sandbox: sandboxFor("codex", "off") }));
  assert.deepEqual(plan.argv, [
    "exec", "--json", "-o", dirs.result, "-C", dirs.worktree, "--sandbox", "danger-full-access",
    "--ignore-user-config", "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "--skip-git-repo-check",
    "-c", instructions(dirs.role),
    "-",
  ]);
  // The portable mode's name is this project's; `--sandbox` only ever sees Codex's own.
  assert.equal(plan.argv.includes("off"), false);
});

// @anchor resumedRunExec
test("a resumed run is exec resume: no -C, no --sandbox, and the profile restored (P10)", (t) => {
  const dirs = layout(t);
  const request = requestFor(dirs, { resumeSessionId: threadId, model: "gpt-6-astra", effort: "high" });
  const plan = codex.plan(request);
  assert.deepEqual(plan.argv, [
    "exec", "resume", threadId, "--json", "-o", dirs.result,
    "--ignore-user-config", "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "--skip-git-repo-check",
    "-m", "gpt-6-astra",
    "-c", 'model_reasoning_effort="high"',
    "-c", 'sandbox_mode="workspace-write"',
    "-c", instructions(dirs.role),
    "-",
  ]);
  // Both heads read `-` from stdin: `codex exec resume [SESSION_ID] [PROMPT]` documents
  // "If `-` is used, read from stdin" exactly as `codex exec` does (0.153.4 `--help`).
  assert.equal(plan.stdin, "Implement the brief.");
  // `codex exec resume` accepts neither flag (0.153.4 `--help`), and `-c cwd=` is ignored:
  // the resuming process's own cwd is the only lever on the writable root, so it is the
  // role's workspace and the plan carries it there.
  assert.equal(plan.argv.includes("-C"), false);
  assert.equal(plan.argv.includes("--sandbox"), false);
  assert.equal(plan.argv.some((argument) => argument.startsWith("cwd=")), false);
  assert.equal(plan.cwd, request.cwd);
  // Never both: a resumed run is the thread it names, and Codex mints the id itself.
  assert.equal(plan.argv.includes(sessionId), false);
});

// @anchor offRoleResumes
test("an off role resumes as sandbox_mode=danger-full-access, never by omission (P10)", (t) => {
  const dirs = layout(t);
  const plan = codex.plan(requestFor(dirs, { resumeSessionId: threadId, sandbox: sandboxFor("codex", "off") }));
  assert.deepEqual(plan.argv, [
    "exec", "resume", threadId, "--json", "-o", dirs.result,
    "--ignore-user-config", "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "--skip-git-repo-check",
    "-c", 'sandbox_mode="danger-full-access"',
    "-c", instructions(dirs.role),
    "-",
  ]);
  // A read-only role resumes read-only, which is what a thread does on its own; saying it
  // is still the adapter's job, because the thread is not what it was launched as.
  const readOnly = codex.plan(requestFor(dirs, { resumeSessionId: threadId, sandbox: sandboxFor("codex", "read-only") }));
  assert.equal(readOnly.argv.find((argument) => argument.startsWith("sandbox_mode=")), 'sandbox_mode="read-only"');
});

// @anchor rolePromptTravels
test("the role prompt travels as a file under scratchDir, pointed at by -c (P9)", (t) => {
  const dirs = layout(t);
  const plan = codex.plan(requestFor(dirs));
  // The role file is the task's own, never inside the worktree the role may edit.
  assert.equal(path.dirname(dirs.role), dirs.task);
  assert.equal(plan.argv.find((argument) => argument.startsWith("model_instructions_file=")), instructions(dirs.role));
  const role = plan.files?.find((file) => file.path === dirs.role);
  assert.deepEqual(role, { path: dirs.role, contents: "You are the implementer.\n" });
  // The adapter names the files; the pipeline is what puts them on disk.
  for (const file of plan.files!) assert.equal(existsSync(file.path), false);
  // A path needing TOML quoting gets it, since the value is TOML and not a bare argument.
  // Both characters a TOML basic string escapes are in this one: a quote and a backslash,
  // and the escaper here is written out rather than borrowed from the implementation.
  const odd = path.join(dirs.root, 'a "task"\\dir');
  const quoted = codex.plan(requestFor(dirs, { scratchDir: odd }));
  const escaped = path.join(odd, "role.md").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  assert.equal(quoted.argv.find((argument) => argument.startsWith("model_instructions_file=")), `model_instructions_file="${escaped}"`);
  assert.ok(escaped.includes('\\"') && escaped.includes("\\\\"), escaped);
});

test("a role with no prompt of its own is pointed at no instructions file at all", (t) => {
  const dirs = layout(t);
  const plan = codex.plan(requestFor(dirs, { rolePrompt: "" }));
  assert.deepEqual(plan.argv, [
    "exec", "--json", "-o", dirs.result, "-C", dirs.worktree, "--sandbox", "workspace-write",
    "--ignore-user-config", "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "--skip-git-repo-check",
    "-",
  ]);
  assert.equal(plan.files?.some((file) => file.path === dirs.role), false);
});

// @anchor fileEmptiedRun
test("the -o file is emptied before the run, so a stale result cannot be read as this one's", (t) => {
  const dirs = layout(t);
  const plan = codex.plan(requestFor(dirs));
  // `codex exec -o` writes the file at the end of the turn; a run that dies before that
  // would otherwise leave the previous run's message for the pipeline to read back and
  // report as this run's, which on a resumed task is the same file every time.
  assert.deepEqual(plan.files?.[0], { path: dirs.result, contents: "" });
  assert.deepEqual(plan.files?.map((file) => file.path), [dirs.result, dirs.role]);
});

// @anchor enginePlacedLead
test("an engine-placed lead's argv carries P9's three -c settings, the tool timeout and the whitelist before the prompt", (t) => {
  const dirs = layout(t);
  const lead = { command: process.execPath, args: ["/projects/team/src/server.ts", "--project", "/projects/team"] };
  const mount = [
    "-c", `mcp_servers.cross-agent.command=${JSON.stringify(process.execPath)}`,
    "-c", 'mcp_servers.cross-agent.args=["/projects/team/src/server.ts","--project","/projects/team"]',
    "-c", 'mcp_servers.cross-agent.default_tools_approval_mode="approve"',
    "-c", "mcp_servers.cross-agent.tool_timeout_sec=3600",
    "-c", 'mcp_servers.cross-agent.env_vars=["CROSS_AGENT_DEPTH","CROSS_AGENT_TASK","CROSS_AGENT_LINEAGE","CROSS_AGENT_PROJECT"]',
  ];
  assert.deepEqual(codex.leadMount(lead, dirs.task).argv, mount);
  const plan = codex.plan(requestFor(dirs, { role: "lead", brief: "Run the loop.", rolePrompt: "You are the lead.\n", lead }));
  assert.deepEqual(plan.argv, [
    "exec", "--json", "-o", dirs.result, "-C", dirs.worktree, "--sandbox", "workspace-write",
    "--ignore-user-config", "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "--skip-git-repo-check",
    "-c", instructions(dirs.role),
    ...mount,
    "-",
  ]);
  assert.equal(plan.stdin, "Run the loop.");
  // Nothing variadic and nothing greedy is left holding the end of the line: `-` is the
  // last argument, and every `-c` before it takes exactly one value.
  assert.equal(plan.argv.at(-1), "-");
  // The mount travels with the flag that makes it exclusive, and there is one of each.
  assert.equal(plan.argv.filter((argument) => argument === "--ignore-user-config").length, 1);
  assert.equal(plan.argv.filter((argument) => argument.startsWith("mcp_servers.")).length, 5);
  // A lead is resumed too, and the mount has to survive the different flag set.
  const resumed = codex.plan(requestFor(dirs, { role: "lead", rolePrompt: "You are the lead.\n", lead, resumeSessionId: threadId }));
  assert.equal(resumed.argv.filter((argument) => argument.startsWith("mcp_servers.")).length, 5);
  assert.deepEqual(resumed.argv.slice(resumed.argv.indexOf("-c", resumed.argv.indexOf(instructions(dirs.role)) + 1), -1), mount);
  // `plan` folds the whole mount, files included; Codex's own carries none, so the plan's
  // files stay the two it names itself.
  assert.equal(codex.leadMount(lead, dirs.task).files, undefined);
  assert.deepEqual(plan.files?.map((file) => file.path), [dirs.result, dirs.role]);
});

/** What every Codex child carries: the flag, then both plugin switches, off (`docs/probes.md#codexPluginLeak`). */
const pluginIsolation = ["--ignore-user-config", "-c", "features.plugins=false", "-c", "features.remote_plugin=false"];

// @anchor codexPluginIsolation
test("every codex child, fresh or resumed, switches off plugins and remote plugins once, beside --ignore-user-config", (t) => {
  const dirs = layout(t);
  const lead = { command: process.execPath, args: ["/projects/team/src/server.ts", "--project", "/projects/team"] };
  for (const resumeSessionId of [undefined, threadId]) {
    for (const profile of Object.keys(codex.sandboxProfiles)) {
      for (const rolePrompt of ["You are the implementer.\n", ""]) {
        for (const mounted of [false, true]) {
          const what = JSON.stringify({ resumeSessionId, profile, rolePrompt, mounted });
          const { argv } = codex.plan(requestFor(dirs, {
            resumeSessionId, sandbox: sandboxFor("codex", profile), rolePrompt, ...(mounted ? { role: "lead", lead } : {}),
          }));
          // The five together, once, and no other value for either switch: the CLI's defaults
          // enable both, so a setting left out or overridden later would be the default's.
          const at = argv.indexOf("--ignore-user-config");
          assert.deepEqual(argv.slice(at, at + pluginIsolation.length), pluginIsolation, what);
          assert.equal(argv.filter((argument) => argument === "--ignore-user-config").length, 1, what);
          assert.deepEqual(argv.filter((argument) => /^features\.(plugins|remote_plugin)\b/.test(argument)),
            ["features.plugins=false", "features.remote_plugin=false"], what);
          // No plugin is named, so none is enabled one by one either.
          assert.equal(argv.some((argument) => argument.startsWith("plugins.")), false, what);
          assert.equal(argv.at(-1), "-", what);
        }
      }
    }
  }
});

// @anchor codexPluginIsolationPipeline
test("the pipeline delivers the plugin switches to a resumed codex child", async (t) => {
  const dirs = layout(t);
  const record = path.join(dirs.task, "record.json");
  const request = requestFor(dirs, {
    resumeSessionId: threadId,
    env: { FAKE_ENGINE_FORMAT: "codex", FAKE_ENGINE_SCRIPT: "ok", FAKE_ENGINE_RECORD: record, CROSS_AGENT_CODEX_BIN: shim(dirs.root) },
  });
  const handle = spawnEngine(codex, request, {});
  t.after(() => { handle.kill("SIGKILL"); });
  const result = await handle.result;
  assert.equal(result.ok, true, JSON.stringify(result.events));
  // The argv the child itself received, not the plan's.
  const { argv } = JSON.parse(readFileSync(record, "utf8")) as { argv: string[] };
  assert.deepEqual(argv.slice(0, 3), ["exec", "resume", threadId]);
  const at = argv.indexOf("--ignore-user-config");
  assert.deepEqual(argv.slice(at, at + pluginIsolation.length), pluginIsolation);
});

test("the -C cwd is the request's cwd exactly, and that cwd is already canonical", (t) => {
  const dirs = layout(t);
  // A workspace reached through a symlink is a second string for one directory. The child
  // sees the real one, and the reservation is keyed by the real one, so the request carries
  // the real one and the adapter passes it through untouched.
  const link = path.join(dirs.root, "link-to-worktree");
  symlinkSync(dirs.worktree, link);
  const cwd = canonicalPath(link);
  assert.notEqual(cwd, link);
  assert.equal(cwd, canonicalPath(dirs.worktree));
  const plan = codex.plan(requestFor(dirs, { cwd }));
  assert.equal(plan.cwd, cwd);
  assert.equal(plan.argv[plan.argv.indexOf("-C") + 1], cwd);
  assert.equal(plan.argv.includes(link), false);
});

test("a configured binary is the one the plan spawns", (t) => {
  const dirs = layout(t);
  const bin = "/opt/custom/codex";
  assert.equal(codex.plan(requestFor(dirs, { env: { CROSS_AGENT_CODEX_BIN: bin } })).bin, bin);
});

test("codex's parseLine reads the thread id from thread.started and nothing else", () => {
  assert.deepEqual(codex.parseLine('{"type":"thread.started","thread_id":"01a07ca9-83fb-78a0-a330-6b7555f3632f"}'),
    { kind: "session", sessionId: "01a07ca9-83fb-78a0-a330-6b7555f3632f" });
  for (const line of ['{"type":"thread.started"}', '{"type":"thread.started","thread_id":42}', '{"type":"turn.started"}']) {
    assert.equal(codex.parseLine(line), null, line);
  }
});

test("a completed agent message and a completed command are both activity, capped at 200", () => {
  const item = (value: unknown) => codex.parseLine(JSON.stringify({ type: "item.completed", item: value }));
  assert.deepEqual(item({ id: "item_2", type: "agent_message", text: "I'll run the command." }),
    { kind: "activity", text: "I'll run the command." });
  assert.deepEqual(item({ id: "item_1", type: "command_execution", command: "/bin/bash -lc 'npm test'", aggregated_output: "…", exit_code: 0, status: "completed" }),
    { kind: "activity", text: "/bin/bash -lc 'npm test'" });
  assert.deepEqual(item({ id: "x", type: "agent_message", text: "x".repeat(300) }), { kind: "activity", text: "x".repeat(200) });
  assert.deepEqual(item({ id: "x", type: "command_execution", command: "c".repeat(300) }), { kind: "activity", text: "c".repeat(200) });
  // By code point: cutting UTF-16 units would leave a lone surrogate in the ledger.
  assert.deepEqual(item({ id: "x", type: "agent_message", text: "🌙".repeat(250) }), { kind: "activity", text: "🌙".repeat(200) });
  // The item type is what identifies the line; a missing string is still the engine alive,
  // which is what advances lastEventAt and keeps the task off the stall path.
  assert.deepEqual(item({ id: "x", type: "agent_message" }), { kind: "activity", text: "" });
  // Every other item type Codex reports is the log's alone.
  for (const value of [{ id: "x", type: "reasoning" }, { id: "x", type: "file_change" }, { id: "x" }, null, "agent_message"]) {
    assert.equal(item(value), null, JSON.stringify(value));
  }
});

/**
 * The MCP call Codex 0.159.2 recorded for a tracked child's `list_roles`
 * (`docs/probes.md#i1CodexTracked`, the 6b archive's `a4/`), trimmed: announced as
 * `item.started`, closed as `item.completed`, the server and the tool as two fields.
 */
const mcpStarted = '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"cross-agent","tool":"list_roles","arguments":{},"result":null,"error":null,"status":"in_progress"}}';
const mcpCompleted = '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"cross-agent","tool":"list_roles","arguments":{},"result":{"content":[{"type":"text","text":"{\\n  \\"roles\\": {}\\n}"}],"structured_content":null},"error":null,"status":"completed"}}';

// @anchor mcpCallIsActivity
test("an MCP call is activity, announced and completed, and an item nothing recorded is still not an event", () => {
  // A lead that only calls `wait` and `ask` for the stall threshold is working: these two
  // lines are the whole of what its stream says meanwhile (design, "Time limits").
  assert.deepEqual(codex.parseLine(mcpCompleted), { kind: "activity", text: "mcp_tool_call cross-agent.list_roles completed" });
  assert.deepEqual(codex.parseLine(mcpStarted), { kind: "activity", text: "mcp_tool_call cross-agent.list_roles in_progress" });
  // Capped as every other activity is.
  const long = JSON.parse(mcpCompleted);
  long.item.tool = "t".repeat(300);
  assert.equal(Array.from((codex.parseLine(JSON.stringify(long)) as { text: string }).text).length, 200);
  // The item type is what identifies the line, so one missing its strings is still a call.
  assert.deepEqual(codex.parseLine('{"type":"item.completed","item":{"type":"mcp_tool_call"}}'), { kind: "activity", text: "mcp_tool_call" });
  for (const line of [
    '{"type":"item.started","item":{"id":"x","type":"web_search"}}',
    '{"type":"item.completed","item":{"id":"x","type":"web_search"}}',
    '{"type":"item.started","item":{"type":"agent_message"}}',
    '{"type":"item.updated","item":{"type":"mcp_tool_call"}}',
  ]) {
    assert.equal(codex.parseLine(line), null, line);
  }
});

// @anchor mcpCallAdvancesClock
test("the stall clock advances on an MCP call's line and on nothing else between", async (t) => {
  const dirs = layout(t);
  // A codex that says its thread, is silent, makes one MCP call, is silent, and ends.
  const bin = path.join(dirs.root, "codex-mcp-shim.mjs");
  writeFileSync(bin,
    `#!${process.execPath}\n`
    + "for await (const _ of process.stdin) {}\n"
    + "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n"
    + `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\n")});\n`
    + "await sleep(300);\n"
    + `process.stdout.write(${JSON.stringify(mcpCompleted + "\n")});\n`
    + "await sleep(300);\n"
    + `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "turn.completed" }) + "\n")});\n`);
  chmodSync(bin, 0o755);
  const request = requestFor(dirs, { sandbox: sandboxFor("codex", "read-only"), env: { CROSS_AGENT_CODEX_BIN: bin } });
  const handle = spawnEngine(codex, request, {});
  t.after(() => { handle.kill("SIGKILL"); });
  const logged = (text: string) => existsSync(request.logPath) && readFileSync(request.logPath, "utf8").includes(text);
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, "the shim's line never reached the log");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  await until(() => logged('"thread.started"'));
  const afterSession = handle.lastEventAt;
  assert.notEqual(afterSession, null, "the session line is an event");
  // The silence after it is silence: nothing moved the clock.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(handle.lastEventAt, afterSession);
  await until(() => logged('"mcp_tool_call"'));
  assert.ok(handle.lastEventAt! > afterSession!, `${handle.lastEventAt} after ${afterSession}`);

  const result = await handle.result;
  assert.equal(result.ok, true, JSON.stringify(result.events));
  assert.deepEqual(result.events, [
    { kind: "session", sessionId: threadId },
    { kind: "activity", text: "mcp_tool_call cross-agent.list_roles completed" },
    { kind: "result", text: "" },
  ]);
});

test("turn.completed is the run's result and turn.failed its error", () => {
  // The turn's own text is the `-o` file's; this line is that the turn ended.
  assert.deepEqual(codex.parseLine('{"type":"turn.completed","usage":{"input_tokens":1}}'), { kind: "result", text: "" });
  assert.deepEqual(codex.parseLine('{"type":"turn.failed","error":{"message":"stream error: exceeded retry limit"}}'),
    { kind: "error", text: "stream error: exceeded retry limit" });
  // A failure has to say something even when the engine does not.
  for (const line of ['{"type":"turn.failed"}', '{"type":"turn.failed","error":{}}', '{"type":"turn.failed","error":{"message":""}}']) {
    const event = codex.parseLine(line);
    assert.equal(event?.kind, "error", line);
    assert.match(event!.text, /codex/, line);
  }
});

test("a line codex's vocabulary does not cover is not an event", () => {
  for (const line of [
    "", " ", "not json", "[]", "null", "42", '"text"', "{}", '{"type":"turn.started"}',
    '{"type":"item.started","item":{"type":"agent_message"}}', '{"thread_id":"x"}', '{"type":"error"}',
  ]) {
    assert.equal(codex.parseLine(line), null, line);
  }
});

// @anchor codexDeclaresFinish
test("codex declares no finish and no stderr reader: its output is a line stream", () => {
  const adapter: EngineAdapter = codex;
  assert.equal(adapter.finish, undefined);
  assert.equal(Object.hasOwn(codex, "finish"), false);
  // P1's stderr sandbox failure is Claude's alone; Codex reports its own in the stream.
  assert.equal(adapter.parseStderrLine, undefined);
  assert.equal(Object.hasOwn(codex, "parseStderrLine"), false);
});

test("codex's final message is the -o file's, then the last result, then the last error", () => {
  const events: EngineEvent[] = [
    { kind: "session", sessionId: threadId }, { kind: "activity", text: "working" }, { kind: "result", text: "" },
  ];
  // The file is Codex's own last message, and it wins: `turn.completed` carries no text.
  assert.equal(codex.finalMessage(events, "the final message\n"), "the final message\n");
  // Emptied before the run and never written: the events are all the evidence there is.
  assert.equal(codex.finalMessage(events, ""), "");
  assert.equal(codex.finalMessage([...events, { kind: "error", text: "the failure" }], ""), "the failure");
  assert.equal(codex.finalMessage([{ kind: "error", text: "the failure" }], null), "the failure");
  assert.equal(codex.finalMessage([{ kind: "result", text: "a turn that spoke" }], ""), "a turn that spoke");
  assert.equal(codex.finalMessage([], null), "");
});

// @anchor fakeCodexRun
test("a fake codex run through the pipeline yields the thread id, the activity and the -o text", async (t) => {
  const dirs = layout(t);
  const bin = shim(dirs.root);
  const record = path.join(dirs.task, "record.json");
  const last = "the message codex wrote to its -o file\n";
  const request = requestFor(dirs, {
    model: "gpt-6-astra", effort: "high",
    env: {
      FAKE_ENGINE_FORMAT: "codex", FAKE_ENGINE_SCRIPT: "ok", FAKE_ENGINE_RECORD: record,
      CODEX_SHIM_LAST: last, CROSS_AGENT_CODEX_BIN: bin,
    },
  });
  const argv = [
    "exec", "--json", "-o", dirs.result, "-C", dirs.worktree, "--sandbox", "workspace-write",
    "--ignore-user-config", "-c", "features.plugins=false", "-c", "features.remote_plugin=false", "--skip-git-repo-check",
    "-m", "gpt-6-astra",
    "-c", 'model_reasoning_effort="high"',
    "-c", instructions(dirs.role),
    "-",
  ];
  // A previous run's message, which the emptied `-o` file must not let through as this one's.
  writeFileSync(dirs.result, "the previous run's final message");
  // The role prompt is a file the child is pointed at, so it has to be on disk already.
  let roleAtSpawn: string | null = null;
  let resultAtSpawn: string | null = null;
  const handle = spawnEngine(codex, request, {
    spawn(binary, args, options) {
      roleAtSpawn = readFileSync(dirs.role, "utf8");
      resultAtSpawn = readFileSync(dirs.result, "utf8");
      return spawn(binary, args, options);
    },
  });
  t.after(() => { handle.kill("SIGKILL"); });
  const result = await handle.result;

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(roleAtSpawn, request.rolePrompt);
  assert.equal(resultAtSpawn, "");
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")).argv, argv);
  // `-` holds the prompt's place in the argv and the brief arrives on stdin, which is
  // what the child read: the fixture echoes back every byte it was given.
  assert.equal(JSON.parse(readFileSync(record, "utf8")).stdin, request.brief);
  assert.equal(JSON.parse(readFileSync(record, "utf8")).cwd, dirs.worktree);
  assert.match(result.sessionId ?? "", /^fake-\d+$/);
  // Codex's last word arrives as an `agent_message` item like any other, so the ledger
  // gets it capped at 200 characters and the `-o` file is what carries it in full.
  const done = `DONE ${argv.join(" ")}`;
  assert.ok(done.length > 200, "the fixture's echo has to exceed the cap for this to prove it");
  assert.deepEqual(result.events, [
    { kind: "session", sessionId: result.sessionId! },
    { kind: "activity", text: "working" },
    { kind: "activity", text: Array.from(done).slice(0, 200).join("") },
    { kind: "result", text: "" },
  ]);
  // The `-o` file the argv named is the one the pipeline read back.
  assert.equal(result.finalMessage, last);
  assert.equal(readFileSync(request.resultPath, "utf8"), last);
});

// @anchor failedTurnSettles
test("a failed turn settles as an error carrying codex's own message", async (t) => {
  const dirs = layout(t);
  const bin = shim(dirs.root);
  const request = requestFor(dirs, {
    env: { FAKE_ENGINE_FORMAT: "codex", FAKE_ENGINE_SCRIPT: "fail", CROSS_AGENT_CODEX_BIN: bin },
  });
  const handle = spawnEngine(codex, request, {});
  t.after(() => { handle.kill("SIGKILL"); });
  const result = await handle.result;

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.events.map((event) => event.kind), ["session", "activity", "error"]);
  assert.equal(result.events.at(-1)!.text, "fake failure");
  // No `-o` file was written, and the emptied one says nothing, so the error is the word.
  assert.equal(result.finalMessage, "fake failure");
});

// I2 covers two things only the real binary can answer, and both need an account and
// about a minute per turn.
//
// The stdin form on **both heads**: `codex exec … -` and `codex exec resume <id> … -`
// must each take the brief from stdin rather than send the literal `-` as the prompt.
// `--help` on 0.153.4 documents it for each — `codex exec [PROMPT]` says "If not provided
// as an argument (or if `-` is used), instructions are read from stdin", and `codex exec
// resume [SESSION_ID] [PROMPT]` says "If `-` is used, read from stdin" — so the flag fact
// is settled and what is left is that the run behaves as the help says, on both heads.
//
// And the P2 negative writes on a *resumed* session (design, Verification, "P10 / T8"): a
// resume with `-c sandbox_mode="workspace-write"`, spawned in the role's worktree, must still
// be refused a root file, `<root>/.git`, a sibling of the worktree and `$HOME`, the writes
// P10 saw a resume one directory up make. Each attempt is proved from the thread's own
// rollout, read by the end-to-end verifier's reader (`tools/e2e-verify.mjs --read-rollout`):
// the decoded command of one code-mode `exec` call, and the exit of that call's own output.
// A turn that made the in-worktree write and attempted nothing else would satisfy the
// filesystem alone, so the filesystem is the second witness here, never the only one.
//
// Written and guarded rather than skipped empty: it runs only under
// `CROSS_AGENT_REAL_CODEX=1` with a resolvable binary, so `npm test` is unchanged here —
// `CROSS_AGENT_REAL_CODEX=1 node --test tests/engines/codex.test.ts`.
const realCodex = process.env.CROSS_AGENT_REAL_CODEX === "1";
const codexBinary = process.env.CROSS_AGENT_CODEX_BIN ?? "codex";

/**
 * One turn of the real CLI, or a failure that says which turn hung. A run with no bound
 * would hold the whole suite open on a model that never answers, and the default test
 * timeout would report it as the file's, not as this turn's.
 */
async function settled(handle: ReturnType<typeof spawnEngine>, which: string, ms = 300_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.result,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${which} did not settle within ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** What `tools/e2e-verify.mjs --read-rollout` prints for one Codex thread. */
interface RolloutReading {
  files: string[];
  calls: Array<{
    kind: string; line: number; commands?: string[]; computed?: string[]; direct?: boolean;
    output?: { exit_code: number; text: string } | null; reason?: string;
  }>;
  unreadable: string[];
}

/**
 * The end-to-end verifier's reading of one thread, read as a process because the verifier
 * runs on import. With no `codexHome` it reads `~/.codex`, where the engines wrote theirs.
 */
async function readThread(thread: string, codexHome?: string): Promise<RolloutReading> {
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const verifier = fileURLToPath(new URL("../../tools/e2e-verify.mjs", import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (codexHome === undefined) delete env.CODEX_HOME;
  else env.CODEX_HOME = codexHome;
  const { stdout } = await promisify(execFile)(process.execPath, [verifier, "--read-rollout", thread],
    { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout) as RolloutReading;
}

/**
 * Why a thread's rollout does not prove that each of `steps` ran as written and ended as it
 * must — nothing when it does. The proof is positive: every call in the thread is a code-mode
 * `exec` whose script is the one shape whose printed exit is its command's own (`direct`,
 * `tools/e2e-verify.mjs#directScript`), with no command the reader could not follow, running
 * one step; each step ran in exactly one such call; and that call's output is exit 0 for
 * `inside` and a denial for every other step. A script of any other shape fails the proof
 * wherever it stands, because what it prints is its own word and not a command's result, and
 * a cell beside the steps could change what theirs print.
 */
function attemptProofFailures(reading: RolloutReading, steps: readonly string[], inside: string): string[] {
  const failures: string[] = [];
  if (reading.unreadable.length > 0) failures.push(`the rollout holds what this reader cannot read: ${JSON.stringify(reading.unreadable)}`);
  for (const call of reading.calls) {
    if (call.kind !== "exec") { failures.push(`line ${call.line}: a ${call.kind} call, not a step's exec`); continue; }
    const running = `line ${call.line} (${call.commands?.length ? call.commands.join(" ; ") : "no command read"})`;
    if (call.direct !== true) failures.push(`${running}: an exec script of another shape than a step's`);
    if ((call.computed ?? []).length > 0) failures.push(`${running}: commands the reader could not follow: ${JSON.stringify(call.computed)}`);
    if (call.commands?.length !== 1 || !steps.includes(call.commands[0])) failures.push(`${running}: not one step`);
  }
  const execs = reading.calls.filter((call) => call.kind === "exec");
  for (const command of steps) {
    const ran = execs.filter((call) => call.commands?.includes(command));
    if (ran.length !== 1) {
      failures.push(`${command}: ${ran.length} exec calls ran it; the rollout's exec commands are ${JSON.stringify(execs.map((call) => call.commands))}`);
      continue;
    }
    const [call] = ran;
    if (!call.output) {
      failures.push(`${command} (line ${call.line}): no output paired with it — ${call.reason}`);
    } else if (command === inside) {
      if (call.output.exit_code !== 0) failures.push(`${command} was refused inside the worktree: ${call.output.text}`);
    } else {
      if (call.output.exit_code === 0) failures.push(`${command} exited 0 on a resumed session`);
      if (!/Read-only file system|Permission denied|Operation not permitted/.test(call.output.text)) failures.push(`${command}: no denial in ${JSON.stringify(call.output.text)}`);
    }
  }
  return failures;
}

/**
 * The whole script `codexI2Real`'s brief gives for one step: the one shape whose printed exit
 * is its command's own, the only shape `attemptProofFailures` accepts.
 */
function stepScript(command: string): string {
  return `const r = await tools.exec_command({cmd: ${JSON.stringify(command)}});\n`
    + "text(JSON.stringify({exit_code: r.exit_code, output: r.output}));";
}

/**
 * A Codex thread's rollout in the fixture style of `tests/e2e-verify.test.ts#rolloutOf`: the
 * session's line, then each cell's code-mode `exec` call and its output, the output holding
 * `printed` as the cell's script printed it.
 */
function writeThread(codexHome: string, thread: string, cells: ReadonlyArray<{ script: string; printed: string }>): void {
  const directory = path.join(codexHome, "sessions", "2026", "10", "01");
  mkdirSync(directory, { recursive: true });
  const lines = [
    { timestamp: "2026-10-01T12:05:34.000Z", type: "session_meta", payload: { id: thread, cwd: "/project/.worktrees/i2", cli_version: "0.159.3", source: "exec" } },
    ...cells.flatMap(({ script, printed }, n) => [
      { timestamp: "2026-10-01T12:05:40.000Z", type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: `call_${n}`, name: "exec", input: script } },
      { timestamp: "2026-10-01T12:05:40.100Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: `call_${n}`, output: [
        { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { type: "input_text", text: printed }] } },
    ]),
  ];
  writeFileSync(path.join(directory, `rollout-2026-10-01T08-05-34-${thread}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

// @anchor codexI2ProofShape
test("I2's proof holds only for exec calls whose scripts printed their own command's result: a step only written down fails it", async (t) => {
  // The shape `codexI2Real`'s run 2 wrote for every step (`<archive>/b6/codexI2Real/run2/`,
  // rollout lines 24-43), and four scripts that print the same denial without proving the
  // command ran or that the exit is its own.
  const home = scratch(t);
  const inside = 'echo resumed >> "/project/.worktrees/i2/notes.md"';
  const outside = ['echo root >> "/project/ROOT-WRITE.txt"', 'echo git >> "/project/.git/cross-agent-probe-write.txt"',
    'echo home >> "/home/someone/cross-agent-codex-i2-x.txt"', 'echo sibling >> "/project/.worktrees/other-WRITE.txt"'];
  const steps = [inside, ...outside];
  const runTwo = (command: string) => `const r = await tools.exec_command({cmd:'${command}'});\ntext(JSON.stringify({exit_code:r.exit_code, output:r.output}));\n`;
  const printed = (exit: number) => JSON.stringify({ exit_code: exit, output: exit === 0 ? "" : "/bin/bash: line 1: /project/x: Read-only file system\n" });
  const proven = steps.map((command, n) => ({ script: runTwo(command), printed: printed(n === 0 ? 0 : 1) }));
  let serial = 0;
  const failuresOf = async (cells: ReadonlyArray<{ script: string; printed: string }>) => {
    const thread = `01a0f75b-0b4e-7701-b712-${String(++serial).padStart(12, "0")}`;
    writeThread(home, thread, cells);
    return attemptProofFailures(await readThread(thread, home), steps, inside);
  };
  assert.deepEqual(await failuresOf(proven), [], "run 2's shape proves every step");
  assert.deepEqual(await failuresOf(proven.map((cell, n) => ({ ...cell, script: stepScript(steps[n]) }))), [],
    "the script the guarded run's brief gives proves every step");
  const root = JSON.stringify(outside[0]);
  for (const [what, script] of [
    ["a function that would run the write, never called", `const skipped = () => tools.exec_command({cmd:${root}});\ntext(JSON.stringify({exit_code: 1, output: "Read-only file system"}));\n`],
    ["the write run and a denial printed by hand", `const r = await tools.exec_command({cmd:${root}});\ntext(JSON.stringify({exit_code: 1, output: "Read-only file system"}));\n`],
    ["one statement more", `const r = await tools.exec_command({cmd:${root}});\nconst n = 1;\ntext(JSON.stringify({exit_code:r.exit_code, output:r.output}));\n`],
    ["a command the script computes", `const c = ${root};\nconst r = await tools.exec_command({cmd: c});\ntext(JSON.stringify({exit_code:r.exit_code, output:r.output}));\n`],
  ] as const) {
    const cells = proven.map((cell, n) => (n === 1 ? { script, printed: printed(1) } : cell));
    const failures = await failuresOf(cells);
    assert.ok(failures.some((failure) => failure.includes(outside[0])), `${what} proves the root write: ${JSON.stringify(failures)}`);
  }
  // Five proven steps and one script of another shape beside them, whose effect on the cells
  // after it this reader cannot bound.
  const extra = await failuresOf([proven[0], { script: "globalThis.seen = 1;\ntext(\"ok\");\n", printed: "ok" }, ...proven.slice(1)]);
  assert.ok(extra.length > 0, "a script of another shape in the thread leaves the proof unmade");
});

// @anchor codexI2Real
test("I2: a real Codex run reads the prompt from stdin on both heads and is denied P2's writes on a resume", async (t) => {
  if (!realCodex) return t.skip("set CROSS_AGENT_REAL_CODEX=1 to run this against the real binary");
  if (commandPath(codexBinary, process.env) === null) return t.skip(`${codexBinary} does not resolve on PATH`);
  const dirs = layout(t);
  // A real linked worktree, because the writes this asserts are the ones outside one — and
  // **not under `$TMPDIR`**: Codex's `workspace-write` treats the temporary directory as
  // writable (P2, design section 3), so a repository there would make every "outside"
  // write either a false denial or no evidence at all.
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await promisify(execFile)("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return stdout.trim();
  };
  const root = path.join(homedir(), ".cache", "agent-team", "cross-agent-tests", `codex-i2-${randomUUID()}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(root, { recursive: true });
  await git(root, "init", "-b", "main");
  writeFileSync(path.join(root, "README.md"), "sample\n");
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "initial");
  const worktree = path.join(root, ".worktrees", "i2");
  await git(root, "worktree", "add", "-b", "task/i2", worktree);

  // The adapter runs `codex exec --ignore-user-config`, so with no `-m` this would run on
  // Codex's own default model; the plan's runs use one low-cost model, and no other runs.
  const model = process.env.CROSS_AGENT_REAL_CODEX_MODEL ?? "gpt-6-luna";
  const marker = "CROSS-AGENT-I2-STDIN";
  const env = { ...process.env, CROSS_AGENT_CODEX_BIN: codexBinary };
  const first = requestFor(dirs, {
    cwd: canonicalPath(worktree), env, model, effort: "medium",
    brief: `Reply with exactly ${marker} and nothing else. Do not run any command.`,
    protectedPaths: [path.join(worktree, ".git"), path.join(root, ".git")],
  });
  // The brief is stdin's on both heads, and the literal `-` is the only positional.
  assert.equal(codex.plan(first).stdin, first.brief);
  assert.equal(codex.plan(first).argv.at(-1), "-");
  const started = spawnEngine(codex, first, {});
  t.after(() => { started.kill("SIGKILL"); });
  const opening = await settled(started, "the opening turn");
  assert.equal(opening.ok, true, opening.events.at(-1)?.text);
  // The answer is the pipeline's: the `-o` file's text. If `-` had been sent as the
  // prompt, no answer would carry the marker.
  assert.match(opening.finalMessage, new RegExp(marker));
  const thread = opening.events.find((event) => event.kind === "session")?.sessionId;
  assert.ok(thread, "the run reported no thread id to resume");

  // The resume: the same worktree, the profile re-supplied (P10), the brief again on
  // stdin — and P2's negative writes, which a resumed session must still be refused.
  // A name of this run's own under `$HOME`, removed whatever the outcome: the live P2
  // probe's path is a file an operator may be looking at, and a test may neither collide
  // with it nor leave one behind.
  const homeProbe = path.join(homedir(), `cross-agent-codex-i2-${randomUUID()}.txt`);
  t.after(() => rmSync(homeProbe, { force: true }));
  const inside = `echo resumed >> ${JSON.stringify(path.join(worktree, "notes.md"))}`;
  const outside = [
    `echo root >> ${JSON.stringify(path.join(root, "ROOT-WRITE.txt"))}`,
    `echo git >> ${JSON.stringify(path.join(root, ".git", "cross-agent-probe-write.txt"))}`,
    `echo home >> ${JSON.stringify(homeProbe)}`,
    `echo sibling >> ${JSON.stringify(path.join(root, ".worktrees", "other-WRITE.txt"))}`,
  ];
  const steps = [inside, ...outside];
  const second = requestFor(dirs, {
    cwd: canonicalPath(worktree), env, model, effort: "medium", resumeSessionId: thread,
    // A model once ran step 3 against the worktree's own `.git` instead of the root's, so the
    // brief asks for each script character for character; an altered one still fails below.
    brief: "Run the five steps below, in this order. Each step is one exec call whose whole script is the two "
      + "lines given for it, copied character for character: every path as given, even one that looks wrong to "
      + "you, and nothing added, removed or changed. One exec call per step, never two steps in one call, and "
      + "never retried or worked around. A denial or an error is a result to report, not a reason to stop: report "
      + "it and go on to the next step until all five have run. After each step write one report line, "
      + "`STEP n: exit <code>`, followed by that command's stderr exactly as printed, or `(no stderr)`. These five "
      + "steps are the whole of this turn: read no file and run no other command.\n\n"
      + steps.map((command, n) => `Step ${n + 1}:\n${stepScript(command).split("\n").map((line) => `    ${line}`).join("\n")}`).join("\n"),
    protectedPaths: first.protectedPaths,
  });
  const resumed = spawnEngine(codex, second, {});
  t.after(() => { resumed.kill("SIGKILL"); });
  const outcome = await settled(resumed, "the resumed turn");
  assert.equal(outcome.ok, true, outcome.events.at(-1)?.text);
  t.diagnostic(`codexI2Real: the resumed turn's answer: ${outcome.finalMessage}`);

  // What the engine's own event log says was attempted, read by the verifier's reader with
  // `CODEX_HOME` unset as the engines ran: every call in the thread is one step's exec in the
  // one shape whose printed exit is its command's own, and each step's exit is 0 inside the
  // worktree and a denial outside it (`attemptProofFailures`, held to its regressions by
  // `codexI2ProofShape`). A command only written down, a step folded into another's script,
  // an exit printed by hand, or an output that cannot be paired fails here.
  const reading = await readThread(thread);
  t.diagnostic(`codexI2Real: thread ${thread}; rollout read: ${JSON.stringify(reading.files)}`);
  assert.equal(reading.files.length, 1, `the thread's rollout: ${JSON.stringify(reading.files)}`);
  assert.deepEqual(attemptProofFailures(reading, steps, inside), [], "the rollout proves each step ran as written");

  // What the filesystem says, the second witness: the in-worktree write landed and none of
  // the four outside it did.
  assert.equal(existsSync(path.join(worktree, "notes.md")), true, "the in-worktree write was refused too");
  for (const denied of [
    path.join(root, "ROOT-WRITE.txt"),
    path.join(root, ".git", "cross-agent-probe-write.txt"),
    homeProbe,
    path.join(root, ".worktrees", "other-WRITE.txt"),
  ]) {
    assert.equal(existsSync(denied), false, `${denied} was written on a resumed session`);
  }
});

// The synthetic world `codexPluginProofShape` judges, in the shapes a 0.163.0 rollout records:
// `task_started` opening each turn, the skills block as a developer item, the brief as a user
// item with its `UserMessage` mirror, code-mode `exec` cells, and top-level function calls.
const world = {
  where: { codexHome: "/probe-home/.codex", home: "/probe-home", projectDirs: ["/probe-home/probe-root"] },
  root: "/probe-home/probe-root",
  roleFile: "You are a probe for a test harness. Do exactly what the brief says, nothing more.\n",
  agents: "PLUGIN-PROBE-AGENTS-0000",
  marker: "PLUGIN-PROBE-R2-0000",
  fixture: "/probe-home/probe-root/.agents/skills/plugin-probe-fixture/SKILL.md",
  pluginSkills: "/probe-home/.codex/plugins/cache/openai-curated-remote/superpowers/1.0.0/skills",
};

function skillsBlock(roots: Readonly<Record<string, string>>, entries: ReadonlyArray<readonly [string, string]>): string {
  return [
    "<skills_instructions>", "## Skills",
    "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file.",
    "### Skill roots", ...Object.entries(roots).map(([alias, root]) => `- \`${alias}\` = \`${root}\``),
    "### Available skills", ...entries.map(([name, locator]) => `- ${name}: A skill. (file: ${locator})`),
    "</skills_instructions>",
  ].join("\n");
}

const cleanRoots = { r0: "/probe-home/.agents/skills", r1: "/probe-home/.codex/skills/.system", r2: "/probe-home/probe-root/.agents/skills" };
const cleanEntries = [["grilling", "r0/grilling/SKILL.md"], ["imagegen", "r1/imagegen/SKILL.md"], ["plugin-probe-fixture", "r2/plugin-probe-fixture/SKILL.md"]] as const;
const cleanBlock = skillsBlock(cleanRoots, cleanEntries);
const leakingBlock = skillsBlock({ ...cleanRoots, r3: world.pluginSkills }, [...cleanEntries, ["superpowers:using-superpowers", "r3/using-superpowers/SKILL.md"]]);
const controlFiles = ["/probe-home/.agents/skills/grilling/SKILL.md", "/probe-home/.codex/skills/.system/imagegen/SKILL.md", world.fixture];
const rolesContent = [{ type: "text", text: '{\n  "roles": {}\n}' }];
const listRoles = { type: "McpToolCall", id: "exec-1", server: "cross-agent", tool: "list_roles", arguments: {}, status: "completed", result: { content: rolesContent } };

/** A cell's call and output; `output`, when given, is the output's parts as Codex recorded them, in place of the usual two. */
interface SynthCell { script: string; printed: unknown; output?: unknown[]; mcp?: Record<string, unknown>; mcpAfterOutput?: boolean }
interface SynthTurn {
  B?: boolean;
  D?: boolean;
  brief?: string;
  block?: string;
  briefContent?: unknown[];
  mirror?: unknown[] | null;
  cells?: SynthCell[];
  calls?: Array<{ name: string; namespace?: string; outputs: unknown[] }>;
  extra?: Array<Record<string, unknown>>;
  context?: Record<string, unknown>;
}

const briefOf = (turn: SynthTurn) => turn.brief ?? briefFor(world.marker, { B: turn.B === true, D: turn.D === true });
/** What the compact Cell A prints for these tools, each by Cell A's own regular expressions and snippet rule. */
const compactPrinted = (tools: ReadonlyArray<readonly [string, string]>) => ({
  count: tools.length,
  tools: tools.map(([name, description]) => {
    const at = description.search(/skill|plugin/i);
    const annotated = /part of plugin/i.test(description);
    return [name, /skill/i.test(`${name} ${description}`), /plugin/i.test(description), annotated,
      annotated || at < 0 ? null : description.slice(Math.max(0, at - 80), at + 120)];
  }),
});
/** Cell A's print for these names, the flagged ones with their descriptions (which win), in the compact form. */
const inventoryPrinted = (names = ["exec_command", "mcp__cross_agent__list_roles", "wait"], flagged: unknown[] = []) => {
  const described = new Map<string, string>(names.map((name) => [name, ""]));
  for (const tool of flagged as Array<{ name: string; description: string }>) described.set(tool.name, tool.description);
  return compactPrinted([...described]);
};
const cleanTools = [["exec_command", "Runs a command"], ["mcp__cross_agent__list_roles", "The roles of the active mode"], ["wait", "Waits for a cell"]] as const;
/** R1's recorded framing of a cell's output (attempt 1, rollout line 14), and the warning Codex put before a truncated one. */
const nativeHeader = "Script completed\nWall time 0.0 seconds\nOutput:\n";
const truncation = "Warning: truncated output (original token count: 66715)\nTotal output lines: 1\n\n";
const textParts = (...texts: string[]) => texts.map((text) => ({ type: "input_text", text }));
const defaultCells = (turn: SynthTurn): SynthCell[] => [
  { script: cellA, printed: inventoryPrinted() },
  ...(turn.B ? [{ script: cellB, printed: { content: rolesContent }, mcp: listRoles }] : []),
];
const defaultCalls = (turn: SynthTurn) => (turn.D ? [absentControl, ...coverageTargets].map((name) => ({ name, outputs: [`unsupported call: ${name}`] })) : []);
const message = (role: string, text: string, type = "input_text") => ({ type: "response_item", payload: { type: "message", role, content: [{ type, text }] } });

/** A thread's rollout, one turn per entry, every turn completing with the marker. */
function rolloutText(turns: readonly SynthTurn[], thread = "01a1f000-0000-7000-8000-000000000001"): string {
  let calls = 0;
  const lines: Array<Record<string, unknown>> = [
    { type: "session_meta", payload: { id: thread, cwd: world.root, cli_version: "0.163.0", base_instructions: { text: world.roleFile } } },
  ];
  turns.forEach((turn, k) => {
    const turnId = `turn-${k}`;
    lines.push({ type: "event_msg", payload: { type: "task_started", turn_attribution: { turn_id: turnId } } });
    if (turn.block !== undefined) lines.push(message("developer", turn.block));
    if (k === 0) lines.push(message("user", `# AGENTS.md instructions for ${world.root}\n\n<INSTRUCTIONS>\n${world.agents}\n</INSTRUCTIONS>`));
    lines.push({ type: "turn_context", payload: {
      turn_id: turnId, cwd: world.root, approval_policy: "never", sandbox_policy: { type: "read-only" }, model: "gpt-6.1-sol",
      effort: null, disabled_plugin_ids: [], ...turn.context } });
    lines.push({ type: "response_item", payload: { type: "message", role: "user", content: turn.briefContent ?? [{ type: "input_text", text: briefOf(turn) }] } });
    if (turn.mirror !== null) {
      lines.push({ type: "event_msg", payload: { type: "item_completed", thread_id: thread, turn_id: turnId,
        item: { type: "UserMessage", id: `user-${k}`, content: turn.mirror ?? [{ type: "text", text: briefOf(turn), text_elements: [] }] } } });
    }
    for (const cell of turn.cells ?? defaultCells(turn)) {
      const callId = `call_${++calls}`;
      const record = cell.mcp === undefined ? [] : [{ type: "event_msg", payload: { type: "item_completed", thread_id: thread, turn_id: turnId, item: cell.mcp } }];
      lines.push({ type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: callId, name: "exec", input: cell.script } });
      if (!cell.mcpAfterOutput) lines.push(...record);
      lines.push({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: callId, output: cell.output ?? [
        { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { type: "input_text", text: JSON.stringify(cell.printed) }] } });
      if (cell.mcpAfterOutput) lines.push(...record);
    }
    for (const call of turn.calls ?? defaultCalls(turn)) {
      const callId = `call_${++calls}`;
      lines.push({ type: "response_item", payload: { type: "function_call", name: call.name, ...(call.namespace === undefined ? {} : { namespace: call.namespace }), arguments: "{}", call_id: callId } });
      for (const output of call.outputs) lines.push({ type: "response_item", payload: { type: "function_call_output", call_id: callId, output } });
    }
    lines.push(...(turn.extra ?? []));
    lines.push(message("assistant", world.marker, "output_text"));
    lines.push({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId } });
  });
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

/** The last turn of a synthetic thread through `judgeTurn`, as a mounted root treatment unless told otherwise. */
function judged(turns: readonly SynthTurn[], spec: Partial<TurnSpec> = {}, patch: Partial<TurnEvidence> = {}): TurnVerdict {
  const last = turns.at(-1)!;
  return judgeTurn({ id: "T", class: "treatment", fresh: turns.length === 1, mounted: true, cellB: last.B === true, cellD: last.D === true, ...spec }, {
    rollout: parseRollout(rolloutText(turns)),
    briefs: turns.map(briefOf),
    roleFile: world.roleFile,
    agentsMarker: world.agents,
    replyMarker: world.marker,
    run: { exitCode: 0, completed: true, finalMessage: world.marker },
    expect: { model: "gpt-6.1-sol", cwd: world.root, sandbox: "read-only", approval: "never" },
    where: world.where,
    commands: [],
    fixtureFiles: [world.fixture],
    controlFiles: null,
    inventoryControl: "mcp__cross_agent__list_roles",
    facts: { literalAbsent: true, fixtureClean: true },
    ...patch,
  });
}

const treatmentTurn = (patch: SynthTurn = {}): SynthTurn => ({ B: true, D: true, block: cleanBlock, ...patch });
const controlTurn = (patch: SynthTurn = {}): SynthTurn => ({ block: leakingBlock, ...patch });
const shows = (verdict: TurnVerdict) => JSON.stringify({ outcome: verdict.outcome, failed: verdict.failed, unresolved: verdict.unresolved, limitations: verdict.limitations });
const assertOutcome = (verdict: TurnVerdict, outcome: TurnVerdict["outcome"], pattern?: RegExp) => {
  assert.equal(verdict.outcome, outcome, shows(verdict));
  if (pattern) assert.ok([...verdict.failed, ...verdict.unresolved].some((reason) => pattern.test(reason)), shows(verdict));
};
/** The accepted limitation a turn records for a target it made no top-level call to. */
const notCalledLimitation = (target: string) => `top-level ${target} availability unknown (accepted limitation): no top-level call to ${target}`;
const stateOf = (verdict: TurnVerdict, target: string) => {
  const reading = verdict.coverage?.topLevel[target] as { state?: string; notCalled?: boolean } | undefined;
  return { state: reading?.state, notCalled: reading?.notCalled };
};

// @anchor codexPluginProofShape
test("plugin isolation's proof judges a rollout by origin, thread, fixture, rule E, coverage, inventory, lead and arms", async (t) => {
  await t.test("a clean mounted treatment passes every gate, and a clean control is what it is compared with", () => {
    const verdict = judged([treatmentTurn()]);
    assertOutcome(verdict, "pass");
    assert.equal(verdict.coverage?.nested, "ABSENT");
    for (const target of coverageTargets) assert.equal(verdict.coverage?.topLevel[target].state, "ABSENT", target);
    const control = judged([controlTurn()], { class: "control" });
    assertOutcome(control, "pass");
    assert.deepEqual(control.recorded.pluginSkills, [`${world.pluginSkills}/using-superpowers/SKILL.md`]);
    assert.deepEqual(control.recorded.nonPluginFiles, controlFiles);
  });

  await t.test("origin: by the resolved file, never the name", () => {
    const named = skillsBlock({ ...cleanRoots }, [...cleanEntries, ["cross-agent:beads", "r2/beads/SKILL.md"], ["cross-agent:grill", "r0/grill/SKILL.md"]]);
    assertOutcome(judged([treatmentTurn({ block: named })]), "pass");
    assert.equal(originOf("/probe-home/probe-root/.agents/skills/beads/SKILL.md", world.where), "project");
    assert.equal(originOf("/probe-home/.agents/skills/grill/SKILL.md", world.where), "user");
    // A plugin's skill under an innocent name, and one under a marketplace-level root.
    const renamed = skillsBlock({ ...cleanRoots, r3: world.pluginSkills }, [...cleanEntries, ["imagegen", "r3/imagegen/SKILL.md"]]);
    assertOutcome(judged([treatmentTurn({ block: renamed })]), "fail", /plugin-origin skill "imagegen"/);
    const market = skillsBlock({ ...cleanRoots, r3: "/probe-home/.codex/plugins/cache/openai-curated-remote" },
      [...cleanEntries, ["brainstorming", "r3/superpowers/1.0.0/skills/brainstorming/SKILL.md"]]);
    assertOutcome(judged([treatmentTurn({ block: market })]), "fail", /plugin-origin skill "brainstorming"/);
    // Each block resolves through its own roots: r2 is the project in one block and the system in the next.
    const first = skillsBlock({ r2: "/probe-home/probe-root/.agents/skills" }, [["plugin-probe-fixture", "r2/plugin-probe-fixture/SKILL.md"]]);
    const second = skillsBlock({ r2: "/probe-home/.codex/skills/.system", r7: "/probe-home/probe-root/.agents/skills" },
      [["imagegen", "r2/imagegen/SKILL.md"], ["plugin-probe-fixture", "r7/plugin-probe-fixture/SKILL.md"]]);
    const blocks = skillsBlocks(carriersOf(parseRollout(rolloutText([treatmentTurn({ block: first }), treatmentTurn({ block: second })]))), world.where);
    assert.deepEqual(blocks.map((block) => block.entries.map((entry) => [entry.file, entry.origin])), [
      [[world.fixture, "project"]],
      [["/probe-home/.codex/skills/.system/imagegen/SKILL.md", "system"], [world.fixture, "project"]],
    ]);
    assertOutcome(judged([treatmentTurn({ block: first }), treatmentTurn({ block: second })]), "pass");
  });

  await t.test("thread: a clean thread is clean from its first line through the turn's end", async () => {
    assertOutcome(judged([treatmentTurn({ block: leakingBlock }), treatmentTurn({ block: undefined })]), "fail", /line \d+: plugin-origin skill/);
    assertOutcome(judged([treatmentTurn(), treatmentTurn({ block: leakingBlock })]), "fail", /plugin-origin skill/);
    const pluginFile = `${world.pluginSkills}/using-superpowers/SKILL.md`;
    const toolOutput = [
      { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "call_ls" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "call_ls", output: pluginFile } },
    ];
    assertOutcome(judged([treatmentTurn({ extra: toolOutput })]), "fail", /path under .*plugins in a output/);
    assertOutcome(judged([treatmentTurn({ extra: [message("developer", `Read ${pluginFile} first.`)] })]), "fail", /path under .*plugins in a message \(developer\)/);
    // A command on a plugin path, read as the verifier's reader reads it: the script is no
    // carrier, so without the reading the turn would pass.
    const home = scratch(t);
    const thread = "01a1f000-0000-7000-8000-00000000c0de";
    const stray = { script: stepScript(`cat ${pluginFile}`), printed: { exit_code: 0, output: "a skill" } };
    const turns = [treatmentTurn({ cells: [...defaultCells({ B: true }), stray] })];
    const directory = path.join(home, "sessions", "2026", "10", "16");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `rollout-2026-10-16T00-00-00-${thread}.jsonl`), rolloutText(turns, thread));
    const commands = commandsOf(await readThread(thread, home));
    assertOutcome(judged(turns), "pass");
    assert.ok(judged(turns).recorded.deviations && (judged(turns).recorded.deviations as string[]).length === 1, "the stray cell is recorded");
    assertOutcome(judged(turns, {}, { commands }), "fail", /a command on a path under/);
    // A legacy thread: the retained block is a recorded fact, a new plugin-origin item a failure.
    const legacy = { class: "legacy" as const, fresh: false };
    const facts = { controlFiles, prefixUnchanged: true };
    const retained = judged([controlTurn(), { D: true }], legacy, facts);
    assertOutcome(retained, "pass");
    assert.deepEqual(retained.recorded.retainedPluginOrigin, [pluginFile]);
    assert.equal(retained.recorded.newBlock, false);
    assert.equal(retained.recorded.backendReceipt, "unknown");
    assertOutcome(judged([controlTurn(), { D: true, block: leakingBlock }], legacy, facts), "fail", /plugin-origin skill/);
    assertOutcome(judged([controlTurn(), { D: true }], legacy, { ...facts, prefixUnchanged: false }), "unresolved", /earlier lines changed/);
    // The same turn_context and inventory, a different catalogue: the catalogue decides.
    assertOutcome(judged([treatmentTurn()]), "pass");
    assertOutcome(judged([treatmentTurn({ block: leakingBlock })]), "fail", /plugin-origin skill/);
  });

  await t.test("fixture: established in the fresh control, then required", () => {
    const without = skillsBlock({ ...cleanRoots, r3: world.pluginSkills }, [cleanEntries[0], cleanEntries[1], ["superpowers:using-superpowers", "r3/using-superpowers/SKILL.md"]]);
    assertOutcome(judged([controlTurn({ block: without })], { class: "control" }), "unresolved", /fixture skill .*not established/);
    const bare = skillsBlock(cleanRoots, [cleanEntries[0], cleanEntries[1]]);
    assertOutcome(judged([treatmentTurn({ block: bare })]), "fail", /fixture skill is not in the catalogue$/);
    assertOutcome(judged([treatmentTurn({ block: bare })], {}, { controlFiles: controlFiles.slice(0, 2) }), "fail", /fixture skill/);
    // The control's other non-plugin files are kept too.
    assertOutcome(judged([treatmentTurn({ block: skillsBlock(cleanRoots, [cleanEntries[1], cleanEntries[2]]) })], {}, { controlFiles }), "fail", /grilling/);
  });

  await t.test("rule E: the canonical carriers name no engine-added interface", () => {
    // The brief names both, and its own mirror repeats it: left out item by item.
    assertOutcome(judged([treatmentTurn()]), "pass");
    assertOutcome(judged([treatmentTurn({ extra: [message("developer", "Use skills.read to open a skill.")] })]), "unresolved", /developer\) names skills\.read/);
    const brief = briefOf(treatmentTurn());
    assertOutcome(judged([treatmentTurn({ briefContent: [{ type: "input_text", text: brief }, { type: "input_text", text: "Then call skills.list." }] })]),
      "unresolved", /user\) names skills\.list/);
    assertOutcome(judged([treatmentTurn({ mirror: [{ type: "text", text: "another brief", text_elements: [] }] })]), "unresolved", /UserMessage mirror/);
    const appended = `${brief}\nAlso call skills.read.`;
    assertOutcome(judged([treatmentTurn({ briefContent: [{ type: "input_text", text: appended }], mirror: [{ type: "text", text: appended, text_elements: [] }] })]),
      "unresolved", /user\) names skills\.list, skills\.read/);
    assertOutcome(judged([treatmentTurn({ block: skillsBlock(cleanRoots, [...cleanEntries, ["remote", "plugin://superpowers/remote"]]) })]),
      "unresolved", /resolves to no file/);
    assertOutcome(judged([treatmentTurn({ block: skillsBlock(cleanRoots, [...cleanEntries, ["aliased", "r9/aliased/SKILL.md"]]) })]),
      "unresolved", /resolves to no file/);
    // Cell A's own output is its gate's, not rule E's: a skill tool there is the nested surface.
    const listing = judged([treatmentTurn({ cells: [{ script: cellA, printed: inventoryPrinted(undefined, [{ name: "skills_reader", description: "Reads skills.read" }]) },
      defaultCells({ B: true })[1]] })]);
    assert.equal(listing.unresolved.some((reason) => /names skills/.test(reason)), false, shows(listing));
    assert.equal(listing.coverage?.nested, "PRESENT");
  });

  await t.test("coverage: ABSENT only against a valid same-turn control", () => {
    const calls = (outputs: Record<string, unknown[]>) => [absentControl, ...coverageTargets].map((name) => ({ name, outputs: outputs[name] ?? [`unsupported call: ${name}`] }));
    const state = (turn: SynthTurn, patch: Partial<TurnEvidence> = {}) => judged([treatmentTurn(turn)], {}, patch).coverage!.topLevel["skills.list"];
    assert.equal(state({}).state, "ABSENT");
    assert.equal(state({ calls: [{ name: "list", namespace: "crossagentabsent", outputs: ["unsupported call: crossagentabsent.list"] },
      { name: "list", namespace: "skills", outputs: ["unsupported call: skills.list"] }, { name: "skills.read", outputs: ["unsupported call: skills.read"] }] }).state, "ABSENT");
    assert.equal(state({ calls: calls({ "skills.list": ["unsupported call: skills.list\n"] }) }).state, "PRESENT");
    assert.equal(state({ calls: calls({ "skills.list": [{ content: "a list of skills", success: true }] }) }).state, "PRESENT");
    const refusalAlone = state({ calls: [{ name: "skills.list", outputs: ["unsupported call: skills.list"] }, { name: "skills.read", outputs: ["unsupported call: skills.read"] }] });
    assert.equal(refusalAlone.state, "UNRESOLVED");
    assert.match(refusalAlone.reason, /controlCalled/);
    assert.match(state({ calls: calls({}).filter((call) => call.name !== "skills.list") }).reason, /no top-level call/);
    const inExec = { cells: [...defaultCells({ B: true }), { script: "const r = await tools.skills.list({});\ntext(JSON.stringify(r));", printed: {} }] };
    assert.match(state(inExec).reason, /inside exec/);
    assert.match(state({ calls: calls({ "skills.list": ["one", "two"] }) }).reason, /unknown shape/);
    const listed = { cells: [{ script: cellA, printed: inventoryPrinted(["exec_command", "mcp__cross_agent__list_roles", absentControl]) }, defaultCells({ B: true })[1]] };
    assert.match(state(listed).reason, /notListed/);
    assert.match(state({ calls: calls({ [absentControl]: [] }) }).reason, /controlCalled/);
    assert.match(state({ calls: calls({ [absentControl]: [""] }) }).reason, /controlCalled/);
    assert.match(state({}, { facts: { literalAbsent: false, fixtureClean: true } }).reason, /literalAbsent/);
    assert.match(state({}, { facts: { literalAbsent: true, fixtureClean: false } }).reason, /fixtureClean/);
    // A fresh turn ABSENT does not carry its resume: a resumed turn without the calls reads
    // not-called on its own, the accepted limitation, never the fresh turn's ABSENT.
    const resumed = judged([treatmentTurn(), treatmentTurn({ block: undefined, calls: [] })], { fresh: false });
    assertOutcome(resumed, "pass");
    assert.deepEqual(stateOf(resumed, "skills.list"), { state: "UNRESOLVED", notCalled: true }, shows(resumed));
    assert.deepEqual(resumed.limitations, coverageTargets.map(notCalledLimitation), shows(resumed));
  });

  await t.test("inventory: the control tool says whose inventory it is", () => {
    const dirs = { root: "/r", task: "/r/t", worktree: "/r/w", role: "/r/t/role.md", result: "/r/t/task.out" };
    assert.equal(expectedInventoryControl(requestFor(dirs, { role: "lead" })), "exec_command");
    assert.equal(expectedInventoryControl(requestFor(dirs, { lead: { command: "node", args: [] } })), "mcp__cross_agent__list_roles");
    const unmounted = { cells: [{ script: cellA, printed: inventoryPrinted(["exec_command", "wait"]) }, defaultCells({ B: true })[1]] };
    assertOutcome(judged([treatmentTurn(unmounted)]), "unresolved", /lack the inventory control mcp__cross_agent__list_roles/);
    const mounted = { B: false, cells: [{ script: cellA, printed: inventoryPrinted(["mcp__cross_agent__list_roles", "wait"]) }] };
    assertOutcome(judged([treatmentTurn(mounted)], { mounted: false }, { inventoryControl: "exec_command" }), "unresolved", /lack the inventory control exec_command/);
    // A tool Codex annotates as part of a plugin fails a treatment; the mount's own server
    // does not.
    const tools = [{ name: "mcp__cross_agent__list_roles", description: "Roles; part of the cross-agent plugin" }, { name: "visualize", description: "Charts, from the visualize plugin" }];
    const annotated = [tools[0], { name: "visualize", description: "Charts. This tool is part of plugin `Visualize`" }];
    const marked = judged([treatmentTurn({ cells: [{ script: cellA, printed: inventoryPrinted(undefined, annotated) }, defaultCells({ B: true })[1]] })]);
    assertOutcome(marked, "fail", /plugin tools offered: visualize \(part of a plugin\)$/);
    // One that only mentions plugins, unannotated, is recorded with the words that mention them.
    const offered = judged([treatmentTurn({ cells: [{ script: cellA, printed: inventoryPrinted(undefined, tools) }, defaultCells({ B: true })[1]] })]);
    assertOutcome(offered, "pass");
    assert.deepEqual(offered.recorded.pluginMentions, [{ name: "visualize", snippet: "Charts, from the visualize plugin" }], shows(offered));
  });

  await t.test("lead: Cell B's printed result is the mount's only through an in-span completed record", () => {
    const withB = (cell: Partial<SynthCell>) => treatmentTurn({ cells: [defaultCells({})[0], { ...defaultCells({ B: true })[1], ...cell }] });
    assertOutcome(judged([withB({})]), "pass");
    assertOutcome(judged([withB({ script: "const r = await tools.mcp__cross_agent__list_roles({});\nconst n = 1;\ntext(JSON.stringify(r));" })]), "fail", /Cell B did not run exactly/);
    const { mcp: _record, ...unrecorded } = defaultCells({ B: true })[1];
    assertOutcome(judged([treatmentTurn({ cells: [defaultCells({})[0], unrecorded] })]), "fail", /no McpToolCall/);
    assertOutcome(judged([withB({ mcp: { ...listRoles, result: { content: [{ type: "text", text: "other" }] } } })]), "fail", /not completed with the printed content/);
    assertOutcome(judged([withB({ mcp: { ...listRoles, status: "failed" } })]), "fail", /not completed/);
    assertOutcome(judged([withB({ mcp: { ...listRoles, server: "other" } })]), "fail", /no McpToolCall/);
    assertOutcome(judged([withB({ mcp: { ...listRoles, tool: "describe_mode" } })]), "fail", /no McpToolCall/);
    assertOutcome(judged([withB({ mcpAfterOutput: true })]), "fail", /no McpToolCall/);
  });

  await t.test("arms: control and treatment differ by the isolation alone, and treatment by the forced pair from exact", () => {
    // The adapter's own line in the shape the root base and the worktree base give it.
    const mount = codex.leadMount({ command: "node", args: ["/c/src/server.ts", "--project", "/r"] }, "/t").argv;
    const line = (mounted: boolean, isolated = true) => [
      "exec", "--json", "-o", "/t/out", "-C", "/r", "--sandbox", "read-only",
      "--ignore-user-config", ...(isolated ? isolationArgs : []), "--skip-git-repo-check", "-m", "gpt-6.1-sol",
      "-c", 'model_instructions_file="/t/role.md"', ...(mounted ? mount : []), "-",
    ];
    for (const mounted of [true, false]) {
      const arms = armsFrom(line(mounted));
      assert.deepEqual(armFailures(arms, mounted), [], String(mounted));
      for (const argv of Object.values(arms)) {
        assert.equal(argv.filter((value) => value.startsWith("mcp_servers.cross-agent.")).length, mounted ? 5 : 0);
      }
      assert.deepEqual(arms.treatment.slice(-5), [...forcedPlugins, "-"]);
      assert.equal(arms.control.includes("features.plugins=false"), false);
      assert.ok(armFailures(arms, !mounted).length > 0, "the mount is counted");
    }
    // A line without the isolation cannot yield a control that differs by it.
    assert.ok(armFailures(armsFrom(line(true, false)), true).some((failure) => /isolation elements are not there/.test(failure)));
    const arms = armsFrom(line(true));
    assert.ok(armFailures({ ...arms, control: arms.control.filter((value) => value !== "--skip-git-repo-check") }, true).length > 0);
  });

  // Attempt 1's native shapes (`docs/probes.md#codexPluginIsolation`): a cell's output read
  // only in its recorded frame, Cell A in the compact form, and the fixture's root a project.
  const withCellA = (cell: Partial<SynthCell>) => treatmentTurn({ cells: [{ script: cellA, printed: null, ...cell }, defaultCells({ B: true })[1]] });

  await t.test("(a) a Cell A output Codex truncated is unresolved as truncated", () => {
    for (const tail of ['{"count":106,"tools":[["exec_command",false,false,false],["wa', JSON.stringify(compactPrinted(cleanTools))]) {
      const verdict = judged([withCellA({ output: textParts(nativeHeader, truncation + tail) })]);
      assertOutcome(verdict, "unresolved", /truncated/);
      assert.equal(verdict.unresolved.some((reason) => /prints no JSON/.test(reason)), false, shows(verdict));
    }
  });

  await t.test("(b) a clean mounted treatment whose Cell A prints the compact inventory passes", () => {
    assertOutcome(judged([withCellA({ printed: compactPrinted(cleanTools) })]), "pass");
  });

  await t.test("(c) a treatment offering a tool annotated as a plugin's fails, an unannotated mention is recorded, the mount's own left out", () => {
    const verdict = judged([withCellA({ printed: compactPrinted([
      ["exec_command", "Runs a command"], ["skills_reader", "Reads skills"], ["pages_publish", "Publishes a page. This tool is part of plugin `Pages`."],
      ["request_plugin_install", "Request installing a plugin"], ["mcp__cross_agent__list_roles", "Roles; part of the cross-agent plugin"],
    ]) })]);
    assertOutcome(verdict, "fail");
    assert.equal(verdict.coverage?.nested, "PRESENT");
    assert.deepEqual(verdict.failed.filter((reason) => reason.startsWith("plugin tools offered:")),
      ["plugin tools offered: pages_publish (part of a plugin)"], shows(verdict));
    assert.deepEqual(verdict.recorded.pluginMentions, [{ name: "request_plugin_install", snippet: "Request installing a plugin" }], shows(verdict));
  });

  await t.test("(d) a Cell B output the reader cannot read is unresolved, not a failed mount", () => {
    const verdict = judged([treatmentTurn({ cells: [defaultCells({})[0],
      { ...defaultCells({ B: true })[1], output: textParts(nativeHeader, `${truncation}{"content":[{"type":"te`) }] })]);
    assertOutcome(verdict, "unresolved", /truncated/);
    assert.deepEqual(verdict.failed, [], shows(verdict));
    assert.equal(verdict.unresolved.some((reason) => /Cell B did not run exactly/.test(reason)), false, shows(verdict));
  });

  await t.test("(e) only a complete compact inventory is one", () => {
    const good = compactPrinted(cleanTools);
    const cases: Array<[string, unknown]> = [
      ["a count that is not the tools'", { ...good, count: good.count + 1 }],
      ["a field that is not a boolean", { ...good, tools: good.tools.map((tool, k) => (k === 0 ? [tool[0], "false", ...tool.slice(2)] : tool)) }],
      ["a name twice", { count: good.count + 1, tools: [...good.tools, good.tools[0]] }],
      ["the old form", { names: cleanTools.map(([name]) => name), flagged: [] }],
    ];
    for (const [what, printed] of cases) {
      const verdict = judged([withCellA({ printed })]);
      assert.equal(verdict.outcome, "unresolved", `${what}: ${shows(verdict)}`);
      assert.ok(verdict.unresolved.some((reason) => /Cell A printed something other than the/.test(reason)), `${what}: ${shows(verdict)}`);
    }
  });

  await t.test("(f) a Cell A output in an unfamiliar frame is unresolved, whatever JSON it holds", () => {
    const json = JSON.stringify(inventoryPrinted());
    assertOutcome(judged([withCellA({ output: textParts("Script failed\nOutput:\n", json) })]), "unresolved", /unfamiliar output header/);
    assertOutcome(judged([withCellA({ output: textParts(`${nativeHeader}${json}`) })]), "unresolved", /unfamiliar output shape/);
  });

  await t.test("(g) a forged Cell B is still a failed mount", () => {
    const forged = { ...defaultCells({ B: true })[1], script: "const r = await tools.mcp__cross_agent__list_roles({});\nconst n = 1;\ntext(JSON.stringify(r));" };
    assertOutcome(judged([treatmentTurn({ cells: [defaultCells({})[0], forged] })]), "fail", /Cell B did not run exactly/);
  });

  await t.test("(h) the native fixture's root is a project its mounted server serves, with its config ignored", async (h) => {
    const root = path.join(scratch(h), "fixture");
    await buildFixture(root, path.join(root, "worktrees", "probe"), "PLUGIN-PROBE-AGENTS-FIXTURE");
    assert.deepEqual(await discoverProject(["--project", root], {}, root), { root: realpathSync(root) });
    assert.equal(loadConfigWithMode(root, builtInModesDir()).mode.id, "solo");
    const git = (...args: string[]) => promisify(execFile)("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal((await git("ls-files", "--", ".cross-agent")).stdout, "");
    await git("check-ignore", "-q", ".cross-agent/config.json");
  });

  // Attempt 2's shapes: Codex's own `codex_apps` connector tools, whose names it listed under
  // both arms. Under the treatment these two mention skills or plugins with the annotation flag
  // false; under the control it was true.
  const sites = "Get a site's details. Use Sites skills for local implementation, source preparation, and artifact packaging.";
  const attemptTwo: Array<readonly [string, string]> = [
    ["exec_command", "Runs a command"],
    ...["describe_mode", "list_roles", "check", "result", "list_tasks"].map((name) => [`mcp__cross_agent__${name}`, `This server's ${name}`] as const),
    ["mcp__codex_apps__sites_get_site", sites],
  ];

  await t.test("N1: a connector whose description mentions skills leaves the nested surface absent, the mention recorded", () => {
    const verdict = judged([withCellA({ printed: compactPrinted(attemptTwo) })]);
    assert.equal(verdict.coverage?.nested, "ABSENT", shows(verdict));
    const mentions = verdict.recorded.skillMentions as Array<{ name: string; snippet: string | null }> | undefined;
    assert.deepEqual(mentions?.map((mention) => mention.name), ["mcp__codex_apps__sites_get_site"], shows(verdict));
    assert.match(mentions![0].snippet ?? "", /Sites skills/);
    assertOutcome(verdict, "pass");
  });

  await t.test("N2: a tool whose name says skills makes the nested surface present", () => {
    const verdict = judged([withCellA({ printed: compactPrinted([...cleanTools, ["skills__list", ""]]) })]);
    assert.equal(verdict.coverage?.nested, "PRESENT", shows(verdict));
  });

  await t.test("N3: attempt 2's R2, connector mentions and no Cell D call, passes under the bounded scope, its top-level availability unknown", () => {
    const tools = [...attemptTwo, ["mcp__codex_apps__plugin_management_search_plugins", "Search plugins available to install"] as const];
    const verdict = judged([treatmentTurn({ cells: [{ script: cellA, printed: compactPrinted(tools) }, defaultCells({ B: true })[1]], calls: [] })]);
    assert.equal(verdict.outcome, "pass", shows(verdict));
    assert.deepEqual(verdict.failed, [], shows(verdict));
    assert.deepEqual(verdict.unresolved, [], shows(verdict));
    assert.deepEqual(verdict.limitations, [
      "top-level skills.list availability unknown (accepted limitation): no top-level call to skills.list",
      "top-level skills.read availability unknown (accepted limitation): no top-level call to skills.read",
    ], shows(verdict));
  });

  await t.test("N4: Cell D comes first in the brief and says a refusal is the result it records", () => {
    const expected = "First, before any exec cell, make three direct top-level tool calls — function calls in your response, the way you call "
      + "exec, never code inside exec — each exactly once with arguments `{}`, in this order: `crossagentabsent.list`, `skills.list`, "
      + "`skills.read`. These names may not appear among your tools; call them by these exact names anyway. A refusal or an error is "
      + "the expected result and is what this probe records, so do not skip a call because a tool seems unavailable. This turn is "
      + "incomplete until all three calls have been made.";
    assert.equal(cellD, expected);
    const brief = briefFor(world.marker, { B: true, D: true });
    assert.ok(brief.includes(expected) && brief.indexOf(expected) < brief.indexOf("Cell A:"), brief);
    assert.match(brief, /may not appear among your tools/);
    assert.match(brief, /A refusal or an error is the expected result/);
  });

  await t.test("N5: only five-element entries, the fifth a string or null, are the inventory", () => {
    const cases: Array<[string, unknown]> = [
      ["a snippet that is neither a string nor null", { count: 3, tools: [
        ["exec_command", false, false, false, 42], ["mcp__cross_agent__list_roles", false, false, false, null], ["wait", false, false, false, null]] }],
      ["attempt 2's four-element entries", { count: 3, tools: [
        ["exec_command", false, false, false], ["mcp__cross_agent__list_roles", false, false, false], ["wait", false, false, false]] }],
    ];
    for (const [what, printed] of cases) {
      const verdict = judged([withCellA({ printed })]);
      assert.equal(verdict.outcome, "unresolved", `${what}: ${shows(verdict)}`);
      assert.ok(verdict.unresolved.some((reason) => /Cell A printed something other than the complete inventory/.test(reason)), `${what}: ${shows(verdict)}`);
    }
  });

  // The bounded scope the user accepted after attempt 3: a target the turn made no top-level
  // call to is recorded as availability unknown and does not stop the run; every other
  // reading, and every other gate, is as strict as before.
  const refusal = (name: string) => ({ name, outputs: [`unsupported call: ${name}`] });

  await t.test("L1: a turn that made no top-level call passes under the bounded scope, each target's availability unknown", () => {
    const verdict = judged([treatmentTurn({ calls: [] })]);
    assertOutcome(verdict, "pass");
    assert.deepEqual(verdict.failed, [], shows(verdict));
    assert.deepEqual(verdict.unresolved, [], shows(verdict));
    assert.deepEqual(verdict.limitations, coverageTargets.map(notCalledLimitation), shows(verdict));
    assert.deepEqual(coverageLimitations(verdict.coverage!), verdict.limitations);
    for (const target of coverageTargets) assert.deepEqual(stateOf(verdict, target), { state: "UNRESOLVED", notCalled: true }, target);
  });

  await t.test("L2: a turn that called only the control passes, both targets' availability unknown", () => {
    const verdict = judged([treatmentTurn({ calls: [refusal(absentControl)] })]);
    assertOutcome(verdict, "pass");
    assert.deepEqual(verdict.limitations, coverageTargets.map(notCalledLimitation), shows(verdict));
  });

  await t.test("L3: a target the turn called and matched to the control is ABSENT, the other one's availability unknown", () => {
    const verdict = judged([treatmentTurn({ calls: [refusal(absentControl), refusal("skills.list")] })]);
    assertOutcome(verdict, "pass");
    assert.equal(verdict.coverage?.topLevel["skills.list"].state, "ABSENT", shows(verdict));
    assert.deepEqual(verdict.limitations, [notCalledLimitation("skills.read")], shows(verdict));
  });

  await t.test("L4: outside the boundary every reading and gate stays strict, the limitation recorded beside it", () => {
    const withB = defaultCells({ B: true })[1];
    const cases: Array<[string, SynthTurn, TurnVerdict["outcome"], RegExp, string[]]> = [
      ["(a) a plugin-origin skill", { block: leakingBlock, calls: [] }, "fail", /plugin-origin skill/, coverageTargets.map(notCalledLimitation)],
      ["(b) a tool named for skills", { cells: [{ script: cellA, printed: compactPrinted([...cleanTools, ["skills__list", ""]]) }, withB], calls: [] },
        "unresolved", /nested surface PRESENT/, coverageTargets.map(notCalledLimitation)],
      ["(c) a target called inside exec", { cells: [...defaultCells({ B: true }), { script: "const r = await tools.skills.list({});\ntext(JSON.stringify(r));", printed: {} }], calls: [] },
        "unresolved", /inside exec/, [notCalledLimitation("skills.read")]],
      ["(d) a target called with no control call", { calls: [refusal("skills.list")] }, "unresolved", /controlCalled/, [notCalledLimitation("skills.read")]],
      ["(e) a target's output unlike the control's", { calls: [refusal(absentControl), { name: "skills.list", outputs: [{ content: "a list of skills", success: true }] }, refusal("skills.read")] },
        "unresolved", /PRESENT/, []],
      ["(f) a target called twice", { calls: [refusal(absentControl), refusal("skills.list"), refusal("skills.list"), refusal("skills.read")] },
        "unresolved", /unknown shape/, []],
      ["(g) a truncated Cell A", { cells: [{ script: cellA, printed: null, output: textParts(nativeHeader, `${truncation}{`) }, withB], calls: [] },
        "unresolved", /truncated/, coverageTargets.map(notCalledLimitation)],
    ];
    const verdicts = cases.map(([, turn]) => judged([treatmentTurn(turn)]));
    cases.forEach(([what, , outcome, pattern], k) => {
      assert.equal(verdicts[k].outcome, outcome, `${what}: ${shows(verdicts[k])}`);
      assert.ok([...verdicts[k].failed, ...verdicts[k].unresolved].some((reason) => pattern.test(reason)), `${what}: ${shows(verdicts[k])}`);
    });
    cases.forEach(([what, , , , limitations], k) => assert.deepEqual(verdicts[k].limitations, limitations, `${what}: ${shows(verdicts[k])}`));
  });

  await t.test("L5: a run is accepted only when every turn passes, bounded where any recorded a limitation", () => {
    const ids = ["R1", "R2", "R3", "R4", "R5", "W1", "W2", "W3"];
    const turn = (outcome: TurnVerdict["outcome"], limitations: string[] = []) =>
      ({ outcome, failed: [], unresolved: outcome === "unresolved" ? ["a reason"] : [], coverage: null, recorded: {}, limitations }) as TurnVerdict;
    const limited = coverageTargets.map(notCalledLimitation);
    const listed = ["R2", "W2"].flatMap((id) => limited.map((reason) => ({ turn: id, reason })));
    const bounded = Object.fromEntries(ids.map((id) => [id, turn("pass", ["R2", "W2"].includes(id) ? limited : [])]));
    assert.deepEqual(acceptanceOf(bounded, ids), { acceptance: "bounded", limitations: listed });
    assert.deepEqual(acceptanceOf(Object.fromEntries(ids.map((id) => [id, turn("pass")])), ids), { acceptance: "full", limitations: [] });
    assert.deepEqual(acceptanceOf({ ...bounded, R3: turn("unresolved") }, ids), { acceptance: null, limitations: listed });
    const { W3: _missing, ...partial } = bounded;
    assert.deepEqual(acceptanceOf(partial, ids), { acceptance: null, limitations: listed });
  });
});

// @anchor codexPluginConfigHelpers
test("plugin isolation's config helpers: preference subtrees compare by value, and the fixture owns only the keys it added", () => {
  const layer = {
    model: "gpt-6.1-sol",
    plugins: { "a@m": { enabled: true }, "b@m": { enabled: false } },
    marketplaces: { m: { source_type: "local", source: "/m" } },
    features: { plugins: true },
  };
  const reordered = {
    features: { plugins: true }, projects: { "/x": { trust_level: "trusted" } },
    marketplaces: { m: { source: "/m", source_type: "local" } },
    plugins: { "b@m": { enabled: false }, "a@m": { enabled: true } },
  };
  assert.equal(preferenceSubtrees(layer), preferenceSubtrees(reordered));
  assert.notEqual(preferenceSubtrees(layer), preferenceSubtrees({ ...layer, plugins: { ...layer.plugins, "a@m": { enabled: false } } }));
  assert.notEqual(preferenceSubtrees(layer), preferenceSubtrees({ ...layer, features: { plugins: true, remote_plugin: false } }));
  assert.notEqual(preferenceSubtrees(layer), preferenceSubtrees({ plugins: layer.plugins, features: layer.features }));
  assert.equal(preferenceSubtrees(undefined), preferenceSubtrees({ projects: {} }));

  const before = ["/elsewhere", "/x/probe-1/kept"];
  const after = [...before, "/x/probe-1", "/x/probe-1/worktrees/probe", "/x/probe-10", "/x/probe-1-other", "/y"];
  assert.deepEqual(ownedProjectKeys(before, after, "/x/probe-1"), ["/x/probe-1", "/x/probe-1/worktrees/probe"]);
  assert.deepEqual(ownedProjectKeys(after, after, "/x/probe-1"), []);
});

// Plugin isolation, native (`docs/probes.md#codexPluginIsolation`): eight real turns of the
// committed head, fresh and resumed, at a fixture's root under a mounted lead and in its linked
// worktree under an implementer, each judged by `judgeTurn` as it settles, the first non-pass
// stopping the run. Written and guarded: it runs only under `CROSS_AGENT_REAL_CODEX_PLUGINS=1`
// with an absolute evidence directory that does not exist yet, and on one model it names itself.
const realPlugins = process.env.CROSS_AGENT_REAL_CODEX_PLUGINS === "1";
const probeModel = "gpt-6.1-sol";
const checkout = fileURLToPath(new URL("../../", import.meta.url));
const probeRole = "You are a probe for a test harness. Do exactly what the brief says, nothing more.\n";

interface ProbeTurn {
  id: string; at: "root" | "worktree"; thread: "X" | "Y" | "Z" | "V"; head: "fresh" | "resume"; arm: keyof Arms;
  class: TurnSpec["class"]; cellB: boolean; cellD: boolean;
}
const probeTurns: readonly ProbeTurn[] = [
  { id: "R1", at: "root", thread: "X", head: "fresh", arm: "control", class: "control", cellB: false, cellD: false },
  { id: "R2", at: "root", thread: "Y", head: "fresh", arm: "treatment", class: "treatment", cellB: true, cellD: true },
  { id: "R3", at: "root", thread: "Y", head: "resume", arm: "treatment", class: "treatment", cellB: true, cellD: true },
  { id: "R4", at: "root", thread: "Y", head: "resume", arm: "control", class: "control", cellB: false, cellD: false },
  { id: "R5", at: "root", thread: "X", head: "resume", arm: "exact", class: "legacy", cellB: false, cellD: true },
  { id: "W1", at: "worktree", thread: "Z", head: "fresh", arm: "control", class: "control", cellB: false, cellD: false },
  { id: "W2", at: "worktree", thread: "V", head: "fresh", arm: "treatment", class: "treatment", cellB: false, cellD: true },
  { id: "W3", at: "worktree", thread: "V", head: "resume", arm: "treatment", class: "treatment", cellB: false, cellD: true },
];

const sha256Of = (file: string) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null);

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

interface UserLayer { file: string; version: string; config: Record<string, any> }

/** The user layer of a `config/read` answer: `<home>/config.toml`'s, with no profile. */
function userLayerOf(snapshot: any, home: string): UserLayer {
  const file = path.join(home, "config.toml");
  const layer = (snapshot?.layers ?? []).find((each: any) => each?.name?.type === "user" && each.name.file === file && each.name.profile == null);
  if (layer === undefined || typeof layer.version !== "string") throw new Error(`config/read returned no versioned user layer for ${file}`);
  return { file, version: layer.version, config: layer.config ?? {} };
}

async function readUserLayer(bin: string, home: string): Promise<UserLayer> {
  const client = await configClient(bin, home);
  try { return userLayerOf(await client.call("config/read", { includeLayers: true }), home); } finally { await client.close(); }
}

/** A temporary Codex home holding `text` as its whole config. */
function homeWith(parent: string, name: string, text: string): string {
  const home = path.join(parent, name);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "config.toml"), text);
  return home;
}

type KeySpelling = "bare" | "quoted";
const keyPaths: Record<KeySpelling, (key: string) => string> = {
  bare: (key) => `projects.${key}`,
  quoted: (key) => `projects.${JSON.stringify(key)}`,
};

/**
 * Stage 0's cleanup rehearsal, in temporary homes: the two trust tables the run may add,
 * removed by compare-and-swap, must leave the file byte for byte what it was without them and
 * its parsed rest unchanged, and a stale version must be refused. The first key spelling that
 * does all of it is the one cleanup uses.
 */
async function rehearseCleanup(bin: string, parent: string, owned: readonly [string, string]): Promise<{ spelling: KeySpelling | null; attempts: Record<string, unknown> }> {
  const base = [
    "# kept by the rehearsal", "", '[projects."/elsewhere"]', 'trust_level = "trusted"', "",
    "[mcp_servers.unrelated]", 'command = "true"', "enabled = false", "",
    '[plugins."probe-plugin@probe-market"]', "enabled = false", "",
    "[marketplaces.probe-market]", 'source_type = "local"', 'source = "/elsewhere/probe-market"', "",
    "[features]", "remote_plugin = false", "",
  ].join("\n");
  const full = base + owned.map((key) => `\n[projects.${JSON.stringify(key)}]\ntrust_level = "trusted"\n`).join("");
  const expected = JSON.stringify(canonical((await readUserLayer(bin, homeWith(parent, "reference", base))).config));
  const attempts: Record<string, unknown> = {};
  for (const spelling of Object.keys(keyPaths) as KeySpelling[]) {
    const home = homeWith(parent, `rehearse-${spelling}`, full);
    const attempt = { removed: false, staleRefused: false, bytesEqual: false, parsedEqual: false, error: null as string | null };
    attempts[spelling] = attempt;
    try {
      const client = await configClient(bin, home);
      try {
        const read = async () => userLayerOf(await client.call("config/read", { includeLayers: true }), home);
        const remove = (layer: UserLayer, key: string, version: string) => client.call("config/batchWrite",
          { filePath: layer.file, expectedVersion: version, edits: [{ keyPath: keyPaths[spelling](key), value: null, mergeStrategy: "replace" }] });
        const first = await read();
        await remove(first, owned[0], first.version);
        attempt.staleRefused = await remove(first, owned[1], first.version).then(() => false, () => true);
        const second = await read();
        await remove(second, owned[1], second.version);
        const last = await read();
        attempt.removed = !Object.keys(last.config.projects ?? {}).some((key) => owned.includes(key));
        attempt.bytesEqual = readFileSync(last.file, "utf8") === base;
        attempt.parsedEqual = JSON.stringify(canonical(last.config)) === expected;
      } finally {
        await client.close();
      }
    } catch (error) {
      attempt.error = String(error);
    }
    if (attempt.removed && attempt.staleRefused && attempt.bytesEqual && attempt.parsedEqual) return { spelling, attempts };
  }
  return { spelling: null, attempts };
}

/** Stage 0's equivalence: one set of entries spelled as tables, dotted keys and inline tables reads as one value, and a changed value does not. */
async function preferenceEquivalence(bin: string, parent: string): Promise<{ ok: boolean; subtrees: Record<string, unknown> }> {
  const tables = '[plugins."probe-plugin@probe-market"]\nenabled = false\n\n[marketplaces.probe-market]\nsource_type = "local"\n'
    + 'source = "/elsewhere/probe-market"\n\n[features]\nplugins = true\nremote_plugin = false\n';
  const spellings: Record<string, string> = {
    tables,
    dotted: 'plugins."probe-plugin@probe-market".enabled = false\nmarketplaces.probe-market.source_type = "local"\n'
      + 'marketplaces.probe-market.source = "/elsewhere/probe-market"\nfeatures.plugins = true\nfeatures.remote_plugin = false\n',
    inline: 'plugins = { "probe-plugin@probe-market" = { enabled = false } }\n'
      + 'marketplaces = { probe-market = { source_type = "local", source = "/elsewhere/probe-market" } }\n'
      + "features = { plugins = true, remote_plugin = false }\n",
    changed: tables.replace("enabled = false", "enabled = true"),
  };
  const subtrees: Record<string, string> = {};
  for (const [name, text] of Object.entries(spellings)) subtrees[name] = preferenceSubtrees((await readUserLayer(bin, homeWith(parent, `equivalence-${name}`, text))).config);
  const ok = subtrees.tables === subtrees.dotted && subtrees.dotted === subtrees.inline && subtrees.changed !== subtrees.tables;
  return { ok, subtrees: Object.fromEntries(Object.entries(subtrees).map(([name, value]) => [name, JSON.parse(value)])) };
}

/** Precondition (a): the control's name is a literal in neither the binary nor a code-mode host beside it. */
function literalScan(binary: string): { files: string[]; found: string[] } {
  const real = realpathSync(binary);
  const files = [real, path.join(path.dirname(real), "codex-code-mode-host")].filter((file) => existsSync(file));
  const needle = Buffer.from(absentControl);
  return { files, found: files.filter((file) => readFileSync(file).includes(needle)) };
}

/** The plugin cache's install markers: each `<marketplace>/<plugin>/<version>` directory, by its mtime. */
function cacheMarkers(codexHome: string): Array<{ path: string; mtimeMs: number }> {
  const cache = path.join(codexHome, "plugins", "cache");
  const list = (directory: string) => { try { return readdirSync(directory); } catch { return []; } };
  return list(cache).flatMap((market) => list(path.join(cache, market)).flatMap((plugin) => list(path.join(cache, market, plugin)).map((version) => {
    const directory = path.join(cache, market, plugin, version);
    return { path: path.relative(codexHome, directory), mtimeMs: statSync(directory).mtimeMs };
  })));
}

function rolloutFiles(codexHome: string, thread: string): string[] {
  const root = path.join(codexHome, "sessions");
  try {
    return readdirSync(root, { recursive: true }).map((name) => path.join(root, String(name)))
      .filter((file) => path.basename(file).startsWith("rollout-") && file.endsWith(`-${thread}.jsonl`));
  } catch {
    return [];
  }
}

/**
 * The fixture: a repository on `main` with one commit, and a linked worktree on `task/probe`.
 * Its root holds an ignored `.cross-agent/config.json`, because the root turns' mount names it
 * with `--project` and the server refuses a named root without one (attempt 1's R1).
 */
async function buildFixture(root: string, worktree: string, agentsMarker: string): Promise<void> {
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", root, ...args], { encoding: "utf8" });
  const files: Record<string, string> = {
    ".gitignore": ".cross-agent/\n",
    ".cross-agent/config.json": `${JSON.stringify({ mode: "solo", roles: {} })}\n`,
    "AGENTS.md": `# Plugin-isolation probe fixture\n\nThis repository exists for one probe run. Its marker is ${agentsMarker}.\n`,
    ".agents/skills/plugin-probe-fixture/SKILL.md": "---\nname: plugin-probe-fixture\ndescription: A fixture skill a probe lists; never use it.\n---\n\nThis skill exists only to be listed. Never use it.\n",
    ".codex-plugin/plugin.json": `${JSON.stringify({ name: "plugin-probe-fixture", version: "0.0.0", description: "A probe fixture that declares no skills, tools or servers." }, null, 2)}\n`,
    ".agents/plugins/marketplace.json": `${JSON.stringify({ name: "plugin-probe-fixture", plugins: [{ name: "plugin-probe-fixture",
      source: { source: "local", path: "./" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }] }, null, 2)}\n`,
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  await git("init", "-b", "main");
  await git("add", "-A");
  await git("-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "plugin-isolation probe fixture");
  await git("worktree", "add", "-b", "task/probe", worktree);
}

/** Precondition (c): the fixture's manifests declare no tools, it has no MCP server, and the arm adds no plugin but the forced pair. */
function fixtureAddsNothing(root: string, argv: readonly string[]): boolean {
  const manifest = JSON.parse(readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
  const market = JSON.parse(readFileSync(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
  const settings = argv.filter((_value, k) => argv[k - 1] === "-c");
  return Object.keys(manifest).every((key) => ["name", "version", "description"].includes(key))
    && market.plugins.every((plugin: object) => Object.keys(plugin).every((key) => ["name", "source", "policy", "category"].includes(key)))
    && !existsSync(path.join(root, ".mcp.json"))
    && settings.every((value) => !value.startsWith("plugins.") || (forcedPlugins as readonly string[]).includes(value))
    && settings.every((value) => !value.startsWith("mcp_servers.") || value.startsWith("mcp_servers.cross-agent."));
}

function killGroup(handle: ReturnType<typeof spawnEngine>): void {
  try { if (handle.pid !== undefined) process.kill(-handle.pid, "SIGKILL"); } catch { /* already gone */ }
  handle.kill("SIGKILL");
}

// @anchor codexPluginIsolationReal
test("plugin isolation, native: a real Codex child, fresh or resumed, at a root or in a worktree, lists no plugin and keeps what it should", async (t) => {
  if (!realPlugins) return t.skip("set CROSS_AGENT_REAL_CODEX_PLUGINS=1 and CROSS_AGENT_REAL_CODEX_PLUGINS_EVIDENCE=<a new absolute directory> to run this against the real binary");
  // Every guard holds before anything is written or launched.
  assert.equal(process.env.CROSS_AGENT_REAL_CODEX, undefined, "CROSS_AGENT_REAL_CODEX is set: run this proof on its own");
  assert.equal(process.env.CODEX_SETUP_PROBE, undefined, "CODEX_SETUP_PROBE is set: run this proof on its own");
  const evidence = process.env.CROSS_AGENT_REAL_CODEX_PLUGINS_EVIDENCE ?? "";
  assert.notEqual(evidence, "", "CROSS_AGENT_REAL_CODEX_PLUGINS_EVIDENCE is unset");
  assert.ok(path.isAbsolute(evidence), `the evidence directory ${evidence} is relative`);
  assert.equal(existsSync(evidence), false, `the evidence directory ${evidence} exists already: name a new one`);
  const resolved = commandPath(codexBinary, process.env);
  assert.ok(resolved !== null, `${codexBinary} does not resolve`);
  const codexHome = realpathSync(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"));
  // Real paths throughout, since `turn_context` reports the cwd Codex resolved.
  const home = realpathSync(homedir());
  const short = randomUUID();
  const root = path.join(home, `cross-agent-plugin-probe-${short}`);
  assert.equal(/[."\\]/.test(root), false, `the fixture path ${root} holds a character its trust key cannot carry`);
  const worktree = path.join(root, "worktrees", "probe");
  mkdirSync(evidence, { recursive: true });
  const homes = realpathSync(mkdtempSync(path.join(tmpdir(), "cross-agent-plugin-stage0-")));
  const versionOf = async () => (await promisify(execFile)(resolved, ["--version"], { encoding: "utf8" })).stdout.trim();

  const live = new Set<ReturnType<typeof spawnEngine>>();
  let launched = 0;
  let version: string | null = null;
  let spelling: KeySpelling | null = null;
  let snapshot: (UserLayer & { subtrees: string; projects: string[]; sha256: string | null }) | null = null;
  const markers: Record<string, unknown> = {};
  const verdict: {
    ok: boolean; head: string | null; version: string | null; stage0: Record<string, unknown>; turns: Record<string, TurnVerdict>;
    stop: { turn: string; kind: "failed" | "unresolved"; reasons: string[] } | null; legacy: unknown;
    acceptance: ReturnType<typeof acceptanceOf>["acceptance"]; limitations: ReturnType<typeof acceptanceOf>["limitations"];
  } = { ok: false, head: null, version: null, stage0: {}, turns: {}, stop: null, legacy: null, acceptance: null, limitations: [] };
  const stop = (turn: string, kind: "failed" | "unresolved", reasons: string[]) => { verdict.stop = { turn, kind, reasons }; };

  // Cleanup, once, from the `finally` below and from `t.after`: the engines and the fixture
  // go, the CLI is the one Stage 0 recorded, and only the trust keys the fixture owns leave
  // the operator's file, each by compare-and-swap.
  let cleanupResult: Record<string, unknown> & { ok: boolean } = { ok: false };
  let cleaning: Promise<void> | undefined;
  const cleanup = () => (cleaning ??= (async () => {
    const record: Record<string, unknown> & { ok: boolean } = { ok: false };
    const problems: string[] = [];
    for (const handle of live) killGroup(handle);
    rmSync(root, { recursive: true, force: true });
    rmSync(homes, { recursive: true, force: true });
    if (existsSync(root)) problems.push(`the fixture ${root} is still there`);
    try {
      if (version !== null) {
        record.version = await versionOf();
        if (record.version !== version) problems.push(`codex --version reads ${record.version}, not Stage 0's ${version}`);
      }
      if (snapshot === null || spelling === null) {
        record.config = "not read: no snapshot or no rehearsed spelling, so no engine was launched";
        if (launched > 0) problems.push("engines ran without a snapshot and a rehearsed spelling");
      } else {
        const keyPath = keyPaths[spelling];
        const owned = ownedProjectKeys(snapshot.projects, Object.keys((await readUserLayer(resolved, codexHome)).config.projects ?? {}), root);
        record.owned = owned;
        for (const key of owned) {
          let removed = false;
          for (let attempt = 0; attempt < 3 && !removed; attempt++) {
            const client = await configClient(resolved, codexHome);
            try {
              const current = userLayerOf(await client.call("config/read", { includeLayers: true }), codexHome);
              if (Object.hasOwn(current.config.projects ?? {}, key)) {
                await client.call("config/batchWrite", { filePath: current.file, expectedVersion: current.version,
                  edits: [{ keyPath: keyPath(key), value: null, mergeStrategy: "replace" }] });
              }
              removed = true;
            } catch (error) {
              record.lastError = String(error);
            } finally {
              await client.close();
            }
          }
          if (!removed) problems.push(`${key} could not be removed in three attempts`);
        }
        const final = await readUserLayer(resolved, codexHome);
        const keys = Object.keys(final.config.projects ?? {});
        if (owned.some((key) => keys.includes(key))) problems.push("a fixture-owned key remains");
        if (snapshot.projects.some((key) => !keys.includes(key))) problems.push("a project key the snapshot held is gone");
        if (preferenceSubtrees(final.config) !== snapshot.subtrees) problems.push("plugins, marketplaces or features differ from the snapshot");
        record.sha256 = { before: snapshot.sha256, after: sha256Of(final.file) };
        const before = snapshot.config;
        record.changedTopLevelKeys = [...new Set([...Object.keys(before), ...Object.keys(final.config)])]
          .filter((key) => JSON.stringify(canonical(before[key])) !== JSON.stringify(canonical(final.config[key])));
        markers.after = cacheMarkers(codexHome);
      }
    } catch (error) {
      problems.push(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
    record.problems = problems;
    record.ok = problems.length === 0;
    cleanupResult = record;
    writeJson(path.join(evidence, "cleanup.json"), record);
    writeJson(path.join(evidence, "plugin-cache-markers.json"), markers);
  })());
  t.after(cleanup);

  const main = async () => {
    verdict.head = (await promisify(execFile)("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    version = await versionOf();
    verdict.version = version;
    writeJson(path.join(evidence, "manifest.json"), {
      head: verdict.head, checkout, binary: resolved, real: realpathSync(resolved), version, model: probeModel, codexHome,
      fixture: root, worktree, turns: probeTurns, node: process.version, startedAt: new Date().toISOString(),
    });

    // Stage 0, with no model: the version, the cleanup rehearsal, the subtrees' equivalence,
    // the operator's snapshot read only, and the control literal's byte scan.
    writeJson(path.join(evidence, "stage0", "version.json"), { binary: resolved, real: realpathSync(resolved), version });
    const rehearsal = await rehearseCleanup(resolved, homes, [root, worktree]);
    writeJson(path.join(evidence, "stage0", "rehearsal.json"), rehearsal);
    const equivalence = await preferenceEquivalence(resolved, homes);
    writeJson(path.join(evidence, "stage0", "equivalence.json"), equivalence);
    const layer = await readUserLayer(resolved, codexHome);
    const taken = { ...layer, subtrees: preferenceSubtrees(layer.config), projects: Object.keys(layer.config.projects ?? {}), sha256: sha256Of(layer.file) };
    markers.before = cacheMarkers(codexHome);
    writeJson(path.join(evidence, "operator-config.json"), { version: taken.version, sha256: taken.sha256, subtrees: JSON.parse(taken.subtrees) });
    writeJson(path.join(evidence, "cleanup-plan.json"), {
      configFile: taken.file, version: taken.version, fixture: root, worktree, spelling: rehearsal.spelling,
      keyPath: rehearsal.spelling === null ? null : keyPaths[rehearsal.spelling]("<owned key>"),
      rule: "remove only the project keys absent from the snapshot and equal to or inside the fixture, each by compare-and-swap, retrying a conflict at most three times",
    });
    const scan = literalScan(resolved);
    writeJson(path.join(evidence, "stage0", "literal-scan.json"), scan);
    const problems = [
      ...(rehearsal.spelling === null ? ["no key spelling removed the owned keys byte for byte, refused a stale version and kept the rest"] : []),
      ...(equivalence.ok ? [] : ["the preference subtrees do not compare by value"]),
      ...(scan.files.length === 0 ? ["no binary was scanned for the control literal"] : []),
      ...(scan.found.length > 0 ? [`the control literal is in ${scan.found.join(", ")}`] : []),
    ];
    verdict.stage0 = { spelling: rehearsal.spelling, equivalence: equivalence.ok, scanned: scan.files, literalAbsent: scan.found.length === 0, problems };
    if (problems.length > 0) return stop("stage0", "unresolved", problems);
    spelling = rehearsal.spelling;
    snapshot = taken;

    const agentsMarker = `PLUGIN-PROBE-AGENTS-${short}`;
    await buildFixture(root, worktree, agentsMarker);
    const bases = {
      root: {
        role: "lead", rolePrompt: probeRole, cwd: root, engine: "codex", sandbox: sandboxFor("codex", "read-only"), model: probeModel, denyTargets: [],
        lead: { command: process.execPath, args: [path.join(checkout, "src", "server.ts"), "--project", root] },
      },
      worktree: {
        role: "implementer", rolePrompt: probeRole, cwd: worktree, engine: "codex", sandbox: sandboxFor("codex", "workspace-write"), model: probeModel, denyTargets: [],
        protectedPaths: [path.join(worktree, ".git"), path.join(root, ".git")],
      },
    } satisfies Record<string, Omit<SpawnRequest, "brief" | "sessionId" | "env" | "scratchDir" | "logPath" | "resultPath">>;
    const threads: Record<string, string> = {};
    const briefs: Record<string, string[]> = { X: [], Y: [], Z: [], V: [] };
    const prefixes: Record<string, string> = {};
    const controls: Record<string, string[]> = {};
    mkdirSync(path.join(evidence, "rollouts"), { recursive: true });

    for (const turn of probeTurns) {
      const dir = path.join(evidence, "turns", turn.id);
      mkdirSync(dir, { recursive: true });
      const base: Omit<SpawnRequest, "brief" | "sessionId" | "env" | "scratchDir" | "logPath" | "resultPath"> = bases[turn.at];
      const marker = `PLUGIN-PROBE-${turn.id}-${short.slice(0, 8)}`;
      const brief = briefFor(marker, { B: turn.cellB, D: turn.cellD });
      const taskId = `plugin-probe-${short.slice(0, 8)}-${turn.id}`;
      if (turn.head === "resume" && threads[turn.thread] === undefined) return stop(turn.id, "unresolved", [`no thread ${turn.thread} to resume`]);
      const request: SpawnRequest = {
        ...base, brief, sessionId: taskId,
        env: { ...childEnv(process.env, 0, taskId, [{ taskId, role: base.role, cwd: base.cwd }], "subscription", root), CROSS_AGENT_CODEX_BIN: resolved },
        scratchDir: dir, logPath: path.join(dir, "events.ndjson"), resultPath: path.join(dir, "final.txt"),
        ...(turn.head === "resume" ? { resumeSessionId: threads[turn.thread] } : {}),
      };
      const mounted = request.lead !== undefined;
      const arms = armsFor(request);
      const argv = arms[turn.arm];
      const armProblems = armFailures(arms, mounted);
      writeJson(path.join(dir, "argv.json"), { arm: turn.arm, argv, ...arms, problems: armProblems });
      if (armProblems.length > 0) return stop(turn.id, "unresolved", armProblems);

      launched++;
      const handle = spawnEngine(codex, request, {
        spawn(bin, args, options) {
          if (JSON.stringify(args) !== JSON.stringify(arms.exact)) throw new Error(`the pipeline's argv is not the exact arm: ${JSON.stringify(args)}`);
          return spawn(bin, argv, options);
        },
      });
      live.add(handle);
      let result: Awaited<typeof handle.result>;
      try {
        result = await settled(handle, turn.id);
      } catch (error) {
        killGroup(handle);
        return stop(turn.id, "unresolved", [String(error)]);
      } finally {
        live.delete(handle);
      }

      const thread = result.sessionId;
      writeFileSync(path.join(dir, "thread.txt"), `${thread ?? ""}\n`);
      if (thread === null) return stop(turn.id, "unresolved", [`the turn reported no thread: exit ${result.exitCode}, ${result.events.at(-1)?.text ?? ""}`]);
      if (turn.head === "fresh") threads[turn.thread] = thread;
      else if (thread !== threads[turn.thread]) return stop(turn.id, "unresolved", [`resumed ${threads[turn.thread]} but reported ${thread}`]);
      const files = rolloutFiles(codexHome, thread);
      if (files.length !== 1) return stop(turn.id, "unresolved", [`${files.length} rollout files for ${thread}: ${JSON.stringify(files)}`]);
      const text = readFileSync(files[0], "utf8");
      copyFileSync(files[0], path.join(evidence, "rollouts", path.basename(files[0])));
      briefs[turn.thread].push(brief);
      const reading = await readThread(thread, codexHome);
      const projectDirs = turn.at === "root" ? [root] : [worktree, root];
      const judgement = judgeTurn({ id: turn.id, class: turn.class, fresh: turn.head === "fresh", mounted, cellB: turn.cellB, cellD: turn.cellD }, {
        rollout: parseRollout(text),
        briefs: briefs[turn.thread],
        roleFile: probeRole,
        agentsMarker,
        replyMarker: marker,
        run: { exitCode: result.exitCode, completed: result.events.some((event) => event.kind === "result"), finalMessage: result.finalMessage },
        expect: { model: probeModel, cwd: base.cwd, sandbox: base.sandbox.profile, approval: "never" },
        where: { codexHome, home, projectDirs },
        commands: commandsOf(reading),
        fixtureFiles: projectDirs.map((directory) => path.join(directory, ".agents", "skills", "plugin-probe-fixture", "SKILL.md")),
        controlFiles: turn.class === "control" && turn.head === "fresh" ? null : controls[turn.at] ?? [],
        inventoryControl: expectedInventoryControl(request),
        facts: { literalAbsent: scan.found.length === 0, fixtureClean: fixtureAddsNothing(root, argv) },
        ...(turn.class === "legacy" ? { prefixUnchanged: prefixes[turn.thread] !== undefined && text.startsWith(prefixes[turn.thread]) } : {}),
      });
      prefixes[turn.thread] = text;
      if (turn.class === "control" && turn.head === "fresh") controls[turn.at] = judgement.recorded.nonPluginFiles as string[];
      // Every turn leaves the operator's plugin preferences as the snapshot found them.
      if (preferenceSubtrees((await readUserLayer(resolved, codexHome)).config) !== taken.subtrees) {
        judgement.failed.push("the operator's plugins, marketplaces or features changed during the turn");
        judgement.outcome = "fail";
      }
      writeJson(path.join(dir, "reading.json"), { thread, rollout: files[0], verdict: judgement, reading });
      verdict.turns[turn.id] = judgement;
      if (turn.class === "legacy") {
        verdict.legacy = { newBlock: judgement.recorded.newBlock, retainedPluginOrigin: judgement.recorded.retainedPluginOrigin, backendReceipt: judgement.recorded.backendReceipt };
      }
      if (judgement.outcome !== "pass") return stop(turn.id, judgement.outcome === "fail" ? "failed" : "unresolved", [...judgement.failed, ...judgement.unresolved]);
    }
  };

  try {
    await main();
  } catch (error) {
    verdict.stop ??= { turn: "harness", kind: "unresolved", reasons: [error instanceof Error ? error.stack ?? error.message : String(error)] };
  } finally {
    await cleanup();
  }
  // Accepted only when all eight turns passed: `bounded` where a turn recorded the accepted
  // limitation, `full` where none did. Written on every exit path, the limitations included.
  const accepted = acceptanceOf(verdict.turns, probeTurns.map((turn) => turn.id));
  verdict.acceptance = accepted.acceptance;
  verdict.limitations = accepted.limitations;
  verdict.ok = verdict.acceptance !== null;
  writeJson(path.join(evidence, "verdict.json"), { ...verdict, cleanup: { ok: cleanupResult.ok } });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.stop));
  assert.equal(cleanupResult.ok, true, JSON.stringify(cleanupResult));
});
