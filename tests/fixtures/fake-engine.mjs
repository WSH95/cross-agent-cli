#!/usr/bin/env node
// A stand-in for a headless engine CLI. Records its invocation and stdin.
//   FAKE_ENGINE_SCRIPT: ok (default) | fail | stall | stall-ignore-term
//   FAKE_ENGINE_FORMAT: generic (default) | claude | codex | grok | grok-json
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
    // `--output-format streaming-messages-json`, the format P8 adopted: NDJSON in the
    // Anthropic Messages API wire shape, so these are the `claude` case's lines. The
    // session id is on the first one, on a resumed turn as well as a fresh one.
    emit({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: "oauth",
      model: "grok-4.6", cwd: process.cwd(), permissionMode: "bypassPermissions",
      tools: ["run_terminal_command", "read_file"] });
    emit({ type: "assistant", session_id: sessionId, message: {
      type: "message", role: "assistant", content: [{ type: "text", text: "working" }],
    } });
    break;
  case "grok-json":
    // Grok's `json` mode, which emits nothing until the final whole-output object: the
    // fallback for an adapter that declares `finish`.
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
      // Success and failure close down one path. A failed turn's message is in `errors`
      // and it carries no `result` field at all (P8).
      emit(failed
        ? { type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 0,
          num_turns: 0, stop_reason: null, errors: [text], session_id: sessionId }
        : { type: "result", subtype: "success", is_error: false, duration_ms: 1, num_turns: 2,
          result: text, session_id: sessionId });
      break;
    case "grok-json":
      process.stdout.write(JSON.stringify({ text, stopReason: failed ? "error" : "end_turn", sessionId }, null, 2) + "\n");
      break;
  }
  // Let stdout drain before exiting, including when it is a pipe. A failed Grok turn
  // exits 1 (P8); the other formats keep this fixture's own 2.
  process.exitCode = failed ? (format.startsWith("grok") ? 1 : 2) : 0;
}
