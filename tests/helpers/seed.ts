import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sandboxFor } from "../../src/engines/registry.ts";
import { appendStep } from "../../src/journal.ts";
import type { Journal } from "../../src/journal.ts";
import { create, currentBootId, newTaskId, readProcessStat, update, writeOutcome, writeSpec } from "../../src/ledger.ts";
import type { EngineIdentity, TaskOutcome, TaskPatch, TaskRecord, TaskStatus } from "../../src/ledger.ts";
import { answerAsk, createAsk } from "../../src/mailbox.ts";
import type { AskRecord } from "../../src/mailbox.ts";
import { git } from "./git.ts";

// Fixtures for the operator's reads: a project whose ledger holds a task in every status,
// built through the ledger's own functions and the CLI's own `init`, and the byte-for-byte
// record of a state directory, so a test can say a read left it exactly as it was. No
// engine and no runner exists in either: every identity a record names is a process that
// has exited and been reaped.

const exec = promisify(execFile);
const sources = fileURLToPath(new URL("../../", import.meta.url));
const cli = path.join(sources, "src", "cli.ts");
/** Nothing of the suite's own CROSS_AGENT_* reaches the CLI: the suite may be a task itself. */
const suiteEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CROSS_AGENT_")));

/**
 * Every entry under `directory`, by path relative to it: a file as its bytes, a directory
 * as `<directory>`. Directories are entries too, because a read that creates an empty
 * `locks/` or `asks/` has written something even though no file appeared. A directory that
 * does not exist is the empty snapshot.
 */
export function snapshot(directory: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const name = path.relative(directory, full);
      if (entry.isDirectory()) {
        entries[name] = "<directory>";
        walk(full);
      } else {
        entries[name] = fs.readFileSync(full).toString("base64");
      }
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return entries;
}

/** The identity of a process that has exited and been reaped: dead, as a runner or as an engine group. */
export async function deadIdentity(): Promise<EngineIdentity> {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
  await once(child, "spawn");
  const pid = child.pid!;
  const stat = readProcessStat(pid);
  assert.ok(stat, `the identity's process ${pid} is readable while it runs`);
  const closed = once(child, "close");
  child.stdin!.end();
  await closed;
  for (let tries = 0; readProcessStat(pid) !== null; tries++) {
    assert.ok(tries < 1000, `process ${pid} was never reaped`);
    await delay(5);
  }
  return { pid, startTime: stat.startTime, pgid: pid, bootId: currentBootId };
}

/** The statuses a seeded record passes through from `launching`, along the ledger's transition table. */
const route: Record<TaskStatus, TaskStatus[]> = {
  launching: [],
  running: ["running"],
  stalled: ["running", "stalled"],
  orphaned: ["running", "orphaned"],
  cancelling: ["running", "cancelling"],
  done: ["running", "done"],
  failed: ["running", "failed"],
  cancelled: ["running", "cancelling", "cancelled"],
};

export interface SeededProject {
  root: string;
  /** One record in each status, as the ledger holds it once seeded. */
  byStatus: Record<TaskStatus, TaskRecord>;
  /** A second `done` record, whose result file was never written. */
  doneWithoutResult: TaskRecord;
  /** A lead and its two children by `parentTaskId`: one running with its runner gone, one done. */
  lead: TaskRecord;
  runningChild: TaskRecord;
  doneChild: TaskRecord;
  /** The settled task that owns the linked worktree; its id is the slug its journal is kept under. */
  worktreeTask: TaskRecord;
  slug: string;
  branch: string;
  /** The linked worktree, canonical, on `branch`. */
  worktree: string;
  journal: Journal;
  /** Asked by `byStatus.running`, which is nobody's descendant. */
  asks: { open: AskRecord; answered: AskRecord };
  /** The engine log, the outcome sidecar and the final message of `byStatus.done`. */
  log: string[];
  outcome: TaskOutcome;
  finalMessage: string;
  /** A malformed task record and a damaged ask file, each named `broken.json`. */
  brokenTask: string;
  brokenAsk: string;
}

/**
 * A git repository initialized by the CLI's own `init --mode dev-team`, its limits edited as
 * an operator would — no cancel grace, a one-second lock wait, a 1.2-second stall threshold —
 * and a ledger holding a task in every status, a cascade, a worktree task with its journal
 * and a real linked worktree, an open and an answered ask, and one damaged file each in the
 * task and ask directories. Every active record names a reaped runner and engine, and every
 * record carries a read-only launch spec, so none of them reserves a workspace.
 */
