import type { EngineName } from "../config.ts";
export type { EngineName };

export interface SpawnRequest {
  role: string;
  brief: string;
  rolePrompt: string;
  cwd: string;
  sandbox: "read-only" | "workspace-write" | "off";
  model?: string;
  effort?: string;
  sessionId: string;
  resumeSessionId?: string;
  denyTargets: string[];
  /** Already prepared by childEnv; the pipeline does not inherit additional variables. */
  env: NodeJS.ProcessEnv;
  logPath: string;
  resultPath: string;
}

export interface SpawnPlan {
  bin: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}

export type EngineEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "activity"; text: string }
  | { kind: "result"; text: string }
  | { kind: "error"; text: string };

export interface EngineAdapter {
  name: EngineName;
  sandboxSupport(): { ok: true } | { ok: false; reason: string };
  plan(request: SpawnRequest): SpawnPlan;
  /** Receives one stdout line without its terminator; unknown lines return null. */
  parseLine(line: string): EngineEvent | null;
  finalMessage(events: EngineEvent[], resultFileText: string | null): string;
}
