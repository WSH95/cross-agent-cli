# Plan

Milestones only. Beads owns the tasks: epic `atc-s96`, `bd ready`.

## M0: scaffold and engine probes (done 2026-09-07)

Server skeleton, config loader, fake engine, probe harness (cef9aa5);
probes P1, P2 (Codex, Grok), P3, P3b, P5, P7 and the design changes they
forced (93b9956, 529fc46, dda08d1). Open: probe P2 for Claude, blocked on
the bwrap AppArmor profile (`atc-s96.17`).

## M1: core runtime

- Done by the OpenMausBot pack: T1 ledger (db75a8f), T2 config and
  worktree verification (975e394), T3 loop guard (3dba529), T4 adapter
  interface and spawn pipeline (464ac65), T5 runner and orphan handling
  (4f39c71).
- Open: T6 OS-held locks, reservation, `git_mutate`, journal (`atc-s96.6`);
  T10 delegate, check, result, cancel (`atc-s96.10`); T11 wait with stall
  detection (`atc-s96.11`).

## M2: engine adapters

T7 Claude (`atc-s96.7`, after the Claude probe), T8 Codex (`atc-s96.8`),
T9 Grok (`atc-s96.9`); all after T6.

## M3: skill and packaging

T12 skill and role prompts (`atc-s96.12`), then T13 Claude Code, T14 Codex,
T15 Grok packaging, each followed by integration probes I1 and I2 and one
end-to-end slugkit task with that host as the lead (`atc-s96.13` to `.15`).

## M4: operator CLI and decision

T16 operator CLI (`atc-s96.16`); go or no-go for the plugin as the second
binding (`atc-s96.18`).
