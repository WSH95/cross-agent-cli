# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass, 1 skipped (769 at 71696ff) |
| Citations | `node tools/check-citations.mjs` (and `--since <task base>` after a task) | 0 misses; `--since`: 0 drifted, 0 not judged |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-10-02 at 8074e8f on `main` (the close of the plan: `npm test` 813 tests,
812 pass, 1 skipped, from the root; checker 1306 citations, none by line, 0 misses;
`--since 4bcc986` 0 drifted, 0 not judged; Decision 0011, go with conditions). The skipped
test is the guarded Codex I2 test (`CROSS_AGENT_REAL_CODEX=1`, green in T14).
Details per milestone: `VERIFY.md` at the root.
