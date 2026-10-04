import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONFIG_PATH, effectiveMaxDepth, loadConfigWithMode } from "../src/config.ts";
import type { TaskRecord } from "../src/ledger.ts";
import { builtInModesDir } from "../src/modes.ts";
import { git } from "./helpers/git.ts";
import {
  bareDotGitProject, layoutRoot, linkedProject, mainCheckout, rootInsideCommonDir, separatedMainProject, submoduleProject, symlinkedGitProject,
  umbrellaProject,
} from "./helpers/project.ts";
import { deadIdentity, seededProject, snapshot } from "./helpers/seed.ts";
import type { SeededProject } from "./helpers/seed.ts";

// `cross-agent`, the operator's own entry point (design section 10): a table of verbs over
// one parser and one exit protocol. Every exit code below is the protocol's: 0 ok, 1 an
// error nothing anticipated, 2 a command line it cannot read, 3 a precondition the verb
// needs and does not have, 4 a task still running, 5 a lead waiting on the operator, 6 a
// task stalled.

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const suiteEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CROSS_AGENT_")));

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** The CLI as a host runs it: its own process, its own exit code, the environment it is given. */
async function run(args: string[], cwd: string, bin: string[] = [process.execPath, cli], env: NodeJS.ProcessEnv = suiteEnv): Promise<Ran> {
  try {
    const { stdout, stderr } = await exec(bin[0], [...bin.slice(1), ...args], { cwd, env, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * Command lines that read and write nothing, each its own process as `run` makes it, four at
 * a time, answered in the order given: what each one prints does not depend on the others.
 */
async function runEach(lines: string[][], cwd: string, env: NodeJS.ProcessEnv = suiteEnv): Promise<Ran[]> {
  const results: Ran[] = new Array(lines.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, lines.length) }, async () => {
    while (next < lines.length) {
      const index = next++;
      results[index] = await run(lines[index], cwd, undefined, env);
    }
  }));
  return results;
}

/** Every verb, in the order usage lists them. */
const usageOrder = ["init", "modes", "tasks", "show", "log", "cancel", "verify-worktree", "git", "git-root", "journal", "waive", "list-asks", "answer", "report"];

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
      // One seat per engine, each reading under a read-only sandbox.
      "code-reviewer": [
        { engine: "claude", model: "claude-opus-5", sandbox: "read-only" },
        { engine: "codex", model: "gpt-6-astra", sandbox: "read-only" },
        { engine: "grok", model: "grok-4.7", sandbox: "read-only" },
      ],
      // The escalation, on a stronger setting than the implementer's.
      resolver: { engine: "codex", model: "gpt-6-astra", effort: "high" },
      // The role every mode carries, bound to a starting engine any call may override.
      consult: { engine: "codex", model: "gpt-6-astra" },
    },
    engines: { claude: {}, codex: {}, grok: {} },
    limits: {
      maxDepth: 1, stallMinutes: 15, waitDefaultSeconds: 600, duplicateWindowMinutes: 10, lockWaitSeconds: 5,
      cancelGraceSeconds: 5, planReviewRounds: 3,
    },
    // What the loop does after the resolver's round: ask the user, unless edited here.
    review: { afterResolver: "ask" },
    billing: "subscription",
  });
  // What it wrote loads, against the mode it named: every role runs under the profile the
  // mode defaults it to.
  const bound = loadConfigWithMode(root, builtInModesDir());
  assert.deepEqual(bound.mode.roles.map((role) => role.sandboxDefault),
    ["read-only", "read-only", "workspace-write", "read-only", "workspace-write", "read-only"]);
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
  assert.deepEqual((led.roles as Record<string, unknown>).resolver, { engine: "codex", model: "gpt-6-astra", effort: "high" });
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
    [], ["modes", "extra"], ["init", "--mode"], ["init", "--mode", "solo", "extra"], ["init", "--engine", "codex"],
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

// @anchor symlinkedEntryPoint
test("the CLI runs when started through a link: npm's bin link and a linked checkout", async (t) => {
  // `npm link` and `npm install -g` install the bin as a symlink, and a checkout may be
  // reached through one. Node runs the module at its real path, so an entry point that
  // compared the path it was started by with its own URL did nothing and exited 0.
  const root = scratch(t);
  const links = scratch(t);
  const entry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  fs.mkdirSync(path.join(links, "bin"));
  fs.symlinkSync(entry, path.join(links, "bin", "cross-agent"));
  fs.symlinkSync(fileURLToPath(new URL("..", import.meta.url)), path.join(links, "checkout"));
  for (const bin of [[path.join(links, "bin", "cross-agent")], [process.execPath, path.join(links, "checkout", "src", "cli.ts")]]) {
    const ran = await run(["--help"], root, bin);
    assert.equal(ran.code, 0, `${bin.join(" ")}: ${ran.stderr}`);
    assert.match(ran.stdout, /cross-agent init/, `${bin.join(" ")} printed its usage`);
  }
});

