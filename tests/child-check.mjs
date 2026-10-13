// Each test file's first import (atc-s96.131). `node --test` runs each test file in a Node
// child and reads its results over a piped stdout. Where that pipe is a socket Node could not
// type, as under Codex's workspace-write sandbox, the child's process.stdout discards all it
// is given, so the runner sees no result and the file stalls or passes untested. This stops
// such a child before its tests, with the cause and what still runs, written straight to fd 2,
// which reaches the user there. It costs no spawn, and it does nothing in any other process:
// one that is no runner's child, one whose stdout is no socket, one whose stdout Node typed.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { lostOutputCause, whatStillRuns } from "./lost-output.mjs";

// Whether fd is a socket; false where it cannot be read.
function socket(fd) {
  try {
    return fs.fstatSync(fd).isSocket();
  } catch {
    return false;
  }
}

// Whether this process is a node --test child whose results are lost: the runner sets
// NODE_TEST_CONTEXT in each file's child and an in-process run leaves it unset, the runner
// pipes the child's stdout over a socket, and Node builds a net.Socket on that socket unless
// it could not type it, when what it builds discards all it is given.
function lostResults() {
  return process.env.NODE_TEST_CONTEXT !== undefined && socket(1) && !(process.stdout instanceof net.Socket);
}

if (lostResults()) {
  const file = process.argv[1] === undefined ? "This test file" : path.relative(process.cwd(), process.argv[1]);
  fs.writeSync(2, [
    `${file} was stopped before its tests: its results reach node --test over a piped stdout whose type Node could not identify here.`,
    lostOutputCause,
    `Run the suite through npm test, whose preflight stops it here once with this cause. ${whatStillRuns}`,
  ].join("\n") + "\n");
  process.exit(1);
}
