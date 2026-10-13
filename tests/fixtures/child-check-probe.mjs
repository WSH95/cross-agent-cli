// A test file for tests/child-check.test.ts to run, opening as every test file does with the
// check. Its one test writes a marker straight to fd 2, so a run shows whether the test ran
// whatever happened to its stdout. Its name matches neither npm test's glob nor node --test's
// default patterns, so only that test runs it.
import "../child-check.mjs";
import test from "node:test";
import fs from "node:fs";

test("the probe's test runs", () => {
  fs.writeSync(2, "child-check probe: its test ran\n");
});
