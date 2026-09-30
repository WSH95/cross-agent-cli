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
// cap are judged by the lead row, whose `delegate` is no offence. `--lead-role` renames that
// role and changes nothing else about a mode this repository ships; for a mode it does not
// ship, which is otherwise judged with no lead exempt and the config's limit alone, the
// flag also supplies the engine placement the verifier cannot read.
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
import { homedir } from "node:os";
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
// A shipped mode keeps its own placement, and the flag only renames its lead's role; a mode
// this repository does not ship has no placement to read, and the flag supplies an engine one.
const shippedPlacement = mode?.lead?.placement;
const placement = shippedPlacement ?? (namedLead !== undefined ? "engine" : undefined);
const placementCap = placement === undefined ? undefined : placement === "engine" ? 2 : 1;
const maxDepth = placementCap === undefined ? configuredDepth : Math.min(placementCap, configuredDepth);
const leadRole = placement === "engine" ? namedLead ?? mode?.lead?.role : undefined;
const capDetail = placementCap === undefined
  ? `mode ${modeName} is not one this repository ships: the cap is limits.maxDepth ${configuredDepth}, and no lead is exempt`
  : `cap ${maxDepth} = min(${shippedPlacement === undefined ? `--lead-role ${namedLead}` : modeName}'s ${placement} placement ${placementCap}, limits.maxDepth ${configuredDepth})`;
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
// What counts as a launch is what the deny list denies (`src/guard.ts#denyTargets`): a
// command whose word is `claude`, `codex`, `grok`, `cross-agent` or a binary this project
// configured under `engines.<e>.bin`, and `node` running `src/server.ts` or `src/cli.ts`.
// Which word is the command is a shell's question, so a small tokenizer answers it rather
// than a pattern (`launcherFor`, below): a pattern read either too little or too much of
// the line around a name. The tokenizer splits a command line into the simple commands a
// shell would run and judges each one's command word; how it does so is at `launcherFor`.
// Its verdict is `launch`, `pass`, or `?` for an engine named inside another language's
// inline code (`python3 -c`, `node -e`, `perl -e`, `ruby -e`), which no shell reading can
// tell from a mention and which is therefore never a pass.
//
// It is stricter than the deny list, on purpose. A deny rule is matched by the engine
// against the command it is asked to run (`Bash(claude *)`), by that engine's own matcher;
// this reads what ran, so an engine behind `sudo -u root`, `timeout -k 5 60`, `FOO=1`, an
// inner `bash -c`, `eval`, `find -exec`, `xargs` or `ssh` is an engine all the same.
const launch = launcherFor(config);
// Codex's `--json` is not the whole of what a Codex specialist ran: codex-cli 0.159.2
// wrote no item for the commands its sandbox denied, while its session rollout under
// `$CODEX_HOME/sessions/` recorded every call (A6, `docs/probes.md#codexCacheWritable`).
// So each Codex record's rollout, found by the record's `sessionId`, is read as well, and
// every command it shows attempted is judged like the transcript's own; a Codex record
// with no rollout to read is `?`, named.
const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
let rolloutFiles;
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
  const argvs = [];
  const unknownItems = [];
  // Codex announces an item and completes it under one id: one call, however many lines.
  const seenItems = new Set();
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
      // An id counts as seen once it has given its command or its call, so a start that
      // lacked one never hides the completion that carries it.
      const key = typeof item.id === "string" ? `${item.type}:${item.id}` : null;
      if (key !== null && seenItems.has(key)) continue;
      if (item.type === "command_execution" && typeof item.command === "string") commands.push(item.command);
      else if (item.type === "mcp_tool_call") calls.push(item.tool);
      else continue;
      if (key !== null) seenItems.add(key);
      continue;
    }
    // Everything else an engine says about itself — a session line, a hook, a rate-limit
    // notice, a result, a turn — carries no tool call and no command. The list of those
    // is closed: an unfamiliar top-level `type` is a shape this build has never seen, and
    // could be the very call the scan is looking for.
    if (knownEvents.has(event.type)) understood++;
    else unknownItems.push(String(event.type));
  }
  // A Codex record's rollout: the commands it shows attempted join the transcript's own.
  let rolloutGap;
  if (record.engine === "codex") {
    const files = typeof record.sessionId === "string" && record.sessionId !== "" ? rolloutsOf(record.sessionId) : [];
    if (files.length === 0) {
      rolloutGap = `no Codex session rollout for ${record.sessionId || "a record with no session id"} under ${path.join(codexHome, "sessions")}`;
    }
    for (const file of files) {
      const read = rolloutCommands(file);
      commands.push(...read.lines);
      argvs.push(...read.argvs);
      if (read.unreadable.length > 0 && rolloutGap === undefined) rolloutGap = `its rollout holds ${read.unreadable[0]}`;
    }
  }
  // What was read is judged first. An offence found has been read far enough to be an
  // offence, and an unread line beside it makes it no less true; `?` is for a transcript
  // that offended nowhere this tool could read, not for one that offended and also holds
  // a line it could not parse.
  const found = new Set();
  const uncertain = [];
  for (const name of calls) {
    if (!lead && isDelegate(name)) found.add(`${record.id.slice(0, 8)} called ${name}`);
  }
  // A launch is named by the simple command that decided, so one command the transcript and
  // its rollout both show — as Codex's `/bin/bash -lc '…'`, the script's `cmd` and the
  // item's argv — is named once.
  for (const judged of [...commands.map((command) => launch.judge(command)), ...argvs.map((argv) => launch.judgeArgv(argv))]) {
    if (judged.verdict === "launch") found.add(`${record.id.slice(0, 8)} ran ${judged.at}`);
    else if (judged.verdict === "?") uncertain.push(judged.at);
  }
  if (found.size > 0) { offences.push(...found); scanned++; continue; }
  if (uncertain.length > 0) {
    unreadable.push(`${record.id.slice(0, 8)}: inline code names an engine, which no shell reading can judge (${uncertain[0]})`);
    continue;
  }
  if (rolloutGap !== undefined) {
    unreadable.push(`${record.id.slice(0, 8)}: ${rolloutGap}`);
    continue;
  }
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

