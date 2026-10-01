import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Authority } from "../src/authority.ts";
import { create } from "../src/ledger.ts";
import { builtInModesDir, loadMode } from "../src/modes.ts";
import type { Mode } from "../src/modes.ts";
import { createServer, projectTools } from "../src/server.ts";
import type { ServerOptions, ToolContext } from "../src/server.ts";
import { buildMode, modesRoot } from "./helpers/mode.ts";
import type { RoleSpec } from "./helpers/mode.ts";

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
const rootWorkspace = { kind: "root" };
const worktreeWorkspace = { kind: "worktree", branchPattern: "task/*", dir: ".worktrees" };
/**
 * Every role of the built-in `dev-team` mode as `list_roles` shows one nothing binds:
 * the mode decides the workspace and the profile, and `binding: null` is the engine a
 * `delegate` call would have to name itself. A test that binds a role overrides its entry.
 */
const unbound = {
  planner: { binding: null, workspace: rootWorkspace, sandbox: "read-only" },
  "plan-reviewer": { binding: null, workspace: rootWorkspace, sandbox: "read-only" },
  implementer: { binding: null, workspace: worktreeWorkspace, sandbox: "workspace-write" },
  "code-reviewer": { binding: null, workspace: worktreeWorkspace, sandbox: "read-only" },
  consult: { binding: null, workspace: rootWorkspace, sandbox: "read-only" },
};
// The mode a server loads once at start and hands its tools. These servers bind the
// built-in `dev-team` roles, which is what a config with no `mode` key names.
const devTeam: Mode = loadMode(builtInModesDir(), "dev-team");

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

