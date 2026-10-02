import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Authority } from "./authority.ts";
import { bindingFault, CONFIG_PATH, effectiveMaxDepth, engineLeadRole, loadConfig, modeDrift } from "./config.ts";
import type { CrossAgentConfig } from "./config.ts";
import { childEnv, childLineage, denyTargets, duplicateRefusal, lineageRefusal, parseLineage, resumeRefusal } from "./guard.ts";
import type { LineageEntry } from "./guard.ts";
import { run } from "./gitmutate.ts";
import { gitRoot, trackedStateFault } from "./gitroot.ts";
import { removeJournal } from "./journal.ts";
import { create, newTaskId, projectLock, readSpec, scan, writeSpec } from "./ledger.ts";
import type { LaunchSpec, TaskRecord, TaskWorktree } from "./ledger.ts";
import { spawnLockName } from "./locks.ts";
import { asksSection, lineageAsks } from "./mailbox.ts";
import { findRole, gitPolicy, rolePrompt } from "./modes.ts";
import type { Mode, Workspace } from "./modes.ts";
import { canonicalPath, reservations, reservedBy } from "./reservation.ts";
import { lineageIds, ownedBy } from "./tasks.ts";
import { adapterFor, sandboxFor } from "./engines/registry.ts";
import type { SandboxProfile } from "./engines/registry.ts";
import { engineNames } from "./engines/types.ts";
import type { EngineName, LeadMountSpec } from "./engines/types.ts";
import { locateRepository, verifyWorktree } from "./worktree.ts";
import type { RepositoryIdentity, VerifiedWorktree } from "./worktree.ts";

// `delegate`: validate under `spawn.lock`, write the record and the launch spec, start the
// detached runner. Everything it refuses, it refuses before a record exists, so a refusal
// leaves the project exactly as it found it (design section 2).

/**
 * This repository, resolved from this module: where `src/server.ts` and `src/cli.ts`
 * actually are, which is what the deny list has to name. The project a task runs in has
 * neither, and a rule naming `<project>/src/server.ts` denies nothing (I1, 2026-09-19).
 * It is the same base `adapterModule` is built from.
 */
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export interface DelegateRequest {
  role: string;
  brief: string;
  cwd: string;
  engine?: string;
  model?: string;
  effort?: string;
  /** Required for a role whose workspace is a worktree: the branch that worktree must be on. */
  branch?: string;
  /**
   * Give this task a writable worktree of its own — `<worktreeDir>/<id>` on the mode's
   * branch pattern — instead of running it at the project root. Valid for a role whose
   * workspace is root, which is the only kind that has no worktree already.
   */
  worktree?: boolean;
  /** The task to continue. Bound to the original's role, engine, cwd and sandbox profile. */
  resume?: string;
  /** Delegate again although an identical task finished inside the duplicate window. */
  force?: boolean;
}

