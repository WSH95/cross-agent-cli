// Loaded with `NODE_OPTIONS=--import=<this file's URL>` into every Node process of a run, so
// that its process.stdout is the stream Node builds for a stdout handle it cannot type: a
// Writable that discards all it is given, and no net.Socket. That is what a Node child with a
// piped stdout gets under Codex's workspace-write sandbox, whose filter denies the getsockopt
// Node types the handle with; fd 1 stays whatever it was, as it does there. What
// tests/child-check.mjs detects.
import { Writable } from "node:stream";

Object.defineProperty(process, "stdout", {
  configurable: true, enumerable: true,
  value: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
});
