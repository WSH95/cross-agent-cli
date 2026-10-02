import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Authority } from "../src/authority.ts";
import { CONFIG_PATH } from "../src/config.ts";
import { delegate, writableProfiles } from "../src/delegate.ts";
import type { DelegateRequest } from "../src/delegate.ts";
import { readJournal } from "../src/journal.ts";
import { create, readSpec, update, writeSpec } from "../src/ledger.ts";
import { reservedBy } from "../src/reservation.ts";
import { verifyWorktree } from "../src/worktree.ts";
import { sandboxFor } from "../src/engines/registry.ts";
import { engineNames } from "../src/engines/types.ts";
import type { LaunchSpec, TaskRecord } from "../src/ledger.ts";
import { acquire, gitLockName, lockPath, repositoryLockPath, spawnLockName } from "../src/locks.ts";
import { buildMode } from "./helpers/mode.ts";
import type { RoleSpec } from "./helpers/mode.ts";
import { git, gitShim } from "./helpers/git.ts";
import { alive, engineEnv, environOf, killLockHolder, poll, reserve, waitForRecord, pollDeadlineMs, project } from "./helpers/project.ts";
import type { TestProject } from "./helpers/project.ts";

const operator: Authority = { row: "operator", reason: "operator: no CROSS_AGENT_* variable and no engine ancestor", depth: 0 };

function lead(taskId: string, depth = 1): Authority {
  return { row: "lead", reason: `lead by ancestry: task ${taskId} (lead, running)`, taskId, depth };
}

// The roles this suite's mode declares: where each one works and what profile it defaults
// to, which is the mode's half of a role. The lead is engine-placed, so `delegate` has a
// lead role to refuse. Grok's own write profile is `workspace`, and the mode names the
// default its bound engine will have to accept.
const modeRoles: RoleSpec[] = [
  { key: "planner" },
  { key: "implementer", workspace: "worktree", sandboxDefault: "workspace" },
  { key: "reviewer", workspace: "worktree", sandboxDefault: "read-only" },
  { key: "lead" },
  { key: "claudish" },
];
const modePatch = { lead: { placement: "engine", role: "lead" } };

function configFor(bin: string, limits: Record<string, number> = {}): Record<string, unknown> {
  return {
    roles: {
      planner: { engine: "grok", prompt: "You are the planner. Report a plan." },
      implementer: { engine: "grok" },
      reviewer: { engine: "grok" },
      // The mode places its lead in an engine, and grok cannot carry one (P9), so the
      // fixture binds it to codex — whose sandbox check is its binary resolving, which
      // keeps this suite off the host's bwrap and socat.
      lead: { engine: "codex" },
    },
    engines: { grok: { bin }, codex: { bin } },
    // The two wall-clock budgets these tools ride on, set far past anything the tests
    // below need: how long a write waits for a record another writer holds, and how long
    // a cancel gives a runner to settle. Left small they are margins a loaded machine can
    // miss, and the test then fails for the load rather than for the behaviour. Each test
    // that is about one of the budgets sets its own.
    limits: { maxDepth: 2, lockWaitSeconds: 30, duplicateWindowMinutes: 10, cancelGraceSeconds: 30, ...limits },
    billing: "subscription",
  };
}

async function projectWithRoles(t: TestContext, limits: Record<string, number> = {}): Promise<TestProject> {
  // A placeholder that need not exist: it only seeds `project`'s config, which the next
  // line rewrites with the project's own engine shim before anything reads a binary.
  const bin = path.join(tmpdir(), "cross-agent-unused-bin");
  const created = await project(t, configFor(bin, limits), modeRoles, modePatch);
  fs.writeFileSync(path.join(created.root, ".cross-agent", "config.json"), JSON.stringify(configFor(created.bin, limits)));
  return created;
}

function request(patch: Partial<DelegateRequest> & Pick<DelegateRequest, "role" | "cwd">): DelegateRequest {
  return { brief: "Do the work of this brief.", ...patch };
}

function refusal(result: Awaited<ReturnType<typeof delegate>>): string {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  return result.reason;
}

function launched(result: Awaited<ReturnType<typeof delegate>>): string {
  assert.equal(result.ok, true, `expected a launch, got ${JSON.stringify(result)}`);
  return result.taskId;
}

/** A task of this project, settled or not, written straight to the ledger. */
async function seed(
  root: string, values: {
    role: string; cwd: string; status?: TaskRecord["status"]; parentTaskId?: string; depth?: number;
    profile?: string; sessionId?: string | null; resumedFrom?: string;
  },
): Promise<TaskRecord> {
  const record = create(root, {
    role: values.role, brief: `seeded ${values.role}`, cwd: values.cwd, engine: "grok",
    depth: values.depth ?? 1, parentTaskId: values.parentTaskId, resumedFrom: values.resumedFrom,
  });
  // The spec a launch would have written beside it: without one the record holds its
  // workspace whatever its sandbox, which is the rule for a spec nobody can read.
  writeSpec(root, record.id, {
    role: values.role, brief: `seeded ${values.role}`, rolePrompt: "seeded", cwd: values.cwd, engine: "grok",
    sandbox: sandboxFor("grok", values.profile ?? "read-only"), sessionId: "seeded-launch-session",
    denyTargets: [], env: {}, scratchDir: path.dirname(record.logPath),
    adapterModule: path.join(fs.realpathSync(path.join(import.meta.dirname, "..")), "src", "engines", "grok.ts"),
  });
  // Null is a task that never announced one, which is what a `resume` of it must refuse.
  const sessionId = values.sessionId === undefined ? "seeded-session" : values.sessionId;
  assert.equal((await update(root, record.id, { sessionId })).applied, true);
  if (!values.status || values.status === "launching") return record;
  const result = await update(root, record.id, { status: values.status });
  assert.equal(result.applied, true);
  return result.record;
}

/** Settles a launched task the way a cancel would, so the next delegation is not a duplicate. */
async function settle(p: TestProject, id: string): Promise<TaskRecord> {
  assert.equal((await update(p.root, id, { status: "cancelling" })).applied, true);
  const settled = await update(p.root, id, { status: "cancelled" });
  assert.equal(settled.applied, true);
  const record = p.record(id);
  if (record.engineIdentity) {
    const { terminateGroup } = await import("../src/process.ts");
    await terminateGroup(record.engineIdentity);
  }
  return settled.record;
}

test("a delegation launches its engine once, in the workspace, with the environment the spec carries", async (t) => {
  const p = await projectWithRoles(t);
  const record = path.join(p.root, "invocation.json");
  const launch = await delegate(p.root, request({ role: "planner", cwd: p.root, model: "grok-4.6", effort: "high" }), {
    authority: operator, mode: p.mode,
    env: engineEnv(p, { FAKE_ENGINE_RECORD: record, CLAUDECODE: "1", MCP_SERVER: "operator's own" }),
  });
  const id = launched(launch);

  // The record is the launch, and the runner settles it without the server's help.
  const done = await waitForRecord(p, id, (value) => value.status === "done");
  assert.equal(done.role, "planner");
  assert.equal(done.engine, "grok");
  assert.equal(done.model, "grok-4.6");
  assert.equal(done.effort, "high");
  assert.equal(done.depth, 1, "the operator is at depth 0, so its specialist is at 1");
  assert.equal(done.parentTaskId, undefined, "no lead delegated this");
  assert.equal(done.cwd, p.root);
  assert.ok(done.sessionId);

  // The task's own scratch directory, which nothing else shares.
  const scratch = path.join(p.root, ".cross-agent", "tasks", `${id}.scratch`);
  assert.equal(fs.statSync(scratch).isDirectory(), true);
  assert.equal(fs.statSync(scratch).mode & 0o777, 0o700);

  const spec = readSpec(p.root, id);
  assert.equal(spec.scratchDir, scratch);
  assert.equal(spec.cwd, p.root);
  assert.equal(spec.rolePrompt, "You are the planner. Report a plan.");
  assert.deepEqual(spec.sandbox, { mode: "read-only", profile: "read-only" });
  assert.equal(spec.adapterModule, path.join(fs.realpathSync(path.join(import.meta.dirname, "..")), "src", "engines", "grok.ts"));
  assert.ok(spec.denyTargets.includes("cross-agent"), "the deny list is rebuilt from config at every launch");
  assert.ok(spec.denyTargets.includes(p.bin), "the configured binary is a deny target too");
  // This repository's entry points, not the project's: the server a specialist could
  // start lives here, and a rule naming `<project>/src/server.ts` denies a path that
  // exists in no project but this one (I1, 2026-09-19).
  const repo = fs.realpathSync(path.join(import.meta.dirname, ".."));
  assert.ok(spec.denyTargets.includes(`node ${path.join(repo, "src", "server.ts")}`), spec.denyTargets.join(" "));
  assert.ok(spec.denyTargets.includes(`node ${path.join(repo, "src", "cli.ts")}`), spec.denyTargets.join(" "));
  // The configured binary is a target because config named it; the project's own tree is
  // not a place this server could be started from.
  assert.equal(spec.denyTargets.includes(`node ${path.join(p.root, "src", "server.ts")}`), false);
  assert.deepEqual([...new Set(spec.denyTargets.filter((target) => target.includes(p.root)))], [p.bin]);

  // The environment the fixture was actually given, which is the spec's.
  const invocation = JSON.parse(fs.readFileSync(record, "utf8")) as { argv: string[]; cwd: string; env: Record<string, string> };
  assert.equal(invocation.cwd, p.root);
  assert.equal(invocation.env.CROSS_AGENT_TASK, id);
  assert.equal(invocation.env.CROSS_AGENT_DEPTH, "1");
  assert.equal(invocation.env.CROSS_AGENT_PROJECT, p.root);
  assert.deepEqual(JSON.parse(invocation.env.CROSS_AGENT_LINEAGE), [{ taskId: id, role: "planner", cwd: p.root }]);
  assert.equal(invocation.env.CROSS_AGENT_GROK_BIN, p.bin, "the configured bin reaches the adapter and its sandbox check");
  assert.equal(invocation.env.CLAUDECODE, undefined, "the host's own markers do not travel to a child");
  assert.equal(invocation.env.MCP_SERVER, undefined);
  assert.equal(invocation.argv[invocation.argv.indexOf("--sandbox") + 1], "read-only");
  assert.equal(invocation.argv[invocation.argv.indexOf("--rules") + 1], "You are the planner. Report a plan.");
  assert.equal(fs.readFileSync(done.resultPath, "utf8"), `DONE ${invocation.argv.join(" ")}`);
  // One engine, once: the run's own event stream announces exactly one session.
  const announced = fs.readFileSync(done.logPath, "utf8").split("\n")
    .filter((line) => line.includes('"subtype":"init"'));
  assert.equal(announced.length, 1, fs.readFileSync(done.logPath, "utf8"));
});

