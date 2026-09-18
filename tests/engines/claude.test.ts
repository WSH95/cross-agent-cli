import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import claude from "../../src/engines/claude.ts";
import { adapterFor, sandboxFor } from "../../src/engines/registry.ts";
import { canonicalPath } from "../../src/reservation.ts";
import { spawnEngine } from "../../src/engines/spawn.ts";
import type { EngineAdapter, EngineEvent, SpawnRequest } from "../../src/engines/types.ts";

const fake = fileURLToPath(new URL("../fixtures/fake-engine.mjs", import.meta.url));

// The deny list design section 3 builds at spawn: the three CLIs, a configured binary,
// this server, this CLI, and the operator command.
const targets = Object.freeze([
  "claude", "codex", "grok", "/opt/custom codex", "node /projects/team/src/server.ts", "node /projects/team/src/cli.ts", "cross-agent",
]);

// A representative slice of it for the argv cases that are not about the list itself: an
// engine CLI, a configured `bin` path with a space in it, and this server's node command.
const someTargets = ["claude", "/opt/custom codex", "node /projects/team/src/server.ts"];
const someDeny = [
  "Bash(claude *)", "Bash(claude)", "Bash(/opt/custom codex *)", "Bash(/opt/custom codex)",
  "Bash(node /projects/team/src/server.ts *)", "Bash(node /projects/team/src/server.ts)",
];

const sessionId = "11111111-1111-4111-8111-111111111111";

function scratch(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), "cross-agent-claude-"));
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
  return { root, task, worktree, role: path.join(task, "role.md") };
}

function requestFor(dirs: ReturnType<typeof layout>, patch: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    role: "implementer",
    brief: "Implement the brief.",
    rolePrompt: "You are the implementer.\n",
    cwd: dirs.worktree,
    engine: "claude",
    sandbox: sandboxFor("claude", "workspace-write"),
    sessionId,
    denyTargets: [...someTargets],
    env: {},
    scratchDir: dirs.task,
    logPath: path.join(dirs.task, "task.ndjson"),
    resultPath: path.join(dirs.task, "task.out"),
    ...patch,
  };
}

function reasonFor(support: ReturnType<EngineAdapter["sandboxSupport"]>): string {
  if (support.ok) assert.fail("expected a refusal");
  return support.reason;
}

