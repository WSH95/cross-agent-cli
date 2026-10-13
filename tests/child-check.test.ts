import "./child-check.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Each test file's check (atc-s96.131). Where a Node child's piped output is lost, as under
// Codex's workspace-write sandbox, a direct `node --test` of a file sees none of its results,
// so the check, each file's first import, stops that child before its tests. The preload
// stands in for the sandbox: the probe's process gets the stdout Node builds for a handle it
// cannot type, while fd 1 stays what it was. Each run has its own timeout: a run that hangs
// fails the test rather than stalling it.

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(testsDir, "fixtures", "child-check-probe.mjs");
const untypedStdout = `--import=${pathToFileURL(path.join(testsDir, "fixtures", "untyped-stdout.mjs")).href}`;
const marker = "child-check probe: its test ran\n";

// This file runs as a runner's child itself, so a run below starts without the
// NODE_TEST_CONTEXT it inherited, which would make a nested runner behave as a child.
function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const own = { ...process.env };
  delete own.NODE_TEST_CONTEXT;
  return { ...own, ...extra };
}

// The probe under a nested `node --test`, whose report goes to stderr: the preload discards
// the runner's own stdout too.
function runProbe(flags: string[], extra?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [
    "--test", "--test-reporter=spec", "--test-reporter-destination=stderr", ...flags, probe,
  ], { env: env(extra), encoding: "utf8", timeout: 30_000 });
}

test("a node --test child whose stdout Node could not type stops before its tests, naming the cause and what still runs", () => {
  const result = runProbe([], { NODE_OPTIONS: untypedStdout });
  assert.equal(result.error, undefined, `the run did not end within 30 s: ${result.error}`);
  assert.equal(result.status, 1, result.stderr);
  for (const pattern of [
    /sandbox that filters socket calls/, /npm test/,
    /node --test --test-isolation=none tests\/<concern>\.test\.ts/, /gate/,
  ]) assert.match(result.stderr, pattern);
  assert.ok(!result.stderr.includes(marker), result.stderr);
});

test("a node --test child whose stdout is a socket Node typed runs its tests", () => {
  const result = runProbe([]);
  assert.equal(result.error, undefined, `the run did not end within 30 s: ${result.error}`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes(marker), result.stderr);
});

test("an in-process run is never stopped, even with a stdout Node could not type", () => {
  const result = runProbe(["--test-isolation=none"], { NODE_OPTIONS: untypedStdout });
  assert.equal(result.error, undefined, `the run did not end within 30 s: ${result.error}`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes(marker), result.stderr);
});

test("every test file npm test runs opens by importing the check", () => {
  // The same files as npm test's glob, tests/**/*.test.ts.
  const files = fs.readdirSync(testsDir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".test.ts")).sort();
  assert.ok(files.some((file) => file.startsWith(`engines${path.sep}`)), files.join(", "));
  const missing = files.filter((file) => {
    const check = path.relative(path.dirname(path.join(testsDir, file)), path.join(testsDir, "child-check.mjs"))
      .split(path.sep).join("/");
    const first = fs.readFileSync(path.join(testsDir, file), "utf8").split("\n", 1)[0];
    return first !== `import "${check.startsWith(".") ? check : `./${check}`}";`;
  });
  assert.deepEqual(missing, []);
});

test("a test child whose stdout is not a socket is never stopped, even with a stdout Node could not type", (t) => {
  // Only a plain node run gives a runner's child an fd 1 that is no socket: a runner pipes its
  // children whatever its own stdout is. NODE_TEST_CONTEXT is set as the runner sets it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-agent-child-check-"));
  const stdout = fs.openSync(path.join(dir, "stdout"), "w");
  t.after(() => {
    fs.closeSync(stdout);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const result = spawnSync(process.execPath, [probe], {
    env: env({ NODE_TEST_CONTEXT: "child-v8", NODE_OPTIONS: untypedStdout }),
    stdio: ["ignore", stdout, "pipe"], encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.error, undefined, `the run did not end within 30 s: ${result.error}`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes(marker), result.stderr);
});
