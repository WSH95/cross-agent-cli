import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import codex from "../../src/engines/codex.ts";
import { adapterFor, sandboxFor } from "../../src/engines/registry.ts";
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

test("codex declares its own profile names and what each one means", () => {
  // `off` is `--sandbox danger-full-access` in argv, which `plan` owns, not this map.
  assert.deepEqual(codex.sandboxProfiles, { "read-only": "read-only", "workspace-write": "write", off: "off" });
});

test("codex carries no deny list: its sandbox's network denial is that layer (P3/P3b)", () => {
  assert.deepEqual(codex.denyArgs(targets), []);
  assert.deepEqual(codex.denyArgs([]), []);
});

test("codex's exclusionArgs removes the operator's own configuration", () => {
  assert.deepEqual(codex.exclusionArgs(), ["--ignore-user-config"]);
});

test("codex's leadMount is the three -c settings P9 recorded, byte for byte", () => {
  const mount = codex.leadMount({ command: "node", args: ["/projects/team/src/server.ts"] }, "/projects/team/.cross-agent/tasks/task");
  assert.deepEqual(mount.argv, [
    "-c", 'mcp_servers.cross-agent.command="node"',
    "-c", 'mcp_servers.cross-agent.args=["/projects/team/src/server.ts"]',
    "-c", 'mcp_servers.cross-agent.default_tools_approval_mode="approve"',
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

test("the -o file is emptied before the run, so a stale result cannot be read as this one's", (t) => {
  const dirs = layout(t);
  const plan = codex.plan(requestFor(dirs));
  // `codex exec -o` writes the file at the end of the turn; a run that dies before that
  // would otherwise leave the previous run's message for the pipeline to read back and
  // report as this run's, which on a resumed task is the same file every time.
  assert.deepEqual(plan.files?.[0], { path: dirs.result, contents: "" });
  assert.deepEqual(plan.files?.map((file) => file.path), [dirs.result, dirs.role]);
});

test("an engine-placed lead's argv carries P9's three -c settings before the prompt", (t) => {
  const dirs = layout(t);
  const lead = { command: process.execPath, args: ["/projects/team/src/server.ts", "--project", "/projects/team"] };
  const plan = codex.plan(requestFor(dirs, { role: "lead", brief: "Run the loop.", rolePrompt: "You are the lead.\n", lead }));
  assert.deepEqual(plan.argv, [
    "exec", "--json", "-o", dirs.result, "-C", dirs.worktree, "--sandbox", "workspace-write",
    "--ignore-user-config", "--skip-git-repo-check",
    "-c", instructions(dirs.role),
    "-c", `mcp_servers.cross-agent.command=${JSON.stringify(process.execPath)}`,
    "-c", 'mcp_servers.cross-agent.args=["/projects/team/src/server.ts","--project","/projects/team"]',
    "-c", 'mcp_servers.cross-agent.default_tools_approval_mode="approve"',
    "-",
  ]);
  assert.equal(plan.stdin, "Run the loop.");
  // Nothing variadic and nothing greedy is left holding the end of the line: `-` is the
  // last argument, and every `-c` before it takes exactly one value.
  assert.equal(plan.argv.at(-1), "-");
  // The mount travels with the flag that makes it exclusive, and there is one of each.
  assert.equal(plan.argv.filter((argument) => argument === "--ignore-user-config").length, 1);
  assert.equal(plan.argv.filter((argument) => argument.startsWith("mcp_servers.")).length, 3);
  // A lead is resumed too, and the mount has to survive the different flag set.
  const resumed = codex.plan(requestFor(dirs, { role: "lead", rolePrompt: "You are the lead.\n", lead, resumeSessionId: threadId }));
  assert.equal(resumed.argv.filter((argument) => argument.startsWith("mcp_servers.")).length, 3);
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
// about a minute per turn, so neither is this task's.
//
// The stdin form on **both heads**: `codex exec … -` and `codex exec resume <id> … -`
// must each take the brief from stdin rather than send the literal `-` as the prompt.
// `--help` on 0.153.4 documents it for each — `codex exec [PROMPT]` says "If not provided
// as an argument (or if `-` is used), instructions are read from stdin", and `codex exec
// resume [SESSION_ID] [PROMPT]` says "If `-` is used, read from stdin" — so the flag fact
// is settled and what is left is that the run behaves as the help says, on both heads.
//
// And the P2 negative writes on a *resumed* session: a resume with `-c
// sandbox_mode="workspace-write"`, spawned in the role's worktree, must still be refused
// the repository root that P10 saw a resume one directory up write to.
test.skip("I2: a real Codex run reads the prompt from stdin on both heads and is denied P2's writes on a resume", () => {});