function executable(directory: string, name: string): void {
  const file = path.join(directory, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
}

/**
 * A run through the pipeline needs `sandboxSupport` to pass on any machine, not only one
 * with bubblewrap installed, so P1's two prerequisites are put on the PATH the request
 * carries — the environment the spawn itself will run with, which is where the adapter
 * reads them.
 */
function sandboxPrerequisites(directory: string): string {
  const bin = path.join(directory, "sandbox-bin");
  mkdirSync(bin, { recursive: true });
  executable(bin, "bwrap");
  executable(bin, "socat");
  return bin;
}

/**
 * A stand-in for the `claude` binary, reached the way a configured one is
 * (`CROSS_AGENT_CLAUDE_BIN`). It runs the fake engine in its own process, so
 * `process.argv.slice(2)` there is exactly the argv the adapter built, and it writes
 * `CLAUDE_SHIM_STDERR` to stderr first when the case under test needs a diagnostic.
 */
function shim(directory: string): string {
  const file = path.join(directory, "claude-shim.mjs");
  writeFileSync(file,
    `#!${process.execPath}\n`
    + 'if (process.env.CLAUDE_SHIM_STDERR) process.stderr.write(process.env.CLAUDE_SHIM_STDERR + "\\n");\n'
    + `await import(${JSON.stringify(pathToFileURL(fake).href)});\n`);
  chmodSync(file, 0o755);
  return file;
}

test("the built-in table answers for claude with this adapter", () => {
  assert.equal(adapterFor("claude"), claude);
  assert.equal(claude.name, "claude");
});

test("claude declares its own profile names and what each one means", () => {
  assert.deepEqual(claude.sandboxProfiles, { "read-only": "read-only", "workspace-write": "write", off: "off" });
});

test("claude's denyArgs is one appendable --disallowedTools array carrying both forms", () => {
  assert.deepEqual(claude.denyArgs(targets), [
    "--disallowedTools", "Bash(claude *)", "Bash(claude)", "Bash(codex *)", "Bash(codex)",
    "Bash(grok *)", "Bash(grok)", "Bash(/opt/custom codex *)", "Bash(/opt/custom codex)",
    "Bash(node /projects/team/src/server.ts *)", "Bash(node /projects/team/src/server.ts)",
    "Bash(node /projects/team/src/cli.ts *)", "Bash(node /projects/team/src/cli.ts)", "Bash(cross-agent *)", "Bash(cross-agent)",
  ]);
});

test("claude's exclusionArgs is the flag that makes a mount exclusive", () => {
  assert.deepEqual(claude.exclusionArgs(), ["--strict-mcp-config"]);
});

test("claude's leadMount returns the config file and the flag that points at it (P9)", (t) => {
  const directory = scratch(t);
  const spec = {
    command: process.execPath,
    args: ["/projects/team/src/server.ts", "--project", "/projects/team"],
    env: { CROSS_AGENT_PROJECT: "/projects/team" },
  };
  const mount = claude.leadMount(spec, directory);
  const file = path.join(directory, "mcp-config.json");
  assert.deepEqual(mount.argv, ["--mcp-config", file]);
  assert.equal(mount.inherited, undefined);
  assert.deepEqual(mount.files?.map((entry) => entry.path), [file]);
  // The adapter is a pure argv builder: the pipeline writes what it returns.
  assert.equal(existsSync(file), false);
  assert.deepEqual(JSON.parse(mount.files![0].contents), {
    mcpServers: { "cross-agent": { command: spec.command, args: spec.args, env: spec.env } },
  });
  // Exclusivity is `--strict-mcp-config`'s, not the config file's, so it stays in exclusionArgs.
  assert.equal(mount.argv.includes("--strict-mcp-config"), false);
  const bare = claude.leadMount({ command: "node", args: [] }, directory);
  assert.deepEqual(JSON.parse(bare.files![0].contents), { mcpServers: { "cross-agent": { command: "node", args: [] } } });
});

test("claude's sandbox support names the Linux prerequisites it cannot find on the spawn's own PATH (P1)", (t) => {
  const directory = scratch(t);
  const env = { PATH: directory };
  if (process.platform !== "linux") {
    // P1 probed Linux. Nothing here has observed another platform's sandbox, and the
    // engine refuses on its own if its own sandbox cannot start.
    assert.deepEqual(claude.sandboxSupport(env), { ok: true });
    return;
  }
  // The reason names what is missing, not merely what is needed, and it is the handed-in
  // PATH that is searched: this process's own may well carry both.
  assert.match(reasonFor(claude.sandboxSupport(env)), /^bwrap and socat not found on PATH/);
  executable(directory, "bwrap");
  assert.match(reasonFor(claude.sandboxSupport(env)), /^socat not found on PATH/);
  rmSync(path.join(directory, "bwrap"));
  executable(directory, "socat");
  assert.match(reasonFor(claude.sandboxSupport(env)), /^bwrap not found on PATH/);
  executable(directory, "bwrap");
  assert.deepEqual(claude.sandboxSupport(env), { ok: true });
});

test("sandboxFor pairs a profile with the mode claude gives it, and refuses any other", () => {
  for (const [profile, mode] of Object.entries(claude.sandboxProfiles)) {
    assert.deepEqual(sandboxFor("claude", profile), { mode, profile });
  }
  // Another engine's profile name, and names only Object.prototype carries.
  for (const profile of ["strict", "workspace", "toString", ""]) {
    assert.throws(() => sandboxFor("claude", profile), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("claude"), error.message);
      assert.ok(error.message.includes(JSON.stringify(profile)), error.message);
      return true;
    });
  }
});

