import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

test("tools/list offers list_roles and verify_worktree", async (t) => {
  const root = await projectWithConfig({ roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = stdioClient(root);
  try {
    await client.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const reply = await client.request("tools/list");
    const tools = (reply.result as Json).tools as Json[];
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("list_roles"), `tools were ${names.join(", ")}`);
    assert.ok(names.includes("verify_worktree"), `tools were ${names.join(", ")}`);
    const schema = tools.find((tool) => tool.name === "verify_worktree")!.inputSchema as Json;
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["path", "branch"]);
    assert.deepEqual(schema.properties, { path: { type: "string" }, branch: { type: "string" } });
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

test("list_roles applies role defaults over stdio", async (t) => {
  const root = await projectWithConfig({ roles: { planner: { engine: "codex" }, helper: { engine: "grok", sandbox: "off" } } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = stdioClient(root);
  try {
    const reply = await client.request("tools/call", { name: "list_roles", arguments: {} });
    const content = (reply.result as Json).content as Json[];
    assert.equal(content[0].type, "text");
    assert.deepEqual(JSON.parse(content[0].text as string), { roles: {
      planner: { engine: "codex", cwd: "root", sandbox: "read-only" },
      helper: { engine: "grok", cwd: "root", sandbox: "off" },
    } });
  } finally {
    client.close();
  }
});

test("verify_worktree returns success and refusal JSON as text over stdio", async (t) => {
  const root = await projectWithConfig({ roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  const exec = promisify(execFile);
  await exec("git", ["-C", root, "init", "-b", "main"]);
  await exec("git", ["-C", root, "-c", "user.name=Dev Team Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "initial"]);
  const candidate = path.join(root, ".worktrees", "stdio");
  await exec("git", ["-C", root, "worktree", "add", "-b", "task/stdio", candidate]);
  const client = stdioClient(root);
  try {
    for (const branch of ["task/stdio", "task/other"]) {
      const reply = await client.request("tools/call", { name: "verify_worktree", arguments: { path: candidate, branch } });
      const result = reply.result as Json;
      const content = result.content as Json[];
      assert.equal(content[0].type, "text");
      assert.notEqual(result.isError, true);
      const parsed = JSON.parse(content[0].text as string) as Json;
      if (branch === "task/stdio") {
        assert.deepEqual(parsed, {
          gitDir: await realpath(path.join(root, ".git", "worktrees", "stdio")),
          workTree: await realpath(candidate), branch,
        });
      } else {
        assert.deepEqual(Object.keys(parsed), ["reason"]);
        assert.equal(typeof parsed.reason, "string");
        assert.ok((parsed.reason as string).length > 0);
      }
    }
  } finally {
    client.close();
  }
});

test("verify_worktree checks required string arguments at runtime", async (t) => {
  const root = await projectWithConfig({ roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = stdioClient(root);
  try {
    for (const args of [{}, { path: 1, branch: "task/t" }, { path: root }, { path: root, branch: false }, [], "invalid"]) {
      const reply = await client.request("tools/call", { name: "verify_worktree", arguments: args });
      assert.equal((reply.error as Json).code, -32602);
      assert.match((reply.error as Json).message as string, /path|branch/);
    }
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
