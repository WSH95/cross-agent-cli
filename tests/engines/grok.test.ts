import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import grok from "../../src/engines/grok.ts";
import { adapterFor, sandboxFor } from "../../src/engines/registry.ts";
import type { EngineAdapter, SpawnRequest } from "../../src/engines/types.ts";

const targets = Object.freeze([
  "claude", "codex", "grok", "/opt/custom codex", "node /projects/team/src/server.ts", "node /projects/team/src/cli.ts", "cross-agent",
]);

function withBin(t: TestContext, value: string | undefined): void {
  const previous = process.env.CROSS_AGENT_GROK_BIN;
  if (value === undefined) delete process.env.CROSS_AGENT_GROK_BIN;
  else process.env.CROSS_AGENT_GROK_BIN = value;
  t.after(() => {
    if (previous === undefined) delete process.env.CROSS_AGENT_GROK_BIN;
    else process.env.CROSS_AGENT_GROK_BIN = previous;
  });
}

function reasonFor(support: ReturnType<EngineAdapter["sandboxSupport"]>): string {
  if (support.ok) assert.fail("expected a refusal");
  return support.reason;
}

test("the built-in table answers for grok with this adapter", () => {
  assert.equal(adapterFor("grok"), grok);
  assert.equal(grok.name, "grok");
});

test("grok declares four profile names, two of which cannot write", () => {
  assert.deepEqual(grok.sandboxProfiles, { "read-only": "read-only", strict: "read-only", workspace: "write", off: "off" });
});

test("grok's denyArgs is one --deny per target, in the enforced form (P3)", () => {
  assert.deepEqual(grok.denyArgs(targets), [
    "--deny", "Bash(claude *)", "--deny", "Bash(codex *)", "--deny", "Bash(grok *)", "--deny", "Bash(/opt/custom codex *)",
    "--deny", "Bash(node /projects/team/src/server.ts *)", "--deny", "Bash(node /projects/team/src/cli.ts *)", "--deny", "Bash(cross-agent *)",
  ]);
  assert.deepEqual(grok.denyArgs([]), []);
});

test("grok has no per-invocation exclusion flag at all", () => {
  assert.deepEqual(grok.exclusionArgs(), []);
});

test("grok's leadMount inherits: there is no per-run mount to build (P9)", () => {
  const mount = grok.leadMount({ command: "node", args: ["/projects/team/src/server.ts"] }, "/scratch");
  assert.deepEqual(mount, { argv: [], inherited: true });
  // Whatever the spec says, the answer is the same: the operator's own registration is the mount.
  assert.deepEqual(grok.leadMount({ command: "other", args: ["--project", "/elsewhere"], env: { A: "1" } }, "/scratch"), { argv: [], inherited: true });
});

test("grok's sandbox support reports the binary it cannot resolve", (t) => {
  withBin(t, path.join(process.cwd(), "no-such-grok-binary"));
  const reason = reasonFor(grok.sandboxSupport());
  assert.match(reason, /no-such-grok-binary/);
  assert.match(reason, /grok/);
  withBin(t, process.execPath);
  assert.deepEqual(grok.sandboxSupport(), { ok: true });
});

test("sandboxFor pairs a profile with the mode grok gives it, and refuses any other", () => {
  for (const [profile, mode] of Object.entries(grok.sandboxProfiles)) {
    assert.deepEqual(sandboxFor("grok", profile), { mode, profile });
  }
  // Another engine's profile name, and names only Object.prototype carries.
  for (const profile of ["workspace-write", "toString", ""]) {
    assert.throws(() => sandboxFor("grok", profile), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("grok"), error.message);
      assert.ok(error.message.includes(JSON.stringify(profile)), error.message);
      return true;
    });
  }
});

test("the grok parts T9 owns are declared and refuse to run", () => {
  const calls: Array<() => unknown> = [
    () => grok.plan({} as SpawnRequest), () => grok.parseLine("{}"),
    // T9: delete the finish stub and this assertion — a line stream declares none.
    () => grok.finish!(""), () => grok.finalMessage([], null),
  ];
  for (const call of calls) assert.throws(call, /grok adapter: not implemented \(T7\/T8\/T9\)/);
});