test("a read-only role's argv is P1's spawn line with no writable root and no editing tools", (t) => {
  const dirs = layout(t);
  const request = requestFor(dirs, {
    role: "code-reviewer", brief: "Review the branch.", rolePrompt: "You are the code reviewer.\n",
    cwd: dirs.root, sandbox: sandboxFor("claude", "read-only"), model: "claude-opus-5",
  });
  const plan = claude.plan(request);
  assert.equal(plan.bin, "claude");
  assert.equal(plan.cwd, dirs.root);
  assert.equal(plan.env, request.env);
  assert.deepEqual(plan.argv, [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
    "--strict-mcp-config",
    "--model", "claude-opus-5",
    "--session-id", sessionId,
    "--append-system-prompt-file", dirs.role,
    "--settings", '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true}}',
    "--disallowedTools", ...someDeny, "Edit", "Write", "MultiEdit", "NotebookEdit",
  ]);
  // The prompt is stdin's, so no positional argument follows the variadic flag.
  assert.equal(plan.stdin, "Review the branch.");
  assert.deepEqual(plan.files, [{ path: dirs.role, contents: "You are the code reviewer.\n" }]);
});

test("a write role's argv carries the worktree as the only writable root, and the whole deny list", (t) => {
  const dirs = layout(t);
  const plan = claude.plan(requestFor(dirs, { model: "claude-sonnet-5", effort: "high", denyTargets: [...targets] }));
  assert.equal(plan.cwd, dirs.worktree);
  assert.deepEqual(plan.argv, [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
    "--strict-mcp-config",
    "--model", "claude-sonnet-5",
    "--effort", "high",
    "--session-id", sessionId,
    "--append-system-prompt-file", dirs.role,
    "--settings", `{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true,"filesystem":{"allowWrite":[${JSON.stringify(dirs.worktree)}]}}}`,
    "--disallowedTools",
    "Bash(claude *)", "Bash(claude)", "Bash(codex *)", "Bash(codex)",
    "Bash(grok *)", "Bash(grok)", "Bash(/opt/custom codex *)", "Bash(/opt/custom codex)",
    "Bash(node /projects/team/src/server.ts *)", "Bash(node /projects/team/src/server.ts)",
    "Bash(node /projects/team/src/cli.ts *)", "Bash(node /projects/team/src/cli.ts)",
    "Bash(cross-agent *)", "Bash(cross-agent)",
  ]);
  // A writable role keeps the editing tools; only a read-only one loses them.
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.equal(plan.argv.includes(tool), false);
});

test("a resumed run carries --resume and never a --session-id beside it", (t) => {
  const dirs = layout(t);
  const plan = claude.plan(requestFor(dirs, { resumeSessionId: "138a9c9e-f573-45c5-80fc-fda76dddc834" }));
  assert.deepEqual(plan.argv, [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
    "--strict-mcp-config",
    "--resume", "138a9c9e-f573-45c5-80fc-fda76dddc834",
    "--append-system-prompt-file", dirs.role,
    "--settings", `{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true,"filesystem":{"allowWrite":[${JSON.stringify(dirs.worktree)}]}}}`,
    "--disallowedTools", ...someDeny,
  ]);
  assert.equal(plan.argv.includes("--session-id"), false);
  assert.equal(plan.argv.includes(sessionId), false);
});

test("an engine-placed lead's argv mounts this server exclusively, and its config is a plan file", (t) => {
  const dirs = layout(t);
  const lead = {
    command: process.execPath,
    args: ["/projects/team/src/server.ts", "--project", "/projects/team"],
    env: { CROSS_AGENT_PROJECT: "/projects/team" },
  };
  const mount = path.join(dirs.task, "mcp-config.json");
  const plan = claude.plan(requestFor(dirs, { role: "lead", rolePrompt: "You are the lead.\n", lead }));
  // P9's order: the mount travels with the flag that makes it exclusive.
  assert.deepEqual(plan.argv, [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
    "--strict-mcp-config", "--mcp-config", mount,
    "--session-id", sessionId,
    "--append-system-prompt-file", dirs.role,
    "--settings", `{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true,"filesystem":{"allowWrite":[${JSON.stringify(dirs.worktree)}]}}}`,
    "--disallowedTools", ...someDeny,
  ]);
  // `--mcp-config` is variadic, so what follows it has to be a flag, and the argv may end
  // only in the deny list's values: any other variadic flag left last would swallow them.
  assert.equal(plan.argv[plan.argv.indexOf("--mcp-config") + 2], "--session-id");
  assert.equal(plan.argv.at(-1), someDeny.at(-1));
  // One mount, and one flag making it exclusive: a second would be a second server.
  assert.equal(plan.argv.filter((argument) => argument === "--strict-mcp-config").length, 1);
  assert.equal(plan.argv.filter((argument) => argument === "--mcp-config").length, 1);
  assert.deepEqual(plan.files?.map((file) => file.path), [mount, dirs.role]);
  assert.deepEqual(JSON.parse(plan.files![0].contents), {
    mcpServers: { "cross-agent": { command: lead.command, args: lead.args, env: lead.env } },
  });
  // The adapter names the files; the pipeline is what puts them on disk.
  for (const file of plan.files!) assert.equal(existsSync(file.path), false);
});

