import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { profileFault, sandboxFor } from "./registry.ts";
import type { EngineAdapter, EngineEvent, SpawnRequest } from "./types.ts";

export interface SpawnResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId: string | null;
  events: EngineEvent[];
  finalMessage: string;
  lastEventAt: number | null;
  /** The stdio drain expired: stdout and stderr may both be missing their tail. */
  truncated: boolean;
}

export interface SpawnHandle {
  readonly pid: number | undefined;
  readonly lastEventAt: number | null;
  result: Promise<SpawnResult>;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnOptions {
  spawn?: (bin: string, argv: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  /** How long after the child's exit to keep reading its stdio before giving up. */
  drainMs?: number;
}

/** Buffers bytes until LF or EOF, preserving both UTF-8 boundaries and native terminators. */
function lineBuffer(accept: (raw: Buffer) => void) {
  let parts: Buffer[] = [];
  let length = 0;
  function flush() {
    if (length === 0) return;
    const raw = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
    parts = [];
    length = 0;
    accept(raw);
  }
  return {
    write(chunk: Buffer) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline + 1;
        parts.push(chunk.subarray(start, end));
        length += end - start;
        if (newline !== -1) flush();
        start = end;
      }
    },
    flush,
  };
}

/** Capability refusals throw synchronously; process and output failures settle through result. */
export function spawnEngine(adapter: EngineAdapter, request: SpawnRequest, options: SpawnOptions = {}): SpawnHandle {
  // The request's mode is a claim; the engine's own map is the fact. A request that
  // called a writable profile `off` would otherwise skip the check below entirely, so the
  // two are compared before anything is planned or spawned. The spec's engine must also
  // be the adapter module the runner imported, or the map the mode is derived from would
  // describe one engine while another builds the argv.
  // @anchor spawnChecks
  if (request.engine !== adapter.name) {
    throw new Error(`${adapter.name} spawn refused: the launch spec names engine ${JSON.stringify(request.engine)}`);
  }
  // The registry's words for a profile the engine does not declare leave the engine out,
  // so the refusal names it once; an engine the registry has no adapter for is refused here
  // the same way.
  let fault: string | null;
  try {
    fault = profileFault(request.engine, request.sandbox.profile);
  } catch (error) {
    fault = error instanceof Error ? error.message : String(error);
  }
  if (fault !== null) throw new Error(`${adapter.name} sandbox refused: ${fault}`);
  const declared = sandboxFor(request.engine, request.sandbox.profile).mode;
  if (declared !== request.sandbox.mode) {
    throw new Error(`${adapter.name} sandbox refused: profile ${JSON.stringify(request.sandbox.profile)} is ${declared}, not ${request.sandbox.mode}`);
  }
  // Only a profile that maps to `off` may run without a sandbox.
  // @anchor sandboxSupportCheck
  if (declared !== "off") {
    const support = adapter.sandboxSupport(request.env);
    if (!support.ok) throw new Error(`${adapter.name} sandbox refused: ${support.reason}`);
  }

  // Taken once, before any output can arrive: an engine whose output is one document at
  // exit declares `finish`, and only then is raw stdout kept. Every other adapter buffers
  // nothing, and its bytes are the log's alone. `parseStderrLine` is bound here for the
  // same reason and read the same way: an engine that writes a fatal line to stderr rather
  // than into its event stream declares it, and stderr is parsed for no other adapter.
  // @anchor finishBound
  const finish = adapter.finish?.bind(adapter);
  const parseLine = adapter.parseLine.bind(adapter);
  // @anchor stderrParserBound
  const parseStderrLine = adapter.parseStderrLine?.bind(adapter);
  const rawStdout: Buffer[] = [];
  const events: EngineEvent[] = [];
  let sessionId: string | null = null;
  let lastEventAt: number | null = null;
  let child: ChildProcessWithoutNullStreams | undefined;
  let pid: number | undefined;
  let log: number | undefined;
  let settled = false;
  let accepting = true;
  let resolved = false;
  let stopping = false;
  let truncated = false;
  // @anchor stderrFailedLatch
  // Per run, and only here: the adapters are pure functions of one line, so the latch that
  // keeps one sandbox failure from becoming hundreds of events belongs to the run.
  let stderrFailed = false;
  let drain: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (result: SpawnResult) => void;
  const result = new Promise<SpawnResult>((done) => { resolve = done; });

  function failure(source: string, error: unknown): string {
    const text = `${adapter.name} ${source}: ${error instanceof Error ? error.message : String(error)}`;
    // @anchor lateError
    // The caller already holds the result: a late error cannot change what it holds. The
    // listeners stay attached, so it is still handled rather than thrown at the process.
    if (resolved) return text;
    events.push({ kind: "error", text });
    // A broken pipe or lost evidence trail cannot leave a child running indefinitely.
    if (child && !settled && !stopping) {
      stopping = true;
      child.kill("SIGKILL");
    }
    return text;
  }

  function closeLog() {
    const fd = log;
    log = undefined;
    if (fd !== undefined) {
      try { closeSync(fd); } catch (error) { failure("closing log", error); }
    }
  }

  function record(raw: Buffer, stderr: boolean) {
    // The result has been built and the log closed: this arrived too late to be evidence.
    if (!accepting) return;
    if (log !== undefined) {
      try {
        // @anchor stderrPrefixed
        appendFileSync(log, stderr ? Buffer.concat([Buffer.from("stderr "), raw]) : raw);
      } catch (error) {
        failure("writing log", error);
        closeLog();
      }
    }
    // A sandbox that engages and then fails at its own setup writes its message once per
    // command the engine tries, so the stderr reader is asked only until it reports a
    // failure: after that the run is already failed and the repetition is the log's alone.
    if (stderr && stderrFailed) return;
    // @anchor parserForStream
    const parse = stderr ? parseStderrLine : parseLine;
    if (parse === undefined) return;
    // @anchor rawStdoutKept
    if (!stderr && finish !== undefined) rawStdout.push(raw);
    let end = raw.length;
    if (raw[end - 1] === 10) {
      end--;
      if (raw[end - 1] === 13) end--;
    }
    try {
      // @anchor parsedEvent
      const event = parse(raw.toString("utf8", 0, end));
      if (event !== null) {
        events.push(event);
        if (event.kind === "session" && sessionId === null) sessionId = event.sessionId;
        if (stderr && event.kind === "error") stderrFailed = true;
        // @anchor stderrAdvancesClock
        // A stderr event advances lastEventAt exactly like a stdout one, deliberately: an
        // engine whose every command dies in the sandbox is working, not stalled, and the
        // stall detector must not be the thing that reports a failure the events already do.
        lastEventAt = Date.now();
      }
    } catch (error) {
      failure(stderr ? "parsing stderr" : "parsing stdout", error);
    }
  }

  const stdout = lineBuffer((raw) => record(raw, false));
  const stderr = lineBuffer((raw) => record(raw, true));

  // @anchor completeOnce
  function complete(exitCode: number | null, signal: NodeJS.Signals | null) {
    if (settled) return;
    // Settled first, so nothing here can be entered twice and nothing here reads as a
    // child still worth signalling. The buffers are then flushed while record still
    // accepts data, because a final line without a terminator is evidence, not a tail to
    // drop; everything after that flush is too late.
    settled = true;
    clearTimeout(drain);
    stdout.flush();
    stderr.flush();
    accepting = false;
    closeLog();
    child = undefined;

    // The document the run was, read once, after the last byte of it and before the final
    // message is extracted: a session or a result that only the whole output carries is
    // still this run's, and still counts as evidence.
    // @anchor finishRuns
    if (finish !== undefined) {
      try {
        for (const event of finish(Buffer.concat(rawStdout).toString("utf8"))) {
          events.push(event);
          if (event.kind === "session" && sessionId === null) sessionId = event.sessionId;
        }
      } catch (error) {
        failure("finishing output", error);
      }
    }

    let resultFileText: string | null = null;
    try {
      resultFileText = readFileSync(request.resultPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure("reading result", error);
    }
    let finalMessage: string;
    try {
      finalMessage = adapter.finalMessage(events, resultFileText);
    } catch (error) {
      finalMessage = failure("extracting final message", error);
    }
    try {
      writeFileSync(request.resultPath, finalMessage);
    } catch (error) {
      failure("writing result", error);
    }
    resolve({
      // @anchor okVerdict
      ok: exitCode === 0 && signal === null && !events.some((event) => event.kind === "error"),
      exitCode, signal, sessionId, events, finalMessage, lastEventAt, truncated,
    });
    // @anchor resolvedLatch
    resolved = true;
  }

  try {
    // @anchor adapterPlan
    const plan = adapter.plan(request);
    // The adapter builds argv and names the files that argv points at; the pipeline puts
    // them in place, parents included, and invents no path of its own.
    // @anchor planFiles
    for (const file of plan.files ?? []) {
      mkdirSync(path.dirname(file.path), { recursive: true });
      // A lead's mount config and a role prompt are this task's alone.
      writeFileSync(file.path, file.contents, { mode: 0o600 });
    }
    log = openSync(request.logPath, "a");
    // @anchor detachedSpawn
    child = (options.spawn ?? spawn)(plan.bin, plan.argv, { cwd: plan.cwd, env: plan.env, detached: true });
    pid = child.pid;
    child.on("error", (error) => { failure("launch/process error", error); });
    child.stdout.on("data", stdout.write);
    child.stdout.on("end", stdout.flush);
    child.stdout.on("error", (error) => { failure("stdout error", error); });
    child.stderr.on("data", stderr.write);
    child.stderr.on("end", stderr.flush);
    child.stderr.on("error", (error) => { failure("stderr error", error); });
    child.stdin.on("error", (error) => { failure("stdin error", error); });
    // close follows exit and the closure of all stdio streams.
    // @anchor closeSettles
    child.once("close", complete);
    // A descendant that inherited stdout holds those streams open for as long as it
    // lives, so close alone can never arrive (probe P3b). Exit starts a bounded drain
    // for the real tail; when it expires the streams are detached and destroyed before
    // the result is built, and the result says the evidence may be incomplete.
    // @anchor exitDrain
    child.once("exit", (code, signal) => {
      drain = setTimeout(() => {
        const streams = child;
        if (settled || streams === undefined) return;
        // @anchor drainExpired
        truncated = true;
        streams.stdout.off("data", stdout.write);
        streams.stdout.off("end", stdout.flush);
        streams.stderr.off("data", stderr.write);
        streams.stderr.off("end", stderr.flush);
        streams.stdout.destroy();
        streams.stderr.destroy();
        complete(code, signal);
      }, options.drainMs ?? 2000);
    });
    child.stdin.end(plan.stdin ?? "");
  } catch (error) {
    // @anchor launchError
    failure("launch error", error);
    if (!child) complete(null, null);
  }

  return {
    pid,
    get lastEventAt() { return lastEventAt; },
    result,
    kill: (signal = "SIGTERM") => !settled && child !== undefined ? child.kill(signal) : false,
  };
}
