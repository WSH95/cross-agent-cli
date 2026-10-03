import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostConfigPaths } from "../src/gitmutate.ts";
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
// tool — which is eight of the thirteen registered names and any name a typo invents in
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

// Keys of a host's own configuration, which this server never sees. Codex's and Grok's
// per-server MCP tool timeout is one of the two numbers the launcher's budget table is made of.
const hostManifestKeys = new Set(["tool_timeout_sec"]);

// A host's own tools, which this server never registers: Grok reaches an MCP server's tools
// through `search_tool` and `use_tool`, and the launcher tells a Grok host to search before it
// concludes this server's are missing.
const hostOwnTools = new Set(["search_tool", "use_tool"]);

// The calls a loop's own steps are made of, besides delegating its specialists: under
// engine placement they are the lead's while a lead is live.
const loopSteps = new Set(["git_root", "git_mutate", "run_command", "verify_worktree"]);

/**
 * The units of `text` that order a loop step — a root or worktree git call, a test run, a
 * `delegate` with or without its arguments — without naming `host` placement. A unit is a
 * blank-line block, cut further at every list item, so one bullet that names `host` cannot
 * stand in for its siblings: an engine-placed host reads a bullet on its own.
 */
function unconditionedSteps(text: string): string[] {
  const units: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    let unit: string[] = [];
    for (const line of block.split("\n")) {
      if (/^\s*(?:[-*]|\d+\.)\s/.test(line) && unit.length > 0) {
        units.push(unit.join("\n"));
        unit = [];
      }
      unit.push(line);
    }
    if (unit.length > 0) units.push(unit.join("\n"));
  }
  return units.flatMap((unit) => {
    const steps = namesCalled(unit).filter((name) => loopSteps.has(name));
    const delegates = /`delegate(?:`|\s*\{)/.test(unit);
    if ((steps.length === 0 && !delegates) || /`host`/.test(unit)) return [];
    return [`${[...steps, ...(delegates ? ["delegate"] : [])].join(", ")}: ${flat(unit).slice(0, 160)}`];
  });
}

/**
 * Every call-shaped name in `text` names a tool the mode registers for `row`, a key one of
 * those tools takes, or a host's own manifest key.
 */
function assertToolsExist(text: string, mode: string, row: "operator" | "lead", where: string): void {
  const tools = registry(mode);
  const keys = parameters(tools);
  for (const name of namesCalled(text)) {
    if (keys.has(name) || hostManifestKeys.has(name) || hostOwnTools.has(name)) continue;
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `${where} calls ${name}, which ${mode} registers no tool for`);
    assert.ok(tool.rows.includes(row), `${where} calls ${name}, which is not offered to the ${row} row`);
  }
}

/**
 * The launcher split at its engine-placement section: the section itself, which only an
 * engine-placed mode reads, and everything else, which every mode does.
 */
function engineSection(): { rest: string; section: string } {
  const text = launcher();
  const start = text.indexOf("\n## Engine placement\n");
  assert.ok(start >= 0, "the launcher has an engine-placement section");
  const next = text.indexOf("\n## ", start + 1);
  const end = next === -1 ? text.length : next;
  return { rest: text.slice(0, start) + text.slice(end), section: text.slice(start, end) };
}

