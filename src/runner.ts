import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { lockWaitSeconds } from "./config.ts";
import { isTerminal, projectLock, read, readSpec, update, writeOutcome } from "./ledger.ts";
import { runnerLockName } from "./locks.ts";
import type { EngineIdentity, ProcessIdentity, TaskPatch, TaskRecord, UpdateOptions, UpdateResult } from "./ledger.ts";
import { findByEnvironment, foreignEngineSettled, identityOf, terminateGroup, terminateGroupByPid } from "./process.ts";
import { spawnEngine } from "./engines/spawn.ts";
import type { SpawnHandle, SpawnResult } from "./engines/spawn.ts";
import type { EngineAdapter } from "./engines/types.ts";

async function run(projectRoot: string, id: string): Promise<void> {
  const directory = path.join(projectRoot, ".cross-agent", "tasks");
  fs.mkdirSync(directory, { recursive: true });
  // @anchor runnerLog
  const diagnosticPath = path.join(directory, `${id}.runner.log`);
  // @anchor lockWait
  // The launch spec does not carry it, so the runner reads the project's own waiting rule
  // once, here: every record write below waits that long for the record lock and no longer.
  const waitSeconds = lockWaitSeconds(projectRoot);
  let record: TaskRecord;
  let handle: SpawnHandle | undefined;
  let engine: EngineIdentity | undefined;
  let outcome: SpawnResult | undefined;
  let activity: ReturnType<typeof setInterval> | undefined;
  let settling = false;
  let identities: { runnerIdentity: ProcessIdentity; engineIdentity: EngineIdentity } | undefined;
  let acknowledgement: Promise<UpdateResult> | undefined;

  function log(value: unknown) {
    const text = value instanceof Error ? value.stack ?? value.message : String(value);
    fs.appendFileSync(diagnosticPath, `${new Date().toISOString()} ${text}\n`);
  }

  // @anchor write
  // Every write is conditional inside the ledger: one read, one check, one rename, all
  // under the record lock. A refusal carries the record that beat this one, so a caller
  // can tell "I wrote it" from "someone else owns it" and act on what it found.
  async function write(patch: TaskPatch, options: UpdateOptions = { unlessTerminal: true }): Promise<UpdateResult> {
    try {
      const result = await update(projectRoot, id, patch, Date.now(), { waitSeconds, ...options });
      if (result.applied) record = result.record;
      else log(`refused ${result.reason}: task ${id} is ${result.record.status}`);
      return result;
    } catch (error) {
      // A write that failed for another reason may still have lost to a settlement.
      const current = read(projectRoot, id);
      if (isTerminal(current.status)) {
        log(error);
        return { applied: false, record: current, reason: "terminal" };
      }
      throw error;
    }
  }

  // @anchor stopEngine
  async function stopEngine(grace: number): Promise<void> {
    if (engine) {
      // The same escalation the branch below runs, from the same place: SIGTERM, the
      // grace, SIGKILL, a shorter one (`src/process.ts#terminate`). What this branch does
      // differently is throw, because the runner owns this group and a terminal record
      // written over an engine still running would be a lie about the task.
      const outcome = await terminateGroup(engine, { termGrace: grace, killGrace: 500 });
      if (outcome !== "dead") throw new Error(`engine group ${engine.pgid} did not terminate: ${outcome}`);
    } else if (handle?.pid !== undefined) {
      // The identity could not be captured, so no record can name this group — but the
      // detached spawn made handle.pid its group and session id, and the kernel keeps
      // that id reserved while any member lives. Killing the child alone would settle
      // the task with the descendants it left still running.
      await terminateGroupByPid(handle.pid, { termGrace: grace, killGrace: 500 });
    }
    // A failed launch or identity read may leave only the directly owned child.
    handle?.kill("SIGKILL");
    if (handle && !outcome) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          handle.result.then((result) => { outcome = result; }),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 250); }),
        ]);
      } finally { clearTimeout(timer); }
    }
  }

  async function fatal(error: unknown): Promise<never> {
    try { log(error); } catch { /* No usable diagnostic destination remains. */ }
    clearInterval(activity);
    try { await stopEngine(0); } catch (cleanupError) {
      try { log(cleanupError); } catch { /* Preserve the nonzero exit if logging failed too. */ }
    }
    process.exit(1);
  }

  // @anchor settle
  // "preempted" is a cancel this runner found already written when it tried to
  // acknowledge: the same teardown, without a `cancelling` write of its own.
  function settle(kind: "completion" | "failed" | "cancel" | "preempted" | "external", error?: unknown): void {
    if (settling) return;
    // Claim settlement synchronously: SIGTERM and close can each arrive first,
    // but neither can independently write after the other has claimed it.
    settling = true;
    clearInterval(activity);
    void (async () => {
      if (error !== undefined) log(error);
      // @anchor settleReadsRecord
      // A cancel, or a lock lost, can reach this before the first record read: the handler
      // is registered as soon as this runner owns the task, because from that moment there
      // is something to cancel. The settlement needs the record's own paths, so it reads
      // the record here rather than crash on one it has not loaded (bead atc-s96.29).
      record ??= read(projectRoot, id);
      // The acknowledgement is this runner's claim on the record. A settlement that
      // arrives while it is in flight waits for it, so no terminal write can overtake it.
      if (acknowledgement) await acknowledgement.catch(() => undefined);
      // @anchor cancellingClaim
      if (kind === "cancel") {
        const claimed = await write({ status: "cancelling" }, {
          expect: (current) => !["cancelling", "orphaned", "done", "failed", "cancelled"].includes(current.status),
        });
        // A record already `cancelling` is this same cancel, written by the server, so
        // the cancel continues. `orphaned` is the other status this teardown settles
        // from, and it is skipped rather than claimed: the ledger allows `orphaned ->
        // cancelled` and not `orphaned -> cancelling`, so claiming it would throw and
        // strand the record (bead atc-s96.39). Any other refusal means the task is no
        // longer this runner's to settle.
        if (!claimed.applied && !["cancelling", "orphaned"].includes(claimed.record.status)) kind = "external";
      }
      // @anchor stopBeforeSettle
      let cancelling = kind === "cancel" || kind === "preempted";
      await stopEngine(cancelling ? 5000 : 0);
      // @anchor evidence
      // The identities go in even when the acknowledgement never applied, so cleanup
      // can verify the group this runner owned.
      const evidence: TaskPatch = {
        exitCode: outcome?.exitCode ?? null, sessionId: outcome?.sessionId ?? null,
        resultPath: record.resultPath, logPath: record.logPath,
        lastEventAt: outcome?.lastEventAt ?? handle?.lastEventAt ?? null,
        // Whether the evidence is complete belongs on every settled record, not only in
        // the prose of a failure: a done task can be missing the tail of its log too.
        truncated: outcome?.truncated ?? false,
        ...identities,
      };
      // The engine's own verdict, by the rule the terminal write below uses. It is
      // computed here rather than inside that write because it is also what this runner
      // records on disk, and it records that whether or not the write is its to make.
      const hasResult = outcome?.events.some((event) => event.kind === "result")
        || Boolean(outcome?.finalMessage.trim());
      const succeeded = Boolean(outcome?.ok) && outcome?.exitCode === 0 && hasResult;
      const detail = error instanceof Error ? error.message : error !== undefined ? String(error)
        : outcome?.events.findLast((event) => event.kind === "error")?.text
          ?? (outcome?.exitCode === 0 && !hasResult ? "engine exited without a result"
            : `engine exited ${outcome?.signal ?? outcome?.exitCode ?? "without an exit code"}`);
      // @anchor truncatedReason
      // The stdio drain expired, so this failure's evidence may be missing its tail. An
      // operator reading the reason has to be told that, or read it as complete.
      const reason = outcome?.truncated ? `${detail}; output truncated` : detail;
      // Recorded before any terminal write is attempted, whatever becomes of that write.
      // A record adopted while this runner was finishing is no longer this runner's to
      // settle, and then this file is the only account of how the engine ended:
      // reconciliation settles such a record from it and from nothing else, because the
      // result file carries an engine's last word whether it succeeded or failed
      // (`src/ledger.ts#TaskOutcome`, design section 2, bead atc-s96.30).
      try {
        writeOutcome(projectRoot, id, {
          kind: succeeded ? "done" : "failed",
          exitCode: evidence.exitCode ?? null, sessionId: evidence.sessionId ?? null,
          ...(succeeded ? {} : { reason }),
          truncated: outcome?.truncated ?? false, at: Date.now(),
        });
      } catch (outcomeError) {
        // A record nobody can settle from is worse than one settled `runner lost`, but
        // it is not worth losing the settlement this runner can still write.
        log(outcomeError);
      }
      let completedDuringCancel = false;
      if (kind === "completion" || kind === "failed") {
        const status = kind === "completion" && succeeded ? "done" : "failed";
        // The engine's own outcome names the status only while the record is still this
        // runner's. A record that reached `cancelling` while the engine was finishing is
        // being cancelled, however well the engine ended; one that reached `orphaned`
        // belongs to whoever wrote it. Taking the status from `kind` alone would attempt
        // a transition the ledger forbids, and strand the record.
        const settled = await write({ status, ...evidence, ...(status === "failed" ? { reason } : {}) }, {
          unlessTerminal: true,
          expect: (current) => !["cancelling", "orphaned"].includes(current.status),
        });
        if (!settled.applied) {
          completedDuringCancel = settled.reason === "expect" && settled.record.status === "cancelling";
          cancelling = completedDuringCancel;
          if (!completedDuringCancel) kind = "external";
        }
      }
      // @anchor settleCancelled
      if (cancelling && kind !== "external") {
        const settled = await write({
          status: "cancelled", ...evidence,
          ...(completedDuringCancel ? { reason: "engine completed during cancel" } : {}),
        }, { expect: (current) => ["cancelling", "orphaned"].includes(current.status) });
        if (!settled.applied) kind = "external";
      }
      log(kind === "external" ? "someone else settled the task"
        : kind === "preempted" ? "cancelled before acknowledgement" : `settled ${record.status}`);
      process.exit(0);
    })().catch(fatal);
  }

  // @anchor runnerLock
  // Exclusive ownership of the task for this process's lifetime, so one task can never
  // own two engines. It is never released: the kernel releases it when this runner dies.
  // A second runner takes it with a zero wait, fails, and leaves the record alone.
  try {
    await projectLock(projectRoot, runnerLockName(id), {
      operation: `run task ${id}`, waitSeconds: 0,
      // The lock is this runner's claim to be the only one for the task. If the kernel
      // has dropped it, another runner may already be starting, so this one gives up
      // everything it owns rather than keep an engine nobody's record accounts for.
      onLost: () => settle("failed", new Error("runner lock lost")),
    });
  } catch (error) {
    log(error);
    log(`another runner owns task ${id}`);
    return process.exit(1);
  }
  // @anchor sigterm
  // Registered once this runner owns the task, because before that it has nothing to
  // cancel. It also covers a SIGTERM received during an asynchronous import.
  process.on("SIGTERM", () => settle("cancel"));
  // @anchor standDown
  // A record that is terminal was settled by someone else and this runner owns nothing; one
  // that is already `cancelling` is a cancel that arrived before anything was spawned, and
  // an engine started now would be one that cancel has already accounted for and nothing
  // would settle. Both are read again after the import, because it can take a while.
  function standDown(current: TaskRecord): boolean {
    if (isTerminal(current.status)) {
      settle("external");
      return true;
    }
    if (current.status === "cancelling") {
      settle("preempted");
      return true;
    }
    return false;
  }

  void (async () => {
    record = read(projectRoot, id);
    if (standDown(record)) return;
    // @anchor adapterImport
    // Only the adapter module is the runner's own; the engine stays in the request,
    // which is what lets the pipeline check the module against the spec that named it.
    const { adapterModule, ...request } = readSpec(projectRoot, id);
    const imported = await import(pathToFileURL(adapterModule).href);
    if (settling) return;
    if (standDown(read(projectRoot, id))) return;
    const adapter = (imported.default ?? imported.adapter) as EngineAdapter;
    // @anchor preSpawnScan
    // The lock keeps two runners from owning this task at once, but not one after
    // another: a runner killed between its spawn and its acknowledgement leaves the
    // record `launching` and the lock free, and a replacement that spawned again would
    // give the task a second engine and strand the first for ever. Reconciliation adopts
    // what is already there, so this runner has nothing to do but stand down. It stands
    // down on an environment it could not read as well, because one of those could be that
    // engine — the rule `adopt` applies. What it never stands down for is itself: the
    // server starts it with `CROSS_AGENT_TASK` in its own environment, and the lock child
    // inherits it, so both carry the id and neither is an engine. An unreadable one is
    // scanned for again — four scans, 250 ms apart, 750 ms of waiting in all, well inside the
    // launch deadline — because such a process can be gone a moment later (atc-s96.49).
    const since = record.createdAt;
    const attempts = 4;
    let retried = 0;
    const foreign = await foreignEngineSettled(() => findByEnvironment(id, since), {
      attempts, delayMs: 250,
      onRetry: (attempt, reason) => {
        retried = attempt;
        log(`re-scanning: ${reason} (attempt ${attempt} of ${attempts})`);
      },
    });
    if (foreign === null && retried > 0) log(`re-scan clean (attempt ${retried + 1} of ${attempts})`);
    // @anchor rescanRecheck
    // The scan may have waited, and a settlement may have claimed the task meanwhile — a
    // cancel, a lost lock, another writer's terminal write — with no engine to stop yet.
    // What was checked before the scan is checked again here, with nothing awaited between
    // this and the spawn: an engine started after a settlement would be owned by nothing and
    // stopped by nothing, because a later settle is ignored. It comes before the stand-down
    // too, so a settlement in flight finishes rather than dying with an exit 1.
    if (settling) return;
    if (standDown(read(projectRoot, id))) return;
    if (foreign) {
      log(`not launching task ${id}: ${foreign}`);
      return process.exit(1);
    }
    log(`launching ${request.engine}`);
    // @anchor engineTaskId
    // The record names what this runner spawns, so the task id comes from it beside the
    // two paths, and not from the spec: `CROSS_AGENT_TASK` is how a stranded engine is
    // found and what a replacement runner stands down on, and a spec that omitted it would
    // leave an engine nothing could ever identify.
    handle = spawnEngine(adapter, {
      ...request, resultPath: record.resultPath, logPath: record.logPath,
      env: { ...request.env, CROSS_AGENT_TASK: id },
    });
    void handle.result.then((result) => {
      outcome = result;
      settle("completion");
    }).catch((error) => settle("failed", error));
    if (handle.pid === undefined) return; // Launch errors finish through handle.result.
    // @anchor acknowledge
    const runnerIdentity = identityOf(process.pid);
    const engineIdentity = identityOf(handle.pid);
    if (!runnerIdentity || !engineIdentity) throw new Error("cannot capture runner and engine process identities");
    engine = { ...engineIdentity, pgid: handle.pid };
    identities = { runnerIdentity, engineIdentity: engine };
    // The acknowledgement claims a record that is still `launching`; anything else was
    // written by someone else while this runner was starting. Settlement waits for it,
    // so even an immediate engine exit is not written before both identities are. It is
    // also the only writer of `acknowledgedAt`: the stall clock measures from the moment
    // the engine was answered for, not from a launch nobody answered.
    acknowledgement = write({ status: "running", ...identities, lastEventAt: handle.lastEventAt, acknowledgedAt: Date.now() },
      { expect: (current) => current.status === "launching" });
    const acknowledged = await acknowledgement;
    // @anchor acknowledgementRefused
    if (!acknowledged.applied) {
      // A cancel that beat the acknowledgement is still this task's cancel. Reading it
      // as a stranger's settlement would kill the engine and skip the settlement,
      // leaving the record `cancelling` for good.
      return settle(acknowledged.record.status === "cancelling" ? "preempted" : "external");
    }
    // A cancel that arrived while the acknowledgement was in flight already owns the
    // teardown, and has cleared an interval this would otherwise start behind it.
    if (settling) return;
    // @anchor activityInterval
    let persistedEvent = handle.lastEventAt;
    let inFlight = false;
    activity = setInterval(() => {
      const latest = handle!.lastEventAt;
      if (inFlight || latest === persistedEvent) return;
      inFlight = true;
      void write({ lastEventAt: latest }).then((result) => {
        if (!result.applied) return settle("external");
        persistedEvent = latest;
      }).catch((error) => settle("failed", error)).finally(() => { inFlight = false; });
    }, 2000);
  })().catch((error) => {
    if (!record) void fatal(error);
    else settle("failed", error);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const values: Record<string, string> = {};
    // @anchor taskArgument
    // Task IDs use base64url and may begin with '-'. Each option consumes its
    // next argument literally instead of interpreting that ID as another flag.
    for (let i = 0; i < args.length; i += 2) {
      const option = args[i];
      if (!["--project", "--task"].includes(option) || values[option] !== undefined || args[i + 1] === undefined) {
        throw new Error("expected --project <root> --task <id>");
      }
      values[option] = args[i + 1];
    }
    if (!values["--project"] || !values["--task"] || !/^[A-Za-z0-9_-]+$/.test(values["--task"])) {
      throw new Error("expected --project <root> --task <id>");
    }
    void run(path.resolve(values["--project"]), values["--task"]).catch(() => { process.exitCode = 1; });
  } catch {
    // Invalid arguments cannot identify a task-local diagnostic destination.
    process.exitCode = 1;
  }
}
