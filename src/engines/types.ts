/**
 * The engines this build has adapters for. It lives here, with the contract, so that the
 * contract depends on nothing: `src/config.ts` reads these names, not the other way round.
 */
export const engineNames = ["claude", "codex", "grok"] as const;
export type EngineName = typeof engineNames[number];

/** What a profile means to the pipeline, whatever the engine calls it (design section 3). */
export type SandboxMode = "read-only" | "write" | "off";

/** How to start this MCP server, as an engine-placed lead's mount has to say it. */
export interface LeadMountSpec {
  command: string;
  args: string[];
  /** An adapter with no probed way to carry a server environment may refuse a non-empty one (Codex does). */
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
  /**
   * The role's workspace, already canonical: the caller resolves it with `canonicalPath`
   * (`src/reservation.ts`), which is also what keys the reservation. An adapter passes it
   * through untouched — it is the spawn's own cwd and, where an engine names a writable
   * root, the name it gives that root — because the child sees the resolved path, and a
   * sandbox told about a symlink to the same directory would not be told about the
   * directory.
   */
  cwd: string;
  /** The engine this request is for, which must be the adapter that runs it. */
  engine: EngineName;
  /**
   * `profile` is the engine's own name for it; `mode` is what `sandboxProfiles` says that
   * profile means. The pair is a claim: both the pipeline and the reservation rule
   * re-derive the mode from the engine's own map rather than trust what is carried here.
   */
  sandbox: { mode: SandboxMode; profile: string };
  model?: string;
  effort?: string;
  sessionId: string;
  resumeSessionId?: string;
  denyTargets: string[];
  /** Already prepared by childEnv; the pipeline does not inherit additional variables. */
  env: NodeJS.ProcessEnv;
  /**
   * Paths a sandbox must refuse even where the engine's own default would allow them: the
   * workspace's `.git` pointer and the repository's common git directory, which
   * `verifyWorktree` resolves. Set for a **worktree workspace**, whatever profile runs
   * there, and both profiles deny them — a read-only role that could rewrite its own
   * pointer file would be as far outside design section 4 as a writable one. Probe P2
   * (Claude, 2026-09-19) is why it exists: a writable root named the worktree alone and
   * the repository's `.git` beside it was still writable. What an adapter does with it is
   * its own: Claude deny-lists them (`filesystem.denyWrite`), beside the workspace itself
   * for a read-only role, Codex needs no argument because its `workspace-write` already
   * protects `.git` inside the workspace and denies everything outside it, and Grok
   * cannot enforce it at all, which is what leaves `verify_worktree` as the check
   * (design section 4).
   */
  protectedPaths?: string[];
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
  /**
   * Whether this engine can be sandboxed here, judged against `env`: the environment the
   * pipeline will spawn with, which is the one carrying `CROSS_AGENT_<ENGINE>_BIN` and the
   * `PATH` the child will search. Reading this process's own environment instead would
   * judge a different binary from the one `plan` goes on to spawn.
   */
  sandboxSupport(env: Readonly<NodeJS.ProcessEnv>): { ok: true } | { ok: false; reason: string };
  denyArgs(targets: readonly string[]): string[];
  exclusionArgs(): string[];
  /**
   * Called by this adapter's own `plan` when `request.lead` is set: `plan` folds `argv`
   * into the spawn line and `files` into `SpawnPlan.files`, and still emits
   * `exclusionArgs()` beside it — on Claude that flag, not the config file, is what makes
   * the mount exclusive.
   */
  leadMount(spec: LeadMountSpec, scratchDir: string): LeadMount;
  plan(request: SpawnRequest): SpawnPlan;
  /** Receives one stdout line without its terminator; unknown lines return null. */
  parseLine(line: string): EngineEvent | null;
  /**
   * The same for stderr, for an engine that writes a fatal line there rather than into its
   * event stream. Claude's sandbox refusals are the case (probe P1): the run continues and
   * can still exit 0, but nothing it did was sandboxed, so the line is an `error` event and
   * the run has failed. The pipeline reads stderr for an adapter that declares this and for
   * no other, so for every other adapter stderr stays log evidence and nothing more; and it
   * asks only until the first `error`, because a sandbox that fails every command repeats
   * itself once per command and one such event is the whole verdict.
   */
  parseStderrLine?(line: string): EngineEvent | null;
  /**
   * For an engine whose output is one document at exit rather than a line stream. The
   * pipeline buffers raw stdout only for an adapter that declares it, calls it once at
   * completion before `finalMessage`, and appends its events, so a late `session` or
   * `result` still counts. No built-in adapter declares it: all three engines speak line
   * streams, and the hook's only exercise is the fake engine's `grok-json` format
   * (`tests/fixtures/fake-engine.mjs`), which is the shape Grok's `json` mode would need
   * it for (design section 3).
   */
  finish?(rawStdout: string): EngineEvent[];
  finalMessage(events: EngineEvent[], resultFileText: string | null): string;
}
