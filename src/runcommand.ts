import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { constants } from "node:os";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { revision } from "./gitmutate.ts";
import { repositoryAt, trackedStateFault } from "./gitroot.ts";
import { childEnv } from "./guard.ts";
import { appendStep, readJournal } from "./journal.ts";
import type { Journal, JournalEntry } from "./journal.ts";
import { projectLock } from "./ledger.ts";
import { gitLockName } from "./locks.ts";
import type { Lock } from "./locks.ts";
import { verifyWorktree } from "./worktree.ts";

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
    /** The `tests-passed` step, when this run completed one. */
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

/** Runs one configured command to completion, or kills its whole process group. */
async function shell(command: string, cwd: string, env: NodeJS.ProcessEnv, seconds: number): Promise<Ran> {
  // `detached` makes the child a process-group leader, so what the timeout kills is the
  // command and everything it started — a suite that backgrounds a server would otherwise
  // outlive the run that started it.
  const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
 * 4). No argument the lead composes reaches a shell: what runs is what the config says,
 * in the project root or a verified worktree, and the only step it can complete is
 * `tests-passed`, which the suite passing on the default branch after the merge is.
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
  // A run journals only the root test run after a merge, so a slug is meaningful in two
  // places: naming the journal whose branch verifies a worktree, and naming the journal a
  // `tests-passed` step belongs to. Anywhere else it would be silently ignored.
  if (!atRoot && slug === undefined) {
    return { ok: false, reason: `run_command verifies ${where} against the branch its journal records; name the slug whose worktree it is` };
  }
  if (atRoot && which === "setup" && slug !== undefined) {
    return { ok: false, reason: "run_command journals nothing for a setup run; only the root test run after the merge completes a step" };
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
  const located = await repositoryAt(projectRoot);
  if ("reason" in located) return { ok: false, reason: located.reason };
  let tracked: string | null;
  try {
    tracked = await trackedStateFault(located.gitDir, located.workTree);
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
  if (tracked !== null) return { ok: false, reason: tracked };

  let cwd: string;
  if (atRoot) {
    cwd = located.workTree;
  } else {
    // Verified exactly as `git_mutate` verifies it, on the branch the journal records: the
    // lead does not get to say which branch a directory is on (design section 4).
    const verified = await verifyWorktree(projectRoot, path.resolve(projectRoot, where), journal!.branch);
    if ("reason" in verified) return { ok: false, reason: verified.reason };
    if (journal!.worktree !== undefined && journal!.worktree !== verified.workTree) {
      return { ok: false, reason: `slug ${slug} is journaled on worktree ${journal!.worktree}; refusing ${verified.workTree}` };
    }
    cwd = verified.workTree;
  }

  // The one step this tool can complete, judged before the suite runs rather than after:
  // a run that could not be journaled is worth knowing about before it takes ten minutes.
  // The same judgement is made again under the lock, where it decides.
  const journals = atRoot && which === "test" && slug !== undefined;
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

  let ran: Ran;
  try {
    ran = await shell(command, cwd, commandEnv(options.env ?? process.env, options.depth ?? 0, config.billing, projectRoot), seconds);
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