/** One `## ` section of a document, by its heading, to the next heading of that level. */
function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}`);
  assert.ok(start >= 0, `no section ${heading}`);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? text.length : next);
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
  const { rest, section } = engineSection();
  for (const mode of ["solo", "dev-team", "dev-team-engine"]) {
    assertToolsExist(rest, mode, "operator", `the launcher under ${mode}`);
  }
  // The mailbox exists under engine placement alone, and so does the section that calls it.
  assertToolsExist(section, "dev-team-engine", "operator", "the launcher's engine-placement section");
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

// @anchor resultIsReport
test("the launcher reads a settled task's final message through result, never from wait's tail", () => {
  // E3's host relayed a lead's closing report as "verbatim" from `wait`'s 2000-character
  // `resultTail` and its `lastActivity` line, rewording four of its lines: the tail is the
  // end of the message and the activity line one event of the engine's, neither the message.
  const text = flat(launcher());
  assert.match(text, /`resultTail` is[^.]*last 2000 characters/);
  assert.match(text, /`lastActivity`[^.]*not the (final )?message/);
  assert.match(flat(engineSection().section), /`result \{task_id: <lead id>\}`[^.]*closing report/);
});

// @anchor routingGuardBites
test("the placement guard catches an unconditioned bullet beside a conditioned one, and a bare delegate", () => {
  // The round-2 review's three mutations, each of which the paragraph-level guard passed:
  // a bullet in a list whose other bullet names `host`, and a `delegate` with no brace.
  const { rest } = engineSection();
  const pushBullet = "- Never `git push`, and never a bare `git stash`";
  const eitherBullet = "- Either one is a task of the `host` loop";
  assert.ok(rest.includes(pushBullet) && rest.includes(eitherBullet), "the anchors the mutations need are still there");
  const mutations: Array<[string, string]> = [
    ["an unconditioned bullet among the guardrails",
      rest.replace(pushBullet, "- Read the root with `git_root {args: [\"status\"]}` before you report.\n" + pushBullet)],
    ["a specialist's delegation among the review bullets",
      rest.replace(eitherBullet, "- **audit** — `delegate {role: \"consult\", cwd: <project root>, engine: <the engine the user named>, brief: <the code>}`.\n" + eitherBullet)],
    ["a delegate written without its arguments",
      `${rest}\n\nOnce the plan is approved, \`delegate\` the implementer with it.\n`],
  ];
  // Each mutation adds exactly one unit to whatever the text holds now, so the guard is
  // shown to bite whether or not the launcher itself is already clean.
  const base = unconditionedSteps(rest).length;
  for (const [what, mutated] of mutations) {
    assert.equal(unconditionedSteps(mutated).length, base + 1, `the guard misses ${what}`);
  }
  assert.deepEqual(unconditionedSteps(rest), [], "and the launcher itself names host placement wherever it orders a loop step");
});

