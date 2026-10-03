#!/usr/bin/env node
// One worktree setup through `run_command`'s own function, in a process a test can kill
// while the setup runs: a server that dies under a setup it started.
//   node run-setup.mjs <projectRoot> <worktree> <slug> [die-before-marker|null-identity]
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { identityOf } from "../../src/process.ts";
import { setupMarkerPath } from "../../src/review.ts";
import { runCommand } from "../../src/runcommand.ts";

const [root, where, slug, fault] = process.argv.slice(2);
const trace = path.join(root, "setup-spawned.json");
if (fault === "die-before-marker") {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === setupMarkerPath(root, where)) {
      // The atomic write is complete, but unpublished. Only the fixture's fs is patched.
      fs.writeFileSync(trace, fs.readFileSync(from));
      process.kill(process.pid, "SIGKILL");
    }
    return rename(from, to);
  };
} else if (fault === "null-identity") {
  const spawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = spawn(...args);
    if (args[0] === "sh" && args[2]?.detached && args[2]?.cwd === where && child.pid) {
      fs.writeFileSync(trace, JSON.stringify({ ...identityOf(child.pid), pgid: child.pid }));
      const read = fs.readFileSync;
      fs.readFileSync = (file, ...options) => {
        if (file === `/proc/${child.pid}/stat`) {
          fs.readFileSync = read;
          throw Object.assign(new Error("fixture: setup identity unreadable"), { code: "ENOENT" });
        }
        return read(file, ...options);
      };
    }
    return child;
  };
  syncBuiltinESMExports();
}
const result = await runCommand(root, { which: "setup", where, slug });
if (fault) fs.writeFileSync(path.join(root, "setup-result.json"), JSON.stringify(result));
process.stdout.write(`${JSON.stringify(result)}\n`);
