---
updated_at: 2026-09-09T10:52:11Z
updated_by: claude
session_status: closed
branch: task/cross-agent
---

# Handoff

## Now

Branch `task/cross-agent` (worktree `.worktrees/cross-agent`, base `main` @
9f85269). Landed and reviewed: rename; `docs/design.md` as the authority,
amended by Task 2c (faf3a8a) with the lifecycle rulings, the P8–P10
outcomes, and the ruling that Grok is not an engine-placed lead; README;
`AGENTS.md` by approved diff (Decision 0006); the whole lifecycle core —
S2 (`atc-s96.20`, closed): locks, async conditional `update` with the
transition table, runner ownership and cancel semantics, `bootId`,
`src/reconcile.ts` (group scan, single-write adoption, see-vs-signal rule,
per-record boundary), spawn drain with `truncated`, record validation —
199 tests at e426f35; probes P8/P9/P10 (S4 `.21`, closed). Beads filed
this session: `.29`–`.32`. SDD ledger:
`.superpowers/sdd/the-original-intent-of-rustling-hummingbird/progress.md`
(main checkout).

## In flight

The Opus review of Task 3 (`atc-s96.6`): `limits.lockWaitSeconds`,
`src/reservation.ts`, `src/journal.ts`, `src/gitmutate.ts` on the verified
git-dir under `git.lock` — six commits 58b90cf..69f3eac, 224 tests. Two
rulings from its report are in the reviewer's constraints: an `off`
sandbox reserves (it can write anywhere); `defaultShaBeforeMerge` is
written once. Task 2c (design amendment) is complete after two rounds
(faf3a8a, 17a635c, 2395d57). Beads filed by Task 3: `.33`, `.34`, `.35`.

## Next steps

1. Close Task 3's review (fix round if needed); close `.6`.
2. In parallel: Task 3d (design sweep for T6, docs only — brief at
   `.superpowers/sdd/.../task-3d-brief.md`) and Task 5 (`.22`, engine
   contract v2 — brief at `.../task-5-brief.md`).
3. Adapters `.7/.8/.9`, T10/T11 (`.10/.11`), modes (`.23`), T12, T13,
   engine placement (`.24`, Claude and Codex leads).

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
