import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawnEngine } from "../src/engines/spawn.ts";
import type { SpawnOptions } from "../src/engines/spawn.ts";
import type { EngineAdapter, EngineEvent, SpawnRequest } from "../src/engines/types.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-engine.mjs", import.meta.url));
const formats = ["generic", "claude", "codex", "grok"] as const;

const generic: EngineAdapter = {
  name: "claude",
  sandboxSupport: () => ({ ok: true }),
  plan: (request) => ({ bin: process.execPath, argv: [fake, request.brief], cwd: request.cwd, env: request.env }),
  parseLine(line) {
    let value;
    try { value = JSON.parse(line); } catch { return null; }
    if (value?.type === "session" && typeof value.session_id === "string") {
      return { kind: "session", sessionId: value.session_id };
    }
    if (typeof value?.text !== "string") return null;
    switch (value.type) {
      case "event": return { kind: "activity", text: value.text };
      case "result": return { kind: "result", text: value.text };
      case "error": return { kind: "error", text: value.text };
      default: return null;
    }
  },
  finalMessage(events, resultFileText) {
    const result = events.findLast((event) => event.kind === "result");
    const error = events.findLast((event) => event.kind === "error");
    return result?.text ?? resultFileText ?? error?.text ?? "";
  },
};

function task(t: TestContext) {
  const cwd = mkdtempSync(path.join(tmpdir(), "cross-agent-spawn-"));
  const kills: (() => void)[] = [];
  const results: Promise<unknown>[] = [];
  t.after(async () => {
    for (const kill of kills) kill();
    await Promise.allSettled(results);
    rmSync(cwd, { recursive: true, force: true });
  });
  const request: SpawnRequest = {
    role: "implementer", brief: "complete the task", rolePrompt: "Implement the brief.", cwd,
    sandbox: "workspace-write", model: "test-model", effort: "high", sessionId: randomUUID(),
    denyTargets: ["claude", "codex", "grok"], env: { FAKE_ENGINE_SCRIPT: "ok", FAKE_ENGINE_FORMAT: "generic" },
    logPath: path.join(cwd, "task.ndjson"), resultPath: path.join(cwd, "task.out"),
  };
  return {
    request,
    launch(adapter = generic, patch: Partial<SpawnRequest> = {}, options: SpawnOptions = {}) {
      const handle = spawnEngine(adapter, { ...request, ...patch }, options);
      kills.push(() => { handle.kill("SIGKILL"); });
      results.push(handle.result);
      return handle;
    },
    fixture(format: typeof formats[number], script = "ok", stdin = "") {
      const record = path.join(cwd, `${format}-${script}.json`);
      const env = { FAKE_ENGINE_FORMAT: format, FAKE_ENGINE_SCRIPT: script, FAKE_ENGINE_RECORD: record };
      const child = spawn(process.execPath, [fake, "--flag", "value"], { cwd, env });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { out += chunk; });
      child.stderr.resume();
      const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal, out }));
      });
      child.stdin.end(stdin);
      kills.push(() => { child.kill("SIGKILL"); });
      results.push(result);
      return { child, result, record, env, output: () => out };
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "child did not reach the expected state");
    await delay(10);
  }
}

function controlled() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let closing = false;
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      if (closing) return false;
      void close(null, signal);
      return true;
    },
  }) as ChildProcessWithoutNullStreams;
  async function close(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (closing) return;
    closing = true;
    const drained = [finished(stdout), finished(stderr)];
    stdout.end();
    stderr.end();
    await Promise.allSettled(drained);
    child.emit("close", code, signal);
  }
  return { child, close, spawn: () => child };
}

