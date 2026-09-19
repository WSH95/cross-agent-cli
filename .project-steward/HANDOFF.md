---
updated_at: 2026-09-19T15:50:17Z
updated_by: claude
session_status: active
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

M3's skills half is merged (`main` `3023e30`; `VERIFY.md` M3). Task 6
(T13; `atc-s96.13`) is on `task/cross-agent-m3` at `aa5edc8`: fourteen
commits over `3023e30`; 614 tests, 613 pass, 1 skipped (the guarded Codex
I2 test); 824 citations, 0 misses; `tools/check-citations.mjs --since` quiet
against both `3023e30` and `39505aa` (and it now reports what it cannot
judge instead of staying silent); `tools/e2e-verify.mjs` 8/8 on the sample.
Four fix rounds closed everything four reviews found; round 4 realigned the
anchored citations to the tests whose titles state each claim (alignment
table in `task-6-report.md`), grounded the verifier's Codex handling, and
fixed the checker's blind spot. **Closing reviews of round 4:** the Grok seat runs through cross-agent
(diff attached); the Opus 5 scoped re-review was stopped by the user before
a verdict and not restarted (the user was asked); the controller's own
spot-check of the realigned anchors passed. When both are clean: close `.13`,
rebase onto `main` and fast-forward, root `npm test`, `VERIFY.md` T13
section (`dispatch/verify-t13-final.md`, four placeholders), the final
handover (`HANDOFF.md` from `dispatch/handoff-draft-static.md`, `PLAN.md`,
`project-steward wrap`). The user leaves after T13; S11 is the next
session's first dispatch (`task-7-brief.md` with addendum;
`dispatch/s11-dispatch.md`). Raw evidence of P2/I1/I2/E1:
`~/.cache/agent-team/probe-logs/t13-2026-09-19/`.

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

- None hard. Two items wait on you, nothing else waits on them:
  `agents-md-m3.diff` (the combined AGENTS.md proposal, applies cleanly to
  `main`) and `atc-s96.54` (trusting the e2e sample folder in your Grok
  config so I1's Grok row can close).
- The Claude sandbox works (docs' `/etc/apparmor.d/bwrap` profile loaded,
  stock `bwrap-userns-restrict` disabled); P2 for Claude ran at T13 and
  found the `<root>/.git` write (`atc-s96.52`), being fixed.
- Codex is paused by the user (2026-09-18): every Codex row is recorded
  with the command that runs it later.

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
