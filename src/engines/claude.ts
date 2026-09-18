import path from "node:path";
import { commandPath, engineBin } from "./binaries.ts";
import type { EngineAdapter, EngineEvent, LeadMount, LeadMountSpec, SpawnPlan, SpawnRequest } from "./types.ts";

/** How much of an assistant turn is kept as evidence of progress: enough to read, not a transcript. */
const activityLimit = 200;

/**
 * P1's two sandbox failures, neither of which the engine reports as an error of its own:
 * the warning it prints when a prerequisite is missing and then runs every command
 * unsandboxed anyway, and the message every command dies with when bubblewrap starts but
 * the AppArmor profile confines its children. Neither can be seen before the spawn, so the
 * run is where the refusal happens.
 */
const sandboxFailure = /Sandbox disabled|apply-seccomp/;

/** Whole code points: cutting UTF-16 units could leave a lone surrogate in the ledger. */
function truncate(text: string): string {
  if (text.length <= activityLimit) return text;
  return Array.from(text).slice(0, activityLimit).join("");
}

/** The text blocks of an assistant turn, joined. Thinking and tool calls are not text. */
function assistantText(message: unknown): string {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  // The wire shape is the Anthropic Messages API's, where content is blocks or a string.
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content as Array<{ type?: unknown; text?: unknown } | null>) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts.join("\n");
}

/**
 * What a failed run says. `result` carries the message when the run produced one at all;
 * `errors` is a list, and an operator reading a failure needs every line of it. A result
 * line with neither still has to say something, so it says which failure it was.
 */
function failureText(event: { subtype?: unknown; result?: unknown; errors?: unknown }): string {
  if (typeof event.result === "string" && event.result !== "") return event.result;
  if (Array.isArray(event.errors) && event.errors.length > 0) {
    return event.errors.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n");
  }
  return `claude reported ${typeof event.subtype === "string" ? event.subtype : "a failure"} with no message`;
}

