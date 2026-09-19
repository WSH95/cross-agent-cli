import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// `tools/e2e-verify.mjs` is what every end-to-end run is judged by, so what it cannot read
// it must not call a pass. Two of its eight conditions are the ones a run can fail without
// anyone noticing: the transcript scan, which has to read three engines' own log shapes,
// and the journal, which has to hold the loop's steps in order.

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verify = path.join(repoRoot, "tools", "e2e-verify.mjs");

async function run(project: string): Promise<{ code: number; out: string }> {
  return runWith(project, []);
}

async function runWith(project: string, extra: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await exec(process.execPath, [verify, "--project", project, ...extra], { encoding: "utf8" });
    return { code: 0, out: stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? -1, out: failure.stdout ?? "" };
  }
}

/** The line of the report for one condition, by the words it opens with. */
function verdict(out: string, name: string): string {
  const line = out.split("\n").find((entry) => entry.includes(name));
  assert.ok(line !== undefined, `no line for ${name} in:\n${out}`);
  return line.trim().split(/\s+/)[0];
}

const claudeLog = (command: string) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
].join("\n") + "\n";

const claudeDelegate = [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__cross-agent__delegate", input: { role: "consult" } }] } }),
].join("\n") + "\n";

/** A Grok turn that runs a shell command, which is `run_terminal_command` for that engine. */
const grokBash = (command: string) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: "g" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "run_terminal_command", input: { command } }] } }),
].join("\n") + "\n";

/** Grok reaches an MCP tool through its `use_tool` dispatcher, which names the tool inside. */
const grokLog = (toolName: string) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: "g" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "use_tool", input: { tool_name: toolName, tool_input: {} } }] } }),
].join("\n") + "\n";

/**
 * Codex's own shape, as `docs/probes.md` records it: items, not Anthropic content blocks,
 * and a command that is `/bin/bash -lc '…'` with the real command inside the quotes.
 * `extraItem` stands for an item type no archived Codex JSON has shown.
 */
const codexLog = (command: string, extraItem?: Record<string, unknown>) => [
  JSON.stringify({ type: "thread.started", thread_id: "t" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "I will run it." } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command, aggregated_output: "", exit_code: 0, status: "completed" } }),
  ...(extraItem === undefined ? [] : [JSON.stringify({ type: "item.completed", item: extraItem })]),
  JSON.stringify({ type: "turn.completed" }),
].join("\n") + "\n";

const journalSteps = ["worktree-created", "git", "committed", "merged", "tests-passed", "worktree-removed", "branch-deleted"];

/**
 * A finished project as an end-to-end run leaves one: a repository on `main` with one
 * commit, a journal, and one task record per delegation with the log each engine wrote.
 */
async function project(
  t: TestContext,
  logs: Record<string, string>,
  options: { steps?: unknown; journal?: string; others?: Record<string, unknown> } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "e2e-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "sample\n");
  // What `cross-agent init` puts there, so the ledger the run leaves behind does not make
  // the working tree dirty — the condition this tool checks two rows above.
  await writeFile(path.join(root, ".gitignore"), ".cross-agent/\n.worktrees/\n");
  await exec("git", ["-C", root, "init", "-b", "main"]);
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "initial"]);
  await mkdir(path.join(root, ".cross-agent", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".cross-agent", "journal"), { recursive: true });
  await writeFile(path.join(root, ".cross-agent", "config.json"), JSON.stringify({
    // A command that runs and exits zero, so the suite row is a pass and the exit status
    // is about the rows this file is testing.
    mode: "dev-team", project: { defaultBranch: "main", testCommand: "true" }, limits: { maxDepth: 1 },
    // A configured binary is a deny target of its own (`src/guard.ts#denyTargets`), so
    // the scan has to know this project's.
    engines: { claude: { bin: "/opt/wrapper" } },
  }));
  await writeFile(
    path.join(root, ".cross-agent", "journal", "slug.json"),
    options.journal ?? JSON.stringify({ slug: "slug", branch: "task/slug", steps: (options.steps ?? journalSteps.map((step) => ({ step }))) }),
  );
  // Older journals of the same project: a consult that never took a worktree, a run that
  // was interrupted. A later complete run is not judged by them.
  for (const [name, body] of Object.entries(options.others ?? {})) {
    const file = path.join(root, ".cross-agent", "journal", `${name}.json`);
    await writeFile(file, JSON.stringify(body));
    await utimes(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  }
  let n = 0;
  for (const [engine, body] of Object.entries(logs)) {
    const id = `task${++n}`;
    const logPath = path.join(root, ".cross-agent", "tasks", `${id}.ndjson`);
    await writeFile(logPath, body);
    await writeFile(path.join(root, ".cross-agent", "tasks", `${id}.json`), JSON.stringify({
      id, role: "implementer", engine, status: "done", depth: 1, createdAt: 1, updatedAt: 2,
      logPath, resultPath: path.join(root, ".cross-agent", "tasks", `${id}.out`),
    }));
  }
  return root;
}

