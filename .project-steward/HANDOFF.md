---
updated_at: 2026-09-09T12:20:49Z
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

The Opus review of Task 5 (`.22`, claimed): engine contract v2 landed in
734e1e9..193b511 (264 tests) — adapter-owned profiles/deny/exclusion/
`leadMount`/`finish`, `src/engines/{registry,binaries,claude,codex,grok}.ts`
with the three engines' static parts, profile validation at config load,
`{mode, profile}` + `scratchDir` + `lead?` on the spawn request, the
pipeline's `finish` hook and `plan.files`. Task 3d's docs round (a false
justification sentence, the `atc-n85` citation refresh, six minors, four
T10 rulings written into §2/§4/§7). Task 3d's sweep itself landed
(7607f69, ee17f96; design 1905 lines).

## Next steps

1. Close Task 5 (`.22`) and Task 3d on clean reviews.
2. T7 Claude adapter (`.7`), T8 Codex (`.8`), T9 Grok (`.9`) — briefs under
   `.superpowers/sdd/.../task-{7,8,9}-brief.md`, confirmed against the
   landed contract; the adapters remove the throwing stubs.
3. T10/T11 (`.10/.11` — the bead carries the ancestry, env, lock-order,
   reservation and journal rulings), modes (`.23`), T12, T13, engine
   placement (`.24`, Claude and Codex leads). New beads this session:
   `atc-n85`, `atc-vuu`, `atc-7bj`.

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
