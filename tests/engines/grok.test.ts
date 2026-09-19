import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import grok from "../../src/engines/grok.ts";
import { adapterFor, sandboxFor } from "../../src/engines/registry.ts";
import { canonicalPath } from "../../src/reservation.ts";
import { spawnEngine } from "../../src/engines/spawn.ts";
import type { EngineAdapter, EngineEvent, SpawnRequest } from "../../src/engines/types.ts";

const fake = fileURLToPath(new URL("../fixtures/fake-engine.mjs", import.meta.url));

const targets = Object.freeze([
  "claude", "codex", "grok", "/opt/custom codex", "node /projects/team/src/server.ts", "node /projects/team/src/cli.ts", "cross-agent",
]);

// A representative slice of it for the argv cases that are not about the list itself: an
// engine CLI, a configured `bin` path with a space in it, and this server's node command.
const someTargets = ["claude", "/opt/custom codex", "node /projects/team/src/server.ts"];
const someDeny = [
  "--deny", "Bash(claude *)", "--deny", "Bash(/opt/custom codex *)",
  "--deny", "Bash(node /projects/team/src/server.ts *)",
];

// The id the ledger holds, which Grok is given for a fresh run and reports back on its
// first line (P8), and P8's own session, the id a resume names.
const sessionId = "11111111-1111-4111-8111-111111111111";
const resumeId = "8d718a3f-32eb-4254-b991-acf067cb13d0";

function reasonFor(support: ReturnType<EngineAdapter["sandboxSupport"]>): string {
  if (support.ok) assert.fail("expected a refusal");
  return support.reason;
}

function scratch(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), "cross-agent-grok-"));
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
  return { root, task, worktree };
}

function requestFor(dirs: ReturnType<typeof layout>, patch: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    role: "implementer",
    brief: "Implement the brief.",
    rolePrompt: "You are the implementer.\n",
    cwd: dirs.worktree,
    engine: "grok",
    sandbox: sandboxFor("grok", "workspace"),
    sessionId,
    denyTargets: [...someTargets],
    env: {},
    scratchDir: dirs.task,
    logPath: path.join(dirs.task, "task.ndjson"),
    resultPath: path.join(dirs.task, "task.out"),
    ...patch,
  };
}

/**
 * A stand-in for the `grok` binary, reached the way a configured one is
 * (`CROSS_AGENT_GROK_BIN`). It runs the fake engine in its own process, so
 * `process.argv.slice(2)` there is exactly the argv the adapter built. Grok asks nothing
 * more of it than that: it writes no result file and this adapter reads no stderr.
 */
function shim(directory: string): string {
  const file = path.join(directory, "grok-shim.mjs");
  writeFileSync(file, `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(fake).href)});\n`);
  chmodSync(file, 0o755);
  return file;
}

test("the built-in table answers for grok with this adapter", () => {
  assert.equal(adapterFor("grok"), grok);
  assert.equal(grok.name, "grok");
});

test("grok declares four profile names, two of which cannot write", () => {
  assert.deepEqual(grok.sandboxProfiles, { "read-only": "read-only", strict: "read-only", workspace: "write", off: "off" });
});

test("grok's denyArgs is one --deny per target, in the enforced form (P3)", () => {
  assert.deepEqual(grok.denyArgs(targets), [
    "--deny", "Bash(claude *)", "--deny", "Bash(codex *)", "--deny", "Bash(grok *)", "--deny", "Bash(/opt/custom codex *)",
    "--deny", "Bash(node /projects/team/src/server.ts *)", "--deny", "Bash(node /projects/team/src/cli.ts *)", "--deny", "Bash(cross-agent *)",
  ]);
  assert.deepEqual(grok.denyArgs([]), []);
});

test("grok has no per-invocation exclusion flag at all", () => {
  assert.deepEqual(grok.exclusionArgs(), []);
});

test("grok's leadMount inherits: there is no per-run mount to build (P9)", () => {
  const mount = grok.leadMount({ command: "node", args: ["/projects/team/src/server.ts"] }, "/scratch");
  assert.deepEqual(mount, { argv: [], inherited: true });
  // Whatever the spec says, the answer is the same: the operator's own registration is the mount.
  assert.deepEqual(grok.leadMount({ command: "other", args: ["--project", "/elsewhere"], env: { A: "1" } }, "/scratch"), { argv: [], inherited: true });
});

