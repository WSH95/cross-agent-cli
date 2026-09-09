# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass, 1 skipped (346 at 45aacf8) |
| Citations | `node tools/check-citations.mjs` | 0 misses (also run by `npm test`) |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-09-09T15:48:03Z at 45aacf8 on `main` (`npm test` 346 pass, 1
skipped, from the root; no leftover runner or fake-engine process;
checker 456 citations, 0 misses). Probes P1, P2 (Codex and Grok), P3,
P3b, P5, P7, P8, P9, P10 recorded; P2 for Claude pending
(`atc-s96.17`). The skipped test is `tests/engines/codex.test.ts`'s I2
placeholder, which needs a real `codex` binary.
