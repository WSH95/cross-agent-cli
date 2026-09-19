import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtInModesDir, CONSULT_ROLE, describeMode, findRole, loadMode } from "../src/modes.ts";
import { projectTools } from "../src/server.ts";

// The text every host loads and the loop every mode serves. `skills/cross-agent/SKILL.md`
// is the launcher — the one skill a host discovers, identical on all three — and
// `modes/<name>/SKILL.md` is that mode's loop, served by `describe_mode` rather than
// copied into a host's skill directory (design section 7). Nothing here reads the prose
// for style; what it checks is what a machine can: the name a host matches, the tools a
// step actually calls, the statuses a watcher has to act on, and the order of the steps
// that touch git.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherDir = path.join(repoRoot, "skills", "cross-agent");
const launcherFile = path.join(launcherDir, "SKILL.md");

type Tool = ReturnType<typeof projectTools>[number];

/** The launcher's own text, without its frontmatter. */
function launcher(): string {
  return fs.readFileSync(launcherFile, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** One line: what a document says, rather than where its paragraphs wrapped. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The mode's loop as `describe_mode` serves it. */
function loop(name: string): string {
  const described = describeMode(builtInModesDir(), name);
  assert.ok(!("reason" in described), JSON.stringify(described));
  return described.loop;
}

/** Every tool this project's server registers under `name`, by its own name. */
function registry(name: string): Map<string, Tool> {
  const tools = projectTools(repoRoot, { mode: loadMode(builtInModesDir(), name) });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

/** Every key any of those tools takes on the wire: `task_id`, `slug`, `timeout_seconds`. */
function parameters(tools: Map<string, Tool>): Set<string> {
  const keys = new Set<string>();
  for (const tool of tools.values()) {
    for (const key of Object.keys((tool.inputSchema as { properties?: object }).properties ?? {})) keys.add(key);
  }
  return keys;
}

// A backticked span is a call when it starts with an identifier: `list_tasks`,
// `run_command {which: "test", …}`, `git_root merge --ff-only <branch>`. Only the names
// carrying an underscore are judged — every prose word in a backtick would otherwise be a
// tool — which is seven of the twelve registered names and any name a typo invents in
// their shape. The other five (`delegate`, `wait`, `check`, `result`, `cancel`) are bare
// words, and the test below names them one by one instead.
const CALL_SHAPED = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function namesCalled(text: string): string[] {
  const names = new Set<string>();
  for (const [, span] of text.matchAll(/`([^`]+)`/g)) {
    const lead = /^[a-z][a-z0-9_]*/.exec(span.trim());
    if (lead !== null && CALL_SHAPED.test(lead[0])) names.add(lead[0]);
  }
  return [...names];
}

// Keys of a host's own manifest, which this server never sees. Codex's per-server MCP
// tool timeout is one of the two numbers the launcher's budget table is made of.
const hostManifestKeys = new Set(["tool_timeout_sec"]);
// The mailbox an engine-placed lead needs, which step 11 of the work plan builds. Nothing
// registers these yet, so the launcher may name them only where it says so.
const notYetBuilt = new Set(["list_asks"]);
const placeholder = /S11 extends/;

/**
 * Every call-shaped name in `text` names a tool the mode registers for `row`, a key one of
 * those tools takes, or a host's own manifest key — unless the paragraph that names it is
 * the one marked as what step 11 extends.
 */
function assertToolsExist(text: string, mode: string, row: "operator" | "lead", where: string): void {
  const tools = registry(mode);
  const keys = parameters(tools);
  for (const paragraph of text.split(/\n\s*\n/)) {
    const marked = placeholder.test(paragraph);
    for (const name of namesCalled(paragraph)) {
      if (keys.has(name) || hostManifestKeys.has(name)) continue;
      if (marked && notYetBuilt.has(name)) continue;
      const tool = tools.get(name);
      assert.ok(tool !== undefined, `${where} calls ${name}, which ${mode} registers no tool for`);
      assert.ok(tool.rows.includes(row), `${where} calls ${name}, which is not offered to the ${row} row`);
    }
  }
}

/** Each fragment appears after the one before it, so the document states them in order. */
function assertInOrder(text: string, steps: string[], where: string): void {
  let at = 0;
  for (const step of steps) {
    const found = text.indexOf(step, at);
    assert.ok(found >= at, `${where} names ${step} after the step before it`);
    at = found + step.length;
  }
}

test("the launcher's frontmatter names the skill its directory does, and its description names the triggers", () => {
  const source = fs.readFileSync(launcherFile, "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source);
  assert.ok(frontmatter !== null, "a host reads the skill through its frontmatter");
  const fields = new Map(
    frontmatter[1].split("\n").filter((line) => /^\S/.test(line))
      .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()] as [string, string]),
  );
  assert.equal(fields.get("name"), path.basename(launcherDir), "a host matches the skill by the name its directory carries");
  const description = fields.get("description") ?? "";
  for (const trigger of ["team", "delegate", "bead", "codex"]) {
    assert.ok(description.includes(trigger), `the description names the ${trigger} trigger, or a host never loads the skill`);
  }
  assert.equal(fields.has("allowed-tools"), false, "the launcher names no tool list: the server decides what it may call, by row");
});

test("every tool the launcher calls is registered and offered to the operator row, under every mode", () => {
  const text = launcher();
  for (const mode of ["solo", "dev-team", "dev-team-engine"]) {
    assertToolsExist(text, mode, "operator", `the launcher under ${mode}`);
  }
});

test("the launcher calls the tools a host session needs to start, watch, merge and report", () => {
  const called = new Set(namesCalled(launcher()));
  for (const name of ["describe_mode", "list_roles", "list_tasks", "git_mutate", "git_root", "run_command", "verify_worktree"]) {
    assert.ok(called.has(name), `the launcher never calls ${name}`);
  }
  for (const name of ["delegate", "wait", "result", "cancel", "check"]) {
    assert.match(launcher(), new RegExp("`" + name + "\\b"), `the launcher never calls ${name}`);
  }
});

test("the launcher says what to do with every status a delegation answers with", () => {
  const text = flat(launcher());
  for (const status of ["running", "stalled", "unsettled", "done", "failed", "cancelled", "orphaned"]) {
    assert.match(text, new RegExp("`" + status + "`"), `a watcher meets ${status} and the launcher says nothing about it`);
  }
  assert.match(text, /[Nn]ever declare a task done from `check` alone/, "`check` reconciles nothing, so it settles nothing");
});

test("the launcher's budget table gives every host a wait that fits inside its tool timeout", () => {
  const text = flat(launcher());
  assert.match(text, /Claude Code[^|]*\|[^|]*\|[^|]*600/, "Claude Code's row and its wait");
  assert.match(text, /Codex[^|]*\|[^|]*`tool_timeout_sec`[^|]*3600[^|]*\|[^|]*600/, "Codex's row names the manifest key and this repo's value");
  assert.match(text, /Grok[^|]*\|[^|]*\|[^|]*300/, "Grok's row, until T15 settles its timeout");
  assert.match(text, /Time limits/, "the table is the design's own budget, cited");
});

test("the launcher carries the merge policy for every mode, in the order a one-shot settles under", () => {
  const text = flat(launcher());
  // The work is committed before anything merges it: a specialist writes no git metadata,
  // so what it left in the worktree is still uncommitted when its task settles.
  assertInOrder(text, [
    // The launcher is mode-generic, so the second exclusion is the mode's own worktree
    // directory; only `dev-team`'s own loop may spell `.worktrees`.
    'git_mutate {slug, args: ["add", "-A", "--", ".", ":(exclude).cross-agent", ":(exclude)<git.worktreeDir>"]}',
    'git_mutate {slug, args: ["commit"',
    "project.mergePolicy",
    'run_command {which: "test", where: <worktree path>, slug}',
    'git_root {args: ["merge", "--ff-only", <branch>], slug}',
    'run_command {which: "test", where: "root", slug}',
    '"worktree", "remove"',
    '"branch", "-d"',
  ], "the launcher's merge policy");
  assert.match(text, /nobody merges by hand under `auto`/, "the launcher applies the policy, not the user");
  assert.match(text, /\*\*`manual`, or any failure.{0,80}?leave the branch/, "the other half of the policy");
  assert.match(text, /git revert --no-edit/, "and the repair path when the root suite fails after the merge");
  assert.match(text, /`git\.branchPattern` with the slug in place of its `\*`/);
  assert.match(text, /HEAD has to be on `project\.defaultBranch`/);
});

test("the launcher documents review and critique as verbs it composes, each naming its engine", () => {
  const text = flat(launcher());
  assert.match(text, /verbs of (this|the) loop, not tools of the server/);
  // Each verb is one `delegate` of the role every mode carries, spelled with the keys
  // the schema requires: a verb the launcher cannot spell is a verb nobody can call.
  for (const verb of ["review", "critique"]) {
    assert.match(text, new RegExp(`\\*\\*${verb}\\*\\* — \`delegate \\{role: "consult", cwd: <project root>, engine: `));
  }
  assert.match(text, /Attach the diff under review/);
  assert.match(text, /git diff <base>\.\.\.HEAD/);
  assert.match(text, /findings by severity, each with `file:line`/);
  assert.match(text, /Name the plan or design file/);
  assert.match(text, /adversarial/);
  assert.match(text, /each is one `delegate` that names its own engine/);
});

test("the launcher's reconciliation pass reads every source design section 7 names", () => {
  const text = flat(launcher());
  assertInOrder(text, ["list_tasks", "journal", '"worktree", "list"', '"branch", "--list"', '"status", "--porcelain"'], "the launcher's reconciliation pass");
  assert.match(text, /rebase/, "the rebase state is the fifth source");
  for (const rule of [/interrupted rebase/, /merged branch/, /branch-only/, /unmerged branch/, /invalid/]) {
    assert.match(text, rule, `a leftover the pass has a rule for: ${rule}`);
  }
});

test("the launcher names what step 11 extends, and nothing else claims a tool that is not built", () => {
  const paragraphs = launcher().split(/\n\s*\n/);
  const marked = paragraphs.filter((paragraph) => placeholder.test(paragraph));
  assert.equal(marked.length, 1, "one marked paragraph, so a reader knows exactly what is deferred");
  for (const name of ["`list_asks`", "`answer`", "`cross-agent answer`", "`cross-agent report`"]) {
    assert.ok(marked[0].includes(name), `the placeholder names ${name}, which engine placement needs`);
  }
  for (const paragraph of paragraphs) {
    if (placeholder.test(paragraph)) continue;
    assert.doesNotMatch(paragraph, /`list_asks`/, "only the marked paragraph names the mailbox");
  }
});

test("the launcher's guardrails keep the host out of a specialist's work and off the engines", () => {
  const text = flat(launcher());
  for (const rule of [/[Nn]ever do a specialist's work/, /[Nn]ever run an engine CLI yourself/, /verbatim/, /secret/, /git push/, /git stash/, /restart/]) {
    assert.match(text, rule, `a guardrail the launcher drops: ${rule}`);
  }
});

test("the launcher's closing report names every task with what ran it and what it cost", () => {
  const text = flat(launcher());
  assert.match(text, /\.cross-agent\/log\.md/);
  assertInOrder(text, ["role", "engine", "model", "effort", "duration", "outcome"], "the launcher's log line");
  assert.match(text, /not verified/, "the closing report says what nobody checked");
});

test("the dev-team loop runs the ten steps in the order design section 4 gives them", () => {
  const text = flat(loop("dev-team"));
  assertInOrder(text, [
    "list_tasks",
    "delegate {role: \"planner\"",
    "delegate {role: \"plan-reviewer\"",
    'git_root {args: ["worktree", "add", "-b", <branch>, <worktree path>, <default>], slug}',
    "delegate {role: \"implementer\"",
    'git_mutate {slug, args: ["add", "-A", "--", ".", ":(exclude).cross-agent", ":(exclude).worktrees"]}',
    'git_mutate {slug, args: ["commit"',
    "delegate {role: \"code-reviewer\"",
    'git_mutate {slug, args: ["rebase", <default>]}',
    'git_root {args: ["merge", "--ff-only", <branch>], slug}',
    'run_command {which: "test", where: "root", slug}',
    '"worktree", "remove"',
    '"branch", "-d"',
    ".cross-agent/log.md",
  ], "the dev-team loop");
  assert.match(text, /rebase", "--abort/, "a rebase that stops on a conflict is aborted in the worktree, and the user hears about it");
  assert.match(text, /git revert --no-edit/, "the repair path when the suite fails on the default branch after the merge");
  assert.match(text, /resume/, "a needs-work round continues the task that did the work");
});

test("every tool the dev-team loop calls is offered to the row its placement runs the loop in", () => {
  assertToolsExist(loop("dev-team"), "dev-team", "operator", "the dev-team loop");
  assertToolsExist(loop("dev-team-engine"), "dev-team-engine", "lead", "the engine-placed dev-team loop");
  assertToolsExist(loop("solo"), "solo", "operator", "the solo loop");
});

test("the dev-team loop names the journal step each of its git calls completes", () => {
  const text = flat(loop("dev-team"));
  for (const step of ["worktree-created", "committed", "rebased", "merged", "tests-passed", "worktree-removed", "branch-deleted"]) {
    assert.match(text, new RegExp("`" + step + "`"), `the loop never says which call writes ${step}`);
  }
  assert.match(text, /`ok: false`/, "any refusal is a reconciliation trigger, whatever its exit code");
});

test("the solo loop is the short one and hands a one-shot that wrote to the launcher", () => {
  const text = flat(loop("solo"));
  assert.match(text, /worktree: true/);
  assert.match(text, /launcher/, "the merge policy belongs to the launcher now, for every mode");
  assert.doesNotMatch(text, /run_command \{which: "test", where: "root", slug\}/, "one copy of the merge policy, and it is the launcher's");
  assert.doesNotMatch(text, /\*\*critique\*\*/, "and one copy of the verbs");
});

/** Every `delegate {…}` call a document spells, as one line each. */
function delegateCalls(text: string): string[] {
  return [...flat(text).matchAll(/`(delegate \{[^`]*)`/g)].map(([, call]) => call);
}

test("every delegate call the launcher and the loops spell names the keys the schema requires", () => {
  // `role`, `brief` and `cwd` are required on every call, resume included, and a role
  // that works in a worktree is refused without the branch it is on
  // (`src/server.ts#projectTools`, `src/delegate.ts#delegate`). A call spelled without
  // them is a step that cannot run.
  const documents: Array<[string, string]> = [
    ["the launcher", launcher()],
    ...["solo", "dev-team", "dev-team-engine"].map((name) => [`the ${name} loop`, loop(name)] as [string, string]),
  ];
  let checked = 0;
  for (const [where, text] of documents) {
    for (const call of delegateCalls(text)) {
      checked++;
      assert.match(call, /\brole\b/, `${where} spells a delegate call with no role: ${call}`);
      assert.match(call, /\bcwd\b/, `${where} spells a delegate call with no cwd: ${call}`);
      if (/cwd: <worktree path>/.test(call)) {
        assert.match(call, /\bbranch\b/, `${where} spells a worktree delegation with no branch: ${call}`);
      }
    }
  }
  assert.ok(checked >= 6, `only ${checked} delegate calls found; the loops spell more than that`);
});

test("the two dev-team modes carry the same role prompts, byte for byte", () => {
  const modes = builtInModesDir();
  for (const key of ["planner", "plan-reviewer", "implementer", "code-reviewer"]) {
    assert.equal(
      fs.readFileSync(path.join(modes, "dev-team-engine", "roles", `${key}.md`), "utf8"),
      fs.readFileSync(path.join(modes, "dev-team", "roles", `${key}.md`), "utf8"),
      `${key}: the engine-placed team's specialists are the host-placed team's; one edit changes both files or neither`,
    );
  }
});

test("the three built-in modes validate, and each serves the loop file its own directory holds", () => {
  const modes = builtInModesDir();
  for (const name of ["solo", "dev-team", "dev-team-engine"]) {
    const mode = loadMode(modes, name);
    assert.equal(loop(name), fs.readFileSync(path.join(mode.dir, "SKILL.md"), "utf8"), `${name}: describe_mode serves the file, never a copy`);
    const described = describeMode(modes, name);
    assert.ok(!("reason" in described));
    for (const role of described.roles) {
      assert.ok(role.prompt.trim().length > 0, `${name}: the ${role.key} role is served an empty prompt`);
    }
  }
});

test("the mode that declares the consultant says exactly what the built-in role says", () => {
  const modes = builtInModesDir();
  const solo = loadMode(modes, "solo");
  const role = findRole(solo, CONSULT_ROLE);
  assert.equal(role?.promptFile, "roles/consult.md", "solo declares the role, so its own file documents it");
  const declared = fs.readFileSync(path.join(solo.dir, "roles", "consult.md"), "utf8");
  // Two copies of one role's text: the file a mode may override, and the text every mode
  // that overrides nothing is given. They say the same thing or one of them is stale.
  assert.equal(findRole(loadMode(modes, "dev-team"), CONSULT_ROLE)?.prompt, declared);
});

// The role prompts came from the devpack package through `tools/from-openmaus.mjs`, a
// one-off harness beside `tools/probe.mjs` (design section 8). The converter is tested on
// a fixture package rather than on that package, which lives outside this repository: what
// the committed files owe it is the transform below — the devpack's machinery dropped, the
// specialist's own git steps dropped, and this runtime's rule for the role added as the
// coda every one of them ends on.

const converter = path.join(repoRoot, "tools", "from-openmaus.mjs");
const fixturePackage = path.join(repoRoot, "tests", "fixtures", "openmaus-package.json");

function convert(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [converter, ...args], { cwd: repoRoot });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.stderr.on("data", (chunk: string) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end();
  });
}

