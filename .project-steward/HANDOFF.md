---
updated_at: 2026-09-07T21:55:56Z
updated_by: claude
session_status: closed
branch: main
---

# Handoff

## Now

The repository is at 4f39c71 plus documentation and setup commits (dda08d1
probes, 993b24a Beads init, then the steward state). T1 to T5 of the
design's task series are merged and green (146 tests); they were built by
the OpenMausBot dev-team pack as that pack's validation run (Decision
0003). From here the operator's own CLI sessions build T6 onward, tracked
in Beads (epic `atc-s96`, `bd ready`).

## In flight

Nothing.

## Next steps

1. Install the bwrap AppArmor profile from Claude Code's sandboxing docs
   (needs sudo), then run probe P2 for Claude (`atc-s96.17`) with
   `tools/probe.mjs` and record the row in `docs/probes.md`.
2. T6 (`atc-s96.6`): OS-held locks, reservation, `git_mutate`, journal; its
   bead description is the brief; design sections 2, 4, 7.
3. Then T7 to T9 adapters (T7 needs the Claude probe), T10, T11, T12, the
   packaging tasks with their end-to-end runs, T16, and the go or no-go
   decision (`atc-s96.18`).

## Blockers

Probe P2 for Claude waits on the AppArmor profile (`docs/probes.md`, P1
rerun; `QUESTIONS.md`).

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
