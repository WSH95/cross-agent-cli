import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSeated } from "./config.ts";
import type { CrossAgentConfig } from "./config.ts";
import { revision } from "./gitmutate.ts";
import { appendStep, readJournal } from "./journal.ts";
import type { Journal, JournalEntry } from "./journal.ts";
import { isTerminal, projectLock, scan, writeAtomic } from "./ledger.ts";
import type { ProcessIdentity, TaskRecord } from "./ledger.ts";
import { gitLockName, spawnLockName } from "./locks.ts";
import type { Lock } from "./locks.ts";
import { groupAlive } from "./process.ts";
import { canonicalPath } from "./reservation.ts";
import { locateRepository } from "./worktree.ts";

// The merge's review guard (design section 4): the verdict a review's result file ends on,
// the head a gating review covered, the hold that freezes a worktree under review, the
// marker a running setup command leaves on its worktree, the guard itself, and the waiver
// that stands in for it. Everything here reads what the server itself wrote — the ledger,
// the result files, the journal, the markers — and never a lead's account of them.

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
 * Writes the marker under the caller's `spawn.lock`, atomically: the
 * identity of the detached command, which leads its own process group, so the marker
 * holds until its group is gone, whatever becomes of the server that started it. A
 * descendant that starts its own session leaves the group, and no marker can follow it.
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
 * Clears this setup's marker only after its group is gone, under `spawn.lock`: checking
 * the full identity and removing the file are one operation against a successor's write.
 * If the lock cannot be had, the marker stays for the next setupRunning reader to clear.
 */
export async function clearSetup(
  projectRoot: string, workTree: string, identity: ProcessIdentity, options: { waitSeconds: number },
): Promise<void> {
  if (!identity) return;
  let lock: Lock;
  try {
    lock = await projectLock(projectRoot, spawnLockName(), { waitSeconds: options.waitSeconds, operation: "clear setup marker" });
  } catch {
    return;
  }
  try {
    const file = setupMarkerPath(projectRoot, workTree);
    try {
      const marker = JSON.parse(fs.readFileSync(file, "utf8"));
      if (marker.pid !== identity.pid || marker.startTime !== identity.startTime || marker.bootId !== identity.bootId
        || marker.pgid !== identity.pid || groupAlive({ ...identity, pgid: identity.pid })) return;
    } catch {
      return;
    }
    fs.rmSync(file, { force: true });
  } finally {
    await lock.release();
  }
}

/**
 * Why `workTree` is held by a running setup, or null: a marker whose group `groupAlive`
 * finds alive is the hold, one whose group is gone is cleared and holds nothing, and one
 * that cannot be read is named and holds. The caller holds `spawn.lock` through this read
 * and the setup or review it admits.
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

/**
 * Why `branchHead` of the task `slug` may not merge under the review guard, or null (design
 * section 4). A one-shot is held to the suite alone: its record is the one `delegate
 * {worktree: true}` writes, whose id is the slug and whose worktree names the journal's
 * branch, and nothing else writes such a record. A `review-waived` step at that head stands
 * in for the reviews. Otherwise each seat of `role`, as config binds it now, needs a done
 * review delegated at that head whose result ends `VERDICT: no major issues`, and none
 * ending on another verdict: a review with no VERDICT line neither counts nor blocks, so a
 * seat retried after an invalid review can pass, and one re-run until it says yes cannot.
 */
export function reviewFault(
  projectRoot: string, config: CrossAgentConfig, role: string, slug: string, journal: Journal, branchHead: string,
): string | null {
  const { records } = scan(projectRoot);
  if (records.some((record) => record.id === slug && record.worktree?.slug === slug && record.worktree.branch === journal.branch)) return null;
  if (journal.steps.some((step) => step.step === "review-waived" && step.after === branchHead)) return null;
  const failures: string[] = [];
  for (const seat of gatingSeats(config, role)) {
    const name = seat === undefined ? role : `${role}#${seat}`;
    let reviews: ReturnType<typeof reviewsOf>;
    try {
      reviews = reviewsOf(records, role, seat, branchHead);
    } catch (error) {
      failures.push(`${name}: ${message(error)}`);
      continue;
    }
    const adverse = reviews.filter((review) => review.verdict !== null && review.verdict !== "no major issues");
    if (adverse.length > 0) {
      failures.push(...adverse.map((review) => `${name} ended VERDICT: ${review.verdict} (task ${review.record.id})`));
    } else if (!reviews.some((review) => review.verdict === "no major issues")) {
      failures.push(reviews.length === 0 ? `${name} has no finished review of that commit`
        : `${name} has no finished review of that commit ending on a VERDICT line (task ${reviews.map((review) => review.record.id).join(", ")} ended on none)`);
    }
  }
  if (failures.length === 0) return null;
  return `git_root refuses to merge ${journal.branch} at ${branchHead}: ${failures.join("; ")}; record the user's waiver with waive_review or cross-agent waive ${slug} ${branchHead}, or review again`;
}

