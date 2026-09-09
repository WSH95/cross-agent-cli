---
updated_at: 2026-09-09T09:52:38Z
updated_by: claude
session_status: closed
branch: task/cross-agent
---

# Handoff

## Now

Branch `task/cross-agent` (worktree `.worktrees/cross-agent`, base `main` @
9f85269). Landed: rename; `docs/design.md` as the authority; README;
`AGENTS.md` by approved diff (Decision 0006); Task 2a (locks, conditional
`update`, runner ownership) and Task 2b (`src/reconcile.ts` on the group
scan, stranded-engine adoption by `CROSS_AGENT_TASK`, spawn drain with
`truncated`, record validation and `scan().invalid`) — 176 tests at 71b2450;
Task 4's probes (397763c, 649b8e5): P8 adopts `streaming-messages-json` for
Grok; P9 Claude mounts cleanly, Codex needs a third `-c`
(`default_tools_approval_mode`), Grok cannot be isolated per run; P10
`codex exec resume` keeps neither cwd nor sandbox (`-c sandbox_mode=`
restores it). Ruling: Grok is not an engine-placed lead. Beads: S1 closed;
S2 `.20` and S4 `.21` claimed; bugs `.29`, `.30`. SDD ledger:
`.superpowers/sdd/the-original-intent-of-rustling-hummingbird/progress.md`
(main checkout).

## In flight

2b fix round 2 (one regression from round 1: the self-exclusion must apply
to signalling, never to seeing — a reconciler inside an engine's session
was writing `failed: launch` over that live engine; plus a `killStrays`
rethrow). Task 2c: `docs/design.md` amendment with the §2 rulings, the
P8–P10 outcomes, and the ruling that Grok is not an engine-placed lead.
Task 4 is complete (bead `.21` closed; 397763c, 649b8e5, f40cadb).

## Next steps

1. 2b round-2 re-review; close `.20`. Review Task 2c.
2. Task 3 (`atc-s96.6`): reservation, `git.lock`, `git_mutate` on the
   verified git-dir, journal, `lockWaitSeconds` — brief confirmed.
3. Engine contract (`.22`; adapters' `sandboxProfiles`, `leadMount` with
   Codex's three `-c` keys, `finish`), adapters (`.7/.8/.9` — beads carry
   the probe facts), T10/T11, modes (`.23`), T12, T13, engine placement
   (`.24`, Claude and Codex leads only).

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
