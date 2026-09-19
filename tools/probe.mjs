#!/usr/bin/env node
// Probe harness: spawn ONE engine CLI the way the design (docs/design.md,
// section 3) says an adapter will, and show what happens. Not product code;
// the adapters are written from tests plus the observations this records.
//
//   node tools/probe.mjs --engine claude|codex|grok --cwd DIR [--sandbox read-only|workspace-write|off]
//        [--model M] [--effort E] [--prompt TEXT | --prompt-file F] [--role-file F]
//        [--session-id UUID | --resume ID] [--permission-mode MODE]
//        [--no-deny] [--dry-run] [--log FILE]
//
// Passthrough flags, each one engine's only (ignored by the others):
//   claude: [--mcp-config FILE]  mounts that file's servers; [--no-strict-mcp]
//           drops --strict-mcp-config so the user's own servers are inherited.
//   codex:  [--codex-config KEY=VALUE]  repeatable, appended as -c KEY=VALUE;
//           [--rules F]  installs F as <cwd>/.codex/rules/cross-agent.rules.
//   grok:   [--output-format json|streaming-json|streaming-messages-json]
//           (default json); [--rules TEXT]  appended as --rules TEXT.
//
// --track runs the spawn through the product instead of this file: it builds the launch
// spec the way `delegate` does — a non-lead role at depth 1, `CROSS_AGENT_PROJECT` in the
// child environment, and the `lead` mount field pointing at this server, which is what lets
// the child see any cross-agent tool at all — writes it with a `launching` record through
// the public ledger API, and starts the real detached runner. Integration probe I1's
// second assertion is what needs it: the engine lists exactly the specialist row and its
// own `delegate` is refused naming the task id.
//
//   --track [--project DIR] [--role NAME] [--track-timeout SECONDS]
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
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
const bins = { claude: process.env.CROSS_AGENT_CLAUDE_BIN ?? "claude", codex: process.env.CROSS_AGENT_CODEX_BIN ?? "codex", grok: process.env.CROSS_AGENT_GROK_BIN ?? "grok" };

// Deny list (design section 3): the three CLIs, this server, this CLI, cross-agent.
const denyTargets = ["claude", "codex", "grok", `node ${path.join(repoRoot, "src", "server.ts")}`, `node ${path.join(repoRoot, "src", "cli.ts")}`, "cross-agent"];
const denyRules = args["no-deny"] ? [] : denyTargets.flatMap((t) => [`Bash(${t} *)`, `Bash(${t})`]);

const scratch = path.join(cwd, ".cross-agent", "probe");
mkdirSync(scratch, { recursive: true });
const sessionId = args["session-id"] ?? randomUUID();

let bin, argv, stdinText = null;
if (engine === "claude") {
  bin = bins.claude;
  // The adapter's own settings, so a probe sees what a real child sees
  // (`src/engines/claude.ts#claude`, the `plan` member): no escape hatch out of a sandbox
  // that is on, a sandbox that cannot start fails the run, and a writable role gets exactly
  // one writable root, its workspace.
  const settings = { sandbox: { enabled: sandbox !== "off", autoAllowBashIfSandboxed: true } };
  if (sandbox !== "off") { settings.sandbox.allowUnsandboxedCommands = false; settings.sandbox.failIfUnavailable = true; }
  if (sandbox === "workspace-write") settings.sandbox.filesystem = { allowWrite: [cwd] };
  argv = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", args["permission-mode"] ?? "bypassPermissions"];
  if (!args["no-strict-mcp"]) argv.push("--strict-mcp-config");
  if (args["mcp-config"]) argv.push("--mcp-config", path.resolve(args["mcp-config"]));
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  argv.push(args.resume ? "--resume" : "--session-id", args.resume ?? sessionId);
  if (role) { const f = path.join(scratch, "role.md"); writeFileSync(f, role); argv.push("--append-system-prompt-file", f); }
  argv.push("--settings", JSON.stringify(settings));
  const disallowed = [...denyRules];
  if (sandbox === "read-only") disallowed.push("Edit", "Write", "MultiEdit", "NotebookEdit");
  if (disallowed.length) argv.push("--disallowedTools", ...disallowed);
  stdinText = prompt; // the prompt goes through stdin so no positional follows the variadic flag
} else if (engine === "codex") {
  bin = bins.codex;
  const out = path.join(scratch, `codex-${sessionId}.last.txt`);
  argv = args.resume ? ["exec", "resume", args.resume] : ["exec"];
  argv.push("--json", "-o", out);
  // `codex exec resume` takes neither -C nor --sandbox (0.153.4 `--help`); the
  // resumed turn gets this process's cwd, and its sandbox is probe P10's question.
  if (!args.resume) argv.push("-C", cwd, "--sandbox", sandbox === "off" ? "danger-full-access" : sandbox);
  argv.push("--ignore-user-config", "--skip-git-repo-check");
  if (model) argv.push("-m", model);
  if (effort) argv.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  for (const setting of args["codex-config"]) argv.push("-c", setting);
  if (args.rules) {
    // Project rules file: installed under the cwd so Codex discovers it (to be confirmed by probe P3).
    const dir = path.join(cwd, ".codex", "rules"); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "cross-agent.rules"), readFileSync(args.rules, "utf8"));
  }
  argv.push((role ? role + "\n\n" : "") + prompt);
} else if (engine === "grok") {
  bin = bins.grok;
  const profile = sandbox === "workspace-write" ? "workspace" : sandbox === "off" ? "off" : sandbox;
  argv = ["-p", (role ? role + "\n\n" : "") + prompt, "--cwd", cwd, "--sandbox", profile, "--permission-mode", args["permission-mode"] ?? "bypassPermissions", "--output-format", args["output-format"] ?? "json"];
  argv.push(args.resume ? "-r" : "--session-id", args.resume ?? sessionId);
  if (model) argv.push("--model", model);
  if (effort) argv.push("--reasoning-effort", effort);
  if (args.rules) argv.push("--rules", args.rules);
  for (const rule of denyRules) argv.push("--deny", rule);
} else {
  fail(`unknown engine ${engine}`);
}

