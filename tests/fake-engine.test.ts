import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, "fixtures", "fake-engine.mjs");

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fake, ...args], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, kill: () => child.kill() }));
    child.stdin.end();
  });
}

test("the fake engine records its argv and prints a result line", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "fake-engine-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const record = path.join(dir, "record.json");
  const { code, out } = await run(["--flag", "value"], { FAKE_ENGINE_RECORD: record, FAKE_ENGINE_SCRIPT: "ok" });
  assert.equal(code, 0);
  const lines = out.trim().split("\n").map((l) => JSON.parse(l) as { type: string; text?: string });
  assert.equal(lines[0].type, "session");
  assert.equal(lines.at(-1)?.type, "result");
  const recorded = JSON.parse(await readFile(record, "utf8")) as { argv: string[]; stdin: string };
  assert.deepEqual(recorded.argv, ["--flag", "value"]);
  assert.equal(recorded.stdin, "");
});

test("the fake engine exits non-zero on the fail script", async () => {
  const { code, out } = await run([], { FAKE_ENGINE_SCRIPT: "fail" });
  assert.equal(code, 2);
  assert.match(out, /"type":"error"/);
});

test("stall-ignore-term survives SIGTERM and exits on SIGKILL", { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, [fake], { env: { FAKE_ENGINE_SCRIPT: "stall-ignore-term" } });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.resume();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end();
  try {
    const deadline = Date.now() + 2000;
    while (!out.includes('"working"')) {
      assert.ok(Date.now() < deadline, "fixture did not become ready");
      await delay(10);
    }
    assert.equal(child.kill("SIGTERM"), true);
    await delay(100);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(child.kill("SIGKILL"), true);
    assert.deepEqual(await closed, { code: null, signal: "SIGKILL" });
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
});
