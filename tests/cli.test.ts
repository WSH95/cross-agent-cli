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

// `cross-agent init --mode <name>` is the one operator command this step ships (design
// section 10). It writes the bind-time config for a mode and answers with an exit code:
// 0 wrote it, 1 could not, 2 could not read the command line.

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
test("a mode this build does not have is an error, and a command line it cannot read is usage", async (t) => {
  const root = scratch(t);
  const unknown = await run(["init", "--mode", "no-such-mode"], root);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /no-such-mode/);
  assert.equal(unknown.stdout, "");
  assert.equal(fs.existsSync(path.join(root, CONFIG_PATH)), false, "a refused init writes nothing");

  const missingProject = await run(["init", "--mode", "solo", "--project", path.join(root, "absent")], root);
  assert.equal(missingProject.code, 1);
  assert.match(missingProject.stderr, /absent/);

  for (const args of [
    [], ["modes"], ["init", "--mode"], ["init", "--mode", "solo", "extra"], ["init", "--engine", "codex"],
    ["init", "--mode", "solo", "--mode", "dev-team"], ["--mode", "solo"], ["init", "--mode", ""],
  ]) {
    const ran = await run(args, root);
    assert.equal(ran.code, 2, `${args.join(" ")}: ${ran.stderr}`);
    assert.match(ran.stderr, /usage: cross-agent init/, args.join(" "));
    assert.equal(ran.stdout, "");
  }
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
