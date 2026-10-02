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

/**
 * The verifier over `project`, with `CODEX_HOME` the fixture's own: Codex's session
 * rollouts are read from there, never from the machine's `~/.codex`.
 */
async function runWith(project: string, extra: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await exec(process.execPath, [verify, "--project", project, ...extra], {
      encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome(project) },
    });
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

/**
 * The item Codex 0.159.2 writes for an MCP tool call, from I1's tracked Codex row (task
 * `994d5673…`, `docs/probes.md#i1CodexTracked`), trimmed: the server and the tool are two
 * fields, and the same item arrives as `item.started` and then `item.completed`.
 */
const codexMcpCall = (tool: string) => [
  JSON.stringify({ type: "thread.started", thread_id: "t" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.started", item: { id: "item_1", type: "mcp_tool_call", server: "cross-agent", tool, arguments: {}, result: null, error: null, status: "in_progress" } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "mcp_tool_call", server: "cross-agent", tool, arguments: {}, result: { content: [{ type: "text", text: "…" }], structured_content: null }, error: null, status: "completed" } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "done" } }),
  JSON.stringify({ type: "turn.completed" }),
].join("\n") + "\n";

/** Where a fixture project keeps the Codex home its rollouts are read from: ignored by git. */
const codexHome = (project: string) => path.join(project, ".cross-agent", "codex-home");

/**
 * A Codex session rollout as codex-cli 0.159.2 writes it, trimmed from A6's archived one
 * (`docs/probes.md#codexCacheWritable`): the session's own line, then for each command
 * the code-mode `exec` call whose script runs it through `tools.exec_command` and that
 * call's output — and, for a command that exited 0, the `CommandExecution` item Codex also
 * recorded. A6's denied writes have the call and the output and no item, as here. A step
 * given as `script` is an `exec` call with that script as its input, verbatim.
 */
type RolloutStep = { cmd: string; exit: number; output?: string } | { script: string } | { entry: Record<string, unknown> } | { event: Record<string, unknown> };
const rolloutOf = (sessionId: string, steps: RolloutStep[]) => [
  { timestamp: "2026-09-30T21:49:05.892Z", type: "session_meta", payload: {
    session_id: sessionId, id: sessionId, cwd: "/sample/.worktrees/6b-codex", originator: "codex_exec", cli_version: "0.159.2", source: "exec" } },
  ...steps.flatMap((step, n) => "entry" in step ? [{ timestamp: "2026-09-30T21:49:14.246Z", type: "response_item", payload: step.entry }]
    : "event" in step ? [{ timestamp: "2026-09-30T21:49:14.246Z", type: "event_msg", payload: step.event }] : [
    { timestamp: "2026-09-30T21:49:14.246Z", type: "response_item", payload: {
      type: "custom_tool_call", status: "completed", call_id: `call_${n}`, name: "exec",
      input: "script" in step ? step.script
        : `const r = await tools.exec_command({cmd:${JSON.stringify(step.cmd)}, max_output_tokens:1000});\ntext(JSON.stringify(r));\n` } },
    ...("cmd" in step && step.exit === 0 ? [{ timestamp: "2026-09-30T21:49:14.422Z", type: "event_msg", payload: {
      type: "item_completed", thread_id: sessionId, item: {
        type: "CommandExecution", id: `exec-${n}`, command: ["/bin/bash", "-lc", step.cmd], status: "completed", exit_code: 0 } } }] : []),
    { timestamp: "2026-09-30T21:49:14.428Z", type: "response_item", payload: {
      type: "custom_tool_call_output", call_id: `call_${n}`, output: [
        { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
        { type: "input_text", text: "script" in step ? "" : JSON.stringify({ exit_code: step.exit, output: step.output ?? "" }) }] } },
  ]),
  { timestamp: "2026-09-30T21:49:29.557Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "done" } },
].map((line) => JSON.stringify(line)).join("\n") + "\n";

const journalSteps = ["worktree-created", "git", "committed", "merged", "tests-passed", "worktree-removed", "branch-deleted"];

/** One task record and its log; a bare string is a log for an implementer at depth 1. */
interface RecordSpec {
  body: string;
  /** The key the record is listed under, when the key is only a label. */
  engine?: string;
  id?: string;
  role?: string;
  depth?: number;
  parentTaskId?: string;
  /** A Codex record's thread id, which names its rollout. */
  sessionId?: string;
  /**
   * A Codex record's session rollout: its text, or `null` for none at all. A Codex record
   * given neither gets one holding the commands its own log ran, as Codex writes both.
   */
  rollout?: string | null;
}

/**
 * A finished project as an end-to-end run leaves one: a repository on `main` with one
 * commit, a journal, and one task record per delegation with the log each engine wrote.
 * `mode` and `limits` are the config's own, and `null` leaves the key out of the file.
 */
async function project(
  t: TestContext,
  logs: Record<string, string | RecordSpec>,
  options: {
    steps?: unknown; journal?: string; others?: Record<string, unknown>;
    mode?: string | null; limits?: Record<string, number> | null;
  } = {},
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
    ...(options.mode === null ? {} : { mode: options.mode ?? "dev-team" }),
    // A command that runs and exits zero, so the suite row is a pass and the exit status
    // is about the rows this file is testing.
    project: { defaultBranch: "main", testCommand: "true" },
    ...(options.limits === null ? {} : { limits: options.limits ?? { maxDepth: 1 } }),
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
  for (const [key, value] of Object.entries(logs)) {
    const spec: RecordSpec = typeof value === "string" ? { body: value } : value;
    n++;
    const id = spec.id ?? `task${n}`;
    const engine = spec.engine ?? key;
    const logPath = path.join(root, ".cross-agent", "tasks", `${id}.ndjson`);
    await writeFile(logPath, spec.body);
    const sessionId = spec.sessionId ?? (engine === "codex" ? `01a0f44a-eb7a-7603-ae3a-${String(n).padStart(12, "0")}` : undefined);
    await writeFile(path.join(root, ".cross-agent", "tasks", `${id}.json`), JSON.stringify({
      id, role: spec.role ?? "implementer", engine, status: "done", depth: spec.depth ?? 1,
      ...(spec.parentTaskId === undefined ? {} : { parentTaskId: spec.parentTaskId }),
      ...(sessionId === undefined ? {} : { sessionId }),
      createdAt: n, updatedAt: n + 1,
      logPath, resultPath: path.join(root, ".cross-agent", "tasks", `${id}.out`),
    }));
    if (engine === "codex" && sessionId !== undefined && spec.rollout !== null) {
      // Codex's `--json` shows `/bin/bash -lc '<command>'`; its rollout, the command.
      const ran = spec.body.split("\n").flatMap((line) => {
        try {
          const item = JSON.parse(line)?.item;
          if (item?.type !== "command_execution" || typeof item.command !== "string") return [];
          return [{ cmd: /^\/bin\/bash -lc '([^']*)'$/.exec(item.command)?.[1] ?? item.command, exit: 0 }];
        } catch { return []; }
      });
      const directory = path.join(codexHome(root), "sessions", "2026", "09", "30");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `rollout-2026-09-30T17-49-05-${sessionId}.jsonl`), spec.rollout ?? rolloutOf(sessionId, ran));
    }
  }
  return root;
}

/** The whole report line for one condition. */
function row(out: string, name: string): string {
  const line = out.split("\n").find((entry) => entry.includes(name));
  assert.ok(line !== undefined, `no line for ${name} in:\n${out}`);
  return line;
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
  const mixed = codexLog("/bin/bash -lc 'claude --version'", { id: "item_2", type: "tool_invocation", tool: "whatever" });
  const withCodex = await project(t, { codex: mixed });
  const codexRun = await run(withCodex);
  assert.equal(verdict(codexRun.out, scan), "FAIL", codexRun.out);
  assert.equal(codexRun.code, 1, codexRun.out);
});

test("a Codex item type no archived run has shown makes the scan answer, not guess", async (t) => {
  // The Codex items archived runs hold are `agent_message`, `command_execution` and, since
  // I1's tracked Codex row, `mcp_tool_call` (`docs/probes.md#i1CodexTracked`). A log
  // carrying any other item type is evidence this tool cannot read — never a pass, and
  // never an invented offence either, however its fields are spelled.
  const root = await project(t, { codex: codexLog("/bin/bash -lc 'true'", { id: "item_2", type: "tool_invocation", tool: "mcp__cross_agent__delegate" }) });
  const { code, out } = await run(root);
  assert.equal(verdict(out, scan), "?", out);
  assert.equal(code, 2, out);
});

// @anchor codexMcpItem
test("Codex's MCP call item is read: a specialist's own tools pass and its delegate is an offence", async (t) => {
  const reading = await project(t, { codex: codexMcpCall("list_roles") });
  const read = await run(reading);
  assert.equal(verdict(read.out, scan), "pass", read.out);
  assert.equal(read.code, 0, read.out);
  const delegating = await project(t, { codex: codexMcpCall("delegate") });
  const refused = await run(delegating);
  assert.equal(verdict(refused.out, scan), "FAIL", refused.out);
  assert.match(row(refused.out, scan), /task1 called delegate/);
  assert.equal(refused.code, 1, refused.out);
});

// @anchor oneItemOneDetail
test("a Codex item announced and then completed is one call and one command in the detail", async (t) => {
  // Codex writes a call as `item.started` and again as `item.completed`, under one id; the
  // detail of a FAIL names each once (6b-R1-6).
  const delegating = await project(t, { codex: codexMcpCall("delegate") });
  const called = row((await run(delegating)).out, scan);
  assert.equal(called.match(/called delegate/g)?.length, 1, called);
  const command = { id: "item_1", type: "command_execution", command: "/bin/bash -lc 'claude -p hi'", aggregated_output: "", exit_code: null, status: "in_progress" };
  const launching = await project(t, { codex: [
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "item.started", item: command }),
    JSON.stringify({ type: "item.completed", item: { ...command, exit_code: 1, status: "failed" } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n") + "\n" });
  const ran = row((await run(launching)).out, scan);
  assert.equal(ran.match(/ran claude -p hi/g)?.length, 1, ran);
});

// @anchor codexRolloutRead
test("a Codex record's session rollout is read: a launch only it shows fails, and none at all is a question", async (t) => {
  // Codex 0.159.2's `--json` carried no item for the commands its sandbox denied, while its
  // rollout recorded every call (A6). So each Codex record's rollout is read too (6b-R1-3).
  const log = codexLog("/bin/bash -lc 'printf inside > ./PROBE-6b-inside.txt'");
  const denied = await project(t, { codex: { body: log, sessionId: "01a0f44a-eb7a-7603-ae3a-02f2d355c7ee", rollout: rolloutOf(
    "01a0f44a-eb7a-7603-ae3a-02f2d355c7ee", [
      { cmd: "printf inside > ./PROBE-6b-inside.txt", exit: 0 },
      { cmd: "claude -p hi", exit: 1, output: "Error: getaddrinfo EAI_AGAIN api.anthropic.com" },
    ]) } });
  const deniedRun = await run(denied);
  assert.equal(verdict(deniedRun.out, scan), "FAIL", deniedRun.out);
  assert.match(row(deniedRun.out, scan), /task1 ran claude -p hi/);
  assert.equal(deniedRun.code, 1);

  const benign = await project(t, { codex: { body: log, sessionId: "01a0f44a-eb7a-7603-ae3a-02f2d355c7ef", rollout: rolloutOf(
    "01a0f44a-eb7a-7603-ae3a-02f2d355c7ef", [
      { cmd: "printf inside > ./PROBE-6b-inside.txt", exit: 0 },
      { cmd: "printf cache > ~/.cache/agent-team/cross-agent-probe-6b-CACHE.txt", exit: 1,
        output: "/bin/bash: line 1: /home/wsh/.cache/agent-team/cross-agent-probe-6b-CACHE.txt: Read-only file system\n" },
    ]) } });
  const benignRun = await run(benign);
  assert.equal(verdict(benignRun.out, scan), "pass", benignRun.out);
  assert.equal(benignRun.code, 0, benignRun.out);

  // No rollout: the commands the sandbox denied are nowhere else, so the record is a
  // question, named — never a pass.
  const missing = await project(t, { codex: { body: log, sessionId: "01a0f44a-eb7a-7603-ae3a-02f2d355c7f0", rollout: null } });
  const missingRun = await run(missing);
  assert.equal(verdict(missingRun.out, scan), "?", missingRun.out);
  assert.match(row(missingRun.out, scan), /task1: no Codex session rollout for 01a0f44a-eb7a-7603-ae3a-02f2d355c7f0/);
  assert.equal(missingRun.code, 2);

  // A code-mode call whose command is computed rather than written cannot be read either.
  const computed = rolloutOf("01a0f44a-eb7a-7603-ae3a-02f2d355c7f1", []).replace('{"timestamp":"2026-09-30T21:49:29.557Z"',
    JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "call_x", name: "exec",
      input: "const tool = ['cla', 'ude'].join(''); await tools.exec_command({cmd: tool + ' -p hi'});" } }) + '\n{"timestamp":"2026-09-30T21:49:29.557Z"');
  const opaque = await project(t, { codex: { body: log, sessionId: "01a0f44a-eb7a-7603-ae3a-02f2d355c7f1", rollout: computed } });
  assert.equal(verdict((await run(opaque)).out, scan), "?");
});

// @anchor codexScriptRead
test("a code-mode script is read as JavaScript: an escaped launch fails, and one it only names is a question", async (t) => {
  // A 0.159.2 rollout holds the script, not the command: the command is a string literal the
  // script hands `tools.exec_command`, escaped as JavaScript, beside whatever else the script
  // says. The literal is decoded and judged. Anything else in the script that reads as a
  // launch cannot be told from one the script assembles and runs, so it answers `?`, and so
  // does a script this reader cannot lex; neither is ever a pass.
  const log = codexLog("/bin/bash -lc 'ls'");
  let n = 0;
  const judged = async (script: string) => {
    const sessionId = `01a0f44a-eb7a-7603-ae3a-${String(256 + n++).padStart(12, "0")}`;
    return run(await project(t, { codex: { body: log, sessionId, rollout: rolloutOf(sessionId, [{ cmd: "ls", exit: 0 }, { script }]) } }));
  };
  for (const script of [
    // Quotes and escapes as JavaScript writes them, in each of its three quotes.
    `const r = await tools.exec_command({cmd:${JSON.stringify('cd "/tmp/a dir" && claude -p "hi there"')}, max_output_tokens:1000});`,
    String.raw`await tools.exec_command({cmd: 'sh -c \'claude -p hi\''});`,
    String.raw`await tools.exec_command({cmd: "\u0063laude -p \x68i"});`,
    "await tools.exec_command({cmd: `claude -p \"hi\"`});",
    String.raw`await tools.\u0065xec_command({cmd: "claude -p hi"});`,
    // The call's own `cmd`, wherever it sits in the object and however its key is spelled.
    'await tools.exec_command({env: {cmd: "ls"}, cmd: "claude -p hi"});',
    'await tools.exec_command({\n  "cmd":\n    "claude -p hi",\n  yield_time_ms: 10000,\n});',
    'await tools["exec_command"]({cmd: "claude -p hi"});',
    // A comment, and a regular expression holding a quote, are neither a string nor its end.
    "// strip the quotes afterwards\nconst r = await tools.exec_command({cmd: \"claude -p hi\"});\ntext(r.output.replace(/'/g, \"\"));",
    // Keystrokes a script writes to the shell it started.
    'const s = await tools.exec_command({cmd: "bash", tty: true});\nawait tools.write_stdin({session_id: s.session_id, chars: "claude -p hi\\n"});',
  ]) {
    const { code, out } = await judged(script);
    assert.equal(verdict(out, scan), "FAIL", `${script}\n${out}`);
    assert.match(row(out, scan), /task1 ran claude -p hi/, `${script}\n${out}`);
    assert.equal(code, 1, out);
  }
  // This server's `delegate`, called from a script, is a call all the same.
  const called = await judged('const r = await tools.mcp__cross_agent__delegate({role: "implementer", brief: "x"});');
  assert.equal(verdict(called.out, scan), "FAIL", called.out);
  assert.match(row(called.out, scan), /task1 called mcp__cross_agent__delegate/);

  for (const [script, why] of [
    // Named and not run: a string beside the call, a comment, a message.
    ['const note = "claude -p hi";\nconst r = await tools.exec_command({cmd: "ls"});\ntext(JSON.stringify(r));', /names a launch it does not run/],
    ['// claude -p hi\nconst r = await tools.exec_command({cmd: "ls"});', /names a launch it does not run/],
    ['const r = await tools.exec_command({cmd: "ls"});\ntext("claude -p hi was not run");', /names a launch it does not run/],
    // A script that does not lex, and a command the script computes.
    ['await tools.exec_command({cmd: "claude -p hi});', /does not read as JavaScript/],
    ["const tool = ['cla', 'ude'].join('');\nawait tools.exec_command({cmd: tool + ' -p hi'});", /exec_command call whose cmd is not a literal/],
    // This server's `delegate` named where no call of it can be seen.
    ["const name = 'mcp__cross_agent__delegate';\nawait tools[name]({role: 'implementer', brief: 'x'});", /names mcp__cross_agent__delegate in a string/],
    // Keystrokes naming an engine, written to a process whose program the rollout does not say.
    ["await tools.write_stdin({session_id: 7, chars: \"import subprocess; subprocess.run(['claude'])\\n\"});", /which program reads them/],
  ] as const) {
    const { code, out } = await judged(script);
    assert.equal(verdict(out, scan), "?", `${script}\n${out}`);
    assert.match(row(out, scan), why, `${script}\n${out}`);
    assert.equal(code, 2, out);
  }

  for (const script of [
    // A6's first run and A4's two scripts, as Codex wrote them.
    'const r = await tools.exec_command({cmd: "printf inside > ./PROBE-6b-inside.txt", workdir: "/sample/.worktrees/6b-codex", yield_time_ms: 10000});\ntext(`exit ${r.exit_code}\\nstderr:\\n${r.output}`);',
    'text(ALL_TOOLS.map(x => x.name).join("\\n"))',
    "const r = await tools.mcp__cross_agent__list_roles({});\ntext(JSON.stringify(r))",
    // Division beside regular expressions with quotes in them, and a string that is no command.
    'const r = await tools.exec_command({cmd: "wc -l README.md"});\nconst half = Number(r.output.split(/\\s+/)[0]) / 2;\ntext(String(half).replace(/"/g, "\'") + " lines; ask claude nothing");',
  ]) {
    const { code, out } = await judged(script);
    assert.equal(verdict(out, scan), "pass", `${script}\n${out}`);
    assert.equal(code, 0, out);
  }
});

// @anchor codexScriptFailClosed
test("a script passes only when every call it makes to a command tool is one this reader can follow", async (t) => {
  // `pass` needs every `exec_command`, `write_stdin` and `delegate` the script names to be a
  // direct call whose one argument is an object literal with a literal `cmd` or `chars` and
  // no spread or computed key. Anything else — an alias, `.call`, `?.(`, `eval`, `Function`,
  // `import(`, a legacy octal escape, a `/` this reader cannot tell for a division or a
  // regular expression, a regular expression that names an engine — is `?` (6b-R2-5).
  const log = codexLog("/bin/bash -lc 'ls'");
  let n = 0;
  const judged = async (script: string) => {
    const sessionId = `01a0f44a-eb7a-7603-ae3a-${String(512 + n++).padStart(12, "0")}`;
    return run(await project(t, { codex: { body: log, sessionId, rollout: rolloutOf(sessionId, [{ cmd: "ls", exit: 0 }, { script }]) } }));
  };
  const expect = async (script: string, expected: string) => {
    const { code, out } = await judged(script);
    assert.equal(verdict(out, scan), expected, `${script}\n${out}`);
    assert.equal(code, { FAIL: 1, pass: 0, "?": 2 }[expected], out);
  };
  for (const script of [
    'await tools.exec_command({cmd: "ls", ...hidden});',
    'await tools.exec_command({...hidden, cmd: "ls"});',
    'await tools.exec_command({cmd: "ls", [key]: "x"});',
    'await tools.exec_command({cmd: "ls"}, extra);',
    "const run = tools.exec_command;\nawait run({cmd: \"ls\"});",
    'await tools.exec_command.call(null, {cmd: "ls"});',
    'await tools.exec_command?.({cmd: "ls"});',
    "const d = tools.mcp__cross_agent__delegate;\nawait d({role: \"implementer\", brief: \"x\"});",
    "const name = \"exec\" + \"_command\";\nawait tools[name]({cmd: \"ls\"});",
    "eval(\"tools.exec_command({cmd: 'ls'})\");",
    'new Function("return 1")();',
    'await import("node:child_process");',
    String.raw`await tools.exec_command({cmd: "\143laude -p hi"});`,
    String.raw`await tools.exec_command({cmd: "ls\08"});`,
    'if (r) { text("a"); } /"/.test(s);\nawait tools.exec_command({cmd: "ls"});',
    "const re = /claude -p hi/;\nawait tools.exec_command({cmd: \"ls\"});",
    'if (true) /exec_command({cmd:"claude -p hi"})/.test("x");\nawait tools.exec_command({cmd:"ls"});',
    'setTimeout("tools.exec_command({cmd: \'claude -p hi\'})", 0);\nawait tools.exec_command({cmd: "ls"});',
  ]) await expect(script, "?");
  // A postfix `++` divides, and a regular expression after a condition's `)` is one.
  await expect('let i = 0; i++ / 2; await tools.exec_command({cmd: "claude -p hi"}); let y = 1 / 2;', "FAIL");
  await expect('if (true) /x/.test("y");\nawait tools.exec_command({cmd: "claude -p hi"});', "FAIL");
  for (const script of [
    'let i = 0; i++;\nconst half = i / 2;\nawait tools.exec_command({cmd: "ls"});',
    'const r = await tools.exec_command({cmd: "ls"});\nconst n = (r.output.length) / 2;\ntext(String(n));',
    'const r = await tools.exec_command({cmd: "ls"});\nif (r) { text("a"); }\ntext("x".replace(/a/g, "b"));',
  ]) await expect(script, "pass");
});

// @anchor codexRolloutUnclassified
test("a rollout's tool call this reader does not classify is a question, and so is a command only the transcript shows", async (t) => {
  // A Codex build that changes its tool surface must not drop the witness 6b-R1-3 added: an
  // unclassified tool-call entry answers `?`, as does a command the `--json` transcript
  // shows that the rollout does not (6b-R2-6).
  const log = codexLog("/bin/bash -lc 'ls'");
  let n = 0;
  const judged = async (steps: RolloutStep[], body = log) => {
    const sessionId = `01a0f44a-eb7a-7603-ae3a-${String(768 + n++).padStart(12, "0")}`;
    return run(await project(t, { codex: { body, sessionId, rollout: rolloutOf(sessionId, [{ cmd: "ls", exit: 0 }, ...steps]) } }));
  };
  const writeStdin = await judged([{ entry: { type: "function_call", name: "write_stdin", call_id: "c1", arguments: JSON.stringify({ session_id: 1, chars: "claude -p hi\n" }) } }]);
  assert.equal(verdict(writeStdin.out, scan), "FAIL", writeStdin.out);
  for (const entry of [
    { type: "custom_tool_call", name: "shell", call_id: "c2", input: "claude -p hi" },
    { type: "function_call", name: "brand_new_tool", call_id: "c3", arguments: "{}" },
    { type: "brand_new_call", call_id: "c4" },
  ]) {
    const { out } = await judged([{ entry }]);
    assert.equal(verdict(out, scan), "?", `${JSON.stringify(entry)}\n${out}`);
    assert.match(row(out, scan), /a tool call this reader does not classify/, out);
  }
  for (const entry of [
    { type: "custom_tool_call", name: "apply_patch", call_id: "c5", input: "*** Begin Patch\n*** End Patch\n" },
    { type: "function_call", name: "update_plan", call_id: "c6", arguments: JSON.stringify({ plan: [] }) },
  ]) {
    const { out } = await judged([{ entry }]);
    assert.equal(verdict(out, scan), "pass", `${JSON.stringify(entry)}\n${out}`);
  }
  // The transcript ran `wc -l README.md`; the rollout shows `ls` alone.
  const missing = await judged([], codexLog("/bin/bash -lc 'wc -l README.md'"));
  assert.equal(verdict(missing.out, scan), "?", missing.out);
  assert.match(row(missing.out, scan), /the transcript ran a command its rollout does not show/, missing.out);
});

// The lead's own record under engine placement. An engine-placed lead is a specialist
// record too — the ledger holds it at depth 1 — but its server holds the lead row, so its
// `delegate` calls are the row's own and not offences; below the effective cap only.
const leadAndChild = (leadBody: string, childBody = claudeLog("python3 -m unittest discover -s tests -t .")) => ({
  lead: { engine: "claude", id: "lead1", role: "lead", depth: 1, body: leadBody },
  implementer: { engine: "claude", id: "impl1", role: "implementer", depth: 2, parentTaskId: "lead1", body: childBody },
});
const depth = "every record at depth <=";

// @anchor engineLeadRow
test("an engine-placed lead's own delegate calls are its row's, below the effective cap", async (t) => {
  // (i) dev-team-engine, the cap the mode needs: the lead's call is not an offence, and the
  // row says whose record was judged by the lead row.
  const exempt = await project(t, leadAndChild(claudeDelegate), { mode: "dev-team-engine", limits: { maxDepth: 2 } });
  const passed = await run(exempt);
  assert.equal(verdict(passed.out, scan), "pass", passed.out);
  assert.match(row(passed.out, scan), /lead1/);
  assert.equal(verdict(passed.out, depth), "pass", passed.out);
  assert.equal(passed.code, 0, passed.out);

  // (ii) The same log on the implementer the lead delegated to: a specialist's delegate.
  const child = await project(t, leadAndChild(claudeLog("true"), claudeDelegate), { mode: "dev-team-engine", limits: { maxDepth: 2 } });
  assert.equal(verdict((await run(child)).out, scan), "FAIL");

  // (iii) The lead row carries no engine launch: a lead that also runs `claude -p` offends.
  const launching = await project(t, leadAndChild(claudeDelegate + claudeLog("claude -p hi")), { mode: "dev-team-engine", limits: { maxDepth: 2 } });
  const launched = await run(launching);
  assert.equal(verdict(launched.out, scan), "FAIL", launched.out);
  assert.match(row(launched.out, scan), /lead1 ran claude -p hi/);

  // (vi) Codex's item on the lead's own record, at depth 1 under cap 2.
  const codexLead = await project(t, { lead: { engine: "codex", id: "lead1", role: "lead", depth: 1, body: codexMcpCall("delegate") } },
    { mode: "dev-team-engine", limits: { maxDepth: 2 } });
  assert.equal(verdict((await run(codexLead)).out, scan), "pass");
});

// E3's lead, trimmed from its archived transcript (`docs/probes.md#e3`): one `wait` call,
// the three heartbeats Claude Code 2.1.286 wrote while it was in flight, verbatim, and the
// call's result.
const waitCall = "toolu_01LaxmRKeHQXzXSExFzkSdw1";
const heartbeat = (beat: number, patch: Record<string, unknown> = {}, drop: string[] = []) => {
  const event: Record<string, unknown> = {
    type: "tool_progress", tool_use_id: `${waitCall}-heartbeat-${beat}`, tool_name: "mcp__cross-agent__wait",
    parent_tool_use_id: waitCall, elapsed_time_seconds: 30 * (beat + 1), heartbeat: true,
    session_id: "a2646510-2e81-48dc-8de7-03337657f559",
    uuid: ["60f8d5c2-d5de-4464-aac8-acfba41cafa9", "d19e1ead-f65c-4e96-bd7b-5626080023dc", "fcdc0331-857f-4b15-a9fe-1a657ac73701"][beat],
    ...patch,
  };
  for (const key of drop) delete event[key];
  return JSON.stringify(event);
};
const waitedLead = (beats: string[]) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: "a2646510-2e81-48dc-8de7-03337657f559" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: waitCall, name: "mcp__cross-agent__wait", input: { task_id: "e564c7d923b8b3c8575feaef43b9e672c9a5", timeout_seconds: 600 } }] } }),
  ...beats,
  JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: waitCall, type: "tool_result", content: [{ type: "text", text: '{"ok": true, "status": "done"}' }] }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
].join("\n") + "\n";

