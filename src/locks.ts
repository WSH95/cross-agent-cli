import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface Lock {
  readonly file: string;
  /**
   * True once the holder has gone without this caller releasing it: the kernel has
   * dropped the lock and whatever it protected is no longer this caller's alone.
   */
  readonly lost: boolean;
  /** Ends the holder, which releases the lock. Calling it again is a no-op. */
  release(): Promise<void>;
}

export interface AcquireOptions {
  /** How long to block before refusing. 0 refuses immediately. */
  waitSeconds?: number;
  /** Named in the refusal, so an operator reads what could not proceed. */
  operation: string;
  /** Called once if the lock is lost, so a long-lived holder can give up what it owned. */
  onLost?: () => void;
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

/** Serializes the lead's git mutations against each other (design section 4, step 3). */
export function gitLockName(): string {
  return "git.lock";
}

/** Serializes delegate's validate-and-spawn, so two hosts cannot both pass one check. */
export function spawnLockName(): string {
  return "spawn.lock";
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
  let lost = false;
  // The child is the lock. If it goes while this caller still believes it holds it —
  // killed, or lost to an error nobody saw — the kernel has already let the next waiter
  // in, and a holder that carried on would be acting on exclusivity it no longer has.
  void exit.then(() => {
    if (released) return;
    lost = true;
    try {
      options.onLost?.();
    } catch { /* The caller's own failure is not this helper's to handle. */ }
  });
  return {
    file,
    get lost() { return lost; },
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