// @anchor exitProtocol
test("the exit protocol is one set of codes, and --help prints it beside every verb", async (t) => {
  const { EXIT } = await import("../src/cli.ts");
  assert.deepEqual(EXIT, { ok: 0, error: 1, usage: 2, precondition: 3, running: 4, needsOperator: 5, stalled: 6 });
  const root = scratch(t);
  for (const args of [["--help"], ["help"], ["init", "--help"], ["report", "--help"], ["answer", "--help"]]) {
    const ran = await run(args, root);
    assert.equal(ran.code, 0, `${args.join(" ")}: ${ran.stderr}`);
    for (const verb of usageOrder) assert.match(ran.stdout, new RegExp(`cross-agent ${verb}`), `${args.join(" ")} names ${verb}`);
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
  assert.match((await usage(["--json", "no-such-verb"], usageOrder)).error, /unknown command "no-such-verb"/);
  assert.match((await usage(["--json"], usageOrder)).error, /no command/);
  assert.match((await usage(["report", "--json", "--bogus", "x"], ["report"])).error, /--bogus/);
  assert.match((await usage(["answer", "only-one", "--json"], ["answer"])).error, /answer takes <ask-id> <text>/);
  // Help is one document too: the verbs, the project rule and the exit protocol.
  for (const args of [["--json", "--help"], ["help", "--json"], ["report", "--help", "--json"], ["--help", "--json"]]) {
    const ran = await run(args, root);
    assert.equal(ran.code, 0, `${args.join(" ")}: ${ran.stderr}`);
    const help = JSON.parse(ran.stdout) as { ok: boolean; usage: string; verbs: Array<{ usage: string; summary: string }>; project: string; exit: Array<{ code: number; meaning: string }> };
    assert.equal(help.ok, true);
    assert.deepEqual(help.verbs.map((verb) => verb.usage.split(" ")[1]), usageOrder, args.join(" "));
    assert.deepEqual(help.exit.map((entry) => entry.code), [0, 1, 2, 3, 4, 5, 6]);
    assert.match(help.project, /init writes in the current directory/);
  }
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
  const record = readAsk(root, open.id).ask!;
  assert.equal(record.status, "answered");
  assert.equal(record.answer, "use s11-i2");

  // The first answer stands, and the second is told when it landed.
  const second = await run(["answer", open.id, "something else", "--project", root], root);
  assert.equal(second.code, 3);
  assert.match(second.stderr, new RegExp(`answeredAt ${record.answeredAt}`));
  assert.equal(readAsk(root, open.id).ask!.answer, "use s11-i2");
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
  assert.deepEqual(JSON.parse(json.stdout), { applied: true, ask: readAsk(root, third.id).ask });
});

// @anchor answerDamagedAsk
test("answer to a damaged ask file is a 3 naming the file, as an unknown ask is, and leaves it as it was", async (t) => {
  const seeded = await seededProject(t);
  const before = fs.readFileSync(seeded.brokenAsk, "utf8");
  const ran = await run(["answer", "broken", "text", "--project", seeded.root], seeded.root);
  assert.equal(ran.code, 3, ran.stderr);
  assert.ok(ran.stderr.includes(seeded.brokenAsk), ran.stderr);
  assert.equal(fs.readFileSync(seeded.brokenAsk, "utf8"), before);
});

// @anchor answerTimeOutOfRange
test("answer to an answered or cancelled ask whose time no date can hold is a 3, never a 1", async (t) => {
  const root = await engineProject(t);
  const asks = path.join(root, ".cross-agent", "asks");
  fs.mkdirSync(asks, { recursive: true });
  for (const record of [
    { id: "answered", taskId: "lead1", question: "Q", createdAt: 1, status: "answered", answer: "A", answeredAt: 1e100 },
    { id: "cancelled", taskId: "lead1", question: "Q", createdAt: 1, status: "cancelled", cancelledAt: 1e100 },
  ]) {
    fs.writeFileSync(path.join(asks, `${record.id}.json`), JSON.stringify(record));
    const ran = await run(["answer", record.id, "yes", "--project", root], root);
    assert.equal(ran.code, 3, `${record.id}: ${ran.stderr}`);
    assert.match(ran.stderr, new RegExp(`refused answer to ask ${record.id}: it was (answered|cancelled) at 1e\\+100`));
  }
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
  // A final message is the engine's own text, and a Markdown table in it — or any line
  // shaped like a row — must not be read as one of the report's rows.
  const plan = "The plan.\n\n| a | b |\n| --- | --- |\nrole | engine\n";
  await seed("planner", "done", base, plan);
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
  // Then each task's final message, read from its record's result file, every line of it
  // indented under its heading, so the rows above are the only column-0 lines holding " | ".
  assert.match(ran.stdout, /^ {4}BLOCKED: no such file\.$/m);
  assert.ok(ran.stdout.indexOf(`## ${seeded[2].id}`) < ran.stdout.indexOf(`## ${seeded[0].id}`), "the messages in the order of the lines");
  const heading = `## ${seeded[0].id} — planner, passed\n\n`;
  const message = ran.stdout.slice(ran.stdout.indexOf(heading) + heading.length).split("\n## ")[0];
  assert.equal(message, plan.split("\n").map((line) => (line === "" ? "" : `    ${line}`)).join("\n"));

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
    status: "done", durationSeconds: 20, outcome: "passed", result: plan,
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

// @anchor cliSeatSpelling
test("a seated record is spelled role#seat by tasks, show and report, and keeps role and seat apart in their JSON", async (t) => {
  const root = await engineProject(t);
  const { create, update } = await import("../src/ledger.ts");
  const base = Date.now() - 600_000;
  const head = "0123456789abcdef0123456789abcdef01234567";
  const unseated = create(root, { role: "planner", brief: "plan", cwd: root, engine: "claude", depth: 2 }, base);
  const seated = create(root, { role: "code-reviewer", brief: "review", cwd: root, engine: "codex", depth: 2, seat: 2, underReview: head }, base + 1_000);
  for (const record of [unseated, seated]) {
    assert.equal((await update(root, record.id, { status: "running" }, base + 2_000)).applied, true);
    assert.equal((await update(root, record.id, { status: "done" }, base + 3_000)).applied, true);
    fs.writeFileSync(record.resultPath, "VERDICT: no major issues\n");
  }
  const ran = await runEach([
    ["tasks"], ["tasks", "--json"], ["show", seated.id], ["show", seated.id, "--json"], ["show", unseated.id], ["report"], ["report", "--json"],
  ], root);
  for (const answer of ran) assert.equal(answer.code, 0, answer.stderr);
  const [tasks, tasksJson, show, showJson, showUnseated, report, reportJson] = ran;

  // `tasks`: the role column spells the seat; the view keeps the two fields apart.
  const roleOf = (id: string) => tasks.stdout.split("\n").find((line) => line.startsWith(id))!.split(/\s+/)[2];
  assert.equal(roleOf(seated.id), "code-reviewer#2");
  assert.equal(roleOf(unseated.id), "planner");
  const views = (JSON.parse(tasksJson.stdout) as { tasks: Array<Record<string, unknown>> }).tasks;
  const view = views.find((entry) => entry.id === seated.id)!;
  assert.deepEqual([view.role, view.seat, view.underReview], ["code-reviewer", 2, head]);
  assert.equal("seat" in views.find((entry) => entry.id === unseated.id)!, false);

  // `show`: one role line, no seat line of its own, and the head the review covers.
  assert.match(show.stdout, /^role: code-reviewer#2$/m);
  assert.doesNotMatch(show.stdout, /^seat:/m);
  assert.match(show.stdout, new RegExp(`^underReview: ${head}$`, "m"));
  assert.match(showUnseated.stdout, /^role: planner$/m);
  assert.doesNotMatch(showUnseated.stdout, /^underReview:/m);
  const record = (JSON.parse(showJson.stdout) as { record: TaskRecord }).record;
  assert.deepEqual([record.role, record.seat, record.underReview], ["code-reviewer", 2, head]);

  // `report`: the row's first field and the heading; the JSON carries seat only where there is one.
  const rows = report.stdout.split("\n").filter((line) => /^\S.* \| /.test(line));
  assert.deepEqual(rows.map((line) => line.split(" | ")[0]), ["code-reviewer#2", "planner"]);
  assert.equal(rows[0].split(" | ").length, 7, "seven fields stay seven");
  assert.match(report.stdout, new RegExp(`^## ${seated.id} — code-reviewer#2, passed$`, "m"));
  assert.match(report.stdout, new RegExp(`^## ${unseated.id} — planner, passed$`, "m"));
  const reported = (JSON.parse(reportJson.stdout) as { tasks: Array<Record<string, unknown>> }).tasks;
  assert.deepEqual([reported[0].id, reported[0].role, reported[0].seat], [seated.id, "code-reviewer", 2]);
  assert.equal("seat" in reported[1], false, "an unseated task's entry has no seat");
});

/** A git repository with one empty commit and nothing of this project's in it: no config, no ledger. */
async function bareRepository(t: TestContext): Promise<string> {
  const root = scratch(t);
  await git(root, "init", "-b", "main");
  await git(root, "commit", "--allow-empty", "-m", "initial");
  return root;
}

/** A task id of the ledger's alphabet that no ledger holds. */
const nobody = "0123456789abcdef0123456789abcdef0123";

// @anchor cliReadsWriteNothingUninitialized
test("the read verbs write nothing in an uninitialized repository", async (t) => {
  const root = await bareRepository(t);
  const excludeFile = path.join(root, ".git", "info", "exclude");
  const exclude = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile) : null;
  // The repository is the project, as the server would find it: no `--project`, no config.
  const reads: Array<[string[], number]> = [
    [["modes"], 0], [["tasks"], 0], [["tasks", "--status", "running"], 0], [["show", nobody], 3], [["log", nobody], 3],
    [["journal"], 0], [["journal", "some-slug"], 3], [["list-asks"], 0], [["list-asks", "--status", "open"], 0], [["report"], 0],
  ];
  const lines = reads.flatMap(([args]) => [args, [...args, "--json"]]);
  const ran = await runEach(lines, root);
  const documents = new Map<string, unknown>();
  ran.forEach((result, index) => {
    const args = lines[index];
    const code = reads[Math.floor(index / 2)][1];
    assert.equal(result.code, code, `${args.join(" ")}: ${result.stderr}`);
    if (args.at(-1) === "--json") {
      assert.equal(result.stderr, "", `${args.join(" ")}: under --json stderr is empty`);
      documents.set(args.slice(0, -1).join(" "), JSON.parse(result.stdout));
    } else if (code === 3) {
      assert.equal(result.stdout, "", `${args.join(" ")}: a refusal, asked for as text, is stderr's`);
      assert.match(result.stderr, /^cross-agent: no (task|journal) /);
    }
  });
  // Every listing is empty, and an empty listing is an answer.
  assert.deepEqual(documents.get("tasks"), { ok: true, tasks: [], invalid: [], errors: [], skipped: [], reconciled: false });
  assert.deepEqual(documents.get("tasks --status running"), { ok: true, tasks: [], invalid: [], errors: [], skipped: [], reconciled: false });
  assert.deepEqual(documents.get("journal"), { slugs: [] });
  assert.deepEqual(documents.get("report"), { tasks: [] });
  assert.deepEqual(documents.get("list-asks"), { asks: [], invalid: [] });
  assert.deepEqual(documents.get("list-asks --status open"), { asks: [], invalid: [] });
  assert.deepEqual(documents.get(`show ${nobody}`), { ok: false, reason: `no task ${nobody}` });
  assert.deepEqual(documents.get(`log ${nobody}`), { ok: false, reason: `no task ${nobody}` });
  assert.deepEqual(documents.get("journal some-slug"), { ok: false, reason: "no journal some-slug" });
  // A repository with no config runs `solo` on the defaults, and that is the active mode.
  const modes = documents.get("modes") as { active: string; installed: boolean; modes: Array<{ id: string; active: boolean }> };
  assert.equal(modes.active, "solo");
  assert.equal(modes.installed, true);
  assert.deepEqual(modes.modes.filter((mode) => mode.active).map((mode) => mode.id), ["solo"]);

  // And the repository is exactly as `git init` left it.
  assert.equal(fs.existsSync(path.join(root, ".cross-agent")), false, "no state directory");
  assert.deepEqual(fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile) : null, exclude, ".git/info/exclude untouched");
  assert.equal(await git(root, "status", "--porcelain", "--untracked-files=all"), "");
});

/** Every record the seeded ledger holds, in the order it was created. */
function everyRecord(seeded: SeededProject): TaskRecord[] {
  const { byStatus } = seeded;
  return [
    byStatus.done, seeded.doneWithoutResult, byStatus.failed, byStatus.cancelled, byStatus.orphaned, byStatus.cancelling,
    byStatus.stalled, byStatus.running, seeded.lead, seeded.runningChild, seeded.doneChild, seeded.worktreeTask, byStatus.launching,
  ];
}

/** `text` as a regular expression that matches it literally. */
function literally(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// @anchor cliReadsLeaveSeededLedger
test("the read verbs leave a seeded ledger byte for byte", async (t) => {
  const seeded = await seededProject(t);
  const { root } = seeded;
  const state = path.join(root, ".cross-agent");
  const before = snapshot(state);
  // The damaged files are part of what must not change: a read that repaired, moved or
  // removed either would show here.
  for (const name of [path.join("tasks", "broken.json"), path.join("asks", "broken.json")]) assert.ok(Object.hasOwn(before, name), name);
  const reads = [
    ...everyRecord(seeded).map((record) => ["show", record.id]),
    ["log", seeded.byStatus.done.id], ["journal"], ["journal", seeded.slug], ["list-asks"], ["tasks"], ["tasks", "--status", "stalled"],
    ["report"], ["modes"], ["verify-worktree", seeded.worktree, seeded.branch],
  ];
  const lines = reads.flatMap((args) => [args, [...args, "--json"]]);
  const ran = await runEach(lines, root);
  ran.forEach((result, index) => {
    assert.ok([0, 4, 5, 6].includes(result.code), `${lines[index].join(" ")}: exit ${result.code}: ${result.stderr}`);
  });
  // The quiet record is past the stall threshold — its engine has said nothing for an hour
  // under `stallMinutes: 0.02` — and `show` reports the status the ledger holds.
  const quiet = seeded.byStatus.running;
  const shown = ran[lines.findIndex((args) => args[0] === "show" && args[1] === quiet.id && args[2] === "--json")];
  assert.equal(shown.code, 4);
  assert.equal((JSON.parse(shown.stdout) as { record: TaskRecord }).record.status, "running");
  assert.deepEqual(snapshot(state), before, "every file under .cross-agent/ is as it was, and nothing was added");

  // The same record under `check`, which is a reader of the stall clock, is written stalled:
  // the reading `show` declined to take is one there was to take.
  const { check } = await import("../src/tasks.ts");
  const checked = await check(root, quiet.id);
  assert.equal(checked.ok && checked.status, "stalled");
});

// @anchor cliTasksReconcileFlag
test("tasks --reconcile is the one read that reconciles", async (t) => {
  const root = await bareRepository(t);
  assert.equal((await run(["init", "--mode", "dev-team"], root)).code, 0);
  const { create, update } = await import("../src/ledger.ts");
  // Running, its runner gone and no engine named: the first thing a pass settles.
  const record = create(root, { role: "planner", brief: "seeded", cwd: root, engine: "claude", depth: 1 });
  assert.equal((await update(root, record.id, { status: "running", runnerIdentity: await deadIdentity() })).applied, true);
  const broken = path.join(root, ".cross-agent", "tasks", "broken.json");
  fs.writeFileSync(broken, "{not a record");
  const state = path.join(root, ".cross-agent");
  const before = snapshot(state);
  const recordName = path.join("tasks", `${record.id}.json`);
  const brokenName = path.join("tasks", "broken.json");

  const [text, json] = await runEach([["tasks"], ["tasks", "--json"]], root);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`^${record.id}\\s+running \\(runner gone\\)\\s`, "m"));
  assert.match(text.stdout, new RegExp(`^invalid task record ${literally(broken)}: \\S`, "m"));
  assert.match(text.stdout, /^not reconciled: pass --reconcile$/m);
  const listed = JSON.parse(json.stdout) as { reconciled: boolean; tasks: Array<{ id: string; status: string }>; invalid: Array<{ file: string; reason: string }> };
  assert.equal(listed.reconciled, false);
  assert.deepEqual(listed.tasks.map((task) => [task.id, task.status]), [[record.id, "running"]]);
  assert.deepEqual(listed.invalid.map((entry) => entry.file), [broken]);
  assert.ok(listed.invalid[0].reason.length > 0);
  assert.deepEqual(snapshot(state), before, "a listing without --reconcile changes no file");

  const reconciled = await run(["tasks", "--reconcile", "--json"], root);
  assert.equal(reconciled.code, 0, reconciled.stderr);
  const after = JSON.parse(reconciled.stdout) as typeof listed & { tasks: Array<{ reason?: string }> };
  assert.equal(after.reconciled, true);
  assert.deepEqual(after.tasks.map((task) => [task.id, task.status, task.reason]), [[record.id, "failed", "runner lost"]]);
  assert.deepEqual(after.invalid.map((entry) => entry.file), [broken]);
  assert.ok(after.invalid[0].reason.length > 0);
  const now = snapshot(state);
  assert.notEqual(now[recordName], before[recordName], "the pass wrote the record it settled");
  assert.equal(now[brokenName], before[brokenName], "and left the damaged file alone");
  for (const name of Object.keys(now).filter((each) => !Object.hasOwn(before, each))) {
    assert.ok(name === "locks" || name.startsWith(`locks${path.sep}`), `${name} is new, and only a lock may be`);
  }
  const human = await run(["tasks", "--reconcile"], root);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, new RegExp(`^${record.id}\\s+failed\\s`, "m"));
  assert.match(human.stdout, new RegExp(`^invalid task record ${literally(broken)}: \\S`, "m"));
  assert.match(human.stdout, /^reconciled$/m);
});

// @anchor cliModes
test("modes lists the installed modes with the active one marked, and a config naming none of them is a 3", async (t) => {
  const root = await bareRepository(t);
  assert.equal((await run(["init", "--mode", "dev-team"], root)).code, 0);
  const [text, json] = await runEach([["modes"], ["modes", "--json"]], root);
  assert.equal(text.code, 0, text.stderr);
  assert.equal(text.stderr, "");
  const heads = text.stdout.split("\n").filter((line) => /^[* ] \S+ \S+ — /.test(line));
  assert.deepEqual(heads.map((line) => line.split(" — ")[0]), ["* dev-team 0.1.0", "  dev-team-engine 0.1.0", "  solo 0.1.0"]);
  assert.match(text.stdout, /^ {6}implementer \(worktree, workspace-write\)$/m);
  assert.match(text.stdout, /^ {6}consult \(root, read-only\)$/m);

  const listed = JSON.parse(json.stdout) as {
    active: string; installed: boolean; reason?: string;
    modes: Array<{ id: string; lead: unknown; active: boolean; roles: Array<Record<string, unknown>> }>;
  };
  assert.equal(listed.active, "dev-team");
  assert.equal(listed.installed, true);
  assert.equal(listed.reason, undefined);
  assert.deepEqual(listed.modes.map((mode) => [mode.id, mode.active]), [["dev-team", true], ["dev-team-engine", false], ["solo", false]]);
  // Each mode as the loader reads it: what `describe_mode` would say of it, less the text.
  const { loadMode } = await import("../src/modes.ts");
  for (const mode of listed.modes) {
    const loaded = loadMode(builtInModesDir(), mode.id);
    assert.deepEqual(mode, {
      id: loaded.id, release: loaded.release, name: loaded.name, summary: loaded.summary, lead: loaded.lead,
      roles: loaded.roles.map((role) => ({ key: role.key, title: role.title, workspace: role.workspace, sandboxDefault: role.sandboxDefault })),
      active: loaded.id === "dev-team",
    });
  }

  // A config naming a mode this build does not have: every other verb that loads it would
  // refuse, so this is a 3 — and what is installed is still the answer, on stdout.
  const configFile = path.join(root, CONFIG_PATH);
  fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, "utf8")), mode: "no-such-mode" }));
  const [missingText, missingJson] = await runEach([["modes"], ["modes", "--json"]], root);
  assert.equal(missingText.code, 3);
  assert.match(missingText.stdout, /^ {2}dev-team 0\.1\.0 — /m);
  assert.doesNotMatch(missingText.stdout, /^\*/m, "nothing installed is active");
  assert.match(missingText.stderr, /^cross-agent: mode "no-such-mode" in \S+ is not installed; this build has dev-team, dev-team-engine, solo$/m);
  assert.equal(missingJson.code, 3);
  assert.equal(missingJson.stderr, "");
  const missing = JSON.parse(missingJson.stdout) as typeof listed;
  assert.equal(missing.active, "no-such-mode");
  assert.equal(missing.installed, false);
  assert.match(missing.reason!, /no-such-mode/);
  assert.deepEqual(missing.modes.map((mode) => mode.id), ["dev-team", "dev-team-engine", "solo"]);

  // A config that does not load is the precondition before anything is listed.
  fs.writeFileSync(configFile, "{ not json");
  const unreadable = await run(["modes"], root);
  assert.equal(unreadable.code, 3);
  assert.equal(unreadable.stdout, "");
  assert.match(unreadable.stderr, /config\.json/);
});