// @anchor claudeHeartbeat
test("Claude Code's heartbeat for a call in flight is no call, in the shape E3 recorded and in no other", async (t) => {
  const engine = { mode: "dev-team-engine", limits: { maxDepth: 2 } };
  const recorded = await project(t, leadAndChild(waitedLead([heartbeat(0), heartbeat(1), heartbeat(2)])), engine);
  const passed = await run(recorded);
  assert.equal(verdict(passed.out, scan), "pass", passed.out);
  assert.equal(passed.code, 0, passed.out);

  // Every other shape of the event is one this build has not seen, and still a question.
  for (const [why, beat] of [
    ["not a heartbeat", heartbeat(0, { heartbeat: false })],
    ["no heartbeat field", heartbeat(0, {}, ["heartbeat"])],
    ["a field the recorded shape lacks", heartbeat(0, { input: { command: "claude -p hi" } })],
    ["a recorded field missing", heartbeat(0, {}, ["uuid"])],
    ["a parent no call of this transcript has", heartbeat(0, { parent_tool_use_id: "toolu_elsewhere", tool_use_id: "toolu_elsewhere-heartbeat-0" })],
    ["a tool its parent call is not", heartbeat(0, { tool_name: "mcp__cross-agent__delegate" })],
    ["an id that is not its parent's heartbeat", heartbeat(0, { tool_use_id: `${waitCall}-progress-0` })],
    ["an elapsed time that is not a number", heartbeat(0, { elapsed_time_seconds: "30" })],
  ] as const) {
    const root = await project(t, leadAndChild(waitedLead([beat])), engine);
    const { code, out } = await run(root);
    assert.equal(verdict(out, scan), "?", `${why}: ${out}`);
    assert.match(row(out, scan), /lead1: event this build cannot read \(tool_progress\)/, why);
    assert.equal(code, 2, why);
  }
});

