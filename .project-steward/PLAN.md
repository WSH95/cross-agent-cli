# Plan

Milestones only. Beads owns the tasks: epic `atc-s96`, `bd ready`.

## Codex one-time MCP setup (done 2026-10-04)

`atc-s96.73`: existing launcher skill, installed-version resolver and native Codex
configuration helper implemented; focused, native and full-suite checks pass. Beads holds
the acceptance and execution record; Decision 0017 records the integration choice.

## M0: scaffold and engine probes (done 2026-09-07; P8–P10 added 2026-09-09)

Server skeleton, config loader, fake engine, probe harness (cef9aa5);
probes P1, P2 (Codex, Grok), P3, P3b, P5, P7 and the design changes they
forced (93b9956, 529fc46, dda08d1). P8 (Grok `streaming-messages-json`),
P9 (per-engine lead mount and instruction delivery), P10 (`codex exec
resume` keeps neither cwd nor sandbox) recorded on 2026-09-09 (`atc-s96.21`,
closed). Probe P2 for Claude ran at T13 (`atc-s96.17`, closed).

## M1: core runtime (done 2026-09-19, merged as `bd37e0e`; `VERIFY.md`)

- Done by the OpenMausBot pack: T1 ledger (db75a8f), T2 config and
  worktree verification (975e394), T3 loop guard (3dba529), T4 adapter
  interface and spawn pipeline (464ac65), T5 runner and orphan handling
  (4f39c71).
- Done on 2026-09-09 (branch `task/cross-agent`, merged): the rename to
  `cross-agent` and the design rewritten as the authority (S1, `.19`); the
  lifecycle core — OS-held locks, async conditional `update` with the
  transition table, runner ownership and cancel semantics, `bootId`,
  reconciliation on the group scan with single-write adoption, the spawn
  drain, record validation (S2, `.20`); T6 — reservation, `git_mutate` on
  the verified git-dir, the journal, `lockWaitSeconds` (`.6`).
- Done on 2026-09-18/19 (branch `task/cross-agent-m3`, merged): cite by
  symbol (`.36`); T10 both halves (`.10`, `.10.1`, `.10.2`, `.37`, `.39`,
  `.29`, `atc-vuu`); T11 (`.11`); the M1-close beads (`.44`, `.40`,
  `atc-1p0`, `.31`, `.32`, `.30`, `.38`, `.41`, `.46`) and test hygiene
  (`.33`, `.43`). Plan: `~/.claude/plans/the-development-of-this-calm-planet.md`.

## M2: engine adapters (done 2026-09-09)

Engine contract v2 (S5, `.22`); T7 Claude (`.7`), T8 Codex (`.8`), T9 Grok
(`.9`). Grok is not an engine-placed lead (P9). The one-time §3 citation
refresh after the adapters (`atc-vao`, closed) and the final whole-branch
review's fix (beads `.39`–`.43` for its residuals).

## M3: modes, skills and packaging (done 2026-10-01)

Modes and the worktree workspace provider with the built-in `dev-team` and
`solo` (S8, `.23`); T12 the launcher skill and the mode loops (`.12`); then
T13 Claude Code, T14 Codex, T15 Grok packaging, each with integration probes
I1 and I2 (rewritten around the permission matrix) and an end-to-end run
(`.13`–`.15`; `.13` waits on `.17`); engine placement — `git_root`,
`run_command`, the mailbox, cascade — with the lead on Claude and Codex
(S11, `.24`).

Merged 2026-09-19 as `3023e30` (`VERIFY.md` M3): S8 (`.23`), Task 4b (root git
tools and the journal's named steps, part of `.24`), 4c (`consult`, the
no-config `solo` default, `worktree: true` one-shots; `.27`), T12 (`.12`).
T13 merged 2026-09-19 as `e9cbac0` (`.13`, `.17`, `.52`, `.54`, `.55` closed;
`VERIFY.md` T13 section). Then 6b (pre-flight probes and hardening) as `d428145`,
S11 (the rest of `.24`) as `ebc9960`, T14 as `827739c` and T15 as `157b6b4`, each
with its `VERIFY.md` section.

## M4: operator CLI and decision (done 2026-10-02)

T16 operator CLI (`.16`); the record of the end-to-end runs (`.18`, Decision
0011). On 2026-10-02 the user ruled that the plugin is not the devpack's second
binding: the project follows its own path. T16 merged as `1f57683`, the follow-ups (task 11) as `71696ff`, the final
whole-branch review's fixes as `7bf9731`, and Decision 0011 as `8074e8f`, each with its
`VERIFY.md` section.
