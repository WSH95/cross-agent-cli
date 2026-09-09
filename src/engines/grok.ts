import { commandPath, engineBin } from "./binaries.ts";
import type { EngineAdapter, EngineEvent, LeadMount, LeadMountSpec, SpawnPlan, SpawnRequest } from "./types.ts";

/** How much of an assistant turn is kept as evidence of progress: enough to read, not a transcript. */
const activityLimit = 200;

/**
 * How much role text `--rules` may carry as one argument. The kernel's exec limit caps a
 * single argument — 128 KiB of it on Linux — and a role prompt anywhere near that is
 * pathological, so the ceiling sits below it with room for the rest of the line. Past it
 * the role goes the other way P9 honoured, prepended to the prompt, which is the one case
 * a flag cannot serve (design section 3).
 */
const rulesLimit = 100 * 1024;

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
 * What a failed run says. In this format the message is in an `errors` array and a failed
 * turn carries no `result` field at all (P8), and `errors` is a list: an operator reading
 * a failure needs every line of it, so it is joined one per line. A `result` beside it is
 * unprobed, so it is read second rather than dropped, and a failure with neither still has
 * to say something — so it says which failure it was.
 */
function failureText(event: { subtype?: unknown; result?: unknown; errors?: unknown }): string {
  if (Array.isArray(event.errors) && event.errors.length > 0) {
    return event.errors.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n");
  }
  if (typeof event.result === "string" && event.result !== "") return event.result;
  return `grok reported ${typeof event.subtype === "string" ? event.subtype : "a failure"} with no message`;
}

/**
 * Grok Build, on the spawn line P2 and P8 recorded and the `streaming-messages-json`
 * output P8 adopted (design section 3).
 */
const grok = {
  name: "grok",
  // `strict` is a read-only profile too, so it frees a workspace exactly as `read-only` does.
  sandboxProfiles: { "read-only": "read-only", strict: "read-only", workspace: "write", off: "off" },

  // Grok's sandbox is the binary's own, so the binary resolving is the whole of the check.
  sandboxSupport(): { ok: true } | { ok: false; reason: string } {
    const bin = engineBin("grok");
    return commandPath(bin) === null
      ? { ok: false, reason: `grok binary ${JSON.stringify(bin)} not found; set engines.grok.bin or CROSS_AGENT_GROK_BIN` }
      : { ok: true };
  },

  // One --deny per target, enforced (P3).
  denyArgs(targets: readonly string[]): string[] {
    return targets.flatMap((target) => ["--deny", `Bash(${target} *)`]);
  },

  // Grok has no per-invocation exclusion flag, only the persistent `grok mcp` subcommand.
  // A Grok child inherits the operator's servers, and what makes that safe is the
  // specialist row it resolves to by ancestry (design section 5), not a flag.
  exclusionArgs(): string[] {
    return [];
  },

  /**
   * There is no per-run mount: P9 found that a Grok child inherits `~/.grok/config.toml`,
   * the operator's Grok plugins and the servers declared to Claude in `~/.claude.json`,
   * and that a project-scoped registration is not started for an untrusted folder. So
   * Grok is not a supported engine-placed lead ("The lead model", item 4), and this value
   * describes the specialist path and the operator CLI's own registration instead.
   */
  leadMount(_spec: LeadMountSpec, _scratchDir: string): LeadMount {
    return { argv: [], inherited: true };
  },

  /**
   * P8's spawn line, with the format it adopted. Every flag takes exactly one value, so
   * the deny list can end the argv without swallowing anything and the prompt is `-p`'s
   * own value rather than a positional argument: nothing goes on stdin.
   */
  plan(request: SpawnRequest): SpawnPlan {
    // P9 found no per-run isolation of any kind: the only mount that works is the
    // operator's own user-scope configuration, which would hand a lead every other server
    // they have. The design rules that out ("The lead model", item 4) and config load
    // refuses `placement: engine` with a Grok lead; this is the gate that cannot be
    // configured around, because there is no argv this could build for such a request.
    if (request.lead !== undefined) {
      throw new Error("grok plan refused: grok is not an engine-placed lead (design: The lead model, item 4); P9 found no per-run MCP isolation");
    }

    // `--rules` is Grok's system-level path for the role prompt and takes a string, not a
    // path (P9), so the flag carries the role's contents and keeps them out of the turn's
    // own text. Above the argv limit it cannot, and the role is prepended to the prompt
    // instead — the delivery P9's comparison run honoured.
    const carried = Buffer.byteLength(request.rolePrompt) <= rulesLimit;
    const prompt = carried ? request.brief : `${request.rolePrompt}\n\n${request.brief}`;

    const argv = [
      "-p", prompt,
      "--cwd", request.cwd,
      // The profile is Grok's own name for it, `off` included, and by the time this runs
      // the pipeline has re-derived its mode from `sandboxProfiles` and refused a request
      // whose pair disagrees (`src/engines/spawn.ts:70-78`). Omitting the flag is
      // `grok-build-plugin-cc`'s write mode, which this design deliberately does not run.
      "--sandbox", request.sandbox.profile,
      "--permission-mode", "bypassPermissions",
      "--output-format", "streaming-messages-json",
    ];
    // Never both: a resumed run is the session it names, and a fresh one is the id the
    // ledger already holds. Both announce that session on the run's first line (P8).
    argv.push(...(request.resumeSessionId
      ? ["-r", request.resumeSessionId]
      : ["--session-id", request.sessionId]));
    if (request.model) argv.push("--model", request.model);
    if (request.effort) argv.push("--reasoning-effort", request.effort);
    if (request.rolePrompt !== "" && carried) argv.push("--rules", request.rolePrompt);
    argv.push(...grok.denyArgs(request.denyTargets), ...grok.exclusionArgs());

    // `cwd` is passed through as the request wrote it — it is already canonical — and it
    // is both the spawn's own cwd and the `--cwd` the child is told about, because a
    // sandbox told about a symlink would not be told about the directory.
    return { bin: engineBin("grok", request.env), argv, cwd: request.cwd, env: request.env };
  },

  /**
   * One `streaming-messages-json` object per line, in the Anthropic Messages API wire
   * shape: line for line what Claude Code's `stream-json` emits (P8). The reader is this
   * adapter's own all the same, because the vocabulary belongs to the engine that speaks
   * it and one engine's format changing must not retune another's. The `system`/`init`
   * line carries the session id — on a resumed turn as well as a fresh one — an
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
        // `is_error` is the field the design and P8 both read the verdict from, and a
        // success has to say so: a line that omits it fails closed rather than passing as
        // one. `subtype` is not a second gate here, because P8 recorded only `success`
        // beside `is_error: false` and `error_during_execution` beside `is_error: true`,
        // so a line disagreeing with itself is still read by its verdict field.
        return event.is_error === false
          ? { kind: "result", text: typeof event.result === "string" ? event.result : "" }
          : { kind: "error", text: failureText(event) };
      default:
        return null;
    }
  },

  /**
   * The run's own last word. `resultFileText` is not read: Grok has no `-o` equivalent, so
   * that file holds only what the pipeline itself last wrote into it.
   */
  finalMessage(events: EngineEvent[], _resultFileText: string | null): string {
    const result = events.findLast((event) => event.kind === "result");
    if (result !== undefined) return result.text;
    return events.findLast((event) => event.kind === "error")?.text ?? "";
  },
} satisfies EngineAdapter;

export default grok;
