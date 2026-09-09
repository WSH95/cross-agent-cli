import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquire, gitLockName, lockPath, recordLockName, runnerLockName, spawnLockName } from "../src/locks.ts";

const worktree = fileURLToPath(new URL("../", import.meta.url));
const locksModule = pathToFileURL(path.join(worktree, "src", "locks.ts")).href;

function project(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), "cross-agent-locks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function poll<T>(read: () => T, accepts: (value: T) => boolean, timeout = 4000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = read();
    if (accepts(value)) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for state: ${JSON.stringify(value)}`);
    await delay(10);
  }
}

test("lock names and paths live under the project's lock directory", (t) => {
  const root = project(t);
  assert.equal(recordLockName("abc"), "record-abc.lock");
  assert.equal(runnerLockName("abc"), "runner-abc.lock");
  // The two project-wide locks of design section 2: one name each, so no caller spells them.
  assert.equal(gitLockName(), "git.lock");
  assert.equal(spawnLockName(), "spawn.lock");
  assert.equal(lockPath(root, recordLockName("abc")), path.join(root, ".cross-agent", "locks", "record-abc.lock"));
  assert.equal(lockPath(root, runnerLockName("-leading")), path.join(root, ".cross-agent", "locks", "runner--leading.lock"));
  assert.equal(lockPath(root, gitLockName()), path.join(root, ".cross-agent", "locks", "git.lock"));
  assert.equal(lockPath(root, spawnLockName()), path.join(root, ".cross-agent", "locks", "spawn.lock"));
  assert.equal(path.isAbsolute(lockPath(path.relative(process.cwd(), root), spawnLockName())), true);
});

test("two acquirers of one file serialize, and the directory is created on demand", async (t) => {
  const root = project(t);
  const file = lockPath(root, recordLockName("serialize"));
  assert.equal(fs.existsSync(path.dirname(file)), false, "the lock directory does not exist yet");
  const first = await acquire(file, { operation: "first writer", waitSeconds: 5 });
  assert.equal(first.file, file);
  assert.equal(fs.existsSync(file), true);

  let heldAt: number | undefined;
  const second = acquire(file, { operation: "second writer", waitSeconds: 5 })
    .then((lock) => { heldAt = Date.now(); return lock; });
  await delay(300);
  assert.equal(heldAt, undefined, "the second acquirer is still waiting on the held lock");
  const releasedAt = Date.now();
  await first.release();
  const lock = await second;
  assert.ok(heldAt !== undefined && heldAt >= releasedAt, "the second acquirer is held only after the first released");
  await lock.release();
  // Releasing twice is what a `finally` does when the body already released.
  await lock.release();
  await (await acquire(file, { operation: "third writer", waitSeconds: 1 })).release();
});

test("a lock held by a SIGKILLed process is taken by the next holder with no reclaim", async (t) => {
  const root = project(t);
  const file = lockPath(root, runnerLockName("killed"));
  const marker = path.join(root, "held");
  const holder = path.join(root, "holder.mjs");
  fs.writeFileSync(holder, `
import fs from "node:fs";
import { acquire } from ${JSON.stringify(locksModule)};
await acquire(${JSON.stringify(file)}, { operation: "holder", waitSeconds: 5 });
fs.writeFileSync(${JSON.stringify(marker)}, "held");
setInterval(() => {}, 1 << 30);
`);
  const child = spawn(process.execPath, [holder], { stdio: "ignore" });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await poll(() => fs.existsSync(marker), Boolean);
    await assert.rejects(acquire(file, { operation: "waiter", waitSeconds: 0 }), /held by another process/);
    child.kill("SIGKILL");
    await closed;
    // No stale detection, no TTL, no rename: the kernel released it when the holder died.
    const started = Date.now();
    const lock = await acquire(file, { operation: "next holder", waitSeconds: 5 });
    assert.ok(Date.now() - started < 1000, "the next holder waits less than a second");
    assert.equal(fs.existsSync(file), true, "the lock file itself is never deleted");
    await lock.release();
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
});

test("a waiter refuses after its wait, naming the operation and the file", async (t) => {
  const root = project(t);
  const file = lockPath(root, recordLockName("busy"));
  const holder = await acquire(file, { operation: "holder", waitSeconds: 5 });
  try {
    const started = Date.now();
    await assert.rejects(
      acquire(file, { operation: "update task busy", waitSeconds: 1 }),
      (error: Error) => error.message === `update task busy: lock ${file} is held by another process (waited 1s)`,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 900, `waited ${elapsed}ms, which is about the requested second`);
    assert.ok(elapsed < 3000, `waited ${elapsed}ms, which is not far past the requested second`);
  } finally {
    await holder.release();
  }
});

/** The util-linux child that actually holds a lock, found by the file on its command line. */
function holderOf(file: string): number | null {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const argv = cmdline.split("\0");
    if (argv[0]?.endsWith("flock") && argv.includes(file)) return Number(entry);
  }
  return null;
}

test("a holder that dies before its release reports the lock lost", { timeout: 20000 }, async (t) => {
  const root = project(t);
  const file = lockPath(root, runnerLockName("task"));
  const lost: string[] = [];
  const lock = await acquire(file, { operation: "hold a lock", onLost: () => lost.push("lost") });
  // Held locks keep a live child on a pipe, so a failed assertion must not leave one.
  t.after(() => lock.release());
  assert.equal(lock.lost, false);
  const holder = await poll(() => holderOf(file), (pid) => pid !== null);

  // The kernel releases the lock when its holder dies, so a caller that believed it
  // owned something exclusive has to be told it no longer does.
  process.kill(holder!, "SIGKILL");
  await poll(() => lock.lost, Boolean);
  assert.deepEqual(lost, ["lost"]);
  const next = await acquire(file, { operation: "take the freed lock", waitSeconds: 0 });
  await next.release();

  const quiet: string[] = [];
  const released = await acquire(file, { operation: "hold and release", onLost: () => quiet.push("lost") });
  t.after(() => released.release());
  await released.release();
  await delay(50);
  assert.equal(released.lost, false, "a release this caller asked for is not a loss");
  assert.deepEqual(quiet, []);
});
