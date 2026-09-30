#!/usr/bin/env node
// The Verification section's "End-to-end under each host" list, checked against a project
// an end-to-end run has just finished in. Not product code and not a test: it reads a
// repository and a ledger and says what it found, so every end-to-end run of the plan's
// table, E1 to E7, is judged by the same eight checks rather than by whatever a report
// happened to grep that day.
//
//   node tools/e2e-verify.mjs --project <sample root> [--default-branch main]
//       [--slug <journal slug>] [--branch-pattern 'task/*']
//       [--test-command <command>] [--since <ISO date or task id>] [--lead-role <role>]
//
// The depth cap is the one the server ran under (`src/config.ts#effectiveMaxDepth`): the
// lower of the mode's own — 2 when its lead is engine-placed, 1 otherwise — and the
// config's `limits.maxDepth`, which is 1 when the file leaves it out, so config can only
// lower it. The mode is `config.mode` (the loader's `dev-team` when absent), read from this
// repository's `modes/`. Under an engine-placed lead, the lead's own records below that
// cap are judged by the lead row, whose `delegate` is no offence. `--lead-role` names that
// role for a mode this repository does not ship, which is otherwise judged with no lead
// exempt and the config's limit alone.
//
// `--slug` names the journal to judge; with none, the newest journal that opened a
// worktree is judged and the others are named in that row.
// `--since` narrows the records to one run: a task id counts every record created at or
// after that record's own `createdAt`. The test command defaults to the project's
// `.cross-agent/config.json` (`project.testCommand`).
//
// One line per check: `pass`, `FAIL`, or `?` where the evidence is missing rather than
// contradicted (no journal, no records, a log in a shape this cannot read), which is not
// the same thing and is never counted as a pass. Exit 0 only when every row passed, 1
// when any failed, 2 when any row had no evidence and none failed; a project that cannot
// be read at all exits 2 as well, with the reason on stderr.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parse(process.argv.slice(2));
const project = path.resolve(args.project ?? ".");
if (!existsSync(path.join(project, ".git"))) fail(`${project} is not a git repository`);

const config = readJson(path.join(project, ".cross-agent", "config.json")) ?? {};
const defaultBranch = args["default-branch"] ?? config.project?.defaultBranch ?? "main";
const branchPattern = args["branch-pattern"] ?? "task/*";
const testCommand = args["test-command"] ?? config.project?.testCommand;
// The cap and the lead row, as the header says. A mode this repository does not ship has
// no placement to read, so it is named in the depth row rather than guessed at.
const modeName = typeof config.mode === "string" && config.mode !== "" ? config.mode : "dev-team";
const mode = readJson(path.resolve(here, "..", "modes", modeName, "mode.json"));
const configuredDepth = config.limits?.maxDepth ?? 1;
const namedLead = args["lead-role"];
const placement = namedLead !== undefined ? "engine" : mode?.lead?.placement;
const placementCap = placement === undefined ? undefined : placement === "engine" ? 2 : 1;
const maxDepth = placementCap === undefined ? configuredDepth : Math.min(placementCap, configuredDepth);
const leadRole = namedLead ?? (placement === "engine" ? mode.lead.role : undefined);
const capDetail = placementCap === undefined
  ? `mode ${modeName} is not one this repository ships: the cap is limits.maxDepth ${configuredDepth}, and no lead is exempt`
  : `cap ${maxDepth} = min(${namedLead === undefined ? modeName : `--lead-role ${namedLead}`}'s ${placement} placement ${placementCap}, limits.maxDepth ${configuredDepth})`;
/** Whether a record is an engine-placed lead's own, below the cap, and so holds the lead row. */
const leadRow = (record) => leadRole !== undefined && record.role === leadRole && (record.depth ?? 0) < maxDepth;

const results = [];
function check(name, verdict, detail) {
  results.push({ name, verdict, detail });
  console.log(`${verdict === "pass" ? "pass" : verdict === "FAIL" ? "FAIL" : "?   "}  ${name}${detail ? `: ${detail}` : ""}`);
}

// 1-3. What git says about the repository the run left behind.
const worktrees = git("worktree", "list", "--porcelain").split("\n\n").filter(Boolean);
check("only the root worktree", worktrees.length === 1 ? "pass" : "FAIL",
  worktrees.length === 1 ? `${project}` : worktrees.map((entry) => entry.split("\n")[0]).join(", "));
