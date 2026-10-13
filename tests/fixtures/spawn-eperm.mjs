// Loaded with `NODE_OPTIONS=--import=<this file's URL>` into tests/preflight.mjs, so that its
// probe's spawnSync fails as it does under Codex's workspace-write sandbox: with EPERM, no
// child started and no output. The preflight imports spawnSync by name, which it sees replaced
// only once the builtin's ESM exports are synced.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

childProcess.spawnSync = () => ({
  status: null, stdout: "", stderr: "",
  error: Object.assign(new Error("spawnSync EPERM"), { code: "EPERM" }),
});
syncBuiltinESMExports();
