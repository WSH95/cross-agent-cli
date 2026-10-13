// Loaded with `NODE_OPTIONS=--import=<this file's URL>` into every Node process of a run, so
// that all a process writes to its stdout is lost, as it is for a Node child with a piped
// stdout under Codex's workspace-write sandbox: what tests/preflight.mjs detects.
process.stdout.write = () => true;
