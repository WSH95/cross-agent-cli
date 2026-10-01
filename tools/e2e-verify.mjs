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
// configured under `engines.<e>.bin`, and `node` running or loading `src/server.ts` or
// `src/cli.ts`. Which word is the command is a shell's question, so a tokenizer answers it
// (`launcherFor`, below, where its grammar is listed), under this contract:
// - On a named line, `pass` requires positive understanding of every construct and no
//   launch. A name is an engine, configured bin or src/server.ts / src/cli.ts entry point
//   anywhere in the raw text or decoded words, including nested quotes, assignments,
//   heredocs, here-strings, redirection targets and comments (`namesTarget`, `namesInList`).
// - Modeled constructs are decoded and judged: substitutions, `$'…'` (inside `${…}` too),
//   literal options and their operands, shell scripts on known stdin, interpreter code,
//   node loaders, ssh's command options, busybox applets and function bodies; a `[[ … ]]`,
//   `(( … ))` or subshell after `if`, `while` or `!` is read as at a command's start. `--`
//   ends option parsing; arguments after inline node code and `--` are data, not a script.
// - The data commands (`dataOnly`) account for their stdin and arguments as data, except
//   execution options, code-carrying assignments and arithmetic/subscript readers. Quoted
//   substitutions given to such builtins, or carried into arithmetic on the same line,
//   are `?`; `let` is unmodeled. Ordinary mentions printed or searched for still pass.
// - Assignments are inspected in prefixes, declaration builtins, env and env -S, with `=`
//   or `+=`: NODE_OPTIONS is read for loaders, PROMPT_COMMAND for commands, startup paths
//   and prompt templates for substitutions. Expanded values and unread named files are `?`.
// - Known stdin left unconsumed by a modeled reader is `?` if it names a target or judges
//   as a launch. Unknown stdin at a shell, wrapper (including sudo -s/-i and xargs) or
//   remote command is `?` on a named line; xargs builds argv rather than forwarding stdin.
//   A pipe into a `{ … }` or `( … )` group feeds every command in it; a later command reads
//   what the earlier ones left, so a launch it reads is `?`.
// - Unmodeled commands, expansions where a literal is needed, unknown options, malformed
//   syntax and other unsupported constructs are `?` on named lines. Malformed syntax,
//   case statements and engine-named functions cap the line at `?`; otherwise a modeled
//   launch takes precedence over a doubt.
// - Inline interpreter code naming a target is `?`: a shell reader cannot judge it.
//   Script files are not read. Stdin is an interpreter's program only with no script or a
//   script that is stdin (`-`, `/dev/stdin`); given to inline code, a module or a script
//   file it is input the code may read and run, consumed by nobody, so it is `?` when it
//   names a target or judges as a launch. Unnamed lines pass unless a modeled launch or the
//   recursion limit decides them; names assembled beyond the supported decoding are
//   outside this transcript audit.
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
// every command it shows attempted is judged like the transcript's own. The same contract
// holds there: a Codex record with no rollout to read, one whose rollout lacks a command
// the transcript shows, and one whose rollout holds a tool call this reader does not
// classify, including changed command-field shapes, are `?`, named. An output carrying a
// command is judged like the call; any other unclassified item with a field naming a tool,
// its arguments or a command, by any spelling, on it or one object below, is `?`. A
// code-mode script is tokenized as JavaScript (`scriptRead`); each exec_command/write_stdin
// direct call must give one object argument with a literal cmd/chars and no spread or
// computed key. The raw source and decoded token text are also inventoried: more
// occurrences of a command tool or delegate name than direct calls followed is `?`, even
// in comments or regexes, whose escapes are decoded for it. Aliases, eval/Function/import,
// legacy octal escapes, role-dependent slashes the reader cannot classify, and asides
// naming launches also answer `?`; a word after `.` or `?.` is a property, never a control
// keyword or one that opens a regular expression. This is a bounded reader, not
// JavaScript execution; a positively read launch still takes precedence.
const codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
// codex-cli 0.159.2's tools (A3's `ALL_TOOLS`): those that run a command, and those that run
// nothing — patches, goals, images, MCP resources, plugins, the web — which a rollout may
// show called without a command in them. A tool in neither list is one this build has not
// seen, and a call of it is `?`.
const commandTools = new Set(["shell", "exec_command", "local_shell", "container.exec"]);
const quietTools = new Set(["apply_patch", "clock__curr_time", "create_goal", "get_goal", "update_goal", "update_plan",
  "image_gen__imagegen", "list_mcp_resource_templates", "list_mcp_resources", "read_mcp_resource",
  "request_plugin_install", "view_image", "web__run"]);
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
  // A Codex record's rollout: the commands and calls it shows attempted join the
  // transcript's own; keystrokes a script wrote are judged as a command line too. Every
  // command the transcript shows has to be in it, or it is not this record's whole rollout.
  let rolloutGap;
  const asides = [];
  const patterns = [];
  const stdin = [];
  if (record.engine === "codex") {
    const files = typeof record.sessionId === "string" && record.sessionId !== "" ? rolloutsOf(record.sessionId) : [];
    if (files.length === 0) {
      rolloutGap = `no Codex session rollout for ${record.sessionId || "a record with no session id"} under ${path.join(codexHome, "sessions")}`;
    }
    const transcript = [...commands];
    const shown = { lines: [], argvs: [] };
    for (const file of files) {
      const read = rolloutCommands(file);
      commands.push(...read.lines, ...read.stdin);
      argvs.push(...read.argvs);
      calls.push(...read.calls);
      asides.push(...read.asides);
      patterns.push(...read.patterns);
      stdin.push(...read.stdin);
      shown.lines.push(...read.lines);
      shown.argvs.push(...read.argvs);
      if (read.unreadable.length > 0 && rolloutGap === undefined) rolloutGap = `its rollout holds ${read.unreadable[0]}`;
    }
    const missing = files.length === 0 ? undefined : transcript.find((command) => !rolloutShows(shown, command));
    if (missing !== undefined && rolloutGap === undefined) rolloutGap = `the transcript ran a command its rollout does not show (${missing.slice(0, 80)})`;
  }
  // What was read is judged first. An offence found has been read far enough to be an
  // offence, and an unread line beside it makes it no less true; `?` is for a transcript
  // that offended nowhere this tool could read, not for one that offended and also holds
  // a line it could not parse.
  // One offence, one entry: a call is keyed by its tool's own name — `delegate` from the
  // transcript's item, the rollout's item and a script's `tools.mcp__cross_agent__delegate(`
  // alike — and a launch by the simple command that decided, so one command the transcript
  // and its rollout both show, as Codex's `/bin/bash -lc '…'`, the script's `cmd` and the
  // item's argv, is named once.
  const found = new Map();
  const uncertain = [];
  for (const name of calls) {
    const tool = String(name).includes("__") ? String(name).slice(String(name).lastIndexOf("__") + 2) : String(name);
    if (!lead && isDelegate(name) && !found.has(`call ${tool}`)) found.set(`call ${tool}`, `${record.id.slice(0, 8)} called ${name}`);
  }
  for (const judged of [...commands.map((command) => launch.judge(command)), ...argvs.map((argv) => launch.judgeArgv(argv))]) {
    if (judged.verdict === "launch") found.set(`run ${judged.at}`, `${record.id.slice(0, 8)} ran ${judged.at}`);
    else if (judged.verdict === "?") uncertain.push(`${judged.why} (${judged.at})`);
  }
  if (found.size > 0) { offences.push(...found.values()); scanned++; continue; }
  // Then what could be an offence and cannot be read as one or as none, first named first.
  const doubts = [
    ...stdin.filter((chars) => launch.namesTarget(chars)).map((chars) =>
      `its rollout's script writes keystrokes naming an engine to a running process, and which program reads them the rollout does not say (${chars.trim().slice(0, 80)})`),
    ...uncertain,
    ...asides.map((text) => launch.judge(text)).filter((judged) => judged.verdict === "launch")
      .map((judged) => `its rollout's script names a launch it does not run, which cannot be told from one it does (${judged.at})`),
    ...patterns.filter((text) => launch.names(text) || launch.judge(text).verdict === "launch")
      .map((text) => `its rollout's script holds a regular expression naming an engine, which cannot be told from a command (${text.slice(0, 80)})`),
    ...(lead ? [] : asides.filter((text) => isDelegate(text)).map((text) =>
      `its rollout's script names ${text} in a string, which could be a call this reader cannot see`)),
    ...(rolloutGap === undefined ? [] : [rolloutGap]),
  ];
  if (doubts.length > 0) {
    unreadable.push(`${record.id.slice(0, 8)}: ${doubts[0]}`);
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
 * `{verdict, why, at}`: `launch`, `pass`, or `?` with `why` naming what could not be read
 * and `at` the text it was read from. The contract is the header's; the grammar is below.
 *
 * A line is read as bash reads it: simple commands at `|`, `|&`, `||`, `&&`, `;`, `;;`,
 * `&`, newlines, a subshell's `(` and `)`, and a `{` or `}` standing as a command word;
 * single quotes, double quotes, `$'…'` (decoded as bash decodes it), `$"…"` and backslashes;
 * comments; redirections, whose target is never a command word; heredocs and here-strings;
 * function definitions; `[[ … ]]` and `(( … ))`. Deferred arithmetic/subscript evaluation
 * is not performed: quoted substitutions at those readers are doubts on named lines.
 * Every `$(…)`, backtick and `<(…)`/`>(…)` is a command line of its own: in a word,
 * in double quotes, inside `${…}`, `$((…))` and `$[…]`, and in an unquoted heredoc's body;
 * a `$'…'` inside `${…}` is decoded too, so the names it spells count. What a command reads
 * on stdin is known: a heredoc's body, a here-string, a file, or the output of the command
 * piped into it, which is known text for `echo`, `printf` and `cat` of a heredoc, and
 * unknown for anything else. A pipe into a `{ … }` or `( … )` group feeds every command in
 * it: the first reads it whole, a later one only what the commands before it left.
 *
 * In each simple command, code-carrying assignments are judged by `assignmentCode`;
 * other leading assignments are data. Reserved words are passed over; the word left is the
 * command word. A command word an expansion supplies is known only by a literal basename
 * after its last slash; a brace expansion of a literal word is expanded; a glob is not
 * modeled. The command word's basename decides:
 * - an engine name, `cross-agent` or a configured binary: a launch;
 * - a data command (`dataOnly`, below): stdin and arguments are data except for code
 *   assignments, deferred subscripts, `rg --pre` and `sort --compress-program`;
 * - literal `git show <revision>:<path>` and `git grep` without options: object/path reads;
 * - an exec wrapper (`sudo`, `doas`, `env`, `exec`, `nohup`, `setsid`, `time`, `timeout`,
 *   `nice`, `command`, `stdbuf`, `xargs`): its options walked letter by letter, each operand
 *   an option takes consumed, and the command after them judged; `command -v` and `-V` only
 *   describe one; `env -S` splits its string into the command; `busybox`: its applet is the
 *   command word;
 * - a shell (`sh`, `bash`, `dash`, `zsh`, `ksh`, `ash`, `mksh`, `hush`, `busybox sh`): its
 *   options walked letter by letter (`-o` and `-O` taking the next word wherever they sit
 *   in a cluster); its `-c` payload, or with no script its stdin, judged as a line; a script
 *   file it runs is not read, and one an expansion names (`<(…)`, `$file`) is unmodeled;
 * - `eval`: its arguments judged as a line; `source` and `.`: a script file, as a shell's;
 * - `find`: the command each `-exec`, `-execdir`, `-ok` and `-okdir` runs;
 * - `ssh`: its options walked, the value of `-o ProxyCommand`, `LocalCommand`,
 *   `RemoteCommand` and `KnownHostsCommand` judged as a line, and the remote command, or
 *   with none its stdin, judged as a line;
 * - `node`: its options walked against node's own table (v24): a module `--import`,
 *   `--require`, `-r`, `--loader`, `--experimental-loader`, `--test-reporter` or
 *   `--test-global-setup` loads, before the first operand, or the script, ending in
 *   `src/server.ts` or `src/cli.ts`, is a launch; `-e`/`-p` code and a program on stdin are
 *   inline code;
 * - an interpreter (`python*`, `perl`, `ruby`, `awk` and its kin): options walked letter by
 *   letter against its own table; inline code (`-c`, `-e`, `-E`, an awk program or `-v`
 *   value, a program on stdin) that names an engine, `cross-agent`, a configured binary or
 *   an entry point is `?`; a script file is not read;
 * - for node and the interpreters alike, stdin is the program only when there is no script
 *   or the script is stdin (`-`, `/dev/stdin`, `/dev/fd/0`); to inline code, a module or a
 *   script file it is input the code may read and run, which no modeled reader consumes;
 * - `if`, `then`, `elif`, `else`, `while`, `until`, `do`, `!` and `{` are passed over, and a
 *   `[[ … ]]`, `(( … ))` or subshell after them is read as at a command's start; `for`
 *   and `select` lists are data; arithmetic and subscript readers carrying deferred
 *   substitutions are unmodeled.
 * A `case` statement and a function named like an engine change what later words mean, and
 * a line bash would refuse — an unterminated quote or substitution, a `(` where no command
 * starts, a `)` with no `(`, a redirection with no target — runs nothing as read here: on a
 * line that names an engine either is `?` whatever else the line holds. Anything else — an
 * unmodeled command word, a command word an expansion or a glob supplies, an option a walk
 * does not know, stdin of unknown content read as a script — is `?` on a line that names
 * a target anywhere in its raw text or decoded words (`namesInList`), unless the line
 * holds a launch. An unnamed line is outside the names gate, not proof that an engine
 * name could not have been assembled. Unconsumed named stdin is a doubt (`unreadInput`).
 * The recursion stops at eight levels, with `?`.
 */
function launcherFor(settings) {
  const bins = Object.values(settings.engines ?? {}).map((engine) => engine?.bin)
    .filter((bin) => typeof bin === "string" && bin !== "");
  const basename = (value) => value.slice(value.lastIndexOf("/") + 1);
  const engineNames = new Set(["claude", "codex", "grok", "cross-agent", ...bins.map(basename)]);
  const binPaths = new Set(bins);
  const isEngine = (value) => engineNames.has(basename(value)) || binPaths.has(value);
  const isEntryPoint = (value) => typeof value === "string" && /(?:^|\/)src\/(?:server|cli)\.(?:ts|js)$/.test(value);
  // A name as a word of its own: a run of word characters, dots and hyphens, its leading
  // hyphens and trailing dots dropped — `claude`, `/usr/bin/claude`, `ProxyCommand=claude`,
  // `${E:-claude}`, `s/x/claude/e` and the directory in `skills/cross-agent/SKILL.md` name
  // it; `.claude`, `claude.ts`, `claude-sonnet-5` and `not-claude` do not.
  const names = (text) => (String(text).match(/[\w.-]+/g) ?? [])
    .some((run) => engineNames.has(run.replace(/^-+/, "").replace(/\.+$/, "")));
  const namesTarget = (text) => names(text)
    || bins.some((bin) => String(text).includes(bin))
    || /(?:^|[^\w.-])(?:\.\/)?src\/(?:server|cli)\.(?:ts|js)(?![\w.-])/.test(String(text));
  const pass = { verdict: "pass", why: "", at: "" };
  const rank = { pass: 0, "?": 1, launch: 2 };
  const worse = (left, right) => (rank[right.verdict] > rank[left.verdict] ? right : left);
  const shown = (text) => String(text).replace(/\s+/g, " ").trim().slice(0, 80);
  const values = (words) => words.map((word) => word.value);
  const launchAt = (words) => ({ verdict: "launch", why: "", at: shown(values(words).join(" ")) });
  const doubt = (why, at) => ({ verdict: "?", why, at: shown(at) });
  // A word an engine recorded or a program an option names: literal, no shell reading it.
  const asWord = (value) => ({ value: String(value), shape: "\u0001".repeat(String(value).length), expansions: false, quoted: true });
  const unmodeled = "a construct this grammar does not model, beside an engine's name";
  const inline = "inline code names an engine, which no shell reading can judge";
  const depthLimit = 8;
  // Whether `ch` is one of `chars`: never for the nothing past a text's end.
  const oneOf = (chars, ch) => ch !== undefined && ch !== "" && chars.includes(ch);

  // These commands treat words/stdin as data except for the execution options,
  // code-carrying assignments and deferred subscripts checked by dataCommand.
  const dataOnly = new Set([
    ":", "[", "test", "true", "false", "echo", "printf", "cat", "tac", "head", "tail", "wc", "sort", "uniq",
    "cut", "tr", "paste", "join", "comm", "diff", "cmp", "nl", "fold", "fmt", "column", "expand", "unexpand",
    "rev", "od", "xxd", "hexdump", "strings", "base64", "base32", "md5sum", "sha1sum", "sha256sum", "sha512sum",
    "b2sum", "cksum", "seq", "shuf", "numfmt", "grep", "egrep", "fgrep", "rg", "jq", "tee", "ls", "stat", "file",
    "du", "df", "tree", "basename", "dirname", "realpath", "readlink", "pwd", "cd", "pushd", "popd", "dirs",
    "mkdir", "rmdir", "rm", "cp", "mv", "ln", "touch", "chmod", "chown", "chgrp", "mktemp", "truncate", "date",
    "sleep", "export", "unset", "set", "shift", "local", "declare", "typeset", "readonly", "read", "return",
    "exit", "break", "continue", "wait", "jobs", "kill", "pkill", "pgrep", "ps", "which", "type", "whereis",
    "printenv", "uname", "hostname", "id", "whoami", "groups", "nproc", "free", "uptime", "getconf", "locale",
    "iconv", "tput", "clear", "getopts", "shopt", "ulimit", "umask", "curl", "wget", "lsof", "ss",
    "netstat", "sync", "gzip", "gunzip", "zcat", "bzip2", "bunzip2", "xz", "unxz", "zstd", "unalias",
  ]);
  const shells = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "mksh", "hush"]);
  const declarations = new Set(["export", "declare", "typeset", "local", "readonly"]);
  const shellCodeVariables = new Set(["BASH_ENV", "ENV", "PROMPT_COMMAND", "PS0", "PS1", "PS2", "PS4"]);
  const substitutionsIn = (text) => /\$\(|`/.test(text);
  const shellFlags = "abefhiklmnprtuvxBCDEHPT";
  const shellLong = new Set(["--login", "--noprofile", "--norc", "--posix", "--restricted", "--verbose", "--version",
    "--help", "--debugger", "--dump-strings", "--dump-po-strings", "--noediting", "--pretty-print"]);
  const interpreters = /^(?:python[\d.]*|perl[\d.]*|ruby[\d.]*|awk|gawk|mawk|nawk)$/;
  // Getopt tables: `flags` take nothing; `values` take the rest of their word or, when that
  // is empty, the next word; `attached` take the rest of their word only; `digits` take the
  // digits after them; `code` letters take code as `values` do; a `long` option maps to
  // "flag", "value" (`--name value` or `--name=value`) or "optional" (`--name=value` only).
  const long = (flags, valued, optional = "") => Object.fromEntries([
    ...flags.split(" ").filter(Boolean).map((name) => [name, "flag"]),
    ...valued.split(" ").filter(Boolean).map((name) => [name, "value"]),
    ...optional.split(" ").filter(Boolean).map((name) => [name, "optional"]),
  ]);
  const wrapperSpecs = new Map([
    ["sudo", { flags: "AbBEeHhiKklNnPSsVv", values: "CDgpRrTtUu",
      long: long("--askpass --background --bell --edit --help --set-home --login --remove-timestamp --reset-timestamp --list --non-interactive --preserve-groups --shell --stdin --validate --version",
        "--user --group --close-from --chdir --login-class --prompt --chroot --role --type --command-timeout --other-user --host", "--preserve-env") }],
    ["doas", { flags: "nsL", values: "uC", long: {} }],
    ["env", { flags: "i0v", values: "uCS", long: long("--ignore-environment --null --debug --list-signal-handling --help --version",
      "--unset --chdir --split-string", "--block-signal --default-signal --ignore-signal") }],
    ["exec", { flags: "cl", values: "a", long: {} }],
    ["nohup", { flags: "", values: "", long: long("--help --version", "") }],
    ["setsid", { flags: "cfw", values: "", long: long("--ctty --fork --wait --help --version", "") }],
    ["time", { flags: "pvaq", values: "fo", long: long("--append --verbose --portability --quiet --help --version", "--format --output") }],
    ["timeout", { flags: "v", values: "sk", long: long("--foreground --preserve-status --verbose --help --version", "--signal --kill-after") }],
    ["nice", { flags: "", values: "n", long: long("--help --version", "--adjustment") }],
    ["stdbuf", { flags: "", values: "ioe", long: long("--help --version", "--input --output --error") }],
    ["xargs", { flags: "0prtxo", values: "aEdILnPs", attached: "ile", long: long("--null --interactive --no-run-if-empty --open-tty --verbose --exit --show-limits --help --version",
      "--arg-file --delimiter --max-args --max-procs --max-chars --process-slot-var", "--eof --replace --max-lines") }],
    ["command", { flags: "pvV", values: "", long: {} }],
  ]);
  const sshSpec = { flags: "46AaCfGgKkMNnqsTtVvXxYy", values: "BbcDEeFIiJLlmOoPpQRSWw", long: {} };
  const sshCommands = new Set(["proxycommand", "localcommand", "remotecommand", "knownhostscommand"]);
  // node v24's own options (`node --help`): the modules a value loads, the code a value is,
  // the options taking a value, and those taking none.
  const nodeLoads = new Set(["--import", "-r", "--require", "--loader", "--experimental-loader", "--test-reporter", "--test-global-setup"]);
  const nodeCode = new Set(["-e", "--eval", "-p", "--print", "-pe", "-ep"]);
  const nodeValues = new Set(("-C --conditions --allow-fs-read --allow-fs-write --build-snapshot-config --cpu-prof-dir --cpu-prof-interval "
    + "--cpu-prof-name --diagnostic-dir --disable-proto --disable-warning --dns-result-order --env-file --env-file-if-exists "
    + "--experimental-config-file --experimental-sea-config --heap-prof-dir --heap-prof-interval --heap-prof-name "
    + "--heapsnapshot-near-heap-limit --heapsnapshot-signal --icu-data-dir --input-type --inspect-port --debug-port "
    + "--inspect-publish-uid --localstorage-file --max-http-header-size --max-old-space-size-percentage "
    + "--network-family-autoselection-attempt-timeout --openssl-config --redirect-warnings --report-dir --report-directory "
    + "--report-filename --report-signal --run --secure-heap --secure-heap-min --snapshot-blob --test-concurrency "
    + "--test-coverage-branches --test-coverage-exclude --test-coverage-functions --test-coverage-include --test-coverage-lines "
    + "--test-isolation --experimental-test-isolation --test-name-pattern --test-reporter-destination --test-rerun-failures "
    + "--test-shard --test-skip-pattern --test-timeout --title --tls-cipher-list --tls-keylog --trace-event-categories "
    + "--trace-event-file-pattern --trace-require-module --unhandled-rejections --use-largepages --v8-pool-size "
    + "--watch-kill-signal --watch-path").split(" "));
  const nodeFlags = new Set(("-c --check -h --help -i --interactive -v --version --abort-on-uncaught-exception --allow-addons "
    + "--allow-child-process --allow-wasi --allow-worker --build-snapshot --completion-bash --cpu-prof --disable-sigusr1 "
    + "--disallow-code-generation-from-strings --enable-etw-stack-walking --enable-fips --enable-network-family-autoselection "
    + "--enable-source-maps --entry-url --expose-gc --force-context-aware --force-fips --force-node-api-uncaught-exceptions-policy "
    + "--frozen-intrinsics --heap-prof --insecure-http-parser --inspect --inspect-brk --inspect-wait "
    + "--interpreted-frames-native-stack --jitless --node-memory-debug --openssl-legacy-provider --openssl-shared-config "
    + "--pending-deprecation --permission --preserve-symlinks --preserve-symlinks-main --prof --prof-process --report-compact "
    + "--report-exclude-env --report-exclude-network --report-on-fatalerror --report-on-signal --report-uncaught-exception "
    + "--test --test-force-exit --test-only --test-update-snapshots --throw-deprecation --tls-max-v1.2 --tls-max-v1.3 "
    + "--tls-min-v1.0 --tls-min-v1.1 --tls-min-v1.2 --tls-min-v1.3 --trace-deprecation --trace-env --trace-env-js-stack "
    + "--trace-env-native-stack --trace-exit --trace-promises --trace-sigint --trace-sync-io --trace-tls --trace-uncaught "
    + "--trace-warnings --track-heap-objects --use-bundled-ca --use-env-proxy --use-openssl-ca --use-system-ca --v8-options "
    + "--watch --watch-preserve-output --zero-fill-buffers --expose-internals").split(" "));
  // Python, Perl, Ruby and awk, each against its own `--help`.
  const pythonSpec = { flags: "bBdEhiIOPqRsSuvVx", values: "WX", code: "c", stop: "m",
    long: long("--help --help-env --help-xoptions --help-all --version", "--check-hash-based-pycs") };
  const perlSpec = { flags: "acnpsStTuUwWXhv", values: "I", attached: "ixCdDFMmV", digits: "0l", code: "eE",
    long: long("--help --version", "") };
  const rubySpec = { flags: "acdlnpsSvwyh", values: "CIEr", attached: "FiWxKT", digits: "0", code: "e",
    long: long("--verbose --version --help --copyright --jit --yydebug", "--enable --disable --encoding --external-encoding --internal-encoding --backtrace-limit --dump --crash-report --parser") };
  const awkSpec = { flags: "bcCgMnNOPrsStV", values: "FvfEeilL", attached: "dDop", long: {} };

  /**
   * One command list, read as bash reads it: its simple commands — each its words, the stdin
   * a heredoc, here-string, file or pipe gives it, and any function it defines — the lists
   * its substitutions hold, and what it could not read. `closer` is `)` for the body of a
   * `$(…)` or `<(…)`, which ends at its unmatched `)`, and "heredoc" for an unquoted
   * heredoc's body, whose expansions alone are read.
   */
  function lexList(text, start, closer) {
    const list = { text: "", commands: [], nested: [], problems: [], end: text.length, closed: closer === null,
      named: false, arithmetic: false, deferred: false };
    // A `{ … }` or `( … )` group a pipe feeds: every command in it reads that pipe, the
    // first one exactly, the rest after whatever came before them may have read.
    const groups = [];
    const newCommand = (pipeFrom) => {
      const group = pipeFrom === null ? groups.findLast((entry) => entry.pipeFrom !== null) : undefined;
      const shared = group !== undefined && group.used;
      if (group !== undefined) group.used = true;
      return { words: [], stdin: null, pipeFrom: pipeFrom ?? group?.pipeFrom ?? null, sharedStdin: shared,
        funcDef: undefined, arith: false, cond: false };
    };
    const openGroup = (kind, pipeFrom, used) => groups.push({ kind, pipeFrom, used });
    const closeGroup = (kind) => {
      const at = groups.findLastIndex((entry) => entry.kind === kind);
      if (at !== -1) groups.splice(at);
    };
    // Reserved words a `[[ … ]]`, `(( … ))` or subshell may follow at the start of a command.
    const reservedOnly = (words) => words.every((word) => !word.quoted && !word.expansions
      && ["if", "elif", "then", "else", "while", "until", "do", "!"].includes(word.value));
    let command = newCommand(null);
    let word = null;
    let redirect = null;
    const heredocs = [];
    let depth = 0;
    let i = start;

    const begin = () => { if (word === null) word = { value: "", shape: "", expansions: false, quoted: false }; };
    const literal = (chars, quoted) => {
      begin();
      word.value += chars;
      word.shape += quoted ? "\u0001".repeat(chars.length) : chars;
      if (quoted) word.quoted = true;
    };
    const expansion = (raw) => {
      begin();
      word.value += raw;
      word.shape += "\u0002".repeat(raw.length);
      word.expansions = true;
    };
    function applyRedirect(target) {
      if (namesTarget(target.value)) list.named = true;
      const op = redirect;
      redirect = null;
      if (op === "<<" || op === "<<-") {
        const stdin = { kind: "text", text: "", exact: true };
        heredocs.push({ owner: command, delimiter: target.value, quoted: target.quoted, strip: op === "<<-", stdin });
        command.stdin = stdin;
      } else if (op === "<<<") {
        command.stdin = { kind: "text", text: `${target.value}\n`, exact: !target.expansions };
        if (names(target.value)) list.named = true;
      }
      else if (op === "<" || op === "<>" || op === "<&") command.stdin = { kind: "unknown", what: `${op} ${target.value}` };
    }
    function finishWord() {
      if (word === null) return;
      const done = word;
      word = null;
      if (namesTarget(done.value)) list.named = true;
      if (done.quoted && !done.expansions && substitutionsIn(done.value)) list.deferred = true;
      if (redirect !== null) { applyRedirect(done); return; }
      const plain = !done.quoted && !done.expansions;
      if (command.cond) {
        if (plain && done.value === "]]") command.cond = false;
        command.words.push(done);
        return;
      }
      if (command.words.length === 0 && plain && done.value === "{") {
        openGroup("{", command.pipeFrom, false);
        endCommand();
        return;
      }
      if (command.words.length === 0 && plain && done.value === "}") { closeGroup("{"); endCommand(); return; }
      // `function name {`: the definition ends where its body starts.
      const [keyword, defined] = command.words;
      if (plain && done.value === "{" && command.words.length === 2 && !keyword.quoted && keyword.value === "function") {
        command.funcDef = defined.value;
        command.words = [];
        openGroup("{", null, false);
        endCommand();
        return;
      }
      if (plain && done.value === "[[" && reservedOnly(command.words)) command.cond = true;
      command.words.push(done);
    }
    function endCommand(pipe = false) {
      finishWord();
      if (redirect !== null) { list.problems.push("a redirection with no target"); redirect = null; }
      const done = command;
      if (done.words.length > 0 || done.funcDef !== undefined || done.stdin !== null || done.arith) list.commands.push(done);
      command = newCommand(pipe ? done : null);
    }
    // `$(…)` or `<(…)` whose body starts at `at`: a list of its own. The index after its `)`.
    function substitution(at) {
      const inner = lexList(text, at, ")");
      inner.text = text.slice(at, inner.end);
      list.nested.push(inner);
      if (!inner.closed) { list.problems.push("an unterminated command substitution"); return text.length; }
      return inner.end + 1;
    }
    // A backtick substitution at `at`: its body, `\``, `\\` and `\$` undone, a list of its own.
    function backtick(at) {
      let body = "";
      let k = at + 1;
      for (; k < text.length && text[k] !== "`"; k++) {
        if (text[k] === "\\" && oneOf("`\\$", text[k + 1])) { body += text[++k]; continue; }
        body += text[k];
      }
      const inner = lexList(body, 0, null);
      inner.text = body;
      list.nested.push(inner);
      if (k >= text.length) { list.problems.push("an unterminated backtick substitution"); return text.length; }
      return k + 1;
    }
    // `${…}`, `$((…))`, `$[…]` or an array's `(…)` from `k`, to the close it ends at, every
    // substitution inside it collected; -1 when it never closes.
    function scanTo(k, close, doubleContext = false) {
      let depth = 0;
      while (k < text.length) {
        const ch = text[k];
        if (ch === "\\") { k += 2; continue; }
        // `$'…'` in a parameter's word or an array's element is decoded as bash decodes it
        // (inside double quotes too: `extquote` is on by default), and its names count.
        if (ch === "$" && text[k + 1] === "'" && (close === "}" || close === ")")) {
          const decoded = decodeAnsiC(k);
          if (namesTarget(decoded.value)) list.named = true;
          if (!decoded.closed) return -1;
          k = decoded.end;
          continue;
        }
        if (ch === "'" && close !== "))" && !doubleContext) {
          const end = text.indexOf("'", k + 1);
          if (end === -1) return -1;
          k = end + 1;
          continue;
        }
        if (ch === '"') {
          k = doubleQuoted(k + 1, false);
          if (k === -1) return -1;
          continue;
        }
        if (ch === "`" || (ch === "$" && oneOf("({[", text[k + 1]))) {
          const end = expansionAt(k, doubleContext);
          if (end === -1) return -1;
          k = end;
          continue;
        }
        if (close === "))" || close === ")") {
          if (ch === "(") depth++;
          else if (ch === ")") {
            if (depth > 0) depth--;
            else if (close === ")") return k + 1;
            else return text[k + 1] === ")" ? k + 2 : -1;
          }
        } else {
          const open = close === "}" ? "{" : "[";
          if (ch === open) depth++;
          else if (ch === close) {
            if (depth > 0) depth--;
            else return k + 1;
          }
        }
        k++;
      }
      return -1;
    }
    // An expansion at `k` (`$…` or a backtick): the index after it, `k` when the `$` is a
    // plain character, -1 when it never closes.
    function expansionAt(k, doubleContext = false) {
      if (text[k] === "`") return backtick(k);
      const next = text[k + 1] ?? "";
      if (next === "(" && text[k + 2] === "(") {
        list.arithmetic = true;
        const end = scanTo(k + 3, "))");
        if (end === -1) list.problems.push("an unterminated arithmetic expansion");
        return end;
      }
      if (next === "(") return substitution(k + 2);
      if (next === "{" || next === "[") {
        if (next === "[") list.arithmetic = true;
        const end = scanTo(k + 2, next === "{" ? "}" : "]", doubleContext);
        if (end === -1) list.problems.push(`an unterminated \`$${next}\``);
        return end;
      }
      if (/[A-Za-z_]/.test(next)) {
        let j = k + 1;
        while (j < text.length && /\w/.test(text[j])) j++;
        return j;
      }
      if (/[\d@*#?$!-]/.test(next)) return k + 2;
      return k;
    }
    // A double-quoted string whose text starts at `k`: `\` escapes `$`, a backtick, `"`, `\`
    // and a newline, and expansions expand. In a heredoc's body a `"` is a character and the
    // text ends at the end. The index after the closing quote, -1 when it never closes.
    function doubleQuoted(k, building, heredoc = false) {
      while (k < text.length && (heredoc || text[k] !== '"')) {
        const ch = text[k];
        if (ch === "\\" && oneOf(heredoc ? "$`\\\n" : "$`\"\\\n", text[k + 1])) {
          if (building && text[k + 1] !== "\n") literal(text[k + 1], true);
          k += 2;
          continue;
        }
        if (ch === "$" || ch === "`") {
          const end = expansionAt(k, true);
          if (end === -1) return -1;
          if (end !== k) {
            if (building) expansion(text.slice(k, end));
            k = end;
            continue;
          }
        }
        if (building) literal(ch, true);
        k++;
      }
      if (heredoc) return k;
      if (k >= text.length) return -1;
      return k + 1;
    }
    // `$'…'` whose `$` is at `at`, as a word's text. The index after its quote.
    function ansiC(at) {
      const decoded = decodeAnsiC(at);
      literal(decoded.value, true);
      if (!decoded.closed) { list.problems.push("an unterminated quote"); return text.length; }
      return decoded.end;
    }
    // `$'…'` whose `$` is at `at`, decoded as bash decodes it: its value, the index after its
    // closing quote, and whether it closed.
    function decodeAnsiC(at) {
      const simple = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
        "\\": "\\", "'": "'", '"': '"', "?": "?" };
      let k = at + 2;
      let value = "";
      while (k < text.length && text[k] !== "'") {
        if (text[k] !== "\\") { value += text[k++]; continue; }
        const escape = text[k + 1];
        k += 2;
        if (escape === undefined) break;
        if (Object.hasOwn(simple, escape)) { value += simple[escape]; continue; }
        const digits = (pattern, max) => {
          let found = "";
          while (found.length < max && pattern.test(text[k] ?? "")) found += text[k++];
          return found;
        };
        if (/[0-7]/.test(escape)) { value += String.fromCharCode(parseInt(escape + digits(/[0-7]/, 2), 8) & 0xff); continue; }
        if (escape === "x" || escape === "u" || escape === "U") {
          const hex = digits(/[0-9a-fA-F]/, escape === "x" ? 2 : escape === "u" ? 4 : 8);
          value += hex === "" ? `\\${escape}` : String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff));
          continue;
        }
        if (escape === "c" && k < text.length) { value += String.fromCharCode(text[k++].toUpperCase().charCodeAt(0) & 0x1f); continue; }
        value += `\\${escape}`;
      }
      return k >= text.length ? { value, end: text.length, closed: false } : { value, end: k + 1, closed: true };
    }
    // At a newline, each heredoc opened on the line just ended takes its body, in order; an
    // unquoted one's body expands, so its substitutions are commands.
    function readHeredocs(k) {
      for (const doc of heredocs.splice(0)) {
        const lines = [];
        let closed = false;
        while (k < text.length) {
          const newline = text.indexOf("\n", k);
          const line = text.slice(k, newline === -1 ? text.length : newline);
          k = newline === -1 ? text.length : newline + 1;
          const stripped = doc.strip ? line.replace(/^\t+/, "") : line;
          if (stripped === doc.delimiter) { closed = true; break; }
          lines.push(stripped);
        }
        if (!closed) list.problems.push("an unterminated heredoc");
        const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
        doc.stdin.text = body;
        if (!doc.quoted) {
          const inner = lexList(body, 0, "heredoc");
          list.nested.push(...inner.nested);
          list.problems.push(...inner.problems);
          doc.stdin.exact = !/[$`\\]/.test(body);
        }
      }
      return k;
    }

    if (closer === "heredoc") {
      if (doubleQuoted(start, false, true) === -1) list.problems.push("an unterminated expansion in a heredoc");
      return list;
    }
    while (i < text.length) {
      const c = text[i];
      if (c === "\n") {
        endCommand();
        i++;
        if (heredocs.length > 0) i = readHeredocs(i);
        continue;
      }
      if (c === " " || c === "\t" || c === "\r") { finishWord(); i++; continue; }
      if (c === "#" && word === null) {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (command.cond && "&|()<>!".includes(c)) { literal(c, false); i++; continue; }
      if (c === "\\") {
        if (text[i + 1] === "\n") { i += 2; continue; }
        literal(text[i + 1] ?? "\\", true);
        i += 2;
        continue;
      }
      if (c === "'") {
        const end = text.indexOf("'", i + 1);
        literal(text.slice(i + 1, end === -1 ? text.length : end), true);
        if (end === -1) { list.problems.push("an unterminated quote"); i = text.length; continue; }
        i = end + 1;
        continue;
      }
      if (c === "$" && text[i + 1] === "'") { i = ansiC(i); continue; }
      if (c === '"' || (c === "$" && text[i + 1] === '"')) {
        begin();
        word.quoted = true;
        const end = doubleQuoted(i + (c === "$" ? 2 : 1), true);
        if (end === -1) { list.problems.push("an unterminated quote"); i = text.length; continue; }
        i = end;
        continue;
      }
      if (c === "`" || c === "$") {
        const end = expansionAt(i);
        if (end === -1) { expansion(text.slice(i)); i = text.length; continue; }
        if (end !== i) { expansion(text.slice(i, end)); i = end; continue; }
      }
      if ((c === "<" || c === ">") && text[i + 1] === "(") {
        const end = substitution(i + 2);
        expansion(text.slice(i, end));
        i = end;
        continue;
      }
      if (c === "<" || c === ">") {
        // A descriptor number or `{name}` before the operator belongs to it.
        if (word !== null && !word.quoted && !word.expansions && /^(?:\d+|\{[A-Za-z_]\w*\})$/.test(word.value)) word = null;
        finishWord();
        const op = /^(?:<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/.exec(text.slice(i, i + 3))[0];
        redirect = op;
        i += op.length;
        continue;
      }
      if (c === "&") {
        if (text[i + 1] === "&") { endCommand(); i += 2; continue; }
        if (text[i + 1] === ">") {
          finishWord();
          const appending = text[i + 2] === ">";
          redirect = appending ? "&>>" : "&>";
          i += appending ? 3 : 2;
          continue;
        }
        endCommand();
        i++;
        continue;
      }
      if (c === "|") {
        if (text[i + 1] === "|") { endCommand(); i += 2; continue; }
        endCommand(true);
        i += text[i + 1] === "&" ? 2 : 1;
        continue;
      }
      if (c === ";") {
        endCommand();
        i += text.startsWith(";;&", i) ? 3 : text.startsWith(";;", i) || text.startsWith(";&", i) ? 2 : 1;
        continue;
      }
      if (c === "(") {
        // An array assignment, `name=(…)`: its elements are data.
        if (word !== null && !word.quoted && /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=$/.test(word.shape)) {
          const end = scanTo(i + 1, ")");
          if (end === -1) { list.problems.push("an unterminated array"); literal(text.slice(i), false); i = text.length; continue; }
          literal(text.slice(i, end), false);
          i = end;
          continue;
        }
        finishWord();
        const pair = /^\(\s*\)/.exec(text.slice(i, i + 64));
        const named = command.words;
        if (pair !== null && redirect === null && (named.length === 1
          || (named.length === 2 && !named[0].quoted && named[0].value === "function"))) {
          command.funcDef = named[named.length - 1].value;
          command.words = [];
          endCommand();
          i += pair[0].length;
          continue;
        }
        if (reservedOnly(named) && redirect === null) {
          if (text[i + 1] === "(") {
            const end = scanTo(i + 2, "))");
            if (end !== -1) { command.arith = true; i = end; continue; }
          }
          depth++;
          openGroup("(", command.pipeFrom, true);
          i++;
          continue;
        }
        list.problems.push("a `(` where no command can start");
        endCommand();
        i++;
        continue;
      }
      if (c === ")") {
        finishWord();
        if (depth > 0) { depth--; closeGroup("("); endCommand(); i++; continue; }
        if (closer === ")") {
          endCommand();
          list.end = i;
          list.closed = true;
          return list;
        }
        list.problems.push("a `)` with no `(`");
        endCommand();
        i++;
        continue;
      }
      literal(c, false);
      i++;
    }
    endCommand();
    return list;
  }

  /** A line: lexed, then judged. */
  function judgeText(text, context) {
    if (context.depth > depthLimit) return doubt("nesting past eight levels", text);
    const list = lexList(String(text), 0, null);
    list.text = String(text);
    return judgeList(list, context);
  }

  const namesInList = (list) => list.named || namesTarget(list.text) || list.nested.some(namesInList);
  /** A command list: its substitutions and its commands, each judged; the worst answer. */
  function judgeList(list, context) {
    if (context.depth > depthLimit) return doubt("nesting past eight levels", list.text);
    // Raw text and decoded words both count, including bodies, targets and comments.
    const named = context.named || namesInList(list);
    const deferred = context.deferred || list.deferred;
    const inner = { depth: context.depth, named, deferred };
    let verdict = pass;
    let cap = null;
    // A `[[ … ]]` comparing integers evaluates its operands as arithmetic, after `if`,
    // `while` or `!` as much as at a command's start.
    const conditional = (words) => {
      const at = words.findIndex((word) => !(!word.quoted && !word.expansions && ["if", "elif", "then", "else", "while", "until", "do", "!"].includes(word.value)));
      return at !== -1 && words[at].value === "[[" && !words[at].quoted && words.slice(at).some((word) => /^-(?:eq|ne|lt|le|gt|ge|v)$/.test(word.value));
    };
    const arithmetic = list.arithmetic || list.commands.some((command) => command.arith || conditional(command.words));
    if (named && deferred && arithmetic) verdict = doubt("arithmetic may evaluate a quoted substitution or subscript", list.text);
    for (const nested of list.nested) verdict = worse(verdict, judgeList(nested, { ...inner, depth: context.depth + 1 }));
    for (const command of list.commands) {
      const judged = judgeCommand(command, inner);
      if (judged.cap) cap ??= judged;
      else verdict = worse(verdict, judged);
    }
    // A line bash would refuse, or one whose later words a construct changes the meaning of,
    // is read no further: `?` beside an engine's name, whatever was found on it.
    if (named && list.problems.length > 0) return doubt(`${list.problems[0]}, beside an engine's name`, list.text);
    if (named && cap !== null) return doubt(cap.why, cap.at);
    return verdict;
  }

  /** A simple command: its assignments, then its words. */
  function judgeCommand(command, context) {
    if (command.funcDef !== undefined) {
      return isEngine(command.funcDef)
        ? { verdict: "?", cap: true, why: "a function named like an engine, which makes the name mean that function", at: `${command.funcDef}()` }
        : pass;
    }
    if (command.arith) return pass;
    let verdict = pass;
    let k = 0;
    while (k < command.words.length && isAssignment(command.words[k])) {
      verdict = worse(verdict, assignmentCode(command.words[k], context));
      k++;
    }
    if (k < command.words.length) verdict = worse(verdict, judgeWords(command.words.slice(k), command, context));
    // A reader must explicitly account for stdin. In particular, wrappers do not
    // consume it merely because their command/option words have been understood.
    if (!command.stdinRead) verdict = worse(verdict, unreadInput(command, context));
    return verdict;
  }

  const isAssignment = (word) => /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(word.shape);

  /** Assignment syntax is shared by prefixes, declaration builtins and env (including -S). */
  function assignmentCode(word, context) {
    const match = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=([\s\S]*)$/.exec(word.value);
    if (match === null) return pass;
    const [, name, code] = match;
    if (name !== "NODE_OPTIONS" && !shellCodeVariables.has(name)) return pass;
    const named = context.named || namesTarget(code);
    if (word.expansions) return named ? doubt("an expansion in a code-carrying assignment", word.value) : pass;
    if (name === "NODE_OPTIONS") {
      const list = lexList(code, 0, null);
      const read = nodeWalk([asWord("node"), ...list.commands.flatMap((command) => command.words)], true);
      if (read.launch) return { verdict: "launch", why: "", at: shown(word.value) };
      return (!read.known || list.problems.length > 0) && named ? doubt(unmodeled, word.value) : pass;
    }
    // Startup paths and prompt templates expand substitutions, but their literal text
    // is not a command. PROMPT_COMMAND, in contrast, is a shell command list.
    if (name !== "PROMPT_COMMAND") {
      const list = lexList(code, 0, "heredoc");
      list.text = code;
      const expanded = judgeList(list, { ...context, named, depth: context.depth + 1 });
      return (name === "BASH_ENV" || name === "ENV") && named
        ? worse(expanded, doubt("a shell startup file this grammar cannot read", word.value)) : expanded;
    }
    return judgeText(code, { ...context, named, depth: context.depth + 1 });
  }

  function unreadInput(command, context) {
    const stdin = stdinOf(command);
    if (stdin === null) return pass;
    const at = values(command.words).join(" ") || stdin.text || stdin.what;
    if (stdin.kind === "text") {
      if (namesTarget(stdin.text) || judgeText(stdin.text, { ...context, depth: context.depth + 1 }).verdict === "launch") {
        return doubt("stdin naming a launch or engine was not consumed by a modeled reader", at);
      }
    } else if (context.named) return doubt(`unread stdin from ${stdin.what}, beside an engine's name`, at);
    return pass;
  }

  /** A simple command's words, from its command word on. */
  function judgeWords(words, command, context) {
    if (context.depth > depthLimit) return doubt("nesting past eight levels", values(words).join(" "));
    const first = words[0];
    const value = first.value;
    const line = values(words).join(" ");
    // The command word's basename: after its last literal slash. A command word an expansion
    // supplies is known by a literal basename alone.
    let slash = -1;
    for (let k = value.length - 1; k >= 0; k--) if (value[k] === "/" && first.shape[k] !== "\u0002") { slash = k; break; }
    const name = value.slice(slash + 1);
    if (first.shape.slice(slash + 1).includes("\u0002") || name === "") return context.named ? doubt(unmodeled, line) : pass;
    if (/\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(first.shape)) {
      const expanded = !first.quoted && !first.expansions ? braceExpand(value) : null;
      if (expanded === null) return context.named ? doubt(unmodeled, line) : pass;
      const plainWord = (text) => ({ value: text, shape: text, expansions: false, quoted: false });
      return judgeWords([...expanded.map(plainWord), ...words.slice(1)], command, { ...context, depth: context.depth + 1 });
    }
    if (/[*?[]/.test(first.shape) && value !== "[" && value !== "[[") return context.named ? doubt(unmodeled, line) : pass;
    if (!first.quoted && !first.expansions) {
      if (["if", "then", "elif", "else", "while", "until", "do", "!", "{"].includes(value)) {
        return words.length > 1 ? judgeWords(words.slice(1), command, context) : pass;
      }
      if (["fi", "done", "esac", "}", "for", "select", "in", "[[", "]]"].includes(value)) return pass;
      if (value === "case") return { verdict: "?", cap: true, why: "a case statement, whose patterns this grammar does not read", at: line };
      if (value === "function") {
        const defined = words[1]?.value ?? "";
        return isEngine(defined)
          ? { verdict: "?", cap: true, why: "a function named like an engine, which makes the name mean that function", at: line }
          : pass;
      }
    }
    if (engineNames.has(name) || binPaths.has(value)) return launchAt(words);
    // Literal git object/path reads used by the audit's own historical rows.
    if (name === "git" && words.every((word) => !word.expansions) && (
      (words.length === 3 && words[1].value === "show" && /^[\w./~-]+:[^\s]+$/.test(words[2].value))
      || (words[1]?.value === "grep" && words.length > 2 && words.slice(2).every((word) => !word.value.startsWith("-"))))) {
      command.stdinRead = true;
      return pass;
    }
    if (dataOnly.has(name)) return dataCommand(name, words, command, context);
    if (name === "busybox") {
      if (words.length < 2 || words[1].value.startsWith("-")) return pass;
      return judgeWords(words.slice(1), command, context);
    }
    if (wrapperSpecs.has(name)) return wrapped(name, words, command, context);
    if (shells.has(name)) return shellRun(words, command, context);
    if (name === "eval") return words.slice(1).some((word) => word.expansions)
      ? (context.named ? doubt(unmodeled, line) : pass)
      : judgeText(values(words.slice(1)).join(" "), { ...context, depth: context.depth + 1 });
    // A script file is not read; one an expansion names — `<(…)`, `$file` — could be anything.
    if (name === "source" || name === ".") return words[1]?.expansions && context.named ? doubt(unmodeled, line) : pass;
    if (name === "find") return findRun(words, context);
    if (name === "ssh") return sshRun(words, command, context);
    if (name === "node" || name === "nodejs") return nodeRun(words, command, context);
    if (interpreters.test(name)) return interpreterRun(name, words, command, context);
    return context.named ? doubt(unmodeled, line) : pass;
  }

  /** A data reader, with its code assignments, subscripts and execution options checked. */
  function dataCommand(name, words, command, context) {
    command.stdinRead = true;
    let verdict = pass;
    if (declarations.has(name)) for (const word of words.slice(1)) verdict = worse(verdict, assignmentCode(word, context));
    const subscriptReader = declarations.has(name) || ["read", "unset"].includes(name)
      || (["test", "[", "printf"].includes(name) && words.some((word) => word.value === "-v"));
    if (context.named && subscriptReader && (context.deferred || words.slice(1).some((word) => substitutionsIn(word.value)))) {
      verdict = worse(verdict, doubt("a builtin may evaluate a quoted substitution or subscript", values(words).join(" ")));
    }
    const run = { rg: "--pre", sort: "--compress-program" }[name];
    if (run === undefined) return verdict;
    for (let k = 1; k < words.length; k++) {
      const value = words[k].value;
      if (value === "--") break;
      if (words[k].expansions) return worse(verdict, context.named ? doubt(unmodeled, value) : pass);
      const program = value === run ? words[++k]?.value : value.startsWith(`${run}=`) ? value.slice(run.length + 1) : undefined;
      if (words[k]?.expansions) return worse(verdict, context.named ? doubt(unmodeled, value) : pass);
      if (program !== undefined && program !== "") {
        verdict = worse(verdict, judgeWords([asWord(program)], command, context));
      }
    }
    return verdict;
  }

  /**
   * Past a command's options, getopt style, against `spec` (see the tables above). Returns
   * the index of the first operand, whether every option was one the table knows, and each
   * option read with its value.
   */
  function options(words, k, spec) {
    let known = true;
    const read = [];
    while (k < words.length) {
      if (words[k].expansions) return { k, known: false, expanded: true, read };
      const word = words[k].value;
      if (word === "--") { k++; break; }
      if (word === "-" || !word.startsWith("-")) break;
      if (word.startsWith("--")) {
        const equals = word.indexOf("=");
        const option = equals === -1 ? word : word.slice(0, equals);
        const kind = spec.long?.[option];
        if (kind === undefined) known = false;
        if (kind === "value" && equals === -1) {
          if (words[k + 1]?.expansions) return { k, known: false, expanded: true, read };
          read.push({ option, value: words[k + 1]?.value }); k += 2; continue;
        }
        read.push({ option, value: equals === -1 ? undefined : word.slice(equals + 1) });
        k++;
        continue;
      }
      if (/^-\d+$/.test(word) && spec.numeric) { k++; continue; }
      let next = k + 1;
      for (let j = 1; j < word.length; j++) {
        const letter = word[j];
        const rest = word.slice(j + 1);
        if (spec.flags.includes(letter)) { read.push({ option: `-${letter}` }); continue; }
        if (spec.digits?.includes(letter)) {
          const digits = /^(?:x[0-9a-fA-F]+|[0-7]*)/.exec(rest)[0];
          read.push({ option: `-${letter}`, value: digits });
          j += digits.length;
          continue;
        }
        if (spec.attached?.includes(letter)) { read.push({ option: `-${letter}`, value: rest }); break; }
        if (spec.values.includes(letter) || spec.code?.includes(letter) || spec.stop?.includes(letter)) {
          if (rest !== "") read.push({ option: `-${letter}`, value: rest });
          else {
            if (words[k + 1]?.expansions) return { k, known: false, expanded: true, read };
            read.push({ option: `-${letter}`, value: words[k + 1]?.value }); next = k + 2;
          }
          break;
        }
        known = false;
        break;
      }
      k = next;
      const last = read[read.length - 1];
      if (last !== undefined && (spec.stop?.includes(last.option.slice(1)) || (spec.codeEnds && spec.code?.includes(last.option.slice(1))))) break;
    }
    return { k, known, read };
  }

  /** An exec wrapper: past its options, the command it runs. */
  function wrapped(name, words, command, context) {
    const line = values(words).join(" ");
    const spec = { ...wrapperSpecs.get(name), numeric: name === "nice" };
    const walk = options(words, 1, spec);
    let k = walk.k;
    const unread = !walk.known && context.named ? doubt(unmodeled, line) : pass;
    let assigned = pass;
    if (walk.expanded) return unread;
    if (name === "command" && walk.read.some(({ option }) => option === "-v" || option === "-V")) return pass;
    if (name === "sudo" && walk.read.some(({ option }) => ["-e", "--edit", "-l", "--list", "-v", "--validate", "-K", "--remove-timestamp"].includes(option))) return unread;
    if (name === "env") {
      const split = walk.read.find(({ option }) => option === "-S" || option === "--split-string");
      while (k < words.length && /^[A-Za-z_]\w*\+?=/.test(words[k].value)) {
        assigned = worse(assigned, assignmentCode(words[k], context));
        k++;
      }
      if (split !== undefined) {
        const parts = lexList(split.value ?? "", 0, null).commands.flatMap((part) => part.words);
        const rest = [...parts, ...words.slice(k)];
        const child = { ...command, words: rest };
        const judged = judgeCommand(child, { ...context, depth: context.depth + 1 });
        command.stdinRead = child.stdinRead;
        return worse(worse(judged, assigned), unread);
      }
    }
    if (name === "timeout") {
      if (words[k]?.expansions) return context.named ? doubt(unmodeled, line) : pass;
      k++;
    }
    if (k >= words.length) return worse(assigned, unread);
    // xargs consumes stdin to build argv, rather than forwarding it to the child.
    if (name === "xargs") return worse(worse(unread, unreadInput(command, context)),
      judgeWords(words.slice(k), { stdin: null, pipeFrom: null }, context));
    return worse(worse(judgeWords(words.slice(k), command, context), assigned), unread);
  }

  /** A shell: its `-c` payload, or with no script its stdin, read as a line. */
  function shellRun(words, command, context) {
    const line = values(words).join(" ");
    let k = 1;
    let commandMode = false;
    let fromStdin = false;
    let known = true;
    while (k < words.length) {
      if (words[k].expansions) return context.named ? doubt(unmodeled, line) : pass;
      const word = words[k].value;
      if (word === "--" || word === "-") { k++; break; }
      if (!/^[-+]./.test(word)) break;
      if (word.startsWith("--")) {
        if (word === "--rcfile" || word === "--init-file") {
          if (words[k + 1]?.expansions) return context.named ? doubt(unmodeled, line) : pass;
          k += 2;
        }
        else { if (!shellLong.has(word)) known = false; k++; }
        continue;
      }
      let operands = 0;
      for (const letter of word.slice(1)) {
        if (letter === "c") commandMode = true;
        else if (letter === "s") fromStdin = true;
        else if (letter === "o" || letter === "O") operands++;
        else if (!shellFlags.includes(letter)) known = false;
      }
      if (words.slice(k + 1, k + 1 + operands).some((word) => word.expansions)) return context.named ? doubt(unmodeled, line) : pass;
      k += 1 + operands;
    }
    const unread = !known && context.named ? doubt(unmodeled, line) : pass;
    const deeper = { depth: context.depth + 1, named: context.named };
    if (commandMode) return k < words.length
      ? worse(words[k].expansions ? (context.named ? doubt(unmodeled, line) : pass) : judgeText(words[k].value, deeper), unread) : unread;
    if (!fromStdin && k < words.length) return worse(words[k].expansions && context.named ? doubt(unmodeled, line) : pass, unread);
    return worse(scriptOnStdin(command, deeper, line), unread);
  }

  /**
   * What a command reads on stdin: text, something unknown, or nothing given. A later command
   * in a piped group reads what the commands before it left, so its text is `shared`.
   */
  function stdinOf(command) {
    if (command.stdin !== null) return command.stdin;
    if (command.pipeFrom === null) return null;
    const output = outputOf(command.pipeFrom);
    return command.sharedStdin ? { ...output, shared: true } : output;
  }

  /** What a command writes to a pipe, as far as this grammar knows it. */
  function outputOf(producer) {
    let k = 0;
    while (k < producer.words.length && isAssignment(producer.words[k])) k++;
    const words = producer.words.slice(k);
    const name = words.length > 0 && !words[0].expansions ? basename(words[0].value) : "";
    if (name === "echo") {
      let j = 1;
      let escapes = false;
      while (j < words.length && /^-[neE]+$/.test(words[j].value)) { if (words[j].value.includes("e")) escapes = true; j++; }
      return { kind: "text", text: `${values(words.slice(j)).join(" ")}\n`, exact: !escapes && words.slice(j).every((word) => !word.expansions) };
    }
    if (name === "printf") return { kind: "text", text: values(words.slice(1)).join(" "), exact: false };
    if (name === "cat" && words.length === 1) return stdinOf(producer) ?? { kind: "unknown", what: "the terminal" };
    return { kind: "unknown", what: `the output of ${name || "a command"}` };
  }

  /** A script a shell or `ssh` reads on stdin. */
  function scriptOnStdin(command, deeper, line) {
    command.stdinRead = true;
    const stdin = stdinOf(command);
    if (stdin === null) return pass;
    if (stdin.kind === "text") {
      const judged = judgeText(stdin.text, deeper);
      if (judged.verdict === "launch" && stdin.shared) return doubt("a script on stdin that commands before it in its group may have read part of", stdin.text);
      if (judged.verdict === "pass" && !stdin.exact && names(stdin.text)) return doubt("a script on stdin this grammar cannot read exactly, beside an engine's name", stdin.text);
      return judged;
    }
    return deeper.named ? doubt(`a script read from ${stdin.what}, beside an engine's name`, line) : pass;
  }

  /** A program an interpreter reads on stdin. */
  function programOnStdin(command, context, line) {
    command.stdinRead = true;
    const stdin = stdinOf(command);
    if (stdin === null) return pass;
    if (stdin.kind === "text") return namesTarget(stdin.text) ? doubt(inline, line) : pass;
    return context.named ? doubt(`a program read from ${stdin.what}, beside an engine's name`, line) : pass;
  }

  /** `find`: the commands its `-exec`, `-execdir`, `-ok` and `-okdir` run. */
  function findRun(words, context) {
    if (words.slice(1).some((word) => word.expansions)) return context.named ? doubt(unmodeled, values(words).join(" ")) : pass;
    let verdict = pass;
    for (let k = 1; k < words.length; k++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(words[k].value)) continue;
      let end = k + 1;
      while (end < words.length && words[end].value !== ";" && words[end].value !== "+") end++;
      const run = words.slice(k + 1, end);
      if (run.length > 0) verdict = worse(verdict, judgeWords(run, { stdin: null, pipeFrom: null }, { ...context, depth: context.depth + 1 }));
      k = end;
    }
    return verdict;
  }

  /** `ssh`: the commands its options carry, and the remote command or the script on stdin. */
  function sshRun(words, command, context) {
    const line = values(words).join(" ");
    const walk = options(words, 1, sshSpec);
    const deeper = { depth: context.depth + 1, named: context.named };
    let verdict = !walk.known && context.named ? doubt(unmodeled, line) : pass;
    if (walk.expanded) return verdict;
    for (const { option, value } of walk.read) {
      if (option !== "-o" || value === undefined) continue;
      const setting = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)([\s\S]*)$/.exec(value);
      if (setting !== null && sshCommands.has(setting[1].toLowerCase())) verdict = worse(verdict, judgeText(setting[2], deeper));
    }
    const remote = words.slice(walk.k + 1);
    if (remote.some((word) => word.expansions)) return worse(verdict, context.named ? doubt(unmodeled, line) : pass);
    if (remote.length > 0) return worse(verdict, judgeText(values(remote).join(" "), deeper));
    if (walk.k >= words.length) return verdict;
    return worse(verdict, scriptOnStdin(command, deeper, line));
  }

  /**
   * node's options, walked against its table: whether a module it loads, before its first
   * operand, or its script is an entry point, whether every option was known, the inline
   * code it was given, and where its operands start.
   */
  function nodeWalk(words, optionsOnly = false) {
    const read = { launch: false, known: true, code: [], script: undefined, stdin: false };
    for (let k = 1; k < words.length; k++) {
      if (words[k].expansions) { read.known = false; break; }
      const word = words[k].value;
      if (word === "--") {
        if (read.code.length === 0 && !optionsOnly) {
          if (words[k + 1]?.expansions) read.known = false;
          else read.script = words[k + 1]?.value;
        }
        break;
      }
      if (word === "-") { read.stdin = true; break; }
      if (!word.startsWith("-") || word.length < 2) {
        if (read.code.length === 0 && !optionsOnly) read.script = word;
        break;
      }
      const equals = word.indexOf("=");
      const option = equals === -1 ? word : word.slice(0, equals);
      const attached = equals === -1 ? undefined : word.slice(equals + 1);
      if (attached === undefined && (nodeCode.has(option) || nodeLoads.has(option) || nodeValues.has(option)) && words[k + 1]?.expansions) {
        read.known = false;
        break;
      }
      const operand = () => attached ?? words[++k]?.value ?? "";
      if (nodeCode.has(option)) { read.code.push(operand()); continue; }
      if (nodeLoads.has(option)) { if (isEntryPoint(operand())) read.launch = true; continue; }
      if (nodeValues.has(option)) { if (attached === undefined) k++; continue; }
      if (nodeFlags.has(option) || option.startsWith("--no-") || option.startsWith("--experimental-") || option.startsWith("--harmony")) continue;
      // An option this table does not know: whether it takes the next word is unknown.
      if (attached === undefined) read.known = false;
    }
    return read;
  }

  // A script operand that is stdin itself: the program is what stdin holds.
  const stdinScripts = new Set(["-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);

  /**
   * `node`: the modules it loads, the script it runs, and its inline code. Stdin is its
   * program only with no script or a script that is stdin; to inline code or a script file
   * it is input the code may read and run, so it is left to `unreadInput`.
   */
  function nodeRun(words, command, context) {
    const line = values(words).join(" ");
    const read = nodeWalk(words);
    if (read.launch) return launchAt(words);
    if (read.script !== undefined && isEntryPoint(read.script)) return read.known ? launchAt(words) : doubt(unmodeled, line);
    const unread = !read.known && (context.named || namesTarget(line)) ? doubt(unmodeled, line) : pass;
    if (read.code.length > 0) return worse(read.code.some(namesTarget) ? doubt(inline, line) : pass, unread);
    if (read.script !== undefined && !stdinScripts.has(read.script)) return unread;
    return worse(programOnStdin(command, context, line), unread);
  }

  /**
   * Python, Perl, Ruby and awk: inline code that names an engine is a question. Stdin is the
   * program only with no script or a script that is stdin; to inline code, a module or a
   * script file it is input the code may read and run, so it is left to `unreadInput`.
   */
  function interpreterRun(name, words, command, context) {
    const line = values(words).join(" ");
    const kind = name.startsWith("python") ? "python" : name.startsWith("perl") ? "perl" : name.startsWith("ruby") ? "ruby" : "awk";
    const spec = { python: { ...pythonSpec, codeEnds: true }, perl: perlSpec, ruby: rubySpec, awk: awkSpec }[kind];
    const walk = options(words, 1, spec);
    const unread = !walk.known && context.named ? doubt(unmodeled, line) : pass;
    if (walk.expanded) return unread;
    const code = walk.read.filter(({ option }) => spec.code?.includes(option.slice(1)) || (kind === "awk" && option === "-e")).map(({ value }) => value ?? "");
    const module = walk.read.find(({ option }) => kind === "python" && option === "-m");
    if (module !== undefined) return worse(namesTarget(module.value ?? "") ? doubt(unmodeled, line) : pass, unread);
    if (kind === "awk") {
      // An awk program is the first operand unless `-f` or `-E` names a file; a `-v` value
      // is text the program can run as well.
      if (code.length === 0 && !walk.read.some(({ option }) => option === "-f" || option === "-E") && walk.k < words.length) {
        if (words[walk.k].expansions) return context.named ? doubt(unmodeled, line) : pass;
        code.push(words[walk.k].value);
      }
      code.push(...walk.read.filter(({ option }) => option === "-v").map(({ value }) => value ?? ""));
    }
    if (code.length > 0) return worse(code.some(namesTarget) ? doubt(inline, line) : pass, unread);
    if (kind === "awk") return unread;
    if (walk.k < words.length && !stdinScripts.has(words[walk.k].value)) return unread;
    return worse(programOnStdin(command, context, line), unread);
  }

  /**
   * Bash's brace expansion of a literal word: `{a,b}` and `{x..y[..step]}`, nested, each
   * alternative with the prefix and suffix around it; null for what this does not expand.
   */
  function braceExpand(word) {
    const open = word.indexOf("{");
    if (open === -1) return [word];
    let depth = 0;
    let close = -1;
    const commas = [];
    for (let k = open; k < word.length; k++) {
      if (word[k] === "{") depth++;
      else if (word[k] === "}" && --depth === 0) { close = k; break; }
      else if (word[k] === "," && depth === 1) commas.push(k);
    }
    if (close === -1) return null;
    const prefix = word.slice(0, open);
    const body = word.slice(open + 1, close);
    const suffix = word.slice(close + 1);
    let alternatives;
    if (commas.length > 0) {
      alternatives = [];
      let from = open + 1;
      for (const comma of [...commas, close]) { alternatives.push(word.slice(from, comma)); from = comma + 1; }
    } else {
      const range = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
      if (range === null) {
        const rest = braceExpand(suffix);
        return rest === null ? null : rest.map((tail) => `${prefix}{${body}}${tail}`);
      }
      const numeric = /\d/.test(range[1]);
      const from = numeric ? Number(range[1]) : range[1].charCodeAt(0);
      const to = numeric ? Number(range[2]) : range[2].charCodeAt(0);
      const step = Math.max(1, Math.abs(Number(range[3] ?? 1)));
      alternatives = [];
      for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step) {
        alternatives.push(numeric ? String(n) : String.fromCharCode(n));
        if (alternatives.length > 64) return null;
      }
    }
    const tails = braceExpand(suffix);
    if (tails === null) return null;
    const out = [];
    for (const alternative of alternatives) {
      const heads = braceExpand(prefix + alternative);
      if (heads === null) return null;
      for (const head of heads) for (const tail of tails) out.push(head + tail);
      if (out.length > 256) return null;
    }
    return out;
  }

  return {
    // A command line that is one simple command and nothing else, as its words; or null.
    argvOf: (text) => {
      const list = lexList(String(text), 0, null);
      return list.problems.length > 0 || list.nested.length > 0 || list.commands.length !== 1 ? null : values(list.commands[0].words);
    },
    judge: (text) => judgeText(text, { depth: 0, named: false }),
    judgeArgv: (argv) => (argv.length === 0 ? pass
      : judgeWords(argv.map(asWord), { stdin: null, pipeFrom: null }, { depth: 0, named: argv.some(namesTarget) })),
    names,
    namesTarget,
  };
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
 * Whether a rollout shows a command the `--json` transcript ran: the same argv, or as the
 * command a script or a function call gave, whole or as the `-c` payload of its shell.
 */
function rolloutShows(shown, command) {
  if (shown.lines.includes(command)) return true;
  const argv = launch.argvOf(command);
  if (argv === null) return false;
  if (shown.argvs.some((other) => other.length === argv.length && other.every((word, k) => word === argv[k]))) return true;
  return argv.length === 3 && /(?:^|\/)(?:ba|da|z|k)?sh$/.test(argv[0]) && /^-[a-z]*c[a-z]*$/.test(argv[1]) && shown.lines.includes(argv[2]);
}

/**
 * The commands a Codex rollout shows attempted, whether or not they ran, and the tools it
 * shows called: each code-mode `exec` script read as JavaScript (`scriptRead`); the command
 * of a `shell`, `exec_command`, `local_shell` or `container.exec` function call, the
 * keystrokes of a `write_stdin` call and the argv of a `local_shell_call`; the argv of every
 * `CommandExecution` item and `exec_command_begin` event; and the tool of every
 * `McpToolCall` item and `mcp__…` call. The tool calls of codex-cli 0.159.2's that run
 * nothing (`quietTools`) are classified as such. An output carrying a command is judged
 * like the call. Any other tool-call entry or item with a field naming a tool, its
 * arguments or a command, a line that is not JSON, a script that does not read and a
 * command a script computes are named, because each could be the one this scan looks for.
 * No verdict reads a call's result: an attempt counts whether it ran, failed or was
 * refused, and the refused ones are the ones `--json` leaves out (A6).
 */
function rolloutCommands(file) {
  const read = { lines: [], argvs: [], calls: [], stdin: [], asides: [], patterns: [], unreadable: [] };
  let text;
  try { text = readFileSync(file, "utf8"); } catch (error) { read.unreadable.push(`an unreadable file (${error.code ?? error.message})`); return read; }
  const unclassified = (what) => read.unreadable.push(`a tool call this reader does not classify (${what})`);
  const argv = (value) => Array.isArray(value) && value.length > 0 && value.every((word) => typeof word === "string");
  // A field naming a tool, its arguments or a command, by any spelling, on a payload, on its
  // item, or on an object one level below either (`data.name`).
  const toolKey = /^(?:name|tool|tool_?name|tool_?call|args?|arguments|argv|params|parameters|function|func|fn|command|commands|cmd|cmd_?line|input|action|script|call|exec|program)$/i;
  const holder = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const toolBearing = (value) => holder(value) && Object.keys(value)
    .some((key) => toolKey.test(key) || (holder(value[key]) && Object.keys(value[key]).some((inner) => toolKey.test(inner))));
  // The commands an entry carries in a `command`, `cmd`, `cmdline` or `argv` field, there or
  // one object below: a string is a command line, an argv of strings an argv, anything else
  // a shape this reader does not know.
  const carried = (value, depth = 0) => {
    if (!holder(value)) return;
    for (const [key, field] of Object.entries(value)) {
      if (/^(?:command|cmd|cmd_?line|argv)$/i.test(key)) {
        if (typeof field === "string") read.lines.push(field);
        else if (argv(field)) read.argvs.push(field);
        else unclassified(`a ${key} field that is neither a command line nor an argv`);
      } else if (depth < 1 && holder(field)) carried(field, depth + 1);
    }
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try { entry = JSON.parse(line); } catch { read.unreadable.push("a line that is not JSON"); continue; }
    const payload = entry?.payload ?? {};
    const type = String(payload.type ?? "");
    const name = String(payload.name ?? "");
    if (entry?.type === "response_item" && type === "custom_tool_call") {
      if (name !== "exec") { if (!quietTools.has(name)) unclassified(`custom_tool_call ${name}`); continue; }
      if (typeof payload.input !== "string") { unclassified("exec input is not a script string"); continue; }
      const script = scriptRead(payload.input);
      if (script.error !== undefined) read.unreadable.push(`an exec script that does not read as JavaScript (${script.error})`);
      read.lines.push(...script.commands);
      read.stdin.push(...script.stdin);
      read.calls.push(...script.calls);
      read.asides.push(...script.asides);
      read.patterns.push(...script.patterns);
      read.unreadable.push(...script.computed);
    } else if (entry?.type === "response_item" && type === "function_call") {
      if (name.startsWith("mcp__")) { read.calls.push(name); continue; }
      if (quietTools.has(name)) continue;
      if (!commandTools.has(name) && name !== "write_stdin") { unclassified(`function_call ${name}`); continue; }
      let args;
      try {
        if (typeof payload.arguments !== "string") throw new Error("not a string");
        args = JSON.parse(payload.arguments);
      } catch { read.unreadable.push(`a ${name} call whose arguments are not JSON`); continue; }
      if (name === "write_stdin") {
        if (typeof args?.chars === "string") read.stdin.push(args.chars);
        else read.unreadable.push("a write_stdin call with no keystrokes");
      } else if (typeof args?.cmd === "string") read.lines.push(args.cmd);
      else if (typeof args?.command === "string") read.lines.push(args.command);
      else if (argv(args?.command)) read.argvs.push(args.command);
      else read.unreadable.push(`a ${name} call with no command`);
    } else if (entry?.type === "response_item" && type === "local_shell_call") {
      if (argv(payload.action?.command)) read.argvs.push(payload.action.command);
      else read.unreadable.push("a local_shell_call with no command");
    } else if (entry?.type === "response_item" && type.endsWith("_call") && type !== "web_search_call") {
      unclassified(type);
    } else if (entry?.type === "event_msg" && type === "item_completed" && payload.item?.type === "CommandExecution") {
      if (argv(payload.item.command)) read.argvs.push(payload.item.command);
      else unclassified("CommandExecution command is not an argv of strings");
    } else if (entry?.type === "event_msg" && type === "item_completed" && payload.item?.type === "McpToolCall") {
      if (typeof payload.item.tool === "string") read.calls.push(payload.item.tool);
      else read.unreadable.push("an McpToolCall with no tool");
    } else if (entry?.type === "event_msg" && type === "exec_command_begin") {
      if (argv(payload.command)) read.argvs.push(payload.command);
      else unclassified("exec_command_begin command is not an argv of strings");
    } else if (type.endsWith("_output")) {
      // An output carrying a command is judged like the call that ran it.
      carried(payload);
      carried(payload.item);
    } else if (toolBearing(payload) || toolBearing(payload.item)) {
      unclassified(payload.item?.type ?? type);
    }
  }
  return read;
}

/**
 * What a code-mode `exec` script runs and calls, read from its tokens (`scriptTokens`)
 * rather than searched for. A call this reader follows is a direct one — `NAME(` or
 * `tools["NAME"](` — to `exec_command`, `write_stdin` or a `delegate`: the literal the one
 * object-literal argument of an `exec_command` gives `cmd`, or of a `write_stdin` gives
 * `chars`, with no spread or computed key beside it, is the command, escapes decoded, and a
 * `delegate` called is a call. Every other reference to those tools, `tools` used other than
 * by a name, `eval`, `Function`, `require` and `import` go in `computed`, as does any excess
 * of raw/decoded tool-name occurrences over the direct calls followed. The scan
 * answers with `?`; every other string, template text and comment is an aside, and every
 * regular expression a pattern, which the scan judges as well, because a launch written
 * there cannot be told from one the script assembles and runs.
 */
function scriptRead(source) {
  const read = { commands: [], stdin: [], calls: [], computed: [], asides: [], patterns: [] };
  let tokens;
  try { tokens = scriptTokens(source); } catch (error) { return { ...read, error: error.message }; }
  const keys = new Map([["exec_command", "cmd"], ["write_stdin", "chars"]]);
  const taken = new Set();
  // Independent of token roles: a slash or another lexical mistake must not hide a
  // command-tool reference. Decode token text as well, counting each source occurrence
  // once (a quoted member name occurs in both the raw source and its decoded token).
  const toolCounts = (text) => {
    const counts = new Map();
    for (const [name] of text.matchAll(/(?<![\w$])(?:exec_command|write_stdin|[\w$]+__delegate|delegate)(?![\w$])/g)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  };
  const named = toolCounts(source);
  const followed = new Map();
  const countDecoded = (text, raw) => {
    const before = toolCounts(raw);
    for (const [name, count] of toolCounts(text)) named.set(name, (named.get(name) ?? 0) + Math.max(0, count - (before.get(name) ?? 0)));
  };
  // A regular expression's text is source a misread slash may have swallowed: its escapes
  // are decoded for the inventory as a string's would be.
  const decodeEscapes = (text) => text
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (all, hex) => (parseInt(hex, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(hex, 16)) : all))
    .replace(/\\u([0-9a-fA-F]{4})/g, (all, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (all, hex) => String.fromCharCode(parseInt(hex, 16)));
  const inventory = (list) => {
    for (const token of list) {
      if (token.kind === "regex") countDecoded(decodeEscapes(token.text), token.text);
      if (token.kind === "string" || token.kind === "name") countDecoded(token.value ?? token.text, source.slice(token.start, token.end));
      if (token.kind === "template") {
        token.parts.forEach((part, k) => countDecoded(part, token.rawParts[k]));
        token.inner.forEach(inventory);
      }
    }
  };
  inventory(tokens);
  const follow = (name) => followed.set(name, (followed.get(name) ?? 0) + 1);
  const visit = (list) => {
    list.forEach((token, k) => {
      if (token.kind === "template") { token.inner.forEach(visit); return; }
      if (token.kind === "name" && ["eval", "Function", "require"].includes(token.text)) { read.computed.push(`a script that uses ${token.text}`); return; }
      if (token.kind === "name" && token.text === "import" && list[k + 1]?.text !== ".") { read.computed.push("a script that imports a module"); return; }
      if (token.kind === "name" && token.text === "tools") {
        const byName = list[k + 1]?.text === "." && list[k + 2]?.kind === "name";
        const byQuotedName = list[k + 1]?.text === "[" && list[k + 2]?.kind === "string" && list[k + 3]?.text === "]";
        if (!byName && !byQuotedName) read.computed.push("the tools object used other than by a tool's name");
        return;
      }
      const name = token.kind === "name" ? token.text : token.kind === "string" ? token.value : undefined;
      if (name === undefined || (!keys.has(name) && !isDelegate(name))) return;
      const member = token.kind === "string" && list[k - 1]?.text === "[" && list[k + 1]?.text === "]";
      if (token.kind === "string" && !member) { read.computed.push(`a string naming ${name}`); return; }
      const open = member ? k + 2 : k + 1;
      if (list[open]?.text !== "(") { read.computed.push(`${name} used other than in a direct call`); return; }
      if (isDelegate(name)) { follow(name); read.calls.push(name); return; }
      const argument = callArgument(list, open + 1, keys.get(name));
      if (argument === null) {
        read.computed.push(`${name === "exec_command" ? "an" : "a"} ${name} call whose ${keys.get(name)} is not a literal in its one object argument`);
        return;
      }
      taken.add(argument);
      follow(name);
      (name === "write_stdin" ? read.stdin : read.commands).push(argument.kind === "string" ? argument.value : argument.parts[0]);
    });
  };
  visit(tokens);
  // A string that holds a command tool's name could be code the script evaluates later.
  const toolText = /\b(?:exec_command|write_stdin)\b|__delegate\b/;
  const aside = (list) => {
    for (const token of list) {
      if (taken.has(token)) continue;
      const text = token.kind === "string" ? token.value : token.kind === "template" ? token.parts.join(" ") : "";
      if (toolText.test(text) && !keys.has(text) && !isDelegate(text)) read.computed.push("a string holding a command tool's name");
      if (token.kind === "string") read.asides.push(token.value);
      else if (token.kind === "comment") read.asides.push(token.text);
      else if (token.kind === "regex") {
        read.patterns.push(token.text);
        if (decodeEscapes(token.text) !== token.text) read.patterns.push(decodeEscapes(token.text));
      }
      else if (token.kind === "template") { read.asides.push(token.parts.join(" ")); token.inner.forEach(aside); }
    }
  };
  aside(tokens);
  for (const [name, count] of named) if (count > (followed.get(name) ?? 0)) {
    read.computed.push(`${name}: ${count} occurrences but only ${followed.get(name) ?? 0} direct calls followed`);
  }
  return read;
}

/**
 * The literal that a call's one argument, the object literal at `list[at]`, gives `key` at
 * its own top level — the last such property, as in JavaScript; null when that argument is
 * not an object literal or not the call's only one, holds a spread, a computed key, a
 * shorthand or a method, or gives `key` anything but one literal.
 */
function callArgument(list, at, key) {
  const next = (k) => { while (list[k]?.kind === "comment") k++; return k; };
  at = next(at);
  if (list[at]?.kind !== "punct" || list[at].text !== "{") return null;
  let value = null;
  let span = [];
  const settle = () => {
    const [first, colon, ...rest] = span.filter((token) => token.kind !== "comment");
    span = [];
    if (first === undefined) return true;
    const name = first.kind === "name" ? first.text : first.kind === "string" ? first.value : undefined;
    if (name === undefined || colon?.kind !== "punct" || colon.text !== ":") return false;
    if (name !== key) return true;
    if (rest.length !== 1 || !(rest[0].kind === "string" || (rest[0].kind === "template" && !rest[0].computed))) return false;
    value = rest[0];
    return true;
  };
  let depth = 0;
  for (let k = at + 1; k < list.length; k++) {
    const token = list[k];
    if (token.kind === "punct" && "([{".includes(token.text)) depth++;
    else if (token.kind === "punct" && ")]}".includes(token.text)) {
      if (depth === 0) {
        if (token.text !== "}" || !settle()) return null;
        let after = next(k + 1);
        if (list[after]?.text === ",") after = next(after + 1);
        return list[after]?.text === ")" ? value : null;
      }
      depth--;
    } else if (depth === 0 && token.kind === "punct" && token.text === ",") {
      if (!settle()) return null;
      continue;
    }
    span.push(token);
  }
  return null;
}

/**
 * A script's tokens, read as JavaScript far enough to tell a call's argument from the
 * strings, comments and regular expressions beside it: names (escapes decoded), strings
 * (decoded), templates (their text decoded, each substitution lexed as a token list of its
 * own), comments, regular expressions (their text kept), numbers, and punctuation, `=>`,
 * `++`, `--`, `?.` and `...` as one token each. A `/` opens a regular expression at the
 * start, after punctuation other than `)`, `]`, `}`, `++` and `--`, after a keyword that
 * takes an operand, and after the `)` of an `if`, `for`, `while` or `with`; it divides
 * after a value, after any other `)`, after a `]`, after a postfix `++` or `--` and after
 * the `}` of an object literal. After the `}` of a block or a prefix `++` or `--` it could
 * be either, and the script does not read. A word after `.` or `?.` is a property: never a
 * control keyword or one that opens a regular expression, though one spelled like an
 * operand keyword, and a contextual keyword, leave the slash after it unsure; a newline
 * prevents `++`/`--` from being postfix. It throws
 * with the construct named on a script it
 * cannot read: those, an unterminated string, template, comment or regular expression, and
 * a legacy octal escape, whose meaning depends on a mode this reader cannot see.
 */
function scriptTokens(source) {
  let i = 0;
  const numeral = /(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y;
  const nameStart = /[\p{ID_Start}$_]/u;
  const namePart = /[\p{ID_Continue}$‌‍]/u;
  const operandKeywords = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
    "case", "do", "else", "yield", "await"]);

  // `source[i]` is a backslash; leaves `i` on the escape's last character.
  function escaped() {
    const next = source[++i];
    const hex = (length) => {
      const digits = source.slice(i + 1, i + 1 + length);
      if (!/^[\da-fA-F]+$/.test(digits) || digits.length !== length) throw new Error("a malformed escape");
      i += length;
      return parseInt(digits, 16);
    };
    switch (next) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\v";
      case "0":
        if (/\d/.test(source[i + 1] ?? "")) throw new Error("a legacy octal escape");
        return "\0";
      case "1": case "2": case "3": case "4": case "5": case "6": case "7": case "8": case "9":
        throw new Error("a legacy octal escape");
      case "x": return String.fromCharCode(hex(2));
      case "u": {
        if (source[i + 1] !== "{") return String.fromCharCode(hex(4));
        const end = source.indexOf("}", i);
        const digits = end === -1 ? "" : source.slice(i + 2, end);
        if (!/^[\da-fA-F]{1,6}$/.test(digits) || parseInt(digits, 16) > 0x10ffff) throw new Error("a malformed escape");
        i = end;
        return String.fromCodePoint(parseInt(digits, 16));
      }
      case "\r": if (source[i + 1] === "\n") i++; return "";
      case "\n": case " ": case " ": return "";
      case undefined: throw new Error("an unterminated string");
      default: return next;
    }
  }
  function quoted() {
    const quote = source[i];
    let value = "";
    for (i++; i < source.length; i++) {
      const ch = source[i];
      if (ch === quote) { i++; return { kind: "string", value }; }
      if (ch === "\n" || ch === "\r") break;
      value += ch === "\\" ? escaped() : ch;
    }
    throw new Error("an unterminated string");
  }
  function template() {
    const parts = [""];
    const rawParts = [];
    const inner = [];
    let from = i + 1;
    for (i++; i < source.length; i++) {
      const ch = source[i];
      if (ch === "`") { rawParts.push(source.slice(from, i)); i++; return { kind: "template", parts, rawParts, inner, computed: inner.length > 0 }; }
      if (ch === "$" && source[i + 1] === "{") {
        rawParts.push(source.slice(from, i));
        i += 2;
        inner.push(lex(true));
        parts.push("");
        from = i;
        i--;
        continue;
      }
      parts[parts.length - 1] += ch === "\\" ? escaped() : ch;
    }
    throw new Error("an unterminated template");
  }
  function regex() {
    const start = i;
    let inClass = false;
    for (i++; i < source.length; i++) {
      const ch = source[i];
      if (ch === "\n" || ch === "\r") break;
      if (ch === "\\") { i++; continue; }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        const text = source.slice(start + 1, i);
        for (i++; i < source.length && namePart.test(source[i]); i++);
        return { kind: "regex", text };
      }
    }
    throw new Error("an unterminated regular expression");
  }
  function name() {
    let text = "";
    while (i < source.length) {
      if (source[i] === "\\" && source[i + 1] === "u") { text += escaped(); i++; continue; }
      if (!namePart.test(source[i])) break;
      text += source[i++];
    }
    return { kind: "name", text };
  }
  // What a `/` after `previous` is: "regex", "division", or "unsure". A name after `.` or
  // `?.` is a property: never a keyword that opens a regular expression, though one spelled
  // like an operand keyword stays unsure.
  function slashAfter(previous) {
    if (previous === null) return "regex";
    if (previous.kind === "name") {
      if (["of", "yield", "await"].includes(previous.text) || (previous.member && operandKeywords.has(previous.text))) return "unsure";
      return operandKeywords.has(previous.text) && !previous.member ? "regex" : "division";
    }
    if (previous.kind !== "punct") return "division";
    if (previous.text === ")") return previous.control ? "regex" : "division";
    if (previous.text === "]") return "division";
    if (previous.text === "}") return previous.block ? "unsure" : "division";
    if (previous.text === "++" || previous.text === "--") return previous.postfix ? "division" : "unsure";
    return "regex";
  }
  // Whether a `{` after `previous` opens a block: at a statement's start, after `)`, `=>`,
  // `else`, `do`, `try`, `finally` or a class's name; an object literal after an operator.
  function blockAfter(previous, braces) {
    if (previous === null) return true;
    if (previous.kind === "name" && previous.member) return false;
    if (previous.kind === "name") return ["else", "do", "try", "finally"].includes(previous.text) || !operandKeywords.has(previous.text);
    if (previous.kind !== "punct") return false;
    if ([";", "{", "}", ")", "=>"].includes(previous.text)) return true;
    if (previous.text === ":") return braces.length === 0 || braces[braces.length - 1].block;
    return false;
  }
  // A token list up to the end, or up to the `}` closing a template's substitution.
  function lex(substitution) {
    const tokens = [];
    const parens = [];
    const braces = [];
    let previous = null;
    while (i < source.length) {
      const ch = source[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === "/" && source[i + 1] === "/") {
        let end = i + 2;
        while (end < source.length && !"\n\r  ".includes(source[end])) end++;
        tokens.push({ kind: "comment", text: source.slice(i + 2, end) });
        i = end;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        if (end === -1) throw new Error("an unterminated comment");
        tokens.push({ kind: "comment", text: source.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
      let token;
      const start = i;
      if (ch === "'" || ch === '"') token = quoted();
      else if (ch === "`") token = template();
      else if (ch === "/" && slashAfter(previous) === "unsure") throw new Error("a `/` this reader cannot tell for a division or a regular expression");
      else if (ch === "/" && slashAfter(previous) === "regex") token = regex();
      else if (nameStart.test(ch) || (ch === "\\" && source[i + 1] === "u")) token = name();
      else if (/\d/.test(ch) || (ch === "." && /\d/.test(source[i + 1] ?? ""))) {
        numeral.lastIndex = i;
        i += numeral.exec(source)?.[0].length || 1;
        token = { kind: "number" };
      } else {
        const text = /^(?:=>|\+\+|--|\.\.\.|\?\.(?!\d))/.exec(source.slice(i, i + 3))?.[0] ?? ch;
        i += text.length;
        token = { kind: "punct", text };
        if (text === "++" || text === "--") {
          token.postfix = previous !== null && !/[\n\r\u2028\u2029]/.test(source.slice(previous.end, start))
            && (previous.kind === "number" || previous.kind === "string" || previous.kind === "template"
            || (previous.kind === "name" && (previous.member || !operandKeywords.has(previous.text))) || (previous.kind === "punct" && (previous.text === ")" || previous.text === "]")));
        } else if (text === "(") {
          parens.push(previous?.kind === "name" && !previous.member && ["if", "while", "for", "with"].includes(previous.text));
        } else if (text === ")") {
          token.control = parens.pop() ?? false;
        } else if (text === "{") {
          braces.push({ block: blockAfter(previous, braces) });
        } else if (text === "}") {
          if (braces.length === 0 && substitution) return tokens;
          token.block = braces.pop()?.block ?? true;
        }
      }
      token.start = start;
      token.end = i;
      if (token.kind === "name") token.member = previous?.text === "." || previous?.text === "?.";
      tokens.push(token);
      previous = token;
    }
    if (substitution) throw new Error("an unterminated template");
    return tokens;
  }
  return lex(false);
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