const scan = "no delegate call and no engine launch in any specialist transcript";
const journal = "the journal shows every git step";

test("a clean transcript in each engine's own shape passes the scan", async (t) => {
  const root = await project(t, {
    claude: claudeLog("python3 -m unittest discover -s tests -t ."),
    grok: grokLog("cross-agent__describe_mode"),
    codex: codexLog("/bin/bash -lc 'python3 -m unittest discover -s tests -t .'"),
  });
  const { code, out } = await run(root);
  // The specialist row's own tools are not offences, whatever a host spells them.
  assert.equal(verdict(out, scan), "pass", out);
  // Every row passing is the only exit 0 there is.
  assert.equal(code, 0, out);
});

test("a delegate call is an offence in every host's spelling, including Grok's dispatcher", async (t) => {
  for (const logs of [
    { claude: claudeDelegate },
    { grok: grokLog("cross-agent__delegate") },
  ]) {
    const root = await project(t, logs);
    const { code, out } = await run(root);
    assert.equal(verdict(out, scan), "FAIL", out);
    assert.equal(code, 1);
  }
});

test("a top-level event type no archived run has shown is read the same way", async (t) => {
  // R5-1: "any string `type` is noise" would let a whole unarchived shape through — a
  // transcript whose only real content is an event type nothing here knows would pass on
  // the strength of the two lines around it. The list of known event types is closed.
  const invented = [
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "mcp_tool_call", tool: "mcp__cross_agent__delegate" }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n") + "\n";
  const root = await project(t, { codex: invented });
  const { code, out } = await run(root);
  assert.equal(verdict(out, scan), "?", out);
  assert.equal(code, 2, out);
});

test("an offence already found is not withdrawn because another line went unread", async (t) => {
  // R5-2: `?` is for a transcript that offended nowhere this tool could read. One that
  // did offend has been read far enough, whatever else it holds.
  const truncated = claudeDelegate + '{"type":"assistant","message":{"content":[{"typ\n';
  const withClaude = await project(t, { claude: truncated });
  const claudeRun = await run(withClaude);
  assert.equal(verdict(claudeRun.out, scan), "FAIL", claudeRun.out);
  assert.equal(claudeRun.code, 1, claudeRun.out);

  // The same for Codex: a command that starts an engine beside an item type this build
  // cannot read is still that command.
  const mixed = codexLog("/bin/bash -lc 'claude --version'", { id: "item_2", type: "mcp_tool_call", tool: "whatever" });
  const withCodex = await project(t, { codex: mixed });
  const codexRun = await run(withCodex);
  assert.equal(verdict(codexRun.out, scan), "FAIL", codexRun.out);
  assert.equal(codexRun.code, 1, codexRun.out);
});

