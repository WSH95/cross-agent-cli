import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface Lock {
  readonly file: string;
  /** Ends the holder, which releases the lock. Calling it again is a no-op. */
  release(): Promise<void>;
}

export interface AcquireOptions {
  /** How long to block before refusing. 0 refuses immediately. */
  waitSeconds?: number;
  /** Named in the refusal, so an operator reads what could not proceed. */
  operation: string;
}

export function lockPath(projectRoot: string, name: string): string {
  return path.resolve(projectRoot, ".cross-agent", "locks", name);
}

export function recordLockName(id: string): string {
  return `record-${id}.lock`;
}

export function runnerLockName(id: string): string {
  return `runner-${id}.lock`;
}

// The lock is flock(2), held by a util-linux `flock` child that stays alive on a pipe.
// Two facts follow, and they are the whole reason for this shape. The child prints
// `held` only once the kernel has granted the lock, so the caller never guesses. And
// the child's stdin is the holder's liveness: closing it, or dying and letting the
// kernel close it, ends the child and releases the lock. So a dead holder needs no
// TTL, no stale detection, no pid check, and no rename — and this helper never
// deletes a lock file, because a file is not the lock.
export async function acquire(file: string, options: AcquireOptions): Promise<Lock> {
  const waitSeconds = options.waitSeconds ?? 5;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const child = spawn("flock", ["-w", String(waitSeconds), file, "sh", "-c", "echo held; read _"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.on("error", () => { /* The holder exits on its own; a broken pipe says so. */ });
  const exit = new Promise<void>((resolve) => { child.once("close", () => resolve()); });

  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const held = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (!output.includes("held")) return;
        child.stdout.off("data", held);
        resolve();
      };
      child.stdout.on("data", held);
      child.once("error", reject);
      // An exit before `held` is flock's refusal: it waited and never got the lock.
      void exit.then(() => reject(new Error(
        `${options.operation}: lock ${file} is held by another process (waited ${waitSeconds}s)`,
      )));
    });
  } catch (error) {
    child.stdin.destroy();
    await exit;
    throw error;
  }

  let released: Promise<void> | undefined;
  return {
    file,
    release(): Promise<void> {
      // The newline ends `read _` even before the pipe's own close reaches the child,
      // so a caller that blocks its loop right after this still frees the lock.
      if (!released) {
        child.stdin.end("\n");
        released = exit;
      }
      return released;
    },
  };
}