test("a configured binary that does not resolve fails the task at the adapter's own sandbox check", async (t) => {
  const p = await projectWithRoles(t);
  const missing = path.join(p.root, "no-such-grok");
  fs.writeFileSync(path.join(p.root, ".cross-agent", "config.json"), JSON.stringify({
    ...configFor(missing), engines: { grok: { bin: missing } },
  }));
  const id = launched(await delegate(p.root, request({ role: "planner", cwd: p.root }), {
    authority: operator, mode: p.mode, env: engineEnv(p),
  }));
  // The spec's environment is what the capability check reads, so the binary config named
  // is the binary it looked for — and the launch fails closed rather than finding `grok`
  // on the server's own PATH.
  const failed = await waitForRecord(p, id, (value) => value.status === "failed");
  assert.match(failed.reason ?? "", /grok sandbox refused/);
  assert.match(failed.reason ?? "", new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(readSpec(p.root, id).env.CROSS_AGENT_GROK_BIN, missing);
});

test("the runner is started with the server's own environment, never the child's", async (t) => {
  const p = await projectWithRoles(t);
  const launch = await delegate(p.root, request({ role: "planner", cwd: p.root }), {
    authority: operator, mode: p.mode,
    env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall", CLAUDECODE: "1" }),
  });
  const id = launched(launch);
  const running = await waitForRecord(p, id, (value) => value.status === "running");
  const runner = environOf(running.runnerIdentity!.pid) ?? [];
  const engine = environOf(running.engineIdentity!.pid) ?? [];

  // The runner is the server's own child and carries what the server had; the engine
  // carries what `childEnv` prepared, and nothing of the host's own markers.
  assert.ok(runner.includes("CLAUDECODE=1"), "the runner inherits the server's environment as it is");
  assert.equal(runner.includes(`CROSS_AGENT_TASK=${id}`), false, "the spec's environment is the engine's alone");
  assert.equal(runner.some((entry) => entry.startsWith("CROSS_AGENT_LINEAGE=")), false);
  assert.ok(engine.includes(`CROSS_AGENT_TASK=${id}`));
  assert.equal(engine.includes("CLAUDECODE=1"), false);
});

test("a role, a workspace and a branch the project does not have are each refused by name", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p) };
  const worktree = await p.worktree("task/one");

  assert.match(refusal(await delegate(p.root, request({ role: "nobody", cwd: p.root }), options)), /role "nobody"/);
  assert.match(refusal(await delegate(p.root, request({ role: "planner", cwd: "relative/path" }), options)), /absolute/);
  assert.match(
    refusal(await delegate(p.root, request({ role: "planner", cwd: path.join(p.root, "missing") }), options)),
    /no directory at /,
  );
  // A root role runs at the project root and nowhere else.
  assert.match(refusal(await delegate(p.root, request({ role: "planner", cwd: worktree }), options)), /works at the project root/);
  // A worktree role needs a branch, and the worktree has to be that branch's.
  assert.match(refusal(await delegate(p.root, request({ role: "implementer", cwd: worktree }), options)), /branch/);
  assert.match(
    refusal(await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/other" }), options)),
    /task\/other/,
  );
  assert.match(
    refusal(await delegate(p.root, request({ role: "implementer", cwd: p.root, branch: "main" }), options)),
    /worktree|main/,
  );
  // An engine override whose map does not declare the role's own profile has no sandbox.
  const foreign = refusal(await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/one", engine: "claude" }), options));
  assert.match(foreign, /claude/);
  assert.match(foreign, /workspace/);
  assert.match(refusal(await delegate(p.root, request({ role: "planner", cwd: p.root, engine: "gpt" }), options)), /engine/);
  assert.deepEqual(p.records(), [], "nothing refused leaves a record behind");
});

test("a workspace an unsettled writable task holds refuses every delegation onto it, above it and below it", async (t) => {
  const p = await projectWithRoles(t);
  const worktree = await p.worktree("task/held");
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  const id = launched(await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/held" }), options));
  await waitForRecord(p, id, (value) => value.status === "running");

  for (const [cwd, role, branch] of [
    [worktree, "implementer", "task/held"], [worktree, "reviewer", "task/held"],
  ] as const) {
    const reason = refusal(await delegate(p.root, request({ role, cwd, branch }), options));
    assert.match(reason, new RegExp(`reserved by task ${id} \\(running\\)`), role);
  }
  // A root delegation contains the worktree, so it is refused by the same reservation.
  assert.match(refusal(await delegate(p.root, request({ role: "planner", cwd: p.root }), options)), new RegExp(`task ${id}`));

  // Once it settles, the workspace is free again.
  assert.equal((await update(p.root, id, { status: "cancelling" })).applied, true);
  assert.equal((await update(p.root, id, { status: "cancelled" })).applied, true);
  const next = launched(await delegate(p.root, request({ role: "reviewer", cwd: worktree, branch: "task/held" }), options));
  assert.notEqual(next, id);
});

// @anchor recordNobodyCan
test("a record nobody can read refuses a writable delegation and leaves a read-only one alone", async (t) => {
  const p = await projectWithRoles(t);
  const worktree = await p.worktree("task/unknown");
  const broken = path.join(p.root, ".cross-agent", "tasks", "broken.json");
  fs.mkdirSync(path.dirname(broken), { recursive: true });
  fs.writeFileSync(broken, "{not a record");
  const options = { authority: operator, mode: p.mode, env: engineEnv(p) };

  const reason = refusal(await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/unknown" }), options));
  assert.match(reason, /broken\.json/);
  assert.match(reason, /repair or remove/);
  // A read-only task frees no workspace and needs none, so an unreadable record is not its business.
  assert.ok(launched(await delegate(p.root, request({ role: "reviewer", cwd: worktree, branch: "task/unknown" }), options)));
});

test("a duplicate of a live task is refused, and force is what crosses the finished window", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  const same = request({ role: "planner", cwd: p.root });
  const id = launched(await delegate(p.root, same, options));
  await waitForRecord(p, id, (value) => value.status === "running");

  assert.equal(refusal(await delegate(p.root, same, options)), `already running, wait on ${id}`);
  // Force is not a way past a live task: two engines in one workspace is what this refuses.
  assert.equal(refusal(await delegate(p.root, { ...same, force: true }, options)), `already running, wait on ${id}`);

  const finished = (await settle(p, id)).updatedAt;
  assert.match(refusal(await delegate(p.root, same, { ...options, now: finished + 60_000 })), /duplicate delegation/);
  const forced = launched(await delegate(p.root, { ...same, force: true }, { ...options, now: finished + 60_000 }));
  await settle(p, forced);
  // And past the window it needs no force at all.
  assert.ok(launched(await delegate(p.root, same, { ...options, now: finished + 11 * 60_000 })));
});

test("resume is bound to the original task, and one chain never forks", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p) };
  const first = request({ role: "planner", cwd: p.root });
  const id = launched(await delegate(p.root, first, options));
  const done = await waitForRecord(p, id, (value) => value.status === "done");

  // A chain with an active record is not resumed: one chain, one live task.
  const other = await seed(p.root, { role: "planner", cwd: p.root, status: "running" });
  assert.equal(
    refusal(await delegate(p.root, { ...first, resume: other.id }, options)),
    `${other.id} is running; wait or cancel first`,
  );
  assert.equal((await update(p.root, other.id, { status: "failed" })).applied, true);
  // The binding is the original's own role, engine, cwd and sandbox profile.
  assert.match(
    refusal(await delegate(p.root, { ...first, role: "lead", resume: id }, options)),
    /role "lead" differs from the original "planner"/,
  );
  assert.match(refusal(await delegate(p.root, { ...first, resume: "no-such-task" }, options)), /no task no-such-task/);

  const second = launched(await delegate(p.root, { ...first, brief: "Carry on.", resume: id }, options));
  const resumed = p.record(second);
  assert.equal(resumed.resumedFrom, id);
  assert.equal(resumed.parentTaskId, undefined, "the original had no parent, so neither has its continuation");
  assert.equal(readSpec(p.root, second).resumeSessionId, done.sessionId);
  assert.notEqual(readSpec(p.root, second).sessionId, done.sessionId, "a fresh id of its own, never the resumed session");
  await waitForRecord(p, second, (value) => value.status === "done");

  // A chain keeps one live record: while any record of it is active, no record of it may
  // be resumed, whichever one the request names.
  const successor = await seed(p.root, { role: "planner", cwd: p.root, status: "running", resumedFrom: second });
  for (const target of [id, second, successor.id]) {
    assert.equal(
      refusal(await delegate(p.root, { ...first, resume: target }, options)),
      `${successor.id} is running; wait or cancel first`, target,
    );
  }
  // And it never forks: once it has settled, only the latest record may be continued.
  assert.equal((await update(p.root, successor.id, { status: "failed" })).applied, true);
  assert.equal(refusal(await delegate(p.root, { ...first, resume: id }, options)), `resume the latest: ${second}`);
  assert.equal(refusal(await delegate(p.root, { ...first, resume: second }, options)), `resume the latest: ${successor.id}`);
  const third = launched(await delegate(p.root, { ...first, resume: successor.id }, options));
  assert.equal(p.record(third).resumedFrom, successor.id);
});