test("the sandbox settings say disabled for the one profile that means it", (t) => {
  const dirs = layout(t);
  const plan = claude.plan(requestFor(dirs, { sandbox: sandboxFor("claude", "off") }));
  assert.equal(plan.argv[plan.argv.indexOf("--settings") + 1], '{"sandbox":{"enabled":false,"autoAllowBashIfSandboxed":true}}');
  // `off` is not read-only: an unsandboxed role still edits.
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.equal(plan.argv.includes(tool), false);
});

test("a sandboxed role may neither leave its sandbox nor run without one", (t) => {
  const dirs = layout(t);
  const sandboxOf = (profile: string): Record<string, unknown> => {
    const { argv } = claude.plan(requestFor(dirs, { sandbox: sandboxFor("claude", profile) }));
    return JSON.parse(argv[argv.indexOf("--settings") + 1]).sandbox;
  };

  // P1's rerun (2026-09-18): a sandboxed child whose `curl` failed at bwrap's setup re-ran
  // the same command with `dangerouslyDisableSandbox: true` and got its 200. Under
  // `bypassPermissions` nothing else stands between a specialist and its own sandbox, so
  // the settings close the escape hatch: the engine ignores that parameter at `false`.
  assert.equal(sandboxOf("workspace-write").allowUnsandboxedCommands, false);
  assert.equal(sandboxOf("read-only").allowUnsandboxedCommands, false);
  // A sandbox that cannot start is a refusal, not a warning and an unsandboxed run.
  // `sandboxSupport` catches a missing `bwrap` or `socat` before the spawn; this catches
  // every other way the sandbox fails to come up, which only the run can see.
  assert.equal(sandboxOf("workspace-write").failIfUnavailable, true);
  assert.equal(sandboxOf("read-only").failIfUnavailable, true);

  // `off` is the profile that asked for no sandbox: there is no escape hatch to close and
  // nothing whose absence could fail the run, so neither setting is sent.
  assert.equal("allowUnsandboxedCommands" in sandboxOf("off"), false);
  assert.equal("failIfUnavailable" in sandboxOf("off"), false);
});

test("the writable root is the request's cwd exactly, and that cwd is already canonical", (t) => {
  const dirs = layout(t);
  // A workspace reached through a symlink is a second string for one directory. The child
  // sees the real one, and the reservation is keyed by the real one, so the request carries
  // the real one — resolved by the same `canonicalPath` T10 will build the request with —
  // and the adapter passes it through untouched rather than normalising it again.
  const link = path.join(dirs.root, "link-to-worktree");
  symlinkSync(dirs.worktree, link);
  const cwd = canonicalPath(link);
  assert.notEqual(cwd, link);
  assert.equal(cwd, canonicalPath(dirs.worktree));
  const plan = claude.plan(requestFor(dirs, { cwd }));
  const settings = plan.argv[plan.argv.indexOf("--settings") + 1];
  assert.equal(plan.cwd, cwd);
  assert.deepEqual(JSON.parse(settings).sandbox.filesystem.allowWrite, [cwd]);
  assert.equal(settings.includes(link), false);
});

