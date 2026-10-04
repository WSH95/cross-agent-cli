import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configClient } from "../skills/cross-agent/scripts/codex-config.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Opt-in real Codex contract check: no account, model turn, or real home writes.
// CODEX_SETUP_PROBE=/absolute/path/to/codex node --test tests/codex-native.test.ts
// @anchor codexNativeSetup
test("real Codex setup preserves TOML and mounts the installed server for separate desktop-backend chats", {
  skip: !process.env.CODEX_SETUP_PROBE, timeout: 90000,
}, async (t) => {
  const codex = process.env.CODEX_SETUP_PROBE!;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cross-agent-native-"));
  const home = path.join(scratch, "home");
  const source = path.join(scratch, "marketplace");
  fs.mkdirSync(home);
  for (const name of ["src", "skills", "modes", ".codex-plugin", ".agents/plugins"]) {
    fs.cpSync(path.join(repo, name), path.join(source, name), { recursive: true });
  }
  fs.copyFileSync(path.join(repo, "package.json"), path.join(source, "package.json"));
  const config = path.join(home, "config.toml");
  fs.writeFileSync(config, '# preserve this comment\n[mcp_servers.unrelated]\ncommand = "true"\nenabled = false\n');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CROSS_AGENT_"))), CODEX_HOME: home };
  const run = (command: string, args: string[], cwd = scratch) => execFileSync(command, args,
    { cwd, env, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  let close: (() => Promise<void>) | undefined;
  try {
    run(codex, ["plugin", "marketplace", "add", source]);
    run(codex, ["plugin", "add", "cross-agent@cross-agent-cli"]);
    const version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
    const helper = path.join(home, "plugins/cache/cross-agent-cli/cross-agent", version, "skills/cross-agent/scripts/codex-setup.mjs");
    const original = fs.readFileSync(config, "utf8");
    for (const verb of ["install", "install", "check"]) run(process.execPath, [helper, verb, "--codex", codex]);
    const settings = await configClient(codex, home);
    try {
      const snapshot = await settings.call("config/read", { includeLayers: true });
      const layer = snapshot.layers.find((l: any) => l.name.type === "user");
      await settings.call("config/batchWrite", { filePath: config, expectedVersion: layer.version,
        edits: [{ keyPath: "mcp_servers.cross-agent.disabled_tools", value: ["cancel"], mergeStrategy: "replace" }] });
    } finally { await settings.close(); }
    run(process.execPath, [helper, "install", "--codex", codex]);
    const registered = JSON.parse(run(codex, ["mcp", "get", "cross-agent", "--json"]));
    assert.equal(registered.transport.cwd, null);
    assert.equal(registered.tool_timeout_sec, 3600);
    assert.deepEqual(registered.disabled_tools, ["cancel"]);
    assert.ok(fs.readFileSync(config, "utf8").includes("# preserve this comment"));

    const projects = [path.join(scratch, "solo project"), path.join(scratch, "team-project")];
    for (const project of projects) { fs.mkdirSync(project); run("git", ["init", "-b", "main"], project); }
    run(process.execPath, [path.join(source, "src/cli.ts"), "init", "--mode", "dev-team"], projects[1]);
    run("git", ["add", ".gitignore"], projects[1]);
    run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "initial"], projects[1]);
    const inherited = path.join(scratch, "inherited-worktree");
    const independent = path.join(scratch, "initialized-worktree");
    run("git", ["worktree", "add", "-b", "inherited", inherited], projects[1]);
    run("git", ["worktree", "add", "-b", "independent", independent], projects[1]);
    run(process.execPath, [path.join(source, "src/cli.ts"), "init"], independent);
    const child = spawn(codex, ["app-server", "--stdio"], { cwd: scratch, env, stdio: ["pipe", "pipe", "pipe"] });
    let next = 0;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const closed = new Promise<void>((resolve) => child.once("close", () => {
      for (const p of pending.values()) p.reject(new Error(`app-server closed: ${stderr}`));
      resolve();
    }));
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const value = JSON.parse(line);
      const p = pending.get(value.id);
      if (!p) return;
      pending.delete(value.id);
      if (value.error) p.reject(new Error(JSON.stringify(value.error)));
      else p.resolve(value.result);
    });
    child.once("error", (error) => { for (const p of pending.values()) p.reject(error); });
    const call = (method: string, params: any) => new Promise<any>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 15000);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
    close = async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      await closed;
      clearTimeout(timer);
      lines.close();
    };
    await call("initialize", { clientInfo: { name: "cross-agent-native-test", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    for (const [cwd, root, expectedMode] of [
      [projects[0], projects[0], "solo"], [projects[1], projects[1], "dev-team"],
      [inherited, projects[1], "dev-team"], [independent, independent, "dev-team"],
    ]) {
      const started = await call("thread/start", { cwd, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
      const threadId = started.thread.id;
      await call("mcpServerStatus/list", { threadId, serverName: "cross-agent" });
      const described = await call("mcpServer/tool/call", { threadId, server: "cross-agent", tool: "describe_mode", arguments: {} });
      assert.ok(!described.isError, JSON.stringify(described));
      const mode = JSON.parse(described.content.find((c: any) => c.type === "text").text);
      assert.equal(mode.projectRoot, root);
      assert.equal(mode.mode.id, expectedMode);
      const roles = await call("mcpServer/tool/call", { threadId, server: "cross-agent", tool: "list_roles", arguments: {} });
      assert.ok(!roles.isError, JSON.stringify(roles));
    }
    assert.equal(fs.existsSync(path.join(projects[0], ".cross-agent/config.json")), false, "solo needed no init");
    await close();
    close = undefined;
    run(process.execPath, [helper, "remove", "--codex", codex]);
    assert.equal(fs.readFileSync(config, "utf8"), original, "native API restores original TOML including comments");
    t.diagnostic(run(codex, ["--version"]).trim());
  } finally {
    await close?.();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
