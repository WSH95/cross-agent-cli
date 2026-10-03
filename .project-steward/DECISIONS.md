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

### Rulings taken during M3 (Tasks 4, 4b, 4c, 5, 6), 2026-09-19

Each is also in the SDD ledger with its dispatch. The cost named is what it
costs if the ruling is wrong.

- **S8 (Task 4).** Fixtures bind leads to Codex so the tests are
  host-independent; `delegate`'s own root-write check stays behind
  `bindingFault`; a Grok-bound lead is refused at load. Cost: a test rebind.
- **Root git tools (4b).** `"none"` journals nothing and a slug is refused
  where nothing would be journaled; `merge --ff-only` is refused unless the
  root HEAD is on the default branch; `tests-passed` is written once and
  only after `merged`; `worktree remove` respects reservations; a tracked
  `.cross-agent/` in the root index is refused before a merge; a rebase can
  be aborted through `git_mutate`. Cost: one refusal too many, never a
  silent merge.
- **Solo without ceremony (4c).** Every mode is a worktree provider: the
  four provider tools register for every mode, and `describe_mode.git.implicit`
  tells the launcher whether the mode declares worktree roles, so a solo
  one-shot's merge finishes through `git_root`/`run_command` with a complete
  journal. Task ids are hex (a base64url id starting with `-` failed the
  slug rule). A consult one-shot cannot smuggle `.cross-agent/` into the
  root (`trackedStateFault`, found Critical by the second opinion). Cost:
  four tools in solo's list nobody calls.
