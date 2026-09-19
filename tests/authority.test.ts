import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAuthority } from "../src/authority.ts";
import type { Authority } from "../src/authority.ts";
import { create, readProcessStat, update } from "../src/ledger.ts";
import type { EngineIdentity, TaskRecord } from "../src/ledger.ts";
import { identityOf } from "../src/process.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const preload = pathToFileURL(path.join(fixtures, "spawn-child.mjs")).href;
const operator = "operator: no CROSS_AGENT_* variable and no engine ancestor";

function workspace(t: TestContext): { project: string; exchange: string } {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cross-agent-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const exchange = path.join(root, "exchange");
  fs.mkdirSync(project);
  fs.mkdirSync(exchange);
  return { project, exchange };
}

function task(project: string, role: string): TaskRecord {
  return create(project, { role, brief: `the ${role}'s brief`, cwd: project, engine: "claude" });
}

// Every child below gets exactly the environment a test names and nothing of the
// suite's own, which may itself be running inside a task.
function taskEnv(id: string, depth: number): NodeJS.ProcessEnv {
  return { CROSS_AGENT_TASK: id, CROSS_AGENT_DEPTH: String(depth), CROSS_AGENT_LINEAGE: "[]" };
}

// ---- A walk over a /proc the test writes -------------------------------------------

// Pids above the kernel's ceiling of 2^22, so no real process can answer for them.
const [first, second] = [5_000_001, 5_000_002];

function statLine(pid: number, ppid: number, startTime: string): string {
  return `${pid} (fake) S ${ppid} ${pid} ${pid} ${Array(15).fill("0").join(" ")} ${startTime} 0 0\n`;
}

const ownStat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
const ownStart = ownStat.slice(ownStat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];

/** This process's own stat with another parent, so a walk starting here climbs a chain the test wrote. */
function ownStatWithParent(ppid: number): string {
  const end = ownStat.lastIndexOf(")") + 1;
  const fields = ownStat.slice(end).trim().split(/\s+/);
  fields[1] = String(ppid);
  return `${ownStat.slice(0, end)} ${fields.join(" ")}\n`;
}

/** Serves /proc/<pid>/stat from `stats` for the pids it names and reads everything else from disk. */
function fakeProc(t: TestContext, stats: Map<number, string | Error>) {
  const original = fs.readFileSync;
  const real = (target: fs.PathOrFileDescriptor, options?: unknown) =>
    (original as (target: fs.PathOrFileDescriptor, options?: unknown) => string)(target, options);
  return t.mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, options?: unknown) => {
    for (const [pid, value] of stats) {
      if (target !== `/proc/${pid}/stat`) continue;
      if (value instanceof Error) throw value;
      return value;
    }
    return real(target, options);
  }) as typeof fs.readFileSync);
}

// @anchor operatorCleanEnvironment
test("the operator is a clean environment whose walk reaches the root without meeting an engine", (t) => {
  const { project } = workspace(t);
  fakeProc(t, new Map([[process.pid, ownStatWithParent(first)], [first, statLine(first, 0, "100")]]));
  assert.deepEqual(resolveAuthority(project, {}, { maxDepth: 1 }), { row: "operator", reason: operator, depth: 0 });
  assert.deepEqual(resolveAuthority(project, {}, { leadRole: "lead", maxDepth: 0 }),
    { row: "specialist", reason: "specialist: depth 0 >= maxDepth 0", depth: 0 },
    "the depth cap lowers the operator as it lowers a lead");
});

