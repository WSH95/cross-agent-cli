---
updated_at: 2026-09-09T06:40:07Z
updated_by: claude
session_status: closed
branch: task/cross-agent
---

# Handoff

## Now

The plugin is being renamed to `cross-agent` and generalized on branch
`task/cross-agent` (worktree `.worktrees/cross-agent`, base `main` @ 9f85269).
Landed on the branch: the mechanical rename (9d648b2) and the rewrite of
`docs/design.md` as the authority for the lead model, modes, ancestry-bound
authority, and the lifecycle target (b446d32). The plan being executed is
`~/.claude/plans/the-original-intent-of-rustling-hummingbird.md`; its ledger
is `.superpowers/sdd/the-original-intent-of-rustling-hummingbird/progress.md`
in the main checkout. Beads: S1 `atc-s96.19` (in progress), S2 `.20`, S4
`.21`, S5 `.22`, S8 `.23`, S11 `.24`, backlog `.25`–`.28`; T6–T16 amended.

## In flight

Task 1b's design rewrite went through two review rounds (Opus task review,
Codex gpt-5.6-sol milestone review, two scoped re-reviews): fix round 1
(59ec7f5) settled the depth cap versus ancestry rule, positive operator
provenance, the authority walk, and nine contracts; fix round 2 (99d19ce)
closed the remaining factual minors. The round-2 re-review is running; Task
1c (README) follows, then the AGENTS.md approval diff is presented.

## Next steps

1. Close the 1b reviews; fix round if needed; then Task 1c (README).
2. Task 2a then 2b (bead `atc-s96.20`): locks primitive, conditional
   `update`, reconcile on the group scan, spawn drain, record validation.
3. T6 remainder (`.6`), probes P8/P9 (`.21`), engine contract (`.22`),
   adapters, T10/T11, modes (`.23`), T12, T13, engine placement (`.24`).
4. Present the held `AGENTS.md` diff (rename + Layout correction) for
   approval once the design is final.

## Blockers

Probe P2 for Claude still waits on the bwrap AppArmor profile (`atc-s96.17`).

## Key files

- `docs/design.md`: the authority; sections 1 to 10 plus the work plan.
- `docs/probes.md`: what each engine CLI does, with commands.
- `src/`: server, config, worktree, guard, ledger, runner, process, and
  `engines/` (types, spawn); `tests/` mirrors it;
  `tests/fixtures/fake-engine.mjs` stands in for a CLI.
- `tools/probe.mjs`: manual engine probe harness (not product code).

## Tried and rejected

- An `O_EXCL` lock file with a TTL and a rename-based reclaim (refuted in
  T5's plan review; Decision 0004).
- A per-process witness cache for engine group liveness (missed descendants
  of a reaped leader; replaced by a kernel pgid and session scan).
- Moving the probe harness onto the adapter interface at T4 (kept manual).
- Execpolicy rules files as a Codex deny layer (`codex exec` ignores them).

## Warnings

- Never push. Commit policy auto for checkpoints, Conventional Commits.
- Projects under `/tmp` or `$TMPDIR` are not isolated by the Codex or Grok
  sandbox.
- Tests that spawn processes need to run outside Codex's sandbox.
- `AGENTS.md` and `CLAUDE.md` carry managed blocks (Project Steward and
  Beads); edit only outside them or through the tools.
