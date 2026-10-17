---
updated_at: 2026-10-17T00:12:58Z
updated_by: claude
session_status: paused
branch: main
---
# Handoff

## Now

**atc-s96.160 is fixed at its cause (2026-10-17, Claude Code host).** The user asked for a
review of the Codex-host campaign, then said to go ahead with the recommended fix. The
earlier .160 fix (`b5a5522`) allowed only the exact read commands seen in archived runs,
so the retest failed again on a new harmless read (a Codex plan reviewer reading
`01-planner-delegate.json`). Row 8 now ignores a `delegate` name the reader cannot follow
to a call, on any row; a followed delegate call still fails and every other doubt stays.
It ran through the configured dev-team from this Claude Code session on installed 0.1.9:
one plan review, two code-review rounds (one Important wording finding fixed), merged as
`39ac7c8`. Root suite: 1281 tests, 1278 pass, 0 fail, 3 skipped. The retest's verifier,
rerun from source against the retained records, now reads 8 pass, 0 fail, exit 0.
`VERIFY.md` has the full record. Root is clean, root worktree only, no task branches.

What has not changed: the frozen candidate `24ea2d2` is still installed and selected in
Codex and does not carry this fix; the sample is still at `7ca2bb3` with its original
dev-team config; the solo and engine-led scenarios have not run. Nine beads stay open
(.155, .156, .157, .159, .160, .161, .162, .169 held for candidate acceptance, and
umbrella .163). Whether and how to finish that matrix is the user's decision.

The rest of this section is Codex's state at the user's pause (2026-10-16T22:43:48Z),
kept for the matrix. Its Task10 planner was cancelled before delivering a plan; the work
it was meant to plan is now the merge above.

Acceptance campaign atc-s96.163 is paused. Before this session, .160 needed an additional
source pass after the candidate retest; that pass is `39ac7c8`. .155/.156/.157/.159/.161/.162/.169 are merged but
held for candidate acceptance; .163 is umbrella. Task9 .168 remains closed. Source main
at the pause checkpoint was abd355817a78e74e3f557f0d60edc93524649d6e.

Frozen candidate24ea2d285c7c12349dc41ba351dba1dab02fb5cd remains installed/selected as
cross-agent@cross-agent-cli0.1.9. Its173 files/executable bits match the retained export;
original plugin stays enabled and managed MCP policy equals the saved original. Source
MCP independently still serves the published0.1.9 cache (full response has no project
object and old staging), correct source root/host placement/roster/no warnings. That is
the intentional frozen development bootstrap, not a new .162 failure. Source config
68f88c... unchanged; main/npm test/no setup/auto/depth1 and exact bindings remain.

Fresh test chat01a146a9-922d-7ca0-a358-3e5b91932980 is settled. Dev-team functional workflow
passed: slug_rotate merged7ca2bb36577d379e56e404c340ba27e7acbeb6c2,147 tests (139 original
methods unchanged +8), all3 clean reviews, all9 depth1/parentnull/exit0, root-only/no task
branches/clean. Formal acceptance remains BLOCKED: frozen verifier7pass0fail1? exit2.
Parent independently reproduced the same result outside the workspace sandbox.

Exact unresolved record: first Codex plan reviewer86afc77121886d7bdd92e4ce6f25a9ed99db,
native session01a146ac-86a4-7e53-b6c1-26f841d567fa, rollout line50 custom exec. Its command
uses Python JSON inspection and cat; delegate appears only in evidence filename
01-planner-delegate.json. Child diagnosis says filename discount requires readsOnly for
the whole combined command; Python prevents it. The source planner must verify the cause,
choose the smallest bounded correction and preserve fail-closed behavior. Keep this
under existing .160. No renamed evidence, edited transcript or manual waiver; old7/8
remains preserved. Task10 acceptance task10-acceptance.md; no source plan/worktree yet.

Full test-chat final/thread and parent reproduction retained. Captured directory
candidate-dev-team-capture-v1 contains198 files; all197 original hash entries match.
All582 original sample evidence hashes also match; config remains original dev-team hash
6dc1f7... and no other mode has started. Full9-task metadata/results/native logs/three
Codex rollouts/journal/replay data retained. Native audit is bounded: no unauthorized
specialist delegation/real engine/project Git write observed; operator plugin markers
absent in recorded Codex inputs; top-level skills.list/read availability remains unknown.
Child host's extra rev-parse HEAD probe was refused and reconciled before delegation.

A parent coordinator approval service timed out before launching a read-only verifier
reproduction. Its explicitly permitted single direct retry ran and reproducedexit2.
This was not an unsafe verdict, product defect or current blocker. Earlier install
output-budget truncation and unsupported --mode/--propose combination remain recorded.

Only after explicit resume, re-establish Task10 planning through published0.1.9
MCP: planner/plan reviewer/final verification, worktree/test-first/commit/gate/all3 reviews/
verified corrections/merge/root tests/cleanup. Keep implementation logs in TMPDIR and
no ignored state under its WT so frozen old staging succeeds. Then freeze/install fixed
candidate and rerun the affected verification with original cohort/config preserved;
plan determines the narrow genuine rerun without gratuitous feature churn. Continue
solo then both engine leads only after this scope passes8/8. No final check is waived.

Task9 source commits are27d9f3c and the required Minor wrap746521e, seven planned files.
All three served staging copies use paired bracketed exclusions; runtime/error handling,
commit/merge guards and public interfaces are unchanged. The real Git2.43.0 regression
fails before the change. Actual RED1280/1262/5/13, local GREEN and wrap1280/1267/0/13;
both committed-head gates and post-merge root npm test1280/1277/0/3. Logs retain raw skip
names/reasons: three native opt-ins guarded, ten additional specialist sandbox limits.
No invented RED for the documentation/test-only wrap. Current mode sizes41447/58274/4508.

Plan R1 noMajor/twoMinor were verified/folded. Code R1 all noMajor: Claude24358167 had
three Minor documentation/coverage points, Codexce6e6512 and Grok3048c6cb none. Implementer
57f75a2c verified/folded all three. Fresh R2 Claude0b82ff7a, Codex828e0128 and Grok9a720100
all have no findings, reviewed746521e. Mandatory final rebase was a no-op; merge/root/
cleanup succeeded. No new confirmed finding, further wrap, resolver or waiver.

Eleven full results, native specs/logs, actual bindings, journal and host-placed log lines
are retained under task9-* evidence. All11 are done/depth1/parentnull/exit0. Native349
recorded tool entries,224 command strings and21 edits were inspected: no unauthorized
project Git metadata write, delegation or real-engine launch observed. Private diagnostic
Git fixtures and npm-test fixtures are authorized test work. Edits are confined to the
implementer tasks and the seven intended worktree files. This is a recorded-call audit,
not OS-wide history or frozen0.1.9 plugin-isolation proof. Exact owned-spec/worktree process
inspection found0 matches/0 unreadable entries/0 signals; test teardown remains primary.