/**
 * The launcher judge. `judge(line)` reads a shell command line and `judgeArgv(words)` a
 * simple command already split into words (an argv an engine recorded); each answers
 * `{verdict: "launch" | "pass" | "?", at}`, `at` naming the simple command that decided.
 *
 * The line is cut into simple commands at `|`, `||`, `&&`, `;`, `&`, a newline, `(`, `)`
 * and a `{` or `}` standing alone, with single quotes, double quotes and backslashes
 * honoured, a comment dropped, a redirection's target never taken for a word, and the body
 * of every `$(…)`, backtick and `<(…)` judged as a command line of its own. In each simple
 * command it passes over leading `NAME=value` assignments (a quoted value is one word), the
 * reserved words that begin a command (`if`, `then`, `elif`, `else`, `while`, `until`,
 * `do`, `!`), and the wrappers that run the rest of the line — `sudo`, `doas`, `env`,
 * `exec`, `nohup`, `setsid`, `time`, `timeout` with its duration, `nice`, `command`,
 * `stdbuf`, `xargs` — with their options and the operands those options take, clustered or
 * not; `command -v` and `-V` only describe a command, and pass. The word it arrives at
 * decides by its basename: an engine's name or a configured binary is a launch; `node` is
 * one when its script — past its flags, with `--title`, `--env-file`,
 * `--env-file-if-exists`, `-C`, `--conditions` and `--input-type` holding their operands —
 * or a module it loads with `--import`, `-r`, `--require`, `--loader` or
 * `--experimental-loader` ends in `src/server.ts` or `src/cli.ts`. A shell (`sh`, `bash`,
 * `dash`, `zsh`, `ksh`, whatever its options) given `-c` has its payload judged as a line,
 * and so do `eval`'s arguments, the command `find` runs for `-exec`, `-execdir`, `-ok` and
 * `-okdir`, and the remote command of `ssh`. A heredoc's body and a here-string are the
 * command's stdin: a script for a shell or `ssh` with no command of its own, judged as a
 * line; program text for an interpreter with no script of its own; and data for anything
 * else. An interpreter's inline code that names an engine — `python3 -c`, `node -e` or
 * `-p`, `perl -e`, `ruby -e`, or a program it reads from stdin — is `?`. Anything else — a
 * word being printed, searched for or listed — passes.
 */
