---
updated_at: 2026-09-19T07:24:03Z
updated_by: claude
session_status: closed
branch: main
---
# Handoff

## Now

`main` at `a3ac875` holds M1 complete: the M0/M2 core plus, merged
2026-09-19 as `bd37e0e` (33 commits from `task/cross-agent-m3`), the
citation checker's symbol form, authority by process ancestry and tools by
permission-matrix row (T10a), `delegate`/`check`/`result`/`cancel`/
`list_tasks` with the runner's outcome sidecar (T10b), `wait` with stall
detection and `notifications/cancelled` (T11), the M1-close beads (Claude
sandbox settings, the environ-scan mid-exec retry, the gitmutate refusal,
the btime margin, the reconciler refinements, the Grok prompt-file
fallback, the text-helper and ladder consolidation) and the test-hygiene
pass. `npm test` at the root: 468 tests, 467 pass, 0 fail, 1 skipped (the
I2 placeholder). `VERIFY.md` records it; `DECISIONS.md` 0010 holds every
ruling of the run. The plan is
`~/.claude/plans/the-development-of-this-calm-planet.md` (three Codex
review rounds, then user-approved amendments: decision 10, Codex paused).

## In flight

Task 4b (`git_root`, `run_command`, the journal's `worktree` field and
named steps; the `git_root`/`run_command` half of `atc-s96.24`) is
implemented on `task/cross-agent-m3` as `9cb89bc`, `59c26cb` over
`757371f` (527 pass, 1 skip; 738 citations, 0 misses) and under review:
task review (Claude Code subagent · claude-opus-5 · max) and second
opinion (· claude-fable-5-1 · max). Task 4 (S8 modes) is complete there
(`atc-s96.23` closed). Next: 4c (solo without ceremony; brief updated
with 4b's shapes), T12 (skills), T13 (Claude Code packaging, I1/I2, E1),
S11 (mailbox, lead delegation, E2/E3). **Codex is paused by the user.**
Pending your approval: `agents-md-m1.diff` (plus Task 4's and 4b's
Layout diffs) in `.superpowers/sdd/the-development-of-this-calm-planet/`.

## Next steps

1. T10a (`atc-s96.10`, first half): authority by ancestry and the server
   plumbing. Brief: `.superpowers/sdd/the-original-intent-of-rustling-hummingbird/task-10a-brief.md`;
   rulings in `bd show atc-s96.10` and DECISIONS 0008 ("for T10"). Fold in
   `atc-s96.10.1` (one source for the engine binary; `sandboxSupport` and
   `plan` read the same env) and `atc-s96.10.2` (the unexercised contract
   surface). Expect `resolveAuthority` tests in `tests/authority.test.ts`
   and `npm test` green.
2. T10b (`atc-s96.10`, second half): `delegate`, `check`, `result`,
   `cancel`, `list_tasks`. Brief: `task-10b-brief.md` beside 10a's. It
   owes `atc-s96.37` (per-task `scratchDir` `<tasks>/<id>.scratch/`) and
   `atc-vuu` (prefix reservation). The runner now sets `CROSS_AGENT_TASK`
   itself and stands down on a foreign or unreadable environ match, so
   `delegate` may spawn the runner with the server's env unchanged.
3. Before T10 shifts many lines: `atc-s96.36` (cite code by symbol). The
   checker only proves a cited line exists; every `src/` edit today
   silently drifts the design's line citations.
4. T11 (`atc-s96.11`) `wait` with stall detection; then S8 modes
   (`atc-s96.23`), T12 (`.12`), T13 (`.13`, needs `.17`), T14/T15, S11
   engine placement (`.24`), T16, the go/no-go (`.18`). `bd ready` lists
   what is unblocked.
5. Housekeeping when convenient: `atc-s96.39` (orphaned → cancelling),
   `.40` (`reservations()` throwing out of `git_mutate`), `.41`
   (duplicated helpers and ladders), `.42` (docs nits), `.43` (test
   hygiene), `.33` (load-sensitive tests), `.29` to `.32`, `.38`, and
   `atc-1p0` (the environ scan's candidate bound loses up to a second to
   `btime` rounding; P2).

## Blockers

- None. The Claude sandbox works: the docs' `/etc/apparmor.d/bwrap` profile
  is loaded and Ubuntu's stock `bwrap-userns-restrict` is disabled (link in
  `/etc/apparmor.d/disable/`); probe P1's sandboxed `curl` returned 200 on
  2026-09-18. `atc-s96.17` (Claude P2) is runnable at T13.
- Pending your approval: `agents-md-cite-by-symbol.diff` in the SDD
  directory (one Conventions sentence for AGENTS.md).

## Key files

- `docs/design.md`: the authority — "The lead model", sections 1 to 10,
  the work plan with what landed per row, Verification.
- `docs/probes.md`: what each engine CLI does, P1 to P10, and the
  `--help` facts the adapters rely on.
- `src/`: `server.ts`, `config.ts`, `ledger.ts`, `locks.ts`, `process.ts`,
  `reconcile.ts`, `worktree.ts`, `reservation.ts`, `gitmutate.ts`,
  `journal.ts`, `runner.ts`, `guard.ts`; `engines/` (`types.ts`,
  `spawn.ts`, `registry.ts`, `binaries.ts`, `claude.ts`, `codex.ts`,
  `grok.ts`). `tests/` mirrors it; `tests/fixtures/fake-engine.mjs` stands
  in for a CLI.
- `tools/probe.mjs` (manual engine probes), `tools/check-citations.mjs`.
- `.project-steward/DECISIONS.md` 0008: every ruling of the session, each
  with what it costs if wrong.

## Tried and rejected

- An `O_EXCL` lock file with a TTL and a rename-based reclaim (refuted in
  T5's plan review; Decision 0004).
- A per-process witness cache for engine group liveness (missed descendants
  of a reaped leader; replaced by a kernel pgid and session scan).
- Moving the probe harness onto the adapter interface at T4 (kept manual).
- Execpolicy rules files as a Codex deny layer (`codex exec` ignores them).
- A lead token in the launch spec: the spec is readable by every sandbox,
  so possession cannot mean authority. Replaced by process ancestry.
- Judging an engine by its leader pid alone (a reaped leader's descendants
  survive; the group scan replaced it).
- Grok as an engine-placed lead: P9 found no per-run MCP isolation.
- `openmaus.package` v1 as an import format: the native mode format only.
- The Codex `app-server` transport: `exec` needs no dependency or second
  JSON-RPC client.

## Warnings

- Never push. Commit policy auto for checkpoints, Conventional Commits.
- `npm test` runs the citation checker: a `src/` edit that shortens a file
  below a cited line fails the suite until `docs/` is refreshed, and any
  edit above a cited line drifts the citation without failing anything.
- The suite is load-sensitive (`atc-s96.33`): a reconcile or process
  timing assertion can fail under load about one run in four. Rerun the
  file in isolation before blaming a change.
- Projects under `/tmp` or `$TMPDIR` are not isolated by the Codex or Grok
  sandbox.
- Tests that spawn processes need to run outside Codex's sandbox.
- The git stash is shared across worktrees: never a bare `git stash`.
- `AGENTS.md` and `CLAUDE.md` carry managed blocks (Project Steward and
  Beads); edit only outside them or through the tools, and only by a diff
  the user approved (Decisions 0006, 0007, 0009).
