// The text npm test's preflight (tests/preflight.mjs) and each test file's check
// (tests/child-check.mjs) print where a Node child's piped output is lost: its cause and what
// still runs. It lives here, with no effect of its own, because each script runs on import:
// the check importing the preflight would run its probe, and the preflight importing the check
// would run the check in the preflight's own process.

export const lostOutputCause = "The likely cause is a sandbox that filters socket calls. Codex's workspace-write sandbox does: its network filter denies the getsockopt Node makes on a piped stdout, so a Node child discards all it writes. node --test reads each test file's results over such a pipe, and many tests read Node children of their own, so here the suite would fail and stall without testing the change.";

export const whatStillRuns = "What still runs here: one file in this process, node --test --test-isolation=none tests/<concern>.test.ts. Its tests that read a Node child's output fail or time out because of the sandbox, not the change. The gate's run of the branch head, outside any sandbox, decides the suite.";
