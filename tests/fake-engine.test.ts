import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, "fixtures", "fake-engine.mjs");

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; kill: () => void }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fake, ...args], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.on("exit", (code) => resolve({ code, out, kill: () => child.kill() }));
  });
}

test("the fake engine records its argv and prints a result line", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fake-engine-"));
  const record = path.join(dir, "record.json");
  const { code, out } = await run(["--flag", "value"], { FAKE_ENGINE_RECORD: record, FAKE_ENGINE_SCRIPT: "ok" });
  assert.equal(code, 0);
  const lines = out.trim().split("\n").map((l) => JSON.parse(l) as { type: string; text?: string });
  assert.equal(lines[0].type, "session");
  assert.equal(lines.at(-1)?.type, "result");
  const recorded = JSON.parse(await readFile(record, "utf8")) as { argv: string[] };
  assert.deepEqual(recorded.argv, ["--flag", "value"]);
});

test("the fake engine exits non-zero on the fail script", async () => {
  const { code, out } = await run([], { FAKE_ENGINE_SCRIPT: "fail" });
  assert.equal(code, 2);
  assert.match(out, /"type":"error"/);
});