// @anchor engineWhoReconciles
test("under engine placement the launcher says who reconciles: the live lead, a resumed one, or the host for a dead lead's leftovers alone", () => {
  // I4 is the case the section has to allow: a lead killed between `worktree remove` and
  // `branch -d` leaves a branch nobody live will delete, and the operator's pass deleted it
  // through `git_root`, journaling `branch-deleted`.
  const section = flat(engineSection().section);
  assert.match(section, /[Ww]hile a lead is live[^.]*step 1/, "a live lead reconciles, as its step 1");
  assert.match(section, /continues it reconciles first/, "a resumed lead reconciles before anything else");
  assert.match(section, /[Oo]nly the leftovers of a lead that failed or was killed and will not be resumed[^.]*`## Between tasks: reconcile` yours/,
    "and only then is the pass the host's");
  assert.match(section, /never through a shell `git`/);
  // The pass itself says the same from its side.
  const pass = flat(sectionOf(launcher(), "Between tasks: reconcile"));
  assert.match(pass, /[Uu]nder `engine` placement[^.]*lead's (own )?step 1 while a lead is live/);
  // No lead is live before the host's first `delegate` either, and that is not the
  // hand-off: the pass is the host's for a dead lead's leftovers alone, and at the start of
  // a session the host delegates the lead and leaves the root to its step 1.
  assert.match(section, /leftovers of a lead that failed or was killed and (that )?will not be resumed/);
  assert.match(section, /[Aa]t the start of a session[^.]*delegate the lead[^.]*nothing at the root/);
  assert.match(pass, /`engine`[^.]*leftovers of a lead that failed or was killed/);
  for (const sentence of flat(launcher()).split(/(?<=[.:;])\s+/)) {
    if (/no lead (is )?live/.test(sentence)) assert.match(sentence, /leftover/, `a hand-off on "no lead live" alone: ${sentence}`);
  }
  // A damaged ask file that refuses a resume is nobody's to delete but the operator's.
  assert.match(section, /unreadable ask file[^.]*operator's to repair or remove by hand[^.]*before the lead is resumed/);
});

// @anchor engineHostHandsOff
test("under engine placement the host runs no command on the project and shows the lead's report whole", () => {
  // E2's host ran `git status`, `git worktree list`, `git branch --list` and `git log`
  // through its own shell around the lead's run, and summarized the closing report it
  // read through `result`: the root check is the lead's step 1, and the report is the
  // lead's own words.
  const section = flat(engineSection().section);
  assert.match(section, /run no `git` and no test command of your own[^.]*not even to look/);
  assert.match(section, /`cross-agent report` and `cross-agent answer` are the only commands/);
  assert.match(section, /[Ss]how it to the user whole/);
  // E2b's host called `result` under that text and still closed with a list of its own:
  // the launcher's closing paragraph asked every host for one. The list is host
  // placement's; under engine placement the closing message is the report, verbatim.
  assert.match(section, /closing message (opens with|is) (it|the lead's report)[^.]*verbatim/);
  assert.match(section, /not a summary of it/);
  const closing = sectionOf(launcher(), "Reporting").split(/\n\s*\n/).filter((paragraph) => /[Cc]lose the session/.test(paragraph));
  assert.ok(closing.length > 0, "the launcher says how a session closes");
  for (const paragraph of closing) assert.match(flat(paragraph), /`host`/, "a per-task list of the host's own is host placement's");
  assert.ok(sectionOf(launcher(), "Reporting").split(/\n\s*\n/).some((paragraph) =>
    /`engine`/.test(paragraph) && /verbatim/.test(flat(paragraph)) && /not a summary/.test(flat(paragraph))),
  "under engine placement the session closes on the lead's report itself");
});

// @anchor hostWithoutTools
test("a host offered none of this server's tools tells the user the server did not start, and why under Codex and Grok", () => {
  // T14's probe (c): a Codex session started without `CROSS_AGENT_PROJECT` was offered the
  // plugin's skill while the plugin's server never started, and nothing said so (atc-s96.71).
  const before = flat(sectionOf(launcher(), "Before anything"));
  // What a host that is offered the tools reads first: which project this server serves.
  assert.match(before, /`projectRoot`, the canonical root of the project this server serves/);
  assert.match(before, /no `describe_mode` is offered to you/);
  assert.match(before, /server did not start/);
  assert.match(before, /tell the user[^.]*stop/);
  assert.match(before, /Codex[^.]*`CROSS_AGENT_PROJECT`[^.]*before `codex` starts/);
  // Grok's half: the attach is a trusted project's own file naming this checkout.
  assert.match(before, /Grok, only in a trusted project whose `\.grok\/config\.toml` names this checkout/);
  // And Grok lists an MCP server's tools behind its own search: a Grok host that sees none in
  // its tool list has not yet looked (T15: nine of ten Grok hosts' first lines listed none). The
  // search comes before the instruction to stop, which a host reading in order would follow first.
  assert.match(before, /Grok host[^.]*`search_tool`[^.]*before[\s\S]*tell the user[^.]*stop/);
});

// @anchor engineHostShowsRoster
test("under engine placement the host shows the roster before it starts the lead", () => {
  // S11's E2c host delegated the lead without first showing the roster `## Before anything`
  // asks for (atc-s96.66): the section that starts the lead asks for it in its own words.
  const section = flat(engineSection().section);
  const roster = section.search(/`list_roles`[^.]*roster|roster[^.]*`list_roles`/);
  assert.ok(roster >= 0, "the engine-placement section names list_roles and the roster");
  assert.ok(section.indexOf("`delegate {role: <lead.role>") > roster, "and shows the roster before its first delegate of the lead");
  // With the project it serves on its first line, judged before the lead starts.
  const served = section.indexOf("`projectRoot`");
  assert.ok(served >= 0 && served < section.indexOf("`delegate {role: <lead.role>"), "and projectRoot with it, before the lead starts");
});

// @anchor headlessHostOpenAsk
test("a host nobody attends relays the lead's open ask verbatim and ends its turn", () => {
  // T14's E5: a `codex exec` host met the lead's ask with nobody to put it to, and the run
  // went on only because the operator answered by resuming the host's thread (atc-s96.70).
  const headless = engineSection().section.split(/\n\s*\n/).map(flat).filter((paragraph) => /nobody attends/.test(paragraph));
  assert.equal(headless.length, 1, "one paragraph says what a headless host does with an open ask");
  const [paragraph] = headless;
  for (const words of [
    /ask's id and its question verbatim/, /end your turn/,
    /[Dd]o not answer it yourself, do not cancel the lead, and do not keep waiting on it/,
    /`cross-agent answer <ask-id> <text>`/,
    // The three hosts' own ways back into the same session, and a new one as the other way.
    /`claude -p --resume <session id>`/, /`codex exec resume <thread id>`/, /`grok -p <prompt> -r <session id>`/,
    /new host session/,
  ]) {
    assert.match(paragraph, words, `the headless paragraph says ${words}`);
  }
});

// @anchor engineHostReadsSkill
test("under engine placement the host's one read outside its two commands is this skill's own SKILL.md", () => {
  // E5's Codex host opened its turn with `cat` of the plugin copy's SKILL.md, which the
  // "only commands" sentence did not allow: a host offered the skill as a file has to read it.
  const section = flat(engineSection().section);
  assert.match(section, /`cross-agent report` and `cross-agent answer` are the only commands of yours this placement needs/);
  assert.match(section, /one exception[^.]*this skill's own `SKILL\.md`/);
  // The exception is that one file: a sentence that also let the host read the project would
  // undo the hands-off rule it qualifies.
  assert.match(section, /this skill's own `SKILL\.md` is yours too, and it is the one file you read\./);
});


// @anchor budgetTable
test("the launcher's budget table gives every host a wait that fits inside its tool timeout", () => {
  const text = flat(launcher());
  assert.match(text, /Claude Code[^|]*\|[^|]*\|[^|]*600/, "Claude Code's row and its wait");
  assert.match(text, /Codex[^|]*\|[^|]*`tool_timeout_sec`[^|]*3600[^|]*\|[^|]*600/, "Codex's row names the manifest key and this repo's value");
  // Where Codex's 3600 lives, and the run that measured a 600 s `wait` inside it (T14's B3).
  assert.match(text, /Codex[^|]*\|[^|]*`\.codex-plugin\/plugin\.json`[^|]*lead mount[^|]*`docs\/probes\.md#codexHostTimeout`[^|]*\|/,
    "Codex's row names the plugin manifest and the lead mount, and cites the measured wait");
  // Grok's per-server key, its default, and the run that held a 600 s `wait` inside it (T15's B3).
  assert.match(text, /Grok[^|]*\|[^|]*`tool_timeout_sec`[^|]*6000[^|]*`docs\/probes\.md#grokToolTimeout`[^|]*\|\s*600\s*\|/,
    "Grok's row names the per-server key and its default, and cites the measured wait");
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
    assert.match(text, new RegExp(`\\*\\*${verb}\\*\\* — under \`host\` placement, \`delegate \\{role: "consult", cwd: <project root>, engine: `));
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

// @anchor launcherRoutesPlacement
test("the launcher routes on placement and names the mailbox tools and the report verb", () => {
  const text = launcher();
  const paragraphs = text.split(/\n\s*\n/);
  // Right after `describe_mode`, placement decides who runs the loop it returned.
  const describe = paragraphs.findIndex((paragraph) => paragraph.includes("Call `describe_mode`"));
  assert.ok(describe >= 0, "the launcher opens on describe_mode");
  const routing = flat(paragraphs[describe + 1]);
  for (const word of [/`mode\.lead\.placement`/, /`host`/, /`engine`/, /## Engine placement/]) {
    assert.match(routing, word, `the paragraph after describe_mode routes on placement: ${word}`);
  }
  // The returned loop is the host's own instructions under `host` and only there.
  const instructions = paragraphs.filter((paragraph) => /your instructions/.test(paragraph));
  assert.ok(instructions.length > 0);
  for (const paragraph of instructions) assert.match(flat(paragraph), /`host`/, "the loop is the host's instructions only under host");

  // Reporting: `.cross-agent/log.md` is host placement's, and under engine placement the
  // report is the lead's final message and the CLI's rendering of the ledger.
  const reporting = sectionOf(text, "Reporting").split(/\n\s*\n/);
  for (const paragraph of reporting.filter((each) => each.includes(".cross-agent/log.md"))) {
    assert.match(flat(paragraph), /`host`/, "the log file is appended under host placement only");
  }
  assert.ok(reporting.some((paragraph) => /`engine`/.test(paragraph) && /`result/.test(paragraph) && /`cross-agent report`/.test(paragraph)),
    "under engine placement: the closing report through result, every task through cross-agent report");

  const { rest, section } = engineSection();
  for (const name of ["`list_asks", "`answer", "`cross-agent answer`", "`cross-agent report`", "resume", "`cancel"]) {
    assert.ok(section.includes(name), `the engine-placement section names ${name}`);
  }
  // Nothing outside the section contradicts it: the mailbox is named only there, and no
  // paragraph says every mode runs its loop in the host session.
  assert.doesNotMatch(rest, /`list_asks|`answer \{|`ask \{/);
  assert.doesNotMatch(flat(rest), /every mode runs its loop in your own session/);
  // Every paragraph and every list item outside the section that orders a loop step — a
  // root or worktree git call, a test run, a delegation — says it is host placement's.
  // E2's host read "Between tasks" and ran its reads through its own shell, because
  // nothing there said the pass was not an engine-placed host's.
  assert.deepEqual(unconditionedSteps(rest), [], "units that order a loop step without naming host placement");
  // The host starts the lead and watches it; the loop's own steps are the lead's.
  const flatSection = flat(section);
  assert.match(flatSection, /`delegate \{role: <lead\.role>, cwd: <project root>, brief\}`/);
  assert.match(flatSection, /`wait \{task_id, timeout_seconds: 600\}`/);
  assert.match(flatSection, /`list_asks \{status: "open"\}`/);
  assert.match(flatSection, /`answer \{ask_id, text\}`/);
  assert.match(flatSection, /`delegate \{role: <lead\.role>, cwd: <project root>, resume: <lead id>, brief\}`/);
  assert.match(flatSection, /`result \{task_id: <lead id>\}`/);
  for (const step of ["git_root", "git_mutate", "run_command", "verify_worktree"]) {
    assert.match(flatSection, new RegExp(`never[^.]*\`${step}\``), `the section keeps ${step} out of the host's hands`);
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

// @anchor engineLoopSteps
test("the engine loop runs the same ten steps in the same order, asking where the host loop stops for the user", () => {
  const source = loop("dev-team-engine");
  const text = flat(source);
  assertInOrder(text, [
    "list_tasks",
    // Step 1's stops — a root that is not clean, not on `<default>` — are questions here.
    "ask {question",
    "delegate {role: \"planner\"",
    // Step 2's premise failure.
    "ask {question",
    "delegate {role: \"plan-reviewer\"",
    "resume",
    // Step 3's human decision and its two-round stop: all before step 4 creates anything.
    "ask {question",
    'git_root {args: ["worktree", "add", "-b", <branch>, <worktree path>, <default>], slug}',
    "delegate {role: \"implementer\"",
    'git_mutate {slug, args: ["add", "-A", "--", ".", ":(exclude).cross-agent", ":(exclude).worktrees"]}',
    'git_mutate {slug, args: ["commit"',
    "delegate {role: \"code-reviewer\"",
    'git_mutate {slug, args: ["rebase", <default>]}',
    'rebase", "--abort',
    'git_root {args: ["merge", "--ff-only", <branch>], slug}',
    'run_command {which: "test", where: "root", slug}',
    "git revert --no-edit",
    '"worktree", "remove"',
    '"branch", "-d"',
    // `.cross-agent/log.md` becomes the closing report, which is the lead's final message.
    "closing report",
  ], "the engine-placed loop");
  assert.match(sectionOf(source, "10."), /closing report[\s\S]*final message|final message[\s\S]*closing report/);
  assert.doesNotMatch(text, /\.cross-agent\/log\.md/, "a lead read-only at the root appends no file");
  // The later stops for a decision are questions too, and a question is waited on by its id.
  for (const step of ["5.", "7.", "8."]) assert.match(flat(sectionOf(source, step)), /ask \{question/, `step ${step}`);
  assert.match(text, /ask \{id/);
  // The repair path is not a question: the lead stops there and dispatches nothing more.
  assert.match(flat(sectionOf(source, "9.")), /dispatch nothing/);
  assert.match(text, /\bresume\b/, "a needs-work round continues the task that did the work");
});

// @anchor engineLoopOwnership
test("the engine loop's root check says what the lead owns: never itself, only its own, and the operator for the rest", () => {
  const step = flat(sectionOf(loop("dev-team-engine"), "1. Root check"));
  // `list_tasks` marks the caller's records `self` and what it owns `own` (the server's half).
  assert.match(step, /`self: true`/);
  assert.match(step, /`own: true`/);
  assert.match(step, /never wait on, cancel or reconcile your own `self`/);
  assert.match(step, /wait on, resume and cancel only[^.]*`own`/);
  assert.match(step, /records (it|you) continue/, "the resume-chain rule: a resumed lead owns its earlier records' children");
  // What is not the lead's is the operator's, asked rather than decided.
  for (const leftover of [/active task[^.]*not own/, /journal[^.]*not[^.]*(write|wrote|written)/, /invalid/]) {
    assert.match(step, leftover);
  }
  assert.match(step, /ask \{question/);
  assert.match(step, /only on (the|its) answer/);
});

// @anchor leadRolePrompt
test("the lead's role prompt states who it is, its report, what it may not do, and its wait budget per engine", () => {
  const lead = flat(fs.readFileSync(path.join(builtInModesDir(), "dev-team-engine", "roles", "lead.md"), "utf8"));
  assert.match(lead, /^You are the lead/);
  // The report, as its fields: the per-task line `cross-agent report` prints, then the rest.
  assertInOrder(lead, ["closing report", "final message", "role", "engine", "model", "effort", "duration", "outcome", "task id",
    "branch", "commit", "suite", "verdict", "cleaned up", "standing", "asked", "nobody verified"], "the lead's report");
  // What it may not do.
  for (const rule of [/never another lead/, /never do a specialist's work/i, /`git_root`/, /`git_mutate`/, /`run_command`/,
    /never (start|run) an engine CLI/i, /only the tasks you own/, /never decide[^.]*operator/i, /no file/]) {
    assert.match(lead, rule, `the lead's prompt says ${rule}`);
  }
  // The budget: every `wait` and `ask` is one call of 600 seconds, inside each engine's own timeout.
  assert.match(lead, /600/);
  assert.match(lead, /Claude[^.]*28 hours/);
  assert.match(lead, /Codex[^.]*3600/);
});

// @anchor leadReportLine
test("the lead's report spells each specialist's line in cross-agent report's seven fields, a duration on every line", () => {
  // S11's E2, E2b and E2c Codex leads closed with each specialist's id and verdict and no
  // duration (atc-s96.64): the line is spelled as `cross-agent report` prints its rows
  // (src/cli.ts#reportVerb), and its duration is the count the `wait` that settled it gave.
  const lead = flat(fs.readFileSync(path.join(builtInModesDir(), "dev-team-engine", "roles", "lead.md"), "utf8"));
  assert.match(lead, /`<role> \| <engine> \| <model> \| <effort> \| <N>s \| <outcome> \| <task id>`/);
  assert.match(lead, /`elapsedSeconds` of the `wait` that saw the task settle/);
  assert.match(lead, /every field present on every line/);
});

test("every tool the dev-team loop calls is offered to the row its placement runs the loop in", () => {
  assertToolsExist(loop("dev-team"), "dev-team", "operator", "the dev-team loop");
  assertToolsExist(loop("dev-team-engine"), "dev-team-engine", "lead", "the engine-placed dev-team loop");
  assertToolsExist(loop("solo"), "solo", "operator", "the solo loop");
});

test("both dev-team loops name the journal step each of their git calls completes", () => {
  for (const name of ["dev-team", "dev-team-engine"]) {
    const text = flat(loop(name));
    for (const step of ["worktree-created", "committed", "rebased", "merged", "tests-passed", "worktree-removed", "branch-deleted"]) {
      assert.match(text, new RegExp("`" + step + "`"), `the ${name} loop never says which call writes ${step}`);
    }
    assert.match(text, /`ok: false`/, `${name}: any refusal is a reconciliation trigger, whatever its exit code`);
  }
});

// @anchor loopsNameHostConfig
test("both dev-team loops name a host's project configuration wherever they say what step 6's commit and step 9's merge refuse", () => {
  // The paths are the guard's own list (`src/gitmutate.ts#hostConfigPaths`), so the loop
  // text a lead reads before the refusal and the refusal itself cannot drift apart.
  for (const name of ["dev-team", "dev-team-engine"]) {
    const paragraphs = loop(name).split(/\n\s*\n/).map(flat);
    for (const phrase of ["step 9 refuses a branch that carries either directory", "carries nothing from `.cross-agent`"]) {
      const found = paragraphs.filter((text) => text.includes(phrase));
      assert.equal(found.length, 1, `${name}: one paragraph says "${phrase}"`);
      for (const entry of hostConfigPaths) {
        assert.ok(found[0].includes("`" + entry), `${name}: the paragraph saying "${phrase}" names ${entry}`);
      }
    }
  }
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

/**
 * The keys of a `delegate {…}` literal, in order, read at its top level: the name that starts
 * the object or follows a comma there, spelled `name: value` or bare, as in the launcher's
 * `delegate {role, brief, cwd}`. A value is stepped over whole — a quoted string, a
 * `<placeholder>`, a nested `{…}`, `[…]` or `(…)` — so a `, branch:` inside one is no key.
 */
function delegateKeys(call: string): string[] {
  const body = call.slice(call.indexOf("{") + 1, call.lastIndexOf("}"));
  const segments = [""];
  let quote = "";
  let angles = 0;
  let depth = 0;
  for (let index = 0; index < body.length; index++) {
    const c = body[index];
    if (quote === "" && angles === 0 && depth === 0 && c === ",") {
      segments.push("");
      continue;
    }
    segments[segments.length - 1] += c;
    if (quote !== "") {
      if (c === "\\") segments[segments.length - 1] += body[++index] ?? "";
      else if (c === quote) quote = "";
    } else if (angles > 0) {
      // Inside a placeholder only its own brackets count: an apostrophe there is prose.
      if (c === "<") angles++;
      else if (c === ">") angles--;
    } else if (c === "<") angles++;
    else if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
  }
  return segments.flatMap((text) => {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::|$)/.exec(text);
    return key === null ? [] : [key[1]];
  });
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
      const keys = delegateKeys(call);
      assert.ok(keys.includes("role"), `${where} spells a delegate call with no role: ${call}`);
      assert.ok(keys.includes("cwd"), `${where} spells a delegate call with no cwd: ${call}`);
      if (/cwd: <worktree path>/.test(call)) {
        assert.ok(keys.includes("branch"), `${where} spells a worktree delegation with no branch: ${call}`);
      }
    }
  }
  assert.ok(checked >= 6, `only ${checked} delegate calls found; the loops spell more than that`);
});

// @anchor delegateKeysTopLevel
test("a delegate literal's keys are read at its top level, never inside a value", () => {
  assert.deepEqual(delegateKeys("delegate {role, brief, cwd}"), ["role", "brief", "cwd"]);
  assert.deepEqual(delegateKeys('delegate {role: "implementer", cwd: <worktree path>, branch: <branch>, brief}'), ["role", "cwd", "branch", "brief"]);
  // A key's name inside a value — a quoted string or a placeholder, commas and apostrophes
  // in it — is no key of the literal.
  assert.deepEqual(delegateKeys('delegate {role: "implementer", brief: "review this, branch: task/x", cwd: <worktree path>}'), ["role", "brief", "cwd"]);
  assert.deepEqual(delegateKeys('delegate {role: "consult", brief: <look here, cwd: /tmp, then report>}'), ["role", "brief"]);
  assert.deepEqual(delegateKeys('delegate {role: "consult", brief: <the implementer\'s notes, branch: and all>, cwd: <project root>}'), ["role", "brief", "cwd"]);
});

test("the two dev-team modes carry the same role prompts, byte for byte", () => {
  const modes = builtInModesDir();
  for (const key of ["planner", "plan-reviewer", "implementer", "code-reviewer", "resolver"]) {
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

// @anchor worktreePathAbsolute
test("both dev-team loops make the worktree path absolute, as delegate's cwd must be", () => {
  // `delegate` refuses a relative `cwd`; the host-placed loop wrote `<git.worktreeDir>/<slug>`
  // where the engine-placed one wrote the project root before it (task 12's review).
  for (const mode of ["dev-team", "dev-team-engine"]) {
    assert.match(flat(loop(mode)), /`<worktree path>` is `<project root>\/<git\.worktreeDir>\/<slug>`/, mode);
  }
});

// @anchor implementerSandboxSentence
test("the implementer is told its shell and its file tools write its worktree alone, and that its pointer is verified", () => {
  // The sandbox binds a Claude role's shell; its file tools are fenced by the permission
  // layer since t12Fix1, and a Grok sandbox lets the pointer be rewritten (P2). So the
  // prompt names both writers, and it no longer says the pointer is writable everywhere.
  for (const mode of ["dev-team", "dev-team-engine"]) {
    const implementer = flat(fs.readFileSync(path.join(builtInModesDir(), mode, "roles", "implementer.md"), "utf8"));
    assert.match(implementer, /Your shell and your file tools can write there and nowhere else/, mode);
    assert.doesNotMatch(implementer, /is a writable file inside your sandbox/, mode);
    assert.match(implementer, /verifies it before every git operation/, mode);
  }
});

test("every committed dev-team role prompt came through the converter and was edited for this runtime", () => {
  const modes = builtInModesDir();
  const codas = new Map([
    ["planner", "You write no files and you delegate nothing; your final message is the plan."],
    ["plan-reviewer", "You write no files and you delegate nothing; your final message is the review."],
    ["implementer", "You run no git command that writes: the session that delegated you commits what you leave. You delegate nothing; your final message is the report that commit is made from."],
    ["code-reviewer", "You write no files and you delegate nothing; your final message is the review, verdict first."],
    // The resolver writes in the worktree as the implementer does, and commits as little.
    ["resolver", "You run no git command that writes: the session that delegated you commits what you leave. You delegate nothing; your final message is the report that commit is made from."],
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

// @anchor rosterProjectRootCases
test("the roster's first line is projectRoot, judged against the project the user is in: stop, proceed, proceed as asked, or confirm", () => {
  const before = flat(sectionOf(launcher(), "Before anything"));
  assert.match(before, /first line is `projectRoot`/);
  // An initialized sibling — a worktree or checkout with its own config — served by M stops.
  assert.match(before, /\*\*[Ss]top\*\*[^.]*initialized project other than `projectRoot`[^.]*\.cross-agent\/config\.json/);
  assert.match(before, /named a project and `projectRoot` is another/);
  // An uninitialized sibling proceeds, served by its main project, and the line says so,
  // but only where the project served is not the worktree the host is in: a bare
  // repository's worktree with no config discovers itself.
  assert.match(before, /\*\*[Pp]roceed\*\*[^.]*uninitialized worktree/);
  assert.match(before, /`projectRoot` is not the nearest directory at or above the working directory that holds a `\.git`, say so on the roster's first line: served by the main project at <projectRoot>; run `cross-agent init` here for a project of its own/);
  // A root the user named or confirmed in this session proceeds as asked, wherever the host
  // sits; a binding the environment alone holds confirms nothing, since a Codex host always
  // has one, and beside another initialized project it is the stale case that stops.
  assert.match(before, /\*\*[Pp]roceed as asked\*\*[^.]*named or confirmed `projectRoot` in this session[^.]*`--project`[^.]*`CROSS_AGENT_PROJECT`[^.]*wherever/);
  assert.match(before, /config\.json` — and the user has not named or confirmed `projectRoot` in this session, or when the user named a project and `projectRoot` is another/);
  assert.match(before, /`CROSS_AGENT_PROJECT` found only in the environment[^.]*confirms nothing/);
  // Inside a task's worktree the line serves its root, and `init` there would exit 3.
  assert.match(before, /[Ll]eave the `init` advice out when the working directory lies under `projectRoot`'s `git\.worktreeDir`/);
  // Any start the cases above leave open is confirmed before anything is dispatched.
  assert.match(before, /\*\*[Oo]therwise\*\*[^*]*show `projectRoot` and ask the user to confirm it before you dispatch anything/);
});

// @anchor rootCheckOwnBranch
test("both loops read the root's own branch, and reconcile only their own project's leftovers among the repository's", () => {
  for (const mode of ["dev-team", "dev-team-engine"]) {
    const step = flat(sectionOf(loop(mode), "1. Root check"));
    assert.match(step, /git_root \{args: \["rev-parse", "--abbrev-ref", "HEAD"\]\}/, mode);
    assert.doesNotMatch(step, /first stanza/, `${mode}: the first stanza is the repository's main worktree, not the project root`);
    assert.match(step, /sibling project/, mode);
    assert.match(step, /open journal/, mode);
    assert.match(step, /`branch-deleted`/, mode);
  }
  // The rebase state is read where the verifier says the worktree's git directory is, by
  // the launcher and by both loops' reconciliation after a refusal.
  for (const [where, text] of [["launcher", launcher()], ["dev-team", loop("dev-team")], ["dev-team-engine", loop("dev-team-engine")]]) {
    assert.match(flat(text), /`rebase-merge` or `rebase-apply` directory under the `gitDir` `verify_worktree/, where);
    assert.match(flat(text), /`branch` being `"HEAD"` while a\s+stopped rebase has detached it/, where);
  }
});
