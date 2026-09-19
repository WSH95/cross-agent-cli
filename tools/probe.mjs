#!/usr/bin/env node
// Probe harness: spawn ONE engine CLI the way the adapters spawn one, and show what
// happens. Not product code — no server, no runner, no ledger unless `--track` — but the
// line it spawns **is** the product's: the argv, the settings JSON and the files all come
// from `src/engines/<engine>.ts`'s own `plan`, so what a probe records is evidence about
// what a specialist meets, and a probe cannot drift from the adapter it is testing.
//
//   node tools/probe.mjs --engine claude|codex|grok --cwd DIR [--sandbox read-only|workspace-write|off]
//        [--model M] [--effort E] [--prompt TEXT | --prompt-file F] [--role-file F]
//        [--session-id UUID | --resume ID] [--no-deny] [--dry-run] [--log FILE]
//
// `--role-file F` is the role prompt, which each adapter delivers its own way (a file for
// Claude, `--rules` for Grok, `model_instructions_file` for Codex). `--mcp-config FILE`
// hands the request the `lead` mount that file's single server describes, which is how a
// probe gives a child this server to see; the adapter writes its own config file from it.
//
// The flags a plan cannot express are gone with the hand-built argv they belonged to:
// `--permission-mode` (the adapters fix `bypassPermissions`), `--no-strict-mcp` (the
// exclusion flag is not optional), `--output-format` (Grok's is settled at
// `streaming-messages-json`, P8), `--codex-config` and Codex's `--rules` (P3: rules files
// are not enforced in `codex exec`). The probes that used them — P3, P8, P9, P10 — are
// recorded in `docs/probes.md` against the harness of their day.
//
// --track runs the spawn through the product instead: it builds the launch spec the way
// `delegate` does — a non-lead role at depth 1, `CROSS_AGENT_PROJECT` in the child
// environment, and the `lead` mount field pointing at this server, which is what lets the
// child see any cross-agent tool at all — writes it with a `launching` record through the
// public ledger API, and starts the real detached runner. Integration probe I1's second
// assertion is what needs it: the engine lists exactly the specialist row and its own
// `delegate` is refused naming the task id.
//
//   --track [--project DIR] [--role NAME] [--track-timeout SECONDS]
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const args = parseArgs(process.argv.slice(2));
const engine = need("engine");
const cwd = path.resolve(need("cwd"));
const sandbox = args.sandbox ?? "read-only";
const prompt = args["prompt-file"] ? readFileSync(args["prompt-file"], "utf8") : (args.prompt ?? "Reply with the single word READY.");
const role = args["role-file"] ? readFileSync(args["role-file"], "utf8") : "";
const model = args.model;
const effort = args.effort;
// Deny list (design section 3): the three CLIs, this server, this CLI, cross-agent. The
// adapter's own `denyArgs` turns it into that engine's flags.
const denyTargets = ["claude", "codex", "grok", `node ${path.join(repoRoot, "src", "server.ts")}`, `node ${path.join(repoRoot, "src", "cli.ts")}`, "cross-agent"];

// What `delegate` puts in the spec of a task that runs in a worktree
// (`src/delegate.ts#delegate`): the workspace's own `.git` pointer file and the
// repository's common git directory, which probe P2's Claude row wrote into. Every
// profile gets them — a read-only role that could rewrite its own pointer would be as far
// outside design section 4 as a writable one — and anything that is not a linked worktree
// gets none.
const protectedPaths = worktreeGitPaths(cwd);

const scratch = path.join(cwd, ".cross-agent", "probe");
mkdirSync(scratch, { recursive: true });
const sessionId = args["session-id"] ?? randomUUID();