test("generic run resolves ok, captures session, writes final text, and appends raw lines in order", async (t) => {
  const { request, launch } = task(t);
  writeFileSync(request.logPath, "earlier evidence\n");
  const before = Date.now();
  const result = await launch().result;
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.match(result.sessionId!, /^fake-\d+$/);
  assert.deepEqual(result.events, [
    { kind: "session", sessionId: result.sessionId }, { kind: "activity", text: "working" },
    { kind: "result", text: "DONE complete the task" },
  ]);
  assert.equal(result.finalMessage, "DONE complete the task");
  assert.equal(readFileSync(request.resultPath, "utf8"), result.finalMessage);
  assert.ok(result.lastEventAt! >= before && result.lastEventAt! <= Date.now());
  const raw = [
    { type: "session", session_id: result.sessionId }, { type: "event", text: "working" },
    { type: "result", text: "DONE complete the task" },
  ].map((value) => JSON.stringify(value) + "\n").join("");
  assert.equal(readFileSync(request.logPath, "utf8"), "earlier evidence\n" + raw);
});

test("spawn exposes its PID and latest event time and creates a separate process group", async (t) => {
  const { launch } = task(t);
  const handle = launch(generic, { env: { FAKE_ENGINE_SCRIPT: "stall" } });
  try {
    const pid = handle.pid;
    assert.ok(Number.isInteger(pid) && pid! > 0);
    assert.equal(handle.lastEventAt, null);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    assert.equal(Number(fields[2]), pid);
    assert.equal(Number(fields[3]), pid, "detached engine leads its session too");
    await waitFor(() => handle.lastEventAt !== null);
    const latest = handle.lastEventAt;
    handle.kill("SIGKILL");
    const result = await handle.result;
    assert.equal(handle.pid, pid, "PID remains available after close");
    assert.equal(handle.lastEventAt, result.lastEventAt);
    assert.ok(handle.lastEventAt! >= latest!);
  } finally {
    handle.kill("SIGKILL");
    await handle.result;
  }
});

test("fail script resolves false with exit code 2 and its error event", async (t) => {
  const { launch, request } = task(t);
  const result = await launch(generic, { env: { FAKE_ENGINE_SCRIPT: "fail" } }).result;
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.signal, null);
  assert.deepEqual(result.events.at(-1), { kind: "error", text: "fake failure" });
  assert.equal(readFileSync(request.resultPath, "utf8"), result.finalMessage);
});

test("stall remains pending until kill and reports SIGKILL", { timeout: 5000 }, async (t) => {
  const { launch, request } = task(t);
  const handle = launch(generic, { env: { FAKE_ENGINE_SCRIPT: "stall" } });
  let settled = false;
  void handle.result.then(() => { settled = true; });
  await waitFor(() => existsSync(request.logPath) && readFileSync(request.logPath, "utf8").includes('"working"'));
  await delay(40);
  assert.equal(settled, false);
  assert.equal(handle.kill("SIGKILL"), true);
  const result = await handle.result;
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGKILL");
  assert.deepEqual(result.events.at(-1), { kind: "activity", text: "working" });
  assert.equal(handle.kill("SIGKILL"), false);
});

test("unsupported sandbox refuses before planning or spawning", (t) => {
  const { request } = task(t);
  const adapter: EngineAdapter = {
    ...generic, sandboxSupport: () => ({ ok: false, reason: "missing sandbox dependency" }),
    plan: () => { assert.fail("must refuse before planning"); },
  };
  for (const sandbox of ["read-only", "workspace-write"] as const) {
    assert.throws(() => spawnEngine(adapter, { ...request, sandbox }, {
      spawn: () => { assert.fail("must refuse before spawning"); },
    }), /claude.*missing sandbox dependency/);
  }
  assert.equal(existsSync(request.logPath), false);
  assert.equal(existsSync(request.resultPath), false);
});

test("sandbox off permits an unsupported adapter", async (t) => {
  const { launch } = task(t);
  const adapter = { ...generic, sandboxSupport: () => { assert.fail("off must bypass the capability check"); } };
  assert.equal((await launch(adapter, { sandbox: "off" }).result).ok, true);
});