const leftoverBranches = git("branch", "--list", branchPattern).split("\n").map((line) => line.trim()).filter(Boolean);
check(`no ${branchPattern} branch remains`, leftoverBranches.length === 0 ? "pass" : "FAIL", leftoverBranches.join(", "));
const status = git("status", "--porcelain", "--untracked-files=normal");
check("the working tree is clean", status.trim() === "" ? "pass" : "FAIL", status.trim().split("\n").slice(0, 5).join(" | "));

// 4. The suite on the default branch, where the merge put the work.
const head = git("rev-parse", "--abbrev-ref", "HEAD");
if (testCommand === undefined || testCommand === "none") {
  check(`the suite on ${defaultBranch}`, "?", "no project.testCommand to run");
} else if (head !== defaultBranch) {
  check(`the suite on ${defaultBranch}`, "FAIL", `HEAD is on ${head}`);
} else {
  try {
    execFileSync("sh", ["-c", testCommand], { cwd: project, stdio: "pipe", encoding: "utf8" });
    check(`the suite on ${defaultBranch}`, "pass", testCommand);
  } catch (error) {
    check(`the suite on ${defaultBranch}`, "FAIL", `${testCommand}: ${String(error.stderr ?? error.message).trim().split("\n").slice(-3).join(" | ")}`);
  }
}

// 5-7. The ledger: one record per delegation with its native log, every depth under the
// cap, and the journal of the run's own git steps.
const tasksDir = path.join(project, ".cross-agent", "tasks");
const records = (existsSync(tasksDir) ? readdirSync(tasksDir) : [])
  .filter((name) => name.endsWith(".json") && !name.endsWith(".spec.json") && !name.endsWith(".outcome.json"))
  .map((name) => readJson(path.join(tasksDir, name)))
  .filter((record) => record !== null && typeof record.id === "string")
  .sort((a, b) => a.createdAt - b.createdAt);
const floor = since(records);
const run = records.filter((record) => record.createdAt >= floor);
if (run.length === 0) {
  check("one record per delegation, each with its native log", "?", `no records under ${tasksDir}`);
  check(`every record at depth <= ${maxDepth}`, "?", `no records; ${capDetail}`);
} else {
  const logless = run.filter((record) => !(existsSync(record.logPath) && statSync(record.logPath).size > 0));
  check("one record per delegation, each with its native log", logless.length === 0 ? "pass" : "FAIL",
    logless.length === 0 ? `${run.length} records` : logless.map((record) => record.id.slice(0, 8)).join(", "));
  const deep = run.filter((record) => (record.depth ?? 0) > maxDepth);
  check(`every record at depth <= ${maxDepth}`, deep.length === 0 ? "pass" : "FAIL",
    `${deep.length === 0 ? `${run.length} records` : deep.map((record) => `${record.id.slice(0, 8)}=${record.depth}`).join(", ")}; ${capDetail}`);
}

const journalDir = path.join(project, ".cross-agent", "journal");
const allJournals = (existsSync(journalDir) ? readdirSync(journalDir) : [])
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, at: statSync(path.join(journalDir, name)).mtimeMs, journal: readJson(path.join(journalDir, name)) }))
  .filter((entry) => entry.journal !== null)
  .sort((a, b) => b.at - a.at);
// A project accumulates journals — a cancelled one-shot, an interrupted run — and the
// documented command names no slug. So `--slug` judges the one it names, and without it
// the newest journal that opened a worktree is the run being judged; the rest are named
// in the row rather than failing it.
const opened = (entry) => Array.isArray(entry.journal.steps)
  && entry.journal.steps.some((step) => step?.step === "worktree-created");
const journals = args.slug === undefined
  ? allJournals.filter(opened).slice(0, 1)
  : allJournals.filter((entry) => entry.name === `${args.slug}.json`);
