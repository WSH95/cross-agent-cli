# cross-agent-cli

`cross-agent`: a multi-engine orchestrator — one MCP server plus a launcher
skill — that runs headless `claude`, `codex`, and `grok` processes as a team
from any host that can attach an MCP server and a skill (Claude Code, Codex,
and Grok today). A team is a *mode*: roles, a lead loop, and a git policy,
kept as data under `modes/`; `dev-team` (planner, plan reviewer,
implementer, as many code reviewer seats as the config binds, and a resolver,
in git worktrees), `dev-team-engine` (the same team with its loop in a lead
the server launches) and `solo` are built in.
The design in `docs/design.md` is authoritative; `docs/probes.md` records what
each engine CLI was observed to do.

## If cross-agent launched you

When `CROSS_AGENT_TASK` is set in your environment and a role prompt named you this task's
planner, plan reviewer, implementer, code reviewer, resolver, consultant or lead, a
cross-agent session delegated you: your role prompt, its loop and your brief are your
instructions. Project facts, Layout, Conventions, Run and Commands describe the code you
work on. The sections from `## Task backend` to the end, and the Beads text in `CLAUDE.md`,
are the operator session's workflow and not yours: run no `bd` and no `project-steward`,
and write nothing under `.project-steward/` or `.beads/`. Git stays where your role prompt
puts it. The session that delegated you tracks the task, records it, and commits and merges
what you leave.

One launched session is the exception: a `dev-team-engine` lead whose `describe_mode`
answers `records`. It keeps the task tracking and the records those sections describe
through the `track` and `record` tools alone — the beads through `track`'s verbs, the
`.project-steward/` files through `record`, written as plain text — and still runs no `bd`
and no `project-steward` and writes nothing under `.project-steward/` or `.beads/` any other
way. What those sections ask that neither tool does — `bd remember`, a `project-steward`
checkpoint or wrap, a sync, a push — stays the operator's. A specialist, and a lead whose
`describe_mode` answers no `records`, keep the rule above.

Run the test suite only through `npm test`. Under a sandbox that filters socket calls, as
Codex's workspace-write sandbox does, a Node child's piped output is lost: `npm test`'s
preflight stops the suite there with that cause, and a direct `node --test` stops each file
before its tests. One file still runs there, only as `node --test --test-isolation=none
tests/<concern>.test.ts`, and its tests that read a Node child's output fail or time out
because of the sandbox, not the change. The gate's run of the branch head, outside any
sandbox, decides the suite.

## Project facts

- Default branch: `main`.
- Test command: `npm test`.
- Setup command (run once in each new worktree): none. There are no
  dependencies; Node 24 runs the TypeScript sources directly.
- Merge policy: auto.

## Layout

Shipped:

- `src/server.ts`: the stdio JSON-RPC (MCP) server and its tool registry,
  gated per request by the permission-matrix row `src/authority.ts` resolves
  from process ancestry; `src/project.ts` finds the project (`--project`,
  `CROSS_AGENT_PROJECT`, or the nearest `.cross-agent/config.json`, a directory
  inside a task's worktree read as its root and a worktree `init` was run in as a
  project of its own).
- `src/delegate.ts` (`delegate` under `spawn.lock`: validation, the launch
  spec, the detached runner, and an engine-placed lead's mount and composed
  prompt), `src/tasks.ts` (`check`, `result`, `cancel` with its cascade over
  tasks and asks, `list_tasks`; ownership by lineage ids), `src/wait.ts`
  (`wait` with stall detection; `observeStall` shared with `check`),
  `src/mailbox.ts` (`ask`, `list_asks`, `answer` over `.cross-agent/asks/`).
- `src/config.ts`: `.cross-agent/config.json` loading and validation
  (`loadConfig` for the bindings alone; `loadConfigWithMode` for the config
  and the mode checked against each other; `effectiveMaxDepth`), and the
  optional `records` block, its tracker verb table and path rules.
- `src/setup.ts`: `init --propose`'s look at a project — the engines found as
  the server finds them, the default branch, the test and setup commands, each
  with where it came from, and, for the background team, a `records` block
  where beads and project-steward are both found — and the team rule that
  proposes each built-in mode from them.
- `src/modes.ts`: the mode loader, `describe_mode`'s payload, the built-in
  `consult` role, and `builtInModesDir`.