// @anchor serverCarryingAny
test("a server carrying any CROSS_AGENT_* variable but matching no record is a specialist, never the operator", (t) => {
  const { project } = workspace(t);
  const cases: [NodeJS.ProcessEnv, Authority][] = [
    [{ CROSS_AGENT_TASK: "no-such-task" },
      { row: "specialist", reason: "specialist: CROSS_AGENT_TASK present and no record matches", depth: 0 }],
    [{ CROSS_AGENT_DEPTH: "0" },
      { row: "specialist", reason: "specialist: CROSS_AGENT_DEPTH present and no record matches", depth: 0 }],
    [{ CROSS_AGENT_DEPTH: "1", CROSS_AGENT_LINEAGE: "[]", CROSS_AGENT_TASK: "no-such-task" },
      { row: "specialist", reason: "specialist: CROSS_AGENT_TASK present and no record matches", depth: 1 }],
    [{ CROSS_AGENT_LINEAGE: "[]" },
      { row: "specialist", reason: "specialist: CROSS_AGENT_LINEAGE is present but CROSS_AGENT_DEPTH is absent", depth: Infinity }],
    [{ CROSS_AGENT_DEPTH: "one" },
      { row: "specialist", reason: "specialist: CROSS_AGENT_DEPTH must be a non-negative decimal safe integer", depth: Infinity }],
  ];
  for (const [env, authority] of cases) {
    assert.deepEqual(resolveAuthority(project, env, { leadRole: "lead", maxDepth: 5 }), authority, JSON.stringify(env));
  }
});

// @anchor walkFailsClosed
test("the walk fails closed on a stat it cannot read, a cycle, and a parent younger than its child", (t) => {
  const { project } = workspace(t);
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const cases: [Map<number, string | Error>, string][] = [
    [new Map<number, string | Error>([[process.pid, ownStatWithParent(first)], [first, denied]]), `specialist: cannot read /proc/${first}/stat: denied`],
    [new Map([[process.pid, ownStatWithParent(first)]]), `specialist: cannot read /proc/${first}/stat: no such process`],
    [new Map([[process.pid, ownStatWithParent(first)], [first, statLine(first, second, "100")], [second, statLine(second, first, "50")]]),
      `specialist: the walk met ancestor ${first} twice`],
    [new Map([[process.pid, ownStatWithParent(first)], [first, statLine(first, 0, String(BigInt(ownStart) + 1n))]]),
      `specialist: ancestor ${first} started after its child ${process.pid}, so the chain was reparented`],
  ];
  // Each chain would otherwise end at a root with a clean environment: the operator.
  for (const [stats, reason] of cases) {
    const proc = fakeProc(t, stats);
    const authority = resolveAuthority(project, {}, { leadRole: "lead", maxDepth: 1 });
    proc.mock.restore();
    assert.deepEqual(authority, { row: "specialist", reason, depth: 0 });
  }
});

// ---- Real chains of processes ------------------------------------------------------

interface Link { argv: string[]; env: NodeJS.ProcessEnv; pidFile?: string }

/** A fake engine that stays alive until killed. */
function engine(env: NodeJS.ProcessEnv, pidFile?: string): Link {
  return { argv: [process.execPath, "--import", preload, path.join(fixtures, "fake-engine.mjs")], env: { ...env, FAKE_ENGINE_SCRIPT: "stall" }, pidFile };
}

/** A process that does nothing but stand between its parent and its child, as an `sh -c` does. */
function wrapper(env: NodeJS.ProcessEnv): Link {
  return { argv: [process.execPath, "--import", preload, "-e", "setInterval(() => {}, 1 << 30)"], env };
}

function resolver(project: string, exchange: string, env: NodeJS.ProcessEnv): Link {
  return { argv: [process.execPath, path.join(fixtures, "resolve-authority.mjs"), exchange, project], env };
}

/** An engine's own MCP client: it starts the server as a child and makes one `tools/call`. */
function client(project: string, answer: string, tool: string, args: unknown, env: NodeJS.ProcessEnv): Link {
  return { argv: [process.execPath, path.join(fixtures, "mcp-call.mjs"), answer, project, tool, JSON.stringify(args)], env };
}

function groupMembers(pgid: number): number[] {
  return fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number).filter((pid) => {
    const stat = readProcessStat(pid);
    return stat !== null && stat.pgid === pgid && stat.state !== "Z" && stat.state !== "X";
  });
}

