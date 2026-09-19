# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass, 1 skipped (617 at e9cbac0) |
| Citations | `node tools/check-citations.mjs` (and `--since <task base>` after a task) | 0 misses; `--since`: 0 drifted, 0 not judged |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-09-19 at e9cbac0 on `main` (`npm test` 617 tests, 616
pass, 1 skipped, from the root; checker 823 citations, 0 misses; `--since
3023e30` and `--since 39505aa` 0 drifted, 0 not judged; `node
tools/e2e-verify.mjs --project ~/.cache/agent-team/cross-agent-e2e/slugkit`
8 pass). Probes P1–P10 recorded, P2 for Claude at T13 (three rows); I1 and
I2 for Claude and Grok; E1. Every Codex row is not run (paused by the user,
2026-09-18). The skipped test is the Codex I2 test, written and guarded
behind `CROSS_AGENT_REAL_CODEX=1`. Details per milestone: `VERIFY.md` at the
root.