- **T12.** The mode's `roles/*.md` reach the engine: `delegate` launches a
  role with the mode's prompt file and a configured `prompt` overrides it
  (`src/` allowed in a text task's fix round because the prompts were
  otherwise dead text). The launcher keeps the plan's "call `list_tasks`
  after a timeout or a stalled return". A resume resolves its model as call,
  then the binding for this engine, then the record (the implementer's
  order, accepted over the finding's). Six one-line fixes were verified by
  the controller's own read rather than a review seat. Cost: one function
  to revert; one missed nit.
- **T13, before review.** A `workspace-write` Claude specialist in a linked
  worktree could write into `<root>/.git`: the launch spec carries
  `protectedPaths` (the workspace's `.git` pointer and the common git
  directory from `verifyWorktree`) and the Claude adapter deny-lists them;
  a call naming another engine drops the binding's model and effort;
  `denyTargets` is rooted at this repository. Fixed before the review so one
  review saw one complete task. Cost: three minutes of subscription for the
  reruns.
- **T13, round 1.** The read-only Claude profile sent no filesystem rule and
  Claude's sandbox writes to the cwd by default: the builder now sends
  `denyWrite` of the cwd plus the protected paths, proven by a real
  read-only probe. The probe harness takes its settings from the adapter's
  `plan`; a fake-engine test pins the by-ancestry refusal naming the task
  id; the Codex I2 body is written behind `CROSS_AGENT_REAL_CODEX=1` and not
  run. The MCP server is declared inline in `.claude-plugin/plugin.json`
  and the root `.mcp.json` deleted, because a repository-root `.mcp.json` is
  Claude Code's project-scoped config for every developer session here
  (from the Claude Code docs). Cost: the file form is one commit away.
- **T13, round 2.** The Grok adapter routes a prompt through
  `--prompt-file` when the brief or the role text is large (a 150 KB review
  brief failed with `E2BIG`, found by running the product on its own
  review); the server's row-and-reason stderr line moves from startup to
  the first request resolution (a specialist's record is often still
  `launching` at startup); a reusable `tools/e2e-verify.mjs` replaces the
  one-off E1 verification for E4–E7. Cost: a harness file to maintain.
- **Grok trusted folder (user, 2026-09-19).** The e2e sample folder is
  trusted in `~/.grok/trusted_folders.toml` (backup beside it) so I1's Grok
  row can close.
- **AGENTS.md refresh under the same approval (T13 round 2):** the `tools/`
  bullet names `probe.mjs --track` and `e2e-verify.mjs`.

### Rulings taken while closing T13 (rounds 3–7), 2026-09-19

- **Citations by anchor.** Every citation into a test file is an
  `// @anchor <name>` on the `test(` line; passages in `docs/probes.md` carry
  `<!-- @anchor -->` names (never inside a table, which splits it); code is
  cited by `#symbol` where a symbol holds the line. Line citations remain only
  for `src/` ranges. Cost: anchors must be kept on their test when tests move.
- **`--since <rev>` in the checker** compares each line citation's text with
  the revision and reports what it cannot judge (a line past the revision's
  file length) rather than staying silent — round 3's "0 drifted" had been
  vacuous for exactly that reason. The controller runs it with the task's
  BASE after every task. Cost: a non-zero exit for a citation into a file that
  grew, until it is re-pointed or anchored.
- **The e2e verifier fails closed, not open:** a transcript shape no archived
  run shows answers `?`; an offence already found is FAIL whatever else is
  unread; the launcher mirrors `denyTargets` (the four CLIs and configured
  bins as command words; `node …/src/server.ts|cli.ts` only where a command
  can start); exit 0 only when every row passes, 1 on a FAIL, 2 on a `?`. The
  Codex MCP-call item shape is not guessed: until I1 Codex records it, an
  unknown Codex item answers `?`. Cost: a real Codex run may answer `?` until
  the shape is recorded.

## 0011 — 2026-10-02 — Go or no-go: the plugin as the dev team's second binding

Context: The plan at `~/.claude/plans/the-development-of-this-calm-planet.md`
set seven end-to-end runs, one per host and placement: E1 under a Claude Code
host with the loop in the host session; E2 and E3 under Claude Code with the
loop in a Codex lead and in a Claude lead; E4 and E5 under a Codex host, and E6
and E7 under a Grok host, each pair host-placed and then with the lead the
table names "Claude if available, else Codex" — Claude was available. S11's
review added E2b and E2c, E2's host clause run twice more under a Codex lead,
task 12's fix round 1 added E8, the rerun rule's whole loop after a change to
every Claude spawn line, and the close added E9, that line under an
engine-placed Claude lead (`docs/probes.md#t12Fix3`). Every run took one task
in the sample repository `~/.cache/agent-team/cross-agent-e2e/slugkit`, a clone
of `~/Documents/atw-sample-slugkit` (at the close `main` at `5f391d4`, 109
tests, 51 records; `#t12Fix3`), and `tools/e2e-verify.mjs` judged each by the
design's eight conditions ("Verification", "End-to-end under each host"),
each `pass`, `FAIL` or `?`, where `?` is evidence missing and never counts as
a pass. What "second binding" means is the devpack's Decision 0008: the
OpenMausBot pack stays the primary binding and the plugin is the second
binding of the same team — its roles and lifecycle, runnable from each of the
three hosts on the user's subscriptions, each CLI's own sandbox the boundary,
no delegation loop, specialists never writing git metadata — and a later
decision records go or no-go for it; this is that decision. Before it, three
independent reviews judged the range `4bcc986..416165c` (162 commits) in four
rounds, triaged in
`.superpowers/sdd/the-development-of-this-calm-planet/task-12-findings-round-1.md`
to `-round-4.md`. Round 1's verdict lines were
`VERDICT: needs work — 2 Critical, 3 Important, 5 Minor`,
`VERDICT: needs work — 1 Critical, 0 Important, 1 Minor` and
`VERDICT: needs work — 0 Critical, 0 Important, 3 Minor`: 3 Critical, one on
the Claude adapter's file tools and two on the verifier, 3 Important and 9
Minor. Rounds 2 and 3 judged fix rounds 1 and 2,
and round 4 the escalation, each with the whole range judged again; round 4's
verdicts were `findings remain open` twice and "Needs fixes" once, and the
wrap-up after it was verified by the controller reproduction by reproduction,
with no fifth round, as at 6b. By id: R1-1 (Critical) confirmed by probe and
fixed (`docs/probes.md#t12Fix1`); R1-2 fixed by `--setting-sources project`,
its residue R2-1 an accepted limitation by the user's word; R1-3 and R1-4
(Critical) fixed; R1-5, R1-7 and R1-8 fixed; R1-6 closed by running the deny
targets P3 had not (`#t12Fix1`); R1-9 closed by E8 (`#t12Fix1`); R2-2 to R2-7
and R2-9 fixed, R2-2's link-following superseded by the escalation's rule;
R2-8's two behaviours, the sensitive paths and the sandboxed network, accepted
limitations by the user's word (`docs/probes.md#t12Fix2`); R3-1, R3-2, R3-4,
R3-6 and R3-7 fixed by the escalation, and R3-3 and R3-5 fixed there for the
shapes named and as classes by the wrap-up's W-1 and W-2; W-1 to W-4, W-6 and
W-7 fixed by the wrap-up; W-5 a stated boundary by the controller's ruling.
The fixes merged at `7bf9731` with 813 tests, 812 passing, 0 failing and 1
skipped, and 1300 citations, 0 by line and 0 missed (`VERIFY.md` T12).

Decision: go with conditions. Row 4 of the table in part 3 is the first whose
test holds, and its conditions (a) to (d) are named there with the host each
binds and the line that carries it.

**1. The record.** One row per run. A lead's own figures stand first among its
specialists; a duration a source gives only for a specialist stays in that
column and never stands in for a `wait`.

| run | host | placement | slug | host time | the specialists, in order | host's MCP `wait`s | lead's MCP `wait`s | verdict, and the `?` as a person read it | deviations |
|---|---|---|---|---|---|---|---|---|---|
| E1 | `claude` | host | `t10-slug-words` | 458.8 s, 33 turns | planner `claude` 36 s, plan; plan reviewer `grok` 92 s, approve; implementer `claude` 27 s, 64 → 68 tests; code reviewer `grok` 83 s, ready; implementer `claude`, a `resume`, 14 s, 68 → 69 tests; code reviewer `grok` 59 s, ready | six, one per delegation, each `done`; durations not recorded | — | `8 pass, 0 fail, 0 without evidence` | step 8's rebase never ran, `main` being unmoved; the needs-work round was the operator's, both reviews having said ready; the run predates the containment fix and the deny-list root, on which no condition depends |
| E3 | `claude` | engine, lead `claude` | `s11-e3` | 387 s, 8 turns | lead `claude` 360 s; planner `codex` 32 s, plan; plan reviewer `grok` 104 s, approve; implementer `claude` 30 s, 69 → 73 tests; code reviewer `grok`, read-only, 90 s, ready | one, `done` at 360 s | four | `7 pass, 0 fail, 1 without evidence`; the `?` on condition 8, "144d7771: events this build cannot read (tool_progress)", read as six in-flight heartbeats of Claude Code, each parented to one of the lead's `wait` calls, with no command and no input | the host relayed `wait`'s tail instead of calling `result` |
| E2 | `claude` | engine, lead `codex` | `s11-e2` | 531 s, 13 turns | lead `codex` 490 s in 27 MCP calls; planner `codex` 24 s, plan; plan reviewer `grok` 150 s, approve; implementer `claude` 28 s, 73 → 77 tests; code reviewer `grok`, read-only, 82 s, ready | one; duration not recorded | four | `7 pass, 0 fail, 1 without evidence`; the `?`, "83750cc5: its rollout holds delegate: 1 occurrences but only 0 direct calls followed", read as a tool-discovery regular expression naming `delegate`, which calls nothing | the host summarized the report and ran two read-only `git` commands of its own |
| E2b | `claude` | engine, lead `codex` | `s11-e2b` | 386 s, 9 turns | lead `codex` 362 s; planner `codex` 27 s; plan reviewer `grok` 108 s, approve; implementer `claude` 32 s, 85 tests; code reviewer `grok`, read-only, 92 s, ready | one; duration not recorded | not recorded | seven `pass` and a `?` on condition 8, "its rollout's script holds a regular expression naming an engine, which cannot be told from a command", read as a tool-discovery regular expression naming `cross-agent`, which calls nothing | the host's closing message was a list of its own, not the report; the lead's report left out each specialist's duration |
| E2c | `claude` | engine, lead `codex` | `s11-e2c` | 250 s, 8 turns | lead `codex` 232 s; planner `codex` 21 s; plan reviewer `grok` 43 s, approve; implementer `claude` 28 s, 87 tests; code reviewer `grok`, read-only, 40 s, ready | one; duration not recorded | not recorded | seven `pass` and a `?`, "its rollout holds delegate: 1 occurrences but only 0 direct calls followed", read as a tool-discovery filter's regular expression naming `delegate`, which calls nothing | none of the host clause; the lead's report left out each specialist's duration; the root guard refused the lead's first `worktree add`, outside the mode's worktree directory, and the lead retried at the right path, a refusal rather than a deviation |
| E4 | `codex` | host | `t14-e4` | 468 s; turns not recorded | planner `codex` 28 s, plan; plan reviewer `grok` 143 s, revise; planner `codex`, a `resume`, 19 s, revised plan; plan reviewer `grok` 79 s, approve; implementer `codex` 38 s, 87 → 90 tests; code reviewer `claude`, read-only, 24 s, ready | six, each `done`: 27.0, 141.2, 17.0, 77.1, 37.1, 22.0 s | — | `7 pass, 0 fail, 1 without evidence`; the `?`, "920c667b: events this build cannot read (file_change)", read as two patches to files inside the task's worktree, with no command and no call | none from the loop: step 8's rebase ran, and the needs-work round was the plan reviewer's own |
| E5 | `codex` | engine, lead `claude` | `t14-e5` | 779 s in turn 1 and 150 s in turn 2, a resume of the host's thread; turns within them not recorded | lead `claude` 984 s, one ask; planner `codex` 32 s, plan; plan reviewer `grok` 133 s, revise; planner `codex`, a `resume`, 22 s, revised plan; plan reviewer `grok` 144 s, revise, and the lead asked the operator; implementer `claude` 28 s, 90 → 95 tests; code reviewer `codex`, read-only, 29 s, ready | two: 600.008 s → `running`; 107.1 s → `done` | not recorded | `8 pass, 0 fail, 0 without evidence` | the host's one shell command, `cat` of the plugin copy's `SKILL.md`; the first turn ended on the lead's question, answered by resuming the host's own thread |
| E6 | `grok` | host | `t15-e6` | 330 s, 24 turns | planner `codex` 24 s, plan; plan reviewer `grok` 92 s, approve; implementer `claude` 28 s, 95 → 98 tests; code reviewer `grok`, read-only in the worktree, 62 s, ready | four, each `done`: 21.0, 90.1, 26.0, 60.1 s | — | `8 pass, 0 fail, 0 without evidence` | none from the loop: step 8's rebase a no-op; one plan-review round, so no `resume`; no `run_command setup` call, setup being `none` |
| E7 | `grok` | engine, lead `claude` | `t15-e7` | 501 s, 8 turns | lead `claude` 462 s, no ask; planner `codex` 36 s, plan; plan reviewer `grok` 96 s, revise; planner `codex`, a `resume`, 26 s, revised plan; plan reviewer `grok` 132 s, approve; implementer `claude` 21 s, 98 → 101 tests; code reviewer `grok`, read-only in the worktree, 57 s, ready | one, `done` after 459.6 s | not recorded | `8 pass, 0 fail, 0 without evidence` | none |
| E8 | `claude` | host | `t12-e8` | 193.8 s, 28 turns | planner `claude` 31.4 s; plan reviewer `claude` 19.3 s, approve; implementer `claude` 24.1 s, 101 → 105 tests; code reviewer `claude`, read-only in the worktree, 22.5 s, ready | four, each `done`, answering `elapsedSeconds` 31, 19, 24 and 23; durations not recorded | — | `8 pass, 0 fail, 0 without evidence` | no roster before the first dispatch; the narration and `log.md` named `codex` and `grok` for three Claude roles (`atc-s96.66`, reopened); no `resume` ran |
| E9 | `claude` | engine, lead `claude` | `t12-e9` | 494.9 s, 9 turns | lead `claude` 456 s, no ask; planner `codex` 25 s, plan; plan reviewer `grok` 82 s, revise; planner `codex`, a `resume`, 20 s, revised plan; plan reviewer `grok` 67 s, approve; implementer `claude` 29 s, 105 → 109 tests; code reviewer `grok`, read-only in the worktree, 48 s, ready | one, `done` after 453.6 s | six, each `done`: 23.1, 79.2, 9.0, 64.1, 27.1, 45.1 s, 247.5 s in all | `8 pass, 0 fail, 0 without evidence` | the host printed no roster before the lead's dispatch (`atc-s96.66`), called no `result` and closed on `wait`'s tail, a sentence of its own before the report; the lead never called `list_roles`, and its report named both planner runs `claude` where the ledger names `codex` (`atc-s96.95`); the lead called `result` after the planner's `wait`s only |

Where the cells come from: E1's row from `VERIFY.md` T13 "E1" and
`docs/probes.md#e1`; E3's and E2's from S11 "E3" and "E2" with `#e3` and
`#e2`; E2b's and E2c's from S11 "E2b and E2c" with `#e2Host`, their
specialists' engines being the sample's S11 bindings (`#s11`); E4's and E5's
from T14 "E4" and "E5" with `#e4` and `#e5`; E6's and E7's from T15 "E6" and
"E7" with `#e6` and `#e7`; E8's from T12 "E8" with `#t12Fix1`; E9's from
`docs/probes.md#t12Fix3` alone, which times every `wait` from its `tool_use`
event to its `tool_result` event and records the lead's own six — a count and
durations no earlier run's sources give, so no cell above is filled from it.
The cells marked `not recorded`, and what was checked for each: E1's `wait`
durations — `#e1` writes each call as `wait 600 → done` with the specialist's
own time beside it; the host `wait` durations of E2, E2b and E2c — their
sections, `#e2` and `#e2Host` give the count alone; the lead's MCP `wait` count
for E2b and E2c — `#e2Host` counts only Codex's own code-mode waits — and for
E5 and E7 — "E5", `#e5`, "E7" and `#e7` give the lead's loop step by step with
no count; the host turns of E4 and E5 — "E4", `#e4`, "E5" and `#e5` give a Codex
host's time and tokens; E8's `wait` durations — `#t12Fix1` gives what each
call answered, `elapsedSeconds`, which is the task's elapsed time and not the
call's own. Codex's code-mode waits, seven in E4's host, six in E2's lead and
in E2b's and two in E2c's (`#e4`, `#e2`, `#e2Host`), call nothing over MCP
and count for nothing here. E3's lead called `wait` four times (`#e3`); the
three that "E3" and `#e3` name are the calls its heartbeats were parented to.

Failure injections. The design's "Failure injection, all six recorded" bullet
stands, with engine placement's two beside it. At T13 (`VERIFY.md` T13
"Failure injections"): a server killed during a task, after which the runner
settled the record `done` and a fresh server reported it; a runner killed with
its engine alive, after which one `list_tasks` settled the record `failed` and
the engine's group was gone; and a needs-work round through `resume`, inside
E1. At S11 (`VERIFY.md` S11 "Failure injections";
`docs/probes.md#injectCancelLead`, `#injectKilledLeadAsk`,
`#injectRootSuiteFails`, `#injectAfterWorktreeRemove`,
`#injectRebaseConflict`): a cancelled lead settled every descendant with one
outcome each and left no process; a killed lead's ask survived, was answered
from a terminal and reached the resumed lead's brief; a suite failing on
`main` after the merge left the merge standing with no `tests-passed` and
offered `git revert --no-edit` over the journal's two SHAs, running nothing
after it; a lead killed at `worktree-removed` had its branch deleted by the
operator's reconciliation pass through `git_root`; and a rebase conflict was
answered with git's own text, aborted and journaled, the lead asking and
stopping on the answer. Each injection's verifier ran for the conditions its
stopping point allows, and each depth-and-lineage reading passed.

