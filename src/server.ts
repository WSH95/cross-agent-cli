import { readFileSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { resolveAuthority } from "./authority.ts";
import type { Authority, Row } from "./authority.ts";
import { effectiveMaxDepth, loadConfig, loadConfigWithMode, lockWaitSeconds, modeDrift, roleProfile } from "./config.ts";
import { delegate } from "./delegate.ts";
import type { DelegateRequest } from "./delegate.ts";
import { gitMutate } from "./gitmutate.ts";
import type { GitMutateRequest } from "./gitmutate.ts";
import { gitRoot } from "./gitroot.ts";
import type { GitRootRequest } from "./gitroot.ts";
import { maxTimeoutSeconds, runCommand } from "./runcommand.ts";
import type { RunCommandRequest } from "./runcommand.ts";
import { answerAsk, ask, askStatuses, lineageAsks, listAsks } from "./mailbox.ts";
import type { AskStatus } from "./mailbox.ts";
import { builtInModesDir, describeMode, gitPolicy } from "./modes.ts";
import type { Mode } from "./modes.ts";
import { discoverProject, isMainModule } from "./project.ts";
import { reconcileAndCleanup } from "./reconcile.ts";
import { cancel, check, lineageIds, listTasks, ownedBy, result } from "./tasks.ts";
import { scan, taskStatuses } from "./ledger.ts";
import type { TaskStatus } from "./ledger.ts";
import { wait } from "./wait.ts";
import { verifyWorktree } from "./worktree.ts";

// cross-agent MCP server: JSON-RPC 2.0 over stdio, one message per line.
// Requests are dispatched as they arrive; a slow tool call never blocks the
// next request on the same connection.

export type Json = Record<string, unknown>;

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolContext {
  /** Who this call was resolved to serve, for this call alone. */
  authority: Authority;
  /** One per call, aborted by a `notifications/cancelled` naming that call's request id. */
  signal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Json;
  /** The rows of the permission matrix (design, "The lead model") this tool is offered to. */
  rows: Row[];
  handler: (args: Json, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

export interface ServerOptions {
  tools: ToolDefinition[];
  /** Called on every `tools/list` and `tools/call`: nothing is cached across requests. */
  authority: () => Authority | Promise<Authority>;
  name?: string;
  version?: string;
}

export const PROTOCOL_VERSION = "2025-03-26";

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function createServer(options: ServerOptions) {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const serverInfo = { name: options.name ?? "cross-agent", version: options.version ?? packageVersion() };
  // Every tool call in flight, by the request id its client addressed it with, so a
  // cancellation reaches exactly the call it names and nothing else. The id is matched as
  // the client spelled it, number or string, because that is what the notification echoes.
  const inFlight = new Map<unknown, AbortController>();

  async function dispatch(method: string, params: Json, id: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo,
        };
      case "ping":
        return {};
      case "tools/list": {
        const { row } = await options.authority();
        return {
          tools: [...tools.values()].filter((tool) => tool.rows.includes(row))
            .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        };
      }
      case "tools/call": {
        const tool = tools.get(String(params.name));
        if (!tool) throw new RpcError(-32602, `unknown tool: ${String(params.name)}`);
        const controller = new AbortController();
        // Registered before the row is resolved, because resolving it awaits: `connect`
        // hands this dispatcher every line of one stdin chunk in order, so a cancellation
        // travelling with its own call would otherwise find nothing yet to abort. A
        // notification carries no id to cancel by, so only a request is registered.
        if (id !== undefined && id !== null) inFlight.set(id, controller);
        try {
          const authority = await options.authority();
          // Refused by this server's own name for the tool, never merely left out of the
          // list, and with the evidence the row rests on.
          if (!tool.rows.includes(authority.row)) {
            throw new RpcError(-32602, `${tool.name} is not available to a ${authority.row} server: ${authority.reason}`);
          }
          try {
            return await tool.handler((params.arguments ?? {}) as Json, { authority, signal: controller.signal });
          } catch (error) {
            // A tool's own failure is its answer; a row that could not be resolved, above,
            // is the protocol's, and stays one.
            if (error instanceof RpcError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: message }], isError: true } satisfies ToolResult;
          }
        } finally {
          // Only this call's own entry: a client that reused an id in flight would
          // otherwise have the first call to finish take the survivor's controller away.
          if (inFlight.get(id) === controller) inFlight.delete(id);
        }
      }
      case "notifications/cancelled":
        // The client has stopped waiting for that request: the call is aborted where it is
        // and answers for itself, and its reply is still written — a client that has moved
        // on may ignore it. An id nothing is running under is nothing to abort.
        inFlight.get(params.requestId)?.abort();
        return undefined;
      default:
        if (method.startsWith("notifications/")) return undefined;
        throw new RpcError(-32601, `method not found: ${method}`);
    }
  }

  /** Handles one parsed message; returns the reply, or undefined for notifications. */
  async function handle(message: Json): Promise<Json | undefined> {
    const id = message.id;
    const isNotification = id === undefined || id === null;
    const method = message.method;
    if (typeof method !== "string") {
      return isNotification ? undefined : { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
    }
    try {
      const result = await dispatch(method, (message.params ?? {}) as Json, id);
      return isNotification ? undefined : { jsonrpc: "2.0", id, result: result ?? {} };
    } catch (error) {
      if (isNotification) return undefined;
      const code = error instanceof RpcError ? error.code : -32603;
      const text = error instanceof Error ? error.message : String(error);
      return { jsonrpc: "2.0", id, error: { code, message: text } };
    }
  }

  /** One line of stdin, its `\r` already taken off: a message, or a parse error answered. */
  function receive(line: string, output: Writable): void {
    if (!line.trim()) return;
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      return;
    }
    void handle(message).then((reply) => {
      if (reply) output.write(JSON.stringify(reply) + "\n");
    });
  }

  // @anchor connectSplitsOnNewline
  // A message is one line, and a line ends at `\n` alone. `node:readline` also ends one at
  // U+2028 and U+2029, which JSON leaves raw inside a string: a brief carrying either
  // arrived as fragments, each answered -32700 with no id, and its caller waited for ever
  // (`atc-s96.59`). One trailing `\r` is taken off, so a CRLF client is still one message a
  // line, and a last line with no newline is read when the stream ends, as readline did.
  function connect(input: Readable, output: Writable): void {
    let pending = "";
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      pending += chunk;
      let start = 0;
      for (let newline = pending.indexOf("\n", start); newline !== -1; newline = pending.indexOf("\n", start)) {
        const line = pending.slice(start, newline);
        start = newline + 1;
        receive(line.endsWith("\r") ? line.slice(0, -1) : line, output);
      }
      pending = pending.slice(start);
    });
    input.on("end", () => {
      const line = pending;
      pending = "";
      receive(line.endsWith("\r") ? line.slice(0, -1) : line, output);
    });
  }

  return { handle, connect, serverInfo };
}

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * A tool's own answer. A refusal is the tool's to report and the caller's to read, so it
 * travels as content with `isError` set rather than as a protocol error: the request was
 * well formed and this server understood it.
 */
