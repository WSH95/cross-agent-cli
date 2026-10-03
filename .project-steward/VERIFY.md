# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass, 1 skipped (769 at 71696ff) |
| Citations | `node tools/check-citations.mjs` (and `--since <task base>` after a task) | 0 misses; `--since`: 0 drifted, 0 not judged |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-10-03 at 1c75090 on `main` (T13, a branch worktree as a project of its own,
`atc-s96.97`: `npm test` 933 tests, 932 pass, 1 skipped, from the root; checker 1458 citations,
none by line, 0 misses; `--since 66e8815` 0 drifted, 0 not judged; E10 8 pass in both projects).
The skipped test is the guarded Codex I2 test (`CROSS_AGENT_REAL_CODEX=1`, green in T14).
Details per milestone: `VERIFY.md` at the root.