// @anchor effectiveCap
test("the effective cap is the lower of the mode's placement and the configured limit, which defaults to 1", async (t) => {
  // (iv) The config lowered the cap to 1: a lead at depth 1 is at the cap, which holds it
  // to the specialist row (design section 5), so its delegate is an offence.
  const capped = await project(t, { lead: { engine: "claude", id: "lead1", role: "lead", depth: 1, body: claudeDelegate } },
    { mode: "dev-team-engine", limits: { maxDepth: 1 } });
  const cappedRun = await run(capped);
  assert.equal(verdict(cappedRun.out, scan), "FAIL", cappedRun.out);
  assert.match(row(cappedRun.out, depth), /min\(.*2.*1\)|placement 2.*maxDepth 1/);

  // (v) A limit above the mode's cap raises nothing: the cap stays 2, so a record at
  // depth 3 fails the depth row, and a lead at depth 1 is still exempt.
  const raised = await project(t, {
    lead: { engine: "claude", id: "lead1", role: "lead", depth: 1, body: claudeDelegate },
    deep: { engine: "claude", id: "deep1", role: "implementer", depth: 3, parentTaskId: "lead1", body: claudeLog("true") },
  }, { mode: "dev-team-engine", limits: { maxDepth: 5 } });
  const raisedRun = await run(raised);
  assert.equal(verdict(raisedRun.out, depth), "FAIL", raisedRun.out);
  assert.match(row(raisedRun.out, depth), /<= 2/);
  assert.match(row(raisedRun.out, depth), /deep1=3|deep1/);
  assert.equal(verdict(raisedRun.out, scan), "pass", raisedRun.out);

  // (vii) No `limits` at all, and (viii) `limits` without `maxDepth`: the loader's own
  // default of 1 applies, never the placement's 2, so the lead is capped and a record at
  // depth 2 is too deep.
  for (const limits of [null, { stallMinutes: 15 }]) {
    const defaulted = await project(t, leadAndChild(claudeDelegate), { mode: "dev-team-engine", limits });
    const out = (await run(defaulted)).out;
    assert.equal(verdict(out, scan), "FAIL", `${JSON.stringify(limits)}\n${out}`);
    assert.equal(verdict(out, depth), "FAIL", `${JSON.stringify(limits)}\n${out}`);
    assert.match(row(out, depth), /<= 1/);
  }
});

// @anchor unshippedMode
test("a host-placed mode, or one this repository does not ship, exempts no lead", async (t) => {
  // An absent mode is the loader's default, `dev-team`, whose lead is the host: a record
  // named `lead` is nobody's lead row.
  const hosted = await project(t, { lead: { engine: "claude", id: "lead1", role: "lead", depth: 1, body: claudeDelegate } }, { mode: null });
  assert.equal(verdict((await run(hosted)).out, scan), "FAIL");

  // A mode the repository does not ship cannot be read, so the depth row takes the config's
  // limit as it stands and says so, and no record is exempt.
  const unknown = await project(t, { lead: { engine: "claude", id: "lead1", role: "lead", depth: 1, body: claudeDelegate } },
    { mode: "my-team", limits: { maxDepth: 3 } });
  const unknownRun = await run(unknown);
  assert.equal(verdict(unknownRun.out, scan), "FAIL", unknownRun.out);
  assert.match(row(unknownRun.out, depth), /<= 3/);
  assert.match(row(unknownRun.out, depth), /my-team/);

  // For such a mode `--lead-role` supplies what the verifier cannot read: an engine-placed
  // lead of that role, under the cap an engine placement gives, min(2, limits.maxDepth).
  const named = await runWith(unknown, ["--lead-role", "lead"]);
  assert.equal(verdict(named.out, scan), "pass", named.out);
  assert.match(row(named.out, depth), /<= 2/);
  // And that limit defaults to 1 as the loader's does, which holds a depth-1 lead at the cap.
  const unlimited = await project(t, { lead: { engine: "claude", id: "lead1", role: "lead", depth: 1, body: claudeDelegate } },
    { mode: "my-team", limits: null });
  const unlimitedRun = await runWith(unlimited, ["--lead-role", "lead"]);
  assert.equal(verdict(unlimitedRun.out, scan), "FAIL", unlimitedRun.out);
  assert.match(row(unlimitedRun.out, depth), /<= 1/);
});