const setAside = allJournals.filter((entry) => !journals.includes(entry)).map((entry) => entry.name.replace(/\.json$/, ""));
// The loop's own table, in the order a finished task writes it. `git` and `rebased` may
// fall between any two — a commit that moved nothing and a rebase that replayed nothing
// are journaled as `git` — but a missing or out-of-order named step means the run did not
// do what the record claims.
const required = ["worktree-created", "committed", "merged", "tests-passed", "worktree-removed", "branch-deleted"];
if (journals.length === 0) {
  check("the journal shows every git step", "?", allJournals.length === 0
    ? `no journal under ${journalDir}`
    : `no journal opened a worktree (${allJournals.map((entry) => entry.name.replace(/\.json$/, "")).join(", ")})`);
} else {
  const judged = journals.map(({ name, journal }) => {
    const slug = name.replace(/\.json$/, "");
    if (!Array.isArray(journal.steps) || journal.steps.some((step) => typeof step?.step !== "string")) {
      return { slug, verdict: "?", detail: "not the journal schema" };
    }
    const written = journal.steps.map((step) => step.step);
    let at = -1;
    const missing = [];
    for (const step of required) {
      const found = written.indexOf(step, at + 1);
      if (found === -1) missing.push(step); else at = found;
    }
    return missing.length === 0
      ? { slug, verdict: "pass", detail: written.join(", ") }
      : { slug, verdict: "FAIL", detail: `missing or out of order: ${missing.join(", ")} (has ${written.join(", ") || "nothing"})` };
  });
  const worst = judged.some((entry) => entry.verdict === "FAIL") ? "FAIL"
    : judged.some((entry) => entry.verdict === "?") ? "?" : "pass";
  const aside = setAside.length === 0 ? "" : ` | not judged: ${setAside.join(", ")}`;
  check("the journal shows every git step", worst, judged.map((entry) => `${entry.slug}: ${entry.detail}`).join(" | ") + aside);
}

// 8. Every specialist transcript, by what it **called** rather than by what its text
// mentions — a Grok session's inherited slash commands include one named `delegate`, so
// the word proves nothing. Three shapes, because three engines write their own logs:
// Claude and Grok emit Anthropic-shaped `tool_use` blocks (Grok reaching an MCP tool
// through its `use_tool` dispatcher, which names the tool inside), and Codex emits items.
// An offence is `delegate` in any host's spelling or a shell command starting one of the
// three CLIs or `cross-agent`. The specialist row's own tools are not offences, whatever
// prefix a host gives them, and neither is anything an engine-placed lead's own record
// calls below the cap (its row holds `delegate`, `wait`, `cancel` and the rest) — though
// an engine launch is an offence there too. A log no parser here understands is evidence
// of nothing, and evidence of nothing is never a pass.
//
// Codex writes an MCP call as an item of type `mcp_tool_call` — `item.started`, then
// `item.completed` — whose `server` and `tool` are separate fields, `tool` being this
// server's own name for it (`list_roles`, `delegate`); I1's tracked Codex row recorded it
// (`docs/probes.md#i1CodexTracked`). Those items, `agent_message` and `command_execution`
// are the whole of what an archived Codex transcript holds, so any other item type is
// answered `?` rather than guessed at, and so is a tool call whose name is not a string.
const codexItems = new Set(["agent_message", "command_execution", "mcp_tool_call"]);
// Every non-item top-level `type` a recorded transcript holds, and where it was recorded:
// `system`, `assistant`, `user` and `result` in Claude's stream-json and Grok's
// streaming-messages-json (`docs/probes.md`'s native samples, and every archived task log
// of E1 and I1); `rate_limit_event` in those archived Claude logs, which the samples in
// `docs/probes.md` are too short to show; `error` in a failed Grok run (P8); and
// `thread.started`, `turn.started`, `turn.completed` and `turn.failed` in Codex's
// `--json` (`docs/probes.md`'s Codex sample, `src/engines/codex.ts#codex`). The list is
// closed on purpose — "any string type is noise" would let a whole unarchived shape pass
// on the strength of the lines around it, which is the opposite of the rule this tool is
// built on.
const knownEvents = new Set([
  "system", "assistant", "user", "result", "rate_limit_event", "error",
  "thread.started", "turn.started", "turn.completed", "turn.failed",
]);
// What counts as a launch is what the deny list denies (`src/guard.ts#denyTargets`): the
// command word `claude`, `codex`, `grok`, `cross-agent` or any binary this project
// configured under `engines.<e>.bin`, bare or path-qualified, and `node` running a path
// that ends `src/server.ts` or `src/cli.ts`, relative or absolute — AGENTS.md spells the
// server `node src/server.ts`, and the CLI is `package.json`'s `bin`. A command word is
// read wherever one can stand: at the start of the line; after `|`, `&`, `;`, `(`, `{`, a
// newline, a backtick or `$(`; at the start of the quoted argument of a shell's `-c` or of
// `eval`, which is how Codex runs everything (`/bin/bash -lc '…'`, P9, P10); and after any
// run of words that hand the rest of the line to a command — the shell's reserved words
// that begin one (`if`, `then`, `elif`, `else`, `while`, `until`, `do`, `!`), leading
// `VAR=value` assignments, and a fixed list of exec wrappers: `sudo`, `env`, `exec`,
// `nohup`, `setsid`, `time`, `nice`, `command`, `xargs` and `stdbuf`, each with any `-`
// flags after it, and `timeout` with its duration. A bare word is never an opener, quoted
// or not: `echo claude`, `ls /opt/wrapper`, `grep -rn "claude" …`, `grep node src/cli.ts`
// and `cat node src/cli.ts` name a word or a file, which is reading, and so do
// `not-claude`, `FOO=claude`, `~/.claude` and `.grok`. Between `node` and its path any
// number of node's own options may stand, each either a flag with an optional attached
// value or one of the options that take a separate operand — `--import`, `-r`,
// `--require`, `--loader`, `--experimental-loader`, `--env-file`, `--env-file-if-exists`,
// `-C`, `--conditions`, `--input-type`, `--title` — with its operand, that form tried
// first; a node running any other path is not this repository's. A name or a path ends at
// the end of the line, whitespace, `|`, `&`, `;`, `)`, a backtick or a quote.
//
// This is stricter than the deny list, on purpose, in its wrappers, assignments and
// reserved words. A deny rule is matched by the engine against the command it is asked to
// run (`Bash(claude *)`), by that engine's own matcher; this reads what ran, and an engine
// started behind `sudo`, `timeout 60` or `FOO=1` is an engine all the same.
const configuredBins = Object.values(config.engines ?? {})
  .map((engine) => engine?.bin)
  .filter((bin) => typeof bin === "string" && bin !== "");
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// Where a command word can stand, before any prefix words.
const COMMAND = "(?:^|[\\n|&;({`]|\\$\\(|(?:^|[\\s/])(?:(?:ba|da|k|z)?sh(?:\\s+-[A-Za-z]+)*\\s+-[A-Za-z]*c|eval)\\s+(?=['\"]))";
// Words that run the next one: reserved words, assignments, exec wrappers.
const WORD = "[^\\s'\"|&;]";
const PREFIX = `(?:(?:if|then|elif|else|while|until|do|!|[A-Za-z_][A-Za-z0-9_]*=${WORD}*`
  + `|(?:${WORD}*\\/)?(?:sudo|env|exec|nohup|setsid|time|nice|command|xargs|stdbuf)(?:\\s+-${WORD}*)*`
  + `|(?:${WORD}*\\/)?timeout(?:\\s+-${WORD}*)*\\s+${WORD}+)\\s+)*`;