// Child env (design section 3): inherit the basics, strip host markers, bill the subscription, mark the depth.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PLUGIN_|CODEX_COMPANION_|GROK_CC_|MCP_|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY)/.test(k)) continue;
  env[k] = v;
}
Object.assign(env, { CROSS_AGENT_DEPTH: "1", CROSS_AGENT_TASK: `probe-${sessionId}`, CROSS_AGENT_LINEAGE: JSON.stringify([{ taskId: `probe-${sessionId}`, role: `probe-${engine}`, cwd }]) });

if (args.track) await track();

const log = args.log ? path.resolve(args.log) : path.join(scratch, `${engine}-${sessionId}.log`);
const header = { engine, bin, argv, cwd, sandbox, sessionId, stdin: stdinText !== null, deny: denyRules.length, at: new Date().toISOString() };
console.log("PROBE " + JSON.stringify(header));
writeFileSync(log, JSON.stringify(header) + "\n");
if (args["dry-run"]) process.exit(0);

const started = Date.now();
const child = spawn(bin, argv, { cwd, env, stdio: [stdinText === null ? "ignore" : "pipe", "pipe", "pipe"] });
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
  const { sandboxFor } = await import("../src/engines/registry.ts");
  const projectRoot = path.resolve(args.project ?? cwd);
  const roleKey = args.role ?? "consult";
  // The engines name the same mode differently, and the spec carries the engine's own name.
  const profile = engine === "grok" && sandbox === "workspace-write" ? "workspace" : sandbox;
  const record = create(projectRoot, { role: roleKey, brief: prompt, cwd, engine, ...(model ? { model } : {}), ...(effort ? { effort } : {}), depth: 1 });
  const scratchDir = path.join(path.dirname(record.logPath), `${record.id}.scratch`);
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  writeSpec(projectRoot, record.id, {
    role: roleKey, brief: prompt, rolePrompt: role,
    cwd, engine, sandbox: sandboxFor(engine, profile),
    ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    sessionId,
    denyTargets,
    env: childEnv(process.env, 0, record.id, childLineage([], { taskId: record.id, role: roleKey, cwd }), "subscription", projectRoot),
    scratchDir,
    // What an engine-placed lead is given, handed to a specialist on purpose: the run is
    // about what the server does with a child that *can* reach it, which is authority.
    lead: { command: process.execPath, args: [path.join(repoRoot, "src", "server.ts")], env: { CROSS_AGENT_PROJECT: projectRoot } },
    adapterModule: path.join(repoRoot, "src", "engines", `${engine}.ts`),
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

function parseArgs(list) {
  const out = { "codex-config": [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith("--")) fail(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "dry-run" || key === "no-deny" || key === "no-strict-mcp" || key === "track") { out[key] = true; continue; }
    if (key === "codex-config") { out[key].push(list[++i]); continue; }
    out[key] = list[++i];
  }
  return out;
}
function need(k) { if (!args[k]) fail(`--${k} is required`); return args[k]; }
function fail(msg) { console.error(msg); process.exit(64); }