All9 original staging artifacts,582 prior sample evidence files,140 Task7 and96 Task8
hashes match. Both configs are unchanged. Sample remains clean/root-only maina9b90d4,
139-test prior baseline. Planner private fixture was already inspected and removed by
host; native permission refusal and host cleanup are retained separately. Rare custom-name
(!/^/backslash) and case limits are accepted and explicitly stated; no new pathspec
framework or universal merge-protection claim is made.

Two host deviations are recorded: read-only git_root status --short was refused before
Git ran, immediately reconciled with consistent state; R1 brief prose omitted explicit
round/seat labels although API seats/IDs/bindings and reviewed SHA distinguish each task.
R2 briefs explicitly include round/seat. Shorter Conventional Commit subjects and the
served correction commit are nonmaterial departures. No auto-review rejection occurred.

Candidate install/restoration snapshot and v2 prepared briefs/configs remain in campaign
evidence. Original sample config is candidate-original-sample-config.json. Original
managed owner/policy snapshot is candidate-original-managed-connection.json. Restore
through the supported helper after all runs settle; remove only the owned temporary
plugin/marketplace, preserve unrelated preferences. Never replace the entire config.

After .160 acceptance, complete six solo paths Claude Opus/Codex Sol/Grok4.7 default effort,
Claude-led shortest-first and Codex-led unique-reverse, with scripted mailbox answers,
complete verbatim lead reports and all six scoped8/8 verifiers/independent audits. No
tracker/Steward config in sample, no host loop/Git/test steps while engine lead is live.
Use --slug. Candidate export/cache are frozen; never hot-load this checkout. Current
captured engine versions Claude2.1.302/Codex0.163.0/Grok1.0.52, Node24.11.0, Git2.43.0.

The .161 user-accepted top-level skills.list/read availability and backend-receipt unknowns
remain; no final verifier check is waived. Task4 standalone mount proved specialist-row
transport, not actual lead ownership. Note any Claude saved-MCP-answer/Read occurrence in
final engine runs without inventing coverage. The preparatory setup check passed outside
the workspace sandbox after its SQLite startup failed inside it. The temporary candidate
owner is now selected; original owner/policy/config restoration evidence is retained.

Full records: root VERIFY.md, task9-* ignored evidence, campaign.json and journal
fix-staging-exclusions-20261016. Task8 and earlier records/evidence remain intact.
Steward CLI unavailable; manual records. Other-session runtime ownership untouched.
No push, release or remote sync.

## Prior verification context

**Additional Codex-led variant is complete (`atc-s96.158`, user-requested).** Chat
`01a1419a-d274-7eb1-b049-14a27a00bb0e` ran installed 0.1.9 with the exact changed bindings:
lead/planner/implementer Codex `gpt-6.1-sol` xhigh, plan reviewer Claude `claude-opus-5-5`
xhigh. All thirteen records finished at correct depths/ownership with exit 0. Two clean
three-seat review rounds cover `bf9a39d` then `a9b90d4`; all 139 tests pass, merge and
cleanup are complete, and the original sample config is restored byte-for-byte. Native
evidence confirms RED before implementation, mailbox chronology, no shell/file changes by
the lead, one host lead delegation and full verbatim relay. However, the lead invented a
specialist-test restriction and required factual operator correction, without waiver
(`atc-s96.159`). The independent verifier twice returned 7 pass, 0 fail, 1 unresolved
because its transcript reader cannot certify source reads/tool-discovery code (`atc-s96.160`).
Functional success is not an unconditional pass. `VERIFY.md` and the sample's ignored
`.cross-agent/codex-lead-e2e-evidence/` preserve all details, including the exact policy
correction and premature "user-authorized fallback" claim. All 459 prior evidence files
retain their hashes. Diagnose/report only; all findings remain open. No push or remote sync.

**Earlier three-mode coverage is complete.**
`atc-s96.154` finished in chat `01a14161-76ce-7ad2-9a39-d7cc9aa2cff0`: Claude Opus xhigh
lead `57e921b11be115d34a10b59557c43208f163`, seven depth-2 specialists with correct parents
and bindings, all three reviews clean on `8396e6e`, 131 tests passing, and independent
verifier 8/8. Its one read-only Bash call violated the no-shell rule after a 56.3 KB mode
response overflow (`atc-s96.157`); functional success does not erase that compliance failure.
The host launched only the lead and relayed its report verbatim, verified from the archived
rollout. Native evidence independently confirms test-first execution and the scripted mailbox
answer before planning. That run ended with clean main at `8396e6e`, root worktree only,
no task branches, and original dev-team config restored byte-for-byte. Evidence is in
`.cross-agent/remaining-modes-evidence/` under the sample; `VERIFY.md` has the complete matrix.

Solo verification (`atc-s96.153`) finished in chat `01a14151-6aba-7c13-b616-102793981539`:
all six scenarios produced the expected examples, all tasks exited 0 at depth 1 with the
requested bindings,
and the clean sample ended at `7b3110b` with 123 passing tests and complete cleanup. Claude
and Codex verifier pairs pass 8/8; Grok writable is blocked on the reader's unrecognized
`search_replace` tool, independently reproduced (`atc-s96.155`). Both Codex tasks searched
outside their assigned directory (`atc-s96.156`), although their functional/verifier checks
passed. The independent audit confirms 106 earlier evidence files unchanged. Full details
are in `VERIFY.md` and the ignored sample evidence. Diagnose/report only; do not fix these
findings. Results and findings are recorded in local evidence commits. No push or remote sync; existing
dirty `.beads/interactions.jsonl` stays uncommitted.

**Codex host acceptance passed (`atc-s96.152`, closed, 2026-10-15).** Installed 0.1.9 ran
the full `dev-team` host loop in test chat `01a14126-c384-7c73-9be7-0a948bb701d7` on `local`,
in `/home/wsh/Documents/cross-agent-codex-host-e2e-20261015`. Its live connection and roster
matched; all 11 tasks finished with the configured bindings at depth 1. Claude, Codex, and
Grok approved both review rounds; one Minor Unicode source-spelling finding was fixed and
verified. Final sample `main` is `22c0657`, all 123 tests pass, tree clean, only the root
worktree remains, task branch deleted. Both the host and independent coordinator verifier
returned eight passes with no missing evidence. No cross-agent defects were found. The
sample's ignored `.cross-agent/host-e2e-evidence/host-run-summary.json` and coordinator
outputs retain the evidence and disclosed host/engine/sandbox observations. `VERIFY.md`
records the result. Preparation commit: `0a4edb7`; final evidence is committed locally under
this bead. No push or remote sync is authorized.