/**
 * Starts `links` as one chain, each the child of the one before, the first detached the
 * way a runner starts an engine; returns the first one's pid. The whole chain shares that
 * process group, which is killed when the test ends.
 */
function chain(t: TestContext, links: Link[]): number {
  const outer = links.reduceRight<Link | undefined>((child, link) =>
    child === undefined ? link : { ...link, env: { ...link.env, SPAWN_CHILD: JSON.stringify(child) } }, undefined)!;
  const child = spawn(outer.argv[0], outer.argv.slice(1), { detached: true, stdio: "ignore", env: outer.env });
  child.once("error", () => {});
  const pid = child.pid!;
  t.after(async () => {
    try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = Date.now() + 4000;
    while (groupMembers(pid).length > 0) {
      assert.ok(Date.now() < deadline, `the chain under ${pid} outlived its test`);
      await delay(10);
    }
  });
  return pid;
}

async function pidFrom(file: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file) || fs.readFileSync(file, "utf8") === "") {
    assert.ok(Date.now() < deadline, `no pid in ${file}`);
    await delay(10);
  }
  return Number(fs.readFileSync(file, "utf8"));
}

function engineIdentity(pid: number): EngineIdentity {
  return { ...identityOf(pid)!, pgid: readProcessStat(pid)!.pgid };
}

/** Asks the resolver process of `exchange` for its authority under `options`. */
function asker(exchange: string) {
  let n = 0;
  return async (options: { leadRole?: string; maxDepth: number }): Promise<Authority> => {
    n++;
    const request = path.join(exchange, `request-${n}.json`);
    fs.writeFileSync(`${request}.tmp`, JSON.stringify(options));
    fs.renameSync(`${request}.tmp`, request);
    const answer = path.join(exchange, `answer-${n}.json`);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(answer)) {
      assert.ok(Date.now() < deadline, `no answer to request ${n}`);
      await delay(10);
    }
    const reply = JSON.parse(fs.readFileSync(answer, "utf8"), (_key, value) => value === "Infinity" ? Infinity : value) as
      { authority?: Authority; error?: string };
    assert.equal(reply.error, undefined);
    return reply.authority!;
  };
}