// @anchor leadRoleNamesOnly
test("--lead-role renames a shipped mode's lead and never changes its placement or cap", async (t) => {
  // `dev-team` places its lead in the host. The flag cannot make a depth-1 implementer a
  // lead: the server gives that implementer the specialist row, so its `delegate` offends,
  // and the cap stays the host placement's 1 (6b-R1-2).
  const hosted = await project(t, {
    implementer: { engine: "claude", id: "impl1", role: "implementer", depth: 1, body: claudeDelegate },
  }, { mode: "dev-team", limits: { maxDepth: 2 } });
  const flagged = await runWith(hosted, ["--lead-role", "implementer"]);
  assert.equal(verdict(flagged.out, scan), "FAIL", flagged.out);
  assert.match(row(flagged.out, depth), /<= 1/);
  assert.doesNotMatch(row(flagged.out, scan), /judged by the lead row/);

  // Under an engine-placed mode it names the role the lead row belongs to, and only that.
  const renamed = await project(t, {
    boss: { engine: "claude", id: "boss1", role: "boss", depth: 1, body: claudeDelegate },
    lead: { engine: "claude", id: "lead1", role: "lead", depth: 1, body: claudeDelegate },
  }, { mode: "dev-team-engine", limits: { maxDepth: 2 } });
  const bossRun = await runWith(renamed, ["--lead-role", "boss"]);
  assert.equal(verdict(bossRun.out, scan), "FAIL", bossRun.out);
  assert.match(row(bossRun.out, scan), /lead1 called mcp__cross-agent__delegate/);
  assert.doesNotMatch(row(bossRun.out, scan), /boss1 called/);
  assert.match(row(bossRun.out, depth), /<= 2/);
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
    // A separator with no space after it, a command substitution and a backtick each open
    // a command, and each closes one as well.
    { claude: claudeLog("claude;true") },
    { claude: claudeLog("echo $(claude)") },
    { claude: claudeLog("echo `claude`") },
    // `node`'s own options before the path, the ones that take a separate operand among them.
    { claude: claudeLog("node --experimental-strip-types src/cli.ts") },
    { claude: claudeLog("node --import x.mjs ./src/server.ts") },
    { claude: claudeLog("node -r ./hook.cjs src/cli.ts") },
    { claude: claudeLog("node --require ./hook.cjs --import=y.mjs src/server.ts") },
    // A word that runs the next one: an exec wrapper, a leading assignment, a reserved word.
    { claude: claudeLog("sudo claude -p hi") },
    { claude: claudeLog("env FOO=1 claude") },
    { claude: claudeLog("FOO=1 claude -p hi") },
    { claude: claudeLog("timeout 60 codex exec -") },
    { claude: claudeLog("setsid --fork claude -p hi") },
    { claude: claudeLog("sudo node src/server.ts") },
    { claude: claudeLog("for x in 1; do claude -p hi; done") },
    // A quoted command for a shell of the specialist's own, beside Codex's own envelope.
    { claude: claudeLog('sh -c "grok -p hi"') },
    // A wrapper's own options, with the operands some of them take (6b-R1-1).
    { claude: claudeLog("sudo -u root claude -p hi") },
    { claude: claudeLog("env -u FOO claude") },
    { claude: claudeLog("nice -n 10 claude") },
    { claude: claudeLog("timeout -s KILL 60 claude") },
    { claude: claudeLog("timeout -k 5 60 claude") },
    { claude: claudeLog("stdbuf -o L claude") },
    { claude: claudeLog("exec -a x claude") },
    { claude: claudeLog('env FOO="hello world" claude -p hi') },
    // A shell or `eval` given the command as words, however the shell's options are spelled,
    // and one shell's `-c` inside another's — Codex's own envelope around an inner shell.
    { claude: claudeLog("bash --login -c 'claude -p hi'") },
    { claude: claudeLog("eval claude -p hi") },
    { claude: claudeLog("sh -c claude") },
    { claude: claudeLog("bash -c claude") },
    { claude: claudeLog('sh -c "bash -c claude"') },
    { codex: codexLog("/bin/bash -lc 'bash -c claude'") },
    // A command another program runs for it: `find`'s `-exec`, `xargs`, a remote shell.
    { claude: claudeLog("find . -exec claude -p hi \\;") },
    { claude: claudeLog("printf 'hi\\n' | xargs -I{} claude -p {}") },
    { claude: claudeLog("ssh localhost 'claude -p hi'") },
    // `node` loading this server as a module, before any script.
    { claude: claudeLog("node --import src/server.ts other.js") },
    // A heredoc or here-string is a script to the shell that reads it.
    { claude: claudeLog("bash << 'EOF'\nclaude -p hi\nEOF") },
    { claude: claudeLog('bash <<< "claude -p hi"') },
  ]) {
    const root = await project(t, logs);
    const { code, out } = await run(root);
    const said = Object.values(logs)[0].split("\n")[1];
    assert.equal(verdict(out, scan), "FAIL", `${said}\n${out}`);
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
    "grep node src/cli.ts",
    "cat node src/cli.ts",
    // An engine's name, or this project's configured binary, as an argument is a word too,
    // quoted or not: quoted text is a command line only where a shell would run it as one —
    // a shell's `-c` payload, `eval`'s arguments, `ssh`'s remote command.
    "echo claude",
    "ls /opt/wrapper",
    'grep -rn "claude" README.md',
    "echo do claude",
    // `node` running something else, whatever options it was given first.
    "node --import x.mjs other.js",
    // A shell, `eval` or an engine's name as an argument is a word being printed (6b-R1-1).
    'echo eval "claude"',
    'echo sh -c "grok"',
    "echo /bin/bash -lc 'claude'",
    // `command -v` and `-V` describe a command without running it.
    "command -v claude",
    "command -V codex",
    "if command -v grok >/dev/null; then echo found; fi",
    // A parenthesis inside a quoted pattern is part of the pattern.
    'grep -rnE "(claude|codex|grok)" src/',
    "rg '(claude)' docs",
    // Options of `node`'s own that take an operand hold that operand, not a script.
    "node --title src/server.ts other.js",
    "node --env-file src/server.ts",
    "node -C src/server.ts other.js",
    // A heredoc handed to anything but a shell is data, and so is a comment.
    "cat > notes.md << 'EOF'\nclaude -p hi\nEOF",
    "cat <<- EOF\n\tclaude -p hi\n\tEOF",
    "# claude -p hi",
  ]) {
    const root = await project(t, { claude: claudeLog(command) });
    const { code, out } = await run(root);
    assert.equal(verdict(out, scan), "pass", `${command}\n${out}`);
    assert.equal(code, 0, out);
  }
});

// @anchor dataProgramOptions
test("a data command's option that runs a program is judged as that program, joined, split, permuted or wrapped", async (t) => {
  // Task 12's review found `wget --use-askpass=claude …` answering pass. Each form below was
  // run on this machine first (wget 1.21.4, GNU sort, ripgrep 14.1.1): wget runs the askpass
  // program it is handed, the `use_askpass` wgetrc command `-e` executes names one, GNU sort
  // resolves an abbreviation of `--compress-program`, and rg runs `--hostname-bin`.
  await judgedAs(t, [
    ["wget --use-askpass=claude https://example.com", "FAIL"],
    ["wget --use-askpass claude https://example.com", "FAIL"],
    ["wget -q --use-askpass=/usr/local/bin/claude https://example.com", "FAIL"],
    ["wget https://example.com --use-askpass=claude", "FAIL"],
    ["wget -e use_askpass=claude https://example.com", "FAIL"],
    ["wget -euse_askpass=claude https://example.com", "FAIL"],
    ["wget -qe useaskpass=claude https://example.com", "FAIL"],
    ["wget -e 'USE-ASKPASS = claude' https://example.com", "FAIL"],
    ["wget --execute=use_askpass=claude https://example.com", "FAIL"],
    ["wget --execute use_askpass=claude https://example.com", "FAIL"],
    ["sudo -u nobody wget --use-askpass=claude https://example.com", "FAIL"],
    ["bash -lc 'wget --use-askpass=claude https://example.com'", "FAIL"],
    ["sort --compress=claude data.txt", "FAIL"],
    ["sort --comp claude data.txt", "FAIL"],
    ["rg --hostname-bin=claude --hyperlink-format=default x", "FAIL"],
    ["rg --hostname-bin claude --hyperlink-format=default x", "FAIL"],
    // What this reader does not resolve, on a line that names an engine: an abbreviated
    // option, a program the environment names, a wgetrc file it would have to read, an
    // option wget's table does not hold, an abbreviation sort itself would refuse.
    ["wget --use-ask=claude https://example.com", "?"],
    ["WGET_ASKPASS=claude wget --use-askpass= https://example.com", "?"],
    ["wget --config=/tmp/rc https://example.com/claude", "?"],
    ["wget --mystery-flag https://example.com/claude", "?"],
    ["sort --c=claude data.txt", "?"],
    // An engine's name wget only fetches or writes is data, and so is a program naming none.
    ["wget -O claude.html https://docs.example.com/claude", "pass"],
    ["wget -e robots=off https://example.com/claude", "pass"],
    ["wget -e use_askpass=/usr/lib/ssh/x11-ssh-askpass https://example.com", "pass"],
    ["sort --compress-program=gzip data.txt", "pass"],
  ]);
});

test("a data command's program option in an argv a Codex rollout recorded is judged the same way", async (t) => {
  const sessionId = "01a0f44a-eb7a-7603-ae3a-02f2d355c7aa";
  const log = codexLog("/bin/bash -lc 'printf inside > ./PROBE-wget.txt'");
  const item = (command: string[]) => ({ event: { type: "item_completed", thread_id: sessionId, item: {
    type: "CommandExecution", id: "exec-wget", command, status: "completed", exit_code: 0 } } });
  const launched = await project(t, { codex: { body: log, sessionId, rollout: rolloutOf(sessionId, [
    { cmd: "printf inside > ./PROBE-wget.txt", exit: 0 },
    item(["wget", "--use-askpass", "claude", "https://example.com"]),
  ]) } });
  const answer = await run(launched);
  assert.equal(verdict(answer.out, scan), "FAIL", answer.out);
  assert.equal(answer.code, 1);
});

// @anchor inlineCodeUnjudged
test("an engine named inside an interpreter's inline code is answered with a question mark", async (t) => {
  // A launch written as another language's code cannot be read by a shell's rules, and a
  // mention of the name in that code cannot be told from a launch: neither pass nor FAIL.
  for (const command of [
    `python3 -c "print('claude')"`,
    `python3 -c 'import subprocess; subprocess.run(["claude", "-p", "hi"])'`,
    `node -e "require('child_process').execSync('codex exec -')"`,
    `perl -e 'system("grok -p hi")'`,
    `ruby -e 'system("claude")'`,
    // A program an interpreter reads from a heredoc is inline code too.
    `python3 << 'PY'\nimport subprocess\nsubprocess.run(["claude", "-p", "hi"])\nPY`,
  ]) {
    const root = await project(t, { claude: claudeLog(command) });
    const { code, out } = await run(root);
    assert.equal(verdict(out, scan), "?", `${command}\n${out}`);
    assert.match(row(out, scan), /inline code/, out);
    assert.equal(code, 2, out);
  }
  // The same interpreters with nothing of an engine in their code are read as what they are.
  const quiet = await project(t, { claude: claudeLog(`python3 -c "print(1 + 1)"`) });
  assert.equal(verdict((await run(quiet)).out, scan), "pass");
});

