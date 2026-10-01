# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass, 1 skipped (703 at ebc9960) |
| Citations | `node tools/check-citations.mjs` (and `--since <task base>` after a task) | 0 misses; `--since`: 0 drifted, 0 not judged |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-10-01 at ebc9960 on `main` (S11 merged: `npm test` 703 tests,
702 pass, 1 skipped, from the root; checker 1011 citations, 0 misses; `--since
886ae9f` 0 drifted, 0 not judged; E3, E2, E2b and E2c each 7 pass and a `?` a
person read as no launch, depth and lineage PASS). The skipped test is the Codex
I2 test, guarded behind `CROSS_AGENT_REAL_CODEX=1`; T14 runs it. Details per
milestone: `VERIFY.md` at the root.