test("a resume keeps the parent of the record it continues, and a lead resumes only its own", async (t) => {
  const p = await projectWithRoles(t);
  const worktree = await p.worktree("task/owned");
  const first = await seed(p.root, { role: "lead", cwd: p.root, status: "running" });
  const child = launched(await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/owned" }), {
    authority: lead(first.id), mode: p.mode, env: engineEnv(p),
  }));
  await waitForRecord(p, child, (value) => value.status === "done");

  // The operator resumes the lead's child: the task stays the lead's, or a cascade could
  // never reach the engine this launches in the lead's own worktree.
  const resumed = launched(await delegate(p.root, {
    ...request({ role: "implementer", cwd: worktree, branch: "task/owned" }), resume: child,
  }, { authority: operator, mode: p.mode, env: engineEnv(p) }));
  assert.equal(p.record(resumed).parentTaskId, first.id, "preserved across resume");
  assert.equal(p.record(resumed).resumedFrom, child);
  await waitForRecord(p, resumed, (value) => value.status === "done");

  // A lead that did not delegate it may not continue it either: the refusal is the same
  // ownership `cancel` applies.
  const stranger = await seed(p.root, { role: "lead", cwd: p.root, status: "running" });
  const refused = refusal(await delegate(p.root, {
    ...request({ role: "implementer", cwd: worktree, branch: "task/owned" }), resume: resumed,
  }, { authority: lead(stranger.id), mode: p.mode, env: engineEnv(p) }));
  assert.match(refused, new RegExp(`lead task ${stranger.id} did not delegate`));
  // Its own lead may, and the continuation is still that lead's.
  const again = launched(await delegate(p.root, {
    ...request({ role: "implementer", cwd: worktree, branch: "task/owned" }), resume: resumed,
  }, { authority: lead(first.id), mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) }));
  assert.equal(p.record(again).parentTaskId, first.id);
});

test("a resume whose original never reached a session is refused rather than launched fresh", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p) };
  // It failed before the engine ever announced a session, so there is nothing to continue.
  const original = await seed(p.root, { role: "planner", cwd: p.root, status: "failed", sessionId: null });
  assert.equal(original.sessionId, null);
  const reason = refusal(await delegate(p.root, { ...request({ role: "planner", cwd: p.root }), resume: original.id }, options));
  assert.match(reason, new RegExp(`task ${original.id} recorded no engine session`));
});

// @anchor delegationStartsGrok
test("no delegation starts a grok engine as the mode's engine-placed lead, whoever names it", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p) };
  const configFile = path.join(p.root, ".cross-agent", "config.json");

  // P9: a Grok child inherits the operator's own servers and has no per-run isolation, so
  // the server it reaches resolves to the **lead row** by ancestry. The config binds this
  // mode's lead to codex; the request names grok for it.
  const overridden = refusal(await delegate(p.root, request({ role: "lead", cwd: p.root, engine: "grok" }), options));
  assert.match(overridden, /P9/);
  assert.match(overridden, /grok/);

  // The same hole through the other door: the server read this config at start, and a
  // config can be edited under a running server.
  fs.writeFileSync(configFile, JSON.stringify({
    ...configFor(p.bin), roles: { ...(configFor(p.bin).roles as Record<string, unknown>), lead: { engine: "grok" } },
  }));
  const bound = refusal(await delegate(p.root, request({ role: "lead", cwd: p.root }), options));
  assert.match(bound, /P9/);
  // A config that cannot be trusted stops every launch, not only the lead's.
  assert.match(refusal(await delegate(p.root, request({ role: "planner", cwd: p.root }), options)), /P9/);
  assert.deepEqual(p.records(), [], "nothing was written and nothing was spawned");

  // The rule is the engine placement's: a host-placed mode names no lead, so a role that
  // happens to be called `lead` is an ordinary specialist and grok may run it.
  const hostPlaced = buildMode(p.modesDir, "host-placed-lead", modeRoles);
  fs.writeFileSync(configFile, JSON.stringify({ ...configFor(p.bin), mode: "host-placed-lead" }));
  assert.ok(launched(await delegate(p.root, request({ role: "lead", cwd: p.root, engine: "grok" }), {
    ...options, mode: hostPlaced, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }),
  })));
});

/** This repository's own server: what a lead's mount starts, wherever the project is. */
const repositoryServer = path.join(fs.realpathSync(path.join(import.meta.dirname, "..")), "src", "server.ts");

/** The mode's loop, a blank line, then the role half: what an engine-placed lead is launched with. */
function leadPrompt(p: TestProject, roleHalf: string): string {
  return `${fs.readFileSync(p.mode.loopFile, "utf8")}\n${roleHalf}`;
}

// @anchor engineLeadSpec
test("the operator's delegation of the engine-placed lead mounts this server and composes the loop with its role prompt", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  const id = launched(await delegate(p.root, request({ role: "lead", cwd: p.root, brief: "S11: the lead's first brief." }), options));

  const spec = readSpec(p.root, id);
  // The mount both lead engines accept: `--project` in the arguments and no environment,
  // which Codex's mount refuses outright (P9; `tools/probe.mjs --track`).
  assert.deepEqual(spec.lead, { command: process.execPath, args: [repositoryServer, "--project", p.root] });
  assert.equal(Object.hasOwn(spec.lead!, "env"), false);
  // The loop verbatim, a blank line, then the role's own prompt, composed once here.
  const roleHalf = fs.readFileSync(path.join(p.mode.dir, "roles", "lead.md"), "utf8");
  assert.equal(spec.rolePrompt, leadPrompt(p, roleHalf));
  assert.equal(spec.brief, "S11: the lead's first brief.");

  // The operator is at depth 0, so the lead runs at 1 and its own children at 2.
  const record = p.record(id);
  assert.equal(record.depth, 1);
  assert.equal(record.parentTaskId, undefined, "nobody delegated the lead but the operator");
  assert.equal(spec.env.CROSS_AGENT_DEPTH, "1");
  assert.deepEqual(JSON.parse(spec.env.CROSS_AGENT_LINEAGE!), [{ taskId: id, role: "lead", cwd: p.root }]);

  // A prompt config binds replaces the role half and leaves the loop where it is.
  const configured = configFor(p.bin);
  (configured.roles as Record<string, Record<string, unknown>>).lead.prompt = "The project's own lead text.";
  fs.writeFileSync(path.join(p.root, ".cross-agent", "config.json"), JSON.stringify(configured));
  const again = launched(await delegate(p.root, request({ role: "lead", cwd: p.root, brief: "S11: the lead's second brief." }), options));
  assert.equal(readSpec(p.root, again).rolePrompt, leadPrompt(p, "The project's own lead text."));

  // A specialist mounts nothing, and its prompt is its role's alone.
  const planner = launched(await delegate(p.root, request({ role: "planner", cwd: p.root }), options));
  assert.equal(readSpec(p.root, planner).lead, undefined);
  assert.equal(readSpec(p.root, planner).rolePrompt, "You are the planner. Report a plan.");
});

/** A directory holding the two programs Claude's Linux sandbox check looks for, for an engine that is the fake. */
function sandboxPath(p: TestProject): string {
  const directory = path.join(p.root, ".sandbox-bin");
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ["bwrap", "socat"]) {
    fs.writeFileSync(path.join(directory, name), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(directory, name), 0o755);
  }
  return `${directory}${path.delimiter}${process.env.PATH ?? ""}`;
}