test("plan stdin, argv, cwd, and environment reach the child", async (t) => {
  const { launch, request } = task(t);
  const record = path.join(request.cwd, "invocation.json");
  const env = { FAKE_ENGINE_RECORD: record, CROSS_AGENT_DEPTH: "1", CROSS_AGENT_LINEAGE: "[]", TASK_MARKER: "child only" };
  const argv = [fake, "--flag", "two words", "quotes ' \" $()", "日本語"];
  const stdin = "first line\nsecond line — 🌙\n";
  let calls = 0;
  const adapter = { ...generic, plan: () => ({ bin: process.execPath, argv, cwd: request.cwd, env, stdin }) };
  const result = await launch(adapter, {}, {
    spawn(bin, args, options) {
      calls++;
      assert.equal(bin, process.execPath);
      assert.deepEqual(args, argv);
      assert.equal(options.cwd, request.cwd);
      assert.deepEqual(options.env, env);
      assert.equal(options.detached, true);
      return spawn(bin, args, options);
    },
  }).result;
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), { argv: argv.slice(1), cwd: request.cwd, env, stdin });
});

test("first session wins and only parsed events advance lastEventAt", async (t) => {
  const { launch } = task(t);
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const engine = controlled();
  const handle = launch(generic, {}, { spawn: engine.spawn });
  assert.equal(handle.lastEventAt, null);
  engine.child.stdout.write('{"type":"session","session_id":"first"}\n');
  assert.equal(handle.lastEventAt, 100);
  now = 200;
  engine.child.stdout.write('{"type":"event","text":"working"}\n');
  now = 300;
  engine.child.stdout.write('{"type":"session","session_id":"second"}\n');
  now = 900;
  engine.child.stdout.write("unknown line\n");
  engine.child.stderr.write("stderr activity\n");
  assert.equal(handle.lastEventAt, 300);
  await engine.close();
  const result = await handle.result;
  assert.equal(result.sessionId, "first");
  assert.equal(result.lastEventAt, 300);
  assert.deepEqual(result.events, [
    { kind: "session", sessionId: "first" }, { kind: "activity", text: "working" },
    { kind: "session", sessionId: "second" },
  ]);
});

test("unknown output leaves sessionId and lastEventAt null", async (t) => {
  const { launch } = task(t);
  const engine = controlled();
  const handle = launch(generic, {}, { spawn: engine.spawn });
  engine.child.stdout.write("not an event\n");
  engine.child.stderr.write("also not an event\n");
  await engine.close();
  const result = await handle.result;
  assert.equal(result.sessionId, null);
  assert.equal(result.lastEventAt, null);
  assert.deepEqual(result.events, []);
});

test("logging preserves split lines, Unicode, CRLF, unknown lines, and EOF fragments", async (t) => {
  const { launch, request } = task(t);
  const engine = controlled();
  const lines: string[] = [];
  const adapter = { ...generic, parseLine(line: string) { lines.push(line); return generic.parseLine(line); } };
  const handle = launch(adapter, {}, { spawn: engine.spawn });
  const raw = Buffer.concat([
    Buffer.from('{"type":"event","text":"日本語 🌙"}\r\nunknown '), Buffer.from([255]),
    Buffer.from(' line\r\n\n{"type":"result","text":"尾 🌙"}'),
  ]);
  for (const byte of raw) engine.child.stdout.write(Buffer.from([byte]));
  await engine.close();
  const result = await handle.result;
  assert.equal(result.ok, true);
  assert.equal(result.finalMessage, "尾 🌙");
  assert.deepEqual(readFileSync(request.logPath), raw);
  assert.deepEqual(lines, [
    '{"type":"event","text":"日本語 🌙"}', "unknown � line", "", '{"type":"result","text":"尾 🌙"}',
  ]);
  assert.equal(readFileSync(request.resultPath, "utf8"), "尾 🌙");
});

test("stderr is prefixed without becoming an engine event", async (t) => {
  const { launch, request } = task(t);
  const engine = controlled();
  const handle = launch(generic, {}, { spawn: engine.spawn });
  engine.child.stderr.write("warn 🌙\r");
  engine.child.stderr.write('\n{"type":"error","text":"stderr only"}\nfragment');
  engine.child.stdout.write('{"type":"result","text":"done"}\n');
  await engine.close();
  const result = await handle.result;
  assert.equal(result.ok, true);
  assert.deepEqual(result.events, [{ kind: "result", text: "done" }]);
  assert.equal(readFileSync(request.logPath, "utf8"),
    'stderr warn 🌙\r\nstderr {"type":"error","text":"stderr only"}\n'
    + '{"type":"result","text":"done"}\nstderr fragment');
});

