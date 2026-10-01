#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, DEFAULT_MODE, initConfig, loadConfig } from "./config.ts";
import { isTerminal, scan } from "./ledger.ts";
import type { TaskRecord } from "./ledger.ts";
import { answerAsk } from "./mailbox.ts";
import { builtInModesDir, loadMode } from "./modes.ts";
import { discoverProject, parseFlags } from "./project.ts";

// `cross-agent`, the operator's own entry point (design section 10): a table of verbs over
// one parser and one exit protocol. `init` writes the bind-time config for a mode; `answer`
// replies to an engine-placed lead's question without a host session; `report` renders the
// per-task log from the ledger, which is where that log comes from under engine placement.
// The other verbs of section 10 are step 13's, on this same table.

/**
 * The exit protocol, one for every verb. 4, 5 and 6 are defined and documented now so a
 * script can rely on them; the verbs step 13 adds are the ones that exit with them.
 */
export const EXIT = { ok: 0, error: 1, usage: 2, precondition: 3, running: 4, needsOperator: 5, stalled: 6 } as const;

const PROTOCOL = [
  `  ${EXIT.ok}  ok`,
  `  ${EXIT.error}  error: something this command did not anticipate failed`,
  `  ${EXIT.usage}  usage: the command line could not be read`,
  `  ${EXIT.precondition}  precondition: the project, the mode, the ask or the task is not in the state the verb needs`,
  `  ${EXIT.running}  still running: a task the verb reads has not settled (step 13's verbs)`,
  `  ${EXIT.needsOperator}  needs the operator: a lead is waiting on an open ask (step 13's verbs)`,
  `  ${EXIT.stalled}  stalled: a task's engine has been silent past limits.stallMinutes (step 13's verbs)`,
].join("\n");

export interface CliOutput {
  out: (text: string) => void;
  err: (text: string) => void;
}

interface Parsed {
  positionals: string[];
  values: Record<string, string>;
  json: boolean;
}

interface Context {
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
}

/** What a verb answers: its exit code, the one document `--json` prints, and what a person reads. */
interface Answer {
  code: number;
  document: unknown;
  /** stdout when the code is 0, stderr otherwise. */
  text: string;
  /** For stderr beside a successful answer — a warning — and never under `--json`, where the document carries it. */
  notes?: string;
}