function answer(value: { ok: boolean }): ToolResult {
  return { ...text(value), ...(value.ok ? {} : { isError: true }) };
}

function fields(args: Json, name: string): Json {
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new RpcError(-32602, `${name} requires an object of arguments`);
  return args;
}

function requiredString(args: Json, key: string, name: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") throw new RpcError(-32602, `${name} requires a non-empty string ${key}`);
  return value;
}

function optional(args: Json, key: string, kind: "string" | "boolean" | "number", name: string): unknown {
  const value = args[key];
  if (value !== undefined && typeof value !== kind) throw new RpcError(-32602, `${name}'s ${key} must be a ${kind}`);
  return value;
}

function stringList(args: Json, key: string, name: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) {
    throw new RpcError(-32602, `${name} requires a non-empty array of strings ${key}`);
  }
  return value as string[];
}

/** `run_command` runs one of the project's two configured commands, and nothing else. */
const selectors = ["test", "setup"];

/** The `delegate` request as the wire spells it, checked before anything reads it. */
function delegateRequest(args: Json): DelegateRequest {
  const request: DelegateRequest = {
    role: requiredString(args, "role", "delegate"),
    brief: requiredString(args, "brief", "delegate"),
    cwd: requiredString(args, "cwd", "delegate"),
  };
  for (const key of ["engine", "model", "effort", "branch", "resume"] as const) {
    const value = optional(args, key, "string", "delegate");
    if (value !== undefined) request[key] = value as string;
  }
  for (const key of ["force", "worktree"] as const) {
    const value = optional(args, key, "boolean", "delegate");
    if (value !== undefined) request[key] = value as boolean;
  }
  return request;
}

