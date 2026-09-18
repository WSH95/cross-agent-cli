import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Authority } from "./authority.ts";
import { CONFIG_PATH, loadConfig } from "./config.ts";
import type { CrossAgentConfig, RoleConfig } from "./config.ts";
import { childEnv, childLineage, denyTargets, duplicateRefusal, lineageRefusal, parseLineage, resumeRefusal } from "./guard.ts";
import type { LineageEntry } from "./guard.ts";
import { create, readSpec, scan, writeSpec } from "./ledger.ts";
import type { LaunchSpec, TaskRecord } from "./ledger.ts";
import { acquire, lockPath, spawnLockName } from "./locks.ts";
import { canonicalPath, reservations, reservedBy } from "./reservation.ts";
import { sandboxFor } from "./engines/registry.ts";
import type { SandboxProfile } from "./engines/registry.ts";
import { engineNames } from "./engines/types.ts";
import type { EngineName } from "./engines/types.ts";
import { verifyWorktree } from "./worktree.ts";

// `delegate`: validate under `spawn.lock`, write the record and the launch spec, start the
// detached runner. Everything it refuses, it refuses before a record exists, so a refusal
// leaves the project exactly as it found it (design section 2).

export interface DelegateRequest {
  role: string;
  brief: string;
  cwd: string;
  engine?: string;
  model?: string;
  effort?: string;
  /** Required for a role whose workspace is a worktree: the branch that worktree must be on. */
  branch?: string;
  /** The task to continue. Bound to the original's role, engine, cwd and sandbox profile. */
  resume?: string;
  /** Delegate again although an identical task finished inside the duplicate window. */
  force?: boolean;
}

export interface DelegateOptions {
  /** Who this call serves. A lead's own task is what its children are recorded under. */
  authority: Authority;
  /** The active mode's lead role, which no mode names until step 8. */
  leadRole?: string;
  /** The server's own environment: the parent of the child's, and the runner's own. */
  env?: NodeJS.ProcessEnv;
  now?: number;
}

export type DelegateResult = { ok: true; taskId: string } | { ok: false; reason: string };

const active = new Set(["launching", "running", "stalled", "orphaned", "cancelling"]);
/** The statuses that carry authority, and so the only ones a lead may delegate under. */
const authoritative = new Set(["running", "stalled"]);

