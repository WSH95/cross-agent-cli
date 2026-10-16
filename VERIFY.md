# Verification record

What `npm test` and the recorded runs showed at each milestone merge into
`main` and at follow-up verification. Counts live here, not in the README
(Decision 0008). Raw engine
transcripts stay in `docs/probes.md`.
The repository was renamed from `~/Documents/agent-team-cli` to `~/Documents/cross-agent-cli`
on 2026-10-03; each section keeps the paths and the Codex plugin names its runs used.

## Acceptance fixes — verifier coverage, `atc-s96.155` / `atc-s96.160` (2026-10-15–16)

**Implementation and isolated archive replay pass; fresh candidate acceptance remains pending.**
The user authorized corrections to the acceptance findings, preserving the original observations.
The first task ran through installed cross-agent 0.1.9 with the source repository's unchanged
`dev-team` roster, host placement, depth 1, automatic merging, `main`, `npm test` and no setup.
It merged as `b5a5522337dc62518c0f7897ff690ee41e99521b` after three clean final code reviews.

The verifier recognizes Grok's exact archived `search_replace` and `web_fetch` input shapes,
literal source-reading commands, delegate-named file operands and the recorded tool-discovery
regular expressions. It retains eight checks and exit codes 0/1/2. Unsupported shapes and
ambiguous execution remain `?`; real delegation and engine launches still fail. Three new tests
cover 75 verdict cases from exact archived events and negative controls; existing assertions
are unchanged. Isolated copies replayed with captured configurations changed row 8 from `?`
to pass for R1 (four transcripts), R2 (two) and R3 (one). Rows 1–7 in these replay fixtures are
synthetic; these results do not retroactively certify complete historical runs. The original
files are untouched, and the 582-file preservation manifest has no mismatches.

Planning converged from 3 Important findings to 1 to 0, followed by the required planner
optimization. Code review round 1 found two missing regression controls and two wording
issues. The implementer verified the guards and added five negative cases; no verifier behavior
changed in that correction. All three round-2 reviews marked the in-scope findings addressed.
The unpublished initial head `2de64899` was amended to keep one task commit; its Git object,
complete patch, original gate and reviews are preserved.

| Validation | Result |
| --- | --- |
| Root baseline | 1233 tests, 1231 pass, 0 fail, 2 guarded skips |
| Test-first implementation | 1236 tests, 1221 pass, exactly 3 new tests fail, 12 sandbox skips |
| Local implementation and correction suites | 1236 tests, 1224 pass, 0 fail, same 12 sandbox skips |
| Initial committed head `2de64899` | 1236 tests, 1234 pass, 0 fail, 2 guarded skips |
| Final committed head `b5a5522` and post-merge root gate | Both 1236 tests, 1234 pass, 0 fail, 2 guarded skips |
| Guard mutation checks | Original verifier tests do not detect removed guards; corrected tests do |
| Citation check | 1856 citations, 0 misses |
| Cleanup | Only source root worktree remains; task branch removed; root clean before bookkeeping |

The mutation copies under `/tmp` each also failed a configuration test whose premise expects
a repository outside `/tmp`, and skipped one Git-dependent test. These are fixture-location
observations, not production failures. An intermediate implementation run separately hit
`cannot read /tmp/.git: ENOENT`; its cause is unconfirmed and tracked as `atc-s96.165`.
The planner found a pre-existing Bash `@P` launch-judge gap (`atc-s96.164`), and a reviewer
found unflagged indirect `globalThis` tool access (`atc-s96.166`); both enter separate dev-team
work before candidate acceptance. A possible `GIT_EXEC_PATH`/`PATH` dependence on programs
written earlier is unconfirmed and falls within the stated prior-call-program boundary;
the follow-up investigation will assess it. No finding has been closed prematurely.

Host deviation: the first gate call used `where: "worktree"` instead of the verified absolute
path; the server refused before launching a command. The corrected call passed. No engine
failed. Read-only reviewers did not run the filesystem-writing suite; they inspected the
exact-head server gate. Development engines were Claude Code 2.1.299, Codex CLI 0.163.0 and
Grok 1.0.52. The sample was independently rechecked: 139 passing tests, clean `main` at
`a9b90d4`, only its root worktree, no task branches, original configuration hash unchanged.

All 15 delegation records, actual bindings, sessions, native logs and full results remain in
`.cross-agent/tasks/`. `.cross-agent/log.md` records roles and durations. The task journal is
`.cross-agent/journal/fixes-verifier-20261015.json`; complete plans, findings, replay harnesses,
source hashes, mutation copies, test output and gates are preserved under
`.cross-agent/fix-acceptance-evidence/`. `campaign.json` maps every task ID to its stage and
review round. The source configuration still hashes to
`68f88c461c77e75b811a89462ebe104b8f669d8c3ca674732bcd989f612500ae`.

## Codex-led engine variant — `atc-s96.158` (2026-10-15)

**Functional pass; strict transcript verification blocked; engine orchestration failure
recorded.** The additional installed 0.1.9 `dev-team-engine` run used every requested role
binding. It added the sample helper `slug_unique_sorted`, passed all 139 tests, completed
two review rounds and cleanup, but required factual operator correction of an invented
specialist-test restriction (`atc-s96.159`). The independent verifier twice returned
**7 pass, 0 fail, 1 without evidence**, exit 2 (`atc-s96.160`). The unresolved row is not a
pass and was not waived. No cross-agent fixes were made.

Fresh Codex host chat `01a1419a-d274-7eb1-b049-14a27a00bb0e` on `local` confirmed the sample
root, engine placement, no records block and no warnings. The released setup CLI applied
the exact changes with config hash protection and depth 2, preserving main, automatic
merging, setup none and `python3 -m unittest discover -s tests -t .`. Baseline was clean
`8396e6e`, 131 tests. Actual records confirm these bindings throughout:

| Role | Engine / model / effort |
| --- | --- |
| Lead, planner, implementer | Codex / `gpt-6.1-sol` / xhigh |
| Plan reviewer | Claude / `claude-opus-5-5` / xhigh |
| Code reviewer #1 | Claude / `claude-opus-5-5` / xhigh |
| Code reviewer #2 | Codex / `gpt-6.1-sol` / xhigh |
| Code reviewer #3 | Grok / `grok-4.7` / xhigh |
| Resolver, bound but unused | Codex / `gpt-6-astra` / max |

Lead `b49d51f8fb220781c0c11cfd282788fa1af6` ran at depth 1. Its twelve specialist records
ran at depth 2, all naming that lead as parent; all thirteen records finished with exit 0.
Planner tasks were `a1d03130b4b8f44253463c898040ff1d0303`, optimization
`e07f58043490d4a84f43236f0f8e53492d25`, and correction
`4f253ae7c3257458fc70aa63f850dc95ae5e`. Plan reviewer:
`21de8c77bb0775c15ff1886f4cd8efc94dc4`. Implementer:
`cdaa81bc5c158d3e78da1183c5f81b445c74`, resumed for the Minor wrap-up as
`58acfe6718fbafb90b6b8eff8c61d2d08d56`.

The ordering ask `34c9abb0996b644ed8bdc3b8f4269c0d1514` was answered before the first
planner with the fixture input `ascending Python string order; remove duplicate words`.
Plan review ended `VERDICT: no major issues` with a Minor tests-first suggestion. However,
the lead had added a blanket rule requiring every specialist test run to use the lead-only
`run_command` tool. The planner consequently treated local RED/GREEN as unavailable, and
its optimization incorrectly called an unverified fallback user-authorized. The lead then
asked for actual approval in `5d4a49dad9801ed7507b8cee967efca62c95`, pausing unnecessarily.

The coordinator checked the served implementer role and answered through the installed
mailbox with factual clarification of existing permissions: the lead's no-shell restriction
does not prohibit the implementer running the configured suite directly in its worktree.
No new permission, fallback exception or waiver was granted. The lead accepted the
correction, resumed planning and corrected the implementation brief. The exact false
restriction, premature authorization claim, question and correction remain in task specs,
results, the mailbox and `policy-clarification.json`. This is an engine instruction-scoping
error, not a missing server capability (`atc-s96.159`).

The implementer added eight tests before the function. Its native log records the test-file
change at line 13, missing-helper `ImportError` at line 15, implementation at line 18, and
139 passing tests at line 20. The RED is one discovery/import failure, not eight assertion
failures; its output prints `exit 1`, although the shell wrapper's final echo returns 0.
The independent audit verified this order and the mailbox chronology. The helper calls
`slug_words`, deduplicates normalized words, sorts ascending and joins with hyphens. Only
README usage, the helper module and its tests changed; all prior tests and solo docs remain.

| Review round | Commit | Reviewer task IDs, seats 1 / 2 / 3 |
| --- | --- | --- |
| 1 | `bf9a39d69547ec359b0dbe62643172b97e9a806d` | `4778f3bce240e69d01f25dc6e456785dee67` / `f6916201517b333e6cb2db60265d29ec7581` / `f51a1d2bfa83f03ac7305b0071139aa9a4ae` |
| 2 | `a9b90d4c579096696a18cae75d68e2d11644aa0b` | `79d3dde8525d0a399d6bcc2f3e53c5506b88` / `69cae6cc3cb016ed2c38e23a1e0160bccc01` / `481abf82471f752a4efb2b8b81f185558ba8` |

All six reviews ended `VERDICT: no major issues` and passed 139 tests. Seat 1's Minor
docstring wording finding in round 1 was verified and fixed by the implementer; all seats
marked it addressed in round 2. Both committed-head gates and the post-merge root suite
passed 139 tests. No major correction round, resolver or waiver was needed. The lead
fast-forward merged the final head, removed the worktree and deleted
`task/codex-lead-20261015`. The independent suite also passed all 139 tests.

The independent verifier ran before configuration restoration:

```sh
node tools/e2e-verify.mjs --project /home/wsh/Documents/cross-agent-codex-host-e2e-20261015 --since b49d51f8fb220781c0c11cfd282788fa1af6 --slug codex-lead-20261015
```

Seven checks pass: cleanup, clean tree, root suite, native logs for all thirteen records,
depth cap and journal. Row 8 remains unresolved in the initial/optimized planner and Claude
plan-reviewer transcripts. The scanner cannot model some source-reading shell constructs
beside engine names in installed paths, a tool-discovery regular expression, and a
`delegate` occurrence in the literal `src/delegate.ts` filename. The saved Codex rollout
reader identifies the exact calls, including source line 144, call
`call_12791e1a81fa48c198e65db5b633243a`, which reads/greps source rather than delegating.
An independent second invocation reproduced exit 2 with the same 7/0/1 result. This
coverage gap is `atc-s96.160`; manual inspection does not certify the unknown row.

The native Codex lead emitted no shell-command or file-change items. The host dispatched
only one lead, called no loop tools, and relayed the full lead report verbatim; the archived
rollout and prefix comparison verify this. Codex review transcripts also contain parent
directory instruction-file searches, retained as scope observations. These observations do
not turn the unresolved transcript check into a pass. A pre-worktree slugged baseline call
was refused because its journal did not exist; the unjournaled root baseline passed. That
documented precondition is not a product defect. No engine process failed or was retried.

Evidence is under the sample's ignored `.cross-agent/codex-lead-e2e-evidence/`: exact config
and brief, native task references/hashes, `coordinator-audit.json`, verifier and independent
reproduction outputs, planner rollout/reader output, `host-audit.json`, mailbox and policy
clarification, `lead-result-verbatim.md`, and `supplemental-proof.json`. All 459 earlier
evidence files retain their hashes. After all tasks settled, the released CLI restored the
original config byte-for-byte (SHA-256
`6dc1f7e2ed4f2a73fdf94183b70210b940f5fa29caf94c2e83501f92c20ea192`). Final sample main is
clean at `a9b90d4`, root worktree only, with no task branch. Verification work is complete;
findings `.159` and `.160` remain open alongside the earlier findings. Source changes are
records only; whitespace and citation checks validate them. No push, remote sync or product fix.

## Codex engine-led acceptance — `atc-s96.154` (2026-10-15)

**Functional pass, lead no-shell compliance fail.** The complete `dev-team-engine` loop
finished under Codex hosting installed cross-agent 0.1.9. The independent verifier returned
**8 pass, 0 fail, 0 without evidence**, exit 0, before the mode was restored. The Claude lead
ran one read-only Bash command despite its no-shell rule; `atc-s96.157` records that
integration/compliance finding. No product code was changed to work around it.

All three built-in modes have now been exercised under Codex. This is not an unconditional
pass for the tool and engines:

| Mode / engine | Read-only result | Writable / full-loop result | Scoped verifier |
| --- | --- | --- | --- |
| `dev-team` (earlier `atc-s96.152`) | Included in team loop | Pass | 8/8 |
| `solo` / Claude Opus | Pass | Pass | 8/8 |
| `solo` / Codex `gpt-6.1-sol` | Fail directory-scope compliance; functional pass | Fail directory-scope compliance; functional pass | 8/8 |
| `solo` / Grok | Pass | Blocked on transcript-reader coverage; functional pass | 7 pass, 1 unresolved |
| `dev-team-engine` / Claude lead | Included in team loop | Fail no-shell compliance; functional pass | 8/8 |

Fresh host chat `01a14161-76ce-7ad2-9a39-d7cc9aa2cff0` on `local` confirmed the canonical
sample root, engine placement, the approved roster, no records block, and no warnings. The
released setup CLI raised the sample's depth limit to 2 and preserved main, the unittest
command, setup none and merge auto. Its baseline was the completed solo head `7b3110b`.
Lead `57e921b11be115d34a10b59557c43208f163` ran Claude `claude-opus-5-5` at xhigh, depth 1;
all seven specialist records ran at depth 2 and named that lead as their parent:

| Role | Actual engine / model / effort | Task ID |
| --- | --- | --- |
| Planner | Claude / `claude-opus-5-5` / xhigh | `a432f0d25e46ebacb502698659dd3b75b7de` |
| Plan reviewer | Codex / `gpt-6-astra` / xhigh | `1cd8e179d53e67edc29034fafaccc1a83e6a` |
| Planner revision | Claude / `claude-opus-5-5` / xhigh | `e6818b234b232dca38ebb666f4088498df40` |
| Implementer | Claude / `claude-opus-5-5` / xhigh | `da8bb46f179840ab979a3ccb35be6b60e40f` |
| Reviewer #1 | Claude / `claude-opus-5-5` / xhigh | `625559a7dafee414404de675650cfbd39b5f` |
| Reviewer #2 | Codex / `gpt-6.1-sol` / xhigh | `dce0c4ce7cae1e6cf9342da4f3ba92068a52` |
| Reviewer #3 | Grok / `grok-4.7` / xhigh | `ef200f734cba614e7e653b9af5cba02c77e1` |

All eight records finished with exit 0 and retained native logs/results. The resolver was
bound as approved but unnecessary. The lead asked ordering question
`f08ae6e59277f055211e31e1902385f19803`; the Codex host displayed it and answered through the
mailbox with the authorized fixture text, `ascending Python string order; preserve duplicates`.
The recorded answer precedes the first planner's creation. The source coordinator verified
that chronology independently rather than relying on the lead's report.

Plan review round 1 ended `VERDICT: no major issues` with two Minor plan-order/evidence
findings, both folded by the required planner revision. Implementation added `slug_sorted`,
eight focused tests and README examples, changing only three files. The native implementer
log records the missing-function `ImportError` at line 88, function insertion at line 230,
then all 131 tests green at line 236. It covers all requested cases, including digits as
strings, duplicates and composed/decomposed Unicode. An intermediate Unicode-escape editing
mistake and a refused rewrite were corrected within the task. Twelve untracked entries seen
only inside the Claude sandbox were mount artifacts; the real worktree held only the
intended modifications. These are engine/sandbox observations, not failed delegations.

The lead committed `8396e6e60b5dc74ca38f38c13d3a771031aa1ce7`, rebased without moving it,
and ran the committed-head gate. All three concurrent reviews covered that exact SHA and
ended `VERDICT: no major issues`, with no code findings. No correction round, resolver or
waiver was needed. The fast-forward merge moved main from `7b3110b` to `8396e6e`; the root
suite and independent coordinator suite each passed all 131 tests. The journal records the
commit, tested head, merge, root test success, worktree removal and branch deletion.

The scoped verifier command, run while the saved engine-mode config was still active, was:

```sh
node tools/e2e-verify.mjs --project /home/wsh/Documents/cross-agent-codex-host-e2e-20261015 --since 57e921b11be115d34a10b59557c43208f163 --slug codex-engine-host-20261015
```

It inspected eight native transcripts, applying the lead's allowed delegation row at depth
1, and found no unauthorized delegation or engine launch. Its eight passes do not certify
the separate no-shell invariant. Native lead log line 8 records Claude's persisted-output
notice for the 56.3 KB `describe_mode` result; line 13 records a Bash `python3 -I` reader of
that saved tool result. The command made no repository changes, but violated the lead's
explicit restriction. The exact 57,968-byte persisted response and command are retained for
`atc-s96.157`; the report does not claim the workaround was required or approved.

The Codex host itself dispatched only its one lead, called no loop tools, and relayed the
complete lead result verbatim before its own notes. The archived host rollout and independent
prefix comparison verify this, with no host deviation found for the engine-led run. The
coordinator's one initial test-first diagnostic parser failed on a string content block;
the corrected read-only diagnostic verified the native event order without rerunning an engine.

Evidence is under the sample's ignored `.cross-agent/remaining-modes-evidence/engine/`:
`coordinator-audit.json`, `coordinator-verifier.txt` and its argv/result JSON, full lead
tool calls, mailbox, config snapshot, `lead-result-verbatim.md`, the host rollout and
`host-audit.json`, the persisted Claude response, and `supplemental-proof.json`. Native
task logs/results/specs and the journal remain under `.cross-agent/`. The lead's optional
documentation/options suggestions are not defects or approved work. Its uncertain read-only
enforcement observation for Grok is not promoted to a verified sandbox guarantee or bug.

After both chats and all tasks settled, the released CLI restored the original sample config
byte-for-byte (SHA-256 `6dc1f7e2ed4f2a73fdf94183b70210b940f5fa29caf94c2e83501f92c20ea192`).
`restoration.json` records clean main at `8396e6e`, only the root worktree, and no task branches.
The 106 prior dev-team evidence files and all 15 solo native logs/results/journals retain
their hashes. Both verification tasks are complete as diagnosis/reporting work; findings
`atc-s96.155`, `.156`, and `.157` remain open. Source changes are evidence/stewardship only,
validated by whitespace and citation checks. No push, remote sync, product fix or engine retry.

## Codex solo acceptance — `atc-s96.153` (2026-10-15)

**Blocked at the Grok writable transcript check; Codex directory-scope compliance failed.**
All six requested functional scenarios completed with correct examples, exit 0, the approved
bindings at depth 1, and native evidence retained. Claude and Codex each passed all eight
scoped verifier checks. Grok passed seven; its writable transcript uses the native
`search_replace` edit tool, which the verifier does not recognize. That row remains `?`,
not a pass. The verification run is complete; the unresolved findings are `atc-s96.155`
(verifier coverage) and `atc-s96.156` (Codex scope compliance). No product fixes were made.

Fresh Codex chat `01a14151-6aba-7c13-b616-102793981539` on `local` ran the installed 0.1.9
MCP tools and live served solo loop in the same independent Slugkit sample,
`/home/wsh/Documents/cross-agent-codex-host-e2e-20261015`. Its handshake confirmed that root,
host placement, the configured Claude consultant, and no warnings. The released setup CLI
replaced the config using its expected SHA-256. Main, automatic merging, no setup command,
and `python3 -m unittest discover -s tests -t .` were preserved. The connection check passed
outside the sandbox; its sandbox attempt could not initialize Codex's read-only state runtime.

Each delegation named its engine and model explicitly and omitted effort. Actual records
agree: Claude `claude-opus-5-5`, Codex `gpt-6.1-sol`, Grok `grok-4.7`, all default effort.
All read-only consultants ran at the root with the read-only profile; writable tasks ran in
server-created worktrees with `workspace-write` for Claude/Codex and `workspace` for Grok.

| Engine | Read-only task | Writable task | Functional / verifier / compliance result |
| --- | --- | --- | --- |
| Claude | `239074c03cc0321c8c7f378aacf26a63e87e` | `bb070fc0780d4238aea50258f08d33785a17` | Both pass; 8/8; no scope violation observed |
| Codex | `08956a56d94a1de787e620f7bc8032624391` | `4e67856c4e49b097abcc9424d39d60d0c061` | Both functionally pass; 8/8; both fail assigned-directory compliance |
| Grok | `e8cedb0faac88b10b845496c1b8b333deb07` | `a83d88f8e73118be440a0f6c5eaddd790ae8` | Read-only passes; writable functionally passes but acceptance is blocked; 7 pass, 1 unresolved |

All six sets covered multiple words, one word, empty input, punctuation, repeated whitespace,
and accented Unicode. Read-only tasks left the commit, status, branches, and worktrees
unchanged. Writable tasks added only `docs/solo-claude.md`, `docs/solo-codex.md`, and
`docs/solo-grok.md`, respectively. Their commits were `ee28a37`, `f4e2116`, and `7b3110b`.
Each passed all 123 tests at the committed branch head and again after its fast-forward
merge, then removed its worktree and branch. Grok's post-task checks found unchanged root
and worktree heads, clean index and tracked files, and only the requested untracked document.
Those checks do not assert that Grok's OS sandbox protects every git metadata path.

The host ran each scoped verifier before starting the next engine, with that engine's
read-only task as `--since` and writable task as `--slug`. Claude/Codex each returned exit 0,
eight passes, two records, and two inspected transcripts. Grok returned exit 2, seven passes,
zero failures, and one row without evidence. A separate coordinator invocation reproduced
that exact result before the mode changed. Four Grok `search_replace` calls appear in its
writable native log at lines 10, 14 (two calls), and 18, all editing the requested document.
`tools/e2e-verify.mjs#engineTools` omits that tool, so the transcript reader fails closed.
Manual inspection neither replaces nor waives the unresolved row. `atc-s96.155` retains
the exact command, task IDs, log positions, actual result, and captured config.

Both Codex tasks ran `find .. -name AGENTS.md -print`, despite their injected consultant
prompt's instruction to work in the given directory and nowhere else. The read-only search
enumerated sibling repositories; the writable search began at the parent worktree directory.
Their native logs and role prompts reproduce the failure (`atc-s96.156`). Both recovered
from an unavailable `python` command by using `python3`. No engine process failed, and no
out-of-scope writes, delegations, or engine launches were observed in those Codex transcripts.
The host summary's functional `pass` does not erase its separate scope `fail`.

Host deviations: an initial refused `git_root rev-parse HEAD` and a read-only branch query
preceded reconciliation; reconciliation completed before delegation. A temporary example
parser error and a failed diagnostic path search were corrected without rerunning tasks.
The intended repeated read-only brief hit the finished-task duplicate window; the host
reconciled and used the documented `force: true`, including for Grok. This was not a failed
engine retry. No models changed, no review waivers were used, and nothing was pushed.

Final solo sample main: `7b3110b8971883183de1c9cbdb41e97df63350aa`, clean, root worktree
only, no task branches, all 123 tests passing. Evidence is under the sample's ignored
`.cross-agent/remaining-modes-evidence/solo/`: `solo-run-summary.json`, full MCP captures,
per-engine native logs/results and verifier commands/configs/outputs, the manifest, and
`coordinator-audit.json`. The coordinator checked bindings, statuses, depths, sandbox
profiles, worktree tuples, log/result hashes, cleanup, tests, and all three verifier outputs;
106 files from the earlier dev-team evidence remained unchanged. Source changes are records
only; the product suite was not rerun. Whitespace and citation checks validate these edits.
The separate engine-led verification is `atc-s96.154`.

## Codex host acceptance — `atc-s96.152` (2026-10-15)

**Pass.** A new Codex desktop chat ran the full host-placed `dev-team` loop against installed
cross-agent 0.1.9 in an independent Slugkit sample. Both the host's verifier and a separate
coordinator run returned **8 pass, 0 fail, 0 without evidence**, exit 0. No cross-agent
defects were found. The verification bead is closed.

The initial chat had the launcher skill but no cross-agent MCP tools. The installed
`codex-setup.mjs check`, retried outside the sandbox after Codex's runtime hit a read-only
filesystem, reported that one-time setup was missing or incomplete. The approved `install`
then succeeded; `check` now resolves `cross-agent@agent-plugins` 0.1.9 and its installed server
under `~/.codex/plugins/cache/agent-plugins/cross-agent/0.1.9/`. After the user registered the
sample as a Codex project, test chat `01a14126-c384-7c73-9be7-0a948bb701d7` called live
`describe_mode` and `list_roles`: the canonical sample root, host placement, approved
bindings, and no drift warnings. The test used the installed plugin's tools and served loop.

The independent sample is `/home/wsh/Documents/cross-agent-codex-host-e2e-20261015`, exported
from Slugkit `f9eaf26` and initialized on `main` at `ebbcaaf`. The released CLI wrote its
`dev-team` config using this repository's model and effort bindings, three read-only reviewer
seats (Claude, Codex, Grok), automatic merging, and depth limit 1. Its configured test command,
`python3 -m unittest discover -s tests -t .`, passed all 116 baseline tests.

Actual bindings, all at xhigh effort: planner and implementer on Claude `claude-opus-5-5`;
plan reviewer on Codex `gpt-6-astra`; code review seats on Claude `claude-opus-5-5`, Codex
`gpt-6.1-sol`, and Grok `grok-4.7`. No binding overrides, review waivers, resolver, or consult
were needed. All 11 delegations finished at depth 1 with exit 0 and native logs preserved.

The team added `slug_reverse(text: str) -> str`, seven tests, and a README example. Native
implementation log events record the missing-function import failure before the function
was added, then all 123 tests passing. Plan review was clean, followed by the required
planner revision. Code review round 1 covered `43d09c6`; all three seats returned
`VERDICT: no major issues`. One Minor finding asked for explicit Unicode escapes in a test
instead of literal combining characters. The implementer verified it and made the one-line
wrap-up correction; both spellings have the same runtime value. Round 2 covered `22c0657`;
all three seats marked the finding addressed, reported no new findings, and passed the suite.

The host tested both committed heads through the gate, fast-forward merged `22c0657` to
`main`, ran all 123 tests there, removed the task worktree, and deleted its branch. The
coordinator independently checked the final clean tree, only the root worktree, no `task/*`
branch, all 11 task records and native-log hashes, and all six review verdicts against their
recorded commits. The scoped verifier command was:

```sh
node tools/e2e-verify.mjs --project /home/wsh/Documents/cross-agent-codex-host-e2e-20261015 --since 43dfa41eac1ea9d2a88ee1a419fb8238d63b --slug codex-host-20261015
```

It confirms every journal step and no delegation or engine launch in any of the 11 specialist
transcripts. Final sample commit: `22c06576a430e393ec796cdce956f3ae72f97470`. First delegation:
`43dfa41eac1ea9d2a88ee1a419fb8238d63b`; journal: `codex-host-20261015`.

Observations retained with the pass:

- The host made one extra read-only `git_root` query using `rev-parse HEAD`, which the
  interface refused because it requires a branch name. It read `list_roles` before the
  required reconciliation, then reconciled and used `rev-parse main`. No state changed and
  no dispatch preceded reconciliation. This is a host deviation, not a product defect.
- The Minor wrap-up included an intermediate escaping mistake and a sandbox-refused write
  command. The implementer corrected them within the task; the tested and reviewed final
  change is correct. No engine task failed or was silently retried.
- The first verifier invocation inside the host sandbox exited 2 at its Git worktree query.
  Its output is preserved. The same verifier outside the sandbox passed all eight checks,
  as did the independent coordinator run.

Evidence is retained in the sample's ignored `.cross-agent/host-e2e-evidence/`: the complete
`host-run-summary.json` (task IDs, actual bindings, outcomes, review coverage, test history,
observations, paths, and hashes), `coordinator-verifier.txt`, `coordinator-verification.json`,
and the setup and native test-first evidence. Full task records, results, native logs, and
the journal remain under the sample's `.cross-agent/`. Preparation was committed locally as
`0a4edb7`. No push or remote sync was performed. Deliberate cancellation, failure injection,
and engine-placed leadership were outside this run. The product suite was not rerun for
these evidence-only repository edits; whitespace and citation checks cover the records.

## Release 0.1.9 — `atc-s96.151` (2026-10-15)

