import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { execFileSync } from "node:child_process";
import { acquire } from "../../../src/locks.ts";
import { installedPlugin } from "./codex-serve.mjs";
import { configClient } from "./codex-config.mjs";

const markers = ["CROSS_AGENT_PROJECT", "CROSS_AGENT_TASK", "CROSS_AGENT_DEPTH", "CROSS_AGENT_LINEAGE"];
const policyKeys = new Set(["enabled", "required", "enabled_tools", "disabled_tools", "tools",
  "default_tools_approval_mode", "default_tools_enabled", "startup_timeout_sec", "tool_timeout_sec"]);
const usage = "node <cross-agent skill>/scripts/codex-setup.mjs install|check|remove [--codex <executable>] [--plugin <plugin-id>]";

function executable(name) {
  const candidates = name.includes(path.sep) ? [path.resolve(name)] : (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.resolve(dir, name));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next PATH entry */ }
  }
  throw new Error(`${name} is not executable; install it on this Codex host first`);
}

function ownedState(dir, home) {
  if (!fs.existsSync(dir)) return undefined;
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`setup directory is not a regular directory: ${dir}`);
  for (const name of ["state.json", "serve.mjs"]) {
    if (!fs.lstatSync(path.join(dir, name)).isFile()) throw new Error(`setup file is not a regular file: ${name}`);
  }
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  if (state.schema !== 1 || state.home !== home || typeof state.pluginId !== "string" || !state.managed) {
    throw new Error(`unrecognized setup directory: ${dir}`);
  }
  return state;
}

function managedConnection(entry, state) {
  return state && entry && [state.managed, state.previousManaged].some((known) => known
    && entry.command === known.command && equal(entry.args, known.args))
    && !Object.keys(entry).some((key) => !policyKeys.has(key) && !["command", "args", "env_vars"].includes(key));
}

function readLayer(snapshot, home) {
  const file = path.join(home, "config.toml");
  const layers = snapshot.layers ?? [];
  const user = layers.find((layer) => layer.name?.type === "user" && layer.name.file === file && layer.name.profile == null);
  if (!user || typeof user.version !== "string") throw new Error("Codex did not return a versioned user config layer; update Codex and retry");
  if (layers.some((layer) => layer !== user && layer.config?.mcp_servers?.["cross-agent"] !== undefined)) {
    throw new Error("another Codex config layer defines cross-agent; resolve that override before setup");
  }
  return { file, version: user.version, entry: user.config?.mcp_servers?.["cross-agent"] };
}

function atomicFile(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

async function main() {
  const [verb, ...args] = process.argv.slice(2);
  if (verb === "--help") { console.log(usage); return; }
  if (!["install", "check", "remove"].includes(verb)) throw new Error(usage);
  let codexName = "codex";
  let pluginId;
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1]) throw new Error(usage);
    if (args[i] === "--codex") codexName = args[i + 1];
    else if (args[i] === "--plugin") pluginId = args[i + 1];
    else throw new Error(usage);
  }
  if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) < 24 || !process.execve) {
    throw new Error("cross-agent requires Linux and Node 24 or newer on the Codex host");
  }
  if (verb !== "check" && markers.slice(1).some((key) => process.env[key] !== undefined)) {
    throw new Error("Codex setup writes host configuration and is refused inside a cross-agent task");
  }
  const home = fs.realpathSync(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")));
  const dir = path.join(home, "cross-agent");
  const codex = executable(codexName);
  for (const name of ["git", "flock"]) execFileSync(executable(name), ["--version"], { stdio: "ignore", timeout: 5000 });
  const lock = verb === "check" ? undefined : await acquire(path.join(home, "cross-agent-setup.lock"), { operation: "Codex setup", waitSeconds: 5 });
  let client;
  try {
    const state = ownedState(dir, home);
    if (pluginId && state && pluginId !== state.pluginId) throw new Error("remove the existing setup before selecting another plugin");
    client = await configClient(codex, home);
    const current = readLayer(await client.call("config/read", { includeLayers: true, cwd: process.cwd() }), home);
    const owned = managedConnection(current.entry, state);
    if (current.entry !== undefined && !owned) {
      throw new Error("cross-agent has a custom MCP registration; setup will not overwrite or remove it");
    }
    if (verb === "remove") {
      if (!state) { console.log("No managed cross-agent setup to remove."); return; }
      if (owned) {
        if (lock.lost) throw new Error("setup lock was lost");
        await client.call("config/batchWrite", { filePath: current.file, expectedVersion: current.version,
          edits: [{ keyPath: "mcp_servers.cross-agent", value: null, mergeStrategy: "replace" }] });
      }
      for (const name of ["serve.mjs", "state.json"]) fs.unlinkSync(path.join(dir, name));
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      console.log("Removed the managed MCP setup. The marketplace plugin and its skill remain installed. Restart Codex's MCP servers.");
      return;
    }
    const plugin = installedPlugin(verb === "check" && state ? state.codex : codex, home, pluginId ?? state?.pluginId);
    const launcher = path.join(dir, "serve.mjs");
    const desired = {
      startup_timeout_sec: 30, tool_timeout_sec: 3600, default_tools_approval_mode: "approve",
      ...(current.entry ?? {}), command: process.execPath, args: [launcher],
      env_vars: [...new Set([...(current.entry?.env_vars ?? []), ...markers])],
    };
    if (verb === "check") {
      if (!owned || !equal(current.entry, desired)) throw new Error("one-time MCP setup is missing or incomplete; run install");
      console.log(`Ready: ${plugin.pluginId} ${plugin.version}; server ${plugin.server}; project inherited from each chat. Restart existing MCP connections after changes.`);
      if (desired.enabled === false) console.log("The MCP server is disabled by your enabled=false policy; its tools will not connect.");
      return;
    }
    const next = { schema: 1, home, codex, pluginId: plugin.pluginId, managed: desired,
      previousManaged: owned ? current.entry : undefined };
    // Keep these files if a config write's reply is lost: it may have succeeded.
    // The next install/check reads Codex afresh and safely resumes.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicFile(launcher, fs.readFileSync(new URL("./codex-serve.mjs", import.meta.url), "utf8"));
    atomicFile(path.join(dir, "state.json"), JSON.stringify(next, null, 2) + "\n");
    if (!equal(current.entry, desired)) {
      if (lock.lost) throw new Error("setup lock was lost");
      await client.call("config/batchWrite", { filePath: current.file, expectedVersion: current.version,
        edits: [{ keyPath: "mcp_servers.cross-agent", value: desired, mergeStrategy: "replace" }] });
    }
    console.log(`Installed ${plugin.pluginId} ${plugin.version} MCP setup in ${current.file}. Restart Codex's MCP servers or open a new session, then call describe_mode to verify projectRoot. No per-session CROSS_AGENT_PROJECT is needed.`);
    if (desired.enabled === false) console.log("Your existing enabled=false policy was preserved; enable the MCP server when you want to use it.");
  } finally {
    await client?.close();
    await lock?.release();
  }
}

try { await main(); } catch (error) { console.error(`cross-agent setup: ${error.message}`); process.exitCode = 1; }
