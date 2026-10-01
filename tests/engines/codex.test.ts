import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import codex from "../../src/engines/codex.ts";
import { adapterFor, sandboxFor } from "../../src/engines/registry.ts";
import { commandPath } from "../../src/engines/binaries.ts";
import { canonicalPath } from "../../src/reservation.ts";
import { spawnEngine } from "../../src/engines/spawn.ts";
import type { EngineAdapter, EngineEvent, SpawnRequest } from "../../src/engines/types.ts";

const fake = fileURLToPath(new URL("../fixtures/fake-engine.mjs", import.meta.url));

const targets = Object.freeze([
  "claude", "codex", "grok", "/opt/custom codex", "node /projects/team/src/server.ts", "node /projects/team/src/cli.ts", "cross-agent",
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
test("codex's exclusionArgs removes the operator's own configuration", () => {
  assert.deepEqual(codex.exclusionArgs(), ["--ignore-user-config"]);
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
    "--ignore-user-config", "--skip-git-repo-check",
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
    "--ignore-user-config", "--skip-git-repo-check",
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
    "--ignore-user-config", "--skip-git-repo-check",
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
    "--ignore-user-config", "--skip-git-repo-check",
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
    "--ignore-user-config", "--skip-git-repo-check",
    "-c", 'sandbox_mode="danger-full-access"',
    "-c", instructions(dirs.role),
    "-",
  ]);
  // A read-only role resumes read-only, which is what a thread does on its own; saying it
  // is still the adapter's job, because the thread is not what it was launched as.
  const readOnly = codex.plan(requestFor(dirs, { resumeSessionId: threadId, sandbox: sandboxFor("codex", "read-only") }));
  assert.equal(readOnly.argv[readOnly.argv.indexOf("-c") + 1], 'sandbox_mode="read-only"');
});

// @anchor rolePromptTravels
test("the role prompt travels as a file under scratchDir, pointed at by -c (P9)", (t) => {
  const dirs = layout(t);
  const plan = codex.plan(requestFor(dirs));
  // The role file is the task's own, never inside the worktree the role may edit.
  assert.equal(path.dirname(dirs.role), dirs.task);
  assert.equal(plan.argv[plan.argv.indexOf("-c") + 1], instructions(dirs.role));
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
  assert.equal(quoted.argv[quoted.argv.indexOf("-c") + 1], `model_instructions_file="${escaped}"`);
  assert.ok(escaped.includes('\\"') && escaped.includes("\\\\"), escaped);
});

test("a role with no prompt of its own is pointed at no instructions file at all", (t) => {
  const dirs = layout(t);
  const plan = codex.plan(requestFor(dirs, { rolePrompt: "" }));
  assert.deepEqual(plan.argv, [
    "exec", "--json", "-o", dirs.result, "-C", dirs.worktree, "--sandbox", "workspace-write",
    "--ignore-user-config", "--skip-git-repo-check",
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
    "--ignore-user-config", "--skip-git-repo-check",
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
    "--ignore-user-config", "--skip-git-repo-check",
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