function launcherFor(settings) {
  const bins = Object.values(settings.engines ?? {}).map((engine) => engine?.bin)
    .filter((bin) => typeof bin === "string" && bin !== "");
  const basename = (word) => word.slice(word.lastIndexOf("/") + 1);
  const engineNames = new Set(["claude", "codex", "grok", "cross-agent", ...bins.map(basename)]);
  const binPaths = new Set(bins);
  const mentions = new RegExp(`(?:^|[^\\w-])(?:${[...engineNames, ...bins].map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})(?![\\w-])`);
  const shells = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
  const reserved = new Set(["if", "then", "elif", "else", "while", "until", "do", "!"]);
  // Each wrapper's options that take a separate operand; any other `-…` word is a flag.
  const wrappers = new Map([
    ["sudo", ["-u", "-g", "-C", "-c", "-D", "-p", "-R", "-r", "-T", "-t", "-U", "--user", "--group", "--close-from",
      "--login-class", "--chdir", "--prompt", "--chroot", "--role", "--command-timeout", "--type", "--other-user", "--host"]],
    ["doas", ["-u", "-C"]],
    ["env", ["-u", "-C", "--unset", "--chdir"]],
    ["exec", ["-a"]],
    ["nohup", []],
    ["setsid", []],
    ["time", ["-f", "-o", "--format", "--output"]],
    ["timeout", ["-s", "-k", "--signal", "--kill-after"]],
    ["nice", ["-n", "--adjustment"]],
    ["command", []],
    ["stdbuf", ["-i", "-o", "-e", "--input", "--output", "--error"]],
    ["xargs", ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--replace",
      "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"]],
  ]);
  const sshOperands = ["-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-P",
    "-p", "-Q", "-R", "-S", "-W", "-w"];
  const nodeLoaders = new Set(["--import", "-r", "--require", "--loader", "--experimental-loader"]);
  const nodeOperands = new Set(["--title", "--env-file", "--env-file-if-exists", "-C", "--conditions", "--input-type"]);
  const nodeInline = new Set(["-e", "--eval", "-p", "--print", "-pe", "-ep"]);
  const isEntryPoint = (word) => typeof word === "string" && /(?:^|\/)src\/(?:server|cli)\.(?:ts|js)$/.test(word);
  const pass = { verdict: "pass", at: "" };
  const rank = { pass: 0, "?": 1, launch: 2 };
  const worse = (left, right) => (rank[right.verdict] > rank[left.verdict] ? right : left);
  const shown = (words) => words.join(" ").slice(0, 80);
  const depthLimit = 8;

  /** Past the options of a getopt-style command: clusters, attached values, `--`. */
  function afterOptions(words, i, takes, dashAlone = false) {
    while (i < words.length) {
      const word = words[i];
      if (word === "--") return i + 1;
      if (word === "-" && dashAlone) { i++; continue; }
      if (!word.startsWith("-") || word === "-") return i;
      if (word.startsWith("--")) { i += !word.includes("=") && takes.includes(word) ? 2 : 1; continue; }
      // A cluster: the first letter that takes an operand takes the rest of the word, or
      // the next word when it is the last letter.
      let next = i + 1;
      for (let k = 1; k < word.length; k++) {
        if (takes.includes(`-${word[k]}`)) { if (k === word.length - 1) next = i + 2; break; }
      }
      i = next;
    }
    return i;
  }

  /**
   * A command line as the simple commands a shell would run — each its words and the text
   * its heredocs and here-strings hand it on stdin — and its substitutions' bodies.
   */
  function simpleCommands(text) {
    const commands = [];
    const substitutions = [];
    let current = { words: [], stdin: [] };
    let word = null;
    let target = null;
    const pending = [];
    function endWord() {
      if (word === null) return;
      const value = word;
      word = null;
      if (target === "herestring") { current.stdin.push(value); target = null; }
      else if (target === "heredoc") { pending.push({ ...heredocMark(value), owner: current }); target = null; }
      else if (target === "file") target = null;
      else if (value === "{" || value === "}") endCommand(false);
      else current.words.push(value);
    }
    function endCommand(finishWord = true) {
      if (finishWord) endWord();
      if (current.words.length > 0 || current.stdin.length > 0) commands.push(current);
      current = { words: [], stdin: [] };
    }
    // A heredoc's delimiter as the shell reads it: quotes removed, `<<-` stripping tabs.
    function heredocMark(value) {
      const strip = value.startsWith("\u0000-");
      return { delimiter: strip ? value.slice(2) : value, strip };
    }
    // At a newline, every heredoc opened on the line just ended takes its body, in order.
    function readHeredocs(from) {
      let k = from;
      for (const doc of pending.splice(0)) {
        const lines = [];
        while (k < text.length) {
          const newline = text.indexOf("\n", k);
          const line = text.slice(k, newline === -1 ? text.length : newline);
          k = newline === -1 ? text.length : newline + 1;
          if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
          lines.push(line);
        }
        doc.owner.stdin.push(lines.join("\n"));
      }
      return k;
    }
    const append = (value) => { word = (word ?? "") + value; };
    // The index of the `)` closing a `(` opened just before `start`, quotes skipped.
    const closeParen = (start) => {
      let depth = 1;
      for (let k = start; k < text.length; k++) {
        const c = text[k];
        if (c === "\\") k++;
        else if (c === "'") { const q = text.indexOf("'", k + 1); k = q === -1 ? text.length : q; }
        else if (c === '"') { k = closeDouble(k + 1); }
        else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) return k;
      }
      return text.length;
    };
    const closeDouble = (start) => {
      for (let k = start; k < text.length; k++) {
        if (text[k] === "\\") k++;
        else if (text[k] === '"') return k;
      }
      return text.length;
    };
    const closeBacktick = (start) => {
      for (let k = start; k < text.length; k++) {
        if (text[k] === "\\") k++;
        else if (text[k] === "`") return k;
      }
      return text.length;
    };
    const closeBrace = (start) => {
      let depth = 1;
      for (let k = start; k < text.length; k++) {
        if (text[k] === "\\") k++;
        else if (text[k] === "{") depth++;
        else if (text[k] === "}" && --depth === 0) return k;
      }
      return text.length;
    };
    // `$(…)`, `$((…))`, `${…}` and a backtick at `i`, inside or outside double quotes: the
    // index after it, with a command substitution's body collected for judging.
    const expansion = (i) => {
      if (text[i] === "`") {
        const end = closeBacktick(i + 1);
        substitutions.push(text.slice(i + 1, end).replace(/\\([`$\\])/g, "$1"));
        append("`…`");
        return end + 1;
      }
      if (text[i + 1] === "(") {
        const end = closeParen(i + 2);
        if (text[i + 2] === "(") append(text.slice(i, end + 1));
        else { substitutions.push(text.slice(i + 2, end)); append("$(…)"); }
        return end + 1;
      }
      const end = closeBrace(i + 2);
      append(text.slice(i, end + 1));
      return end + 1;
    };
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        if (text[i + 1] === "\n") { i += 2; continue; }
        append(text[i + 1] ?? ""); i += 2; continue;
      }
      if (c === "'") {
        const end = text.indexOf("'", i + 1);
        append(text.slice(i + 1, end === -1 ? text.length : end));
        i = end === -1 ? text.length : end + 1;
        continue;
      }
      if (c === '"') {
        append("");
        i++;
        while (i < text.length && text[i] !== '"') {
          if (text[i] === "\\" && "$`\"\\\n".includes(text[i + 1] ?? "")) {
            if (text[i + 1] !== "\n") append(text[i + 1]);
            i += 2;
          } else if (text[i] === "`" || (text[i] === "$" && (text[i + 1] === "(" || text[i + 1] === "{"))) {
            i = expansion(i);
          } else { append(text[i]); i++; }
        }
        i++;
        continue;
      }
      if (c === "`" || (c === "$" && (text[i + 1] === "(" || text[i + 1] === "{"))) { i = expansion(i); continue; }
      if (c === "#" && word === null) {
        const newline = text.indexOf("\n", i);
        i = newline === -1 ? text.length : newline;
        continue;
      }
      if (c === "\n") { endCommand(); i = pending.length > 0 ? readHeredocs(i + 1) : i + 1; continue; }
      if (c === ";" || c === "|" || c === "(" || c === ")") { endCommand(); i++; continue; }
      if (c === "&" && text[i + 1] !== ">") { endCommand(); i++; continue; }
      if (c === "<" || c === ">" || c === "&") {
        // A process substitution is a command. A redirection's operator is none: the word
        // after `<<` is a heredoc's delimiter, after `<<<` a here-string, and after any other
        // its file; a descriptor number before it belongs to it.
        if ((c === "<" || c === ">") && text[i + 1] === "(") {
          const end = closeParen(i + 2);
          substitutions.push(text.slice(i + 2, end));
          append("<(…)");
          i = end + 1;
          continue;
        }
        if (word !== null && /^\d+$/.test(word)) word = null;
        endWord();
        if (text.startsWith("<<<", i)) { target = "herestring"; i += 3; continue; }
        if (text.startsWith("<<", i)) {
          target = "heredoc";
          i += 2;
          if (text[i] === "-") { append("\u0000-"); i++; }
          while (text[i] === " " || text[i] === "\t") i++;
          continue;
        }
        let k = i + 1;
        while (k < text.length && "<>|".includes(text[k])) k++;
        if (text[k] === "&") {
          k++;
          while (k < text.length && /[\d-]/.test(text[k])) k++;
          i = k;
          continue;
        }
        target = "file";
        i = k;
        continue;
      }
      if (c === " " || c === "\t" || c === "\r") { endWord(); i++; continue; }
      append(c);
      i++;
    }
    endCommand();
    return { commands, substitutions };
  }

  function judge(text, depth = 0) {
    if (depth > depthLimit) return { verdict: "?", at: String(text).slice(0, 80) };
    const { commands, substitutions } = simpleCommands(String(text));
    let verdict = pass;
    for (const command of commands) verdict = worse(verdict, judgeArgv(command.words, depth, command.stdin));
    for (const body of substitutions) verdict = worse(verdict, judge(body, depth + 1));
    return verdict;
  }

  function judgeArgv(words, depth = 0, stdin = []) {
    if (depth > depthLimit) return { verdict: "?", at: shown(words) };
    // What a heredoc or here-string hands the command: a script to a shell or `ssh` that
    // has no command of its own, program text to an interpreter that has none, and data to
    // anything else.
    const script = stdin.join("\n");
    let i = 0;
    while (i < words.length && (reserved.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
    if (i >= words.length) return pass;
    const word = words[i];
    const name = basename(word);
    if (engineNames.has(name) || binPaths.has(word)) return { verdict: "launch", at: shown(words) };
    if (name === "command") {
      const options = [];
      let k = i + 1;
      while (k < words.length && words[k].startsWith("-") && words[k] !== "--") options.push(words[k++]);
      if (options.some((option) => /[vV]/.test(option))) return pass;
      return judgeArgv(words.slice(words[k] === "--" ? k + 1 : k), depth, stdin);
    }
    if (name === "env") {
      for (let k = i + 1; k < words.length && words[k].startsWith("-"); k++) {
        const split = words[k] === "-S" || words[k] === "--split-string" ? words[k + 1]
          : words[k].startsWith("--split-string=") ? words[k].slice(15) : words[k].startsWith("-S") && words[k].length > 2 ? words[k].slice(2) : undefined;
        if (split !== undefined) {
          const rest = words.slice(words[k] === "-S" || words[k] === "--split-string" ? k + 2 : k + 1);
          return judgeArgv([...(simpleCommands(split).commands[0]?.words ?? []), ...rest], depth + 1, stdin);
        }
      }
    }
    if (wrappers.has(name)) {
      let k = afterOptions(words, i + 1, wrappers.get(name), name === "env");
      if (name === "timeout") k++;
      return judgeArgv(words.slice(k), depth, stdin);
    }
    if (shells.has(name)) {
      let command = false;
      let k = i + 1;
      while (k < words.length) {
        const option = words[k];
        if (option === "--") { k++; break; }
        if (!/^[-+]/.test(option) || option.length < 2) break;
        if (option.startsWith("--")) { k += option === "--rcfile" || option === "--init-file" ? 2 : 1; continue; }
        if (option.startsWith("-") && option.includes("c")) command = true;
        k += /[oO]$/.test(option) ? 2 : 1;
      }
      if (command) return k < words.length ? judge(words[k], depth + 1) : pass;
      return k >= words.length && script !== "" ? judge(script, depth + 1) : pass;
    }
    if (name === "eval") return judge(words.slice(i + 1).join(" "), depth + 1);
    if (name === "find") {
      let verdict = pass;
      for (let k = i + 1; k < words.length; k++) {
        if (!["-exec", "-execdir", "-ok", "-okdir"].includes(words[k])) continue;
        const end = words.findIndex((value, index) => index > k && (value === ";" || value === "+"));
        const run = words.slice(k + 1, end === -1 ? words.length : end);
        verdict = worse(verdict, judgeArgv(run, depth + 1));
        k = end === -1 ? words.length : end;
      }
      return verdict;
    }
    if (name === "ssh") {
      const host = afterOptions(words, i + 1, sshOperands);
      if (host + 1 < words.length) return judge(words.slice(host + 1).join(" "), depth + 1);
      return script !== "" ? judge(script, depth + 1) : pass;
    }
    if (name === "node" || name === "nodejs") return nodeRun(words, i, script);
    if (/^python[\d.]*$/.test(name) || name === "perl" || name === "ruby") return inlineCode(name, words, i, script);
    return pass;
  }

  /** `node`: its inline code, the modules it loads, and the script it runs. */
  function nodeRun(words, i, script) {
    for (let k = i + 1; k < words.length; k++) {
      const word = words[k];
      if (word === "--") return isEntryPoint(words[k + 1]) ? { verdict: "launch", at: shown(words) } : pass;
      if (word === "-") return mentions.test(script) ? { verdict: "?", at: shown(words) } : pass;
      if (!word.startsWith("-")) return isEntryPoint(word) ? { verdict: "launch", at: shown(words) } : pass;
      const equals = word.indexOf("=");
      const option = equals === -1 ? word : word.slice(0, equals);
      const value = equals === -1 ? undefined : word.slice(equals + 1);
      if (nodeInline.has(option)) {
        const code = value ?? words[k + 1] ?? "";
        return mentions.test(code) ? { verdict: "?", at: shown(words) } : pass;
      }
      if (nodeLoaders.has(option)) {
        const operand = value ?? words[++k];
        if (isEntryPoint(operand)) return { verdict: "launch", at: shown(words) };
      } else if (nodeOperands.has(option) && value === undefined) k++;
    }
    // No script: the program is what stdin holds.
    return mentions.test(script) ? { verdict: "?", at: shown(words) } : pass;
  }

  /** Python's `-c`, Perl's `-e`/`-E` and Ruby's `-e`: code no shell reading can judge. */
  function inlineCode(name, words, i, script) {
    const letters = name === "perl" ? "eE" : name === "ruby" ? "e" : "c";
    const fromStdin = mentions.test(script) ? { verdict: "?", at: shown(words) } : pass;
    for (let k = i + 1; k < words.length; k++) {
      const word = words[k];
      if (word === "-") return fromStdin;
      if (!word.startsWith("-") || word === "--") return pass;
      if (name.startsWith("python") && (word === "-m" || word.startsWith("-m"))) return pass;
      const at = [...word.slice(1)].findIndex((letter) => letters.includes(letter));
      if (at === -1 || word.startsWith("--")) {
        if (name.startsWith("python") && ["-W", "-X", "-Q"].includes(word)) k++;
        continue;
      }
      const attached = word.slice(at + 2);
      const code = attached !== "" ? attached : words[k + 1] ?? "";
      return mentions.test(code) ? { verdict: "?", at: shown(words) } : pass;
    }
    return fromStdin;
  }

  return { judge: (line) => judge(line), judgeArgv: (argv) => judgeArgv(argv) };
}

/** Every rollout file under `$CODEX_HOME/sessions/` named for this Codex session. */
function rolloutsOf(sessionId) {
  if (rolloutFiles === undefined) {
    const root = path.join(codexHome, "sessions");
    try {
      rolloutFiles = readdirSync(root, { recursive: true }).map((name) => path.join(root, String(name)))
        .filter((file) => path.basename(file).startsWith("rollout-") && file.endsWith(".jsonl"));
    } catch {
      rolloutFiles = [];
    }
  }
  return rolloutFiles.filter((file) => file.endsWith(`-${sessionId}.jsonl`));
}

/**
 * The commands a Codex rollout shows attempted, whether or not they ran: the command lines
 * a code-mode `exec` script hands `tools.exec_command` (as `cmd`) or `tools.write_stdin`
 * (as `chars`), an older `shell`/`exec_command` function call's or a `local_shell_call`'s,
 * and the argv of every `CommandExecution` item and `exec_command_begin` event. What it
 * cannot read — a line that is not JSON, a command a script computes rather than writes —
 * is named, because it could be the command this scan is looking for.
 */
function rolloutCommands(file) {
  const read = { lines: [], argvs: [], unreadable: [] };
  let text;
  try { text = readFileSync(file, "utf8"); } catch (error) { read.unreadable.push(`an unreadable file (${error.code ?? error.message})`); return read; }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try { entry = JSON.parse(line); } catch { read.unreadable.push("a line that is not JSON"); continue; }
    const payload = entry?.payload ?? {};
    if (entry?.type === "response_item" && payload.type === "custom_tool_call" && payload.name === "exec") {
      const script = String(payload.input ?? "");
      for (const [call, key] of [["exec_command", "cmd"], ["write_stdin", "chars"]]) {
        for (const at of [...script.matchAll(new RegExp(`\\b${call}\\s*\\(`, "g"))].map((match) => match.index)) {
          const value = literalAfter(script, at, key);
          if (value === null) read.unreadable.push(`a ${call} call whose ${key} is computed`);
          else read.lines.push(value);
        }
      }
    } else if (entry?.type === "response_item" && payload.type === "function_call" && ["shell", "exec_command", "local_shell", "container.exec"].includes(payload.name)) {
      let args;
      try { args = JSON.parse(payload.arguments ?? "{}"); } catch { read.unreadable.push(`a ${payload.name} call whose arguments are not JSON`); continue; }
      if (typeof args?.cmd === "string") read.lines.push(args.cmd);
      else if (typeof args?.command === "string") read.lines.push(args.command);
      else if (Array.isArray(args?.command)) read.argvs.push(args.command.map(String));
      else read.unreadable.push(`a ${payload.name} call with no command`);
    } else if (entry?.type === "response_item" && payload.type === "local_shell_call") {
      if (Array.isArray(payload.action?.command)) read.argvs.push(payload.action.command.map(String));
      else read.unreadable.push("a local_shell_call with no command");
    } else if (entry?.type === "event_msg" && payload.type === "item_completed" && payload.item?.type === "CommandExecution") {
      if (Array.isArray(payload.item.command)) read.argvs.push(payload.item.command.map(String));
    } else if (entry?.type === "event_msg" && payload.type === "exec_command_begin" && Array.isArray(payload.command)) {
      read.argvs.push(payload.command.map(String));
    }
  }
  return read;
}

/**
 * The string literal a script passes as `key` in the object it hands the call at `at`, or
 * `null` when that value is anything but a literal: a JavaScript string in any of its three
 * quotes, a template only when it holds no substitution.
 */
function literalAfter(script, at, key) {
  const open = script.indexOf("{", at);
  if (open === -1) return null;
  const property = new RegExp(`(?:^|[{,\\s])["']?${key}["']?\\s*:\\s*`, "g");
  property.lastIndex = open;
  const match = property.exec(script);
  if (match === null) return null;
  let k = match.index + match[0].length;
  const quote = script[k];
  if (!["'", '"', "`"].includes(quote)) return null;
  let value = "";
  for (k++; k < script.length && script[k] !== quote; k++) {
    if (quote === "`" && script[k] === "$" && script[k + 1] === "{") return null;
    if (script[k] !== "\\") { value += script[k]; continue; }
    const next = script[++k];
    if (next === "n") value += "\n";
    else if (next === "t") value += "\t";
    else if (next === "r") value += "\r";
    else if (next === "0") value += "\0";
    else if (next === "x") { value += String.fromCharCode(parseInt(script.slice(k + 1, k + 3), 16)); k += 2; }
    else if (next === "u" && script[k + 1] === "{") { const end = script.indexOf("}", k); value += String.fromCodePoint(parseInt(script.slice(k + 2, end), 16)); k = end; }
    else if (next === "u") { value += String.fromCharCode(parseInt(script.slice(k + 1, k + 5), 16)); k += 4; }
    else if (next === "\n") continue;
    else value += next ?? "";
  }
  return k < script.length ? value : null;
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