// @anchor engineLeadArgv
test("the lead's mount reaches the engine's own argv through the real runner, on Claude and on Codex", async (t) => {
  const p = await projectWithRoles(t);
  const configFile = path.join(p.root, ".cross-agent", "config.json");
  const argvOf = async (engine: "claude" | "codex", brief: string): Promise<{ id: string; argv: string[] }> => {
    const config = configFor(p.bin);
    (config.roles as Record<string, unknown>).lead = { engine };
    config.engines = { grok: { bin: p.bin }, codex: { bin: p.bin }, claude: { bin: p.bin } };
    fs.writeFileSync(configFile, JSON.stringify(config));
    const record = path.join(p.root, `${engine}-invocation.json`);
    const id = launched(await delegate(p.root, request({ role: "lead", cwd: p.root, brief }), {
      authority: operator, mode: p.mode,
      env: engineEnv(p, { FAKE_ENGINE_FORMAT: engine, FAKE_ENGINE_RECORD: record, PATH: sandboxPath(p) }),
    }));
    const done = await waitForRecord(p, id, (value) => value.status === "done" || value.status === "failed");
    assert.equal(done.status, "done", `${engine}: ${done.reason}`);
    return { id, argv: (JSON.parse(fs.readFileSync(record, "utf8")) as { argv: string[] }).argv };
  };

  // Claude: the mount travels with the flag that makes it exclusive, and its file says
  // exactly this server with exactly this project.
  const claude = await argvOf("claude", "S11: a Claude lead's brief.");
  const strict = claude.argv.indexOf("--strict-mcp-config");
  assert.ok(strict >= 0, claude.argv.join(" "));
  assert.equal(claude.argv[strict + 1], "--mcp-config");
  const mountFile = claude.argv[strict + 2];
  assert.equal(mountFile, path.join(p.root, ".cross-agent", "tasks", `${claude.id}.scratch`, "mcp-config.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(mountFile, "utf8")), {
    mcpServers: { "cross-agent": { command: process.execPath, args: [repositoryServer, "--project", p.root] } },
  });
  // Under `dontAsk` an MCP call nothing approved is denied, so the lead's settings approve
  // its mount's server by name, and its read-only file tools approve no edit (t12Fix1).
  const leadSettings = JSON.parse(claude.argv[claude.argv.indexOf("--settings") + 1]) as { permissions: { allow: string[] } };
  assert.deepEqual(leadSettings.permissions.allow, ["Read", "mcp__cross-agent"]);
  assert.equal(claude.argv[claude.argv.indexOf("--permission-mode") + 1], "dontAsk");

  // Codex: the five `-c` settings, under the flag that removes the operator's own servers.
  const codex = await argvOf("codex", "S11: a Codex lead's brief.");
  const settings = codex.argv.flatMap((value, index) => (codex.argv[index - 1] === "-c" && value.startsWith("mcp_servers.") ? [value] : []));
  assert.deepEqual(settings, [
    `mcp_servers.cross-agent.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.cross-agent.args=${JSON.stringify([repositoryServer, "--project", p.root])}`,
    'mcp_servers.cross-agent.default_tools_approval_mode="approve"',
    "mcp_servers.cross-agent.tool_timeout_sec=3600",
    'mcp_servers.cross-agent.env_vars=["CROSS_AGENT_DEPTH","CROSS_AGENT_TASK","CROSS_AGENT_LINEAGE","CROSS_AGENT_PROJECT"]',
  ]);
  assert.ok(codex.argv.includes("--ignore-user-config"));
});

// @anchor inheritedMountRefused
test("an engine whose lead mount is the operator's inherited configuration is refused before any record exists", async (t) => {
  const p = await projectWithRoles(t);
  // No built-in engine but Grok answers so, and Grok is refused earlier by name; what this
  // reads is the adapter's own answer, through the table `delegate` launches from.
  const { adapters } = await import("../src/engines/registry.ts");
  t.mock.method(adapters.codex, "leadMount", () => ({ argv: [], inherited: true as const }));
  const reason = refusal(await delegate(p.root, request({ role: "lead", cwd: p.root }), {
    authority: operator, mode: p.mode, env: engineEnv(p),
  }));
  assert.match(reason, /P9/);
  assert.match(reason, /codex/);
  assert.deepEqual(p.records(), [], "nothing was written and nothing was spawned");
  assert.equal(fs.existsSync(path.join(p.root, ".cross-agent", "tasks")), false);
});

// @anchor engineLeadCap
test("a lead the project's depth cap would hold to the specialist row is refused before it launches", async (t) => {
  const p = await projectWithRoles(t, { maxDepth: 1 });
  // At depth 1 under a cap of 1 its own server resolves the specialist row, and the loop
  // could call none of the tools it runs on.
  const reason = refusal(await delegate(p.root, request({ role: "lead", cwd: p.root }), {
    authority: operator, mode: p.mode, env: engineEnv(p),
  }));
  assert.match(reason, /depth 1/);
  assert.match(reason, /limits\.maxDepth/);
  assert.deepEqual(p.records(), []);
  // A specialist is not the lead, and runs under the same cap as before.
  assert.ok(launched(await delegate(p.root, request({ role: "planner", cwd: p.root }), {
    authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }),
  })));
});

// @anchor resumedLeadAsks
test("a resumed lead's brief carries its lineage's asks, and its record hashes the caller's brief alone", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_FORMAT: "codex" }) };
  const { createHash } = await import("node:crypto");
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const { answerAsk, createAsk } = await import("../src/mailbox.ts");

  // A lead that ran and settled, with a session to continue.
  const first = launched(await delegate(p.root, request({ role: "lead", cwd: p.root, brief: "S11: run the task." }), options));
  await waitForRecord(p, first, (value) => value.status === "done");
  // Nothing asked yet: the resume brief is the caller's text alone.
  const quiet = launched(await delegate(p.root, request({ role: "lead", cwd: p.root, brief: "Carry on.", resume: first }), options));
  assert.equal(readSpec(p.root, quiet).brief, "Carry on.");
  await waitForRecord(p, quiet, (value) => value.status === "done");

  // Its chain asked twice — once before the resume and once after — and one was answered.
  const asked = createAsk(p.root, { taskId: first, question: "Which slug?" }, 1_000);
  const open = createAsk(p.root, { taskId: quiet, question: "Delete the branch?\nIt is merged." }, 2_000);
  createAsk(p.root, { taskId: "some-other-lead", question: "Not this lineage's?" }, 3_000);
  assert.equal((await answerAsk(p.root, asked.id, "use s11-i2")).applied, true);

  const resumed = launched(await delegate(p.root, request({ role: "lead", cwd: p.root, brief: "Carry on again.", resume: quiet }), options));
  assert.equal(readSpec(p.root, resumed).brief, [
    "Carry on again.",
    "",
    "## Asks so far",
    `- ask ${asked.id}: answered`,
    "  question: Which slug?",
    "  answer: use s11-i2",
    `- ask ${open.id}: open`,
    "  question: Delete the branch?",
    "    It is merged.",
    "",
  ].join("\n"));
  // The duplicate window keys on what the caller wrote, never on what the server added.
  assert.equal(p.record(resumed).briefHash, hash("Carry on again."));
  assert.equal(p.record(quiet).briefHash, hash("Carry on."));
});

// @anchor resumeRefusesUnreadableAsk
test("a lead's resume is refused, naming the file, while an ask its chain may have put cannot be read", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_FORMAT: "codex" }) };
  const { createAsk } = await import("../src/mailbox.ts");
  const first = launched(await delegate(p.root, request({ role: "lead", cwd: p.root, brief: "S11: run the task." }), options));
  await waitForRecord(p, first, (value) => value.status === "done");
  createAsk(p.root, { taskId: first, question: "Which slug?" });
  const asks = path.join(p.root, ".cross-agent", "asks");

  // A file no reader can parse could be this chain's question, and its answer with it: the
  // continuation would be launched without it, so nothing is launched.
  const torn = path.join(asks, "torn.json");
  fs.writeFileSync(torn, '{"id": "torn", "taskId": "');
  const before = p.records().length;
  const reason = refusal(await delegate(p.root, request({ role: "lead", cwd: p.root, brief: "Carry on.", resume: first }), options));
  assert.ok(reason.includes(torn), reason);
  assert.equal(p.records().length, before, "no record for a refused resume");

  // Damage that still names another lineage's task is that lineage's to repair.
  fs.writeFileSync(torn, JSON.stringify({ id: "torn", taskId: "some-other-lead", question: "Q", createdAt: 1, status: "pending" }));
  const resumed = launched(await delegate(p.root, request({ role: "lead", cwd: p.root, brief: "Carry on.", resume: first }), options));
  assert.match(readSpec(p.root, resumed).brief, /## Asks so far/);
});

// @anchor configEditedAfter
test("a config edited after the server read it is refused at the launch boundary, by field and rule", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p) };
  const configFile = path.join(p.root, ".cross-agent", "config.json");
  const base = configFor(p.bin);
  const rebind = (roles: Record<string, unknown>) => fs.writeFileSync(configFile, JSON.stringify({ ...base, roles }));

  // A root role turned writable: `.cross-agent/` is the server's to write, and the ledger,
  // the mailbox and the journal live there.
  rebind({ planner: { engine: "grok", sandbox: "off" } });
  const writable = refusal(await delegate(p.root, request({ role: "planner", cwd: p.root }), options));
  assert.match(writable, /roles\.planner\.sandbox/);
  assert.match(writable, /project root/);

  // A role key this mode does not declare.
  rebind({ designer: { engine: "grok" } });
  assert.match(refusal(await delegate(p.root, request({ role: "planner", cwd: p.root }), options)), /declares no role "designer"/);

  // A profile the bound engine does not have — `workspace-write` is Claude's and Codex's
  // name for it, and this role is bound to grok.
  rebind({ implementer: { engine: "grok", sandbox: "workspace-write" } });
  const foreign = refusal(await delegate(p.root, request({ role: "implementer", cwd: p.root }), options));
  assert.match(foreign, /roles\.implementer\.sandbox/);
  assert.match(foreign, /grok profiles/);

  // And the mode itself changing under the server, whose tools were registered for the one
  // it loaded: a restart is the only honest answer.
  fs.writeFileSync(configFile, JSON.stringify({ ...base, mode: "host-placed-lead" }));
  buildMode(p.modesDir, "host-placed-lead", modeRoles);
  const drifted = refusal(await delegate(p.root, request({ role: "planner", cwd: p.root }), options));
  assert.match(drifted, /host-placed-lead/);
  assert.match(drifted, /restart/);
  assert.deepEqual(p.records(), [], "no refusal wrote a record");
});

