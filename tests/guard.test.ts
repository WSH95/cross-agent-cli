import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CrossAgentConfig } from "../src/config.ts";
import type { TaskRecord, TaskStatus } from "../src/ledger.ts";
import {
  readDepth, toolsAtDepth, parseLineage, formatLineage, childLineage, lineageRefusal,
  duplicateRefusal, resumeRefusal, denyTargets, denyArgs, exclusionArgs, childEnv,
} from "../src/guard.ts";

const now = 1_000_000;
const windowMinutes = 10;
const windowMs = windowMinutes * 60_000;
const activeStatuses: TaskStatus[] = ["launching", "running", "stalled", "orphaned", "cancelling"];
const terminalStatuses: TaskStatus[] = ["done", "failed", "cancelled"];
const request = Object.freeze({
  role: "implementer",
  cwd: "/projects/team/.worktrees/guard",
  brief: "Implement the loop guard.\nPreserve raw bytes — 🌙.\n",
});
const resumeRequest = Object.freeze({
  role: request.role, cwd: request.cwd, engine: "codex", sandbox: "workspace-write",
} as const);

function record(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-original", role: request.role, cwd: request.cwd, engine: "codex",
    briefHash: createHash("sha256").update(request.brief).digest("hex"),
    status: "done", createdAt: now - 2 * windowMs, updatedAt: now - 1,
    launchDeadline: now - 2 * windowMs + 30_000,
    resultPath: "/projects/team/.cross-agent/tasks/task-original.out",
    logPath: "/projects/team/.cross-agent/tasks/task-original.ndjson",
    ...patch,
  };
}

const config: CrossAgentConfig = {
  project: { defaultBranch: "main", testCommand: "npm test", setupCommand: "none", mergePolicy: "auto" },
  roles: {},
  engines: {
    claude: { bin: "/opt/engines/claude" }, codex: { bin: "/opt/custom codex" },
    grok: { bin: "/opt/engines/grok" }, custom: { bin: "/opt/wrapper" }, unconfigured: {},
  },
  limits: { maxDepth: 1, stallMinutes: 15, waitDefaultSeconds: 600, duplicateWindowMinutes: windowMinutes },
  billing: "subscription",
};

test("readDepth accepts absent, zero, and one; rejects malformed or missing child depth", () => {
  assert.deepEqual(readDepth({}), { depth: 0 });
  assert.deepEqual(readDepth({ CROSS_AGENT_DEPTH: undefined, CROSS_AGENT_LINEAGE: undefined }), { depth: 0 });
  for (const value of ["0", "1", "12", "001", String(Number.MAX_SAFE_INTEGER)]) {
    assert.deepEqual(readDepth({ CROSS_AGENT_DEPTH: value }), { depth: Number(value) });
    assert.deepEqual(readDepth({ CROSS_AGENT_DEPTH: value, CROSS_AGENT_LINEAGE: "[]" }), { depth: Number(value) });
  }
  for (const value of [
    "abc", "-1", "", " ", "1.5", "1e2", "0x10", "+1", " 1", "1 ", "1\n",
    "Infinity", "NaN", "9007199254740992", "9".repeat(400),
  ]) {
    const result = readDepth({ CROSS_AGENT_DEPTH: value });
    assert.equal(result.depth, Infinity, JSON.stringify(value));
    assert.match(result.reason!, /CROSS_AGENT_DEPTH/);
  }
  for (const value of ["[]", "", "malformed"]) {
    const result = readDepth({ CROSS_AGENT_LINEAGE: value });
    assert.equal(result.depth, Infinity);
    assert.match(result.reason!, /CROSS_AGENT_LINEAGE/);
    assert.match(result.reason!, /CROSS_AGENT_DEPTH/);
  }
});

test("toolsAtDepth returns exact full and restricted tool lists", () => {
  const full = ["list_roles", "delegate", "wait", "check", "result", "cancel", "list_tasks", "verify_worktree", "git_mutate"];
  const restricted = ["list_roles", "list_tasks", "check", "result"];
  assert.deepEqual(toolsAtDepth(0, 1), full);
  assert.deepEqual(toolsAtDepth(1, 2), full);
  for (const depth of [1, 2, Infinity]) assert.deepEqual(toolsAtDepth(depth, 1), restricted);
  assert.deepEqual(toolsAtDepth(0, 0), restricted);
});

