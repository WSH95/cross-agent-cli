#!/usr/bin/env node
// A stand-in for a tracker's command line, run by `track` with no shell. Its first argument
// is what it does; every argument after it is the template's, filled.
// @anchor fakeTrackerActions
//   print: prints its arguments as JSON, then FAKE-1
//   append=<path>: appends one JSON line to the path, under the cwd, creating its
//     directories, then prints as print does
//   fail: writes "fake tracker failed" to stderr and exits 3
//   fail=<path>: appends as append= does, then fails as fail does
//   commit=<path>: appends as append= does, then git add <path> and git commit -q -m fake
//   sleep: waits until it is killed
//   FAKE_TRACKER_RECORD: path of a JSON file to write {argv, cwd, env, pid} to first
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

if (process.env.FAKE_TRACKER_RECORD) {
  writeFileSync(
    process.env.FAKE_TRACKER_RECORD,
    JSON.stringify({ argv: process.argv, cwd: process.cwd(), env: process.env, pid: process.pid }),
  );
}
const [action = "print", ...rest] = process.argv.slice(2);
const [name, file] = action.includes("=") ? [action.slice(0, action.indexOf("=")), action.slice(action.indexOf("=") + 1)] : [action, undefined];

const print = () => process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\nFAKE-1\n`);
const append = () => {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: Date.now(), args: rest })}\n`);
};
const fail = () => {
  process.stderr.write("fake tracker failed\n");
  process.exit(3);
};

switch (name) {
  case "print":
    print();
    break;
  case "append":
    append();
    print();
    break;
  case "fail":
    if (file !== undefined) append();
    fail();
    break;
  case "commit":
    append();
    execFileSync("git", ["add", "--", file]);
    execFileSync("git", ["commit", "-q", "-m", "fake"]);
    print();
    break;
  case "sleep":
    setInterval(() => {}, 60_000);
    break;
  default:
    process.stderr.write(`fake tracker: unknown action ${action}\n`);
    process.exit(2);
}