// @anchor cliTasks
test("tasks lists the ledger newest first without a pass, filtered by status, and names the damaged file", async (t) => {
  const seeded = await seededProject(t);
  const { root } = seeded;
  const brokenBytes = fs.readFileSync(seeded.brokenTask);
  const { listTasks } = await import("../src/tasks.ts");
  const [text, json, stalledText, stalledJson] = await runEach([
    ["tasks"], ["tasks", "--json"], ["tasks", "--status", "stalled"], ["tasks", "--status", "stalled", "--json"],
  ], root);
  assert.equal(text.code, 0, text.stderr);
  assert.equal(text.stderr, "");
  const listed = await listTasks(root, undefined, { reconcile: false });
  assert.deepEqual(JSON.parse(json.stdout), { ...listed, reconciled: false });
  // Newest first, the fresh launch at the top.
  const newestFirst = everyRecord(seeded).map((record) => record.id).reverse();
  const rows = text.stdout.split("\n").filter((line) => /^[0-9a-f]{36}\s/.test(line));
  assert.deepEqual(rows.map((line) => line.split(/\s+/)[0]), newestFirst);
  // A runner the record names and that is gone is shown as gone; a launch names none yet.
  for (const record of everyRecord(seeded)) {
    const row = rows.find((line) => line.startsWith(record.id))!;
    const gone = !["done", "failed", "cancelled", "launching"].includes(record.status);
    assert.equal(row.includes(`${record.status} (runner gone)`), gone, row);
    assert.match(row, new RegExp(`\\s${literally(`${record.engine}/${record.model ?? "-"}/${record.effort ?? "-"}`)}\\s+1\\s+\\S+\\s+${literally(record.cwd)}$`), row);
  }
  // The damaged file, by name and reason, in both forms, and its bytes as they were.
  assert.deepEqual(listed.invalid.map((entry) => entry.file), [seeded.brokenTask]);
  assert.ok(listed.invalid[0].reason.length > 0);
  assert.ok(text.stdout.includes(`invalid task record ${seeded.brokenTask}: ${listed.invalid[0].reason}\n`));
  assert.match(text.stdout, /\nnot reconciled: pass --reconcile\n$/);
  assert.deepEqual(fs.readFileSync(seeded.brokenTask), brokenBytes);

  assert.equal(stalledText.code, 0, stalledText.stderr);
  assert.deepEqual(stalledText.stdout.split("\n").filter((line) => /^[0-9a-f]{36}\s/.test(line)).map((line) => line.split(/\s+/)[0]), [seeded.byStatus.stalled.id]);
  assert.deepEqual(JSON.parse(stalledJson.stdout), { ...(await listTasks(root, "stalled", { reconcile: false })), reconciled: false });

  for (const args of [["tasks", "--status", "nope"], ["tasks", "--reconcile", "x"], ["tasks", "--reconcile", "--reconcile"], ["tasks", "--status"]]) {
    const refused = await run(args, root);
    assert.equal(refused.code, 2, `${args.join(" ")}: ${refused.stderr}`);
    assert.match(refused.stderr, /usage: cross-agent tasks/);
  }
});

// @anchor cliShow
test("show reads one task as the ledger holds it and exits by its status: settled 0, stalled 6, anything else 4", async (t) => {
  const seeded = await seededProject(t);
  const { root, byStatus } = seeded;
  const { find } = await import("../src/ledger.ts");
  const verdict: Record<string, number> = { launching: 4, running: 4, stalled: 6, orphaned: 4, cancelling: 4, done: 0, failed: 0, cancelled: 0 };
  const records = Object.values(byStatus);
  // A runner writes its final message before it settles the record, so an unsettled task
  // can have a result file already: the message is the settled record's, never this one's.
  const early = "written before the record settled\n";
  const unsettled = records.filter((record) => !["done", "failed", "cancelled"].includes(record.status));
  for (const record of unsettled) fs.writeFileSync(record.resultPath, early);
  const lines = records.flatMap((record) => [["show", record.id], ["show", record.id, "--json"]]);
  const ran = await runEach(lines, root);
  type Shown = { record: TaskRecord; elapsedSeconds: number; lastActivity: string[]; result: string | null; outcome: unknown; journal: unknown; runnerLog: string };
  const shown = new Map<string, Shown>();
  records.forEach((record, index) => {
    const [text, json] = [ran[2 * index], ran[2 * index + 1]];
    assert.equal(text.code, verdict[record.status], `${record.status}: ${text.stderr}`);
    assert.equal(json.code, verdict[record.status], record.status);
    // Whatever the verdict, the record is the answer, and it is stdout's.
    assert.equal(text.stderr, "", record.status);
    assert.match(text.stdout, new RegExp(`^id: ${record.id}$`, "m"));
    assert.match(text.stdout, new RegExp(`^status: ${record.status}$`, "m"));
    const document = JSON.parse(json.stdout) as Shown;
    assert.deepEqual(document.record, find(root, record.id));
    assert.equal(document.runnerLog, path.join(root, ".cross-agent", "tasks", `${record.id}.runner.log`));
    shown.set(record.status, document);
  });
  // The settled task with every file: its activity, its outcome and its message, whole.
  const done = shown.get("done")!;
  assert.deepEqual(done.lastActivity, seeded.log.slice(-10));
  assert.deepEqual(done.outcome, seeded.outcome);
  assert.equal(done.result, seeded.finalMessage);
  // Only a task given a worktree has a journal; none of these was given one.
  for (const record of records) assert.equal(shown.get(record.status)!.journal, null, record.status);
  assert.equal(done.elapsedSeconds, 20, "a settled task's time stops at its settlement");
  const doneText = ran[2 * records.indexOf(byStatus.done)].stdout;
  assert.ok(doneText.endsWith(`\nfinal message:\n${seeded.finalMessage}`), doneText);
  assert.match(doneText, new RegExp(`^log: ${literally(byStatus.done.logPath)}$`, "m"));
  assert.match(doneText, new RegExp(`^runner log: ${literally(done.runnerLog)}$`, "m"));
  assert.match(doneText, new RegExp(`^result: ${literally(byStatus.done.resultPath)}$`, "m"));
  assert.match(doneText, /^outcome: done, exit 0, session seeded-session, at \S+$/m);
  // Nothing unsettled has a final message, and a settled one with no file says so.
  for (const record of unsettled) {
    assert.equal(shown.get(record.status)!.result, null, record.status);
    const text = ran[2 * records.indexOf(record)].stdout;
    assert.doesNotMatch(text, /final message/, record.status);
    assert.ok(!text.includes(early), `${record.status}: an unsettled task's result file is not its message`);
  }
  assert.equal(shown.get("running")!.record.lastEventAt! < Date.now() - 3_000_000, true, "the quiet record is an hour silent");

  const [missingFile, missingJson, worktreeJson, three, zero, word, unknown, none] = await runEach([
    ["show", seeded.doneWithoutResult.id], ["show", seeded.doneWithoutResult.id, "--json"], ["show", seeded.worktreeTask.id, "--json"],
    ["show", byStatus.done.id, "--lines", "3", "--json"], ["show", byStatus.done.id, "--lines", "0"], ["show", byStatus.done.id, "--lines", "x"],
    ["show", nobody], ["show"],
  ], root);
  assert.equal(missingFile.code, 0, missingFile.stderr);
  assert.match(missingFile.stdout, /\nfinal message: no result file\n$/);
  assert.equal((JSON.parse(missingJson.stdout) as Shown).result, null);
  assert.equal((JSON.parse(missingJson.stdout) as Shown).journal, null);
  const { readJournal } = await import("../src/journal.ts");
  assert.deepEqual((JSON.parse(worktreeJson.stdout) as Shown).journal, readJournal(root, seeded.slug));
  assert.deepEqual((JSON.parse(worktreeJson.stdout) as Shown).journal, seeded.journal);
  assert.deepEqual((JSON.parse(three.stdout) as Shown).lastActivity, seeded.log.slice(-3));
  // An outcome written with a time no date can hold is printed as the number it is, and the
  // exit is still the record's.
  const { writeOutcome } = await import("../src/ledger.ts");
  writeOutcome(root, byStatus.done.id, { ...seeded.outcome, at: 1e300 });
  const [far, farJson] = await runEach([["show", byStatus.done.id], ["show", byStatus.done.id, "--json"]], root);
  assert.equal(far.code, 0, far.stderr);
  assert.match(far.stdout, new RegExp(`^id: ${byStatus.done.id}$`, "m"));
  assert.match(far.stdout, /^outcome: done, exit 0, session seeded-session, at 1e\+300$/m);
  assert.equal(farJson.code, 0, farJson.stdout);
  assert.equal((JSON.parse(farJson.stdout) as { outcome: { at: number } }).outcome.at, 1e300);
  for (const refused of [zero, word, none]) {
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /usage: cross-agent show/);
  }
  assert.equal(unknown.code, 3);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, new RegExp(`^cross-agent: no task ${nobody}$`, "m"));
});

// @anchor cliLog
test("log prints the tail of a task's engine stream, and a task whose engine has said nothing is an empty answer", async (t) => {
  const seeded = await seededProject(t);
  const { root, byStatus } = seeded;
  const [text, json, three, fresh, freshJson, unknown, zero] = await runEach([
    ["log", byStatus.done.id], ["log", byStatus.done.id, "--json"], ["log", byStatus.done.id, "--lines", "3"],
    ["log", byStatus.launching.id], ["log", byStatus.launching.id, "--json"], ["log", nobody], ["log", byStatus.done.id, "--lines", "0"],
  ], root);
  assert.equal(text.code, 0, text.stderr);
  // Fifty lines by default, and the seeded stream has twelve: all of it, verbatim.
  assert.equal(text.stdout, `${seeded.log.join("\n")}\n`);
  assert.deepEqual(JSON.parse(json.stdout), { id: byStatus.done.id, logPath: byStatus.done.logPath, lines: seeded.log });
  assert.equal(three.stdout, `${seeded.log.slice(-3).join("\n")}\n`);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(fresh.stdout, "");
  assert.deepEqual(JSON.parse(freshJson.stdout), { id: byStatus.launching.id, logPath: byStatus.launching.logPath, lines: [] });
  assert.equal(unknown.code, 3);
  assert.match(unknown.stderr, /no task/);
  assert.equal(zero.code, 2);
});