test("lineage round-trips ordered entries and appends without mutation", () => {
  const parent = Object.freeze([
    Object.freeze({ taskId: "parent", role: "planner", cwd: "/projects/team" }),
    Object.freeze({ taskId: 'task-"quoted"', role: "reviewer\\custom", cwd: '/projects/space and \"quotes\"/日本語\nline' }),
  ]);
  const entry = Object.freeze({ taskId: "child", role: request.role, cwd: request.cwd });
  const before = structuredClone(parent);
  const appended = childLineage(parent, entry);
  assert.deepEqual(appended, [...parent, entry]);
  assert.notEqual(appended, parent);
  assert.deepEqual(parent, before);
  assert.equal(formatLineage(parent), JSON.stringify(parent));
  assert.deepEqual(parseLineage(formatLineage(parent)), parent);
  assert.deepEqual(parseLineage(formatLineage(appended)), appended);
  assert.deepEqual(childLineage([], entry), [entry]);
  assert.deepEqual(parseLineage(undefined), []);
  assert.deepEqual(parseLineage("[]"), []);
  assert.equal(formatLineage([]), "[]");
});

test("parseLineage rejects malformed supplied lineage", () => {
  for (const value of ["", " ", "not JSON", "[", "null", "{}", "true", "42", '"lineage"']) {
    assert.throws(() => parseLineage(value), /CROSS_AGENT_LINEAGE/, value);
  }
  const valid = { taskId: "parent", role: "planner", cwd: "/projects/team" };
  for (const entry of [
    null, [], "entry", 1, {}, { role: valid.role, cwd: valid.cwd },
    { taskId: valid.taskId, cwd: valid.cwd }, { taskId: valid.taskId, role: valid.role },
    { ...valid, taskId: 1 }, { ...valid, role: null }, { ...valid, cwd: [] },
  ]) {
    assert.throws(() => parseLineage(JSON.stringify([valid, entry])), /CROSS_AGENT_LINEAGE/);
  }
});

test("lineageRefusal rejects a repeated role and canonical cwd without alternatives", () => {
  const ancestor = { taskId: "parent-implementer", role: request.role, cwd: request.cwd };
  const lineage = [{ taskId: "parent-planner", role: "planner", cwd: "/projects/team" }, ancestor];
  const refusal = lineageRefusal(lineage, request.role, request.cwd);
  assert.ok(refusal);
  for (const value of [ancestor.taskId, ancestor.role, ancestor.cwd]) assert.ok(refusal.includes(value), refusal);
  assert.match(refusal, /refus/i);
  assert.match(refusal, /lineage/i);
  assert.doesNotMatch(refusal, /\b(try|instead|alternative|retry|force)\b/i);
  assert.equal(lineageRefusal(lineage, "code-reviewer", request.cwd), null);
  assert.equal(lineageRefusal(lineage, request.role, "/projects/team/.worktrees/other"), null);
  assert.equal(lineageRefusal([], request.role, request.cwd), null);
});

test("duplicateRefusal rejects every active status even with force", () => {
  const finished = Object.freeze(record({ id: "finished" }));
  for (const status of activeStatuses) {
    const active = Object.freeze(record({ id: `active-${status}`, status, updatedAt: now - windowMs - 1 }));
    for (const force of [undefined, false, true]) {
      for (const records of [[active], [finished, active], [active, finished]]) {
        assert.equal(
          duplicateRefusal({ ...request, force }, Object.freeze(records), now, windowMinutes),
          `already running, wait on ${active.id}`,
        );
      }
    }
  }
});

test("duplicateRefusal applies the finished window and force", () => {
  for (const status of terminalStatuses) {
    for (const age of [0, 1, windowMs - 1, windowMs]) {
      const finished = record({ status, updatedAt: now - age, lastEventAt: now - 2 * windowMs });
      const refusal = duplicateRefusal(request, [finished], now, windowMinutes);
      assert.ok(refusal, `${status} finished ${age}ms ago`);
      assert.ok(refusal.includes(finished.id), refusal);
      assert.match(refusal, /finished/i);
      assert.equal(duplicateRefusal({ ...request, force: false }, [finished], now, windowMinutes), refusal);
      assert.equal(duplicateRefusal({ ...request, force: true }, [finished], now, windowMinutes), null);
    }
    const old = record({ status, createdAt: now, updatedAt: now - windowMs - 1, lastEventAt: now });
    assert.equal(duplicateRefusal(request, [old], now, windowMinutes), null);
    assert.equal(duplicateRefusal({ ...request, force: true }, [old], now, windowMinutes), null);
    const recent = record({ id: "recent", status });
    assert.ok(duplicateRefusal(request, [old, recent], now, windowMinutes)?.includes(recent.id));
  }
  assert.equal(duplicateRefusal(request, [record({ updatedAt: now - 1 })], now, 0), null);
  assert.ok(duplicateRefusal(request, [record({ updatedAt: now })], now, 0));
});

