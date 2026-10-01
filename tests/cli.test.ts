import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONFIG_PATH, effectiveMaxDepth, loadConfigWithMode } from "../src/config.ts";
import { builtInModesDir } from "../src/modes.ts";

// `cross-agent`, the operator's own entry point (design section 10): a table of verbs —
// `init`, `answer` and `report` so far — over one parser and one exit protocol. Every exit
// code below is the protocol's: 0 ok, 1 an error nothing anticipated, 2 a command line it
// cannot read, 3 a precondition the verb needs and does not have.

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const suiteEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CROSS_AGENT_")));

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** The CLI as a host runs it: its own process, its own exit code. */
async function run(args: string[], cwd: string, bin: string[] = [process.execPath, cli]): Promise<Ran> {
  try {
    const { stdout, stderr } = await exec(bin[0], [...bin.slice(1), ...args], { cwd, env: suiteEnv, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function scratch(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "cross-agent-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function written(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_PATH), "utf8")) as Record<string, unknown>;
}

// @anchor initModeDev
test("init --mode dev-team writes the section 6 config, bound to the built-in mode", async (t) => {
  const root = scratch(t);
  const ran = await run(["init", "--mode", "dev-team"], root);
  assert.equal(ran.code, 0, ran.stderr);
  assert.match(ran.stdout, /dev-team/);
  // The project's own state is ignored by the same verb that creates it: both root tools
  // refuse to work in a project that tracks `.cross-agent/`.
  assert.match(ran.stdout, /\.gitignore/);
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), ".cross-agent/\n.worktrees/\n");
  assert.match(ran.stdout, new RegExp(path.join(root, CONFIG_PATH).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.deepEqual(written(root), {
    mode: "dev-team",
    project: { defaultBranch: "main", testCommand: "npm test", setupCommand: "none", mergePolicy: "auto" },
    roles: {
      planner: { engine: "codex", model: "gpt-6-astra", effort: "high" },
      "plan-reviewer": { engine: "claude", model: "claude-opus-5" },
      implementer: { engine: "codex", model: "gpt-6-astra" },
      "code-reviewer": { engine: "claude", model: "claude-opus-5", sandbox: "read-only" },
      // The role every mode carries, bound to a starting engine any call may override.
      consult: { engine: "codex", model: "gpt-6-astra" },
    },
    engines: { claude: {}, codex: {}, grok: {} },
    limits: {
      maxDepth: 1, stallMinutes: 15, waitDefaultSeconds: 600, duplicateWindowMinutes: 10, lockWaitSeconds: 5,
      cancelGraceSeconds: 5,
    },
    billing: "subscription",
  });
  // What it wrote loads, against the mode it named: the four roles run under the profiles
  // the mode defaults them to.
  const bound = loadConfigWithMode(root, builtInModesDir());
  assert.deepEqual(bound.mode.roles.map((role) => role.sandboxDefault), ["read-only", "read-only", "workspace-write", "read-only", "read-only"]);
  assert.equal(effectiveMaxDepth(bound.mode, bound.config), 1);

  // Every project in this suite is under the system temporary directory, which Codex and
  // Grok sandboxes treat as writable: `init` says so on stderr rather than silently
  // writing a config for a project its own sandboxes do not isolate.
  assert.match(ran.stderr, /^cross-agent: /);
  assert.match(ran.stderr, /writable/);
  assert.match(ran.stderr, /not isolated/);

  // A second run neither rewrites nor fails: the operator's own edits survive it.
  const bytes = fs.readFileSync(path.join(root, CONFIG_PATH), "utf8");
  const again = await run(["init", "--mode", "dev-team"], root);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already/);
  assert.equal(fs.readFileSync(path.join(root, CONFIG_PATH), "utf8"), bytes);
});

// @anchor initModeBinds
test("init --mode binds each built-in mode's own roles, and an engine-placed lead raises the cap", async (t) => {
  const engineRoot = scratch(t);
  assert.equal((await run(["init", "--mode", "dev-team-engine"], engineRoot)).code, 0);
  const led = written(engineRoot);
  assert.deepEqual((led.roles as Record<string, unknown>).lead, { engine: "claude", model: "claude-opus-5", effort: "high" });
  // A lead runs at depth 1 and its specialists at 2, and the documented default of 1
  // would hold them at the lead: the mode's cap is written, not left to be derived.
  assert.equal((led.limits as Record<string, number>).maxDepth, 2);
  const bound = loadConfigWithMode(engineRoot, builtInModesDir());
  assert.equal(effectiveMaxDepth(bound.mode, bound.config), 2);

  const soloRoot = scratch(t);
  assert.equal((await run(["init", "--mode", "solo"], soloRoot)).code, 0);
  assert.deepEqual(written(soloRoot).roles, { consult: { engine: "codex", model: "gpt-6-astra" } });
  assert.equal((written(soloRoot).limits as Record<string, number>).maxDepth, 1);
  // Solo declares no worktree role, so nothing in its config names a branch or a directory.
  assert.equal(loadConfigWithMode(soloRoot, builtInModesDir()).mode.git, undefined);
});

// @anchor initProjectWrites
test("init --project writes to the project it names, in either flag order, and defaults to the working directory", async (t) => {
  const elsewhere = scratch(t);
  const target = scratch(t);
  for (const args of [["init", "--mode", "solo", "--project", target], ["init", "--project", target, "--mode", "solo"]]) {
    fs.rmSync(path.join(target, ".cross-agent"), { recursive: true, force: true });
    const ran = await run(args, elsewhere);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(written(target).mode, "solo");
    assert.equal(fs.existsSync(path.join(elsewhere, CONFIG_PATH)), false, "the working directory is not the project here");
  }
  // A relative --project resolves against the working directory.
  const nested = path.join(elsewhere, "nested");
  fs.mkdirSync(nested);
  assert.equal((await run(["init", "--mode", "solo", "--project", "nested"], elsewhere)).code, 0);
  assert.equal(written(nested).mode, "solo");
  // With no flag at all, the working directory is the project and the mode is the default team.
  const here = scratch(t);
  assert.equal((await run(["init"], here)).code, 0);
  assert.equal(written(here).mode, "dev-team");
});

// @anchor modeBuildError
test("a mode this build does not have is a precondition, and a command line it cannot read is usage", async (t) => {
  const root = scratch(t);
  // Ruling 3: one protocol for every verb, and what init needs and does not have is a 3.
  for (const mode of ["no-such-mode", "../solo"]) {
    const unknown = await run(["init", "--mode", mode], root);
    assert.equal(unknown.code, 3, unknown.stderr);
    assert.match(unknown.stderr, new RegExp(mode.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
    assert.equal(unknown.stdout, "");
  }
  assert.equal(fs.existsSync(path.join(root, CONFIG_PATH)), false, "a refused init writes nothing");

  const missingProject = await run(["init", "--mode", "solo", "--project", path.join(root, "absent")], root);
  assert.equal(missingProject.code, 3);
  assert.match(missingProject.stderr, /absent/);
  assert.equal(fs.existsSync(path.join(root, "absent")), false);

  for (const args of [
    [], ["modes"], ["init", "--mode"], ["init", "--mode", "solo", "extra"], ["init", "--engine", "codex"],
    ["init", "--mode", "solo", "--mode", "dev-team"], ["--mode", "solo"], ["init", "--mode", ""],
    ["report", "extra"], ["answer", "only-an-id"], ["answer", "id", "text", "more"],
    ["report", "--since"], ["report", "--mode", "solo"], ["answer", "id", "text", "--since", "x"],
  ]) {
    const ran = await run(args, root);
    assert.equal(ran.code, 2, `${args.join(" ")}: ${ran.stderr}`);
    assert.match(ran.stderr, /usage: cross-agent/, args.join(" "));
    assert.equal(ran.stdout, "", "a command line that cannot be read, asked for as text, prints nothing on stdout");
  }
  // Asked for as JSON, the same refusal is the one document on stdout (`#jsonOnEveryExit`).
  const twice = await run(["init", "--json", "--json"], root);
  assert.equal(twice.code, 2, twice.stderr);
  assert.match((JSON.parse(twice.stdout) as { error: string }).error, /--json given twice/);
});

// @anchor shebangEntryPoint
test("the packaged entry point runs from its own shebang, as the bin field names it", async (t) => {
  const root = scratch(t);
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    bin?: Record<string, string>;
  };
  assert.deepEqual(pkg.bin, { "cross-agent": "src/cli.ts" });
  const entry = fileURLToPath(new URL(`../${pkg.bin!["cross-agent"]}`, import.meta.url));
  assert.equal(fs.readFileSync(entry, "utf8").startsWith("#!/usr/bin/env node\n"), true);
  assert.ok(fs.statSync(entry).mode & 0o111, "the entry point is executable");
  // Run it as the shebang makes it runnable, which is how a host on PATH will.
  const ran = await run(["init", "--mode", "solo"], root, [entry]);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(written(root).mode, "solo");
});

// @anchor exitProtocol
test("the exit protocol is one set of codes, and --help prints it beside every verb", async (t) => {
  const { EXIT } = await import("../src/cli.ts");
  assert.deepEqual(EXIT, { ok: 0, error: 1, usage: 2, precondition: 3, running: 4, needsOperator: 5, stalled: 6 });
  const root = scratch(t);
  for (const args of [["--help"], ["help"], ["init", "--help"], ["report", "--help"], ["answer", "--help"]]) {
    const ran = await run(args, root);
    assert.equal(ran.code, 0, `${args.join(" ")}: ${ran.stderr}`);
    for (const verb of ["init", "answer", "report"]) assert.match(ran.stdout, new RegExp(`cross-agent ${verb}`), `${args.join(" ")} names ${verb}`);
    for (const [code, word] of [[0, "ok"], [1, "error"], [2, "usage"], [3, "precondition"], [4, "still running"], [5, "needs the operator"], [6, "stalled"]] as const) {
      assert.match(ran.stdout, new RegExp(`^\\s*${code}\\s+${word}`, "m"), `${args.join(" ")}: exit ${code}`);
    }
    assert.match(ran.stdout, /--json/);
    // `init` is the one verb that does not find its project as the server does: it makes one.
    assert.match(ran.stdout.replace(/\s+/g, " "), /without --project, init writes in the current directory/i);
  }
  assert.equal(fs.existsSync(path.join(root, ".cross-agent")), false, "help writes nothing");
});

// @anchor initJson
test("init --json prints one JSON document on stdout, for what it wrote and for what it refused", async (t) => {
  const root = scratch(t);
  const ran = await run(["init", "--mode", "solo", "--json"], root);
  assert.equal(ran.code, 0, ran.stderr);
  const document = JSON.parse(ran.stdout) as Record<string, unknown>;
  assert.deepEqual({ ...document, warning: undefined }, {
    wrote: true, file: path.join(root, CONFIG_PATH), mode: "solo", ignored: [".cross-agent/", ".worktrees/"], warning: undefined,
  });
  // The project is under the temporary directory, so the warning travels in the document too.
  assert.match(document.warning as string, /not isolated/);
  const refused = await run(["--json", "init", "--mode", "no-such-mode"], root);
  assert.equal(refused.code, 3);
  assert.equal((JSON.parse(refused.stdout) as { ok: boolean }).ok, false);
  assert.match((JSON.parse(refused.stdout) as { reason: string }).reason, /no-such-mode/);
});

// @anchor jsonOnEveryExit
test("--json prints one JSON document on stdout whatever the exit, a usage error and an unanticipated one included", async (t) => {
  const root = scratch(t);
  const usage = async (args: string[], verbs: string[]) => {
    const ran = await run(args, root);
    assert.equal(ran.code, 2, `${args.join(" ")}: ${ran.stderr}`);
    const document = JSON.parse(ran.stdout) as { ok: boolean; error: string; usage: string[] };
    assert.equal(document.ok, false);
    assert.equal(typeof document.error, "string");
    for (const verb of verbs) assert.ok(document.usage.some((line) => line.startsWith(`cross-agent ${verb}`)), `${args.join(" ")}: usage names ${verb}`);
    return document;
  };
  assert.match((await usage(["--json", "no-such-verb"], ["init", "answer", "report"])).error, /unknown command "no-such-verb"/);
  assert.match((await usage(["--json"], ["init", "answer", "report"])).error, /no command/);
  assert.match((await usage(["report", "--json", "--bogus", "x"], ["report"])).error, /--bogus/);
  assert.match((await usage(["answer", "only-one", "--json"], ["answer"])).error, /answer takes <ask-id> <text>/);
  // `--json` after `--` is an argument, not the flag: that command line reads as text.
  const text = await run(["report", "--", "--json"], root);
  assert.equal(text.code, 2);
  assert.equal(text.stdout, "");
  assert.match(text.stderr, /report takes no arguments/);

  // An error nothing anticipated: a result file that is a directory cannot be read.
  const project = await engineProject(t);
  const { create } = await import("../src/ledger.ts");
  const record = create(project, { role: "planner", brief: "b", cwd: project, engine: "claude", depth: 1 });
  fs.mkdirSync(record.resultPath);
  const broken = await run(["report", "--json"], project);
  assert.equal(broken.code, 1, broken.stderr);
  const error = JSON.parse(broken.stdout) as { ok: boolean; error: string };
  assert.equal(error.ok, false);
  assert.match(error.error, /EISDIR/);
  const plain = await run(["report"], project);
  assert.equal(plain.code, 1);
  assert.equal(plain.stdout, "", "without --json an error is stderr's alone");
  assert.match(plain.stderr, /EISDIR/);
});

/** A git repository holding a `dev-team-engine` config, as `init` writes it: the project an engine-placed lead asks in. */
async function engineProject(t: TestContext): Promise<string> {
  const root = scratch(t);
  await exec("git", ["-C", root, "init", "-b", "main"]);
  const ran = await run(["init", "--mode", "dev-team-engine"], root);
  assert.equal(ran.code, 0, ran.stderr);
  return root;
}

// @anchor answerVerb
test("answer replies to an open ask from a terminal: the first answer is 0, a second, a cancelled or an unknown ask 3", async (t) => {
  const root = await engineProject(t);
  const { cancelAsks, createAsk, readAsk } = await import("../src/mailbox.ts");
  const open = createAsk(root, { taskId: "lead1", question: "Which slug?" });

  const answered = await run(["answer", open.id, "use s11-i2", "--project", root], root);
  assert.equal(answered.code, 0, answered.stderr);
  assert.match(answered.stdout, new RegExp(open.id));
  assert.match(answered.stdout, /use s11-i2/);
  const record = readAsk(root, open.id)!;
  assert.equal(record.status, "answered");
  assert.equal(record.answer, "use s11-i2");

  // The first answer stands, and the second is told when it landed.
  const second = await run(["answer", open.id, "something else", "--project", root], root);
  assert.equal(second.code, 3);
  assert.match(second.stderr, new RegExp(`answeredAt ${record.answeredAt}`));
  assert.equal(readAsk(root, open.id)!.answer, "use s11-i2");
  const asJson = await run(["answer", open.id, "again", "--project", root, "--json"], root);
  assert.equal(asJson.code, 3);
  assert.deepEqual(JSON.parse(asJson.stdout), { applied: false, reason: JSON.parse(asJson.stdout).reason, ask: record });

  const cancelled = createAsk(root, { taskId: "lead2", question: "Rebase?" });
  await cancelAsks(root, ["lead2"]);
  const late = await run(["answer", cancelled.id, "yes", "--project", root], root);
  assert.equal(late.code, 3);
  assert.match(late.stderr, /cancelled/);
  const unknown = await run(["answer", "0".repeat(36), "yes", "--project", root], root);
  assert.equal(unknown.code, 3);
  assert.match(unknown.stderr, /no ask/);
  // An id no ask file could carry is the mailbox's own refusal, by value.
  const malformed = await run(["answer", "../tasks/x", "yes", "--project", root], root);
  assert.equal(malformed.code, 3, malformed.stderr);
  assert.match(malformed.stderr, /no ask "\.\.\/tasks\/x": an ask id is/);

  // With --json the record is the one document on stdout, and the working directory finds
  // the project as the server does when no --project names it.
  const third = createAsk(root, { taskId: "lead3", question: "Merge?" });
  const json = await run(["--json", "answer", third.id, "yes"], root);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { applied: true, ask: readAsk(root, third.id) });
});

// @anchor answerWritesNothing
test("answer in a project with no config or no mailbox is a 3, and writes nothing", async (t) => {
  // A repository nobody initialized is a project — it runs solo at its toplevel — but no
  // lead of it asks anything, so `answer` refuses it at the config; a directory no project
  // holds is not one at all.
  const bare = scratch(t);
  await exec("git", ["-C", bare, "init", "-b", "main"]);
  const before = fs.readdirSync(bare).sort();
  const unknown = await run(["answer", "a".repeat(36), "yes"], bare);
  assert.equal(unknown.code, 3, unknown.stderr);
  assert.match(unknown.stderr, /holds no \.cross-agent\/config\.json/);
  assert.deepEqual(fs.readdirSync(bare).sort(), before, "no .cross-agent/, no lock, no mailbox");

  const nowhere = scratch(t);
  const unresolved = await run(["answer", "a".repeat(36), "yes"], nowhere);
  assert.equal(unresolved.code, 3, unresolved.stderr);
  assert.deepEqual(fs.readdirSync(nowhere), []);
  const named = await run(["answer", "a".repeat(36), "yes", "--project", nowhere], bare);
  assert.equal(named.code, 3, named.stderr);
  assert.match(named.stderr, /holds no \.cross-agent\/config\.json/);

  // An open ask in a repository whose config is gone: discovery still finds the git
  // toplevel, and the answer is refused there before anything is written.
  const root = await engineProject(t);
  const { createAsk } = await import("../src/mailbox.ts");
  const open = createAsk(root, { taskId: "lead1", question: "Which slug?" });
  const askFile = path.join(root, ".cross-agent", "asks", `${open.id}.json`);
  const asked = fs.readFileSync(askFile, "utf8");
  fs.rmSync(path.join(root, CONFIG_PATH));
  const locks = path.join(root, ".cross-agent", "locks");
  const lockedBefore = fs.existsSync(locks) ? fs.readdirSync(locks).sort() : [];
  const configless = await run(["answer", open.id, "use s11-i2"], root);
  assert.equal(configless.code, 3, configless.stderr);
  assert.match(configless.stderr, /config\.json/);
  assert.equal(fs.readFileSync(askFile, "utf8"), asked, "the ask is as it was");
  assert.deepEqual(fs.existsSync(locks) ? fs.readdirSync(locks).sort() : [], lockedBefore, "and no lock was taken for it");
});

// @anchor reportVerb
test("report renders every task newest first, then each final message, three-valued per task", async (t) => {
  const root = await engineProject(t);
  const { create, update } = await import("../src/ledger.ts");
  const seeded: Array<{ id: string; label: string }> = [];
  /** A record moved along the transition table to `status`, with a final message or none. */
  const seed = async (label: string, status: string, at: number, out: string | null) => {
    const record = create(root, { role: label, brief: label, cwd: root, engine: "claude", model: "claude-sonnet-5", effort: "medium", depth: 2 }, at);
    const path_: Record<string, string[]> = {
      launching: [], running: ["running"], stalled: ["running", "stalled"], orphaned: ["orphaned"],
      cancelling: ["cancelling"], done: ["running", "done"], failed: ["running", "failed"], cancelled: ["cancelling", "cancelled"],
    };
    let now = at;
    for (const step of path_[status]) {
      now += 10_000;
      assert.equal((await update(root, record.id, { status: step as never }, now)).applied, true);
    }
    if (out !== null) fs.writeFileSync(record.resultPath, out);
    seeded.push({ id: record.id, label });
    return record;
  };
  const base = Date.now() - 3_600_000;
  await seed("planner", "done", base, "The plan.\n");
  await seed("plan-reviewer", "done", base + 1_000, null);
  await seed("implementer", "failed", base + 2_000, "BLOCKED: no such file.\n");
  await seed("code-reviewer", "cancelled", base + 3_000, "");
  await seed("consult", "running", base + 4_000, null);
  await seed("lead", "stalled", base + 5_000, null);
  await seed("lead-orphan", "orphaned", base + 6_000, null);
  await seed("lead-cancelling", "cancelling", base + 7_000, null);
  await seed("lead-launching", "launching", base + 8_000, null);

  const ran = await run(["report", "--project", root], root);
  assert.equal(ran.code, 0, ran.stderr);
  const lines = ran.stdout.split("\n");
  const rows = lines.filter((line) => /^\S.* \| /.test(line));
  // Newest first, one line per task: role, engine, model, effort, duration, outcome, id.
  assert.deepEqual(rows.map((line) => line.split(" | ")[0]), seeded.map((entry) => entry.label).reverse());
  const outcome = (label: string) => rows.find((line) => line.startsWith(`${label} | `))!.split(" | ")[5];
  assert.equal(outcome("planner"), "passed");
  assert.equal(outcome("plan-reviewer"), "unknown", "done, but the result file is missing");
  assert.equal(outcome("implementer"), "failed");
  assert.equal(outcome("code-reviewer"), "failed", "cancelled is a failure the report names");
  for (const label of ["consult", "lead", "lead-orphan", "lead-cancelling", "lead-launching"]) assert.equal(outcome(label), "unknown", label);
  assert.deepEqual(rows.find((line) => line.startsWith("planner | "))!.split(" | "), [
    // Settled two transitions after it was created, ten seconds apart.
    "planner", "claude", "claude-sonnet-5", "medium", "20s", "passed", seeded[0].id,
  ]);
  // Then each task's final message, read from its record's result file.
  assert.match(ran.stdout, /The plan\./);
  assert.match(ran.stdout, /BLOCKED: no such file\./);
  assert.ok(ran.stdout.indexOf(`## ${seeded[2].id}`) < ran.stdout.indexOf(`## ${seeded[0].id}`), "the messages in the order of the lines");

  // --since keeps the tasks created at or after that task's own creation.
  const since = await run(["report", "--project", root, "--since", seeded[6].id], root);
  assert.equal(since.code, 0, since.stderr);
  assert.deepEqual(since.stdout.split("\n").filter((line) => /^\S.* \| /.test(line)).map((line) => line.split(" | ")[0]),
    ["lead-launching", "lead-cancelling", "lead-orphan"]);
  const unknownSince = await run(["report", "--project", root, "--since", "0".repeat(36)], root);
  assert.equal(unknownSince.code, 3);
  assert.match(unknownSince.stderr, /no task/);

  // --json: the same fields, one document.
  const json = await run(["report", "--json", "--project", root, "--since", seeded[0].id], root);
  assert.equal(json.code, 0, json.stderr);
  const tasks = (JSON.parse(json.stdout) as { tasks: Array<Record<string, unknown>> }).tasks;
  assert.equal(tasks.length, seeded.length);
  assert.deepEqual(tasks.at(-1), {
    id: seeded[0].id, role: "planner", engine: "claude", model: "claude-sonnet-5", effort: "medium",
    status: "done", durationSeconds: 20, outcome: "passed", result: "The plan.\n",
  });
  assert.equal(tasks.find((task) => task.id === seeded[1].id)!.result, null);
});

// @anchor reportWritesNothing
test("report over an empty or absent ledger is 0, says nothing, and creates nothing", async (t) => {
  const bare = scratch(t);
  await exec("git", ["-C", bare, "init", "-b", "main"]);
  const before = fs.readdirSync(bare).sort();
  const empty = await run(["report"], bare);
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(empty.stdout, "");
  assert.deepEqual(JSON.parse((await run(["report", "--json"], bare)).stdout), { tasks: [] });
  assert.deepEqual(fs.readdirSync(bare).sort(), before, "a read creates no ledger");
  const root = await engineProject(t);
  const configured = await run(["report", "--json", "--project", root], root);
  assert.deepEqual(JSON.parse(configured.stdout), { tasks: [] });
  assert.equal(fs.existsSync(path.join(root, ".cross-agent", "tasks")), false);
});