export interface ToolOptions {
  /** The active mode, loaded once by whoever starts the server: it decides what registers. */
  mode: Mode;
}

/**
 * A config pointed at another mode after this server started: which tools exist was
 * decided when the mode was loaded, so a tool that acts on the mode's own git policy
 * refuses rather than act under a policy this server is not serving (design section 6).
 * `delegate` applies the same check at the launch boundary.
 */
function driftFault(projectRoot: string, mode: Mode): string | null {
  try {
    return modeDrift(mode, loadConfig(projectRoot));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The worktree provider's four tools, registered under **every** mode: every mode carries
 * the `consult` role, every root role can be given a worktree of its own by `delegate
 * {worktree: true}`, and the branch that leaves behind has to be testable, mergeable and
 * removable through the journal like any other (design, "Modes"). What differs between
 * modes is the policy they act under, and `describe_mode`'s `git.implicit` is what tells a
 * launcher whether that policy is the mode's own. The root verbs are here rather than
 * behind `placement: engine`, because the journal is the same document under either
 * placement and a host-placed lead writes it through these too (plan decision 4).
 */
function worktreeTools(projectRoot: string, mode: Mode): ToolDefinition[] {
  // The mode's own policy, or the implicit one its one-shots use: what `git_mutate` and
  // `git_root` judge a path and a branch against, and never undefined.
  const policy = gitPolicy(mode);
  return [
    {
      name: "verify_worktree",
      description: "Verify a linked worktree and its exact branch, returning canonical Git and worktree paths or a refusal reason.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, branch: { type: "string" } },
        required: ["path", "branch"],
      },
      rows: ["operator", "lead"],
      handler: async (args) => {
        if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.path !== "string") {
          throw new RpcError(-32602, "verify_worktree requires a string path");
        }
        if (typeof args.branch !== "string") throw new RpcError(-32602, "verify_worktree requires a string branch");
        const drift = driftFault(projectRoot, mode);
        if (drift !== null) return text({ reason: drift });
        return text(await verifyWorktree(projectRoot, args.path, args.branch));
      },
    },
    {
      name: "git_mutate",
      description: "Run one git subcommand in a verified worktree, under the project's locks and journaled. The only path that writes a worktree's git metadata; the workspace and branch default to the mode's own git policy.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string" }, args: { type: "array", items: { type: "string" } },
          path: { type: "string" }, branch: { type: "string" },
        },
        required: ["slug", "args"],
      },
      rows: ["operator", "lead"],
      handler: async (args) => {
        const values = fields(args, "git_mutate");
        const request: GitMutateRequest = {
          slug: requiredString(values, "slug", "git_mutate"),
          args: stringList(values, "args", "git_mutate"),
        };
        for (const key of ["path", "branch"] as const) {
          const value = optional(values, key, "string", "git_mutate");
          if (value !== undefined) request[key] = value as string;
        }
        const drift = driftFault(projectRoot, mode);
        if (drift !== null) return answer({ ok: false, reason: drift });
        return answer(await gitMutate(projectRoot, request, {
          waitSeconds: lockWaitSeconds(projectRoot),
          dir: policy.worktreeDir, branchPattern: policy.branchPattern,
        }));
      },
    },
    {
      name: "git_root",
      description: "Run one whitelisted git verb at the project root, under the project's git lock, and journal the step it completes. The verbs are worktree add -b, worktree remove, branch -d, merge --ff-only, rebase --abort, and the read-only status, log, rev-parse, rev-parse --abbrev-ref HEAD, merge-base, branch --list and worktree list; a verb that journals a step names the slug whose journal it belongs to.",
      inputSchema: {
        type: "object",
        properties: { args: { type: "array", items: { type: "string" } }, slug: { type: "string" } },
        required: ["args"],
      },
      rows: ["operator", "lead"],
      handler: async (args) => {
        const values = fields(args, "git_root");
        const request: GitRootRequest = { args: stringList(values, "args", "git_root") };
        const slug = optional(values, "slug", "string", "git_root");
        if (slug !== undefined) request.slug = slug as string;
        const drift = driftFault(projectRoot, mode);
        if (drift !== null) return answer({ ok: false, reason: drift });
        return answer(await gitRoot(projectRoot, request, {
          waitSeconds: lockWaitSeconds(projectRoot),
          dir: policy.worktreeDir, branchPattern: policy.branchPattern,
        }));
      },
    },
    {
      name: "run_command",
      description: "Run this project's configured test or setup command — by selector, never as a command string — at the project root or in a verified worktree, returning the exit code and the last 64 KB of its output. A passing test run at the root after the merge journals the slug's tests-passed step.",
      inputSchema: {
        type: "object",
        properties: {
          which: { type: "string", enum: [...selectors] }, where: { type: "string" },
          slug: { type: "string" }, timeout_seconds: { type: "number" },
        },
        required: ["which", "where"],
      },
      rows: ["operator", "lead"],
      handler: async (args, context) => {
        const values = fields(args, "run_command");
        const which = requiredString(values, "which", "run_command");
        if (!selectors.includes(which)) throw new RpcError(-32602, `run_command's which must be one of ${selectors.join(", ")}`);
        const request: RunCommandRequest = { which: which as "test" | "setup", where: requiredString(values, "where", "run_command") };
        const slug = optional(values, "slug", "string", "run_command");
        if (slug !== undefined) request.slug = slug as string;
        const timeoutSeconds = optional(values, "timeout_seconds", "number", "run_command") as number | undefined;
        if (timeoutSeconds !== undefined) {
          // The same bound `runCommand` holds: a delay above it fires at once, and a lead
          // asking for a month would have its suite killed on the spot.
          if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > maxTimeoutSeconds) {
            throw new RpcError(-32602, `run_command's timeout_seconds must be a positive number of seconds no greater than ${maxTimeoutSeconds}, not ${timeoutSeconds}`);
          }
          request.timeoutSeconds = timeoutSeconds;
        }
        const drift = driftFault(projectRoot, mode);
        if (drift !== null) return answer({ ok: false, reason: drift });
        // The command runs one step below the caller in the delegation chain, so a server
        // it starts is a specialist and never the operator (design section 5, layer 2).
        return answer(await runCommand(projectRoot, request, { depth: context.authority.depth }));
      },
    },
  ];
}