test("duplicateRefusal allows different briefs, roles, and cwd values", () => {
  for (const status of [...activeStatuses, ...terminalStatuses]) {
    const records = [record({ status })];
    for (const brief of ["Different task", request.brief.trim(), request.brief.replaceAll("\n", "\r\n"), `${request.brief} `]) {
      assert.equal(duplicateRefusal({ ...request, brief }, records, now, windowMinutes), null);
    }
    assert.equal(duplicateRefusal({ ...request, role: "planner" }, records, now, windowMinutes), null);
    assert.equal(duplicateRefusal({ ...request, cwd: "/projects/team" }, records, now, windowMinutes), null);
  }
  assert.equal(duplicateRefusal(request, [], now, windowMinutes), null);
});

test("resumeRefusal rejects active records and each mismatched binding field", () => {
  for (const status of activeStatuses) {
    const active = { ...record({ status }), sandbox: resumeRequest.sandbox };
    const refusal = resumeRefusal(resumeRequest, active);
    assert.ok(refusal);
    assert.ok(refusal.includes(active.id), refusal);
    assert.ok(refusal.includes(status), refusal);
    assert.match(refusal, /active/i);
  }
  const finished = { ...record(), sandbox: resumeRequest.sandbox };
  for (const [field, changed] of [
    ["role", { ...resumeRequest, role: "planner" }],
    ["engine", { ...resumeRequest, engine: "grok" as const }],
    ["cwd", { ...resumeRequest, cwd: "/projects/team" }],
    ["sandbox", { ...resumeRequest, sandbox: "read-only" as const }],
  ] as const) {
    const refusal = resumeRefusal(changed, finished);
    assert.ok(refusal);
    assert.ok(refusal.includes(finished.id), refusal);
    assert.ok(refusal.includes(field), refusal);
  }
});

test("resumeRefusal accepts matching terminal records and refuses missing sandbox metadata", () => {
  for (const status of terminalStatuses) {
    const finished = Object.freeze(record({ status }));
    assert.equal(resumeRefusal(resumeRequest, { ...finished, sandbox: resumeRequest.sandbox }), null);
    const refusal = resumeRefusal(resumeRequest, finished);
    assert.ok(refusal);
    assert.ok(refusal.includes(finished.id), refusal);
    assert.match(refusal, /sandbox/);
    assert.match(refusal, /missing|unknown|unavailable/i);
  }
});

test("denyTargets includes configured binaries and both entrypoints", () => {
  const before = structuredClone(config);
  assert.deepEqual(denyTargets(config, "/projects/team"), [
    "claude", "codex", "grok", "/opt/engines/claude", "/opt/custom codex", "/opt/engines/grok", "/opt/wrapper",
    "node /projects/team/src/server.ts", "node /projects/team/src/cli.ts", "cross-agent",
  ]);
  const { engines, ...withoutEngines } = config;
  for (const plain of [withoutEngines, { ...config, engines: {} }]) {
    assert.deepEqual(denyTargets(plain, "/projects/space team/"), [
      "claude", "codex", "grok", "node /projects/space team/src/server.ts", "node /projects/space team/src/cli.ts", "cross-agent",
    ]);
  }
  assert.deepEqual(config, before);
});

test("denyArgs matches exact Claude, Grok, and Codex arrays", () => {
  const targets = Object.freeze([
    "claude", "codex", "grok", "/opt/custom codex", "node /projects/team/src/server.ts", "node /projects/team/src/cli.ts", "cross-agent",
  ]);
  assert.deepEqual(denyArgs("claude", targets), [
    "--disallowedTools", "Bash(claude *)", "Bash(claude)", "Bash(codex *)", "Bash(codex)",
    "Bash(grok *)", "Bash(grok)", "Bash(/opt/custom codex *)", "Bash(/opt/custom codex)",
    "Bash(node /projects/team/src/server.ts *)", "Bash(node /projects/team/src/server.ts)",
    "Bash(node /projects/team/src/cli.ts *)", "Bash(node /projects/team/src/cli.ts)", "Bash(cross-agent *)", "Bash(cross-agent)",
  ]);
  assert.deepEqual(denyArgs("grok", targets), [
    "--deny", "Bash(claude *)", "--deny", "Bash(codex *)", "--deny", "Bash(grok *)", "--deny", "Bash(/opt/custom codex *)",
    "--deny", "Bash(node /projects/team/src/server.ts *)", "--deny", "Bash(node /projects/team/src/cli.ts *)", "--deny", "Bash(cross-agent *)",
  ]);
  assert.deepEqual(denyArgs("codex", targets), []);
});

