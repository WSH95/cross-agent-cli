import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { currentBootId, list, readProcessStat, update } from "./ledger.ts";
import type { EngineIdentity, ProcessIdentity, TaskRecord } from "./ledger.ts";

export function identityOf(pid: number): ProcessIdentity | null {
  const stat = readProcessStat(pid);
  return stat && /^\d+$/.test(stat.startTime) ? { pid, startTime: stat.startTime, bootId: currentBootId } : null;
}

const live = (state: string) => state !== "Z" && state !== "X";

// X is the engine leader's pid. A detached spawn made X the leader of both process
// group X and session X, and a descendant can hold pgid X only inside session X, so a
// member is any live process with pgid X and sid X. The kernel keeps X reserved while
// any process holds it as pgid or sid, so no earlier scan needs remembering.
//
// Guarantee: while any original member lives, the scan finds all of them and nothing
// foreign. Limitation: once the whole group is dead, X can be reallocated at once. A
// live replacement leader is vetoed by its start time, pgid, or sid, but a replacement
// session X whose own leader has exited leaves descendants the scan cannot tell from
// ours and would signal. No timing bound is claimed. Descendants that leave the group
// with setpgid or setsid are not members and are not signalled.
function inspectGroup(identity?: EngineIdentity | null): "invalid" | "reused" | "alive" | "dead" {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 1
    || !Number.isInteger(identity.pgid) || identity.pgid <= 1 || identity.pgid !== identity.pid
    || !/^\d+$/.test(identity.startTime)) return "invalid";
  // A pid, start time and group from an earlier boot can all match a live process by
  // chance, so an identity from another boot is dead rather than reused: its record
  // settles instead of being skipped for as long as that unrelated process lives.
  if (identity.bootId !== currentBootId) return "dead";
  const leader = readProcessStat(identity.pid);
  if (leader && (leader.startTime !== identity.startTime || leader.pgid !== identity.pid || leader.sid !== identity.pid)) {
    return "reused";
  }
  if (leader && live(leader.state)) return "alive";
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readProcessStat(Number(entry));
    if (stat && stat.pgid === identity.pid && stat.sid === identity.pid && live(stat.state)) return "alive";
  }
  return "dead";
}

export function groupAlive(identity?: EngineIdentity | null): boolean {
  return inspectGroup(identity) === "alive";
}

export function killGroup(identity: EngineIdentity, signal: NodeJS.Signals): boolean {
  if (!groupAlive(identity)) return false;
  try {
    process.kill(-identity.pgid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForGroup(identity: EngineIdentity, timeout: number): Promise<boolean> {
  const deadline = performance.now() + timeout;
  while (groupAlive(identity)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(20, remaining));
  }
  return true;
}

// Each call judges every orphaned record on the current kernel state: an invalid or
// reused identity is left alone, a live group is terminated, and a dead group, one
// with no live member, is settled. A stale identity is therefore skipped while its
// pid lives under another identity and settled once that pid is gone, because the
// pid could only be reallocated after the original group had died.
export async function terminateOrphans(projectRoot: string): Promise<TaskRecord[]> {
  const changed: TaskRecord[] = [];
  for (const record of list(projectRoot, "orphaned")) {
    const identity = record.engineIdentity;
    const state = inspectGroup(identity);
    if (!identity || state === "invalid" || state === "reused") continue;
    if (state === "alive") {
      killGroup(identity, "SIGTERM");
      if (!await waitForGroup(identity, 2000)) {
        killGroup(identity, "SIGKILL");
        if (!await waitForGroup(identity, 500)) throw new Error(`engine group ${identity.pgid} did not terminate`);
      }
    }
    // A record settled by another writer since the listing is refused: not changed.
    const result = await update(projectRoot, record.id, { status: "failed", reason: "runner lost" }, Date.now(), { unlessTerminal: true });
    if (result.applied) changed.push(result.record);
  }
  return changed;
}