test("a specialist's own server refuses delegate by name, with the task its ancestry matched", async (t) => {
  const { project, exchange } = workspace(t);
  // A server starts against a project that has a config, so this one is the smallest that
  // loads: the built-in `solo` mode, its one role bound to an engine.
  fs.mkdirSync(path.join(project, ".cross-agent"), { recursive: true });
  fs.writeFileSync(path.join(project, ".cross-agent", "config.json"), JSON.stringify({
    mode: "solo", roles: { consult: { engine: "claude" } }, billing: "subscription",
  }));
  const specialist = task(project, "implementer");
  const env = taskEnv(specialist.id, 1);
  const answer = path.join(exchange, "refusal.json");
  // The shape I1(ii) puts a real engine in: a specialist holding a lead's own mount, so
  // the server is reachable and ancestry is the only thing deciding what it may do.
  const pid = chain(t, [engine(env), client(project, answer, "delegate", { role: "consult", brief: "reply OK", cwd: project }, env)]);
  // The server starts while the record is still `launching`, which is the ordinary case:
  // a runner acknowledges its engine after the engine has started its own servers, so what
  // the row rests on is not knowable at startup.
  fs.writeFileSync(`${answer}.go`, "");
  const ready = Date.now() + 20_000;
  while (!fs.existsSync(`${answer}.ready`)) {
    assert.ok(Date.now() < ready, "the server never came up");
    await delay(20);
  }
  // A live runner as well as a live engine: the server reconciles before it answers, and
  // a record whose runner is gone would be adopted as `orphaned` before the walk read it.
  await update(project, specialist.id, {
    status: "running", runnerIdentity: identityOf(process.pid)!, engineIdentity: engineIdentity(pid),
  });
  fs.writeFileSync(`${answer}.call`, "");

  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(answer)) {
    assert.ok(Date.now() < deadline, "the server never answered");
    await delay(20);
  }
  const replied = JSON.parse(fs.readFileSync(answer, "utf8")) as
    { tools?: string[]; reply?: { error?: { code: number; message: string } }; error?: string; stderr?: string; stderrBeforeRequest?: string };
  assert.equal(replied.error, undefined, replied.stderr);

  // Exactly the specialist row, and `delegate` refused by this server's own name with the
  // reason the walk resolved — which names the task the ancestry matched, so a transcript
  // can tell "specialist by ancestry" from the fail-closed paths that look the same in a
  // tool list ("CROSS_AGENT_TASK present and no record matches", "the walk found neither
  // an engine nor the root within 8 hops").
  assert.deepEqual(replied.tools?.slice().sort(), ["check", "describe_mode", "list_roles", "list_tasks", "result"]);
  // And the same sentence on stderr, so a transcript that never called a tool outside the
  // row still says which row this server resolved and why. It is written at the **first
  // resolution a request asked for**, not at startup: at startup this record was still
  // `launching`, and the honest answer then would have been a fail-closed reason that this
  // very call contradicts. Once per distinct reason, so two requests do not say it twice.
  const stderr = replied.stderr ?? "";
  assert.equal(replied.stderrBeforeRequest?.includes("serving the"), false, replied.stderrBeforeRequest);
  const line = `cross-agent: serving the specialist row: specialist by ancestry: task ${specialist.id} (implementer, running)`;
  assert.equal(stderr.split("\n").filter((entry) => entry === line).length, 1, stderr);
  assert.equal(stderr.includes("no record matches"), false, stderr);
  assert.equal(replied.reply?.error?.code, -32602);
  assert.equal(
    replied.reply?.error?.message,
    `delegate is not available to a specialist server: specialist by ancestry: task ${specialist.id} (implementer, running)`,
  );
});

// @anchor engineAncestorGrants
test("an engine ancestor grants its record's row, and the depth cap can only lower it", async (t) => {
  const { project, exchange } = workspace(t);
  const lead = task(project, "lead");
  const env = taskEnv(lead.id, 1);
  const pid = chain(t, [engine(env), resolver(project, exchange, env)]);
  await update(project, lead.id, { status: "running", engineIdentity: engineIdentity(pid) });
  const ask = asker(exchange);
  const evidence = `by ancestry: task ${lead.id} (lead, running)`;

  assert.deepEqual(await ask({ leadRole: "lead", maxDepth: 2 }), { row: "lead", reason: `lead ${evidence}`, taskId: lead.id, depth: 1 });
  assert.deepEqual(await ask({ leadRole: "planner", maxDepth: 2 }), { row: "specialist", reason: `specialist ${evidence}`, taskId: lead.id, depth: 1 });
  assert.deepEqual(await ask({ maxDepth: 2 }), { row: "specialist", reason: `specialist ${evidence}`, taskId: lead.id, depth: 1 },
    "a server with no lead role to match, as under a host-placed mode, grants no lead");
  assert.deepEqual(await ask({ leadRole: "lead", maxDepth: 1 }),
    { row: "specialist", reason: "specialist: depth 1 >= maxDepth 1", taskId: lead.id, depth: 1 });

  // A depth that cannot be read lowers the lead whatever the cap, and says why.
  const untrusted = task(project, "lead");
  const untrustedEnv = { ...taskEnv(untrusted.id, 1), CROSS_AGENT_DEPTH: "one" };
  const untrustedExchange = fs.mkdtempSync(path.join(exchange, "untrusted-"));
  const untrustedPid = chain(t, [engine(untrustedEnv), resolver(project, untrustedExchange, untrustedEnv)]);
  await update(project, untrusted.id, { status: "running", engineIdentity: engineIdentity(untrustedPid) });
  assert.deepEqual(await asker(untrustedExchange)({ leadRole: "lead", maxDepth: 2 }), {
    row: "specialist", reason: "specialist: CROSS_AGENT_DEPTH must be a non-negative decimal safe integer", taskId: untrusted.id, depth: Infinity,
  });
});

