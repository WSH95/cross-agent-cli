// Loaded with `node --import` ahead of another script — a fake engine, or a bare
// link — so that the process it starts is that script's own child. A test builds
// the ancestry a server would sit under this way: engine → wrapper … → server.
//   SPAWN_CHAIN: the path of a JSON array of links, each {argv: [file, ...args], env, pidFile?}
//     argv and env: that link's command line and its whole environment.
//     pidFile: where its parent writes its pid, for a test that needs its identity.
//   SPAWN_CHAIN_AT: this process's own index in that array.
// This process starts link AT+1, with the two variables added to its environment, and
// nothing when it is the last. The chain lives in a file because nesting each child's
// JSON inside its parent's environment doubles the escaping at every level: fourteen
// links already exceed the kernel's 128 KiB limit on one string. A file keeps every
// link's environment the same size however long the chain is.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

if (process.env.SPAWN_CHAIN !== undefined) {
  const links = JSON.parse(readFileSync(process.env.SPAWN_CHAIN, "utf8"));
  const at = Number(process.env.SPAWN_CHAIN_AT);
  const next = links[at + 1];
  if (next !== undefined) {
    const child = spawn(next.argv[0], next.argv.slice(1), {
      stdio: "ignore", env: { ...next.env, SPAWN_CHAIN: process.env.SPAWN_CHAIN, SPAWN_CHAIN_AT: String(at + 1) },
    });
    if (next.pidFile) writeFileSync(next.pidFile, String(child.pid));
  }
}