// @anchor cliJournal
test("journal renders one journal whole or lists every slug; a missing one is 3, a slug it cannot read 2, a damaged one 1", async (t) => {
  const seeded = await seededProject(t);
  const { root, slug } = seeded;
  const [text, json, bare, bareJson, missing, dots] = await runEach([
    ["journal", slug], ["journal", slug, "--json"], ["journal"], ["journal", "--json"], ["journal", "no-such-slug"], ["journal", ".."],
  ], root);
  assert.equal(text.code, 0, text.stderr);
  const { readJournal } = await import("../src/journal.ts");
  assert.deepEqual(JSON.parse(json.stdout), readJournal(root, slug));
  assert.deepEqual(JSON.parse(json.stdout), seeded.journal);
  for (const [field, value] of [["slug", slug], ["branch", seeded.branch], ["worktree", seeded.worktree], ["defaultBranch", "main"]]) {
    assert.match(text.stdout, new RegExp(`^${field}: ${literally(value)}$`, "m"));
  }
  // One line per step: when, which, the SHAs around it, the default branch's, what ran.
  for (const step of seeded.journal.steps) {
    assert.match(text.stdout, new RegExp(`^  ${literally(new Date(step.at).toISOString())}  ${step.step}  ${step.before ?? "-"}→${step.after}  defaultSha ${step.defaultSha}  args ${literally(step.args!.join(" "))}$`, "m"));
  }
  assert.equal(bare.code, 0, bare.stderr);
  assert.equal(bare.stdout, `${slug}\n`);
  assert.deepEqual(JSON.parse(bareJson.stdout), { slugs: [slug] });
  assert.equal(missing.code, 3);
  assert.match(missing.stderr, /^cross-agent: no journal no-such-slug$/m);
  // A slug no journal file could have is a command line this build cannot read.
  assert.equal(dots.code, 2);
  assert.match(dots.stderr, /invalid slug/);
  assert.match(dots.stderr, /usage: cross-agent journal/);

  // A journal that does not read is the operator's file to repair, and the error names it.
  const directory = path.join(root, ".cross-agent", "journal");
  const damaged = path.join(directory, "damaged.json");
  fs.writeFileSync(damaged, "{}");
  const [broken, brokenJson] = await runEach([["journal", "damaged"], ["journal", "damaged", "--json"]], root);
  assert.equal(broken.code, 1);
  assert.ok(broken.stderr.includes(`invalid journal ${damaged}`), broken.stderr);
  assert.equal(brokenJson.code, 1);
  assert.ok((JSON.parse(brokenJson.stdout) as { error: string }).error.includes(damaged));
  // A step that does not read is the same damage, named the same way, never a crash
  // halfway through printing the steps before it.
  const head = { slug: "damaged", branch: "task/damaged", defaultBranch: "main" };
  for (const step of [
    "null", '{"step":"committed"}', '{"step":7,"at":1}', '{"step":"git","at":1e400}', '{"step":"git","at":1,"args":"status"}',
    '{"step":"git","at":1,"before":5}', '{"step":"git","at":1,"args":["status",1]}',
    // Finite, and still no time a date can hold: the renderer would refuse it.
    '{"step":"git","at":1e300}',
  ]) {
    fs.writeFileSync(damaged, `${JSON.stringify(head).slice(0, -1)},"steps":[{"step":"worktree-created","at":1},${step}]}`);
    const [stepText, stepJson] = await runEach([["journal", "damaged"], ["journal", "damaged", "--json"]], root);
    assert.equal(stepText.code, 1, `${step}: ${stepText.stderr}`);
    assert.equal(stepText.stdout, "", step);
    assert.ok(stepText.stderr.includes(`invalid journal ${damaged}`), `${step}: ${stepText.stderr}`);
    assert.equal(stepJson.code, 1, step);
    assert.ok((JSON.parse(stepJson.stdout) as { error: string }).error.includes(damaged), step);
  }

  // A task whose journal does not read is still shown: the record is what the operator came
  // to read, the journal's error is named beside it, and the exit is the record's.
  const own = path.join(directory, `${slug}.json`);
  const { find } = await import("../src/ledger.ts");
  const farStep = JSON.stringify({
    slug, branch: seeded.branch, defaultBranch: "main", steps: [{ step: "worktree-created", at: 1 }, { step: "git", at: 1e300 }],
  });
  for (const damage of ["{not json", farStep]) {
    fs.writeFileSync(own, damage);
    const [shownText, shownJson] = await runEach([["show", seeded.worktreeTask.id], ["show", seeded.worktreeTask.id, "--json"]], root);
    assert.equal(shownText.code, 0, `${damage}: ${shownText.stderr}`);
    assert.match(shownText.stdout, new RegExp(`^id: ${seeded.worktreeTask.id}$`, "m"));
    assert.match(shownText.stderr, new RegExp(`^cross-agent: invalid journal ${literally(own)}: `, "m"));
    assert.equal(shownJson.code, 0, damage);
    assert.equal(shownJson.stderr, "");
    const withoutJournal = JSON.parse(shownJson.stdout) as { record: TaskRecord; journal: unknown; journalError: string };
    assert.deepEqual(withoutJournal.record, find(root, seeded.worktreeTask.id));
    assert.equal(withoutJournal.journal, null);
    assert.ok(withoutJournal.journalError.startsWith(`invalid journal ${own}: `), withoutJournal.journalError);
  }
  // The bare listing is 0 with nothing to list.
  for (const entry of fs.readdirSync(directory)) fs.rmSync(path.join(directory, entry));
  const empty = await run(["journal", "--json"], root);
  assert.equal(empty.code, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), { slugs: [] });
});

// @anchor cliListAsks
test("list-asks shows every ask in the order asked, exits 5 while one it printed is open, and names a damaged file", async (t) => {
  const seeded = await seededProject(t);
  const { root, asks } = seeded;
  const { listAsks } = await import("../src/mailbox.ts");
  const [text, json, answered, answeredJson, nope] = await runEach([
    ["list-asks"], ["list-asks", "--json"], ["list-asks", "--status", "answered"], ["list-asks", "--status", "answered", "--json"],
    ["list-asks", "--status", "nope"],
  ], root);
  // An open ask is a lead waiting on the operator, and the listing is still stdout's.
  assert.equal(text.code, 5);
  assert.equal(json.code, 5);
  assert.deepEqual(JSON.parse(json.stdout), listAsks(root));
  const heads = text.stdout.split("\n").filter((line) => /^[0-9a-f]{36} {2}/.test(line));
  assert.deepEqual(heads.map((line) => line.split("  ")[0]), [asks.answered.id, asks.open.id], "in the order asked");
  assert.match(heads[1], new RegExp(`^${asks.open.id} {2}open {2}task ${asks.open.taskId} {2}${literally(new Date(asks.open.createdAt).toISOString())} \\(\\d+s ago\\) {2}Which slug\\?$`));
  assert.match(text.stdout, /^ {4}answer: Yes, onto main\. {2}answeredAt \S+ \(\d+s ago\)$/m);
  assert.doesNotMatch(text.stdout, /second line|run the suite/, "each question and answer by its first line");
  // The damaged file is named on stderr and in the document, and changes no verdict.
  assert.match(text.stderr, new RegExp(`^cross-agent: invalid ask file ${literally(seeded.brokenAsk)}: unparsable JSON`, "m"));
  assert.deepEqual((JSON.parse(json.stdout) as { invalid: Array<{ file: string }> }).invalid.map((entry) => entry.file), [seeded.brokenAsk]);
  assert.equal(answered.code, 0, answered.stderr);
  assert.deepEqual(answered.stdout.split("\n").filter((line) => /^[0-9a-f]{36} {2}/.test(line)).map((line) => line.split("  ")[0]), [asks.answered.id]);
  assert.match(answered.stderr, /invalid ask file/);
  assert.deepEqual(JSON.parse(answeredJson.stdout), listAsks(root, { status: "answered" }));
  assert.equal(nope.code, 2);
  assert.match(nope.stderr, /usage: cross-agent list-asks/);

  // Answered, the open one is open no longer, and nothing printed waits on the operator.
  const reply = await run(["answer", asks.open.id, "the seeded slug"], root);
  assert.equal(reply.code, 0, reply.stderr);
  const after = await run(["list-asks"], root);
  assert.equal(after.code, 0, after.stderr);
  assert.match(after.stderr, /invalid ask file/);

  // An ask whose times no date can hold is listed with every other, its times the numbers
  // they are.
  const { asksDirectory } = await import("../src/mailbox.ts");
  const far = { id: "f".repeat(36), taskId: asks.open.taskId, question: "From the far future?", createdAt: 1e300, status: "answered", answer: "Later.", answeredAt: 1e300 };
  fs.writeFileSync(path.join(asksDirectory(root), `${far.id}.json`), JSON.stringify(far));
  const [listed, listedJson] = await runEach([["list-asks"], ["list-asks", "--json"]], root);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(listed.stdout.split("\n").filter((line) => /^[0-9a-f]{36} {2}/.test(line)).map((line) => line.split("  ")[0]), [asks.answered.id, asks.open.id, far.id]);
  assert.match(listed.stdout, new RegExp(`^${far.id} {2}answered {2}task ${far.taskId} {2}1e\\+300 {2}From the far future\\?$`, "m"));
  assert.match(listed.stdout, /^ {4}answer: Later\. {2}answeredAt 1e\+300$/m);
  assert.equal(listedJson.code, 0, listedJson.stdout);
  assert.deepEqual((JSON.parse(listedJson.stdout) as { asks: Array<{ id: string }> }).asks.map((ask) => ask.id), [asks.answered.id, asks.open.id, far.id]);
});

// @anchor cliUsage
test("every verb refuses a flag it does not take and a wrong argument count as usage, and help names every verb and code", async (t) => {
  const root = scratch(t);
  const wrong = [
    ["init", "--since", "x"], ["modes", "--bogus", "x"], ["tasks", "--lines", "3"], ["show", "x", "--status", "running"],
    ["log", "x", "--reconcile"], ["journal", "--status", "x"], ["list-asks", "--since", "x"], ["answer", "a", "b", "--mode", "x"],
    ["report", "--lines", "2"], ["cancel", "x", "--status", "running"], ["verify-worktree", "a", "b", "--lines", "3"],
    ["git", "s", "--since", "x", "--", "status"],
    ["show"], ["log"], ["answer", "a"], ["cancel"], ["verify-worktree", "a"], ["git", "--", "status"],
    ["modes", "x"], ["tasks", "x"], ["show", "a", "b"], ["log", "a", "b"], ["journal", "a", "b"], ["list-asks", "x"],
    ["cancel", "a", "b"], ["verify-worktree", "a", "b", "c"], ["git", "a", "b", "--", "status"],
    // git's arguments come after `--`, and there has to be one.
    ["git", "s"], ["git", "s", "status"], ["git", "s", "--"],
  ];
  const ran = await runEach(wrong, root);
  ran.forEach((result, index) => {
    const args = wrong[index];
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`usage: cross-agent ${args[0]} `), args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
  });
  // The global flags go before a verb's `--`: after it every word is the tail's, so a usage
  // line that put them last would hand `--json` to git.
  const [gitText, gitJson, showText] = await runEach([["git", "s"], ["git", "s", "--json"], ["show"]], root);
  const gitUsage = "cross-agent git <slug> [--path <dir>] [--branch <name>] [--project <root>] [--json] [--help] -- <git arguments…>";
  assert.match(gitText.stderr, new RegExp(`^usage: ${literally(gitUsage)}$`, "m"));
  assert.deepEqual((JSON.parse(gitJson.stdout) as { usage: string[] }).usage, [gitUsage]);
  assert.match(showText.stderr, /^usage: cross-agent show <id> \[--lines <n>\] \[--project <root>\] \[--json\] \[--help\]$/m);
  const { EXIT, VERB_NAMES } = await import("../src/cli.ts");
  assert.deepEqual(VERB_NAMES, usageOrder);
  const helped = await run(["--help"], root);
  assert.equal(helped.code, 0, helped.stderr);
  for (const verb of VERB_NAMES) assert.match(helped.stdout, new RegExp(`^ {2}cross-agent ${verb} `, "m"), verb);
  for (const code of Object.values(EXIT)) assert.match(helped.stdout, new RegExp(`^ {2}${code} {2}\\S`, "m"), `exit ${code}`);
  const alone = await run([], root);
  assert.equal(alone.code, 2);
  assert.match(alone.stderr, /no command/);
  assert.equal(fs.readdirSync(root).length, 0, "a refused command line writes nothing");
});