**Backlog run through the `dev-team` loop (the user, 2026-10-15): finish the remaining `atc-s96`
beads, several beads per task, on requirements only — rare, hard edge cases get a stated
limitation.** Triage committed as `6a6077a`: `.60`, `.105`, `.85`, `.86` closed as accepted
limitations; `.25`, `.26`, `.28`, `.48`, `.96`, `.99`, `.100`, `.110`, `.93` deferred with reasons.
31 beads in 12 tasks: (1) launcher text `.122` `.82` `.83` `.66` — merged as `f395066`, closed;
(2) docs `.125` `.126` `.127` + task 1's two follow-ups — merged as `17ea9ae`, closed; (3) EPIPE `.120` `.121` — merged as `f811cf4`, closed; (4) server answers `.95` `.102` — merged as `12709e0`, closed;
(5) tidy `.84` `.87` `.91` `.81` `.89` `.90` `.101` (old tasks 5 and 6 combined) — merged as `1dfad88`, closed; (7) self-hosting authority
`.123` `.74` — merged as `4b785cc`, closed; (8) verifier `.69` `.72` `.62` `.94` — merged as `f6b89c2`, closed; (9) answer bounds `.79` and (10) hung git `.98`, combined as one task — merged as `9f29d5c`, closed;
(11) Grok specialist isolation `.77` `.92` `.78` `.76` and (12) Claude compound commands `.113`, combined as the last task — merged as `1696dad`, closed. **The backlog run is complete.** Released as 0.1.9 (`439a8c8`, pushed); agent-plugins PR #24 merged; Claude Code runs 0.1.9.
Team runs from the installed 0.1.8 build. No push or release without asking.

**New epic `atc-2jl` (Decision 0022, 2026-10-14): the `dev-team-engine` lead owns the backlog
and the project's records.** The user chose: the lead takes an epic/bead list or a goal it
breaks down (approved once by the user); a general `records` config (tracker commands, record
files); `dev-team-engine` itself changes; records committed at the root by new `track` and
`record` tools. `atc-s96.117` is folded in. The user allowed `AGENTS.md` edits this session and
asked for the work to run through the dev team, asking only for the user's own decisions.

**The setup skill is merged (`atc-s96.134`; parts `.1` and `.2` closed 2026-10-13).** A plugin user now
sets a project up, or changes its team, by asking the host (`/cross-agent:setup`, Codex `$`, Grok `/setup`,
or in words); no terminal step. The spec is `docs/superpowers/specs/2026-10-13-setup-skill-design.md`;
Decision 0021 records it and the user-approved `AGENTS.md` edits.
- Part 1, `init --propose` and `init --config`, merged as `e3ff61c`.
- Part 2, `skills/setup/SKILL.md` with routing, docs and tests, merged as `62f5aad`. The root suite
  passed (1117 tests, 0 fail) on a re-run; the first run hit a test-only race (`atc-s96.139`).
- Both went through the dev-team loop; `VERIFY.md` has a section for each.

