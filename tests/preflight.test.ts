import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// npm test's preflight (atc-s96.124). A sandbox in which a Node child's piped output never
// arrives would leave the suite to fail and stall without testing anything, so the check
// runs before it and stops it there. Each run below has its own timeout: a preflight that
// hangs fails the test rather than stalling it.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preflight = path.join(repoRoot, "tests", "preflight.mjs");
const discardStdout = pathToFileURL(path.join(repoRoot, "tests", "fixtures", "discard-stdout.mjs")).href;

function run(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [preflight], { env, encoding: "utf8", timeout: 30_000 });
}

test("npm test runs the preflight first, and the suite only when it passes", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.test, "node tests/preflight.mjs && node --test 'tests/**/*.test.ts'");
});

test("the preflight passes silently where a Node child's piped output arrives", () => {
  const result = run(process.env);
  assert.equal(result.error, undefined);
  assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 0, stdout: "", stderr: "" });
});

test("the preflight stops at once, naming the cause and what still runs, where a Node child's piped output is lost", () => {
  // The preload reaches the preflight's own child through NODE_OPTIONS, as a sandbox's
  // filter reaches every process under it.
  const result = run({ ...process.env, NODE_OPTIONS: `--import=${discardStdout}` });
  assert.equal(result.error, undefined, `the preflight did not stop within 30 s: ${result.error}`);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  for (const pattern of [
    /stopped before the suite/, /piped output/, /Codex's workspace-write sandbox/,
    /node --test --test-isolation=none tests\/<concern>\.test\.ts/, /gate/,
  ]) assert.match(result.stderr, pattern);
});
