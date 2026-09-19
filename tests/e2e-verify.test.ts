import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  try {
    const { stdout } = await exec(process.execPath, [verify, "--project", project], { encoding: "utf8" });
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

/** Grok reaches an MCP tool through its `use_tool` dispatcher, which names the tool inside. */
const grokLog = (toolName: string) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: "g" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "use_tool", input: { tool_name: toolName, tool_input: {} } }] } }),
].join("\n") + "\n";

/** Codex's own shape: items, not Anthropic content blocks. */
const codexLog = (command: string, mcpTool?: string) => [
  JSON.stringify({ type: "thread.started", thread_id: "t" }),
  JSON.stringify({ type: "item.completed", item: { type: "command_execution", command } }),
  ...(mcpTool === undefined ? [] : [JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", tool: mcpTool } })]),
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
  options: { steps?: unknown; journal?: string } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "e2e-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "sample\n");
  await exec("git", ["-C", root, "init", "-b", "main"]);
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "initial"]);
  await mkdir(path.join(root, ".cross-agent", "tasks"), { recursive: true });
  await mkdir(path.join(root, ".cross-agent", "journal"), { recursive: true });
  await writeFile(path.join(root, ".cross-agent", "config.json"), JSON.stringify({
    mode: "dev-team", project: { defaultBranch: "main", testCommand: "none" }, limits: { maxDepth: 1 },
  }));
  await writeFile(
    path.join(root, ".cross-agent", "journal", "slug.json"),
    options.journal ?? JSON.stringify({ slug: "slug", branch: "task/slug", steps: (options.steps ?? journalSteps.map((step) => ({ step }))) }),
  );
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
    codex: codexLog("npm test", "mcp__cross_agent__check"),
  });
  const { out } = await run(root);
  // The specialist row's own tools are not offences, whatever a host spells them.
  assert.equal(verdict(out, scan), "pass", out);
});

test("a delegate call is an offence in every host's spelling, including Grok's dispatcher", async (t) => {
  for (const logs of [
    { claude: claudeDelegate },
    { grok: grokLog("cross-agent__delegate") },
    { codex: codexLog("true", "mcp__cross_agent__delegate") },
  ]) {
    const root = await project(t, logs);
    const { code, out } = await run(root);
    assert.equal(verdict(out, scan), "FAIL", out);
    assert.equal(code, 1);
  }
});

test("a shell command that starts an engine is an offence in each engine's own log shape", async (t) => {
  for (const logs of [
    { claude: claudeLog("claude -p 'do the work'") },
    { codex: codexLog("grok -p hello") },
  ]) {
    const root = await project(t, logs);
    assert.equal(verdict((await run(root)).out, scan), "FAIL");
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

test("the journal has to hold the loop's steps in order, and an empty one fails", async (t) => {
  const complete = await project(t, { claude: claudeLog("true") });
  assert.equal(verdict((await run(complete)).out, journal), "pass");

  const empty = await project(t, { claude: claudeLog("true") }, { steps: [] });
  assert.equal(verdict((await run(empty)).out, journal), "FAIL");

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