- `src/cli.ts`: the operator CLI — `init`, `modes`, `tasks`, `show`, `log`,
  `cancel`, `verify-worktree`, `git`, `git-root`, `journal`, `waive`, `list-asks`,
  `answer` and `report` on one verb table, each calling the function its tool calls, with
  `--project`, `--json` and `--help` on every verb and one exit protocol (0 ok,
  1 error, 2 usage, 3 precondition, 4 still running, 5 needs the operator, 6
  stalled); its reads write nothing, and a verb that writes refuses inside a
  task's environment.
- `src/ledger.ts` (task records; async conditional `update` under the
  record lock; the runner's outcome sidecar), `src/locks.ts` (OS-held
  `flock` on a pipe, and the repository lock in the common directory),
  `src/process.ts`
  (identities, groups, the environ scan, orphan cleanup), `src/reconcile.ts`
  (reconciliation on the group scan), `src/worktree.ts` (the project's
  repository, located from outside it, the opt-in rule for writes at a root that
  is not the main checkout, and linked-worktree verification),
  `src/reservation.ts` (workspace reservation), `src/gitmutate.ts` (`git_mutate`
  on the verified git-dir under `spawn.lock` → `git.lock` → the repository
  lock), `src/gitroot.ts` (`git_root`: one whitelisted verb at the project root
  under `git.lock`, and the repository lock for a verb that changes it),
  `src/runcommand.ts` (`run_command`: the configured test or setup
  command by selector; a worktree test run tests a detached checkout of the
  branch head under `.cross-agent/gate/` and journals `tested`; `commandEnv` and
  `runArgv`, shared with `track`),
  `src/journal.ts` (the per-task git journal), `src/records.ts` (`record`:
  declared record files read, or written and committed at the root under
  `git.lock` → the repository lock, journaled in `.cross-agent/runs/<run>.json`;
  `track`: a configured tracker verb run at the root with no shell, a reading verb
  under `git.lock` alone, a writing verb committing only `tracker.files` on the
  same procedure),
  `src/review.ts` (the merge's
  review guard: the verdict a review's result ends on, the head a review
  covered, the hold on a reviewed worktree, the setup marker, the waiver),
  `src/runner.ts` (the detached per-task runner), `src/guard.ts` (depth,
  lineage, duplicates, deny targets, child env): one file per concern, as
  in the design.
- `src/engines/types.ts` (the adapter contract), `src/engines/spawn.ts`
  (the pipeline), `src/engines/registry.ts` (the built-in table,
  `sandboxFor`), `src/engines/binaries.ts`, `src/engines/text.ts` (the
  readers the adapters share: `truncate`, `assistantText`, `failureText`),
  and the three adapters
  `src/engines/{claude,codex,grok}.ts` (Claude: stream-json, `dontAsk`
  with the settings sandbox, the file tools' permission rules and a tool
  allowlist, deny list; Codex: `exec`/`exec resume` with the prompt on stdin;
  Grok: `streaming-messages-json`, `--rules`, not an engine-placed lead);
  `tests/fixtures/fake-engine.mjs` stands in for a CLI, and
  `tests/fixtures/fake-tracker.mjs` for a tracker's command line;
  `tests/helpers/project.ts` builds a per-test project and sweeps every
  process it spawned.
- `tests/<concern>.test.ts`: `node:test` with `node:assert/strict`;
  `tests/citations.test.ts` runs `tools/check-citations.mjs`, which fails
  `npm test` when a doc cites a line past a file's end or a symbol the file
  does not declare. `tests/preflight.mjs` is `npm test`'s preflight, run before
  `node --test`: it starts one Node child with piped output and stops the suite
  at once, with the cause and what still runs, where that output is lost, as
  under Codex's workspace-write sandbox; `tests/preflight.test.ts` pins it with
  the preloads `tests/fixtures/discard-stdout.mjs` (a child's output lost) and
  `tests/fixtures/spawn-eperm.mjs` (no child started, as Node reports it).
  `tests/child-check.mjs` is every test file's first import (`../child-check.mjs`
  under `tests/engines/`). In a `node --test` child whose piped stdout Node could
  not type, as a direct `node --test` of a file gets under that sandbox, it stops
  the file before its tests with the same cause and what still runs; in any other
  process it does nothing. `tests/child-check.test.ts` pins it with the preload
  `tests/fixtures/untyped-stdout.mjs` and the test file
  `tests/fixtures/child-check-probe.mjs`, and pins that every test file opens
  with it. `tests/lost-output.mjs` holds the text both print.
