// Starts this repository's MCP server as its own child — the way an engine given a lead
// mount does — and makes one `tools/call` on it, so a test can place the pair anywhere in
// a chain of processes and read what the server answered a caller whose authority its own
// ancestry decides. Waits for `<answer>.go` first, so the test can write the record the
// walk has to match before the server resolves anything.
//   node mcp-call.mjs <answerFile> <projectRoot> <tool> <argumentsJson> [<environment>]
// With <tool> `--calls`, <argumentsJson> is a list of [tool, arguments] pairs, called in
// order, and the answers are `replies` rather than `reply`.
// <environment> is what the server is started with, as an engine's MCP host would start it:
//   everything (the default) — this process's whole environment, as a host that copies its own;
//   markers — PATH, HOME and the four CROSS_AGENT_* markers alone, as a host that whitelists them;
//   none — PATH and HOME and no marker at all, as a host that builds a fresh environment.
// Writes {tools, reply | replies} to <answerFile>, then stays alive so nothing it started is
// orphaned; the chain's own cleanup ends it.
import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [answer, projectRoot, tool, argumentsJson, environment = "everything"] = process.argv.slice(2);
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "server.ts");
while (!existsSync(`${answer}.go`)) await delay(10);

const markers = ["CROSS_AGENT_DEPTH", "CROSS_AGENT_TASK", "CROSS_AGENT_LINEAGE", "CROSS_AGENT_PROJECT"];
const kept = { everything: null, markers: ["PATH", "HOME", ...markers], none: ["PATH", "HOME"] }[environment];
if (kept === undefined) throw new Error(`mcp-call: no environment ${JSON.stringify(environment)}`);
const env = kept === null ? process.env : Object.fromEntries(Object.entries(process.env).filter(([name]) => kept.includes(name)));

const child = spawn(process.execPath, [server, "--project", projectRoot], { stdio: ["pipe", "pipe", "pipe"], env });
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

const result = { environment, serverEnvironment: Object.keys(env).sort() };
try {
  // `initialize` resolves no row — the dispatcher only resolves for `tools/list` and
  // `tools/call` — so its reply is proof the server is up without being a request that
  // could have made it resolve. The test changes the ledger between this and `.call`, and
  // `stderrBeforeRequest` is what the server had said by then.
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-call", version: "1" } });
  writeFileSync(`${answer}.ready`, "");
  while (!existsSync(`${answer}.call`)) await delay(10);
  result.stderrBeforeRequest = stderr;
  const listed = await call("tools/list", {});
  result.tools = (listed.result?.tools ?? []).map((entry) => entry.name);
  if (tool === "--calls") {
    result.replies = [];
    for (const [name, args] of JSON.parse(argumentsJson)) result.replies.push(await call("tools/call", { name, arguments: args }));
  } else {
    result.reply = await call("tools/call", { name: tool, arguments: JSON.parse(argumentsJson) });
  }
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error);
}
result.stderr = stderr;
writeFileSync(`${answer}.tmp`, JSON.stringify(result));
renameSync(`${answer}.tmp`, answer);
await new Promise(() => {});
