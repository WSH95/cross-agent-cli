import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import claude from "../../src/engines/claude.ts";
import { adapterFor } from "../../src/engines/registry.ts";
import type { EngineAdapter, SpawnRequest } from "../../src/engines/types.ts";

// The deny list design section 3 builds at spawn: the three CLIs, a configured binary,
// this server, this CLI, and the operator command.
const targets = Object.freeze([
  "claude", "codex", "grok", "/opt/custom codex", "node /projects/team/src/server.ts", "node /projects/team/src/cli.ts", "cross-agent",
]);

function scratch(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), "cross-agent-claude-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function withPath(t: TestContext, value: string): void {
  const previous = process.env.PATH;
  process.env.PATH = value;
  t.after(() => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
}

function reasonFor(support: ReturnType<EngineAdapter["sandboxSupport"]>): string {
  if (support.ok) assert.fail("expected a refusal");
  return support.reason;
}

function executable(directory: string, name: string): void {
  const file = path.join(directory, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
}

test("the built-in table answers for claude with this adapter", () => {
  assert.equal(adapterFor("claude"), claude);
  assert.equal(claude.name, "claude");
});

test("claude declares its own profile names and what each one means", () => {
  assert.deepEqual(claude.sandboxProfiles, { "read-only": "read-only", "workspace-write": "write", off: "off" });
});

test("claude's denyArgs is one appendable --disallowedTools array carrying both forms", () => {
  assert.deepEqual(claude.denyArgs(targets), [
    "--disallowedTools", "Bash(claude *)", "Bash(claude)", "Bash(codex *)", "Bash(codex)",
    "Bash(grok *)", "Bash(grok)", "Bash(/opt/custom codex *)", "Bash(/opt/custom codex)",
    "Bash(node /projects/team/src/server.ts *)", "Bash(node /projects/team/src/server.ts)",
    "Bash(node /projects/team/src/cli.ts *)", "Bash(node /projects/team/src/cli.ts)", "Bash(cross-agent *)", "Bash(cross-agent)",
  ]);
});

test("claude's exclusionArgs is the flag that makes a mount exclusive", () => {
  assert.deepEqual(claude.exclusionArgs(), ["--strict-mcp-config"]);
});

test("claude's leadMount returns the config file and the flag that points at it (P9)", (t) => {
  const directory = scratch(t);
  const spec = {
    command: process.execPath,
    args: ["/projects/team/src/server.ts", "--project", "/projects/team"],
    env: { CROSS_AGENT_PROJECT: "/projects/team" },
  };
  const mount = claude.leadMount(spec, directory);
  const file = path.join(directory, "mcp-config.json");
  assert.deepEqual(mount.argv, ["--mcp-config", file]);
  assert.equal(mount.inherited, undefined);
  assert.deepEqual(mount.files?.map((entry) => entry.path), [file]);
  // The adapter is a pure argv builder: the pipeline writes what it returns.
  assert.equal(existsSync(file), false);
  assert.deepEqual(JSON.parse(mount.files![0].contents), {
    mcpServers: { "cross-agent": { command: spec.command, args: spec.args, env: spec.env } },
  });
  // Exclusivity is `--strict-mcp-config`'s, not the config file's, so it stays in exclusionArgs.
  assert.equal(mount.argv.includes("--strict-mcp-config"), false);
  const bare = claude.leadMount({ command: "node", args: [] }, directory);
  assert.deepEqual(JSON.parse(bare.files![0].contents), { mcpServers: { "cross-agent": { command: "node", args: [] } } });
});

test("claude's sandbox support names the Linux prerequisites it cannot find (P1)", (t) => {
  const directory = scratch(t);
  withPath(t, directory);
  if (process.platform !== "linux") {
    // P1 probed Linux. Nothing here has observed another platform's sandbox, and the
    // engine refuses on its own if its own sandbox cannot start.
    assert.deepEqual(claude.sandboxSupport(), { ok: true });
    return;
  }
  // The reason names what is missing, not merely what is needed.
  assert.match(reasonFor(claude.sandboxSupport()), /^bwrap and socat not found on PATH/);
  executable(directory, "bwrap");
  assert.match(reasonFor(claude.sandboxSupport()), /^socat not found on PATH/);
  executable(directory, "socat");
  assert.deepEqual(claude.sandboxSupport(), { ok: true });
});

test("the claude parts T7 owns are declared and refuse to run", () => {
  const calls: Array<() => unknown> = [
    () => claude.plan({} as SpawnRequest), () => claude.parseLine("{}"),
    () => claude.finish!(""), () => claude.finalMessage([], null),
  ];
  for (const call of calls) assert.throws(call, /claude adapter: not implemented \(T7\/T8\/T9\)/);
});