const NODE_OPTIONS = "(?:\\s+(?:(?:--import|-r|--require|--loader|--experimental-loader|--env-file|--env-file-if-exists|-C|--conditions|--input-type|--title)\\s+[^\\s'\"|&;]+|--?[A-Za-z][\\w-]*(?:=[^\\s'\"]*)?))*";
const CLOSE = "(?=$|[\\s|&;)`'\"])";
const NAMES = ["claude", "codex", "grok", "cross-agent", ...configuredBins].map(escape).join("|");
const launcher = new RegExp(
  `${COMMAND}\\s*['"]?${PREFIX}(?:(?:${WORD}*\\/)?(?:${NAMES})`
  + `|(?:${WORD}*\\/)?node${NODE_OPTIONS}\\s+['"]?(?:[^\\s'"]*\\/)?src\\/(?:server|cli)\\.(?:ts|js))${CLOSE}`,
);
const isDelegate = (name) => typeof name === "string" && (name === "delegate" || name.endsWith("__delegate"));
const offences = [];
const unreadable = [];
const exempted = [];
let scanned = 0;
for (const record of run) {
  const lead = leadRow(record);
  if (lead) exempted.push(`${record.id.slice(0, 8)} (${record.role}, depth ${record.depth ?? 0})`);
  const log = record.logPath;
  if (!existsSync(log) || statSync(log).size === 0) {
    unreadable.push(`${record.id.slice(0, 8)}: no log`);
    continue;
  }
  const calls = [];
  const commands = [];
  const unknownItems = [];
  let understood = 0;
  let unparsable = 0;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try { event = JSON.parse(line); } catch { unparsable++; continue; }
    if (typeof event !== "object" || event === null) { unparsable++; continue; }
    // Claude and Grok: `assistant` turns carrying content blocks.
    const content = event.message?.content;
    if (Array.isArray(content)) {
      understood++;
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        if (block.name === "use_tool") {
          // Grok's dispatcher: the tool it is dispatching to is the call.
          calls.push(block.input?.tool_name ?? block.input?.tool ?? block.input?.name);
          continue;
        }
        calls.push(block.name);
        for (const key of ["command", "cmd"]) {
          if (typeof block.input?.[key] === "string") commands.push(block.input[key]);
        }
      }
      continue;
    }
    // Codex: items, one per completed step. An item type no archived run has shown is the
    // one thing this scan must not shrug at — it could be the very call it looks for.
    if (typeof event.type === "string" && event.type.startsWith("item.")) {
      const item = event.item ?? {};
      if (!codexItems.has(item.type)) { unknownItems.push(String(item.type)); continue; }
      if (item.type === "mcp_tool_call" && typeof item.tool !== "string") { unknownItems.push("mcp_tool_call without a tool"); continue; }
      understood++;
      if (item.type === "command_execution" && typeof item.command === "string") commands.push(item.command);
      if (item.type === "mcp_tool_call") calls.push(item.tool);
      continue;
    }
    // Everything else an engine says about itself — a session line, a hook, a rate-limit
    // notice, a result, a turn — carries no tool call and no command. The list of those
    // is closed: an unfamiliar top-level `type` is a shape this build has never seen, and
    // could be the very call the scan is looking for.
    if (knownEvents.has(event.type)) understood++;
    else unknownItems.push(String(event.type));
  }
  // What was read is judged first. An offence found has been read far enough to be an
  // offence, and an unread line beside it makes it no less true; `?` is for a transcript
  // that offended nowhere this tool could read, not for one that offended and also holds
  // a line it could not parse.
  let offended = false;
  for (const name of calls) {
    if (!lead && isDelegate(name)) { offences.push(`${record.id.slice(0, 8)} called ${name}`); offended = true; }
  }
  for (const command of commands) {
    if (launcher.test(command)) { offences.push(`${record.id.slice(0, 8)} ran ${command.slice(0, 60)}`); offended = true; }
  }
  if (offended) { scanned++; continue; }
  if (understood === 0 || unparsable > 0 || unknownItems.length > 0) {
    unreadable.push(unknownItems.length > 0
      ? `${record.id.slice(0, 8)}: event${unknownItems.length === 1 ? "" : "s"} this build cannot read (${[...new Set(unknownItems)].join(", ")})`
      : `${record.id.slice(0, 8)}: ${unparsable} line${unparsable === 1 ? "" : "s"} in no shape this reads`);
    continue;
  }
  scanned++;
}
const asLead = exempted.length === 0 ? "" : `; judged by the lead row: ${exempted.join(", ")}`;
check("no delegate call and no engine launch in any specialist transcript",
  offences.length > 0 ? "FAIL" : unreadable.length > 0 || scanned === 0 ? "?" : "pass",
  offences.length > 0 ? offences.slice(0, 5).join(" | ")
    : unreadable.length > 0 ? `${scanned} scanned; ${unreadable.slice(0, 3).join(" | ")}${asLead}`
      : `${scanned} transcripts${asLead}`);

