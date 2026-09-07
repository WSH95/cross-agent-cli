#!/usr/bin/env node
// Probe harness: spawn ONE engine CLI the way the design (docs/design.md,
// section 3) says an adapter will, and show what happens. Not product code;
// the adapters are written from tests plus the observations this records.
//
//   node tools/probe.mjs --engine claude|codex|grok --cwd DIR [--sandbox read-only|workspace-write|off]
//        [--model M] [--effort E] [--prompt TEXT | --prompt-file F] [--role-file F]
//        [--session-id UUID | --resume ID] [--permission-mode MODE] [--rules F]
//        [--no-deny] [--dry-run] [--log FILE]
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
const bins = { claude: process.env.DEV_TEAM_CLAUDE_BIN ?? "claude", codex: process.env.DEV_TEAM_CODEX_BIN ?? "codex", grok: process.env.DEV_TEAM_GROK_BIN ?? "grok" };

// Deny list (design section 3): the three CLIs, this server, this CLI, dev-team.
const denyTargets = ["claude", "codex", "grok", `node ${path.join(repoRoot, "src", "server.ts")}`, `node ${path.join(repoRoot, "src", "cli.ts")}`, "dev-team"];
const denyRules = args["no-deny"] ? [] : denyTargets.flatMap((t) => [`Bash(${t} *)`, `Bash(${t})`]);

const scratch = path.join(cwd, ".dev-team", "probe");
mkdirSync(scratch, { recursive: true });
const sessionId = args["session-id"] ?? randomUUID();

let bin, argv, stdinText = null;
if (engine === "claude") {
  bin = bins.claude;
  const settings = { sandbox: { enabled: sandbox !== "off", autoAllowBashIfSandboxed: true } };
  argv = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", args["permission-mode"] ?? "bypassPermissions", "--strict-mcp-config"];
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
  argv.push("--json", "-o", out, "-C", cwd, "--sandbox", sandbox === "off" ? "danger-full-access" : sandbox, "--ignore-user-config", "--skip-git-repo-check");
  if (model) argv.push("-m", model);
  if (effort) argv.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  if (args.rules) {
    // Project rules file: installed under the cwd so Codex discovers it (to be confirmed by probe P3).
    const dir = path.join(cwd, ".codex", "rules"); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "dev-team.rules"), readFileSync(args.rules, "utf8"));
  }
  argv.push((role ? role + "\n\n" : "") + prompt);
} else if (engine === "grok") {
  bin = bins.grok;
  const profile = sandbox === "workspace-write" ? "workspace" : sandbox === "off" ? "off" : sandbox;
  argv = ["-p", (role ? role + "\n\n" : "") + prompt, "--cwd", cwd, "--sandbox", profile, "--permission-mode", args["permission-mode"] ?? "bypassPermissions", "--output-format", "json"];
  argv.push(args.resume ? "-r" : "--session-id", args.resume ?? sessionId);
  if (model) argv.push("--model", model);
  if (effort) argv.push("--reasoning-effort", effort);
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
Object.assign(env, { DEV_TEAM_DEPTH: "1", DEV_TEAM_TASK: `probe-${sessionId}`, DEV_TEAM_LINEAGE: `probe/${sessionId}:${engine}:${cwd}` });

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

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith("--")) fail(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "dry-run" || key === "no-deny") { out[key] = true; continue; }
    out[key] = list[++i];
  }
  return out;
}
function need(k) { if (!args[k]) fail(`--${k} is required`); return args[k]; }
function fail(msg) { console.error(msg); process.exit(64); }
