import { spawn } from "node:child_process";
import fs from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { loadConfig, repositoryLockWait } from "./config.ts";
import type { CrossAgentConfig } from "./config.ts";
import { revision, run } from "./gitmutate.ts";
import { trackedStateFault } from "./gitroot.ts";
import { childEnv } from "./guard.ts";
import { appendStep, readJournal } from "./journal.ts";
import type { Journal, JournalEntry } from "./journal.ts";
import { projectLock } from "./ledger.ts";
import type { ProcessIdentity } from "./ledger.ts";
import { acquire, gitLockName, repositoryLockPath, spawnLockName } from "./locks.ts";
import type { Lock } from "./locks.ts";
import { identityOf } from "./process.ts";
import { clearSetup, markSetup, reviewHold, setupRunning } from "./review.ts";
import { locateRepository, rootWriteFault, verifyWorktree } from "./worktree.ts";
import type { Repository, VerifiedWorktree } from "./worktree.ts";

export interface RunCommandRequest {
  /** Which configured command to run: a selector, never a command string. */
  which: "test" | "setup";
  /** `"root"` or the path of a worktree to verify. */
  where: string;
  /**
   * The task whose journal this run belongs to: required for a worktree, where it names
   * the branch to verify, and for the root test run that writes `tests-passed`.
   */
  slug?: string;
  /** How long the run may take before its process group is killed; 600 by default. */
  timeoutSeconds?: number;
}

export interface RunCommandOptions {
  /** The server's own environment, which the command's is derived from. */
  env?: NodeJS.ProcessEnv;
  /** The caller's depth in the delegation chain: the command runs one below it. */
  depth?: number;
  now?: number;
}

export type RunCommandResult =
  | {
    ok: true;
    exitCode: number;
    /** The last 64 KB of the command's own output, both streams as it interleaved them. */
    tail: string;
    /**
     * The step this run completed: `tested` for a passing worktree test run, at the branch
     * head it checked out, and `tests-passed` for a passing root test run after the merge.
     */
    journal?: JournalEntry;
  }
  | {
    ok: false;
    reason: string;
    /** What a killed run had printed: the last thing a hanging suite said. */
    tail?: string;
  };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const selectors = ["test", "setup"] as const;
// Enough of a failing suite to act on, and bounded, because this travels back through a
// tool result into a lead's context.
const tailBytes = 64 * 1024;
const defaultTimeoutSeconds = 600;
// A `setTimeout` delay is a 32-bit millisecond count: anything above this fires at once,
// so a lead asking for a month would have its suite killed on the spot.
export const maxTimeoutSeconds = Math.floor((2 ** 31 - 1) / 1000);

/**
 * What the command's own process sees. It is the specialist child environment — the host
 * markers a nested engine must not inherit are gone, and so are the API keys under
 * subscription billing (`src/guard.ts#childEnv`) — with one difference: the command is
 * **not a task**, so it carries no `CROSS_AGENT_TASK` and no lineage. What it does carry
 * is the depth, one below its caller's, so a `cross-agent` server started inside a test
 * suite resolves as a specialist and never as the operator (design section 5, layer 2).
 */
function commandEnv(
  parentEnv: Readonly<NodeJS.ProcessEnv>, depth: number, billing: "subscription" | "api", projectRoot: string,
): NodeJS.ProcessEnv {
  const env = childEnv(parentEnv, depth, "", [], billing, projectRoot);
  delete env.CROSS_AGENT_TASK;
  delete env.CROSS_AGENT_LINEAGE;
  // The variables `gitEnvironment` drops for git's own invocations, dropped here too: a
  // suite that runs git — this project's does — would otherwise be pointed at another
  // repository, index, object store or configuration by whatever the server inherited
  // (`src/worktree.ts#gitEnvironment`, design section 4).
  for (const name of Object.keys(env)) {
    if (redirectingGit.includes(name) || name.startsWith("GIT_CONFIG_")) delete env[name];
  }
  return env;
}

const redirectingGit = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_COMMON_DIR",
];