// @anchor leadHoldsRow
test("a lead holds its row exactly while its record is running or stalled, re-read on every resolution", async (t) => {
  const { project, exchange } = workspace(t);
  const lead = task(project, "lead");
  const env = taskEnv(lead.id, 1);
  const pid = chain(t, [engine(env), resolver(project, exchange, env)]);
  const ask = asker(exchange);
  const options = { leadRole: "lead", maxDepth: 2 };
  const byAncestry = (row: string, status: string) =>
    ({ row, reason: `${row} by ancestry: task ${lead.id} (lead, ${status})`, taskId: lead.id, depth: 1 });

  // Before the runner's acknowledgement the record names no engine: the race is lost safely.
  assert.deepEqual(await ask(options), { row: "specialist", reason: "specialist: CROSS_AGENT_TASK present and no record matches", depth: 1 });
  await update(project, lead.id, { status: "running", engineIdentity: engineIdentity(pid) });
  assert.deepEqual(await ask(options), byAncestry("lead", "running"));
  await update(project, lead.id, { status: "stalled" });
  assert.deepEqual(await ask(options), byAncestry("lead", "stalled"));
  await update(project, lead.id, { status: "cancelling" });
  assert.deepEqual(await ask(options), byAncestry("specialist", "cancelling"));
  await update(project, lead.id, { status: "cancelled" });
  assert.deepEqual(await ask(options), byAncestry("specialist", "cancelled"));
});

test("the nearest engine decides: a server under a specialist under a lead is a specialist, even in the lead's environment", async (t) => {
  const { project, exchange } = workspace(t);
  const lead = task(project, "lead");
  const specialist = task(project, "implementer");
  const leadEnv = taskEnv(lead.id, 1);
  const pidFile = path.join(exchange, "specialist.pid");
  const leadPid = chain(t, [engine(leadEnv), engine(taskEnv(specialist.id, 2), pidFile), resolver(project, exchange, leadEnv)]);
  await update(project, lead.id, { status: "running", engineIdentity: engineIdentity(leadPid) });
  await update(project, specialist.id, { status: "running", engineIdentity: engineIdentity(await pidFrom(pidFile)) });

  assert.deepEqual(await asker(exchange)({ leadRole: "lead", maxDepth: 2 }),
    { row: "specialist", reason: `specialist by ancestry: task ${specialist.id} (implementer, running)`, taskId: specialist.id, depth: 1 });
});

test("a specialist engine holding no authority never hands the lead's row above it to its server", async (t) => {
  const { project, exchange } = workspace(t);
  const lead = task(project, "lead");
  const specialist = task(project, "implementer");
  const env = taskEnv(specialist.id, 2);
  const pidFile = path.join(exchange, "specialist.pid");
  const leadPid = chain(t, [engine(taskEnv(lead.id, 1)), engine(env, pidFile), resolver(project, exchange, env)]);
  const specialistPid = await pidFrom(pidFile);
  await update(project, lead.id, { status: "running", engineIdentity: engineIdentity(leadPid) });
  const ask = asker(exchange);
  const options = { leadRole: "lead", maxDepth: 2 };

  // Unacknowledged, the specialist's record names no engine, and the walk goes on to the
  // lead's: the task this server carries is what keeps the lead's row from reaching it.
  assert.deepEqual(await ask(options), {
    row: "specialist", depth: 2,
    reason: `specialist: this server carries CROSS_AGENT_TASK=${specialist.id}, but the nearest engine ancestor ${leadPid} is task ${lead.id}'s`,
  });
  await update(project, specialist.id, { status: "running", engineIdentity: engineIdentity(specialistPid) });
  assert.deepEqual(await ask(options),
    { row: "specialist", reason: `specialist by ancestry: task ${specialist.id} (implementer, running)`, taskId: specialist.id, depth: 2 });
  // An engine whose record lost its authority still ends the walk.
  await update(project, specialist.id, { status: "orphaned" });
  assert.deepEqual(await ask(options),
    { row: "specialist", reason: `specialist by ancestry: task ${specialist.id} (implementer, orphaned)`, taskId: specialist.id, depth: 2 });
});