/** A wait-shaped budget in seconds, checked as `wait` checks its own: finite and not negative. */
function timeoutSeconds(args: Json, name: string): number | undefined {
  const value = optional(args, "timeout_seconds", "number", name) as number | undefined;
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RpcError(-32602, `${name}'s timeout_seconds must be a finite number of seconds, not ${value}`);
  }
  return value;
}

/** The lineage ids of the lead this call serves: its own record and those it continues. */
function callerLineage(projectRoot: string, authority: Authority): string[] {
  return authority.taskId === undefined ? [] : lineageIds(scan(projectRoot).records, authority.taskId);
}

/**
 * The mailbox (design, "The lead model", item 3), registered only under engine placement:
 * a host-placed lead is the operator's own session and asks natively. `ask` is the lead's —
 * a specialist is unauthorized to ask, not unable to reach this server — `answer` is the
 * operator's, and `list_asks` is both rows', the lead seeing only its own lineage's asks and
 * the damaged files that may be its own (`src/mailbox.ts#lineageAsks`).
 */
function mailboxTools(projectRoot: string): ToolDefinition[] {
  return [
    {
      name: "ask",
      description: "Put a question to the operator and wait for the answer, up to timeout_seconds. A timeout answers status open with the ask's id: call ask again with that id to keep waiting on the same question. Asks are answered through list_asks and answer, or cross-agent answer.",
      inputSchema: {
        type: "object",
        properties: { question: { type: "string" }, id: { type: "string" }, timeout_seconds: { type: "number" } },
      },
      rows: ["lead"],
      handler: async (args, context) => {
        const values = fields(args, "ask");
        const id = optional(values, "id", "string", "ask") as string | undefined;
        const question = id === undefined ? requiredString(values, "question", "ask") : optional(values, "question", "string", "ask") as string | undefined;
        const taskId = context.authority.taskId;
        if (taskId === undefined) return answer({ ok: false, reason: "ask needs the task this lead runs as, and this call resolved none" });
        return answer(await ask(projectRoot, {
          taskId, lineageIds: callerLineage(projectRoot, context.authority),
          ...(id === undefined ? {} : { id }), ...(question === undefined ? {} : { question }),
          timeoutSeconds: timeoutSeconds(values, "ask"), signal: context.signal,
        }));
      },
    },
    {
      name: "list_asks",
      description: "The questions an engine-placed lead has put to the operator, in the order they were asked, each with its status and answer. A lead sees only its own.",
      inputSchema: { type: "object", properties: { status: { type: "string", enum: [...askStatuses] } } },
      rows: ["operator", "lead"],
      handler: (args, context) => {
        const status = optional(fields(args, "list_asks"), "status", "string", "list_asks") as string | undefined;
        if (status !== undefined && !askStatuses.includes(status as AskStatus)) {
          throw new RpcError(-32602, `list_asks status must be one of ${askStatuses.join(", ")}`);
        }
        const filter = status as AskStatus | undefined;
        if (context.authority.row === "lead") {
          // Its own lineage's asks, and of the damaged files only those that may be its own:
          // one naming a task of the lineage, or no task a reader could find.
          const { asks, unreadable } = lineageAsks(projectRoot, callerLineage(projectRoot, context.authority), filter);
          return answer({ ok: true, asks, invalid: unreadable });
        }
        return answer({ ok: true, ...listAsks(projectRoot, filter === undefined ? {} : { status: filter }) });
      },
    },
    {
      name: "answer",
      description: "Answer a lead's open question. The first answer wins: a later one, or an answer to a cancelled question, is refused.",
      inputSchema: {
        type: "object",
        properties: { ask_id: { type: "string" }, text: { type: "string" } },
        required: ["ask_id", "text"],
      },
      rows: ["operator"],
      handler: async (args) => {
        const values = fields(args, "answer");
        const answered = await answerAsk(projectRoot, requiredString(values, "ask_id", "answer"), requiredString(values, "text", "answer"));
        return answered.applied
          ? answer({ ok: true, ask: answered.ask })
          : answer({ ok: false, reason: answered.reason, ...(answered.ask === null ? {} : { ask: answered.ask }) });
      },
    },
  ];
}