// @anchor toolsListOffers
test("tools/list offers each row of the permission matrix exactly its tools", async (t) => {
  const root = await projectWithConfig({ roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  const delegation = ["delegate", "wait", "check", "result", "cancel", "list_tasks"];
  const provider = ["verify_worktree", "git_mutate", "git_root", "run_command"];
  for (const [row, expected] of [
    ["operator", ["describe_mode", "list_roles", ...delegation, ...provider]],
    ["lead", ["describe_mode", "list_roles", ...delegation, ...provider]],
    // The specialist row is the four read tools plus describe_mode, and nothing that
    // starts or stops a task.
    ["specialist", ["describe_mode", "list_roles", "check", "result", "list_tasks"]],
  ] as const) {
    const request = inProcess({ tools: projectTools(root, { mode: devTeam }), authority: () => ({ row, reason: "test", depth: 0 }) });
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

// @anchor callToolOutside
test("a call to a tool outside the resolved row is refused by name with the reason, and never runs", async (t) => {
  const root = await projectWithConfig({ roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  const reason = "specialist by ancestry: task T (implementer, running)";
  const specialist = () => ({ row: "specialist" as const, reason, taskId: "T", depth: 1 });
  const refused = await inProcess({ tools: projectTools(root, { mode: devTeam }), authority: specialist })(
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

// @anchor rowResolvedAgain
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
    planner: { engine: "codex", model: "gpt-6-astra" },
    implementer: { engine: "claude", model: "claude-opus-5" },
  };
  const client = stdioClient(await projectWithConfig({ roles }));
  try {
    await client.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const reply = await client.request("tools/call", { name: "list_roles", arguments: {} });
    const content = (reply.result as Json).content as Json[];
    assert.equal(content[0].type, "text");
    // The bindings are config's; the workspace and the profile come from the built-in
    // `dev-team` mode the server loaded at start.
    assert.deepEqual(JSON.parse(content[0].text as string), { roles: {
      ...unbound,
      planner: { ...roles.planner, workspace: rootWorkspace, sandbox: "read-only" },
      implementer: { ...roles.implementer, workspace: worktreeWorkspace, sandbox: "workspace-write" },
    } });
  } finally {
    client.close();
  }
});

test("list_roles applies the mode's defaults and a role's own override over stdio", async (t) => {
  const root = await projectWithConfig({ roles: { planner: { engine: "codex" }, "code-reviewer": { engine: "grok", sandbox: "strict" } } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = stdioClient(root);
  try {
    const reply = await client.request("tools/call", { name: "list_roles", arguments: {} });
    const content = (reply.result as Json).content as Json[];
    assert.equal(content[0].type, "text");
    assert.deepEqual(JSON.parse(content[0].text as string), { roles: {
      ...unbound,
      planner: { engine: "codex", workspace: rootWorkspace, sandbox: "read-only" },
      // Grok's own read-only profile, overriding the mode's portable name for one.
      "code-reviewer": { engine: "grok", workspace: worktreeWorkspace, sandbox: "strict" },
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
  const request = inProcess({ tools: projectTools(root, { mode: devTeam }), authority: () => operator });
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
        // The lead sees the common directory too: it is what a host that writes its own
        // sandbox rules would have to protect, and `delegate` puts it in every writable
        // spec's `protectedPaths`.
        commonDir: await realpath(path.join(root, ".git")),
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
  const request = inProcess({ tools: projectTools(root, { mode: devTeam }), authority: () => operator });
  for (const args of [{}, { path: 1, branch: "task/t" }, { path: root }, { path: root, branch: false }, [], "invalid"]) {
    const reply = await request("tools/call", { name: "verify_worktree", arguments: args });
    assert.equal((reply.error as Json).code, -32602);
    assert.match((reply.error as Json).message as string, /path|branch/);
  }
});

test("--project and CROSS_AGENT_PROJECT choose the project over stdio", async (t) => {
  const roles = { planner: { engine: "codex" } };
  const root = await projectWithConfig({ roles });
  const elsewhere = await mkdtemp(path.join(tmpdir(), "cross-agent-elsewhere-"));
  t.after(() => Promise.all([root, elsewhere].map((dir) => rm(dir, { recursive: true, force: true }))));
  for (const options of [{ args: ["--project", root] }, { env: { CROSS_AGENT_PROJECT: root } }]) {
    const client = stdioClient(elsewhere, options);
    try {
      const reply = await client.request("tools/call", { name: "list_roles", arguments: {} });
      const content = (reply.result as Json).content as Json[];
      assert.deepEqual(JSON.parse(content[0].text as string), {
        roles: { ...unbound, planner: { engine: "codex", workspace: rootWorkspace, sandbox: "read-only" } },
      }, JSON.stringify(options));
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
  // Under no config the project would be the working directory's git toplevel, and a
  // directory in no repository has none (design, "Modes").
  assert.equal(stderr, `cross-agent: no .cross-agent/config.json in ${empty} or any directory above it, `
    + `and ${empty} is in no git repository: without a config the project is the working directory's git toplevel\n`);
});

// A bounded test, because what it asserts is that the process **ends**: a server that
// served instead would leave this waiting on a close that never comes.
test("a server attached to a repository with no config writes nothing to it", async (t) => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), "cross-agent-bare-")));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await promisify(execFile)("git", ["-C", repo, "init", "-b", "main"]);
  const before = (await readdir(repo)).sort();
  const exclude = path.join(repo, ".git", "info", "exclude");
  const excluded = async () => readFile(exclude, "utf8").catch(() => "");
  const wasExcluded = await excluded();

  const client = stdioClient(repo);
  try {
    // The project is the git toplevel, running solo on the defaults, and it says which
    // git policy a `worktree: true` one-shot here would use (design, "Modes").
    const reply = (await client.request("tools/call", { name: "describe_mode", arguments: {} })).result as Json;
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    const described = JSON.parse((reply.content as Json[])[0].text as string) as Json;
    assert.equal((described.mode as Json).id, "solo");
    assert.deepEqual(described.git, { worktreeDir: ".worktrees", branchPattern: "task/*", implicit: true });
    assert.deepEqual((described.roles as Json[]).map((role) => role.key), ["consult"]);

    // The one role this project has, listed with the binding it does not have.
    const roles = JSON.parse(((((await client.request("tools/call", { name: "list_roles", arguments: {} })).result as Json).content as Json[])[0].text as string)) as Json;
    assert.deepEqual(roles.roles, { consult: { binding: null, workspace: { kind: "root" }, sandbox: "read-only" } });
    // Every row this server can resolve holds those two; which row this suite's own
    // process depth earns is `resolveAuthority`'s own test, and the registry a project
    // with no config gets is asserted below, where the row is this test's to choose.
    const listed = (((await client.request("tools/list")).result as Json).tools as Json[]).map((tool) => tool.name);
    for (const name of ["describe_mode", "list_roles", "check", "result", "list_tasks"]) {
      assert.ok(listed.includes(name), `${name} is served`);
    }
  } finally {
    client.close();
  }

  // And attaching it wrote nothing: `cross-agent init` writes the config, and the first
  // `delegate` writes the ledger — a read of a project creates neither (T4c-F6).
  assert.deepEqual((await readdir(repo)).sort(), before);
  assert.equal(await excluded(), wasExcluded);

  // What an operator of this project is offered: the provider's four among them, because
  // the mode it runs has a role that can be given a worktree like every other mode's.
  const offered = projectTools(repo, { mode: loadMode(builtInModesDir(), "solo") }).map((tool) => tool.name);
  for (const name of ["delegate", "verify_worktree", "git_mutate", "git_root", "run_command"]) {
    assert.ok(offered.includes(name), `${name} is registered`);
  }
});

// @anchor serverWhoseMode
test("a server whose mode does not load, or whose config does not match it, exits naming the reason", { timeout: 20_000 }, async (t) => {
  const modes = modesRoot(t);
  buildMode(modes, "dev-team", [{ key: "planner" }]);
  const cases: Array<[Json, RegExp]> = [
    // The mode decides which tools exist and where every role works, so a mode that
    // cannot be read is not something to discover on the first `delegate`.
    [{ mode: "no-such-mode", roles: {} }, /no mode "no-such-mode"/],
    // The server serves the built-in modes, and `dev-team` declares no `designer`.
    [{ roles: { designer: { engine: "codex" } } }, /declares no role "designer"/],
  ];
  for (const [config, expected] of cases) {
    const root = await projectWithConfig(config);
    t.after(() => rm(root, { recursive: true, force: true }));
    const child = spawn(process.execPath, [serverEntry, "--project", root], { stdio: ["pipe", "pipe", "pipe"], env: suiteEnv });
    t.after(() => { child.kill(); });
    let stderr = "";
    let stdout = "";
    child.stderr!.setEncoding("utf8");
    child.stdout!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    // A client that speaks first is answered by the exit, not by a server serving half a
    // mode: the refusal is this process's own reason for stopping.
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    const [code] = await once(child, "close");
    assert.equal(code, 1, `${JSON.stringify(config)}: ${stderr}`);
    assert.match(stderr, /^cross-agent: /);
    assert.match(stderr, expected);
    assert.equal(stdout, "", "a server that will not serve answers nothing");
  }
});

// @anchor entryPointResolves
test("the entry point resolves its own row: a server carrying a task no record matches is a specialist", async (t) => {
  const root = await projectWithConfig({ roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = stdioClient(root, { env: { CROSS_AGENT_TASK: "no-such-task" } });
  try {
    const tools = ((await client.request("tools/list")).result as Json).tools as Json[];
    assert.deepEqual(tools.map((tool) => tool.name), ["describe_mode", "list_roles", "check", "result", "list_tasks"]);
    const refused = await client.request("tools/call", { name: "verify_worktree", arguments: { path: root, branch: "main" } });
    assert.deepEqual(refused.error, {
      code: -32602,
      message: "verify_worktree is not available to a specialist server: specialist: CROSS_AGENT_TASK present and no record matches",
    });
  } finally {
    client.close();
  }
});

// @anchor unknownMethodsGet
test("unknown methods get a JSON-RPC method-not-found error", async () => {
  const client = stdioClient(await projectWithConfig({ roles: {} }));
  try {
    const reply = await client.request("no/such/method");
    assert.equal((reply.error as Json).code, -32601);
  } finally {
    client.close();
  }
});

// @anchor pingAnsweredWhile
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

// @anchor linesSplitOnNewline
test("stdin is split on newlines alone: U+2028 and U+2029 inside a string, and a CRLF ending, are one request each", async () => {
  // JSON leaves both separators raw inside a string, and a brief carrying pasted text holds
  // them; a reader that also broke lines there would hand the server three fragments, each
  // answered -32700 with no id, and leave the client waiting on its own id for ever.
  const received: unknown[] = [];
  const server = createServer({
    tools: [{
      name: "echo",
      description: "answers with the text it was given",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      rows: ["operator"],
      handler: (args) => {
        received.push(args.text);
        return { content: [{ type: "text", text: String(args.text) }] };
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

  const separated = "before between after";
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: separated } } });
  // Sent raw, the way `JSON.stringify` writes them: nothing on this side escapes either.
  assert.ok(request.includes(" ") && request.includes(" "), "the request carries both separators raw");
  input.write(request + "\n");
  await waitFor(() => replies.some((m) => m.id === 1));
  assert.deepEqual(received, [separated], "the handler received the argument intact");
  assert.equal((((replies.find((m) => m.id === 1) as Json).result as Json).content as Json[])[0].text, separated);
  assert.equal(replies.some((m) => m.id === null), false, "no fragment of it was answered as a parse error");

  // A request ending in CRLF is the same request.
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\r\n");
  await waitFor(() => replies.some((m) => m.id === 2));
  assert.deepEqual(replies.find((m) => m.id === 2), { jsonrpc: "2.0", id: 2, result: {} });

  // A line that is not JSON is answered as one, and the next line on the connection is served.
  input.write("not json\n" + JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }) + "\n");
  await waitFor(() => replies.some((m) => m.id === 3));
  assert.deepEqual(replies.filter((m) => m.id === null), [{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }]);
});

// @anchor cancelledEndsWait
test("notifications/cancelled ends the wait it names within 100ms, and the reply is still sent", async (t) => {
  const root = await projectWithConfig({ roles: { planner: { engine: "grok" } } });
  t.after(() => rm(root, { recursive: true, force: true }));
  // A record no runner ever picked up: `wait` polls it for its whole timeout, and nothing
  // this test starts has a process to clean up.
  const record = create(root, { role: "planner", brief: "b", cwd: root, engine: "grok" });
  const server = createServer({ tools: projectTools(root, { mode: devTeam }), authority: () => operator });
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Json[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line.trim()) replies.push(JSON.parse(line) as Json);
  });
  server.connect(input, output);
  const send = (message: Json) => input.write(JSON.stringify(message) + "\n");

  send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait", arguments: { task_id: record.id, timeout_seconds: 600 } } });
  // An id nothing is running under is ignored: the ping behind it is answered, and the
  // wait it did not name is still pending.
  send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 999, reason: "no such request" } });
  send({ jsonrpc: "2.0", id: 2, method: "ping" });
  await waitFor(() => replies.some((message) => message.id === 2));
  assert.equal(replies.some((message) => message.id === 1), false, "the wait must still be pending");

  const cancelled = performance.now();
  send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "the user moved on" } });
  await waitFor(() => replies.some((message) => message.id === 1));
  assert.ok(performance.now() - cancelled < 100, "a cancelled wait answers within 100ms");

  // The reply is still sent, and it carries the task as the cancelled call last saw it.
  const reply = replies.find((message) => message.id === 1) as Json;
  const result = reply.result as Json;
  assert.equal(result.isError, undefined);
  const payload = JSON.parse((result.content as Json[])[0].text as string) as Json;
  const { elapsedSeconds, ...rest } = payload;
  assert.deepEqual(rest, {
    ok: true, task_id: record.id, status: "launching", stalled: false,
    lastActivity: null, resultTail: null, hint: "call wait again", cancelled: true,
  });
  assert.ok(typeof elapsedSeconds === "number" && elapsedSeconds >= 0 && elapsedSeconds < 30, `elapsed ${elapsedSeconds}`);
});

// @anchor cancellationSharingChunk
test("a cancellation sharing a chunk with the call it names is still honoured", async (t) => {
  const root = await projectWithConfig({ roles: { planner: { engine: "grok" } } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = create(root, { role: "planner", brief: "b", cwd: root, engine: "grok" });
  const server = createServer({ tools: projectTools(root, { mode: devTeam }), authority: () => operator });
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Json[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line.trim()) replies.push(JSON.parse(line) as Json);
  });
  server.connect(input, output);

  // One write, two lines: `connect` hands the dispatcher both in order, so the notification
  // is read while the call it names is still resolving its row. A controller registered
  // after that resolution would not be there to abort.
  input.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait", arguments: { task_id: record.id, timeout_seconds: 600 } } }) + "\n"
    + JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }) + "\n",
  );
  await waitFor(() => replies.some((message) => message.id === 1), 3000);
  const answered = JSON.parse((((replies.find((message) => message.id === 1) as Json).result as Json).content as Json[])[0].text as string);
  assert.equal(answered.cancelled, true);
  assert.equal(answered.status, "launching");
});