// @anchor leadRowDelegates
test("the lead row delegates its own children, and is refused a lead, a lineage repeat and a cancelling parent", async (t) => {
  const p = await projectWithRoles(t);
  const worktree = await p.worktree("task/child");
  const leadTask = await seed(p.root, { role: "lead", cwd: p.root, status: "running", depth: 1 });
  const options = {
    authority: lead(leadTask.id), mode: p.mode,
    env: { ...engineEnv(p), CROSS_AGENT_DEPTH: "1", CROSS_AGENT_TASK: leadTask.id, CROSS_AGENT_LINEAGE: JSON.stringify([{ taskId: leadTask.id, role: "lead", cwd: p.root }]) },
  };

  // A lead delegates specialists, never another lead (the permission matrix).
  assert.match(refusal(await delegate(p.root, request({ role: "lead", cwd: p.root }), options)), /lead/);
  // The operator's row may delegate a lead; the refusal is the lead row's alone.
  assert.ok(launched(await delegate(p.root, request({ role: "lead", cwd: p.root }), {
    authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }),
  })));
  // A caller whose own depth cannot be trusted writes no record at all.
  assert.match(
    refusal(await delegate(p.root, request({ role: "planner", cwd: p.root }), { ...options, authority: { ...operator, depth: Infinity } })),
    /depth Infinity cannot be trusted/,
  );
  // Its own (role, cwd) pair is already in the lineage it carries. Under a host-placed
  // mode there is no lead role to refuse first, so the lineage is what answers.
  const hostPlaced = buildMode(p.modesDir, "host-placed", modeRoles);
  const configFile = path.join(p.root, ".cross-agent", "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ ...configFor(p.bin), mode: "host-placed" }));
  assert.match(
    refusal(await delegate(p.root, request({ role: "lead", cwd: p.root }), { ...options, mode: hostPlaced })),
    /already has this pair in CROSS_AGENT_LINEAGE/,
  );
  fs.writeFileSync(configFile, JSON.stringify(configFor(p.bin)));

  const id = launched(await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/child" }), options));
  const child = p.record(id);
  assert.equal(child.parentTaskId, leadTask.id, "the record says whose child it is, for the cascade");
  assert.equal(child.depth, 2, "a lead at depth 1 delegates at depth 2");
  const spec = readSpec(p.root, id);
  assert.equal(spec.env.CROSS_AGENT_DEPTH, "2");
  assert.deepEqual(JSON.parse(spec.env.CROSS_AGENT_LINEAGE!), [
    { taskId: leadTask.id, role: "lead", cwd: p.root },
    { taskId: id, role: "implementer", cwd: worktree },
  ]);

  // From the moment the lead is cancelling, nothing more may be delegated under it.
  assert.equal((await update(p.root, leadTask.id, { status: "cancelling" })).applied, true);
  const second = await p.worktree("task/second");
  assert.match(
    refusal(await delegate(p.root, request({ role: "implementer", cwd: second, branch: "task/second" }), options)),
    new RegExp(`parent task ${leadTask.id} is cancelling`),
  );
});

test("a role with no binding runs on the engine the call names, and the built-in consultant has none", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  // `consult` is a role of every mode, declared by none of them here and bound by
  // nothing: the engine comes from the call, which is what makes a one-off delegation
  // possible with no team template (design, "Modes").
  assert.match(
    refusal(await delegate(p.root, request({ role: "consult", cwd: p.root }), options)),
    /bound to no engine .*cross-agent init --mode dev-team/,
  );
  const id = launched(await delegate(p.root, request({ role: "consult", cwd: p.root, engine: "grok" }), options));
  assert.equal(p.record(id).engine, "grok");
  const spec: LaunchSpec = readSpec(p.root, id);
  assert.deepEqual(spec.sandbox, sandboxFor("grok", "read-only"), "read-only at the root, as the mode says");
  // Its prompt is the mode's own text for the role, not the one-line default a bound
  // role with no configured prompt gets.
  assert.match(spec.rolePrompt, /consultant/);
  assert.match(spec.rolePrompt, /read-only/);
});

test("every engine names the writable profile a one-shot runs under", () => {
  // The table is per engine because a profile means nothing apart from the engine that
  // declares it — `workspace-write` is Claude's and Codex's name, `workspace` is Grok's —
  // and an engine missing from it would launch a one-shot read-only in a worktree it was
  // given to write in, or refuse at `sandboxFor` with the engine's own list.
  assert.deepEqual(Object.keys(writableProfiles).sort(), [...engineNames].sort());
  for (const engine of engineNames) {
    assert.equal(sandboxFor(engine, writableProfiles[engine]).mode, "write", engine);
  }
});

test("a worktree one-shot is created through git_root, journaled, and the record carries it", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  const id = launched(await delegate(p.root, request({ role: "planner", cwd: p.root, worktree: true }), options));
  const worktree = path.join(p.root, ".worktrees", id);
  const record = p.record(id);
  assert.deepEqual(record.worktree, { path: worktree, branch: `task/${id}`, slug: id });
  assert.equal(record.cwd, worktree, "the task runs there, so that is what it reserves");
  assert.equal(reservedBy(p.root, worktree)?.id, id);
  // Writable in the engine's own spelling of the profile — that is what the flag is for —
  // and the root rule is untouched, because the task never runs at the root.
  const spec: LaunchSpec = readSpec(p.root, id);
  assert.deepEqual(spec.sandbox, sandboxFor("grok", "workspace"));
  assert.equal(spec.cwd, worktree);
  // A real linked worktree on its own branch, with the step in the task's own journal.
  const verified = await verifyWorktree(p.root, worktree, `task/${id}`);
  assert.ok(!("reason" in verified), JSON.stringify(verified));
  const journal = readJournal(p.root, id);
  assert.equal(journal?.branch, `task/${id}`);
  assert.equal(journal?.worktree, worktree);
  assert.equal(journal?.defaultBranch, "main");
  assert.deepEqual(journal?.steps.map((step) => step.step), ["worktree-created"]);
});

// @anchor worktreeShotRefused
test("a worktree one-shot is refused wherever git_root would refuse it, and leaves nothing behind", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p) };
  const existing = await p.worktree("task/one");

  // Only a role that works at the project root takes the flag, and never with a resume,
  // which continues the workspace of the task it names rather than taking a new one.
  assert.match(
    refusal(await delegate(p.root, request({ role: "implementer", cwd: existing, branch: "task/one", worktree: true }), options)),
    /already works in a worktree/,
  );
  assert.match(
    refusal(await delegate(p.root, request({ role: "planner", cwd: p.root, worktree: true, resume: "whatever" }), options)),
    /resume/,
  );
  // Nor the mode's own engine-placed lead, which is read-only at the project root
  // because that is how it reaches git at all, and never with a branch: the flag is what
  // creates this task's branch, so one named here could only be another task's.
  assert.match(
    refusal(await delegate(p.root, request({ role: "lead", cwd: p.root, worktree: true }), options)),
    /engine-placed lead/,
  );
  assert.match(
    refusal(await delegate(p.root, request({ role: "planner", cwd: p.root, worktree: true, branch: "task/named" }), options)),
    /branch/,
  );
  // The reservation is read against the path the one-shot would take, before git creates
  // it: a task holding the worktree directory holds every worktree under it.
  const holder = await reserve(p.root, path.join(p.root, ".worktrees"));
  assert.match(
    refusal(await delegate(p.root, request({ role: "planner", cwd: p.root, worktree: true }), options)),
    new RegExp(`is reserved by task ${holder.id}`),
  );
  assert.equal((await update(p.root, holder.id, { status: "done" })).applied, true);

  // And a project that tracks `.cross-agent/` is one where a specialist could commit what
  // the lead runs at the root — including the config this call has just read — so no
  // delegation of any kind proceeds there, worktree or not (design section 4).
  await git(p.root, "add", "-f", ".cross-agent/config.json");
  for (const patch of [{ worktree: true }, {}]) {
    assert.match(
      refusal(await delegate(p.root, request({ role: "planner", cwd: p.root, ...patch }), options)),
      /\.cross-agent\/ is tracked by this repository[\s\S]*\.gitignore/,
    );
  }

  assert.deepEqual(p.records().map((record) => record.id), [holder.id], "nothing refused leaves a record behind");
  assert.deepEqual(fs.readdirSync(path.join(p.root, ".worktrees")), ["task-one"], "or a worktree");
  assert.equal(fs.existsSync(path.join(p.root, ".cross-agent", "journal")), false, "or a journal");
});

test("one worktree one-shot of a role and brief at a time, and the window holds after it settles", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  const brief = "Change the one thing.";
  const oneShot = (patch: Partial<DelegateRequest> = {}) =>
    delegate(p.root, { ...request({ role: "planner", cwd: p.root, worktree: true }), brief, ...patch }, options);

  const first = launched(await oneShot());
  // Each one-shot takes a workspace nothing has seen before, so the duplicate window is
  // read against the other one-shots of this role and brief rather than against a path.
  assert.match(refusal(await oneShot()), new RegExp(`already running, wait on ${first}`));
  await settle(p, first);
  assert.match(refusal(await oneShot()), /duplicate delegation/);
  const forced = launched(await oneShot({ force: true }));
  assert.notEqual(forced, first);
  // A brief of its own is another task, whatever else is running.
  const other = launched(await oneShot({ brief: "Change the other thing." }));

  // And the same brief at the project root is not one of these at all: a delegation
  // without the flag is keyed by its workspace, as every other delegation is. It waits
  // for the worktrees to settle, because a task at the root contains every one of them.
  for (const id of [forced, other]) await settle(p, id);
  launched(await delegate(p.root, { ...request({ role: "planner", cwd: p.root }), brief }, options));
});

