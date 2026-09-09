---
updated_at: 2026-09-09T07:22:59Z
updated_by: claude
session_status: closed
branch: task/cross-agent
---

# Handoff

## Now

Branch `task/cross-agent` (worktree `.worktrees/cross-agent`, base `main` @
9f85269) carries: the rename (9d648b2); `docs/design.md` rewritten as the
authority and closed after two review rounds (b446d32, 59ec7f5, 99d19ce);
the README aligned (9fa1540, one fix round pending); and Task 2a of the
lifecycle work (45ee841..3a28be7): `src/locks.ts` (OS-held flock on a pipe),
`ledger.update` async and conditional under the record lock with an
`{applied}` result, the runner acknowledging only from `launching`,
treating `cancelling` as a cancel, and holding `runner-<id>.lock` for its
lifetime; identities carry `bootId`. Tests 146 → 159. The SDD ledger is
`.superpowers/sdd/the-original-intent-of-rustling-hummingbird/progress.md`
in the main checkout. Beads: S1 `atc-s96.19` in progress; S2 `.20` half
done; new bug `.29` (SIGTERM before the runner's first record read).

## In flight

Task 2a's Opus review and Task 1c's README fix round, in parallel. Then
Task 2b (reconcile on the group scan, stranded-engine adoption, spawn
drain, record validation). The AGENTS.md rename/Layout diff awaits the
user's approval (`.superpowers/sdd/.../agents-md-proposed.diff`).

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
