import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSeated } from "./config.ts";
import type { CrossAgentConfig } from "./config.ts";
import { isTerminal, scan, writeAtomic } from "./ledger.ts";
import type { ProcessIdentity, TaskRecord } from "./ledger.ts";
import { groupAlive } from "./process.ts";
import { canonicalPath } from "./reservation.ts";

// The merge's review guard (design section 4): the verdict a review's result file ends on,
// the head a gating review covered, the hold that freezes a worktree under review, and the
// marker a running setup command leaves on its worktree. Everything here reads what the
// server itself wrote — the ledger, the result files, the markers — and never a lead's
// account of them.

/** The four lines a code review ends on (`modes/dev-team/roles/code-reviewer.md`). */
export const verdicts = ["no major issues", "major issues", "needs rebase", "discard"] as const;
export type Verdict = typeof verdicts[number];

/**
 * The verdict a review's result file ends on: its last non-empty line, exactly `VERDICT:
 * <value>` once its surrounding whitespace is set aside, else null. A verdict anywhere
 * else in the text is no verdict: a reviewer quoting the line is not ending on it.
 */
export function verdictOf(text: string): Verdict | null {
  const last = text.split("\n").map((line) => line.trim()).filter((line) => line !== "").at(-1);
  if (last === undefined || !last.startsWith("VERDICT: ")) return null;
  const value = last.slice("VERDICT: ".length);
  return (verdicts as readonly string[]).includes(value) ? value as Verdict : null;
}

/** The gating role's seats, as the config binds them: [undefined] for an object or no binding, [1..N] for a list. */
export function gatingSeats(config: CrossAgentConfig, role: string): Array<number | undefined> {
  const binding = Object.hasOwn(config.roles, role) ? config.roles[role] : undefined;
  return isSeated(binding) ? binding.map((_, index) => index + 1) : [undefined];
}

/**
 * Each seat's finished reviews of `head`: the done records of that role and seat whose
 * `underReview` is that commit, each with the verdict its result file ends on. A result
 * file that is not there reads as no verdict; one that cannot be read is a throw, because a
 * review nobody can read may be the one that found the problem.
 */
export function reviewsOf(
  records: readonly TaskRecord[], role: string, seat: number | undefined, head: string,
): Array<{ record: TaskRecord; verdict: Verdict | null }> {
  return records
    .filter((record) => record.role === role && record.seat === seat && record.underReview === head && record.status === "done")
    .map((record) => {
      let text = "";
      try {
        text = fs.readFileSync(record.resultPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(`the result of review task ${record.id} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { record, verdict: verdictOf(text) };
    });
}

/**
 * Why `workTree` may not be written now, or null: a task delegated to review it for the
 * merge is still active there, and its review is of the head it was delegated at. A
 * read-only task reserves nothing (`src/reservation.ts#reservesWorkspace`), so this hold
 * is its own rule. `workTree` is canonical.
 */
export function reviewHold(projectRoot: string, workTree: string): string | null {
  const record = scan(projectRoot).records.find((each) =>
    each.underReview !== undefined && !isTerminal(each.status) && canonicalPath(each.cwd) === workTree);
  return record === undefined ? null
    : `${workTree} is under review by task ${record.id} (${record.status}) at ${record.underReview}; wait or cancel first`;
}

/** Where the marker of a setup running in `workTree` is kept: one file per canonical worktree. */
export function setupMarkerPath(projectRoot: string, workTree: string): string {
  const name = createHash("sha256").update(workTree).digest("hex").slice(0, 32);
  return path.join(path.resolve(projectRoot, ".cross-agent", "setups"), `${name}.json`);
}

/**
 * Writes the marker for a setup that has just started in `workTree`, atomically: the
 * identity of the detached command, which leads its own process group, so the marker
 * holds for as long as anything that command started lives, whatever becomes of the
 * server that started it.
 */
export function markSetup(projectRoot: string, workTree: string, slug: string, identity: ProcessIdentity): string {
  const file = setupMarkerPath(projectRoot, workTree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, {
    pid: identity.pid, startTime: identity.startTime, bootId: identity.bootId, pgid: identity.pid,
    workTree, slug, at: Date.now(),
  });
  return file;
}

/**
 * Removes a marker; a marker already gone is removed. Given the pid of the setup that
 * wrote it, a marker naming another process is left alone: once this setup's group is gone
 * another setup may have marked the worktree for itself.
 */
export function clearSetup(projectRoot: string, workTree: string, pid?: number): void {
  const file = setupMarkerPath(projectRoot, workTree);
  if (pid !== undefined) {
    try {
      if ((JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown }).pid !== pid) return;
    } catch {
      return;
    }
  }
  fs.rmSync(file, { force: true });
}

/**
 * Why `workTree` is held by a running setup, or null: a marker whose group `groupAlive`
 * finds alive is the hold, one whose group is gone is cleared and holds nothing, and one
 * that cannot be read is named and holds.
 */
export function setupRunning(projectRoot: string, workTree: string): string | null {
  const file = setupMarkerPath(projectRoot, workTree);
  let marker: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
    marker = parsed as Record<string, unknown>;
    if (!Number.isInteger(marker.pid) || !Number.isInteger(marker.pgid) || typeof marker.startTime !== "string"
      || typeof marker.bootId !== "string") {
      throw new Error("it names no process group");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return `the setup marker ${file} cannot be read (${error instanceof Error ? error.message : String(error)}), so a setup command may be running in ${workTree}; remove the file once none is`;
  }
  const identity = { pid: marker.pid as number, startTime: marker.startTime as string, bootId: marker.bootId as string, pgid: marker.pgid as number };
  if (!groupAlive(identity)) {
    fs.rmSync(file, { force: true });
    return null;
  }
  return `the setup command of task ${String(marker.slug)} is running in ${workTree} (process group ${identity.pgid}); wait for it, or end that group`;
}