// @anchor specialistRowCannot
test("the specialist row cannot delegate, wait or cancel, and is refused by this server's own name", async (t) => {
  const root = await projectWithConfig({ roles: { planner: { engine: "codex" } } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const reason = "specialist by ancestry: task T (implementer, running)";
  const request = inProcess({
    tools: projectTools(root, { mode: devTeam }),
    authority: () => ({ row: "specialist" as const, reason, taskId: "T", depth: 1 }),
  });
  for (const [name, args] of [
    ["delegate", { role: "planner", brief: "do it", cwd: root }],
    ["wait", { task_id: "T" }],
    ["cancel", { task_id: "T" }],
  ] as const) {
    const refused = await request("tools/call", { name, arguments: args });
    assert.deepEqual(refused.error, { code: -32602, message: `${name} is not available to a specialist server: ${reason}` });
  }
  // The read tools it does have answer normally, and no task was created by the refusals.
  const listed = (await request("tools/call", { name: "list_tasks", arguments: {} })).result as Json;
  assert.deepEqual(JSON.parse(((listed.content as Json[])[0].text as string)).tasks, []);
});

test("the delegation tools answer a refusal as an error result, and their arguments are checked", async (t) => {
  const root = await projectWithConfig({ roles: { planner: { engine: "codex" } } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = inProcess({ tools: projectTools(root, { mode: devTeam }), authority: () => operator });
  const call = async (name: string, args: Json) => (await request("tools/call", { name, arguments: args }));

  for (const name of ["check", "result", "cancel", "wait"]) {
    const reply = await call(name, { task_id: "no-such-task" });
    const result = reply.result as Json;
    assert.equal(result.isError, true, name);
    assert.deepEqual(JSON.parse((result.content as Json[])[0].text as string), { ok: false, reason: "no task no-such-task" }, name);
  }
  // A refusal `delegate` decided is the tool's own answer, not a protocol error.
  const refused = (await call("delegate", { role: "nobody", brief: "b", cwd: root })).result as Json;
  assert.equal(refused.isError, true);
  assert.match(JSON.parse((refused.content as Json[])[0].text as string).reason as string, /no role "nobody"/);

  // A request this server cannot read at all is a protocol error instead.
  for (const [name, args] of [
    ["delegate", {}], ["delegate", { role: "planner", brief: "b", cwd: 5 }], ["delegate", { role: "planner", brief: "b", cwd: root, force: "yes" }],
    ["delegate", { role: "planner", brief: "b", cwd: root, worktree: "yes" }],
    ["check", { task_id: "" }], ["check", { task_id: "t", lines: "ten" }], ["result", {}], ["cancel", { task_id: null }],
    ["check", { task_id: "t", lines: 0 }], ["check", { task_id: "t", lines: -1 }], ["check", { task_id: "t", lines: 1.5 }],
    ["wait", { task_id: "" }], ["wait", { task_id: "t", timeout_seconds: "soon" }], ["wait", { task_id: "t", timeout_seconds: -1 }],
    ["list_tasks", { status: "elsewhere" }],
  ] as const) {
    const reply = await call(name, args as Json);
    assert.equal((reply.error as Json)?.code, -32602, `${name} ${JSON.stringify(args)}`);
  }
});

// @anchor worktreeProviderTools
test("the worktree provider's tools are registered for the operator and the lead under every mode", async (t) => {
  const root = await projectWithConfig({ roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = {
    operator: ["describe_mode", "list_roles", "delegate", "wait", "check", "result", "cancel", "list_tasks"],
    // The specialist row is the four read tools plus describe_mode, whatever the mode is.
    specialist: ["describe_mode", "list_roles", "check", "result", "list_tasks"],
  };
  const provider = ["verify_worktree", "git_mutate", "git_root", "run_command"];

  const team = buildMode(modesRoot(t), "dev-team", [{ key: "planner" }, { key: "implementer", workspace: "worktree" }]);
  const solo = buildMode(modesRoot(t), "solo", [{ key: "solo" }]);
  // Every mode registers them, because every mode has a role that can take `worktree:
  // true` and the branch it leaves has to be testable, mergeable and removable through
  // the journal. What differs is the policy they act under, which `describe_mode`'s
  // `git.implicit` names (design, "Modes").
  for (const [mode, expected] of [[team, provider], [solo, provider]] as const) {
    const names = async (row: Authority["row"]) => {
      const request = inProcess({ tools: projectTools(root, { mode }), authority: () => ({ row, reason: "test", depth: 0 }) });
      return (((await request("tools/list")).result as Json).tools as Json[]).map((tool) => tool.name);
    };
    for (const row of ["operator", "lead"] as const) {
      assert.deepEqual(await names(row), [...rows.operator, ...expected], `${mode.id} ${row}`);
    }
    // A specialist never reaches the provider's tools whatever the mode declares.
    assert.deepEqual(await names("specialist"), rows.specialist, mode.id);
  }

  // A tool no server registers is unknown rather than refused; every one this server has
  // is offered by row, which the two lists above are.
  const refused = await inProcess({ tools: projectTools(root, { mode: solo }), authority: () => operator })(
    "tools/call", { name: "ask", arguments: {} });
  assert.deepEqual(refused.error, { code: -32602, message: "unknown tool: ask" });
});

// The built-in engine-placed mode, whose server carries the mailbox.
const devTeamEngine: Mode = loadMode(builtInModesDir(), "dev-team-engine");
const twelve = [
  "describe_mode", "list_roles", "delegate", "wait", "check", "result", "cancel", "list_tasks",
  "verify_worktree", "git_mutate", "git_root", "run_command",
];

/** The JSON a tool answered with, and whether it answered as a refusal. */
function payload(reply: Json): { body: Json; isError: boolean } {
  const result = reply.result as Json;
  assert.ok(result, JSON.stringify(reply));
  return { body: JSON.parse(((result.content as Json[])[0].text as string)) as Json, isError: result.isError === true };
}

// @anchor mailboxRows
test("under engine placement the mailbox is three more tools, each offered to its rows of the matrix", async (t) => {
  const root = await projectWithConfig({ mode: "dev-team-engine", roles: {}, limits: { maxDepth: 2 } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = async (mode: Mode, row: Authority["row"]) => {
    const request = inProcess({ tools: projectTools(root, { mode }), authority: () => ({ row, reason: "test", depth: 0 }) });
    return (((await request("tools/list")).result as Json).tools as Json[]).map((tool) => tool.name);
  };
  // The operator answers and lists; the lead asks and lists its own; a specialist does neither.
  assert.deepEqual(await names(devTeamEngine, "operator"), [...twelve, "list_asks", "answer"]);
  assert.deepEqual(await names(devTeamEngine, "lead"), [...twelve, "ask", "list_asks"]);
  assert.deepEqual(await names(devTeamEngine, "specialist"), ["describe_mode", "list_roles", "check", "result", "list_tasks"]);
  // A host-placed mode has no lead to ask anything, and so no mailbox at all.
  for (const id of ["dev-team", "solo"]) {
    const mode = loadMode(builtInModesDir(), id);
    for (const row of ["operator", "lead"] as const) assert.deepEqual(await names(mode, row), twelve, `${id} ${row}`);
  }

  // Outside its rows a mailbox tool is refused by this server's own name, with the evidence.
  const operatorReason = "operator: no CROSS_AGENT_* variable and no engine ancestor";
  const asked = await inProcess({ tools: projectTools(root, { mode: devTeamEngine }), authority: () => ({ row: "operator", reason: operatorReason, depth: 0 }) })(
    "tools/call", { name: "ask", arguments: { question: "Which slug?" } });
  assert.deepEqual(asked.error, { code: -32602, message: `ask is not available to a operator server: ${operatorReason}` });
  const leadReason = "lead by ancestry: task L (lead, running)";
  const answered = await inProcess({ tools: projectTools(root, { mode: devTeamEngine }), authority: () => ({ row: "lead", reason: leadReason, taskId: "L", depth: 1 }) })(
    "tools/call", { name: "answer", arguments: { ask_id: "x", text: "yes" } });
  assert.deepEqual(answered.error, { code: -32602, message: `answer is not available to a lead server: ${leadReason}` });
});

/** A lead resumed once, a child of each of its records, and a task of nobody's: the ownership fixture. */
function ledgerOfOneLead(root: string) {
  const first = create(root, { role: "lead", brief: "the lead's first record", cwd: root, engine: "claude", depth: 1 });
  const resumed = create(root, { role: "lead", brief: "the lead, resumed", cwd: root, engine: "claude", depth: 1, resumedFrom: first.id });
  const before = create(root, { role: "planner", brief: "delegated before the resume", cwd: root, engine: "codex", depth: 2, parentTaskId: first.id });
  const after = create(root, { role: "planner", brief: "delegated after it", cwd: root, engine: "codex", depth: 2, parentTaskId: resumed.id });
  const stranger = create(root, { role: "consult", brief: "nobody's", cwd: root, engine: "codex", depth: 1 });
  return { first, resumed, before, after, stranger };
}

// @anchor askCarriesCaller
test("ask records the caller's own task, waits on its lineage's asks by id, and refuses anyone else's", async (t) => {
  const root = await projectWithConfig({ mode: "dev-team-engine", roles: {}, limits: { maxDepth: 2 } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { first, resumed, stranger } = ledgerOfOneLead(root);
  const lead = { row: "lead" as const, reason: `lead by ancestry: task ${resumed.id} (lead, running)`, taskId: resumed.id, depth: 1 };
  const request = inProcess({ tools: projectTools(root, { mode: devTeamEngine }), authority: () => lead });
  const ask = async (args: Json) => request("tools/call", { name: "ask", arguments: args });

  const asked = payload(await ask({ question: "Which slug?", timeout_seconds: 0 }));
  assert.equal(asked.isError, false);
  assert.deepEqual(asked.body, { ok: true, id: asked.body.id, status: "open", hint: `call ask again with id ${asked.body.id}` });
  const { readAsk, createAsk } = await import("../src/mailbox.ts");
  assert.equal(readAsk(root, asked.body.id as string)!.taskId, resumed.id, "the question is the calling task's own");

  // The record it continues asked before it died: still this lead's to wait on.
  const inherited = createAsk(root, { taskId: first.id, question: "Delete the branch?" });
  assert.deepEqual(payload(await ask({ id: inherited.id, timeout_seconds: 0 })).body,
    { ok: true, id: inherited.id, status: "open", hint: `call ask again with id ${inherited.id}` });
  const theirs = createAsk(root, { taskId: stranger.id, question: "Not this lead's?" });
  const refused = payload(await ask({ id: theirs.id, timeout_seconds: 0 }));
  assert.equal(refused.isError, true);
  assert.match(refused.body.reason as string, new RegExp(`refused ask ${theirs.id}`));

  // What this server cannot read is a protocol error, as `wait`'s is.
  for (const args of [{}, { question: "" }, { question: 5 }, { id: 5 }, { question: "Q?", timeout_seconds: -1 }, { question: "Q?", timeout_seconds: "soon" }]) {
    assert.equal(((await ask(args as Json)).error as Json)?.code, -32602, JSON.stringify(args));
  }
});

// @anchor cancelledEndsAsk
test("notifications/cancelled ends a pending ask within 100ms, and the reply is still sent", async (t) => {
  const root = await projectWithConfig({ mode: "dev-team-engine", roles: {}, limits: { maxDepth: 2 } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { resumed } = ledgerOfOneLead(root);
  const server = createServer({
    tools: projectTools(root, { mode: devTeamEngine }),
    authority: () => ({ row: "lead", reason: "test", taskId: resumed.id, depth: 1 }),
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Json[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line.trim()) replies.push(JSON.parse(line) as Json);
  });
  server.connect(input, output);
  const send = (message: Json) => input.write(JSON.stringify(message) + "\n");

  send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: { question: "Still there?", timeout_seconds: 600 } } });
  const { listAsks } = await import("../src/mailbox.ts");
  await waitFor(() => listAsks(root).asks.length === 1);
  send({ jsonrpc: "2.0", id: 2, method: "ping" });
  await waitFor(() => replies.some((message) => message.id === 2));
  assert.equal(replies.some((message) => message.id === 1), false, "the ask must still be pending");

  const cancelled = performance.now();
  send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "the user moved on" } });
  await waitFor(() => replies.some((message) => message.id === 1));
  assert.ok(performance.now() - cancelled < 100, "a cancelled ask answers within 100ms");
  const { body } = payload(replies.find((message) => message.id === 1) as Json);
  assert.deepEqual(body, { ok: true, id: listAsks(root).asks[0].id, status: "open", cancelled: true });
  assert.equal(listAsks(root).asks[0].status, "open", "the question is still the operator's to answer");
});

// @anchor listAsksRows
test("list_asks shows the operator every ask and a lead its own lineage's, and answer is the first one's", async (t) => {
  const root = await projectWithConfig({ mode: "dev-team-engine", roles: {}, limits: { maxDepth: 2 } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { first, resumed, stranger } = ledgerOfOneLead(root);
  const { createAsk } = await import("../src/mailbox.ts");
  const mine = createAsk(root, { taskId: first.id, question: "Mine, from before the resume?" }, 1_000);
  const theirs = createAsk(root, { taskId: stranger.id, question: "Theirs?" }, 2_000);
  const operatorCall = inProcess({ tools: projectTools(root, { mode: devTeamEngine }), authority: () => operator });
  const leadCall = inProcess({
    tools: projectTools(root, { mode: devTeamEngine }),
    authority: () => ({ row: "lead", reason: "test", taskId: resumed.id, depth: 1 }),
  });
  const ids = (reply: Json) => (payload(reply).body.asks as Json[]).map((entry) => entry.id);

  assert.deepEqual(ids(await operatorCall("tools/call", { name: "list_asks", arguments: {} })), [mine.id, theirs.id]);
  assert.deepEqual(ids(await leadCall("tools/call", { name: "list_asks", arguments: {} })), [mine.id]);

  // The operator answers; a second answer is refused, naming when the first landed.
  const answered = payload(await operatorCall("tools/call", { name: "answer", arguments: { ask_id: mine.id, text: "use s11-i2" } }));
  assert.equal(answered.isError, false);
  assert.equal(answered.body.ok, true);
  assert.equal((answered.body.ask as Json).answer, "use s11-i2");
  const again = payload(await operatorCall("tools/call", { name: "answer", arguments: { ask_id: mine.id, text: "no" } }));
  assert.equal(again.isError, true);
  assert.match(again.body.reason as string, new RegExp(`answeredAt ${(answered.body.ask as Json).answeredAt}`));

  assert.deepEqual(ids(await operatorCall("tools/call", { name: "list_asks", arguments: { status: "open" } })), [theirs.id]);
  assert.deepEqual(ids(await leadCall("tools/call", { name: "list_asks", arguments: { status: "answered" } })), [mine.id]);
  assert.deepEqual(ids(await leadCall("tools/call", { name: "list_asks", arguments: { status: "open" } })), []);
  for (const [name, args] of [
    ["list_asks", { status: "elsewhere" }], ["list_asks", { status: 1 }],
    ["answer", {}], ["answer", { ask_id: mine.id }], ["answer", { ask_id: mine.id, text: "" }], ["answer", { ask_id: 1, text: "yes" }],
  ] as const) {
    assert.equal(((await operatorCall("tools/call", { name, arguments: args as Json })).error as Json)?.code, -32602, `${name} ${JSON.stringify(args)}`);
  }
});

// @anchor listTasksMarks
test("list_tasks marks a lead's own records self and the tasks it owns own, and marks nothing for the operator", async (t) => {
  const root = await projectWithConfig({ mode: "dev-team-engine", roles: {}, limits: { maxDepth: 2 } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { first, resumed, before, after, stranger } = ledgerOfOneLead(root);
  const tasksOf = async (authority: Authority) => {
    const request = inProcess({ tools: projectTools(root, { mode: devTeamEngine }), authority: () => authority });
    const listed = payload(await request("tools/call", { name: "list_tasks", arguments: {} })).body;
    return new Map((listed.tasks as Json[]).map((task) => [task.id as string, task]));
  };

  const asLead = await tasksOf({ row: "lead", reason: "test", taskId: resumed.id, depth: 1 });
  // The lead's own records are the one it runs as and the ones it continues; what it owns
  // is what any of them delegated (the resume-chain rule).
  for (const id of [resumed.id, first.id]) {
    assert.equal(asLead.get(id)!.self, true, id);
    assert.equal(asLead.get(id)!.own, undefined, id);
  }
  for (const id of [before.id, after.id]) {
    assert.equal(asLead.get(id)!.own, true, id);
    assert.equal(asLead.get(id)!.self, undefined, id);
  }
  assert.equal(asLead.get(stranger.id)!.self, undefined);
  assert.equal(asLead.get(stranger.id)!.own, undefined);

  // The operator owns nothing by lineage and is no task's self.
  for (const task of (await tasksOf(operator)).values()) {
    assert.equal(Object.hasOwn(task, "self") || Object.hasOwn(task, "own"), false, task.id as string);
  }
});

// @anchor describeModeServes
test("describe_mode serves the active mode's loop and roles to every row, and refuses a mode that is not there", async (t) => {
  const modes = modesRoot(t);
  const mode = buildMode(modes, "dev-team", [
    { key: "planner", prompt: "You are the planner of this test.\n" },
    { key: "implementer", workspace: "worktree" },
  ]);
  const root = await projectWithConfig({ roles: { planner: { engine: "codex" } } });
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const row of ["operator", "lead", "specialist"] as const) {
    const request = inProcess({ tools: projectTools(root, { mode }), authority: () => ({ row, reason: "test", depth: 0 }) });
    const reply = await request("tools/call", { name: "describe_mode", arguments: {} });
    const result = reply.result as Json;
    assert.notEqual(result.isError, true, row);
    const described = JSON.parse(((result.content as Json[])[0].text as string)) as Json;
    assert.deepEqual((described.mode as Json).id, "dev-team");
    assert.equal(described.loop, await readFile(path.join(mode.dir, "SKILL.md"), "utf8"), row);
    const roles = described.roles as Json[];
    assert.deepEqual(roles.map((role) => role.key), ["planner", "implementer", "consult"]);
    assert.equal(roles[0].prompt, "You are the planner of this test.\n");
    assert.deepEqual(described.git, { worktreeDir: ".worktrees", branchPattern: "task/*" });
  }

  // The launcher's first call is this one, so a config naming a mode nobody shipped fails
  // loudly here rather than half-way through a task.
  await writeFile(path.join(root, ".cross-agent", "config.json"), JSON.stringify({ mode: "no-such-mode", roles: {} }));
  const request = inProcess({ tools: projectTools(root, { mode }), authority: () => operator });
  const missing = (await request("tools/call", { name: "describe_mode", arguments: {} })).result as Json;
  assert.equal(missing.isError, true);
  assert.match(JSON.parse(((missing.content as Json[])[0].text as string)).reason as string, /no mode "no-such-mode"/);
});

test("list_roles reports the mode's workspace and the profile each role will actually run under", async (t) => {
  const modes = modesRoot(t);
  const mode = buildMode(modes, "dev-team", [{ key: "planner" }, { key: "implementer", workspace: "worktree" }]);
  const root = await projectWithConfig({
    roles: { planner: { engine: "codex", model: "gpt-6-astra", effort: "high" }, implementer: { engine: "claude", sandbox: "off" } },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = inProcess({ tools: projectTools(root, { mode }), authority: () => operator });
  const reply = await request("tools/call", { name: "list_roles", arguments: {} });
  assert.deepEqual(JSON.parse((((reply.result as Json).content as Json[])[0].text as string)), {
    roles: {
      planner: { engine: "codex", model: "gpt-6-astra", effort: "high", workspace: { kind: "root" }, sandbox: "read-only" },
      implementer: {
        engine: "claude", workspace: { kind: "worktree", branchPattern: "task/*", dir: ".worktrees" }, sandbox: "off",
      },
      // The mode's roles, not the config's: a role nothing binds is listed with the
      // binding it does not have, because a `delegate` may name the engine itself.
      consult: { binding: null, workspace: { kind: "root" }, sandbox: "read-only" },
    },
  });

  // Which tools exist was decided when the server loaded its mode, so a config since
  // pointed at another mode is answered with the roles it now names **and** the drift.
  const other = buildMode(path.dirname(mode.dir), "other-team", [{ key: "only" }]);
  await writeFile(path.join(root, ".cross-agent", "config.json"),
    JSON.stringify({ mode: "other-team", roles: { only: { engine: "codex" } } }));
  const drifted = JSON.parse(((((await request("tools/call", { name: "list_roles", arguments: {} })).result as Json).content as Json[])[0].text as string)) as Json;
  assert.deepEqual(drifted.roles, {
    only: { engine: "codex", workspace: { kind: "root" }, sandbox: "read-only" },
    consult: { binding: null, workspace: { kind: "root" }, sandbox: "read-only" },
  });
  assert.match(drifted.warning as string, /"other-team" in \.cross-agent\/config\.json/);
  assert.match(drifted.warning as string, /"dev-team" served/);
  assert.match(drifted.warning as string, /restart/);
  assert.equal(other.id, "other-team");

  // A config the mode no longer matches is the loader's refusal, reported as the tool's answer.
  await writeFile(path.join(root, ".cross-agent", "config.json"), JSON.stringify({ roles: { designer: { engine: "codex" } } }));
  const refused = (await request("tools/call", { name: "list_roles", arguments: {} })).result as Json;
  assert.equal(refused.isError, true);
  assert.match((refused.content as Json[])[0].text as string, /declares no role "designer"/);
});

// @anchor gitMutateTakes
test("git_mutate takes its worktree directory and branch from the mode's own git policy", async (t) => {
  const modes = modesRoot(t);
  const mode = buildMode(modes, "dev-team", [{ key: "implementer", workspace: "worktree" }], {
    git: { worktreeDir: "trees", branchPattern: "work/*" },
    roles: [{
      key: "implementer", title: "Implementer", promptFile: "roles/implementer.md",
      workspace: { kind: "worktree", branchPattern: "work/*", dir: "trees" }, sandboxDefault: "workspace-write",
    }],
  });
  const root = await projectWithConfig({ roles: { implementer: { engine: "codex" } } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const git = (...args: string[]) => exec("git", ["-C", root, "-c", "user.name=Cross Agent Test",
    "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", ...args]);
  await git("init", "-b", "main");
  await git("commit", "--allow-empty", "-m", "initial");
  await git("worktree", "add", "-b", "work/one", path.join(root, "trees", "one"));
  await writeFile(path.join(root, "trees", "one", "file.txt"), "work\n");

  const request = inProcess({ tools: projectTools(root, { mode }), authority: () => operator });
  const call = async (args: Json) => {
    const reply = await request("tools/call", { name: "git_mutate", arguments: args });
    return JSON.parse(((((reply.result as Json).content as Json[])[0].text) as string)) as Json;
  };
  // Neither `path` nor `branch` is given: both come from the policy, so the call lands in
  // `trees/one` on `work/one` and nowhere else.
  const added = await call({ slug: "one", args: ["add", "file.txt"] });
  assert.equal(added.ok, true, JSON.stringify(added));
  const committed = await call({ slug: "one", args: ["commit", "-m", "add a file"] });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal((committed.journal as Json).step, "committed", "the step a commit completes, by its own name");
  const { stdout } = await exec("git", ["-C", path.join(root, "trees", "one"), "log", "-1", "--format=%s %d"]);
  assert.match(stdout, /add a file/);
  assert.match(stdout, /work\/one/);

  // The shape of the request is still this server's to check.
  for (const args of [{}, { slug: "one" }, { slug: "one", args: "status" }, { slug: 1, args: ["status"] }, { slug: "one", args: [1] }]) {
    const reply = await request("tools/call", { name: "git_mutate", arguments: args as Json });
    assert.equal((reply.error as Json)?.code, -32602, JSON.stringify(args));
  }
});

test("git_root is the worktree provider's own, for the operator and the lead, under either placement", async (t) => {
  const modes = modesRoot(t);
  // Plan decision 4: the root verbs are registered whenever the mode declares a worktree
  // role, so a host-placed lead journals its own root steps too.
  const hosted = buildMode(modes, "dev-team", [{ key: "planner" }, { key: "implementer", workspace: "worktree" }]);
  const placed = buildMode(modes, "dev-team-engine", [{ key: "lead" }, { key: "implementer", workspace: "worktree" }], {
    lead: { placement: "engine", role: "lead" },
  });
  const root = await projectWithConfig({ mode: "dev-team", roles: {} });
  t.after(() => rm(root, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const git = (...args: string[]) => exec("git", ["-C", root, "-c", "user.name=Cross Agent Test",
    "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", ...args]);
  await git("init", "-b", "main");
  await git("commit", "--allow-empty", "-m", "initial");

  for (const mode of [hosted, placed]) {
    const names = async (row: Authority["row"]) => {
      const request = inProcess({ tools: projectTools(root, { mode }), authority: () => ({ row, reason: "test", depth: 0 }) });
      return (((await request("tools/list")).result as Json).tools as Json[]).map((tool) => tool.name);
    };
    for (const row of ["operator", "lead"] as const) assert.ok((await names(row)).includes("git_root"), `${mode.id} ${row}`);
    assert.equal((await names("specialist")).includes("git_root"), false, mode.id);
  }

  const request = inProcess({ tools: projectTools(root, { mode: hosted }), authority: () => operator });
  const call = async (args: Json) => {
    const reply = await request("tools/call", { name: "git_root", arguments: args });
    return JSON.parse(((((reply.result as Json).content as Json[])[0].text) as string)) as Json;
  };
  const directory = path.join(root, ".worktrees", "one");
  const created = await call({ args: ["worktree", "add", "-b", "task/one", directory, "main"], slug: "one" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal((created.journal as Json).step, "worktree-created");
  // The mode's own policy reached the tool: another mode's directory is refused.
  const outside = await call({ args: ["worktree", "add", "-b", "task/two", path.join(root, "trees", "two"), "main"], slug: "two" });
  assert.equal(outside.ok, false);

  // A config pointed at another mode after this server started is answered with a restart
  // rather than served under a policy this server is not serving — by every tool of the
  // provider, because each of them acts on that mode's own git policy.
  await writeFile(path.join(root, ".cross-agent", "config.json"), JSON.stringify({ mode: "solo", roles: {} }));
  const drifted = await call({ args: ["status", "--porcelain"] });
  assert.equal(drifted.ok, false);
  assert.match(drifted.reason as string, /restart the server/);
  for (const [name, args] of [
    ["git_mutate", { slug: "one", args: ["status"] }],
    ["verify_worktree", { path: directory, branch: "task/one" }],
  ] as Array<[string, Json]>) {
    const reply = await request("tools/call", { name, arguments: args });
    const answered = JSON.parse((((reply.result as Json).content as Json[])[0].text) as string) as Json;
    assert.match(answered.reason as string, /restart the server/, name);
  }
  await writeFile(path.join(root, ".cross-agent", "config.json"), JSON.stringify({ mode: "dev-team", roles: {} }));

  // The shape of the request is this server's to check.
  for (const args of [{}, { args: "status" }, { args: [] }, { args: ["status"], slug: 1 }]) {
    const reply = await request("tools/call", { name: "git_root", arguments: args as Json });
    assert.equal((reply.error as Json)?.code, -32602, JSON.stringify(args));
  }
});

test("run_command is registered beside git_root and runs the project's own command", async (t) => {
  const mode = buildMode(modesRoot(t), "dev-team", [{ key: "planner" }, { key: "implementer", workspace: "worktree" }]);
  const root = await projectWithConfig({ mode: "dev-team", roles: {}, project: { testCommand: "echo the suite ran; pwd" } });
  t.after(() => rm(root, { recursive: true, force: true }));
  // A real repository: this tool refuses a project whose `.cross-agent/` is tracked, so
  // it reads the repository at the root before it runs anything.
  const exec = promisify(execFile);
  await exec("git", ["-C", root, "init", "-b", "main"]);
  const request = inProcess({ tools: projectTools(root, { mode }), authority: () => operator });
  const call = async (args: Json) => {
    const reply = await request("tools/call", { name: "run_command", arguments: args });
    return JSON.parse(((((reply.result as Json).content as Json[])[0].text) as string)) as Json;
  };

  const ran = await call({ which: "test", where: "root" });
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.match(ran.tail as string, /the suite ran/);
  assert.match(ran.tail as string, new RegExp(await realpath(root)), "it ran at the project root");
  assert.equal(ran.journal, undefined);

  // A config pointed at another mode after this server started: a restart, not a run.
  await writeFile(path.join(root, ".cross-agent", "config.json"), JSON.stringify({ mode: "solo", roles: {} }));
  const drifted = await call({ which: "test", where: "root" });
  assert.equal(drifted.ok, false);
  assert.match(drifted.reason as string, /restart the server/);

  // The shape of the request is this server's to check, the enum included.
  for (const args of [{}, { which: "test" }, { where: "root" }, { which: "build", where: "root" },
    { which: "test", where: "root", timeout_seconds: 0 }, { which: "test", where: "root", timeout_seconds: 2_147_484 },
    { which: "test", where: "root", slug: 1 }]) {
    const reply = await request("tools/call", { name: "run_command", arguments: args as Json });
    assert.equal((reply.error as Json)?.code, -32602, JSON.stringify(args));
  }
});

// @anchor resolverThrowsAnswers
test("a resolver that throws answers -32603, lists nothing, and runs no handler", async () => {
  let ran = false;
  const request = inProcess({
    tools: [{
      name: "guarded", description: "never runs", inputSchema: { type: "object", properties: {} }, rows: ["operator", "lead", "specialist"],
      handler: () => { ran = true; return { content: [{ type: "text", text: "ran" }] }; },
    }],
    authority: () => { throw new Error("/proc/1/stat: permission denied"); },
  });
  const listed = await request("tools/list");
  assert.deepEqual(listed.error, { code: -32603, message: "/proc/1/stat: permission denied" });
  assert.equal(listed.result, undefined);
  const called = await request("tools/call", { name: "guarded", arguments: {} });
  assert.deepEqual(called.error, { code: -32603, message: "/proc/1/stat: permission denied" });
  assert.equal(ran, false, "a row that could not be resolved runs nothing");
});

test("the server reconciles once before it serves and names on stderr what it could not decide", async (t) => {
  const root = await projectWithConfig({ roles: {}, limits: { lockWaitSeconds: 0 } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { create } = await import("../src/ledger.ts");
  const { acquire, lockPath, recordLockName } = await import("../src/locks.ts");
  // A launch nobody acknowledged, past its deadline: the pass has to judge it, and cannot,
  // because another writer holds its record lock and this project waits no time at all.
  const record = create(root, { role: "planner", brief: "b", cwd: root, engine: "codex" }, Date.now() - 60_000);
  const held = await acquire(lockPath(root, recordLockName(record.id)), { operation: "the test holds it", waitSeconds: 2 });
  t.after(() => held.release());

  const child = spawn(process.execPath, [serverEntry, "--project", root], { stdio: ["pipe", "pipe", "pipe"], env: suiteEnv });
  t.after(() => { child.kill(); });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  await waitFor(() => stderr.includes(record.id), 8000);
  assert.match(stderr, new RegExp(`cross-agent: task ${record.id}: .*lock`));
  assert.equal(record.status, "launching");
});
