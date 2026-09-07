import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { read, readSpec, update } from "./ledger.ts";
import type { EngineIdentity, TaskPatch, TaskRecord } from "./ledger.ts";
import { groupAlive, identityOf, killGroup } from "./process.ts";
import { spawnEngine } from "./engines/spawn.ts";
import type { SpawnHandle, SpawnResult } from "./engines/spawn.ts";
import type { EngineAdapter } from "./engines/types.ts";

const terminal = (record: TaskRecord) => ["done", "failed", "cancelled"].includes(record.status);

function run(projectRoot: string, id: string): void {
  const directory = path.join(projectRoot, ".dev-team", "tasks");
  fs.mkdirSync(directory, { recursive: true });
  const diagnosticPath = path.join(directory, `${id}.runner.log`);
  let record: TaskRecord;
  let handle: SpawnHandle | undefined;
  let engine: EngineIdentity | undefined;
  let outcome: SpawnResult | undefined;
  let activity: ReturnType<typeof setInterval> | undefined;
  let settling = false;

  function log(value: unknown) {
    const text = value instanceof Error ? value.stack ?? value.message : String(value);
    fs.appendFileSync(diagnosticPath, `${new Date().toISOString()} ${text}\n`);
  }

  // The ledger permits metadata updates to a terminal record. The runner must
  // preserve it entirely, including when another writer wins between these reads.
  function write(patch: TaskPatch): boolean {
    if (terminal(read(projectRoot, id))) return false;
    try {
      record = update(projectRoot, id, patch);
      return true;
    } catch (error) {
      if (terminal(read(projectRoot, id))) {
        log(error);
        return false;
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

  function settle(kind: "completion" | "failed" | "cancel" | "external", error?: unknown): void {
    if (settling) return;
    // Claim settlement synchronously: SIGTERM and close can each arrive first,
    // but neither can independently write after the other has claimed it.
    settling = true;
    clearInterval(activity);
    void (async () => {
      if (error !== undefined) log(error);
      if (kind === "cancel" && !write({ status: "cancelling" })) kind = "external";
      await stopEngine(kind === "cancel" ? 5000 : 0);
      if (kind !== "external") {
        const hasResult = outcome?.events.some((event) => event.kind === "result")
          || Boolean(outcome?.finalMessage.trim());
        const status = kind === "cancel" ? "cancelled"
          : kind === "completion" && outcome?.ok && outcome.exitCode === 0 && hasResult ? "done" : "failed";
        const reason = error instanceof Error ? error.message : error !== undefined ? String(error)
          : outcome?.events.findLast((event) => event.kind === "error")?.text
            ?? (outcome?.exitCode === 0 && !hasResult ? "engine exited without a result"
              : `engine exited ${outcome?.signal ?? outcome?.exitCode ?? "without an exit code"}`);
        if (!write({
          status, exitCode: outcome?.exitCode ?? null, sessionId: outcome?.sessionId ?? null,
          resultPath: record.resultPath, logPath: record.logPath,
          lastEventAt: outcome?.lastEventAt ?? handle?.lastEventAt ?? null,
          ...(status === "failed" ? { reason } : {}),
        })) kind = "external";
      }
      log(kind === "external" ? "someone else settled the task" : `settled ${record.status}`);
      process.exit(0);
    })().catch(fatal);
  }

  // This handler also covers a SIGTERM received during an asynchronous import.
  process.on("SIGTERM", () => settle("cancel"));
  void (async () => {
    record = read(projectRoot, id);
    if (terminal(record)) return settle("external");
    const { engine: engineName, adapterModule, ...request } = readSpec(projectRoot, id);
    const imported = await import(pathToFileURL(adapterModule).href);
    if (settling) return;
    if (terminal(read(projectRoot, id))) return settle("external");
    const adapter = (imported.default ?? imported.adapter) as EngineAdapter;
    log(`launching ${engineName}`);
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
    groupAlive(engine);
    // No await between spawn and this atomic acknowledgement. Even an immediate
    // engine exit is not handled until both identities have reached the ledger.
    if (!write({ status: "running", runnerIdentity, engineIdentity: engine, lastEventAt: handle.lastEventAt })) {
      return settle("external");
    }
    let persistedEvent = handle.lastEventAt;
    activity = setInterval(() => {
      try {
        const latest = handle!.lastEventAt;
        if (latest !== persistedEvent) {
          if (!write({ lastEventAt: latest })) return settle("external");
          persistedEvent = latest;
        }
      } catch (error) { settle("failed", error); }
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
    run(path.resolve(values["--project"]), values["--task"]);
  } catch {
    // Invalid arguments cannot identify a task-local diagnostic destination.
    process.exitCode = 1;
  }
}