Depth, lineage and the `?` readings. Every engine-placed run reads PASS on the
ledger, the lead at depth 1 with no parent and every specialist at depth 2
with the lead first in its lineage (`VERIFY.md` S11 "A lead's server, from the
ledger", "E3", "E2" and "E2b and E2c"; T14 "E5"; T15 "E7";
`docs/probes.md#t12Fix3` for E9), and every host-placed run's records sit at
depth 1 against a cap of 1 (`VERIFY.md` "E1" and "E4"; `docs/probes.md#e6`,
`#t12Fix1`). Five of the eleven runs needed a person to read a `?` — E3, E2,
E2b, E2c and E4 — and each reading stands beside its verdict; E1, E5, E6, E7,
E8 and E9 read eight `pass`.

**2. The rows not run**, each with its reason and where it is recorded as not
run:

- P2's outstanding Claude rows — `$TMPDIR` for a writable role, a write into
  another registered worktree, `<root>/.git/refs/heads/<default>`, and the
  whole set on a resumed session — outstanding since T13 (`VERIFY.md` T13
  "Probes", P2) and run by no later section; fix round 1 reran the file-tool
  writes, fresh and resumed, not these shell rows (`docs/probes.md#t12Fix1`).
- The direct `tools/call delegate` refusal: unreachable from a client that
  honours `tools/list`, so a test pins it instead (`VERIFY.md` 6b "Probes", the
  I1 Codex bullet; `docs/probes.md#i1Ancestry`).
