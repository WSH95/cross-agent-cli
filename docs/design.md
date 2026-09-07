<!-- Approved design of 2026-09-07. Source of truth for agent-team-cli; the OpenMausBot pack's history lives in ~/Documents/agent-team-devpack. -->

# dev-team: a standalone multi-engine dev team plugin for Claude Code, Codex, and Grok

## Context

The dev team pack in this repo runs on OpenMausBot. The user asked whether
it could become a plugin or skill for a general-purpose coding agent CLI,
with that CLI as the orchestrator. Research on 2026-09-07 (read-only,
summarised in "Findings" at the end) says yes: about 70% of the pack is
host-independent text, every engine CLI on this machine has a headless
mode with session resume and a sandbox, and the reasons Paperclip was
dropped do not apply to a plugin that composes public CLIs.

Decisions taken with the user:

- Standalone: no OpenMausBot dependency, no chat, no rooms. OpenMausBot code
  (Apache-2.0) may be referenced or ported. Its limits (wake budget, dropped
  wakes, four pending delegations, the 4-minute ask cap, one-hop chains,
  immutable playbooks, the 1,000-character cap) are not constraints.
- One MCP server core, TypeScript on Node 24, attached by every host with
  the same skill text.
- Each CLI's own sandbox is the boundary. No approval broker.
- No time cap on a delegated task; `wait` reports a stall instead.
- Cooperative delegation loops (Claude Code delegates to Codex, Codex
  delegates back) must be impossible in code and tested.
- The user's `agent-plugins` marketplace and the `agent-artifact-maintainer`
  skill are unrelated to this project.
- New repository `~/Documents/agent-team-cli`, plugin name `dev-team`. I
  scaffold it; its feature tasks are M7's "first real repository" for the
  OpenMausBot pack, sent to Sudo one at a time from this session. The new
  repo is not bound by this repo's AGENTS.md (no 500-line ceiling).
- Prose in prompts and briefs stays purposeful; no artificial length limit.

Reviewed twice by Codex gpt-6-astra (effort xhigh) on 2026-09-07. Round
one: twelve findings, all adopted. Round two: ten new findings and nine
partials, all adopted; the two places where the plan takes a narrower
option than suggested are marked "(narrowed)".

## Design

### 1. The `dev-team` MCP server

`src/server.ts`: stdio, JSON-RPC 2.0 written by hand (the subset is
`initialize`, `tools/list`, `tools/call`, `ping`, `notifications/cancelled`;
no dependencies, so the pack's setup command is `none` and Node 24 runs the
`.ts` sources directly). Requests are dispatched concurrently: a pending
`wait` never blocks `check`, `cancel`, or `list_tasks` on the same
connection, and a `notifications/cancelled` for a `wait` aborts it. Tools:

| Tool | Input | Behaviour |
|---|---|---|
| `list_roles` | — | roles from config with engine, model, cwd kind, sandbox profile |
| `delegate` | `role`, `brief`, `cwd`, optional `engine`, `model`, `effort`, `resume` (task id), `force` | under the spawn lock: validates (depth, role, cwd, reservation, running and recent duplicates, resume binding), writes the ledger record as `launching`, starts the runner, returns `task_id` |
| `wait` | `task_id`, `timeout_seconds` (default 600) | returns when the task settles, the timeout passes, or the stall threshold is crossed: `status`, `stalled`, elapsed, last activity line, result tail |
| `check` | `task_id` | non-blocking status and the last activity lines |
| `result` | `task_id` | the final message in full, the engine session id |
| `cancel` | `task_id` | identity-checked termination of the runner's and the engine's process groups |
| `list_tasks` | optional `status` | ledger listing after reconciliation |
| `verify_worktree` | `path`, `branch` | the checks of section 4; returns the explicit git-dir and work-tree to use, or a refusal |
| `git_mutate` | `slug`, `args[]` | the lead's only path for mutating git in a worktree: verify, `flock`, explicit `--git-dir`/`--work-tree`, journal (section 4) |

Statuses: `launching`, `running`, `stalled` (running, no engine event for
`stallMinutes`), `orphaned` (engine alive, runner dead), `cancelling`,
`done`, `failed`, `cancelled`.

### 2. Ledger, runner, locks

