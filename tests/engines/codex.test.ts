import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import codex from "../../src/engines/codex.ts";
import { adapterFor, sandboxFor } from "../../src/engines/registry.ts";
import type { EngineAdapter, SpawnRequest } from "../../src/engines/types.ts";

const targets = Object.freeze([
  "claude", "codex", "grok", "/opt/custom codex", "node /projects/team/src/server.ts", "node /projects/team/src/cli.ts", "cross-agent",
]);

function withBin(t: TestContext, value: string | undefined): void {
  const previous = process.env.CROSS_AGENT_CODEX_BIN;
  if (value === undefined) delete process.env.CROSS_AGENT_CODEX_BIN;
  else process.env.CROSS_AGENT_CODEX_BIN = value;
  t.after(() => {
    if (previous === undefined) delete process.env.CROSS_AGENT_CODEX_BIN;
    else process.env.CROSS_AGENT_CODEX_BIN = previous;
  });
}

function reasonFor(support: ReturnType<EngineAdapter["sandboxSupport"]>): string {
  if (support.ok) assert.fail("expected a refusal");
  return support.reason;
}

test("the built-in table answers for codex with this adapter", () => {
  assert.equal(adapterFor("codex"), codex);
  assert.equal(codex.name, "codex");
});

test("codex declares its own profile names and what each one means", () => {
  // `off` is `--sandbox danger-full-access` in argv, which is T8's concern, not this map's.
  assert.deepEqual(codex.sandboxProfiles, { "read-only": "read-only", "workspace-write": "write", off: "off" });
});

test("codex carries no deny list: its sandbox's network denial is that layer (P3/P3b)", () => {
  assert.deepEqual(codex.denyArgs(targets), []);
  assert.deepEqual(codex.denyArgs([]), []);
});

test("codex's exclusionArgs removes the operator's own configuration", () => {
  assert.deepEqual(codex.exclusionArgs(), ["--ignore-user-config"]);
});

test("codex's leadMount is the three -c settings P9 recorded, byte for byte", () => {
  const mount = codex.leadMount({ command: "node", args: ["/projects/team/src/server.ts"] }, "/projects/team/.cross-agent/tasks/task");
  assert.deepEqual(mount.argv, [
    "-c", 'mcp_servers.cross-agent.command="node"',
    "-c", 'mcp_servers.cross-agent.args=["/projects/team/src/server.ts"]',
    "-c", 'mcp_servers.cross-agent.default_tools_approval_mode="approve"',
  ]);
  // Nothing to write, and nothing inherited: the mount is entirely in the argv.
  assert.equal(mount.files, undefined);
  assert.equal(mount.inherited, undefined);
  // TOML values, so a value that needs quoting gets it.
  const quoted = codex.leadMount({ command: "/opt/my node", args: ["--project", 'C:\\team"x"'] }, "/scratch");
  assert.deepEqual(quoted.argv.slice(0, 4), [
    "-c", 'mcp_servers.cross-agent.command="/opt/my node"',
    "-c", 'mcp_servers.cross-agent.args=["--project","C:\\\\team\\"x\\""]',
  ]);
});

test("codex's leadMount refuses an environment no probed setting can carry", () => {
  const spec = { command: "node", args: ["/projects/team/src/server.ts"], env: { CROSS_AGENT_PROJECT: "/projects/team" } };
  assert.throws(() => codex.leadMount(spec, "/scratch"), /codex leadMount.*env/i);
  // An empty one asks for nothing, so it is the same mount as none at all.
  assert.deepEqual(codex.leadMount({ ...spec, env: {} }, "/scratch").argv, codex.leadMount({ command: spec.command, args: spec.args }, "/scratch").argv);
});

test("codex's sandbox support reports the binary it cannot resolve", (t) => {
  withBin(t, path.join(process.cwd(), "no-such-codex-binary"));
  const reason = reasonFor(codex.sandboxSupport());
  assert.match(reason, /no-such-codex-binary/);
  assert.match(reason, /codex/);
  withBin(t, process.execPath);
  assert.deepEqual(codex.sandboxSupport(), { ok: true });
});

test("sandboxFor pairs a profile with the mode codex gives it, and refuses any other", () => {
  for (const [profile, mode] of Object.entries(codex.sandboxProfiles)) {
    assert.deepEqual(sandboxFor("codex", profile), { mode, profile });
  }
  // Another engine's profile name, and names only Object.prototype carries.
  for (const profile of ["strict", "workspace", "toString", ""]) {
    assert.throws(() => sandboxFor("codex", profile), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("codex"), error.message);
      assert.ok(error.message.includes(JSON.stringify(profile)), error.message);
      return true;
    });
  }
});

test("the codex parts T8 owns are declared and refuse to run", () => {
  const calls: Array<() => unknown> = [
    () => codex.plan({} as SpawnRequest), () => codex.parseLine("{}"),
    // T8: delete the finish stub and this assertion — a line stream declares none.
    () => codex.finish!(""), () => codex.finalMessage([], null),
  ];
  for (const call of calls) assert.throws(call, /codex adapter: not implemented \(T7\/T8\/T9\)/);
});
