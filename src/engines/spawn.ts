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
}

export interface SpawnHandle {
  result: Promise<SpawnResult>;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnOptions {
  spawn?: (bin: string, argv: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
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
  let log: number | undefined;
  let settled = false;
  let stopping = false;
  let resolve!: (result: SpawnResult) => void;
  const result = new Promise<SpawnResult>((done) => { resolve = done; });

  function failure(source: string, error: unknown): string {
    const text = `${adapter.name} ${source}: ${error instanceof Error ? error.message : String(error)}`;
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
    settled = true;
    stdout.flush();
    stderr.flush();
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
      exitCode, signal, sessionId, events, finalMessage, lastEventAt,
    });
  }

  try {
    const plan = adapter.plan(request);
    log = openSync(request.logPath, "a");
    child = (options.spawn ?? spawn)(plan.bin, plan.argv, { cwd: plan.cwd, env: plan.env });
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
    child.stdin.end(plan.stdin ?? "");
  } catch (error) {
    failure("launch error", error);
    if (!child) complete(null, null);
  }

  return {
    result,
    kill: (signal = "SIGTERM") => !settled && child !== undefined ? child.kill(signal) : false,
  };
}
