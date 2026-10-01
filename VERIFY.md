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
