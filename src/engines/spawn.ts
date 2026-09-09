import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
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
  if (request.sandbox !== "off") {
    const support = adapter.sandboxSupport();
    if (!support.ok) throw new Error(`${adapter.name} sandbox refused: ${support.reason}`);
  }

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
  let drain: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (result: SpawnResult) => void;
  const result = new Promise<SpawnResult>((done) => { resolve = done; });

  function failure(source: string, error: unknown): string {
    const text = `${adapter.name} ${source}: ${error instanceof Error ? error.message : String(error)}`;
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
        appendFileSync(log, stderr ? Buffer.concat([Buffer.from("stderr "), raw]) : raw);
      } catch (error) {
        failure("writing log", error);
        closeLog();
      }
    }
    if (stderr) return;
    let end = raw.length;
    if (raw[end - 1] === 10) {
      end--;
      if (raw[end - 1] === 13) end--;
    }
    try {
      const event = adapter.parseLine(raw.toString("utf8", 0, end));
      if (event !== null) {
        events.push(event);
        if (event.kind === "session" && sessionId === null) sessionId = event.sessionId;
        lastEventAt = Date.now();
      }
    } catch (error) {
      failure("parsing stdout", error);
    }
  }

  const stdout = lineBuffer((raw) => record(raw, false));
  const stderr = lineBuffer((raw) => record(raw, true));

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
      ok: exitCode === 0 && signal === null && !events.some((event) => event.kind === "error"),
      exitCode, signal, sessionId, events, finalMessage, lastEventAt, truncated,
    });
    resolved = true;
  }

  try {
    const plan = adapter.plan(request);
    log = openSync(request.logPath, "a");
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
    child.once("close", complete);
    // A descendant that inherited stdout holds those streams open for as long as it
    // lives, so close alone can never arrive (probe P3b). Exit starts a bounded drain
    // for the real tail; when it expires the streams are detached and destroyed before
    // the result is built, and the result says the evidence may be incomplete.
    child.once("exit", (code, signal) => {
      drain = setTimeout(() => {
        const streams = child;
        if (settled || streams === undefined) return;
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