test("a configured binary is the one the plan spawns", (t) => {
  const dirs = layout(t);
  const bin = "/opt/custom/claude";
  assert.equal(claude.plan(requestFor(dirs, { env: { CROSS_AGENT_CLAUDE_BIN: bin } })).bin, bin);
});

test("a flag with nothing to carry is not emitted at all", (t) => {
  const dirs = layout(t);
  // An empty deny list would leave `--disallowedTools` looking for its variadic values,
  // and an empty role prompt would hand the binary an empty system prompt file.
  const plan = claude.plan(requestFor(dirs, { rolePrompt: "", denyTargets: [] }));
  assert.equal(plan.argv.includes("--disallowedTools"), false);
  assert.equal(plan.argv.includes("--append-system-prompt-file"), false);
  assert.deepEqual(plan.files, []);
  // Read-only still loses the editing tools, which is what the flag is for.
  const readOnly = claude.plan(requestFor(dirs, { rolePrompt: "", denyTargets: [], sandbox: sandboxFor("claude", "read-only") }));
  assert.deepEqual(readOnly.argv.slice(-5), ["--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
});

test("claude's parseLine reads the session id from the init line and nothing else", () => {
  assert.deepEqual(claude.parseLine(JSON.stringify({
    type: "system", subtype: "init", cwd: "/tmp/probe-repo", session_id: "138a9c9e-f573-45c5-80fc-fda76dddc834",
    tools: ["Task", "Bash"], mcp_servers: [{ name: "cross-agent", status: "connected" }], permissionMode: "bypassPermissions",
  })), { kind: "session", sessionId: "138a9c9e-f573-45c5-80fc-fda76dddc834" });
  for (const line of ['{"type":"system","subtype":"compact_boundary","session_id":"x"}', '{"type":"system","subtype":"init"}']) {
    assert.equal(claude.parseLine(line), null);
  }
});

test("an assistant turn is activity: its text, without the thinking, capped at 200 characters", () => {
  const turn = (content: unknown) => claude.parseLine(JSON.stringify({
    type: "assistant", session_id: "x", message: { type: "message", role: "assistant", content },
  }));
  assert.deepEqual(turn([
    { type: "thinking", thinking: "the private part", signature: "EtgECqgBCBEYAipASVvJ" },
    { type: "text", text: "Reading the design." },
    { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/docs/design.md" } },
    { type: "text", text: "Then the probes." },
  ]), { kind: "activity", text: "Reading the design.\nThen the probes." });
  // A turn that is only a tool call is still the engine being alive, which is what
  // advances lastEventAt and keeps the task off the stall path.
  assert.deepEqual(turn([{ type: "tool_use", id: "toolu_2", name: "Bash", input: {} }]), { kind: "activity", text: "" });
  assert.deepEqual(turn("a string content, as the Messages API wire shape allows"),
    { kind: "activity", text: "a string content, as the Messages API wire shape allows" });
  assert.deepEqual(turn([{ type: "text", text: "x".repeat(300) }]), { kind: "activity", text: "x".repeat(200) });
  // By code point: cutting UTF-16 units would leave a lone surrogate in the ledger.
  assert.deepEqual(turn([{ type: "text", text: "🌙".repeat(250) }]), { kind: "activity", text: "🌙".repeat(200) });
  assert.deepEqual(turn([{ type: "text", text: "🌙".repeat(150) }]), { kind: "activity", text: "🌙".repeat(150) });
});

test("a result line is the run's verdict: success is a result, anything else is an error", () => {
  assert.deepEqual(claude.parseLine('{"type":"result","subtype":"success","is_error":false,"session_id":"x","result":"the final message"}'),
    { kind: "result", text: "the final message" });
  assert.deepEqual(claude.parseLine('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"the failure"}'),
    { kind: "error", text: "the failure" });
  // A failure whose messages are a list: an operator reading it needs all of them.
  assert.deepEqual(claude.parseLine('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["first","second"]}'),
    { kind: "error", text: "first\nsecond" });
  // Either half of the verdict alone makes it a failure, and a missing half is a failure
  // too: a success has to say so, so a line that omits `is_error` fails closed.
  assert.deepEqual(claude.parseLine('{"type":"result","subtype":"success","is_error":true,"result":"contradiction"}'),
    { kind: "error", text: "contradiction" });
  assert.deepEqual(claude.parseLine('{"type":"result","subtype":"success","result":"no verdict at all"}'),
    { kind: "error", text: "no verdict at all" });
  assert.deepEqual(claude.parseLine('{"type":"result","subtype":"error_max_turns","is_error":false,"result":"ran out"}'),
    { kind: "error", text: "ran out" });
  const silent = claude.parseLine('{"type":"result","subtype":"error_max_turns","is_error":true}');
  assert.equal(silent?.kind, "error");
  assert.match(silent!.text, /error_max_turns/);
});

test("a line claude's vocabulary does not cover is not an event", () => {
  for (const line of [
    "", " ", "not json", "[]", "null", "42", '"text"', "{}", '{"type":"user","message":{}}',
    '{"type":"stream_event"}', '{"subtype":"init","session_id":"x"}',
  ]) {
    assert.equal(claude.parseLine(line), null, line);
  }
});

test("claude's stderr reader turns P1's two sandbox failures into an error, and nothing else", () => {
  const disabled = "Sandbox disabled: sandbox is enabled but dependencies are missing: socat not installed. Commands will run WITHOUT sandboxing.";
  const seccomp = "apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN): Permission denied";
  for (const line of [disabled, seccomp]) {
    assert.deepEqual(claude.parseStderrLine(line), { kind: "error", text: `claude sandbox failure: ${line}` });
  }
  for (const line of ["", "npm warn deprecated", "the sandbox is enabled", "Sandbox: enabled"]) {
    assert.equal(claude.parseStderrLine(line), null, line);
  }
});

test("claude's final message is the last result, then the last error, then nothing", () => {
  const events: EngineEvent[] = [
    { kind: "session", sessionId: "x" }, { kind: "activity", text: "working" },
    { kind: "result", text: "first" }, { kind: "error", text: "then a failure" }, { kind: "result", text: "last" },
  ];
  // Claude writes no result file of its own; the pipeline's is the previous run's at most.
  assert.equal(claude.finalMessage(events, "a file claude never wrote"), "last");
  assert.equal(claude.finalMessage([{ kind: "error", text: "only a failure" }], "a file claude never wrote"), "only a failure");
  assert.equal(claude.finalMessage([{ kind: "session", sessionId: "x" }], "a file claude never wrote"), "");
  assert.equal(claude.finalMessage([], null), "");
});

test("claude declares no finish: its output is a line stream, not one document at exit", () => {
  const adapter: EngineAdapter = claude;
  assert.equal(adapter.finish, undefined);
  assert.equal(Object.hasOwn(claude, "finish"), false);
});

test("a fake claude run through the pipeline yields the session, the activity and the final text", async (t) => {
  const dirs = layout(t);
  const record = path.join(dirs.task, "record.json");
  const request = requestFor(dirs, {
    model: "claude-sonnet-5",
    env: {
      FAKE_ENGINE_FORMAT: "claude", FAKE_ENGINE_SCRIPT: "ok", FAKE_ENGINE_RECORD: record,
      CROSS_AGENT_CLAUDE_BIN: shim(dirs.root), PATH: sandboxPrerequisites(dirs.root),
    },
  });
  const argv = [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
    "--strict-mcp-config",
    "--model", "claude-sonnet-5",
    "--session-id", sessionId,
    "--append-system-prompt-file", dirs.role,
    "--settings", `{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true,"filesystem":{"allowWrite":[${JSON.stringify(dirs.worktree)}]}}}`,
    "--disallowedTools", ...someDeny,
  ];
  // The role prompt is a file the child is pointed at, so it has to be on disk already.
  let roleAtSpawn: string | null = null;
  const handle = spawnEngine(claude, request, {
    spawn(bin, args, options) {
      roleAtSpawn = readFileSync(dirs.role, "utf8");
      return spawn(bin, args, options);
    },
  });
  t.after(() => { handle.kill("SIGKILL"); });
  const result = await handle.result;

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(roleAtSpawn, request.rolePrompt);
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")).argv, argv);
  assert.match(result.sessionId ?? "", /^fake-\d+$/);
  assert.deepEqual(result.events, [
    { kind: "session", sessionId: result.sessionId! },
    { kind: "activity", text: "working" },
    { kind: "result", text: `DONE ${argv.join(" ")}` },
  ]);
  assert.equal(result.finalMessage, `DONE ${argv.join(" ")}`);
  assert.equal(readFileSync(request.resultPath, "utf8"), result.finalMessage);
  assert.equal(JSON.parse(readFileSync(record, "utf8")).stdin, request.brief);
});

test("a failed run settles as an error carrying the engine's own message", async (t) => {
  const dirs = layout(t);
  const request = requestFor(dirs, {
    env: {
      FAKE_ENGINE_FORMAT: "claude", FAKE_ENGINE_SCRIPT: "fail",
      CROSS_AGENT_CLAUDE_BIN: shim(dirs.root), PATH: sandboxPrerequisites(dirs.root),
    },
  });
  const handle = spawnEngine(claude, request, {});
  t.after(() => { handle.kill("SIGKILL"); });
  const result = await handle.result;

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.events.map((event) => event.kind), ["session", "activity", "error"]);
  assert.equal(result.events.at(-1)!.text, "fake failure");
  assert.equal(result.finalMessage, "fake failure");
});

test("a sandbox failure on stderr fails a run the engine itself calls a success (P1)", async (t) => {
  const dirs = layout(t);
  const warning = "Sandbox disabled: sandbox is enabled but dependencies are missing: socat not installed. Commands will run WITHOUT sandboxing.";
  const request = requestFor(dirs, {
    env: {
      FAKE_ENGINE_FORMAT: "claude", FAKE_ENGINE_SCRIPT: "ok", CLAUDE_SHIM_STDERR: warning,
      CROSS_AGENT_CLAUDE_BIN: shim(dirs.root), PATH: sandboxPrerequisites(dirs.root),
    },
  });
  const handle = spawnEngine(claude, request, {});
  t.after(() => { handle.kill("SIGKILL"); });
  const result = await handle.result;

  // The engine exits 0 and reports a result; the sandbox it ran without is the failure.
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, false);
  assert.deepEqual(result.events.filter((event) => event.kind === "error"),
    [{ kind: "error", text: `claude sandbox failure: ${warning}` }]);
  assert.ok(result.events.some((event) => event.kind === "result"));
  // The line stays in the log as the engine wrote it, prefixed as stderr evidence.
  assert.match(readFileSync(request.logPath, "utf8"), new RegExp(`^stderr ${warning.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
});

test("a sandbox that fails every command is still one error event, and all of it evidence", async (t) => {
  const dirs = layout(t);
  // P1's other failure mode: the sandbox engages and every command inside it dies at its
  // setup, so the message arrives once per command and a long run would emit hundreds.
  const lines = ["curl", "npm test", "git status"].map((command) =>
    `${command}: apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN): Permission denied`);
  const request = requestFor(dirs, {
    env: {
      FAKE_ENGINE_FORMAT: "claude", FAKE_ENGINE_SCRIPT: "ok", CLAUDE_SHIM_STDERR: lines.join("\n"),
      CROSS_AGENT_CLAUDE_BIN: shim(dirs.root), PATH: sandboxPrerequisites(dirs.root),
    },
  });
  const handle = spawnEngine(claude, request, {});
  t.after(() => { handle.kill("SIGKILL"); });
  const result = await handle.result;

  assert.equal(result.ok, false);
  // One event: the run has already failed, and the record is not the place for the repeat.
  assert.deepEqual(result.events.filter((event) => event.kind === "error"),
    [{ kind: "error", text: `claude sandbox failure: ${lines[0]}` }]);
  // The log is where the repeat belongs, in full: every line the engine wrote.
  const log = readFileSync(request.logPath, "utf8");
  for (const line of lines) assert.ok(log.includes(`stderr ${line}\n`), line);
});