test("error event fails a zero-exit run", async (t) => {
  const { launch } = task(t);
  const engine = controlled();
  const handle = launch(generic, {}, { spawn: engine.spawn });
  engine.child.stdout.write('{"type":"error","text":"native failure"}\n');
  await engine.close();
  const result = await handle.result;
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, false);
  assert.equal(result.finalMessage, "native failure");
});

test("launch failure resolves false", async (t) => {
  for (const mode of ["missing binary", "synchronous spawn error"]) {
    await t.test(mode, async (t) => {
      const { launch, request } = task(t);
      const adapter = { ...generic, plan: () => ({ ...generic.plan(request), bin: path.join(request.cwd, "missing") }) };
      const handle = mode === "missing binary" ? launch(adapter) : launch(adapter, {}, {
        spawn: () => { throw new Error("launch failed synchronously"); },
      });
      const result = await handle.result;
      assert.equal(result.ok, false);
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.sessionId, null);
      assert.equal(result.lastEventAt, null);
      assert.ok(result.events.some((event) => event.kind === "error" && /ENOENT|launch failed/.test(event.text)));
      assert.equal(readFileSync(request.resultPath, "utf8"), result.finalMessage);
      assert.equal(handle.kill(), false);
    });
  }
});

test("stream errors terminate the child and finalize once", async (t) => {
  for (const stream of ["stdin", "stdout", "stderr"] as const) {
    await t.test(stream, async (t) => {
      const { launch, request } = task(t);
      const engine = controlled();
      let finalized = 0;
      const adapter = { ...generic, finalMessage(events: EngineEvent[], text: string | null) {
        finalized++;
        return generic.finalMessage(events, text);
      } };
      const handle = launch(adapter, {}, { spawn: engine.spawn });
      engine.child[stream].destroy(new Error(`${stream} failed`));
      const result = await handle.result;
      assert.equal(result.ok, false);
      assert.ok(result.events.some((event) => event.kind === "error" && event.text.includes(`${stream} failed`)));
      assert.equal(result.lastEventAt, null);
      assert.equal(finalized, 1);
      assert.equal(handle.kill(), false);
      assert.equal(readFileSync(request.resultPath, "utf8"), result.finalMessage);
    });
  }
});

test("completion waits for close and drained output after exit", async (t) => {
  const { launch, request } = task(t);
  const engine = controlled();
  const handle = launch(generic, {}, { spawn: engine.spawn });
  let settled = false;
  void handle.result.then(() => { settled = true; });
  engine.child.emit("exit", 0, null);
  await delay(10);
  assert.equal(settled, false);
  const text = "tail 🌙 ".repeat(30_000);
  const raw = JSON.stringify({ type: "result", text });
  engine.child.stdout.write(raw);
  engine.child.stderr.write("last diagnostic");
  await engine.close();
  const result = await handle.result;
  assert.equal(result.finalMessage, text);
  assert.equal(readFileSync(request.resultPath, "utf8"), text);
  assert.equal(readFileSync(request.logPath, "utf8"), raw + "stderr last diagnostic");
});

test("finalMessage receives engine-written result text before replacement", async (t) => {
  const { launch, request } = task(t);
  let finalized = 0;
  const adapter: EngineAdapter = {
    ...generic,
    plan: () => ({
      bin: process.execPath, argv: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'engine text\\n');", request.resultPath],
      cwd: request.cwd, env: request.env,
    }),
    finalMessage(events, text) {
      finalized++;
      assert.deepEqual(events, []);
      assert.equal(text, "engine text\n");
      return `final: ${text}`;
    },
  };
  const result = await launch(adapter).result;
  assert.equal(result.ok, true);
  assert.equal(finalized, 1);
  assert.equal(result.finalMessage, "final: engine text\n");
  assert.equal(readFileSync(request.resultPath, "utf8"), result.finalMessage);
  assert.equal(readFileSync(request.logPath, "utf8"), "");
});