// @anchor serverWhoseEngine
test("a server whose engine passed it no environment still finds the task in an ancestor's", async (t) => {
  const { project, exchange } = workspace(t);
  const lead = task(project, "lead");
  // The engine carries the task and the server it starts carries nothing of it, as a
  // server does whose engine builds its environment from a list of its own.
  const pid = chain(t, [engine(taskEnv(lead.id, 1)), resolver(project, exchange, {})]);
  const ask = asker(exchange);
  const options = { leadRole: "lead", maxDepth: 1 };

  assert.deepEqual(await ask(options),
    { row: "specialist", reason: `specialist: ancestor ${pid} carries CROSS_AGENT_TASK=${lead.id} and no record matches`, depth: 0 });
  await update(project, lead.id, { status: "running", engineIdentity: engineIdentity(pid) });
  assert.deepEqual(await ask(options), { row: "lead", reason: `lead by ancestry: task ${lead.id} (lead, running)`, taskId: lead.id, depth: 0 });
});

// @anchor identityAnotherBoot
test("an identity from another boot, or an engine not carrying its task, matches nothing", async (t) => {
  const { project, exchange } = workspace(t);
  const foreign = task(project, "lead");
  const env = taskEnv(foreign.id, 1);
  const foreignPid = chain(t, [engine(env), resolver(project, exchange, env)]);
  await update(project, foreign.id, { status: "running", engineIdentity: { ...engineIdentity(foreignPid), bootId: "3a1e0e6c-0000-4000-8000-000000000000" } });
  assert.deepEqual(await asker(exchange)({ leadRole: "lead", maxDepth: 2 }),
    { row: "specialist", reason: "specialist: CROSS_AGENT_TASK present and no record matches", depth: 1 });

  const bare = task(project, "lead");
  const bareExchange = fs.mkdtempSync(path.join(exchange, "bare-"));
  const barePid = chain(t, [engine({}), resolver(project, bareExchange, {})]);
  await update(project, bare.id, { status: "running", engineIdentity: engineIdentity(barePid) });
  assert.deepEqual(await asker(bareExchange)({ leadRole: "lead", maxDepth: 2 }), {
    row: "specialist", depth: 0,
    reason: `specialist: ancestor ${barePid} holds the engine identity of task ${bare.id}, but its environment names no task`,
  });
});

// @anchor walkReachesEngine
test("the walk reaches an engine eight hops up and fails closed at nine", async (t) => {
  const { project, exchange } = workspace(t);
  for (const wrappers of [7, 8]) {
    const lead = task(project, "lead");
    const dir = fs.mkdtempSync(path.join(exchange, `hops-${wrappers + 1}-`));
    // Only the engine carries the task, so nothing but the walk can find it.
    const pid = chain(t, [engine(taskEnv(lead.id, 1)), ...Array.from({ length: wrappers }, () => wrapper({})), resolver(project, dir, {})]);
    await update(project, lead.id, { status: "running", engineIdentity: engineIdentity(pid) });
    const authority = await asker(dir)({ leadRole: "lead", maxDepth: 1 });
    assert.deepEqual(authority, wrappers === 7
      ? { row: "lead", reason: `lead by ancestry: task ${lead.id} (lead, running)`, taskId: lead.id, depth: 0 }
      : { row: "specialist", reason: "specialist: the walk found neither an engine nor the root within 8 hops", depth: 0 });
  }
});
