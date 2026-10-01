# Verification record

What `npm test` and the recorded runs showed at each milestone merge into
`main`. Counts live here, not in the README (Decision 0008). Raw engine
transcripts stay in `docs/probes.md`.

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
`--prompt-file` fallback is `--help`-verified only (T15).

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
| citation checker | 823 citations in 2 files (74 by line, 749 by symbol or anchor), 0 misses; `node tools/check-citations.mjs --since 3023e30` and `--since 39505aa` both report 0 drifted, 0 not judged |
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
  is pinned by `tests/authority.test.ts:209` instead.
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
| merge | `main` at `d428145`: `task/cross-agent-m3` rebased onto `main` and fast-forwarded — 24 commits over `cb87b01` (twelve, two fix rounds of six and four, the verifier's class-level rewrite `0f9ff3a`, and the wrap-up) |
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