test("grok's sandbox support reports the binary it cannot resolve, from the spawn's own environment", (t) => {
  const missing = path.join(process.cwd(), "no-such-grok-binary");
  const reason = reasonFor(grok.sandboxSupport({ CROSS_AGENT_GROK_BIN: missing }));
  assert.match(reason, /no-such-grok-binary/);
  assert.match(reason, /grok/);
  assert.deepEqual(grok.sandboxSupport({ CROSS_AGENT_GROK_BIN: process.execPath }), { ok: true });
  // The environment handed in is the whole of it: a `grok` on this process's own PATH
  // answers for nothing, because the spawn will run with the environment below.
  const directory = scratch(t);
  assert.match(reasonFor(grok.sandboxSupport({ PATH: directory })), /^grok binary "grok" not found/);
  writeFileSync(path.join(directory, "grok"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(directory, "grok"), 0o755);
  assert.deepEqual(grok.sandboxSupport({ PATH: directory }), { ok: true });
});

test("sandboxFor pairs a profile with the mode grok gives it, and refuses any other", () => {
  for (const [profile, mode] of Object.entries(grok.sandboxProfiles)) {
    assert.deepEqual(sandboxFor("grok", profile), { mode, profile });
  }
  // Another engine's profile name, and names only Object.prototype carries.
  for (const profile of ["workspace-write", "toString", ""]) {
    assert.throws(() => sandboxFor("grok", profile), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("grok"), error.message);
      assert.ok(error.message.includes(JSON.stringify(profile)), error.message);
      return true;
    });
  }
});

test("a write role's argv is design section 3's Grok line, in the order P8 ran it", (t) => {
  const dirs = layout(t);
  const request = requestFor(dirs, { model: "grok-4.6", effort: "high" });
  const plan = grok.plan(request);
  assert.equal(plan.bin, "grok");
  assert.equal(plan.cwd, dirs.worktree);
  assert.equal(plan.env, request.env);
  assert.deepEqual(plan.argv, [
    "-p", "Implement the brief.",
    "--cwd", dirs.worktree,
    "--sandbox", "workspace",
    "--permission-mode", "bypassPermissions",
    "--output-format", "streaming-messages-json",
    "--session-id", sessionId,
    "--model", "grok-4.6",
    "--reasoning-effort", "high",
    "--rules", "You are the implementer.\n",
    ...someDeny,
  ]);
  // The prompt is `-p`'s own value, so nothing goes on stdin; and Grok reads no file this
  // adapter writes, so the plan names none.
  assert.equal(plan.stdin, undefined);
  assert.equal(plan.files, undefined);
});

test("a read-only role's argv differs from a writing one only in the profile it names", (t) => {
  const dirs = layout(t);
  const request = requestFor(dirs, {
    role: "code-reviewer", brief: "Review the branch.", rolePrompt: "You are the code reviewer.\n",
    cwd: dirs.root, sandbox: sandboxFor("grok", "read-only"), model: "grok-4.6",
  });
  assert.deepEqual(grok.plan(request).argv, [
    "-p", "Review the branch.",
    "--cwd", dirs.root,
    "--sandbox", "read-only",
    "--permission-mode", "bypassPermissions",
    "--output-format", "streaming-messages-json",
    "--session-id", sessionId,
    "--model", "grok-4.6",
    "--rules", "You are the code reviewer.\n",
    ...someDeny,
  ]);
  // A flag with nothing to carry is not emitted: no model, no effort, no role prompt.
  const bare = grok.plan(requestFor(dirs, { rolePrompt: "" }));
  for (const flag of ["--model", "--reasoning-effort", "--rules"]) assert.equal(bare.argv.includes(flag), false);
});

test("every profile reaches --sandbox under the name grok gives it, off included", (t) => {
  const dirs = layout(t);
  const plans = Object.keys(grok.sandboxProfiles).map((profile) =>
    grok.plan(requestFor(dirs, { sandbox: sandboxFor("grok", profile) })));
  for (const [index, profile] of Object.keys(grok.sandboxProfiles).entries()) {
    const argv = plans[index].argv;
    assert.equal(argv.filter((argument) => argument === "--sandbox").length, 1);
    assert.equal(argv[argv.indexOf("--sandbox") + 1], profile);
    // Nothing else moves with the profile. `strict` is read-only like `read-only`, and
    // even `off` is a name Grok is given rather than the flag's absence, which is
    // `grok-build-plugin-cc`'s write mode and deliberately not this one.
    assert.deepEqual(argv.toSpliced(argv.indexOf("--sandbox") + 1, 1), plans[0].argv.toSpliced(plans[0].argv.indexOf("--sandbox") + 1, 1));
  }
});

