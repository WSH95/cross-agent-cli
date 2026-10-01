# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass, 1 skipped (659 at d428145) |
| Citations | `node tools/check-citations.mjs` (and `--since <task base>` after a task) | 0 misses; `--since`: 0 drifted, 0 not judged |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-10-01 at d428145 on `main` (task 6b merged: `npm test` 659
tests, 658 pass, 1 skipped, from the root; checker 909 citations, 0 misses;
`--since cb87b01` 0 drifted, 0 not judged; `node tools/e2e-verify.mjs --project
~/.cache/agent-team/cross-agent-e2e/slugkit` 8 pass; `node --test
tests/e2e-verify.test.ts` 40/40). The skipped test is the Codex I2 test, guarded
behind `CROSS_AGENT_REAL_CODEX=1`; T14 runs it. Details per milestone: `VERIFY.md`
at the root.