/**
 * The scan's answer for each command, one fixture project per command and four verifiers at
 * a time: the verdict word, the scan's whole line and the exit status.
 */
async function scanEach(t: TestContext, commands: readonly string[]): Promise<Array<{ verdict: string; line: string; code: number }>> {
  const answers: Array<{ verdict: string; line: string; code: number }> = [];
  let next = 0;
  const worker = async () => {
    while (next < commands.length) {
      const k = next++;
      const { code, out } = await run(await project(t, { claude: claudeLog(commands[k]) }));
      answers[k] = { verdict: verdict(out, scan), line: row(out, scan), code };
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return answers;
}

/** Each command judged as `expected` says: "FAIL" for a launch, "pass", or "?". */
async function judgedAs(t: TestContext, rows: ReadonlyArray<readonly [string, "FAIL" | "pass" | "?"]>) {
  const answers = await scanEach(t, rows.map(([command]) => command));
  rows.forEach(([command, expected], k) => {
    assert.equal(answers[k].verdict, expected, `${command}\n${answers[k].line}`);
    assert.equal(answers[k].code, { FAIL: 1, pass: 0, "?": 2 }[expected], `${command}\n${answers[k].line}`);
  });
}

// @anchor nestedSubstitutions
test("a substitution nested in an expansion or a heredoc is judged, and a shell's stdin is its script", async (t) => {
  // Bash runs a `$(…)` or backtick wherever it stands — inside `${…}` and `$((…))`, inside
  // double quotes, in an unquoted heredoc's body — and a shell reads its stdin as a script,
  // from a heredoc, a here-string or a pipe; `$'…'` is a quote bash decodes (6b-R2-1).
  await judgedAs(t, [
    ["echo ${unset:-$(claude -p hi)}", "FAIL"],
    ['echo "${unset:-$(claude -p hi)}"', "FAIL"],
    ["echo ${var:-`claude`}", "FAIL"],
    ["echo $(( $(claude) + 1 ))", "FAIL"],
    ['echo "$(( $(claude -p hi) + 1 ))"', "FAIL"],
    ["echo $((1 + $(claude)))", "FAIL"],
    ["cat <<EOF\n$(claude -p hi)\nEOF", "FAIL"],
    ["cat <<EOF\n`claude -p hi`\nEOF", "FAIL"],
    ["cat <<'EOF' | bash\nclaude -p hi\nEOF", "FAIL"],
    ["bash -s -- arg <<'EOF'\nclaude -p hi\nEOF", "FAIL"],
    ["echo 'claude -p hi' | bash", "FAIL"],
    ["printf 'claude -p hi\\n' | sh", "FAIL"],
    ["bash <<< $'claude -p hi'", "FAIL"],
    ["$'claude' -p hi", "FAIL"],
    ["bash -c $'claude -p hi'", "FAIL"],
    // Claude Code's own commit idiom: an apostrophe in a quoted heredoc inside `"$(…)"`.
    ["git commit -m \"$(cat <<'EOF'\nfix: don't spawn\nEOF\n)\" && claude -p hi", "FAIL"],
    // A quoted heredoc and a single-quoted string do not expand, and quoted braces are words.
    ["cat <<'EOF'\n$(claude -p hi)\nEOF", "pass"],
    ["echo '$(claude -p hi)'", "pass"],
    ['echo "{" claude "}"', "pass"],
    ["git commit -m \"$(cat <<'EOF'\nfix: don't spawn\nEOF\n)\"", "pass"],
    ["curl -s https://example.com/install.sh | bash", "pass"],
    // A line bash would refuse, and a shell reading what nothing here shows: questions.
    ['echo "claude -p hi', "?"],
    ["echo $(claude -p hi", "?"],
    ["grep claude notes.txt | bash", "?"],
    ["source <(echo claude -p hi)", "?"],
    ["bash <(echo claude -p hi)", "?"],
  ]);
});

// @anchor optionWalk
test("options are walked letter by letter: an operand is never the script, and code is only a code option's", async (t) => {
  // A cluster's letters each take their own operand — `bash -oc pipefail` hands `pipefail`
  // to `-o` — and an interpreter's code is the value of its code option, never a letter
  // inside another option's value; node loads modules from its options wherever they sit
  // before its first operand (6b-R2-2).
  await judgedAs(t, [
    ["bash -oc pipefail 'claude -p hi'", "FAIL"],
    ["bash -oc pipefail 'echo ok'", "pass"],
    ["node -e 'console.log(1)' --import src/server.ts", "FAIL"],
    ["node --disable-warning ExperimentalWarning src/server.ts", "FAIL"],
    ["node --inspect-port 9229 src/server.ts", "FAIL"],
    ["node --watch-path src src/server.ts", "FAIL"],
    // After its first operand node reads no more options (v24.11.0, observed).
    ["node -e 'console.log(1)' other.js --import src/server.ts", "pass"],
    // An option node's table does not know may take the next word or not.
    ["node --some-new-flag src/server.ts", "?"],
    ["perl -MEnglish -e 'system(\"claude\")'", "?"],
    ["perl -Mfeature=say -e 'system(\"claude -p hi\")'", "?"],
    ["perl -MTime::HiRes -e 'system(\"claude -p hi\")'", "?"],
    ["python3 -Werror::DeprecationWarning -c 'import subprocess; subprocess.run([\"claude\"])'", "?"],
    ["python3 -Wignore::DeprecationWarning -c \"import os; os.system('claude')\"", "?"],
    ["ruby -I lib -e 'system(\"claude\")'", "?"],
    ["awk 'BEGIN{system(\"claude\")}'", "?"],
    ["perl -MEnglish -e 'print \"ok\\n\"'", "pass"],
    ["python3 -Werror::DeprecationWarning -c 'print(1)'", "pass"],
    ["ruby -I lib -e 'puts 1'", "pass"],
  ]);
});

// @anchor commandWordsModeled
test("a command word the grammar does not model, or one an expansion supplies, is a question beside an engine's name", async (t) => {
  // `pass` needs the grammar to have understood the whole line. ssh's command-carrying
  // options and busybox's applets are modeled; any other command word, and one an expansion
  // or a glob supplies, is `?` on a line that names an engine, and nothing on one that names
  // none (6b-R2-3).
  await judgedAs(t, [
    ["ssh -o ProxyCommand=claude example.com", "FAIL"],
    ["ssh -o 'ProxyCommand claude -p hi' example.com", "FAIL"],
    ["ssh -oProxyCommand=claude example.com", "FAIL"],
    ["ssh -o LocalCommand=claude -o PermitLocalCommand=yes example.com", "FAIL"],
    ["busybox sh -c 'claude -p hi'", "FAIL"],
    ["NODE_OPTIONS='--import src/server.ts' node other.js", "FAIL"],
    ["NODE_OPTIONS=\"--require ./src/cli.ts\" npm test", "FAIL"],
    ["$HOME/.local/bin/claude -p hi", "FAIL"],
    ["{claude,echo} -p hi", "FAIL"],
    ["su -c 'claude -p hi'", "?"],
    ["script -qc 'claude -p hi' /dev/null", "?"],
    ["flock /tmp/x claude -p hi", "?"],
    ["ionice -c3 claude -p hi", "?"],
    ["taskset -c 0 claude -p hi", "?"],
    ["chrt -f 1 claude", "?"],
    ["watch claude -p hi", "?"],
    ["strace -f claude -p hi", "?"],
    ["unshare -r claude", "?"],
    ["systemd-run --user claude", "?"],
    ["tmux new -d claude", "?"],
    ["npx cross-agent init", "?"],
    ["parallel claude ::: a b", "?"],
    ["coproc claude -p hi", "?"],
    ["\"$(command -v claude)\" -p hi", "?"],
    ["$(which claude) -p hi", "?"],
    ["${E:-claude} -p hi", "?"],
    ["for e in claude codex; do $e --version; done", "?"],
    ["CMD=claude; $CMD -p hi", "?"],
    ["npm test", "pass"],
    ["make test", "pass"],
    ["ssh -G example.com", "pass"],
    // A directory is a word too: `cross-agent` in a path names the CLI as much as anywhere.
    ["git diff -U5 HEAD -- docs/design.md skills/cross-agent/SKILL.md", "?"],
    ["sed 's/x/claude/e' notes.md", "?"],
  ]);
});

// @anchor functionDefinitions
test("a function definition is no launch: its body is judged, and one named like an engine is a question", async (t) => {
  // `claude() { …; }` defines a function and runs nothing, and after it the name means the
  // function; the body runs when it is called (6b-R2-4).
  await judgedAs(t, [
    ["claude() { echo hi; }", "?"],
    ["claude () { echo hi; }", "?"],
    ["function claude { echo hi; }", "?"],
    ["function claude() { echo hi; }", "?"],
    ["claude() { echo hi; }; claude", "?"],
    ["run() { claude -p hi; }", "FAIL"],
    ["function run { claude -p hi; }", "FAIL"],
    ["run() { echo hi; }; run", "pass"],
  ]);
});


// @anchor wholeLineNames
const wholeLineNames = [
  ["make -f - <<'EOF'\nall:\n\tclaude -p hi\nEOF", "?"],
  ["at now <<'EOF'\nclaude -p hi\nEOF", "?"],
  ["parallel <<'EOF'\nclaude -p hi\nEOF", "?"],
  ["su - wsh <<'EOF'\nclaude -p hi\nEOF", "?"],
  ["docker exec -i box sh <<'EOF'\nclaude -p hi\nEOF", "?"],
  ["bash < <(echo claude -p hi)", "?"],
  ["sh < <(printf 'claude -p hi\\n')", "?"],
  ["ssh host < <(echo claude -p hi)", "?"],
  ["{ bash; } <<'EOF'\nclaude -p hi\nEOF", "?"],
  ["(bash) <<'EOF'\nclaude -p hi\nEOF", "?"],
  ["make test > /opt/wrapper", "?"],
  ["make test < src/server.ts", "?"],
  ["make test <<< './src/cli.ts'", "?"],
  ["FILE=./src/server.ts make test", "?"],
  ["make test > $'cl\\x61ude'", "?"],
  ["make test # claude", "?"],
  ["make <<< \"$(echo cl''aude)\"", "?"],
  ["make <<< \"$(printf $'cl\\x61ude')\"", "?"],
] as const;
test("6b-E-1: names anywhere in the line gate unmodeled constructs", async (t) => {
  await judgedAs(t, wholeLineNames);
});

// @anchor unreadStdin
const unreadStdin = [
  ["echo 'claude -p hi' | sudo -s", "?"],
  ["echo 'claude -p hi' | sudo -i", "?"],
  ["sudo -s <<< 'claude -p hi'", "?"],
  ["sudo -i <<< 'claude -p hi'", "?"],
  ["sudo -s <<'EOF'\nclaude -p hi\nEOF", "?"],
  ["sudo -i <<'EOF'\nclaude -p hi\nEOF", "?"],
  ["echo claude -p hi | xargs bash -c", "?"],
  ["echo claude -p hi | xargs env", "?"],
  ["echo claude -p hi | xargs sudo", "?"],
  ["echo claude -p hi | xargs nohup", "?"],
  ["echo claude -p hi | xargs timeout 60", "?"],
  ["ssh host bash -s <<'EOF'\nclaude -p hi\nEOF", "?"],
  ["ssh host 'bash -s' <<< 'claude -p hi'", "?"],
  ["echo 'claude -p hi' | ssh host sh", "?"],
  ["cat - <<'EOF'\nclaude -p hi\nEOF | bash", "?"],
  ["cat -u <<'EOF'\nclaude -p hi\nEOF | bash", "?"],
  ["command cat <<'EOF'\nclaude -p hi\nEOF | bash", "?"],
  ["cat - <<'EOF' | bash\nclaude -p hi\nEOF", "?"],
  ["cat -u <<'EOF' | bash\nclaude -p hi\nEOF", "?"],
  ["command cat <<'EOF' | bash\nclaude -p hi\nEOF", "?"],
  ["bash /dev/stdin <<< 'claude -p hi'", "?"],
  ["source /dev/stdin <<< 'claude -p hi'", "?"],
  ["sudo -s < claude", "?"],
  ["xargs env < claude", "?"],
  ["ssh host bash -s < claude", "?"],
  ["bash /dev/stdin <<< 'echo claude'", "?"],
  ["echo claude | xargs echo", "?"],
  // A modeled data reader consumes its input; a shell's known script is decided.
  ["cat <<'EOF'\nclaude -p hi\nEOF", "pass"],
  ["echo 'claude -p hi' | wc -l", "pass"],
  ["echo 'claude -p hi' | bash", "FAIL"],
  ["env -S cat <<'EOF'\nclaude -p hi\nEOF", "pass"],
] as const;
test("6b-E-2: unread stdin cannot silently pass at a code reader or wrapper", async (t) => {
  await judgedAs(t, unreadStdin);
});

// @anchor expandedOperands
const expandedOperands = [
  ['OPT=--import; node "$OPT" ./src/server.ts', "?"],
  ['OPT=--import; node "$OPT" ./src/server.ts --title claude', "?"],
  [`CODE='import os; os.system("claude -p hi")'; python3 -c "$CODE"`, "?"],
  [`CODE='claude -p hi'; bash -c "$CODE"`, "?"],
  ['MOD=./src/server.ts; node --import "$MOD" other.js', "?"],
  ['OPT=-c; bash "$OPT" "claude -p hi"', "?"],
  ['OPT=-e; perl "$OPT" "claude"', "?"],
  ['DIR=claude; ruby -I "$DIR" -e "puts 1"', "?"],
  ['CMD=claude; env "$CMD" -p hi', "?"],
  ['OPT=-exec; find . "$OPT" claude \\;', "?"],
  ['CODE=claude; eval "echo $CODE"', "?"],
  ['echo "${unset:-\'$(claude -p hi)\'}"', "FAIL"],
  ['echo "${unset:-\'`claude -p hi`\'}"', "FAIL"],
  ["echo ${unset:-'$(claude -p hi)'}", "pass"],
  ['echo "$OPT" claude', "pass"],
] as const;
test("6b-E-3: required literal operands reject expansions and parameter quotes retain substitutions", async (t) => {
  await judgedAs(t, expandedOperands);
});

// @anchor codeAssignments
const codeAssignments = [
  ["NODE_OPTIONS+='--import src/server.ts' node other.js", "FAIL"],
  ["env NODE_OPTIONS+='--import src/server.ts' node other.js", "FAIL"],
  ["export NODE_OPTIONS='--import ./src/server.ts'; node other.js", "FAIL"],
  ["declare -x NODE_OPTIONS='--import ./src/server.ts'; node other.js", "FAIL"],
  [`env -S 'NODE_OPTIONS="--import ./src/server.ts" node' other.js`, "FAIL"],
  [`env -S 'NODE_OPTIONS+="--import ./src/server.ts" node' other.js`, "FAIL"],
  ["readonly NODE_OPTIONS='--require ./src/cli.ts'", "FAIL"],
  ["typeset -x NODE_OPTIONS+='--loader ./src/server.ts'", "FAIL"],
  ['MOD=./src/server.ts; NODE_OPTIONS="--import $MOD" node other.js', "?"],
  ["NODE_OPTIONS='--import ./src/server.ts'", "FAIL"],
  ["BASH_ENV=<(echo 'claude -p hi') bash -c :", "?"],
  ["PROMPT_COMMAND='claude -p hi' bash -i", "FAIL"],
  ["export PROMPT_COMMAND='claude -p hi'; bash -i", "FAIL"],
  ["env PROMPT_COMMAND='claude -p hi' bash -i", "FAIL"],
  [`env -S 'PROMPT_COMMAND="claude -p hi" bash' -i`, "FAIL"],
  ["BASH_ENV='$(claude -p hi)' bash -c :", "FAIL"],
  ["ENV='$(claude -p hi)' sh -i", "FAIL"],
  ["BASH_ENV='claude -p hi' bash -c :", "?"],
  ["ENV='claude -p hi' sh -i", "?"],
  ["PS4='$(claude -p hi)' bash -x script.sh", "FAIL"],
  ["PS4='claude -p hi' bash -x script.sh", "pass"],
  ["env BASH_ENV=./claude claude -p hi", "FAIL"],
  ['CODE=claude; PROMPT_COMMAND="$CODE" bash -i', "?"],
  ["BASH_ENV=./claude bash -c :", "?"],
  ["PROMPT_COMMAND='echo claude' bash -i", "pass"],
  ["ENGINE=claude; echo $ENGINE", "pass"],
] as const;
test("6b-E-4: assignment entry points share loader and shell-code judgment", async (t) => {
  await judgedAs(t, codeAssignments);
});

// @anchor deferredArithmetic
const deferredArithmetic = [
  ["let 'x[$(claude -p hi)]=1'", "?"],
  ["test -v 'x[$(claude -p hi)]'", "?"],
  ["[ -v 'x[$(claude -p hi)]' ]", "?"],
  ["printf -v 'x[$(claude -p hi)]' '%s' value", "?"],
  ["read 'x[$(claude -p hi)]'", "?"],
  ["declare 'x[$(claude -p hi)]=1'", "?"],
  ["x='a[$(claude -p hi)]'; echo $(( x ))", "?"],
  ["x='a[$(claude -p hi)]'; (( x ))", "?"],
  ["x='a[$(claude -p hi)]'; [[ $x -eq 0 ]]", "?"],
  ["read 'x[`claude -p hi`]'", "?"],
  ["x='a[$(claude -p hi)]'; test -v \"$x\"", "?"],
  ["echo 'x[$(claude -p hi)]'", "pass"],
  ["let 'x=1'", "pass"],
  ["echo $(( $(claude -p hi) + 1 ))", "FAIL"],
] as const;
test("6b-E-5: arithmetic and subscript readers cannot call quoted substitutions data", async (t) => {
  await judgedAs(t, deferredArithmetic);
});

// @anchor optionTerminators
const optionTerminators = [
  ["rg -- '--pre=claude' README.md", "pass"],
  ["node -e 'console.log(process.argv)' -- src/server.ts", "pass"],
  ["sort -- '--compress-program=claude'", "pass"],
  ["node -- src/server.ts", "FAIL"],
  ["rg --pre=claude README.md", "FAIL"],
] as const;
test("option terminators leave search patterns and inline-code arguments as data", async (t) => {
  await judgedAs(t, optionTerminators);
});

// @anchor scriptNameAccounting
const scriptNameAccounting = [
  ['const o={of:4}; o.of / await tools.exec_command({cmd:"claude -p hi"}) / 2;', "?"],
  [String.raw`const o={of:4}; o.of / await tools.exec_command({cmd:"\u0063laude -p hi"}) / 2;`, "?"],
  ['const o={of:4}; o.of / await tools.mcp__cross_agent__delegate({role:"consult"}) / 2;', "?"],
  ['const o={of:4}; o.of / await tools.write_stdin({chars:"ls"}) / 2;', "?"],
  ['let i=0;\ni\n++ /tools.exec_command({cmd:"claude -p hi"})/.lastIndex;', "?"],
  ['const re=/exec_command/; await tools.exec_command({cmd:"ls"});', "?"],
  [String.raw`text("tools.\u0065xec_command"); await tools.exec_command({cmd:"ls"});`, "?"],
  ['text("delegate");', "?"],
  ['// write_stdin\nawait tools.exec_command({cmd:"ls"});', "?"],
  ['await tools["exec_command"]({cmd:"ls"});', "pass"],
  [String.raw`await tools.\u0065xec_command({cmd:"ls"});`, "pass"],
  ['await tools.exec_command({cmd:"claude -p hi"});', "FAIL"],
] as const;
test("6b-E-6: every tool-name occurrence is accounted for despite lexical ambiguity", async (t) => {
  for (const [script, expected] of scriptNameAccounting) {
    const sessionId = "01a0f44a-eb7a-7603-ae3a-000000006601";
    const { code, out } = await run(await project(t, { codex: {
      body: codexLog("/bin/bash -lc 'ls'"), sessionId,
      rollout: rolloutOf(sessionId, [{ cmd: "ls", exit: 0 }, { script }]),
    } }));
    assert.equal(verdict(out, scan), expected, `${script}\n${out}`);
    assert.equal(code, { FAIL: 1, pass: 0, "?": 2 }[expected], out);
  }
});

// @anchor rolloutItemShapes
const rolloutItemShapes = [
  { event: { type: "item_completed", item: { type: "NewToolCall", name: "exec_command", arguments: { cmd: "claude -p hi" } } } },
  { event: { type: "exec_command_begin", command: "claude -p hi" } },
  { event: { type: "item_completed", item: { type: "CommandExecution", command: "claude -p hi" } } },
  { event: { type: "item_completed", item: { type: "CommandExecution", command: ["echo", { cmd: "claude" }] } } },
  { event: { type: "item_completed", item: { type: "NewItem", command: ["claude", "-p", "hi"] } } },
  { event: { type: "item_completed", item: { type: "NewItem", arguments: {} } } },
  { entry: { type: "new_item", name: "exec_command", arguments: { cmd: "claude -p hi" } } },
  { entry: { type: "custom_tool_call", name: "exec", input: { cmd: "claude -p hi" } } },
] as const;
test("6b-E-6: unknown tool-bearing rollout items and changed field shapes are questions", async (t) => {
  for (const step of rolloutItemShapes) {
    const sessionId = "01a0f44a-eb7a-7603-ae3a-000000006602";
    const { code, out } = await run(await project(t, { codex: {
      body: codexLog("/bin/bash -lc 'ls'"), sessionId,
      rollout: rolloutOf(sessionId, [{ cmd: "ls", exit: 0 }, step]),
    } }));
    assert.equal(verdict(out, scan), "?", `${JSON.stringify(step)}\n${out}`);
    assert.equal(code, 2, out);
  }
});

// @anchor groupStdin
const groupStdin = [
  ["echo 'claude -p hi' | { bash; }", "FAIL"],
  ["echo 'claude -p hi' | { bash -s; }", "FAIL"],
  ["echo 'claude -p hi' | { sudo -s; }", "?"],
  ["echo 'claude -p hi' | { xargs bash; }", "?"],
  ["printf '%s\\n' 'claude -p hi' | { bash; }", "?"],
  // Every command in the group shares the pipe, not only its first; a later one reads what
  // the commands before it left, which this grammar cannot know exactly.
  ["echo 'claude -p hi' | { true; bash; }", "?"],
  ["echo 'claude -p hi' | (true; bash)", "?"],
  ["echo 'claude -p hi' | { cat; }", "pass"],
  ["{ echo a; echo b; } | wc -l", "pass"],
] as const;
test("6b-W-1: a pipe into a `{ … }` or `( … )` group is the stdin of every command in it", async (t) => {
  await judgedAs(t, groupStdin);
});

// @anchor interpreterStdin
const interpreterStdin = [
  ["python3 /dev/stdin <<'EOF'\nimport os; os.system('claude -p hi')\nEOF", "?"],
  ["python3 - <<'EOF'\nimport os; os.system('claude -p hi')\nEOF", "?"],
  ["python3 -c 'exec(input())' <<< '__import__(\"os\").system(\"claude -p hi\")'", "?"],
  ["node -e 'eval(require(\"fs\").readFileSync(0, \"utf8\"))' <<< 'require(\"child_process\").execSync(\"claude -p hi\")'", "?"],
  ["node /dev/stdin <<< 'require(\"child_process\").execSync(\"claude -p hi\")'", "?"],
  ["perl -e 'eval join \"\", <STDIN>' <<< 'system(\"claude -p hi\")'", "?"],
  // A script file's code is unknown, so stdin naming an engine is not data either.
  ["python3 script.py <<'EOF'\nclaude -p hi\nEOF", "?"],
  ["python3 -c 'print(1)' <<< 'hello'", "pass"],
  ["echo '{\"a\": 1}' | python3 -m json.tool", "pass"],
  ["python3 script.py < data.txt", "pass"],
] as const;
test("6b-W-2: stdin is not data to an interpreter whose script is stdin, or whose code is inline or unknown", async (t) => {
  await judgedAs(t, interpreterStdin);
});

// @anchor parameterAnsiC
const parameterAnsiC = [
  ["eval ${x:-$'cl\\x61ude -p hi'}", "?"],
  ["eval \"${x:-$'cl\\x61ude -p hi'}\"", "?"],
  ["bash -c ${x:-$'cl\\x61ude -p hi'}", "?"],
  ["echo ${x:-$'hello'}", "pass"],
] as const;
test("6b-W-3: `$'…'` inside `${…}` is decoded before the line's names are read", async (t) => {
  await judgedAs(t, parameterAnsiC);
});

// @anchor reservedArithmetic
const reservedArithmetic = [
  ["x='a[$(claude -p hi)]'; if [[ $x -eq 0 ]]; then :; fi", "?"],
  ["x='a[$(claude -p hi)]'; while [[ $x -eq 0 ]]; do :; done", "?"],
  ["x='a[$(claude -p hi)]'; ! [[ $x -eq 0 ]]", "?"],
  ["x='a[`claude -p hi`]'; if [[ $x -eq 0 ]]; then :; fi", "?"],
  ["x='a[$(claude -p hi)]'; if (( x )); then :; fi", "?"],
  ["PROMPT_COMMAND=\"x='a[\\$(claude -p hi)]'; if [[ \\$x -eq 0 ]]; then :; fi\" bash -i", "?"],
  ["env PROMPT_COMMAND=\"x='a[\\$(claude -p hi)]'; if [[ \\$x -eq 0 ]]; then :; fi\" bash -i", "?"],
  ["if [[ $n -eq 0 ]]; then echo zero; fi", "pass"],
  ["if (( n > 0 )); then echo more; fi", "pass"],
] as const;
test("6b-W-4: arithmetic after `if`, `while` or `!` is arithmetic, on a line and in PROMPT_COMMAND", async (t) => {
  await judgedAs(t, reservedArithmetic);
});

// @anchor memberNames
const memberNames = [
  ['const o={while:()=>4}; o.while() / await tools["exec_command"]({cmd:"claude -p hi"}) / 2;', "FAIL"],
  [String.raw`const o={while:()=>4};` + "\n" + String.raw`o.while() / await tools["exec_command"]({cmd:"claude -p hi"}) / 2;`, "FAIL"],
  ['const o={if:()=>4}; o.if() / 2; await tools.exec_command({cmd:"ls"});', "pass"],
  // A name a regular expression's escapes spell is still counted against the calls followed.
  [String.raw`const re=/exec_command/; await tools.exec_command({cmd:"ls"});`, "?"],
] as const;
test("6b-W-5: a word after `.` or `?.` is a property name, and a name only a misread could hide is still counted", async (t) => {
  for (const [script, expected] of memberNames) {
    const sessionId = "01a0f44a-eb7a-7603-ae3a-000000006605";
    const { code, out } = await run(await project(t, { codex: {
      body: codexLog("/bin/bash -lc 'ls'"), sessionId,
      rollout: rolloutOf(sessionId, [{ cmd: "ls", exit: 0 }, { script }]),
    } }));
    assert.equal(verdict(out, scan), expected, `${script}\n${out}`);
    assert.equal(code, { FAIL: 1, pass: 0, "?": 2 }[expected], out);
  }
});

// @anchor rolloutOutputs
const rolloutOutputs = [
  [{ event: { type: "exec_command_output", call_id: "c1", command: ["claude", "-p", "hi"] } }, "FAIL"],
  [{ entry: { type: "custom_tool_call_output", call_id: "c2", item: { command: ["claude", "-p", "hi"] } } }, "FAIL"],
  [{ event: { type: "item_completed", item: { type: "NewItem", toolName: "exec_command", args: { cmd: "ls" } } } }, "?"],
  [{ event: { type: "item_completed", item: { type: "NewItem", data: { name: "exec_command" } } } }, "?"],
  [{ entry: { type: "new_thing", toolName: "write_stdin" } }, "?"],
  // Codex's own output shapes carry no command, and a FileChange item runs nothing.
  [{ entry: { type: "custom_tool_call_output", call_id: "c3", name: "exec", output: "Running pnpm lint" } }, "pass"],
  [{ event: { type: "item_completed", item: { type: "FileChange", changes: {} } } }, "pass"],
] as const;
test("6b-W-6: an output carrying a command is judged like the call, and a tool-bearing field makes an unclassified item a question", async (t) => {
  for (const [step, expected] of rolloutOutputs) {
    const sessionId = "01a0f44a-eb7a-7603-ae3a-000000006606";
    const { code, out } = await run(await project(t, { codex: {
      body: codexLog("/bin/bash -lc 'ls'"), sessionId,
      rollout: rolloutOf(sessionId, [{ cmd: "ls", exit: 0 }, step as RolloutStep]),
    } }));
    assert.equal(verdict(out, scan), expected, `${JSON.stringify(step)}\n${out}`);
    assert.equal(code, { FAIL: 1, pass: 0, "?": 2 }[expected], out);
  }
});

// @anchor codexCodeModeWait
// The two recorded payloads, verbatim: E2c's lead rollout, line 86, and S11's B2, line 32
// (`docs/probes.md#s11CodexLeadTimeout`), which carries no `max_tokens`. Every archived
// code-mode `wait` has exactly these payload keys and this passthrough.
const e2cWait = {
  type: "function_call", id: "fc_01972f92cc52d25e016abe0abc8b4487d281b41bdc999d7303", name: "wait",
  arguments: "{\"cell_id\":\"11\",\"yield_time_ms\":30000,\"max_tokens\":1000}", call_id: "call_JAvEhP3zi4gqfzMoe4qd67kR",
  internal_chat_message_metadata_passthrough: { turn_id: "01a0f658-ae9d-78c0-9325-899bfcb9a5f6", create_time: 1790839480.816802 },
};
const b2Wait = {
  type: "function_call", id: "fc_053969cea5577e64016abddd68352487d2a9975b2c72a823f9", name: "wait",
  arguments: "{\"cell_id\":\"3\",\"yield_time_ms\":600000}", call_id: "call_kdEVlzpG4pMgR2PDTZlZUtts",
  internal_chat_message_metadata_passthrough: { turn_id: "01a0f5a8-5641-72e1-a374-0142d06114fa", create_time: 1790827879.263279 },
};
const codexCodeModeWait = [
  [e2cWait, "pass"],
  [b2Wait, "pass"],
  // Any other shape is a call this reader has not seen, whatever its name: other arguments,
  [{ ...e2cWait, arguments: JSON.stringify({ cell_id: "11", yield_time_ms: 30000, max_tokens: 1000, cmd: "claude -p hi" }) }, "?"],
  [{ ...e2cWait, arguments: JSON.stringify({ cell_id: 11, yield_time_ms: 30000 }) }, "?"],
  [{ ...e2cWait, arguments: JSON.stringify({ cell_id: "11", yield_time_ms: "30000" }) }, "?"],
  [{ ...e2cWait, arguments: JSON.stringify({ cell_id: "11", yield_time_ms: 30000, max_tokens: "1000" }) }, "?"],
  [{ ...e2cWait, arguments: JSON.stringify({ cell_id: "11" }) }, "?"],
  [{ ...e2cWait, arguments: "{\"cell_id\":\"11\"," }, "?"],
  [{ ...e2cWait, arguments: { cell_id: "11", yield_time_ms: 30000 } }, "?"],
  // a field beside them on the payload, a field inside its passthrough, a passthrough of
  // another shape, and a payload missing a key the recorded ones carry.
  [{ ...e2cWait, command: "claude -p hidden" }, "?"],
  [{ ...e2cWait, internal_chat_message_metadata_passthrough: { ...e2cWait.internal_chat_message_metadata_passthrough, command: "claude -p hidden" } }, "?"],
  [{ ...e2cWait, internal_chat_message_metadata_passthrough: { turn_id: "01a0f658-ae9d-78c0-9325-899bfcb9a5f6", create_time: "1790839480" } }, "?"],
  [{ type: "function_call", name: "wait", arguments: "{\"cell_id\":\"11\",\"yield_time_ms\":30000,\"max_tokens\":1000}", call_id: "call_x" }, "?"],
] as const;
test("atc-s96.61: Codex's top-level wait on a yielded code-mode cell runs no command, in exactly its recorded shapes", async (t) => {
  // codex-cli 0.159.3 waits on a code-mode cell that yielded with a `wait` function of its own,
  // which names a cell and no command; E2, E2b and E2c each answered `?` on it until a person
  // read it. Learned in the two shapes recorded, and in no other.
  for (const [entry, expected] of codexCodeModeWait) {
    const sessionId = "01a0f44a-eb7a-7603-ae3a-000000006607";
    const { code, out } = await run(await project(t, { codex: {
      body: codexLog("/bin/bash -lc 'ls'"), sessionId,
      rollout: rolloutOf(sessionId, [{ cmd: "ls", exit: 0 }, { entry }]),
    } }));
    assert.equal(verdict(out, scan), expected, `${JSON.stringify(entry)}\n${out}`);
    assert.equal(code, { pass: 0, "?": 2 }[expected], out);
    if (expected === "?") assert.match(row(out, scan), /a tool call this reader does not classify \(function_call wait\)/, out);
  }
});

/**
 * `--read-rollout <session id>` over a Codex home holding `rollout` (none for `null`): the JSON
 * document it printed, its status and its stderr. It runs in a directory that is no
 * repository, so a mode that read a project would exit 2 before printing anything.
 */
async function readRolloutOf(t: TestContext, sessionId: string, rollout: string | null, extra: string[] = []) {
  const home = await mkdtemp(path.join(tmpdir(), "read-rollout-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "sessions", "2026", "09", "30", `rollout-2026-09-30T17-49-05-${sessionId}.jsonl`);
  if (rollout !== null) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, rollout);
  }
  try {
    const { stdout, stderr } = await exec(process.execPath, [verify, "--read-rollout", sessionId, ...extra], {
      encoding: "utf8", cwd: home, env: { ...process.env, CODEX_HOME: home },
    });
    return { code: 0, report: JSON.parse(stdout), err: stderr, home, file };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, report: null, err: failure.stderr ?? "", home, file };
  }
}

// @anchor readRollout
test("--read-rollout reports each call the reader decoded, an exec paired with its one output by call_id, and judges nothing", async (t) => {
  // The decoded `cmd` of each direct `exec_command` call, escapes and all, and the exit code
  // and text of that call's own `custom_tool_call_output`.
  const escaped = 'echo "resumed"\necho done >> notes.md';
  const sessionId = "01a0f44a-eb7a-7603-ae3a-000000007001";
  const paired = await readRolloutOf(t, sessionId, rolloutOf(sessionId, [
    { cmd: escaped, exit: 0 },
    { cmd: "echo root >> ../../ROOT-WRITE.txt", exit: 1, output: "/bin/bash: line 1: ../../ROOT-WRITE.txt: Read-only file system\n" },
  ]));
  assert.equal(paired.code, 0, paired.err);
  assert.ok(rolloutOf(sessionId, [{ cmd: escaped, exit: 0 }]).includes(String.raw`\"resumed\"\n`), "the script's source holds the escapes");
  assert.deepEqual(paired.report, {
    files: [paired.file],
    calls: [
      { file: paired.file, line: 2, call_id: "call_0", kind: "exec", commands: [escaped], computed: [], direct: false,
        output: { exit_code: 0, text: "" } },
      { file: paired.file, line: 5, call_id: "call_1", kind: "exec", commands: ["echo root >> ../../ROOT-WRITE.txt"], computed: [], direct: false,
        output: { exit_code: 1, text: "/bin/bash: line 1: ../../ROOT-WRITE.txt: Read-only file system\n" } },
    ],
    unreadable: [],
  });

  // A command named only in a comment or a string is no command; the mention is a computed reason.
  for (const [script, why] of [
    ['// tools.exec_command({cmd: "claude -p hi"})\nconst r = await tools.exec_command({cmd: "ls"});\ntext(JSON.stringify(r));', /exec_command: 2 occurrences but only 1 direct calls followed/],
    ["const note = 'tools.exec_command({cmd: \"rm -rf build\"})';\nconst r = await tools.exec_command({cmd: \"ls\"});\ntext(JSON.stringify(r));", /a string holding a command tool's name/],
  ] as const) {
    const id = "01a0f44a-eb7a-7603-ae3a-000000007002";
    const { code, report, err } = await readRolloutOf(t, id, rolloutOf(id, [{ script }]));
    assert.equal(code, 0, err);
    assert.deepEqual(report.calls[0].commands, ["ls"], script);
    assert.ok(report.calls[0].computed.some((reason: string) => why.test(reason)), `${script}\n${JSON.stringify(report.calls[0].computed)}`);
  }

  // An exec with two outputs, one with none and one whose output holds no exit code: no output
  // is paired, and the reason says which.
  const call = (callId: string) => ({ entry: { type: "custom_tool_call", call_id: callId, name: "exec",
    input: 'const r = await tools.exec_command({cmd: "ls"});\ntext(JSON.stringify(r));' } });
  const output = (callId: string, text: string) => ({ entry: { type: "custom_tool_call_output", call_id: callId,
    output: [{ type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { type: "input_text", text }] } });
  const unpaired = "01a0f44a-eb7a-7603-ae3a-000000007003";
  const doubled = await readRolloutOf(t, unpaired, rolloutOf(unpaired, [
    call("call_d"), output("call_d", JSON.stringify({ exit_code: 0, output: "" })), output("call_d", JSON.stringify({ exit_code: 1, output: "denied" })),
    call("call_n"),
    call("call_t"), output("call_t", "exit 0"),
  ]));
  assert.equal(doubled.code, 0, doubled.err);
  const byId = new Map(doubled.report.calls.map((entry: { call_id: string }) => [entry.call_id, entry]));
  for (const [callId, why] of [["call_d", /2 outputs/], ["call_n", /no output/], ["call_t", /no exit code/]] as const) {
    const entry = byId.get(callId) as { output: unknown; reason: string };
    assert.equal(entry.output, null, callId);
    assert.match(entry.reason, why, callId);
  }

  // A function call is listed with its arguments decoded, or null where they do not decode;
  // a script that does not lex is named under `unreadable`, as the verdicts name it.
  const listed = "01a0f44a-eb7a-7603-ae3a-000000007004";
  const listing = await readRolloutOf(t, listed, rolloutOf(listed, [
    { entry: { type: "function_call", name: "wait", arguments: "{\"cell_id\":\"11\",\"yield_time_ms\":30000,\"max_tokens\":1000}", call_id: "call_w" } },
    { entry: { type: "function_call", name: "brand_new_tool", arguments: "{not json", call_id: "call_b" } },
    { script: 'await tools.exec_command({cmd: "ls});' },
  ]));
  assert.equal(listing.code, 0, listing.err);
  assert.deepEqual(listing.report.calls.slice(0, 2), [
    { file: listing.file, line: 2, call_id: "call_w", kind: "function_call", name: "wait", arguments: { cell_id: "11", yield_time_ms: 30000, max_tokens: 1000 } },
    { file: listing.file, line: 3, call_id: "call_b", kind: "function_call", name: "brand_new_tool", arguments: null },
  ]);
  assert.deepEqual(listing.report.calls[2].commands, []);
  assert.equal(listing.report.calls[2].error, "an unterminated string");
  assert.ok(listing.report.unreadable.includes("an exec script that does not read as JavaScript (an unterminated string)"), JSON.stringify(listing.report.unreadable));
  assert.ok(listing.report.unreadable.includes("a tool call this reader does not classify (function_call brand_new_tool)"), JSON.stringify(listing.report.unreadable));

  // A report larger than a pipe's 64 KiB buffer arrives whole: the mode exits only once it is written.
  const long = "01a0f44a-eb7a-7603-ae3a-000000007006";
  const steps = Array.from({ length: 400 }, (_, n) => ({ cmd: `echo step-${n} >> notes.md`, exit: 0 }));
  const whole = await readRolloutOf(t, long, rolloutOf(long, steps));
  assert.equal(whole.code, 0, whole.err);
  assert.equal(whole.report.calls.length, 400);
  assert.ok(JSON.stringify(whole.report, null, 2).length > 65_536, "the report is larger than a pipe's buffer");

  // No rollout is said, not shrugged at; the mode takes a session id and nothing else.
  const absent = await readRolloutOf(t, "01a0f44a-eb7a-7603-ae3a-000000007005", null);
  assert.equal(absent.code, 0, absent.err);
  assert.deepEqual(absent.report.files, []);
  assert.deepEqual(absent.report.calls, []);
  assert.match(absent.report.unreadable[0], /^no Codex session rollout for 01a0f44a-eb7a-7603-ae3a-000000007005 under /);
  const withProject = await readRolloutOf(t, sessionId, null, ["--project", "."]);
  assert.equal(withProject.code, 2);
  assert.match(withProject.err, /--read-rollout reads no project and takes no other flag \(--project\)/);
  const bare = await readRolloutOf(t, "", null);
  assert.equal(bare.code, 2);
  assert.match(bare.err, /--read-rollout takes a Codex session id/);
});

// @anchor readRolloutDirect
// The one script shape whose printed exit is its command's own: one awaited `exec_command`
// with a literal `cmd` and nothing else in its argument, its result printed through exactly
// `{exit_code, output}` read off that result, and no other statement. `codexI2Real`'s run 2
// wrote it (rollout lines 24-43, `<archive>/b6/codexI2Real/run2/`); the cell's output is
// whatever its script prints, so any other script's printed exit proves nothing.
const directScript = (cmd: string) => `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)}});\ntext(JSON.stringify({exit_code:r.exit_code, output:r.output}));\n`;
const notDirect = [
  // A function that would run the write, never called, and an exit printed by hand.
  'const skipped = () => tools.exec_command({cmd: "echo root >> /project/ROOT-WRITE.txt"});\ntext(JSON.stringify({exit_code: 1, output: "Read-only file system"}));\n',
  // The command run, and a different exit printed.
  'const r = await tools.exec_command({cmd: "echo root >> /project/ROOT-WRITE.txt"});\ntext(JSON.stringify({exit_code: 1, output: "Read-only file system"}));\n',
  // One statement more than the shape.
  'const r = await tools.exec_command({cmd: "echo root >> /project/ROOT-WRITE.txt"});\nconst n = 1;\ntext(JSON.stringify({exit_code:r.exit_code, output:r.output}));\n',
  // A command the script computes.
  'const c = "echo root >> /project/ROOT-WRITE.txt";\nconst r = await tools.exec_command({cmd: c});\ntext(JSON.stringify({exit_code:r.exit_code, output:r.output}));\n',
  // A6's own form: an option beside `cmd`, and the result printed whole.
  'const r = await tools.exec_command({cmd:"echo root >> /project/ROOT-WRITE.txt", max_output_tokens:1000});\ntext(JSON.stringify(r));\n',
  // Two commands in one script.
  'const r = await tools.exec_command({cmd:"ls"});\nconst s = await tools.exec_command({cmd:"pwd"});\ntext(JSON.stringify({exit_code:r.exit_code, output:r.output}));\n',
  // The shape, and a statement after the print: the script does not end where the shape does.
  'const r = await tools.exec_command({cmd:"ls"});\ntext(JSON.stringify({exit_code:r.exit_code, output:r.output}));\nglobalThis.JSON = {stringify: () => \'{"exit_code": 1, "output": "Read-only file system"}\'};\n',
  // The print reading a binding other than the awaited one.
  'const r = await tools.exec_command({cmd:"ls"});\ntext(JSON.stringify({exit_code:s.exit_code, output:r.output}));\n',
];
test("--read-rollout marks direct only an exec whose script prints its one literal command's own result, unaltered", async (t) => {
  const id = "01a0f44a-eb7a-7603-ae3a-000000007101";
  const steps = [{ script: directScript('echo resumed >> "/project/.worktrees/i2/notes.md"') }, { script: "// @exec: {\"yield_time_ms\": 10000}\n" + directScript("ls") },
    ...notDirect.map((script) => ({ script }))];
  const { code, report, err } = await readRolloutOf(t, id, rolloutOf(id, steps));
  assert.equal(code, 0, err);
  const execs = report.calls.filter((call: { kind: string }) => call.kind === "exec");
  assert.equal(execs.length, steps.length);
  assert.deepEqual(execs.map((call: { direct: boolean }) => call.direct), [true, true, ...notDirect.map(() => false)],
    JSON.stringify(execs.map((call: { line: number; direct: boolean }) => [call.line, call.direct])));
  assert.deepEqual(execs[0].commands, ['echo resumed >> "/project/.worktrees/i2/notes.md"']);
  assert.deepEqual(execs[0].computed, []);
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
