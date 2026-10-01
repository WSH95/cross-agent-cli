import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { read, readSpec } from "../src/ledger.ts";
import { project } from "./helpers/project.ts";

// `tools/probe.mjs` is not product code, but `--track` is how a probe puts a real engine
// under the real runner, and a harness that cannot launch one engine records nothing about
// it. The fake engine stands in for Codex here, reached the way a configured binary is.

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = path.join(repoRoot, "tools", "probe.mjs");

// @anchor trackedLeadMount
test("--track mounts this server with --project in its arguments, which the Codex builder accepts", async (t) => {
  // Any mode will do: neither the harness nor the runner reads one.
  const p = await project(t, { roles: {} }, [{ key: "consult" }]);
  const engineRecord = path.join(p.root, "engine-record.json");
  // `track()` builds the spec's environment with `childEnv`, which passes these three and
  // the project's marker through, so the fake engine is what the runner spawns and the
  // project's sweep finds the runner and the engine alike.
  const { stdout } = await exec(process.execPath, [
    probe, "--engine", "codex", "--track", "--project", p.root, "--cwd", p.root,
    "--sandbox", "read-only", "--prompt", "6b tracked mount", "--track-timeout", "60",
  ], {
    encoding: "utf8",
    env: { ...p.env, CROSS_AGENT_CODEX_BIN: p.bin, FAKE_ENGINE_FORMAT: "codex", FAKE_ENGINE_RECORD: engineRecord },
  });
  const started = stdout.split("\n").find((line) => line.startsWith("TRACK {"));
  assert.ok(started, stdout);
  const { taskId } = JSON.parse(started.slice("TRACK ".length)) as { taskId: string };
  const server = path.join(repoRoot, "src", "server.ts");

  // The design's mount spec passes the project in the arguments (`src/project.ts`:
  // `--project` outranks `CROSS_AGENT_PROJECT`), and an environment is what Codex's
  // builder refuses outright, so the spec carries none.
  assert.deepEqual(readSpec(p.root, taskId).lead, { command: process.execPath, args: [server, "--project", p.root] });
  // The harness exits 0 on any terminal status, so the verdict is the record's: a mount
  // the builder refused settles `failed` with `codex launch error: codex leadMount: …`.
  const settled = read(p.root, taskId);
  assert.equal(settled.status, "done", JSON.stringify(settled));
  const argv = (JSON.parse(fs.readFileSync(engineRecord, "utf8")) as { argv: string[] }).argv;
  const settings = argv.flatMap((value, index) => (argv[index - 1] === "-c" && value.startsWith("mcp_servers.") ? [value] : []));
  assert.deepEqual(settings, [
    `mcp_servers.cross-agent.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.cross-agent.args=${JSON.stringify([server, "--project", p.root])}`,
    'mcp_servers.cross-agent.default_tools_approval_mode="approve"',
    // The adapter's own per-tool timeout, which the harness's mount gets like any lead's.
    "mcp_servers.cross-agent.tool_timeout_sec=3600",
    'mcp_servers.cross-agent.env_vars=["CROSS_AGENT_DEPTH","CROSS_AGENT_TASK","CROSS_AGENT_LINEAGE","CROSS_AGENT_PROJECT"]',
  ]);
});
