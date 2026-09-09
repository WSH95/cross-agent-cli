import fs from "node:fs";
import path from "node:path";
import { isTerminal, readSpec, scan } from "./ledger.ts";
import type { InvalidRecord, TaskRecord } from "./ledger.ts";

export interface Reservations {
  /** Canonical cwd to the unsettled writable task that holds it. */
  reserved: Map<string, TaskRecord>;
  /**
   * `scan()`'s invalid records, verbatim. Each one is an **unknown-active** task: its cwd
   * cannot be read, so it can never be shown to have freed a workspace, and a caller that
   * is about to let something write must refuse while this is non-empty (design section 2,
   * A4-a and E2), naming the files for the operator to repair or remove.
   */
  unknown: InvalidRecord[];
}

/**
 * The path a reservation is keyed by. A removed worktree still holds its reservation, so
 * the closest existing ancestor is canonicalized and the rest is kept as it was written:
 * a path that cannot be resolved must still compare equal to itself.
 */
function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  const missing: string[] = [];
  let head = resolved;
  while (true) {
    try {
      return path.join(fs.realpathSync(head), ...missing);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return resolved;
      missing.unshift(path.basename(head));
      head = parent;
    }
  }
}

// The record carries no sandbox; the launch spec beside it does (design section 2). Only a
// mode of `read-only` frees the workspace: `write` may write inside it, and `off` is the
// least constrained task there is and may write anywhere. A spec that cannot be read, or
// whose sandbox this build cannot read as a `{mode, profile}` pair, leaves the task's mode
// unknown — and an unknown mode has never been shown to be read-only, so it holds the
// workspace rather than silently letting a second writer in.
function reservesWorkspace(projectRoot: string, record: TaskRecord): boolean {
  let sandbox: unknown;
  try {
    sandbox = readSpec(projectRoot, record.id).sandbox;
  } catch {
    return true;
  }
  const mode = sandbox !== null && typeof sandbox === "object" ? (sandbox as { mode?: unknown }).mode : undefined;
  return mode !== "read-only";
}

/** Every workspace an unsettled writable task holds, and every record that cannot be read. */
export function reservations(projectRoot: string): Reservations {
  const { records, invalid } = scan(projectRoot);
  const reserved = new Map<string, TaskRecord>();
  for (const record of records) {
    if (isTerminal(record.status)) continue;
    if (!reservesWorkspace(projectRoot, record)) continue;
    const key = canonicalPath(record.cwd);
    const held = reserved.get(key);
    // Two writable tasks on one path is what the reservation check prevents; if one is
    // ever seen, the task that took the path first is the one that holds it, so the
    // answer does not depend on the order the directory happened to list.
    const earlier = held === undefined || record.createdAt < held.createdAt
      || (record.createdAt === held.createdAt && record.id < held.id);
    if (earlier) reserved.set(key, record);
  }
  return { reserved, unknown: invalid };
}

/**
 * The task holding `target`, or null. `known` lets a caller that already scanned — one
 * deciding on `unknown` in the same breath — answer both questions from one scan.
 */
export function reservedBy(projectRoot: string, target: string, known: Reservations = reservations(projectRoot)): TaskRecord | null {
  return known.reserved.get(canonicalPath(target)) ?? null;
}
