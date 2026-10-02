import path from "node:path";
import { commandPath, engineBin } from "./binaries.ts";
import { assistantText, failureText, truncate } from "./text.ts";
import type { EngineAdapter, EngineEvent, LeadMount, LeadMountSpec, SpawnPlan, SpawnRequest } from "./types.ts";

/**
 * How much role text `--rules` may carry as one argument. The kernel's exec limit caps a
 * single argument — 128 KiB of it on Linux — and a role prompt anywhere near that is
 * pathological, so the ceiling sits below it with room for the rest of the line. Past it
 * the role travels as a file: the delivery P9 honoured, prepending it to `-p`'s value,
 * would put the same text plus the brief into another single argument and hit the same
 * limit it was fleeing (design section 3).
 */
const rulesLimit = 100 * 1024;

/**
 * How much text the whole turn may put on the command line: the role prompt as `--rules`'s
 * value plus the brief as `-p`'s. Linux caps one argument at 128 KiB and the whole argv at
 * a quarter of the stack limit, and a `review` brief with a diff attached is routinely
 * past both — on 2026-09-19 a 150,745-byte one failed at launch with `spawn E2BIG`
 * (`atc-s96.55`). Past this budget the pair travels as `--prompt-file`'s file instead.
 * Their sum is the measure because it bounds each half, and 64 KiB leaves the rest of the
 * line — the deny list above all — room under the argv ceiling.
 */
const promptLimit = 64 * 1024;

/**
 * A sandbox that cannot be enforced, as Grok reports it. Its bubblewrap plan resolves the
 * binary's own runtime-socket deny list path by path, and a path it may not resolve —
 * rootful podman's `/run/podman`, created `0700 root` — refuses the whole run before any
 * stream begins: two lines on stderr and exit 1 (probe A2, `docs/probes.md#grokSandboxSocket`).
 */
const sandboxRefusal = /sandbox profile resolve failed|could not enforce its deny list/;

/**
 * Grok Build, on the spawn line P2 and P8 recorded and the `streaming-messages-json`
 * output P8 adopted (design section 3).
 */
const grok = {
  name: "grok",
  // `strict` is a read-only profile too, so it frees a workspace exactly as `read-only` does.
  sandboxProfiles: { "read-only": "read-only", strict: "read-only", workspace: "write", off: "off" },

  // `protectedPaths` cannot be enforced here: the `workspace` profile takes no per-path
  // deny rule, and P2 watched a Grok specialist rewrite its own `.git` pointer. So a Grok
  // implementer's git metadata is checked rather than protected — `verify_worktree` before
  // every `git_mutate`, which is what design section 4 means by detected, not prevented.

  // Grok's sandbox is the binary's own, so the binary resolving is the whole of the check.
  // Whether its bubblewrap plan can resolve its deny list is not checked here: that list
  // is the binary's own, so a check would encode it and go stale, and the run reports the
  // failure itself, which `parseStderrLine` reads.
  sandboxSupport(env: Readonly<NodeJS.ProcessEnv>): { ok: true } | { ok: false; reason: string } {
    const bin = engineBin("grok", env);
    return commandPath(bin, env) === null
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
  // @anchor exclusionArgs
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
    // own text. Above the argv limit it cannot, and the role then travels the way P9's
    // comparison run honoured — its text, a blank line, then the brief — as
    // `--prompt-file`'s file rather than as `-p`'s value, which is one argument again and
    // larger than the one that did not fit. The file is the task's own, never inside the
    // specialist's worktree, which the role may edit.
    const carried = Buffer.byteLength(request.rolePrompt) <= rulesLimit;
    // Two measures, because the two flags are charged separately. `carried` is whether
    // `--rules` can hold the role at all; `inline` is whether the turn's text fits on the
    // command line beside it. A role past `rulesLimit` is past `promptLimit` too, so the
    // file below is the one delivery that serves both.
    const inline = Buffer.byteLength(request.rolePrompt) + Buffer.byteLength(request.brief) <= promptLimit;
    const files: NonNullable<SpawnPlan["files"]> = [];
    const prompt: string[] = [];
    if (inline) {
      prompt.push("-p", request.brief);
    } else {
      const promptPath = path.join(request.scratchDir, "rules.md");
      // The role text, a blank line, then the brief — P9's own comparison delivery — and
      // the role goes in whether or not `--rules` is also carrying it: a file that held
      // the brief alone would drop the role for an oversize one, and repeating it for a
      // role that fits costs the run nothing but tokens. A brief with no role text is the
      // brief alone rather than two leading blank lines.
      files.push({ path: promptPath, contents: request.rolePrompt === "" ? request.brief : `${request.rolePrompt}\n\n${request.brief}` });
      prompt.push("--prompt-file", promptPath);
    }

    const argv = [
      ...prompt,
      "--cwd", request.cwd,
      // The profile is Grok's own name for it, `off` included, and by the time this runs
      // the pipeline has re-derived its mode from `sandboxProfiles` and refused a request
      // whose pair disagrees (`src/engines/spawn.ts#spawnChecks`). Omitting the flag is
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
    // No file at all in the ordinary case: the role is `--rules`'s own string and the
    // brief is `-p`'s, so the plan names nothing for the pipeline to write.
    return { bin: engineBin("grok", request.env), argv, cwd: request.cwd, env: request.env, ...(files.length > 0 ? { files } : {}) };
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
          : { kind: "error", text: failureText(event, "errors", "grok") };
      default:
        return null;
    }
  },

  /**
   * The run-time verdict on a sandbox that could not start (A2). Grok refuses with two
   * stderr lines and exit 1 before any stream, so without this the record would say only
   * `engine exited 1`; with it the failure is named, as P1's is for Claude. The pipeline
   * records the first such line and stops asking, so this stays a pure function of one line.
   */
  parseStderrLine(line: string): EngineEvent | null {
    return sandboxRefusal.test(line) ? { kind: "error", text: `grok sandbox failure: ${line}` } : null;
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
