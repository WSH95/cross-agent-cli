import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { lockWaitSeconds } from "./config.ts";
import { isTerminal, read, readSpec, update } from "./ledger.ts";
import { acquire, lockPath, runnerLockName } from "./locks.ts";
import type { EngineIdentity, ProcessIdentity, TaskPatch, TaskRecord, UpdateOptions, UpdateResult } from "./ledger.ts";
import { findByEnvironment, groupAlive, identityOf, killGroup, terminateGroupByPid } from "./process.ts";
import { spawnEngine } from "./engines/spawn.ts";
import type { SpawnHandle, SpawnResult } from "./engines/spawn.ts";
import type { EngineAdapter } from "./engines/types.ts";

async function run(projectRoot: string, id: string): Promise<void> {
  const directory = path.join(projectRoot, ".cross-agent", "tasks");
  fs.mkdirSync(directory, { recursive: true });
  const diagnosticPath = path.join(directory, `${id}.runner.log`);
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

  async function waitForGroup(timeout: number): Promise<boolean> {
    const deadline = performance.now() + timeout;
    while (engine && groupAlive(engine)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await delay(Math.min(20, remaining));
    }
    return true;
  }

  async function stopEngine(grace: number): Promise<void> {
    if (engine && groupAlive(engine)) {
      killGroup(engine, grace > 0 ? "SIGTERM" : "SIGKILL");
      if (!await waitForGroup(grace || 500)) {
        killGroup(engine, "SIGKILL");
        if (!await waitForGroup(500)) throw new Error(`engine group ${engine.pgid} did not terminate`);
      }
    } else if (!engine && handle?.pid !== undefined) {
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
      // The acknowledgement is this runner's claim on the record. A settlement that
      // arrives while it is in flight waits for it, so no terminal write can overtake it.
      if (acknowledgement) await acknowledgement.catch(() => undefined);
      if (kind === "cancel") {
        const claimed = await write({ status: "cancelling" }, {
          expect: (current) => !["cancelling", "done", "failed", "cancelled"].includes(current.status),
        });
        // A record already `cancelling` is this same cancel, written by the server, so
        // the cancel continues. Any other refusal means the task is no longer this
        // runner's to settle.
        if (!claimed.applied && claimed.record.status !== "cancelling") kind = "external";
      }
      let cancelling = kind === "cancel" || kind === "preempted";
      await stopEngine(cancelling ? 5000 : 0);
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
      let completedDuringCancel = false;
      if (kind === "completion" || kind === "failed") {
        const hasResult = outcome?.events.some((event) => event.kind === "result")
          || Boolean(outcome?.finalMessage.trim());
        const status = kind === "completion" && outcome?.ok && outcome.exitCode === 0 && hasResult ? "done" : "failed";
        const detail = error instanceof Error ? error.message : error !== undefined ? String(error)
          : outcome?.events.findLast((event) => event.kind === "error")?.text
            ?? (outcome?.exitCode === 0 && !hasResult ? "engine exited without a result"
              : `engine exited ${outcome?.signal ?? outcome?.exitCode ?? "without an exit code"}`);
        // The stdio drain expired, so this failure's evidence may be missing its tail.
        // An operator reading the reason has to be told that, or read it as complete.
        const reason = outcome?.truncated ? `${detail}; output truncated` : detail;
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
      if (cancelling && kind !== "external") {
        const settled = await write({
          status: "cancelled", ...evidence,
          ...(completedDuringCancel ? { reason: "engine completed during cancel" } : {}),
        }, { expect: (current) => current.status === "cancelling" });
        if (!settled.applied) kind = "external";
      }
      log(kind === "external" ? "someone else settled the task"
        : kind === "preempted" ? "cancelled before acknowledgement" : `settled ${record.status}`);
      process.exit(0);
    })().catch(fatal);
  }

  // Exclusive ownership of the task for this process's lifetime, so one task can never
  // own two engines. It is never released: the kernel releases it when this runner dies.
  // A second runner takes it with a zero wait, fails, and leaves the record alone.
  try {
    await acquire(lockPath(projectRoot, runnerLockName(id)), {
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
  // Registered once this runner owns the task, because before that it has nothing to
  // cancel. It also covers a SIGTERM received during an asynchronous import.
  process.on("SIGTERM", () => settle("cancel"));
  void (async () => {
    record = read(projectRoot, id);
    if (isTerminal(record.status)) return settle("external");
    // Only the adapter module is the runner's own; the engine stays in the request,
    // which is what lets the pipeline check the module against the spec that named it.
    const { adapterModule, ...request } = readSpec(projectRoot, id);
    const imported = await import(pathToFileURL(adapterModule).href);
    if (settling) return;
    if (isTerminal(read(projectRoot, id).status)) return settle("external");
    const adapter = (imported.default ?? imported.adapter) as EngineAdapter;
    // The lock keeps two runners from owning this task at once, but not one after
    // another: a runner killed between its spawn and its acknowledgement leaves the
    // record `launching` and the lock free, and a replacement that spawned again would
    // give the task a second engine and strand the first for ever. Reconciliation adopts
    // what is already there, so this runner has nothing to do but stand down.
    if (findByEnvironment(id, record.createdAt).found.length > 0) {
      log(`engine already running for task ${id}`);
      return process.exit(1);
    }
    log(`launching ${request.engine}`);
    handle = spawnEngine(adapter, { ...request, resultPath: record.resultPath, logPath: record.logPath });
    void handle.result.then((result) => {
      outcome = result;
      settle("completion");
    }).catch((error) => settle("failed", error));
    if (handle.pid === undefined) return; // Launch errors finish through handle.result.
    const runnerIdentity = identityOf(process.pid);
    const engineIdentity = identityOf(handle.pid);
    if (!runnerIdentity || !engineIdentity) throw new Error("cannot capture runner and engine process identities");
    engine = { ...engineIdentity, pgid: handle.pid };
    identities = { runnerIdentity, engineIdentity: engine };
    // The acknowledgement claims a record that is still `launching`; anything else was
    // written by someone else while this runner was starting. Settlement waits for it,
    // so even an immediate engine exit is not written before both identities are.
    acknowledgement = write({ status: "running", ...identities, lastEventAt: handle.lastEventAt },
      { expect: (current) => current.status === "launching" });
    const acknowledged = await acknowledgement;
    if (!acknowledged.applied) {
      // A cancel that beat the acknowledgement is still this task's cancel. Reading it
      // as a stranger's settlement would kill the engine and skip the settlement,
      // leaving the record `cancelling` for good.
      return settle(acknowledged.record.status === "cancelling" ? "preempted" : "external");
    }
    // A cancel that arrived while the acknowledgement was in flight already owns the
    // teardown, and has cleared an interval this would otherwise start behind it.
    if (settling) return;
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