// Child env (design section 3): inherit the basics, strip host markers, bill the subscription, mark the depth.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  // The same list as `src/guard.ts#childEnv`, `CLAUDE_PROJECT_DIR` included: Claude Code
  // sets it for every MCP server it starts, and a child that inherited it would be told it
  // works where the operator does rather than where its own role does.
  if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_|CODEX_COMPANION_|GROK_CC_|MCP_|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY)$|^(CLAUDE_CODE_|CLAUDE_PLUGIN_|CODEX_COMPANION_|GROK_CC_|MCP_)/.test(k)) continue;
  env[k] = v;
}
Object.assign(env, { CROSS_AGENT_DEPTH: "1", CROSS_AGENT_TASK: `probe-${sessionId}`, CROSS_AGENT_LINEAGE: JSON.stringify([{ taskId: `probe-${sessionId}`, role: `probe-${engine}`, cwd }]) });

// The product's own line. `sandboxFor` re-derives the mode from the engine's profile map,
// which is where a profile this engine does not have is refused, and `plan` is the single
// builder every specialist of this engine is launched by.
const adapter = (await import(path.join(repoRoot, "src", "engines", `${engine}.ts`))).default;
const { sandboxFor } = await import(path.join(repoRoot, "src", "engines", "registry.ts"));
const profile = engine === "grok" && sandbox === "workspace-write" ? "workspace" : sandbox;
const request = {
  role: args.role ?? `probe-${engine}`,
  brief: prompt,
  rolePrompt: role,
  cwd,
  engine,
  sandbox: sandboxFor(engine, profile),
  ...(model ? { model } : {}),
  ...(effort ? { effort } : {}),
  sessionId,
  ...(args.resume ? { resumeSessionId: args.resume } : {}),
  denyTargets: args["no-deny"] ? [] : denyTargets,
  env,
  scratchDir: scratch,
  ...(protectedPaths.length === 0 ? {} : { protectedPaths }),
  ...(args["mcp-config"] ? { lead: leadMountFrom(args["mcp-config"]) } : {}),
  logPath: args.log ? path.resolve(args.log) : path.join(scratch, `${engine}-${sessionId}.log`),
  resultPath: path.join(scratch, `${engine}-${sessionId}.last.txt`),
};

if (args.track) await track();

const plan = adapter.plan(request);
const { bin, argv } = plan;
const stdinText = plan.stdin ?? null;
for (const file of plan.files ?? []) {
  mkdirSync(path.dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.contents, { mode: 0o600 });
}

const log = request.logPath;
const header = { engine, bin, argv, cwd, sandbox: request.sandbox, sessionId, stdin: stdinText !== null, deny: request.denyTargets.length, protectedPaths, at: new Date().toISOString() };
console.log("PROBE " + JSON.stringify(header));
writeFileSync(log, JSON.stringify(header) + "\n");
if (args["dry-run"]) process.exit(0);

const started = Date.now();
const child = spawn(bin, argv, { cwd: plan.cwd, env: plan.env, stdio: [stdinText === null ? "ignore" : "pipe", "pipe", "pipe"] });
if (stdinText !== null) { child.stdin.end(stdinText); }
for (const [name, stream] of [["out", child.stdout], ["err", child.stderr]]) {
  stream.setEncoding("utf8");
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      appendFileSync(log, `${name} ${line}\n`);
      console.log(`${name}| ${line.length > 400 ? line.slice(0, 400) + "…" : line}`);
    }
  });
}
child.on("exit", (code, signal) => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const footer = { exit: code, signal, elapsedSeconds: Number(elapsed), log };
  appendFileSync(log, "EXIT " + JSON.stringify(footer) + "\n");
  console.log("EXIT " + JSON.stringify(footer));
});

/**
 * The spec `delegate` would write for this role, the record that owns it, and the runner
 * that owns the engine from here on — through the product's own modules, so what the child
 * meets is the adapter's spawn line and not this file's. Nothing here is a test hook: the
 * ledger API it writes through is the one the server calls.
 */