test("a one-shot resumes in the worktree it was given, and is refused once that worktree is gone", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p) };
  // Run to completion rather than cancelled: the session a resume continues is what the
  // runner writes when the engine settles, and there is nothing to continue without it.
  const start = async (brief: string): Promise<TaskRecord> => {
    const id = launched(await delegate(p.root, { ...request({ role: "planner", cwd: p.root, worktree: true }), brief }, options));
    return waitForRecord(p, id, (value) => value.status === "done" && Boolean(value.sessionId));
  };

  // A needs-work round for a one-shot: the role works at the project root, but the record
  // says where this task ran and its spec says what it ran under, and a continuation is
  // bound to both (design section 5, layer 4).
  const original = await start("Change the one thing.");
  const again = launched(await delegate(p.root, {
    ...request({ role: "planner", cwd: p.root }), resume: original.id, brief: "Now address the review.",
  }, options));
  const continued = p.record(again);
  assert.equal(continued.cwd, original.worktree!.path);
  assert.deepEqual(continued.worktree, original.worktree, "the same worktree, and the same journal slug");
  assert.deepEqual(readSpec(p.root, again).sandbox, sandboxFor("grok", "workspace"));
  assert.equal(readSpec(p.root, again).cwd, original.worktree!.path);

  // And a worktree the lead has already cleaned up is named rather than recreated.
  const removed = await start("Change the other thing.");
  await git(p.root, "worktree", "remove", "--force", removed.worktree!.path);
  const reason = refusal(await delegate(p.root, {
    ...request({ role: "planner", cwd: p.root }), resume: removed.id, brief: "Now address that review.",
  }, options));
  assert.match(reason, new RegExp(removed.worktree!.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a one-shot that fails after its worktree exists leaves no worktree, branch or journal", async (t) => {
  if (process.getuid!() === 0) {
    t.skip("root writes a directory whatever its mode says, so neither failure can be staged");
    return;
  }
  const options = (p: TestProject) => ({ authority: operator, mode: p.mode, env: engineEnv(p) });
  const left = async (p: TestProject): Promise<string[]> => [
    ...fs.readdirSync(path.join(p.root, ".worktrees"), { withFileTypes: true }).map((entry) => entry.name),
    ...(await git(p.root, "branch", "--list", "task/*")).split("\n").filter(Boolean),
    ...fs.readdirSync(path.join(p.root, ".cross-agent", "journal")).filter((name) => name.endsWith(".json")),
  ];

  // (a) The journal step fails after `git worktree add` has already run: `git_root`
  // answers `ok: false` for a command that happened, which is the one refusal that can
  // leave a worktree standing.
  const journalled = await projectWithRoles(t);
  fs.mkdirSync(path.join(journalled.root, ".cross-agent", "journal"), { recursive: true });
  fs.mkdirSync(path.join(journalled.root, ".worktrees"), { recursive: true });
  // Restored before the project's own cleanup, which cannot empty a directory it may not
  // write; a removed root is already clean.
  t.after(() => { try { fs.chmodSync(path.join(journalled.root, ".cross-agent", "journal"), 0o755); } catch { /* gone */ } });
  fs.chmodSync(path.join(journalled.root, ".cross-agent", "journal"), 0o555);
  assert.match(
    refusal(await delegate(journalled.root, request({ role: "planner", cwd: journalled.root, worktree: true }), options(journalled))),
    /journal step could not be written/,
  );
  assert.deepEqual(await left(journalled), []);

  // (b) A throw after the worktree exists — here the ledger's own directory cannot be
  // written — escapes as an error, and must not escape with a worktree behind it.
  const recorded = await projectWithRoles(t);
  fs.mkdirSync(path.join(recorded.root, ".cross-agent", "journal"), { recursive: true });
  fs.mkdirSync(path.join(recorded.root, ".worktrees"), { recursive: true });
  fs.mkdirSync(path.join(recorded.root, ".cross-agent", "tasks"), { recursive: true });
  t.after(() => { try { fs.chmodSync(path.join(recorded.root, ".cross-agent", "tasks"), 0o755); } catch { /* gone */ } });
  fs.chmodSync(path.join(recorded.root, ".cross-agent", "tasks"), 0o555);
  await assert.rejects(
    () => delegate(recorded.root, request({ role: "planner", cwd: recorded.root, worktree: true }), options(recorded)),
    /EACCES|permission denied/,
  );
  fs.chmodSync(path.join(recorded.root, ".cross-agent", "tasks"), 0o755);
  assert.deepEqual(await left(recorded), []);
});

test("a project with no config delegates on the engine the call names, and no config is written", async (t) => {
  const p = await projectWithRoles(t);
  // The mode a project with no config runs as, served from this project's own shelf: one
  // role, no worktree role, and therefore no git policy of its own.
  const solo = buildMode(p.modesDir, "solo", [{ key: "consult" }]);
  fs.rmSync(path.join(p.root, ".cross-agent", "config.json"));
  const options = {
    authority: operator, mode: solo,
    env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall", CROSS_AGENT_GROK_BIN: p.bin }),
  };

  assert.match(
    refusal(await delegate(p.root, request({ role: "consult", cwd: p.root }), options)),
    /bound to no engine .*cross-agent init --mode solo/,
  );
  const asked = launched(await delegate(p.root, request({ role: "consult", cwd: p.root, engine: "grok" }), options));
  assert.equal(p.record(asked).engine, "grok");

  // And a change, in a worktree created under the policy this build supplies where the
  // mode declares none.
  const changed = launched(await delegate(p.root, { ...request({ role: "consult", cwd: p.root, engine: "grok", worktree: true }), brief: "Change the one thing." }, options));
  assert.deepEqual(p.record(changed).worktree, {
    path: path.join(p.root, ".worktrees", changed), branch: `task/${changed}`, slug: changed,
  });
  assert.deepEqual(readSpec(p.root, changed).sandbox, sandboxFor("grok", "workspace"));

  // The ledger's own directory is created by the first delegation; the config file is
  // not, because `cross-agent init` is the only thing that writes one.
  assert.equal(fs.existsSync(path.join(p.root, ".cross-agent", "tasks")), true);
  assert.equal(fs.existsSync(path.join(p.root, ".cross-agent", "config.json")), false);
});

test("a delegation whose spawn lock was lost before the record is written launches nothing", async (t) => {
  const p = await projectWithRoles(t);
  const worktree = await p.worktree("task/lost");
  const file = lockPath(p.root, spawnLockName());
  const options = { authority: operator, mode: p.mode, env: engineEnv(p) };

  // The reservation check this delegation passed was only true while the lock held it
  // true, so the launch is refused rather than spawned onto a workspace someone may have
  // taken meanwhile. The holder is killed the way a dead one dies: the kernel drops it.
  let reason: string | undefined;
  let rounds = 0;
  // Rounds until the window is hit, not a fixed number of them: whether one round lands
  // inside it is the machine's business, and every round asserts the same invariant —
  // the delegation either never held the lock, or wrote a record, or was refused for the
  // lock it lost. A round that loses the race is retried; the deadline is where a build
  // that can never hit the window stops.
  const deadline = Date.now() + pollDeadlineMs;
  while (reason === undefined) {
    rounds++;
    const killer = setInterval(() => { killLockHolder(file); }, 1);
    try {
      const result = await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/lost" }), options);
      if (result.ok) {
        // The race was lost the other way: the record exists, so it is settled and the
        // round retried.
        assert.equal((await update(p.root, result.taskId, { status: "failed", reason: "test" })).applied, true);
      } else if (/held by another process/.test(result.reason)) {
        // The killer landed before the helper printed `held`, so this delegation never
        // took the lock at all — a lost round, not the window under test.
        assert.match(result.reason, /spawn\.lock/);
      } else {
        reason = result.reason;
      }
      await delay(20);
    } finally { clearInterval(killer); }
    assert.ok(Date.now() < deadline || reason !== undefined,
      `the lock holder was never killed inside the validation window: ${rounds} rounds`);
  }
  assert.match(reason, /spawn\.lock/);
  assert.match(reason, /lost/);
  assert.equal(p.records().some((value) => value.status === "launching"), false, "nothing was written or spawned");
});

test("a delegation waits for the spawn lock and refuses when it cannot have it", async (t) => {
  const p = await projectWithRoles(t, { lockWaitSeconds: 0 });
  const { acquire } = await import("../src/locks.ts");
  const held = await acquire(lockPath(p.root, spawnLockName()), { operation: "the test holds it", waitSeconds: 2 });
  t.after(() => held.release());
  const result = await delegate(p.root, request({ role: "planner", cwd: p.root }), { authority: operator, mode: p.mode, env: engineEnv(p) });
  assert.match(refusal(result), /spawn\.lock/);
  assert.match(refusal(result), /held by another process/);
  assert.deepEqual(p.records(), []);
});

test("a worktree workspace carries the paths a writable sandbox must refuse", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  const commonDir = fs.realpathSync(path.join(p.root, ".git"));

  // A role that works at the project root has no writable root at all, so there is
  // nothing for a deny rule to subtract from. It goes first: a writable task below the
  // root reserves it, and every delegation onto the root would then be refused.
  const atRoot = launched(await delegate(p.root, { ...request({ role: "planner", cwd: p.root }), brief: "Read the project." }, options));
  assert.equal(readSpec(p.root, atRoot).protectedPaths, undefined);

  // A role that works in a worktree: its own `.git` pointer file and the repository's
  // common git directory, which is what probe P2's Claude row wrote into.
  const worktree = await p.worktree("task/protected");
  const inWorktree = launched(await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/protected" }), options));
  assert.deepEqual(readSpec(p.root, inWorktree).protectedPaths, [path.join(fs.realpathSync(worktree), ".git"), commonDir]);

  // A one-shot, whose worktree this call created a moment ago.
  const oneShot = launched(await delegate(p.root, request({ role: "planner", cwd: p.root, worktree: true }), options));
  assert.deepEqual(
    readSpec(p.root, oneShot).protectedPaths,
    [path.join(fs.realpathSync(path.join(p.root, ".worktrees", oneShot)), ".git"), commonDir],
  );
});

