# Decisions

Record decisions in order. Include the reason, the choice, and its practical
effect.

## 0001 — 2026-09-07T21:50:42Z — Adopt Project Steward

Context: Project work needs to survive changes of agent, tool, or device.

Decision: Keep project state in `.project-steward/`. Use `AGENTS.md` for
shared instructions and `CLAUDE.md` as a small Claude Code adapter.

Consequences: Git carries the files needed to resume the work elsewhere.

## 0002 — 2026-09-07 — The design as approved

Context: The user asked whether the OpenMausBot dev-team pack could become
a plugin for a general-purpose coding agent CLI. Research on 2026-09-07
found about 70% of the pack host-independent and every engine CLI on this
machine headless with resume and a sandbox.

Decision: One MCP server core in TypeScript on Node 24 with no
dependencies, spawning `claude`, `codex`, and `grok` itself; each CLI's
sandbox as the boundary; no time cap on a task, a stall flag instead;
delegation loops impossible in code and tested; lead-owned git through
explicit git-dir commands; a detached runner so completion survives the
server. Two Codex gpt-6-astra reviews (twelve, then ten findings) shaped
it. Full text: `docs/design.md`.

Consequences: `docs/design.md` is the authority; every task's brief points
at its sections; probes in `docs/probes.md` pin the spawn flags.

## 0003 — 2026-09-07 — T1 to T5 built by the OpenMausBot pack; later work by the operator's sessions

Context: This repository was the "first real repository" for validating
the OpenMausBot dev-team pack (agent-team-devpack milestone M7).

Decision: T1 to T5 were sent as briefs to the pack's lead and built by its
planner, reviewers, and implementer (evidence in that repository's
EVIDENCE.md). From T6 on, the operator's own Claude Code and Codex sessions
build here, tracked in Beads (epic `atc-s96`) with Project Steward.

Consequences: Closed beads `atc-s96.1` to `.5` carry the verbatim briefs
and outcomes; the pack's timings and review rounds live in the devpack.

## 0004 — 2026-09-07 — Locks are OS-held flock, never reclaimed

Context: The design's first lock recipe (an `O_EXCL` file with a TTL and a
rename-based reclaim) was refuted during T5's plan review: a reclaim by
pathname can rename the winner's fresh lock, so two reclaimers could both
succeed, and a "dead or expired" rule lets a stalled live writer lose its
lock.

Decision: All three locks (spawn, per-record, git) are `flock(2)` on files
under `.dev-team/locks/`, held through a util-linux `flock` child on a
pipe; the kernel releases them when the holder dies. Commit ac3e5d5.

Consequences: T6 implements the helper and puts the per-record lock inside
the ledger's update; until then two automated cleaners can both write the
same failed "runner lost" record (design section 2, residual sentence).

## 0005 — 2026-09-07 — T5 narrowed after two failed replans

Context: Code review found two P1 defects in T5's first implementation;
two replans that tried to add the lock inside T5 each had a hole.

Decision: T5 fixed the two defects (kernel pgid and session scan; the
terminal guard inside the ledger's single read-check-rename), stated the
residual, and left the lock to T6. One extra review round was authorized
beyond the pack's two-round cap.

Consequences: 4f39c71 on `main`, 146 tests; T6 closes the residual.

## 0006 — 2026-09-09 — AGENTS.md follows the cross-agent design (user-approved diff)

Context: The plugin was renamed to `cross-agent` and `docs/design.md`
rewritten as the authority for the lead model, modes, and ancestry-bound
authority. `AGENTS.md` is user-owned; agents change it only through an
approved diff.

Decision: The user approved the diff at
`.superpowers/sdd/the-original-intent-of-rustling-hummingbird/agents-md-proposed.diff`
on 2026-09-09: the opening paragraph describes `cross-agent` and modes; the
Layout section separates shipped files (`src/server.ts`, `config.ts`,
`ledger.ts`, `process.ts`, `worktree.ts`, `runner.ts`, `guard.ts`,
`engines/{types,spawn}.ts`) from planned ones (`locks.ts` — since landed —,
`reconcile.ts`, `gitmutate.ts`, `cli.ts`, the adapters, the launcher skill,
`modes/`); the Conventions add the permission matrix as a hard requirement,
`git_root` for an engine-placed lead, and the mode/config split (workspace
and sandbox default in the mode; engine, model, effort per role and `bin`
per engine in config). Managed blocks untouched; `CLAUDE.md` unchanged.

Consequences: Instruction files match the design; the Layout's "planned"
list is updated as tasks land.

## 0007 — 2026-09-09 — AGENTS.md Layout follows the shipped files (user-approved diff)

Context: Since Decision 0006 the branch shipped `src/locks.ts`,
`src/reconcile.ts`, `src/reservation.ts`, `src/gitmutate.ts`,
`src/journal.ts`, the engine registry and adapters, and the citation
checker; the Layout still listed several as planned.

Decision: The user approved the diff at
`.superpowers/sdd/the-original-intent-of-rustling-hummingbird/agents-md-proposed-2.diff`
on 2026-09-09: the Shipped list names every file now present with its concern,
the citation checker is described under tests, and Planned keeps
`src/cli.ts`, the delegation tools, the launcher skill and the modes.
Managed blocks untouched; `CLAUDE.md` unchanged.

Consequences: Instruction files match the tree; the Planned list shrinks
as T8–T13 land.

## 0009 — 2026-09-09 — AGENTS.md Layout names the three adapters as built (user-approved diff)

Context: T7, T8 and T9 landed the Claude, Codex and Grok adapters; the
Layout still called two of them "in progress".

Decision: The user approved the diff at
`.superpowers/sdd/the-original-intent-of-rustling-hummingbird/agents-md-proposed-3.diff`
on 2026-09-09: the three adapters are listed with one line each on what they
do. Managed blocks untouched; `CLAUDE.md` unchanged.

Consequences: Instruction files match the tree at the close of the
adapter milestone.
