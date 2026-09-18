import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolveAuthority } from "./authority.ts";
import type { Authority, Row } from "./authority.ts";
import { loadConfig } from "./config.ts";
import { delegate } from "./delegate.ts";
import type { DelegateRequest } from "./delegate.ts";
import { discoverProject } from "./project.ts";
import { reconcileAndCleanup } from "./reconcile.ts";
import { cancel, check, listTasks, result } from "./tasks.ts";
import type { TaskStatus } from "./ledger.ts";
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
  /** One per call. `notifications/cancelled` does not abort it yet (T11). */
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

  async function dispatch(method: string, params: Json): Promise<unknown> {
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
        const authority = await options.authority();
        // Refused by this server's own name for the tool, never merely left out of the
        // list, and with the evidence the row rests on.
        if (!tool.rows.includes(authority.row)) {
          throw new RpcError(-32602, `${tool.name} is not available to a ${authority.row} server: ${authority.reason}`);
        }
        try {
          return await tool.handler((params.arguments ?? {}) as Json, { authority, signal: new AbortController().signal });
        } catch (error) {
          if (error instanceof RpcError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: message }], isError: true } satisfies ToolResult;
        }
      }
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
      const result = await dispatch(method, (message.params ?? {}) as Json);
      return isNotification ? undefined : { jsonrpc: "2.0", id, result: result ?? {} };
    } catch (error) {
      if (isNotification) return undefined;
      const code = error instanceof RpcError ? error.code : -32603;
      const text = error instanceof Error ? error.message : String(error);
      return { jsonrpc: "2.0", id, error: { code, message: text } };
    }
  }

  function connect(input: Readable, output: Writable): void {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
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

const statuses = ["launching", "running", "stalled", "orphaned", "cancelling", "done", "failed", "cancelled"];

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
  const force = optional(args, "force", "boolean", "delegate");
  if (force !== undefined) request.force = force as boolean;
  return request;
}

export interface ToolOptions {
  /** The active mode's lead role. No mode names one until step 8, so `delegate` has none to refuse. */
  leadRole?: string;
}

/** The tools for the project at `projectRoot`, each with the rows of the permission matrix it is offered to. */
export function projectTools(projectRoot: string, options: ToolOptions = {}): ToolDefinition[] {
  return [
    {
      name: "list_roles",
      description: "List the roles configured in .cross-agent/config.json with their engine, model, working directory kind, and sandbox profile.",
      inputSchema: { type: "object", properties: {} },
      rows: ["operator", "lead", "specialist"],
      handler: () => text({ roles: loadConfig(projectRoot).roles }),
    },
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
        return text(await verifyWorktree(projectRoot, args.path, args.branch));
      },
    },
    {
      name: "delegate",
      description: "Launch a specialist for a role on a brief in a working directory, returning its task id. Validates the role, the workspace, its reservation, duplicates and the resume binding first.",
      inputSchema: {
        type: "object",
        properties: {
          role: { type: "string" }, brief: { type: "string" }, cwd: { type: "string" },
          engine: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
          branch: { type: "string" }, resume: { type: "string" }, force: { type: "boolean" },
        },
        required: ["role", "brief", "cwd"],
      },
      rows: ["operator", "lead"],
      handler: async (args, context) => {
        const request = delegateRequest(fields(args, "delegate"));
        const launched = await delegate(projectRoot, request, { authority: context.authority, leadRole: options.leadRole });
        return answer(launched.ok ? { ok: true, task_id: launched.taskId } : launched);
      },
    },
    {
      name: "check",
      description: "The status of a task, how long it has been running, and the last lines of its engine's own event stream. Reconciles nothing.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" }, lines: { type: "number" } },
        required: ["task_id"],
      },
      rows: ["operator", "lead", "specialist"],
      handler: (args, _context) => {
        const values = fields(args, "check");
        const lines = optional(values, "lines", "number", "check") as number | undefined;
        if (lines !== undefined && (!Number.isSafeInteger(lines) || lines <= 0)) {
          throw new RpcError(-32602, `check's lines must be a positive whole number, not ${lines}`);
        }
        return answer(check(projectRoot, requiredString(values, "task_id", "check"), { lines }));
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
      inputSchema: { type: "object", properties: { status: { type: "string", enum: statuses } } },
      rows: ["operator", "lead", "specialist"],
      handler: async (args) => {
        const status = optional(fields(args, "list_tasks"), "status", "string", "list_tasks") as string | undefined;
        if (status !== undefined && !statuses.includes(status)) {
          throw new RpcError(-32602, `list_tasks status must be one of ${statuses.join(", ")}`);
        }
        return answer(await listTasks(projectRoot, status as TaskStatus | undefined));
      },
    },
  ];
}

/** Serves the project `discoverProject` names, or exits with the reason there is none. */
async function main(): Promise<void> {
  const found = await discoverProject(process.argv.slice(2), process.env, process.cwd());
  if ("reason" in found) throw new Error(found.reason);
  const { root } = found;
  const { maxDepth } = loadConfig(root).limits;
  // Once before serving, so the first request reads a ledger that is in step with the
  // kernel: a task whose runner died while no server was running is judged here rather
  // than on whichever call happens to be first (design section 2).
  const pass = await reconcileAndCleanup(root);
  for (const { id, reason } of [...pass.errors, ...pass.skipped]) {
    process.stderr.write(`cross-agent: task ${id}: ${reason}\n`);
  }
  // No lead role: a host-placed mode has none until its mode binds one (S8).
  createServer({ tools: projectTools(root), authority: () => resolveAuthority(root, process.env, { maxDepth }) })
    .connect(process.stdin, process.stdout);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`cross-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