function refuse(reason: string): DelegateResult {
  return { ok: false, reason: `refused delegation: ${reason}` };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Until a mode brings the role's own prompt (design section 8), this is what a role says. */
function defaultPrompt(role: string): string {
  return `You are the ${role} for this project: do what the brief asks in the working directory you were given, report the outcome in your final message, and do not delegate — report back instead.`;
}

function directory(target: string): boolean {
  return fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** The workspace rule of the role's own kind (design section 6). */
async function workspaceFault(projectRoot: string, role: RoleConfig, name: string, cwd: string, branch?: string): Promise<string | null> {
  if (role.cwd === "root") {
    return cwd === canonicalPath(projectRoot) ? null : `role ${JSON.stringify(name)} works at the project root ${projectRoot}, not ${cwd}`;
  }
  if (branch === undefined || branch === "") {
    return `role ${JSON.stringify(name)} works in a worktree, so the request must name the branch it is on`;
  }
  const verified = await verifyWorktree(projectRoot, cwd, branch);
  return "reason" in verified ? verified.reason : null;
}

/** Every record of one resume chain: what `id` continues, and what continues it. */
function resumeChain(records: readonly TaskRecord[], id: string): Set<string> {
  const chain = new Set<string>([id]);
  const byId = new Map(records.map((record) => [record.id, record]));
  for (let current = byId.get(id)?.resumedFrom; current && !chain.has(current); current = byId.get(current)?.resumedFrom) {
    chain.add(current);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const record of records) {
      if (record.resumedFrom !== undefined && record.resumedFrom !== null
        && chain.has(record.resumedFrom) && !chain.has(record.id)) {
        chain.add(record.id);
        grew = true;
      }
    }
  }
  return chain;
}

/**
 * Why this resume may not proceed, or null. `resumeRefusal` binds the new task to the
 * original's role, engine, cwd and sandbox profile (design section 5, layer 4), reading
 * the profile where it is kept — the original's own launch spec. The two rules here are
 * the chain's, and they need the scan: a chain keeps at most one active record and never
 * forks, so only its latest record may be continued, and only once it has settled.
 */
function resumeFault(
  projectRoot: string, records: readonly TaskRecord[], id: string,
  request: { role: string; engine: EngineName; cwd: string; sandbox: SandboxProfile },
): string | null {
  const original = records.find((record) => record.id === id);
  if (!original) return `no task ${id}`;
  const chain = resumeChain(records, id);
  const live = records.find((record) => chain.has(record.id) && active.has(record.status));
  if (live) return `${live.id} is ${live.status}; wait or cancel first`;
  const successor = records.find((record) => record.resumedFrom === id);
  if (successor) return `resume the latest: ${successor.id}`;
  let sandbox: SandboxProfile | undefined;
  try {
    sandbox = readSpec(projectRoot, id).sandbox.profile as SandboxProfile;
  } catch {
    // An unreadable spec leaves the binding unprovable, which `resumeRefusal` names.
  }
  const bound = resumeRefusal(request, { ...original, sandbox });
  if (bound !== null) return bound;
  if (!original.sessionId) return `refused resume of task ${id}: task ${id} recorded no engine session to continue`;
  return null;
}

export async function delegate(projectRoot: string, request: DelegateRequest, options: DelegateOptions): Promise<DelegateResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  for (const field of ["role", "brief", "cwd"] as const) {
    if (typeof request[field] !== "string" || request[field] === "") return refuse(`${field} must be a non-empty string`);
  }
  let config: CrossAgentConfig;
  try {
    config = loadConfig(projectRoot);
  } catch (error) {
    return refuse(message(error));
  }
  if (options.authority.row === "lead" && options.leadRole !== undefined && request.role === options.leadRole) {
    // `delegate (another lead)` is the operator's row alone in the permission matrix: a
    // lead delegates specialists, and the mode's own lead is placed by the launcher.
    return refuse(`role ${JSON.stringify(request.role)} is the mode's lead role; a lead delegates specialists`);
  }
  // Depth is written to the record and read back by the loop guard, so a caller whose own
  // depth could not be trusted — `readDepth` answers Infinity for that — delegates
  // nothing rather than writing a record no reader could judge.
  const depth = options.authority.depth + 1;
  if (!Number.isSafeInteger(depth)) return refuse(`depth ${options.authority.depth} cannot be trusted`);
  let lineage: readonly LineageEntry[];
  try {
    lineage = parseLineage(env.CROSS_AGENT_LINEAGE);
  } catch (error) {
    return refuse(message(error));
  }

  const waitSeconds = config.limits.lockWaitSeconds;
  let claim;
  try {
    claim = await acquire(lockPath(projectRoot, spawnLockName()), {
      operation: `delegate ${request.role}`, waitSeconds,
    });
  } catch (error) {
    return refuse(message(error));
  }
  try {
    // One scan for everything under this lock: the caller's own record, the duplicate
    // window and the resume chain are all read from it, and nothing writes in between.
    const { records } = scan(projectRoot);

    // 0. The caller's own task, re-read under the lock: a cancel that reached the parent
    // first owns the cascade, and a child delegated after it would be outside the snapshot.
    const parentTaskId = options.authority.row === "lead" ? options.authority.taskId : undefined;
    if (parentTaskId !== undefined) {
      const parent = records.find((record) => record.id === parentTaskId);
      if (!parent) return refuse(`no parent task ${parentTaskId}`);
      if (!authoritative.has(parent.status)) return refuse(`parent task ${parentTaskId} is ${parent.status}`);
    }

    // 1. The role, its engine, and the workspace as the reservation will key it.
    if (!Object.hasOwn(config.roles, request.role)) return refuse(`no role ${JSON.stringify(request.role)} in ${CONFIG_PATH}`);
    const role = config.roles[request.role];
    const engine = (request.engine ?? role.engine) as EngineName;
    if (!engineNames.includes(engine)) {
      return refuse(`no engine ${JSON.stringify(request.engine)}; this build has ${engineNames.join(", ")}`);
    }
    const model = request.model ?? role.model ?? null;
    const effort = request.effort ?? role.effort ?? null;
    if (!path.isAbsolute(request.cwd)) return refuse(`cwd ${JSON.stringify(request.cwd)} must be an absolute path`);
    const cwd = canonicalPath(request.cwd);
    if (!directory(cwd)) return refuse(`no directory at ${cwd}`);
    // The role's own profile, never the request's, because it is the rule the record will
    // be reserved by; an engine override has to be one that declares it.
    let sandbox: LaunchSpec["sandbox"];
    try {
      sandbox = sandboxFor(engine, role.sandbox);
    } catch (error) {
      return refuse(message(error));
    }

    // 2. Where this role may work.
    const fault = await workspaceFault(projectRoot, role, request.role, cwd, request.branch);
    if (fault !== null) return refuse(fault);

    // 3. The workspace reservation, and the records nobody can read (design section 2, E2).
    const known = reservations(projectRoot);
    const holder = reservedBy(projectRoot, cwd, known);
    if (holder !== null) return refuse(`${cwd} is reserved by task ${holder.id} (${holder.status}); wait or cancel first`);
    if (sandbox.mode !== "read-only" && known.unknown.length > 0) {
      const files = known.unknown.map((entry) => `${entry.file} (${entry.reason})`).join(", ");
      return refuse(`no workspace can be cleared while a task record cannot be read: ${files}; repair or remove it first`);
    }

    // 4. The loop guard: lineage, duplicates, and the resume binding.
    const repeat = lineageRefusal(lineage, request.role, cwd);
    if (repeat !== null) return { ok: false, reason: repeat };
    let resumeSessionId: string | undefined;
    if (request.resume === undefined) {
      const duplicate = duplicateRefusal({ role: request.role, cwd, brief: request.brief, force: request.force }, records, now,
        config.limits.duplicateWindowMinutes);
      if (duplicate !== null) return { ok: false, reason: duplicate };
    } else {
      const chain = resumeFault(projectRoot, records, request.resume, {
        role: request.role, engine, cwd, sandbox: sandbox.profile as SandboxProfile,
      });
      if (chain !== null) return { ok: false, reason: chain };
      resumeSessionId = records.find((record) => record.id === request.resume)!.sessionId!;
    }

    // 5. Nothing exists yet, and the checks above were only true while this lock held them
    // true, so a lock already lost is a launch that must not happen (design section 2).
    if (claim.lost) return refuse("spawn.lock was lost before the record was written; nothing was launched");

    // 6. The record, its spec, and the runner that owns the engine from here on.
    const record = create(projectRoot, {
      role: request.role, brief: request.brief, cwd, engine, model, effort, depth,
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
      ...(request.resume === undefined ? {} : { resumedFrom: request.resume }),
    }, now);
    // The task's own directory, which nothing else shares: an adapter writes a role file
    // and a lead's mount config here, never into a workspace the role may edit.
    const scratchDir = path.join(path.dirname(record.logPath), `${record.id}.scratch`);
    fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    const spec: LaunchSpec = {
      role: request.role, brief: request.brief, rolePrompt: role.prompt ?? defaultPrompt(request.role),
      cwd, engine, sandbox,
      ...(model === null ? {} : { model }),
      ...(effort === null ? {} : { effort }),
      sessionId: randomUUID(),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      denyTargets: denyTargets(config, projectRoot),
      env: {
        ...childEnv(env, options.authority.depth, record.id, childLineage(lineage, {
          taskId: record.id, role: request.role, cwd,
        }), config.billing, projectRoot),
        // The one way a configured binary reaches both the adapter's capability check and
        // its spawn line, which read the same environment (design section 3).
        ...binEnvironment(config, engine),
      },
      scratchDir,
      adapterModule: fileURLToPath(new URL(`./engines/${engine}.ts`, import.meta.url)),
    };
    writeSpec(projectRoot, record.id, spec);
    startRunner(projectRoot, record.id, env);
    return { ok: true, taskId: record.id };
  } finally {
    await claim.release();
  }
}

function binEnvironment(config: CrossAgentConfig, engine: EngineName): NodeJS.ProcessEnv {
  const bin = config.engines?.[engine]?.bin;
  return bin === undefined ? {} : { [`CROSS_AGENT_${engine.toUpperCase()}_BIN`]: bin };
}

/**
 * The detached runner, started with the **server's** own environment and never the spec's:
 * the spec's environment is the engine's, and a runner carrying it would be indistinguishable
 * from the engine it is about to spawn (design section 2). It is unref'd, so the server may
 * exit while the task runs on.
 */
function startRunner(projectRoot: string, id: string, env: NodeJS.ProcessEnv): void {
  const runner = fileURLToPath(new URL("./runner.ts", import.meta.url));
  const child = spawn(process.execPath, [runner, "--project", projectRoot, "--task", id], {
    cwd: projectRoot, detached: true, stdio: "ignore", env,
  });
  // A runner that could not be started leaves a `launching` record its deadline settles:
  // the failure belongs to reconciliation, which is the only reader that can tell a runner
  // that never started from one that died a moment later.
  child.once("error", () => {});
  child.unref();
}
