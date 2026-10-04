# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass, 1 skipped (769 at 71696ff) |
| Citations | `node tools/check-citations.mjs` (and `--since <task base>` after a task) | 0 misses; `--since`: 0 drifted, 0 not judged |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-10-03 at 7de15c0 on `main` (`atc-s96.104`, N code reviewer seats, the resolver and the
two merge guards: `npm test` 1006 tests, 1005 pass, 1 skipped, from the root; checker 1608 citations, none
by line, 0 misses; 1631 with E11's record at c4ca8e5). The skipped test is the guarded Codex I2 test
(`CROSS_AGENT_REAL_CODEX=1`, green in T14). Remove an empty `/tmp/.git` before running the suite: Codex's
sandbox leaves one, and the suite fails or hangs while it exists (`atc-s96.106`).
Details per milestone: `VERIFY.md` at the root.
