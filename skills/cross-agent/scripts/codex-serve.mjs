// Copied outside the versioned plugin cache by codex-setup.mjs. Keep this file
// self-contained: marketplace updates can remove the copy it was installed from.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function installedPlugin(codex, home, pluginId) {
  let inventory;
  try {
    inventory = JSON.parse(execFileSync(codex, ["plugin", "list", "--json"], {
      env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 10000,
      maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch (error) {
    throw new Error(`cannot read Codex's installed plugins: ${error.message}`);
  }
  if (!Array.isArray(inventory.installed)) throw new Error("Codex returned no installed-plugin inventory; update Codex and retry setup");
  const matches = inventory.installed.filter((p) => p.name === "cross-agent" && p.installed === true
    && (pluginId === undefined || p.pluginId === pluginId));
  if (matches.length !== 1) throw new Error(matches.length === 0
    ? `cross-agent is not installed${pluginId ? ` (${pluginId})` : ""}; install it through Codex's marketplace`
    : "several cross-agent plugins are installed; select one with --plugin <plugin-id>");
  const plugin = matches[0];
  if (plugin.enabled !== true) throw new Error(`${plugin.pluginId} is disabled in Codex; enable it before starting cross-agent`);
  const segment = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
  if (!segment(plugin.marketplaceName) || !segment(plugin.version)
      || plugin.pluginId !== `cross-agent@${plugin.marketplaceName}`) {
    throw new Error("Codex returned an invalid installed-plugin identity");
  }
  // Use the installed version, never a marketplace source or a spare cache.
  const cache = path.join(home, "plugins", "cache");
  const root = path.join(cache, plugin.marketplaceName, "cross-agent", plugin.version);
  const realRoot = fs.realpathSync(root);
  if (!realRoot.startsWith(fs.realpathSync(cache) + path.sep)) throw new Error("installed plugin resolves outside Codex's cache");
  const manifest = JSON.parse(fs.readFileSync(path.join(realRoot, ".codex-plugin/plugin.json"), "utf8"));
  if (manifest.name !== "cross-agent" || manifest.version !== plugin.version) {
    throw new Error("installed plugin manifest does not match Codex's inventory; repair the marketplace installation");
  }
  const server = fs.realpathSync(path.join(realRoot, "src/server.ts"));
  if (!server.startsWith(realRoot + path.sep) || !fs.statSync(server).isFile()) throw new Error("installed plugin has no local server");
  return { pluginId: plugin.pluginId, version: plugin.version, root: realRoot, server };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const state = JSON.parse(fs.readFileSync(new URL("./state.json", import.meta.url), "utf8"));
    if (state.schema !== 1 || !path.isAbsolute(state.home) || !path.isAbsolute(state.codex) || typeof state.pluginId !== "string") {
      throw new Error("invalid setup state; run cross-agent Codex setup again");
    }
    const plugin = installedPlugin(state.codex, state.home, state.pluginId);
    // No chdir and no marker filtering. execve keeps PID, stdio and ancestry;
    // the normal server remains responsible for authority.
    const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
    process.execve(process.execPath, [process.execPath, plugin.server], env);
  } catch (error) {
    console.error(`cross-agent: ${error.message}`);
    process.exitCode = 1;
  }
}
