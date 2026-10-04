import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { engineEnv, project } from "./helpers/project.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = "skills/cross-agent/scripts";
const markers = ["CROSS_AGENT_PROJECT", "CROSS_AGENT_TASK", "CROSS_AGENT_DEPTH", "CROSS_AGENT_LINEAGE"];

function fixture(t: any) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-setup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codex = path.join(home, "codex");
  fs.copyFileSync(path.join(repo, "tests/fixtures/fake-codex-setup.mjs"), codex);
  fs.chmodSync(codex, 0o755);
  const file = path.join(home, "fixture.json");
  const pluginId = "cross-agent@fixture-market";
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  for (const name of markers) delete env[name];
  const state = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const write = (value: any) => fs.writeFileSync(file, JSON.stringify(value));
  write({ version: 0, config: { model: "untouched", mcp_servers: { other: { command: "unchanged" } } }, plugins: [] });
  function installVersion(version: string, selected = true) {
    const root = path.join(home, "plugins/cache/fixture-market/cross-agent", version);
    for (const directory of ["src", "skills", ".codex-plugin"]) {
      fs.cpSync(path.join(repo, directory), path.join(root, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(root, ".codex-plugin/plugin.json"), JSON.stringify({ name: "cross-agent", version }));
    fs.writeFileSync(path.join(root, "src/server.ts"), 'console.log(JSON.stringify({ version: ' + JSON.stringify(version)
      + ', cwd: process.cwd(), pid: process.pid, markers: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CROSS_AGENT_"))) }));\n');
    if (selected) {
      const s = state();
      s.plugins = [{ name: "cross-agent", pluginId, marketplaceName: "fixture-market", version, installed: true, enabled: true }];
      write(s);
    }
    return root;
  }
  const root = installVersion("1.0.0");
  function run(verb: string, extra: string[] = [], extraEnv = {}) {
    return spawnSync(process.execPath, [path.join(root, scripts, "codex-setup.mjs"), verb, "--codex", codex, ...extra],
      { env: { ...env, ...extraEnv }, cwd: home, encoding: "utf8", timeout: 15000 });
  }
  function launch(cwd: string, extraEnv = {}) {
    const entry = state().config.mcp_servers["cross-agent"];
    return spawnSync(entry.command, entry.args, { cwd, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 15000 });
  }
  return { home, root, codex, env, state, write, run, launch, installVersion };
}

// @anchor codexSetupLifecycle
test("one-time setup uses a versioned native config edit, inherits each chat's cwd, and removes only its own registration", (t) => {
  const f = fixture(t);
  const before = f.state().config;
  const absent = f.run("check");
  assert.notEqual(absent.status, 0);
  assert.equal(f.state().writes, undefined, "check does not write config");
  const installed = f.run("install");
  assert.equal(installed.status, 0, installed.stderr);
  const entry = f.state().config.mcp_servers["cross-agent"];
  assert.equal(entry.cwd, undefined);
  assert.equal(entry.env, undefined);
  assert.deepEqual(entry.env_vars, markers);
  assert.equal(entry.startup_timeout_sec, 30);
  assert.equal(entry.tool_timeout_sec, 3600);
  assert.equal(entry.default_tools_approval_mode, "approve");
  assert.ok(!entry.args.join(" ").includes("1.0.0"), "registration has no versioned cache path");
  for (const project of ["first project", "second-project"]) {
    const cwd = path.join(f.home, project);
    fs.mkdirSync(cwd);
    const launched = f.launch(cwd);
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(JSON.parse(launched.stdout).cwd, cwd);
  }
  assert.equal(f.run("install").status, 0);
  assert.equal(f.run("check").status, 0);
  assert.equal(f.state().writes, 1, "repeated setup is idempotent");
  const removed = f.run("remove");
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(f.state().config, before);
  assert.equal(f.run("remove").status, 0, "removing twice is harmless");
});

test("the launcher follows installed updates, ignores unselected caches and marketplace-only updates, and honors disable and uninstall", (t) => {
  const f = fixture(t);
  assert.equal(f.run("install").status, 0);
  f.installVersion("2.0.0", false);
  const s = f.state();
  s.available = [{ ...s.plugins[0], version: "2.0.0" }];
  f.write(s);
  assert.equal(JSON.parse(f.launch(f.home).stdout).version, "1.0.0");
  f.installVersion("2.0.0");
  fs.rmSync(f.root, { recursive: true });
  assert.equal(JSON.parse(f.launch(f.home).stdout).version, "2.0.0", "survives removal of the old cache");
  const disabled = f.state();
  disabled.plugins[0].enabled = false;
  f.write(disabled);
  assert.notEqual(f.launch(f.home).status, 0);
  disabled.plugins = [];
  f.write(disabled);
  const removed = f.launch(f.home);
  assert.notEqual(removed.status, 0);
  assert.equal(removed.stdout, "", "never runs stale cached code after uninstall");
});

test("repair preserves user restrictions on the managed server; removal deletes that whole registration", (t) => {
  const f = fixture(t);
  const original = f.state().config;
  assert.equal(f.run("install").status, 0);
  const s = f.state();
  const policy = { enabled: false, default_tools_approval_mode: "prompt", disabled_tools: ["delegate"], tool_timeout_sec: 45,
    tools: { git_mutate: { approval_mode: "prompt" } } };
  Object.assign(s.config.mcp_servers["cross-agent"], policy);
  f.write(s);
  assert.equal(f.run("install").status, 0);
  const entry = f.state().config.mcp_servers["cross-agent"];
  for (const [key, value] of Object.entries(policy)) assert.deepEqual(entry[key], value);
  assert.equal(f.run("remove").status, 0);
  assert.deepEqual(f.state().config, original, "no commandless MCP table remains after removal");
});

test("setup refuses a custom registration or project override and removal does not delete a replacement", (t) => {
  const f = fixture(t);
  const s = f.state();
  s.config.mcp_servers["cross-agent"] = { command: "/custom/server" };
  f.write(s);
  assert.notEqual(f.run("install").status, 0);
  assert.deepEqual(f.state(), s);
  delete s.config.mcp_servers["cross-agent"];
  s.override = { mcp_servers: { "cross-agent": { command: "/project/server" } } };
  f.write(s);
  assert.notEqual(f.run("install").status, 0);
  delete s.override;
  f.write(s);
  assert.equal(f.run("install").status, 0);
  const replaced = f.state();
  replaced.config.mcp_servers["cross-agent"] = { command: "/user/replacement" };
  f.write(replaced);
  assert.notEqual(f.run("remove").status, 0);
  assert.deepEqual(f.state(), replaced);
});

test("a concurrent config edit is preserved and an uncommitted setup can be retried", (t) => {
  const f = fixture(t);
  const s = f.state();
  s.race = true;
  f.write(s);
  const raced = f.run("install");
  assert.notEqual(raced.status, 0);
  assert.match(raced.stderr, /version|concurrent|conflict/i);
  assert.equal(f.state().config.model, "concurrent-edit");
  assert.equal(f.state().config.mcp_servers["cross-agent"], undefined);
  const retry = f.state();
  retry.race = false;
  f.write(retry);
  assert.equal(f.run("install").status, 0);
  assert.equal(f.state().config.model, "concurrent-edit");
});

test("a conflicted repair after a Node path change recognizes either side of the attempted config write", (t) => {
  const f = fixture(t);
  assert.equal(f.run("install").status, 0);
  const stateFile = path.join(f.home, "cross-agent/state.json");
  const recorded = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const s = f.state();
  // Represent a previous Node installation whose executable path changed.
  recorded.managed.command = s.config.mcp_servers["cross-agent"].command = "/previous/node";
  fs.writeFileSync(stateFile, JSON.stringify(recorded));
  s.race = true;
  f.write(s);
  assert.match(f.run("install").stderr, /conflict/);
  const retry = f.state();
  retry.race = false;
  f.write(retry);
  const repaired = f.run("install");
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(f.run("check").status, 0);
});

test("task markers survive the launcher and prevent setup mutations even when empty", (t) => {
  const f = fixture(t);
  assert.equal(f.run("install").status, 0);
  const env = Object.fromEntries(markers.map((name, i) => [name, String(i)]));
  const launched = f.launch(f.home, env);
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(JSON.parse(launched.stdout).markers, env);
  for (const name of markers.slice(1)) {
    for (const verb of ["install", "remove"]) {
      const refused = f.run(verb, [], { [name]: "" });
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /task/i);
    }
  }
  assert.equal(f.state().writes, 1);
});

