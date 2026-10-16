import "./child-check.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.ts";
import { trackerVerbs } from "../src/config.ts";
import type { RecordsConfig } from "../src/config.ts";
import { hostConfigPaths } from "../src/gitmutate.ts";
import { builtInModesDir, CONSULT_ROLE, describeMode, findRole, loadMode } from "../src/modes.ts";
import { projectTools } from "../src/server.ts";
import { git } from "./helpers/git.ts";

// The text every host loads and the loop every mode serves. `skills/cross-agent/SKILL.md`
// is the launcher — one of the two skills a host discovers, identical on all three — and
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

// @anchor engineHostNoLog
test("under engine placement the host appends nothing to .cross-agent/log.md: the lead's report and cross-agent report are the record", () => {
  // The launcher put the log under host placement and said the lead appends nothing, and it
  // said nothing of an engine-placed host's own lines (E8, atc-s96.66).
  const paragraphs = sectionOf(launcher(), "Reporting").split(/\n\s*\n/).map(flat)
    .filter((paragraph) => paragraph.includes("`engine`") && paragraph.includes("`.cross-agent/log.md`"));
  assert.equal(paragraphs.length, 1, "one Reporting paragraph says what an engine-placed host does with the log");
  assert.match(paragraphs[0], /[Nn]or do you append to `\.cross-agent\/log\.md` under this placement/);
  assert.match(paragraphs[0], /the lead's report and `cross-agent report` are the record/);
});

// @anchor hostWithoutTools
test("a host offered none of this server's tools tells the user the server did not start, and why under Codex and Grok", () => {
  // T14's probe (c): a Codex session started without `CROSS_AGENT_PROJECT` was offered the
  // plugin's skill while the plugin's server never started, and nothing said so (atc-s96.71).
  const before = flat(sectionOf(launcher(), "Before delegating"));
  // What a host that is offered the tools reads first: which project this server serves.
  assert.match(before, /`projectRoot`, the canonical root of the project this server serves/);
  assert.match(before, /no `describe_mode` is offered to you/);
  assert.match(before, /server did not start/);
  assert.match(before, /tell the user[^.]*stop/);
  assert.match(before, /Codex, suggest asking for the one-time setup/);
  assert.match(before, /legacy bundled mount requires `CROSS_AGENT_PROJECT`[^.]*before Codex starts/);
  const setup = flat(sectionOf(launcher(), "Codex host setup"));
  assert.match(setup, /before\*\* calling `describe_mode`/);
  assert.match(setup, /ordinary delegation with missing tools does not authorize/);
  // Grok's half: the attach is a trusted project's own file naming this checkout.
  assert.match(before, /Grok it starts only in a trusted project whose `\.grok\/config\.toml` names this checkout/);
  // And Grok lists an MCP server's tools behind its own search: a Grok host that sees none in
  // its tool list has not yet looked (T15: nine of ten Grok hosts' first lines listed none). The
  // search comes before the instruction to stop, which a host reading in order would follow first.
  assert.match(before, /Grok host[^.]*`search_tool`[^.]*before[\s\S]*tell the user[^.]*stop/);
});

// @anchor engineHostShowsRoster
test("under engine placement the host shows the roster before it starts the lead", () => {
  // S11's E2c host delegated the lead without first showing the roster `## Before delegating`
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
  // Claude Code's 28 hours is not where its host hands a call back: at 120 s it moves the call
  // to the background, and the answer comes later as a notification (the pilot, atc-s96.122).
  assert.match(text,
    /\| Claude Code \|[^|]*28 hours[^|]*120 s[^|]*moved to the background[^|]*keeps running[^|]*task notification[^|]*`docs\/probes\.md#claudeCodeBackground`[^|]*\|\s*600\s*\|/,
    "Claude Code's row describes the backgrounding, cites the runs that saw it, and keeps its wait");
  assert.match(text, /Codex[^|]*\|[^|]*`tool_timeout_sec`[^|]*3600[^|]*\|[^|]*600/, "Codex's row names the manifest key and this repo's value");
  // Where Codex's 3600 lives, and the run that measured a 600 s `wait` inside it (T14's B3).
  assert.match(text, /Codex[^|]*\|[^|]*`\.codex-plugin\/plugin\.json`[^|]*lead mount[^|]*`docs\/probes\.md#codexHostTimeout`[^|]*\|/,
    "Codex's row names the plugin manifest and the lead mount, and cites the measured wait");
  // Grok's per-server key, its default, and the run that held a 600 s `wait` inside it (T15's B3).
  assert.match(text, /Grok[^|]*\|[^|]*`tool_timeout_sec`[^|]*6000[^|]*`docs\/probes\.md#grokToolTimeout`[^|]*\|\s*600\s*\|/,
    "Grok's row names the per-server key and its default, and cites the measured wait");
  assert.match(text, /Time limits/, "the table is the design's own budget, cited");
});

// @anchor backgroundedCall
test("under a Claude Code host a call moved to the background at 120 s is waited out through its task notification, never re-issued", () => {
  // The pilot's host got every 600 s `wait` and every `run_command` test run back at 120 s as
  // "moved to the background as task …" (atc-s96.122): that is the call still running, and
  // issuing it again starts a second call beside it.
  const watching = flat(sectionOf(launcher(), "Watching"));
  // It comes back when 120 s have passed, not as soon as it is called.
  assert.match(watching, /Claude Code host, a `wait`[^.]*`host` placement[^.]*`run_command`[^.]*120 s comes back at that point[^.]*moved to the background/);
  assert.match(watching, /answer[^.]*arrives later as a task notification/);
  assert.match(watching, /neither a timeout nor a reason to issue the same `wait` or `run_command` again/);
  assert.match(watching, /wait for its notification and act on the answer it carries/);
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

// @anchor hostNeverStartsServer
test("the host never starts this server itself, beside its rule against starting an engine CLI", () => {
  // A host that started `src/server.ts` under its own shell would hold a second server of its
  // own, outside the one its host attached and the lineage that one reads (atc-s96.82).
  const paragraphs = launcher().split(/\n\s*\n/).map(flat).filter((paragraph) => paragraph.includes("never start an engine CLI yourself"));
  assert.equal(paragraphs.length, 1, "one paragraph keeps the host off the engine CLIs");
  assert.match(paragraphs[0], /[Nn]or do you start this server yourself — `src\/server\.ts`, the plugin's MCP entrypoint/);
});

test("the launcher's closing report names every task with what ran it and what it cost", () => {
  const text = flat(launcher());
  assert.match(text, /\.cross-agent\/log\.md/);
  assertInOrder(text, ["role", "engine", "model", "effort", "duration", "outcome"], "the launcher's log line");
  assert.match(text, /not verified/, "the closing report says what nobody checked");
});

// @anchor narrationFromRoster
test("every dispatch is narrated with the engine, model and effort the roster, the call or the task's record names, never a guess", () => {
  // The narration is the user's one sight of what is paid for, so it names what the server
  // said rather than what the host supposes (atc-s96.66).
  const narration = launcher().split(/\n\s*\n/).map(flat).filter((paragraph) => paragraph.startsWith("Narrate every dispatch"));
  assert.equal(narration.length, 1, "one paragraph says how a dispatch is narrated");
  assert.match(narration[0], /from the roster's line for that role or seat, or from your call where it names them/);
  // A field neither the line nor the call names runs at that engine's default, field by field.
  // A call that names another engine drops the bound model and effort: the call's model and
  // effort are then all there is, and whichever it leaves out is that engine's default, so
  // the switch is a rule of its own, not an example.
  assert.match(narration[0], /a model or an effort that neither the roster's line nor your call names is that engine's default[^.]*as such/);
  assert.match(narration[0], /call that names another engine than the roster's line is its own rule[^.]*drops the line's model and effort[^.]*your call's alone[^.]*where your call names either not at all, say that engine's default for that one/);
  assert.doesNotMatch(narration[0], /as when your call names another engine/);
  assert.doesNotMatch(narration[0], /the same for its effort/);
  // The delegation answers with the three its record holds, which settles any doubt the
  // rules above leave (atc-s96.95), and the section that introduces the call says so first.
  assert.match(narration[0], /delegation's answer carries the engine, model and effort the task's record holds[^.]*narrate the answer's/);
  assert.match(flat(sectionOf(launcher(), "Starting a task")),
    /`delegate \{role, brief, cwd\}` launches one task and answers with its task id and the engine, model and effort it runs on/);
  assert.match(narration[0], /task you did not dispatch[^.]*by the engine, model and effort its record in `list_tasks` carries/);
  assert.match(narration[0], /never guess them/);
});

// @anchor rosterProjectWarning
test("the launcher shows describe_mode's projectWarning and judges it as the stop case", () => {
  // The server names the mismatch between the directory it was started in and the project
  // it serves, so the host need not notice it on its own (atc-s96.102).
  const before = flat(sectionOf(launcher(), "Before delegating"));
  assert.match(before, /`projectWarning`[^.]*initialized project other than `projectRoot`[^.]*show it to the user[^.]*first case/);
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
  // Triage is the lead's own work; a waiver is the operator's unless the config hands the lead that ruling.
  assert.match(lead, /Triage is yours/);
  assert.match(lead, /lead-decides/);
  assert.match(lead, /every stop with its answer/);
  // The budget: every `wait` and `ask` is one call of 600 seconds, inside each engine's own timeout.
  assert.match(lead, /600/);
  assert.match(lead, /Claude[^.]*28 hours/);
  assert.match(lead, /Codex[^.]*3600/);
});

// @anchor engineLeadScope
test("the engine loop has its lead read the summary, keeps run_command for its gates, and leaves the specialists' tests in their worktrees", () => {
  const source = loop("dev-team-engine");
  const text = flat(source);
  // The loop and the lead's own prompt are its instructions already (atc-s96.162).
  assert.ok(text.includes('describe_mode {view: "summary"}'), "the lead reads the summary view");
  // `run_command` is the lead's route for the server's gates, and the limit is the lead's:
  // a Codex lead once read it as a rule for every test (atc-s96.159).
  assert.match(text, /your own test and setup runs[^.]*the server's gates[^.]*`run_command`/);
  assert.match(text, /These limits are yours, not your specialists'/);
  assert.match(text, /no specialist can call `run_command`/);
  assert.match(text, /the implementer and the resolver run the test command in their own worktree/);
  assert.match(text, /a brief never routes a specialist's tests through `run_command`/);
  for (const step of ["2.", "5."]) {
    assert.match(flat(sectionOf(source, step)), /the test command \(`project\.testCommand`\), which the implementer runs in its worktree/, `step ${step}`);
  }
  const lead = flat(fs.readFileSync(path.join(builtInModesDir(), "dev-team-engine", "roles", "lead.md"), "utf8"));
  assert.match(lead, /These limits are yours, not your specialists'/);
  assert.match(lead, /the implementer and the resolver run the test command in their own worktrees/);
  for (const [where, prose] of [["the loop", text], ["the lead's prompt", lead]]) {
    assert.doesNotMatch(prose, /every test and setup run through `run_command`/, where);
  }
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
  // A seat of a many-seat role is spelled as the command spells it.
  assert.match(lead, /`<role>#<seat>`/);
  // A lead's report named engines and models it never read (atc-s96.95): each line's three
  // come from the answers the loop already reads, as the task's record holds them.
  assert.match(lead, /engine, model and effort on its line are those the `delegate` that launched it answered with[^.]*`wait` and `result`[^.]*`null` written `-`[^.]*never from memory/);
  // The loop sends `list_roles` to step 1's binding check, and the report to those answers.
  const engineLoop = flat(loop("dev-team-engine"));
  assert.match(engineLoop, /`list_roles` gives you the engine, model and effort each role name below is bound to[^.;]*;[^.]*report names each task's own[^.]*`delegate` that launched it answered/);
  assert.doesNotMatch(engineLoop, /you name each of them in your report/);
});

// The engine lead's run (design section 7, "The engine lead's run"): under `dev-team-engine`
// with a `records` block, the lead's brief may name an epic, a list of tracker ids or a goal,
// and the loop's `## The run` works it one task per item, keeping the tracker and the record
// files through `track` and `record` alone. Without the block none of it applies.

/**
 * One `### ` subsection of a document, by its heading, to the next `### ` or the end. It cuts
 * the raw text, so flatten it afterwards: `flat` removes the line breaks it cuts on.
 */
function subsection(text: string, heading: string): string {
  const start = text.indexOf(`\n### ${heading}`);
  assert.ok(start >= 0, `no subsection ${heading}`);
  const next = text.indexOf("\n### ", start + 1);
  return text.slice(start, next === -1 ? text.length : next);
}

/** The units of `text` as `unconditionedSteps` cuts them: blank-line blocks, cut further at every list item. */
function unitsOf(text: string): string[] {
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
  return units;
}

// A records tool named as a call: `track`, `record`, or either with its arguments. The existing
// tool-name check judges only names carrying an underscore, so these two pass it unseen.
const RECORDS_CALL = /`(?:track|record)(?:`|\s*\{)/;

/** A block with every verb the tracker table has, the optional `epic` and `depend` included. */
const everyVerb: RecordsConfig = {
  files: [".project-steward/HANDOFF.md", ".project-steward/PROGRESS.md", ".project-steward/DECISIONS.md"],
  tracker: {
    ready: ["bd", "ready"],
    show: ["bd", "show", "{id}"],
    create: ["bd", "create", "--title={title}", "--description={text}", "--parent={parent}"],
    file: ["bd", "create", "--title={title}", "--description={text}"],
    epic: ["bd", "create", "--type=epic", "--title={title}", "--description={text}"],
    claim: ["bd", "update", "{id}", "--claim"],
    close: ["bd", "close", "{id}", "--reason={text}"],
    depend: ["bd", "dep", "add", "{id}", "{on}"],
    files: [".beads/interactions.jsonl"],
  },
};

/** Every tool this project's server registers under `name` when its config keeps records. */
function registryWithRecords(name: string): Map<string, Tool> {
  const tools = projectTools(repoRoot, { mode: loadMode(builtInModesDir(), name), records: everyVerb });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

/** The engine loop's `## The run`, raw. */
function theRun(): string {
  return sectionOf(loop("dev-team-engine"), "The run");
}

/** The lead's role prompt, raw. */
function leadPrompt(): string {
  return fs.readFileSync(path.join(builtInModesDir(), "dev-team-engine", "roles", "lead.md"), "utf8");
}

// @anchor engineRunSet
test("the engine loop works a set: step 1, claim, steps 2–9, file, record, close, step 10, in dependency order", () => {
  const step = flat(subsection(theRun(), "R2."));
  assertInOrder(step, ["1. Step 1.", 'track {verb: "claim"', "Steps 2 to 9", 'track {verb: "file"', "record {changes",
    'track {verb: "close"', "Step 10"], "the run's R2");
  assert.match(step, /dependency order/);
  assert.match(step, /`track \{verb: "ready"\}`/);
});

// @anchor engineRunReport
test("with records, step 10 ends the task and the report waits for the run's end; without records it is the final message", () => {
  const step = flat(sectionOf(loop("dev-team-engine"), "10."));
  assert.match(step, /[Ww]ithout `records`, your closing report, which is your final message/);
  assert.match(step, /`records`[^.]*step 10 ends this task/);
  assert.match(step, /closing report waits for the end of the run/);
  assert.ok(flat(subsection(theRun(), "R5.")).includes("closing report, which is your final message"), "R5 writes the report once");
});

// @anchor engineRunGoal
test("a goal is clarified through ask, approved in one ask, recorded before filing, and its set is the ids create printed, named in the handoff", () => {
  const step = flat(subsection(theRun(), "R3."));
  assertInOrder(step, ["ask {question", 'delegate {role: "planner"', "One approval", "Only on a yes", "`record` the approved design",
    'track {verb: "epic"', 'track {verb: "create"', "parent: <the epic>", "keeping the id each one prints", 'track {verb: "depend"',
    "the handoff naming the goal, the epic and the set"], "the run's R3");
  assert.match(step, /ask again/);
  assert.match(step, /A stop ends the run with nothing filed/);
});

// @anchor engineRunGoalReview
test("a goal's design and breakdown goes to the plan reviewer as that, each item planned and tested on its own when it runs", () => {
  // The plan reviewer's prompt is written for one task's plan: the brief says what this one is.
  assert.match(flat(subsection(theRun(), "R3.")),
    /plan reviewer's brief[^.]*reviews a goal's design and breakdown[^.]*each item is planned and tested on its own when it runs/);
});

// @anchor plannerGoalBreakdown
test("the planner answers the design and breakdown R3 asks of it, and every other brief with a plan of one task", () => {
  // The planner's prompt reaches it as its system instructions, and it plans one task for one
  // implementer: R3's brief is the one exception it names, in the words R3 asks with.
  const asked = ["design and its breakdown", "ordered items, each one task, each with its acceptance criteria and the items it depends on"];
  assertInOrder(flat(subsection(theRun(), "R3.")), asked, "R3's planner brief");
  for (const mode of ["dev-team", "dev-team-engine"]) {
    const planner = flat(fs.readFileSync(path.join(builtInModesDir(), mode, "roles", "planner.md"), "utf8"));
    assertInOrder(planner, ["this plan is one task", ...asked, "Every other brief gets the one-task plan"], `${mode}'s planner`);
  }
});

// @anchor engineRunEdges
test("a goal whose set the handoff does not name is R3's, a stopped step 10 ends the run, and a new record file's expect is null", () => {
  assert.match(flat(subsection(theRun(), "R1.")), /goal whose set the handoff does not name[^.]*is R3's/);
  // Unless its filing began and a crash cut it short: R3 again could file the epic twice.
  assert.match(flat(subsection(theRun(), "R1.")), /is R3's, unless the handoff says this goal's filing has begun[^.]*`ask \{question\}` the operator/);
  assert.match(flat(subsection(theRun(), "R5.")), /The run ends when[^.]*or a step 10 that stopped/);
  const opening = flat(theRun().slice(0, theRun().indexOf("\n### R1.")));
  assert.match(opening, /every `replace` an `expect`[^.]*or `null` for a file that does not exist yet/);
});

// @anchor engineRunFollowUps
test("a follow-up is filed with track file, outside the set, and never worked", () => {
  const step = flat(subsection(theRun(), "R4."));
  for (const pin of [/`track \{verb: "file"/, /outside the set/, /never worked/, /naming it in a new run/]) assert.match(step, pin);
  // Nothing outside a goal's filing creates an item of the set.
  const creates = (text: string) => flat(text).split('track {verb: "create"').length - 1;
  assert.equal(creates(theRun()), creates(subsection(theRun(), "R3.")), "only R3 creates items");
});

// @anchor engineRunStopShort
test("an item that stops before merge after a review found a follow-up: the follow-up is filed at the run's end, and the item is not closed", () => {
  assert.match(flat(subsection(theRun(), "R2.")), /stops short of step 9's passing suite[^.]*ends the run by R5/);
  assertInOrder(flat(subsection(theRun(), "R5.")), ["File every follow-up found and not yet filed", 'track {verb: "file"',
    "An unfinished item stays in progress", "never close"], "the run's R5");
  // Two closes in the run, each of its own id: R2's of the item, after its merge and suite, and
  // R5's of the run's epic once every item is closed. No other close exists, so an item that
  // stopped short stays in progress; a close of any other id, or a third close, fails here.
  const closes = flat(theRun()).split('track {verb: "close"').slice(1).map((after) => /^, id: <([^>]*)>/.exec(after)?.[1]);
  assert.deepEqual(closes, ["the item", "the epic"], "R2 closes the item and R5 only the run's epic");
});

// @anchor engineRunCloseEpic
test("a run that ends with every item closed closes its epic once show reports every child closed, and a list of ids or a stop closes none", () => {
  const step = flat(subsection(theRun(), "R5."));
  // After the follow-ups, filed outside the epic, and before the handoff and the report that carry its close.
  assertInOrder(step, ["File every follow-up found and not yet filed", "The run's epic — a goal's, from R3, or the one your brief names",
    "only when every item of the set is closed and no stop ended the run", 'track {verb: "show", id: <the epic>}',
    "once it reports every child closed", 'track {verb: "close", id: <the epic>', "The final handoff", "the epic's close among them"],
    "the run's R5");
  assert.match(step, /A child it reports not closed leaves the epic open/);
  assert.match(step, /leaves the epic open, named in the handoff and your report/);
  assert.match(step, /list of ids has no epic, and a run that ended at a stop closes nothing here/);
});

// @anchor engineRunResume
test("a resumed lead finishes the bookkeeping of a merge whose suite it saw pass, and asks the operator about any state its session cannot establish", () => {
  const step = flat(subsection(theRun(), "R1."));
  for (const pin of [/your own session claimed it/, /merged and you saw its root suite pass[^.]*R2's steps 4 to 7/,
    /cannot establish[^.]*`ask \{question\}`/, /Never close it on your own/]) {
    assert.match(step, pin);
  }
});

// @anchor engineRunWithoutRecords
test("without records the loop calls neither tool", () => {
  const source = loop("dev-team-engine");
  const run = theRun();
  // Outside `## The run`, every unit that names a records tool says it is for `records` alone.
  const flagged = (text: string) => unitsOf(text).filter((unit) => RECORDS_CALL.test(unit) && !/`records`/.test(unit));
  const rest = source.replace(run, "");
  assert.deepEqual(flagged(rest), [], "units outside ## The run that name a records tool without naming records");
  const opening = flat(run.slice(0, run.indexOf("\n### R1.")));
  assert.match(opening, /only for a project whose `describe_mode` answers `records`/);
  assert.match(opening, /without `records` your brief is one task[^.]*neither `track` nor `record`/);
  for (const name of ["dev-team", "solo"]) assert.doesNotMatch(loop(name), RECORDS_CALL, `the ${name} loop`);
  // The guard bites: one unconditioned call outside the section is one flagged unit.
  assert.ok(source.includes("## 2. Plan\n\n"), "the anchor the mutation needs is still there");
  const mutated = rest.replace("## 2. Plan\n\n", "## 2. Plan\n\nFirst `track {verb: \"claim\", id: <the item>, message}`.\n\n");
  assert.equal(flagged(mutated).length, flagged(rest).length + 1, "the guard misses an unconditioned track call");
});

// @anchor leadRunReport
test("the lead's report adds the set, each outcome, the follow-ups filed and unfiled, and the commits", () => {
  const additions = ["the set and each item's outcome", "follow-ups filed", "unfiled", "record and tracker commit", "approved"];
  assertInOrder(flat(leadPrompt()), ["nobody verified", "`records`", ...additions], "the lead's report");
  // R5's `records` condition is `## The run`'s opening paragraph, which the test above checks.
  assertInOrder(flat(subsection(theRun(), "R5.")), additions, "the run's R5");
});

// @anchor leadEpicClose
test("the lead's prompt leaves the run's epic, which is no item, to R5's close, and its report carries that close", () => {
  // The prompt reaches the lead as its system instructions: its rule on closing an item must not
  // read as forbidding R5's close of an epic, which has no merge and no suite of its own.
  const lead = flat(leadPrompt());
  assert.match(lead, /never close an item whose merge and root suite you did not see pass[^.]*the run's epic is not an item[^.]*R5 closes it only on its own conditions/);
  assertInOrder(lead, ["record and tracker commit", "the epic's close among them", "approved"], "the lead's report");
});

// @anchor engineRunToolsOffered
test("every records tool the loop names is offered to the lead row when records are configured", () => {
  const tools = registryWithRecords("dev-team-engine");
  for (const name of ["track", "record"]) {
    assert.ok(tools.get(name)?.rows.includes("lead"), `${name} is offered to the lead row with a records block`);
    assert.equal(registry("dev-team-engine").has(name), false, `${name} is not registered without one`);
  }
  // Every name the loop or the lead's prompt spells as a call is a tool offered to the lead row.
  const unoffered = (text: string) => [...flat(text).matchAll(/`([a-z][a-z_]*) \{/g)]
    .map(([, name]) => name).filter((name) => !tools.get(name)?.rows.includes("lead"));
  for (const [where, text] of [["the engine loop", loop("dev-team-engine")], ["lead.md", leadPrompt()]]) {
    assert.deepEqual(unoffered(text), [], `${where} spells calls to tools the lead row is not offered`);
  }
  // And the check bites: a misspelled call is one it names.
  const ready = '`track {verb: "ready"}`';
  assert.ok(loop("dev-team-engine").includes(ready), "the anchor the mutation needs is still there");
  assert.deepEqual(unoffered(loop("dev-team-engine").replace(ready, '`trak {verb: "ready"}`')), ["trak"], "the check misses a misspelled call");
  let checked = 0;
  for (const [, call] of flat(loop("dev-team-engine")).matchAll(/`((?:track|record) \{[^`]*\})`/g)) {
    checked++;
    const name = call.slice(0, call.indexOf(" "));
    const keys = delegateKeys(call);
    const offered = Object.keys((tools.get(name)?.inputSchema as { properties?: object } | undefined)?.properties ?? {});
    for (const key of keys) assert.ok(offered.includes(key), `${call}: ${name} takes no ${key}`);
    if (name === "track") {
      const verb = /verb: "([a-z]+)"/.exec(call)?.[1] ?? "";
      assert.ok(Object.hasOwn(trackerVerbs, verb), `${call}: ${verb} is no tracker verb`);
      const { writes, placeholders } = trackerVerbs[verb as keyof typeof trackerVerbs];
      assert.deepEqual([...keys].sort(), ["verb", ...placeholders, ...(writes ? ["message"] : [])].sort(),
        `${call}: a ${verb} call spells its verb, every placeholder it takes${writes ? " and message" : ""}`);
    } else {
      assert.ok(["path", "changes,message"].includes(keys.join(",")), `${call}: a record call reads {path} or writes {changes, message}`);
    }
  }
  assert.ok(checked >= 8, `only ${checked} records calls found; the run spells more than that`);
});

// @anchor engineHostNoRecords
test("under engine placement with records the host makes no tracker call and writes no record", () => {
  const { rest, section } = engineSection();
  const text = flat(section);
  for (const pin of [/`records`/, /`records`, the epic, the list of tracker ids or the goal the user gave/,
    /never call[^.]*`track` or `record`/, /no tracker call and write no record/, /no `bd` and no `project-steward`/, /like any other ask/]) {
    assert.match(text, pin);
  }
  assert.doesNotMatch(rest, RECORDS_CALL, "the launcher outside its engine-placement section names no records tool");
});

// @anchor engineHostBookkeepingScope
test("under engine placement with records the host keeps nothing of its own accord at any point of the run, and what neither tool does is the user's", () => {
  // One scope, the launcher's, in the launcher and the operator guide alike: no bookkeeping of
  // the host's own accord, before, during or after the lead; the rest on the user's request.
  const section = flat(engineSection().section);
  const guide = flat(fs.readFileSync(path.join(repoRoot, "docs", "operator-guide.md"), "utf8"));
  for (const [where, text] of [["the launcher", section], ["the operator guide", guide]]) {
    assert.match(text, /of (your|its) own accord at any point of the run/, where);
    assert.match(text, /`bd remember`, a `project-steward` checkpoint or wrap, a sync(,| and) a push[^.]*(is|are) (the user's|yours)[^.]*explicit request/, where);
  }
  assert.doesNotMatch(guide, /while the run is the lead's/, "the guide's narrower scope is gone");
});

/** Every specialist prompt text, by where it lives: the five shared roles in both dev-team modes and both consults. */
function specialistPrompts(): Array<[string, string]> {
  const modes = builtInModesDir();
  return [
    ...["dev-team", "dev-team-engine"].flatMap((mode) => ["planner", "plan-reviewer", "implementer", "code-reviewer", "resolver"]
      .map((key) => [`${mode}'s ${key}`, fs.readFileSync(path.join(modes, mode, "roles", `${key}.md`), "utf8")] as [string, string])),
    ["the built-in consult role", findRole(loadMode(modes, "dev-team"), CONSULT_ROLE)?.prompt ?? ""],
    ["solo's consult.md", fs.readFileSync(path.join(modes, "solo", "roles", "consult.md"), "utf8")],
  ];
}

// @anchor specialistsLeaveBookkeeping
test("every specialist prompt leaves tracking, handoff and commit instructions to the session that runs the loop", () => {
  const sentence = "The project's task-tracking, handoff and commit instructions belong to the session that runs the loop, never to a specialist.";
  for (const [where, prompt] of specialistPrompts()) assert.ok(flat(prompt).includes(sentence), `${where} leaves the bookkeeping to the loop`);
  assert.equal(flat(leadPrompt()).includes(sentence), false, "the lead runs the loop: the bookkeeping is its own with records");
});

// @anchor specialistsPlainShell
test("every specialist prompt says to run plain shell commands and to split one a permission layer refuses", () => {
  const paragraph = 'Run plain shell commands: a program with its arguments and redirections, joined to the next by `;`, `&&` or `|`, and read an exit status with `echo "exit $?"`. Some engines\' permission layers may refuse, rather than run, a loop, a `$(…)` or `${…}` expansion, a heredoc, a `( … )` subshell, a leading `VAR=value` or `env`, or an `awk` program. Such a refusal says the permission was denied in "don\'t ask mode" and is not the command\'s result: split the command into plain ones — `sed -n` or `grep -n` in place of `awk`, one call per item in place of a loop — and report any that stays refused.';
  for (const [where, prompt] of specialistPrompts()) {
    assert.ok(flat(prompt).includes(paragraph), `${where} carries the plain-shell paragraph`);
  }
});

test("every tool the dev-team loop calls is offered to the row its placement runs the loop in", () => {
  assertToolsExist(loop("dev-team"), "dev-team", "operator", "the dev-team loop");
  assertToolsExist(loop("dev-team-engine"), "dev-team-engine", "lead", "the engine-placed dev-team loop");
  assertToolsExist(loop("solo"), "solo", "operator", "the solo loop");
});

test("both dev-team loops name the journal step each of their git calls completes", () => {
  for (const name of ["dev-team", "dev-team-engine"]) {
    const text = flat(loop(name));
    for (const step of ["worktree-created", "committed", "rebased", "merged", "tests-passed", "tested", "review-waived", "worktree-removed", "branch-deleted"]) {
      assert.match(text, new RegExp("`" + step + "`"), `the ${name} loop never says which call writes ${step}`);
    }
    // The gate's step is written before every round, and again on the way back from a rebase that moved the branch.
    const tested = loop(name).split("\n").find((line) => line.startsWith("| `tested` |"));
    assert.ok(tested !== undefined, `${name}: the journal table has a row for tested`);
    assert.match(tested, /step 7's gate[^|]*return from step 8/, name);
    assert.match(text, /`ok: false`/, `${name}: any refusal is a reconciliation trigger, whatever its exit code`);
  }
});

// @anchor loopsNameHostConfig
test("both dev-team loops and the launcher's one-shot name a host's project configuration wherever they say what the commit and the merge refuse", () => {
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
  // The one-shot a host commits and merges under `host` placement meets the same two refusals
  // (atc-s96.83).
  const phrase = "the merge refuses a branch carrying either directory";
  const found = launcher().split(/\n\s*\n/).map(flat).filter((text) => text.includes(phrase));
  assert.equal(found.length, 1, `the launcher: one paragraph says "${phrase}"`);
  for (const entry of hostConfigPaths) {
    assert.ok(found[0].includes("`" + entry), `the launcher: the paragraph saying "${phrase}" names ${entry}`);
  }
});

test("the solo loop is the short one and hands a one-shot that wrote to the launcher", () => {
  const text = flat(loop("solo"));
  assert.match(text, /worktree: true/);
  assert.match(text, /launcher/, "the merge policy belongs to the launcher now, for every mode");
  assert.doesNotMatch(text, /run_command \{which: "test", where: "root", slug\}/, "one copy of the merge policy, and it is the launcher's");
  assert.doesNotMatch(text, /\*\*critique\*\*/, "and one copy of the verbs");
  assert.match(text, /The setup skill writes the binding once/);
  assert.doesNotMatch(text, /cross-agent init/);
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

// @anchor consultScopeSentence
test("the consultant looks for the project in the directory it was given, reads beyond it what the brief needs, and changes files in its own worktree alone", () => {
  const modes = builtInModesDir();
  // The profiles restrict writes, not reads (P2, design section 3), so the prompt scopes
  // where the consultant looks for its project rather than claiming its reads are confined.
  for (const [where, prompt] of [
    ["the built-in consult role", findRole(loadMode(modes, "dev-team"), CONSULT_ROLE)?.prompt ?? ""],
    ["solo's consult.md", fs.readFileSync(path.join(modes, "solo", "roles", "consult.md"), "utf8")],
  ] as Array<[string, string]>) {
    const text = flat(prompt);
    assert.doesNotMatch(text, /You work in the directory you were given and nowhere else/, where);
    assert.match(text, /look for its files, its instructions and its code there, and search no directory above or beside it for them/, where);
    assert.match(text, /Read outside it only what the brief needs/, where);
    assert.match(text, /You change files in a task worktree of your own and nowhere else/, where);
    assert.match(text, /at the project root you are read-only/, where);
    assert.match(text, /you never run git/, where);
  }
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
    ["plan-reviewer", "You write no files and you delegate nothing; your final message is the review, and its last line is the VERDICT."],
    ["implementer", "You run no git command that writes: the session that delegated you commits what you leave. You delegate nothing; your final message is the report that commit is made from."],
    ["code-reviewer", "You write no files and you delegate nothing; your final message is the review, and its last line is the VERDICT."],
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
  const before = flat(sectionOf(launcher(), "Before delegating"));
  assert.match(before, /first line is `projectRoot`/);
  // An initialized sibling — a worktree or checkout with its own config — served by M stops.
  assert.match(before, /\*\*[Ss]top\*\*[^.]*initialized project other than `projectRoot`[^.]*\.cross-agent\/config\.json/);
  assert.match(before, /named a project and `projectRoot` is another/);
  // An uninitialized sibling proceeds, served by its main project, and the line says so,
  // but only where the project served is not the worktree the host is in: a bare
  // repository's worktree with no config discovers itself.
  assert.match(before, /\*\*[Pp]roceed\*\*[^.]*uninitialized worktree/);
  assert.match(before, /`projectRoot` is not the nearest directory at or above the working directory that holds a `\.git`, say so on the roster's first line: served by the main project at <projectRoot>; ask for setup here for a project of its own/);
  // A root the user named or confirmed in this session proceeds as asked, wherever the host
  // sits; a binding the environment alone holds confirms nothing and beside another
  // initialized project it is the stale case that stops.
  assert.match(before, /\*\*[Pp]roceed as asked\*\*[^.]*named or confirmed `projectRoot` in this session[^.]*`--project`[^.]*`CROSS_AGENT_PROJECT`[^.]*wherever/);
  assert.match(before, /config\.json` — and the user has not named or confirmed `projectRoot` in this session, or when the user named a project and `projectRoot` is another/);
  assert.match(before, /`CROSS_AGENT_PROJECT` found only in the environment[^.]*confirms nothing/);
  // Inside a task's worktree the line serves its root, and setup there refuses (`task-worktree`).
  assert.match(before, /[Ll]eave the setup advice out when the working directory lies under `projectRoot`'s `git\.worktreeDir`/);
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

/** A dev-team specialist's prompt, flattened; both team modes carry the same file, byte for byte. */
function rolePrompt(key: string): string {
  return flat(fs.readFileSync(path.join(builtInModesDir(), "dev-team", "roles", `${key}.md`), "utf8"));
}

/** The two loops of the team, which state every rule below alike. */
const teamLoops = ["dev-team", "dev-team-engine"];

// @anchor rosterBeforeDispatch
test("both dev-team loops check the roster before anything is dispatched: every role bound, the resolver too, or a stop naming the binding", () => {
  for (const mode of teamLoops) {
    const step = flat(sectionOf(loop(mode), "1. Root check"));
    for (const pin of [/`list_roles`/, /`binding: null`/, /resolver/, /which the setup skill adds once they confirm/]) assert.match(step, pin, `${mode}: ${pin}`);
    assert.doesNotMatch(step, /cross-agent init/, mode);
  }
  assert.match(flat(sectionOf(loop("dev-team"), "1. Root check")), /show the user the role/);
  assert.match(flat(sectionOf(loop("dev-team-engine"), "1. Root check")), /`ask \{question\}` the operator with the role/);
});

// @anchor planIteration
test("both dev-team loops iterate the plan review on its VERDICT line, up to limits.planReviewRounds, and say what the approved plan carries", () => {
  for (const mode of teamLoops) {
    const step = flat(sectionOf(loop(mode), "3. Plan review"));
    for (const pin of [/`VERDICT: no major issues`/, /`VERDICT: major issues`/, /`VERDICT: human decision`/,
      /verifies each finding before folding it/, /ADDRESSED, PARTLY or NOT/, /`limits\.planReviewRounds`/, /`review\.planReviewRounds`/,
      /no further review/, /neither counts toward the limit nor resets/, /"Issues" section/, /Anything else this step does not cover/]) {
      assert.match(step, pin, `${mode}: ${pin}`);
    }
    // A `major issues` round is counted before the planner is resumed, and its revision is reviewed again.
    const counted = step.indexOf("`major issues` —");
    assert.ok(counted > 0, `${mode}: step 3 says what a major issues round does`);
    assertInOrder(step.slice(counted),
      ["`major issues` —", "count first", "limits.planReviewRounds", "resume the planner the same way", 'delegate {role: "plan-reviewer"'], mode);
  }
});

// @anchor reviewGate
test("both dev-team loops gate every review round on a rebase and a tested head, seat every reviewer, and triage, fix, resolve or stop", () => {
  for (const mode of teamLoops) {
    const step = flat(sectionOf(loop(mode), "7. Code review"));
    assertInOrder(step, ['git_mutate {slug, args: ["rebase", <default>]}', 'run_command {which: "test", where: <worktree path>, slug}',
      'delegate {role: "code-reviewer", seat: <n>', 'delegate {role: "implementer"', 'delegate {role: "resolver"'], mode);
    for (const pin of [/checks the branch head out on its own/, /journals `tested`/, /refused while the worktree holds uncommitted changes/,
      /`VERDICT: no major issues`/, /`VERDICT: major issues`/, /`VERDICT: needs rebase`/, /`VERDICT: discard`/,
      /the server reads for itself/, /refuses the branch head unless every seat/, /two fix rounds/, /`review\.afterResolver`/,
      /`lead-decides`/, /`always-ask`/, /waive_review \{slug, commit: <the branch head>\}/, /one wrap-up fix/, /one more round;/,
      /Anything this step does not cover/]) {
      assert.match(step, pin, `${mode}: ${pin}`);
    }
  }
  const host = flat(sectionOf(loop("dev-team"), "7. Code review"));
  assert.match(host, /stop and ask the user/);
  assert.match(host, /cross-agent waive <slug> <commit>/);
  const engine = flat(sectionOf(loop("dev-team-engine"), "7. Code review"));
  assert.match(engine, /ask \{question\}/);
  assert.match(engine, /dispatch nothing until the answer/);
});

// @anchor afterResolverBeforeWrapUp
for (const mode of teamLoops) {
  test(`${mode} applies afterResolver to Minor-only leftovers under always-ask before wrap-up`, () => {
    const step = flat(sectionOf(loop(mode), "7. Code review"));
    const condition = 'Before the wrap-up route, apply `review.afterResolver` from `describe_mode`: `ask` and `lead-decides` when a Critical or Important row stands; `always-ask` when any row stands, Minor included.';
    assert.ok(step.includes(condition), `${mode}: afterResolver must cover Minor-only leftovers under always-ask before wrap-up`);
    assertInOrder(step, ['delegate {role: "resolver"', condition, 'A round with only Minor rows standing gets one wrap-up fix'], mode);
  });
}

// @anchor rebaseGate
test("both dev-team loops send a branch a rebase moved back through step 7's gate, and one it left alone on to the merge", () => {
  for (const mode of teamLoops) {
    const step = flat(sectionOf(loop(mode), "8. Rebase"));
    for (const pin of [/nobody tested or reviewed/, /step 7 again, from its gate/, /moved nothing[^.]*step 9/, /rebase", "--abort/]) {
      assert.match(step, pin, `${mode}: ${pin}`);
    }
  }
});

// @anchor mergeGuardsNamed
test("both dev-team loops name the merge's two guards where step 9 says what the merge refuses", () => {
  for (const mode of teamLoops) {
    const step = flat(sectionOf(loop(mode), "9. Merge"));
    assert.match(step, /`tested` step at the branch head/, mode);
    assert.match(step, /`review-waived` step names it/, mode);
  }
});

// @anchor noChangeCommit
test("both dev-team loops read the staged names before they commit, and skip a commit of nothing", () => {
  for (const mode of teamLoops) {
    const step = flat(sectionOf(loop(mode), "6. Commit what it left"));
    assertInOrder(step, ['git_mutate {slug, args: ["add", "-A", "--", ".", ":(exclude).cross-agent", ":(exclude).worktrees"]}',
      'git_mutate {slug, args: ["diff", "--cached", "--name-only"]}', 'git_mutate {slug, args: ["commit", "-m", <the implementer\'s summary>]}'], mode);
    assert.match(step, /nothing printed is nothing to commit/, mode);
  }
});

// @anchor scopeRule
test("a finding outside the task's acceptance is out of scope wherever it is judged: a follow-up that never blocks and changes nothing", () => {
  for (const mode of teamLoops) {
    for (const heading of ["3. Plan review", "7. Code review"]) assert.match(flat(sectionOf(loop(mode), heading)), /out of scope/, `${mode} step ${heading}`);
    assert.match(flat(sectionOf(loop(mode), "3. Plan review")), /never blocks/, mode);
  }
  for (const key of ["planner", "plan-reviewer", "implementer", "code-reviewer", "resolver"]) assert.match(rolePrompt(key), /out of scope/, key);
  for (const key of ["plan-reviewer", "code-reviewer"]) assert.match(rolePrompt(key), /never blocks/, key);
  for (const key of ["implementer", "resolver"]) assert.match(rolePrompt(key), /out of scope[^.]*changes? nothing/, key);
});

// @anchor convergenceMarks
test("every re-review marks each major finding carried, introduced or new, and both loops judge convergence by that mark", () => {
  const mark = /carried, introduced by the last (fold|fix) or newly noticed/;
  for (const key of ["plan-reviewer", "code-reviewer"]) assert.match(rolePrompt(key), mark, key);
  for (const mode of teamLoops) {
    for (const heading of ["3. Plan review", "7. Code review"]) {
      const step = flat(sectionOf(loop(mode), heading));
      assert.match(step, mark, `${mode} step ${heading}`);
      assert.match(step, /not converging\*?\*? when the major count did not fall, or most majors were introduced by the last (fold|fix)/, `${mode} step ${heading}`);
    }
  }
});

// @anchor limitDiagnosis
test("at a review limit both loops stop with the findings per round, a convergence verdict and four options, and recommend simplify when the rounds are not converging", () => {
  for (const mode of teamLoops) {
    for (const heading of ["3. Plan review", "7. Code review"]) {
      const step = flat(sectionOf(loop(mode), heading));
      for (const pin of [/findings per round/, /convergence verdict/, /fold and proceed/, /one more round/, /simplify/, /pause/,
        /recommend simplify when the rounds are not converging/]) {
        assert.match(step, pin, `${mode} step ${heading}: ${pin}`);
      }
    }
  }
});

// @anchor proportion
test("the planner plans the smallest change that meets the acceptance, and the plan reviewer asks for nothing beyond it", () => {
  const planner = rolePrompt("planner");
  assert.match(planner, /smallest change that meets the acceptance/);
  assert.match(planner, /as optional rather than planning it/);
  const reviewer = rolePrompt("plan-reviewer");
  assert.match(reviewer, /Do not ask for additions beyond the acceptance/);
  assert.match(reviewer, /optional follow-ups/);
});

// @anchor launcherSeats
test("the launcher spells a seat, has a team loop's resolver bound first, and says what the merge's guards ask of a one-shot", () => {
  const text = flat(launcher());
  for (const pin of [/one line per seat, `<role>#<seat>`/, /Add `seat`, 1-based/, /the same role, seat, cwd and brief/,
    /`review`, the loop's two settings/, /journals `tested`/, /checks out on its own/, /a one-shot needs no review/, /waive_review/,
    /does not add it/]) {
    assert.match(text, pin, `the launcher says ${pin}`);
  }
  // None of it orders a loop step outside `host` placement.
  assert.deepEqual(unconditionedSteps(engineSection().rest), []);
});

// The setup skill (`skills/setup/SKILL.md`, setup spec section 1): the second skill a host
// discovers, which sets a project up and later changes its setup by running the plugin's own
// CLI, `init --propose` and then `init --config -` once the user confirms. What a machine can
// check: the name a host matches, the CLI it runs and the options it passes, that it asks
// before every write and never has the user type a command, that no option carries what its
// message does not show, and that every answer the CLI gives has a next step.

const setupDir = path.join(repoRoot, "skills", "setup");
const setupFile = path.join(setupDir, "SKILL.md");
/** The plugin's own CLI, as the setup skill spells it: relative to its own directory, run directly. */
const SETUP_CLI = '"<skill-dir>/../../bin/cross-agent"';

/** The setup skill's text, without its frontmatter. */
function setupSkill(): string {
  return fs.readFileSync(setupFile, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** The code a document spells: each fenced block's body, then each inline span outside them, as one line each. */
function codeSpans(text: string): string[] {
  const blocks: string[] = [];
  const rest = text.replace(/^[ \t]*```[^\n]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm, (_fence, body: string) => {
    blocks.push(body);
    return "";
  });
  return [...blocks, ...[...rest.matchAll(/`([^`]+)`/g)].map(([, span]) => flat(span))];
}

/** One sentence per entry, read across the line wraps. */
function sentences(text: string): string[] {
  return flat(text).split(/(?<=[.!?])\s+/);
}

// The skill's text tells an agent what to do; these name a user who has to type a command.
const USER_TYPES = [
  /\b(?:ask|tell|have|let|get)\s+(?:the user|them)\s+to\s+(?:run|type|enter|paste|execute)\b/i,
  /\bthe user (?:runs|types|enters|pastes|should run|must run|needs to run)\b/i,
  /\b(?:in|from|open) (?:a|your|the) terminal\b/i,
];

/** The sentences of `text` that have the user type a command. */
function userTypes(text: string): string[] {
  return sentences(text).filter((sentence) => USER_TYPES.some((pattern) => pattern.test(sentence)));
}

// The consent rule `## Asking` opens with, before the first question: what waits for the
// user's own answer, what is never one, and what a session that cannot take one does. Each
// part is one whole sentence, so a part cut, moved out of `## Asking`, or hedged on either
// side is a gap.
const CONSENT: Array<[string, RegExp]> = [
  ["the rule opens ## Asking", /^ ## Asking - \*\*Wait for the user's answer\.\*\* /],
  ["what waits for the answer", /(?:^|[.*] )Every write \(`init --config`\), `git init`, and the `\.gitignore` add and commit run only on the user's own explicit answer to its question, given in this conversation\. /],
  ["what is never an answer", /(?:^|\. )A default, the recommended option or silence is never an answer\. /],
  ["a session that cannot take an answer", /(?:^|\. )When it fails, or this session cannot take an answer \(a single-turn or headless run\), ask in chat as numbered choices and end your turn\. /],
  ["a session that ends first", /(?:^|\. )A session that ends before the user answers has written nothing\. /],
];

/** Each part of the consent rule that `## Asking` does not state whole. */
function consentGaps(text: string): string[] {
  const asking = flat(sectionOf(text, "Asking"));
  return CONSENT.filter(([, sentence]) => !sentence.test(asking)).map(([part]) => part);
}

/** One question the skill asks: its words, its options, and the text the options are read against. */
interface Question { question: string; labels: string[]; unit: string }

/**
 * Every `Ask:` line of the skill outside `## Asking`, which states their form. Its unit is the
 * text from the nearest heading or numbered step at or above it to the `Ask:` itself, so a
 * blank line inside a step does not cut it, and the `Ask:` line's own words never count.
 */
function questions(text: string): Question[] {
  const lines = text.replace(sectionOf(text, "Asking"), "").split("\n");
  const found: Question[] = [];
  for (const [index, line] of lines.entries()) {
    const ask = /Ask: "([^"]+)" — options: (.*)$/.exec(line);
    if (ask === null) continue;
    let start = index;
    while (start > 0 && !/^#{1,6} |^\s*\d+\. /.test(lines[start])) start--;
    found.push({
      question: ask[1],
      labels: [...ask[2].matchAll(/\*([^*]+)\*/g)].map(([, label]) => label),
      unit: [...lines.slice(start, index), line.slice(0, ask.index)].join("\n"),
    });
  }
  return found;
}

// An answer that carries nothing to read: a label the message need not show.
const CONTENT_FREE = new Set(["Yes", "No", "Not now", "Cancel", "Looks right", "Change something", "Change something else",
  "Write it", "Replace it", "Yes, commit it"]);

/** Each label of `asked` that names a word of three letters or more its unit does not show, with those words. */
function unshownLabels(asked: Question[]): string[] {
  const unshown: string[] = [];
  for (const { question, labels, unit } of asked) {
    for (const label of labels) {
      if (CONTENT_FREE.has(label)) continue;
      const words = label.toLowerCase().replace(/[*`(),]/g, " ").split(/\s+/).filter((word) => word.length >= 3);
      const missing = words.filter((word) =>
        !new RegExp(`(?<![a-z0-9-])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`, "i").test(unit));
      if (missing.length > 0) unshown.push(`"${question}" offers "${label}", and its message never shows ${missing.join(", ")}`);
    }
  }
  return unshown;
}

/** Each code in `codes` that `section` does not name in backticks. */
function unnamedCodes(section: string, codes: Iterable<string>): string[] {
  return [...codes].filter((code) => !section.includes("`" + code + "`"));
}

/** Every refusal code `src/cli.ts` answers with, single words included. */
function cliRefusalCodes(): Set<string> {
  const source = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
  return new Set([...source.matchAll(/code: "([a-z]+(?:-[a-z]+)*)"/g)].map(([, code]) => code));
}

test("the setup skill's frontmatter names it setup, user-invocable, and its description carries the four triggers", () => {
  const source = fs.readFileSync(setupFile, "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source);
  assert.ok(frontmatter !== null, "a host reads the skill through its frontmatter");
  const fields = new Map(
    frontmatter[1].split("\n").filter((line) => /^\S/.test(line))
      .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()] as [string, string]),
  );
  assert.equal(fields.get("name"), "setup");
  assert.equal(fields.get("name"), path.basename(setupDir), "a host matches the skill by the name its directory carries");
  assert.equal(fields.get("user-invocable"), "true", "the user starts it by name");
  const description = fields.get("description") ?? "";
  for (const trigger of ["set up cross-agent", "configure the team", "change a role's model or engine", "change the test command"]) {
    assert.ok(description.includes(trigger), `the description names "${trigger}", or a host never loads the skill for it`);
  }
  // A plugin installed at user scope offers the skill in every project, where "change the test
  // command" is an ordinary request: every trigger is one about cross-agent.
  assert.match(description, /^Use when the user asks, about cross-agent, to /);
  assert.equal(fields.has("allowed-tools"), false, "the skill names no tool list");
});

test("the setup skill runs the plugin's own CLI from its directory, with only options init takes", async () => {
  const text = setupSkill();
  // Every spelling of the CLI is the plugin's own launcher, relative to this skill, run directly:
  // `bin/cross-agent` is a shell script, which `node` cannot run.
  const spelled = [...text.matchAll(/bin\/cross-agent/g)].length;
  const uses = [...text.matchAll(/"<skill-dir>\/\.\.\/\.\.\/bin\/cross-agent"([^`\n]*)/g)];
  assert.ok(uses.length >= 3, "the skill looks, writes and replaces through the CLI");
  assert.equal(uses.length, spelled, "every spelling of the CLI is the plugin's own, relative to the skill");
  for (const [use, after] of uses) {
    assert.ok(after === "" || after.startsWith(" init "), `the skill runs a verb other than init: ${use}`);
  }
  assert.doesNotMatch(text, /\bnode\s+"<skill-dir>/, "the launcher is run directly, never through node");
  assert.doesNotMatch(text, /`cross-agent [a-z]/, "no bare cross-agent verb, which only a PATH the user set up would find");
  const launcher = path.resolve(setupDir, "../../bin/cross-agent");
  assert.equal(launcher, path.join(repoRoot, "bin", "cross-agent"), "the path resolves to this plugin's launcher");
  assert.notEqual(fs.statSync(launcher).mode & 0o111, 0, `${launcher} is not executable`);

  // Every option it passes is one init's own usage names.
  let printed = "";
  const code = await runCli(["help", "--json"], repoRoot, { out: (chunk) => { printed += chunk; }, err: () => {} });
  assert.equal(code, 0);
  const usage = (JSON.parse(printed) as { verbs: Array<{ usage: string }> }).verbs.find((verb) => verb.usage.startsWith("cross-agent init "));
  assert.ok(usage !== undefined, "the CLI's help names init");
  const options = new Set([...usage.usage.matchAll(/--[a-z][a-z-]*/g)].map(([flag]) => flag).concat(["--json", "--project"]));
  for (const span of codeSpans(text)) {
    for (const [flag] of span.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)) {
      assert.ok(options.has(flag), `the skill passes ${flag}, which init does not take: ${span}`);
    }
  }
  for (const call of [`${SETUP_CLI} init --propose --json`, `${SETUP_CLI} init --config - --json`, "--replace --expect"]) {
    assert.ok(text.includes(call), `the skill runs ${call}`);
  }
  assert.doesNotMatch(text, /--mode\b|--from\b/, "the skill writes the document the user confirmed, never a mode's defaults");
});

test("the setup skill names each host's way to start it, its question tool, its reconnect step and its sandbox approval", () => {
  const rows = sectionOf(setupSkill(), "Hosts").split("\n").filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  assert.deepEqual(rows[0].slice(1), ["Claude Code", "Codex", "Grok"], "one column per host");
  const row = (name: string): string[] => {
    const found = rows.find((cells) => cells[0].startsWith(name));
    assert.ok(found !== undefined, `the hosts table has a ${name} row`);
    assert.equal(found.length, 4, `${name}: one cell per host`);
    for (const cell of found.slice(1)) assert.notEqual(cell, "", `${name}: every host has its own`);
    return found.slice(1);
  };
  const [claudeStart, codexStart, grokStart] = row("Start");
  assert.match(claudeStart, /`\/cross-agent:setup`/);
  assert.match(codexStart, /`\$`/);
  assert.match(grokStart, /`\/setup`/);
  const [claudeAsk, codexAsk, grokAsk] = row("Ask");
  assert.match(claudeAsk, /`AskUserQuestion`/);
  assert.match(codexAsk, /numbered choices/);
  assert.match(grokAsk, /`ask_user_question`/);
  const [claudeReconnect, codexReconnect, grokReconnect] = row("Reconnect");
  assert.match(claudeReconnect, /`\/mcp`[^|]*Reconnect/);
  assert.match(claudeReconnect, /`\/reload-plugins` does not restart the server/);
  assert.match(codexReconnect, /restart MCP servers[^|]*new chat/);
  assert.match(grokReconnect, /new session/);
  const [claudeApproval, codexApproval, grokApproval] = row("Approval");
  assert.match(claudeApproval, /sandbox/);
  assert.match(codexApproval, /escalated/);
  assert.match(grokApproval, /approval/);
});

test("the setup skill never tells the user to type a command, and the guard catches one that does", () => {
  const text = setupSkill();
  assert.deepEqual(userTypes(text), [], "sentences that have the user type a command");
  const base = userTypes(text).length;
  for (const mutation of ["Ask the user to run `git init`.", "Then the user types the command in a terminal."]) {
    assert.equal(userTypes(`${text}\n\n${mutation}\n`).length, base + 1, `the guard misses: ${mutation}`);
  }
  assert.match(flat(text), /You run every command/, "the skill says it runs every command itself");
});

test("the setup skill asks before every write and before its one commit, and every write ends in the same After a write", () => {
  const text = setupSkill();
  assertInOrder(sectionOf(text, "First setup"), ["*Looks right*", "--config -"], "First setup");
  assertInOrder(sectionOf(text, "Later changes"), ["*Write it*", "--replace --expect"], "Later changes");
  assertInOrder(sectionOf(text, "A config the server refuses"), ["*Replace it*", "--replace --expect"], "A config the server refuses");
  for (const heading of ["First setup", "Later changes", "A config the server refuses"]) {
    assert.ok(sectionOf(text, heading).includes("`## After a write`"), `${heading} ends in ## After a write`);
  }
  const commit = `git commit -m "chore: ignore cross-agent's state" -- .gitignore`;
  assertInOrder(sectionOf(text, "After a write"),
    ["`file`", "`warning`", "`ignored`", "Commit this .gitignore change now?", "`git add -- .gitignore`", "`" + commit + "`"], "After a write");
  assertInOrder(text, ["Make this folder a git repository now?", "`git init`"], "the skill");
  // The three it writes with, and the two reads that show what the commit will hold.
  const git = new Set(codeSpans(text).filter((span) => /^git(\s|$)/.test(span)));
  assert.deepEqual([...git].sort(),
    ["git add -- .gitignore", commit, "git diff HEAD -- .gitignore", "git ls-files -- .gitignore", "git init"].sort(), "the only git the skill runs");
  // A refused write has no `file` to report: only an exit 0 reaches After a write.
  const after = flat(sectionOf(text, "After a write"));
  assert.match(after, /once it exits 0/);
  assert.match(after, /exits otherwise follows `## Refusals` or `## When a step fails`, never this section/);
  // The skill's own `git init` leaves the user's files untracked, and a team loop's first step
  // stops on them: their first commit is the user's to ask for, before the connection check's
  // example request would meet that stop.
  assertInOrder(after, ["this setup ran `git init` in a folder that already held files", "`dev-team` or `dev-team-engine`",
    "a team task starts only from committed files", "first commit before the first team task", "if they ask", "`## Connection check`"],
  "After a write, past the skill's own git init");
  // Each answer that changes a proposal asks what to change, and each Cancel stops without writing.
  assert.match(flat(sectionOf(text, "First setup")), /On \*Change something\*, ask in plain words what to change/);
  assert.match(flat(sectionOf(text, "A config the server refuses")), /\*Change something\* goes as in step 4; \*Cancel\* stops without writing/);
});

test("the setup skill opens ## Asking, before any question, with its consent rule, and the guard catches the rule cut, moved or weakened", () => {
  // A single-turn Grok run whose question tool could not be answered took the recommended mode,
  // wrote the config and committed `.gitignore`: only the user's own answer lets a write run.
  const text = setupSkill();
  assert.deepEqual(consentGaps(text), [], "parts of the consent rule ## Asking does not state whole");
  const asking = sectionOf(text, "Asking");
  const end = text.indexOf(asking) + asking.length;
  const asks = [...text.matchAll(/^[ \t]*Ask: "/gm)];
  assert.equal(asks.length, questions(text).length, "every question the skill asks is an Ask: line");
  for (const ask of asks) {
    assert.ok((ask.index ?? 0) > end, `a question comes before the consent rule ends: ${text.slice(ask.index, ask.index + 60)}`);
  }
  // The rule cut, moved out of `## Asking`, hedged, weakened, given an exception, or going on
  // in a session that cannot take an answer: each is a gap the guard names.
  const rule = /^- \*\*Wait for the user's answer\.\*\*[\s\S]*?\n(?=- )/m.exec(text)?.[0] ?? "";
  const cut = text.replace(rule, "");
  const mutations: Array<[string, string, string]> = [
    ["cut", cut, "what waits for the answer"],
    ["moved", `${cut}\n${rule}`, "what is never an answer"],
    ["hedged before", text.replace(/Every\s+write\s+\(/, "Where it can, every write ("), "what waits for the answer"],
    ["weakened", text.replace(/is\s+never\s+an\s+answer\./, "is rarely an answer."), "what is never an answer"],
    ["exception added", text.replace(/is\s+never\s+an\s+answer\./, "is never an answer, unless the session cannot take one."),
      "what is never an answer"],
    ["recommended option dropped", text.replace(/A\s+default,\s+the\s+recommended\s+option\s+or\s+silence/, "A default or silence"),
      "what is never an answer"],
    ["goes on instead of stopping", text.replace(/and\s+end\s+your\s+turn\./, "and take the recommended option."),
      "a session that cannot take an answer"],
  ];
  for (const [how, mutated, part] of mutations) {
    assert.notEqual(mutated, text, `the ${how} mutation changes nothing`);
    assert.ok(consentGaps(mutated).includes(part), `the guard misses the rule ${how}: ${consentGaps(mutated).join(", ")}`);
  }
});

test("before the commit question the setup skill shows everything the commit will hold, setup's lines marked and anything else named", async (t) => {
  // `git add -- .gitignore` and the commit that follows take the whole file, edits the user
  // made before setup included, so the message shows the file's change since the last commit,
  // or the whole file where git has none: the user consents to what is committed.
  const text = setupSkill();
  const asked = questions(text).find((each) => each.question === "Commit this .gitignore change now?");
  assert.ok(asked !== undefined && sectionOf(text, "After a write").includes(asked.unit), "After a write asks to commit");
  const step = flat(asked.unit);
  assertInOrder(step, ["`ignored`", "`git diff HEAD -- .gitignore`", "whole file"], "the commit question's message");
  for (const pin of [/no commit yet/, /git does not track `\.gitignore` yet/, /[Mm]ark the `ignored` lines as setup's/,
    /anything else[^.]*say plainly that the commit holds it too/]) {
    assert.match(step, pin, `the commit question's message: ${pin}`);
  }
  assert.doesNotMatch(step, /git add|git commit/, "nothing is staged or committed before the answer");
  // An empty diff is also a tracked file that already matches the last commit: the index tells
  // it from an untracked one, and with nothing to commit there is no question.
  assertInOrder(step, ["prints nothing", "`git ls-files -- .gitignore`", "already matches the last commit"], "an empty diff");
  assert.match(step, /already matches the last commit: say no `\.gitignore` commit is needed/);

  // And git answers as the step says, in each state a setup meets.
  const reads = [...new Set(codeSpans(text).filter((span) => /^git (diff|ls-files) /.test(span)))].sort();
  assert.deepEqual(reads, ["git diff HEAD -- .gitignore", "git ls-files -- .gitignore"]);
  const repo = fs.mkdtempSync(path.join(tmpdir(), "setup-gitignore-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const run = (span: string) => {
    const [command, ...args] = span.split(" ");
    return spawnSync(command, args, { cwd: repo, encoding: "utf8", env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  };
  const [diff, listed] = [() => run(reads[0]), () => run(reads[1])];
  const gitignore = path.join(repo, ".gitignore");
  await git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(gitignore, "dist/\n.cross-agent/\n.worktrees/\n");
  assert.notEqual(diff().status, 0, "no commit yet: the diff fails, and the commit holds the whole file");
  await git(repo, "commit", "-q", "--allow-empty", "-m", "first");
  assert.deepEqual([diff().status, diff().stdout, listed().stdout], [0, "", ""],
    "an untracked .gitignore: both print nothing, and the commit holds the whole file");
  fs.writeFileSync(gitignore, "dist/\nbuild/\n");
  await git(repo, "add", "--", ".gitignore");
  await git(repo, "commit", "-q", "-m", "ignore");
  // The user dropped `build/` before setup, and setup appended its two lines.
  fs.writeFileSync(gitignore, "dist/\n.cross-agent/\n.worktrees/\n");
  const tracked = diff();
  assert.equal(tracked.status, 0, tracked.stderr);
  for (const line of [/^-build\/$/m, /^\+\.cross-agent\/$/m, /^\+\.worktrees\/$/m]) assert.match(tracked.stdout, line);
  // The committed file held setup's lines, the user had deleted them, and setup's append put
  // them back: the file matches the last commit again.
  await git(repo, "add", "--", ".gitignore");
  await git(repo, "commit", "-q", "-m", "setup");
  fs.writeFileSync(gitignore, "dist/\n");
  fs.writeFileSync(gitignore, "dist/\n.cross-agent/\n.worktrees/\n");
  assert.deepEqual([diff().status, diff().stdout, listed().stdout], [0, "", ".gitignore\n"],
    "tracked and unchanged: the diff prints nothing, git ls-files names the file, and nothing is left to commit");

  // A deletion staged before setup, and the working file put back: both reads miss it, so the
  // step says only that `.gitignore` needs no commit, never that nothing blocks the team —
  // loop step 1's `git status --porcelain` stops on the staged change.
  fs.writeFileSync(gitignore, "dist/\n");
  await git(repo, "add", "--", ".gitignore");
  fs.writeFileSync(gitignore, "dist/\n.cross-agent/\n.worktrees/\n");
  assert.deepEqual([diff().status, diff().stdout, listed().stdout], [0, "", ".gitignore\n"],
    "a staged deletion the working file undoes: the diff prints nothing and git ls-files names the file");
  assert.equal(await git(repo, "diff", "--cached", "--name-only"), ".gitignore", "and the index still holds a change");
  assert.doesNotMatch(step, /blocks the team/);
});

test("a step that needs a proposal checks it is available first, and otherwise shows its reason and follows Refusals", () => {
  // With every proposal unavailable — no engine found, or a default branch no mode accepts —
  // each `document` is null and step 3 has no mode to offer.
  const text = setupSkill();
  assertInOrder(flat(sectionOf(text, "A config the server refuses")), ["no proposal `available`", "`## Refusals`", "First setup steps 3 and 4"],
    "a refused config's replacement");
  const mode = /\*\*New mode\.\*\*[^*]*/.exec(flat(sectionOf(text, "Applying a change")));
  assert.ok(mode !== null, "Applying a change says how the mode changes");
  assert.match(mode[0], /only when it is `available`; otherwise show its `reason` and follow `## Refusals`/);
  assert.match(flat(sectionOf(text, "Later changes")), /proposal's binding for it[^.]*when that proposal is `available`/);
  assert.match(flat(sectionOf(text, "Refusals")), /Every proposal unavailable, or the one a change needs, while engines were found/);
});

test("the setup skill's options carry only what their message shows", () => {
  const text = setupSkill();
  const asked = questions(text);
  assert.equal(asked.length, 7, `the skill's questions: ${asked.map((each) => each.question).join(" | ")}`);
  for (const { question, labels } of asked) {
    assert.ok(labels.length >= 2 && labels.length <= 4, `"${question}" offers ${labels.length} options`);
    for (const label of labels) {
      assert.ok(label.length <= 40, `"${question}": "${label}" is longer than a host shows`);
      assert.doesNotMatch(label, /[`|]/, `"${question}": "${label}" carries code or a table`);
    }
  }
  assert.deepEqual(unshownLabels(asked), []);
  // An option naming what nobody showed, and a mode whose meaning was cut from its step.
  const commit = "*Yes, commit it* / *No*";
  assert.ok(text.includes(commit), "the commit question's options");
  assert.match(unshownLabels(questions(text.replace(commit, "*Yes, commit it* / *Use Grok at maximum effort*"))).join("\n"),
    /Use Grok at maximum effort/);
  const meaning = text.split("\n").filter((line) => line.includes("**Background team**"));
  assert.equal(meaning.length, 1, "the Background team's meaning is one line of step 3");
  assert.match(unshownLabels(questions(text.replace(`${meaning[0]}\n`, ""))).join("\n"), /Background team \(dev-team-engine\)/);
  const asking = flat(sectionOf(text, "Asking"));
  assert.match(asking, /in the message/);
  assert.match(asking, /never a preview, a table or a config/);
});

test("the launcher and the Codex setup guide send setting up or changing a team to the setup skill, never to init", () => {
  const section = flat(sectionOf(launcher(), "Setting up a team"));
  assert.match(section, /`<skill-dir>\/\.\.\/setup\/SKILL\.md`/);
  assert.equal(path.resolve(launcherDir, "../setup/SKILL.md"), setupFile, "the path is the setup skill beside the launcher");
  assert.match(section, /no `\.cross-agent\/config\.json`/, "a project with no config");
  assert.match(section, /change the team/, "and a change to one");
  assert.doesNotMatch(launcher(), /`cross-agent init/, "the launcher tells nobody to run init");
  const guide = flat(fs.readFileSync(path.join(launcherDir, "references", "codex-setup.md"), "utf8"));
  assert.match(guide, /setup skill/);
  assert.doesNotMatch(guide, /init --mode/);
  assert.match(guide, /Resolve `<skill-dir>` to the cross-agent skill's directory/);
});

// @anchor setupRefusalCodes
test("the setup skill names every refusal code init's setup calls answer with", () => {
  const codes = cliRefusalCodes();
  assert.ok(codes.has("unsupported"), "a code of one word is read too");
  assert.ok(codes.size >= 13, `only ${codes.size} codes read from src/cli.ts`);
  const refusals = sectionOf(setupSkill(), "Refusals");
  assert.deepEqual(unnamedCodes(refusals, codes), [], "codes the skill has no next step for");
  assert.deepEqual(unnamedCodes(refusals.replaceAll("`unsupported`", "unsupported"), codes), ["unsupported"]);
});

test("the setup skill says what to do with each finding that blocks or changes a proposal", () => {
  const text = flat(setupSkill());
  assert.match(text, /`existing\.tracked`/);
  assert.match(text, /`trackedReason`/);
  const refusals = flat(sectionOf(setupSkill(), "Refusals"));
  assert.match(refusals, /No engine found/);
  for (const link of ["https://claude.com/claude-code", "https://github.com/openai/codex", "https://x.ai/cli"]) {
    assert.ok(refusals.includes(link), `where to get an engine: ${link}`);
  }
  assert.match(refusals, /Every proposal unavailable/);
  for (const rule of [/git check-ref-format --branch accepts/, /does not start with `-`/, /is not `HEAD` or `@`/, /holds no `@\{`/, /`task\/\*`/]) {
    assert.match(refusals, rule, `the branch rule: ${rule}`);
  }
  assert.match(text, /`notes` verbatim/);
  // A role's engine may be found and still replaced: the team rule keeps a Grok writer out
  // while Claude or Codex is installed (`src/setup.ts#proposeMode`).
  assert.match(text, /not found, using Claude" when `engines\.<from>\.found` is false/);
  assert.match(text, /replaced by Claude, since Grok does not write while Claude or Codex is installed/);
  assert.match(text, /drops the <From> seat/);
  assert.match(text, /adds a <To> seat/);
  assert.match(text, /[Nn]ever show a substitution's seat number/);
  assert.match(text, /`copiedFrom`/);
  assert.match(flat(sectionOf(setupSkill(), "First setup")), /`existing\.mainCheckoutConfig\.fault`[^.]*starts fresh/);
});

test("the setup skill gives each built-in mode and each of its roles a one-line meaning", () => {
  const text = setupSkill();
  const step = questions(text).find((each) => each.question === "How should cross-agent work here?");
  assert.ok(step !== undefined && sectionOf(text, "First setup").includes(step.unit), "First setup asks for the mode");
  const modes = fs.readdirSync(builtInModesDir()).filter((name) => fs.existsSync(path.join(builtInModesDir(), name, "mode.json")));
  assert.deepEqual(modes.sort(), ["dev-team", "dev-team-engine", "solo"]);
  const roles = sectionOf(text, "Roles");
  for (const mode of modes) {
    assert.ok(step.unit.includes("`" + mode + "`"), `the mode step says what ${mode} means before it asks`);
    for (const key of [...loadMode(builtInModesDir(), mode).roles.map((role) => role.key), CONSULT_ROLE]) {
      assert.ok(roles.includes("`" + key + "`"), `${mode}'s ${key} has no line in ## Roles`);
    }
  }
});

test("after a first setup or a reconnect the setup skill checks describe_mode and list_roles, refuses drift, ends with an example, and under Codex hands off to the connection setup", () => {
  const section = flat(sectionOf(setupSkill(), "Connection check"));
  assert.match(section, /first setup, whatever `reconnect` says/);
  for (const pin of [/`describe_mode`/, /`list_roles`/, /without error/, /`projectRoot` is `root`/, /the mode is the one written/,
    /no `warning`/, /`warning` means[^.]*old mode: give the reconnect step/, /not yet verified/, /`search_tool`/,
    /"Use the cross-agent dev team to/]) {
    assert.match(section, pin, `the connection check: ${pin}`);
  }
  assert.ok(section.includes("`<skill-dir>/../cross-agent/references/codex-setup.md`"), "the Codex connection setup, beside this skill");
  assert.ok(fs.statSync(path.resolve(setupDir, "../cross-agent/references/codex-setup.md")).isFile());
  // A folder outside git started no server, and `reconnect` cannot know it: after the skill's
  // own `git init`, the host reconnects first.
  assert.match(section, /when `reconnect` is true, or when this setup ran `git init`: give the host's reconnect step/);
  // A server that answers for another project or mode, with no warning, is not connected.
  for (const pin of [/\*\*Another project or mode\*\* answering with no `warning`/, /which `projectRoot` and mode answered[^.]*not verified/,
    /Under Codex, offer the hand-off below/, /`CROSS_AGENT_PROJECT` naming another project keeps serving it[^.]*forwards that variable/,
    /\*Not now\* leaves the connection not verified/, /\*\*End\*\*, once connected,/]) {
    assert.match(section, pin, `a server for another project or mode: ${pin}`);
  }
});

// @anchor setupShowsRecords
test("the setup skill shows the records block before it asks", () => {
  // The background team's proposal may carry a `records` block (`src/setup.ts#detectRecords`):
  // the user sees every file and command it names before the write, and can change or drop it.
  const text = setupSkill();
  const asked = questions(text).find((each) => each.question === "Does this look right?");
  assert.ok(asked !== undefined, "First setup asks about the proposal");
  const unit = flat(asked.unit);
  for (const pin of ["the `document` has `records`, show it below the table", "`records.files`", "each tracker verb with its command",
    "`records.tracker.files`", "`record` and `track` tools"]) {
    assert.ok(unit.includes(pin), `the proposal's message: ${pin}`);
  }
  assertInOrder(sectionOf(text, "First setup"), ["`records`", "*Looks right*", "--config -"], "First setup");
  const applying = flat(sectionOf(text, "Applying a change"));
  assert.ok(applying.includes("whole `records` block dropped"), "a change may drop the block");
  const mode = /\*\*New mode\.\*\*[^*]*/.exec(applying);
  assert.ok(mode !== null && mode[0].includes("its `records` block where it has one"), "a new mode takes its proposal's block");
  assert.match(flat(sectionOf(text, "Later changes")), /config has no `records`[^.]*offer its block as a change/);
});

// @anchor setupChecksRecordsWarning
test("the setup skill's connection check reads describe_mode's records warning", () => {
  // A server started before the block came or went carries a `warning` in `describe_mode`
  // (`src/config.ts#recordsDrift`), with the mode and the root both as written.
  const section = flat(sectionOf(setupSkill(), "Connection check"));
  assert.ok(section.includes("both answers carry no `warning`"), "the check reads both answers' warnings");
  assert.match(section, /A `describe_mode` `warning` means[^.]*`records` block was added or removed: give the reconnect step/);
});

test("a change keeps what the user did not ask to change, and a mode change raises limits.maxDepth to the new mode's need, shown before → after", () => {
  const section = flat(sectionOf(setupSkill(), "Applying a change"));
  for (const pin of [/[Kk]eep the current `project`, `limits`, `review`, `billing` and `engines`/, /`limits\.maxDepth`/,
    /\(1 when the config sets none\)/, /raise it to the proposal's value/, /before → after/, /[Nn]ever lower `maxDepth`/,
    /takes the model and effort another role on that engine has/, /"sandbox": "workspace"/, /`lead` is never Grok/,
    // Claude and Codex have no `workspace` profile, so `--config` refuses a role that kept it.
    /role moved off Grok drops its `sandbox`, shown before → after/]) {
    assert.match(section, pin, `applying a change: ${pin}`);
  }
});

test("a config the server refuses gets a replacement proposal written with its own hash, apart from a valid config's unbound role", () => {
  const refused = flat(sectionOf(setupSkill(), "A config the server refuses"));
  for (const pin of [/`fault`/, /`existing\.config` is null/, /replacement/, /`[^`]*--replace --expect <existing\.sha256>`/]) {
    assert.match(refused, pin, `a refused config: ${pin}`);
  }
  const later = flat(sectionOf(setupSkill(), "Later changes"));
  assert.match(later, /unbound/);
  assert.match(later, /[Oo]ffer the proposal's binding for it/);
});

test("a permission failure may be the sandbox, gets one approved retry of that command alone, and every stop says the reason, the command and what is done", () => {
  const section = flat(sectionOf(setupSkill(), "When a step fails"));
  for (const word of ["`EROFS`", "`EACCES`", "`EPERM`", '"Read-only file system"', '"Permission denied"']) {
    assert.ok(section.includes(word), `a permission failure: ${word}`);
  }
  assert.match(section, /may be the host's sandbox/);
  assert.doesNotMatch(section, /is the host's sandbox/, "a permission error does not prove the sandbox caused it");
  for (const pin of [/only the failed command once more, with the host's approval/, /That one retry is all/,
    /Stop if it fails too, if the host offers no approval, or if the user declines/, /later command that writes `\.git` needs the same approval/,
    /stop, no retry/, /lock/, /hook/, /[Ee]very stop[^.]*reason[^.]*failed command[^.]*done/,
    /config is written and `\.gitignore` is changed but not committed/]) {
    assert.match(section, pin, `a failed step: ${pin}`);
  }
  assert.doesNotMatch(flat(setupSkill()), /nothing was written/i, "a refused write may still have touched git's info/exclude");
  // What setup says it writes is all it writes: `init --config` adds the same two entries to
  // git's local exclude file.
  assert.doesNotMatch(flat(setupSkill()), /nothing else/);
  assert.match(flat(sectionOf(setupSkill(), "First setup")), /two lines to `\.gitignore` and to git's local exclude file/);
});