test("a Codex item type no archived run has shown makes the scan answer, not guess", async (t) => {
  // The only Codex items any archived `--json` transcript holds are `agent_message` and
  // `command_execution` (`docs/probes.md`, the native samples). How Codex names an MCP
  // call is unknown until I1's Codex row runs, so a log carrying any other item type is
  // evidence this tool cannot read — never a pass, and never an invented offence either.
  const root = await project(t, { codex: codexLog("/bin/bash -lc 'true'", { id: "item_2", type: "mcp_tool_call", tool: "mcp__cross_agent__delegate" }) });
  const { code, out } = await run(root);
  assert.equal(verdict(out, scan), "?", out);
  assert.equal(code, 2, out);
});

test("a shell command that starts an engine is an offence through a shell's own quoting", async (t) => {
  for (const logs of [
    { claude: claudeLog("claude -p 'do the work'") },
    // A path is still that engine, and this server's own entry point is a launch too: the
    // deny list names both (design section 3), so the scan has to see both.
    { claude: claudeLog("/usr/bin/claude -p hello") },
    { claude: claudeLog("node /home/op/agent-team-cli/src/server.ts --project /tmp/x") },
    // The shape the probes recorded: Codex wraps everything in `/bin/bash -lc '…'`, so the
    // engine's name is preceded by a quote and not by whitespace.
    { codex: codexLog("/bin/bash -lc 'grok -p hello'") },
    { codex: codexLog(`/bin/bash -lc 'echo "DEPTH=\${CROSS_AGENT_DEPTH:-NONE}"; claude --version'`) },
    { grok: grokBash("codex exec 'do the work'") },
    // The deny list names this CLI as well as the server (`src/guard.ts#denyTargets`).
    // AGENTS.md documents the server as `node src/server.ts`, and `package.json`'s `bin`
    // is the CLI's entry point, so both are launches however the path is spelled.
    { claude: claudeLog("node /home/op/agent-team-cli/src/cli.ts init --mode solo") },
    { claude: claudeLog("node src/cli.ts init --mode solo") },
    { claude: claudeLog("node ./src/server.ts") },
    { claude: claudeLog("cd x && node src/cli.ts init") },
    { codex: codexLog("/bin/bash -lc 'node src/server.ts'") },
    // And the binary this project configured, which is the fourth kind of deny target.
    { claude: claudeLog("/opt/wrapper -p hello") },
  ]) {
    const root = await project(t, logs);
    const { code, out } = await run(root);
    assert.equal(verdict(out, scan), "FAIL", out);
    assert.equal(code, 1, out);
  }
});

test("the exit status says which of the three verdicts the run reached", async (t) => {
  // A controller that reads only the status has to be able to tell silence from success:
  // 0 when every row passed, 1 when any failed, 2 when any row had no evidence.
  const clean = await project(t, { claude: claudeLog("true") });
  assert.equal((await run(clean)).code, 0);
  const failing = await project(t, { claude: claudeDelegate });
  assert.equal((await run(failing)).code, 1);
  // A log that exists but says nothing this tool can read: every other row passes, so the
  // only thing between the caller and a green run is the verdict it cannot judge.
  const silent = await project(t, { claude: "not json at all\n" });
  const answered = await run(silent);
  assert.equal(verdict(answered.out, scan), "?", answered.out);
  assert.equal(answered.code, 2, answered.out);
});

test("reading a file that happens to be named like one of them is not a launch", async (t) => {
  // The deny list is about command words, not about paths anywhere in a line: a
  // specialist reading this repository's own source is doing what a reviewer does.
  for (const command of [
    "cat src/server.ts",
    "git show HEAD:src/server.ts",
    "rg --files-with-matches server.ts src",
    "python3 -m unittest discover -s tests -t .",
    // A name that merely ends in an engine's is not that engine, and a dotfile named
    // after one is a directory to look at, not a command to run.
    "not-claude --version",
    "myclaude -p hello",
    "FOO=claude python3 run.py",
    "ls ~/.claude",
    "rm -rf .grok",
    "echo pre-grok",
    // `node` as an argument is a word being searched for or printed, not a command: the
    // path after it then names a file, which is reading and not running.
    "rg node src/cli.ts",
    "grep node src/server.ts",
    "echo node src/cli.ts",
  ]) {
    const root = await project(t, { claude: claudeLog(command) });
    const { code, out } = await run(root);
    assert.equal(verdict(out, scan), "pass", `${command}\n${out}`);
    assert.equal(code, 0, out);
  }
});