- The hop count of a Codex or a Grok host at a terminal or in its desktop app,
  "not run: the user's hands" (`VERIFY.md` T14 and T15 "Depth, from the MCP
  server's position"; `docs/probes.md#codexHostHops`, `#grokHostHops`), and of
  Claude Code under VS Code or its desktop app, which `QUESTIONS.md`'s walk item
  asked for before the walk's budget rose to 32; a Claude Code host at a
  terminal was measured at T13, 7 hops (`VERIFY.md` T13 "Depth, from the MCP
  server's position"). Every measured row, the deepest 11 under a Grok host,
  fits the 32-hop budget, so the rest are a record, not a gate.
- The Codex plugin in an interactive session without `CROSS_AGENT_PROJECT`:
  not probed (`.superpowers/sdd/the-development-of-this-calm-planet/task-8-report.md`,
  "Concerns of this round" 4); the headless case is recorded, no server
  starting and `codex exec` saying nothing (`docs/probes.md#codexMarkers`,
  probe (c)).
- A Grok lead: not a row. P9 found no per-run MCP isolation for Grok, and the
  design's placement table names Claude or Codex (`docs/probes.md#p9GrokInherits`;
  design "The lead model"); a Grok host delegates a Claude or Codex lead, as
  E7 did.
- A Codex lead under a Codex host or under a Grok host: the plan's table names
  one lead per row, "Claude if available, else Codex", and Claude was
  available; the Codex lead ran under a Claude Code host, in E2, E2b and E2c.
- E1 under the shipped containment configuration: not rerun
  (`docs/probes.md#e1`); E3's specs were the first of a whole loop to carry
  `protectedPaths` and the deny-list root, E4 the first under a Codex plugin
  host (`#e4`), and E8 is the Claude Code host-placed loop under the Claude line
  that ships now.
- The end-to-end runs under the Claude line that ships: fix round 1 gave every
  Claude role `dontAsk`, a tool allowlist, workspace-only edit rules and
  `--setting-sources project` after E1 to E7 had run. E8 and E9 are the whole
  loops under that line, E8 host-placed with every specialist on Claude and E9
  with an engine-placed Claude lead (`docs/probes.md#t12Fix3`); neither ran a
  resumed Claude specialist, a read-only Claude specialist under engine
  placement or a lead's `ask` under `dontAsk` (`VERIFY.md` T12 "E8", its "not
  exercised" row; `#t12Fix3`, "Not exercised"). Fix round 1 ran a resumed
  Claude role through the product under the line, and a candidate line with
  the lead mount on which `dontAsk` ran the MCP call its allow rule names
  (`#t12Fix1`).
- E4 and E5 under the Codex mount that ships: both ran on an earlier install
  whose `env_vars` named the project alone, and probe (a) shows the shipped
  four-name mount behaves the same from a clean shell (`VERIFY.md` T14, the
  paragraph after "Landed"; `docs/probes.md#codexMarkers`).
- A Codex lead or host under the Codex CLI that is installed now: `VERIFY.md`'s
  T12 table names a newer Codex CLI than its S11, T14 and T15 tables, so the CLI
  was upgraded after E2, E2b, E2c, E4 and E5, where Codex was a lead or the
  host, and after E3, E6 and E7, whose planners ran on it. Under the newer CLI
  ran fix round 1's probe (c), a Codex consult whose patch tool refused a write
  outside its worktree (`#t12Fix1`), and E9's planner, fresh and resumed, the
  first Codex specialist of a whole loop under it (`docs/probes.md#t12Fix3`);
  no section records a Codex lead, a Codex host or a writing Codex specialist
  under it (`#t12Fix3`, "Not exercised").
- The Grok rows T15 did not run (`docs/probes.md#t15Attach`;
  `.superpowers/sdd/the-development-of-this-calm-planet/task-9-report.md`,
  "Rulings taken" 1 and "Deviations"): the user-scope `grok plugin install
  <worktree> --trust`, by ruling, since it would reach every Grok session on
  the machine; `--trust`'s own write to `~/.grok/trusted_folders.toml`, which
  would have edited the operator's trust file, so the README's trust sentence
  rests on Grok's guide; the ACP route, `grok agent --plugin-dir`, which a
  client drives; attach candidates (3) and (4), a `.grok/plugins/` link and a
  project mount beside a `.grok/skills/` link, because candidate (2) worked;
  the `strict` and `off` sandbox profiles, which no run has exercised
  (`docs/probes.md#cliGrok`); and a needs-work round in E6, where none arose
  (`#e6`).
- `.70`'s and `.71`'s launcher sentences, for a headless host that meets an
  open ask and for a host whose cross-agent tools are missing: each written and
  pinned by a test at T15 (`VERIFY.md` T15, "Landed"), neither met by a run,
  since the leads of E7 and E9, the engine-placed runs after T15, asked nothing
  (`docs/probes.md#e7`, `#t12Fix3`) and every host had the tools. T15 closed
  both beads on this entry's word.
- The trusted-workspace case of the project-settings limitation below, and a
  project `apiKeyHelper` reaching a specialist: both unprobed
  (`docs/probes.md#t12Fix2`; README, the Claude prerequisites); `atc-s96.93` is
  their probe.

**3. The decision**, by an ordered table in which the first row whose test
holds decides:

| order | test | outcome | here |
|---|---|---|---|
| 1 | a hard requirement failed on some host with no operator step that closes it — the permission matrix and loop guard, the deny list and exclusion flags, no git metadata by specialists, the verifier failing closed, packaging on all three hosts — or a Critical finding of the final review stands | no-go | does not hold |
| 2 | a `?` in any run's verdict not yet read by a person | no decision until it is read and the reading recorded | does not hold |
| 3 | an Important finding of the final review still open after its loop and escalation | no-go until it is fixed or ruled by the user | does not hold |
| 4 | an E-row unrun, cut short by a cap, or ended outside the design's clean state; or a hard requirement that rests, on some host, on an operator prerequisite the README names | go with conditions, each named with the host it binds and its carrier | holds |
| 5 | otherwise | go | — |

Row 1 does not hold. No Critical finding stands. R1-1 was confirmed by probe:
a writable Claude role's Write tool wrote the project root, its `.git`,
`.cross-agent/`, `$HOME` and its own `.git` pointer, and a read-only role's
`EnterWorktree` made a worktree and a branch. The fix gave every Claude role
the CLI's own `dontAsk`, a tool allowlist and workspace-only edit rules, after
which every outside write was refused, fresh and resumed (`#t12Fix1`); no
recorded run had used that path, every Claude containment probe having written
through the shell (`task-12-findings-round-1.md`, R1-1), and E8 and E9 are the
whole loops under the fix, E9's Claude lead under `dontAsk` with its allow rule
admitting every call to its mount, the writing ones included
(`docs/probes.md#t12Fix3`). R1-3 and R1-4, the verifier passing a program that
a data command's option runs and tool calls it never read, were fixed, and
every archived run and record reads as it did (`VERIFY.md` T12, its "archived
verdicts" row). Each hard requirement holds on every host. No specialist
transcript of the eleven runs shows a `delegate` or an engine launch, and every
engine-placed ledger reads PASS (part 1). The deny targets were refused live
on Claude and Grok, fresh and resumed (`#t12Fix1`, R1-6), and the builder tests
pin each adapter's flags (design section 3). Claude's sandbox and file tools
and Codex's sandbox refuse a write to git metadata; Grok's sandbox does not,
and `verify_worktree`, which runs before every `git_mutate`, refused the
rewritten pointer in the I2 runs under all three hosts (design section 4;
`docs/probes.md#i2`, `#i2Codex`, `#i2GrokHost`). The verifier answers `?` for
every shape the rounds named, the escalation and the wrap-up closing them as
classes (`VERIFY.md` T12, "Landed"). And each host's attach ran whole loops:
Claude Code E1, E3, E2, E2b, E2c, E8 and E9; Codex E4 and E5; Grok E6 and E7.

Row 2 does not hold: every `?`, in E3, E2, E2b, E2c and E4, was read by a
person and the reading stands beside its verdict.

Row 3 does not hold. Of the Important findings, R1-2, R1-5, R2-2, R2-3, R3-1,
R3-2, R3-3, W-1, W-2 and W-3 were fixed and R1-6 closed by its run; R2-1 is an
accepted limitation by the user's own word; and W-5 was ruled by the
controller under the user's standing instruction for this plan, by which,
after the escalation, the controller decides each standing finding with the
evidence and records the ruling here (`task-12-brief.md`, the controller's
ruling on the loop's escalation). The controller's two rulings under that
instruction, each of which the user may overturn:

- W-5, a stated boundary: the guard keeps a task from placing host
  configuration at the root, refusing a symbolic link at any of the four host
  paths wherever a task's branch or worktree carries one, and it does not
  police what the operator's own configuration at the root refers to; the
  operator keeps the root's host configuration as regular files too (design
  section 4; README, the Grok section's host-configuration paragraph).
- The 16 MiB host listing, a Minor: no change, because a host directory whose
  listing passed that buffer would have its commit or merge refused, which
  fails closed (`task-12-findings-round-4.md`, the controller's decision 8).

Row 4 holds, on its second test. Every E-row ran, none was cut short by a cap,
and each ended in the design's clean state: the root worktree alone, no
`task/*` branch, a clean tree and the suite green on `main` read `pass` in all
eleven verdicts. But on some hosts a hard requirement rests on an operator
prerequisite the README names, and each such prerequisite is a condition:

- (a) Codex host — the project named in `CROSS_AGENT_PROJECT` before `codex`
  starts, for the Codex plugin. Without it the plugin's launcher starts no
  server and Codex says nothing, so packaging on Codex rests on it. Carried by
  README "Install it in Codex" (`CROSS_AGENT_PROJECT="$PWD" codex`, and a
  resumed session started the same way), `atc-s96.73`, `VERIFY.md` T14
  "Probes" (B1 and the markers bullet) and its "as packaged" subsection, and
  `docs/probes.md#codexMarkers`.
- (b) Grok host — the folder trusted in `~/.grok/trusted_folders.toml`; the
  project's own `.grok/config.toml` naming the checkout under `[plugins]` and
  raising `[mcp] max_output_bytes` to 100000; and `.grok/` ignored by git, the
  change committed. An untrusted folder loads no project plugin, Grok's
  default cap of 20,000 bytes cuts `describe_mode` under both dev-team modes,
  and an unignored `.grok/` stops a loop's first step and, once committed,
  would reach every task worktree, so packaging on Grok rests on all three.
  Carried by README "Install it in Grok", `docs/probes.md#t15Attach`,
  `#grokWorktreeMount` and `#p9GrokInherits`, `VERIFY.md` T15's "result cap"
  row, and `atc-s96.79` for the cap line.
- (c) Every host, wherever a Grok role runs read-only on Linux with rootful
  podman — `/run/podman` at `0711`. While podman leaves it `0700 root`, Grok's
  read-only and `strict` sandboxes refuse to start and the build fails the
  task by name rather than run it unsandboxed: the requirement fails closed,
  and the step is what lets Grok's own sandbox be the boundary for those
  roles. Carried by README "Prerequisites on Linux",
  `docs/probes.md#grokSandboxSocket` and `VERIFY.md` 6b "Probes".
- (d) Every host, wherever a Claude role runs on Linux — `bwrap` and `socat` on
  `PATH`, and on Ubuntu 24.04 and later a bwrap AppArmor profile that wins over
  the stock `bwrap-userns-restrict`. Without them the task fails before Claude
  starts or at its sandbox's first command, failing closed as in (c); with
  them Claude's sandbox is the shell's half of the git-metadata and read-only
  guarantees (design section 3). Carried by README "Prerequisites on Linux",
  `VERIFY.md` M1's "Probes rerun this milestone" paragraph,
  `docs/probes.md#p1ProfileShadowed` and `QUESTIONS.md`'s first item.

Two operator prerequisites are not conditions. Limitation 1's advice below —
keep a file-tool allow rule that reaches beyond the workspace, or an
`additionalDirectories` entry, out of a tracked `.claude/settings.json` where
specialists run (README, the Claude prerequisites) — bears on the Claude
file-tool fence, but no hard requirement rests on it: no git metadata by
specialists rests on the adapter's own deny rules for the protected paths,
which held even under `bypassPermissions` (`#t12Fix1`, candidate C1), and on
the sandbox's `denyWrite` for the shell; what the advice keeps closed, writes
beyond the workspace such as the project root and `.cross-agent/` in a
workspace the operator trusts, is the accepted limitation itself. And the
credentials-store sign-in — "A Claude specialist signs in with the credentials
`claude login` stored", or under `"billing": "api"` with the key from the
server's environment (README, the Claude prerequisites) — is a prerequisite
of every Claude role that decides whether it can sign in, not what it may do.

Accepted limitations. By the user's word (2026-10-02; the two messages are
quoted in `task-12-findings-round-2.md`, its last two sections), each with its
evidence and the advice that reduces it:

1. A project's tracked `.claude/settings.json` reaches every Claude role: its
   file-tool allow rules beyond the workspace and its `additionalDirectories`
   would pre-approve what `dontAsk` refuses. Claude Code applies them only in a
   workspace its operator trusts, and the trusted case was not probed
   (`docs/probes.md#t12Fix2`; design section 3). Advice: the README's, above.
2. `dontAsk` refuses Claude Code's sensitive paths inside a role's workspace —
   `.vscode/`, `.idea/`, `.husky/`, `.npmrc`, `.gitmodules` and more
   (`#t12Fix2`). A task that must change one is finished by hand.
3. A sandboxed Claude shell reaches no network host (`#t12Fix2`). A dependency
   install goes in `setupCommand`, which `run_command` runs outside any
   sandbox.
4. Grok's `.git` pointer is checked, not protected: its sandbox lets a Grok
   implementer rewrite it, and `verify_worktree` refuses the rewritten pointer
   before any `git_mutate` (design section 4; `docs/probes.md#i2GrokHost`).
5. `.76`: the operator's Claude Code plugin hooks run inside Grok specialists
   (`VERIFY.md` T15 "Probes", its last bullet; `docs/probes.md#i1GrokHost`).
   They run inside the specialist's sandbox under its markers and ancestry,
   so a server any of them reached would serve the specialist row. The
   controller's operator note (`task-12-brief.md`, ruling 11): keep the Codex
   plugin's stop-review gate off while Grok specialists run, because with it on
   a Grok specialist's Stop hook launches a Codex task that no transcript
   records; that task carries the specialist's markers, so a server it reached
   would still serve the specialist row. No README step names the gate, so it
   is a note, not a condition.
6. `.78`: a Grok specialist at an attached root is offered the launcher skill,
   while its row has no `delegate` and Grok's own dispatcher refuses the name
   (`docs/probes.md#grokWorktreeMount`, `#i1GrokHost`; README "Install it in
   Grok").

By the design's own bounds: `.74`, layer 1's deny rules rooted at the server's
own checkout, since layers 2 and 3 hold and the verifier's judge is
path-independent; `.85`, `.86` and `.89`, the host-configuration guard's reach
— below the root, past `commit` in the worktree, and in case at the merge —
since the root merge is the gate on the four top-level paths and this
machine's filesystem is case-sensitive; and `.77`, `childEnv` passing
`GROK_SESSION_ID`, `AI_AGENT` and `GIT_EDITOR`, harmless in every run
(`docs/probes.md#grokHostHops`). What a specialist inherits from the
operator's host is bounded by the matrix, the markers and the sandbox, which
the design promises, not by a clean-room specialist, which it does not.

Against Decision 0008's terms: the same team, its roles and lifecycle — the
four roles and the engine-placed lead took tasks from plan to cleanup in
eleven runs; runnable from each of the three hosts on the user's subscriptions
— host- and engine-placed loops ran under Claude Code, Codex and Grok, with
conditions (a) and (b); each CLI's own sandbox the boundary — with conditions
(c) and (d), and limitations 1 to 4 accepted; no delegation loop — the matrix
by ancestry, the depth cap, lineage and the deny list, with no specialist
`delegate` or engine launch in eleven runs; specialists never writing git
metadata — refused on Claude and Codex, checked on Grok.

**4. The deferred beads** (each `atc-s96.<n>`), one line each with its class
and reason; `.57` was closed at the merge, since `--setting-sources project`
drops the operator's plugins, skills and commands from Claude specialists
(`docs/probes.md#t12Fix1`):

- `.60` follow-up — the verifier's unmodeled shapes, its notes now holding the
  out-of-class shapes the rounds named: the verifier is an audit that answers
  `?` for each, read by a person, and the sandboxes and the deny list enforce.
- `.62` follow-up — a lead-row `delegate` in a script, and every doubt
  reported: the same reason as `.60`.
- `.66` follow-up, reopened — host fidelity: E8's host printed no roster before
  the first dispatch and named other engines for three Claude roles, and E9's
  printed no roster before the lead's dispatch (`docs/probes.md#t12Fix3`).
- `.69` follow-up — Codex's `file_change` item, its notes now holding a second
  archived log from fix round 1's probe (c): the same reason as `.60`.
- `.72` follow-up — Codex's own `sleep` and `request_user_input_async`: the
  same reason as `.60`.
- `.73` follow-up, behind condition (a) — the Codex plugin without the
  `CROSS_AGENT_PROJECT` step: it waits on Codex substituting `${PLUGIN_ROOT}`
  or handing a server the session's directory.
- `.74` accepted limitation — deny rules rooted at the server's own checkout:
  layers 2 and 3 hold; a design question on layer 1.
- `.76` accepted limitation — the operator's Claude Code plugin hooks inside
  Grok specialists: as limitation 5; a probe of `plugins.disabled` and
  `GROK_CLAUDE_HOOKS_ENABLED`.
- `.77` accepted limitation — `childEnv` passes `GROK_SESSION_ID`, `AI_AGENT`
  and `GIT_EDITOR`: harmless in every run; a scrub, test first.
- `.78` accepted limitation — Grok specialists at the root offered the launcher
  skill: as limitation 6; a `plugins.disabled` decision.
- `.79` follow-up, behind condition (b) — bound `describe_mode` and `list_tasks`
  against a host's result cap: the attach's cap line covers it until the server
  bounds its answers.
- `.80` follow-up — `cross-agent report | head` dies on EPIPE: a CLI bug
  outside the hard requirements.
- `.81` follow-up — no test pins the resolver's unreadable-environment reason,
  the branch every Grok specialist's server takes: the branch fails closed,
  and the final review rated it no higher.
- `.82` follow-up — the launcher's sentence that a host never starts this
  server itself: a host is the operator row; one sentence and a test.
- `.83` follow-up — the one-shot paragraph to name the host configuration the
  merge refuses: launcher text the loops already carry.
- `.84` follow-up — one source for the active task statuses: a refactor beyond
  `.68`'s list.
- `.85` accepted limitation — host configuration below the root: the root
  merge is the gate on the four top-level paths.
- `.86` accepted limitation — commit-making `git_mutate` verbs other than
  `commit` unchecked in the worktree: the root merge refuses what they carry.
- `.87` follow-up — a duplicated test: tests, no hard requirement.
- `.88` follow-up — a flaky read in `tests/runner.test.ts`: tests, no hard
  requirement.
- `.89` accepted limitation — `.cross-agent` and the worktree directory
  matched case-sensitively at the merge: this machine's filesystem is
  case-sensitive.
- `.90` follow-up — `trackedStateFault` names three paths: text, no hard
  requirement.
- `.91` follow-up — one time renderer: text, no hard requirement.
- `.92` follow-up — Grok specialists hold `spawn_subagent`, `scheduler_create`,
  `workflow`, `web_fetch`, `web_search`, `ask_user_question` and the image
  tools, and the adapter withholds none: the verifier answers `?` for a Grok
  tool call outside its archived vocabulary (`VERIFY.md` T12, "Landed"); probe
  `--deny` or Grok's tool settings.
- `.93` accepted limitation's probe — the trusted-workspace case of
  limitation 1, with a project `apiKeyHelper`.
- `.94` follow-up — a test tying the verifier's Claude tool vocabulary to the
  adapter's tool lists.
- `.95` follow-up — E9's lead never called `list_roles` and its report named
  both planner runs `claude`, where the ledger, `cross-agent report` and the
  live process name `codex` (`docs/probes.md#t12Fix3`): report fidelity, not a
  hard requirement, since the ledger and `cross-agent report` carry the engine
  that ran.

Consequences: The plan closes with this entry. `main` carries every milestone,
and the open beads are the epic `atc-s96` as the parent of the backlog (`.25`,
`.26` and `.28`, row 14 of the design's work plan), `prune` (`.48`) and the
deferred beads above. Conditions (a) to (d) are the operator's steps on each
machine and project, carried by the README lines named; the accepted
limitations stand until a bead or a later Claude Code, Codex or Grok release
changes them. The `AGENTS.md` change is proposed as the consolidated
`task-12-agents-md.diff` in `.superpowers/sdd/the-development-of-this-calm-planet/`,
against the `AGENTS.md` blob `43d92acbb62da520252ef77906037a632d1183e0`,
unchanged on `main` since `2de546f` and still `main`'s at `60fa393`, and awaits
the user's approval.

**AGENTS.md changes approved (2026-10-02).** The user approved
`task-12-agents-md.diff`, applied on `main` by `git apply` against the blob
`43d92acbb62da520252ef77906037a632d1183e0` it was built on: seven tasks' Layout
and Run changes as one diff. The opening paragraph names `dev-team-engine`
beside `dev-team` and `solo`. The `src/delegate.ts` bullet gains the
engine-placed lead's mount and composed prompt, the cascade over asks, and
`src/mailbox.ts`. The `src/cli.ts` bullet becomes the operator CLI's twelve
verbs and its exit protocol. The Claude adapter's summary names `dontAsk`, the
file tools' permission rules and the tool allowlist. The launcher and modes
bullets describe the placement sections and the engine lead's own loop. The
attach sentence names the Claude Code and Grok hosts, and a Codex plugin bullet
follows it. Planned is the backlog (row 14) alone. Run gains the read-only CLI
line and the Codex and Grok host lines. The managed blocks are untouched, and
`CLAUDE.md`, which includes `AGENTS.md` by reference, is unchanged.

**The user's word on this decision (2026-10-02): the binding withdrawn.** "No
need to be the second binding of dev pack. … This project will follow its own
development path; if we remain tied to the Dev Pack, we'll be restricted. If
this tool needs to support the import and export of configuration files for
Team Pack or Workflow, that functionality should be developed within this
project."

So this entry decides no binding. cross-agent is not the OpenMausBot pack's
second binding, and the devpack's Decision 0008 no longer frames it. The design
already said so: "Standalone: no OpenMausBot dependency", and the mode format is
native only (design "Context").

What stands is this project's own record at the close:
- the eleven runs;
- conditions (a) to (d), as the operator prerequisites a release names;
- the accepted limitations;
- the deferred beads.

Importing and exporting team or workflow configuration, if it is needed, is a
feature of this repository in its own format (`atc-s96.96`). The note drafted
for the devpack's `EVIDENCE.md` under part C was withdrawn uncommitted.

## 0012 — 2026-10-03 — A branch worktree as a project of its own (`atc-s96.97`); AGENTS.md Layout and Run (user-approved diff)

Context: The user develops several branches of one repository at once, one
worktree per branch, and asked on 2026-10-02 whether cross-agent works in each.
It did not:
- every worktree of a repository was one project, anchored at the main checkout;
- its tasks branched from and merged into that checkout's default branch;
- bare repositories were refused.

Decision: The user chose, on 2026-10-02:
- **Opt-in by `init`.** A worktree becomes a project of its own only when
  `cross-agent init` is run in it. One never initialized keeps its mapping to
  the main project.
- **Bare repositories** (`git clone --bare`, then one `git worktree add` per
  branch) are supported.
- **`init` in a worktree copies the main project's setup.** The team config is
  copied with `defaultBranch` set to the worktree's branch, or the mode's
  defaults are used where there is none. The main checkout's Grok attach file
  is copied too.
- **A `cross-agent git-root` verb,** the operator's cooperating path for root
  git while a loop runs.

It was built as `docs/design.md` describes it ("Which project", section 4, the
locks) and merged at `fb0d050` (`VERIFY.md` "T13").

Two rulings were taken in review:
- `branch -d` holds a branch to the last tip its journal's steps recorded, in
  step order (`src/journal.ts#recordedTip`). A journaled move after a merge is
  the better evidence.
- E10's condition that `~/.grok/` stay unchanged by sha256 is met in purpose,
  not in letter. The operator's own running `grok` wrote its log and memtrace
  during the run, and 86 unreadable `sandbox-blocked.<pid>` files were compared
  by mtime. No configuration, auth or trust file changed
  (`docs/probes.md#worktreeProjects`).

The user approved `task-13-agents-md.diff` on 2026-10-03. It was applied on
`main` by `git apply` against the blob `8efa36be7e739ec3156825a462980bb6e93209d7`:
- the `src/project.ts` sentence names the two new discovery rules;
- the CLI bullet lists `git-root`;
- the `src/locks.ts`, `src/worktree.ts`, `src/gitmutate.ts` and `src/gitroot.ts`
  lines name the repository lock and the repository located from outside;
- Run gains `init` in a branch worktree.

The managed blocks are untouched, and `CLAUDE.md`, which includes `AGENTS.md`
by reference, is unchanged.

Consequences: The limits the plan stated stand, documented in the README
("Several branches at once") and the design:
- Grok folder trust is the operator's;
- Codex writes its own trust entries;
- a hung git hook needs manual recovery;
- plain git run by hand during a loop can interleave;
- a separated main's worktree needs `init --from <main checkout>`.

The follow-ups are `atc-s96.98` to `.102`.

## 0013 — 2026-10-03 — The repository renamed from `agent-team-cli` to `cross-agent-cli` (`atc-s96.103`); AGENTS.md (user-approved)

Context: The user asked on 2026-10-03 to rename the project from `agent-team-cli` to `cross-agent-cli`. The product was already `cross-agent`: the package, the CLI command, both plugin manifests' `name`, the MCP server and the launcher skill. `agent-team-cli` was the repository's own name:
- the directory `~/Documents/agent-team-cli`;
- the Codex marketplace name, and so the install id `cross-agent@agent-team-cli`;
- both manifests' `author`;
- the README's install paths and three design lines;
- `AGENTS.md`'s title and Codex line;
- the steward project name.

Decision: The user chose, on 2026-10-03:
- the new name wherever it is live;
- records of past runs (`docs/probes.md`, `VERIFY.md`) keep the paths, marketplace name and plugin id their runs used, with one note each saying so;
- the bead prefix `atc-`, git history and `~/.cache/agent-team/` unchanged;
- the directory moved last;
- no migration or compatibility work: "This tool has never been used in any development project, so there is no need to consider any migration work related to it."

The plan (three plan reviews) and the implementation (five commits, test first; a three-seat review with no Critical or Important finding) were merged at `1a17004`. `npm test` gives 933 tests, 932 pass, 1 skipped; citations are 1458, none by line, 0 misses.

The user approved the `AGENTS.md` change on 2026-10-03: "I approve you to modify the AGENTS.md, just complete the task for me". It changes the title and the Codex install id. The managed blocks are untouched, and `CLAUDE.md`, which includes `AGENTS.md` by reference, is unchanged. The steward's project name follows, in `PROJECT.md` and `state.json`.

The move: since the user asked for the task to be completed, the controller runs the move as the session's last step. The plan had left it to the user. Two scripts run, both kept beside the plan:
- **`task-14-move.sh`:**
  - a preflight of every process's cwd and command line, with only inspected pids allowed;
  - `mv -T`;
  - `core.hooksPath`, absolute to the old path, set to the relative `.beads/hooks`;
  - the e2e sample's Grok attach repointed and verified.
- **`task-14-smoke.sh`:** one `claude-sonnet-5` turn under `--plugin-dir` at the new path. It passes only with the plugin's server connected and the operator row's exact tool set.

Their results follow below.

Consequences: These steps are left to the user, because the app or the CLI owns each one:
- Claude Code asks to trust the new path on its first start there.
- Codex writes its own trust entry.
- The Codex desktop app's project list re-adds the folder at the new path; the stale `agent-team-cli` and `cross-agent-m3` projects are removed through the app.
- VS Code reopens the folder.

These entries keep the old path, harmlessly:
- `~/.claude.json`'s project key;
- `~/.codex/config.toml`'s trust entry;
- the dormant OpenMausBot Phase 0 binding under `~/.cache/agent-team/openmausbot-data-4/`;
- the probe archives.