- `skills/cross-agent/SKILL.md`: the launcher skill, one of the two skills a host
  discovers. It carries what every mode shares — the roster, the brief, the
  watch budget, the report — what every host-placed mode shares — the merge
  policy a `worktree: true` task settles under, the `review` and `critique`
  verbs, the reconciliation pass, each naming `host` placement — and the
  engine-placement section a host follows while a lead runs the loop.
- `skills/setup/SKILL.md`: the setup skill, which sets a project up and changes
  its setup through the plugin's own CLI, `init --propose` and then `init --config -`
  once the user confirms, with each host's way of asking and reconnecting.
- `modes/{dev-team,dev-team-engine,solo}/{mode.json, SKILL.md, roles/*.md}`:
  the three built-in modes. `SKILL.md` is that mode's loop, served by
  `describe_mode` and never copied into a host's skill directory;
  `roles/*.md` is one prompt per role, launched with the specialist.
  `dev-team-engine`'s loop is the engine lead's own: the same ten steps,
  every root step through `git_root` and `run_command`, every question
  through `ask`; with a `records` block, its `## The run` works an epic, a
  list of tracker ids or a goal one task per item, keeping the tracker and
  the record files through `track` and `record`.
- `.claude-plugin/plugin.json`: the Claude Code plugin manifest, which declares
  the MCP server inline under `mcpServers` (a repository-root `.mcp.json`
  would double as this repository's own project config); `tests/packaging.test.ts`
  pins it. A Claude Code host installs it from WSH95/agent-plugins or attaches a
  clone with `claude --plugin-dir <this repository>`; a Grok host reads the same
  manifest as a plugin in place, named under `[plugins]` in the project's own
  `.grok/config.toml`, so no Grok manifest exists.
- `.codex-plugin/plugin.json`, its launcher `.codex-plugin/serve`, and
  `.agents/plugins/marketplace.json`: the Codex plugin, offered from this
  repository as a one-plugin marketplace. Codex runs it from a copy in its
  cache and starts the server there through the launcher, so a Codex host
  names its project in `CROSS_AGENT_PROJECT`; `assets/codex/mcp_servers.toml`
  is the configured-server fallback. `tests/packaging.test.ts` pins them too.
- `bin/cross-agent`: the operator CLI's launcher, which Claude Code puts on its
  Bash tool's PATH; it runs the `src/cli.ts` beside it, and specialists are denied
  it as they are the CLI.
- `tools/build-dist.mjs`, `tools/publish_agent_artifact_pr.py` and
  `agent-artifacts.json`: the install payloads, built from a commit into
  `dist/cross-agent/` (ignored) in WSH95/agent-plugins' layout, and published there
  by pull request; the publisher is WSH95/project-steward's, kept verbatim.
  `tests/dist.test.ts` and `tests/publish.test.ts` pin them.
- `tools/probe.mjs`: a standalone harness for observing a real engine CLI
  (`--track` spawns the real runner from a delegate-shaped spec).
  `tools/e2e-verify.mjs` judges an end-to-end run by the design's eight
  conditions. `tools/from-openmaus.mjs` is the one-off that carried the
  devpack's dev-team text into `modes/`, run once, kept as history. None of
  `tools/` is product code.
- `docs/design.md`, `docs/probes.md`, and the user's guides the README links,
  `docs/install.md` and `docs/operator-guide.md`.

Planned, in the design's work plan: the backlog (row 14).

## Conventions

- TypeScript with erasable syntax only (no enums, namespaces, parameter
  properties, or decorators), so Node runs it without a build step. Import
  paths carry the `.ts` extension. No dependencies: Node built-ins only.
- Test first. Every behaviour change starts with a failing test in
  `tests/`; the test names the behaviour. Test-only hooks never go into
  `src/`; tests inject through public options (for example a tool list or
  an engine binary path).
- The permission matrix and loop-guard scope (design "The lead model" and
  section 5) and the deny list and exclusion flags (design section 3) are
  hard requirements: a change to spawn arguments keeps them and updates the
  builder tests.
- Docs cite code by symbol (`src/<file>.ts#<symbol>`) where a top-level
  declaration or an `// @anchor` comment names the spot, and by line only
  where none does; `tools/check-citations.mjs` verifies both.
- Specialists never write git metadata (design section 4). Code that runs
  git in a worktree goes through `git_mutate`; root operations for an
  engine-placed lead go through `git_root`.
- A role's workspace and sandbox default belong to its mode;
  `.cross-agent/config.json` binds engine, model, and effort per role and
  `bin` per engine.
- Every sentence in prompts, briefs, and docs serves a purpose. No
  artificial length caps.

## Run

- The server: `node src/server.ts` (stdio; JSON-RPC lines in, lines out).
- A project's config: `node src/cli.ts init --mode dev-team` (or `solo`, or
  `dev-team-engine`) in the project root; in a branch worktree beside it, `node
  src/cli.ts init` copies the main checkout's config onto the worktree's own branch
  (docs/operator-guide.md, "Several branches at once").
