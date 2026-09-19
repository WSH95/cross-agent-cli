// Starts this repository's MCP server as its own child — the way an engine given a lead
// mount does — and makes one `tools/call` on it, so a test can place the pair anywhere in
// a chain of processes and read what the server answered a caller whose authority its own
// ancestry decides. Waits for `<answer>.go` first, so the test can write the record the
// walk has to match before the server resolves anything.
//   node mcp-call.mjs <answerFile> <projectRoot> <tool> <argumentsJson>
// Writes {tools, reply} to <answerFile>, then stays alive so nothing it started is
// orphaned; the chain's own cleanup ends it.
import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [answer, projectRoot, tool, argumentsJson] = process.argv.slice(2);
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "server.ts");
while (!existsSync(`${answer}.go`)) await delay(10);

const child = spawn(process.execPath, [server, "--project", projectRoot], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

let buffer = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

let id = 0;
function call(method, params) {
  return new Promise((resolve) => {
    const request = { jsonrpc: "2.0", id: ++id, method, params };
    pending.set(request.id, resolve);
    child.stdin.write(JSON.stringify(request) + "\n");
  });
}

const result = {};
try {
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-call", version: "1" } });
  const listed = await call("tools/list", {});
  result.tools = (listed.result?.tools ?? []).map((entry) => entry.name);
  result.reply = await call("tools/call", { name: tool, arguments: JSON.parse(argumentsJson) });
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error);
}
result.stderr = stderr;
writeFileSync(`${answer}.tmp`, JSON.stringify(result));
renameSync(`${answer}.tmp`, answer);
await new Promise(() => {});