// @anchor cliCancel
test("cancel cascades from a lead, leaves first and the lead last, and a second cancel answers each task as already settled", async (t) => {
  const seeded = await seededProject(t);
  const { root, lead, runningChild, doneChild } = seeded;
  const { find } = await import("../src/ledger.ts");
  const { listAsks } = await import("../src/mailbox.ts");
  const doneFile = path.join(root, ".cross-agent", "tasks", `${doneChild.id}.json`);
  const doneBytes = fs.readFileSync(doneFile);
  const [damaged] = listAsks(root).invalid;

  const first = await run(["cancel", lead.id, "--json"], root);
  assert.equal(first.code, 0, first.stdout);
  const cancelled = JSON.parse(first.stdout) as { ok: boolean; outcomes: Array<{ id: string; outcome: string; reason?: string }>; asksCancelled: string[]; asksNotCancelled?: unknown[] };
  // The children first, in the order the cascade took them, and the lead last.
  assert.deepEqual(cancelled.outcomes.at(-1), { id: lead.id, outcome: "cancelled" });
  assert.deepEqual(new Map(cancelled.outcomes.slice(0, -1).map((entry) => [entry.id, entry])), new Map([
    [runningChild.id, { id: runningChild.id, outcome: "cancelled" }],
    [doneChild.id, { id: doneChild.id, outcome: "already done" }],
  ]));
  // The lead asked nothing; the damaged ask file names no task, so it could be the lead's,
  // and is named rather than skipped — beside a verdict it does not change.
  assert.deepEqual(cancelled, {
    ok: true, outcomes: cancelled.outcomes, asksCancelled: [], asksNotCancelled: [{ file: damaged.file, reason: damaged.reason }],
  });
  for (const id of [lead.id, runningChild.id]) assert.equal(find(root, id)!.status, "cancelled");
  assert.equal(find(root, runningChild.id)!.reason, "cancelled; the runner did not settle it");

  // A second cancel settles nothing more: what the first cancelled is already cancelled, and
  // the child that had finished keeps its own status and its own bytes.
  fs.rmSync(seeded.brokenAsk);
  const again = await run(["cancel", lead.id], root);
  const againJson = await run(["cancel", lead.id, "--json"], root);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stderr, "");
  const lines = again.stdout.split("\n");
  for (const expected of [`${runningChild.id} already cancelled`, `${doneChild.id} already done`, `${lead.id} already cancelled`]) {
    assert.ok(lines.includes(expected), `${expected} in ${again.stdout}`);
  }
  assert.equal(lines.indexOf(`${lead.id} already cancelled`), 2, "the lead's line is the cascade's last");
  assert.ok(lines.includes("asks cancelled: none"));
  assert.doesNotMatch(again.stdout, /not cancelled/);
  const settled = JSON.parse(againJson.stdout) as typeof cancelled;
  assert.equal(againJson.code, 0);
  assert.equal(Object.hasOwn(settled, "asksNotCancelled"), false);
  assert.deepEqual(settled.outcomes.at(-1), { id: lead.id, outcome: "already cancelled" });
  assert.deepEqual(fs.readFileSync(doneFile), doneBytes, "a done child is never written by a cancel");

  // A task nobody has is a 3, named, before any lock is taken.
  const unknown = await run(["cancel", nobody], root);
  assert.equal(unknown.code, 3);
  assert.match(unknown.stderr, new RegExp(`^cross-agent: no task ${nobody}$`, "m"));
  const bare = await bareRepository(t);
  assert.equal((await run(["cancel", nobody], bare)).code, 3);
  assert.equal(fs.existsSync(path.join(bare, ".cross-agent")), false, "a cancel of nothing creates no lock directory");
});

// @anchor cliVerifyWorktree
test("verify-worktree verifies a linked worktree on its branch, and refuses the main worktree and a wrong branch", async (t) => {
  const seeded = await seededProject(t);
  const { root, worktree, branch } = seeded;
  const { verifyWorktree } = await import("../src/worktree.ts");
  const verified = await verifyWorktree(root, worktree, branch);
  assert.ok(!("reason" in verified));
  const [text, json, relative, main, mainJson, wrong] = await runEach([
    ["verify-worktree", worktree, branch], ["verify-worktree", worktree, branch, "--json"],
    ["verify-worktree", path.relative(root, worktree), branch, "--json"],
    ["verify-worktree", root, "main"], ["verify-worktree", root, "main", "--json"], ["verify-worktree", worktree, "task/other"],
  ], root);
  assert.equal(text.code, 0, text.stderr);
  assert.equal(text.stdout, `verified: ${verified.workTree} on ${branch}\ngit dir: ${verified.gitDir}\ncommon dir: ${verified.commonDir}\n`);
  assert.deepEqual(JSON.parse(json.stdout), verified);
  // A relative path is the operator's, read against the working directory.
  assert.equal(relative.code, 0, relative.stderr);
  assert.deepEqual(JSON.parse(relative.stdout), verified);
  assert.equal(main.code, 3);
  assert.equal(main.stdout, "");
  assert.match(main.stderr, /^refused: \S+ is not a linked worktree of /m);
  assert.deepEqual(JSON.parse(mainJson.stdout), await verifyWorktree(root, root, "main"));
  assert.equal(wrong.code, 3);
  assert.match(wrong.stderr, /^refused: Worktree branch \S+ does not match the requested branch task\/other\.$/m);
});

// @anchor cliGit
test("git runs one subcommand in the verified worktree as git_mutate does: 0 journaled, 1 for git's own failure, 3 for a refusal", async (t) => {
  const seeded = await seededProject(t);
  const { root, slug, worktree } = seeded;
  // A task record nobody can read holds every workspace (design section 2, E2), and the CLI
  // refuses on it exactly as the tool does, naming the file, before git runs.
  const held = await run(["git", slug, "--", "status"], root);
  assert.equal(held.code, 3);
  assert.ok(held.stderr.includes(seeded.brokenTask), held.stderr);
  fs.rmSync(seeded.brokenTask);

  const before = await git(worktree, "rev-parse", "HEAD");
  const committed = await run(["git", slug, "--json", "--", "commit", "--allow-empty", "-m", "msg"], root);
  assert.equal(committed.code, 0, committed.stdout);
  const mutated = JSON.parse(committed.stdout) as { ok: boolean; exitCode: number; journal: { step: string; before: string; after: string; args: string[] } };
  assert.equal(mutated.ok, true);
  assert.equal(mutated.journal.step, "committed");
  assert.equal(mutated.journal.before, before);
  assert.notEqual(mutated.journal.after, before);
  assert.equal(mutated.journal.after, await git(worktree, "rev-parse", "HEAD"));
  assert.deepEqual(mutated.journal.args, ["commit", "--allow-empty", "-m", "msg"]);
  const journaled = await run(["journal", slug, "--json"], root);
  assert.deepEqual((JSON.parse(journaled.stdout) as { steps: unknown[] }).steps.at(-1), mutated.journal);

  // Everything after `--` is git's, a flag-shaped word included.
  const status = await run(["git", slug, "--", "status", "--short", "--branch"], root);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`^## ${literally(seeded.branch)}$`, "m"));
  const head = await git(worktree, "rev-parse", "HEAD");
  assert.match(status.stdout, new RegExp(`^journal: git ${head}→${head}$`, "m"));

  // git ran and failed: a 1, its own words printed, the answer whole under --json.
  const failed = await run(["git", slug, "--", "checkout", "no-such-ref"], root);
  const failedJson = await run(["git", slug, "--json", "--", "checkout", "no-such-ref"], root);
  assert.equal(failedJson.code, 1);
  const refusal = JSON.parse(failedJson.stdout) as { ok: boolean; exitCode: number; stderr: string; reason: string };
  assert.equal(refusal.ok, false);
  assert.equal(refusal.exitCode, 1);
  assert.match(refusal.stderr, /no-such-ref/);
  assert.equal(failedJson.stderr, "");
  assert.equal(failed.code, 1);
  assert.ok(failed.stderr.includes(refusal.stderr), failed.stderr);
  assert.match(failed.stderr, /exited 1/);

  // A refusal before git ran: a 3.
  const fault = await run(["git", slug, "--", "status", "--git-dir=/x"], root);
  assert.equal(fault.code, 3);
  assert.match(fault.stderr, /--git-dir=\/x is refused/);

  // A held git.lock refuses after the project's own lockWaitSeconds, which is 1 here.
  const { acquire, gitLockName, lockPath } = await import("../src/locks.ts");
  const lock = await acquire(lockPath(root, gitLockName()), { operation: "a test holding the git lock", waitSeconds: 0 });
  t.after(() => lock.release());
  const started = performance.now();
  const blocked = await run(["git", slug, "--", "status"], root);
  const elapsed = performance.now() - started;
  await lock.release();
  assert.equal(blocked.code, 3, blocked.stderr);
  assert.match(blocked.stderr, /git\.lock is held by another process \(waited 1s\)/);
  assert.ok(elapsed < 4_000, `the refusal took ${Math.round(elapsed)} ms against a one-second wait`);
  assert.equal(await git(worktree, "rev-parse", "HEAD"), head, "nothing ran while the lock was held");
});

// @anchor cliRefusesInsideEngine
test("a verb that writes refuses inside a task's environment, naming the marker, and the reads answer as they do outside one", async (t) => {
  const seeded = await seededProject(t);
  const { root, slug, asks, byStatus, lead } = seeded;
  const state = path.join(root, ".cross-agent");
  const fresh = scratch(t);
  const env = (variables: Record<string, string>) => ({ ...suiteEnv, ...variables });
  const writes: Array<{ args: string[]; cwd: string }> = [
    { args: ["init", "--mode", "solo"], cwd: fresh },
    { args: ["answer", asks.open.id, "text"], cwd: root },
    { args: ["cancel", byStatus.running.id], cwd: root },
    { args: ["git", slug, "--", "status"], cwd: root },
    { args: ["tasks", "--reconcile"], cwd: root },
    { args: ["waive", slug, seeded.journal.steps.at(-1)!.after!], cwd: root },
  ];
  for (const [variable, value] of [["CROSS_AGENT_TASK", lead.id], ["CROSS_AGENT_DEPTH", "2"], ["CROSS_AGENT_LINEAGE", `lead:${root}`]]) {
    const before = snapshot(state);
    for (const { args, cwd } of writes) {
      const [text, json] = [await run(args, cwd, undefined, env({ [variable]: value })), await run([args[0], "--json", ...args.slice(1)], cwd, undefined, env({ [variable]: value }))];
      const refusal = new RegExp(`^${variable} is set in this environment: ${args[0]} is an operator's command, and an engine reaches the project through its server, never this CLI$`);
      assert.equal(text.code, 3, `${variable}: ${args.join(" ")}: ${text.stderr}`);
      assert.equal(text.stdout, "");
      assert.match(text.stderr.replace(/^cross-agent: /, "").trimEnd(), refusal);
      assert.equal(json.code, 3, `${variable}: ${args.join(" ")} --json`);
      const document = JSON.parse(json.stdout) as { ok: boolean; reason: string };
      assert.equal(document.ok, false);
      assert.match(document.reason, refusal);
    }
    // Nothing was written: no config, the ask open and byte for byte, the record running, no
    // journal step and no lock file — the whole state directory as it was.
    assert.deepEqual(snapshot(state), before, `${variable}: nothing under .cross-agent/ changed`);
    assert.deepEqual(fs.readdirSync(fresh), [], `${variable}: init wrote nothing`);
  }
  const { find } = await import("../src/ledger.ts");
  const { readAsk } = await import("../src/mailbox.ts");
  assert.equal(find(root, byStatus.running.id)!.status, "running");
  assert.equal(readAsk(root, asks.open.id).ask!.status, "open");

  // The reads are the same answers with the marker as without it.
  const reads = [
    ["tasks"], ["show", byStatus.done.id], ["log", byStatus.done.id], ["journal", slug], ["list-asks"], ["modes"], ["report"],
    ["verify-worktree", seeded.worktree, seeded.branch],
  ].map((args) => [...args, "--json"]);
  const outside = await runEach(reads, root);
  const inside = await runEach(reads, root, env({ CROSS_AGENT_TASK: lead.id }));
  // Two runs a moment apart: the seconds a running task has run are the only difference.
  const steady = (text: string) => JSON.parse(text, (key, value) => (key === "durationSeconds" || key === "elapsedSeconds" ? undefined : value));
  outside.forEach((ran, index) => {
    assert.equal(inside[index].code, ran.code, reads[index].join(" "));
    assert.deepEqual(steady(inside[index].stdout), steady(ran.stdout), reads[index].join(" "));
  });

  // The project variable alone is the operator's own way to name a project, and refuses nothing.
  const elsewhere = scratch(t);
  const named = await run(["answer", asks.open.id, "named by CROSS_AGENT_PROJECT"], elsewhere, undefined, env({ CROSS_AGENT_PROJECT: root }));
  assert.equal(named.code, 0, named.stderr);
  assert.equal(readAsk(root, asks.open.id).ask!.answer, "named by CROSS_AGENT_PROJECT");
  const initialized = await run(["init", "--mode", "solo"], fresh, undefined, env({ CROSS_AGENT_PROJECT: root }));
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.ok(fs.existsSync(path.join(fresh, CONFIG_PATH)));
});

/** A document of this repository, by its path from the root. */
function documentAt(file: string): string {
  return fs.readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
}

/** The protocol numbers a paragraph states after the word `exit` or `exits`, clause by clause. */
function statedCodes(paragraph: string): number[][] {
  return [...paragraph.replace(/\s+/g, " ").matchAll(/\bexits?\b([^.;]*)/g)].map((clause) => [...clause[1].matchAll(/\b\d+\b/g)].map(Number));
}

