import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { verifyWorktree } from "./worktree.ts";

// cross-agent MCP server: JSON-RPC 2.0 over stdio, one message per line.
// Requests are dispatched as they arrive; a slow tool call never blocks the
// next request on the same connection.

export type Json = Record<string, unknown>;

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Json;
  handler: (args: Json) => Promise<ToolResult> | ToolResult;
}

export interface ServerOptions {
  tools: ToolDefinition[];
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
      case "tools/list":
        return { tools: [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      case "tools/call": {
        const tool = tools.get(String(params.name));
        if (!tool) throw new RpcError(-32602, `unknown tool: ${String(params.name)}`);
        try {
          return await tool.handler((params.arguments ?? {}) as Json);
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

/** The tools offered to a lead session for the project at `projectRoot`. Depth gating and the delegation tools arrive with T3 and T10. */
export function projectTools(projectRoot: string): ToolDefinition[] {
  return [
    {
      name: "list_roles",
      description: "List the dev team roles configured in .cross-agent/config.json with their engine, model, working directory kind, and sandbox profile.",
      inputSchema: { type: "object", properties: {} },
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

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  createServer({ tools: projectTools(process.cwd()) }).connect(process.stdin, process.stdout);
}