The package and both manifests are 0.1.9. Since 0.1.8 (`541bc98`) the payload carries the backlog
run's nine tasks (`f395066` … `1696dad`): the launcher's text on Claude Code's 120 s backgrounding,
the server and the narration; the binding in `delegate`, `wait` and `result` and `describe_mode`'s
`projectWarning`; the CLI's ancestry refusal of write verbs below an engine; bounded `list_tasks`;
every git child in its own group with a 30-minute timeout and an output cap; EPIPE handling in the
CLI and the server; `childEnv` dropping `GROK_SESSION_ID` and `AI_AGENT`, and the specialists'
plain-shell paragraph; the tidy task's single sources and case-blind guards; and the docs. After the
bump, `npm test` at the root ran 1233 tests: 1231 pass, 0 fail, 2 guarded skips. The opt-in real-Codex
packaging probe (`CODEX_SETUP_PROBE`) was not run this time.

The frozen source release is `439a8c8`, pushed to `main` as a fast-forward from `541bc98` on the
user's approval ("push and publish").

The publish opened https://github.com/WSH95/agent-plugins/pull/24 on
`publish/cross-agent-plugin/20261015184254` (commit `b8f0571`), 67 files. The target's `cross-agent/`
equals the frozen dist (`diff -r`). Its Claude and Codex plugin manifests and `package.json` read
0.1.9. `claude plugin validate` passes for the marketplace and, with `--strict`, for the plugin. The
PR is `MERGEABLE`, merge state `CLEAN`. No merge was performed.

The user merged PR #24 (`bd9f573`, 2026-10-15T18:45:05Z), updated the plugin in Claude Code and
reconnected the server. Read-only checks on the installed build: `installed_plugins.json` names
0.1.9 at `~/.claude/plugins/cache/agent-plugins/cross-agent/0.1.9`, and the running server is that
copy's `src/server.ts`, started after the update. An unfiltered `list_tasks` answered the 20 newest
settled tasks with `omitted: 327` (`.79` live). `describe_mode` served every specialist prompt with
the plain-shell paragraph (`.113` live), and `list_roles` the same bindings as before.

Codex, at the user's request: `codex plugin marketplace upgrade` and `codex plugin add
cross-agent@agent-plugins` installed 0.1.9; `codex plugin list --json` reads 0.1.9, installed and
enabled, and its cache equals the 0.1.9 Codex dist payload (`diff -r`). Grok holds no copy of its
own here: `grok plugin list` is empty and no project attach names this plugin; its specialists
started the server from Claude Code's install (the last Grok seat's `events.jsonl`:
`node ~/.claude/plugins/cache/agent-plugins/cross-agent/0.1.8/src/server.ts`), so they follow
Claude Code's update.

**Not verified yet:** that the next Grok session starts the 0.1.9 copy; the other changes on a live
task (they ran in the suite only).

## What a specialist's engine is given — `atc-s96.77`, `.113`, `.92`, `.78`, `.76` (2026-10-15)

Task 9 of the backlog run, its last (old tasks 11 and 12 combined). Went through the `dev-team`
loop and merged as a fast-forward from `3f6327a` to `1696dad` (slug `specialist-env`; commits
`5f331bf`, `1696dad`). No engine CLI was started for it: each bead was decided from the evidence
already on disk — this repository's ledger (336 tasks, 2026-10-04 to 2026-10-15), the Grok sessions'
own files, `docs/probes.md` and Grok's guide.
- **`.77`:** `src/guard.ts#childEnv` now drops `GROK_SESSION_ID` (a Grok host's session id) and
  `AI_AGENT` (the label a Claude Code host gives its server, carried by all 336 specs and handed to
  every Codex and Grok child as its own). `GIT_EDITOR` passes on: it marks no host, and its `true`
  keeps a headless git from waiting on an editor. `tools/probe.mjs` copies the list.