interface Verb {
  /** The line usage prints for it, without the global flags. */
  usage: string;
  summary: string;
  positionals: string[];
  /** Value flags beyond `--project`, as `parseFlags` takes them. */
  flags: Record<string, string>;
  run(parsed: Parsed, context: Context): Promise<Answer>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refused(reason: string, document: unknown = { ok: false, reason }): Answer {
  return { code: EXIT.precondition, document, text: `cross-agent: ${reason}\n` };
}

/** The project every verb but `init` reads, found as the server finds it (design, "Which project"). */
async function project(parsed: Parsed, context: Context): Promise<{ root: string } | { reason: string }> {
  const named = parsed.values["--project"];
  return discoverProject(named === undefined ? [] : ["--project", named], context.env, context.cwd);
}

// @anchor initVerb
const init: Verb = {
  usage: "cross-agent init [--mode <name>] [--project <root>]",
  summary: "write .cross-agent/config.json, binding every role of a mode to an engine",
  positionals: [],
  flags: { "--mode": "name" },
  async run(parsed, context) {
    const mode = parsed.values["--mode"] ?? DEFAULT_MODE;
    let root: string;
    try {
      // An existing directory, resolved before anything is written: `initConfig` creates
      // `.cross-agent/` with its parents, and a typo in `--project` would otherwise leave a
      // project tree somewhere nobody asked for one.
      root = fs.realpathSync(path.resolve(context.cwd, parsed.values["--project"] ?? "."));
      if (!fs.statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
    } catch (error) {
      return refused(`cannot resolve the project: ${message(error)}`);
    }
    try {
      // The mode first, so a name this build has no mode for, or a mode that does not
      // validate, is the precondition it is rather than an error halfway through a write.
      loadMode(builtInModesDir(), mode);
    } catch (error) {
      return refused(message(error));
    }
    const result = initConfig(root, { mode });
    const file = path.join(root, CONFIG_PATH);
    const lines = [result.wrote ? `cross-agent: wrote ${file} for mode ${mode}` : `cross-agent: ${file} already exists; nothing was written`];
    if (result.ignored.length > 0) lines.push(`cross-agent: added ${result.ignored.join(", ")} to ${path.join(root, ".gitignore")}`);
    return {
      code: EXIT.ok,
      document: { wrote: result.wrote, file, mode, ignored: result.ignored, ...(result.warning === undefined ? {} : { warning: result.warning }) },
      text: `${lines.join("\n")}\n`,
      ...(result.warning === undefined ? {} : { notes: `cross-agent: ${result.warning}\n` }),
    };
  },
};

// @anchor answerVerb
const answer: Verb = {
  usage: "cross-agent answer <ask-id> <text> [--project <root>]",
  summary: "answer an engine-placed lead's open question; the first answer stands",
  positionals: ["ask-id", "text"],
  flags: {},
  async run(parsed, context) {
    const [id, text] = parsed.positionals;
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    // Discovery falls back to a git toplevel with no config, which runs solo and asks
    // nothing: an ask file left there belongs to no lead this project can run, and
    // answering it would write in a project nobody configured. Checked before any write.
    const configFile = path.join(found.root, CONFIG_PATH);
    if (!fs.existsSync(configFile)) return refused(`${found.root} holds no ${CONFIG_PATH}: no engine-placed lead of this project asks anything`);
    try {
      loadConfig(found.root);
    } catch (error) {
      return refused(message(error));
    }
    // An id that could not name a file names no ask either, and `answerAsk` says so by
    // value through the mailbox's own predicate (`src/mailbox.ts#isAskId`).
    const answered = await answerAsk(found.root, id, text);
    if (!answered.applied) return refused(answered.reason, answered);
    const { ask } = answered;
    return {
      code: EXIT.ok, document: answered,
      text: `cross-agent: answered ask ${ask.id} of task ${ask.taskId} at ${new Date(ask.answeredAt!).toISOString()}\n`
        + `  question: ${ask.question}\n  answer: ${ask.answer}\n`,
    };
  },
};

/** One task as the report renders it, in either form. */
interface ReportedTask {
  id: string;
  role: string;
  engine: string;
  model: string | null;
  effort: string | null;
  status: TaskRecord["status"];
  durationSeconds: number;
  /** `passed` for done, `failed` for failed or cancelled, `unknown` until it settles or when its result file is missing. */
  outcome: "passed" | "failed" | "unknown";
  /** The final message in full, or null where there is no result file. */
  result: string | null;
}

function reported(record: TaskRecord, now: number): ReportedTask {
  let result: string | null = null;
  try {
    result = fs.readFileSync(record.resultPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const terminal = isTerminal(record.status);
  // A settled task's duration stops at its settlement, as `check` reports it.
  const until = terminal ? record.updatedAt : now;
  const outcome = !terminal || result === null ? "unknown" : record.status === "done" ? "passed" : "failed";
  return {
    id: record.id, role: record.role, engine: record.engine, model: record.model ?? null, effort: record.effort ?? null,
    status: record.status, durationSeconds: Math.max(0, Math.round((until - record.createdAt) / 1000)), outcome, result,
  };
}

// @anchor reportVerb
const report: Verb = {
  usage: "cross-agent report [--since <task id>] [--project <root>]",
  summary: "every task, newest first — role, engine, model, effort, duration, outcome, id — then each final message",
  positionals: [],
  flags: { "--since": "task id" },
  async run(parsed, context) {
    const found = await project(parsed, context);
    if ("reason" in found) return refused(found.reason);
    // A read and only a read: no reconciliation pass, and nothing created where no ledger is.
    const { records, invalid } = scan(found.root);
    let chosen = records;
    const since = parsed.values["--since"];
    if (since !== undefined) {
      const from = records.find((record) => record.id === since);
      if (from === undefined) return refused(`no task ${since}`);
      chosen = records.filter((record) => record.createdAt >= from.createdAt);
    }
    const now = Date.now();
    const tasks = chosen
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
      .map((record) => reported(record, now));
    const rows = tasks.map((task) => [
      task.role, task.engine, task.model ?? "-", task.effort ?? "-", `${task.durationSeconds}s`, task.outcome, task.id,
    ].join(" | "));
    const messages = tasks.map((task) => `## ${task.id} — ${task.role}, ${task.outcome}\n\n${task.result ?? "(no result file)"}`);
    return {
      code: EXIT.ok,
      document: { tasks, ...(invalid.length === 0 ? {} : { invalid }) },
      text: tasks.length === 0 ? "" : `${rows.join("\n")}\n\n${messages.map((entry) => entry.replace(/\n*$/, "\n")).join("\n")}`,
      ...(invalid.length === 0 ? {} : { notes: invalid.map((entry) => `cross-agent: invalid task record ${entry.file}: ${entry.reason}\n`).join("") }),
    };
  },
};

const verbs: Record<string, Verb> = { init, answer, report };

function usageOf(verb?: Verb): string {
  if (verb !== undefined) return `usage: ${verb.usage} [--json] [--help]\n`;
  return `usage: cross-agent <verb> [arguments] [--project <root>] [--json] [--help]\n`
    + Object.values(verbs).map((each) => `  ${each.usage}\n`).join("");
}

function help(): string {
  return `usage: cross-agent <verb> [arguments] [--project <root>] [--json] [--help]\n\n`
    + Object.values(verbs).map((verb) => `  ${verb.usage}\n      ${verb.summary}\n`).join("")
    + "\n--json prints one JSON document on stdout; --help prints this. Without --project the project is\n"
    + "the one the server would find: CROSS_AGENT_PROJECT, then the nearest .cross-agent/config.json.\n\n"
    + `exit codes:\n${PROTOCOL}\n`;
}

/**
 * The verb, and every other token in the order given: the global flags (`--json`, `--help`,
 * `--project <root>`) may come before the verb as well as after it.
 */
function split(argv: readonly string[]): { verb?: string; rest: string[] } {
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--json" || token === "--help") {
      rest.push(token);
    } else if (token === "--project") {
      rest.push(token, ...argv.slice(index + 1, index + 2));
      index++;
    } else {
      return token.startsWith("--") ? { rest: [...argv] } : { verb: token, rest: [...rest, ...argv.slice(index + 1)] };
    }
  }
  return { rest };
}

/**
 * One verb's command line: its positionals, `--json` and `--help` once each, `--` ending the
 * flags, and every `--flag <value>` pair through `parseFlags` — the parser the server's own
 * argv goes through — so an unknown flag, a missing or empty value and a repeat are each a
 * reason rather than a guess (`src/project.ts#parseFlags`).
 */
function parse(name: string, verb: Verb, argv: readonly string[]): (Parsed & { help: boolean }) | { reason: string } {
  const pairs: string[] = [];
  const positionals: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === "--json" || token === "--help") {
      if (seen.has(token)) return { reason: `${token} given twice` };
      seen.add(token);
    } else if (token.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { reason: `${token} needs a value` };
      pairs.push(token, value);
      index++;
    } else {
      positionals.push(token);
    }
  }
  const flags = parseFlags(pairs, { ...verb.flags, "--project": "root" });
  if ("reason" in flags) return flags;
  if (seen.has("--help")) return { positionals, values: flags.values, json: seen.has("--json"), help: true };
  if (positionals.length !== verb.positionals.length) {
    const wanted = verb.positionals.length === 0 ? "no arguments" : verb.positionals.map((each) => `<${each}>`).join(" ");
    return { reason: `${name} takes ${wanted}, not ${positionals.length === 0 ? "none" : positionals.map((each) => JSON.stringify(each)).join(" ")}` };
  }
  if (positionals.some((each) => each === "")) return { reason: `${name}'s ${verb.positionals.join(" and ")} must not be empty` };
  return { positionals, values: flags.values, json: seen.has("--json"), help: false };
}