test("finalMessage receives null when the engine did not write a result file", async (t) => {
  const { launch } = task(t);
  const adapter = { ...generic, finalMessage(events: EngineEvent[], text: string | null) {
    assert.equal(text, null);
    return generic.finalMessage(events, text);
  } };
  assert.equal((await launch(adapter).result).ok, true);
});

test("claude format emits init session_id, assistant content, and final result", async (t) => {
  const run = task(t).fixture("claude");
  const { code, out } = await run.result;
  assert.equal(code, 0);
  const lines = out.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].type, "system");
  assert.equal(lines[0].subtype, "init");
  assert.match(lines[0].session_id, /^fake-\d+$/);
  const assistant = lines.find((line) => line.type === "assistant");
  assert.equal(assistant.message.role, "assistant");
  assert.deepEqual(assistant.message.content, [{ type: "text", text: "working" }]);
  assert.equal(lines.at(-1).type, "result");
  assert.equal(lines.at(-1).result, "DONE --flag value");
  assert.equal(lines.at(-1).session_id, lines[0].session_id);
});

test("codex format emits thread_id, agent_message text, and turn.completed", async (t) => {
  const run = task(t).fixture("codex");
  const { code, out } = await run.result;
  assert.equal(code, 0);
  const lines = out.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].type, "thread.started");
  assert.match(lines[0].thread_id, /^fake-\d+$/);
  assert.deepEqual(lines.filter((line) => line.type === "item.completed").map((line) => {
    assert.equal(line.item.type, "agent_message");
    assert.equal(typeof line.item.id, "string");
    return line.item.text;
  }), ["working", "DONE --flag value"]);
  assert.equal(lines.at(-1).type, "turn.completed");
});

test("grok format emits one multiline final object containing sessionId and text", async (t) => {
  const { code, out } = await task(t).fixture("grok").result;
  assert.equal(code, 0);
  const value = JSON.parse(out);
  assert.equal(value.text, "DONE --flag value");
  assert.match(value.sessionId, /^fake-\d+$/);
  assert.equal(out, JSON.stringify(value, null, 2) + "\n");
  assert.ok(out.trim().split("\n").length > 1);
});

test("every format preserves fail, stall, and invocation recording", { timeout: 10_000 }, async (t) => {
  for (const format of formats) {
    for (const script of ["ok", "fail", "stall"]) {
      await t.test(`${format} ${script}`, async (t) => {
        const { request, fixture } = task(t);
        const run = fixture(format, script, "recorded stdin\n🌙");
        if (script === "stall") {
          await waitFor(() => existsSync(run.record));
          let settled = false;
          void run.result.then(() => { settled = true; });
          await delay(40);
          assert.equal(settled, false);
          if (format === "grok") assert.equal(run.output(), "", "no final object before completion");
          else assert.notEqual(run.output(), "");
          run.child.kill("SIGTERM");
        }
        const { code, signal, out } = await run.result;
        assert.equal(code, script === "fail" ? 2 : script === "stall" ? 143 : 0);
        assert.equal(signal, null);
        assert.deepEqual(JSON.parse(readFileSync(run.record, "utf8")), {
          argv: ["--flag", "value"], cwd: request.cwd, env: run.env, stdin: "recorded stdin\n🌙",
        });
        if (script === "fail") {
          assert.match(out, /fake failure/);
          if (format === "grok") {
            assert.equal(JSON.parse(out).text, "fake failure");
          } else {
            const last = JSON.parse(out.trim().split("\n").at(-1)!);
            if (format === "generic") assert.equal(last.type, "error");
            if (format === "claude") {
              assert.equal(last.type, "result");
              assert.equal(last.is_error, true);
            }
            if (format === "codex") assert.equal(last.type, "turn.failed");
          }
        }
      });
    }
  }
});
