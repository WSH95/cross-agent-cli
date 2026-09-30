import fs from "node:fs";
import { readDepth } from "./guard.ts";
import { currentBootId, readProcessStat, scan } from "./ledger.ts";
import type { TaskRecord, TaskStatus } from "./ledger.ts";

// Design, "The lead model": a server's authority is who spawned it, never a token it
// could have copied. The walk climbs from this process towards the root, and the
// nearest ancestor holding an engine identity the ledger wrote decides the row. The
// server resolves again on every request, so nothing here is cached.

export type Row = "operator" | "lead" | "specialist";

export interface Authority {
  row: Row;
  /** The evidence the row rests on, in words a refusal can quote. */
  reason: string;
  /** The task whose record decided the row, when one did. */
  taskId?: string;
  /** `CROSS_AGENT_DEPTH` as `readDepth` reads it, Infinity when it cannot be trusted. */
  depth: number;
}

export interface AuthorityOptions {
  /** The active mode's lead role. Without one, no ancestor grants the lead row. */
  leadRole?: string;
  maxDepth: number;
}

/**
 * Enough for a host nested inside another session — nine hops or more below its own
 * terminal on the machine T13 measured — and any wrapper an engine puts between itself
 * and a server it starts. Past it the walk fails closed, as it does on every other
 * failure (the user's decision of 2026-09-30).
 */
const maxHops = 32;
const authoritative = new Set<TaskStatus>(["running", "stalled"]);
const markers = ["CROSS_AGENT_TASK", "CROSS_AGENT_DEPTH", "CROSS_AGENT_LINEAGE"] as const;

/** The nearest task id this server was seen to carry, and where. */
interface Carried {
  task: string;
  source: string;
}

type Decision = Omit<Authority, "depth">;
type Walk = { decided: Decision } | { carried?: Carried; failure?: string };

function statOf(pid: number): { ppid: number; startTime: string } | string {
  let stat: ReturnType<typeof readProcessStat>;
  try {
    stat = readProcessStat(pid);
  } catch (error) {
    return `cannot read /proc/${pid}/stat: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (stat === null) return `cannot read /proc/${pid}/stat: no such process`;
  // Both fields the walk goes on to use, checked where the file was read: a malformed line
  // yields a NaN ppid, and the failure has to name the pid whose stat it was.
  if (!/^\d+$/.test(stat.startTime ?? "") || !Number.isInteger(stat.ppid) || stat.ppid < 0) {
    return `cannot read /proc/${pid}/stat: malformed`;
  }
  return stat;
}

// Another user's process, a non-dumpable one of this user's, or one that has just exited:
// whatever the reason, an environment that cannot be read is evidence of nothing.
function environOf(pid: number): string[] | null {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  } catch {
    return null;
  }
}

function tasksIn(environ: string[] | null): string[] {
  const prefix = "CROSS_AGENT_TASK=";
  return (environ ?? []).filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
}

// The ancestor holds an engine identity the ledger wrote, so it is an engine and the walk
// ends here whatever it finds: going on past an engine whose record grants nothing would
// hand its server the row of whatever lead stands above it.
function decide(pid: number, claimants: TaskRecord[], environ: string[] | null, carried: Carried | undefined, leadRole?: string): Decision {
  const tasks = tasksIn(environ);
  const named = claimants.filter((record) => tasks.includes(record.id));
  if (named.length !== 1) {
    const seen = environ === null ? "cannot be read" : tasks.length === 0 ? "names no task" : `names task ${tasks.join(", ")}`;
    return {
      row: "specialist",
      reason: `specialist: ancestor ${pid} holds the engine identity of task ${claimants.map((record) => record.id).join(", ")}, but its environment ${seen}`,
    };
  }
  const [record] = named;
  const lead = authoritative.has(record.status) && leadRole !== undefined && record.role === leadRole;
  // A process nearer than this engine carries another task — a specialist engine its
  // runner has not yet acknowledged, say — so this server is that task's, not the lead's.
  if (lead && carried !== undefined && carried.task !== record.id) {
    return {
      row: "specialist",
      reason: `specialist: ${carried.source} carries CROSS_AGENT_TASK=${carried.task}, but the nearest engine ancestor ${pid} is task ${record.id}'s`,
    };
  }
  const row = lead ? "lead" : "specialist";
  return { row, reason: `${row} by ancestry: task ${record.id} (${record.role}, ${record.status})`, taskId: record.id };
}