export async function seededProject(t: TestContext): Promise<SeededProject> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "cross-agent-seed-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await git(root, "init", "-b", "main");
  // `git_mutate` refuses `-c`, so the identity its commits need lives in the repository.
  await git(root, "config", "user.name", "Cross Agent Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "commit.gpgSign", "false");
  await git(root, "commit", "--allow-empty", "-m", "initial");
  await exec(process.execPath, [cli, "init", "--mode", "dev-team"], { cwd: root, env: suiteEnv, encoding: "utf8" });
  const configFile = path.join(root, ".cross-agent", "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as { limits: Record<string, number> };
  config.limits = { ...config.limits, cancelGraceSeconds: 0, lockWaitSeconds: 1, stallMinutes: 0.02 };
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  await git(root, "add", ".gitignore");
  await git(root, "commit", "-m", "ignore the project's own state");

  const gone = await deadIdentity();
  const now = Date.now();
  // Two hours of history, a minute between records, so newest-first has one answer.
  let clock = now - 2 * 3_600_000;
  async function seed(
    role: string, status: TaskStatus,
    values: { id?: string; at?: number; parentTaskId?: string; worktree?: TaskRecord["worktree"]; patch?: TaskPatch } = {},
  ): Promise<TaskRecord> {
    const at = values.at ?? (clock += 60_000);
    const record = create(root, {
      id: values.id, role, brief: `seeded ${role}`, cwd: values.worktree?.path ?? root,
      engine: "claude", model: "claude-opus-5", effort: role === "planner" ? "high" : null, depth: 1,
      parentTaskId: values.parentTaskId ?? null, worktree: values.worktree,
    }, at);
    writeSpec(root, record.id, {
      role, brief: `seeded ${role}`, rolePrompt: "seeded", cwd: record.cwd, engine: "claude",
      sandbox: sandboxFor("claude", "read-only"), sessionId: `session-${record.id}`, denyTargets: [], env: {},
      scratchDir: path.dirname(record.logPath),
      adapterModule: path.join(sources, "src", "engines", "claude.ts"),
    });
    let moved = record;
    let step = at;
    for (const next of route[status]) {
      step += 10_000;
      const patch: TaskPatch = {
        status: next,
        ...(next === "running" ? { runnerIdentity: gone, engineIdentity: gone, acknowledgedAt: step, lastEventAt: step } : {}),
        ...(next === status ? values.patch : {}),
      };
      const result = await update(root, record.id, patch, step);
      assert.equal(result.applied, true, `seed could not move ${role} to ${next}`);
      moved = result.record;
    }
    return moved;
  }

  // The done task carries every file a settled task can have.
  const done = await seed("planner", "done", { patch: { exitCode: 0, sessionId: "seeded-session" } });
  const finalMessage = "The plan, in full.\nSecond line of it.\n";
  fs.writeFileSync(done.resultPath, finalMessage);
  const log = Array.from({ length: 12 }, (_, index) => JSON.stringify({ type: "event", n: index + 1 }));
  fs.writeFileSync(done.logPath, `${log.join("\n")}\n`);
  fs.writeFileSync(path.join(path.dirname(done.logPath), `${done.id}.runner.log`), "runner: seeded diagnostic\n");
  const outcome: TaskOutcome = { kind: "done", exitCode: 0, sessionId: "seeded-session", at: done.updatedAt };
  writeOutcome(root, done.id, outcome);
  const doneWithoutResult = await seed("plan-reviewer", "done");
  const failed = await seed("implementer", "failed", { patch: { reason: "BLOCKED: seeded failure", exitCode: 1 } });
  const cancelled = await seed("code-reviewer", "cancelled", { patch: { reason: "cancelled by the operator" } });
  const orphaned = await seed("consult", "orphaned");
  const cancelling = await seed("consult", "cancelling");
  const stalled = await seed("consult", "stalled");
  // The quiet one: running, its runner gone, and nothing from its engine for an hour, which
  // is far past `stallMinutes` — a `check` would write it `stalled`; a read must not.
  const running = await seed("consult", "running");
  const quiet = (await update(root, running.id, { lastEventAt: now - 3_600_000 }, running.updatedAt)).record;

  const lead = await seed("lead", "running");
  const runningChild = await seed("implementer", "running", { parentTaskId: lead.id });
  const doneChild = await seed("planner", "done", { parentTaskId: lead.id });

  // A worktree task: its id is the slug, the branch and the directory, as `delegate` names them.
  const slug = newTaskId();
  const branch = `task/${slug}`;
  await git(root, "worktree", "add", "-b", branch, path.join(root, ".worktrees", slug), "main");
  const worktree = fs.realpathSync(path.join(root, ".worktrees", slug));
  const base = await git(root, "rev-parse", "main");
  await git(worktree, "commit", "--allow-empty", "-m", "seeded work");
  const head = await git(worktree, "rev-parse", "HEAD");
  const worktreeTask = await seed("implementer", "done", { id: slug, worktree: { path: worktree, branch, slug } });
  appendStep(root, slug, "worktree-created", {
    at: worktreeTask.createdAt, after: base, defaultSha: base, branch, worktree, defaultBranch: "main",
    args: ["worktree", "add", "-b", branch, worktree, "main"],
  });
  const journal = appendStep(root, slug, "committed", {
    at: worktreeTask.createdAt + 5_000, before: base, after: head, defaultSha: base, args: ["commit", "-m", "seeded work"],
  });

  // Fresh, and last: created now, inside its launch window, no runner yet.
  const launching = await seed("planner", "launching", { at: now });

  const open = createAsk(root, { taskId: running.id, question: "Which slug?\nThe second line." }, now - 600_000);
  const asked = createAsk(root, { taskId: running.id, question: "Rebase first?" }, now - 1_200_000);
  const answered = await answerAsk(root, asked.id, "Yes, onto main.\nThen run the suite.", { now: now - 900_000 });
  assert.equal(answered.applied, true);

  const brokenTask = path.join(root, ".cross-agent", "tasks", "broken.json");
  fs.writeFileSync(brokenTask, "{not a record");
  const brokenAsk = path.join(root, ".cross-agent", "asks", "broken.json");
  fs.writeFileSync(brokenAsk, "{not json");

  return {
    root,
    byStatus: { launching, running: quiet, stalled, orphaned, cancelling, done, failed, cancelled },
    doneWithoutResult, lead, runningChild, doneChild, worktreeTask, slug, branch, worktree, journal,
    asks: { open, answered: answered.applied ? answered.ask : asked },
    log, outcome, finalMessage, brokenTask, brokenAsk,
  };
}
