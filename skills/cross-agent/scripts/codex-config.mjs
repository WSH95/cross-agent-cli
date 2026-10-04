import { spawn } from "node:child_process";
import readline from "node:readline";

// Codex owns TOML parsing, comment preservation and compare-and-swap writes.
// This connection creates no conversation or model turn.
export async function configClient(codex, home) {
  const child = spawn(codex, ["app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let next = 0;
  let diagnostic = "";
  let stopped;
  const fail = (error) => {
    stopped = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.stderr.on("data", (data) => { diagnostic = (diagnostic + data).slice(-2000); });
  child.once("error", fail);
  child.stdin.on("error", fail);
  const closed = new Promise((resolve) => child.once("close", (code) => {
    fail(new Error(`Codex app-server exited (${code}): ${diagnostic}`));
    resolve();
  }));
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    } catch (error) { fail(error); }
  });
  function call(method, params) {
    if (stopped) return Promise.reject(stopped);
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex ${method} timed out; check setup before retrying`));
      }, 15000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async function close() {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    await closed;
    clearTimeout(timer);
    lines.close();
  }
  try {
    await call("initialize", { clientInfo: { name: "cross-agent-setup", version: "1" } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    return { call, close };
  } catch (error) {
    await close();
    throw error;
  }
}