- **`.113`:** every specialist prompt — the five shared role files in both dev-team modes, the built-in
  consult and `modes/solo/roles/consult.md` — carries one plain-shell paragraph: run plain commands,
  read a status with `echo "exit $?"`, and take a "don't ask mode" refusal as no result but a command
  to split. The ledger read 174 refusals in 3,256 Claude `Bash` calls, clustered in loops, heredocs,
  `$(…)`/`${…}`, subshells, `VAR=`/`env` prefixes, `awk` and `git -c`; plain commands and their
  plain compounds ran (`docs/probes.md#specialistLedger`, stated there as text associations, not the
  layer's rule). No permission rule is added: one wide enough to approve those shapes would also
  approve what the deny list's prefix rules cannot read.
- **`.92`, `.78`, `.76`:** stated limitations in design section 3's Grok bullet ("What the adapter does
  not withhold"). A Grok specialist stays offered `spawn_subagent`, the `scheduler_*` tools and the
  rest (52 specialists called none; `--disallowed-tools` is documented but unexercised, so it stays
  off the spawn line). With the plugin installed in the operator's Claude Code (2026-10-13), every
  Grok worktree seat (51 of 51) was offered the launcher skill and mounted this server on the
  specialist row's five tools; the install guide's worktree bullet is now conditional. The operator's
  Claude Code plugin hooks ran inside Grok specialists (548 runs, all `success`); keep the Codex
  stop-review gate off while they run. Operator probes A–D for each are recorded in the plan and the
  probes section's "Not recorded"; none were run.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `no major issues`, 4 Minor, all folded in the
  planner's final pass (the shell advice qualified and the method disclosed, the install guide's
  contradiction, the test pinning the whole paragraph, the probes' precision).
- **Code review:** round 1 (`5f331bf`) all three seats `no major issues`. The wrap-up fixed five doc
  rows (the `_agent` label, a remaining unconditional worktree sentence in the design, a stray word,
  the 26-tool inits, the root mount marked as inference). The implementer rejected two with evidence:
  117 calls do carry `echo "exit $?"` (the 96 with no other pattern all ran), and `lead.md` says the
  lead runs no shell command. Round 2 (`1696dad`): all three `no major issues`, no Minor.
- **Tests:** `tests/guard.test.ts#childEnvHostAgent` and `tests/skills.test.ts#specialistsPlainShell`
  each failed first on what they pin. `describe_mode`'s stated sizes moved to 40,602 / 56,223 / 4,217
  bytes (`dev-team` / `dev-team-engine` / `solo`).
- **Gate and root suite:** 1233 tests at `1696dad`, 1231 pass, 0 fail, 2 guarded skips (gate at `5f331bf` the same).
- **Accepted limitations:**
  - None of the Grok switches (`--disallowed-tools`, `GROK_SUBAGENTS`, `GROK_CLAUDE_HOOKS_ENABLED`,
    `GROK_CLAUDE_SKILLS_ENABLED`, `plugins.disabled`, `skills.disabled`) has been run; whether a Grok
    subagent or a `durable` scheduled run outlives its task is unverified.
  - A Claude specialist may still compose a refused shape; the refusal costs a call and is the safe
    direction.
  - A Claude lead is given `Bash` (the shared read-tool set) although `lead.md` says it runs no shell
    command; its sandbox bounds it. The lead's prompt carries no plain-shell paragraph for that reason.
  - The table's ` $?` row reads 24/161 or 23/160 depending on whether the quote must close; both are
    regex readings, as the section says.

## Bounded `list_tasks` and a timeout on every git child — `atc-s96.79`, `.98` (2026-10-15)

Task 8 of the backlog run (old tasks 9 and 10 combined). Went through the `dev-team` loop and merged as
a fast-forward from `fac95fb` to `9f29d5c` (slug `bounds`; commits `66ba113`, `9f29d5c`).
- **`.79`:** `list_tasks` used to answer every record. On this repository that came to about
  145 KB, over Claude Code's own MCP result limit, and the loops' root check calls it unfiltered.
  - It now answers every active task plus the 20 newest settled ones
    (`src/tasks.ts#defaultSettledLimit`), after the reconciliation pass and the `status` filter.
  - It takes a `limit` (a whole number ≥ 0) and reports `omitted` for what it left out.
  - CLI `tasks` and `report` are unchanged. `describe_mode` is unchanged on purpose: Grok's attach
    ships `max_output_bytes = 100000`.
- **`.98`:** `run`, which every git call goes through, is now built on `spawn`.
  - git leads its own process group, and each output stream is capped at 16 MiB.
  - At `gitTimeoutSeconds = 1800`, or on an overflow, the group gets SIGTERM, then always SIGKILL
    2 s later. Only then does the call answer, and it refuses naming the timeout.
  - `git_mutate` and `git_root` then answer `ok: false` with the locks free. `record` still decides
    by whether its commit landed.
  - A git that cannot start (a NUL in an argument, `E2BIG`) refuses instead of throwing.
  - A gate checkout that git could not finish is refused, and its directory is removed.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `major issues`: 2 Important (an argument-free
  call would have been refused; git's `close` could cancel the SIGKILL) and 4 Minor, all folded.
  Round 2 `no major issues`, 2 Minor folded. The reviewer judged the separate process group the
  right trade.
- **Code review:** round 1 (`66ba113`) all three seats `no major issues`. Five Minor rows were fixed
  in a wrap-up: a synchronous spawn fault (a regression from `main`), a line citation, the description
  built from the constant, the design sentence narrowed for `record`, and the gate checkout's
  cleanup. Round 2 (`9f29d5c`): all three `no major issues`, no Minor.
- **Tests:** each new test failed first on what it pins. The three hang tests ran 30.2 s with the
  hook sleeping out its 30 s before the change, and about 5 s after it. With the group SIGKILL
  removed as a check, the TERM-ignoring hook survived.
- **Gate and root suite:** 1231 tests at `9f29d5c`, 1229 pass, 0 fail, 2 guarded skips.
- **Accepted limitations:**
  - Git runs in its own group, so a terminal Ctrl-C on `cross-agent git`/`git-root`, or a server
    killed as part of an engine's group, no longer reaches a running hook. That hook then runs with
    the locks released (the operator guide says so).
  - A hook that legitimately runs past 30 minutes is cut.
  - A git that resists SIGTERM may leave `index.lock` behind.
  - A hang shorter than 30 minutes still needs the by-hand procedure.
  - The 20,000-byte figure holds for ordinary records only. `describe_mode` stays above Grok's
    default cap.
  - The `git -C` reads that find a project or verify a worktree keep no timeout.
  - A refused gate checkout may leave a prunable worktree registration behind.

## The verifier learns its recorded Codex shapes and names every doubt — `atc-s96.69`, `.72`, `.62`, `.94` (2026-10-15)

Task 7 of the backlog run. Went through the `dev-team` loop and merged as a fast-forward from
`7a953df` to `f6b89c2` (slug `verifier`; commits `6ac80f4`, `f6b89c2`). Only `tools/e2e-verify.mjs`,
its tests and `docs/design.md` changed; nothing in `src/`.
- **`.69`:** Codex's `--json` `file_change` item (an apply_patch edit) reads as a change that runs
  no command, in exactly its recorded shape (`recordedFileChange`). Any other `file_change` answers
  `?` ("file_change in a shape no archived run recorded").
- **`.72`:** Codex's own `sleep` and `request_user_input_async` calls read as calls that run no
  command, with the whole payload exact (`codexOwnCall`); any other shape stays `?`.
- **Follow-up from the planner:** `codeModeWait` now requires the strings `function_call` and
  `wait` themselves; an array name or type passed before.
- **`.62`:** on the lead row, a `delegate` name the script reader cannot follow is no doubt.
  Unfollowed command-tool names and computed `tools[…]` stay doubts. A record's row names every
  doubt it holds, each once.
- **`.94`:** `#claudeAdapterVocabulary` ties every tool the Claude adapter can grant, its lead
  mount's included, to the verifier's vocabulary. `serverTools` gains `record` and `track`, which a
  Claude lead calling them answered `?` before.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `major issues`: 1 Important (string identity
  values) and 3 Minor, folded. Round 2 `no major issues`, with the `codeModeWait` follow-up taken in.
- **Code review:** round 1 (`6ac80f4`) all three seats `no major issues`. Two Minor rows were fixed
  in a wrap-up (a delegate-only string named as such; two `?` rows pin their reasons). Round 2
  (`f6b89c2`): all three `no major issues`, no Minor.
- **Archive checks:** condition 8 over fixtures built from `~/.cache/agent-team/probe-logs/`,
  `main` → branch:
  - E4: `? … (file_change)` → `pass … 6 transcripts`.
  - E2 and E2c: `? … delegate: 1 occurrences but only 0 direct calls followed` →
    `pass … 5 transcripts; judged by the lead row`.
  - E5 `--read-rollout`: no `sleep` or `request_user_input_async` reason; the calls are still
    listed.

  The implementer ran E5. The controller ran E4, E2 and E2c outside the project, because the
  implementer's sandbox refused the scratch repository's commit.
- **Gate and root suite:** 1223 tests at `f6b89c2`, 1221 pass, 0 fail, 2 guarded skips.
- **Accepted limitations:**
  - Values no archive recorded (`kind: "delete"`, `status: "failed"`, another `sleep` namespace)
    stay `?` until a person reads the first run that shows one.
  - A record's row has no length bound when a rollout lacks many transcript commands.
  - The row still shows at most three records.

## The CLI refuses writes by ancestry — `atc-s96.123`, `.74` (2026-10-15)

Task 6 of the backlog run. Went through the `dev-team` loop and merged as a fast-forward from
`a94bb67` to `4b785cc` (slug `selfhost`; commits `3890a86`, `4b785cc`).
- **`.123`:** every CLI write verb (`init`, `answer`, `cancel`, `git`, `git-root`, `waive`,
  `tasks --reconcile`) now also resolves its row by process ancestry through
  `src/authority.ts#resolveAuthority`, unchanged, and refuses with 3 unless the row is the
  operator's (`src/cli.ts#ancestryRefusal`). The marker refusal is unchanged and checked first,
  and reads stay open. The suite's own CLI runs walk as the operator through a test preload
  (`tests/fixtures/operator-ancestry.mjs`, `cliEnv`), so `npm test` still passes below a task.
  `tests/authority.test.ts#cliBelowEngine` pins the refusals, the reads and the preload below
  an engine.
- **`.74`:** no new deny patterns. Design section 3 says the deny list's path forms name only the
  server's own checkout and are not the boundary; ancestry is.
- Task 5's two leftovers: `#devTeamModes` derives the shared role keys from `dev-team`, and the
  new-branch rule is no longer called the slug alphabet (design, `newBranchFault`'s comment,
  a test name).

Verification:
- **Plan:** the planner flagged a human decision (the authorization change, fail-closed refusal of
  an operator whose walk cannot finish, Claude's PID namespace). The controller settled it under the
  user's standing instruction, since the bead itself offered the two options. Plan review round 1
  (codex/gpt-6-astra/xhigh) `no major issues`, 3 Minor folded (a citation continuation, the
  opt-in Codex test's two `init` calls, the settled answers).
- **Code review:** round 1 (`3890a86`) all three seats `no major issues`; 3 Minor fixed in a
  wrap-up (`init` and `init --config -` pinned below an engine; which ledger the check reads; the
  guide's rerun wording). Round 2 (`4b785cc`) all three `no major issues`, no Minor.
- **Live evidence (round 1, the worktree's CLI with the markers unset, `cancel` of an unknown
  id):** the Codex seat exited 3 with "ancestor 1 carries CROSS_AGENT_TASK=… and no record
  matches" (its sandbox has a PID namespace of its own). The Grok seat exited 3 with "ancestor
  <pid> holds the engine identity of task …, but its environment cannot be read". The Claude
  seat's `dontAsk` permissions refused the command, so a Claude seat is unverified. Its Bash
  carries the markers and has its own PID namespace, so the marker path is the one that would
  answer.
- **Gate and root suite:** 1218 tests at `4b785cc`, 1216 pass, 0 fail, 2 guarded skips.
- **Accepted limitations:**
  - An operator whose walk cannot finish (32 hops, an unreadable stat, a reparent race) is refused
    and reruns the verb from a plain terminal.
  - Under a sandbox with its own PID namespace, the walk sees a task only through a marker a
    process inside it was started with.
  - A process that sheds every marker and every marked ancestor reads as the operator, as for a
    server.
  - A ledger read that throws exits 1 rather than 3 (nothing is written).
  - A lead's refusal reads "specialist by ancestry … (lead, …)".

## Tidy: one source per rule, case-blind state guards, git's branch names — `atc-s96.84`, `.87`, `.91`, `.81`, `.89`, `.90`, `.101` (2026-10-15)

Task 5 of the backlog run (old tasks 5 and 6 combined). Went through the `dev-team` loop and merged
as a fast-forward from `e8f87ae` to `1dfad88` (slug `tidy`; commits `a9bf039`, `1dfad88`).
- **`.84`:** `src/ledger.ts` exports `activeStatuses`, `claimableStatuses` and `authoritativeStatuses`,
  and the copies in `authority.ts`, `delegate.ts`, `guard.ts` and `tasks.ts` are gone.
- **`.87`:** one byte-equal shared-prompts test (`tests/modes.test.ts#devTeamModes`); the
  `tests/skills.test.ts` copy and the design's stale "until step 9 generates both" are gone.
- **`.91`:** `src/mailbox.ts#printable` is the one renderer; `src/cli.ts#iso` is gone.
- **`.81`:** `tests/authority.test.ts#engineEnvironmentUnreadable` pins `decide`'s "…but its
  environment cannot be read" row.
- **`.89`, `.90`:** `smuggled` and `trackedStateFault` match `.cross-agent` and the worktree
  directory with `:(icase)`, `trackedStateFault` names every tracked path, and its repair advice is
  `git rm -r --cached -- ':(icase).cross-agent'`, which a test runs through real git.
- **`.101`:** `nameFault` accepts what `git check-ref-format --branch` accepts as written (still
  refusing a leading `-`, `HEAD`, `@`, `@{`, revision syntax and path forms); a new branch from
  `worktree add -b` keeps the slug alphabet (`newBranchFault`); `BRANCH_RULE` is the one sentence
  the CLI and setup quote; a merge and delete of `task/a+b` is pinned.
- The previous task's stale test title (`tests/tasks.test.ts#resultFinalMessage`) is fixed.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `major issues`: 1 Important (a setup test
  pinned the old wording) and 2 Minor, folded by the planner with I5 (tracked-state `:(icase)`) and
  I8 (`authoritativeStatuses`); round 2 `no major issues`, 1 Minor folded.
- **Departure:** the setup skill writes `git check-ref-format --branch` as plain text, because two
  `tests/skills.test.ts` guards read every code span there as a command the skill runs.
- **Code review:** round 1 (`a9bf039`) all three seats `no major issues`; 5 Minor fixed in a
  wrap-up (design "Three limits"; the operator guide's exact `HEAD`/`@`; repair advice that untracks
  every case, failing first on the old advice; the new-branch rule in the design; the merge and
  delete pin). Round 2 (`1dfad88`) all three `no major issues`, no Minor. Two round-1 leftovers
  (the five-role list hard-coded in `#devTeamModes`, and the design calling the branch class "the
  slug alphabet") are folded into task 6.
- **Gate and root suite:** 1217 tests at `1dfad88`, 1215 pass, 0 fail, 2 guarded skips.
- **Accepted limitations:** names git accepts that a person may not expect now pass (git is the
  judge); a non-UTF-8 name reads back with U+FFFD; the case-blind match also refuses `.Cross-Agent/`
  on a case-sensitive filesystem; the loops' `:(exclude)` pathspecs stay case-exact (the merge
  refuses a staged cased directory); the `.cross-agent/` line the refusal suggests for `.gitignore`
  is case-sensitive, and the `:(icase)` check still refuses whatever it lets through.

## The binding in the answers, and `projectWarning` — `atc-s96.95`, `.102` (2026-10-15)

Task 4 of the backlog run. Went through the `dev-team` loop and merged as a fast-forward from
`3d73742` to `12709e0` (slug `binding-answers`; commits `3570998`, `12709e0`). `delegate`, `wait`
and `result` (both ok branches) now answer the task's `engine`, `model` and `effort` from its record,
`null` where none was named; the `dev-team-engine` lead fills each report line from those answers,
never from memory, and its loop no longer points the report at `list_roles`; the launcher narrates
the delegation's answer and names the fields in "Starting a task", as the three tool descriptions
do. `describe_mode` answers `projectWarning` (its own key, beside the unchanged `warning`) when the
directory the server was started in lies in an initialized project other than `projectRoot`
(`src/server.ts#cwdProjectWarning`, given the directory by `main` alone); the launcher shows it and
judges it as the roster's Stop case. `dev-team-engine`'s `describe_mode` size is now 52,527 bytes.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `no major issues`, 2 Minor folded (named
  values pinned on every answer; the engine loop's report source).
- **Code review:** round 1 (`3570998`) all three seats `no major issues`, 5 Minor fixed in a
  wrap-up (the whole check inside its `try`; a served-project case; the Codex bundled-mount limit
  stated; the fields named in the tool descriptions; a stale comment); round 2 (`12709e0`) all three
  `no major issues`. One test title left stale in `tests/tasks.test.ts` is folded into task 5.
- **Gate and root suite:** 1213 tests at `12709e0`, 1211 pass, 0 fail, 2 guarded skips.
- **Accepted limitations:** a lead may still ignore the text (the ledger and `cross-agent report`
  stay the authority); under Codex's bundled mount the server starts in its cache copy, so the
  warning never speaks for the host's project there.

## EPIPE on the CLI's stderr and the server's stdout — `atc-s96.120`, `.121` (2026-10-15)

Task 3 of the backlog run. Went through the `dev-team` loop and merged as a fast-forward from
`bf93670` to `f811cf4` (slug `epipe`). The CLI drops EPIPE on stderr as it already did on stdout,
so `report 2>&1 | head` keeps the verb's exit code. The server, on EPIPE on stdout (its host gone
mid-reply), exits with the code a stdin end gives it and no stack, and does nothing else: detached
runners run on (`src/delegate.ts#startRunner` starts them `detached`, with `stdio: "ignore"`, and
unrefs them), the next server's reconciliation settles them, and a pending `wait` or `ask` ends with
the process. Only EPIPE is swallowed; any other stream error still throws.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `no major issues`, 2 Minor folded.
- **Code review:** round 1 (`f811cf4`) all three seats `no major issues`; seat 3 probed both
  shapes on Node 24.11.0 (without the handlers: exit 1 with an `Unhandled 'error' event` stack;
  with them: exit 0, empty stderr; an `EIO` still throws). One optional Minor (cite
  `startRunner` in the server's comment) not taken.
- **Tests:** `tests/cli.test.ts#cliClosedStderr` and `tests/server.test.ts#serverClosedStdout`, each
  seen failing before its fix. Gate and root suite: 1209 tests at `f811cf4`, 1207 pass, 0 fail,
  2 guarded skips.
- **Accepted limitations:** the immediate exit can stop an in-flight root write as a host kill
  would, and may cut short queued stderr lines; a live host that closes the server's own stderr
  can still crash it on its next stderr write (rare: the server writes stderr only at startup and
  on a request's first permission check).

## Docs — `atc-s96.125`, `.126`, `.127` and task 1's two follow-ups (2026-10-15)

Task 2 of the backlog run. Went through the `dev-team` loop and merged as a fast-forward from
`a89871e` to `17ea9ae` (slug `docs-text`; commits `e631a4f`, `17ea9ae`). Every place that has a
Claude Code user restart the server after `init` or a mode change (README, install guide, operator
guide, setup skill, launcher) now names `/mcp`, choose cross-agent, Reconnect as the lighter path and
says `/reload-plugins` does not restart the server, recorded in `docs/probes.md#claudeReloadPlugins`.
The resolver is "on a stronger setting" everywhere; `describe_mode`'s sizes move to 36,906 / 52,225 /
3,601. The design now says `init` writes the values of section 6's config, not its bytes. The
launcher's narration treats an engine switch as its own rule (N2-1), and the probe entry's Reading
credits each statement to the text that makes it (N2-2).

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `no major issues`, no findings; the
  optimization pass folded the launcher's two restart lines.
- **Implementation:** the first run reported BLOCKED: the plan's verbatim sentence named
  `` `delegate` `` in a paragraph both placements read, which the launcher's placement guard
  refuses. The host sent the one-word correction ("the server drops") back as a plan correction
  rather than stopping the run.
- **Code review:** round 1 (`e631a4f`) all three seats `no major issues`, 3 Minor and one folded
  follow-up (the probe entry), fixed in a wrap-up; round 2 (`17ea9ae`) all three `no major issues`.
- **Gate and root suite:** 1207 tests at `17ea9ae`, 1205 pass, 0 fail, 2 guarded skips.
- **Accepted limitation:** a resume that names no model runs the record's model, which the
  engine-switch narration rule could misname on a chain whose first call switched engine and named
  a model (the needs-work section already gives the resume's model rule).
- **Not verified:** the Claude Code version behind the `/reload-plugins` observation.

## Launcher text — `atc-s96.122`, `.82`, `.83`, `.66` (2026-10-15)

Task 1 of the backlog run. Went through the `dev-team` loop and merged as a fast-forward from
`2fa1006` to `f395066` (slug `launcher-text`; commits `32b1571`, `f395066`). The launcher's Claude
Code row and a new `## Watching` paragraph describe the 120 s backgrounding (the call keeps running,
its answer arrives as a task notification, it is no reason to call again), cited to the new
`docs/probes.md#claudeCodeBackground` (the pilot and this run, the message quoted verbatim) and one
`docs/design.md` "Time limits" sentence. The launcher now says a host never starts `src/server.ts`
itself, names `.claude/`, `.codex/`, `.grok/` and `.mcp.json` in the one-shot's commit step, takes
the narration's engine, model and effort from the roster, the call or the task's record (a default
named as such), and appends nothing to `.cross-agent/log.md` under engine placement. `.66`'s roster
and `result` parts were already met and pinned.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `no major issues`, no findings.
- **Code review:** round 1 (`32b1571`) all three seats `no major issues`, 4 Minor (fixed in a
  wrap-up); round 2 (`f395066`) all three `no major issues`, 2 Minor left as follow-ups (N2-1: the
  narration rule for a call that names another engine; N2-2: the probe entry credits the row with
  "no reason to call again"), folded into task 2.
- **Gate and root suite:** 1205 tests at `f395066`, 1203 pass, 0 fail, 2 guarded skips, in the
  gate's checkout and at the root after the merge.
- **Not verified:** the Claude Code version; whether `claude -p` backgrounds at 120 s
  (`modes/dev-team-engine/roles/lead.md` still says about 28 hours, an accepted limitation).

## The live acceptance trace of `atc-2jl` on 0.1.8, with `atc-2jl.5` (2026-10-15)

The epic plan's trace (`.cross-agent/plans/atc-2jl/plan-approved.md`, "Live acceptance trace"),
run on the installed 0.1.8 after the user merged agent-plugins PR #23. Claude Code updated by the
user; Codex updated here (`codex plugin marketplace upgrade`, `codex plugin add
cross-agent@agent-plugins`), its cache equal to the dist payload (`diff -rq`).

**The project.** `~/.cache/agent-team/cross-agent-trace/kvtiny`: a tiny ES-module library with a
`node --test` suite, beads initialized by `bd init --non-interactive -p kv --skip-agents` (bd 1.2.2,
its git hooks installed, its own init commit), `.project-steward/` with `HANDOFF.md`,
`PROGRESS.md` and `DECISIONS.md`, and an `AGENTS.md` whose Task backend and Project Steward sections
say how the records are kept. **Step 1 passed:** the installed CLI's `init --propose` gave the
`dev-team-engine` proposal the `records` block (the three steward files; bd's verbs;
`.beads/interactions.jsonl`). It was written as proposed but for a cheaper roster (lead
claude-opus-5-5 high; Sonnet and Codex specialists at medium; one review seat).

**Run 1: an epic, a Claude lead.** Epic `kv-q15` with A `kv-q15.1` (clamp; its text names a
bigint follow-up to file) and B `kv-q15.2` (lerp, depends on A). Host: a headless `codex exec`
told to work epic kv-q15, nobody attending. All pass conditions held:
- A was claimed, merged (`e3c5a68`), recorded (`91c9195`) and closed (`a2bfe9c`) before B was
  claimed (B's claim journal step starts from `a2bfe9c`); then B merged (`bb808a3`), recorded
  (`e2c9555`), closed (`0c23568`); the epic was closed (`769abe1`) and the final handoff written
  (`83203bf`).
- A's follow-up `kv-xs9` (bigint), and `kv-ts1` (NaN, from the plan), were filed with no parent,
  never claimed, and are open at the end.
- The host's transcript: 64 cross-agent calls (describe_mode, list_roles, one delegate, then
  wait, list_tasks, list_asks, check, result) and three `cat`s of skill files; no `bd`,
  `project-steward`, `track` or `record` call, no file change. It showed the lead's report whole.
- Every commit on `main` is a task merge (each task journal's `merged`) or a run-journal step;
  every step with a commit is `verified: true`; the claims and filings committed nothing.
  `git status --porcelain` empty at the end, no worktree or branch left.

**Run 2: a goal, a Codex lead** (codex gpt-6-astra high). Goal: snap(n, step) and snapClamp(n,
step, lo, hi). The lead asked one clarifying question, relayed verbatim by the host, which ended
its turn; I answered with `cross-agent answer` and resumed the host. Its one approval ask carried
the design and the ordered two items, each with its acceptance and dependency; it was answered
"yes" at 06:00:51 UTC, and the run's first write came after it (06:01:10). All pass conditions
held:
- The yes filed in R3's order: `record` of the approved design with the handoff saying filing has
  begun (`7951ef0`), `track epic` (`kv-34j`), two `track create {parent}`, `track depend`, then the
  handoff naming the goal, the epic and the set (`c3ec920`).
- The items were worked as in run 1: claim, merge (`668754c`, `e2478e5`), record, close, then
  cleanup (to the millisecond, each record and close before its `worktree remove`), the epic closed
  (`9e13427`) and the final handoff (`959de95`). Every commit on `main` is a merge or a verified
  run-journal step; the root clean at the end.
- The host's three sessions made no `bd`, `project-steward`, `track` or `record` call and changed
  no file.

**`atc-2jl.5`, `record`'s `expect` type array.** Both leads were offered `record` and called it
with `expect` as a sha256 on every replace (each write landed and verified); neither sent an
explicit null (both omitted `expect` on appends). A direct probe settled it: a headless `codex
exec` and a headless `claude -p`, each told to call `record` with `{"path":
".project-steward/DECISIONS.md", "mode": "replace", "expect": null}`, sent `"expect": null` and got
the server's own refusal ("exists, and expect null names a file that does not"), the file and the
root unchanged. So both hosts accept the schema and pass the null through.

**Observed, nothing to fix in this epic:**
- Claude Code's project-steward plugin hooks write `.project-steward/runtime/` in any project with
  `.project-steward/`; in a project that does not ignore it, the root is unclean and `record`
  refuses (as the first Claude probe did). `project-steward init` ignores that directory; the
  scratch project, made by hand, did not until it was added.
- The Codex host waited in 45-second calls rather than the launcher's 600 for Codex, and read the
  steward's `HANDOFF.md` once because project-steward's session-resume skill told it to; neither
  touched a record.

## Release 0.1.8 — `atc-s96.150` (2026-10-15)

The package and both manifests are 0.1.8. Since 0.1.7 (`0ab03cf`) the payload carries epic
`atc-2jl`, the engine lead owning the backlog and the project's records: the optional `records`
config, the `record` and `track` tools (`atc-2jl.1`, `.2`), setup's records proposal and reconnect
(`.3`), the engine lead's run with the specialists' bookkeeping sentence and the planner's
goal-breakdown exception (`.4`), the run's epic close (`.10`), and `git_root`'s trailing-`.` refusal
(`.9`); `atc-9w2`'s test fix is not in the payload. After the bump:
- `CODEX_SETUP_PROBE=$(command -v codex) node --test tests/packaging.test.ts tests/dist.test.ts
  tests/publish.test.ts tests/codex-native.test.ts` passed 34 tests, none skipped;
- `npm test` at the root ran 1201 tests: 1199 pass, 0 fail, 2 guarded skips.

The frozen source release is `541bc98`, pushed to `main` as a fast-forward from `0ab03cf` on the
user's approval ("Push and release 0.1.8").

The publish opened https://github.com/WSH95/agent-plugins/pull/23 on
`publish/cross-agent-plugin/20261015052940` (commit `84aa080`). It holds 53 files: the marketplace
version, and in both payloads the plugin manifest, `package.json`, the three modes' loops and role
prompts, both skills, and `src/{cli,config,gitroot,modes,records,runcommand,server,setup}.ts`. The
target's `cross-agent/` equals the frozen dist (`diff -r`). `claude plugin validate` passes for the
marketplace and, with `--strict`, for the plugin. The PR is `MERGEABLE`, merge state `CLEAN`. No
merge was performed.

**Not verified yet:** the epic's live acceptance trace (its plan's "Live acceptance trace", with
`atc-2jl.5`'s `expect` type array against real Claude and Codex leads), which runs on the installed
0.1.8.

## The flaky `#quietTaskWhose` — `atc-9w2` (2026-10-15)

Went through the `dev-team` loop and merged as a fast-forward from `c867d3c` to `213dacf` (slug
`9w2-flake`). Test only. The cause is a race in the test's setup, not in the product: the runner
acknowledges right after spawning the `stall` engine, and the test SIGKILLs it at once, so whether the
engine has finished writing its startup lines decides the reason. An engine that has not dies of the
unhandled `EPIPE` its next write meets (Node ignores SIGPIPE), and the pass settles `runner lost`;
one that has idles on and is ended by orphan cleanup, `runner lost; engine group terminated`. Both
are correct, so `tests/wait.test.ts#quietTaskWhose` now accepts that closed pair, as
`#runnerKilledDuring` already did, and still asserts `failed`, the settled hint and a dead engine.
Two comments that blamed SIGPIPE now name the `EPIPE`.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `no major issues`; the reviewer confirmed the
  cause from the code and with a probe on Node 24 (`SigIgn` has SIGPIPE; exit 1 on `EPIPE` before
  the output, exit 143 on SIGTERM after it).
- **Code review:** round 1 (`213dacf`) all three seats `no major issues`, no findings.
- **Gate and root suite:** 1201 tests at `213dacf`, 0 fail; the root suite there ran 1201: 1199
  pass, 0 fail, 2 guarded skips.
- **Not verified:** the race itself was not reproduced; the fix accepts the outcome it produced.

## `git_root` refuses a branch name ending in `.` — `atc-2jl.9` (2026-10-15)

Follow-up of epic `atc-2jl` (from `atc-2jl.4`'s plan review). Went through the `dev-team` loop and
merged as a fast-forward from `fae2721` to `4c2288e` (slug `2jl-9-dot`). `src/gitroot.ts#nameFault`
also refuses a name ending in `.`, which git refuses (`git check-ref-format --branch task/example.`
fails), so a tracker id ending in `.` used as a slug is refused before `git_root`'s git command runs
rather than failing in git with an exit code; every other name it accepted still passes. The
refusal messages in `src/setup.ts#defaultBranchFault` and `src/cli.ts#worktreeBranchRefusal`,
`docs/design.md` and the setup skill's branch rule state the trailing `.`; both dev-team loops' slug
sentence now keeps the journal's alphabet apart from `git_root`'s branch exclusions (`..`, a
trailing `.` or `.lock`), which the plan reviewer judged worth folding in.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `no major issues`, three Minors folded.
- **Code review:** round 1 (`4c2288e`) all three seats `no major issues`; seat 1's one Minor (an
  unpinned message on an unreachable path) not taken, and git's other ref-format rules stay the
  plan's stated limitation, already deferred in `docs/design.md`.
- **Gate and root suite:** 1201 tests at `4c2288e`, 0 fail; the root suite there ran 1201: 1199
  pass, 0 fail, 2 guarded skips. Citation check: 0 misses, 0 drifted since `fae2721`.
  `describe_mode` sizes: 36,895 (`dev-team`), 52,216 (`dev-team-engine`), 3,601 (`solo`) bytes.

## A finished run closes its epic — `atc-2jl.10` (2026-10-15)

Follow-up of epic `atc-2jl` (from `atc-2jl.4`'s round-1 review). Went through the `dev-team`
loop and merged as a fast-forward from `ebb09f6` to `c94ae09` (slug `2jl-10-epic`; `9b7232f` the
change, `c94ae09` the wrap-up). Text and tests only. R5 in `modes/dev-team-engine/SKILL.md` gains
a step: when every item of the set is closed and no stop ended the run, the run's epic (a goal's
from R3, or the one the brief names) is closed with `track show` then `track close` once `show`
reports every child closed, after the follow-ups and before the final handoff; a child not closed
leaves it open and named; a list of ids has no epic; the report lists the close. `roles/lead.md`
says the epic is no item and R5 closes it on its own conditions. `docs/design.md`'s run paragraph
is rewrapped (atc-2jl.4's round-3 cosmetic Minor) and describes the step, as does the operator
guide.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `no major issues`, two Minors folded.
- **Code review:** round 1 (`9b7232f`) all three seats `no major issues`; seat 1's two Minors (the
  lead prompt's item rule and report, a missing pin) fixed in the wrap-up. Round 2 (`c94ae09`) all
  three `no major issues`, no findings.
- **Gate and root suite:** 1198 and 1199 tests at the two heads, 0 fail; the root suite at
  `c94ae09` ran 1199: 1197 pass, 0 fail, 2 guarded skips. Citation check: 1803 citations, 0
  misses. `describe_mode` for `dev-team-engine`: 52,068 bytes.
- **Not verified:** a real lead closing a real epic (the live trace after a release).

## The engine lead's run — `atc-2jl.4`, with `atc-s96.117` and `atc-2jl.8` (2026-10-14)

Task 4 of epic `atc-2jl`, the last of its four. Went through the `dev-team` loop and merged as a
fast-forward from `80a8381` to `5a78aec` (slug `2jl-4-run`; `1c7c448` the change, `b088cbe` the
round-1 fix, `5a78aec` the round-2 wrap-up). Text and tests only, no server change.
`modes/dev-team-engine/SKILL.md` gains `## The run` (R1 finding the run's place, R2 each item in
dependency order — step 1, `track claim`, steps 2-9, `track file` for follow-ups, one `record`,
`track close`, step 10 — R3 a goal clarified through `ask`, designed and broken down by the
planner, approved in one `ask` and only then recorded and filed, R4 follow-ups filed and never
worked, R5 the run's end), step 10's report deferred to R5 under `records`, and the `recorded` and
`tracked` journal rows; `roles/lead.md` names the entry points, the bookkeeping rule and the
report's additions. Every specialist prompt and the consultant's gain atc-s96.117's sentence (the
project's task-tracking, handoff and commit instructions belong to the session that runs the
loop); the planner's prompt gains one exception for a goal's design and breakdown. The launcher's
engine-placement section adds `track` and `record` to what the host never calls and says the host
does no bookkeeping of its own accord at any point of a records run. `AGENTS.md` (the "If
cross-agent launched you" exception and the `modes/` Layout line), `docs/design.md` and
`docs/operator-guide.md` follow; atc-2jl.8's rewrap is in it. Without a `records` block nothing
changes but atc-s96.117's sentence.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `major issues`, one Important (two test pins
  did not match the drafted text); round 2 `no major issues`; the planner's optimization pass.
- **Code review:** round 1 (`1c7c448`) seats 1 (claude) and 3 (grok) `no major issues`, seat 2
  (codex/gpt-6.1-sol) `major issues`: R3 asked the planner for a breakdown its prompt forbade
  ("this plan is one task"), fixed by the planner exception, with four Minors (goal routing, a
  stopped step 10, a test loop that could not fail, one scope for the host's ban). Round 2
  (`b088cbe`) all three `no major issues`, three Minors fixed in the wrap-up (a rewrap, asking
  before re-filing a goal whose filing began, telling the plan reviewer it reviews a breakdown).
  Round 3 (`5a78aec`) all three `no major issues`; seat 1's cosmetic Minor (a ragged reflow in
  `docs/design.md` around 3654 and 3661) goes to `atc-2jl.10`.
- **Gate and root suite:** 1193, 1196 and 1197 tests at the three heads, 0 fail; the root suite at
  `5a78aec` ran 1197: 1195 pass, 0 fail, 2 guarded skips. Citation check: 1802 citations, 0
  misses, 0 drifted since `80a8381`, 0 not judged. `describe_mode` sizes: 36,747 (`dev-team`),
  51,385 (`dev-team-engine`), 3,601 (`solo`) bytes.
- **Not verified:** what a real engine lead does with this text; the pins hold the wording. That
  is the epic's live acceptance trace, the operator's after a release, with `atc-2jl.5` (`record`'s
  `expect` type array against real Claude and Codex leads).

## Setup proposes the records block — `atc-2jl.3`, with `atc-2jl.7` (2026-10-14)

Task 3 of epic `atc-2jl`. Went through the `dev-team` loop and merged as a fast-forward from
`89a92ba` to `c6a6433` (slug `2jl-3-setup`; `a34923f` the change, `c6a6433` the review wrap-up).
`src/setup.ts#detectRecords` proposes a `records` block for `dev-team-engine` alone, and only
where both halves are found: a real `.beads/` holding `config.yaml` or `metadata.json` with `bd`
on `PATH` (looked up, never run), and every regular `.md` file directly under a real
`.project-steward/` that the path rules admit. The tracker is bd 1.2's own commands
(`BEADS_TRACKER`: `--silent` creates, `update --claim`, `close --reason`, `dep add`) committing
`.beads/interactions.jsonl`. A declared path through a symbolic link proposes nothing; a base's
own block stands over the detected one. `init --config` now answers `reconnect` when a write adds
or removes the block against what the running server registered. The setup skill shows the block
before it asks and reads `describe_mode`'s records warning at its connection check.
`atc-2jl.7`'s word in `docs/design.md` is reflowed in it.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `major issues`, one Important (I1, a test
  fixture that could not fail); round 2 `no major issues`. The host supplied bd 1.2.2's flags
  from `bd --help`, since no specialist runs `bd`.
- **Code review:** round 1 (`a34923f`) all three seats `no major issues`, four Minor rows fixed
  in the wrap-up (a marker that can now fail, the removed-block reconnect text, a base's block
  pinned, the guide's steward-files wording); proposing `.beads/issues.jsonl` was left out of
  scope. Round 2 (`c6a6433`) all three seats `no major issues`; seat 1's one cosmetic Minor (a
  short line in `docs/operator-guide.md` around 81) goes to Task 4.
- **Gate and root suite:** 1182 tests at `a34923f` and at `c6a6433`, 0 fail; the root suite at
  `c6a6433` ran 1182: 1180 pass, 0 fail, 2 guarded skips. Citation check: 1782 citations,
  0 misses, 0 drifted since `89a92ba`, 0 not judged.
- **Not verified:** that a real `init --propose` here proposes the block (the tests use a fake
  `bd`); nothing yet runs the proposed tracker commands from an engine lead (Task 4 and the live
  trace).

## The `track` tool — `atc-2jl.2`, with `atc-2jl.6` (2026-10-14)

Task 2 of epic `atc-2jl`. Went through the `dev-team` loop and merged as a fast-forward from
`f662107` to `9360f3e` (slug `2jl-2-track`; `cad6503` the change, `9360f3e` the review wrap-up).
`src/records.ts#track` runs the configured tracker commands at the root with no shell
(`src/runcommand.ts#runArgv`): a reading verb under `git.lock` alone, refused when HEAD or the
root changed; a writing verb on the shared root-commit procedure (`underLocks`, `rootReady`,
`landCommit`, which `record`'s `commitRecords` now uses too, its answers unchanged), committing
only `tracker.files` or journalling a no-commit `tracked` step; a non-zero exit, a kill at 120 s,
a moved HEAD or a change outside `tracker.files` commits nothing and leaves the tracker's change
in place. `track` registers beside `record` for the operator and lead rows. `atc-2jl.6`'s three
Minors (the could-not-verify wording, the guide's journal paths, a root-user skip) are in it.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `no major issues`, three Minors folded; the
  planner's one "human decision" was the host's own brief (`tests/server.test.ts#recordRows`
  pins record-only registration until Task 2), settled by the host.
- **Code review:** round 1 (`cad6503`) all three seats `no major issues`, four Minor rows fixed in
  the wrap-up (journaled-call wording, the post-run answer qualified, a trimmed refusal, a failing
  read-verb test). Round 2 (`9360f3e`) all three seats `no major issues`; one leftover word in
  `docs/design.md` went to `atc-2jl.7`.
- **Gate and root suite:** 1175 tests at `cad6503` and at `9360f3e`; the root suite at
  `9360f3e` ran 1175: 1173 pass, 0 fail, 2 guarded skips. Citation check: 1772 citations,
  0 misses (seat 1's run). The implementer's first worktree run of the wrap-up hit a race in
  `tests/wait.test.ts#quietTaskWhose`, untouched by this change; the re-run passed (`atc-9w2`).
- **Not verified:** a tracker that leaves a background process holding its output (the bound is
  stated, untested); nothing yet calls `track` from an engine lead (Task 4).

## The records config, the root commit and `record` — `atc-2jl.1` (2026-10-14)

Task 1 of epic `atc-2jl` (the engine lead owns the backlog and the project's records, Decision
0022). Went through the `dev-team` loop and merged as a fast-forward from `ca46231` to `c1cb58c`
(slug `2jl-1-record`; `eb92543` the change, `c1cb58c` the review wrap-up). A config may carry a
`records` block in exactly two shapes (none, or `files` with `tracker`); `src/config.ts` validates
its fixed verb table and path rules at load; `src/records.ts#record` reads a declared record file,
or writes a batch and commits the changed declared files at the root under `git.lock` then the
repository lock, verifies the commit and journals it in `.cross-agent/runs/<run>.json`; the server
registers `record` for the operator and lead rows only when the block is configured.

Verification:
- **Plan review:** the epic's design and breakdown took three rounds (codex/gpt-6-astra/xhigh:
  6, 2, then 0 majors); Task 1's plan took three (I1 the worktree directory's spelling, I2 the
  rollback boundary, then I3 a link walk without a block), then `no major issues`.
- **Code review:** round 1 (`eb92543`) all three seats `no major issues`, five Minor rows fixed in
  the wrap-up (a thrown verification error still journals the landed commit; an unreadable record
  file is refused by name; a spawned-server registration test; a mode-preservation test; the docs'
  "exactly the batch's paths" corrected). Round 2 (`c1cb58c`) all three seats `no major issues`;
  its three Minors (two wordings, a root-user skip) went to `atc-2jl.6`.
- **Gate and root suite:** the gate ran 1156 tests at `eb92543` and 1160 at `c1cb58c`; the root
  suite at `c1cb58c` ran 1160: 1158 pass, 0 fail, 2 guarded skips. Citation check: 1744
  citations, 0 misses (seat 1's run).
- **Not verified:** the tool's `expect` type array (`["string", "null"]`) against a real Codex or
  Grok host (`atc-2jl.5`); nothing yet calls `record` from an engine lead (Task 4).

## Release 0.1.7 — `atc-s96.149` (2026-10-14)

The package and both manifests are 0.1.7. Since 0.1.6 (`1b1ff0b`) the payload carries the
separated worktree's init hint (`atc-s96.144`) and the reconnect after a first setup under Codex's
legacy mount (`atc-s96.147`); the install-guide and design changes (`atc-s96.145`) are not in the
payload. After the bump:
- `CODEX_SETUP_PROBE=$(command -v codex) node --test tests/packaging.test.ts tests/dist.test.ts
  tests/publish.test.ts tests/codex-native.test.ts` passed 34 tests, none skipped;
- `npm test` at the root ran 1126 tests: 1124 pass, 0 fail, 2 guarded skips.

The frozen source release is `0ab03cf`, pushed to `main` as a fast-forward from `1b1ff0b` on the
user's approval ("Push and release 0.1.7").

The publish opened https://github.com/WSH95/agent-plugins/pull/22 on
`publish/cross-agent-plugin/20261014131643` (commit `36c117c`). It holds 9 files: the marketplace
version, and in both payloads the plugin manifest, `package.json`, `src/cli.ts` and
`src/worktree.ts`. The target's `cross-agent/` equals the frozen dist (`diff -r`).
`claude plugin validate` passes for the marketplace and, with `--strict`, for the plugin. The PR
is `MERGEABLE`, merge state `CLEAN`. No merge was performed.

The user merged PR #22 on 2026-10-14 at 13:21:22Z, as `9354b8f`, and updated the plugin in Claude
Code; this session's server runs `…/cross-agent/0.1.7/src/server.ts`. Codex's plugin was updated
too (`codex plugin marketplace upgrade`, `codex plugin add cross-agent@agent-plugins`); its cache
equals the 0.1.7 dist payload (`diff -rq`).

**Live check of the legacy explicit-project mount** (Codex 0.162.1, the plugin's bundled mount, no
one-time setup), in a fresh scratch git repository with no config:
- `CROSS_AGENT_PROJECT=$PWD codex exec -s read-only`: the shell's `printenv CROSS_AGENT_PROJECT`
  printed the repository's path, so Codex's default shell carries the variable to the CLI; the
  `cross-agent:setup` skill was offered from the 0.1.7 cache; no `describe_mode` tool was
  available, as the mount does not start without a config.
- The skill's first write, run as the skill runs it (the installed 0.1.7 `bin/cross-agent`,
  `init --propose --json`, then `init --config - --json` with the `solo` document, under the same
  `CROSS_AGENT_PROJECT`): `{"ok":true,"wrote":true,"mode":"solo","served":null,"reconnect":true}`,
  where 0.1.6 answered `served: "solo", reconnect: false`. So the setup skill gives Codex's
  restart step instead of the one-time-setup hand-off.
- A fresh `codex exec` in the same repository under the binding (the guide's "start Codex
  again"): the mount started and `describe_mode` answered mode `solo` with that `projectRoot`.

## The setup skill's reconnect under Codex's legacy mount — `atc-s96.147` (2026-10-14)

Went through the `dev-team` loop and merged as a fast-forward from `20f2f92` to `a450ddd` (slug
`s96-147-legacy-reconnect`; `f5f44e2` and the test wrap-up `a450ddd`). Under Codex's legacy
explicit-project mount, a first `solo` setup reported `served: "solo", reconnect: false`, so the
setup skill offered the one-time setup instead of a restart. `src/cli.ts#initConfigWrite` now
reads `CROSS_AGENT_PROJECT` from the CLI's environment only when it names the root being set up
(`namesRoot`, resolved as discovery resolves it): a first write there reports
`served: null, reconnect: true`, and the unchanged skill gives Codex's reconnect step. Every
other binding, or none, keeps today's calculation. `docs/design.md` records the exception.

Verification:
- **Plan review:** round 1 (codex/gpt-6-astra/xhigh) `major issues`: the first plan passed the
  whole environment, which also changed a session bound to another project; narrowed to a
  binding that names the root. Round 2 `no major issues`, no findings.
- **Red:** `tests/cli.test.ts#initConfigReconnectBound`'s first assertion got
  `[0, "solo", false]` before the fix and `[0, null, true]` after.
- **Code review:** round 1 (`f5f44e2`) all three seats `no major issues`; three Minors (no
  symlink, relative, missing or unconfigured-elsewhere binding in the test) were added in the
  wrap-up, each shown to fail against a deliberately broken `namesRoot`. Round 2 (`a450ddd`) all
  three seats `no major issues`.
- **Gate and root suite:** each ran 1126 tests: 1124 pass, 0 fail, 2 guarded skips.
- **Due after the next release (operator checks):** a live Codex session under the legacy mount
  (setup skill offered, first write, reconnect step, `describe_mode`), and whether Codex's shell
  carries `CROSS_AGENT_PROJECT` by default; where it does not, the fix is inert and behaviour is
  as before.

## The separated worktree's init hint and the legacy Codex mount — `atc-s96.144` + `.145` (2026-10-14)

Went through the `dev-team` loop and merged as a fast-forward from `9d66272` to `5e3d713` (slug
`s96-144-init-hints`; `c357ef7` and the wrap-up `5e3d713`).
- **`atc-s96.144`:** at a worktree of a `--separate-git-dir` main
  (`repo.kind === "linked" && repo.main === null`), where plain `cross-agent init` refuses,
  `src/worktree.ts#rootWriteFault`'s config-less refusal names `cross-agent init --mode dev-team`
  and offers `--from <main checkout>`. Every other root's text is byte-identical.
  `tests/cli.test.ts#configlessHintRuns` runs the quoted command at every layout and checks that
  it exits 0 and clears the fault; it was red only at the separated layout before the change.
- **`atc-s96.145`:** `docs/install.md`'s legacy Codex mount names the setup skill first (it
  writes the config through the plugin's CLI with no MCP server), then terminal `cross-agent init`
  through the installed plugin's launcher where `cross-agent` is not on `PATH`; pinned by
  `tests/packaging.test.ts#codexLegacyMountSetup`. `docs/design.md` says what the refusal names.

Verification:
- **Plan review:** rounds 1–3 (codex/gpt-6-astra/xhigh) answered `major issues` each time: the
  plan grew into a copy of every `init` check inside the message, and each round found a rarer
  state it mishandled (majors 1 → 1 → 2, not converging). At the limit the user chose to simplify
  back to the small fix and closed `atc-s96.148` (branch states) as covered by `init`'s own
  refusals; filesystem obstructions are left to `init` too. The simplified plan's review answered
  `no major issues` with one Minor, folded.
- **Code review:** round 1 (`c357ef7`) all three seats `no major issues`; one Minor (the test
  checked the fault with a hard-coded branch) and two small doc points were fixed in the wrap-up.
  Round 2 (`5e3d713`) all three seats `no major issues`.
- **Gate and root suite:** each ran 1125 tests: 1123 pass, 0 fail, 2 guarded skips.
- **Open:** `atc-s96.147` (the setup skill's connection check under the legacy mount) is the next
  task. A live Codex check of the legacy-mount paragraph is due after the next release.
- **Cost:** 17 engine tasks, 4,681 s of engine time; the three non-converging plan rounds account
  for most of the planning time.

## Release 0.1.6 — `atc-s96.146` (2026-10-14)

The package and both manifests are 0.1.6. Since 0.1.5 (`fccfae9`) the payload changes only texts
and messages: the setup follow-ups (`atc-s96.136`, `.137`, `.138`) and `rootWriteFault`'s
setup-skill hint (`atc-s96.143`). The flaky-test fixes (`atc-s96.135`, `.139`) are test-only.
After the bump:
- `CODEX_SETUP_PROBE=$(command -v codex) node --test tests/packaging.test.ts tests/dist.test.ts
  tests/publish.test.ts tests/codex-native.test.ts` passed 33 tests, none skipped;
- `npm test` at the root ran 1123 tests: 1121 pass, 0 fail, 2 guarded skips.

The frozen source release is `1b1ff0b`. It was pushed to `main` as a fast-forward from
`fccfae9`, on the user's approval ("Fix .143, then 0.1.6").

The publish opened https://github.com/WSH95/agent-plugins/pull/21 on
`publish/cross-agent-plugin/20261014085118` (commit `1f56240`). It holds 21 files: the marketplace
version, and in both payloads the plugin manifest, `package.json`, the three mode loops,
`skills/setup/SKILL.md`, `skills/cross-agent/scripts/codex-setup.mjs` and
`src/{cli,delegate,worktree}.ts`. The target's `cross-agent/` equals the frozen dist (`diff -r`).
`claude plugin validate` passes for the marketplace and, with `--strict`, for the plugin. The PR
is `MERGEABLE`, merge state `CLEAN`. No merge was performed.

The user merged PR #21 on 2026-10-14 at 08:54:56Z, as `a7cabee`, then updated the plugin in
Claude Code and reconnected. This session's server runs `…/cross-agent/0.1.6/src/server.ts`, and
its `describe_mode` serves the 0.1.6 loop text (step 1 of the dev-team loop names the setup skill).
Codex's plugin cache still held only 0.1.5 at that point; updating it is the user's step.

## `rootWriteFault` names the setup skill first — `atc-s96.143` (2026-10-14)

Went through the `dev-team` loop and merged as a fast-forward from `375bd5e` to `c028cc3`
(slug `s96-143-worktree-hint`). The refusal for a root that is no main checkout and holds no
`.cross-agent/config.json` now reads `<workTree> is not an initialized project; set it up there
with cross-agent's setup skill, or from a terminal run "cross-agent init" in <workTree>`. It
fires in the same cases as before: a worktree whose main checkout git cannot name, and a root
whose config was removed. The setup skill sets up both. Only the string changed. Its three pins
(`tests/runcommand.test.ts`, `tests/gitroot.test.ts`, `tests/delegate.test.ts`), the sentence in
`docs/design.md` that describes it, and a stale comment in `tests/gitmutate.test.ts` changed with
it. The planner's survey of `src/`, `skills/`, `modes/` and the user guides found no other
refusal or hint that sends a plugin user to `cross-agent init`.

Verification:
- **Plan review:** codex/gpt-6-astra/xhigh, `no major issues` with no findings. The fold round
  took in the design sentence on the lead's decision.
- **Red:** the 5 tests the plan named failed on the old text before the source change.
- **Code review round 1** (`c028cc3`): all three seats `no major issues`. One cosmetic Minor (a
  short line left in `docs/design.md`) was not taken.
- **Gate and root suite:** each ran 1123 tests: 1121 pass, 0 fail, 2 guarded skips.
- **Follow-ups filed:** `atc-s96.144` (terminal `init` with no flags is refused at a separated
  main's worktree) and `atc-s96.145` (the legacy Codex mount docs name only `init`).
- **Cost:** 7 engine tasks, 1,823 s of engine time.

## The setup follow-ups' wording — `atc-s96.136` + `.137` + `.138` (2026-10-14)

All three went through the `dev-team` loop as one task and merged as a fast-forward from
`f62abe0` to `2deb7c6` (slug `s96-136-wording`, two commits: `a5191f2` and the wrap-up
`2deb7c6`). Only texts, messages and comments changed; no code path did.
- **`atc-s96.136`:** the `init --config` lock comment in `src/cli.ts#initConfigWrite` now says
  a `flock` that could not start also gets the `config.lock could not be prepared:` prefix.
  `initConfigLockFailed` asserts the exact lock path with `startsWith` on a project named
  `U V`, which the old `\S*` regex failed. A new test, `initConfigLockUnstarted`, sends `flock`
  to a missing binary and pins that prefix and `ENOENT`.
- **`atc-s96.137`:** the three mode loops name the setup skill where they named `cross-agent
  init`. The unbound-role refusal and `baseHint`'s no-config hint in `src/delegate.ts` name the
  setup skill first and keep terminal `cross-agent init --mode`; a new test covers `baseHint`.
  The setup skill says that a refused main-checkout config (`existing.mainCheckoutConfig.fault`)
  makes the proposal start fresh, and under Codex that a forwarded `CROSS_AGENT_PROJECT` naming
  another project keeps serving it. Also: `codex-setup.mjs`'s remove message says "its skills",
  the Grok install commit is `'Ignore Grok state'`, and `docs/design.md` gives the setup skill's
  chat fallback and says the setup skill, or a hand edit, adds an old config's binding. The mode
  text sizes in `docs/install.md` and `docs/design.md` are now 35,480 / 41,004 / 3,473.
- **`atc-s96.138`:** after a write, a `.gitignore` that already matches the last commit gets
  "no `.gitignore` commit is needed" in place of the claim that nothing blocks the team. A new
  variant of the real-git test stages a deletion that both of the skill's reads miss.

Verification:
- **Plan review:** codex/gpt-6-astra/xhigh. Two attempts failed with "Selected model is at
  capacity"; the third answered `no major issues`, with two Minors folded (a fixture reference,
  and a whitespace fallback that would not have worked).
- **Red:** the implementer saw 11 tests fail at their intended assertions before the change and
  pass after it. The optional `flock` test pins unchanged behaviour, so it was seen red only
  against a deliberately wrong expectation.
- **Code review round 1** (`a5191f2`): all three seats `no major issues`. Two Minors from seat
  #1 (a dangling "its" in `docs/install.md`, and lines the rewrap left overlong) were fixed in the
  wrap-up `2deb7c6`. Round 2 (`2deb7c6`): all three seats `no major issues`, nothing in scope.
- **Gate and root suite:** each ran 1123 tests: 1121 pass, 0 fail, 2 guarded skips.
- **Follow-up:** `atc-s96.143`, `src/worktree.ts#rootWriteFault`'s init hint and a comment in
  `tests/gitmutate.test.ts`, both outside this task's scope.
- **Cost:** 13 engine tasks (two of them the capacity failures), 4,355 s of engine time.

## Two flaky tests, fixed in the tests — `atc-s96.135` + `atc-s96.139` (2026-10-14)

Both went through the `dev-team` loop as one task and merged as a fast-forward from `19db256`
to `5311717` (slug `s96-135-flaky-tests`). The change is test-only and touches nothing in
`src/`.
- **`atc-s96.135`:** "a delegation racing a cascade" can read the lead `cancelled` rather than
  `cancelling`. `cancel` claims the lead under `spawn.lock` and settles it after releasing the
  lock, so both words are the truthful refusal `docs/design.md` promises. The test now accepts
  exactly those two words, matched to the end of the reason. A new test forces the order that
  flaked: the cascade completes before the delegation reads the lead.
- **`atc-s96.139`:** the runner harness parsed `descendant.json` while it was being written.
  - `jsonWhenWhole` polls through an empty or partial file, and still rethrows any error other
    than `SyntaxError`. It now serves the harness's `descendant()` and the two inline reads.
  - `audit` parses only lines that end in a newline.
  - Two new tests force a partial file.

Verification:
- **Plan review:** codex/gpt-6-astra/xhigh, `no major issues`. Two Minors were folded: the red
  run allows the known flakes, and the claim that atomic publication is untestable was
  removed.
- **Red:** each new test failed for its stated reason. The old racing test also flaked on its
  own in that run (`…is cancelled`), which reproduces the bug.
- **Code review round 1** (`5311717`): all three seats `no major issues`. One Minor was not
  taken, because it is practically unreachable: a `finally` read of `unpublished-agent.json`.
- **Gate and root suite:** each ran 1121 tests: 1119 pass, 0 fail, 2 guarded skips.
- **Cost:** 7 engine tasks, 2,175 s of engine time.

## Release 0.1.5 — `atc-s96.142` (2026-10-14)

The package and both manifests are 0.1.5. The payload's one change since 0.1.4 (`6e46507`)
is the setup skill's consent rule (`atc-s96.141`). After the bump:
- `CODEX_SETUP_PROBE=$(command -v codex) node --test tests/packaging.test.ts tests/dist.test.ts
  tests/publish.test.ts tests/codex-native.test.ts` passed 33 tests, none skipped;
- `npm test` at the root ran 1118 tests: 1116 pass, 0 fail, 2 guarded skips.

The frozen source release is `fccfae9`. It was pushed to `main` as a fast-forward from
`6e46507`.

The publish opened https://github.com/WSH95/agent-plugins/pull/20 on
`publish/cross-agent-plugin/20261014054254`. It holds 7 files:
- the marketplace version;
- in both payloads, the plugin manifest, `package.json` and `skills/setup/SKILL.md`.

The target's `cross-agent/` equals the frozen dist (`diff -r`). `claude plugin validate`
passes for the marketplace and, with `--strict`, for the plugin. No merge was performed.

The user merged PR #20 on 2026-10-14 at 05:46:28Z, as `9adee2e`, then updated the plugin and
reconnected. This session's server runs `…/cross-agent/0.1.5/src/server.ts`, and Codex's
plugin was updated to 0.1.5.

**Live re-check of `atc-s96.141`.** Each run used a fresh scratch git repository with one
commit, and asked for setup once, single-turn:
- **Grok:** `grok --trust -p "/setup"`, run twice. Both runs called `--propose`, tried
  `ask_user_question`, then asked the mode question as numbered choices in chat and stopped
  ("Nothing has been written yet").
- **Claude Code:** `claude -p "/cross-agent:setup"` asked numbered choices and stopped.
- **Codex:** `codex exec --sandbox workspace-write '$setup'` asked numbered choices and
  stopped.

In all four runs, no `.cross-agent/config.json` was written, `git status --porcelain` was
empty, and the repository still had its one commit. The defect is fixed on every host.

## The setup skill waits for the user's own answer — `atc-s96.141` (2026-10-14)

The defect came from the 0.1.4 live check:
- Under Grok single-turn headless (`grok --trust -p "/setup"`), `ask_user_question` could not
  be answered.
- The agent took the recommended mode itself and wrote the config and the `.gitignore`
  commit.
- Claude Code and Codex asked in chat and stopped.

The fix went through the `dev-team` loop and merged as a fast-forward from `b7647a8` to
`bebd8f1` (slug `s96-141-setup-consent`). It changes two files:
- **`skills/setup/SKILL.md`:** `## Asking` opens with **Wait for the user's answer**. Writes,
  `git init` and the `.gitignore` add and commit run only on the user's own explicit answer
  in this conversation. A default, the recommended option or silence is never an answer. When
  the question tool fails or the session cannot take an answer, the skill asks numbered
  choices in chat and ends its turn, having written nothing.
- **`tests/skills.test.ts`:** one test with the `CONSENT` guard and seven mutations.

Verification:
- **Plan review:** codex/gpt-6-astra/xhigh, `no major issues` in one round. Its one Minor
  (filter the in-sandbox fallback to the new test) was folded.
- **Red:** only the new test failed, listing all five gaps.
- **Code review round 1** (`bebd8f1`): all three seats `no major issues`.
  - code-reviewer#1 tried 11 more mutations beyond the planned seven, and every one bit.
  - code-reviewer#3 (Grok) judged the text would have stopped the original run.
  - Two Minors were not taken: a contrary sentence beside the rule escapes the guard, and the
    label "recommended" could be over-read. The live re-check covers the second.
  - `docs/design.md`'s note on the chat fallback went to `atc-s96.137`.
- **Gate and root suite:** each ran 1118 tests: 1116 pass, 0 fail, 2 guarded skips.
- **Cost:** 7 engine tasks, 2,156 s of engine time (`.cross-agent/log.md`).

## Release 0.1.4 — `atc-s96.140` (2026-10-13)

The package and both manifests are 0.1.4. The user authorized the release: pushing `main`,
an agent-plugins pull request, and an update to agent-plugins' `README.md` for the setup
skill.

The payload's changes since 0.1.3 (`6f9f2c4`):
- the setup skill, `skills/setup/SKILL.md` (`atc-s96.134.2`);
- `init --propose` and `init --config` in `src/cli.ts`, `src/config.ts`, `src/setup.ts` and
  `src/locks.ts` (`atc-s96.134.1`);
- the launcher and `references/codex-setup.md`, which route setup to the new skill.

After the bump:
- `CODEX_SETUP_PROBE=$(command -v codex) node --test tests/packaging.test.ts tests/dist.test.ts
  tests/publish.test.ts tests/codex-native.test.ts` passed 33 tests, none skipped;
- `npm test` at the root ran 1117 tests: 1115 pass, 0 fail, 2 guarded skips.

The frozen source release is `6e465075a28dce4c47656716616da6e6ad3744e8`. It was pushed to
`main` as a fast-forward from `3656382`.

The publisher's dry run proposed 19 files under `cross-agent/`:
- the Claude marketplace metadata's version;
- in both payloads: the plugin manifest, `package.json`, the launcher skill and
  `references/codex-setup.md`, the new `skills/setup/SKILL.md`, and `src/cli.ts`,
  `src/config.ts`, `src/locks.ts` and the new `src/setup.ts`.

The publish opened https://github.com/WSH95/agent-plugins/pull/19 on
`publish/cross-agent-plugin/20261014025055`, payload commit `869cd72`. A second commit,
`f376e9f`, updates the marketplace `README.md`'s cross-agent section for the setup skill, as
the user asked:
- setup from the session on every host;
- `/cross-agent:setup`, Codex's `$`, Grok's `/setup`;
- no `init --mode` advice;
- a setup example.

Checks on the published branch:
- the PR holds 20 files, no attribution trailer, and is open, mergeable and clean;
- the target's `cross-agent/` equals the frozen dist (`diff -r`), and all three versions
  read 0.1.4;
- `claude plugin validate` passes for the marketplace and, with `--strict`, for the plugin.

No merge was performed. The target checkout is kept at
`/tmp/agent-artifact-pr-u5pyifhh/target`.

The user merged PR #19 on 2026-10-14 at 02:57:41Z, as `1091b8a`. They updated the Claude
Code plugin and reconnected, and this session's server now runs
`~/.claude/plugins/cache/agent-plugins/cross-agent/0.1.4/src/server.ts`.

**Live checks of the setup skill** (spec section 3), each in a fresh scratch git repository:

- **Claude Code.** Discovery holds: the session lists `cross-agent:setup`. One end-to-end
  run went through six headless `claude -p` turns, the first with `/cross-agent:setup` and
  each later one with `--resume`; together they cost about $1.95. The run covered:
  - the two-sentence opener, then `--propose` through
    `…/0.1.4/skills/setup/../../bin/cross-agent`, which detected all three engines, `npm
    test`, `npm ci` and `main`;
  - with no question tool in this mode, numbered choices in chat, and the turn ended;
  - the proposal table;
  - "use Claude for the plan reviewer", applied and shown before → after;
  - *Looks right*, then the write, the `/tmp` warning, and the whole-file preview for an
    untracked `.gitignore`;
  - *Yes*, then `git add` and the exact commit, leaving the tree clean;
  - the `/mcp` reconnect step;
  - after a fresh start, `describe_mode` and `list_roles` showing `dev-team` with no
    `warning`, and the closing example request.
- **Grok** 1.0.52, run with `--trust` in a scratch project with no `.grok` config.
  - Discovery holds: Grok lists the `setup` skill, and `grok -p "/setup"` invoked it,
    through the plugin Claude Code installed.
  - **Defect:** after `ask_user_question` could not be answered in single-turn mode, the
    agent picked the recommended mode itself. It wrote the config and committed
    `.gitignore` with no answer from the user. This is bug `atc-s96.141`, priority 1, for
    0.1.5.
- **Codex** 0.162.1. The user approved installing the plugin, so `codex plugin add
  cross-agent@agent-plugins` installed 0.1.4 with both skills. The run used `codex exec
  --sandbox workspace-write` with `$setup`, then `exec resume`:
  - discovery, and `--propose` (`pytest`, no setup command), worked inside the sandbox;
  - numbered choices, and the turn ended;
  - *Looks right*: `--config` refused with `config-lock-failed` (EROFS on
    `.git/info/exclude`). The skill retried that one command outside the sandbox, and the
    write succeeded;
  - *Yes*: the index is read-only too. `git add` and the commit ran outside the sandbox,
    and the tree ended clean;
  - Codex had no cross-agent MCP tools, so the skill said the connection is not yet
    verified and offered the connection hand-off. The probe stopped there, because the
    hand-off would change the user's Codex MCP configuration.

## The setup skill — `atc-s96.134.2` (2026-10-13)

The second of the setup skill's two tasks. It ran through all ten steps of the `dev-team`
loop and merged as a fast-forward from `43ac55d` to `62f5aad` (slug `s96-134-setup-skill`).
Decision 0021 covers it, along with the user-approved `AGENTS.md` edits.

- **What changed** (11 files):
  - `skills/setup/SKILL.md`, new, `name: setup`, `user-invocable: true`. It covers first
    setup, later changes, a refused config, after-a-write, failures, refusals and the
    connection check. It drives `init --propose --json` and `init --config - --json`
    through the plugin's own `bin/cross-agent`, and asks with each host's question tool.
  - The launcher and `references/codex-setup.md` route setup and team changes to it.
  - The README, the install guide, the design, the operator guide's `init` row and
    `AGENTS.md` (two approved edits) changed to match.
  - 16 new tests in `tests/skills.test.ts`; packaging and dist pins now cover both payloads.
- **Plan review** (codex/gpt-6-astra/xhigh):
  - Round 1 ended `major issues`: eight Important findings, all folded. One was rejected
    with evidence: the Claude implementer's sandbox runs the suite.
  - Round 2 ended `no major issues`. Its two Minors were folded into the approved plan
    (r3, SHA-256 `b173d369…`).
  - The planner corrected two lines of the spec, both checked by the operator. The skill
    runs the launcher directly, because `node` cannot run a `sh` script. It stages
    `.gitignore` before the exact commit, because `git commit -- <path>` refuses an
    untracked file.
- **Code review**, three seats: claude/claude-opus-5-5, codex/gpt-6.1-sol and
  grok/grok-4.7, all at xhigh.
  - **Round 1** (`3aee45a`): code-reviewer#2 found two Important issues. The `.gitignore`
    commit could carry edits the user was not shown, and the refused-config replacement
    skipped the unavailable-proposal stop. There were nine Minors. All were fixed in
    `39d6e74`, with two new tests.
  - **Round 2:** all seats `no major issues`. Four Minors were fixed in the wrap-up
    `62f5aad`:
    - the empty-diff case for a tracked, unchanged `.gitignore`;
    - after setup's own `git init`, the project's files need a first commit before a team
      task (the operator reproduced it: `?? app.py`);
    - two single-skill phrases;
    - what *Not now* does.
  - **Round 3:** all seats `no major issues`. One Minor is follow-up `atc-s96.138`.
- **Gate:** the gate on `3aee45a` ran 1115 tests (1113 pass); on `39d6e74` and `62f5aad`
  it ran 1117 (1115 pass, 0 fail, 2 guarded skips).
- **Root suite after the merge:**
  - The first run failed one test, `tests/runner.test.ts:911`. Its harness parsed a
    half-written descendant file. That is a test-only race, filed as `atc-s96.139`; the
    merge touched no `src/`, runner test or helper.
  - The second run on the same tree passed: 1117 tests, 1115 pass, 0 fail, 2 skipped,
    with `tests-passed` journaled.
  - Citations: 1692, 0 misses.
- **Operator checks:** these ran in scratch repositories, using the skill's exact CLI path
  from the task worktree.
  - `--propose` detected Node (`npm test`, `npm ci`), Python (`pytest`, `uv sync`) and none
    (`none`).
  - `--config` wrote a dev-team config with `reconnect: true`, and the `/tmp` warning.
  - `git add -- .gitignore`, then the exact commit, left status clean, including in a
    repository with no commit.
  - After `git init`, a solo write answered `reconnect: false`, which the skill now
    overrides.
- **Not yet verified:** the live per-host checks wait for release 0.1.4: discovery of
  `/cross-agent:setup`, Grok `/setup` and Codex `$`, each host's approval for a `.git`
  write, and an end-to-end setup in Claude Code.
- **Cost:** 17 engine tasks, 9,074 s of engine time (`.cross-agent/log.md`).

## The setup skill's CLI: `init --propose` and `init --config` — `atc-s96.134.1` (2026-10-13)

The first of the setup skill's two tasks, built under the approved spec
(`docs/superpowers/specs/2026-10-13-setup-skill-design.md`, section 2). It ran through all
ten steps of the `dev-team` loop and merged as a fast-forward from `8059c33` to `e3ff61c`
(slug `s96-134-setup-cli`). The `AGENTS.md` change is the one Layout line for
`src/setup.ts` that the user approved.

- **What changed:**
  - `init --propose --json` writes nothing. It returns:
    - the engines found;
    - the detected default branch, test command, setup command and merge policy;
    - the existing config with its SHA-256 and `.gitignore` state;
    - one proposal per built-in mode, with the substitutions the team rule made.
  - `init --config - --json [--replace --expect <sha256>]` validates the document as the
    server would. It creates the config, or replaces it under `config.lock` and keeps
    `.cross-agent/config.json.prev`. It answers `served` and `reconnect` from the server's
    own discovery.
  - Refusals exit 3 with a `code`: `not-a-git-repository`, `not-the-repository-root`,
    `unsupported`, `task-worktree`, `no-such-directory`, `detached-head`, `branch-name`,
    `inside-a-task`, `invalid-config`, `config-exists`, `config-changed`, `config-busy` and
    `config-lock-failed`.
  - `src/locks.ts#acquire` runs `flock -E 99`, so only a wait that ran out is
    `LockHeldError`.
- **Plan review:** codex/gpt-6-astra/xhigh.
  - Rounds 1–3 ended `major issues`, each folded. Round 1 was about concurrency and branch
    worktrees.
  - The user's decisions at those stops are in the spec (`242d2fa`, `8059c33`): a Grok-only
    team, the offer of `git init`, the lock and `.prev`.
  - At the limit the user chose one more round, and round 4 ended `no major issues`
    (plan r4, SHA-256 `162742b0…e315`).
- **Code review:** three seats: claude/claude-opus-5-5, codex/gpt-6.1-sol and grok/grok-4.7,
  all at xhigh.
  - **Round 1** (`0bfc8aa`): Important. `served` and `reconnect` read the config rather
    than discovery, and a subdirectory was accepted as a root. Fixed in `7b01a8d`.
  - **Round 2:** Important. A configured ancestor was not what a server there would serve.
    Fixed in `da58ece`.
  - **Round 3:** Important R3-I1. The writer went ahead after its lock was lost during
    discovery. After two fix rounds the resolver (codex/gpt-6-astra/max) took the table and
    fixed it with four Minors in `9f262fb`.
  - **Round 4:** all seats `no major issues`. One Minor was fixed in the wrap-up `e3ff61c`:
    a `config-lock-failed` reason names `config.lock`.
  - **Round 5** (`e3ff61c`): all seats `no major issues`. Its two Minors are follow-up
    `atc-s96.136`.
  - Out of scope for task 2:
    - the operator guide's `init` row;
    - proposals when the default branch fails its gate;
    - the per-host live check;
    - the codes the skill must recognise.
- **Gate and root suite:** the gate on `9f262fb` and on `e3ff61c`, and the root suite after
  the merge (`tests-passed`), each ran 1101 tests: 1099 pass, 0 fail, 2 guarded skips.
  Citations: 1691, 0 misses.
- **Cost:** 29 engine tasks, 15,186 s of engine time in all (`.cross-agent/log.md`).

## Release 0.1.3 — `atc-s96.133` (2026-10-13)

The package and both manifests are 0.1.3. The user authorized pushing `main` and an
agent-plugins pull request. The payload's changes since 0.1.2 (`0ebbac2`):
- `src/cli.ts`: a closed stdout ends the CLI quietly (`atc-s96.80`);
- `src/config.ts`: `init --mode dev-team` binds the user's team (`atc-s96.119`), and the
  `dev-team-engine` lead defaults to claude/claude-opus-5-5/xhigh (`atc-s96.128`);
- both loops' resolver example (`modes/*/SKILL.md`).

The repository's own dev team developed all three. The other commits since 0.1.2 change
tests, docs and `AGENTS.md`, none of which the payload carries.
`CODEX_SETUP_PROBE=/home/wsh/.local/bin/codex node --test tests/packaging.test.ts
tests/dist.test.ts tests/publish.test.ts tests/codex-native.test.ts` passed 33 tests, none
skipped. After the bump, `npm test` at the root ran 1061 tests: 1059 pass, 0 fail, 2
guarded skips.

The frozen source release is `6f9f2c4ecd093cc69304b1dc05f53514a1256b8e`, pushed to `main`
as a fast-forward from `c4140c1`. The publisher's dry run proposed 13 files under
`cross-agent/`:
- the Claude marketplace metadata's version;
- in both payloads, the plugin manifest, `package.json`, `src/cli.ts`, `src/config.ts`
  and the two loops' `SKILL.md`.

The publish opened https://github.com/WSH95/agent-plugins/pull/18 on
`publish/cross-agent-plugin/20261013122052`, head
`1d4c9749890e298fc3f892f9937204f399133653`. It is open and mergeable, with those 13 files
and no attribution trailer. The target's `cross-agent/` equals the frozen dist
(`diff -r`). `claude plugin validate` passes for the marketplace and, with `--strict`, for
the plugin. No merge or Dolt remote sync was performed. The target checkout is kept at
`/tmp/agent-artifact-pr-zpwhkib_/target`.

The user merged PR #18 on 2026-10-13 at 12:38:32Z, as merge commit
`f5ca5423f074746f39b199219b7e15fcc270d5f3`. Afterwards:
- on agent-plugins `main`, both payloads' versions read 0.1.3;
- the user updated the plugin and reconnected the server, and the session's server now
  runs `~/.claude/plugins/cache/agent-plugins/cross-agent/0.1.3/src/server.ts`;
- its `list_roles` answers with the user's team, unchanged.

## A direct `node --test` inside Codex's sandbox — `atc-s96.130`, `.131`, `.132` (2026-10-13)

The three beads ran as one task through all ten steps of the `dev-team` loop and merged as
`5b9919b`, in two commits: `b83b1b5` and the wrap-up `5b9919b` (slug
`s96-131-codex-test-guard`). The `AGENTS.md` change is user-approved (Decision 0020).

- **Before the change,** measured under `codex sandbox -c 'sandbox_mode="workspace-write"'`
  on `c640e50`:
  - A direct `node --test tests/cli.test.ts` failed after 49 s with a bare
    `'test failed'`.
  - `tests/server.test.ts` was still running when a 130 s timeout killed it.
  - In a test child, `process.stdout` was a plain `Writable`, not a `net.Socket`, while
    fd 1 was a socket. A raw `fs.writeSync(2, …)` still reached the terminal.
- **What changed:**
  - Every `tests/**/*.test.ts` (39 files) opens with `tests/child-check.mjs`. It stops a
    `node --test` child at once, with the cause and what still runs, when all three
    hold: `NODE_TEST_CONTEXT` is set, fd 1 is a socket, and `process.stdout` is not a
    `net.Socket`.
  - The check shares its text with the preflight through `tests/lost-output.mjs`, and
    the preflight's stderr is byte-identical (783 and 781 bytes).
  - The EPERM fixture returns Node's real no-child result, so the preflight's `?.` is
    now pinned (`.130`).
  - `AGENTS.md` tells a delegated session how to run tests here and names the new files
    in Layout (`.131`, `.132`).
- **Tests.** `tests/child-check.test.ts` adds five tests:
  - T1, a broken child, stops, and its message's first line is asserted whole;
  - T2, a working child, runs;
  - T3, an in-process run, runs, which pins the `NODE_TEST_CONTEXT` condition;
  - T4 checks that every file `npm test` runs has the import, expanding `npm test`'s own
    pattern with Node's `node_modules` exclusion;
  - T5, a child whose fd 1 is a file, runs, which pins the socket condition.

  The implementer showed a red for each pin by mutation. None was committed.
- **Plan review:** codex/gpt-6-astra/xhigh, `no major issues`. Its three Minor findings
  were folded once: T5 was added, two issue descriptions were corrected, and the diff
  hand-off was added.
- **Review round 1** (`b83b1b5`): all three seats `no major issues`. The four Minor
  rows were fixed in the wrap-up:
  - the design clause now names the import;
  - "could not open" became "whose type Node could not identify";
  - AGENTS.md says "fail or time out";
  - T4 uses `fs.globSync` with the runner's options instead of a directory walk.

  Two out-of-scope rows were the operator's records: a stale line citation in this file,
  now cited by test name, and Decision 0020.
- **Review round 2** (`5b9919b`): all three seats marked every row ADDRESSED, with no
  findings in scope. code-reviewer#2 also ran the check first-hand in its Codex sandbox:
  `tests/guard.test.ts` stopped in 0.15–0.19 s.
- **Gate and root suite:** the gate on `b83b1b5` and on `5b9919b`, and the root suite
  after the merge (`tests-passed`), each ran 1061 tests: 1059 pass, 0 fail, 2 guarded
  skips. Citations: 1649, 0 misses.
- **Codex check** on an export of `5b9919b`, under the same sandbox:
  - `tests/server.test.ts` exits 1 in 0.98 s and `tests/cli.test.ts` in 0.84 s. Each
    first line names its file, the cause, and the forms that still run.
  - `npm test` stops once, at the preflight.
  - `--test-isolation=none tests/guard.test.ts` passes 13/13.
  - A direct run of all 39 files stops each one, in 5.7 s in total.
- **Cost:** 11 engine tasks, 4,594 s of engine time in all (`.cross-agent/log.md`).

## The suite inside a specialist's sandbox — `atc-s96.124` + `atc-s96.129` (2026-10-13)

The two beads ran as one task through all ten steps of the `dev-team` loop and merged as
`6b3913d` (slug `s96-124-sandbox-suite`, two commits: `f9d5ea5` and the wrap-up `6b3913d`).
- **The Codex cause.** Codex's workspace-write sandbox applies a network seccomp filter
  that denies `getsockopt`. Node calls it to identify a piped stdout, so a Node child
  discards everything it writes, and `spawnSync` reports `EPERM`. `node --test` reads each
  file's results over such a pipe, so the suite failed (253 fail, 48 cancelled) and
  stalled. The user chose to detect it and stop, not to enable `network_access`.
- **What changed.** `npm test` now runs `tests/preflight.mjs` before `node --test`. Where
  piped output is lost it stops with exit 1 and three lines: the cause, and what still runs
  (`node --test --test-isolation=none` on one file). The Claude-sandbox-only failures now
  skip with a reason: the `/tmp` config test, the `.mcp.json` placeholder, and the
  unpublished-identity probe, which now skips only where ssh-agent never ran its command.
  The runner harness writes its generated modules under its own temporary root, and
  `.gitignore` ignores `/tests/cross-agent-config-*/`, so an interrupted suite leaves
  nothing in `tests/` for a task commit to stage (`atc-s96.129`).
- **Plan review:** two rounds by codex/gpt-6-astra/xhigh, the second `no major issues`,
  folded once.
- **Implementer's own runs,** inside its Claude sandbox at `6b3913d`: 1056 tests, 1044
  pass, 0 fail, 12 skipped. Before the change the same sandbox gave 3 failures.
- **Review round 1** (`f9d5ea5`): all three seats `no major issues`. Two Minor rows were
  fixed in the wrap-up:
  - M1: the unpublished-identity skip had also covered the probe's own timeout.
  - M3: no test reached the preflight's spawn-error branch; it now has one, through a
    second preload (`tests/fixtures/spawn-eperm.mjs`).

  M2 (split the `/tmp` test) was not taken.
- **Review round 2** (`6b3913d`): all three seats `no major issues`. A Minor row, N1, is a
  follow-up (`atc-s96.130`), because the loop allows one wrap-up. The fixture returns
  `stdout: ""`, while Node 24.11.0 returns `stdout: undefined` and `output: null` on a
  failed spawn, so no test checks the `?.` in `probe.stdout?.includes`. Out-of-scope
  follow-ups: `atc-s96.131` (a direct `node --test` under Codex skips the preflight) and
  `.132` (AGENTS.md Layout lines).
- **Gate** on a detached checkout of `6b3913d`, and the root suite after the merge
  (`tests-passed`): each 1056 tests, 1054 pass, 0 fail, 2 guarded skips, with the
  preflight silent.
- **Codex check,** `codex sandbox -c 'sandbox_mode="workspace-write"' -- npm test` on an
  export of the merged `6b3913d`: exit 1 in 0.27 s, the first line ending `(stdout empty,
  error EPERM).` The same check on `f9d5ea5` took 0.46 s.
- **Cost:** 13 engine tasks, 4,636 s of engine time in all (`.cross-agent/log.md`).

## The engine lead's default, as a one-shot — `atc-s96.128` (2026-10-13)

The user moved the `dev-team-engine` lead's default to claude/claude-opus-5-5/xhigh. It
ran as a `consult` one-shot (codex/gpt-6-astra, `worktree: true`) and merged as `8f27449`.
The commit is three lines: `src/config.ts`'s lead binding and the two tests that pin it.
- **The consult's own suite stalled under Codex's sandbox.** Captured child stdout was
  empty and `spawnSync` returned `EPERM`. Two interrupted runs took 1060 s in all, and the
  consult said so rather than claiming a pass (`atc-s96.124`).
- **The interrupted runs left four `tests/fixtures/runner-*.mjs` files.** The commit step's
  `git add -A` staged them; the operator unstaged and deleted them before committing
  (`atc-s96.129`).
- **Results:** the test step on `8f27449` and the root suite after the merge each ran
  1049 tests: 1047 pass, 0 fail, 2 guarded skips.

## The second dev-team task: `init`'s default bindings — `atc-s96.119` (2026-10-13)

Bead `atc-s96.119` went through all ten steps of the `dev-team` loop and merged as
`7f5969b` (slug `s96-119-init-defaults`).
- What changed: `init --mode dev-team`, and `dev-team-engine` for the roles it shares, now
  writes the user's bindings (`src/config.ts#devTeamBindings`). The `lead` and `consult`
  bindings are unchanged.
- Docs updated: section 6 of `docs/design.md`, both loops' resolver example, and the
  `describe_mode` sizes (35,473 / 40,996 / 3,463).
- Plan review: `no major issues`, with two Minor findings folded.
- Implementer's red runs: the three binding tests and `#describeModeSizes` failed on the
  old values, then passed. Its own suite inside its Claude sandbox gave 1036 pass, 3 fail
  and 10 skips. All the failures and seven of the skips are sandbox-only (`atc-s96.124`).
- Gate, on a detached checkout of `7f5969b`: 1049 tests, 1047 pass, 0 fail, 2 guarded skips.
- Review round 1: all three seats `no major issues`. Two out-of-scope Minor follow-ups
  were filed (`atc-s96.126`, `.127`).
- Root suite after the merge: 1049, 1047 pass, 0 fail, 2 guarded skips (`tests-passed`).

The pilot (`atc-s96.118`) is closed. In both tasks the specialists kept to `AGENTS.md`'s
specialist section: they ran no `bd`, wrote nothing under `.project-steward/`, and changed
only the planned files.

## The first dev-team task on this repository — `atc-s96.80` (2026-10-13)

The pilot (`atc-s96.118`) ran under the installed 0.1.2 build with the user's bindings.
Bead `atc-s96.80` (`cross-agent report | head` died on EPIPE) went through all ten steps of
the `dev-team` loop and merged as `50fe5ba` (slug `s96-80-epipe`).
- Plan review: one round, `no major issues`, one Minor finding folded. The test moved from
  a Node-spawned socket to a real shell pipe into `head -n 1`.
- Implementer's red run, before the fix: both legs exited 1 with `Error: write EPIPE`.
  After the fix, `tests/cli.test.ts#cliClosedStdout` passes.
- Gate, on a detached checkout of `50fe5ba`: 1049 tests, 1047 pass, 0 fail, 2 guarded skips.
- Review round 1: all three seats `no major issues` (claude-opus-5-5, gpt-6.1-sol,
  grok-4.7). Two out-of-scope Minor follow-ups were filed (`atc-s96.120`, `.121`).
- Root suite after the merge: 1049, 1047 pass, 0 fail, 2 guarded skips (`tests-passed`).

The implementer's own `npm test` inside its Claude sandbox gave 3 failures that the gate's
operator run did not reproduce (`atc-s96.124`). Per-task lines are in
`.cross-agent/log.md`.

## The suite below a task — `atc-s96.115` (2026-10-13)

A suite started below a cross-agent task, as an implementer's own `npm test` is, now runs
clean. The simulation runs the suite under a parent carrying the task marker, then removes
the marker from the suite's own environment: `CROSS_AGENT_TASK=simulated-implementer sh -c
'env -u CROSS_AGENT_TASK npm test'`. Before the fix it ran 1048 tests: 1045 pass, 1 fail,
2 skipped. The failure was `tests/codex-setup.test.ts#codexSetupMcp`, whose real server
resolved as a specialist's and hid `delegate`. The same test alone: 1 fail under the
simulation, 1 pass without it. After the fix the test alone is skipped under the
simulation, naming the ancestor that carries the marker, and passes without it.

Full suite after the fix, clean: 1048 tests, 1046 pass, 0 fail, 2 guarded skips (real
Codex I2 and the opt-in native setup probe), 176 s. Under the simulation: 1048 tests,
1045 pass, 0 fail, 3 skipped (the two guarded skips and the launcher test), 182 s. The
plan was reviewed by `gpt-6-astra` at `xhigh` effort with the dev-team plan-reviewer
prompt (no major issues; four Minor findings folded). The real Claude and Codex sandboxes
around the suite are not covered here; that is the pilot, `atc-s96.118`.

## Release 0.1.2 — `atc-s96.114` (2026-10-12)

The package and both manifests are 0.1.2, with Claude specialists' web tools from
`209b512` (`atc-s96.112`, Decision 0018). `CODEX_SETUP_PROBE=/home/wsh/.local/bin/codex
node --test tests/packaging.test.ts tests/dist.test.ts tests/publish.test.ts
tests/codex-native.test.ts` passed 33 tests, none skipped. After the bump, `npm test`
ran 1048 tests: 1046 pass, 0 fail, 2 guarded skips (real Codex I2 and the opt-in
native setup probe). Citations: 1648, 0 misses, 0 drifted since `640763f`. The
implementation's two real Claude probes are `docs/probes.md#claudeWebTools`.
PR #16 (0.1.1) was merged on 2026-10-04, so this release opened a new agent-plugins
pull request.

The frozen source release is `0ebbac245227be4621bae51d9537edb73ce08463`, pushed to
`main` as a fast-forward from `640763f`. The publisher's dry run proposed seven files under
`cross-agent/`: the version in both payloads' manifests and `package.json`, the Claude
marketplace metadata, and `src/engines/claude.ts` in both payloads; the root marketplace
entries pin no version and were left alone. The publish opened
https://github.com/WSH95/agent-plugins/pull/17 on `publish/cross-agent-0.1.2`, head
`ab7bedb4b9fd26590ddb8705d3e25d63164ceb3f`: open and mergeable, those seven files, no
attribution trailer. The target's `cross-agent/` equals the frozen dist (`diff -r`), and
`claude plugin validate` passes for the marketplace and, `--strict`, for the plugin. No
merge, force-push or Dolt remote sync was performed. The target checkout is kept at
`/tmp/agent-artifact-pr-5tcm77bx/target`.

The user merged PR #17 on 2026-10-12 at 22:46:42Z (merge commit
`e2b0cba07c6af7d488e065ee719824cc12860df5`). On agent-plugins `main` afterwards, both
payloads' plugin manifests and the Claude marketplace metadata read 0.1.2, and the Claude
payload's `src/engines/claude.ts` lists `WebSearch` and `WebFetch` in both tool lists.

## Release 0.1.1 — `atc-s96.111` (2026-10-04)

The package and both manifests are 0.1.1, with the implementation from e3b4f85.
`CODEX_SETUP_PROBE=/home/wsh/.local/bin/codex node --test tests/packaging.test.ts
tests/dist.test.ts tests/publish.test.ts tests/codex-native.test.ts` passed 33 tests,
none skipped. This includes both generated payloads, publisher preview behavior,
and real Codex 0.160.0 setup, policy preservation, removal and four per-chat roots.
The preceding implementation's full suite passed 1045 with two guarded skips;
publication changes only version metadata and project records in the source tree.

The frozen source release is `4738b3d592849bbd25a25d153a6033811b2448a9`, pushed to
`main`. Existing agent-plugins PR #16 was updated on its original branch to
`37e4ee63ea66d8bb373e873268635870101d2730`; its head, title and full body were verified
through GitHub. It remains open and mergeable, with no status checks configured.
No new PR, force-push, merge or Dolt remote sync was performed.

The publisher's dry run passed against the existing PR branch. Its guarded copy
helpers then replaced only `cross-agent/`, after verifying the target checkout was
clean. All payload bytes and modes match the frozen dist; the marketplace README
was updated separately. Claude marketplace and strict plugin validation pass.
A fresh isolated Codex home installed enabled version 0.1.1 from the exact target
checkout; its cached payload also matches byte for byte and mode for mode. The
cached helper's install/check/remove pass, `codex mcp get` shows no fixed cwd and a
3600-second timeout, and the stable launcher in a fresh project without config
answers MCP `initialize` with version 0.1.1. Real user configuration was untouched.
Evidence: `/tmp/cross-agent-release-0.1.1-KbXLn0/` and
`/tmp/cross-agent-release-0.1.1-checks.log`. The target checkout is clean.

## Codex one-time MCP setup — `atc-s96.73` (2026-10-04)

| Check | Result |
| --- | --- |
| Baseline `npm test` at d2064f5 | 1037 tests, 1036 pass, 0 fail, 1 guarded skip |
| Final `npm test` | 1047 tests, 1045 pass, 0 fail, 2 guarded skips; no core runtime changes |
| Earlier full run | One existing `tests/server.test.ts` reconciliation deadline expired after 8 seconds; unchanged file passed 46/46 alone, unchanged full rerun passed |
| Focused setup and skill checks | 66/66 pass; install/reinstall/check/remove, update selection, disable/uninstall, policy repair, custom conflicts, concurrent config edits, task markers, real-server fixture delegation/wait/result |
| Native Codex | `CODEX_SETUP_PROBE=/home/wsh/.local/bin/codex node --test tests/codex-native.test.ts`: pass on 0.160.0, Node 24.11.0, Linux; isolated local marketplace and home, no model turns |
| Per-chat discovery | One app-server, four ephemeral chats: no-config solo, team, uninitialized worktree served by team, initialized sibling served independently; `describe_mode` and `list_roles` pass |
| Native config | Repeated setup, repair preserving a disabled-tool rule, and removal; unrelated TOML and its comment restored exactly |
| Packaging | Full suite includes both generated payloads containing the helpers and reference; Claude and Grok attach contracts remain unchanged |
| Citations and skill format | 1643 citations, 0 misses, 0 drifted since d2064f5; skill-creator's `quick_validate.py` passes |
| Review | One fresh-context gpt-6-astra reviewer: no actionable findings; explicit setup, ordinary solo, and missing-tools/no-setup instruction scenarios all route correctly |

Native evidence covers the desktop backend, not clicking its restart control. The
native setup test is opt-in in ordinary suite runs; it was run separately above.
Linux/Node requirements remain. User Codex configuration and installed plugins were
not changed, and no publication or push was performed. Decision 0017 records the
integration and removal semantics; `docs/probes.md#codexOneTimeSetup` records the probe.

## M1 — core runtime plus the delegation tools (merged 2026-09-19)

| what | value |
|---|---|
| `main` after the merge | `bd37e0e` (fast-forward of `task/cross-agent-m3`, 33 commits over `cf49bd8`) |
| `npm test` at the root | 468 tests: 467 pass, 0 fail, 1 skipped (`tests/engines/codex.test.ts`, the I2 placeholder that needs a real `codex` binary) |
| citation checker | 609 citations in 2 files (304 by line, 305 by symbol), 0 misses |
| load acceptance (Task 3c) | ten consecutive `npm test` runs on the branch under 8-core load, all 467/0/1, 1029 s wall |

Landed: cite-by-symbol citations and the lexer-aware checker (`atc-s96.36`);
authority by process ancestry, project discovery and tools by
permission-matrix row (T10a); `delegate`, `check`, `result`, `cancel` with
its cascade, `list_tasks`, the outcome sidecar, `sandboxSupport(env)`, the
per-task scratch directory, prefix reservations, resume chains (T10b and
its folds); `wait` with stall detection and `notifications/cancelled`
(T11); the M1-close beads (`atc-s96.44`, `.40`, `atc-1p0`, `.31`, `.32`,
`.30`, `.38`, `.41`, `.46`) and the test-hygiene pass (`.33`, `.43`).

Probes rerun this milestone: P1 on 2026-09-18 — with the docs' AppArmor
profile installed and Ubuntu's stock `bwrap-userns-restrict` disabled, a
sandboxed `curl` from a `claude -p` child returned 200 on the first call;
before the fix the child escaped a failed sandboxed command with
`dangerouslyDisableSandbox: true`, which the adapter now forbids
(`sandbox.allowUnsandboxedCommands: false`). Details in `docs/probes.md`.

Not run yet: probe P2 for Claude (`atc-s96.17`, runnable now), the
integration probes I1 and I2, every end-to-end run (E1–E7). Grok's
`--prompt-file` fallback ran at 6b, alone and with `--rules` beside it, on grok 1.0.44
(`docs/probes.md#grokRulesBesidePromptFile`).

## M3 — modes, root git tools, solo, the launcher and the loops (merged 2026-09-19)

| what | value |
|---|---|
| `main` after the merge | `3023e30` (fast-forward of `task/cross-agent-m3`, 20 commits over `ff1cf55`) |
| `npm test` at the root | 586 tests: 585 pass, 0 fail, 1 skipped (the Codex I2 placeholder) |
| citation checker | 795 citations in 2 files (334 by line, 461 by symbol), 0 misses |

Landed: modes and the worktree provider with `describe_mode` and `init
--mode` (S8, `atc-s96.23`); `git_root`, `run_command` and the journal's
named steps (Task 4b, part of `.24`); the built-in `consult` role, the
no-config `solo` default and `worktree: true` one-shots (`.27`); the
launcher skill, the `dev-team` loop, the role prompts through the one-off
converter, and `delegate` launching a role with the mode's own prompt
(T12, `.12`).

Probes rerun this milestone: none.

Not run yet: probe P2 for Claude (`atc-s96.17`, at T13), I1, I2, E1–E7.
T13 recorded its Codex rows as not run; 6b ran I1's Codex rows, and T14 runs
the rest.

## M3, second merge — T13: Claude Code packaging, the integration probes and the first end-to-end run (merged 2026-09-19)

| what | value |
|---|---|
| `main` after the merge | `e9cbac0` (fast-forward of `task/cross-agent-m3`: 19 T13 commits over `3023e30`, rebased onto `main` at `5846754`) |
| `npm test` on the branch | 617 tests: 616 pass, 0 fail, 1 skipped (the Codex I2 test, written and guarded behind `CROSS_AGENT_REAL_CODEX=1`) |
| `npm test` at the root after the merge | 617 tests: 616 pass, 0 fail, 1 skipped (the one skipped test is the Codex I2 test, written and guarded behind `CROSS_AGENT_REAL_CODEX=1`) |
| citation checker | 823 citations in 2 files (74 by line, 749 by symbol or anchor), 0 misses; `node tools/check-citations.mjs --since 3023e30` and `--since 39505aa` (merged as `2de4f84`) both report 0 drifted, 0 not judged |
| host | `claude -p --plugin-dir <repo> --model claude-sonnet-5 --effort medium --permission-mode bypassPermissions --output-format stream-json --verbose`, claude 2.1.277 |
| packaging | `.claude-plugin/plugin.json` alone: name, `package.json`'s version, and this server inline under `mcpServers`. No `.mcp.json` at the repository root — that file is Claude Code's project-scoped config, where `${CLAUDE_PLUGIN_ROOT}` has no value |
| sample repository | `~/.cache/agent-team/cross-agent-e2e/slugkit` (clone of `~/Documents/atw-sample-slugkit`, Python; `python3 -m unittest discover -s tests -t .`) |
| engines | claude 2.1.277, grok 1.0.34. codex-cli 0.155.0 present and **not run** at T13 |
| raw evidence | `~/.cache/agent-team/probe-logs/t13-2026-09-19/` (36 files: the P2 logs, the I1/I2/E1 host logs, the `grok mcp doctor` captures), named in `docs/probes.md` |
| how an end-to-end run is judged | `node tools/e2e-verify.mjs --project <sample>` — the eight conditions below, each `pass`, `FAIL` or `?` |

### E1 — one `dev-team` task, `placement: host`

Task T10 "slug_words": add `slug_words(text, **options) -> list[str]` beside
`slugify`, with tests. Host session 458.8 s, 33 turns, $0.73, **six `wait` calls**
(one per delegation), **no refusal of any call**.

| task | role | engine | model | effort | duration | outcome |
|---|---|---|---|---|---|---|
| `e96f5a87…` | planner | claude | claude-sonnet-5 | medium | 36 s | plan, no premise failure |
| `5d242cf4…` | plan-reviewer | grok | grok-4.6 | medium | 92 s | approve |
| `7fd15e08…` | implementer | claude | claude-sonnet-5 | medium | 27 s | 64 → 68 tests green |
| `388bcd2d…` | code-reviewer (round 1, commit `3878466`) | grok | grok-4.6 | medium | 83 s | ready, two non-blocking findings |
| `f5477ad3…` | implementer (`resume` of `7fd15e08…`) | claude | claude-sonnet-5 | medium | 14 s | 68 → 69 tests green |
| `f3ae4c8d…` | code-reviewer (round 2, commit `90473bf`) | grok | grok-4.6 | medium | 59 s | ready |

`tools/e2e-verify.mjs` on the sample: **8 pass, 0 fail, 0 without evidence** —
only the root worktree; no `task/*` branch; a clean tree; 69 tests green on
`main` at `90473bf`; six records, one per delegation, each with its native log;
every record at depth 1 against a cap of 1; the journal reading
`worktree-created, git, committed, git, committed, merged, tests-passed,
worktree-removed, branch-deleted`; and no `delegate` call, no `mcp__` tool and no
engine-launching shell command in any specialist transcript.

Deviations: the loop's step 8 (rebase) never ran, because `main` had not moved —
the loop now says to run it anyway and why; both reviews returned `ready`, so the
needs-work round was injected by the operator and named as such in the brief. And
E1 ran **before** the containment fix and the deny-list root: its implementers'
specs carry no `protectedPaths` and their deny rules name a path under the
sample. No pass condition depends on either; the shipped configuration's evidence
is I2's Claude row under the fix, and the next end-to-end run on any host is the
first to exercise both inside a whole loop.

### Depth, from the MCP server's position

| host | hops from the server to pid 1 | row served |
|---|---|---|
| Claude Code, started from a terminal (`claude`, `bash`, `sh`, terminal, `systemd --user`, `init`) | 7 | operator |
| Claude Code, started with `setsid --fork` (E1, I1, I2) | 4 | operator |
| Claude Code, started as a child of another Claude Code session | 9 | **specialist** — "the walk found neither an engine nor the root within 8 hops" |

At T13 the design's 8-hop limit was **not raised** (6b raised it to 32 on
2026-09-30; see the 6b section): it excluded a nested harness, not an
operator, and the harness has a one-word fix (`setsid`). A server says which row
it resolved, and why, on stderr at the first resolution a request asks for.

### Failure injections

Every row rests on the records the run left on disk: the settled record, its
`.outcome.json` and the runner log under the injection project's
`.cross-agent/tasks/`. The harness console output was not archived; the rows
below quote what those files say.

| injection | what was done | what happened |
|---|---|---|
| server killed during a task | real stdio server + real detached runner, fake engine bound as `engines.claude.bin`; SIGKILL to the server while the task ran | runner and engine survived; the runner settled the record `done` (exit 0) 13 s later and wrote `<id>.outcome.json`; a fresh server's `list_tasks` reported it `done` with `invalid: []`, `errors: []`, `skipped: []` |
| runner killed, engine alive | same, `FAKE_ENGINE_SCRIPT=stall`; SIGKILL to the runner | one `list_tasks` settled it in 80 ms: `status: "failed"`, `reason: "runner lost; engine group terminated"`; the engine's process group was gone afterwards, and a second `list_tasks` left it alone |
| needs-work round through `resume` | inside E1: the implementer resumed with an amended brief (`f5477ad3…`) | record carries `resumedFrom: 7fd15e08…`, spec carries the original's `resumeSessionId`, same role, cwd, branch and sandbox; the round's work was committed and re-reviewed |

### Probes

- **P2, Claude** (`atc-s96.17`): three rows. The first found a **containment
  failure** — a workspace-write specialist wrote `<root>/.git/…` (`atc-s96.52`).
  The rerun with `filesystem.denyWrite` carrying the spec's `protectedPaths`
  denies it and changes nothing else. The **read-only row** closes the gap the
  second opinion found: a read-only role's own workspace is denied by name, and
  the project, `.cross-agent/`, `git add -A` and `/tmp` were all refused while
  reads worked. Outstanding and not run: `$TMPDIR` for a writable role, a write
  into another registered worktree, `<root>/.git/refs/heads/<default>`, and the
  whole set on a resumed session.
- **I1**: Claude's rows pass (a delegated specialist sees no MCP tool; a tracked
  one with a lead's mount sees exactly the five specialist tools). **Grok's row
  is closed** (`atc-s96.54`): with the sample folder trusted, a `consult` at the
  project root reached this server and listed exactly the five, its `delegate`
  refused by Grok's own dispatcher. A Grok specialist inside a linked worktree
  reaches no server — `./.grok/config.toml` is per-directory — and would need a
  user-scope mount, which is the operator's decision. The refusal that names the
  matched task id is unreachable from any engine that honours `tools/list` and
  is pinned by `tests/authority.test.ts`'s "a specialist's own server refuses
  delegate by name, with the task its ancestry matched" instead.
- **I2**: Claude and Grok rows pass, and the Claude row was rerun under the
  containment fix through the product pipeline — spec `protectedPaths`, the
  engine's own `--settings`, nine steps including `<root>/.git/hooks/pre-commit`,
  every outside write denied. A 600-second `wait` returned at 602 s.
- **Not run at T13: every Codex row.** I1's Codex rows ran at 6b (below); I2's
  Codex rows and the guarded test (`CROSS_AGENT_REAL_CODEX=1 node --test
  tests/engines/codex.test.ts`) are T14's, with `gpt-6-luna` at medium.

### Cost of the recorded runs

$2.88 in all, on the subscription: P2 $0.24 and its rerun $0.17, the read-only
row $0.21, the two host tool listings $0.14 and the inline-mount recheck $0.06,
I1 $0.31 with the tracked probe $0.18, its rerun $0.10 and the Grok row $0.03,
I2 $0.33 and the delegated rerun under the fix $0.26, the ten-minute wait $0.15,
E1 $0.73.

## 6b — pre-flight: probes on the current CLIs and hardening (merged 2026-10-01)

| what | value |
|---|---|
| merge | `main` at `d428145`: `task/cross-agent-m3` rebased onto `main` and fast-forwarded — 24 commits over `cb87b01` (twelve, two fix rounds of six and four, the verifier's class-level rewrite `0f9ff3a`, merged as `af0f266`, and the wrap-up) |
| `npm test` at the root | 659 tests: 658 pass, 0 fail, 1 skipped (the Codex I2 test, guarded behind `CROSS_AGENT_REAL_CODEX=1`), on `main` at `d428145` |
| citation checker | 909 citations in 2 files (37 by line, 872 by symbol or anchor), 0 misses; `--since cb87b01`: 0 drifted, 0 not judged |
| verifier | `node --test tests/e2e-verify.test.ts` 40/40; the controller's launcher table 347/347; the 148 archived transcript commands judge 129 pass, 4 launch, 15 `?` (no false FAIL); this machine's Codex code-mode scripts, no FAIL |
| engines | Claude Code 2.1.286, codex-cli 0.159.2, grok 1.0.44 (5b807183dd79); `claude-sonnet-5`, `gpt-6-luna`, `grok-4.7`, each at medium |
| sample repository | `~/.cache/agent-team/cross-agent-e2e/slugkit`, `main` at `5578d3c`; `tools/e2e-verify.mjs` on E1's six records: 8 pass, exit 0 |
| raw evidence | `~/.cache/agent-team/probe-logs/6b-2026-09-30/` (one directory per probe), and the probe task records under `~/.cache/agent-team/cross-agent-e2e/probe-tasks/6b/`, named in `docs/probes.md` |

Landed: `tools/probe.mjs --track` mounts the server with `--project` in its
arguments, the form Codex's builder accepts; a read of an unknown task writes
nothing (`atc-s96.51`); the runner re-scans an unreadable candidate — four scans,
250 ms apart, 750 ms of waiting — and re-checks after the wait, so a settlement
inside it launches no engine (`atc-s96.49`); `git_root` and `run_command` name the main worktree when
pointed at a linked one (`atc-s96.50`); `killGroup` removed (`atc-s96.47`); the
authority walk allows 32 hops; Grok's sandbox refusal fails the run by name;
the end-to-end verifier judges a launch with a shell tokenizer under a written
contract — on a line that names an engine anywhere (heredoc bodies, assignment values
and redirection targets included), `pass` only where its grammar understands every
construct, `?` for anything unmodeled, including unread stdin, expanded operands,
code-carrying variables and deferred arithmetic — applies its
effective depth cap and lead row (`--lead-role` renaming a shipped mode's lead
only), reads Codex's `mcp_tool_call` item, and reads each Codex record's session
rollout, passing a code-mode script only when every command-tool call in it is
a direct one it can follow (`atc-s96.56`); a Claude specialist's settings
disable the operator's hooks.

### Probes

- **Smoke**: all three CLIs answer a read-only `consult` through the product
  (claude 7.8 s, codex 12.4 s, grok 6.8 s); the Claude specialist ran the
  operator's `SessionStart` hooks and answered a `Stop` hook with its final
  message.
- **Grok's sandbox**: 1.0.44's `read-only` (and `strict`) refused to start —
  `/run/podman` created `0700 root` by rootful podman left its runtime-socket
  deny list unresolvable. Fixed by the user (`/etc/tmpfiles.d/podman.conf` at
  `0711`, `chmod 0711 /run/podman`); a `consult` then answered in 8.0 s. The
  refusal now fails a run as `grok sandbox failure: …`, not `engine exited 1`.
- **I1, Codex**: both rows run. A delegated `consult` sees only Codex's own
  `codex_apps`; a child given a lead's mount sees exactly the five specialist
  tools as `mcp__cross_agent__<tool>`, answers `list_roles` from the project
  `--project` names, and has no `delegate`. First recorded `mcp_tool_call` item.
  Not run: the direct `tools/call delegate` refusal (unreachable from a client
  that honours `tools/list`; pinned by a test) and the Codex host rows (T14).
- **Grok `--rules` beside `--prompt-file`**: four marker runs — both inputs are
  read (`atc-3ub` item 1).
- **Codex `workspace-write`**: every write outside the worktree denied, `~/.cache`
  included (`atc-3ub` item 2); the network denied (DNS fails). `--json` carried no
  command item for the four denied writes; the session rollout recorded them, and
  by the controller's ruling it is the second witness where `--json` has no item.
  The end-to-end verifier reads each Codex record's rollout for that reason.
- **Claude hooks**: before `disableAllHooks`, four `SessionStart` hooks and one
  injected context; after, none, `mcp_servers: []`, "OK" alone; the read-only
  write and the deny-list denial hold. Skills and slash commands still load.

### Depth, from the MCP server's position

| host | hops from the server to pid 1 | row served |
|---|---|---|
| Claude Code, started from a terminal | 7 | operator |
| Claude Code, started with `setsid --fork` (E1, I1, I2) | 4 | operator |
| Claude Code, started as a child of another Claude Code session (T13, 8-hop walk) | 9 | **specialist** — "the walk found neither an engine nor the root within 8 hops" |
| a server started from a Claude Code session's own shell, no `setsid` (6b, 32-hop walk) | 9 (`node`, `bash`, `claude`, `bash --posix`, `sh -c`, `ghostty`, `nautilus`, `systemd --user`, `init`) | operator, twelve tools |

T13 recorded "the design's 8-hop limit is not raised"; that is now history. The
user raised the budget to 32 on 2026-09-30, the walk otherwise unchanged, and
6b's nested row serves the operator. The Codex and Grok hosts' counts are T14's
and T15's (`atc-s96.53`).

### Decisions recorded by the runs

- **Grok's sandbox fix** is the machine's, not the product's: the product names
  the refusal and does not check Grok's deny list before a launch.
- **Hooks**: `disableAllHooks: true` under every profile, adopted on A7's gate;
  `--setting-sources` not needed.

### Cost of the recorded runs

$0.375 in dollars on the subscriptions: Claude $0.272 (hooks baseline $0.148,
after $0.054, hard requirements $0.071); Grok $0.103 (sandbox after the fix
$0.014, the four `--rules` runs $0.088). Codex reports tokens only: I1 (i)
22,461 in / 1,571 out, I1 (ii) 45,102 / 1,969, the `~/.cache` runs 43,369 / 388
and 103,367 / 625. The coordinator's smoke was not rerun (Claude $0.196, Grok
$0.015).

## S11 — engine placement (merged 2026-10-01)

| what | value |
|---|---|
| merge | `main` at `ebc9960`: `task/cross-agent-m3` rebased onto `main` and fast-forwarded — 25 commits over `886ae9f` (fifteen, fix round 1's nine, the wrap-up) |
| `npm test` at the root | 703 tests: 702 pass, 0 fail, 1 skipped (the Codex I2 test, guarded behind `CROSS_AGENT_REAL_CODEX=1`), on `main` at `ebc9960` |
| citation checker | 1011 citations in 2 files (37 by line, 974 by symbol or anchor), 0 misses; `--since 886ae9f`: 0 drifted, 0 not judged |
| engines | Claude Code 2.1.286, codex-cli 0.159.3, grok 1.0.44 (5b807183dd79), 1.0.46 (2765805b9442) for E2b and E2c; `claude-sonnet-5`, `gpt-6-luna`, `grok-4.7`, each at medium |
| host (E3, E2) | the E1 command, `claude -p --plugin-dir <worktree> --model claude-sonnet-5 --effort medium --permission-mode bypassPermissions --output-format stream-json --verbose`, under `setsid --fork` from the sample |
| operator driver (B2, injections) | `scripts/driver.mjs` in the archive: a stdio client of the server, one operator-row call per request file, any number in flight |
| sample repository | `~/.cache/agent-team/cross-agent-e2e/slugkit`, `main` from `5578d3c` to `15e9f4e`; 87 tests green |
| raw evidence | `~/.cache/agent-team/probe-logs/s11-2026-10-01/` (one directory per run, the scripts, every config version), and the records of every run but E3 and E2 under `~/.cache/agent-team/cross-agent-e2e/probe-tasks/s11/`, named in `docs/probes.md#s11` |
| how a run is judged | `node tools/e2e-verify.mjs --project <sample> --since <lead id> --slug <slug>`, `CODEX_HOME` unset, and the ledger's depth-and-lineage reading (`scripts/depth-lineage.py`), which sees a record one level too shallow where the verifier's upper bound cannot |

Landed: the server splits stdin on `\n` alone, so U+2028 and U+2029 inside a request
no longer strand it (`atc-s96.59`). `ask`, `list_asks` and `answer` live over
`.cross-agent/asks/`, under a per-ask lock, first answer wins, and they are offered
only under engine placement. An operator's `delegate` of `dev-team-engine`'s lead
launches it with a per-run mount of this server and its loop and role as the system
prompt; a lead the depth cap would hold is refused, as is one on an engine that has
no per-run mount. The Codex mount carries `tool_timeout_sec=3600` and whitelists the
four task markers, and an MCP call is stall activity. A resumed lead receives its
lineage's asks. `list_tasks` marks a lead's `self` and `own`. Cancelling a lead
cancels its open asks. The operator CLI has one verb table, `--json`, one exit
protocol, and `answer` and `report`. The engine lead's ten-step loop and role prompt
are written, and the launcher routes on placement.

### E3 — one `dev-team-engine` task, a Claude lead

Task "S11-E3: add `is_slug(text) -> bool` beside `slugify`, with tests". Host
session 387 s, 8 turns, $0.25: `describe_mode`, `list_roles`, one `delegate` of the
lead and one `wait`. No shell.

| task | role | engine | model | effort | duration | outcome |
|---|---|---|---|---|---|---|
| `144d7771…` | lead | claude | claude-sonnet-5 | medium | 360 s | the loop; closing report through `result` |
| `9c82d1cd…` | planner | codex | gpt-6-luna | medium | 32 s | plan |
| `e564c7d9…` | plan-reviewer | grok | grok-4.7 | medium | 104 s | approve |
| `fe75f142…` | implementer | claude | claude-sonnet-5 | medium | 30 s | 69 → 73 tests green |
| `c3f54b10…` | code-reviewer | grok | grok-4.7 (read-only) | medium | 90 s | ready |

`tools/e2e-verify.mjs --since 144d7771… --slug s11-e3` gave 7 pass, 0 fail, 1 without
evidence:
- only the root worktree; no `task/*` branch; a clean tree; 73 tests on `main` at
  `81cec9d`;
- five records with their logs, every one at depth 2 or less against a cap of 2;
- the journal `worktree-created, git, committed, git, merged, tests-passed,
  worktree-removed, branch-deleted`;
- condition 8 `?` on six `tool_progress` events, read: each `heartbeat: true`, its
  `parent_tool_use_id` one of the lead's three `wait` calls, no command, no input —
  neither a launch nor a `delegate`.

Depth and lineage: the lead at depth 1, `parentTaskId` null, its lineage itself; four
specialists at depth 2, each the lead's child, the lead first in its spec's lineage —
PASS. The lead's server carried all four markers (Claude passes its environment on).
It listed the lead row's fourteen tools, ran no shell command, and showed no hook
activity under `disableAllHooks`. `result` on the lead equals its result file;
`cross-agent report` shows the five tasks `passed`.

Deviation: the host relayed `wait`'s tail instead of calling `result`; the launcher
now says the tail is not the report.

### E2 — one `dev-team-engine` task, a Codex lead

Task "S11-E2: `slug_words` accepts `max_words: int | None`, with tests". Host
session 531 s, 13 turns, $0.28: `describe_mode`, `list_roles`, `list_tasks`, one
`delegate` of the lead, one `wait` and `result`.

| task | role | engine | model | effort | duration | outcome |
|---|---|---|---|---|---|---|
| `83750cc5…` | lead | codex | gpt-6-luna | medium | 490 s | the loop in 27 MCP calls; closing report through `result` |
| `6bbadfd0…` | planner | codex | gpt-6-luna | medium | 24 s | plan |
| `8b7d2f21…` | plan-reviewer | grok | grok-4.7 | medium | 150 s | approve |
| `b4ef9d49…` | implementer | claude | claude-sonnet-5 | medium | 28 s | 73 → 77 tests green |
| `d7185cc2…` | code-reviewer | grok | grok-4.7 (read-only) | medium | 82 s | ready, one low-priority note |

`tools/e2e-verify.mjs --since 83750cc5… --slug s11-e2` gave 7 pass, 0 fail, 1 without
evidence: the same seven, with 77 tests on `main` at `7a5c15f`.

Condition 8 was `?`, "its rollout holds delegate: 1 occurrences but only 0 direct
calls followed". The reading:
- the occurrence is a tool-discovery regular expression naming `delegate`, which
  calls nothing;
- the rollout's six top-level `function_call`s are Codex's code-mode `wait` on
  yielded cells;
- there is no command execution anywhere.

Depth and lineage: PASS, as E3. All 27 MCP calls completed with no approval text, and
`git_mutate` and `git_root` ran without a Codex prompt. `result` equals the result
file; `cross-agent report` shows the five `passed`.

Deviation: the host summarized the report and ran two read-only `git` commands of its
own; the launcher now forbids both under engine placement. No run has exercised that
text yet.

### A lead's server, from the ledger

| lead | the server's environment | the lead row | its child |
|---|---|---|---|
| Claude (E3) | Claude's own, all four markers | depth 1 | depth 2, the lead first in its lineage |
| Codex, three settings (B2 run 1) | `HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` only | depth **0** | depth **1**, a lineage of itself |
| Codex, `env_vars` whitelisting the markers (B2 run 2, E2) | the seven and the four markers, the engine's values | depth 1 | depth 2, the lead first in its lineage |

### B2 — a Codex lead's tool call past 60 s

| run | child | the lead's `wait`, by its rollout item's own `duration` | verdict |
|---|---|---|---|
| 1 | Claude `consult`, `sleep 100`: refused by Claude Code ("Blocked: standalone sleep"), backgrounded, answered at 22 s | 19.04 s | inconclusive |
| 2 | Codex `consult`, `sleep 150`, done at 161.4 s | `{secs: 158, nanos: 219517083}` = 158.22 s, `status: completed`, no error | pass, under `tool_timeout_sec=3600` |

### Failure injections

| injection | what was done | what happened |
|---|---|---|
| cancelling the lead (I1) | `cancel` of a Claude lead while its implementer ran | one outcome per task: the implementer and the lead `cancelled`, planner and plan reviewer `already done`; `asksCancelled: []`; every record terminal, no process left; the worktree and branch stand, as a cancel leaves them |
| a killed lead's ask (I2) | SIGKILL to the lead's engine while its ask was open | the record `failed`, the ask still `open`; `cross-agent answer` exit 0, a second answer exit 3 naming the first's time; the resumed lead's brief ends `## Asks so far` with the question and answer while `briefHash` is the caller's text; the resumed lead created `task/s11-i2` |
| the suite fails on `main` after the merge (I3) | a root-only marker in `testCommand` | the merge stood, root `run_command` exit 1, no `tests-passed`; the final message offers `git revert --no-edit <defaultShaBeforeMerge>..<branchHead>` with the journal's two SHAs and runs nothing after it |
| interrupted after `worktree remove` (I4) | SIGKILL to the lead's engine at `worktree-removed`, its ask open | the operator's reconciliation pass deleted the branch through `git_root`, journaling `branch-deleted`; the verifier then 7 pass and `?`; cancelling the dead lead cancelled its ask |
| a rebase conflict (I5) | the operator's own commit to `main` on the lines the task rewrote | `git_mutate rebase` `ok: false` with git's CONFLICT text, journaling nothing; `rebase --abort` journaled `git`, no rebase state left; the lead asked, naming the file, and stopped on the answer |

Each injection's verifier ran for the conditions its stopping point allows, and each
depth-and-lineage reading passed. The restores are recorded in each run's directory.

### Codex 0.159.3

- A stdio MCP server starts with `HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and
  `USER` only. `mcp_servers.<id>.env_vars=[…]` adds named variables with the engine's
  own values.
- `tool_timeout_sec=3600` lets one MCP call run past the 60 s default (158.22 s,
  measured).
- The MCP item is 0.159.2's: the `--json` `mcp_tool_call` pair, and the rollout's
  `McpToolCall` with `duration {secs, nanos}`.
- Every call ran inside a code-mode `exec` script. A yielded cell is waited on with
  Codex's top-level `wait` function (`{cell_id, yield_time_ms}`), which runs no command
  and which the verifier does not yet classify.
- `default_tools_approval_mode="approve"` under `codex exec`'s `never`: 27 calls, no
  approval text.
- Codex does not confine a mounted server to its sandbox: a read-only lead's server
  wrote the ledger.

### The sample at close

`dev-team-engine`, `limits.maxDepth` 2, the lead on claude/claude-sonnet-5/medium (as
the last run left it), the planner on codex/gpt-6-luna, both reviewers on
grok/grok-4.7 (the code reviewer read-only), the implementer and `consult` on
claude/claude-sonnet-5, all at medium; `project.*` unchanged. `main` at `a832c1b`,
clean, the root worktree alone, no `task/*` branch, 82 tests green; 16 records (E1's
six, E3's five, E2's five).

### Cost of the recorded runs

$4.77 in dollars on the subscriptions:

| run | dollars |
|---|---|
| E3 | $1.29 |
| B2 | $0.11 |
| E2 | $0.56 |
| I1 | $0.14 |
| I2 | $0.14 |
| I3 | $1.05 |
| I4 | $0.34 |
| I5 | $1.14 |

Killed or cancelled Claude sessions report no cost (I1's lead and implementer, I2's
two leads, I4's lead), so this undercounts. Codex reports tokens only: 2,494,197 in /
18,162 out across S11, of which E2's lead was 1,384,308 / 4,318.
```

### Fix round 1 and the wrap-up

Also landed: the launcher's host-loop paragraphs each name `host` placement, and the
engine section says who reconciles — the live lead's step 1, the continuing lead
after a resume, and the host only for a failed or killed lead's leftovers that will
not be resumed, never at session start; an engine-placed host closes on the lead's
report verbatim; a resume refuses while an unreadable ask may be its chain's, and a
cancel names such asks beside its outcomes; `answer` refuses a project with no
config; one ask-id predicate; `--json` prints one document on every exit, help
included; the verifier reads Claude Code's in-flight heartbeat in E3's shape, so E3's
lead scans clean (E3's `--since` range still includes E2's records and their `?`).

The E3 and E2 deviations above stand as recorded; the launcher now says the tail of
`wait` is not the report, and its host-loop paragraphs name `host` placement.

#### E2b and E2c — E2's host clause, run again

| run | host | lead | verdict | depth | host calls | closing message |
|---|---|---|---|---|---|---|
| E2b, `s11-e2b` | 386 s, 9 turns, $0.25 | `33fde77f…`, codex, 362 s; merge `efa2d27` | 7 pass, `?` read as a tool-discovery regular expression naming `cross-agent` | PASS | the launcher's only, no shell | a list of its own — the launcher's closing paragraph asked for one; now host placement's |
| E2c, `s11-e2c` | 250 s, 8 turns, $0.21 | `84a1c550…`, codex, 232 s; merge `15e9f4e` | 7 pass, `?` read as a tool-discovery regular expression naming `delegate` | PASS | the launcher's only, no shell | the lead's report verbatim |

In E2c `git_root` refused a lead's `worktree add` outside the mode's worktree
directory, and the lead ran its refusal check before retrying at the right path.

The sample at close: `main` at `15e9f4e`, 87 tests green, `dev-team-engine`, the lead
on codex/gpt-6-luna/medium as E2c left it. Fix round 1's runs cost $1.03 (a Grok
1.0.46 smoke $0.015, E2b $0.59, E2c $0.43) and Codex 2,473,954 tokens in / 8,913 out;
S11's recorded runs, $5.81 in all.

## T16 — the operator CLI (merged 2026-10-01)

| what | value |
|---|---|
| merge | `main` at `1f57683`: `task/cross-agent-m3` rebased onto `main` and fast-forwarded — 16 commits over `567a1f5` (five, fix round 1's seven, the wrap-up's three, and the work plan's rows re-pointed to the merged commits) |
| `npm test` at the root | 723 tests: 722 pass, 0 fail, 1 skipped (the Codex I2 test, guarded behind `CROSS_AGENT_REAL_CODEX=1`), on `main` at `1f57683` |
| citation checker | 1083 citations in 2 files (37 by line, 1046 by symbol or anchor), 0 misses; `--since a8d1577`: 0 drifted, 0 not judged |
| engines | none: every proof is a seeded ledger, a bare repository or a test |

Landed: the operator CLI's nine remaining verbs on S11's dispatcher, each calling what
its tool calls; `listTasks` without a pass for the operator's read; the reads proved
side-effect free; the verbs that write refused inside a task's environment; `report`'s
messages indented; `list-asks` naming damaged ask files (the CLI half of
`atc-s96.65`). The review's fix round made `show` take a task's status, exit and final
message from one read of its record, kept the record on screen beside a journal that
does not read, failed the marker refusal closed for a verb that does not declare it
only reads, put `git`'s usage flags before its `--`, and checked each journal step;
the wrap-up printed a time no date can hold as its number and bounded a journal step's
time.

| verb | calls | exits beside 1 and 2 |
|---|---|---|
| `init` | `initConfig` | 0, 3 |
| `modes` | `loadMode` per built-in mode, `loadConfig(root).mode` | 0, 3 |
| `tasks [--status] [--reconcile]` | `listTasks(root, status, {reconcile})` | 0 |
| `show <id> [--lines]` | `find`, `tailLines`, `readOutcome`, `readJournal`, `result`; no `observeStall` | 0, 3, 4, 6 |
| `log <id> [--lines]` | `find`, `tailLines` | 0, 3 |
| `cancel <id>` | `cancel(root, id)`, no lead | 0, 3, 4 |
| `verify-worktree <path> <branch>` | `verifyWorktree` | 0, 3 |
| `git <slug> -- <args…>` | `gitMutate` with `lockWaitSeconds` and the mode's `gitPolicy` | 0, 1, 3 |
| `journal [<slug>]` | `readJournal` / `listJournals` | 0, 1, 3 |
| `list-asks [--status]` | `listAsks(root, {status?})` | 0, 5 |
| `answer <ask-id> <text>` | `answerAsk` | 0, 3 |
| `report [--since]` | `scan` | 0, 3 |

Every verb but `init` also exits 3 when no project resolves. The verbs that write —
`init`, `answer`, `cancel`, `git`, `tasks --reconcile` — exit 3 under
`CROSS_AGENT_TASK`, `CROSS_AGENT_DEPTH` or `CROSS_AGENT_LINEAGE`.

### The uninitialized proof, by hand

In a scratch repository (`<dir>`; `<worktree>` is the task worktree; no other
substitution):

    $ git init -q -b main <dir> && git -C <dir> commit -q --allow-empty -m init
    $ sha256sum <dir>/.git/info/exclude
    6671fe83b7a07c8932ee89164d1f2793b2318058eb8b98dc5c06ee0a5a3b0ec1  <dir>/.git/info/exclude
    $ node <worktree>/src/cli.ts modes; echo "exit $?"
      dev-team 0.1.0 — Dev team
        A planner and a plan reviewer read at the project root; an implementer works in a linked
        worktree on its own task branch and a code reviewer reads that branch. The loop runs in your
        own host session, which owns every root git operation.
        roles:
          planner (root, read-only)
          plan-reviewer (root, read-only)
          implementer (worktree, workspace-write)
          code-reviewer (worktree, read-only)
          consult (root, read-only)
      dev-team-engine 0.1.0 — Dev team, engine-placed lead
        The dev-team roles with the loop moved into a spawned Claude or Codex lead, so your own
        session stays free while the team works. The lead is read-only at the project root and
        reaches git and the test command through the server's root tools.
        roles:
          lead (root, read-only)
          planner (root, read-only)
          plan-reviewer (root, read-only)
          implementer (worktree, workspace-write)
          code-reviewer (worktree, read-only)
          consult (root, read-only)
    * solo 0.1.0 — Solo
        One role and one turn: the built-in consultant reads the project at its root under a
        read-only sandbox and reports back, or takes one change in a task worktree of its own when
        the call asks for one. No plan, no review round, no second engine — the zero-ceremony
        delegation, the mode a project with no config runs as, and the proof that the worktree
        provider is a seam rather than an assumption.
        roles:
          consult (root, read-only)
    exit 0
    $ node <worktree>/src/cli.ts tasks; echo "exit $?"
    no tasks
    not reconciled: pass --reconcile
    exit 0
    $ node <worktree>/src/cli.ts tasks --json; echo "exit $?"
    {
      "ok": true,
      "tasks": [],
      "invalid": [],
      "errors": [],
      "skipped": [],
      "reconciled": false
    }
    exit 0
    $ node <worktree>/src/cli.ts show 0123456789abcdef0123456789abcdef0123; echo "exit $?"
    cross-agent: no task 0123456789abcdef0123456789abcdef0123
    exit 3
    $ node <worktree>/src/cli.ts log 0123456789abcdef0123456789abcdef0123; echo "exit $?"
    cross-agent: no task 0123456789abcdef0123456789abcdef0123
    exit 3
    $ node <worktree>/src/cli.ts journal; echo "exit $?"
    exit 0
    $ node <worktree>/src/cli.ts journal some-slug; echo "exit $?"
    cross-agent: no journal some-slug
    exit 3
    $ node <worktree>/src/cli.ts list-asks; echo "exit $?"
    exit 0
    $ node <worktree>/src/cli.ts report; echo "exit $?"
    exit 0
    $ test ! -e <dir>/.cross-agent && echo "no .cross-agent"
    no .cross-agent
    $ sha256sum <dir>/.git/info/exclude
    6671fe83b7a07c8932ee89164d1f2793b2318058eb8b98dc5c06ee0a5a3b0ec1  <dir>/.git/info/exclude
    $ git -C <dir> status --porcelain --untracked-files=all | wc -c
    0

Exits `0 0 0 3 3 0 3 0 0`, as expected.

### The marker proof, by hand, in the same repository

    $ CROSS_AGENT_TASK=x node <worktree>/src/cli.ts cancel 0123456789abcdef0123456789abcdef0123; echo $?
    cross-agent: CROSS_AGENT_TASK is set in this environment: cancel is an operator's command, and an engine reaches the project through its server, never this CLI
    3
    $ CROSS_AGENT_TASK=x node <worktree>/src/cli.ts tasks; echo $?
    no tasks
    not reconciled: pass --reconcile
    0
    $ node <worktree>/src/cli.ts cancel 0123456789abcdef0123456789abcdef0123; echo $?   # the same cancel, no marker
    cross-agent: no task 0123456789abcdef0123456789abcdef0123
    3
    $ test ! -e <dir>/.cross-agent && echo "no .cross-agent"
    no .cross-agent

### The seeded proof

The tests, over a ledger `tests/helpers/seed.ts#seededProject` builds through the
ledger's own functions and the CLI's own `init`:
`tests/tasks.test.ts#listTasksWithoutPass`;
`tests/cli.test.ts#cliReadsWriteNothingUninitialized`, `#cliReadsLeaveSeededLedger`,
`#cliTasksReconcileFlag`, `#cliModes`, `#cliTasks`, `#cliShow`, `#cliShowOneRead` (a
FIFO at the record's path that would serve a second read a settled record), `#cliLog`,
`#cliCancel`, `#cliCancelStillActive`, `#cliIdOutsideAlphabet`, `#cliVerifyWorktree`,
`#cliGit` (the held `git.lock` refused in under 4 s against a one-second wait),
`#cliJournal`, `#cliListAsks`, `#cliRefusesInsideEngine`, `#cliWritesFailsClosed`,
`#cliUsage`, `#cliDocsNameVerbs`, and `#reportVerb`'s table case.
## T14 — Codex packaging, I1 and I2 under a Codex host, E4 and E5 (merged 2026-10-01)

| what | value |
|---|---|
| merge | `main` at `827739c`: `task/cross-agent-m3` rebased onto `main` and fast-forwarded — 24 commits over `7d1ef63` (eleven, fix round 1's ten, the wrap-up's two, and the commit references re-pointed to the merged commits) |
| `npm test` at the root | 735 tests: 734 pass, 0 fail, 1 skipped (the Codex I2 test, guarded behind `CROSS_AGENT_REAL_CODEX=1`; it ran green under it, last under the positive proof of fix round 1), on `main` at `827739c` |
| citation checker | 1142 citations in 2 files (37 by line, 1105 by symbol), 0 misses; `--since 6a13c0c`: 0 drifted, 0 not judged |
| packaging | `.codex-plugin/plugin.json`: `skills: "./skills/"`; the server inline, `command: "./.codex-plugin/serve"`, `cwd: "."`, `env_vars: ["CROSS_AGENT_PROJECT", "CROSS_AGENT_TASK", "CROSS_AGENT_DEPTH", "CROSS_AGENT_LINEAGE"]`, `tool_timeout_sec: 3600`, `default_tools_approval_mode: "approve"`, `startup_timeout_sec: 30`, no `enabled`; `.codex-plugin/serve` refuses without `CROSS_AGENT_PROJECT` and stops if its own root does not resolve; `.agents/plugins/marketplace.json` offers `cross-agent` from `"./"`; fallback `assets/codex/mcp_servers.toml` with the same `env_vars` |
| install | a `git archive` export of `HEAD` in a directory of its own, `codex plugin marketplace add <export>`, `codex plugin add cross-agent@agent-team-cli`; Codex runs a copy taken at install (`~/.codex/plugins/cache/agent-team-cli/cross-agent/0.0.1/`); at close, installed from the export of `6d86c9e` (`f3272a2` before the merge's rebase, the name its export directory keeps), disabled; the operator's `~/.codex/config.toml` is backed up as `~/.codex/config.toml.bak-t14-2026-10-01`, and the wrap restores it |
| exposure | the plugin-level key: `[plugins."cross-agent@agent-team-cli"] enabled = false` in the operator's file, `-c plugins.cross-agent@agent-team-cli.enabled=true` per session; `[mcp_servers.cross-agent] enabled = false` stops Codex loading its config; file windows 11:29:15–11:32:40Z, 11:54:05–11:56:18Z (B5), and under 82 ms at fix round 1's reinstall |
| host | `codex exec --json -o <run>/host.last.txt -C <target> -s workspace-write -m gpt-6-luna -c model_reasoning_effort="medium" [-c plugins.cross-agent@agent-team-cli.enabled=true] -`, `setsid --fork` from the target, markers scrubbed, `CROSS_AGENT_PROJECT=<target>`; the per-session flag on every host that had the server but B5's; B4(b)'s nested host without `setsid`; E5's second turn `codex exec resume <thread> -` |
| engines | Claude Code 2.1.286, codex-cli 0.159.3, grok 1.0.46 (2765805b9442), node 24.11.0; `claude-sonnet-5`, `gpt-6-luna`, `grok-4.7`, each at medium, the hosts included |
| sample | `~/.cache/agent-team/cross-agent-e2e/slugkit`, `main` `15e9f4e` → `23980ed` (E4) → `583bfda` (E5); 95 tests green |
| raw evidence | `~/.cache/agent-team/probe-logs/t14-2026-10-01/` (fix round 1's under `fix1/`); probe records under `~/.cache/agent-team/cross-agent-e2e/probe-tasks/t14/`; named in `docs/probes.md#t14` |
| how a run is judged | `node tools/e2e-verify.mjs --project <sample> --since <first id> --slug <slug>`, `CODEX_HOME` unset, plus the depth-and-lineage reading for E5 |

Landed: the Codex plugin, its launcher and marketplace entry, the fallback snippet and the README's
Codex section (install from a clean export); the plugin's whitelist of the project and a task's
markers; the verifier's `--read-rollout` mode, with `direct` per `exec`, and its reading of Codex
0.159.3's code-mode `wait` by its whole payload; the guarded I2 test reading `finalMessage`, adding
the resumed sibling write and proving every attempt from the rollout by a positive proof; the
launcher's Codex budget row.

E4 and E5 ran on the `bbf2460` install (`dac519b` before the merge's rebase), whose `env_vars` named `CROSS_AGENT_PROJECT` alone; probe (a) shows the shipped four-name mount behaves the same from a clean shell (`docs/probes.md#codexMarkers`).

### E4 — one `dev-team` task under a Codex host, `placement: host`

Task "T14-E4: add `unslugify(slug: str) -> str` beside `slugify`, with tests". Host 468 s, 1,744,918
tokens in / 5,067 out; six `wait`s (27.0, 141.2, 17.0, 77.1, 37.1, 22.0 s by their own items), no
refusal; the loop's own calls and the log append, no engine launch.

| task | role | engine | model | effort | duration | outcome |
|---|---|---|---|---|---|---|
| `9ed6c4fc…` | planner | codex | gpt-6-luna | medium | 28 s | plan |
| `376e3fae…` | plan-reviewer | grok | grok-4.7 | medium | 143 s | revise |
| `35cb5547…` | planner (`resume` of `9ed6c4fc…`) | codex | gpt-6-luna | medium | 19 s | revised plan |
| `70aa060c…` | plan-reviewer (round 2) | grok | grok-4.7 | medium | 79 s | approve |
| `920c667b…` | implementer | codex | gpt-6-luna | medium | 38 s | 87 → 90 tests green |
| `de1e73ec…` | code-reviewer | claude | claude-sonnet-5 (read-only) | medium | 24 s | ready, commit `23980ed` |

`tools/e2e-verify.mjs --since 9ed6c4fc… --slug t14-e4` gave 7 pass, 0 fail, 1 without evidence: only the
root worktree; no `task/*` branch; a clean tree; 90 tests on `main` at `23980ed`; six records with their
logs at depth 1 against a cap of 1; the journal `worktree-created, git, committed, git, merged,
tests-passed, worktree-removed, branch-deleted`; condition 8 `?` on the Codex implementer's
`file_change` items, read: two patches to files inside the task's worktree, no command and no call —
neither a launch nor a `delegate`. The implementer's and code reviewer's specs carry `protectedPaths`;
all six carry deny targets rooted at the plugin's copy: the first whole loop with both under a Codex
plugin host.

Deviations: none from the loop; step 8's rebase ran; the needs-work round was the plan reviewer's own.

### E5 — one `dev-team-engine` task under a Codex host, a Claude lead

Task "T14-E5: add `slug_hash(text: str, length: int = 8) -> str` …". Host: turn 1 779 s, turn 2 150 s
(a resume of the same thread), 2,030,354 tokens in / 5,036 out; calls `describe_mode`, `list_roles`,
one `delegate` of the lead, two `wait`s (600.008 s → running; 107.1 s → done), `list_tasks`, three
`list_asks`, `answer`, `result`.

| task | role | engine | model | effort | duration | outcome |
|---|---|---|---|---|---|---|
| `a74b6420…` | lead | claude | claude-sonnet-5 | medium | 984 s | the loop, one ask; closing report through `result` |
| `4e3fe4c9…` | planner | codex | gpt-6-luna | medium | 32 s | plan |
| `0965332e…` | plan-reviewer | grok | grok-4.7 | medium | 133 s | revise |
| `5e0db051…` | planner (`resume`) | codex | gpt-6-luna | medium | 22 s | revised plan |
| `c080b7b7…` | plan-reviewer (round 2) | grok | grok-4.7 | medium | 144 s | revise → the lead asked the operator |
| `113916c3…` | implementer | claude | claude-sonnet-5 | medium | 28 s | 90 → 95 tests green |
| `c3f723e9…` | code-reviewer | codex | gpt-6-luna (read-only) | medium | 29 s | ready |

`tools/e2e-verify.mjs --since a74b6420… --slug t14-e5`: 8 pass, 0 fail, 0 without evidence (95 tests at
`583bfda`; seven records, cap 2; every Codex record judged from its rollout; the lead by the lead row).
Depth and lineage: PASS. The lead's server carried all four markers. `result` = the result file byte
for byte; the host's closing message opens with it verbatim, nothing before or after; `cross-agent
report` renders E4's and E5's thirteen tasks `passed`.

Deviations: the host's one shell command, `cat` of the plugin copy's `skills/cross-agent/SKILL.md` —
Codex reading the skill it was offered — is outside the launcher's "`cross-agent report` and
`cross-agent answer` are the only commands of yours this placement needs" (T15's to settle,
`atc-s96.66`, `.70`); and the first turn ended on the lead's question (headless, no user to answer
it), so the operator's answer reached the run by resuming the host's own thread, whose `answer`
applied it.

### Depth, from the MCP server's position (Codex host)

| host | processes from the server to pid 1 | row served |
|---|---|---|
| Codex, `codex exec` started with `setsid --fork` (B3, E4) | 4 (`node`, `codex exec`, `systemd --user`, `init`) | operator |
| Codex, the same command from an agent session's own shell, no `setsid` | 10 (`node`, `codex exec`, `bash`, `claude`, `bash --posix`, `sh -c`, `ghostty`, `nautilus`, `systemd --user`, `init`) | operator, fourteen tools |
| Codex at a terminal; the Codex desktop app | not run: the user's hands | — |

### Probes

- **B1, the mount**: the Claude manifest alone installs and finds the skill but mounts no server;
  codex-cli 0.159.3 substituted no `${PLUGIN_ROOT}` in the inline `command`, `args` or `cwd` forms B1
  ran and runs a relative command from the session's directory, so the shipped form starts the server
  in the plugin's copy through its launcher, the project named by `CROSS_AGENT_PROJECT`. The copy takes
  the whole marketplace directory; from it discovery finds nothing (an export's copy) or a repository
  the operator did not name (a checkout's).
- **B2, environment**: the seven, `PWD`, `CROSS_AGENT_PROJECT`; no marker from a clean shell; not
  confined; its stderr surfaced nowhere.
- **Markers (fix round 1)**: with `env_vars` naming the project alone, a host started with
  `CROSS_AGENT_DEPTH=1` and no task id, as `run_command` gives a suite, served the operator's fourteen.
  With the four names: from a clean shell the server holds no marker, not even an empty one, and lists
  the fourteen; with `CROSS_AGENT_DEPTH=1` it holds `CROSS_AGENT_DEPTH=1` and lists the specialist
  row's five; without `CROSS_AGENT_PROJECT` no server starts and `codex exec` reports nothing.
- **B3, the ten-minute wait**: one `wait` through the plugin, 600.004 s by its own item, the child still
  running; a copy declaring 60 s cut the same call at 60 s.
- **I1 (B5)**: Claude no MCP tool; Codex `codex_apps` only — `--ignore-user-config` drops the user's
  plugins; Grok exactly the five specialist tools.
- **I2 (B6)**: every outside write denied on all three; Claude and Grok reach the network, Codex does
  not; Grok's pointer rewrite refused by `verify_worktree` and `git_mutate` with nothing mutated;
  `codexI2Real` green, each resumed attempt proved from the rollout, last (run 3) under the positive
  proof: five `direct` calls, nothing computed or unreadable.

### Codex 0.159.3, as packaged

- A plugin server's `McpToolCall` carries `pluginId`. `--json` writes an `apply_patch` edit as a
  `file_change` item. A headless host may call Codex's own `request_user_input_async` and `sleep`.
- `codex exec` writes `[projects."<dir>"] trust_level = "trusted"` for an untrusted repository it runs
  in, with no prompt, under `--ignore-user-config` too.
- A whitelisted name the session does not have is left out of a stdio server's environment, not
  passed empty. A plugin server that exits at start is reported nowhere under `codex exec`.
- `codex plugin add` writes `enabled = true` on every install; `codex plugin remove` leaves an empty
  `~/.codex/plugins/cache/agent-team-cli/`.

### The sample at close

`dev-team-engine`, `limits.maxDepth` 2, the lead on claude/claude-sonnet-5, the planner and code
reviewer on codex/gpt-6-luna (the code reviewer read-only), the plan reviewer on grok/grok-4.7, the
implementer and `consult` on claude/claude-sonnet-5, all at medium; `project.*` unchanged. `main` at
`583bfda`, clean, the root worktree alone, no `task/*` branch, 95 tests green; 29 records (S11's
sixteen, E4's six, E5's seven).

### Cost of the recorded runs

$1.852 in dollars on the subscriptions: B5 $0.182, B6 $0.272, E4 $0.264, E5 $1.134; fix round 1 ran
Codex alone. Codex reports tokens only: the hosts 5,590,071 in / 40,841 out over twenty-one sessions
(E4 1,744,918 / 5,067; E5's two turns 2,030,354 / 5,036; fix round 1's four marker probes 285,866 /
8,152); the specialists B5 22,493 / 1,637, B6 151,085 / 1,315, E4 260,949 / 2,738, E5 228,873 / 2,972;
`codexI2Real` 80,686 / 906, 80,026 / 793 and 98,154 / 1,015.

## T15 — Grok packaging, I1 and I2 under a Grok host, and the end-to-end runs E6 and E7 (merged 2026-10-01)

| what | value |
|---|---|
| merge | `main` at `157b6b4`: `task/cross-agent-m3` rebased onto `main` and fast-forwarded — 14 commits over `e5abf4d` (six, fix round 1's four, the wrap-up's three, and the commit references re-pointed to the merged commits) |
| `npm test` at the root | 742 tests: 741 pass, 0 fail, 1 skipped (the guarded Codex I2 test), on `main` at `157b6b4` |
| citation checker | 1199 citations in 2 files (37 by line, 1162 by symbol), 0 misses; `--since e436132`: 0 drifted, 0 not judged |
| host command | `grok --prompt-file <run>/prompt.md --model grok-4.7 --reasoning-effort medium --permission-mode bypassPermissions --output-format streaming-messages-json`, `setsid --fork` from the sample, markers scrubbed, no `--sandbox` |
| attach | the project's `.grok/config.toml`, kept out of git: `[plugins] paths = ["<repo>"]`, `enabled = ["cross-agent"]`; `[mcp] max_output_bytes = 100000`; the folder trusted. grok 1.0.46 reads `.claude-plugin/plugin.json` in place — `skills/` and the inline `mcpServers`, `${CLAUDE_PLUGIN_ROOT}` expanded — no copy, no Grok manifest, nothing under `~/.grok/` |
| install / verify / remove | README "Install it in Grok": `cross-agent init`, `printf '\n.grok/\n' >> .gitignore` and that change committed (a project that already tracks `.grok/config.toml` untracks it in the same commit: `git rm --cached`, then a commit of the index), the heredoc writing `$HOME/Documents/agent-team-cli` (or, into existing tables, the absolute path and `"cross-agent"` added to the arrays, and the cap raised only where lower, its earlier value noted); `grok inspect --json`, `grok mcp doctor cross-agent` (fourteen under `dev-team-engine`, twelve under `dev-team`/`solo`); removal takes out only what the attach added, entry by entry, and deletes the file only if the attach's lines were all it held |
| result cap | `describe_mode` 19,856 / 24,880 / 3,463 bytes (`dev-team` / `dev-team-engine` / `solo`); Grok's default cut at 20,000 bytes spilled the rest; with 100000 the answer arrived whole |
| engines | Claude Code 2.1.286, codex-cli 0.159.3, grok 1.0.46 (2765805b9442), node 24.11.0; `claude-sonnet-5`, `gpt-6-luna`, `grok-4.7`, each at medium, the hosts included |
| sample | `main` `583bfda` → `1a56f2a` (E6) → `90281e2` (E7); 101 tests green |
| raw evidence | `~/.cache/agent-team/probe-logs/t15-2026-10-01/` (fix round 1 under `fix1/`, the wrap-up under `wrap/`); probe records under `~/.cache/agent-team/cross-agent-e2e/probe-tasks/t15/`; named in `docs/probes.md#t15Attach` |
| how a run is judged | `node tools/e2e-verify.mjs --project <sample> --since <first id> --slug <slug>`, `CODEX_HOME` unset, plus the depth-and-lineage reading for E7 |

Landed: the README's Grok section and its tests (the `.grok/` ignore line, safe after a last line
with no newline; the commit of `init`'s `.gitignore` on every host; a tracked `.grok/config.toml`
untracked in that commit; the merge into existing tables and the removal of only the attach's
entries); the launcher's Grok budget row (600, measured); the launcher's sentences for a host
without tools (a Grok host searches before it stops), the roster before the lead, the headless
host's open ask and the skill's own file; the lead's spelled report line.

### E6 — one `dev-team` task under a Grok host, `placement: host`

Task "add `slug_snake(text) -> str` … use the slug `t15-e6`". Host 330 s, 24 turns, $0.236; four
`wait`s (21.0, 90.1, 26.0, 60.1 s by Grok's own records), no refusal; the loop's own calls, the log
appended with Grok's `search_replace`, no shell command. Largest MCP result `describe_mode`, 20,692
bytes with Grok's envelope.

| task | role | engine | model | effort | duration | outcome |
|---|---|---|---|---|---|---|
| `99215630…` | planner | codex | gpt-6-luna | medium | 24 s | plan |
| `d366adf2…` | plan-reviewer | grok | grok-4.7 | medium | 92 s | approve |
| `a4c77994…` | implementer | claude | claude-sonnet-5 | medium | 28 s | 95 → 98 tests |
| `b04f904a…` | code-reviewer | grok | grok-4.7 (read-only, in the worktree) | medium | 62 s | ready, `1a56f2a` |

`tools/e2e-verify.mjs --since 99215630… --slug t15-e6` under `dev-team`: 8 pass, 0 fail, 0 without
evidence. Deviations: none from the loop.

### E7 — one `dev-team-engine` task under a Grok host, a Claude lead

Task "add `slug_title(text) -> str` … use the slug `t15-e7`". Host 501 s, 8 turns, $0.068: the skill
read with Grok's `read_file`, `describe_mode` (the largest MCP result, 25,836 bytes with the
envelope), `list_roles`, the roster, one `delegate` of the lead, one `wait` (459.6 s → done),
`result`; no shell command, no loop step.

| task | role | engine | model | effort | duration | outcome |
|---|---|---|---|---|---|---|
| `46e6d4aa…` | lead | claude | claude-sonnet-5 | medium | 462 s | the loop, no ask; closing report through `result` |
| `73f83ac5…` | planner | codex | gpt-6-luna | medium | 36 s | plan |
| `eba563ca…` | plan-reviewer | grok | grok-4.7 | medium | 96 s | revise |
| `fc53f286…` | planner (`resume`) | codex | gpt-6-luna | medium | 26 s | revised plan |
| `b175523c…` | plan-reviewer (round 2) | grok | grok-4.7 | medium | 132 s | approve |
| `54bfee1e…` | implementer | claude | claude-sonnet-5 | medium | 21 s | 98 → 101 tests |
| `1d90f728…` | code-reviewer | grok | grok-4.7 (read-only, in the worktree) | medium | 57 s | ready, `90281e2` |

`tools/e2e-verify.mjs --since 46e6d4aa… --slug t15-e7`: 8 pass, 0 fail, 0 without evidence. Depth
and lineage: PASS. `result` = the result file byte for byte; the closing message opens with it;
every specialist line in `cross-agent report`'s seven fields with its duration; `cross-agent report`
renders all seven `passed`. Re-run under this configuration, E6's range (eleven records, cap 2) also
reads 8 pass — a combined record check.

### Depth, from the MCP server's position (Grok host)

| host | processes from the server to pid 1 | row served |
|---|---|---|
| `grok` started with `setsid --fork` (A1, B0, B3, E6, E7) | 4 (`node`, `grok`, `systemd --user`, `init`) | operator |
| the same, `CROSS_AGENT_DEPTH=1` exported and no task (`b4-depth1`) | 4 | specialist, five tools: "CROSS_AGENT_DEPTH present and no record matches" |
| the same command from an agent session's own shell, no `setsid` | 11 (`node`, `grok`, `timeout`, `bash`, `claude`, `bash --posix`, `sh -c`, `ghostty`, `nautilus`, `systemd --user`, `init`) — 10 without the run's `timeout` wrapper | operator, fourteen tools |
| Grok at a terminal; the desktop app | not run: the user's hands | — |

### Probes

- **The attach (A0–A2)**: no `--plugin-dir` on the headless `grok`; the project plugin path reads the
  Claude manifest in place, skill and inline server; no `~` expansion in `paths`; the cap line;
  `.grok/` kept out of git, since Grok takes a linked worktree as its own trusted project.
- **I1 (B0)**: Claude no MCP tool; Codex nothing of ours (no `codex_apps` either); Grok exactly the
  five, `delegate` never attempted, and the launcher skill offered to it at the root; the Grok
  child's server served the specialist row with "its environment cannot be read" from inside
  bubblewrap.
- **I2 (B0) and the read-only row (B2)**: every outside write denied on all three; Claude and Grok
  reach the network, Codex not (`curl: (6)`); Grok's pointer rewrite refused by `verify_worktree`; at
  the root the read-only Grok child's cwd, `.git`, `$HOME` and sibling writes denied, `/tmp` and
  `~/.grok` its exceptions, its network cut.
- **A deny rule (B1, a driver run)**: gates a Grok child's calls to this server, does not hide the tools.
- **The ten-minute wait (B3)**: 600.003 s by Grok's own record under its 6000 s default, intact.
- **Environment (B4)**: Grok hands a stdio server the session's whole environment plus
  `GROK_SESSION_ID`; layer 2 under a Grok host rests on that pass-through.
- **The worktree mount (B5)**: a Grok specialist in a linked worktree mounts no server of ours, nor
  gets the launcher skill, while `.grok/` is ignored: none of the three in worktrees listed the
  skill, and all seven at the root did.
- The operator's Claude Code plugin hooks run inside Grok children (the controller's bead).

### The sample at close

`dev-team-engine`, `limits.maxDepth` 2, the lead on claude/claude-sonnet-5, the planner on
codex/gpt-6-luna, the plan reviewer and code reviewer on grok/grok-4.7 (the code reviewer read-only),
the implementer and `consult` on claude/claude-sonnet-5, all at medium. `main` at `90281e2`, clean,
the root worktree alone, 101 tests green; 40 records. `.grok/` ignored; `.grok/config.toml` repointed
at the root checkout: `[plugins] paths = ["/home/wsh/Documents/agent-team-cli"]`, `enabled =
["cross-agent"]`, `[mcp] max_output_bytes = 100000`; `grok mcp doctor cross-agent` reports fourteen
tools.

### Cost of the recorded runs

$2.79 on the subscriptions: hosts $0.740 (two B4 hosts unrecorded), specialists $2.045 (E7 $1.086,
E6 $0.291, B0 $0.533). Codex specialists 682,863 tokens in / 4,839 out. Fix round 1 and the wrap-up ran no engine.

Note: the M1 paragraph's line "Grok's `--prompt-file` fallback is `--help`-verified only (T15)" was
answered before T15, by T13's E2BIG fix and 6b's A5 (`docs/probes.md#grokRulesBesidePromptFile`).

## T11 — the docs nits and the small follow-ups (merged 2026-10-01)

| what | value |
|---|---|
| merge | `main` at `71696ff`: `task/cross-agent-m3` rebased onto `main` and fast-forwarded — twenty commits over `0f8374c` (the task's nine, fix round 1's seven, the wrap-up's four) |
| `npm test` at the root | 769 tests: 768 pass, 0 fail, 1 skipped (`#codexI2Real`), on `main` at `71696ff` |
| citation checker | 1257 citations in 2 files (0 by line, 1257 by symbol), 0 misses; `--since 17de337`: 0 drifted, 0 not judged (at `17de337`: 1199, 37 by line) |
| temporary directories | `ls -1d /tmp/* \| sort` around one `npm test`: 42 new entries at `17de337` (39 empty `cross-agent-bin-*`, 3 `cross-agent-*` projects), as at `6a13c0c` and `157b6b4`; 0 at `b717c92`, `6bb6122`, `0e19e65`, `8040e3a` and `2124be0` (merged as `b4f8f52`, `5b6531a`, `caaa328`, `7d5d902` and `71696ff`) |
| reconcile | `bash -c 'for i in 1 2 3 4 5; do timeout 180 node --test tests/reconcile.test.ts \|\| exit 1; done'`: exit 0, five `ℹ pass 33`, 0 fail, 8.3 s each, no `ENOTEMPTY`, nothing under `/tmp/cross-agent-reconcile-*` and no helper left, at `2124be0` (merged as `71696ff`) |
| beads | `atc-s96.42`, `.45`, `.58`, `.63`, `.65`, `.67`, `.68`, `.75` |

Landed: the design's last 37 line citations as anchors (0 by line), and the checker's header naming
its lexer limits and their causes, pinned; a sandbox profile the engine does not declare refused
naming the engine once; the README's loop guard as built, the three built-in modes, Codex's trust
entries; `Reconciled.errors` documented as reported; Claude Code's refused foreground `sleep` in the
CLI facts; the delegate-literal check reading top-level keys; no temporary directory left by the
suite, reconcile's teardowns drained in order before the directory goes, and a hand-spawned helper
heard and cleaned up from its spawn; a damaged ask read by id a refusal naming the file, an
answered or cancelled ask with a time no date can hold refused with that time as its number, and a
lead's `list_asks` naming only its own lineage's damaged files; the ledger's exclusions written
whole ahead of the first project lock, through a link and at their mode, raced at a barrier whose
failed child fails the wait, and `cancel` looking before it locks; a host's project configuration
(`.claude/`, `.codex/`, `.grok/`, `.mcp.json`, in any case) refused at the worktree's commit — and
changed under an assume-unchanged mark, though not for the mark alone — and at the root's merge,
which names every path, the loops naming it; one source for the statuses, the id alphabet and the
runner log path.

### The uninitialized repository, by hand

Run first at `6bb6122` (merged as `5b6531a`), and re-run against an export of `8040e3a` (`7d5d902`) and at `2124be0` (`71696ff`), each byte for
byte identical; output verbatim but for two paths, `<worktree>` the task worktree and `<scratch>`
the scratch directory's absolute path in the one line that prints it:

    $ git init -b main uninit && git -C uninit commit --allow-empty -m init
    $ sha256sum uninit/.git/info/exclude
    6671fe83b7a07c8932ee89164d1f2793b2318058eb8b98dc5c06ee0a5a3b0ec1  uninit/.git/info/exclude
    $ node -e 'import("<worktree>/src/tasks.ts").then((m) => m.cancel(process.argv[1], "no-such-task")).then((r) => console.log(JSON.stringify(r)))' uninit
    {"ok":false,"reason":"no task no-such-task"}
    $ test ! -e uninit/.cross-agent; echo $?
    0
    $ sha256sum uninit/.git/info/exclude
    6671fe83b7a07c8932ee89164d1f2793b2318058eb8b98dc5c06ee0a5a3b0ec1  uninit/.git/info/exclude
    $ git -C uninit status --porcelain --untracked-files=all | wc -l
    0
    $ node -e 'import("<worktree>/src/gitmutate.ts").then((m) => m.gitMutate(process.argv[1], { slug: "s", args: ["status"] }, { waitSeconds: 1 })).then((r) => console.log(JSON.stringify(r)))' uninit
    {"ok":false,"reason":"Cannot resolve the project root and worktree path: ENOENT: no such file or directory, realpath '<scratch>/uninit/.worktrees/s'"}
    $ git -C uninit status --porcelain --untracked-files=all | wc -l
    0
    $ grep -c cross-agent uninit/.git/info/exclude
    1
    $ ls -A uninit/.git/info
    exclude
    $ ls -A uninit
    .cross-agent
    .git

The cancel locks nothing and writes nothing; `git_mutate`'s `spawn.lock` makes `.cross-agent/locks/`
and finds it already excluded, with no temporary left beside `exclude`.

### Tests

`tests/citations.test.ts#lexerContinuedString`, `#lexerRegexAfterParen`;
`tests/spawn.test.ts#spawnRefusesProfileOnce`; `tests/reconcile.test.ts#teardownDrainsAll`,
`#handSpawnedHelper`; `tests/mailbox.test.ts#readAskDamaged`, `#askTimeOutOfRange`;
`tests/server.test.ts#listAsksLeadDamaged`, `#answerToolTimeOutOfRange`;
`tests/cli.test.ts#answerDamagedAsk`, `#answerTimeOutOfRange`;
`tests/tasks.test.ts#cancelUnknownWritesNothing`;
`tests/gitmutate.test.ts#gitMutateUninitializedExcluded`, `#commitRefusesHostConfig`,
`#hostConfigAnyCase`, `#commitRefusesAssumeUnchanged`, `#commitUnderIgnoreStat`;
`tests/gitroot.test.ts#mergeRefusesHostConfig`, `#mergeHostConfigAnyCase`, `#mergeNamesEveryPath`;
`tests/skills.test.ts#loopsNameHostConfig`, `#delegateKeysTopLevel`;
`tests/ledger.test.ts#excludeLedgerIdempotent`, `#excludeLedgerConcurrent`, `#excludeLedgerKeepsFile`,
`#taskStatusesOneSource`; and `list_tasks`'s status enum read from `taskStatuses`
(`tests/server.test.ts`).

Deviations: A5's matcher became a top-level key reader (R1-7), because the launcher's
`delegate {role, brief, cwd}` is shorthand and `skills/` was out of scope; the design's "Four
locks" and "base64url" ids were corrected beside the passages this task changed; R1-2 landed as
the controller ruled, keeping the asks' time policy T16 chose; an assume-unchanged host file is
refused only when its bytes differ from the index (W-2), since `core.ignoreStat` marks every
tracked file.

## T12 — the final review's fixes, merged (2026-10-02)

| what | value |
|---|---|
| merge | `main` at `7bf9731`: `task/cross-agent-m3` rebased onto `main` and fast-forwarded. It carries 22 commits over `4a25ed8`: fix round 1's nine, fix round 2's seven, the escalation's one, the wrap-up's four, and one that names fix round 1's head by its rebased SHA in `docs/probes.md` |
| review | three independent reviews of `4bcc986..416165c` (162 commits), then of each fix diff with the whole range judged again: four rounds, with one escalation pass after the second fix round. Findings, triage and rulings are in T12-R1-1 … R1-9, R2-1 … R2-9, R3-1 … R3-7 and W-1 … W-7, and the dispositions are in Decision 0011 |
| `npm test` at the root | 813 tests: 812 pass, 0 fail, 1 skipped (`#codexI2Real`), on `main` at `7bf9731` |
| citation checker | 1300 citations in 2 files (0 by line, 1300 by symbol), 0 misses; `--since 4bcc986`: 0 drifted, 0 not judged |
| engines (probes and E8) | Claude Code 2.1.286, codex-cli 0.160.0, grok 1.0.46; `claude-sonnet-5`, `gpt-6-luna`, `grok-4.7`, each at medium |
| records | `docs/probes.md#t12Fix1`, `#t12Fix2`; raw evidence `~/.cache/agent-team/probe-logs/close-2026-10-02/{fix1,fix2,wrapup}/` |
| archived verdicts | every archived run (15: E1, E3, E2, E2b, E2c, I1–I5, E4–E8) and every archived record judged alone (121) reads the same condition-8 row and exit under each round's verifier as under the one before it |
| sample at close | `main` at `15f7b28`, 105 tests, clean, the root worktree alone, 44 records; config and `.grok/config.toml` as before the rounds |
| cost | fix round 1 $3.63 on the subscriptions, with Codex at 38,641 tokens in and 294 out; fix round 2 $0.554; the escalation and the wrap-up ran no engine |
| beads | `atc-s96.57` (its probe ran: `--setting-sources project` drops the operator's plugins, skills and commands) |

Landed:
- **The Claude adapter.** The probe ran before any change and confirmed the gap. A writable role's Write tool wrote the root, its `.git`, `.cross-agent/`, `$HOME` and its own `.git` pointer, and a read-only role's `EnterWorktree` made a worktree and a branch. Every Claude role now runs `dontAsk`, with:
  - a `--tools` allowlist (read roles: `Bash`, `Read`, `ToolSearch`; edit roles add `Edit`, `Write`, `NotebookEdit`);
  - `--setting-sources project`;
  - permission rules that allow `Read`, allow `Edit` in the role's own workspace, deny the protected paths by name, and allow this server's tools for a lead.

  Rerun through the product, fresh and resumed, every outside write was refused, the in-workspace control was written, and `EnterWorktree` was absent. `cross-agent`, `node <repo>/src/cli.ts` and a configured bin, as deny targets on Claude and Grok, were refused fresh and resumed.
- **Host configuration.** It must be regular files. A symbolic link at or under `.claude/`, `.codex/`, `.grok/` or `.mcp.json`, in any case, is refused by name:
  - at a worktree commit, from its tree, index or working tree (ignored links and names that are not UTF-8 included);
  - at the root's merge, from the branch's tree. That read lists only the four pathspecs, and 150,000 files merged in 394 ms.

  A host link the operator keeps at the root, outside git, is outside the guard; design section 4 states this boundary.
- **The verifier.** Each line answers `?` beside an engine's name unless noted:
  - wget's askpass program and the program options of sort and rg are read against whole option tables;
  - Claude and Grok tool calls are read against each engine's archived vocabulary, and `use_tool` only in its recorded shape;
  - a file or program the environment names;
  - node's code-loading options (module loaders, env and config files, `--run`, snapshots, the OpenSSL config) and its unknown options;
  - a server launch written as an `--entry-url` URL is a launch;
  - every way bash writes a variable that the grammar does not read: builtin destinations, namerefs, `{NAME}` redirections, `${NAME:=}`, and arithmetic wherever bash evaluates it.
- **Smaller fixes.** The CLI, the server and the runner find their entry point by real path. `verify_worktree` reads a relative path against the project root, and both loops' worktree path is absolute. The Codex fallback carries `startup_timeout_sec = 30`. A damaged ask whose id fails the alphabet is invalid.

Accepted limitations, by the user's word (2026-10-02), each documented in design section 3 or 4 and the README:
- a project's tracked `.claude/settings.json` reaching every Claude role. Its file-tool allow rules beyond the workspace and its `additionalDirectories` would pre-approve what `dontAsk` refuses, and Claude Code applies them only in a trusted workspace; the untrusted sample dropped them, and the trusted case was not probed;
- `dontAsk` refusing Claude Code's sensitive paths inside a workspace;
- no network from a sandboxed Claude shell;
- Grok's `.git` pointer, checked rather than protected;
- the operator's Claude Code plugin hooks inside Grok specialists (`atc-s96.76`);
- Grok specialists at an attached root offered the launcher skill (`atc-s96.78`).

### E8 — one `dev-team` task under a Claude Code host, every specialist on Claude

| | |
|---|---|
| host | `claude -p --plugin-dir <worktree>`, `claude-sonnet-5` medium, host placement, 28 turns, 193.8 s, $0.693 |
| slug, commit | `t12-e8`, `15f7b28` (`main` 90281e2 → 15f7b28), 101 → 105 tests |
| `wait` | four, each `done`: 31, 19, 24, 23 s |
| specialists | planner 31.4 s, plan reviewer 19.3 s approve, implementer 24.1 s, code reviewer (read-only, in the worktree) 22.5 s ready; all Claude, $0.420 |
| live argv | all four: `dontAsk`, the role's `--tools`, `--setting-sources project`, `--strict-mcp-config`; the worktree specs carry `protectedPaths` |
| verdict | `e2e-verify --since 98acff45… --slug t12-e8`: 8 pass, 0 fail, 0 without evidence |
| deviations | no roster before the first dispatch; the narration and `log.md` named `codex`/`grok` for three Claude roles (`atc-s96.66`); no `resume` ran |
| not exercised | a resumed specialist, a Codex or Grok specialist, engine placement |

### Corrections to earlier sections

Applied in place at this merge:
- **The M1 paragraph.** Its "Not run yet" sentence now says that Grok's `--prompt-file` fallback ran at 6b (`docs/probes.md#grokRulesBesidePromptFile`), and T15's note now points at "the M1 paragraph's line".
- **Rebased-away SHAs.** Each is named beside the merged commit that carries it:
  - the M3 citation row's `39505aa` (`2de4f84`);
  - the 6b merge row's `0f9ff3a` (`af0f266`);
  - T11's `b717c92` (`b4f8f52`), `6bb6122` (`5b6531a`), `0e19e65` (`caaa328`), `8040e3a` (`7d5d902`) and `2124be0` (`71696ff`).

## Close of the plan (merged 2026-10-02)

| what | value |
|---|---|
| merge | `main` at `8074e8f`: `task/cross-agent-m3` rebased onto `main` and fast-forwarded. It carries three commits over `60fa393`: Decision 0011, E9's record, and 0011's pass for E9 |
| `npm test` at the root | 813 tests: 812 pass, 0 fail, 1 skipped (`#codexI2Real`), on `main` at `8074e8f` |
| citation checker | 1306 citations in 2 files (0 by line, 1306 by symbol), 0 misses; `--since 4bcc986`: 0 drifted, 0 not judged |
| final review | three independent reviews in four rounds, over `4bcc986..416165c` and then each fix. Round 1 found 3 Critical, 3 Important and 9 Minor; every finding's disposition is in Decision 0011 and the T12 section above |
| fix runs | `docs/probes.md#t12Fix1` (the probe, the Claude line that ships, E8), `#t12Fix2` (a project's own Claude settings, the network, the sensitive paths), `#t12Fix3` (E9) |
| decision | go with conditions, by Decision 0011 |
| beads | `atc-s96.18` |

Decision 0011's conditions:
- (a) a Codex host names its project in `CROSS_AGENT_PROJECT`;
- (b) a Grok host trusts the folder, keeps `[plugins]` and the result cap in an ignored `.grok/config.toml`;
- (c) where a Grok role runs read-only on a rootful-podman Linux machine, `/run/podman` is at 0711;
- (d) where a Claude role runs on Linux, `bwrap` and `socat` are installed with the AppArmor profile.

### E9 — one `dev-team-engine` task under a Claude Code host, a Claude lead on the shipped line

| | |
|---|---|
| host | `claude -p --plugin-dir <root checkout>` at `main` `60fa393` (the code of `7bf9731`), `claude-sonnet-5` medium, engine placement, 9 turns, 494.9 s, $0.262 |
| engines | Claude Code 2.1.286, codex-cli 0.160.0, grok 1.0.46; `claude-sonnet-5`, `gpt-6-luna`, `grok-4.7`, each at medium; E7's configuration, unedited |
| slug, commit | `t12-e9`, `5f391d4` (`main` 15f7b28 → 5f391d4), 105 → 109 tests |
| host `wait` | one, `done`: 453.6 s by its transcript, `elapsedSeconds` 456 |
| lead | `9979292e…`, claude, 456 s, $0.676, no ask; six `wait`s, each `done`: 23.1, 79.2, 9.0, 64.1, 27.1, 45.1 s by its transcript |
| specialists | planner (codex) 25 s; plan reviewer (grok) 82 s revise; planner `resume` 20 s; plan reviewer 67 s approve; implementer (claude) 29 s; code reviewer (grok, read-only, in the worktree) 48 s ready; $0.340, Codex 160,159 tokens in / 1,569 out |
| live argv | the lead: `dontAsk`, `--tools Bash,Read,ToolSearch`, `--setting-sources project`, `--strict-mcp-config`, `--mcp-config` the lead mount, allow `Read` and `mcp__cross-agent`; 31 MCP calls, none refused. The implementer: `dontAsk`, the edit `--tools`, the same two flags, `Edit` allowed in its worktree and denied on both `.git` paths |
| verdict | `e2e-verify --since 9979292e… --slug t12-e9`: 8 pass, 0 fail, 0 without evidence; depth and lineage PASS |
| deviations | host: no roster (`atc-s96.66`); no `result`, closing on `wait`'s tail (whole here) with a sentence before the report. Lead: no `list_roles`, so its report names the Codex planner `claude`/`claude-sonnet-5` (`atc-s96.95`); `result` after the planner's waits only |
| not exercised | an ask and the headless host's resume, a resumed Claude specialist in a loop, a read-only Claude specialist under engine placement, a rebase that moved the branch |

## T13 — a branch worktree as a project of its own (`atc-s96.97`), merged (2026-10-03)

| what | value |
|---|---|
| merge | `main` at `1c75090`: `task/worktree-projects` rebased onto `main` and fast-forwarded, 45 commits over `08047f1`. They are the implementation (15), fix round 1 (13), fix round 2 (9), E10's record and its attribution (2), and the wrap-up (5), and one that names E10's build by its rebased SHA in `docs/probes.md` (`7907167` merged as `de14c23`) |
| review | three independent reviews of the implementation, then of each fix diff with the whole range judged again. There were three rounds and no escalation pass: the third found nothing Critical or Important, and a wrap-up fixed its Minor findings |
| `npm test` at the root | 933 tests: 932 pass, 0 fail, 1 skipped (`#codexI2Real`), on `main` at `1c75090` |
| citation checker | 1458 citations in 2 files (0 by line, 1458 by symbol), 0 misses; `--since 66e8815`: 0 drifted, 0 not judged |
| engines (E10) | Claude Code 2.1.286, node 24.11.0, git 2.43.0; every role `claude-sonnet-5` at medium |
| records | `docs/probes.md#worktreeProjects`; raw evidence in `~/.cache/agent-team/probe-logs/t13-e10/` (352 files, `MANIFEST.sha256` verified) |
| sample at close | `main` at `ba496c7`, 113 tests, clean, the root worktree alone; `feature/dotted` kept at `0ed8097`; the config restored `cmp`-equal; `.git/cross-agent.lock` (empty) left by the repository lock |
| cost | E10 $2.631 on the subscription: each project's host and loop $1.25 and $1.24, the containment probe $0.14 |
| beads | `atc-s96.97` closed. Follow-ups: `.98` (cancelling a running git child), `.99` (worktree projects inside the main checkout), `.100` (writes at a separated main or a submodule), `.101` (widen `nameFault`), `.102` (`describe_mode` warns when the server's own working directory lies in another initialized project) |

Landed:
- **A worktree as a project.** `cross-agent init` run in a linked worktree, or in a bare repository's worktree, makes it a project of its own. It gets its own `.cross-agent/`, and its default branch is the branch it has checked out.
  - **What `init` copies:** the main checkout's config, or `--from <dir>`'s, with `defaultBranch` replaced, and the main checkout's Grok attach. The attach is copied through no link, into no existing entry, and never when it binds a project.
  - **What `init` refuses:** a detached HEAD, a branch outside `nameFault`'s alphabet, or one matching the mode's task pattern.
  - **An uninitialized worktree** keeps today's mapping to its main project.
- **The repository, located from outside it** (`src/worktree.ts#locateRepository`). A root is `main`, `linked`, `bare-linked`, `unsupported` or refused.
  - **Nesting:** decided from the candidate's ancestors, by each ancestor's own git and registry, before any config is read. A task worktree, its pointer intact, deleted or replaced, is never a project root.
  - **Allowed layouts:** the umbrella `.bare` layout, a bare `U/.git`, and `repo.git` beside its worktrees.
  - **`unsupported`:** a separated main, a submodule and a symlinked `.git` take no writes, and their root roles launch protected.
- **Writes at a root that is not the main checkout** need the opt-in, through `src/worktree.ts#rootWriteFault`:
  - every `run_command` there needs an initialized root;
  - every write also needs the default branch checked out, and no detached HEAD.
- **The repository lock** `<commonDir>/cross-agent.lock`. It is held by every `git_mutate`, every root verb that changes the repository, and the discard, and it is innermost in the order `spawn.lock`, `git.lock`, the repository lock. It waits at least sixty seconds. A loss is reported as `lockLost`, cleanup paths included.
- **Protected paths per root kind.** At a non-main root, root roles get `[<root>/.git, commonDir]` and worktree roles also get the root's `.git`.
- **Closed journals are terminal,** and `branch -d` holds the branch to the tip its open journal last recorded. A name another project reused cannot be deleted by a retried cleanup.
- **`cross-agent git-root`,** the operator's cooperating path for root git while a loop runs.
- **The launcher.** `describe_mode` carries `projectRoot`, and the launcher shows it with the roster and stops before dispatch when the working directory lies in another initialized project.
- **The verifier.** Rows 1 and 2 are scoped to the project: siblings' worktrees and branches are named and ignored, and unknown ownership is `?`.
- **Single-checkout behaviour changed only where stated:**
  - a symlinked `.git` is `unsupported`: root roles launch protected, while worktree roles and one-shots are refused;
  - a one-shot whose record write fails is refused, carrying the discard's account;
  - `branch -d` refuses a branch that moved from its journal's recorded tip.

### E10 — a main checkout and a branch worktree as two projects of one repository, at once

| | |
|---|---|
| layout | the sample's main checkout on `main`, and `../slugkit-feature` on `feature/dotted`, made with `git worktree add` and initialized by `cross-agent init` (the config copied with `defaultBranch: feature/dotted`; the Grok attach copied byte for byte) |
| hosts | two `claude -p --plugin-dir <worktree>` hosts, started 0.02 s apart, one per root, `claude-sonnet-5` medium, engine placement, every role on Claude |
| slugs, commits | `t13-e10-main`: `main` `5f391d4` → `ba496c7` (`slug_pascal`), 109 → 113 tests. `t13-e10-feature`: `feature/dotted` `5f391d4` → `0ed8097` (`slug_constant`), 109 → 112 tests |
| leads | main `de51b90d…`, 176 s, $0.534; branch `dbbe6608…`, 212 s, $0.547. Each ran planner, plan reviewer, implementer and code reviewer, then merged at its own root and ran the suite there |
| verdicts | `e2e-verify --project <each> --slug <each> --since <each lead>`: 8 pass, 0 fail, 0 without evidence, in both |
| containment | a read-only `consult` at the branch root wrote into neither the common directory, nor the branch's admin directory, nor `FEAT/.git`, nor the root, nor its `.cross-agent/`. All five writes failed in the sandbox with "Read-only file system", and `Write` was not in its tool list. The launch carried `protectedPaths` `[FEAT/.git, MAIN/.git]` |
| cross-project facts | the registry held both roots and both task worktrees at once (22:51:55Z); each merge sits in its own root's HEAD reflog alone; the ledgers, journals and `.worktrees/` are disjoint; `info/exclude` holds each line once, unchanged; `~/.codex/config.toml` unchanged by sha256 and mtime |
| `~/.grok` | every readable configuration, auth and trust file unchanged. The two files that changed are the log and memtrace of the operator's own `grok` process (pid 1171929). The 86 unreadable `sandbox-blocked.<pid>` files kept their mtimes. The brief's "unchanged by sha256" is met in purpose, not in letter |
| deviations | neither host printed the full roster, and the main host's line named no path; the branch host relayed `wait`'s tail as the lead's report; the restore was a script run at the end, not a trap; the probe ran twice, to record the live argv |
| not exercised | lock contention between the projects (no two root or mutation calls overlapped; the deterministic tests prove the serialization), `ask`, a resumed role, a rebase, a bare repository, a separated main, `--from`, `cross-agent git-root`, any engine but Claude |

## `atc-s96.104` — N code reviewers by seat, the resolver, the two merge guards (merged 2026-10-03)

| what | value |
|---|---|
| merge | `main` at `7de15c0`: `task/team-modes` rebased onto `main` and fast-forwarded, 15 commits over `823c884`: the implementation (13), fix round 1 (1) and the wrap-up (1) |
| review | two independent reviews of the implementation, then of the fix diff with the whole range judged again. Two rounds and no escalation pass: round 1 found 3 Critical, 1 Important and 3 Minor; round 2 found nothing Critical or Important, and a wrap-up fixed its two Minor findings |
| `npm test` at the root | 1006 tests: 1005 pass, 0 fail, 1 skipped (`#codexI2Real`), on `main` at `7de15c0`. The first root run hung in `tests/server.test.ts` while an empty `/tmp/.git` existed, left by a Codex sandbox (`atc-s96.106`); it was stopped and rerun with `/tmp/.git` absent throughout |
| citation checker | 1608 citations in 2 files (0 by line, 1608 by symbol), 0 misses, at `7de15c0`; `--since 92b35be`: 0 drifted, 0 not judged. 1631, 0 misses, with E11's record (`c4ca8e5`) |
| engines (E11) | Claude Code 2.1.288, codex-cli 0.160.0, grok 1.0.46, node 24.11.0, git 2.43.0; every role on a cost-effective model at medium |
| records | `docs/probes.md#e11Seats`; raw evidence in `~/.cache/agent-team/probe-logs/t15-e11/` (188 files, `MANIFEST.sha256` verified) |
| sample at close | `main` at `f9eaf26`, 116 tests, clean, the root worktree alone, no `task/*` branch; the run's config kept (three code reviewer seats and the resolver); `feature/dotted` kept at `0ed8097` |
| cost | E11 $1.555 on the subscription by its result lines; the three Codex records report tokens only (214,073 in, 2,606 out) |
| beads | `atc-s96.104` closed. Follow-ups: `.105` (deliberate self-subversion of the guards, a documented limit), `.106` (an invalid `.git` in an ancestor refuses every project below it; the stray `/tmp/.git` is made by Codex's Linux sandbox) |

Landed:
- **Code reviewer seats.** `roles.code-reviewer` may be a list of bindings, one seat each, and an object stays one reviewer.
  - Seats are a mode fact: `"seats": "many"` in `mode.json`.
  - `delegate` takes `seat`, and the duplicate and resume identities include it.
  - Listings spell `code-reviewer#2`.
  - `cross-agent init` binds three read-only seats.
- **The resolver role.** It is delegated once two fix rounds leave Critical or Important findings standing. It is writable in the task worktree and writes no git metadata.
- **Two settings, both read through `describe_mode`'s `review`:**
  - `limits.planReviewRounds`, default 3: after that many consecutive major plan reviews, the loop asks;
  - `review.afterResolver`: `ask` (the default), `lead-decides` or `always-ask`.
- **The loop text.** The plan iteration and the review and fix rounds are short procedures with a "stop and ask the user" fallback. The convergence rules:
  - findings outside the brief and acceptance are follow-ups;
  - re-review findings are marked carried, introduced or newly noticed;
  - a stop at a limit shows the findings per round, a convergence verdict and four options (fold and proceed, one more round, simplify, pause);
  - the planner plans the smallest change that meets the acceptance.
- **Guard 1, the test gate.** `git_root merge` acts on one resolved head and refuses it without a `tested` step for that exact head. A worktree test run tests a detached checkout of the branch head under `.cross-agent/gate/`, after the setup command, and journals `tested`.
- **Guard 2, the review gate.** Under a mode with a gating role, every seat's finished review of that head must end `VERDICT: no major issues`. The server reads the verdict from the result file itself. Otherwise a `review-waived` step must name that head. Waivers come from `waive_review` or `cross-agent waive`, revalidated under `git.lock`; the lead may waive only under `lead-decides`, after a complete round.
- **What the guards rest on:**
  - a gating review launches only on a committed tree, with no live setup marker;
  - a reviewed worktree is held against writers;
  - the setup marker is published before the command runs, holds until its process group is gone, and is cleared only under `spawn.lock`, by its full identity;
  - `verifyWorktree` refuses paths under `.cross-agent/`;
  - a one-shot needs guard 1 alone.
- **The stated limit.** The guarantee is that no misreading and no accident merges untested or unreviewed work. A lead, or the operator's own session, deliberately racing its tools against the gate is outside it (`atc-s96.105`).

### E11 — three code reviewer seats on three engines under a Claude lead

| | |
|---|---|
| layout | the sample's main checkout under `dev-team-engine`, with three code reviewer seats on `claude-sonnet-5`, `gpt-6-luna` and `grok-4.7`, each at medium effort and read-only. The resolver is bound to `gpt-6-luna` at medium. `planReviewRounds` is 3 and `afterResolver` is `ask`, and every other role is as before |
| host | one `claude -p --plugin-dir <main checkout>` host on `claude-sonnet-5` at medium, with engine placement, built at `13058ed` |
| slug, commit | `e11-seats`: `main` `ba496c7` → `f9eaf26` (`slug_final_letters`), 113 → 116 tests |
| lead | `9c141b35…`, 411 s, $0.815. It ran the planner twice, the plan reviewer once (`no major issues`), the implementer, one review round of three seats at `f9eaf26`, and the merge |
| verdict | `e2e-verify --project <sample> --slug e11-seats --since <lead>`: 8 pass, 0 fail, 0 without evidence |
| seats | seat 1 on claude, seat 2 on codex and seat 3 on grok. Each is `done` at depth 2 with `underReview` `f9eaf26`, and each result ends `VERDICT: no major issues`. All three were alive together for 14 s |
| guards | `tested` at `f9eaf26` came before the seats' records and before `merged`; `merged.branchHead` equals the last `tested.after`; no `review-waived` |
| `cross-agent report` | `code-reviewer#1 \| claude …`, `#2 \| codex …`, `#3 \| grok …` |
| host config | `~/.codex/config.toml` is unchanged by sha256 and mtime. In `~/.grok`, the config, auth and trust files are unchanged; the engines' session files and logs were added |
| deviations | **116 tests, not the brief's 117:** the host's brief to the lead named three test cases; all four acceptance examples hold. **The host:** its roster was a prose paragraph, and it relayed the lead's report with the last paragraph reworded. **The lead:** it read the seats' reviews from `wait`'s tail rather than calling `result`, and the merge guard reads the result files itself |
| unproven | the refusals (the deterministic tests prove them), the waiver and `afterResolver`, the resolver (bound, never delegated), D2's limit, the wrap-up, a `needs rebase` verdict, consolidation across seats (there was no finding), the setup marker and the hold (no setup command, and no writer during a review), and the host loop's text |


## atc-s96.106 — empty ancestor git directories (verified 2026-10-03)

| what | value |
|---|---|
| state | working-tree changes on `main` at `9f766aa`, uncommitted |
| subsequent commit | `c492021`, after a fresh focused run passed all 66 worktree/project tests and citations had no misses or drift |
| regression cycle | eight new cases failed before the fix and passed after it |
| focused tests | `node --test tests/worktree.test.ts tests/project.test.ts`: both files pass |
| full suite | unchanged `npm test`: 1014 tests, 1013 pass, 0 fail, 1 skipped (guarded real Codex I2), 187.4 seconds |
| citation checker | 1636 citations in 2 files, all by symbol, 0 misses |
| review | one independent read-only review; no findings |

The user approved a narrow exception in `enclosingWorktree`: skip an actual,
readable, empty ancestor `.git` directory. Continue checking deeper ancestors;
keep Git verification for other entries, refusal on read failures, and the
candidate root's own validation. Regression coverage includes main and linked
roots, a config-only root, a nested task with its pointer intact or deleted, an
empty candidate `.git`, and unreadable `.git`, `HEAD`, `objects`, and `refs`.
The existing malformed-gitfile coverage remains.

The passing full run used a temporary user service with the same Node 24 runtime
and no test filtering. The shared `/tmp/.git` stayed present and empty. Earlier
runs exposed two validation-environment problems: the app sandbox lost asynchronous
Node child stdout/stderr, and the direct app context's AppArmor label could not
signal the runner tests' confined `ping` probes. That outside-sandbox run had 1009
passes, four cleanup failures and one skip. The four failed cases were
`cancelDuringRescan`, `settledDuringRescan`, `lockLostDuringRescan`, and
`clearedDuringRescan`; `atc-s96.107` tracks the helper follow-up. The probes were
terminated through a temporary user service, and generated fixtures left by the
failed or interrupted runs were archived. No workaround was added to product or
test code.

Raw evidence: `/tmp/cross-agent-atc106-review-ZRRfyD/`, including `red.log`,
`green.log`, `focused.log`, `full-suite-unsandboxed.log`, and the passing
`full-suite-user-service.log`. `atc-s96.106` is closed; the changes were committed
as `c492021` before work resumed on `.107`.

## atc-s96.107 — cleanup-compatible runner probes (verified 2026-10-03)

| what | value |
|---|---|
| scope | runner test helpers and regression coverage; no production or host security changes |
| prerequisites | `.106` committed as `c492021`, then `.108` as `5b0e529`; runner changes excluded from both |
| regression cycle | seven cases failed before implementation and passed after it; one review regression also went red to green |
| focused tests | 12 pass, 0 fail, 0 skipped, including all four original rescan cases |
| full suite | unchanged `npm test`: 1022 tests, 1021 pass, 0 fail, 1 skipped (guarded real Codex I2), 189.1 seconds |
| execution context | direct desktop context, AppArmor label `chatgpt (unconfined)`, outside the filesystem sandbox to preserve child output |
| citation checker | 1636 citations, 0 misses or drift |
| review | one independent read-only review; one Important finding reproduced and fixed; no Critical or Minor findings |
| cleanup audit | no live probe agents, no live runner-marked processes, no generated runner fixtures |

`unreadableCandidate` uses command-mode ssh-agent with a stdin-controlled command
that exits after at most 60 seconds. An actual SIGKILL of a sacrificial agent
proves cleanup compatibility before the test receives a fresh candidate. The
helper checks ownership, session/group leadership and unreadable environ, reports
specific environment skips, and awaits identity-checked retirement. Every rescan
caller awaits `clear`; the harness also retires probes when an assertion fails.
Cleanup continues after individual signal errors, removes all generated files,
and then reports accumulated errors.

The review found that a command failing before its readiness write could leave
the forked agent alive while reporting a skip. A regression with a real agent
proved it. Cleanup now recovers that agent by its unique socket argument, with
ownership and process-identity checks, before it can claim retirement. The
persistent signal-denial case separately proves retirement through command EOF.

Evidence: `/tmp/cross-agent-atc107-4i7vMg/`, including `107-red-all.log`,
`107-review-red.log`, `107-review-green.log`, `107-runner.log`,
`107-full-suite.log`, and `107-leak-audit.json`. `atc-s96.107` is closed.

## atc-s96.109 — release 0.1.0: MIT, the launcher, the dist, the concise README (verified 2026-10-04)

| what | value |
|---|---|
| commits | `3ddcbb4` MIT and 0.1.0; `974a630` `bin/cross-agent` and its deny target; `b94cb69` `tools/build-dist.mjs`; `25f3789` the publisher and `agent-artifacts.json`; `c2d120c` the README, `docs/install.md`, `docs/operator-guide.md`; review fixes `bc33a8a`, `208c651`, `8099eca` |
| full suite | `npm test` after the review fixes: 1037 tests, 1036 pass, 0 fail, 1 skipped (guarded real Codex I2) |
| citation checker | 1639 citations in 4 files, 0 misses |
| dist | built from HEAD twice, the second over the first; `claude plugin validate` (and `--strict`) passes for the plugin and for a preview marketplace with the root entries; 111 files, about 870 KB per host |
| Claude Code, isolated home | marketplace add and install at user scope, one registry record (`user`, 0.1.0); the cache equals the dist byte for byte, exec bits kept; its server answers `initialize` 0.1.0 and 13 operator tools |
| Claude Code, real session | `claude -p --plugin-dir <installed copy>` ($0.087): `command -v cross-agent` names the plugin's `bin/cross-agent`, and `cross-agent modes` runs |
| Codex, isolated home | marketplace add and plugin add, installed and enabled at 0.1.0; the cache equals the dist; the cached `bin/cross-agent init --mode solo` works; `codex mcp list` shows `./.codex-plugin/serve`; the cached launcher with `CROSS_AGENT_PROJECT` answers `initialize`, 13 tools, and `list_roles` of the named project |
| Grok | a fresh signed-out home lists the per-project `paths` plugin but keeps it `enabled: false`, folders trusted or not, so the mixed-host matrix is inconclusive (`atc-s96.110`); on the real home the documented attach works (e2e sample: plugin enabled, `grok mcp doctor` started it, handshake OK, 15 tools), and the doctor also lists `plugin: context7`, a Claude Code user-scope plugin |
| isolation | the real host configs unchanged after the isolated installs, but for `~/.claude.json`, which the live session rewrites; no `cross-agent@agent-plugins` in any of them |
| plan review | five gpt-6-astra (max) rounds, from the second through cross-agent's own `delegate`, a Fable 5.1 subagent judging rounds 3 and 4; the fifth "ready" |
| release review | gpt-6.1-sol (max) and grok-4.7 (xhigh) through cross-agent, in parallel: R1 (high, a stale output check before the swap), R2, R3, R5, R6 and R7, M1, L2 and R4 fixed with regressions; B1 already in the plan (the root marketplace entries come with the first publication); L1 declined, since the agent-artifact-maintainer skill keeps a non-final system alias under `/` |
| attribution | no `Co-Authored-By: Claude` and no `Claude-Session` trailer in `2415b73..HEAD` |
| release SHA | `f996a46`, rebuilt into a fresh dist and a preview marketplace rebuilt from it; `claude plugin validate` passes; fresh isolated Claude and Codex installs equal the build byte for byte, exec bits kept, the cached Codex launcher answers 0.1.0 with 13 tools |
| publication | `gh repo create WSH95/cross-agent-cli --public`; `git push -u origin main`; `git ls-remote --refs origin` is `refs/heads/main` at `f996a46` alone; GitHub reports PUBLIC, license MIT |
| agent-plugins | https://github.com/WSH95/agent-plugins/pull/16: `5f5d1c5` (`cross-agent/`, 111 files, identical to the frozen build) and `b6cc463` (the two root marketplace entries and README); `claude plugin validate` passes; open and mergeable, not merged; no attribution in either commit |

The release review's race regression was checked by mutation: with the second output check
removed it fails, with it restored it passes. Evidence: this session's scratchpad logs
(`step*-npm-test.log`, `review-fix-npm-test.log`, `claude-probe.json`, `real-configs.*`).
