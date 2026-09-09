---
updated_at: 2026-09-09T13:15:59Z
updated_by: claude
session_status: closed
branch: task/cross-agent
---

# Handoff

## Now

Branch `task/cross-agent` (worktree `.worktrees/cross-agent`, base `main` @
9f85269). Landed and reviewed: rename; `docs/design.md` as the authority
(amended through Task 2c); README; `AGENTS.md` by approved diff (Decision
0006); the lifecycle core (S2 `.20`, closed; 199 tests); probes P8–P10
(S4 `.21`, closed); T6 (`.6`, closed at ffbb84d, 237 tests): reservation
(every profile but read-only/strict reserves; invalid records block),
`git_mutate` (verified git-dir only, `spawn.lock` → `git.lock`, a git
environment allowlist, never throws at the lead), the journal (per-step
`defaultSha`; the `merged` step sets the revert target once),
`lockWaitSeconds` through every lock. Beads `.29`–`.35` filed this
session (`.34`, `.35` closed). SDD ledger:
`.superpowers/sdd/the-original-intent-of-rustling-hummingbird/progress.md`
(main checkout).

## In flight

Two Opus reviews: Task 7, the Claude adapter (d8bc672: stream-json parse,
settings sandbox, deny list, role file, lead mount, a `parseStderrLine?`
hook for the run-time sandbox failure; 297 tests), and Task 5d
(77eef9d, fe26d96: `tools/check-citations.mjs` under `npm test` — 364
citations, 0 range misses — and §3 rewritten as built; `atc-2q4` closed).
Citation refresh for `src/engines` is held until T9 lands (`atc-vao`,
with `atc-6sl`/`atc-540` folded in); `atc-s96.36` proposes symbol
citations so line drift stops.

## Next steps

1. Close T7 (`.7`) and 5d on clean reviews; T8 Codex (`.8`), T9 Grok
   (`.9`) — briefs confirmed against the contract; then the one §3
   citation refresh (`atc-vao`).
2. T10 in two halves (`.10`: 10a authority + server plumbing, 10b the
   tools — briefs drafted), T11 (`.11`), modes (`.23`), T12, T13, engine
   placement (`.24`).

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