/** Claude Code, on the spawn line P1 recorded and the output shape the probe logs sampled. */
const claude = {
  name: "claude",
  sandboxProfiles: { "read-only": "read-only", "workspace-write": "write", off: "off" },

  /**
   * P1's prerequisites are Linux's: `bwrap` for the sandbox and `socat` for its network
   * proxy. On Ubuntu 24.04 and later an AppArmor profile for `/usr/bin/bwrap` is needed
   * too, and that one cannot be probed here: the sandbox engages and every command inside
   * it then fails at its own setup, which only the run can see. `parseStderrLine` is where
   * that half is caught. No other platform's sandbox has been observed, so none is refused
   * here; the engine refuses on its own if its sandbox cannot start.
   */
  sandboxSupport(env: Readonly<NodeJS.ProcessEnv>): { ok: true } | { ok: false; reason: string } {
    if (process.platform !== "linux") return { ok: true };
    // The spawn's own PATH, not this process's: the child is what has to find them.
    const missing = ["bwrap", "socat"].filter((command) => commandPath(command, env) === null);
    return missing.length === 0
      ? { ok: true }
      : { ok: false, reason: `${missing.join(" and ")} not found on PATH; Claude's Linux sandbox needs bwrap and socat (probe P1)` };
  },

  // Both forms in one appendable array, enforced under bypassPermissions (P3).
  denyArgs(targets: readonly string[]): string[] {
    return ["--disallowedTools", ...targets.flatMap((target) => [`Bash(${target} *)`, `Bash(${target})`])];
  },

  // What makes a mount exclusive: dropping it pulled in five of the operator's own
  // servers in an otherwise identical run (P9).
  exclusionArgs(): string[] {
    return ["--strict-mcp-config"];
  },

  leadMount(spec: LeadMountSpec, scratchDir: string): LeadMount {
    const file = path.join(scratchDir, "mcp-config.json");
    const contents = JSON.stringify(
      { mcpServers: { "cross-agent": { command: spec.command, args: spec.args, env: spec.env } } }, null, 2,
    ) + "\n";
    return { argv: ["--mcp-config", file], files: [{ path: file, contents }] };
  },

  /**
   * P1's spawn line, with P9's role-prompt file and lead mount. The sandbox is the
   * `--settings` JSON's alone, so the mode has to be right: it is, by the time this runs,
   * because the pipeline re-derives it from `sandboxProfiles` and refuses a request whose
   * pair disagrees (`src/engines/spawn.ts:70-78`).
   */
  plan(request: SpawnRequest): SpawnPlan {
    const { mode } = request.sandbox;
    const settings: {
      sandbox: {
        enabled: boolean; autoAllowBashIfSandboxed: true;
        allowUnsandboxedCommands?: false; failIfUnavailable?: true;
        filesystem?: { allowWrite: string[] };
      };
    } = { sandbox: { enabled: mode !== "off", autoAllowBashIfSandboxed: true } };
    // A sandbox the specialist cannot step out of. `allowUnsandboxedCommands: false` makes
    // the engine ignore the `dangerouslyDisableSandbox` parameter its own escape hatch
    // retries a blocked command with — P1's 2026-09-18 rerun watched a child take that
    // hatch and reach the network — and `failIfUnavailable: true` turns a sandbox that
    // cannot start into a failed run rather than a warning and an unsandboxed one. Both
    // belong to a sandbox that is on: with `enabled: false` there is no hatch to close and
    // nothing whose absence could fail the run.
    if (mode !== "off") {
      settings.sandbox.allowUnsandboxedCommands = false;
      settings.sandbox.failIfUnavailable = true;
    }
    // A writable role gets exactly one writable root, its own workspace; a read-only one
    // gets no `allowWrite` at all.
    if (mode === "write") settings.sandbox.filesystem = { allowWrite: [request.cwd] };

    const argv = [
      "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
      ...claude.exclusionArgs(),
    ];
    const files: NonNullable<SpawnPlan["files"]> = [];
    // Beside the flag that makes it exclusive, which is the order P9 ran. `--mcp-config`
    // is variadic, so nothing variadic may end the line: the last flag is
    // `--disallowedTools`, whose values end the argv, and the prompt goes on stdin.
    if (request.lead !== undefined) {
      const mount = claude.leadMount(request.lead, request.scratchDir);
      argv.push(...mount.argv);
      files.push(...(mount.files ?? []));
    }
    if (request.model) argv.push("--model", request.model);
    if (request.effort) argv.push("--effort", request.effort);
    // Never both: a resumed run is the session it names, and a fresh one is the id the
    // ledger already holds.
    argv.push(...(request.resumeSessionId
      ? ["--resume", request.resumeSessionId]
      : ["--session-id", request.sessionId]));

    // A Claude role prompt travels as a file and never as prompt text (P9), and the file
    // is the task's own — never inside the specialist's worktree, which the role may edit.
    if (request.rolePrompt !== "") {
      const rolePath = path.join(request.scratchDir, "role.md");
      files.push({ path: rolePath, contents: request.rolePrompt });
      argv.push("--append-system-prompt-file", rolePath);
    }
    argv.push("--settings", JSON.stringify(settings));

    // denyArgs is the flag and its values in one array. A read-only role loses the editing
    // tools as well as the launch commands, and the flag is variadic, so it is emitted
    // only when it has something to carry.
    const disallowed = claude.denyArgs(request.denyTargets);
    if (mode === "read-only") disallowed.push("Edit", "Write", "MultiEdit", "NotebookEdit");
    if (disallowed.length > 1) argv.push(...disallowed);

    // `cwd` is passed through as the request wrote it: it is already canonical, and the
    // writable root above has to be the name the child sees.
    return { bin: engineBin("claude", request.env), argv, cwd: request.cwd, env: request.env, stdin: request.brief, files };
  },

  /**
   * One stream-json object per line. The `system`/`init` line carries the session id, an
   * `assistant` turn is the engine being alive, and the `result` line is the whole
   * verdict: success and failure both arrive down that one path.
   */
  parseLine(line: string): EngineEvent | null {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return null; }
    if (typeof value !== "object" || value === null) return null;
    const event = value as {
      type?: unknown; subtype?: unknown; session_id?: unknown; message?: unknown;
      is_error?: unknown; result?: unknown; errors?: unknown;
    };
    switch (event.type) {
      case "system":
        return event.subtype === "init" && typeof event.session_id === "string"
          ? { kind: "session", sessionId: event.session_id }
          : null;
      case "assistant":
        // Emitted even when the turn is only a tool call: that is still progress, and
        // `lastEventAt` is what keeps the task off the stall path.
        return { kind: "activity", text: truncate(assistantText(event.message)) };
      case "result":
        // Both halves of the verdict have to agree before a run counts as a success.
        return event.is_error === false && event.subtype === "success"
          ? { kind: "result", text: typeof event.result === "string" ? event.result : "" }
          : { kind: "error", text: failureText(event) };
      default:
        return null;
    }
  },

  /**
   * The sandbox failure that no check before the spawn can see (P1). The engine keeps
   * running and can still exit 0, so the line itself is the failure: the pipeline records
   * an `error` event, which is what makes the run fail closed rather than quietly go
   * unsandboxed. It records one — the pipeline stops asking after the first, because the
   * failure that engages the sandbox and then breaks it repeats once per command — so this
   * stays a pure function of one line and holds no state of its own.
   */
  parseStderrLine(line: string): EngineEvent | null {
    return sandboxFailure.test(line) ? { kind: "error", text: `claude sandbox failure: ${line}` } : null;
  },

  /**
   * The run's own last word. `resultFileText` is not read: Claude has no `-o` equivalent,
   * so that file holds only what the pipeline itself last wrote into it.
   */
  finalMessage(events: EngineEvent[], _resultFileText: string | null): string {
    const result = events.findLast((event) => event.kind === "result");
    if (result !== undefined) return result.text;
    return events.findLast((event) => event.kind === "error")?.text ?? "";
  },
} satisfies EngineAdapter;

export default claude;
