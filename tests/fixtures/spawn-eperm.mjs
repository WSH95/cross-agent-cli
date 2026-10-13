// Loaded with `NODE_OPTIONS=--import=<this file's URL>` into tests/preflight.mjs, so that its
// probe's spawnSync fails as it does under Codex's workspace-write sandbox: with EPERM and no
// child started. What it returns is Node's own result when no child starts, as Node 24 gives
// it: `error`, a null `status`, `signal` and `output`, a `pid` of 0, and no `stdout` or
// `stderr` at all. The preflight imports spawnSync by name, which it sees replaced only once
// the builtin's ESM exports are synced.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

childProcess.spawnSync = () => ({
  error: Object.assign(new Error("spawnSync EPERM"), { code: "EPERM" }),
  status: null, signal: null, output: null, pid: 0, stdout: undefined, stderr: undefined,
});
syncBuiltinESMExports();
