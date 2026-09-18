import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Authority } from "../src/authority.ts";
import { createServer, projectTools } from "../src/server.ts";
import type { ServerOptions, ToolContext } from "../src/server.ts";

type Json = Record<string, unknown>;

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "src", "server.ts");

async function projectWithConfig(config: Json): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cross-agent-"));
  await mkdir(path.join(dir, ".cross-agent"), { recursive: true });
  await writeFile(path.join(dir, ".cross-agent", "config.json"), JSON.stringify(config));
  return dir;
}

// Nothing of the suite's own CROSS_AGENT_* environment reaches a server under test: the
// suite may itself be running inside a task.
const suiteEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CROSS_AGENT_")));

function stdioClient(cwd: string, options: { args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(process.execPath, [serverEntry, ...(options.args ?? [])], {
    cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...suiteEnv, ...options.env },
  });
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

const operator: Authority = { row: "operator", reason: "test", depth: 0 };

/** A server in this process, answering one request at a time through `handle`. */
function inProcess(options: ServerOptions) {
  const server = createServer(options);
  let id = 0;
  return (method: string, params: Json = {}) => server.handle({ jsonrpc: "2.0", id: ++id, method, params }) as Promise<Json>;
}

async function waitFor(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("initialize identifies the cross-agent server over stdio", async () => {
  const client = stdioClient(await projectWithConfig({ roles: {} }));
  try {
    const reply = await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const result = reply.result as Json;
    assert.equal((result.serverInfo as Json).name, "cross-agent");
    assert.equal(typeof result.protocolVersion, "string");
    assert.ok((result.capabilities as Json).tools, "advertises tools");
  } finally {
    client.close();
  }
});

test("tools/list offers each row of the permission matrix exactly its tools", async (t) => {
  const root = await projectWithConfig({ roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [row, expected] of [
    ["operator", ["list_roles", "verify_worktree"]], ["lead", ["list_roles", "verify_worktree"]], ["specialist", ["list_roles"]],
  ] as const) {
    const request = inProcess({ tools: projectTools(root), authority: () => ({ row, reason: "test", depth: 0 }) });
    const tools = ((await request("tools/list")).result as Json).tools as Json[];
    assert.deepEqual(tools.map((tool) => tool.name), expected, row);
    const verify = tools.find((tool) => tool.name === "verify_worktree");
    if (verify) {
      assert.deepEqual(verify.inputSchema, {
        type: "object", properties: { path: { type: "string" }, branch: { type: "string" } }, required: ["path", "branch"],
      });
    }
  }
});

test("a call to a tool outside the resolved row is refused by name with the reason, and never runs", async (t) => {
  const root = await projectWithConfig({ roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  const reason = "specialist by ancestry: task T (implementer, running)";
  const specialist = () => ({ row: "specialist" as const, reason, taskId: "T", depth: 1 });
  const refused = await inProcess({ tools: projectTools(root), authority: specialist })(
    "tools/call", { name: "verify_worktree", arguments: { path: root, branch: "main" } });
  assert.deepEqual(refused.error, { code: -32602, message: `verify_worktree is not available to a specialist server: ${reason}` });

  let ran = false;
  const request = inProcess({
    tools: [{
      name: "guarded", description: "operator only", inputSchema: { type: "object", properties: {} }, rows: ["operator"],
      handler: () => { ran = true; return { content: [{ type: "text", text: "ran" }] }; },
    }],
    authority: specialist,
  });
  assert.deepEqual((await request("tools/call", { name: "guarded", arguments: {} })).error,
    { code: -32602, message: `guarded is not available to a specialist server: ${reason}` });
  assert.equal(ran, false);
  // A name no row has is still unknown, not refused.
  assert.deepEqual((await request("tools/call", { name: "delegate", arguments: {} })).error, { code: -32602, message: "unknown tool: delegate" });
});

test("the row is resolved again on every request", async () => {
  let authority: Authority = operator;
  const request = inProcess({
    tools: [{
      name: "guarded", description: "operator and lead", inputSchema: { type: "object", properties: {} }, rows: ["operator", "lead"],
      handler: () => ({ content: [{ type: "text", text: "ran" }] }),
    }],
    authority: async () => authority,
  });
  const names = async () => (((await request("tools/list")).result as Json).tools as Json[]).map((tool) => tool.name);
  const call = () => request("tools/call", { name: "guarded", arguments: {} });

  assert.deepEqual(await names(), ["guarded"]);
  authority = { row: "specialist", reason: "specialist: CROSS_AGENT_TASK present and no record matches", depth: 1 };
  assert.deepEqual(await names(), []);
  assert.deepEqual((await call()).error,
    { code: -32602, message: "guarded is not available to a specialist server: specialist: CROSS_AGENT_TASK present and no record matches" });
  authority = { row: "lead", reason: "lead by ancestry: task L (lead, running)", taskId: "L", depth: 1 };
  assert.deepEqual(((await call()).result as Json).content, [{ type: "text", text: "ran" }]);
});

test("a handler receives the authority resolved for its call and a signal of its own", async () => {
  const contexts: ToolContext[] = [];
  const resolved: Authority[] = [];
  const request = inProcess({
    tools: [{
      name: "probe", description: "records its context", inputSchema: { type: "object", properties: {} }, rows: ["lead"],
      handler: (_args, context) => { contexts.push(context); return { content: [{ type: "text", text: "ok" }] }; },
    }],
    authority: () => {
      const authority: Authority = { row: "lead", reason: `lead by ancestry: task L${resolved.length} (lead, running)`, taskId: "L", depth: 1 };
      resolved.push(authority);
      return authority;
    },
  });
  await request("tools/call", { name: "probe", arguments: {} });
  await request("tools/call", { name: "probe", arguments: {} });
  assert.equal(contexts.length, 2);
  for (const [index, context] of contexts.entries()) {
    assert.equal(context.authority, resolved[index]);
    assert.ok(context.signal instanceof AbortSignal);
    assert.equal(context.signal.aborted, false);
  }
  assert.notEqual(contexts[0].signal, contexts[1].signal);
});

test("list_roles returns the roles from .cross-agent/config.json", async () => {
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

test("verify_worktree returns success and refusal JSON as text", async (t) => {
  const root = await projectWithConfig({ roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  const exec = promisify(execFile);
  await exec("git", ["-C", root, "init", "-b", "main"]);
  await exec("git", ["-C", root, "-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "initial"]);
  const candidate = path.join(root, ".worktrees", "stdio");
  await exec("git", ["-C", root, "worktree", "add", "-b", "task/stdio", candidate]);
  const request = inProcess({ tools: projectTools(root), authority: () => operator });
  for (const branch of ["task/stdio", "task/other"]) {
    const reply = await request("tools/call", { name: "verify_worktree", arguments: { path: candidate, branch } });
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
});

test("verify_worktree checks required string arguments at runtime", async (t) => {
  const root = await projectWithConfig({ roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = inProcess({ tools: projectTools(root), authority: () => operator });
  for (const args of [{}, { path: 1, branch: "task/t" }, { path: root }, { path: root, branch: false }, [], "invalid"]) {
    const reply = await request("tools/call", { name: "verify_worktree", arguments: args });
    assert.equal((reply.error as Json).code, -32602);
    assert.match((reply.error as Json).message as string, /path|branch/);
  }
});

test("--project and CROSS_AGENT_PROJECT choose the project over stdio", async (t) => {
  const roles = { planner: { engine: "codex", cwd: "root", sandbox: "read-only" } };
  const root = await projectWithConfig({ roles });
  const elsewhere = await mkdtemp(path.join(tmpdir(), "cross-agent-elsewhere-"));
  t.after(() => Promise.all([root, elsewhere].map((dir) => rm(dir, { recursive: true, force: true }))));
  for (const options of [{ args: ["--project", root] }, { env: { CROSS_AGENT_PROJECT: root } }]) {
    const client = stdioClient(elsewhere, options);
    try {
      const reply = await client.request("tools/call", { name: "list_roles", arguments: {} });
      const content = (reply.result as Json).content as Json[];
      assert.deepEqual(JSON.parse(content[0].text as string), { roles }, JSON.stringify(options));
    } finally {
      client.close();
    }
  }
});

test("a server that finds no project exits naming the reason", async (t) => {
  const empty = await realpath(await mkdtemp(path.join(tmpdir(), "cross-agent-empty-")));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const child = spawn(process.execPath, [serverEntry], { cwd: empty, stdio: ["ignore", "ignore", "pipe"], env: suiteEnv });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.equal(stderr, `cross-agent: no .cross-agent/config.json in ${empty} or any directory above it\n`);
});

test("the entry point resolves its own row: a server carrying a task no record matches is a specialist", async (t) => {
  const root = await projectWithConfig({ roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = stdioClient(root, { env: { CROSS_AGENT_TASK: "no-such-task" } });
  try {
    const tools = ((await client.request("tools/list")).result as Json).tools as Json[];
    assert.deepEqual(tools.map((tool) => tool.name), ["list_roles"]);
    const refused = await client.request("tools/call", { name: "verify_worktree", arguments: { path: root, branch: "main" } });
    assert.deepEqual(refused.error, {
      code: -32602,
      message: "verify_worktree is not available to a specialist server: specialist: CROSS_AGENT_TASK present and no record matches",
    });
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
      rows: ["operator"],
      handler: async () => {
        await gate;
        return { content: [{ type: "text", text: "slow done" }] };
      },
    }],
    authority: () => operator,
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