test("a resumed run carries -r and never a --session-id beside it", (t) => {
  const dirs = layout(t);
  const plan = grok.plan(requestFor(dirs, { resumeSessionId: resumeId }));
  // The same line otherwise: P8 resumed in this format and the run announced the resumed
  // session on its first line, so nothing about the format changes with the flag.
  assert.deepEqual(plan.argv, [
    "-p", "Implement the brief.",
    "--cwd", dirs.worktree,
    "--sandbox", "workspace",
    "--permission-mode", "bypassPermissions",
    "--output-format", "streaming-messages-json",
    "-r", resumeId,
    "--rules", "You are the implementer.\n",
    ...someDeny,
  ]);
  assert.equal(plan.argv.includes("--session-id"), false);
  assert.equal(plan.argv.includes(sessionId), false);
});

test("the whole deny list ends the argv, one --deny per target, and a configured bin runs", (t) => {
  const dirs = layout(t);
  const bin = "/opt/custom/grok";
  const plan = grok.plan(requestFor(dirs, { denyTargets: [...targets], env: { CROSS_AGENT_GROK_BIN: bin } }));
  assert.equal(plan.bin, bin);
  assert.deepEqual(plan.argv.slice(-targets.length * 2), grok.denyArgs(targets));
  // Every `--deny` takes exactly one value, so the list can end the line without
  // swallowing anything; an empty list emits no flag at all.
  assert.equal(plan.argv.filter((argument) => argument === "--deny").length, targets.length);
  assert.equal(grok.plan(requestFor(dirs, { denyTargets: [] })).argv.includes("--deny"), false);
});

test("the role prompt travels as the --rules string itself, never as a path (P9)", (t) => {
  const dirs = layout(t);
  const rolePrompt = "You are the implementer.\nBegin every reply with ROLE-OK.\n";
  const plan = grok.plan(requestFor(dirs, { rolePrompt }));
  // Given a path, Grok put the path into the system prompt as literal text and the child
  // read the file with its own tool, so the flag carries the role's contents.
  assert.equal(plan.argv[plan.argv.indexOf("--rules") + 1], rolePrompt);
  assert.equal(plan.argv.filter((argument) => argument === "--rules").length, 1);
  // While the flag can carry it, the role stays out of the turn's own text.
  assert.equal(plan.argv[plan.argv.indexOf("-p") + 1], "Implement the brief.");
  assert.equal(plan.files, undefined);
});

test("a role prompt past the 100 KB argv limit goes to a file, never into another argument", (t) => {
  const dirs = layout(t);
  const limit = 100 * 1024;
  const atLimit = "r".repeat(limit);
  const carried = grok.plan(requestFor(dirs, { rolePrompt: atLimit })).argv;
  assert.equal(carried[carried.indexOf("--rules") + 1], atLimit);
  const over = `${atLimit}r`;
  const filed = grok.plan(requestFor(dirs, { rolePrompt: over }));
  const rules = path.join(dirs.task, "rules.md");
  // What the ceiling exists for is the kernel's limit on one argument, so the delivery it
  // falls back to cannot be another argument: `-p`'s value would hold the role text and
  // the brief, and be strictly larger than the `--rules` value that did not fit.
  assert.equal(filed.argv.includes("--rules"), false);
  assert.equal(filed.argv.includes("-p"), false);
  assert.equal(filed.argv[filed.argv.indexOf("--prompt-file") + 1], rules);
  assert.deepEqual(filed.files, [{ path: rules, contents: `${over}\n\nImplement the brief.` }]);
  // The adapter names the file; the pipeline is what puts it on disk.
  assert.equal(existsSync(rules), false);
  // The limit is the argument's bytes, which is what an exec limit counts: a moon is four
  // of them and one UTF-16 unit short of two.
  const moons = "🌙".repeat(limit / 4);
  assert.equal(Buffer.byteLength(moons), limit);
  assert.ok(moons.length < limit);
  const carriedMoons = grok.plan(requestFor(dirs, { rolePrompt: moons })).argv;
  assert.equal(carriedMoons[carriedMoons.indexOf("--rules") + 1], moons);
  const overByOneMoon = grok.plan(requestFor(dirs, { rolePrompt: `${moons}🌙` }));
  assert.equal(overByOneMoon.argv.includes("--rules"), false);
  assert.equal(overByOneMoon.argv.includes("--prompt-file"), true);
});