test("the settings a delegated Claude task is launched with deny what the spec protects", async (t) => {
  const p = await projectWithRoles(t);
  fs.writeFileSync(path.join(p.root, ".cross-agent", "config.json"), JSON.stringify({
    ...configFor(p.bin),
    roles: { planner: { engine: "claude" }, implementer: { engine: "claude", sandbox: "workspace-write" }, reviewer: { engine: "claude" } },
    engines: { claude: { bin: p.bin } },
  }));
  const commonDir = fs.realpathSync(path.join(p.root, ".git"));
  /** The `--settings` JSON the fake engine records as its own argv, which is the adapter's. */
  async function settingsOf(id: string, file: string): Promise<{ sandbox: Record<string, unknown> }> {
    await waitForRecord(p, id, (value) => value.status === "done");
    const invocation = JSON.parse(fs.readFileSync(file, "utf8")) as { argv: string[] };
    return JSON.parse(invocation.argv[invocation.argv.indexOf("--settings") + 1]) as { sandbox: Record<string, unknown> };
  }

  // A writable worktree role: one writable root, and the two paths the guard protects
  // denied inside it (probe P2's Claude row, 2026-09-19).
  const worktree = fs.realpathSync(await p.worktree("task/settings"));
  const writableRecord = path.join(p.root, "writable.json");
  const writable = launched(await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/settings" }), {
    authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_RECORD: writableRecord, FAKE_ENGINE_FORMAT: "claude" }),
  }));
  assert.deepEqual(readSpec(p.root, writable).protectedPaths, [path.join(worktree, ".git"), commonDir]);
  assert.deepEqual((await settingsOf(writable, writableRecord)).sandbox.filesystem, {
    allowWrite: [worktree], denyWrite: [path.join(worktree, ".git"), commonDir],
  });

  // A read-only role **in a worktree**: no writable root, and three denied paths — its own
  // workspace, its `.git` pointer and the repository's git directory. A read-only role
  // that could rewrite its own pointer would be as far outside design section 4 as a
  // writable one, which is why the spec carries them for every profile.
  const readerRecord = path.join(p.root, "reader.json");
  const reader = launched(await delegate(p.root, request({ role: "reviewer", cwd: worktree, branch: "task/settings", brief: "Read the branch." }), {
    authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_RECORD: readerRecord, FAKE_ENGINE_FORMAT: "claude" }),
  }));
  assert.deepEqual(readSpec(p.root, reader).protectedPaths, [path.join(worktree, ".git"), commonDir]);
  assert.deepEqual((await settingsOf(reader, readerRecord)).sandbox.filesystem, {
    denyWrite: [worktree, path.join(worktree, ".git"), commonDir],
  });

  // A read-only role at the project root: no writable root, and its own workspace denied
  // by name, because the sandbox would otherwise write there by default.
  const readOnlyRecord = path.join(p.root, "read-only.json");
  const readOnly = launched(await delegate(p.root, request({ role: "planner", cwd: p.root, brief: "Read the project." }), {
    authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_RECORD: readOnlyRecord, FAKE_ENGINE_FORMAT: "claude" }),
  }));
  assert.equal(readSpec(p.root, readOnly).protectedPaths, undefined);
  assert.deepEqual((await settingsOf(readOnly, readOnlyRecord)).sandbox.filesystem, { denyWrite: [fs.realpathSync(p.root)] });
});

test("a continuation of a worktree task carries that worktree's protected paths", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p) };
  const commonDir = fs.realpathSync(path.join(p.root, ".git"));

  // A role that works in a worktree, resumed where it ran.
  const worktree = fs.realpathSync(await p.worktree("task/continued"));
  const first = request({ role: "implementer", cwd: worktree, branch: "task/continued" });
  const id = launched(await delegate(p.root, first, options));
  await waitForRecord(p, id, (value) => value.status === "done");
  const resumed = launched(await delegate(p.root, { ...first, brief: "Carry on.", resume: id }, options));
  assert.deepEqual(readSpec(p.root, resumed).protectedPaths, [path.join(worktree, ".git"), commonDir]);

  // A one-shot, whose role works at the root: the continuation runs in the worktree the
  // record carries, so it is that worktree's metadata the sandbox has to refuse.
  const shot = launched(await delegate(p.root, request({ role: "planner", cwd: p.root, worktree: true }), options));
  await waitForRecord(p, shot, (value) => value.status === "done");
  const shotPath = fs.realpathSync(path.join(p.root, ".worktrees", shot));
  const continued = launched(await delegate(p.root, { ...request({ role: "planner", cwd: p.root }), brief: "Carry on.", resume: shot }, options));
  assert.deepEqual(readSpec(p.root, continued).protectedPaths, [path.join(shotPath, ".git"), commonDir]);
});

test("a resume keeps the original's model and effort when nothing else names them", async (t) => {
  const p = await projectWithRoles(t);
  fs.writeFileSync(path.join(p.root, ".cross-agent", "config.json"), JSON.stringify({
    ...configFor(p.bin),
    roles: { planner: { engine: "claude", model: "claude-sonnet-5", effort: "high" } },
    engines: { claude: { bin: p.bin }, grok: { bin: p.bin } },
  }));
  const options = { authority: operator, mode: p.mode, env: engineEnv(p) };

  // The case R0-2 created: the call named the engine, so the binding's model does not
  // apply, and the call named its own. A continuation that names neither would have had
  // none at all — and `claude --resume` with no `--model` continues on the engine's
  // default, so a chain would change model halfway through one session.
  const started = request({ role: "planner", cwd: p.root, engine: "grok", model: "grok-4.6", effort: "low" });
  const id = launched(await delegate(p.root, started, options));
  await waitForRecord(p, id, (value) => value.status === "done");
  const second = launched(await delegate(p.root, { role: "planner", cwd: p.root, engine: "grok", brief: "Carry on.", resume: id }, options));
  assert.equal(p.record(second).model, "grok-4.6");
  assert.equal(p.record(second).effort, "low");
  assert.equal(readSpec(p.root, second).model, "grok-4.6");

  // A continuation that names its own still gets its own, and what it does not name
  // still comes from the record.
  await waitForRecord(p, second, (value) => value.status === "done");
  const third = launched(await delegate(p.root, { role: "planner", cwd: p.root, engine: "grok", brief: "Once more.", resume: second, model: "grok-4.6-fast" }, options));
  assert.equal(readSpec(p.root, third).model, "grok-4.6-fast");
  assert.equal(readSpec(p.root, third).effort, "low");

  // The record is the last fallback, not the first: a binding for the engine that runs
  // is still resolved on every call, which is what the launcher says about a resume.
  const bound = launched(await delegate(p.root, request({ role: "planner", cwd: p.root, brief: "On the bound engine." }), options));
  await waitForRecord(p, bound, (value) => value.status === "done");
  const continued = launched(await delegate(p.root, { role: "planner", cwd: p.root, brief: "Carry on.", resume: bound }, options));
  assert.equal(readSpec(p.root, continued).model, "claude-sonnet-5");
});

test("a call that names another engine drops the binding's model and effort", async (t) => {
  const p = await projectWithRoles(t);
  fs.writeFileSync(path.join(p.root, ".cross-agent", "config.json"), JSON.stringify({
    ...configFor(p.bin),
    roles: { planner: { engine: "claude", model: "claude-sonnet-5", effort: "high" } },
    engines: { claude: { bin: p.bin }, grok: { bin: p.bin } },
  }));
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };

  // I1, 2026-09-19: `delegate {engine: "grok"}` on this binding launched
  // `grok --model claude-sonnet-5`, which grok refuses as an unknown model id. A model
  // and an effort belong to the engine that was bound, so naming another drops both.
  const crossed = launched(await delegate(p.root, request({ role: "planner", cwd: p.root, engine: "grok" }), options));
  assert.equal(p.record(crossed).engine, "grok");
  assert.equal(p.record(crossed).model, null);
  assert.equal(p.record(crossed).effort, null);
  assert.equal(readSpec(p.root, crossed).model, undefined);
  assert.equal(readSpec(p.root, crossed).effort, undefined);

  // Named in the call, they are the call's.
  const named = launched(await delegate(p.root, { ...request({ role: "planner", cwd: p.root, engine: "grok", model: "grok-4.6" }), brief: "Named model." }, options));
  assert.equal(readSpec(p.root, named).model, "grok-4.6");
  assert.equal(readSpec(p.root, named).effort, undefined);

  // The binding still holds for the engine it binds.
  const bound = launched(await delegate(p.root, { ...request({ role: "planner", cwd: p.root }), brief: "The bound engine." }, options));
  assert.equal(readSpec(p.root, bound).model, "claude-sonnet-5");
  assert.equal(readSpec(p.root, bound).effort, "high");
});