test("a transcript the parser cannot read is answered with a question mark, never a pass", async (t) => {
  // The rule this tool exists for: evidence missing is not evidence of a pass. A log in a
  // shape no adapter writes, or a record whose log is gone, has nothing to say either way.
  const unreadable = await project(t, { claude: "not json at all\n{\"half\": \n" });
  assert.equal(verdict((await run(unreadable)).out, scan), "?", (await run(unreadable)).out);
  const empty = await project(t, { claude: "" });
  assert.equal(verdict((await run(empty)).out, scan), "?");
});

test("with no slug the newest journal that opened a worktree is the one judged", async (t) => {
  // A project accumulates journals: a `consult` one-shot that was cancelled, an earlier
  // interrupted run. The documented command names no slug, so a later complete run must
  // not be failed by an older file — and the others are named rather than hidden.
  const logs = { claude: claudeLog("true") };
  const others = {
    stale: { slug: "stale", branch: "task/stale", steps: [{ step: "worktree-created" }] },
    consult: { slug: "consult", branch: "task/consult", steps: [{ step: "git" }] },
  };
  const root = await project(t, logs, { others });
  const { code, out } = await run(root);
  assert.equal(verdict(out, journal), "pass", out);
  assert.equal(code, 0, out);
  const line = out.split("\n").find((entry) => entry.includes(journal))!;
  assert.match(line, /slug:/);
  assert.match(line, /not judged: consult, stale|not judged: stale, consult/);

  // Named with `--slug`, that one is judged whatever its age.
  const named = await runWith(root, ["--slug", "stale"]);
  assert.equal(verdict(named.out, journal), "FAIL", named.out);
});

test("the journal has to hold the loop's steps in order, and an empty one fails", async (t) => {
  const complete = await project(t, { claude: claudeLog("true") });
  assert.equal(verdict((await run(complete)).out, journal), "pass");

  // A run that opened its worktree and stopped: every later step is missing, which is a
  // failure and not a silence.
  const stopped = await project(t, { claude: claudeLog("true") }, { steps: [{ step: "worktree-created" }] });
  assert.equal(verdict((await run(stopped)).out, journal), "FAIL");

  // A journal that never opened a worktree is not this run's, so with no slug there is
  // nothing to judge — and saying so is not the same as passing.
  const empty = await project(t, { claude: claudeLog("true") }, { steps: [] });
  const answered = await run(empty);
  assert.equal(verdict(answered.out, journal), "?", answered.out);
  assert.equal(answered.code, 2, answered.out);
  // Named outright, the same file is judged and fails.
  assert.equal(verdict((await runWith(empty, ["--slug", "slug"])).out, journal), "FAIL");

  const missing = await project(t, { claude: claudeLog("true") }, {
    steps: journalSteps.filter((step) => step !== "merged").map((step) => ({ step })),
  });
  assert.equal(verdict((await run(missing)).out, journal), "FAIL");

  const reordered = await project(t, { claude: claudeLog("true") }, {
    steps: ["worktree-created", "merged", "committed", "tests-passed", "worktree-removed", "branch-deleted"].map((step) => ({ step })),
  });
  assert.equal(verdict((await run(reordered)).out, journal), "FAIL");

  // Not the journal schema at all: nothing to judge, rather than a pass or a failure.
  const foreign = await project(t, { claude: claudeLog("true") }, { journal: JSON.stringify({ notes: "something else" }) });
  assert.equal(verdict((await run(foreign)).out, journal), "?");
});