function walk(records: TaskRecord[], env: Readonly<NodeJS.ProcessEnv>, leadRole?: string): Walk {
  // An engine CLI may start its servers in a fresh environment rather than a copy of its
  // own, so the task a server belongs to is also read off its ancestors.
  let carried: Carried | undefined = env.CROSS_AGENT_TASK === undefined ? undefined : { task: env.CROSS_AGENT_TASK, source: "this server" };
  const own = statOf(process.pid);
  if (typeof own === "string") return { carried, failure: own };
  let child = { pid: process.pid, stat: own };
  const seen = new Set([process.pid]);
  for (let hops = 0; child.stat.ppid !== 0; hops++) {
    if (hops === maxHops) return { carried, failure: `the walk found neither an engine nor the root within ${maxHops} hops` };
    const pid = child.stat.ppid;
    if (seen.has(pid)) return { carried, failure: `the walk met ancestor ${pid} twice` };
    seen.add(pid);
    const stat = statOf(pid);
    if (typeof stat === "string") return { carried, failure: stat };
    // A parent is older than its child unless the chain was reparented while it was read,
    // and then this ancestor is not the one that started the process below it.
    if (BigInt(stat.startTime) > BigInt(child.stat.startTime)) {
      return { carried, failure: `ancestor ${pid} started after its child ${child.pid}, so the chain was reparented` };
    }
    const environ = environOf(pid);
    const claimants = records.filter(({ engineIdentity: identity }) =>
      identity?.pid === pid && identity.startTime === stat.startTime && identity.bootId === currentBootId);
    if (claimants.length > 0) return { decided: decide(pid, claimants, environ, carried, leadRole) };
    const task = tasksIn(environ)[0];
    if (carried === undefined && task !== undefined) carried = { task, source: `ancestor ${pid}` };
    child = { pid, stat };
  }
  return { carried };
}

// No engine ancestor decided, so this server is the operator's only if nothing says
// otherwise: not its own environment, not an ancestor's, and not a walk that stopped short.
function unmatched(found: { carried?: Carried; failure?: string }, env: Readonly<NodeJS.ProcessEnv>, distrusted?: string): Decision {
  if (distrusted !== undefined) return { row: "specialist", reason: `specialist: ${distrusted}` };
  const present = markers.find((name) => env[name] !== undefined);
  if (present !== undefined) return { row: "specialist", reason: `specialist: ${present} present and no record matches` };
  if (found.carried !== undefined) {
    return { row: "specialist", reason: `specialist: ${found.carried.source} carries CROSS_AGENT_TASK=${found.carried.task} and no record matches` };
  }
  if (found.failure !== undefined) return { row: "specialist", reason: `specialist: ${found.failure}` };
  return { row: "operator", reason: "operator: no CROSS_AGENT_* variable and no engine ancestor" };
}

/**
 * The row of the permission matrix this process may serve for the project at
 * `projectRoot`. Ancestry decides; depth only caps. Operator provenance is positive: it
 * takes a clean environment and a walk that reached the root without meeting an engine
 * or a process carrying a task, and anything short of that is a specialist.
 */
export function resolveAuthority(projectRoot: string, env: Readonly<NodeJS.ProcessEnv>, options: AuthorityOptions): Authority {
  const { depth, reason: distrusted } = readDepth(env);
  const found = walk(scan(projectRoot).records, env, options.leadRole);
  const decision = "decided" in found ? found.decided : unmatched(found, env, distrusted);
  if (decision.row === "specialist") return { ...decision, depth };
  // Depth is a cap, not a second opinion: it can only lower what ancestry decided, and a
  // depth that cannot be trusted is Infinity, which lowers everything.
  if (depth >= options.maxDepth) {
    return { ...decision, row: "specialist", reason: `specialist: ${distrusted ?? `depth ${depth} >= maxDepth ${options.maxDepth}`}`, depth };
  }
  return { ...decision, depth };
}