test("a brief too large for the command line travels as the prompt file", (t) => {
  const dirs = layout(t);
  const rolePrompt = "You are the reviewer.\n";
  // What the controller's own review delegation hit on 2026-09-19: a `review` brief with
  // the diff attached was 150,745 bytes and the launch died on `spawn E2BIG`, because the
  // role text — not the brief — was the only thing this adapter measured.
  const brief = "d".repeat(150 * 1024);
  const plan = grok.plan(requestFor(dirs, { rolePrompt, brief }));
  const file = path.join(dirs.task, "rules.md");
  assert.equal(plan.argv.includes("-p"), false);
  assert.equal(plan.argv[plan.argv.indexOf("--prompt-file") + 1], file);
  assert.deepEqual(plan.files, [{ path: file, contents: `${rolePrompt}\n\n${brief}` }]);
  // `--rules` is Grok's system-prompt path and this role text fits in one argument, so it
  // still travels that way; the file is the turn's own text.
  assert.equal(plan.argv[plan.argv.indexOf("--rules") + 1], rolePrompt);
  assert.equal(existsSync(file), false, "the adapter names the file; the pipeline writes it");
});

test("the prompt budget is the role text and the brief together, counted in bytes", (t) => {
  const dirs = layout(t);
  const budget = 64 * 1024;
  const rolePrompt = "r".repeat(1024);
  // Exactly at the budget: one argument each, as every ordinary task runs.
  const atLimit = grok.plan(requestFor(dirs, { rolePrompt, brief: "b".repeat(budget - 1024) }));
  assert.equal(atLimit.argv[atLimit.argv.indexOf("-p") + 1], "b".repeat(budget - 1024));
  assert.equal(atLimit.files, undefined);
  // One byte past it, the pair goes to the file: the sum is what the kernel charges for
  // the line, and either half alone is bounded by it.
  const over = grok.plan(requestFor(dirs, { rolePrompt, brief: "b".repeat(budget - 1023) }));
  assert.equal(over.argv.includes("-p"), false);
  assert.equal(over.argv.includes("--prompt-file"), true);
  // Bytes, not UTF-16 units, because that is what an exec limit counts.
  const moons = "🌙".repeat(budget / 4);
  assert.equal(Buffer.byteLength(moons), budget);
  assert.equal(grok.plan(requestFor(dirs, { rolePrompt: "", brief: moons })).argv.includes("-p"), true);
  assert.equal(grok.plan(requestFor(dirs, { rolePrompt: "", brief: `${moons}🌙` })).argv.includes("-p"), false);
});

test("a role prompt of nothing puts the brief alone in the prompt file", (t) => {
  const dirs = layout(t);
  const brief = "b".repeat(80 * 1024);
  const plan = grok.plan(requestFor(dirs, { rolePrompt: "", brief }));
  assert.deepEqual(plan.files, [{ path: path.join(dirs.task, "rules.md"), contents: brief }]);
  assert.equal(plan.argv.includes("--rules"), false);
});

test("plan refuses an engine-placed lead: Grok cannot be isolated as one (P9)", (t) => {
  const dirs = layout(t);
  const lead = { command: process.execPath, args: ["/projects/team/src/server.ts", "--project", "/projects/team"] };
  assert.throws(() => grok.plan(requestFor(dirs, { role: "lead", lead })), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /grok is not an engine-placed lead/);
    return true;
  });
  // The mount value still answers, because it describes the specialist path and the
  // operator CLI's own registration rather than a lead.
  assert.deepEqual(grok.leadMount(lead, dirs.task), { argv: [], inherited: true });
  // And a request with no lead carries no mount argument of any kind.
  const plan = grok.plan(requestFor(dirs));
  for (const flag of ["--mcp-config", "--plugin-dir", "--strict-mcp-config"]) assert.equal(plan.argv.includes(flag), false);
  assert.deepEqual(grok.exclusionArgs(), []);
});

test("--cwd is the request's cwd exactly, and that cwd is already canonical", (t) => {
  const dirs = layout(t);
  // A workspace reached through a symlink is a second string for one directory. The child
  // sees the real one, and the reservation is keyed by the real one, so the request carries
  // the real one and the adapter passes it through untouched.
  const link = path.join(dirs.root, "link-to-worktree");
  symlinkSync(dirs.worktree, link);
  const cwd = canonicalPath(link);
  assert.notEqual(cwd, link);
  assert.equal(cwd, canonicalPath(dirs.worktree));
  const plan = grok.plan(requestFor(dirs, { cwd }));
  assert.equal(plan.cwd, cwd);
  assert.equal(plan.argv[plan.argv.indexOf("--cwd") + 1], cwd);
  assert.equal(plan.argv.includes(link), false);
});