async function track() {
  const { childEnv, childLineage } = await import("../src/guard.ts");
  const { create, read, readOutcome, writeSpec } = await import("../src/ledger.ts");
  const projectRoot = path.resolve(args.project ?? cwd);
  const roleKey = args.role ?? "consult";
  const record = create(projectRoot, { role: roleKey, brief: prompt, cwd, engine, ...(model ? { model } : {}), ...(effort ? { effort } : {}), depth: 1 });
  const scratchDir = path.join(path.dirname(record.logPath), `${record.id}.scratch`);
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  writeSpec(projectRoot, record.id, {
    ...request,
    role: roleKey,
    scratchDir,
    env: childEnv(process.env, 0, record.id, childLineage([], { taskId: record.id, role: roleKey, cwd }), "subscription", projectRoot),
    // What an engine-placed lead is given, handed to a specialist on purpose: the run is
    // about what the server does with a child that *can* reach it, which is authority.
    lead: { command: process.execPath, args: [path.join(repoRoot, "src", "server.ts")], env: { CROSS_AGENT_PROJECT: projectRoot } },
    adapterModule: path.join(repoRoot, "src", "engines", `${engine}.ts`),
    logPath: undefined, resultPath: undefined,
  });
  console.log("TRACK " + JSON.stringify({ taskId: record.id, projectRoot, role: roleKey, engine, sandbox: profile, log: record.logPath }));
  const runner = spawn(process.execPath, [path.join(repoRoot, "src", "runner.ts"), "--project", projectRoot, "--task", record.id], {
    cwd: projectRoot, detached: true, stdio: "ignore", env: process.env,
  });
  runner.once("error", (error) => fail(`runner: ${error.message}`));
  runner.unref();
  const deadline = Date.now() + Number(args["track-timeout"] ?? 300) * 1000;
  let status = record.status;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const current = read(projectRoot, record.id);
    if (current.status !== status) console.log(`TRACK ${current.status} at ${new Date().toISOString()}`);
    status = current.status;
    if (["done", "failed", "cancelled", "orphaned"].includes(status)) {
      const outcome = readOutcome(projectRoot, current);
      console.log("TRACK " + JSON.stringify({ status, exitCode: outcome?.exitCode, finalMessage: outcome?.finalMessage?.slice(0, 4000) }));
      process.exit(0);
    }
  }
  console.log(`TRACK still ${status} at the timeout; the record and its log are under ${projectRoot}/.cross-agent/tasks/`);
  process.exit(1);
}

/** The single server of an `--mcp-config` file, as a `lead` mount spec. */
function leadMountFrom(file) {
  const servers = JSON.parse(readFileSync(path.resolve(file), "utf8")).mcpServers ?? {};
  const [name, server] = Object.entries(servers)[0] ?? [];
  if (server === undefined) fail(`${file} declares no mcpServers`);
  console.log(`PROBE mounting ${name} from ${file}`);
  return { command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) };
}

/**
 * `[<worktree>/.git, <common git dir>]` for a linked worktree, `[]` for anything else —
 * a main worktree's `.git` is the common directory itself and a writable role never runs
 * in one. Both realpath'd, as the verifier returns them.
 */
function worktreeGitPaths(directory) {
  const pointer = path.join(directory, ".git");
  try {
    if (!statSync(pointer).isFile()) return [];
    const common = execFileSync("git", ["-C", directory, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).replace(/\n$/, "");
    return [realpathSync(pointer), realpathSync(path.resolve(directory, common))];
  } catch {
    return [];
  }
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith("--")) fail(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (["dry-run", "no-deny", "track"].includes(key)) { out[key] = true; continue; }
    // The flags a plan cannot express went with the hand-built argv (see the header).
    if (["permission-mode", "no-strict-mcp", "output-format", "codex-config", "rules"].includes(key)) {
      fail(`--${key} is gone: the harness builds the product's own line through <engine>.plan, which does not take it`);
    }
    out[key] = list[++i];
  }
  return out;
}

function need(k) { if (!args[k]) fail(`--${k} is required`); return args[k]; }
function fail(msg) { console.error(msg); process.exit(64); }