async function draftsFrom(t: { after: (fn: () => unknown) => void }, extra: string[] = []): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "from-openmaus-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = await convert(["--package", fixturePackage, "--out", dir, ...extra]);
  assert.equal(run.code, 0, `${run.out}${run.err}`);
  return dir;
}

test("the converter refuses a package whose format it does not know", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "from-openmaus-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "other.json");
  fs.writeFileSync(file, JSON.stringify({ format: "other.package", version: 1, package: { agents: [] } }), "utf8");
  const { code, err } = await convert(["--package", file, "--out", path.join(dir, "out")]);
  assert.equal(code, 1);
  assert.match(err, /other\.package/, "the refusal names what it was handed");
});

test("the converter writes one draft per devpack title this runtime has a role for", async (t) => {
  const dir = await draftsFrom(t);
  assert.deepEqual(fs.readdirSync(path.join(dir, "roles")).sort(), ["implementer.md", "planner.md"]);
  assert.equal(fs.existsSync(path.join(dir, "SKILL.md")), true, "the loop draft comes from the worktree-workflow playbook");
  assert.match(fs.readFileSync(path.join(dir, "roles", "planner.md"), "utf8"), /You never edit files or implement\./);
});

test("the converter drops the devpack's own machinery and says what it dropped", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "from-openmaus-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { code, err } = await convert(["--package", fixturePackage, "--out", dir]);
  assert.equal(code, 0, err);
  const planner = fs.readFileSync(path.join(dir, "roles", "planner.md"), "utf8");
  assert.doesNotMatch(planner, /list_bots/, "a sentence naming a devpack tool has no analogue here");
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), /delegate_bot/, "the loop draft is remapped too");
  assert.match(err, /planner: dropped/, "a human has to see what was cut before editing the draft");
  assert.match(err, /Archivist/, "and which titles this runtime has no role for");
});

