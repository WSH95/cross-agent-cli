import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Claude Code packaging (design section 9). The attach contract is a stdio MCP server plus
// the launcher skill; for this host that is `.claude-plugin/plugin.json` beside `.mcp.json`
// with `skills/` discovered by convention, all three at the repository root, which is the
// plugin root `claude --plugin-dir <repo>` names. These tests pin the shape a host reads,
// not behaviour: what the manifests claim has to still be true of this repository.

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