interface Ran {
  exitCode: number;
  tail: string;
  /** The run was killed at its timeout: there is no exit code to judge. */
  timedOut?: true;
}

/**
 * Runs one configured command to completion, or kills its whole process group. `started`
 * is told the command's pid as soon as it exists, before this awaits anything, so a caller
 * holding a lock can record the command before it lets the lock go. With `started`, the
 * child waits for `go` on stdin before it execs the command: publication comes first, and
 * a parent that dies before it sends `go` leaves EOF and no run. A `started` that throws
 * kills the waiting group, and the throw is this call's. The command itself sees EOF.
 */
async function shell(
  command: string, cwd: string, env: NodeJS.ProcessEnv, seconds: number, started?: (pid: number) => void,
): Promise<Ran> {
  // `detached` makes the child a process-group leader, so what the timeout kills is the
  // command and everything it started — a suite that backgrounds a server would otherwise
  // outlive the run that started it.
  const args = started === undefined ? ["-c", command]
    : ["-c", 'IFS= read -r start && [ "$start" = go ] && exec sh -c "$1"', "sh", command];
  const child = spawn("sh", args, { cwd, env, stdio: [started === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true });
  child.stdin?.on("error", () => { /* A child that exited before go leaves a broken pipe. */ });
  if (child.pid !== undefined && started !== undefined) {
    try {
      started(child.pid);
    } catch (error) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch { /* it exited first */ }
      child.stdin?.destroy();
      throw error;
    }
    child.stdin!.end("go\n");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const keep = (chunk: Buffer): void => {
    chunks.push(chunk);
    size += chunk.length;
    // Only whole chunks the cap has passed are dropped, so the tail is never rebuilt.
    while (chunks.length > 1 && size - chunks[0].length >= tailBytes) size -= chunks.shift()!.length;
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch { /* it exited between the timer and the signal */ }
  }, seconds * 1000);
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      // `close` rather than `exit`: the output is only whole once both pipes have ended.
      // A child that died on a signal has no exit code of its own, so it gets the one a
      // shell would report for it — 137 for the SIGKILL this timeout sends.
      child.once("close", (code, signal) => resolve(code ?? 128 + (constants.signals[signal!] ?? 0)));
    });
    const whole = Buffer.concat(chunks);
    // The cut is by byte and the output is text: step over the continuation bytes of a
    // character the cap landed inside, so a tail never opens with a replacement character.
    let start = Math.max(0, size - tailBytes);
    while (start < whole.length && (whole[start] & 0xc0) === 0x80) start += 1;
    const tail = whole.subarray(start).toString("utf8");
    return timedOut ? { exitCode, tail, timedOut: true } : { exitCode, tail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The project's configured `testCommand` or `setupCommand`, by selector (design section
 * 4). No argument the lead composes reaches a shell: what runs is what the config says. A
 * root run runs at the root, and completes `tests-passed` when the suite passes on the
 * default branch after the merge. A worktree setup runs in the verified worktree, marking
 * it for as long as the command's group lives (`worktreeSetup`). A worktree test run is the
 * merge's gate: it runs in a checkout of the branch head of its own, never in the worktree,
 * and completes `tested` at that head (`gateRun`).
 */
