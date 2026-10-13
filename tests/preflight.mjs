// npm test's preflight, run before `node --test` (atc-s96.124). `node --test` reads each
// test file's results from a Node child over a pipe, and many tests read Node children of
// their own, so where a Node child's piped output never arrives, as under Codex's
// workspace-write sandbox, the suite fails and stalls without testing anything. One child
// started the same way finds that out in seconds, and this stops the suite there with the
// cause and what can still be run. The child gets this process's environment unchanged,
// because what it has to show is what `node --test`'s own children will see.
import { spawnSync } from "node:child_process";
import { lostOutputCause, whatStillRuns } from "./lost-output.mjs";

const token = "cross-agent preflight";
const probe = spawnSync(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(token)})`], {
  encoding: "utf8", timeout: 10_000,
});
if (!probe.stdout?.includes(token)) {
  const seen = `stdout ${probe.stdout ? JSON.stringify(probe.stdout) : "empty"}, `
    + (probe.error ? `error ${probe.error.code ?? probe.error.message}` : `exit status ${probe.status}`);
  process.stderr.write([
    `npm test stopped before the suite: a Node child started with piped output sent none back (${seen}).`,
    lostOutputCause,
    whatStillRuns,
  ].join("\n") + "\n");
  process.exit(1);
}
