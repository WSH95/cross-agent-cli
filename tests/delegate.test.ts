import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Authority } from "../src/authority.ts";
import { delegate } from "../src/delegate.ts";
import type { DelegateRequest } from "../src/delegate.ts";
import { create, readSpec, update, writeSpec } from "../src/ledger.ts";
import { sandboxFor } from "../src/engines/registry.ts";
import type { LaunchSpec, TaskRecord } from "../src/ledger.ts";
import { lockPath, spawnLockName } from "../src/locks.ts";
import { alive, engineEnv, environOf, killLockHolder, poll, project } from "./helpers/project.ts";
import type { TestProject } from "./helpers/project.ts";

const operator: Authority = { row: "operator", reason: "operator: no CROSS_AGENT_* variable and no engine ancestor", depth: 0 };

function lead(taskId: string, depth = 1): Authority {
  return { row: "lead", reason: `lead by ancestry: task ${taskId} (lead, running)`, taskId, depth };
}

function configFor(bin: string, limits: Record<string, number> = {}): Record<string, unknown> {
  return {
    roles: {
      planner: { engine: "grok", cwd: "root", sandbox: "read-only", prompt: "You are the planner. Report a plan." },
      implementer: { engine: "grok", cwd: "worktree", sandbox: "workspace" },
      reviewer: { engine: "grok", cwd: "worktree", sandbox: "read-only" },
      lead: { engine: "grok", cwd: "root", sandbox: "read-only" },
    },
    engines: { grok: { bin } },
    limits: { maxDepth: 2, lockWaitSeconds: 2, duplicateWindowMinutes: 10, cancelGraceSeconds: 2, ...limits },
    billing: "subscription",
  };
}

async function projectWithRoles(t: TestContext, limits: Record<string, number> = {}): Promise<TestProject> {
  const bin = path.join(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "cross-agent-bin-")), "unused");
  const created = await project(t, configFor(bin, limits));
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
    authority: operator,
    env: engineEnv(p, { FAKE_ENGINE_RECORD: record, CLAUDECODE: "1", MCP_SERVER: "operator's own" }),
  });
  const id = launched(launch);

  // The record is the launch, and the runner settles it without the server's help.
  const done = await poll(() => p.record(id), (value) => value.status === "done");
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
    authority: operator, env: engineEnv(p),
  }));
  // The spec's environment is what the capability check reads, so the binary config named
  // is the binary it looked for — and the launch fails closed rather than finding `grok`
  // on the server's own PATH.
  const failed = await poll(() => p.record(id), (value) => value.status === "failed");
  assert.match(failed.reason ?? "", /grok sandbox refused/);
  assert.match(failed.reason ?? "", new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(readSpec(p.root, id).env.CROSS_AGENT_GROK_BIN, missing);
});

