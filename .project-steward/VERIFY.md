# Verification

Run the relevant checks before marking work as verified in `HANDOFF.md`.

| Check | Command | Expected |
| --- | --- | --- |
| Build | `none` | exits 0 |
| Tests | `npm test` | all pass (146 at 4f39c71) |
| Lint | `none` | clean |
| Engine probes | `node tools/probe.mjs --engine <e> --cwd <dir> …` | recorded in `docs/probes.md` |

Last verified: 2026-09-07T21:21Z at 4f39c71 (`npm test` 146/146 from the
root, no leftover runner or fake-engine process). Probes P1, P2 (Codex and
Grok), P3, P3b, P5, P7 recorded; P2 for Claude pending.