// @anchor cliWaive
test("waive records the review waiver for the branch head, refuses a stale or unknown commit, and is an operator's command", async (t) => {
  const seeded = await seededProject(t);
  const { root, slug, branch } = seeded;
  const head = await git(root, "rev-parse", branch);
  const base = await git(root, "rev-parse", "main");
  const recorded = await run(["waive", slug, head, "--json"], root);
  assert.equal(recorded.code, 0, recorded.stderr);
  const step = JSON.parse(recorded.stdout) as { step: string; before: string; after: string; args: string[] };
  assert.deepEqual([step.step, step.before, step.after, step.args], ["review-waived", head, head, ["operator", "cli"]]);
  assert.match((await run(["waive", slug, head.slice(0, 10)], root)).stdout, new RegExp(`waived the review of ${branch} at ${head}`));

  // A commit that is not the branch head, a task no journal names, and a commit that is not hex.
  const stale = await run(["waive", slug, base], root);
  assert.equal(stale.code, 3, stale.stderr);
  assert.match(stale.stderr, new RegExp(`the branch ${branch} is at ${head}, which ${base} does not name`));
  assert.equal((await run(["waive", "no-such-task", head], root)).code, 3);
  assert.equal((await run(["waive", slug, "zz"], root)).code, 2);
  // A merged task takes no waiver.
  const { appendStep } = await import("../src/journal.ts");
  appendStep(root, slug, "merged", { before: head, after: head });
  const closed = await run(["waive", slug, head], root);
  assert.equal(closed.code, 3);
  assert.match(closed.stderr, /closed by its merged step/);
});

// @anchor cliDocsNameVerbs
test("the README, the operator guide and the launcher name only the dispatcher's verbs, and state their exits from its protocol", async () => {
  const { EXIT, VERB_NAMES } = await import("../src/cli.ts");
  const protocol = Object.values(EXIT) as number[];
  const readme = documentAt("README.md");
  const guide = documentAt("docs/operator-guide.md");
  const launcher = documentAt("skills/cross-agent/SKILL.md");
  // Every `cross-agent <verb>` either document spells is a verb this build has.
  const spelled = (text: string) => [...text.matchAll(/`cross-agent ([a-z][a-z-]*)/g)].map((match) => match[1]);
  for (const [name, text] of [["README.md", readme], ["docs/operator-guide.md", guide], ["skills/cross-agent/SKILL.md", launcher]]) {
    assert.ok(spelled(text).length > 0, `${name} names a verb`);
    for (const verb of spelled(text)) assert.ok(VERB_NAMES.includes(verb), `${name} names cross-agent ${verb}, which is no verb`);
  }

  // The operator guide's section has one row per verb, in the usage order, and the whole protocol.
  const start = guide.indexOf("## The operator CLI");
  assert.ok(start >= 0, "the operator guide has its operator CLI section");
  const section = guide.slice(start, guide.indexOf("\n## ", start + 1));
  const verbRows = section.split("\n").filter((line) => /^\| `[a-z]/.test(line));
  assert.deepEqual(verbRows.map((line) => /^\| `([a-z-]+)/.exec(line)![1]), [...VERB_NAMES]);
  for (const row of verbRows) {
    const codes = [...row.split("|").at(-2)!.matchAll(/\b\d+\b/g)].map(Number);
    assert.ok(codes.length > 0, `${row}: its exits`);
    for (const code of codes) assert.ok(protocol.includes(code), `${row}: exit ${code} is not the protocol's`);
  }
  const exitRows = section.split("\n").filter((line) => /^\| \d+ \|/.test(line));
  assert.deepEqual(exitRows.map((line) => Number(/^\| (\d+) \|/.exec(line)![1])), protocol);

  // The launcher states, beside each verb it names, the codes that verb exits with — at
  // least once per verb — and no code outside the protocol in any paragraph naming one.
  const paragraphs = launcher.split(/\n\s*\n/).filter((paragraph) => spelled(paragraph).length > 0);
  for (const verb of new Set(spelled(launcher))) {
    assert.ok(paragraphs.some((paragraph) => spelled(paragraph).includes(verb) && statedCodes(paragraph).some((codes) => codes.length > 0)),
      `the launcher states cross-agent ${verb}'s exit codes beside it`);
  }
  for (const paragraph of paragraphs) {
    for (const codes of statedCodes(paragraph)) {
      for (const code of codes) assert.ok(protocol.includes(code), `exit ${code} is not the protocol's: ${paragraph.slice(0, 120)}`);
    }
  }
});

// @anchor cliWritesFailsClosed
test("a verb that does not say it only reads is refused as a write inside a task's environment", async () => {
  const { taskMarker } = await import("../src/cli.ts");
  const parsed = { positionals: [], values: {}, booleans: new Set<string>(), rest: [], json: false };
  const verb = (writes?: unknown) => ({
    usage: "cross-agent example", summary: "example", positionals: [], flags: {},
    ...(writes === undefined ? {} : { writes }), run: async () => ({ code: 0, document: {}, text: "" }),
  });
  const inside = { CROSS_AGENT_DEPTH: "2" };
  // Only an explicit read is let through.
  assert.equal(taskMarker(verb(false) as never, parsed, inside), null);
  assert.equal(taskMarker(verb(() => false) as never, parsed, inside), null);
  assert.equal(taskMarker(verb(true) as never, parsed, inside), "CROSS_AGENT_DEPTH");
  // Everything else is a write: a verb that declares nothing, or a rule that answers nothing.
  assert.equal(taskMarker(verb() as never, parsed, inside), "CROSS_AGENT_DEPTH", "a verb that declares nothing is a write");
  assert.equal(taskMarker(verb(() => undefined) as never, parsed, inside), "CROSS_AGENT_DEPTH", "a rule that answers nothing is a write");
  // Outside a task's environment nothing is refused.
  assert.equal(taskMarker(verb() as never, parsed, {}), null);
});

// @anchor cliCancelStillActive
test("a cancel that leaves a task of its cascade active exits 4, beside the ask file it could not read, and a second cancel finishes it", async (t) => {
  const seeded = await seededProject(t);
  const { root, lead, runningChild, doneChild } = seeded;
  const { find } = await import("../src/ledger.ts");
  const { acquire, lockPath, recordLockName } = await import("../src/locks.ts");
  const { listAsks } = await import("../src/mailbox.ts");
  const [damaged] = listAsks(root).invalid;
  // A writer holds the running child's record: the cascade's claim on it waits the project's
  // one second and gives up, so the child is still running when the cascade is done.
  const held = await acquire(lockPath(root, recordLockName(runningChild.id)), { operation: "a test holding the child's record", waitSeconds: 0 });
  t.after(() => held.release());

  const text = await run(["cancel", lead.id], root);
  assert.equal(text.code, 4, text.stdout);
  assert.equal(text.stderr, "", "a verdict, on stdout");
  const lines = text.stdout.split("\n");
  assert.ok(lines.some((line) => line.startsWith(`${runningChild.id} running — `) && line.includes("is held by another process")), text.stdout);
  assert.ok(lines.includes(`${doneChild.id} already done`), text.stdout);
  assert.equal(lines.indexOf(`${lead.id} cancelled`), 2, "the lead is settled last, whatever its children did");
  assert.ok(lines.includes("asks cancelled: none"), text.stdout);
  assert.ok(lines.includes(`ask not cancelled ${damaged.file}: ${damaged.reason.slice(`invalid ask ${damaged.file}: `.length)}`), text.stdout);
  assert.equal(find(root, runningChild.id)!.status, "running");
  assert.equal(find(root, lead.id)!.status, "cancelled");

  const json = await run(["cancel", lead.id, "--json"], root);
  assert.equal(json.code, 4, json.stdout);
  const answer = JSON.parse(json.stdout) as { ok: boolean; outcomes: Array<{ id: string; outcome: string; reason?: string }>; asksNotCancelled: unknown };
  assert.equal(answer.ok, true);
  const still = answer.outcomes.find((entry) => entry.id === runningChild.id)!;
  assert.equal(still.outcome, "running");
  assert.match(still.reason!, /is held by another process \(waited 1s\)/);
  assert.deepEqual(answer.outcomes.at(-1), { id: lead.id, outcome: "already cancelled" });
  assert.deepEqual(answer.asksNotCancelled, [{ file: damaged.file, reason: damaged.reason }]);

  // Released, the next cancel retries the task the cascade left and settles it.
  await held.release();
  const retried = await run(["cancel", lead.id, "--json"], root);
  assert.equal(retried.code, 0, retried.stdout);
  const settled = JSON.parse(retried.stdout) as typeof answer;
  assert.deepEqual(settled.outcomes.find((entry) => entry.id === runningChild.id), { id: runningChild.id, outcome: "cancelled" });
  assert.equal(find(root, runningChild.id)!.status, "cancelled");
});

// @anchor cliIdOutsideAlphabet
test("an id no task file could have names no task: show, log and cancel answer 3 and write nothing", async (t) => {
  const root = await bareRepository(t);
  assert.equal((await run(["init", "--mode", "dev-team"], root)).code, 0);
  const { create } = await import("../src/ledger.ts");
  create(root, { role: "planner", brief: "seeded", cwd: root, engine: "claude", depth: 1 });
  const state = path.join(root, ".cross-agent");
  const before = snapshot(state);
  for (const id of ["../tasks/x", "a.b", "x/y"]) {
    const [show, showJson, log, logJson] = await runEach([["show", id], ["show", "--json", id], ["log", id], ["log", "--json", id]], root);
    // `cancel` writes when it finds a task, so it runs on its own.
    const cancel = await run(["cancel", id], root);
    const cancelJson = await run(["cancel", "--json", id], root);
    for (const [verb, text, json] of [["show", show, showJson], ["log", log, logJson], ["cancel", cancel, cancelJson]] as const) {
      assert.equal(text.code, 3, `${verb} ${id}: ${text.stderr}`);
      assert.equal(text.stdout, "", `${verb} ${id}`);
      assert.equal(text.stderr, `cross-agent: no task ${id}\n`, `${verb} ${id}`);
      assert.equal(json.code, 3, `${verb} --json ${id}`);
      assert.deepEqual(JSON.parse(json.stdout), { ok: false, reason: `no task ${id}` }, `${verb} --json ${id}`);
    }
  }
  assert.deepEqual(snapshot(state), before, "nothing under .cross-agent/ was written, no lock taken");
});

/**
 * A command line run as its own process against a record whose file is a FIFO this test
 * serves: the first read of the record gets `first`, any later read `later`, until the CLI
 * exits. Every open here is non-blocking, so this process never waits in open(2) or on a
 * clock: each turn yields to the event loop and looks again. A read is served only once the
 * reader before it has closed its end — `/proc/<pid>/fd` says when — so no reader is ever
 * handed two records in one stream.
 */
async function servedRecord(
  t: TestContext, args: string[], cwd: string, fifo: string, first: string, later: string,
): Promise<Ran & { served: number }> {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: suiteEnv, stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
  t.after(stop);
  t.signal.addEventListener("abort", stop, { once: true });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  let closed = false;
  const exited = once(child, "close").then(([code]) => { closed = true; return code as number; });
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  // Whether the CLI holds the FIFO open: a read whose open(2) has returned.
  const reading = () => {
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${child.pid}/fd`);
    } catch {
      return false;
    }
    return fds.some((fd) => {
      try {
        return fs.readlinkSync(`/proc/${child.pid}/fd/${fd}`) === fifo;
      } catch {
        return false;
      }
    });
  };
  let served = 0;
  while (!closed && !t.signal.aborted) {
    let fd: number;
    try {
      // It succeeds only when a reader waits in its own open(2), which — the read before it
      // having closed — is a new read of the record.
      fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
      await turn();
      continue;
    }
    try {
      fs.writeSync(fd, served === 0 ? first : later);
      served++;
      // Held open until the reader's descriptor shows: it cannot reach end-of-file while this
      // end is open, so what it reads is this one record.
      while (!reading() && !closed) await turn();
    } finally {
      fs.closeSync(fd);
    }
    while (reading() && !closed) await turn();
  }
  return { code: await exited, stdout, stderr, served };
}

// @anchor cliShowOneRead
test("show takes a task's status, exit and final message from one read of its record, whatever a second read would say", { timeout: 30_000 }, async (t) => {
  const root = await bareRepository(t);
  assert.equal((await run(["init", "--mode", "dev-team"], root)).code, 0);
  const { create, update } = await import("../src/ledger.ts");
  const now = Date.now();
  const record = create(root, { role: "planner", brief: "seeded", cwd: root, engine: "claude", depth: 1 }, now - 60_000);
  const file = path.join(root, ".cross-agent", "tasks", `${record.id}.json`);
  assert.equal((await update(root, record.id, { status: "running", acknowledgedAt: now - 30_000, lastEventAt: now - 30_000 }, now - 30_000)).applied, true);
  const running = fs.readFileSync(file, "utf8");
  assert.equal((await update(root, record.id, { status: "done", exitCode: 0 }, now - 1_000)).applied, true);
  const done = fs.readFileSync(file, "utf8");
  // A runner writes its final message and then settles the record. The FIFO stands for the
  // moment between: the first read of the record finds it running, and any second read
  // would find the task done, its message written.
  fs.writeFileSync(record.resultPath, "the final message\n");
  fs.rmSync(file);
  await exec("mkfifo", [file]);
  for (const args of [["show", record.id, "--json"], ["show", record.id]]) {
    const shown = await servedRecord(t, args, root, file, running, done);
    assert.equal(shown.code, 4, `${args.join(" ")}: ${shown.stderr}`);
    if (args.includes("--json")) {
      const document = JSON.parse(shown.stdout) as { record: TaskRecord; result: string | null };
      assert.equal(document.record.status, "running");
      assert.equal(document.result, null, "a running record has no final message");
    } else {
      assert.match(shown.stdout, /^status: running$/m);
      assert.doesNotMatch(shown.stdout, /final message/);
    }
    assert.equal(shown.served, 1, `${args.join(" ")} read the record once`);
  }
});

// `cross-agent git-root`: one `git_root` verb from a terminal, under the same whitelist,
// journal rules, opt-in rule and locks as the tool (design section 10), so an operator has a
// cooperating path for root git while a loop runs.

/** A repository on `main` with one commit, holding `config` as its own. */
async function rootProject(t: TestContext, config: Record<string, unknown>): Promise<string> {
  const root = scratch(t);
  await git(root, "init", "-b", "main");
  await git(root, "commit", "--allow-empty", "-m", "initial");
  fs.mkdirSync(path.join(root, ".cross-agent"), { recursive: true });
  fs.writeFileSync(path.join(root, CONFIG_PATH), JSON.stringify(config));
  return root;
}

// @anchor cliGitRootRuns
test("git-root runs one whitelisted verb at the project root as git_root does: a read, and a journaled merge at a linked root", async (t) => {
  const made = await layoutRoot(t, "linked");
  const root = made.root;
  fs.mkdirSync(path.join(root, ".cross-agent"), { recursive: true });
  // `solo`: this is the CLI's root verb, not the review guard a team mode adds to its merge.
  fs.writeFileSync(path.join(root, CONFIG_PATH), JSON.stringify({ mode: "solo", roles: {}, project: { defaultBranch: "feature", testCommand: "true" } }));
  const { gitRoot } = await import("../src/gitroot.ts");
  const { gitMutate } = await import("../src/gitmutate.ts");
  const { runCommand } = await import("../src/runcommand.ts");
  const directory = path.join(root, ".worktrees", "x");
  const created = await gitRoot(root, { args: ["worktree", "add", "-b", "task/x", directory, "feature"], slug: "x" }, { waitSeconds: 5 });
  assert.equal(created.ok, true, JSON.stringify(created));
  const committed = await gitMutate(root, { slug: "x", args: ["commit", "--allow-empty", "-m", "work"] }, { waitSeconds: 5 });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  // The suite on the branch head, which the merge is held to.
  const tested = await runCommand(root, { which: "test", where: directory, slug: "x" });
  assert.equal(tested.ok, true, JSON.stringify(tested));

  const read = await run(["git-root", "--", "rev-parse", "--abbrev-ref", "HEAD"], root);
  assert.equal(read.code, 0, read.stderr);
  assert.equal(read.stdout, "feature\n", "a read prints git's own answer and journals nothing");
  const merged = await run(["git-root", "--slug", "x", "--", "merge", "--ff-only", "task/x"], root);
  assert.equal(merged.code, 0, merged.stderr);
  const head = await git(root, "rev-parse", "task/x");
  assert.equal(await git(root, "rev-parse", "feature"), head, "the merge landed on the root's own branch");
  assert.match(merged.stdout, new RegExp(`^journal: merged \\S+→${head}$`, "m"));
  const journal = await run(["journal", "x", "--json"], root);
  assert.equal((JSON.parse(journal.stdout) as { steps: Array<{ step: string }> }).steps.at(-1)!.step, "merged");
  // --json is the tool's own answer, whole.
  const listed = await run(["git-root", "--json", "--", "worktree", "list", "--porcelain"], root);
  assert.equal(listed.code, 0, listed.stderr);
  const answer = JSON.parse(listed.stdout) as { ok: boolean; stdout: string };
  assert.equal(answer.ok, true);
  assert.match(answer.stdout, new RegExp(`^worktree ${literally(root)}$`, "m"));
});

// @anchor cliGitRootRefusedInTask
test("git-root is refused under every task marker, a read as much as a mutation, before it writes a lock or an exclusion", async (t) => {
  const root = scratch(t);
  await git(root, "init", "-b", "main");
  const initialized = await run(["init", "--mode", "solo"], root);
  assert.equal(initialized.code, 0, initialized.stderr);
  const exclude = path.join(root, ".git", "info", "exclude");
  const excluded = () => (fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : null);
  const before = excluded();
  for (const [variable, value] of [["CROSS_AGENT_TASK", "a-task"], ["CROSS_AGENT_DEPTH", "1"], ["CROSS_AGENT_LINEAGE", `lead:${root}`]]) {
    for (const args of [["git-root", "--", "status"], ["git-root", "--slug", "x", "--", "merge", "--ff-only", "task/x"]]) {
      const ran = await run(args, root, undefined, { ...suiteEnv, [variable]: value });
      assert.equal(ran.code, 3, `${variable}: ${args.join(" ")}: ${ran.stderr}`);
      assert.match(ran.stderr, new RegExp(`${variable} is set in this environment: git-root is an operator's command`));
    }
  }
  assert.equal(fs.existsSync(path.join(root, ".cross-agent", "locks")), false, "no lock directory");
  assert.equal(excluded(), before, "and no exclusion line");
});

