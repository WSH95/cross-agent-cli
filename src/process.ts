import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { list, read, readProcessStat, update } from "./ledger.ts";
import type { EngineIdentity, ProcessIdentity, TaskRecord } from "./ledger.ts";

export function identityOf(pid: number): ProcessIdentity | null {
  const stat = readProcessStat(pid);
  return stat && /^\d+$/.test(stat.startTime) ? { pid, startTime: stat.startTime } : null;
}

// Keep identity-checked witnesses before signalling: the leader can be reaped while
// descendants remain. A bare pgid after losing that proof is unsafe to signal.
const witnesses = new Map<string, ProcessIdentity[]>();
const alive = (state: string) => state !== "Z" && state !== "X";

export function groupAlive(identity?: EngineIdentity | null): boolean {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 1
    || !Number.isInteger(identity.pgid) || identity.pgid <= 1 || !/^\d+$/.test(identity.startTime)) return false;
  const key = `${identity.pid}:${identity.startTime}:${identity.pgid}`;
  const leader = readProcessStat(identity.pid);
  if (leader && (leader.startTime !== identity.startTime || leader.pgid !== identity.pgid)) return false;
  if (!leader && !(witnesses.get(key) ?? []).some((member) => {
    const stat = readProcessStat(member.pid);
    return stat?.startTime === member.startTime && stat.pgid === identity.pgid;
  })) {
    witnesses.delete(key);
    return false;
  }
  const members: ProcessIdentity[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const stat = readProcessStat(pid);
    if (stat?.pgid === identity.pgid && alive(stat.state)) members.push({ pid, startTime: stat.startTime });
  }
  if (members.length === 0) witnesses.delete(key);
  else witnesses.set(key, members);
  return members.length > 0;
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

export async function terminateOrphans(projectRoot: string): Promise<TaskRecord[]> {
  const changed: TaskRecord[] = [];
  for (const record of list(projectRoot, "orphaned")) {
    const identity = record.engineIdentity;
    if (read(projectRoot, record.id).status !== "orphaned" || !identity || !groupAlive(identity)) continue;
    killGroup(identity, "SIGTERM");
    if (!await waitForGroup(identity, 2000)) {
      killGroup(identity, "SIGKILL");
      if (!await waitForGroup(identity, 500)) throw new Error(`engine group ${identity.pgid} did not terminate`);
    }
    if (read(projectRoot, record.id).status !== "orphaned") continue;
    try {
      changed.push(update(projectRoot, record.id, { status: "failed", reason: "runner lost" }));
    } catch (error) {
      if (!["done", "failed", "cancelled"].includes(read(projectRoot, record.id).status)) throw error;
    }
  }
  return changed;
}
