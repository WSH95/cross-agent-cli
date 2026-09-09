import { createHash } from "node:crypto";
import path from "node:path";
import type { CrossAgentConfig, EngineName, SandboxProfile } from "./config.ts";
import type { TaskRecord, TaskStatus } from "./ledger.ts";

// Callers supply canonical absolute cwd values; guards never resolve paths through the filesystem.
export interface LineageEntry {
  taskId: string;
  role: string;
  cwd: string;
}

export interface DuplicateRequest {
  role: string;
  cwd: string;
  brief: string;
  force?: boolean;
}

export interface ResumeRequest {
  role: string;
  engine: EngineName;
  cwd: string;
  sandbox: SandboxProfile;
}

type ResumeRecord = TaskRecord & { sandbox?: SandboxProfile };

const activeStatuses = new Set<TaskStatus>(["launching", "running", "stalled", "orphaned", "cancelling"]);

export function readDepth(env: Readonly<NodeJS.ProcessEnv>): { depth: number; reason?: string } {
  const value = env.CROSS_AGENT_DEPTH;
  if (value === undefined) {
    return env.CROSS_AGENT_LINEAGE === undefined
      ? { depth: 0 }
      : { depth: Infinity, reason: "CROSS_AGENT_LINEAGE is present but CROSS_AGENT_DEPTH is absent" };
  }
  const depth = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(depth)) {
    return { depth: Infinity, reason: "CROSS_AGENT_DEPTH must be a non-negative decimal safe integer" };
  }
  return { depth };
}

export function toolsAtDepth(depth: number, maxDepth: number): string[] {
  return depth < maxDepth
    ? ["list_roles", "delegate", "wait", "check", "result", "cancel", "list_tasks", "verify_worktree", "git_mutate"]
    : ["list_roles", "list_tasks", "check", "result"];
}

export function parseLineage(value: string | undefined): LineageEntry[] {
  if (value === undefined) return [];
  const reason = "CROSS_AGENT_LINEAGE must be a JSON array of {taskId, role, cwd} string entries";
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(reason);
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
    && typeof entry.taskId === "string" && typeof entry.role === "string" && typeof entry.cwd === "string",
  )) {
    throw new Error(reason);
  }
  return parsed as LineageEntry[];
}

export function formatLineage(entries: readonly LineageEntry[]): string {
  return JSON.stringify(entries);
}

export function childLineage(parent: readonly LineageEntry[], entry: LineageEntry): LineageEntry[] {
  return [...parent, entry];
}

export function lineageRefusal(lineage: readonly LineageEntry[], role: string, cwd: string): string | null {
  const ancestor = lineage.find((entry) => entry.role === role && entry.cwd === cwd);
  return ancestor
    ? `refused delegation for role ${JSON.stringify(role)} in ${JSON.stringify(cwd)}: task ${ancestor.taskId} already has this pair in CROSS_AGENT_LINEAGE`
    : null;
}

export function duplicateRefusal(
  request: DuplicateRequest, records: readonly TaskRecord[], now: number, windowMinutes: number,
): string | null {
  const briefHash = createHash("sha256").update(request.brief).digest("hex");
  const matches = records.filter((record) =>
    record.role === request.role && record.cwd === request.cwd && record.briefHash === briefHash,
  );
  const active = matches.find((record) => activeStatuses.has(record.status));
  if (active) return `already running, wait on ${active.id}`;
  if (request.force === true) return null;

  // Terminal metadata patches can advance updatedAt, conservatively extending the duplicate window.
  const finished = matches.find((record) => record.updatedAt >= now - windowMinutes * 60_000);
  return finished
    ? `refused duplicate delegation: task ${finished.id} finished within the ${windowMinutes}-minute duplicate window`
    : null;
}

export function resumeRefusal(request: ResumeRequest, record: ResumeRecord): string | null {
  if (activeStatuses.has(record.status)) {
    return `refused resume of task ${record.id}: status ${record.status} is active`;
  }
  if (record.sandbox === undefined) {
    return `refused resume of task ${record.id}: original sandbox metadata is missing`;
  }
  for (const field of ["role", "engine", "cwd", "sandbox"] as const) {
    if (request[field] !== record[field]) {
      return `refused resume of task ${record.id}: ${field} ${JSON.stringify(request[field])} differs from the original ${JSON.stringify(record[field])}`;
    }
  }
  return null;
}

/** repoRoot is the caller-supplied absolute repository path. */
export function denyTargets(config: CrossAgentConfig, repoRoot: string): string[] {
  const binaries = Object.values(config.engines ?? {}).flatMap((engine) => engine.bin === undefined ? [] : [engine.bin]);
  return [
    "claude", "codex", "grok", ...binaries,
    `node ${path.join(repoRoot, "src", "server.ts")}`, `node ${path.join(repoRoot, "src", "cli.ts")}`, "cross-agent",
  ];
}

export function denyArgs(engine: EngineName, targets: readonly string[]): string[] {
  switch (engine) {
    case "claude": return ["--disallowedTools", ...targets.flatMap((target) => [`Bash(${target} *)`, `Bash(${target})`])];
    case "grok": return targets.flatMap((target) => ["--deny", `Bash(${target} *)`]);
    // Codex exec ignores rules files; its sandbox's network denial supplies this layer (probes P3/P3b).
    case "codex": return [];
  }
}

export function exclusionArgs(engine: EngineName): string[] {
  switch (engine) {
    case "claude": return ["--strict-mcp-config"];
    case "codex": return ["--ignore-user-config"];
    // Grok inherits MCP configuration; the depth guard restricts the inherited server.
    case "grok": return [];
  }
}

export function childEnv(
  parentEnv: Readonly<NodeJS.ProcessEnv>, depth: number, taskId: string,
  lineage: readonly LineageEntry[], billing: CrossAgentConfig["billing"],
): NodeJS.ProcessEnv {
  const exactMarkers = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"];
  const prefixes = ["CLAUDE_CODE_", "CLAUDE_PLUGIN_", "CODEX_COMPANION_", "GROK_CC_", "MCP_"];
  const apiKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"];
  const env = Object.fromEntries(Object.entries(parentEnv).filter(([key]) =>
    !exactMarkers.includes(key) && !prefixes.some((prefix) => key.startsWith(prefix))
    && !(billing === "subscription" && apiKeys.includes(key)),
  ));
  return {
    ...env,
    CROSS_AGENT_DEPTH: String(depth + 1),
    CROSS_AGENT_TASK: taskId,
    CROSS_AGENT_LINEAGE: formatLineage(lineage),
  };
}