// @anchor cliGitRootTakesLocks
test("git-root waits out the repository lock past its project's own wait, and is refused for git.lock after that wait", async (t) => {
  const root = await rootProject(t, { mode: "solo", roles: {}, limits: { lockWaitSeconds: 1 } });
  const { acquire, gitLockName, lockPath, repositoryLockPath } = await import("../src/locks.ts");
  const shared = await acquire(repositoryLockPath(path.join(root, ".git")), { operation: "another project's git step", waitSeconds: 0 });
  t.after(() => shared.release());
  const directory = path.join(root, ".worktrees", "x");
  const pending = run(["git-root", "--slug", "x", "--", "worktree", "add", "-b", "task/x", directory, "main"], root);
  await delay(1500);
  assert.equal(fs.existsSync(directory), false, "nothing ran while another project held the repository lock");
  await shared.release();
  const created = await pending;
  assert.equal(created.code, 0, created.stderr);
  assert.equal(fs.existsSync(directory), true);

  const held = await acquire(lockPath(root, gitLockName()), { operation: "a test holding the git lock", waitSeconds: 0 });
  t.after(() => held.release());
  const blocked = await run(["git-root", "--", "status"], root);
  await held.release();
  assert.equal(blocked.code, 3, blocked.stderr);
  assert.match(blocked.stderr, /git\.lock is held by another process \(waited 1s\)/);
});

// @anchor cliGitRootExitCodes
test("git-root exits 0 when git ran, 1 when git failed or its step went unrecorded, 3 when refused before git, 2 for a line it cannot read", async (t) => {
  if (process.getuid!() === 0) {
    t.skip("root writes a directory whatever its mode says, so an unwritable journal cannot be staged");
    return;
  }
  const root = await rootProject(t, { mode: "solo", roles: {} });
  const ok = await run(["git-root", "--", "status", "--porcelain"], root);
  assert.equal(ok.code, 0, ok.stderr);
  // git ran and failed: its own words, and the reason after them.
  const failed = await run(["git-root", "--", "rebase", "--abort"], root);
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stderr, /exited 128/);
  // Refused before git ran: a verb outside the whitelist, and a journaled verb with no slug.
  for (const args of [["git-root", "--", "push", "origin", "main"], ["git-root", "--", "branch", "-d", "task/x"]]) {
    const refusal = await run(args, root);
    assert.equal(refusal.code, 3, `${args.join(" ")}: ${refusal.stderr}`);
  }
  // git's arguments come after `--`, and there has to be one.
  assert.equal((await run(["git-root", "status"], root)).code, 2);
  // git exited 0, and the step it completed could not be written: the command happened,
  // and its answer says so rather than 0.
  const journals = path.join(root, ".cross-agent", "journal");
  fs.mkdirSync(journals, { recursive: true });
  t.after(() => { try { fs.chmodSync(journals, 0o755); } catch { /* gone */ } });
  fs.chmodSync(journals, 0o555);
  const directory = path.join(root, ".worktrees", "y");
  const unrecorded = await run(["git-root", "--slug", "y", "--json", "--", "worktree", "add", "-b", "task/y", directory, "main"], root);
  fs.chmodSync(journals, 0o755);
  assert.equal(unrecorded.code, 1, unrecorded.stdout);
  const document = JSON.parse(unrecorded.stdout) as { ok: boolean; exitCode: number; reason: string };
  assert.equal(document.ok, false);
  assert.equal(document.exitCode, 0);
  assert.match(document.reason, /journal step could not be written/);
  assert.equal(fs.existsSync(directory), true);
});

// `init` in a worktree (design section 10): judged from outside in before anything is
// written, its default branch the worktree's own, its config the main checkout's or the
// mode's defaults, and the Grok attach copied as a regular file through no link.

/** A main checkout initialized for `mode`, its consultant moved to a model of its own as an operator would. */
async function initializedMain(t: TestContext, mode = "dev-team"): Promise<string> {
  const main = await mainCheckout(scratch(t), "M");
  const ran = await run(["init", "--mode", mode], main);
  assert.equal(ran.code, 0, ran.stderr);
  const config = written(main);
  (config.roles as Record<string, Record<string, unknown>>).consult.model = "a-model-of-this-project";
  fs.writeFileSync(path.join(main, CONFIG_PATH), JSON.stringify(config, null, 2));
  return main;
}

/** A refused `init` in `cwd`: a 3 that changed nothing at `root`. */
async function refusedInit(args: string[], cwd: string, root: string): Promise<string> {
  const before = fs.readdirSync(root).sort();
  const ran = await run(["init", ...args], cwd);
  assert.equal(ran.code, 3, `${args.join(" ")}: ${ran.stderr}`);
  assert.deepEqual(fs.readdirSync(root).sort(), before, "a refused init writes nothing");
  return ran.stderr;
}

/** `written(root)`'s default branch. */
function defaultBranchOf(root: string): string {
  return (written(root).project as Record<string, string>).defaultBranch;
}

// @anchor initInWorktree
test("init in a linked worktree copies its main checkout's config, the worktree's own branch its default", async (t) => {
  const main = await initializedMain(t);
  const linked = await linkedProject(t, main, "feature/one");
  const ran = await run(["init"], linked);
  assert.equal(ran.code, 0, ran.stderr);
  const source = written(main);
  assert.deepEqual(written(linked), { ...source, project: { ...(source.project as Record<string, string>), defaultBranch: "feature/one" } });
  assert.ok(ran.stdout.includes(path.join(main, CONFIG_PATH)), ran.stdout);
  assert.equal(fs.readFileSync(path.join(linked, ".gitignore"), "utf8"), ".cross-agent/\n.worktrees/\n");
  assert.equal(defaultBranchOf(main), "main", "the source is left as it was");
  // `--mode` names the mode's defaults, so beside a main checkout's config it is the answer
  // rather than a 2: only `--from` names a config to copy, and the one found is not copied.
  const defaults = await linkedProject(t, main, "feature/two");
  const named = await run(["init", "--mode", "solo"], defaults);
  assert.equal(named.code, 0, named.stderr);
  assert.equal(written(defaults).mode, "solo");
  assert.equal(defaultBranchOf(defaults), "feature/two");
  // A config named and a mode named are two answers to one question.
  const both = await run(["init", "--mode", "solo", "--from", main], await linkedProject(t, main, "feature/three"));
  assert.equal(both.code, 2, both.stderr);
  assert.match(both.stderr, /--mode[\s\S]*--from|--from[\s\S]*--mode/);
  // A main checkout still writes `main`, whatever it has checked out.
  const trunk = await mainCheckout(scratch(t), "T");
  await git(trunk, "checkout", "-b", "trunk");
  assert.equal((await run(["init", "--mode", "solo"], trunk)).code, 0);
  assert.equal(defaultBranchOf(trunk), "main");
});

// @anchor initUmbrellaWorktree
test("init in an umbrella layout's worktree takes the mode's defaults on its own branch: there is no checkout to copy", async (t) => {
  const umbrella = await umbrellaProject(t);
  const ran = await run(["init", "--mode", "solo"], umbrella.root);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(written(umbrella.root).mode, "solo");
  assert.equal(defaultBranchOf(umbrella.root), "feature");
  // The umbrella itself is no work tree of the repository, and no project.
  const reason = await refusedInit([], umbrella.umbrella, umbrella.umbrella);
  assert.match(reason, /an unsupported root that is no work tree/);
  assert.doesNotMatch(reason, /\ba unsupported\b/);
});

