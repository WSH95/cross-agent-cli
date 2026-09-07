#!/usr/bin/env node
// A stand-in for a headless engine CLI. Records its invocation and stdin.
//   FAKE_ENGINE_SCRIPT: ok (default) | fail | stall | stall-ignore-term
//   FAKE_ENGINE_FORMAT: generic (default) | claude | codex | grok
//   FAKE_ENGINE_RECORD: path of a JSON file to write {argv, cwd, env, stdin}
import { writeFileSync } from "node:fs";

const script = process.env.FAKE_ENGINE_SCRIPT ?? "ok";
// Readiness output must mean that the resistant mode is already ignoring SIGTERM.
if (script === "stall-ignore-term") process.on("SIGTERM", () => {});
const format = process.env.FAKE_ENGINE_FORMAT ?? "generic";
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
if (process.env.FAKE_ENGINE_RECORD) {
  writeFileSync(
    process.env.FAKE_ENGINE_RECORD,
    JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, stdin }),
  );
}
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sessionId = `fake-${process.pid}`;
switch (format) {
  case "generic":
    emit({ type: "session", session_id: sessionId });
    emit({ type: "event", text: "working" });
    break;
  case "claude":
    emit({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, tools: [], mcp_servers: [] });
    emit({ type: "assistant", session_id: sessionId, message: {
      type: "message", role: "assistant", content: [{ type: "text", text: "working" }],
    } });
    break;
  case "codex":
    emit({ type: "thread.started", thread_id: sessionId });
    emit({ type: "turn.started" });
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "working" } });
    break;
  case "grok":
    // Grok's json mode emits nothing until the final whole-output object.
    break;
  default:
    throw new Error(`Unknown FAKE_ENGINE_FORMAT: ${format}`);
}
if (script === "stall" || script === "stall-ignore-term") {
  if (script === "stall") process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1 << 30);
} else {
  const failed = script === "fail";
  const text = failed ? "fake failure" : `DONE ${process.argv.slice(2).join(" ")}`;
  switch (format) {
    case "generic":
      emit({ type: failed ? "error" : "result", text });
      break;
    case "claude":
      emit({ type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed,
        session_id: sessionId, result: text });
      break;
    case "codex":
      if (failed) {
        emit({ type: "turn.failed", error: { message: text } });
      } else {
        emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
        emit({ type: "turn.completed" });
      }
      break;
    case "grok":
      process.stdout.write(JSON.stringify({ text, stopReason: failed ? "error" : "end_turn", sessionId }, null, 2) + "\n");
      break;
  }
  // Let stdout drain before exiting, including when it is a pipe.
  process.exitCode = failed ? 2 : 0;
}