/** The tools for the project at `projectRoot`, each with the rows of the permission matrix it is offered to. */
export function projectTools(projectRoot: string, options: ToolOptions): ToolDefinition[] {
  const { mode } = options;
  // The shelf this mode came from, so `describe_mode` re-reads the mode config names now
  // rather than the one the server started with.
  const modesDir = path.dirname(mode.dir);
  return [
    {
      name: "describe_mode",
      description: "The active mode's loop text, its roles with their workspace, sandbox default and prompt, and its git policy. Call this first: it is how a launcher learns the loop, which is served rather than copied.",
      inputSchema: { type: "object", properties: {} },
      rows: ["operator", "lead", "specialist"],
      handler: () => {
        const described = describeMode(modesDir, loadConfig(projectRoot).mode);
        return "reason" in described ? { ...text(described), isError: true } : text(described);
      },
    },
    {
      name: "list_roles",
      description: "The roles the active mode has: each one's workspace and the sandbox profile it will run under, with the engine, model and effort .cross-agent/config.json binds it to — or binding: null where it binds none, which is the engine a delegate call must name itself.",
      inputSchema: { type: "object", properties: {} },
      rows: ["operator", "lead", "specialist"],
      handler: () => {
        // Both files, checked against each other: a config naming a role the mode does not
        // declare is the loader's refusal, and this tool is where an operator reads it.
        const bound = loadConfigWithMode(projectRoot, modesDir);
        // Which tools exist was decided when this server loaded its mode, so a config
        // since pointed at another one is answered with the roles it names and the drift
        // beside them: everything below is true of a mode this server is not serving.
        const drift = modeDrift(mode, bound.config);
        // The **mode's** roles, not the config's: a role nothing binds is still a role
        // this project can delegate, with the engine named in the call, and a launcher
        // that could not see it would not know to name one (design, "Modes").
        return text({
          roles: Object.fromEntries(bound.mode.roles.map((role) => {
            const binding = Object.hasOwn(bound.config.roles, role.key) ? bound.config.roles[role.key] : undefined;
            return [role.key, {
              ...(binding === undefined ? { binding: null } : {
                engine: binding.engine,
                ...(binding.model === undefined ? {} : { model: binding.model }),
                ...(binding.effort === undefined ? {} : { effort: binding.effort }),
              }),
              workspace: role.workspace,
              sandbox: roleProfile(bound.mode, bound.config, role.key),
            }];
          })),
          ...(drift === null ? {} : { warning: drift }),
        });
      },
    },
    {
      name: "delegate",
      description: "Launch a specialist for a role on a brief in a working directory, returning its task id. Validates the role, the workspace, its reservation, duplicates and the resume binding first. A role with no binding takes its engine in the call; worktree: true gives a role that works at the project root a writable task worktree of its own instead.",
      inputSchema: {
        type: "object",
        properties: {
          role: { type: "string" }, brief: { type: "string" }, cwd: { type: "string" },
          engine: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
          branch: { type: "string" }, resume: { type: "string" }, force: { type: "boolean" },
          worktree: { type: "boolean" },
        },
        required: ["role", "brief", "cwd"],
      },
      rows: ["operator", "lead"],
      handler: async (args, context) => {
        const request = delegateRequest(fields(args, "delegate"));
        const launched = await delegate(projectRoot, request, { authority: context.authority, mode });
        return answer(launched.ok ? { ok: true, task_id: launched.taskId } : launched);
      },
    },
    {
      name: "wait",
      description: "Wait for a task to settle, for its engine to go quiet for the configured stall threshold, or for the timeout, and answer with the call to make next. A lead may wait only on a task it delegated.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" }, timeout_seconds: { type: "number" } },
        required: ["task_id"],
      },
      rows: ["operator", "lead"],
      handler: async (args, context) => {
        const values = fields(args, "wait");
        const taskId = requiredString(values, "task_id", "wait");
        const budget = timeoutSeconds(values, "wait");
        // A lead waits on the tasks it delegated and no others; the operator waits on any.
        // A task nobody has is that first, as `cancel` reports it: a lead asking after a
        // task id that does not exist has not been refused anything.
        if (context.authority.row === "lead") {
          const { records } = scan(projectRoot);
          if (!records.some((record) => record.id === taskId)) return answer({ ok: false, reason: `no task ${taskId}` });
          const leadTaskId = context.authority.taskId;
          if (leadTaskId === undefined || !ownedBy(records, leadTaskId, taskId)) {
            return answer({ ok: false, reason: `refused wait on task ${taskId}: lead task ${leadTaskId} did not delegate it` });
          }
        }
        return answer(await wait(projectRoot, taskId, { timeoutSeconds: budget, signal: context.signal }));
      },
    },
    {
      name: "check",
      description: "The status of a task, how long it has been running, and the last lines of its engine's own event stream. Reconciles nothing, and records the stall or the revival its clock reads.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" }, lines: { type: "number" } },
        required: ["task_id"],
      },
      rows: ["operator", "lead", "specialist"],
      handler: async (args) => {
        const values = fields(args, "check");
        const lines = optional(values, "lines", "number", "check") as number | undefined;
        if (lines !== undefined && (!Number.isSafeInteger(lines) || lines <= 0)) {
          throw new RpcError(-32602, `check's lines must be a positive whole number, not ${lines}`);
        }
        return answer(await check(projectRoot, requiredString(values, "task_id", "check"), { lines }));
      },
    },
    {
      name: "result",
      description: "The final message of a settled task in full, with the engine session it ran under. A task still running answers with its status.",
      inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
      rows: ["operator", "lead", "specialist"],
      handler: (args) => answer(result(projectRoot, requiredString(fields(args, "result"), "task_id", "result"))),
    },
    {
      name: "cancel",
      description: "Terminate a task and every task it delegated, leaves first, returning one outcome per task. A lead may cancel only its own.",
      inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
      rows: ["operator", "lead"],
      handler: async (args, context) => {
        const taskId = requiredString(fields(args, "cancel"), "task_id", "cancel");
        // A lead cancels its own children and nothing else; the operator cancels any task.
        const leadTaskId = context.authority.row === "lead" ? context.authority.taskId : undefined;
        return answer(await cancel(projectRoot, taskId, { leadTaskId }));
      },
    },
    {
      name: "list_tasks",
      description: "Every task of this project after a reconciliation pass, newest first, with the records no reader could judge.",
      inputSchema: { type: "object", properties: { status: { type: "string", enum: [...taskStatuses] } } },
      rows: ["operator", "lead", "specialist"],
      handler: async (args, context) => {
        const status = optional(fields(args, "list_tasks"), "status", "string", "list_tasks") as string | undefined;
        if (status !== undefined && !taskStatuses.includes(status as TaskStatus)) {
          throw new RpcError(-32602, `list_tasks status must be one of ${taskStatuses.join(", ")}`);
        }
        const listed = await listTasks(projectRoot, status as TaskStatus | undefined);
        const leadTaskId = context.authority.row === "lead" ? context.authority.taskId : undefined;
        if (leadTaskId === undefined) return answer(listed);
        // A lead reads the roster to settle leftovers before it starts, and must never take
        // itself for one: its own records — the one it runs as and those it continues — are
        // marked `self`, and what it owns by lineage, which is all it may wait on, resume or
        // cancel, `own` (design, "The lead model", item 2). The operator owns no task.
        const { records } = scan(projectRoot);
        const self = new Set(lineageIds(records, leadTaskId));
        return answer({
          ...listed,
          tasks: listed.tasks.map((task) => ({
            ...task,
            ...(self.has(task.id) ? { self: true } : {}),
            ...(ownedBy(records, leadTaskId, task.id) ? { own: true } : {}),
          })),
        });
      },
    },
    ...worktreeTools(projectRoot, mode),
    // The mailbox exists where a lead runs in an engine and nowhere else.
    ...(mode.lead.placement === "engine" ? mailboxTools(projectRoot) : []),
  ];
}