export interface DelegateOptions {
  /** Who this call serves. A lead's own task is what its children are recorded under. */
  authority: Authority;
  /** The active mode: where each role works, what it defaults to, and which role is the lead. */
  mode: Mode;
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

/**
 * What a `worktree: true` one-shot runs under: the writable counterpart of the read-only
 * profile its role has at the root, in each engine's own spelling (design section 3).
 * `sandboxFor` re-derives the mode from the adapter's own map, so a name an engine does
 * not declare is a refusal here rather than a launch.
 */
export const writableProfiles: Record<EngineName, SandboxProfile> = {
  claude: "workspace-write", codex: "workspace-write", grok: "workspace",
};

function directory(target: string): boolean {
  return fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** The workspace rule of the kind the mode gave this role (design, "Modes"). */
async function workspaceFault(
  projectRoot: string, workspace: Workspace, name: string, cwd: string, branch?: string, repo?: RepositoryIdentity,
): Promise<{ fault: string } | { verified?: VerifiedWorktree }> {
  if (workspace.kind === "root") {
    return cwd === canonicalPath(projectRoot) ? {} : { fault: `role ${JSON.stringify(name)} works at the project root ${projectRoot}, not ${cwd}` };
  }
  if (branch === undefined || branch === "") {
    return { fault: `role ${JSON.stringify(name)} works in a worktree, so the request must name the branch it is on` };
  }
  // The verification is the check and the source of `protectedPaths`: the caller keeps
  // what it resolved rather than running git a second time to learn the same thing.
  const verified = await verifyWorktree(projectRoot, cwd, branch, repo);
  return "reason" in verified ? { fault: verified.reason } : { verified };
}

/** What an engine-placed lead launches with that no specialist does (design, "The lead model"). */
interface EngineLead {
  /** The record's id, minted first so the mount is built against the directory the task will own. */
  id: string;
  mount: LeadMountSpec;
  /** The mode's loop, read once: the first half of the lead's role prompt. */
  loop: string;
}

/**
 * The engine-placed lead's own preparation, or the reason it cannot run, all before a
 * record exists. Three things are settled here.
 *
 * The **cap**: the lead's server resolves the lead row only below the project's effective
 * depth cap (`src/authority.ts#resolveAuthority`), and at or above it every tool the loop
 * runs on is refused, so a lead the cap would hold to the specialist row is not launched.
 *
 * The **mount**: this server, for this project, with `--project` in its arguments and no
 * environment — the form both lead engines' mounts accept (P9; `tools/probe.mjs --track`).
 * The adapter is asked for it here, and one whose mount is the operator's own inherited
 * configuration has no per-run isolation to give a lead: refused with P9's reason, whatever
 * the engine (Grok, the one that answers so, is refused by name before this).
 *
 * The **loop**: the mode's own text, which reaches the lead as the first half of its role
 * prompt — the engine's instruction file — and never as a copy anywhere else (design,
 * "Two skills, and how the loop is delivered").
 */
function engineLead(
  projectRoot: string, mode: Mode, config: CrossAgentConfig, engine: EngineName, depth: number, role: string,
): EngineLead | { fault: string } {
  const named = `role ${JSON.stringify(role)} is mode ${mode.id}'s engine-placed lead`;
  const cap = effectiveMaxDepth(mode, config);
  if (depth >= cap) {
    return { fault: `${named}, which would run at depth ${depth}, and this project's depth cap of ${cap} holds a server at that depth to the specialist row; set limits.maxDepth to ${depth + 1} or more in ${CONFIG_PATH}` };
  }
  const id = newTaskId();
  const mount: LeadMountSpec = { command: process.execPath, args: [path.join(repositoryRoot, "src", "server.ts"), "--project", projectRoot] };
  let inherited: boolean;
  try {
    // A pure call: the mount is the adapter's argv and files, which `plan` folds in at the
    // spawn, so asking for it here writes nothing. The directory is the one step 7 makes.
    inherited = adapterFor(engine).leadMount(mount, path.join(path.resolve(projectRoot, ".cross-agent", "tasks"), `${id}.scratch`)).inherited === true;
  } catch (error) {
    return { fault: message(error) };
  }
  if (inherited) {
    return { fault: `${named}, and ${engine} has no per-run mount to carry one: its server would come from the operator's own inherited configuration (P9: no per-run isolation)` };
  }
  let loop: string;
  try {
    loop = fs.readFileSync(mode.loopFile, "utf8");
  } catch (error) {
    return { fault: `mode ${mode.id}: cannot read the loop its lead runs: ${message(error)}` };
  }
  return { id, mount, loop };
}

/** The lead's system prompt: the mode's loop verbatim, a blank line, then its role's own text. */
function leadPrompt(loop: string, roleHalf: string): string {
  return `${loop}${loop.endsWith("\n") ? "\n" : "\n\n"}${roleHalf}`;
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
  // The mode and the config are checked against each other **again** here. The server read
  // both when it started, and a file can change under a running server: a config that
  // binds a role the mode does not declare, makes a root role writable, or hands an
  // engine-placed lead to Grok is refused at the launch boundary too, because this is
  // where an engine would actually start (design section 6).
  const drift = modeDrift(options.mode, config);
  if (drift !== null) return refuse(drift);
  const binding = bindingFault(options.mode, config, path.join(projectRoot, CONFIG_PATH));
  if (binding !== null) return refuse(binding);
  // A tracked `.cross-agent/` is a config a specialist could have committed, and this call
  // has just read one: the deny targets, the billing mode and `engines.<e>.bin` all reach
  // the runner from it. Both root tools refuse to work in such a project (design section
  // 4) and so does the launch boundary. A project that is not a repository of its own
  // tracks nothing, and has nothing to check.
  const located = await locateRepository(projectRoot);
  // What every verification of this call is held to: the repository located once, here.
  const repo = "reason" in located ? undefined : located;
  if (repo !== undefined) {
    let tracked: string | null;
    try {
      tracked = await trackedStateFault(repo.gitDir, repo.workTree);
    } catch (error) {
      return refuse(message(error));
    }
    if (tracked !== null) return refuse(tracked);
  }

  const leadRole = options.mode.lead.role;
  if (options.authority.row === "lead" && leadRole !== undefined && request.role === leadRole) {
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
    claim = await projectLock(projectRoot, spawnLockName(), {
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
    const caller = options.authority.row === "lead" ? options.authority.taskId : undefined;
    if (caller !== undefined) {
      const parent = records.find((record) => record.id === caller);
      if (!parent) return refuse(`no parent task ${caller}`);
      if (!authoritative.has(parent.status)) return refuse(`parent task ${caller} is ${parent.status}`);
    }

    // 1. The role as the mode declares it and as config binds it, its engine, and the
    // workspace as the reservation will key it. A role the mode does not declare has no
    // workspace and no sandbox default, so there is nothing to launch it under.
    const declared = findRole(options.mode, request.role);
    if (declared === undefined) return refuse(`no role ${JSON.stringify(request.role)} in mode ${options.mode.id}`);
    // A role with no binding is still a role of this mode — the built-in consultant is
    // bound by nothing in a project with no config at all — so the engine may come from
    // the call instead. Nothing else a binding carries is required (design, "Modes").
    const bound = Object.hasOwn(config.roles, request.role) ? config.roles[request.role] : undefined;
    if (bound === undefined && request.engine === undefined) {
      return refuse(`role ${JSON.stringify(request.role)} is bound to no engine in ${CONFIG_PATH}: name engine in this call, or run "cross-agent init --mode ${config.mode}"`);
    }
    const engine = (request.engine ?? bound?.engine) as EngineName;
    if (!engineNames.includes(engine)) {
      return refuse(`no engine ${JSON.stringify(request.engine)}; this build has ${engineNames.join(", ")}`);
    }
    // P9 once more, against the engine this call will actually start rather than the one
    // config binds: a request may name its own, and a Grok lead has no per-run isolation —
    // the server an inherited configuration hands it would resolve to the **lead row**.
    if (engineLeadRole(options.mode) === request.role && engine === "grok") {
      return refuse(`role ${JSON.stringify(request.role)} is mode ${options.mode.id}'s engine-placed lead, and grok cannot carry one (P9: no per-run isolation)`);
    }
    // The engine-placed lead: everything it needs is settled here, before a record exists.
    let lead: EngineLead | undefined;
    if (engineLeadRole(options.mode) === request.role) {
      const prepared = engineLead(projectRoot, options.mode, config, engine, depth, request.role);
      if ("fault" in prepared) return refuse(prepared.fault);
      lead = prepared;
    }
    // A binding's model and effort belong to the engine it binds: `grok --model
    // claude-sonnet-5` is an unknown model id, not a cross-engine default (I1,
    // 2026-09-19). A call that names another engine therefore carries its own or none.
    // Resolved below, once the record a resume continues is in hand: a continuation with
    // no model of its own keeps the original's.
    const binding = bound?.engine === engine ? bound : undefined;
    if (!path.isAbsolute(request.cwd)) return refuse(`cwd ${JSON.stringify(request.cwd)} must be an absolute path`);
    const cwd = canonicalPath(request.cwd);
    if (!directory(cwd)) return refuse(`no directory at ${cwd}`);

    // 1b. A one-shot worktree. The role works at the project root, and this call gives it
    // a writable workspace of its own instead: `<worktreeDir>/<id>` on the mode's branch
    // pattern, under the mode's own git policy or the implicit one where it declares none
    // (design section 1, the `delegate` row). The id is minted here because the directory,
    // the branch and the journal are all named after it. Nothing is created yet: every
    // refusal below still leaves the project as it found it.
    const policy = gitPolicy(options.mode);
    let oneShot: TaskWorktree | undefined;
    if (request.worktree === true) {
      if (declared.workspace.kind !== "root") {
        return refuse(`role ${JSON.stringify(request.role)} already works in a worktree, which this request names; worktree: true is for a role that works at the project root`);
      }
      if (request.resume !== undefined) {
        return refuse(`task ${request.resume} is resumed in the workspace it ran in, so worktree: true would take another`);
      }
      // Not the mode's own lead: it is read-only at the project root because that is what
      // makes `git_root` and `run_command` its way of reaching git at all, and a lead in
      // a worktree of its own could run neither ("The lead model").
      if (engineLeadRole(options.mode) === request.role) {
        return refuse(`role ${JSON.stringify(request.role)} is mode ${options.mode.id}'s engine-placed lead, which works read-only at the project root; worktree: true is for a specialist it delegates`);
      }
      // The flag is what creates this task's branch, so a branch named beside it is
      // either this one, redundantly, or another task's.
      if (request.branch !== undefined) {
        return refuse(`worktree: true creates this task's own branch, so the request names none; ${JSON.stringify(request.branch)} would have to exist already`);
      }
      const slug = newTaskId();
      oneShot = {
        path: canonicalPath(path.join(projectRoot, policy.worktreeDir, slug)),
        branch: policy.branchPattern.replace("*", slug),
        slug,
      };
    }
    // 1c. A resume continues the task it names **where that task ran**. A one-shot's role
    // works at the project root, but the record says which worktree it was given and its
    // spec says what profile it ran under, and a continuation is bound to both (design
    // section 5, layer 4): read them here, before the rules that would otherwise put this
    // launch back at the root under a read-only profile.
    const original = request.resume === undefined ? undefined : records.find((record) => record.id === request.resume);
    const continued = original?.worktree;
    // A chain runs on one model unless a call changes it: `claude --resume` with no
    // `--model` continues on the engine's default, so a continuation that names none
    // takes the record's own rather than silently changing model halfway through.
    const model = request.model ?? binding?.model ?? original?.model ?? null;
    const effort = request.effort ?? binding?.effort ?? original?.effort ?? null;
    let continuedProfile: string | undefined;
    if (continued !== undefined) {
      try {
        continuedProfile = readSpec(projectRoot, original!.id).sandbox.profile;
      } catch {
        // An unreadable spec leaves the binding unprovable, which `resumeFault` names.
      }
    }
    /** Where this task will run: its new worktree, the one it continues in, or the named cwd. */
    const workspace = oneShot?.path ?? continued?.path ?? cwd;

    // The mode's default unless config overrode it, never the request's, because it is the
    // rule the record will be reserved by; an engine override has to be one that declares
    // it. A one-shot runs writable in the worktree it was given, which is what it is for,
    // and a continuation runs under the profile its original was bound to.
    let sandbox: LaunchSpec["sandbox"];
    try {
      const profile = oneShot !== undefined ? writableProfiles[engine]
        : continuedProfile ?? bound?.sandbox ?? declared.sandboxDefault;
      sandbox = sandboxFor(engine, profile);
    } catch (error) {
      return refuse(message(error));
    }
    // The root rule against the **resolved** engine: `bindingFault` above checked the one
    // config binds, and this call may name another whose profile map reads the same name
    // differently. `.cross-agent/` is the server's to write, and no engine starts at the
    // root that could edit it — which neither of these does: both run in a worktree.
    if (oneShot === undefined && continued === undefined && declared.workspace.kind === "root" && sandbox.mode !== "read-only") {
      return refuse(`role ${JSON.stringify(request.role)} works at the project root, which only the server may write; ${JSON.stringify(sandbox.profile)} is ${sandbox.mode} under ${engine}`);
    }

    // 2. Where this role may work. A continuation is held to its original's workspace
    // instead, which the resume binding below compares and the verifier confirms.
    /** The worktree this task will run in, once something has verified it. */
    let verifiedWorktree: VerifiedWorktree | undefined;
    if (continued === undefined) {
      const checked = await workspaceFault(projectRoot, declared.workspace, request.role, cwd, request.branch, repo);
      if ("fault" in checked) return refuse(checked.fault);
      verifiedWorktree = checked.verified;
    }

    // 3. The workspace reservation, and the records nobody can read (design section 2, E2).
    const known = reservations(projectRoot);
    const holder = reservedBy(projectRoot, workspace, known);
    if (holder !== null) return refuse(`${workspace} is reserved by task ${holder.id} (${holder.status}); wait or cancel first`);
    if (sandbox.mode !== "read-only" && known.unknown.length > 0) {
      const files = known.unknown.map((entry) => `${entry.file} (${entry.reason})`).join(", ");
      return refuse(`no workspace can be cleared while a task record cannot be read: ${files}; repair or remove it first`);
    }

    // 4. The loop guard: lineage, duplicates, and the resume binding.
    const repeat = lineageRefusal(lineage, request.role, workspace);
    if (repeat !== null) return { ok: false, reason: repeat };
    let resumeSessionId: string | undefined;
    let parentTaskId = caller;
    if (request.resume === undefined) {
      const duplicate = duplicateRefusal({
        role: request.role, cwd: workspace, brief: request.brief, force: request.force,
        ...(oneShot === undefined ? {} : { worktree: true }),
      }, records, now, config.limits.duplicateWindowMinutes);
      if (duplicate !== null) return { ok: false, reason: duplicate };
    } else {
      // A lead continues its own tasks and no others: a resume launches an engine in the
      // original's workspace, and a task another lead's cascade could not reach is exactly
      // the engine this refusal exists to prevent.
      if (caller !== undefined && !ownedBy(records, caller, request.resume)) {
        return refuse(`lead task ${caller} did not delegate task ${request.resume}`);
      }
      const chain = resumeFault(projectRoot, records, request.resume, {
        role: request.role, engine, cwd: workspace, sandbox: sandbox.profile as SandboxProfile,
      });
      if (chain !== null) return { ok: false, reason: chain };
      // The worktree the original ran in has to still be that worktree: a lead that has
      // already merged and cleaned up is told so by name rather than handed a fresh one.
      if (continued !== undefined) {
        const verified = await verifyWorktree(projectRoot, continued.path, continued.branch, repo);
        if ("reason" in verified) {
          return refuse(`task ${request.resume} ran in ${continued.path} on ${continued.branch}, which is no longer a worktree of this project: ${verified.reason}`);
        }
        verifiedWorktree = verified;
      }
      resumeSessionId = original!.sessionId!;
      // Preserved across resume (the lead model, item 2): the continuation belongs to
      // whoever the original belonged to, not to whoever asked for it.
      parentTaskId = original!.parentTaskId ?? undefined;
    }

    // 4b. A resumed lead is told what its chain asked and what the operator answered: its
    // engine session may have died waiting on a question, and the brief is the one way an
    // answer reaches the continuation (design, "The lead model", item 3). The record still
    // hashes the caller's own text below, because the duplicate window keys on it.
    // An ask that cannot be read may be this chain's, and its answer with it: a brief that
    // left it out would tell the continuation part of what it asked as the whole of it.
    let brief = request.brief;
    if (lead !== undefined && request.resume !== undefined) {
      let found: ReturnType<typeof lineageAsks>;
      try {
        found = lineageAsks(projectRoot, lineageIds(records, request.resume));
      } catch (error) {
        return refuse(`the asks of task ${request.resume} cannot be read: ${message(error)}`);
      }
      if (found.unreadable.length > 0) {
        return refuse(`the asks of task ${request.resume} cannot all be read, and the lead that continues it would not be told what its chain asked: ${found.unreadable.map((entry) => entry.reason).join("; ")} — repair or remove ${found.unreadable.length === 1 ? "that file" : "those files"}, then resume`);
      }
      brief += asksSection(found.asks);
    }

    // 5. Nothing exists yet, and the checks above were only true while this lock held them
    // true, so a lock already lost is a launch that must not happen (design section 2).
    if (claim.lost) return refuse("spawn.lock was lost before the record was written; nothing was launched");

    // 6. The worktree a one-shot was promised, created the way every other root git verb
    // is — through `git_root`, which holds it to this mode's policy and journals the
    // `worktree-created` step under the task's own slug (design section 4). Its refusal is
    // this delegation's, and a refusal here has still written no record.
    if (oneShot !== undefined) {
      const created = await gitRoot(projectRoot, {
        args: ["worktree", "add", "-b", oneShot.branch, oneShot.path, config.project.defaultBranch],
        slug: oneShot.slug,
      }, { waitSeconds, dir: policy.worktreeDir, branchPattern: policy.branchPattern });
      // A refusal here may still have created the worktree: `git_root` answers `ok: false`
      // for a `worktree add` whose journal step could not be written, and that command
      // has run. So every failure from here to the runner discards what exists.
      if (!created.ok) {
        return refuse(`${created.reason}${printed(created.stderr)}${baseHint(created, config, projectRoot)}${await discardWorktree(projectRoot, oneShot)}`);
      }
      // What a worktree role's own delegation is held to, applied to the one just made:
      // the record is about to say a writable engine runs there.
      const verified = await verifyWorktree(projectRoot, oneShot.path, oneShot.branch, repo);
      if ("reason" in verified) {
        return refuse(`the worktree for this task does not verify: ${verified.reason}${await discardWorktree(projectRoot, oneShot)}`);
      }
      verifiedWorktree = verified;
    }

    // 7. The record, its spec, and the runner that owns the engine from here on. A throw
    // in any of the three is a task that will never run, so it leaves nothing standing
    // either: the worktree, its branch and its journal go with it.
    let record: TaskRecord;
    let spec: LaunchSpec;
    try {
      record = create(projectRoot, {
        role: request.role, brief: request.brief, cwd: workspace, engine, model, effort, depth,
        ...(oneShot === undefined ? {} : { id: oneShot.slug, worktree: oneShot }),
        ...(lead === undefined ? {} : { id: lead.id }),
        ...(continued === undefined ? {} : { worktree: continued }),
        ...(parentTaskId === undefined ? {} : { parentTaskId }),
        ...(request.resume === undefined ? {} : { resumedFrom: request.resume }),
      }, now);
      // The task's own directory, which nothing else shares: an adapter writes a role file
      // and a lead's mount config here, never into a workspace the role may edit.
      const scratchDir = path.join(path.dirname(record.logPath), `${record.id}.scratch`);
      fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
      // The prompt config binds, else the mode's own text for the role — its
      // `roles/<key>.md`, or the text a built-in role carries — which is the same string
      // `describe_mode` serves (design section 8, `src/modes.ts#rolePrompt`). An
      // engine-placed lead's runs behind the loop it runs, composed once, here.
      const roleHalf = bound?.prompt ?? rolePrompt(options.mode, declared);
      spec = {
        role: request.role, brief,
        rolePrompt: lead === undefined ? roleHalf : leadPrompt(lead.loop, roleHalf),
        ...(lead === undefined ? {} : { lead: lead.mount }),
        cwd: workspace, engine, sandbox,
        ...(model === null ? {} : { model }),
        ...(effort === null ? {} : { effort }),
        sessionId: randomUUID(),
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        denyTargets: denyTargets(config, repositoryRoot),
        // The git metadata of a worktree workspace, which a sandbox has to refuse however
        // its engine names the rule and whatever profile runs there: the pointer file the
        // specialist could redirect and the repository's own git directory every worktree
        // shares (probe P2, Claude). A root workspace has no worktree of its own to
        // protect, and its own read-only rule is the adapter's.
        ...(verifiedWorktree === undefined ? {} : {
          protectedPaths: [path.join(verifiedWorktree.workTree, ".git"), verifiedWorktree.commonDir],
        }),
        env: {
          ...childEnv(env, options.authority.depth, record.id, childLineage(lineage, {
            taskId: record.id, role: request.role, cwd: workspace,
          }), config.billing, projectRoot),
          // The one way a configured binary reaches both the adapter's capability check
          // and its spawn line, which read the same environment (design section 3).
          ...binEnvironment(config, engine),
        },
        scratchDir,
        adapterModule: fileURLToPath(new URL(`./engines/${engine}.ts`, import.meta.url)),
      };
      writeSpec(projectRoot, record.id, spec);
    } catch (error) {
      if (oneShot !== undefined) await discardWorktree(projectRoot, oneShot);
      throw error;
    }
    startRunner(projectRoot, record.id, env);
    return { ok: true, taskId: record.id };
  } finally {
    await claim.release();
  }
}

/** What git printed, when it printed anything: the line a lead needs to act on. */
function printed(stderr?: string): string {
  const text = stderr?.trim();
  return text === undefined || text === "" ? "" : `: ${text}`;
}

/**
 * The one refusal a project is likely to meet before it has a config: a one-shot branches
 * from `project.defaultBranch`, whose documented default is `main`, and a repository whose
 * own default branch is called something else fails inside git with nothing to act on.
 */
function baseHint(failure: { stderr?: string }, config: CrossAgentConfig, projectRoot: string): string {
  const base = config.project.defaultBranch;
  if (failure.stderr === undefined || !failure.stderr.includes(base)) return "";
  const configured = fs.statSync(path.join(projectRoot, CONFIG_PATH), { throwIfNoEntry: false })?.isFile() ?? false;
  return `. A one-shot branches from project.defaultBranch, which is ${JSON.stringify(base)} here; `
    + (configured ? `set another in ${CONFIG_PATH}` : `this project has no ${CONFIG_PATH}, so run "cross-agent init --mode ${config.mode}" and set project.defaultBranch`)
    + " if that is not this repository's default branch";
}

/**
 * Everything a one-shot that never launched would otherwise leave standing: its worktree,
 * its branch and its journal. It runs inside the `spawn.lock` this delegation already
 * holds, so it uses the explicit git form directly rather than `git_root worktree remove`,
 * which takes that same lock; `--force` is right here and nowhere else, because the only
 * thing in that worktree is what git has just put there and no task ever ran in it.
 * Reconciliation does not clean up worktrees, so a leftover here is a leftover for good.
 * It is best effort by construction — the failure it follows may be the reason a step of
 * it cannot run — and what it could not remove is named in the refusal.
 */
async function discardWorktree(projectRoot: string, worktree: TaskWorktree): Promise<string> {
  const located = await locateRepository(projectRoot);
  if (!("reason" in located)) {
    for (const args of [["worktree", "remove", "--force", worktree.path], ["branch", "-D", worktree.branch]]) {
      try {
        await run(located.gitDir, located.workTree, args);
      } catch {
        // A git that could not run leaves what it was asked to remove; named below.
      }
    }
  }
  try {
    removeJournal(projectRoot, worktree.slug);
  } catch {
    // Named below with the worktree it belongs to.
  }
  return directory(worktree.path)
    ? `. ${worktree.path} on ${worktree.branch} could not be removed and is still there`
    : "";
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