test("exclusionArgs returns the probed flags for each engine", () => {
  assert.deepEqual(exclusionArgs("claude"), ["--strict-mcp-config"]);
  assert.deepEqual(exclusionArgs("codex"), ["--ignore-user-config"]);
  assert.deepEqual(exclusionArgs("grok"), []);
});

const retainedEnv = Object.freeze({
  PATH: "/usr/bin:/bin", HOME: "/home/test", XDG_CONFIG_HOME: "/home/test/.config", XDG_CACHE_HOME: "/home/test/.cache",
  CODEX_HOME: "/home/test/.codex", LANG: "en_US.UTF-8", OTHER: "keep", UNSET: undefined,
  CLAUDECODE_EXTRA: "keep", CLAUDE_PID_EXTRA: "keep", CLAUDE_EFFORT_EXTRA: "keep",
  CLAUDE_CODE: "keep", CLAUDE_PLUGIN: "keep", CODEX_COMPANION: "keep", GROK_CC: "keep", MCP: "keep",
  OTHER_MCP_SERVER: "keep", OPENAI_API_KEY_BACKUP: "keep",
});
const strippedEnv = Object.freeze({
  CLAUDECODE: "nested", CLAUDE_PID: "123", CLAUDE_EFFORT: "high",
  CLAUDE_CODE_: "marker", CLAUDE_CODE_SESSION: "session", CLAUDE_CODE_OTHER: "other",
  CLAUDE_PLUGIN_: "marker", CLAUDE_PLUGIN_ROOT: "/plugins", CLAUDE_PLUGIN_OTHER: "other",
  CODEX_COMPANION_: "marker", CODEX_COMPANION_SESSION: "session", CODEX_COMPANION_OTHER: "other",
  GROK_CC_: "marker", GROK_CC_SESSION: "session", GROK_CC_OTHER: "other",
  MCP_: "marker", MCP_SERVER: "server", MCP_OTHER: "other",
});
const apiKeys = Object.freeze({ ANTHROPIC_API_KEY: "anthropic-test", OPENAI_API_KEY: "openai-test", XAI_API_KEY: "xai-test" });
const childEntries = Object.freeze([Object.freeze({ taskId: "child", role: request.role, cwd: request.cwd })]);

test("childEnv strips every specified marker and subscription API key", () => {
  const parent = Object.freeze({ ...retainedEnv, ...strippedEnv, ...apiKeys, CROSS_AGENT_DEPTH: "9", CROSS_AGENT_TASK: "parent", CROSS_AGENT_LINEAGE: "[]" });
  const before = structuredClone(parent);
  const child = childEnv(parent, 0, "child", childEntries, "subscription");
  assert.deepEqual(child, {
    ...retainedEnv, CROSS_AGENT_DEPTH: "1", CROSS_AGENT_TASK: "child", CROSS_AGENT_LINEAGE: JSON.stringify(childEntries),
  });
  for (const key of [...Object.keys(strippedEnv), ...Object.keys(apiKeys)]) assert.equal(Object.hasOwn(child, key), false, key);
  assert.deepEqual(parent, before);
  assert.notEqual(child, parent);
});

test("childEnv preserves API billing credentials and sets all CROSS_AGENT variables without mutation", () => {
  const parent = Object.freeze({ ...retainedEnv, ...strippedEnv, ...apiKeys });
  const before = structuredClone(parent);
  const child = childEnv(parent, 2, "child", childEntries, "api");
  assert.deepEqual(child, {
    ...retainedEnv, ...apiKeys, CROSS_AGENT_DEPTH: "3", CROSS_AGENT_TASK: "child", CROSS_AGENT_LINEAGE: JSON.stringify(childEntries),
  });
  assert.deepEqual(parseLineage(child.CROSS_AGENT_LINEAGE), childEntries);
  assert.deepEqual(parent, before);
  assert.deepEqual(childEnv({}, 0, "root-child", [], "subscription"), {
    CROSS_AGENT_DEPTH: "1", CROSS_AGENT_TASK: "root-child", CROSS_AGENT_LINEAGE: "[]",
  });
});