export async function runCommand(
  projectRoot: string, request: RunCommandRequest, options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const { which, where, slug } = request;
  if (!selectors.includes(which)) {
    return { ok: false, reason: `run_command runs a configured command by selector; which must be ${selectors.join(" or ")}` };
  }
  if (typeof where !== "string" || where.trim() === "") {
    return { ok: false, reason: `run_command runs at "root" or in a verified worktree; where must name one` };
  }
  const seconds = request.timeoutSeconds ?? defaultTimeoutSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxTimeoutSeconds) {
    return { ok: false, reason: `run_command's timeout_seconds must be a positive number of seconds no greater than ${maxTimeoutSeconds}, not ${seconds}` };
  }
  const atRoot = where === "root";
  // A worktree test run journals `tested` at the branch head; the root test run after the
  // merge journals `tests-passed`. A slug names the journal used to verify a worktree
  // and record those steps; for a root setup run it would be silently ignored.
  if (!atRoot && slug === undefined) {
    return { ok: false, reason: `run_command verifies ${where} against the branch its journal records; name the slug whose worktree it is` };
  }
  if (atRoot && which === "setup" && slug !== undefined) {
    return { ok: false, reason: "run_command journals nothing for a setup run; a worktree test run journals tested at the branch head, and the root test run after the merge journals tests-passed" };
  }

  let config;
  try {
    config = loadConfig(projectRoot);
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  let journal: Journal | null = null;
  if (slug !== undefined) {
    try {
      journal = readJournal(projectRoot, slug);
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
    if (journal === null) return { ok: false, reason: `slug ${slug} has no journal; there is no task to run this against` };
  }

  // The command this tool runs is read from `.cross-agent/config.json`, which is safe
  // exactly while a specialist cannot commit a change to it (design section 4).
  const located = await locateRepository(projectRoot);
  if ("reason" in located) return { ok: false, reason: located.reason };
  // Every run at a root that is not its repository's main checkout needs the project to be
  // that root's own; a run that journals writes it, on its branch, and so does the gate,
  // whose checkout is a worktree of the repository.
  const journals = atRoot && which === "test" && slug !== undefined;
  const gates = !atRoot && which === "test";
  const unwritable = rootWriteFault(located, projectRoot, config.project.defaultBranch, journals || gates ? "write" : "initialized");
  if (unwritable !== null) return { ok: false, reason: unwritable };
  let tracked: string | null;
  try {
    tracked = await trackedStateFault(located.gitDir, located.workTree);
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  if (tracked !== null) return { ok: false, reason: tracked };

  let cwd: string;
  let verified: VerifiedWorktree | undefined;
  if (atRoot) {
    cwd = located.workTree;
  } else {
    // Verified exactly as `git_mutate` verifies it, on the branch the journal records: the
    // lead does not get to say which branch a directory is on (design section 4).
    const checked = await verifyWorktree(projectRoot, path.resolve(projectRoot, where), journal!.branch, located);
    if ("reason" in checked) return { ok: false, reason: checked.reason };
    if (journal!.worktree !== undefined && journal!.worktree !== checked.workTree) {
      return { ok: false, reason: `slug ${slug} is journaled on worktree ${journal!.worktree}; refusing ${checked.workTree}` };
    }
    verified = checked;
    cwd = checked.workTree;
  }

  // The one step this tool can complete, judged before the suite runs rather than after:
  // a run that could not be journaled is worth knowing about before it takes ten minutes.
  // The same judgement is made again under the lock, where it decides.
  let defaultSha: string | undefined;
  if (journals) {
    const fault = passedFault(slug!, journal, config.project.defaultBranch);
    if (fault !== null) return { ok: false, reason: fault };
    // What the suite is about to run on, read before it starts: the step says which commit
    // passed, and the branch may move while a long suite runs.
    defaultSha = await revision(located.gitDir, located.workTree, config.project.defaultBranch);
  }

  const command = which === "test" ? config.project.testCommand : config.project.setupCommand;
  // A configured `"none"` is a no-op success, and it completes no step: `tests-passed`
  // would claim a suite passed that never ran.
  if (command === "none") return { ok: true, exitCode: 0, tail: "" };

  const env = commandEnv(options.env ?? process.env, options.depth ?? 0, config.billing, projectRoot);
  if (verified !== undefined) {
    return gates
      ? gateRun(projectRoot, { located, verified, journal: journal!, slug: slug!, config, env, seconds, now: options.now })
      : worktreeSetup(projectRoot, { verified, slug: slug!, config, env, seconds });
  }

  let ran: Ran;
  try {
    ran = await shell(command, cwd, env, seconds);
  } catch (error) {
    return { ok: false, reason: `${which}Command could not run in ${cwd}: ${message(error)}` };
  }
  if (ran.timedOut === true) {
    return {
      ok: false,
      reason: `${which}Command ran longer than ${seconds}s in ${cwd}; its process group was killed, so there is no exit code to judge`,
      tail: ran.tail,
    };
  }
  // A failing suite is an answer, not a refusal: it is where the repair path of section 7
  // starts, and the lead reads the exit code and the tail to report it.
  if (!journals || ran.exitCode !== 0) return { ok: true, exitCode: ran.exitCode, tail: ran.tail };

  // `git.lock` around the re-check and the append, and never around the suite: a run may
  // take ten minutes, and holding the lock for it would refuse every mutation in the
  // project for that long. Two runs that both passed the check above are ordered here,
  // and the second reads the first's step (design section 7).
  let lock: Lock;
  const unwritten = (reason: string): { ok: false; reason: string } =>
    ({ ok: false, reason: `the suite passed in ${cwd}, but its journal step could not be written: ${reason}` });
  try {
    lock = await projectLock(projectRoot, gitLockName(), {
      waitSeconds: config.limits.lockWaitSeconds, operation: `run_command tests-passed ${slug}`,
    });
  } catch (error) {
    return unwritten(message(error));
  }
  try {
    const current = readJournal(projectRoot, slug!);
    const fault = passedFault(slug!, current, config.project.defaultBranch);
    if (fault !== null) return { ok: false, reason: fault };
    const appended = appendStep(projectRoot, slug!, "tests-passed", {
      at: options.now ?? Date.now(), ...(defaultSha === undefined ? {} : { defaultSha }),
    });
    return { ok: true, exitCode: ran.exitCode, tail: ran.tail, journal: appended.steps[appended.steps.length - 1] };
  } catch (error) {
    return unwritten(message(error));
  } finally {
    await lock.release();
  }
}

interface GateRun {
  located: Repository;
  verified: VerifiedWorktree;
  journal: Journal;
  slug: string;
  config: CrossAgentConfig;
  env: NodeJS.ProcessEnv;
  seconds: number;
  now?: number;
}

/**
 * `body` under `git.lock` with the repository lock inside it, the standing order, for git's
 * own commands and the step they complete; the reason a lock could not be had otherwise.
 */
async function underGitLocks<T>(
  projectRoot: string, commonDir: string, waitSeconds: number, operation: string, body: () => Promise<T>,
): Promise<{ value: T } | { reason: string }> {
  let lock: Lock;
  try {
    lock = await projectLock(projectRoot, gitLockName(), { waitSeconds, operation });
  } catch (error) {
    return { reason: message(error) };
  }
  try {
    let shared: Lock;
    try {
      shared = await acquire(repositoryLockPath(commonDir), { waitSeconds: repositoryLockWait(waitSeconds), operation });
    } catch (error) {
      return { reason: message(error) };
    }
    try {
      return { value: await body() };
    } finally {
      await shared.release();
    }
  } finally {
    await lock.release();
  }
}

/**
 * The merge's first guard, from the side that feeds it (design section 4): the configured
 * suite on the branch head, in a checkout of the server's own. The head is resolved once
 * and is what everything below acts on; the checkout is the repository's own objects
 * checked out detached at it under `<root>/.cross-agent/gate/`, which no writable sandbox
 * reaches and `verifyWorktree` gives no task, so nothing uncommitted in the worktree — a
 * file, a marked file's bytes, an artifact — and nothing written there while the suite runs
 * reaches what it tests. The setup command runs there first. Both of git's own commands, the
 * `worktree add` and the `worktree remove --force`, run under `git.lock` and the repository
 * lock, which are never held while a command runs; `tested` is written under that same
 * `git.lock` once the checkout is gone, naming the head it ran on.
 */
async function gateRun(projectRoot: string, { located, verified, journal, slug, config, env, seconds, now }: GateRun): Promise<RunCommandResult> {
  const head = await revision(verified.gitDir, verified.workTree, journal.branch);
  if (head === undefined) return { ok: false, reason: `slug ${slug}: branch ${journal.branch} has no commit to test` };
  const defaultSha = await revision(located.gitDir, located.workTree, config.project.defaultBranch);
  // The checkout is the server's: made in the project's own state directory, which this
  // call holds to being a directory of the project's rather than a link out of it.
  const gateRoot = path.join(located.workTree, ".cross-agent", "gate");
  let tmp: string;
  try {
    fs.mkdirSync(gateRoot, { recursive: true, mode: 0o700 });
    tmp = fs.mkdtempSync(path.join(gateRoot, `${slug}-`));
  } catch (error) {
    return { ok: false, reason: `the gate could not make its checkout's directory under ${gateRoot}: ${message(error)}` };
  }
  const canonical = fs.realpathSync(tmp);
  if (!canonical.startsWith(gateRoot + path.sep)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, reason: `the gate's checkout at ${tmp} resolves to ${canonical}, outside ${gateRoot}; .cross-agent/gate must be a directory of the project's own` };
  }
  const checkout = path.join(tmp, "tree");
  const waitSeconds = config.limits.lockWaitSeconds;
  const operation = `run_command test ${slug}`;
  // The explicit form `git_root` creates worktrees with, on the commit resolved above.
  const added = await underGitLocks(projectRoot, located.commonDir, waitSeconds, operation,
    () => run(located.gitDir, located.workTree, ["worktree", "add", "--detach", checkout, head]));
  if ("reason" in added || added.value.exitCode !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, reason: `the gate could not check out ${head}: ${"reason" in added ? added.reason : added.value.stderr.trim()}` };
  }

  // The setup command, then the suite, in the checkout; no lock is held while either runs.
  let ran: Ran | undefined;
  let refusal: { ok: false; reason: string; tail?: string } | undefined;
  try {
    if (config.project.setupCommand !== "none") {
      const setup = await shell(config.project.setupCommand, checkout, env, seconds);
      if (setup.timedOut === true) {
        refusal = { ok: false, reason: `setupCommand ran longer than ${seconds}s in the gate's checkout of ${head}; its process group was killed`, tail: setup.tail };
      } else if (setup.exitCode !== 0) {
        refusal = { ok: false, reason: `setupCommand exited ${setup.exitCode} in the gate's checkout of ${head}`, tail: setup.tail };
      }
    }
    if (refusal === undefined) ran = await shell(config.project.testCommand, checkout, env, seconds);
  } catch (error) {
    refusal = { ok: false, reason: `the gate could not run its commands in ${checkout}: ${message(error)}` };
  }

  // The checkout goes, and then the step, both under `git.lock`: a step is written only
  // once nothing of the run is left behind.
  const tail = ran?.tail ?? refusal?.tail;
  const ranWhat = ran === undefined ? `the gate checked ${head} out in ${checkout}` : `the suite ran on ${head} in ${checkout}`;
  const settled = await underGitLocks(projectRoot, located.commonDir, waitSeconds, operation, async (): Promise<RunCommandResult> => {
    const removed = await run(located.gitDir, located.workTree, ["worktree", "remove", "--force", checkout]);
    if (removed.exitCode !== 0) {
      return {
        ok: false, ...(tail === undefined ? {} : { tail }),
        reason: `${ranWhat}, but the gate's checkout could not be removed: ${removed.stderr.trim() || `git worktree remove exited ${removed.exitCode}`}; git worktree remove --force ${checkout} at the root, then run again`,
      };
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (refusal !== undefined) return refusal;
    if (ran!.timedOut === true) {
      return { ok: false, reason: `testCommand ran longer than ${seconds}s in the gate's checkout of ${head}; its process group was killed, so there is no exit code to judge`, tail: ran!.tail };
    }
    // A failing suite is an answer, as at the root, and passes nothing.
    if (ran!.exitCode !== 0) return { ok: true, exitCode: ran!.exitCode, tail: ran!.tail };
    try {
      const appended = appendStep(projectRoot, slug, "tested", {
        at: now ?? Date.now(), before: head, after: head, ...(defaultSha === undefined ? {} : { defaultSha }),
      });
      return { ok: true, exitCode: 0, tail: ran!.tail, journal: appended.steps[appended.steps.length - 1] };
    } catch (error) {
      return { ok: false, reason: `the suite passed on ${head}, but its journal step could not be written: ${message(error)}`, tail: ran!.tail };
    }
  });
  if ("reason" in settled) {
    return {
      ok: false, ...(tail === undefined ? {} : { tail }),
      reason: `${ranWhat}, but the gate's checkout could not be removed: ${settled.reason}; git worktree remove --force ${checkout} at the root, then run again`,
    };
  }
  return settled.value;
}

interface WorktreeSetup {
  verified: VerifiedWorktree;
  slug: string;
  config: CrossAgentConfig;
  env: NodeJS.ProcessEnv;
  seconds: number;
}

/**
 * The setup command in a verified worktree, as it always ran, with the marker that holds the
 * worktree against a review for as long as the command's group lives (design section 4).
 * Under `spawn.lock`, the one `delegate` validates a review under, it is refused while a
 * review that gates the merge reads the worktree or another setup's marker holds it, and its
 * own marker is written before the lock is let go: whichever of a setup and a review takes
 * the lock first, the other sees it. The marker names the command's own group, so a server
 * that dies mid-setup leaves a hold that lasts exactly as long as that group, with no timer;
 * this call keeps its marker until its group is gone. A descendant that starts its own
 * session leaves the group, and no marker can follow it. Cleanup retakes `spawn.lock`,
 * removes only this setup's full identity, and leaves the marker if the lock times out.
 */
async function worktreeSetup(projectRoot: string, { verified, slug, config, env, seconds }: WorktreeSetup): Promise<RunCommandResult> {
  let claim: Lock;
  try {
    claim = await projectLock(projectRoot, spawnLockName(), { waitSeconds: config.limits.lockWaitSeconds, operation: `run_command setup ${slug}` });
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  let marked: ProcessIdentity | undefined;
  let pending: Promise<Ran>;
  try {
    const held = reviewHold(projectRoot, verified.workTree) ?? setupRunning(projectRoot, verified.workTree);
    if (held !== null) return { ok: false, reason: held };
    pending = shell(config.project.setupCommand, verified.workTree, env, seconds, (pid) => {
      const identity = identityOf(pid);
      if (identity === null) throw new Error(`cannot read the setup process identity for pid ${pid}`);
      markSetup(projectRoot, verified.workTree, slug, identity);
      marked = identity;
    });
    // A startup refusal may settle while release() awaits the lock holder's exit. It is
    // reported by the await below, but must already have a rejection handler here.
    void pending.catch(() => {});
  } finally {
    await claim.release();
  }
  try {
    const ran = await pending;
    if (ran.timedOut === true) {
      return {
        ok: false, tail: ran.tail,
        reason: `setupCommand ran longer than ${seconds}s in ${verified.workTree}; its process group was killed, so there is no exit code to judge`,
      };
    }
    return { ok: true, exitCode: ran.exitCode, tail: ran.tail };
  } catch (error) {
    return { ok: false, reason: `setupCommand could not run in ${verified.workTree}: ${message(error)}` };
  } finally {
    if (marked !== undefined) {
      await clearSetup(projectRoot, verified.workTree, marked, { waitSeconds: config.limits.lockWaitSeconds });
    }
  }
}

/**
 * Whether this slug's journal is one a `tests-passed` step belongs to: the merge has
 * happened, and no run has recorded the step already. Read before the suite runs so a run
 * that could not be journaled is refused early, and again under the lock, where two runs
 * that both read "no step yet" are finally ordered.
 */
function passedFault(slug: string, journal: Journal | null, defaultBranch: string): string | null {
  if (journal === null) return `slug ${slug} has no journal; there is no task to run this against`;
  if (!journal.steps.some((step) => step.step === "merged")) {
    return `slug ${slug} has no merged step; tests-passed records the suite passing on ${defaultBranch} after the merge`;
  }
  if (journal.steps.some((step) => step.step === "tests-passed")) {
    return `slug ${slug} already has a tests-passed step; the journal records what happened, not how often it was run`;
  }
  return null;
}