/** The exit code this command line earns, by the protocol `EXIT` names. */
export async function runCli(
  argv: readonly string[], cwd: string, write: CliOutput, env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<number> {
  const { verb: name, rest } = split(argv);
  if (name === "help" || (name === undefined && rest.includes("--help"))) {
    write.out(help());
    return EXIT.ok;
  }
  if (name === undefined || !Object.hasOwn(verbs, name)) {
    write.err(`cross-agent: ${name === undefined ? "no command" : `unknown command ${JSON.stringify(name)}`}\n${usageOf()}`);
    return EXIT.usage;
  }
  const verb = verbs[name];
  const parsed = parse(name, verb, rest);
  if ("reason" in parsed) {
    write.err(`cross-agent: ${parsed.reason}\n${usageOf(verb)}`);
    return EXIT.usage;
  }
  if (parsed.help) {
    write.out(help());
    return EXIT.ok;
  }
  let answered: Answer;
  try {
    answered = await verb.run(parsed, { cwd, env });
  } catch (error) {
    // Nothing a verb anticipated: the message, and nothing a script would parse.
    write.err(`cross-agent: ${message(error)}\n`);
    return EXIT.error;
  }
  if (parsed.json) {
    write.out(`${JSON.stringify(answered.document, null, 2)}\n`);
  } else if (answered.code === EXIT.ok) {
    write.out(answered.text);
    if (answered.notes !== undefined) write.err(answered.notes);
  } else {
    write.err(answered.text);
  }
  return answered.code;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void runCli(process.argv.slice(2), process.cwd(), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  }).then((code) => { process.exitCode = code; });
}