test("grok's parseLine reads the session id from the init line and nothing else", () => {
  // P8's own first line, shortened: it arrives on a resumed turn as well as a fresh one.
  assert.deepEqual(grok.parseLine(JSON.stringify({
    type: "system", subtype: "init", session_id: "8d718a3f-32eb-4254-b991-acf067cb13d0", apiKeySource: "oauth",
    model: "grok-4.6", cwd: "/tmp/probe-repo/.worktrees/p8b", permissionMode: "bypassPermissions",
    tools: ["run_terminal_command", "read_file"], mcp_servers: [{ name: "claude-design", status: "connected" }],
  })), { kind: "session", sessionId: "8d718a3f-32eb-4254-b991-acf067cb13d0" });
  for (const line of ['{"type":"system","subtype":"compact_boundary","session_id":"x"}', '{"type":"system","subtype":"init"}']) {
    assert.equal(grok.parseLine(line), null);
  }
});

test("an assistant turn is activity: its text, without the thinking, capped at 200 characters", () => {
  const turn = (content: unknown) => grok.parseLine(JSON.stringify({
    type: "assistant", session_id: "x", message: { type: "message", role: "assistant", content },
  }));
  assert.deepEqual(turn([
    { type: "thinking", thinking: "the private part", signature: "EtgECqgBCBEYAipASVvJ" },
    { type: "text", text: "Reading package.json." },
    { type: "tool_use", id: "call-1adf9901", name: "read_file", input: { target_file: "package.json" } },
    { type: "text", text: "Then the answer." },
  ]), { kind: "activity", text: "Reading package.json.\nThen the answer." });
  // A turn that is only a tool call is still the engine being alive, which is what
  // advances lastEventAt and keeps the task off the stall path.
  assert.deepEqual(turn([{ type: "tool_use", id: "call-2", name: "run_terminal_command", input: {} }]), { kind: "activity", text: "" });
  assert.deepEqual(turn("a string content, as the Messages API wire shape allows"),
    { kind: "activity", text: "a string content, as the Messages API wire shape allows" });
  assert.deepEqual(turn([{ type: "text", text: "x".repeat(300) }]), { kind: "activity", text: "x".repeat(200) });
  // By code point: cutting UTF-16 units would leave a lone surrogate in the ledger.
  assert.deepEqual(turn([{ type: "text", text: "🌙".repeat(250) }]), { kind: "activity", text: "🌙".repeat(200) });
});

test("a result line is the run's verdict, and a failed one's message is its joined errors", () => {
  assert.deepEqual(grok.parseLine('{"type":"result","subtype":"success","is_error":false,"duration_ms":11800,"num_turns":2,"result":"probe-repo","session_id":"x"}'),
    { kind: "result", text: "probe-repo" });
  // P8's own failure line, shortened: the message is in `errors` and there is no `result`
  // field at all.
  assert.deepEqual(grok.parseLine('{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":0,"num_turns":0,"stop_reason":null,"errors":["Couldn\'t set model \'no-such-model\'."],"session_id":"x"}'),
    { kind: "error", text: "Couldn't set model 'no-such-model'." });
  // A list, joined one per line: an operator reading a failure needs all of it.
  assert.deepEqual(grok.parseLine('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["first","second"]}'),
    { kind: "error", text: "first\nsecond" });
  // A success has to say so, so a line that omits `is_error` fails closed, and a failure
  // that says nothing at all still says which failure it was.
  const silent = grok.parseLine('{"type":"result","subtype":"error_during_execution","is_error":true}');
  assert.equal(silent?.kind, "error");
  assert.match(silent!.text, /error_during_execution/);
  const unstated = grok.parseLine('{"type":"result","subtype":"success","result":"no verdict at all"}');
  assert.equal(unstated?.kind, "error");
  assert.equal(unstated!.text, "no verdict at all");
  // A successful turn that carries no text is still the run's result.
  assert.deepEqual(grok.parseLine('{"type":"result","subtype":"success","is_error":false}'), { kind: "result", text: "" });
});

