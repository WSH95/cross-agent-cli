// Loaded with `node --import` ahead of another script — a fake engine, or a bare
// link — so that the process it starts is that script's own child. A test builds
// the ancestry a server would sit under this way: engine → wrapper … → server.
//   SPAWN_CHILD: JSON {argv: [file, ...args], env, pidFile?}
//     argv and env: the child's command line and its whole environment.
//     pidFile: where to write the child's pid, for a test that needs its identity.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

if (process.env.SPAWN_CHILD !== undefined) {
  const { argv, env, pidFile } = JSON.parse(process.env.SPAWN_CHILD);
  const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", env });
  if (pidFile) writeFileSync(pidFile, String(child.pid));
}
