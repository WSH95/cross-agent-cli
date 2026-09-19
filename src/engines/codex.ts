import path from "node:path";
import { commandPath, engineBin } from "./binaries.ts";
import { truncate } from "./text.ts";
import type { EngineAdapter, EngineEvent, LeadMount, LeadMountSpec, SpawnPlan, SpawnRequest } from "./types.ts";

/** A field Codex declares as a string, as the string it is or as nothing at all. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The name Codex gives a profile on its command line. `off` is `danger-full-access` in
 * both places the profile appears — `--sandbox` on launch and `-c sandbox_mode=` on
 * resume — and every other profile name is already Codex's own (design section 3).
 */
function sandboxName(profile: string): string {
  return profile === "off" ? "danger-full-access" : profile;
}

/**
 * What a failed turn says. `turn.failed` carries the message under `error`, and a failure
 * that arrives without one still has to say which engine failed and that it said nothing.
 */
function failureText(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message !== "" ? message : "codex reported a failed turn with no message";
}

/**
 * Codex, on the `codex exec` line P2 and P5 recorded, the `codex exec resume` line P10
 * recorded, and the `--json` output the probe logs sampled.
 */
const codex = {
  name: "codex",
  sandboxProfiles: { "read-only": "read-only", "workspace-write": "write", off: "off" },

  // `protectedPaths` needs no argument here: `workspace-write` denies every write outside
  // the workspace and protects the `.git` entry inside it, both observed (P2, Codex).

  /**
   * Codex's sandbox is the binary's own, so the binary resolving is the whole of the
   * check. What it cannot see is where the workspace is: Codex treats `/tmp` and `$TMPDIR`
   * as writable, so a project under either is not isolated by a workspace-write profile.
   * `cross-agent init` warns about that (design section 3,
   * `src/config.ts#temporaryLocationWarning`); the adapter does not refuse, because the
   * operator may have meant it.
   */
  sandboxSupport(env: Readonly<NodeJS.ProcessEnv>): { ok: true } | { ok: false; reason: string } {
    const bin = engineBin("codex", env);
    return commandPath(bin, env) === null
      ? { ok: false, reason: `codex binary ${JSON.stringify(bin)} not found; set engines.codex.bin or CROSS_AGENT_CODEX_BIN` }
      : { ok: true };
  },

  // No deny list: `codex exec` does not honour execpolicy rules files, so the sandbox's
  // own network denial is the layer that holds instead (probes P3/P3b).
  denyArgs(_targets: readonly string[]): string[] {
    return [];
  },

  // Keeps auth, raises no trust prompt, and removes the operator's MCP servers (P5).
  exclusionArgs(): string[] {
    return ["--ignore-user-config"];
  },

  /**
   * The three settings P9 recorded. The third is not optional: `codex exec` runs with
   * approval policy `never`, so without it the lead sees the tools and every call is
   * refused. The values are TOML, so the quotes are part of the argument.
   */
  leadMount(spec: LeadMountSpec, _scratchDir: string): LeadMount {
    // No probed setting carries a server environment, and emitting an unprobed one would
    // be the only flag in this file no run has exercised. A lead's project reaches it
    // through `args` (`--project <root>`), so refusing here loses nothing.
    if (spec.env !== undefined && Object.keys(spec.env).length > 0) {
      throw new Error("codex leadMount: no probed setting carries an env for a mounted server; pass what the lead needs in args");
    }
    return {
      argv: [
        "-c", `mcp_servers.cross-agent.command=${JSON.stringify(spec.command)}`,
        "-c", `mcp_servers.cross-agent.args=${JSON.stringify(spec.args)}`,
        "-c", 'mcp_servers.cross-agent.default_tools_approval_mode="approve"',
      ],
    };
  },

  /**
   * P2's `codex exec` line for a launch and P10's `codex exec resume` line for a resume,
   * which is a different subcommand with a different flag set: it accepts neither `-C` nor
   * `--sandbox`, and a resumed thread keeps neither the cwd nor the sandbox it was
   * launched with. So the resume re-applies both — the cwd as the spawn's own, because
   * `-c cwd=` is ignored and the writable root silently follows the process, and the
   * profile as `-c sandbox_mode=`, because the thread comes back read-only whatever it was.
   * Both heads take the prompt from stdin behind a `-` positional.
   */
  plan(request: SpawnRequest): SpawnPlan {
    const sandbox = sandboxName(request.sandbox.profile);
    const resume = request.resumeSessionId;
    // The `-o` file is the pipeline's own result path: Codex writes its last message
    // there, the pipeline reads it back as `resultFileText` and rewrites it with
    // `finalMessage`. It is emptied below, before the spawn.
    const argv = resume
      ? ["exec", "resume", resume, "--json", "-o", request.resultPath]
      : ["exec", "--json", "-o", request.resultPath, "-C", request.cwd, "--sandbox", sandbox];
    argv.push(...codex.exclusionArgs(), "--skip-git-repo-check", ...codex.denyArgs(request.denyTargets));
    if (request.model) argv.push("-m", request.model);
    if (request.effort) argv.push("-c", `model_reasoning_effort=${JSON.stringify(request.effort)}`);
    // The profile the launch line spent `--sandbox` on, restored the only way the resume
    // subcommand accepts. There is no unsandboxed resume by omission (P10).
    if (resume) argv.push("-c", `sandbox_mode=${JSON.stringify(sandbox)}`);

    // Created empty, so that a run which dies before Codex writes its last message leaves
    // nothing for the pipeline to read back and report as this one's. Every run has its
    // own file: a resume is a record of its own, with its own `<id>.out`.
    const files: NonNullable<SpawnPlan["files"]> = [{ path: request.resultPath, contents: "" }];
    // A Codex role prompt reaches the child as a file, and it is obeyed with no role text
    // in the prompt at all (P9), so a lead spends no prompt space on the loop. The file is
    // the task's own, never inside the specialist's worktree, which the role may edit. The
    // value is TOML, so the quotes are part of the argument. It is re-supplied on a resume
    // for the same reason the sandbox is: a `-c` setting belongs to the process, and the
    // resumed thread is a new one.
    if (request.rolePrompt !== "") {
      const rolePath = path.join(request.scratchDir, "role.md");
      files.push({ path: rolePath, contents: request.rolePrompt });
      argv.push("-c", `model_instructions_file=${JSON.stringify(rolePath)}`);
    }
    if (request.lead !== undefined) {
      const mount = codex.leadMount(request.lead, request.scratchDir);
      // The whole mount, not its argv alone: an adapter may name a file its argv points
      // at. Codex's own mount is three `-c` settings and no file, but `plan` reads the
      // contract, not this file's implementation of it.
      argv.push(...mount.argv);
      files.push(...(mount.files ?? []));
    }

    // The prompt goes on stdin and `-` holds its place, last. Both heads document it:
    // `codex exec [PROMPT]` reads stdin "if not provided as an argument (or if `-` is
    // used)", and `codex exec resume [SESSION_ID] [PROMPT]` the same (0.153.4 `--help`).
    // A bare positional — what the probe harness ran — is misread as a flag the moment a
    // brief begins with `-`, and a brief is prose composed by a lead, not by this file.
    argv.push("-");

    // `cwd` is passed through as the request wrote it: it is already canonical, and on a
    // resume it is the whole of the sandbox's writable root, so it has to be the name the
    // child sees.
    return { bin: engineBin("codex", request.env), argv, cwd: request.cwd, env: request.env, stdin: request.brief, files };
  },

  /**
   * One `--json` object per line. `thread.started` carries the id a resume names, a
   * completed item is the engine being alive, and the turn's own line is the verdict.
   */
  parseLine(line: string): EngineEvent | null {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return null; }
    if (typeof value !== "object" || value === null) return null;
    const event = value as { type?: unknown; thread_id?: unknown; item?: unknown; error?: unknown };
    switch (event.type) {
      case "thread.started":
        return typeof event.thread_id === "string" ? { kind: "session", sessionId: event.thread_id } : null;
      case "item.completed": {
        const item = event.item as { type?: unknown; text?: unknown; command?: unknown } | null | undefined;
        // What the model said and what it ran: the two item types an operator reads as
        // progress. The item type is what identifies the line, so an item missing its
        // string is still an event — `lastEventAt` is what keeps the task off the stall
        // path. Every other item type Codex reports stays in the log alone.
        if (item?.type === "agent_message") return { kind: "activity", text: truncate(asText(item.text)) };
        if (item?.type === "command_execution") return { kind: "activity", text: truncate(asText(item.command)) };
        return null;
      }
      case "turn.completed":
        // That the turn ended. Its text is the `-o` file's, which `finalMessage` reads:
        // this line carries usage figures and no message of its own.
        return { kind: "result", text: "" };
      case "turn.failed":
        return { kind: "error", text: failureText(event.error) };
      default:
        return null;
    }
  },

  /**
   * The `-o` file is Codex's own last message, written by the engine at the end of the
   * turn, and `plan` empties it before the spawn — so a non-empty file is this run's and
   * the first place to look. Without one the events are the whole of the evidence: a turn
   * that somehow spoke on its completion line, then whatever failed.
   */
  finalMessage(events: EngineEvent[], resultFileText: string | null): string {
    if (resultFileText !== null && resultFileText !== "") return resultFileText;
    const result = events.findLast((event) => event.kind === "result");
    if (result !== undefined && result.text !== "") return result.text;
    return events.findLast((event) => event.kind === "error")?.text ?? "";
  },
} satisfies EngineAdapter;

export default codex;
