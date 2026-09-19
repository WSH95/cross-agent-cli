#!/usr/bin/env node
// The Verification section's "End-to-end under each host" list, checked against a project
// an end-to-end run has just finished in. Not product code and not a test: it reads a
// repository and a ledger and says what it found, so E1 under Claude Code, E2 under Codex
// and E3 under Grok are judged by the same eight checks rather than by whatever a report
// happened to grep that day.
//
//   node tools/e2e-verify.mjs --project <sample root> [--default-branch main]
//       [--slug <journal slug>] [--branch-pattern 'task/*']
//       [--test-command <command>] [--since <ISO date or task id>]
//
// `--slug` names the journal to read; with none, every journal in the project is read.
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

const args = parse(process.argv.slice(2));
const project = path.resolve(args.project ?? ".");
if (!existsSync(path.join(project, ".git"))) fail(`${project} is not a git repository`);

const config = readJson(path.join(project, ".cross-agent", "config.json")) ?? {};
const defaultBranch = args["default-branch"] ?? config.project?.defaultBranch ?? "main";
const branchPattern = args["branch-pattern"] ?? "task/*";
const testCommand = args["test-command"] ?? config.project?.testCommand;
const maxDepth = config.limits?.maxDepth ?? 1;

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
  check(`every record at depth <= ${maxDepth}`, "?", "no records");
} else {
  const logless = run.filter((record) => !(existsSync(record.logPath) && statSync(record.logPath).size > 0));
  check("one record per delegation, each with its native log", logless.length === 0 ? "pass" : "FAIL",
    logless.length === 0 ? `${run.length} records` : logless.map((record) => record.id.slice(0, 8)).join(", "));
  const deep = run.filter((record) => (record.depth ?? 0) > maxDepth);
  check(`every record at depth <= ${maxDepth}`, deep.length === 0 ? "pass" : "FAIL",
    deep.length === 0 ? `${run.length} records` : deep.map((record) => `${record.id.slice(0, 8)}=${record.depth}`).join(", "));
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
// prefix a host gives them. A log no parser here understands is evidence of nothing, and
// evidence of nothing is never a pass.
//
// **Codex's MCP items are not parsed, because no archived Codex run has shown one.** Its
// `--json` transcripts hold `agent_message` and `command_execution` items and nothing
// else (`docs/probes.md`, the native samples); how it names an MCP call is I1's Codex row
// to record. Until then a Codex log carrying any other item type is answered `?` rather
// than guessed at, and one carrying only those two is judged on its commands.
const codexItems = new Set(["agent_message", "command_execution"]);
// A quote is a delimiter like any other: Codex wraps every command in `/bin/bash -lc '…'`
// (P9, P10), so the engine's own name is preceded by `'` and not by whitespace. A path is
// still that engine — the deny list names `/opt/custom codex` as readily as `codex` — and
// this server's own entry point is a launch of its own, so a `src/server.ts` or
// `server.js` argument counts however it is reached.
const launcher = /(^|[|&;`('"()\s/])(claude|codex|grok|cross-agent)(\s|$|['"])|(^|[\s'"])[^\s'"]*\/server\.(?:ts|js)(\s|$|['"])/;
const isDelegate = (name) => typeof name === "string" && (name === "delegate" || name.endsWith("__delegate"));
const offences = [];
const unreadable = [];
let scanned = 0;
for (const record of run) {
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
      understood++;
      if (item.type === "command_execution" && typeof item.command === "string") commands.push(item.command);
      continue;
    }
    // Everything else an engine says about itself — a hook, a rate-limit notice, a
    // session line, a result — carries no tool call and no command, so an unfamiliar
    // `type` here is noise rather than evidence withheld.
    if (typeof event.type === "string") understood++;
    else unparsable++;
  }
  if (understood === 0 || unparsable > 0 || unknownItems.length > 0) {
    unreadable.push(unknownItems.length > 0
      ? `${record.id.slice(0, 8)}: Codex item${unknownItems.length === 1 ? "" : "s"} this build cannot read (${[...new Set(unknownItems)].join(", ")})`
      : `${record.id.slice(0, 8)}: ${unparsable} line${unparsable === 1 ? "" : "s"} in no shape this reads`);
    continue;
  }
  scanned++;
  for (const name of calls) {
    if (isDelegate(name)) offences.push(`${record.id.slice(0, 8)} called ${name}`);
  }
  for (const command of commands) {
    if (launcher.test(command)) offences.push(`${record.id.slice(0, 8)} ran ${command.slice(0, 60)}`);
  }
}
check("no delegate call and no engine launch in any specialist transcript",
  offences.length > 0 ? "FAIL" : unreadable.length > 0 || scanned === 0 ? "?" : "pass",
  offences.length > 0 ? offences.slice(0, 5).join(" | ")
    : unreadable.length > 0 ? `${scanned} scanned; ${unreadable.slice(0, 3).join(" | ")}`
      : `${scanned} transcripts`);

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