- `src/ledger.ts`: `<project>/.dev-team/tasks/<id>.json` written with
  atomic rename, `<id>.ndjson` (the engine's native event stream teed
  verbatim), `<id>.out` (final message). Ids are random. `.dev-team/` and
  `.worktrees/` are added to `.git/info/exclude` on first use.
- Launch protocol: `delegate` writes `launching` with `launchDeadline`
  (now + 30 s) and a launch token; the runner, once started, writes
  `running` with its own identity (pid, start time from `/proc/<pid>/stat`,
  the token on its command line) and the engine's identity (pid, start
  time, process group). Reconciliation may turn `launching` into `failed:
  launch` only after the deadline passes with no runner acknowledgement.
- `src/runner.ts`: a detached process per task that owns the engine child
  in its own process group, tees events, updates `lastEventAt`, and on
  engine exit writes the terminal record and `<id>.out` itself, so
  completion survives the MCP server. Terminal writers: the runner writes
  `done`, `failed`, `cancelled`; the server writes `cancelling` and, only
  when the runner is dead and the engine group is verified dead, `cancelled`
  or `failed`. `cancel` sends SIGTERM to the runner, which terminates the
  engine group and writes `cancelled`; the server escalates to SIGKILL on
  both groups after a grace period.
- Reconciliation (on server start and every `list_tasks`): a `running`
  record whose runner identity is dead but whose engine identity is alive
  becomes `orphaned`; the reconciler terminates the engine group, then
  writes `failed: runner lost`. A worktree reservation is never released
  while an engine identity is alive.
- Spawn lock: `.dev-team/spawn.lock` created with `O_EXCL`, holding pid,
  start time, host name, timestamp, TTL 30 s. It guards `delegate`'s
  validate-and-spawn only (milliseconds). Reclaim of a lock whose holder is
  dead and whose TTL passed is `rename(lock, lock.stale.<random>)` followed
  by a fresh `O_EXCL` create; two reclaimers cannot both succeed, and the
  losing one retries.
- Worktree reservation: a task with a writable sandbox reserves its
  canonical cwd until it settles; `delegate` refuses any other task on that
  cwd meanwhile. `resume` of a task in `launching`, `running`, `stalled`,
  `orphaned`, or `cancelling` is refused ("wait or cancel first").
- Git lock: every lead git mutation runs inside `flock -n
  .dev-team/git.lock` (util-linux, OS-held, released when the git process
  dies), through `git_mutate` or `dev-team git`. Two hosts on one project
  therefore cannot spawn into or mutate the same repository concurrently.

### 3. Engine adapters

`src/engines/{types,claude,codex,grok}.ts`: build argv and env, capture the
session id from the first native event, extract the final message, support
`resume`. Binaries are overridable through config (`engines.<e>.bin`) and
`DEV_TEAM_<ENGINE>_BIN` (tests use fake engines). Every adapter must apply
the configured sandbox or refuse to spawn (fail closed); running without a
sandbox requires `sandbox: "off"` in config. Spawn lines to be pinned by
the Phase 0 probes:

- Claude: `claude -p --output-format stream-json --verbose --model <m>
  --session-id <uuid> | --resume <id> --append-system-prompt-file <role.md>
  --permission-mode <mode> --strict-mcp-config --settings <sandbox json>
  --disallowedTools <deny list>`, cwd = the role's cwd. Sandbox through the
  settings JSON (`sandbox.enabled`, `filesystem.allowWrite`,
  `autoAllowBashIfSandboxed`); bubblewrap is installed. Read-only roles
  get no `allowWrite` and no `Edit`/`Write` tools.
- Codex: `codex exec --json -o <out> -C <cwd> --sandbox
  <read-only|workspace-write> --ignore-user-config --skip-git-repo-check
  -m <m> -c model_reasoning_effort=<e>`; `codex exec resume <thread id>`
  with the same flags for resume. `--ignore-user-config` keeps auth and
  drops the user's MCP servers, plugins, and marketplaces. Probe P3 showed
  that execpolicy rules files are not honoured by `codex exec`, so Codex
  carries no deny list; its sandbox denies network access instead, and a
  launched engine cannot reach its API (probe P3b).
- Grok: `grok -p <prompt> --cwd <cwd> --sandbox
  <workspace|read-only|strict> --permission-mode bypassPermissions
  --output-format json --session-id <uuid> | -r <id> --model <m>` plus one
  `--deny` per deny-list entry, the same on resume.

