// npm test's preflight, run before `node --test` (atc-s96.124). `node --test` reads each
// test file's results from a Node child over a pipe, and many tests read Node children of
// their own, so where a Node child's piped output never arrives, as under Codex's
// workspace-write sandbox, the suite fails and stalls without testing anything. One child
// started the same way finds that out in seconds, and this stops the suite there with the
// cause and what can still be run. The child gets this process's environment unchanged,
// because what it has to show is what `node --test`'s own children will see.
import { spawnSync } from "node:child_process";

const token = "cross-agent preflight";
const probe = spawnSync(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(token)})`], {
  encoding: "utf8", timeout: 10_000,
});
if (!probe.stdout?.includes(token)) {
  const seen = `stdout ${probe.stdout ? JSON.stringify(probe.stdout) : "empty"}, `
    + (probe.error ? `error ${probe.error.code ?? probe.error.message}` : `exit status ${probe.status}`);
  process.stderr.write([
    `npm test stopped before the suite: a Node child started with piped output sent none back (${seen}).`,
    "The likely cause is a sandbox that filters socket calls. Codex's workspace-write sandbox does: its network filter denies the getsockopt Node makes on a piped stdout, so a Node child discards all it writes. node --test reads each test file's results over such a pipe, and many tests read Node children of their own, so here the suite would fail and stall without testing the change.",
    "What still runs here: one file in this process, node --test --test-isolation=none tests/<concern>.test.ts. Its tests that read a Node child's output fail or time out because of the sandbox, not the change. The gate's run of the branch head, outside any sandbox, decides the suite.",
  ].join("\n") + "\n");
  process.exit(1);
}
