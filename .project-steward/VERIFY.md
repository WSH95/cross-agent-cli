# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass; guarded live probes may skip |
| Native Codex setup | `CODEX_SETUP_PROBE=/absolute/path/to/codex node --test tests/codex-native.test.ts` | isolated install, policy repair, per-chat roots and removal pass |
| Citations | `node tools/check-citations.mjs` (and `--since <task base>` after a task) | 0 misses; `--since`: 0 drifted, 0 not judged |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-10-04 for `atc-s96.73`: `npm test` 1047 tests, 1045 pass, 0 fail,
2 guarded skips (real Codex I2 and the opt-in native setup probe). The latter passed
separately on Codex 0.160.0, Node 24.11.0 and Linux. Focused setup/skill checks: 66/66.
Citation checker: 1643 citations, 0 misses, 0 drifted since d2064f5, 0 not judged.
One full run hit the existing server reconciliation deadline; that file passed 46/46
in isolation and the unchanged full-suite rerun passed. Do not remove shared `/tmp/.git`:
readable empty ancestor git directories are now skipped (`atc-s96.106`).
Details per milestone: `VERIFY.md` at the root.
