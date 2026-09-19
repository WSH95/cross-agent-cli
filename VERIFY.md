# Verification record

What `npm test` and the recorded runs showed at each milestone merge into
`main`. Counts live here, not in the README (Decision 0008). Raw engine
transcripts stay in `docs/probes.md`.

## M1 — core runtime plus the delegation tools (merged 2026-09-19)

| what | value |
|---|---|
| `main` after the merge | `bd37e0e` (fast-forward of `task/cross-agent-m3`, 33 commits over `cf49bd8`) |
| `npm test` at the root | 468 tests: 467 pass, 0 fail, 1 skipped (`tests/engines/codex.test.ts`, the I2 placeholder that needs a real `codex` binary) |
| citation checker | 609 citations in 2 files (304 by line, 305 by symbol), 0 misses |
| load acceptance (Task 3c) | ten consecutive `npm test` runs on the branch under 8-core load, all 467/0/1, 1029 s wall |

Landed: cite-by-symbol citations and the lexer-aware checker (`atc-s96.36`);
authority by process ancestry, project discovery and tools by
permission-matrix row (T10a); `delegate`, `check`, `result`, `cancel` with
its cascade, `list_tasks`, the outcome sidecar, `sandboxSupport(env)`, the
per-task scratch directory, prefix reservations, resume chains (T10b and
its folds); `wait` with stall detection and `notifications/cancelled`
(T11); the M1-close beads (`atc-s96.44`, `.40`, `atc-1p0`, `.31`, `.32`,
`.30`, `.38`, `.41`, `.46`) and the test-hygiene pass (`.33`, `.43`).

Probes rerun this milestone: P1 on 2026-09-18 — with the docs' AppArmor
profile installed and Ubuntu's stock `bwrap-userns-restrict` disabled, a
sandboxed `curl` from a `claude -p` child returned 200 on the first call;
before the fix the child escaped a failed sandboxed command with
`dangerouslyDisableSandbox: true`, which the adapter now forbids
(`sandbox.allowUnsandboxedCommands: false`). Details in `docs/probes.md`.

Not run yet: probe P2 for Claude (`atc-s96.17`, runnable now), the
integration probes I1 and I2, every end-to-end run (E1–E7). Grok's
`--prompt-file` fallback is `--help`-verified only (T15).

## M3 — modes, root git tools, solo, the launcher and the loops (merged 2026-09-19)

| what | value |
|---|---|
| `main` after the merge | `3023e30` (fast-forward of `task/cross-agent-m3`, 20 commits over `ff1cf55`) |
| `npm test` at the root | 586 tests: 585 pass, 0 fail, 1 skipped (the Codex I2 placeholder) |
| citation checker | 795 citations in 2 files (334 by line, 461 by symbol), 0 misses |

Landed: modes and the worktree provider with `describe_mode` and `init
--mode` (S8, `atc-s96.23`); `git_root`, `run_command` and the journal's
named steps (Task 4b, part of `.24`); the built-in `consult` role, the
no-config `solo` default and `worktree: true` one-shots (`.27`); the
launcher skill, the `dev-team` loop, the role prompts through the one-off
converter, and `delegate` launching a role with the mode's own prompt
(T12, `.12`).

Probes rerun this milestone: none.

Not run yet: probe P2 for Claude (`atc-s96.17`, at T13), I1, I2, E1–E7.
Codex is paused by the user (2026-09-18): T13 records its Codex rows as
not run, each with the command that runs it later.
