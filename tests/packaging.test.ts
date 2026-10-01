import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Claude Code packaging (design section 9). The attach contract is a stdio MCP server plus
// the launcher skill; for this host that is one file — `.claude-plugin/plugin.json`, which
// names the plugin and declares the server under `mcpServers` — with `skills/` discovered
// by convention, both at the repository root, which is the plugin root `claude
// --plugin-dir <repo>` names. There is deliberately no `.mcp.json` beside it: that file is
// Claude Code's project-scoped config for this repository, not a plugin's. These tests pin
// the shape a host reads, not behaviour: what the manifest claims has to still be true of
// this repository.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function json(relative: string): Record<string, unknown> {
  const file = path.join(repoRoot, relative);
  assert.ok(fs.existsSync(file), `${relative} is missing`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("the plugin manifest names this plugin at package.json's version", () => {
  const manifest = json(".claude-plugin/plugin.json");
  const pkg = json("package.json");
  assert.equal(manifest.name, "cross-agent");
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(typeof manifest.description, "string");
  assert.notEqual(manifest.description, "");
});

test("the plugin manifest starts this server from the plugin root", () => {
  const manifest = json(".claude-plugin/plugin.json");
  const servers = manifest.mcpServers as Record<string, { command?: unknown; args?: unknown }>;
  assert.deepEqual(Object.keys(servers), ["cross-agent"]);
  const server = servers["cross-agent"];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/src/server.ts"]);
  // `${CLAUDE_PLUGIN_ROOT}` is this repository when the host is given `--plugin-dir <repo>`,
  // so the argument has to name a file that exists there.
  const args = server.args as string[];
  const entry = path.join(repoRoot, args[0].replace("${CLAUDE_PLUGIN_ROOT}/", ""));
  assert.ok(fs.statSync(entry).isFile(), `${entry} is not a file`);
});

test("no .mcp.json sits at the repository root, where it would be this project's own config", () => {
  // A repository-root `.mcp.json` is Claude Code's **project-scoped** MCP config: every
  // session opened in this repository is prompted to enable what it declares, and there
  // `${CLAUDE_PLUGIN_ROOT}` expands to nothing, so the offer is a server that cannot
  // start. The plugin's own manifest is the only place this server is declared.
  assert.equal(fs.existsSync(path.join(repoRoot, ".mcp.json")), false);
});

test("the skills directory the plugin ships by convention holds the launcher skill", () => {
  const manifest = json(".claude-plugin/plugin.json");
  // No `skills` key: the directory is found by convention, which is what the Codex fallback
  // copy of `skills/` alone depends on too (design section 9).
  assert.equal(manifest.skills, undefined);
  const skill = path.join(repoRoot, "skills", "cross-agent", "SKILL.md");
  assert.ok(fs.statSync(skill).isFile(), `${skill} is not a file`);
});

// Codex packaging (design section 9). Codex reads `.codex-plugin/plugin.json` at the plugin
// root and installs a plugin from a marketplace: a directory holding
// `.agents/plugins/marketplace.json`, which here is this repository, offering itself as its
// one plugin. Codex runs the plugin from a copy of it in its own cache, so the manifest names
// the server through `${PLUGIN_ROOT}` and nothing that belongs to one checkout.

/** The servers a Codex manifest declares, inline. */
function codexServers(manifest: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const servers = manifest.mcpServers;
  assert.ok(servers !== null && typeof servers === "object" && !Array.isArray(servers), "mcpServers is declared inline");
  return servers as Record<string, Record<string, unknown>>;
}

// @anchor codexManifestNames
test("the Codex manifest names this plugin at package.json's version and ships the skills directory", () => {
  const manifest = json(".codex-plugin/plugin.json");
  const claude = json(".claude-plugin/plugin.json");
  const pkg = json("package.json");
  assert.equal(manifest.name, "cross-agent");
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.name, claude.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.version, claude.version);
  assert.equal(typeof manifest.description, "string");
  assert.notEqual(manifest.description, "");
  // Codex finds a plugin's skills where `skills` points, relative to the plugin root.
  assert.equal(manifest.skills, "./skills/");
  const skill = path.join(repoRoot, "skills", "cross-agent", "SKILL.md");
  assert.ok(fs.statSync(skill).isFile(), `${skill} is not a file`);
});

// @anchor codexManifestMounts
test("the Codex manifest starts this server from the plugin root in the session's own directory, with a call budget and no approval prompt", () => {
  const servers = codexServers(json(".codex-plugin/plugin.json"));
  assert.deepEqual(Object.keys(servers), ["cross-agent"]);
  const server = servers["cross-agent"];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${PLUGIN_ROOT}/src/server.ts"]);
  const entry = path.join(repoRoot, (server.args as string[])[0].replace("${PLUGIN_ROOT}/", ""));
  assert.ok(fs.statSync(entry).isFile(), `${entry} is not a file`);
  // No `cwd`: the server starts where the session runs, and finds the project from there
  // (`src/project.ts#discoverProject`). A `cwd` inside the plugin would find the cache copy.
  assert.equal(Object.hasOwn(server, "cwd"), false);
  // A `wait` is a 600 s call, and Codex gives an MCP call 60 s unless the server says otherwise.
  assert.equal(server.tool_timeout_sec, 3600);
  // `codex exec` runs with approval policy `never`, which refuses every call that would ask (P9).
  assert.equal(server.default_tools_approval_mode, "approve");
  assert.equal(server.startup_timeout_sec, 30);
  // Whether the server runs is the operator's configuration's to say, never the product's.
  assert.equal(Object.hasOwn(server, "enabled"), false);
  // A value belongs to one machine, and Codex gives a stdio server the seven names it needs.
  assert.equal(Object.hasOwn(server, "env"), false);
  assert.equal(Object.hasOwn(server, "env_vars"), false);
});

// @anchor codexMarketplace
test("the repository is a marketplace offering this one plugin from its own root", () => {
  const marketplace = json(".agents/plugins/marketplace.json");
  assert.equal(marketplace.name, "agent-team-cli");
  const plugins = marketplace.plugins as Array<Record<string, unknown>>;
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, "cross-agent");
  // A local source path starts with `./` and stays inside the marketplace; `./` is its root.
  assert.deepEqual(plugins[0].source, { source: "local", path: "./" });
  assert.equal((plugins[0].policy as Record<string, unknown>).installation, "AVAILABLE");
});

test("the Claude and Codex manifests agree on the plugin's name, version and description", () => {
  const codex = json(".codex-plugin/plugin.json");
  const claude = json(".claude-plugin/plugin.json");
  for (const key of ["name", "version", "description"]) assert.equal(codex[key], claude[key], key);
});