const failed = results.filter((result) => result.verdict === "FAIL").length;
const unknown = results.filter((result) => result.verdict === "?").length;
console.log(`\n${results.length - failed - unknown} pass, ${failed} fail, ${unknown} without evidence`);
// Three verdicts, three statuses: a caller that reads only the status must not be able to
// mistake silence for success, which is the whole rule this tool is built on.
process.exit(failed > 0 ? 1 : unknown > 0 ? 2 : 0);

/** The `createdAt` every record of this run is at or after. */
function since(all) {
  if (args.since === undefined) return 0;
  const named = all.find((record) => record.id === args.since || record.id.startsWith(args.since));
  if (named !== undefined) return named.createdAt;
  const parsed = Date.parse(args.since);
  if (Number.isNaN(parsed)) fail(`--since ${args.since} is neither a task id of this project nor a date`);
  return parsed;
}

function git(...argv) {
  try {
    return execFileSync("git", ["-C", project, ...argv], { encoding: "utf8" }).replace(/\n$/, "");
  } catch (error) {
    fail(`git ${argv.join(" ")}: ${String(error.stderr ?? error.message).trim()}`);
  }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function parse(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (!list[i].startsWith("--")) fail(`unexpected argument ${list[i]}`);
    out[list[i].slice(2)] = list[++i];
  }
  return out;
}

function fail(reason) {
  console.error(`e2e-verify: ${reason}`);
  process.exit(2);
}
