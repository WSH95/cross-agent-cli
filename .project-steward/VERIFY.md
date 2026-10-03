# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass, 1 skipped (769 at 71696ff) |
| Citations | `node tools/check-citations.mjs` (and `--since <task base>` after a task) | 0 misses; `--since`: 0 drifted, 0 not judged |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-10-03 at 6c3e5c3 on `main` (the rename to `cross-agent-cli`, `atc-s96.103`:
`npm test` 933 tests, 932 pass, 1 skipped, from the root; checker 1458 citations, none by line,
0 misses). The skipped test is the guarded Codex I2 test (`CROSS_AGENT_REAL_CODEX=1`, green in T14).
Details per milestone: `VERIFY.md` at the root.
