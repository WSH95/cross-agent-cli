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

## 0008 — 2026-09-09 — Rulings taken while executing the cross-agent plan (T1–T9 series)

Context: The plan at `~/.claude/plans/the-original-intent-of-rustling-hummingbird.md`
was executed by subagents under review (Opus task reviews, Codex gpt-6-astra and
gpt-5.6-sol milestone reviews). Where the plan, the design and the code disagreed,
or a reviewer surfaced a decision the plan had not made, the controller ruled and
recorded the ruling in the SDD ledger. This entry preserves those rulings; each
names what it costs if wrong so the operator can undo it.

Decision: the following rulings stand as the design's decisions (written into
`docs/design.md` where they concern the design):

- git worktree at .worktrees/cross-agent instead of EnterWorktree — the project convention names that directory, there is no origin for EnterWorktree's default base ref, and subagents need one explicit path — cost if wrong: an unmanaged worktree the harness does not track (cleaned by hand at finish).
- S2 (atc-s96.20) executes as two dispatches — 2a locks primitive + conditional update + runner acknowledgement/cancel + runner lock (B3, B4, B5-ii); 2b reconcile rework + environ scan + spawn drain + record validation (B1, B5-i, B2, A4-a). Same bead; 2b consumes 2a's update API — cost if wrong: one extra review seat.
- ledger.update becomes async (the record lock is an OS-held flock child on a pipe, which cannot be held synchronously across a critical section); create/read/list stay sync. TerminalTaskError is replaced by the {applied:false, reason:"terminal"} result. Cost if wrong: call-site churn in runner and tests, all inside S2.
- the AGENTS.md diff (rename) is held and merged with the Layout/Project-facts correction into one approval request after Task 1b, so the user approves the user-owned file once — cost if wrong: AGENTS.md lags the code by one task.
- the probes.md transcript renames (DEV_TEAM_* inside a recorded Codex line, probe file names) are accepted — the record describes what the adapters do and the env names are now CROSS_AGENT_*; cost if wrong: a reader of the 2026-09-07 rows sees names that did not exist that day (the versions line dates the rows).
- Ruling (workspace authority): a role's `workspace` and `sandboxDefault` belong to the MODE; `.cross-agent/config.json` binds engine, model, effort, bin per role and may override `sandbox` only; a config `workspace` key is refused from S8 on (until S8, config keeps `workspace` as the renamed `cwd`, stated in the Work plan). Cost if wrong: relocating a role's workspace means editing the mode file, which the user owns anyway.
- Ruling ({mode, profile}): each adapter declares `sandboxProfiles: Record<profile, "read-only"|"write"|"off">` — Claude {read-only: read-only, workspace-write: write, off: off}; Codex the same (off = danger-full-access); Grok {read-only: read-only, strict: read-only, workspace: write, off: off}. Config load requires the role's profile to be a key of its engine's map; the spawn request carries {mode: map[profile], profile}; `mode !== "off"` drives the fail-closed check, `mode === "write"` drives reservation. Cost if wrong: one table to change.
- Ruling (leadMount): `leadMount(spec: {command: string; args: string[]; env?: Record<string,string>}, scratchDir: string): {argv: string[]; files?: Array<{path, contents}>}` — Claude writes an mcp-config JSON into scratchDir and returns `--mcp-config <file>` (keeping --strict-mcp-config); Codex returns `-c mcp_servers.cross-agent.command=…`/`args=…`; Grok returns [] with `inherited: true` (a Grok lead relies on the user's config) — all pending P9. `SpawnRequest` gains `scratchDir` = dirname(logPath), which also settles T7's role-prompt file location. Cost if wrong: adapter-local.
- Ruling (finish): `finish?(rawStdout: string): EngineEvent[]` runs once at completion before `finalMessage`; the pipeline buffers raw stdout only when the adapter declares `finish`; returned events are appended (so a late `session`/`result` can be emitted); `finalMessage(events, resultFileText)` then runs as today. Cost if wrong: adapter-local.
- Ruling (minors): the nine Minor findings are in the same file and are one-clause corrections of false-or-stale claims; they ride in the fix round rather than being deferred, because later briefs cite this document — cost: a slightly longer round.
- Ruling (depth): ancestry decides the row a server may get; depth is a cap (≥ maxDepth → specialist); maxDepth derives from the mode (engine placement → 2), config may only lower it; records gain depth. Cost if wrong: one guard rule.
- Ruling (authority walk): 8-hop /proc walk failing closed; identities gain bootId; match requires pid+startTime+bootId, environ CROSS_AGENT_TASK, exactly one record in the canonical project with status running|stalled, lead role for the lead row; operator needs positive provenance (no CROSS_AGENT_* env and no ancestor); revalidated per call; server takes --project, childEnv sets CROSS_AGENT_PROJECT. Cost if wrong: T10 rework.
- Ruling (contracts E1–E9): decisions written into the design; field-level details stay in briefs. Ruling (D12): one probes.md line may change in this round. Ruling (C5): every lock waits lockWaitSeconds, no -n. Ruling (C6): openmaus import and session transfer are not planned. Ruling (E2): an invalid record file refuses writable delegates until repaired.
- the six Minor findings plus three factual out-of-scope items go into a round 2 instead of the deferred list — this document is the authority every later brief cites, and each item is a one-sentence factual fix; cost: one short round.
- Ruling (bin): `bin` is per engine (`engines.<e>.bin`), never per role. Ruling (revalidation): a no-match server re-walks on every call; a matched server revalidates its ancestor and record. Ruling (root+write): a mode may not give a role both a root workspace and a writable sandbox; mode validation refuses it.
- Ruling (solo vs root+write rule): `solo`'s single role is `{kind: "root"}` with `sandboxDefault: "read-only"`, and a config `sandbox` override to a write profile is refused by the same mode rule — one-shot consultation is read-only, as the vendor bridges default; a task that must write uses a worktree mode. Carried into S8's brief; one design sentence lands with S8. Cost if wrong: a writable solo mode is a later mode file, not a core change.
- the README carries no test count — a number goes stale on every commit; VERIFY.md is where counts live. One follow-up commit requested before the scoped re-review. Cost if wrong: none.
- Ruling (completion over cancelling): the runner settles `cancelled` — reason "engine completed during cancel", exit code, session id and result path preserved — never `done`; a completion over `orphaned` settles external (the record is no longer the runner's). Cost if wrong: a completed task shows cancelled; its output is still on disk.
- Ruling (bootId read at ledger import): accepted — the tool is Linux-only by design (the /proc scans); an import-time throw on another OS is the right failure.
- a failed engine outcome over `cancelling` also settles `cancelled` (both transitions are legal; the failure is usually the cancel; the runner log keeps the cause) — accepted. Scoped re-review dispatched (Opus) over the src/tests-only diff 3a28be7..11a2e7e.
- Ruling (adoption edge): the transition table gains `launching → orphaned` (design E1 + src/ledger.ts); adoption writes it directly with the engine identity — the two-step `launching → running → orphaned` shows a task as running with no runner. Cost if wrong: one extra legal edge.
- Ruling (pass isolation): a group that survives SIGKILL is reported per record in the reconcile result (`errors: [{id, reason}]`) and never aborts the pass; the record stays orphaned for the next pass. Cost if wrong: none material.
- Ruling (truncated): the record gains `truncated?: boolean` (design E9) written by the runner from the spawn result, in addition to the reason suffix; the brief under-specified this. Runner settle-path touch for it is accepted.
- Task 4 (probes; tools/probe.mjs + docs/probes.md only) runs in parallel with 2b's reviews and any 2b fix round (src/ + tests/ only) — disjoint files, path-limited review packages, explicit `git add <paths>` and commit retry on index.lock in both dispatches. Cost if wrong: an interleaved commit history on the branch, no content conflict.
- C1–C8 recorded in task-2b-fix-round-1.md Part 2 (decision point = the conditional write; runner pre-spawn environ check; extra leaders are strays; group termination by pgid scan on identity failure; unreadable environ never yields failed: launch; stat→environ→stat; id must equal filename; Z/X dead; terminateOrphans reports skipped; lock.lost + runner settles failed on lost ownership). Cost if wrong: each is local to one function.
- Ruling (Grok as lead): Grok is not supported as an engine-placed lead — P9 found no per-run MCP isolation (inherits ~/.grok/config.toml, plugins, ~/.claude.json; untrusted project scope, no --trust); a lead there would mutate the operator's global config around every run. Grok remains a specialist engine and a host. S11's e2e runs the lead on Claude and Codex. Cost if wrong: a later Grok release with per-run MCP config reopens it.
- the adopted format's resume and bad-model runs are added (two short real runs) rather than caveated — T9 builds on them. Minors 2–6 taken; minor 7 (--system-prompt-override unexercised) noted for S11.
- the two unarchived terminal strings stay marked "not archived" — no re-registration. Scoped re-review dispatched (Sonnet).
- C4(a) applies to plausible candidates only (same uid, group+session leader, started no earlier than the record); count reported in errors. Bead atc-s96.31: time bound for the launching hold; terminateGroup reason. Scoped re-review dispatched (Opus) over the src/tests-only diff 71b2450..b4d130f.
- Ruling (see vs signal): findByEnvironment returns every match marked self; adoption of a self-marked sole leader is deferred to another server with the record left launching and an error reported; self-marked matches are never signalled; the runner's pre-spawn check counts all matches. Cost if wrong: a nested lead's stranded engine waits for the operator's server to reconcile — acceptable.
- Codex `off` on resume maps to sandbox_mode="danger-full-access"; T9 joins `errors` with newlines and delivers the role prompt via --rules (prepend only past the argv limit); the by-name refusal acts on the server's own tool names while I1 is checked per host with its prefix/folding. Cost if wrong: adapter-local.
- Ruling (off reserves): a role with sandbox mode `off` can write anywhere, so it reserves its canonical cwd — reservation is `mode !== "read-only"`, not `mode === "write"`; the design's §2 rule is amended by 3d. Cost if wrong: an unsandboxed task over-reserves, the safe direction.
- Ruling (defaultShaBeforeMerge): written once when absent, never overwritten by a later step — it is the revert target. Cost if wrong: none.
- git env allowlist (I2); journal `branch` write-once, mismatch refused (M3); git_mutate holds spawn.lock for its duration, lock order spawn→git (M6); lock lost during the command → journal anyway, report lockLost (M1); bead .35 fixed here (M7). Deferred: relative record.cwd → T10 requires absolute (bead .10 note).
- Ruling (revert target, corrects ruling B): generic git_mutate steps record the default SHA per step; the journal-level defaultShaBeforeMerge and branchHead are set exactly once by the `merged` step, a second `merged` refused. Cost if wrong: the revert range comes from the step log instead.
- for T10 — a reserved cwd refuses every delegation (read-only included) until settled, `unknown` refuses writable only; reservations cover the path and everything beneath it (atc-vuu, T10 implements the prefix match); delegate refuses a launch if spawn.lock is lost before the record is written; git_root's merge writes the `merged` step itself, and the step-name mapping for the other verbs is fixed in §7. Cost if wrong: each is a one-function change in T10.
- sandboxFor(engine, profile) in the registry; the pipeline and reservation re-derive the mode from the engine's map and refuse/reserve on mismatch. Cycle reversed (EngineName moves to engines/types.ts). Minors 5, 7 noted only.
- the lead mount is emitted with --strict-mcp-config before --model (P9's exercised order); canonicalPath exported and SpawnRequest.cwd documented canonical for T10. Minors 3, 4, 6 taken; 5 stays as contract.
- the sandbox-error latch lives in the pipeline's per-run closure, not the singleton adapter — accepted deviation. Scoped re-review dispatched (Sonnet), FIX_BASE d8bc672.
- atc-s96.7's dependency on .17 (Claude P2) moved to .13 — the probe gates I2's isolation check, not the adapter's spawn line (P1/P9). Cost if wrong: none; the adapter's argv is unchanged by P2.
- implemented (commit aa3e8bc; 323 pass + 1 skip), DONE — instructions re-supplied on resume and the -o file emptied before spawn (accepted); no `--` before the positional prompt → the prompt goes on stdin with `-` as the positional (documented by codex exec --help), verified by the I2 placeholder against the real binary. Review dispatched (Opus).
- T9 runs in parallel with T8's review and any T8 fix round — grok.ts/grok.test.ts/the fixture vs codex.ts/codex.test.ts, disjoint; path-staged commits. Cost if wrong: an interleaved history.
- Final whole-branch review (Opus, 9f85269..fd36d21): I1, I2, I3, M2, M6 taken into the one fix dispatch — I2/I3 (the runner counting itself in the environ scan; nothing enforcing CROSS_AGENT_TASK in the engine env) are one line each plus a test on the seam T10 builds on; the rest beaded (atc-s96.39–.43, .10.1, .10.2). Cost if wrong: a larger-than-"test-only" fix diff, covered by the scoped re-review.
- Ruling (runner stand-down): the runner refuses to launch on a foreign environ match and on an unreadable same-uid candidate, the rule the reconciler applies — one visible failed delegate over one invisible second engine in a worktree; atc-s96.31 bounds the hold. Cost if wrong: a late launch under a same-uid non-dumpable leader started after the task.
- Ruling (engine env): the runner sets CROSS_AGENT_TASK from the record id beside logPath/resultPath rather than asserting the spec carries it — the record names what the runner spawns. Cost if wrong: a spec naming another id is corrected silently rather than refused.
- Ruling (M2 without a test): the codex/grok plans spread the missing denyArgs/exclusionArgs call on their existing argv line — structural, both return []; the byte-exact builder tests pin the argv. Ruling (the flake): the reconcile test asserts the reconciler child exited unsignalled, recorded by its leader, instead of "alive" after its last write.
- Ruling (atc-1p0): the btime-rounding gap in the environ scan's candidate bound — an unreadable same-uid candidate spawned inside its record's own second is not counted — does not block the merge; it predates the fix, sits in `adopt` as much as in the runner, and is beaded at P2. Cost if wrong: one `failed: launch` written over a live engine in that window.
- Ruling (9d minors): the seven Minor findings of the 9d review were applied by the controller as one docs commit (45aacf8) without a reviewer, under the citation checker (471/0); M6's provenance is what `--help` and the resolver's error establish without a run. Cost if wrong: a wording slip in §3 nobody read twice.

Consequences: `docs/design.md` and the beads carry each ruling's effect; a
ruling the operator rejects is reverted by the bead or commit it names.

## 0009 — 2026-09-09 — AGENTS.md Layout names the three adapters as built (user-approved diff)

Context: T7, T8 and T9 landed the Claude, Codex and Grok adapters; the
Layout still called two of them "in progress".

Decision: The user approved the diff at
`.superpowers/sdd/the-original-intent-of-rustling-hummingbird/agents-md-proposed-3.diff`
on 2026-09-09: the three adapters are listed with one line each on what they
do. Managed blocks untouched; `CLAUDE.md` unchanged.

Consequences: Instruction files match the tree at the close of the
adapter milestone.

## 0010 — 2026-09-19 — Rulings taken while executing the M1 plan (cite-by-symbol, T10, T11, the M1-close beads)

Context: The plan at `~/.claude/plans/the-development-of-this-calm-planet.md`
(reviewed three times by Codex gpt-6-astra before execution) was executed by
Claude Code subagents — implementers on claude-opus-5 at max effort, task
reviews on claude-opus-5, second-opinion reviews on claude-fable-5-1 after the
user paused Codex on 2026-09-18 — with the SDD ledger at
`.superpowers/sdd/the-development-of-this-calm-planet/progress.md` holding
every ruling. This entry preserves them; each names what it costs if wrong.

Decision: the following rulings stand (written into `docs/design.md` where
they concern the design):

- The Claude sandbox on this machine: the docs' `/etc/apparmor.d/bwrap` profile was shadowed by Ubuntu's stock `bwrap-userns-restrict` (same profile name, loaded later); the stock one is disabled (link in `/etc/apparmor.d/disable/`). The adapter now sends `allowUnsandboxedCommands: false` and `failIfUnavailable: true` (`atc-s96.44`) — cost if wrong: a Claude child whose sandbox cannot start fails instead of running unsandboxed, the safe direction.
- Authority resolver (T10a): the walk stops at the nearest engine ancestor whatever its record's status; the lead row also requires that the nearest carried `CROSS_AGENT_TASK` (own env, else the first ancestor environ) equals the lead record's id; any ancestor's `CROSS_AGENT_TASK` counts against operator provenance; a stateless full re-walk per request; the cap never hides an ancestry reason; the 8-hop limit stands (this machine: 6 hops from an MCP server's position); invalid records stay skipped — cost if wrong: an unusual process layout is denied a row in the safe direction, with a reason naming the cause.
- T10b: ownership is by lineage ids (own id plus the `resumedFrom` chain); a resume chain has at most one active record and never forks, and a lead resumes only what it owns; `cancel` handles every parent state (`orphaned` is terminated by identity and written `cancelled` directly; a terminal parent's surviving descendants are still cancelled); the parent write and descendant snapshot happen under `spawn.lock`; records carry `depth`, `parentTaskId`, `resumedFrom`, `acknowledgedAt`, `effort`; `check` and `list_tasks` show engine, model and effort (user request) — cost if wrong: each is one function.
- A cancel inside the launch window: the reconciler's `cancelling` branch runs the environ scan before settling, `terminate()` scans too, and the runner stands down on a `cancelling` record at both checkpoints — cost if wrong: a leaked engine, the failure this closed (reproduced before the fix).
- T11: the stall clock is `lastEventAt ?? acknowledgedAt`; `observeStall` (shared by `wait` and `check`) is the only writer of `running ↔ stalled`; a wait answers a stall crossed during its own call whoever wrote it; a dead runner or overdue launch triggers one pass and an unsettled record is answered with the pass's reason; the per-call `AbortController` registers before authority resolution — cost if wrong: a wait that polls to its timeout instead of answering.
- The runner writes `<id>.outcome.json` before its terminal ledger write; reconciliation settles an orphan only from that sidecar (a result file alone never means success); a group the cleanup itself killed settles `runner lost; engine group terminated`; the edge `orphaned → done` exists for the sidecar's `done` — cost if wrong: a failed run shown as done, the defect this replaced.
- `findByEnvironment` retries a process mid-`execve` (empty `cmdline`, EACCES on `environ`) for one 250 ms budget per scan before counting it unreadable — the real cause of the `atc-s96.33` flake — cost if wrong: a slower scan under a spawn storm.
- Engine placement ships as a third built-in mode `dev-team-engine` (S8); `git_root` and `run_command` register under the worktree provider for every placement with the journal selected by an explicit `slug`; the built-in `consult` role in every mode, a no-config default to `solo`, `worktree: true` one-shots merged by the launcher under `mergePolicy`, and `review`/`critique` briefs (user-approved decision 10) — cost if wrong: one mode file, one flag, one role to remove.
- Process: Codex paused by the user (subscription limit); second-opinion reviews on Fable 5.1, plan reviews on Opus 5; every dispatch names harness · model · effort; the controller's own citation-drift script misattributed continuation citations once (Task 3c round 3, withdrawn) — cost: one wasted round.

Consequences: `docs/design.md`, `VERIFY.md` and the beads carry each ruling's
effect; a ruling the operator rejects is reverted by the bead or commit it
names. The AGENTS.md changes these rulings imply are proposed in
`.superpowers/sdd/the-development-of-this-calm-planet/agents-md-m1.diff` and
await approval.

**AGENTS.md changes approved (2026-09-19).** The user approved changing
`AGENTS.md` in this session. Applied on `main`: the consolidated proposal
`agents-md-m3.diff` (Layout rewritten to what shipped in M1 and M3; the
cite-by-symbol sentence in Conventions; the `init --mode` line in Run),
refreshed for T13 (the Claude Code plugin manifest with its inline MCP
declaration and `tests/packaging.test.ts` under Shipped; Planned reduced to
the Codex and Grok packaging, the mailbox, the remaining CLI verbs). The
managed blocks are untouched. `CLAUDE.md` includes `AGENTS.md` by reference,
so it needs no mirror. Later Layout refreshes in this session (the e2e verify
script, S11's mailbox, T14–T16) fall under the same approval and are noted
here as they land.