test("the runner is started with the server's own environment, never the child's", async (t) => {
  const p = await projectWithRoles(t);
  const launch = await delegate(p.root, request({ role: "planner", cwd: p.root }), {
    authority: operator,
    env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall", CLAUDECODE: "1" }),
  });
  const id = launched(launch);
  const running = await poll(() => p.record(id), (value) => value.status === "running");
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
  const options = { authority: operator, env: engineEnv(p) };
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
  const options = { authority: operator, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  const id = launched(await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/held" }), options));
  await poll(() => p.record(id), (value) => value.status === "running");

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

test("a record nobody can read refuses a writable delegation and leaves a read-only one alone", async (t) => {
  const p = await projectWithRoles(t);
  const worktree = await p.worktree("task/unknown");
  const broken = path.join(p.root, ".cross-agent", "tasks", "broken.json");
  fs.mkdirSync(path.dirname(broken), { recursive: true });
  fs.writeFileSync(broken, "{not a record");
  const options = { authority: operator, env: engineEnv(p) };

  const reason = refusal(await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/unknown" }), options));
  assert.match(reason, /broken\.json/);
  assert.match(reason, /repair or remove/);
  // A read-only task frees no workspace and needs none, so an unreadable record is not its business.
  assert.ok(launched(await delegate(p.root, request({ role: "reviewer", cwd: worktree, branch: "task/unknown" }), options)));
});

test("a duplicate of a live task is refused, and force is what crosses the finished window", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  const same = request({ role: "planner", cwd: p.root });
  const id = launched(await delegate(p.root, same, options));
  await poll(() => p.record(id), (value) => value.status === "running");

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
  const options = { authority: operator, env: engineEnv(p) };
  const first = request({ role: "planner", cwd: p.root });
  const id = launched(await delegate(p.root, first, options));
  const done = await poll(() => p.record(id), (value) => value.status === "done");

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
  assert.equal(resumed.parentTaskId, undefined);
  assert.equal(readSpec(p.root, second).resumeSessionId, done.sessionId);
  assert.notEqual(readSpec(p.root, second).sessionId, done.sessionId, "a fresh id of its own, never the resumed session");
  await poll(() => p.record(second), (value) => value.status === "done");

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

test("a resume whose original never reached a session is refused rather than launched fresh", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, env: engineEnv(p) };
  // It failed before the engine ever announced a session, so there is nothing to continue.
  const original = await seed(p.root, { role: "planner", cwd: p.root, status: "failed", sessionId: null });
  assert.equal(original.sessionId, null);
  const reason = refusal(await delegate(p.root, { ...request({ role: "planner", cwd: p.root }), resume: original.id }, options));
  assert.match(reason, new RegExp(`task ${original.id} recorded no engine session`));
});

test("the lead row delegates its own children, and is refused a lead, a lineage repeat and a cancelling parent", async (t) => {
  const p = await projectWithRoles(t);
  const worktree = await p.worktree("task/child");
  const leadTask = await seed(p.root, { role: "lead", cwd: p.root, status: "running", depth: 1 });
  const options = {
    authority: lead(leadTask.id), leadRole: "lead",
    env: { ...engineEnv(p), CROSS_AGENT_DEPTH: "1", CROSS_AGENT_TASK: leadTask.id, CROSS_AGENT_LINEAGE: JSON.stringify([{ taskId: leadTask.id, role: "lead", cwd: p.root }]) },
  };

  // A lead delegates specialists, never another lead (the permission matrix).
  assert.match(refusal(await delegate(p.root, request({ role: "lead", cwd: p.root }), options)), /lead/);
  // The operator's row may delegate a lead; the refusal is the lead row's alone.
  assert.ok(launched(await delegate(p.root, request({ role: "lead", cwd: p.root }), {
    authority: operator, leadRole: "lead", env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }),
  })));
  // A caller whose own depth cannot be trusted writes no record at all.
  assert.match(
    refusal(await delegate(p.root, request({ role: "planner", cwd: p.root }), { ...options, authority: { ...operator, depth: Infinity } })),
    /depth Infinity cannot be trusted/,
  );
  // Its own (role, cwd) pair is already in the lineage it carries.
  assert.match(
    refusal(await delegate(p.root, request({ role: "lead", cwd: p.root }), { ...options, leadRole: undefined })),
    /already has this pair in CROSS_AGENT_LINEAGE/,
  );

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

test("a delegation whose spawn lock was lost before the record is written launches nothing", async (t) => {
  const p = await projectWithRoles(t);
  const worktree = await p.worktree("task/lost");
  const file = lockPath(p.root, spawnLockName());
  const options = { authority: operator, env: engineEnv(p) };

  // The reservation check this delegation passed was only true while the lock held it
  // true, so the launch is refused rather than spawned onto a workspace someone may have
  // taken meanwhile. The holder is killed the way a dead one dies: the kernel drops it.
  let reason: string | undefined;
  for (let attempt = 0; attempt < 5 && reason === undefined; attempt++) {
    const killer = setInterval(() => { killLockHolder(file); }, 1);
    try {
      const result = await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/lost" }), options);
      if (result.ok) {
        // The race was lost: the record exists, so it is settled and the round retried.
        assert.equal((await update(p.root, result.taskId, { status: "failed", reason: "test" })).applied, true);
        await delay(20);
      } else {
        reason = result.reason;
      }
    } finally { clearInterval(killer); }
  }
  assert.ok(reason, "the lock holder was never killed inside the validation window");
  assert.match(reason, /spawn\.lock/);
  assert.match(reason, /lost/);
  assert.equal(p.records().some((value) => value.status === "launching"), false, "nothing was written or spawned");
});

test("a delegation waits for the spawn lock and refuses when it cannot have it", async (t) => {
  const p = await projectWithRoles(t, { lockWaitSeconds: 0 });
  const { acquire } = await import("../src/locks.ts");
  const held = await acquire(lockPath(p.root, spawnLockName()), { operation: "the test holds it", waitSeconds: 2 });
  t.after(() => held.release());
  const result = await delegate(p.root, request({ role: "planner", cwd: p.root }), { authority: operator, env: engineEnv(p) });
  assert.match(refusal(result), /spawn\.lock/);
  assert.match(refusal(result), /held by another process/);
  assert.deepEqual(p.records(), []);
});

test("the engine a request overrides is the engine that runs, and the record says so", async (t) => {
  const p = await projectWithRoles(t);
  const claudeBin = p.bin;
  fs.writeFileSync(path.join(p.root, ".cross-agent", "config.json"), JSON.stringify({
    ...configFor(p.bin),
    roles: {
      planner: { engine: "grok", cwd: "root", sandbox: "read-only", model: "grok-4.6", effort: "low" },
      claudish: { engine: "grok", cwd: "root", sandbox: "off" },
    },
    engines: { grok: { bin: p.bin }, claude: { bin: claudeBin } },
  }));
  const options = { authority: operator, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };

  // The role's bindings unless the request names its own.
  const bound = launched(await delegate(p.root, request({ role: "planner", cwd: p.root }), options));
  assert.equal(p.record(bound).model, "grok-4.6");
  assert.equal(p.record(bound).effort, "low");

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

test("a role that binds no prompt is launched with a one-line default that forbids delegating", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  const worktree = await p.worktree("task/prompt");
  const id = launched(await delegate(p.root, request({ role: "implementer", cwd: worktree, branch: "task/prompt" }), options));
  const spec: LaunchSpec = readSpec(p.root, id);
  assert.match(spec.rolePrompt, /implementer/);
  assert.match(spec.rolePrompt, /not delegate/);
  assert.equal(spec.rolePrompt.trim().split("\n").length, 1, "one line until a mode brings the real prompt");
});

test("every delegation of a project gets its own scratch directory and nothing else shares it", async (t) => {
  const p = await projectWithRoles(t);
  const options = { authority: operator, env: engineEnv(p, { FAKE_ENGINE_SCRIPT: "stall" }) };
  const first = launched(await delegate(p.root, request({ role: "planner", cwd: p.root }), options));
  const running = await poll(() => p.record(first), (value) => value.status === "running");
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
