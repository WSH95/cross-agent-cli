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
Codex is paused by the user (2026-09-18): T13 records its Codex rows as
not run, each with the command that runs it later.

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
| engines | claude 2.1.277, grok 1.0.34. codex-cli 0.155.0 present and **not run**: the user paused the Codex harness on 2026-09-18 |
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

The design's 8-hop limit is **not raised**: it excluded a nested harness, not an
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
- **Not run: every Codex row** — the user paused the Codex harness and its models
  on 2026-09-18. When the pause lifts: `delegate {role: "consult", engine:
  "codex", model: "gpt-5.6-luna", cwd: <sample>}` with I1's listing brief and
  again with `worktree: true` and I2's negative writes (its network row is a
  failure if it succeeds); `node tools/probe.mjs --engine codex --track --project
  <sample> --cwd <sample> --sandbox read-only --model gpt-5.6-luna` for I1(ii);
  and `CROSS_AGENT_REAL_CODEX=1 node --test tests/engines/codex.test.ts` for the
  test that is written and guarded rather than empty. Confirm `gpt-5.6-luna`
  first with `node tools/probe.mjs --engine codex --model gpt-5.6-luna --sandbox
  read-only --cwd <sample> --prompt "reply OK"`, and fall back to `gpt-5.6-sol`.

### Cost of the recorded runs

$2.88 in all, on the subscription: P2 $0.24 and its rerun $0.17, the read-only
row $0.21, the two host tool listings $0.14 and the inline-mount recheck $0.06,
I1 $0.31 with the tracked probe $0.18, its rerun $0.10 and the Grok row $0.03,
I2 $0.33 and the delegated rerun under the fix $0.26, the ten-minute wait $0.15,
E1 $0.73.
