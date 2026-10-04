# Verification record

What `npm test` and the recorded runs showed at each milestone merge into
`main` and at follow-up verification. Counts live here, not in the README
(Decision 0008). Raw engine
transcripts stay in `docs/probes.md`.
The repository was renamed from `~/Documents/agent-team-cli` to `~/Documents/cross-agent-cli`
on 2026-10-03; each section keeps the paths and the Codex plugin names its runs used.

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
