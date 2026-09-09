---
updated_at: 2026-09-09T14:58:24Z
updated_by: claude
session_status: active
branch: task/cross-agent
---

# Handoff

## Now

Branch `task/cross-agent` (worktree `.worktrees/cross-agent`, base `main` @
9f85269). Landed and reviewed: rename; `docs/design.md` as the authority
(`tools/check-citations.mjs` under `npm test`); README; `AGENTS.md` by
three approved diffs (Decisions 0006, 0007, 0009); the lifecycle core (S2);
probes P8–P10 (S4); T6; the engine contract v2 (S5); the three adapters —
Claude (T7, 90fd4d6), Codex (T8, 1a20cc8), Grok (T9, 992a830) — 343 tests
+ 1 skipped (the I2 placeholder). The final whole-branch review (Opus,
9f85269..fd36d21) found no Critical defect: three Important (the reconcile
flake `atc-7bj`; the runner's environ check counting itself and ignoring
unreadable candidates; nothing enforcing `CROSS_AGENT_TASK` in the engine
env) and six Minor. Residuals beaded: `atc-s96.39`–`.43`, `.10.1`, `.10.2`.
SDD ledger (rulings):
`.superpowers/sdd/the-original-intent-of-rustling-hummingbird/progress.md`
(main checkout); DECISIONS 0008 drafted at the session scratchpad.

## In flight

Task 9d, the §3 refresh (`atc-vao`, `atc-6sl`, `atc-540`): `5a70d24`
committed, `docs/probes.md` still being edited. Queued behind it: the one
fix dispatch for the final review's I1/I2/I3/M2/M6
(`task-final-fix-brief.md`) and a scoped re-review; a scoped review of 9d.

## Next steps

The operator's close sequence, after the fix and both reviews: a full
`npm test` on the branch; `git merge --ff-only task/cross-agent` into
`main` and the suite on `main`; the handover (HANDOFF, PROGRESS, VERIFY,
PLAN, QUESTIONS; beads closed; DECISIONS 0008 from the scratchpad draft);
remove the worktree and delete the branch. No push. After that, the next
work is T10 (two halves briefed; `.10.1`/`.10.2` fold in), T11, modes,
T12, T13 (needs `.17`), engine placement.

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