export interface WaiveRequest {
  slug: string;
  /** The branch head the waiver names: the commit, or an abbreviation of it of 7 characters or more. */
  commit: string;
  /** Who records it: `["operator", "cli"]`, `["operator", "tool"]` or `["lead", <task id>]`, journaled as the step's `args`. */
  by: string[];
}

export interface WaiveOptions {
  waitSeconds: number;
  /** For the lead row: the config it is held to, and the mode's role that gates the merge. */
  lead?: { config: CrossAgentConfig; role: string };
  now?: number;
}

export type WaiveResult = { ok: true; journal: JournalEntry } | { ok: false; reason: string };

/** Why `journal` takes no waiver: none to name, or a task its merge or its branch's deletion closed. */
function journalFault(slug: string, journal: Journal | null): string | null {
  if (journal === null) return `slug ${slug} has no journal; there is no task whose review to waive`;
  const closing = (["merged", "branch-deleted"] as const).filter((name) => journal.steps.some((step) => step.step === name));
  return closing.length === 0 ? null
    : `journal ${slug} is closed by its ${closing.join(" and ")} step${closing.length > 1 ? "s" : ""}; a waiver is for a branch still to merge`;
}

/**
 * Records the waiver of the review guard for the branch head of `slug`, as a
 * `review-waived` step (design section 4). The request's shape and the journal are judged
 * first, needing no lock; then, under `git.lock` — which `git_mutate` holds for a command
 * and its step, so no commit lands between — the journal is read again and the branch head
 * resolved, and the waiver names that head or is refused. The lead row records one only
 * under `review.afterResolver: "lead-decides"`, once every seat has finished its review of
 * that head, whatever the verdicts; every other waiver is the operator's.
 */
export async function waiveReview(projectRoot: string, request: WaiveRequest, options: WaiveOptions): Promise<WaiveResult> {
  const { slug, commit, by } = request;
  if (typeof commit !== "string" || !/^[0-9a-f]{7,}$/.test(commit)) {
    return { ok: false, reason: `a waiver names the branch head by its commit, hex of at least 7 characters, not ${JSON.stringify(commit)}` };
  }
  let journal: Journal | null;
  try {
    journal = readJournal(projectRoot, slug);
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  const early = journalFault(slug, journal);
  if (early !== null) return { ok: false, reason: early };
  const located = await locateRepository(projectRoot);
  if ("reason" in located) return { ok: false, reason: located.reason };

  let lock: Lock;
  try {
    lock = await projectLock(projectRoot, gitLockName(), { waitSeconds: options.waitSeconds, operation: `waive_review ${slug}` });
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  try {
    journal = readJournal(projectRoot, slug);
    const fault = journalFault(slug, journal);
    if (fault !== null) return { ok: false, reason: fault };
    const branch = journal!.branch;
    const head = await revision(located.gitDir, located.workTree, branch);
    if (head === undefined) return { ok: false, reason: `the branch ${branch} of slug ${slug} does not exist, so there is no head to waive the review of` };
    if (!head.startsWith(commit)) {
      return { ok: false, reason: `the branch ${branch} is at ${head}, which ${commit} does not name; a waiver names the branch head as it stands` };
    }
    if (by[0] === "lead") {
      const lead = options.lead;
      const complete = lead !== undefined && lead.config.review.afterResolver === "lead-decides"
        && gatingSeats(lead.config, lead.role).every((seat) => reviewsOf(scan(projectRoot).records, lead.role, seat, head).length > 0);
      if (!complete) {
        return { ok: false, reason: `waive_review is the operator's unless review.afterResolver is lead-decides and every seat has finished its review of ${head}` };
      }
    }
    const defaultSha = await revision(located.gitDir, located.workTree, journal!.defaultBranch);
    const appended = appendStep(projectRoot, slug, "review-waived", {
      at: options.now ?? Date.now(), before: head, after: head, ...(defaultSha === undefined ? {} : { defaultSha }), args: by,
    });
    return { ok: true, journal: appended.steps[appended.steps.length - 1] };
  } catch (error) {
    return { ok: false, reason: message(error) };
  } finally {
    await lock.release();
  }
}
