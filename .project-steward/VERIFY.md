# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass, 1 skipped (735 at 827739c) |
| Citations | `node tools/check-citations.mjs` (and `--since <task base>` after a task) | 0 misses; `--since`: 0 drifted, 0 not judged |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-10-01 at 827739c on `main` (T14 merged: `npm test` 735 tests,
734 pass, 1 skipped, from the root; checker 1142 citations, 0 misses; `--since
6a13c0c` 0 drifted, 0 not judged; E5 8 pass, E4 7 pass and a `?` a person read as two
in-worktree patches; `codexI2Real` green under `CROSS_AGENT_REAL_CODEX=1`). The skipped
test is that guarded Codex I2 test. Details per milestone: `VERIFY.md` at the root.
