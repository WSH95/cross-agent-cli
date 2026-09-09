---
updated_at: 2026-09-09T14:08:21Z
updated_by: claude
session_status: closed
branch: task/cross-agent
---

# Handoff

## Now

Branch `task/cross-agent` (worktree `.worktrees/cross-agent`, base `main` @
9f85269). Landed and reviewed: rename; `docs/design.md` as the authority
(current through §3 as built; `tools/check-citations.mjs` under `npm
test`); README; `AGENTS.md` by two approved diffs (Decisions 0006, 0007);
the lifecycle core (S2, closed); probes P8–P10 (S4, closed); T6 (closed);
the engine contract v2 (S5, closed); the Claude adapter (T7, closed at
90fd4d6). Landed, under review: the Codex adapter (T8, aa3e8bc — 323 tests
+ 1 skipped I2 placeholder). Beads this session: `.29`–`.36`, `atc-n85`
(closed), `atc-vuu`, `atc-7bj`, `atc-2q4` (closed), `atc-vao`, `atc-6sl`,
`atc-540`. SDD ledger:
`.superpowers/sdd/the-original-intent-of-rustling-hummingbird/progress.md`
(main checkout).

## In flight

T8's fix round (the Codex prompt on stdin with `-`; the mount's files
folded; a whole-argv `off` case) and T9, the Grok adapter
(`streaming-messages-json`, `--rules`, the deny list, the fixture
rewritten), on disjoint files. Bead `atc-s96.37` (per-task `scratchDir`)
filed for T10 and the design.

## Next steps

The operator's instruction for this session's close: once T8 and T9 clear
review — (1) Task 9d, the one §3 refresh (`atc-vao`); (2) a final
whole-branch review and a full `npm test`; (3) `git merge --ff-only
task/cross-agent` into `main`, the suite on `main`; (4) the handover
(HANDOFF, PROGRESS, VERIFY, PLAN, QUESTIONS; beads closed; DECISIONS 0008
listing every ruling); (5) remove the worktree and delete the branch. No
push. After that, the next work is T10 (two halves, briefs drafted), T11,
modes, T12, T13 (needs `.17`), engine placement.

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
