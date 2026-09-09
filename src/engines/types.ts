import type { EngineName } from "../config.ts";
export type { EngineName };

/** What a profile means to the pipeline, whatever the engine calls it (design section 3). */
export type SandboxMode = "read-only" | "write" | "off";

/** How to start this MCP server, as an engine-placed lead's mount has to say it. */
export interface LeadMountSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The argv that mounts exactly this server, and any file that argv points at. The adapter
 * returns the files rather than writing them, so it stays the pure argv builder `plan` is;
 * the pipeline writes them before the spawn. `inherited` marks an engine with no
 * per-invocation mount at all (Grok, P9): its argv is empty and the mount is the
 * operator's own configuration.
 */
export interface LeadMount {
  argv: string[];
  files?: Array<{ path: string; contents: string }>;
  inherited?: true;
}

export interface SpawnRequest {
  role: string;
  brief: string;
  rolePrompt: string;
  cwd: string;
  /** `profile` is the engine's own name for it; `mode` is what it means (`sandboxProfiles`). */
  sandbox: { mode: SandboxMode; profile: string };
  model?: string;
  effort?: string;
  sessionId: string;
  resumeSessionId?: string;
  denyTargets: string[];
  /** Already prepared by childEnv; the pipeline does not inherit additional variables. */
  env: NodeJS.ProcessEnv;
  /** The task's own directory (`path.dirname(logPath)`): where an adapter's files go, never the specialist's worktree. */
  scratchDir: string;
  /** Set only for an engine-placed lead, which mounts this server through `leadMount`. */
  lead?: LeadMountSpec;
  logPath: string;
  resultPath: string;
}

export interface SpawnPlan {
  bin: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  /** Written by the pipeline, parents included, before the spawn. */
  files?: LeadMount["files"];
}

export type EngineEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "activity"; text: string }
  | { kind: "result"; text: string }
  | { kind: "error"; text: string };

export interface EngineAdapter {
  name: EngineName;
  /** The profile names this engine accepts, each mapped to its portable mode. */
  sandboxProfiles: Record<string, SandboxMode>;
  sandboxSupport(): { ok: true } | { ok: false; reason: string };
  denyArgs(targets: readonly string[]): string[];
  exclusionArgs(): string[];
  leadMount(spec: LeadMountSpec, scratchDir: string): LeadMount;
  plan(request: SpawnRequest): SpawnPlan;
  /** Receives one stdout line without its terminator; unknown lines return null. */
  parseLine(line: string): EngineEvent | null;
  /**
   * For an engine whose output is one document at exit rather than a line stream. The
   * pipeline buffers raw stdout only for an adapter that declares it, calls it once at
   * completion before `finalMessage`, and appends its events, so a late `session` or
   * `result` still counts.
   */
  finish?(rawStdout: string): EngineEvent[];
  finalMessage(events: EngineEvent[], resultFileText: string | null): string;
}
