---
updated_at: 2026-09-09T08:21:20Z
updated_by: claude
session_status: closed
branch: task/cross-agent
---

# Handoff

## Now

Branch `task/cross-agent` (worktree `.worktrees/cross-agent`, base `main` @
9f85269). Landed: the rename; `docs/design.md` as the authority (two review
rounds closed); README aligned; `AGENTS.md` updated by user-approved diff
(5a7cd5f, Decision 0006); Task 2a of the lifecycle work — `src/locks.ts`,
async conditional `ledger.update` under the record lock with `{applied}`,
the runner acknowledging only from `launching`, treating `cancelling` as a
cancel (including an engine that completes during a cancel), and holding
`runner-<id>.lock` for its lifetime; identities carry `bootId`. Tests 161.
Beads: S1 `atc-s96.19` closed; S2 `.20` claimed (2a done, 2b in progress);
new `.29` (SIGTERM before the runner's first read), `.30` (a completed
engine over an orphaned record loses its evidence). SDD ledger:
`.superpowers/sdd/the-original-intent-of-rustling-hummingbird/progress.md`
in the main checkout.

## In flight

Task 2b (Opus): `src/reconcile.ts` on the group scan with the `cancelling`
case, stranded-engine adoption by `CROSS_AGENT_TASK` in `/proc/*/environ`,
the spawn pipeline's bounded stdio drain with `truncated`, record validation
and `scan().invalid`. Then its Opus review and a Codex gpt-5.6-sol milestone
review of 2a+2b together, then Task 3 (T6 remainder).

## Next steps

1. Close 2b's reviews; amend the Task 3 brief against the landed signatures;
   dispatch Task 3 (`atc-s96.6`: reservation, `git.lock`, `git_mutate` on
   the verified git-dir, journal, `lockWaitSeconds`).
2. Task 4 (`atc-s96.21`): probe harness flags; probes P8, P9, P10.
3. Engine contract (`.22`), adapters (`.7/.8/.9`), T10/T11, modes (`.23`),
   T12, T13, engine placement (`.24`).

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