**Release 0.1.4 is merged and installed (`atc-s96.140`, closed).** Source `6e46507` pushed;
agent-plugins PR #19 (payload + marketplace README) merged by the user as `1091b8a`; plugin updated.
Live checks (`VERIFY.md`): Claude Code end to end passed; Codex passed through approved retries
outside its sandbox (cross-agent now installed in the user's Codex; MCP hand-off not run); Grok
discovers `/setup` but in single-turn headless mode wrote and committed without the user's answer.

**Release 0.1.5 is merged and installed (`atc-s96.142`, closed 2026-10-14).** PR #20 merged as
`9adee2e`; it carries the consent fix `atc-s96.141` (`bebd8f1`). Live re-check passed on Grok
(single-turn `/setup`, twice), Claude Code and Codex: numbered choices, nothing written. The setup
skill epic `atc-s96.134` is closed.

**In flight: the follow-ups, through the dev-team loop (user's choice 2026-10-14).**
- Task 1, `atc-s96.135` + `.139` (flaky tests, test-only): merged as `5311717`, root suite
  1121/1119/0 fail, beads closed.
- Task 2, `atc-s96.136` + `.137` + `.138` (setup/init wording, mode loops, delegate refusals,
  design/install docs): merged as `2deb7c6` (two review rounds; round 2 clean on all three
  seats), root suite 1123/1121/0 fail, worktree and branch removed, beads closed. Follow-up
  `atc-s96.143` (`rootWriteFault`'s init hint and a test comment) is open.
- Task 3, `atc-s96.143` (`rootWriteFault`'s refusal names the setup skill first): merged as
  `c028cc3` (review round 1 clean on all three seats), root suite 1123/1121/0 fail, bead closed.
  Follow-ups `atc-s96.144`, `atc-s96.145` (P4) are open.
- Release 0.1.6 (`atc-s96.146`, closed): source `1b1ff0b` pushed; agent-plugins PR #21 merged by
  the user as `a7cabee`; Claude Code updated and reconnected, and this session's server serves the
  0.1.6 text. Codex's cache still held 0.1.5: its update (`codex plugin marketplace upgrade`, then
  `codex plugin add cross-agent@agent-plugins`) is the user's.
- Codex updated to 0.1.6 at the user's request (`codex plugin marketplace upgrade`, `codex plugin
  add cross-agent@agent-plugins`); its cache equals the 0.1.6 dist payload.
- User instruction (2026-10-14, saved with `bd remember`): follow-up beads are not left open; fix
  them through the dev-team loop, including follow-ups those fixes generate, and ask before any
  push or release. `atc-s96.88` closed as already fixed by `atc-s96.139`.
- `atc-s96.144` + `.145` merged as `5e3d713` (plan review hit its limit; the user chose the small
  fix and closed `atc-s96.148`; code review clean in two rounds); root suite 1125/1123/0 fail.
- `atc-s96.147` merged as `a450ddd` (plan narrowed in review to a binding that names the root;
  code review clean in two rounds); root suite 1126/1124/0 fail. Every follow-up of this round is
  closed. The ~40 older backlog beads under `atc-s96` are not in this scope unless the user says so.
- Release 0.1.7 (`atc-s96.149`, closed): `0ab03cf` pushed; agent-plugins PR #22 merged by the
  user as `9354b8f`; Claude Code and Codex both on 0.1.7. Live check of Codex's legacy mount
  passed: the shell carries `CROSS_AGENT_PROJECT`, the setup skill is offered without a server,
  the first `solo` write answers `reconnect: true`, and a restarted session's mount serves the
  new config (`VERIFY.md`).
- Nothing from this round is open. The ~40 older backlog beads under `atc-s96` are untouched
  unless the user asks.
Ask the user before any push or release. `main` was pushed at `0ab03cf`; record commits after it are local.

**Release 0.1.3 is merged and installed (`atc-s96.133`, closed 2026-10-13).**
- `main` was pushed at the frozen source `6f9f2c4`.
- The user merged https://github.com/WSH95/agent-plugins/pull/18 as `f5ca542`, updated the
  plugin and reconnected.
- This session's server runs from the 0.1.3 cache and serves the user's team.
- 0.1.3 carries the EPIPE fix, `init`'s team defaults and the engine lead default.
- The dev team on this repository now runs 0.1.3.

**A direct `node --test` inside Codex's sandbox (`atc-s96.130`, `.131`, `.132`, closed
2026-10-13).** One dev-team task merged all three as `5b9919b`.
- Every test file now opens with `tests/child-check.mjs`. Inside Codex's sandbox, a direct
  `node --test` of any file stops in under a second with the cause, instead of stalling.
  Everywhere else the check does nothing.
- The EPERM fixture matches Node's real result.
- `AGENTS.md` (user-approved, Decision 0020) tells delegated sessions how to run tests and
  names the new files.

Gate and root suite: 1061 tests, 1059 pass, 0 fail, 2 guarded skips. Two review rounds,
all seats `no major issues`, and no follow-ups were left (`VERIFY.md`).

**`npm test` inside a specialist's sandbox (`atc-s96.124`, `atc-s96.129`, closed
2026-10-13).** One dev-team task merged both as `6b3913d`.
- Under Codex's workspace-write sandbox, `npm test` now stops in under a second with the
  cause and what still runs. It used to fail and stall, because the sandbox's network
  filter denies the `getsockopt` Node needs for a piped stdout. `network_access` stays off.
- Claude-sandbox-only failures now skip with a reason.
- An interrupted suite leaves nothing a task commit stages.

Gate and root suite: 1056 tests, 1054 pass, 0 fail, 2 guarded skips. Two review rounds,
all three seats `no major issues` in each (`VERIFY.md`). Follow-ups `.130`–`.132`.

**The repository is ready for its own dev team (`atc-s96.115`, `atc-s96.116`, closed
2026-10-13).** The user wants cross-agent developed by its `dev-team` mode. Two fixes:
- `tests/codex-setup.test.ts#codexSetupMcp` now skips below a task (an implementer's own
  `npm test`, or any suite under an engine-placed lead), where no server the suite starts
  is the operator's. Before the fix it failed 1 of 1048 under a simulated task.
- `AGENTS.md` gained "If cross-agent launched you" (delegated sessions leave `bd`,
  `project-steward`, `.project-steward/` and `.beads/` to the operator) and a Run bullet
  (attach a released build, never this checkout; host configuration stays with the
  operator). The user approved it (Decision 0019).

`npm test`: clean 1046 pass, 0 fail, 2 guarded skips; under a simulated task 1045 pass,
0 fail, 3 skipped (`VERIFY.md`). The plan was reviewed by `gpt-6-astra` at `xhigh` effort:
no major issues, four Minor findings folded. Two local commits, not pushed.

**Release 0.1.2 is merged (`atc-s96.114`, closed 2026-10-12).** With the user's
authorization, `main` was pushed at `0ebbac2` (the web tools, `209b512`, and the version
bump), and the user merged https://github.com/WSH95/agent-plugins/pull/17 as `e2b0cba`.
agent-plugins `main` now serves cross-agent 0.1.2: both manifests read 0.1.2 and the Claude
payload's adapter lists `WebSearch` and `WebFetch`. Release checks 33/33; `npm test` 1046
pass, 0 fail, 2 guarded skips. Installed hosts get it on their next plugin update.

**`atc-s96.112` is complete and closed (2026-10-12).** Claude specialists now hold
`WebSearch` and `WebFetch`: every role lists both in `--tools` and pre-approves both in
`permissions.allow`, so Claude matches Codex and Grok, whose specialists already searched
the web. The shell's sandbox is unchanged and still reaches no host. Decision 0018 records
the exposure (web content reaches every specialist; data can leave in a fetched URL).
`npm test`: 1048 tests, 1046 pass, 0 fail, 2 guarded skips. Citations: 1648, 0 misses,
0 drift since `640763f`. Two real probes plus a with/without comparison are in
`docs/probes.md#claudeWebTools`. Follow-up `atc-s96.113` (P3): a compound shell command
carrying `$?` is refused under `dontAsk`, independent of this change. `atc-s96.92`'s
Grok scope no longer includes the web tools. Committed locally, not pushed.

`atc-s96.111` is complete and closed. With the user's explicit approval, source
`main` was pushed at release commit `4738b3d` (0.1.1), and the existing agent-plugins
PR #16 was updated on `publish/cross-agent-0.1.0` to `37e4ee6`. The PR is open and
mergeable, with its title and description verified. The generated payload matches
the frozen source commit; 33 release checks pass, Claude validation passes, and an
isolated Codex install passes setup/check/remove and the 0.1.1 MCP handshake. The
marketplace README now explains the one-time setup. No force-push, PR merge or Dolt
remote sync was performed. Marketplace availability still awaits the user's merge.

## Completed implementation

`atc-s96.73` is complete and closed, with local integration under the repository's
automatic commit and merge policies.
The existing skill offers install/check/remove, and a stable launcher follows the
enabled installed marketplace version while inheriting each chat's project. No real
user Codex config changed. The 66 focused checks and native Codex 0.160.0 probe pass;
the latter covers solo, team, uninitialized and initialized worktree chats. Independent
review found no actionable findings, including the three skill-routing scenarios.
Final `npm test`: 1047 tests, 1045 pass, 0 fail, 2 guarded skips. One earlier full run
hit an existing reconciliation deadline; the unchanged server file passed 46/46 in
isolation and the unchanged full-suite rerun passed. Citations: 1643, no misses or
drift. This implementation is now included in the 0.1.1 publication above.

## Previous release context

**Release 0.1.0 is published (`atc-s96.109`, closed 2026-10-04).** The project is public at
https://github.com/WSH95/cross-agent-cli under the MIT license, `main` at the release commit
`f996a46` and the closing records after it. The plugin's payloads are in
https://github.com/WSH95/agent-plugins/pull/16, open and mergeable, **not merged**: the
marketplace install (`cross-agent@agent-plugins`) works once the user merges it. The
release brought:
- `bin/cross-agent`, the CLI's launcher on Claude Code's Bash tool PATH, denied to
  specialists;
- `tools/build-dist.mjs`, the payloads from a commit, and `tools/publish_agent_artifact_pr.py`
  with `agent-artifacts.json`;
- a 150-line README, with the reference material in `docs/install.md` and
  `docs/operator-guide.md`;
- the release review's fixes. Decision 0016 and `VERIFY.md` ("atc-s96.109") have the record.

The follow-ups `.106` (`c492021`), `.108` (`5b0e529`), and `.107` are complete.
This checkpoint records `.107`'s cleanup-compatible runner probes. The final
suite passed 1021 tests with 0 failures and 1 guarded skip; the host cleanup audit
was empty. No next implementation task is selected, and nothing was pushed.

The plan is closed. `main` (`128df05` and the wrap commit above it) holds every milestone, M0 to M4.

**What it built.** `cross-agent` runs headless `claude`, `codex` and `grok` processes as a team: one MCP server and a launcher skill, attached to a Claude Code, Codex or Grok host. Each team is a mode kept as data:
- `dev-team`: the planner, the plan reviewer, the implementer and the code reviewer, each task in its own git worktree;
- `dev-team-engine`: the same team, with its loop in a Claude or Codex lead the server spawns;
- `solo`.

Its guarantees:
- **The permission matrix.** Rows are resolved from process ancestry and task markers, so no specialist delegates.
- **The deny list.** Each adapter's exclusion flags keep specialists from launching an engine.
- **The sandboxes.** Each role writes only its own workspace. Claude roles run `dontAsk` with a tool allowlist and workspace-only edit rules.
- **Git ownership.** Specialists never write git metadata: `git_mutate` and `git_root` own git, and both refuse host configuration and the project's own state.
- **The audit.** A fail-closed verifier judges every end-to-end run by eight conditions.

**Counts at the close.**
- `npm test` at the root: 813 tests, 812 pass, 0 fail, 1 skipped (the guarded Codex I2 test).
- Citation checker: 1306 citations, none by line, 0 misses.

**The final review.** Three independent reviews in four rounds, from `4bcc986`, with two fix rounds, one escalation pass and a controller-verified wrap-up. Every finding was fixed, accepted as a limitation by the user's word, or ruled with its evidence (`VERIFY.md` "T12" and "Close of the plan").

**Decision 0011** (`.project-steward/DECISIONS.md`) records the eleven end-to-end runs, E1 to E9 with E2b and E2c. Each ended clean: six read eight `pass`, and five carry a `?` that a person read.

It was written as a go or no-go on the plugin as the devpack's second binding. On 2026-10-02 the user withdrew that binding: cross-agent follows its own development path, untied to the OpenMausBot devpack, and any team or workflow configuration import and export is built here (`atc-s96.96`).

What stands is the project's own record. The operator conditions a release names:
- (a) a Codex host exports `CROSS_AGENT_PROJECT`;
- (b) a Grok host trusts the folder and keeps `[plugins]` and the result cap in an ignored `.grok/config.toml`;
- (c) `/run/podman` is at 0711 where Grok runs read-only on a rootful-podman machine;
- (d) `bwrap`, `socat` and the AppArmor profile are in place where Claude runs on Linux.

**Attaching each host:**
- **Claude Code:** `claude --plugin-dir <this repository>`.
- **Codex:** install through the marketplace, then ask the existing cross-agent skill
  for one-time MCP setup. Reconnect and verify `describe_mode.projectRoot`. The legacy
  bundled mount still requires `CROSS_AGENT_PROJECT`; `docs/install.md` covers both.
- **Grok:** the project's own `.grok/config.toml`, with `[plugins] paths` naming this repository, `enabled = ["cross-agent"]` and `[mcp] max_output_bytes = 100000`, in a trusted folder.

## In flight

Current: nothing in flight. The .160 fix is merged (`39ac7c8`) and the retest's verifier
reads 8/8 from source. No live delegation, task worktree or task branch. Nine beads remain
open. Sample clean at `7ca2bb3` with its original config; candidate `24ea2d2` still
selected in Codex. The campaign matrix waits for the user. See Now.

Historical entries:

- `atc-s96.152`, `.153`, `.154` and `.158` verification work is complete. Source changes
  are evidence/stewardship only; the sample and ignored native evidence are retained.
  Findings `.155`, `.156`, `.157`, `.159` and `.160` remain open; no fixes are authorized
  in this diagnosis scope.
  Beads generated `.beads/interactions.jsonl`; that log remains uncommitted under the
  repository's standing warning. No push or remote sync is authorized.

- `atc-2jl`: epic plan approved (3 rounds; the epic's design field holds it); tasks `.1`-`.4`,
  follow-ups `.5` (record's `expect` type array vs real hosts, at Task 4) and `.6` (round-2
  Minors of `.1`, folded into `.2`). **Task 1 (`atc-2jl.1`) merged as `c1cb58c`** and closed:
  records config, root commit procedure, run journal, `record`; root suite 1160/1158/0 fail.
  Plans and reviews: `.cross-agent/plans/atc-2jl*/` (ignored).
- **Task 2 (`atc-2jl.2` + `.6`) merged as `9360f3e`** and closed: `track`, the shared root-commit
  helpers; root suite 1175/1173/0 fail. Follow-ups `atc-2jl.7` (a design.md word, into `.3`) and
  `atc-9w2` (flaky `tests/wait.test.ts#quietTaskWhose`).
- **Task 3 (`atc-2jl.3` + `.7`) merged as `c6a6433`** and closed: setup proposes the `records`
  block for `dev-team-engine` where beads and project-steward are found; reconnect covers a block
  added or removed; root suite 1182/1180/0 fail. Follow-up `atc-2jl.8` (a short line in
  `docs/operator-guide.md`, into `.4`).
- **Task 4 (`atc-2jl.4` + `.8` + `atc-s96.117`) merged as `5a78aec`** and closed: `## The run`
  (R1-R5) in the engine loop, the lead prompt, every specialist prompt leaving bookkeeping to the
  loop, the planner's goal-breakdown exception, the launcher's records paragraph, `AGENTS.md`
  (recorded in Decision 0022); root suite 1197/1195/0 fail. All four tasks of `atc-2jl` are merged.
- **`atc-2jl.10` merged as `c94ae09`** and closed: a finished run closes its epic at R5; the
  lead prompt names the epic as no item; root suite 1199/1197/0 fail.
- **`atc-2jl.9` merged as `4c2288e`** and closed: `nameFault` refuses a trailing `.`; the loops'
  slug sentence names `git_root`'s branch exclusions; root suite 1201/1199/0 fail.
- **`atc-9w2` merged as `213dacf`** and closed: the flaky test accepts both correct reasons of a
  setup race; root suite 1201/1199/0 fail. `atc-2jl.5` waits for the live trace after a release.
- **Release 0.1.8 (`atc-s96.150`):** `541bc98` pushed; agent-plugins PR #23 merged by the user, Claude
  Code updated and reconnected; Codex updated here (`codex plugin marketplace upgrade`, `codex plugin
  add`), its cache equals the dist payload. Steward commits after `541bc98` are local.
- **Live acceptance trace passed** (`VERIFY.md`): run 1 (epic, Claude lead) and run 2 (goal, Codex
  lead) met every pass condition in `~/.cache/agent-team/cross-agent-trace/kvtiny`; `atc-2jl.5` settled by
  a direct probe (Claude and Codex both pass `expect: null`). `atc-2jl`, `atc-2jl.5` and `atc-s96.150`
  closed. Nothing of `atc-2jl` remains.
- No release work remains in flight. `atc-s96.111` is closed; PR #16 awaits the user.
  Its clean temporary target checkout and publication evidence remain under
  `/tmp/cross-agent-release-0.1.1-KbXLn0/`.
- No implementation remains in flight for `atc-s96.73`. The local commit includes the
  launcher skill/reference/helpers, bundled-mount diagnostic, installation/design/probe
  docs, setup/native/packaging/skill tests, and Project Steward records.
- The main checkout's `.beads/interactions.jsonl` is unrelated mutable history and stays
  uncommitted. Test-generated runner fixtures cleaned up before staging.

The requested prerequisite commits are complete: `.106` is `c492021`, and `.108`
is `5b0e529`. Both commits were reviewed for task separation; neither includes
the unfinished runner fix. Plain Beads output, native-hook JSON and the saved
PRIME override match. Local commits after validation are authorized; pushes and
remote sync still need approval. Resume memories with `bd prime --export --memories-only`.

`atc-s96.107` is complete and closed. It uses command-mode ssh-agent, a stdin-controlled command with a
60-second lifetime, an actual SIGKILL preflight, and awaited identity-checked
retirement. Harness cleanup continues after signal errors and removes fixtures
before reporting accumulated failures. Seven regressions went red to green; the
complete runner file then passed 83 tests. An independent review found one
Important missing-identity cleanup case. A real-agent regression reproduced it;
recovery by the unique socket argv fixed it. The final focused run passes all 12
cases with no skips. Final `npm test` in the direct desktop context passed 1021
of 1022 tests, with 0 failures and the guarded real Codex I2 skipped. The host
audit found no live probes, runner-marked processes, or generated fixtures.
No production code or host security policy changed. Evidence is in
`/tmp/cross-agent-atc107-4i7vMg/`. This checkpoint includes the runner change and
verification records. Only the expected Beads interaction log remains unstaged.

`atc-s96.106` is closed and committed on `main` as `c492021`. Before committing,
all 66 focused worktree/project tests passed again, and the citation checker
reported 1636 citations, no misses or drift. The six-file commit includes its
Project Steward records and excludes `.107` and `.108` changes.
The user approved skipping only readable, empty ancestor `.git` directories.
Nonempty entries, files and symlinks retain Git verification; unreadable entries
refuse, and the ancestor walk still detects registered task worktrees.

Validation on 2026-10-03: eight new regression cases went from failing to passing;
the focused worktree and project-discovery files pass; the full suite has 1014
tests, 1013 pass, 0 fail, 1 skipped (the guarded real Codex I2); 1636 citations,
no misses; one independent read-only review found no findings. The shared
`/tmp/.git` remained present and empty.

The passing `npm test` ran unchanged through a temporary user service. This app's
sandbox loses asynchronous Node child stdout/stderr, and its direct outside-sandbox
context cannot signal AppArmor-confined `ping` probes. That earlier full run had
four runner cleanup failures, tracked as `atc-s96.107`. All four probes were
terminated; ten generated fixture files left by failed or interrupted runs were
archived out of `tests/fixtures`. No generated runner fixture remains there.
Evidence and original-file review snapshots are in
`/tmp/cross-agent-atc106-review-ZRRfyD/`; the passing log is
`full-suite-user-service.log`. That earlier validation session did not commit;
the separate prerequisite commits above are now complete.

`atc-s96.104` is merged and closed.

**`atc-s96.104` merged on 2026-10-03** (`7de15c0`, 15 commits; Decision 0014). The built-in team modes now run the plan iteration and the review and fix rounds as short procedures, with N code reviewers and a `resolver` role. This was the user's request, with the user's decisions D1–D4.

What it does:
- **Code reviewer seats:** `roles.code-reviewer` may be a list of bindings, one seat each. Seats are a mode fact (`"seats": "many"`); `delegate` takes `seat`, and listings write `code-reviewer#2`. `init` binds three read-only seats and the resolver.
- **Two settings,** both read through `describe_mode`: `limits.planReviewRounds` (default 3) and `review.afterResolver` (`ask` by default, or `lead-decides` or `always-ask`).
- **The loop text:** short, with a "stop and ask the user" fallback and the user's convergence rules (scope; carried, introduced or newly noticed; a diagnosis with four options at a limit; proportion).
- **Guard 1:** `git_root merge` acts on one resolved head and needs a `tested` step for it. The step comes from a suite run in a detached checkout under `.cross-agent/gate/`.
- **Guard 2:** under a mode with a gating role, the merge also needs every seat's clean review of that head, read by the server from the result files, or a waiver (`waive_review`, `cross-agent waive`).
- **The limit:** deliberate self-subversion by a lead is outside the guarantee (`atc-s96.105`).

How it was checked:
- **Planning:** six reviews of a large plan did not converge. The user reset it to a smaller plan, then chose to simplify at the plateau.
- **Review:** two rounds. Round 1 found 3 Critical (all in the setup marker), 1 Important and 3 Minor. Round 2 found nothing Critical or Important, and a wrap-up fixed its two Minor findings. No escalation was needed.
- **The suite:** `npm test` at the root ran 1006 tests: 1005 pass, 1 skipped. Citations: 1608, then 1631 with E11's record.
- **E11:** three seats on three engines (claude, codex, grok) reviewed `f9eaf26` in parallel. The verifier gave 8 pass, and the merge passed both guards with no waiver (`docs/probes.md#e11Seats`, `VERIFY.md`). The run cost $1.555.
- **`AGENTS.md`:** updated with the user's approval (`c05671e`).

The task worktree is removed, and its ignored files are archived in `~/.cache/agent-team/probe-logs/t15-worktree-state/`.

**The stray empty `/tmp/.git`** is left by Codex's Linux sandbox, along with
`/tmp/.agents`, `/tmp/.codex` and `/tmp/.aws`. With the verified `atc-s96.106`
working-tree fix, readable empty ancestor `.git` directories are skipped; leave
this shared directory in place. Nonempty or unreadable metadata still refuses.

**`atc-s96.103` is done (2026-10-03).** The repository is now `~/Documents/cross-agent-cli`, renamed from `~/Documents/agent-team-cli`.
- **What changed:** its live names (the Codex marketplace and install id `cross-agent@cross-agent-cli`, both manifests' `author`, the README, the design, `AGENTS.md`, the steward project name) were merged at `1a17004` and `6c3e5c3`.
- **What kept the old path:** records of past runs keep the paths they ran at, with one note each in `docs/probes.md` and `VERIFY.md`.
- **The move:** the controller moved the directory. `core.hooksPath` is now the relative `.beads/hooks`, and the e2e sample's Grok attach was repointed.
- **The smoke test:** it passed, with the plugin loaded from the new path, its server connected, and the operator row's fourteen tools.

Decision 0013 records all of it.

**Left to the user:**
- trust the new folder when Claude Code first starts there;
- in the Codex desktop app, add the folder at the new path, and remove the stale `agent-team-cli` and `cross-agent-m3` projects;
- reopen VS Code at the new path.

Codex writes its own trust entry for the new path. Stale entries that name the old path (`~/.claude.json`'s project key, `~/.codex/config.toml`'s trust entry, and the dormant OpenMausBot data under `~/.cache/agent-team/`) are harmless.

**`atc-s96.97` merged on 2026-10-03** (`fb0d050`; the feature's 45 commits end at `1c75090`).
A linked worktree, or a bare repository's worktree, becomes a cross-agent project of its own when
`cross-agent init` is run in it, so several branches of one repository can each run their own
loop at once (README, "Several branches at once").

What it does:
- `init` copies the main checkout's config, or `--from <dir>`'s, onto the worktree's own branch,
  and copies the Grok attach;
- the repository is located from outside the candidate, so a task worktree is never a project root;
- writes at a root that is not the main checkout need the opt-in;
- `<commonDir>/cross-agent.lock` serializes the projects' git;
- protected paths are set per root kind;
- closed journals are terminal, and `branch -d` holds a branch to its recorded tip;
- a new `cross-agent git-root` verb;
- `describe_mode` carries `projectRoot`;
- verifier rows 1 and 2 are scoped to the project.

How it was checked:
- **Review:** three review rounds and a wrap-up, with no escalation.
- **E10:** the sample's main checkout and a `feature/dotted` worktree each ran one
  `dev-team-engine` task at the same time, every engine `claude-sonnet-5`. Both verdicts read
  8 pass, and the containment probe was refused by the sandbox (`docs/probes.md#worktreeProjects`,
  `VERIFY.md` "T13").
- **The suite:** `npm test` at the root ran 933 tests: 932 pass, 1 skipped.
- **Citations:** 1458, none by line.

The task worktree is removed, and its ignored files are archived in
`~/.cache/agent-team/probe-logs/t13-worktree-state/`.

## Next steps

1. Ask the user how to finish the campaign: freeze and install a candidate that carries
   `39ac7c8`, then run the solo and both engine-led scenarios; or settle the held beads
   another way. Do not start it without that answer.
2. If the matrix runs, keep all retest evidence outside the sample project (the reviewer
   that tripped row 8 was reading the operator's evidence under the sample's
   `.cross-agent/`), then restore the original sample config and Codex managed owner
   through the supported helper. No push, release or remote sync without approval.
3. Optional follow-up: `docs/design.md`'s E2 history still says these names are set aside
   "on the lead row".

Historical next-step entries below predate the approved fix campaign:

1. Review `VERIFY.md` and `bd show atc-s96.159` / `bd show atc-s96.160` for the additional
   Codex-led variant's engine orchestration error and transcript-verifier blocker. The run,
   independent audit and configuration restoration are complete; no rerun or fix is pending
   in the approved scope. Earlier evidence is intact. Ask before a new fix scope or push.

1. Review `VERIFY.md` and `bd show atc-s96.155`, `.156`, `.157` for the three reproducible
   findings. The verification is complete; no rerun or fix is pending in the approved scope.
   The original sample config is restored. Verifier snapshots retain each mode's depth cap;
   do not judge old depth-2 records under the restored depth-1 configuration. Ask before new
   fix scope, push or remote sync.

1. `atc-s96.152` is complete. Review `VERIFY.md` and the retained sample evidence if needed;
   no test rerun or follow-up fix is pending. Ask before any push or new acceptance scope.

0. **The backlog run is complete and released as 0.1.9 (see Now).** `main` is pushed to `439a8c8`;
   agent-plugins PR #24 is merged; Claude Code and Codex run 0.1.9, and Grok specialists load
   Claude Code's copy (checked 2026-10-15, VERIFY). The deferred beads stay open with their
   reasons.
   Before it: **Epic `atc-2jl` is done and released (0.1.8).**
   steward commits after `541bc98` are local, for the user to push when wanted.
1. **The pilot is done (`atc-s96.118`, closed).** Two beads went through the full
   `dev-team` loop on this repository under the user's bindings, both with no fix round:
   - `atc-s96.80` (EPIPE) merged as `50fe5ba`.
   - `atc-s96.119` (`init`'s defaults are now the user's team) merged as `7f5969b`.

   `.cross-agent/config.json` (ignored) keeps those bindings. The team runs from the
   installed 0.1.2 build, so neither change reaches it until a release; this repository's
   `main` is ahead of 0.1.2.

   Findings to pick from with `bd ready`: `.122` (Claude Code backgrounds MCP calls after
   120 s), `.123` (self-hosting CLI guard), `.125` (`/reload-plugins` does not restart the
   server), and `.117` (the specialist rule in the role prompts). Review follow-ups:
   `.120`, `.121`, `.126`, `.127`.

   Before a team task's step 1, commit `.beads/interactions.jsonl` if it is dirty.

   **`atc-s96.130`, `.131` and `.132` are done.** One dev-team task merged them as
   `5b9919b`, and the worktree and branch are cleaned up. A direct `node --test` inside
   Codex's sandbox now stops at once with its reason. The review rounds left no
   follow-ups. The user authorized pushing and publishing a release after this work; they
   merge the agent-plugins pull request and update the plugin.

   **`atc-s96.124` and `atc-s96.129` are done.** They ran as one dev-team task and merged
   as `6b3913d`; the worktree and branch are cleaned up. `npm test` now stops in under a
   second, naming the cause, inside Codex's workspace-write sandbox, where it used to
   stall. The Claude-sandbox failures skip with a reason, and an interrupted suite no
   longer leaves files a task commit stages (`VERIFY.md`). A Codex specialist still must
   not run `node --test` directly with process isolation (`.131`). Follow-ups:
   `.130`, `.131`, `.132`.

   **`atc-s96.128` is done.** The user moved the `dev-team-engine` lead's default to
   claude-opus-5-5 at xhigh. A consult one-shot merged it as `8f27449`.

   `main` is ahead of the installed 0.1.2 by the EPIPE fix, the new `init` defaults, the
   lead default and the sandbox-suite fix. A release needs the user's authorization to push and publish.
2. No release work is pending: PR #17 (0.1.2) is merged. Run `bd ready` to choose the
   next task. Future pushes, PR merges and Dolt remote sync require separate authorization.
3. For an isolated native regression check, run
   `CODEX_SETUP_PROBE=/absolute/path/to/codex node --test tests/codex-native.test.ts`.
   It creates its own temporary Codex home and makes no model turn. `VERIFY.md` records
   the suite, focused checks, review and initial timeout.

Previous release and backlog pointers:

1. **The user:** review and merge https://github.com/WSH95/agent-plugins/pull/16. After the
   merge, `/plugin marketplace update agent-plugins` (or a fresh `marketplace add`) offers
   `cross-agent@agent-plugins`.
2. `atc-s96.110` (P3): settle how a Claude Code install of cross-agent reaches Grok
   sessions, and whether a marketplace install can stay per project. This needs a
   signed-in isolated Grok home, since a fresh signed-out one keeps path plugins off.
3. Later releases follow the README's "Development": bump the version in all three files,
   commit, push `main`, then run the publisher.
1. Run `bd ready` before choosing the next task. `.106`, `.108`, and `.107` are
   closed; no push or remote sync is authorized.
2. **The team-mode follow-ups:**
   - `.105` (P4): deliberate self-subversion of the merge guards;
   - optional, the user's call: trim the loops' text, which grew with `atc-s96.104` (`modes/dev-team/SKILL.md` 13,065 → 20,684 bytes).
3. **The deferred beads** (`bd ready`; each carries its class and reason from Decision 0011):
   - P3: `.60`, `.76`, `.92` (Grok specialists' extra tools, web tools now excluded), `.95` (a lead's report names bindings it never read), `.113` (compound shell commands refused under `dontAsk`);
   - P4: the rest, `.96` included (team and workflow configuration import and export, in this project's own format);
   - the backlog, `.25`, `.26` and `.28`, and `prune`, `.48`.
4. **The worktree-project follow-ups:**
   - `.98`: cancelling a running git child;
   - `.99`: worktree projects inside the main checkout;
   - `.100`: writes at a separated main or a submodule;
   - `.101`: widen `nameFault`;
   - `.102`: `describe_mode` warns when the server's own working directory lies in another initialized project.

## Blockers

Current: no technical blocker. One user decision is pending: whether and how to run the
remaining frozen-candidate matrix (Next steps 1). All source fixes are merged, reviewed and
tested. See Now and Beads.

Historical acceptance failures below are preserved; their fixes are now authorized:

The additional Codex-led variant cannot receive a strict pass: an invented specialist-test
restriction needed operator correction (`atc-s96.159`), and row 8 of its verifier remains
unresolved (`atc-s96.160`). Functional tests, reviews, merge and cleanup completed.

Grok writable solo acceptance remains blocked by the verifier's unrecognized native
`search_replace` tool (`atc-s96.155`). Both Codex solo tasks failed assigned-directory
compliance (`atc-s96.156`), and the Claude lead failed no-shell compliance (`atc-s96.157`).
The runs and evidence are complete; these findings prevent an unconditional clean pass.
Product fixes are outside the user's acceptance scope.

The `AGENTS.md` diff for `atc-s96.104` was approved and applied on 2026-10-03 (`c05671e`, Decision 0014).

## Key files

- `docs/design.md`: the authority — "The lead model", sections 1 to 10, the work plan with what landed per row, and Verification.
- `docs/probes.md`: every probe and end-to-end run with its transcripts. It covers P1–P10, I1, I2 and E1–E11; T12's fix rounds are `#t12Fix1`, `#t12Fix2` and `#t12Fix3`, E10 is `#worktreeProjects` and E11 is `#e11Seats`.
- `src/`:
  - the top level: `server.ts`, `authority.ts`, `project.ts`, `delegate.ts`, `tasks.ts`, `wait.ts`, `mailbox.ts`, `modes.ts`, `cli.ts`, `gitroot.ts`, `runcommand.ts`, `config.ts`, `ledger.ts`, `locks.ts`, `process.ts`, `reconcile.ts`, `worktree.ts`, `reservation.ts`, `gitmutate.ts`, `journal.ts`, `review.ts`, `runner.ts`, `guard.ts`;
  - `engines/`: `types.ts`, `spawn.ts`, `registry.ts`, `binaries.ts`, `text.ts`, `claude.ts`, `codex.ts`, `grok.ts`;
  - `tests/` mirrors it, with `tests/fixtures/fake-engine.mjs` and `tests/helpers/`.
- The skill, the modes and the packaging:
  - `skills/cross-agent/SKILL.md`, the launcher;
  - `skills/cross-agent/references/codex-setup.md` and `scripts/codex-{setup,config,serve}.mjs`,
    one-time native Codex configuration and installed-version resolution;
  - `modes/{dev-team,dev-team-engine,solo}/`;
  - `.claude-plugin/plugin.json`, with inline `mcpServers`;
  - `.codex-plugin/` with `.agents/plugins/marketplace.json`, and `assets/codex/mcp_servers.toml`, the configured-server fallback.
- `tools/`:
  - `probe.mjs`: engine probes; `--track` spawns the real runner;
  - `e2e-verify.mjs`: the eight end-to-end checks, which fail closed;
  - `check-citations.mjs`;
  - `from-openmaus.mjs`: a one-off, kept as history.
- The records:
  - `VERIFY.md`: counts and runs per merge, ending with "T13" and `atc-s96.104`;
  - `.project-steward/DECISIONS.md`: 0010, the rulings of M1–M3; 0011, the go or no-go with its conditions, limitations and deferred beads; 0012–0014, the worktree projects, the rename and the team modes;
  - the plan, `~/.claude/plans/the-development-of-this-calm-planet.md`.
- The close's raw evidence: `~/.cache/agent-team/probe-logs/close-2026-10-02/` (`fix1/`, `fix2/`, `wrapup/`, `e9/`, `worktree-state/`).
- The sample, `~/.cache/agent-team/cross-agent-e2e/slugkit`: `main` at `f9eaf26` (E11's `slug_final_letters`), 116 tests, in `dev-team-engine` with E11's config kept (three code reviewer seats on claude, codex and grok, and the resolver), and `feature/dotted` kept at `0ed8097`. Its `.grok/config.toml` names this checkout.

## Tried and rejected

- An `O_EXCL` lock file with a TTL and a rename-based reclaim (Decision 0004).
- A per-process witness cache for engine liveness (replaced by the group scan).
- A lead token in the launch spec (readable by every sandbox; replaced by process ancestry).
- Grok as an engine-placed lead (P9: no per-run MCP isolation).
- A repository-root `.mcp.json` for the plugin. Claude Code reads it as this repository's own project-scoped config in every developer session, where `${CLAUDE_PLUGIN_ROOT}` is empty (T13). The plugin declares `mcpServers` inline instead.
- Attaching a 150 KB diff to a Grok brief before `atc-s96.55` (`E2BIG`).
- Relying on Claude's default sandbox for a read-only role. It writes to the cwd by default (T6-R1-20); the cwd is now in `denyWrite`.
- `bypassPermissions` for Claude roles behind a sandbox that binds only Bash. The Write tool wrote outside the workspace, and `EnterWorktree` made git metadata (T12, `docs/probes.md#t12Fix1`). Roles now run `dontAsk` with a tool allowlist.
- A spawn-time refusal of a project's `.claude/settings.json` allow rules. It was built, probed and withdrawn, because it would refuse legitimate projects. The residue is an accepted limitation (Decision 0011).
- Following host-configuration links to what they load. Three review rounds each found a new link shape, so a link at or under the four host paths is now refused by rule.

## Warnings

- **Push only with explicit approval.** The user authorized this 0.1.1 source push
  and update to PR #16; future pushes still need approval. Checkpoints use Conventional Commits.
- **`AGENTS.md` and `CLAUDE.md` are user-owned.** They change only by hunks the user approved after seeing the diff.
- **Start end-to-end host sessions with `setsid --fork`**, from the target directory, with the session's markers scrubbed.
  - A server's permission row is decided by `CROSS_AGENT_*` markers and ledger identities in its process ancestry, not by a `claude` process name.
  - A server started inside a plain Claude Code session serves the operator row (`docs/probes.md#walk32`).
  - One under a task's process tree does not, and `setsid --fork` keeps a host out of any such tree.
- **Anchor `pgrep -f` and `pkill -f` patterns.** A pattern that matches your own shell's command line kills the shell. Anchor it, for example `'^node .*script\.mjs'`.
- **The citation checker's limits.** `npm test` runs it, and it proves that a cited line or symbol exists, not that it still says what the sentence claims.
  - Cite tests by `// @anchor`, passages by `<!-- @anchor -->` and code by `#symbol`.
  - Run `node tools/check-citations.mjs --since <task base>` after every task.
  - An anchor on the wrong test is invisible to both checks: read each sentence against the test title.
- **The suite is load-sensitive.** A timing assertion can fail under load; rerun the file in isolation first.
- **Keep projects out of `/tmp` and `$TMPDIR`.** The Codex and Grok sandboxes do not isolate them; the e2e sample lives under `~/.cache/agent-team/cross-agent-e2e/`.
- **Never run a bare `git stash`.** The stash is shared across worktrees.
- **Two dirty paths at the root are expected and never committed:** `.beads/interactions.jsonl` (bd's own log) and `.codex/agents/` (the Codex plugin's mirror of the implementer agent definition).
- **No engine at this repository's root,** except a read-only `consult`. The sample is the target for everything else.
- **`~/.codex/config.toml` changes under you.** The user's own Codex processes (the desktop app, a `codex` session) rewrite it; on 2026-10-02 they changed `model` once and `service_tier` three times. Compare a fresh copy and check its mtime before any edit.