// @anchor initBareDotGitDefaults
test("init in a worktree of a bare repository at U/.git takes the defaults, though the listing names U without bare", async (t) => {
  const fixture = await bareDotGitProject(t);
  const ran = await run(["init"], fixture.root);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(written(fixture.root).mode, "dev-team");
  assert.equal(defaultBranchOf(fixture.root), "feature");
  assert.match(await refusedInit([], fixture.bare, fixture.bare), /unsupported/);
  // No work tree, whatever the flags: `--from` is not what is wrong there.
  assert.match(await refusedInit(["--from", fixture.root], fixture.bare, fixture.bare), /no work tree/);
});

// @anchor initFrom
test("init --from copies the config the directory holds, on the worktree's own branch", async (t) => {
  const source = await initializedMain(t, "solo");
  const separated = await separatedMainProject(t);
  const ran = await run(["init", "--from", source], separated.root);
  assert.equal(ran.code, 0, ran.stderr);
  const copied = written(source);
  assert.deepEqual(written(separated.root), { ...copied, project: { ...(copied.project as Record<string, string>), defaultBranch: "feature" } });
  const both = await run(["init", "--from", source, "--mode", "solo"], separated.root);
  assert.equal(both.code, 2, both.stderr);
  // A main checkout is no worktree to copy into: init writes the mode's own there.
  const main = await mainCheckout(scratch(t), "N");
  assert.match(await refusedInit(["--from", source], main, main), /--from/);
});

// @anchor initFromMissing
test("init --from a directory that is not there is a 3, and writes nothing", async (t) => {
  const main = await initializedMain(t);
  const linked = await linkedProject(t, main, "feature");
  assert.match(await refusedInit(["--from", path.join(main, "absent")], linked, linked), /absent/);
});

// @anchor initFromNoConfig
test("init --from a directory holding no config is a 3, never a silent default", async (t) => {
  const main = await initializedMain(t);
  const linked = await linkedProject(t, main, "feature");
  const empty = scratch(t);
  assert.match(await refusedInit(["--from", empty], linked, linked), /holds no \.cross-agent\/config\.json/);
});

// @anchor initDetachedRefused
test("init in a worktree with a detached HEAD is a 3: it has no branch to make the default", async (t) => {
  const main = await initializedMain(t);
  const linked = await linkedProject(t, main, "feature");
  await git(linked, "checkout", "--detach");
  assert.match(await refusedInit([], linked, linked), /detached/);
});

/** An initialized main checkout and a task worktree under it, `.worktrees/t` on `task/t`. */
async function mainWithTaskWorktree(t: TestContext): Promise<{ main: string; task: string }> {
  const main = await initializedMain(t);
  const task = path.join(main, ".worktrees", "t");
  await git(main, "worktree", "add", "-b", "task/t", task);
  return { main, task: fs.realpathSync(task) };
}

// @anchor initRemovedPointerRefused
test("init in a task worktree whose pointer was deleted is a 3 naming it and the work tree that registers it", async (t) => {
  const { main, task } = await mainWithTaskWorktree(t);
  fs.rmSync(path.join(task, ".git"));
  const reason = await refusedInit([], task, task);
  assert.ok(reason.includes(task) && reason.includes(main), reason);
});

// @anchor initReplacedPointerRefused
test("init in a task worktree whose pointer was replaced by a repository is a 3, decided before its .git is read", async (t) => {
  const { main, task } = await mainWithTaskWorktree(t);
  fs.rmSync(path.join(task, ".git"));
  await git(task, "init", "-b", "main");
  const reason = await refusedInit([], task, task);
  assert.ok(reason.includes(task) && reason.includes(main), reason);
});

// @anchor initInsideCommonDirRefused
test("init in a worktree inside its own git directory is a 3 naming the fix", async (t) => {
  const { root } = await rootInsideCommonDir(t);
  assert.match(await refusedInit([], root, root), /beside the git directory/);
});

// @anchor initUnsupportedWorkTreeDefaults
test("init at a checkout whose git directory lies outside it writes the mode's defaults on main, as before worktree projects", async (t) => {
  // A separated main's own checkout, a submodule, and a main checkout whose .git links to
  // its git directory are work trees by their own git: init there is a main checkout's.
  const separated = await separatedMainProject(t);
  const { submodule } = await submoduleProject(t);
  const linkedGit = await symlinkedGitProject(t);
  for (const root of [separated.main, submodule, linkedGit.main]) {
    const ran = await run(["init"], root);
    assert.equal(ran.code, 0, `${root}: ${ran.stderr}`);
    assert.equal(written(root).mode, "dev-team", root);
    assert.equal(defaultBranchOf(root), "main", root);
  }
  // `--from` copies into a linked worktree, and none of these is one, nor a main checkout.
  const refusal = await refusedInit(["--from", separated.main], linkedGit.main, linkedGit.main);
  assert.match(refusal, /--from/);
  assert.doesNotMatch(refusal, /a main checkout/);
  // A link git does not read as the root's own git directory makes no project.
  const other = await mainCheckout(scratch(t), "N");
  fs.rmSync(path.join(other, ".git"), { recursive: true });
  fs.symlinkSync(scratch(t), path.join(other, ".git"), "dir");
  assert.match(await refusedInit([], other, other), /refuses/);
});

// @anchor initBranchOutsideAlphabetRefused
test("init in a worktree on a branch git_root could not name is a 3 naming the branch and the rule", async (t) => {
  const main = await initializedMain(t);
  const linked = await linkedProject(t, main, "feature+one");
  const reason = await refusedInit([], linked, linked);
  assert.match(reason, /feature\+one/);
  assert.match(reason, /letters, digits/);
});

// @anchor initSeparatedMainNeedsFrom
test("init in a worktree of a separated main needs --from, or --mode for the defaults", async (t) => {
  const separated = await separatedMainProject(t);
  const reason = await refusedInit([], separated.root, separated.root);
  assert.match(reason, /--from <main checkout>/);
  assert.match(reason, /--mode/);
  const ran = await run(["init", "--mode", "solo"], separated.root);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(defaultBranchOf(separated.root), "feature");
});

// @anchor initTaskPatternBranchRefused
test("init in a worktree on a branch the mode's task pattern matches is a 3 naming the pattern", async (t) => {
  const main = await initializedMain(t);
  const linked = await linkedProject(t, main, "task/topic");
  const reason = await refusedInit([], linked, linked);
  assert.match(reason, /task\/topic/);
  assert.match(reason, /task\/\*/);
});

/** A `.grok/config.toml` as the install guide's attach writes it, discovering the project by the working directory. */
const shippedAttach = '[plugins]\npaths = ["/home/someone/Documents/cross-agent-cli"]\nenabled = ["cross-agent"]\n\n[mcp]\nmax_output_bytes = 100000\n';

// @anchor initCopiesGrokAttach
test("init copies the source's Grok attach once, a regular file written through no link, and leaves what is there alone", async (t) => {
  const main = await initializedMain(t);
  fs.mkdirSync(path.join(main, ".grok"));
  fs.writeFileSync(path.join(main, ".grok", "config.toml"), shippedAttach);

  // Copied once, byte for byte, ignored beside the project's own state, and the trust that
  // only the user can give named.
  const linked = await linkedProject(t, main, "feature");
  const ran = await run(["init"], linked);
  assert.equal(ran.code, 0, ran.stderr);
  const copy = path.join(linked, ".grok", "config.toml");
  assert.equal(fs.readFileSync(copy, "utf8"), shippedAttach);
  assert.equal(fs.lstatSync(copy).isFile(), true);
  assert.match(ran.stdout, /trusted_folders\.toml/);
  assert.ok(fs.readFileSync(path.join(linked, ".gitignore"), "utf8").split("\n").includes(".grok/"));
  // An existing file is kept, and named.
  fs.writeFileSync(copy, "# edited by the operator\n");
  const again = await run(["init"], linked);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fs.readFileSync(copy, "utf8"), "# edited by the operator\n");
  assert.ok(`${again.stdout}${again.stderr}`.includes(copy), again.stderr);

  // A source whose file is a link, or whose `.grok` is: not copied, and named.
  const elsewhere = scratch(t);
  fs.writeFileSync(path.join(elsewhere, "config.toml"), shippedAttach);
  const leaf = await initializedMain(t);
  fs.mkdirSync(path.join(leaf, ".grok"));
  fs.symlinkSync(path.join(elsewhere, "config.toml"), path.join(leaf, ".grok", "config.toml"));
  const parent = await initializedMain(t);
  fs.symlinkSync(elsewhere, path.join(parent, ".grok"));
  for (const source of [leaf, parent]) {
    const worktree = await linkedProject(t, source, "feature");
    const linkedRun = await run(["init"], worktree);
    assert.equal(linkedRun.code, 0, linkedRun.stderr);
    assert.equal(fs.existsSync(path.join(worktree, ".grok")), false, source);
    assert.match(linkedRun.stderr, /symbolic link/);
  }

  // A destination whose `.grok` is a link, or whose file is a dangling one: left alone, and
  // nothing is written through either.
  const target = scratch(t);
  const linkedParent = await linkedProject(t, main, "parent");
  fs.symlinkSync(target, path.join(linkedParent, ".grok"));
  const dangling = await linkedProject(t, main, "dangling");
  fs.mkdirSync(path.join(dangling, ".grok"));
  fs.symlinkSync(path.join(target, "nowhere.toml"), path.join(dangling, ".grok", "config.toml"));
  for (const worktree of [linkedParent, dangling]) {
    const destinationRun = await run(["init"], worktree);
    assert.equal(destinationRun.code, 0, destinationRun.stderr);
    assert.match(destinationRun.stderr, /left alone/);
  }
  assert.deepEqual(fs.readdirSync(target), [], "no link was written through");
});

// @anchor initModeCopiesGrokAttach
test("init in a worktree copies the main checkout's Grok attach whatever the team config came from", async (t) => {
  // Beside a main config `--mode` writes the mode's defaults, and beside none init does:
  // the attach is the main checkout's either way.
  const configured = await initializedMain(t);
  const bare = await mainCheckout(scratch(t), "N");
  for (const [main, args] of [[configured, ["--mode", "solo"]], [bare, []]] as const) {
    fs.mkdirSync(path.join(main, ".grok"));
    fs.writeFileSync(path.join(main, ".grok", "config.toml"), shippedAttach);
    const linked = await linkedProject(t, main, "feature");
    const ran = await run(["init", ...args], linked);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(written(linked).mode, args.length > 0 ? "solo" : "dev-team");
    assert.equal(fs.readFileSync(path.join(linked, ".grok", "config.toml"), "utf8"), shippedAttach, main);
    assert.match(ran.stdout, /trusted_folders\.toml/);
    assert.ok(fs.readFileSync(path.join(linked, ".gitignore"), "utf8").split("\n").includes(".grok/"), main);
  }
});

// @anchor initKeptGrokAttachIgnored
test("a first init in a worktree that already holds a regular Grok attach keeps it and ignores .grok/", async (t) => {
  const main = await initializedMain(t);
  fs.mkdirSync(path.join(main, ".grok"));
  fs.writeFileSync(path.join(main, ".grok", "config.toml"), shippedAttach);
  // The worktree's own attach, and no rule ignoring it: kept beside a source that has one,
  // and beside the mode's defaults, which copy none.
  for (const [branch, args] of [["kept", []], ["defaults", ["--mode", "solo"]]] as const) {
    const linked = await linkedProject(t, main, branch);
    fs.mkdirSync(path.join(linked, ".grok"));
    fs.writeFileSync(path.join(linked, ".grok", "config.toml"), "# the worktree's own\n");
    const ran = await run(["init", ...args], linked);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(fs.readFileSync(path.join(linked, ".grok", "config.toml"), "utf8"), "# the worktree's own\n", branch);
    assert.ok(fs.readFileSync(path.join(linked, ".gitignore"), "utf8").split("\n").includes(".grok/"), `${branch}: .grok/ is ignored`);
    assert.doesNotMatch(await git(linked, "status", "--porcelain", "--untracked-files=normal"), /\.grok/, branch);
  }
});

// @anchor initBoundGrokAttachNotCopied
test("init copies no Grok attach that binds a project, and prints the binding to set up by hand", async (t) => {
  for (const binding of ['args = ["--project", "/projects/main"]', 'env = { CROSS_AGENT_PROJECT = "/projects/main" }']) {
    const main = await initializedMain(t);
    fs.mkdirSync(path.join(main, ".grok"));
    fs.writeFileSync(path.join(main, ".grok", "config.toml"), `${shippedAttach}\n[mcp_servers.cross-agent]\n${binding}\n`);
    const linked = await linkedProject(t, main, "feature");
    const ran = await run(["init"], linked);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(fs.existsSync(path.join(linked, ".grok")), false, binding);
    assert.ok(ran.stderr.includes(binding), ran.stderr);
    assert.match(ran.stderr, /by hand/);
  }
});