test("the converter drops the git steps the devpack's specialist ran, which the lead runs here", async (t) => {
  const dir = await draftsFrom(t);
  const implementer = flat(fs.readFileSync(path.join(dir, "roles", "implementer.md"), "utf8"));
  assert.match(implementer, /Follow the plan or report BLOCKED with the reason\./, "what survives is the reporting convention");
  assert.doesNotMatch(implementer, /rebase on the brief's default branch/, "a specialist writes no git metadata here");
  assert.match(implementer, /You run no git command that writes/, "and the coda says so in this runtime's own words");
});

test("the converter writes the lead's prompt only for the mode that has a lead role", async (t) => {
  assert.equal(fs.existsSync(path.join(await draftsFrom(t), "roles", "lead.md")), false);
  const engine = await draftsFrom(t, ["--mode", "dev-team-engine"]);
  assert.match(fs.readFileSync(path.join(engine, "roles", "lead.md"), "utf8"), /You run this mode's loop/);
});

test("the converter never writes over a draft that is already there", async (t) => {
  const dir = await draftsFrom(t);
  const { code, err } = await convert(["--package", fixturePackage, "--out", dir]);
  assert.equal(code, 1);
  assert.match(err, /roles\/planner\.md/, "the refusal names the file it would have replaced");
});

test("every committed dev-team role prompt came through the converter and was edited for this runtime", () => {
  const modes = builtInModesDir();
  const codas = new Map([
    ["planner", "You write no files and you delegate nothing; your final message is the plan."],
    ["plan-reviewer", "You write no files and you delegate nothing; your final message is the review."],
    ["implementer", "You run no git command that writes: the session that delegated you commits what you leave. You delegate nothing; your final message is the report that commit is made from."],
    ["code-reviewer", "You write no files and you delegate nothing; your final message is the review, verdict first."],
  ]);
  for (const [key, coda] of codas) {
    const prompt = fs.readFileSync(path.join(modes, "dev-team", "roles", `${key}.md`), "utf8");
    assert.equal(flat(prompt).trim().endsWith(coda), true, `${key}: the converter's coda is this runtime's own rule for the role`);
    for (const machinery of [/delegate_bot/, /ask_bot/, /post_to_room/, /list_bots/, /create_bot/, /\broom\b/]) {
      assert.doesNotMatch(prompt, machinery, `${key} carries devpack machinery this runtime has no analogue for`);
    }
  }
  const implementer = fs.readFileSync(path.join(modes, "dev-team", "roles", "implementer.md"), "utf8");
  assert.match(implementer, /worktree/, "the one role that writes is told where");
  const lead = fs.readFileSync(path.join(modes, "dev-team-engine", "roles", "lead.md"), "utf8");
  assert.match(lead, /`git_root`/, "the engine-placed lead reaches the root through the tools and not its own hands");
});
