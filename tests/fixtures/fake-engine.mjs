#!/usr/bin/env node
// A stand-in for a headless engine CLI. Prints JSONL like the real ones and
// records how it was called, so adapter tests can assert argv, cwd, and env.
//   FAKE_ENGINE_SCRIPT: ok (default) | fail | stall
//   FAKE_ENGINE_RECORD: path of a JSON file to write {argv, cwd, env}
import { writeFileSync } from "node:fs";

const script = process.env.FAKE_ENGINE_SCRIPT ?? "ok";
if (process.env.FAKE_ENGINE_RECORD) {
  writeFileSync(
    process.env.FAKE_ENGINE_RECORD,
    JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }),
  );
}
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
emit({ type: "session", session_id: `fake-${process.pid}` });
emit({ type: "event", text: "working" });
if (script === "fail") {
  emit({ type: "error", text: "fake failure" });
  process.exit(2);
}
if (script === "stall") {
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1 << 30);
} else {
  emit({ type: "result", text: `DONE ${process.argv.slice(2).join(" ")}` });
  process.exit(0);
}
