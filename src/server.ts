import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolveAuthority } from "./authority.ts";
import type { Authority, Row } from "./authority.ts";
import { loadConfig } from "./config.ts";
import { discoverProject } from "./project.ts";
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

/** The tools for the project at `projectRoot`, each with its rows. The delegation tools arrive with T10b. */
export function projectTools(projectRoot: string): ToolDefinition[] {
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
  ];
}

/** Serves the project `discoverProject` names, or exits with the reason there is none. */
async function main(): Promise<void> {
  const found = await discoverProject(process.argv.slice(2), process.env, process.cwd());
  if ("reason" in found) throw new Error(found.reason);
  const { root } = found;
  const { maxDepth } = loadConfig(root).limits;
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