/** Serves the project `discoverProject` names, or exits with the reason there is none. */
async function main(): Promise<void> {
  const found = await discoverProject(process.argv.slice(2), process.env, process.cwd());
  if ("reason" in found) throw new Error(found.reason);
  const { root } = found;
  // Once, before serving: the mode decides which tools exist and what each role's
  // workspace is, so a mode that cannot be read is not something to discover on the first
  // `delegate`. Its refusal is this process's exit reason.
  const { config, mode } = loadConfigWithMode(root, builtInModesDir());
  const maxDepth = effectiveMaxDepth(mode, config);
  // Once before serving, so the first request reads a ledger that is in step with the
  // kernel: a task whose runner died while no server was running is judged here rather
  // than on whichever call happens to be first (design section 2).
  const pass = await reconcileAndCleanup(root);
  for (const { id, reason } of [...pass.errors, ...pass.skipped]) {
    process.stderr.write(`cross-agent: task ${id}: ${reason}\n`);
  }
  // A host-placed mode names no lead role, so nothing an ancestry walk finds resolves to
  // the lead row under one. Resolved again on every request — nothing here is cached — and
  // said on stderr the first time each answer is reached, because a row and its evidence
  // are what a transcript otherwise cannot show: a session that never calls a tool outside
  // its row looks the same whether ancestry granted it or the walk failed closed (I1(ii)).
  // At the **first resolution a request asked for**, never at startup: a specialist's own
  // record is usually still `launching` when its engine starts this server, so a line
  // written then would report a fail-closed reason that the first `tools/call` contradicts.
  // Once per distinct reason, so a long session says it again only when the answer changes.
  const said = new Set<string>();
  const authority = () => {
    const resolved = resolveAuthority(root, process.env, { leadRole: mode.lead.role, maxDepth });
    if (!said.has(resolved.reason)) {
      said.add(resolved.reason);
      process.stderr.write(`cross-agent: serving the ${resolved.row} row: ${resolved.reason}\n`);
    }
    return resolved;
  };
  createServer({ tools: projectTools(root, { mode }), authority }).connect(process.stdin, process.stdout);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`cross-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