test("the engine a request overrides is the engine that runs, and the record says so", async (t) => {
  const p = await projectWithRoles(t);
  const claudeBin = p.bin;
  fs.writeFileSync(path.join(p.root, ".cross-agent", "config.json"), JSON.stringify({
    ...configFor(p.bin),
    roles: {
      planner: { engine: "grok", model: "grok-4.6", effort: "low" },
      claudish: { engine: "grok" },
    },
    engines: { grok: { bin: p.bin }, claude: { bin: claudeBin } },
  }));
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };

  // The role's bindings unless the request names its own.
  const bound = launched(await delegate(p.root, request({ role: "planner", cwd: p.root }), options));
  assert.equal(p.record(bound).model, "grok-4.6");
  assert.equal(p.record(bound).effort, "low");

  // A request that names another engine runs that engine's adapter, with that engine's
  // configured binary: the role's own profile has to be one the new engine declares, and
  // the mode's `read-only` default is declared by both.
  const crossed = launched(await delegate(p.root, { ...request({ role: "claudish", cwd: p.root, engine: "claude" }), brief: "Run on the other engine." }, {
    authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_FORMAT: "claude", FAKE_ENGINE_SCRIPT: "ok" }),
  }));
  const ran = await waitForRecord(p, crossed, (value) => value.status === "done");
  assert.equal(ran.engine, "claude");
  assert.equal(readSpec(p.root, crossed).adapterModule.endsWith("/engines/claude.ts"), true);
  assert.equal(readSpec(p.root, crossed).env.CROSS_AGENT_CLAUDE_BIN, claudeBin);
  assert.equal(readSpec(p.root, crossed).env.CROSS_AGENT_GROK_BIN, undefined, "only the engine that runs is told where its binary is");
  assert.match(fs.readFileSync(ran.resultPath, "utf8"), /--strict-mcp-config/, "the Claude adapter built the line");

  const overridden = launched(await delegate(p.root, request({ role: "claudish", cwd: p.root, model: "other-model", effort: "high" }), options));
  const record = p.record(overridden);
  assert.equal(record.engine, "grok");
  assert.equal(record.model, "other-model");
  assert.equal(record.effort, "high");
  assert.equal(readSpec(p.root, overridden).model, "other-model");
  assert.equal(readSpec(p.root, overridden).effort, "high");
  // A role that binds neither records neither, rather than a value nobody chose.
  const bare = await seed(p.root, { role: "claudish", cwd: p.root, status: "failed" });
  assert.equal(bare.model, undefined);
});

// @anchor profileSpecialistRuns
test("the profile a specialist runs under is the mode's default unless config overrides it", async (t) => {
  const p = await projectWithRoles(t);
  const configFile = path.join(p.root, ".cross-agent", "config.json");
  const base = configFor(p.bin);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };

  // No override: the planner runs under the mode's own `read-only`.
  const byDefault = launched(await delegate(p.root, request({ role: "planner", cwd: p.root }), options));
  assert.deepEqual(readSpec(p.root, byDefault).sandbox, { mode: "read-only", profile: "read-only" });

  // An override config binds: Grok's own read-only profile, which is a profile this
  // engine has and the mode never names.
  fs.writeFileSync(configFile, JSON.stringify({
    ...base, roles: { ...(base.roles as Record<string, unknown>), planner: { engine: "grok", sandbox: "strict" } },
  }));
  // Its own brief, because two live tasks with one brief in one workspace are the
  // duplicate `delegate` refuses whatever `force` says.
  const overridden = launched(await delegate(p.root, { ...request({ role: "planner", cwd: p.root }), brief: "Plan the second thing." }, options));
  assert.deepEqual(readSpec(p.root, overridden).sandbox, { mode: "read-only", profile: "strict" });

  // A role the mode declares and config does not bind has no engine to run on, and the
  // refusal says which file is missing it.
  fs.writeFileSync(configFile, JSON.stringify(base));
  assert.equal(
    refusal(await delegate(p.root, request({ role: "claudish", cwd: p.root }), options)),
    `refused delegation: role "claudish" is bound to no engine in ${CONFIG_PATH}: name engine in this call, or run "cross-agent init --mode dev-team"`,
  );
  // And a role neither declares is the mode's refusal, because the mode is what says
  // where a role works.
  assert.match(refusal(await delegate(p.root, request({ role: "nobody", cwd: p.root }), options)), /no role "nobody" in mode/);
});

test("a role that binds no prompt is launched with the mode's prompt file", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  const worktree = await p.worktree("task/prompt");
  const id = launched(await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/prompt" }), options));
  const spec: LaunchSpec = readSpec(p.root, id);
  // The mode's own text for the role, verbatim: the file `describe_mode` serves is the
  // file the engine is launched with, or the prompts a mode ships reach nothing
  // (design section 8, `src/modes.ts#rolePrompt`).
  assert.equal(spec.rolePrompt, fs.readFileSync(path.join(p.mode.dir, "roles", "implementer.md"), "utf8"));
});

test("a configured prompt overrides the mode's prompt file", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  // The bind-time layer still wins where a project sets one, which is how an operator
  // adjusts a role without editing the mode (design section 6).
  const id = launched(await delegate(p.root, request({ role: "planner", cwd: p.root }), options));
  const spec: LaunchSpec = readSpec(p.root, id);
  assert.equal(spec.rolePrompt, "You are the planner. Report a plan.");
  assert.notEqual(spec.rolePrompt, fs.readFileSync(path.join(p.mode.dir, "roles", "planner.md"), "utf8"));
});

test("every delegation of a project gets its own scratch directory and nothing else shares it", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, mode: p.mode, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  const first = launched(await delegate(p.root, request({ role: "planner", cwd: p.root }), options));
  const running = await waitForRecord(p, first, (value) => value.status === "running");
  assert.equal((await update(p.root, first, { status: "cancelling" })).applied, true);
  assert.equal((await update(p.root, first, { status: "cancelled" })).applied, true);
  if (running.engineIdentity) {
    const { terminateGroup } = await import("../src/process.ts");
    await terminateGroup(running.engineIdentity);
  }
  const second = launched(await delegate(p.root, request({ role: "planner", cwd: p.root, force: true }), options));
  const scratches = [first, second].map((id) => readSpec(p.root, id).scratchDir);
  assert.notEqual(scratches[0], scratches[1]);
  for (const directory of scratches) assert.equal(fs.statSync(directory).isDirectory(), true);
  assert.equal(alive(p.record(first).engineIdentity), false);
});

// @anchor discardUnderGitLocks
test("a one-shot discarded after git made its worktree is removed under git.lock and the repository lock", async (t) => {
  if (process.getuid!() === 0) {
    t.skip("root writes a directory whatever its mode says, so the failure cannot be staged");
    return;
  }
  const p = await projectWithRoles(t);
  const journals = path.join(p.root, ".cross-agent", "journal");
  fs.mkdirSync(journals, { recursive: true });
  t.after(() => { try { fs.chmodSync(journals, 0o755); } catch { /* gone */ } });
  // The `worktree-created` step cannot be written, after `git worktree add` has run.
  fs.chmodSync(journals, 0o555);
  // The discard's own removal is the one git command that carries `--force`: held for two
  // seconds, while the locks around it are looked at.
  const recorder = await gitShim(t, { sleepOn: "--force" });
  const pending = delegate(p.root, request({ role: "planner", cwd: p.root, worktree: true }), { authority: operator, mode: p.mode, env: engineEnv(p) });
  await poll(async () => (await recorder.argv()).includes("--force"), Boolean);
  // A probe that takes a lock gives it straight back, so a failing run leaves no holder.
  const held = async (file: string): Promise<boolean> => {
    try {
      await (await acquire(file, { operation: "a probe", waitSeconds: 0 })).release();
      return false;
    } catch {
      return true;
    }
  };
  for (const file of [lockPath(p.root, gitLockName()), repositoryLockPath(path.join(p.root, ".git"))]) {
    assert.equal(await held(file), true, `${file} is held while the discard runs`);
  }
  assert.match(refusal(await pending), /journal step could not be written/);
  assert.deepEqual(fs.readdirSync(path.join(p.root, ".worktrees")), []);
  assert.equal(await git(p.root, "branch", "--list", "task/*"), "");
});

// @anchor discardKeepsJournalOnFailure
test("a discard that leaves the worktree or its branch standing keeps the journal and names what survived", async (t) => {
  if (process.getuid!() === 0) {
    t.skip("root writes a directory whatever its mode says, so the failure cannot be staged");
    return;
  }
  const p = await projectWithRoles(t);
  const tasks = path.join(p.root, ".cross-agent", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  t.after(() => { try { fs.chmodSync(tasks, 0o755); } catch { /* gone */ } });
  // The record cannot be written: a throw once the worktree and its journal exist.
  fs.chmodSync(tasks, 0o555);
  // And the discard's removal dies on a signal, so the branch it would delete next is still
  // checked out in the surviving worktree, which git refuses to delete.
  await gitShim(t, { signalOn: "--force" });
  await assert.rejects(
    () => delegate(p.root, request({ role: "planner", cwd: p.root, worktree: true }), { authority: operator, mode: p.mode, env: engineEnv(p) }),
    (error: Error) => {
      assert.match(error.message, /EACCES|permission denied/);
      assert.match(error.message, /journal \S+ is kept/);
      return true;
    },
  );
  fs.chmodSync(tasks, 0o755);
  const [slug] = fs.readdirSync(path.join(p.root, ".worktrees"));
  assert.ok(slug !== undefined, "the worktree survived");
  assert.match(await git(p.root, "branch", "--list", "task/*"), new RegExp(`task/${slug}`), "and so did its branch");
  assert.equal(readJournal(p.root, slug)?.branch, `task/${slug}`, "and the journal that finds them both");
});
