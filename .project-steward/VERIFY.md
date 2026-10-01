# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass, 1 skipped (723 at 1f57683) |
| Citations | `node tools/check-citations.mjs` (and `--since <task base>` after a task) | 0 misses; `--since`: 0 drifted, 0 not judged |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-10-01 at 1f57683 on `main` (T16 merged: `npm test` 723 tests,
722 pass, 1 skipped, from the root; checker 1083 citations, 0 misses; `--since
a8d1577` 0 drifted, 0 not judged; no engine run, every proof a seeded ledger, a bare
repository or a test). The skipped test is the Codex I2 test, guarded behind
`CROSS_AGENT_REAL_CODEX=1`; T14 runs it. Details per milestone: `VERIFY.md` at the
root.