test("a line grok's vocabulary does not cover is not an event", () => {
  for (const line of [
    "", " ", "not json", "[]", "null", "42", '"text"', "{}", '{"type":"user","message":{"role":"user","content":[]}}',
    '{"type":"stream_event"}', '{"subtype":"init","session_id":"x"}',
    // The other format's lines, which this adapter never asked for (P8).
    '{"type":"available_commands","tools":["read_file"]}', '{"type":"thought","data":"thinking"}',
    '{"type":"end","stopReason":"end_turn","sessionId":"x"}', '{"type":"error","message":"Couldn\'t set model"}',
  ]) {
    assert.equal(grok.parseLine(line), null, line);
  }
});

test("grok declares no finish and no stderr reader: its output is a line stream", () => {
  const adapter: EngineAdapter = grok;
  assert.equal(adapter.finish, undefined);
  assert.equal(Object.hasOwn(grok, "finish"), false);
  // The sandbox is Grok's own and it reports its failures in the stream, so stderr stays
  // log evidence and nothing more.
  assert.equal(adapter.parseStderrLine, undefined);
  assert.equal(Object.hasOwn(grok, "parseStderrLine"), false);
});

test("grok's final message is the last result, then the last error, then nothing", () => {
  const events: EngineEvent[] = [
    { kind: "session", sessionId: "x" }, { kind: "activity", text: "working" },
    { kind: "result", text: "first" }, { kind: "error", text: "then a failure" }, { kind: "result", text: "last" },
  ];
  // Grok writes no result file of its own; the pipeline's is the previous run's at most.
  assert.equal(grok.finalMessage(events, "a file grok never wrote"), "last");
  assert.equal(grok.finalMessage([{ kind: "error", text: "only a failure" }], "a file grok never wrote"), "only a failure");
  assert.equal(grok.finalMessage([{ kind: "session", sessionId: "x" }], "a file grok never wrote"), "");
  assert.equal(grok.finalMessage([], null), "");
});

test("a fake grok run through the pipeline yields the session, the activity and the final text", async (t) => {
  const dirs = layout(t);
  const bin = shim(dirs.root);
  const record = path.join(dirs.task, "record.json");
  const request = requestFor(dirs, {
    model: "grok-4.6", effort: "high",
    env: { FAKE_ENGINE_FORMAT: "grok", FAKE_ENGINE_SCRIPT: "ok", FAKE_ENGINE_RECORD: record, CROSS_AGENT_GROK_BIN: bin },
  });
  const argv = [
    "-p", "Implement the brief.",
    "--cwd", dirs.worktree,
    "--sandbox", "workspace",
    "--permission-mode", "bypassPermissions",
    "--output-format", "streaming-messages-json",
    "--session-id", sessionId,
    "--model", "grok-4.6",
    "--reasoning-effort", "high",
    "--rules", "You are the implementer.\n",
    ...someDeny,
  ];
  const handle = spawnEngine(grok, request, {});
  t.after(() => { handle.kill("SIGKILL"); });
  const result = await handle.result;

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  const recorded = JSON.parse(readFileSync(record, "utf8"));
  assert.deepEqual(recorded.argv, argv);
  // The prompt is `-p`'s value and the role is `--rules`', so stdin carries nothing.
  assert.equal(recorded.stdin, "");
  assert.equal(recorded.cwd, dirs.worktree);
  // The session id arrives on the first line, before any activity, so a run that dies
  // mid-turn is still resumable.
  assert.match(result.sessionId ?? "", /^fake-\d+$/);
  assert.deepEqual(result.events, [
    { kind: "session", sessionId: result.sessionId! },
    { kind: "activity", text: "working" },
    { kind: "result", text: `DONE ${argv.join(" ")}` },
  ]);
  assert.equal(result.finalMessage, `DONE ${argv.join(" ")}`);
  assert.equal(readFileSync(request.resultPath, "utf8"), result.finalMessage);
});

test("a failed run settles as an error carrying the joined errors of its result line", async (t) => {
  const dirs = layout(t);
  const bin = shim(dirs.root);
  const request = requestFor(dirs, {
    env: { FAKE_ENGINE_FORMAT: "grok", FAKE_ENGINE_SCRIPT: "fail", CROSS_AGENT_GROK_BIN: bin },
  });
  const handle = spawnEngine(grok, request, {});
  t.after(() => { handle.kill("SIGKILL"); });
  const result = await handle.result;

  // A failed Grok turn exits 1 and still closes with a parseable result line (P8), so
  // success and failure settle down one path.
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.events.map((event) => event.kind), ["session", "activity", "error"]);
  assert.equal(result.events.at(-1)!.text, "fake failure");
  assert.equal(result.finalMessage, "fake failure");
  assert.equal(readFileSync(request.resultPath, "utf8"), "fake failure");
});