test("setup refuses missing, disabled, ambiguous, or malformed installed plugin identities", (t) => {
  const f = fixture(t);
  const original = f.state();
  for (const plugins of [[], [{ ...original.plugins[0], enabled: false }],
    [original.plugins[0], { ...original.plugins[0], pluginId: "cross-agent@another", marketplaceName: "another" }],
    [{ ...original.plugins[0], version: "../1.0.0" }]]) {
    f.write({ ...original, plugins });
    const refused = f.run("install");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /not installed|disabled|several|invalid/);
    assert.equal(f.state().writes, undefined);
  }
});

// @anchor codexSetupMcp
test("the configured launcher serves the real MCP protocol, fixture delegation, and specialist restrictions", async (t) => {
  const f = fixture(t);
  const p = await project(t, { mode: "solo" }, [{ key: "worker" }]);
  fs.writeFileSync(path.join(p.root, ".cross-agent/config.json"), JSON.stringify({ mode: "solo", roles: {}, engines: { grok: { bin: p.bin } } }));
  for (const name of ["src", "modes"]) fs.cpSync(path.join(repo, name), path.join(f.root, name), { recursive: true });
  fs.copyFileSync(path.join(repo, "package.json"), path.join(f.root, "package.json"));
  assert.equal(f.run("install").status, 0);
  const entry = f.state().config.mcp_servers["cross-agent"];
  for (const restricted of [false, true]) {
    const env = { ...engineEnv(p), ...f.env, FAKE_ENGINE_FORMAT: "grok", ...(restricted ? { CROSS_AGENT_DEPTH: "1" } : {}) };
    const child = spawn(entry.command, entry.args, { cwd: p.root, env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let id = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const closed = new Promise<void>((resolve) => child.once("close", () => {
      for (const p of pending.values()) p.reject(new Error(stderr || "server exited"));
      resolve();
    }));
    child.on("error", (error) => { for (const p of pending.values()) p.reject(error); });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const value = JSON.parse(line);
      const p = pending.get(value.id);
      if (!p) return;
      pending.delete(value.id);
      if (value.error) p.reject(new Error(JSON.stringify(value.error)));
      else p.resolve(value.result);
    });
    const call = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => { pending.delete(n); reject(new Error(`server timed out: ${stderr}`)); }, 10000);
      pending.set(n, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
    const tool = async (name: string, args = {}) => {
      const result = await call("tools/call", { name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    try {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "setup-test", version: "1" } });
      const listed = await call("tools/list");
      assert.equal(listed.tools.some((t: any) => t.name === "delegate"), !restricted);
      if (restricted) continue;
      assert.equal((await tool("describe_mode")).projectRoot, p.root);
      const task = await tool("delegate", { role: "consult", engine: "grok", cwd: p.root, brief: "Return the fixture result." });
      const settled = await tool("wait", { task_id: task.task_id, timeout_seconds: 10 });
      assert.equal(settled.status, "done");
      assert.match(JSON.stringify(await tool("result", { task_id: task.task_id })), /DONE/);
    } finally {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      await closed;
      clearTimeout(timer);
      lines.close();
    }
  }
});
