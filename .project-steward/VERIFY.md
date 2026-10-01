# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass, 1 skipped (742 at 157b6b4) |
| Citations | `node tools/check-citations.mjs` (and `--since <task base>` after a task) | 0 misses; `--since`: 0 drifted, 0 not judged |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-10-01 at 157b6b4 on `main` (T15 merged: `npm test` 742 tests,
741 pass, 1 skipped, from the root; checker 1199 citations, 0 misses; `--since
e436132` 0 drifted, 0 not judged; E6 and E7 each 8 pass under a Grok host, E7's
depth-and-lineage reading PASS). The skipped test is the guarded Codex I2 test
(`CROSS_AGENT_REAL_CODEX=1`, green in T14). Details per milestone: `VERIFY.md` at the
root.
