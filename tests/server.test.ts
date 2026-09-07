import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.ts";

type Json = Record<string, unknown>;

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "src", "server.ts");

async function projectWithConfig(config: Json): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dev-team-"));
  await mkdir(path.join(dir, ".dev-team"), { recursive: true });
  await writeFile(path.join(dir, ".dev-team", "config.json"), JSON.stringify(config));
  return dir;
}

function stdioClient(cwd: string) {
  const child = spawn(process.execPath, [serverEntry], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (msg: Json) => void>();
  let buffer = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) {
        const msg = JSON.parse(line) as Json;
        const resolve = pending.get(msg.id as number);
        if (resolve) {
          pending.delete(msg.id as number);
          resolve(msg);
        }
      }
      nl = buffer.indexOf("\n");
    }
  });
  let nextId = 1;
  return {
    request(method: string, params: Json = {}): Promise<Json> {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    close() {
      child.stdin!.end();
      child.kill();
    },
  };
}

async function waitFor(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("initialize identifies the dev-team server over stdio", async () => {
  const client = stdioClient(await projectWithConfig({ roles: {} }));
  try {
    const reply = await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const result = reply.result as Json;
    assert.equal((result.serverInfo as Json).name, "dev-team");
    assert.equal(typeof result.protocolVersion, "string");
    assert.ok((result.capabilities as Json).tools, "advertises tools");
  } finally {
    client.close();
  }
});

test("tools/list offers list_roles", async () => {
  const client = stdioClient(await projectWithConfig({ roles: {} }));
  try {
    await client.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const reply = await client.request("tools/list");
    const names = ((reply.result as Json).tools as Json[]).map((t) => t.name);
    assert.ok(names.includes("list_roles"), `tools were ${names.join(", ")}`);
  } finally {
    client.close();
  }
});

test("list_roles returns the roles from .dev-team/config.json", async () => {
  const roles = {
    planner: { engine: "codex", model: "gpt-6-astra", cwd: "root", sandbox: "read-only" },
    implementer: { engine: "claude", model: "claude-opus-5", cwd: "worktree", sandbox: "workspace-write" },
  };
  const client = stdioClient(await projectWithConfig({ roles }));
  try {
    await client.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const reply = await client.request("tools/call", { name: "list_roles", arguments: {} });
    const content = (reply.result as Json).content as Json[];
    assert.equal(content[0].type, "text");
    const parsed = JSON.parse(content[0].text as string) as { roles: typeof roles };
    assert.deepEqual(parsed.roles, roles);
  } finally {
    client.close();
  }
});

test("unknown methods get a JSON-RPC method-not-found error", async () => {
  const client = stdioClient(await projectWithConfig({ roles: {} }));
  try {
    const reply = await client.request("no/such/method");
    assert.equal((reply.error as Json).code, -32601);
  } finally {
    client.close();
  }
});

test("ping is answered while a slow tool call is pending", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = createServer({
    tools: [{
      name: "slow",
      description: "blocks until released",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        await gate;
        return { content: [{ type: "text", text: "slow done" }] };
      },
    }],
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Json[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line.trim()) replies.push(JSON.parse(line) as Json);
  });
  server.connect(input, output);
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", arguments: {} } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
  await waitFor(() => replies.some((m) => m.id === 2));
  assert.equal(replies.some((m) => m.id === 1), false, "the slow call must still be pending");
  release();
  await waitFor(() => replies.some((m) => m.id === 1));
  const slow = replies.find((m) => m.id === 1) as Json;
  assert.equal(((slow.result as Json).content as Json[])[0].text, "slow done");
});