Deny list for Claude and Grok, rebuilt from config at spawn: the commands
`claude`, `codex`, `grok`, each configured `engines.<e>.bin` path, `node
<absolute path of src/server.ts>`, `node <absolute path of src/cli.ts>`,
and `dev-team`. Forms: Claude `Bash(<target> *)` and `Bash(<target>)`
(enforced under `bypassPermissions`, probe P3); Grok one `--deny
"Bash(<target> *)"` per target (enforced, probe P3). Codex children rely on
the sandbox's network denial (probe P3b). The argv builders are unit-tested
for the exact list; P3 covers each target on each engine, including a
resumed session.

Sandbox facts from the probes that the adapters must respect: Claude's
sandbox needs `bwrap` and `socat`, and prints "Sandbox disabled" when they
are missing, which the adapter treats as a refusal to spawn; Codex and Grok
treat `/tmp` and `$TMPDIR` as writable, so a project there is not isolated
(`dev-team init` warns); Codex refuses to rewrite the worktree's `.git`
pointer, Grok allows it, so tampering is detected by `verify_worktree`, not
prevented; a Grok child inherits the user's MCP configuration, so a
dev-team server started by that child runs at depth 1 and offers no
`delegate` (section 5, layer 1), which is what makes the inheritance safe.

Child env: inherit `PATH`, `HOME`, `XDG_*`, `CODEX_HOME`; strip
`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`,
`CLAUDE_PLUGIN_*`, `CODEX_COMPANION_*`, `GROK_CC_*`, `MCP_*`; unset
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` (config `billing:
subscription`); set `DEV_TEAM_DEPTH`, `DEV_TEAM_TASK`, `DEV_TEAM_LINEAGE`.

### 4. Git ownership

Specialists never write git metadata. A linked worktree's `.git` is a
writable file inside the implementer's sandbox, so the lead never trusts
it: `git_mutate` (and the identical `dev-team git <slug> -- <args>` CLI)
is the only way the skill mutates git in a worktree, and it

1. refuses while any task reserving that path is not settled;
2. verifies, from the root, that `realpath(path)` is a linked worktree in
   `git worktree list --porcelain`, that `git -C <path> rev-parse
   --git-dir` is `<root>/.git/worktrees/<slug>`, `--git-common-dir` is
   `<root>/.git`, and `--abbrev-ref HEAD` is exactly `task/<slug>`;
3. runs `flock -n .dev-team/git.lock git --git-dir=<root>/.git/worktrees/<slug>
   --work-tree=<path> <args>` so the pointer file is never consulted;
4. appends the step to the task journal (section 7) with the SHAs before
   and after.

The lead creates the worktree after plan approval, commits the task branch
with the implementer's summary, rebases it, merges with `--ff-only`, runs
the tests on `<default>`, removes the worktree, deletes the branch. On a
rebase conflict the lead aborts the rebase and escalates to the user
(narrowed: a validated conflict-edit mode is a later enhancement). The
flow per task: plan (root), plan review (root), worktree, implement, lead
commit, code review, needs-work round through `resume`, lead commit,
ready, merge. Branch-scoped metadata grants are not part of this plan.
Under a Codex host the lead's own sandbox protects `.git` too, so
`git_mutate` calls made by a Codex lead need that host's approval
escalation, as EVIDENCE.md recorded for the 0.4.0 Codex lead.

### 5. Loop guard

Scope, stated in the README: no delegation loop can form through
`delegate`; direct engine launches from specialists are denied for exactly
the deny-list forms of section 3 at each CLI's own permission layer (Claude
and Grok), or cannot reach a model API (Codex, network denied by its
sandbox). A
specialist that defeats its own CLI's permission rules (a copied binary, a
wrapper script) is outside the guarantee, as it is for OpenMausBot.
Layers, each with its own unit test:

1. Depth: the server reads `DEV_TEAM_DEPTH` at startup. Absent with no
   `DEV_TEAM_LINEAGE` means 0. Present, malformed, or lineage present with
   depth absent means a child (fail closed). At depth ≥ `maxDepth`
   (default 1) the server registers only `list_roles`, `list_tasks`,
   `check`, and `result`; a `delegate` call by name is answered with an
   error naming the lineage.
2. No self-mount: `--strict-mcp-config` without this server for Claude,
   `--ignore-user-config` for Codex, no `--plugin-dir` for Grok.
3. Denied launches: the deny list of section 3 for Claude and Grok; for
   Codex, the sandbox's network denial, which stops a launched engine from
   reaching any model API.
4. Lineage and duplicates: `DEV_TEAM_LINEAGE` is an ordered list of
   `(task id, role, canonical cwd)`. A `delegate` whose `(role, cwd)` is
   already in the lineage is refused. A request identical to a running task
   in `(role, canonical cwd, sha256(brief))` is refused with "already
   running, wait on <id>"; identical to a task finished within
   `duplicateWindowMinutes` (default 10) is refused unless `force: true`.
   `resume` skips the duplicate check, is refused for active tasks, and is
   bound to the original task's role, engine, cwd, and sandbox.
5. Prompt: every role prompt says the specialist cannot delegate and
   reports back instead. Advisory only.

### 6. Config and validation

`<project>/.dev-team/config.json`, created by `dev-team init`, validated on
load:

```json
{
  "project": {"defaultBranch": "main", "testCommand": "npm test",
              "setupCommand": "none", "mergePolicy": "auto"},
  "roles": {
    "planner":       {"engine": "codex",  "model": "gpt-6-astra", "effort": "high", "cwd": "root",     "sandbox": "read-only"},
    "plan-reviewer": {"engine": "claude", "model": "claude-opus-5",                  "cwd": "root",     "sandbox": "read-only"},
    "implementer":   {"engine": "codex",  "model": "gpt-6-astra",                    "cwd": "worktree", "sandbox": "workspace-write"},
    "code-reviewer": {"engine": "claude", "model": "claude-opus-5",                  "cwd": "worktree", "sandbox": "read-only"}
  },
  "engines": {"claude": {}, "codex": {}, "grok": {}},
  "limits": {"maxDepth": 1, "stallMinutes": 15, "waitDefaultSeconds": 600,
             "duplicateWindowMinutes": 10},
  "billing": "subscription"
}
```

`cwd: "root"` roles run at the project root with a read-only sandbox.
`cwd: "worktree"` roles require the `verify_worktree` checks of section 4
against the branch named in the request (`task/<slug>`), and a writable
sandbox reserves the path.

### 7. The skill

`skills/dev-team/SKILL.md` carries the lead loop: the pack's
`worktree-workflow` with the verbs remapped (`delegate_bot` and `ask_bot`
become `delegate` then `wait`; "end your turn, you are woken" becomes "call
`wait` again while it reports running"; roles are names; the closing room
post becomes one line in `.dev-team/log.md`), the git ownership and
ordering of section 4, and:

- Journal: `.dev-team/journal/<slug>.json` records, per task, the default
  branch SHA before the merge, the task branch head, and each completed
  git step (`worktree-created`, `committed`, `rebased`, `merged`,
  `tests-passed`, `worktree-removed`, `branch-deleted`); `git_mutate`
  writes it.
- Reconciliation at the start of every task and after any interruption:
  `list_tasks`, the journal, `git worktree list`, `git branch --list
  'task/*'`, `git status --porcelain --untracked-files=normal`, and
  `git rebase` state. Rules: an interrupted rebase is aborted; a merged
  branch with a surviving worktree continues at the cleanup gate; a
  branch-only leftover is deleted with `branch -d`; a running task is
  waited on; an unmerged branch with a dead task is reported to the user.
- Repair path: never reset or rewrite `<default>`. If the suite fails on
  `<default>` after a merge, stop, report, and offer `git revert --no-edit
  <recorded default SHA>..<recorded merged head>` as a new commit; the
  operator dispatches no further task until the repository is reconciled.

### 8. Role prompts

`roles/{planner,plan-reviewer,implementer,code-reviewer}.md` are written
for this runtime, using the pack's role text for the review and reporting
conventions only: planner and plan reviewer read at the root; the
implementer edits and runs the tests in its worktree and reports a commit
summary but never runs git write commands; the code reviewer reads the
committed branch in the worktree; nobody delegates. Acceptance is
behavioural (the end-to-end runs).

### 9. Host packaging

Repo root is the plugin root for all three hosts: `.claude-plugin/plugin.json`
+ `.mcp.json` + `skills/` for Claude Code (`claude --plugin-dir
~/Documents/agent-team-cli` in development); `.codex-plugin/plugin.json`
with `skills` and `mcpServers` (`tool_timeout_sec: 3600`) for Codex, plus
`codex mcp add dev-team -- node <repo>/src/server.ts` and a copy into
`~/.codex/skills/dev-team/` as the documented fallback; Grok through
`--plugin-dir` or `grok plugin install <path>`, which reads the Claude
manifest. Grok's MCP tool timeout is settled by integration probe I2.

### 10. Operator CLI

`src/cli.ts`: `dev-team init | tasks | show <id> | log <id> | cancel <id> |
verify-worktree <path> <branch> | git <slug> -- <args> | journal <slug>`.

### Time limits, as agreed

No cap on a task. `wait` returns early with `stalled: true` when the engine
has emitted nothing for `stallMinutes`; the task keeps running and the lead
decides. `timeout_seconds` bounds one call so the lead's turn never hangs;
Claude Code's MCP tool timeout defaults to about 28 hours, Codex takes
`tool_timeout_sec` per server.

### Not built

Chat, rooms, a roster UI, an approval broker, runtime bot creation, the
lead's own persistence (the host's job), ACP engines, branch-scoped git
metadata grants, a conflict-edit mode for rebases.

## Repository layout (`~/Documents/agent-team-cli`)

```
.claude-plugin/plugin.json   .codex-plugin/plugin.json   .mcp.json
skills/dev-team/SKILL.md     roles/*.md
src/server.ts  src/ledger.ts  src/runner.ts  src/guard.ts  src/config.ts
src/locks.ts   src/gitmutate.ts  src/cli.ts
src/engines/{types,claude,codex,grok}.ts
tests/*.test.ts  tests/fixtures/fake-engine.mjs
tools/probe.mjs  docs/design.md  docs/probes.md
AGENTS.md  README.md  LICENSE (Apache-2.0)  package.json  .gitignore
```

`package.json`: no dependencies, `"test": "node --test tests/"`. AGENTS.md
carries the Project facts for the pack (default branch `main`, test command
`npm test`, setup command `none`, merge policy `auto`), the layout, the
conventions (one file per concern, tests next to behaviour, no dependency
without a reason), and the loop-guard scope as a hard requirement.

## Work plan

### Phase 0: scaffold and engine-level probes (this session)

1. Create the repository: `git init`, LICENSE, package.json, `.gitignore`
   (`.dev-team/`, `.worktrees/`, `node_modules/`), AGENTS.md, README.md,
   `docs/design.md` (this design), `src/server.ts` with the JSON-RPC loop,
   `initialize`, `tools/list`, `list_roles` from a config file, concurrent
   dispatch; `tests/server.test.ts` over stdio, including one test that
   answers `ping` while a slow tool call is pending; `tests/fixtures/
   fake-engine.mjs` (emits JSONL; `FAKE_ENGINE_SCRIPT` selects stall,
   fail, loop attempt, denied command); `tools/probe.mjs`, a standalone
   harness that spawns one engine with the section 3 argv (no server, no
   runner) so the probes do not wait on feature tasks. `npm test` green.
   First commit.
2. Probes with the harness, each a short real run recorded in
   `docs/probes.md` with the exact command and outcome:
   - P1 nested `claude -p` from inside a Claude Code session with the
     scrubbed env (the binary carries a `CLAUDECODE` guard).
   - P2 each engine as implementer inside `.worktrees/x` under its sandbox:
     an edit and the tests succeed; writes to a root file, to another
     worktree, to `<root>/.git/refs/heads/main`, and a rewrite of the
     worktree's `.git` pointer are attempted; the first three must be
     denied, and after the fourth `verify-worktree` must refuse; the same
     on a resumed session.
   - P3 the deny list: each target on each engine, including resumed
     sessions and a configured binary path. (Outcome: Claude and Grok
     enforce it; Codex ignores rules files in `exec`, see P3b.)
   - P3b Codex network: a workspace-write child cannot reach a model API
     or complete a nested engine run.
   - P5 `codex exec --ignore-user-config`: auth kept, no trust prompt, no
     user MCP servers.
   - P7 `dev-team git` over a worktree edited by a sandboxed implementer:
     commit, rebase, `--ff-only` merge, cleanup, with `flock` held.
3. In this repo: Decision 0008, beads under epic `atw-07l` for the
   T-series, `bd remember` for the marketplace and skill clarification,
   an EVIDENCE.md section header for M7.
4. Bring up the pack: headless server on `openmausbot-data-4`, rebind every
   bot and the room to `~/Documents/agent-team-cli` with
   `scripts/bind-team.sh`, set the lead's Project facts, lead on Claude for
   T1. Operator rule: the next task is dispatched only after the previous
   one settled and the repository reconciled.

### Phase 1: the pack builds the tool (one task at a time to Sudo)

Contracts first, then locks and the runner, then adapters, then the tools,
then skill and packaging with each host's integration probes and
end-to-end run right after its packaging. Each task names files,
acceptance, and `npm test`; a plan under 60 lines, 50 to 250 changed
lines.

| Task | Scope | Acceptance |
|---|---|---|
| T1 Ledger and launch protocol | `src/ledger.ts`: records, atomic writes, statuses, `launchDeadline`, identities, reconciliation rules, `.git/info/exclude` | a `launching` record is untouched before its deadline and `failed: launch` after; dead runner with dead engine becomes `failed: runner lost` |
| T2 Config and validation | `src/config.ts`: load, defaults, validation, `dev-team init`, `cwd` kinds; `verify_worktree` with `realpath`, `git worktree list --porcelain`, the three `rev-parse` checks, exact branch | root, a subdirectory, an unrelated repo, the main worktree, a wrong branch, and a rewritten `.git` pointer are refused; a linked `task/<slug>` worktree passes |
| T3 Guard | `src/guard.ts`: depth parsing (fail closed), lineage, running and recent duplicates, resume binding and active-resume refusal, deny-list and exclusion-flag builders per engine | one test per layer; malformed and cleared variables; needs-work resume accepted; resume of a running task refused |
| T4 Adapter interface, fake engine, harness | `src/engines/types.ts`, fake wired through `DEV_TEAM_<ENGINE>_BIN`, sandbox-or-refuse rule, `tools/probe.mjs` moved onto the interface | a fake run produces `<id>.ndjson`, `<id>.out`; a missing sandbox capability refuses to spawn |
| T5 Runner and orphan handling | `src/runner.ts`: detached, own process group for the engine, identity file, event tee, terminal writes, SIGTERM handling | crash tests: kill the server during launch, execution, finalisation; kill the runner with the engine alive (engine terminated, `failed: runner lost`); cancel racing completion has one terminal writer |
| T6 Locks, reservation, git_mutate, journal | `src/locks.ts` (spawn lock with TTL and rename reclaim; `flock` wrapper), reservation rules, `src/gitmutate.ts`, journal | two servers cannot both spawn; simultaneous reclaim yields one winner; `git_mutate` refuses an unsettled reservation and a failed verification; journal records SHAs and steps |
| T7 Claude adapter | argv, env scrub, session id, resume, final message, settings JSON, deny list | tests with the fake binary; flags from P1, P2, P3 |
| T8 Codex adapter | `exec --json -o -C`, sandbox, execpolicy rules file, `exec resume` | tests; flags from P2, P3, P5 |
| T9 Grok adapter | `-p --cwd --sandbox`, deny rules, `--session-id`/`-r`, json output | tests; flags from P2, P3 |
| T10 delegate, check, result, cancel | validation order under the spawn lock, reservation, identity-checked cancel of both groups, adoption after restart | cancel of a running fake; a retried delegate while the child survives is refused; a second writable task on a reserved cwd is refused |
| T11 wait with stall | per-call timeout, `stalled` after silence, `orphaned` surfaced, cancellation notification | fake silent for N seconds flips `stalled` and keeps running; `check` answers during a pending `wait` |
| T12 Skill and roles | `skills/dev-team/SKILL.md`, `roles/*.md`, README with the guard scope | reviewed against sections 4, 5, 7, 8 |
| T13 Claude Code packaging | `.claude-plugin/plugin.json`, `.mcp.json` | `claude --plugin-dir . -p` lists the skill and the tools; then integration probes I1, I2 for this host and end-to-end run 1 (mine) |
| T14 Codex packaging | `.codex-plugin/plugin.json`, `codex mcp add` notes, skills copy script | a Codex session sees the tools and the skill; then I1, I2 and end-to-end run 2 |
| T15 Grok packaging | manifest reuse, `--plugin-dir` notes | a Grok session sees the tools; then I1, I2 (including the MCP tool timeout) and end-to-end run 3 |
| T16 Operator CLI | `dev-team tasks | show | log | cancel | journal` | tests over a seeded ledger |

Integration probes after each packaging task (mine): I1 self-mount, with
the plugin installed in that host, each of the three engines spawned as a
specialist lists its MCP tools and shows no `dev-team` tool; I2 host ×
engine isolation, each engine spawned by the server launched from that
host repeats the P2 negative writes and can reach the network, plus a
ten-minute `wait` under that host's MCP timeout.

### Phase 2: evidence and decisions

EVIDENCE.md gets one table per pack task (as for T7 to T9 in 0.4.0) plus
the probes and the end-to-end runs. Pack findings feed 0.4.x fixes; a
Decision records the go or no-go for the plugin as the second binding.

## Verification

- `npm test` green in `agent-team-cli` after every task. T3, T5, and T6
  are gates: no adapter or tool task is briefed before they pass.
- Probes P1, P2, P3, P5, P7 recorded with command and outcome before T7 to
  T9 are briefed; a failed negative probe (a denied write that succeeded,
  a pointer rewrite that `verify-worktree` accepted) blocks the
  corresponding adapter.
- Failure injection, each recorded once: a suite that fails on `<default>`
  after a merge (repair path offered, dispatch halted); an interruption
  after `worktree remove` and before `branch -d` (reconciliation deletes
  the branch); an interrupted rebase (aborted and reported); a server
  killed during a task (the runner records the outcome; a restarted server
  adopts it); a runner killed with the engine alive (engine terminated);
  a needs-work round through `resume`.
- End-to-end under each host: plan and plan review at the root, worktree,
  implement, lead commit, code review, merge, tests, cleanup; `git
  worktree list` shows only the root, no `task/*` branch remains, `git
  status --porcelain --untracked-files=normal` is empty, the suite is green
  on `main`; `.dev-team/tasks/` holds one record per delegation with native
  logs; the journal shows every step; no record shows depth above 1; the
  specialists' transcripts show no `dev-team` tool and no engine launch.
- For the pack (M7): every T-series task ends with no worktree, no task
  branch, a clean root, and `npm test` green on `main`, as in 0.4.0.

## Findings from the research (kept for reference)

- Pack anatomy: zero lines of product code; one JSON package, two
  playbooks, three skill mirrors. Host-independent: the four role prompts,
  the lifecycle, the merge policy, Project facts. Host-specific: the
  delegation verbs, the wake, `create_bot`, rooms, id lookup, bind script.
- OpenMausBot 0.1.56 (Apache-2.0): Claude via `claude -p` stream-json with
  an MCP permission proxy; Codex via `codex app-server` JSON-RPC; Grok and
  seven others via ACP; team tools are a stdio MCP server injected into the
  engine process; durable delegation ledger with a wake budget; no git
  worktrees; loopback HTTP API with SSE; a shipped MCP server
  (`dist-server/mcp-server.js`) with `send_bot_message` and a 120 s
  `wait_for_conversation`. Worth porting: the recursion budget wording in
  `room-post-budget.ts`, the native event tee, the ledger shape.
- Vendor bridges installed here (`codex` 1.0.6 by OpenAI, `grok-build`
  0.2.1 by xAI): thin Sonnet forwarder agents around 4 to 5 thousand lines
  of runtime each; `codex app-server` through a broker, `grok -p
  --always-approve`; both pin cwd to the git root; both persist jobs and
  resume sessions. Reference for argv, job control, and result rendering;
  not a dependency.
- CLIs: Claude Code 2.1.263 (`-p`, stream-json, `--resume`,
  `--strict-mcp-config`, `--settings` sandbox JSON, `--disallowedTools`
  with `Bash(<prefix> *)` patterns, bubblewrap present, `--bg`); Codex
  0.153.4 (`exec --json -o -C --sandbox --add-dir --ignore-user-config
  --ignore-rules`, `exec resume`, `mcp-server`, `multi_agent` enabled,
  plugins with skills and MCP servers only); Grok 1.0.13 (`-p`, json
  output, `--cwd`, `--sandbox off|workspace|read-only|strict`,
  `--session-id`/`-r`, `--deny`, `--disallowed-tools Agent`, plugins).
- Decision 0034's Paperclip reasons: boundary bloat and private patches do
  not transfer; "wrong face" does (a plugin is terminal-shaped), which is
  why the OpenMausBot pack stays the primary binding.