- A project's tasks from a terminal, without writing anything: `node src/cli.ts
  tasks`, `node src/cli.ts show <id>`, `node src/cli.ts report` (each takes
  `--json`).
- A Codex host: `codex plugin add cross-agent@agent-plugins` from WSH95/agent-plugins,
  or from a clone, export `HEAD` into a directory of its own (`git archive HEAD |
  tar -x -C <dir>`), `codex plugin marketplace add <dir>`, `codex plugin add
  cross-agent@cross-agent-cli`; then `init` the project and start
  `CROSS_AGENT_PROJECT=<project root> codex` (docs/install.md, "Install it in Codex").
- A Grok host: in the project, after `init`, `.grok/` added to `.gitignore` and
  that change committed, then `[plugins]` with `paths = ["<this repository's
  absolute path>"]` and `enabled = ["cross-agent"]`, and `[mcp]` with
  `max_output_bytes = 100000`, in `.grok/config.toml`, the folder trusted
  (docs/install.md, "Install it in Grok").
- An engine probe: `node tools/probe.mjs --engine claude --cwd <dir> --sandbox read-only --prompt "…"`.
- A release: bump the version in `package.json` and both manifests, commit, push
  `main`, then `python3 tools/publish_agent_artifact_pr.py --build …`, which runs
  `node tools/build-dist.mjs` and opens the agent-plugins pull request (README,
  "Development").
- The dev team on this repository: attach a released build to the host, never this
  checkout, whose merges would change the runner and adapters the next task loads while
  the server keeps the code it started with. That build is `cross-agent@agent-plugins`, or
  `--plugin-dir` at an export (`git archive <commit> | tar -x -C <dir>`) of the frozen
  source commit `VERIFY.md` records for each release. `init --mode dev-team` here writes
  `.cross-agent/config.json`, which `.gitignore` already ignores. A change to host
  configuration (`.claude/`, `.codex/`, `.grok/`, `.mcp.json`, in any case) stays with the
  operator: a task's commit refuses it, and so does the merge.

<!-- PROJECT-STEWARD:BEGIN commands -->
## Commands

- Build: `none`
- Test: `npm test`
- Lint: `none`
<!-- PROJECT-STEWARD:END commands -->

<!-- PROJECT-STEWARD:BEGIN task-backend -->
## Task backend

beads owns the detailed task list. Keep only milestones and a pointer in `.project-steward/PLAN.md`; do not copy tasks between systems.
<!-- PROJECT-STEWARD:END task-backend -->

<!-- PROJECT-STEWARD:BEGIN agent-session-protocol -->
## Project Steward workflow

- Start by reading `.project-steward/HANDOFF.md`. Run `project-steward resume`
  when available, then recap the current task, next step, blockers, open
  questions, git state, and any crash signals.
- At meaningful checkpoints, write plain, factual updates to the relevant
  files in `.project-steward/` or run `project-steward checkpoint --note "..."`.
- Before pausing or switching agents, leave `HANDOFF.md` ready for someone
  without this chat. Run `project-steward wrap --summary "..."` when available.
- Propose Conventional Commits that include `.project-steward/`. Never push,
  force-push, or rewrite published history without explicit approval.
- Treat `AGENTS.md` and `CLAUDE.md` as user-owned files. Change only
  `PROJECT-STEWARD` managed blocks, show the diff first, and record the
  approved change in `.project-steward/DECISIONS.md`.
<!-- PROJECT-STEWARD:END agent-session-protocol -->

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
