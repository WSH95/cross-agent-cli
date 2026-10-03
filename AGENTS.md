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
  and the mode checked against each other; `effectiveMaxDepth`).
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
  branch head under `.cross-agent/gate/` and journals `tested`),
  `src/journal.ts` (the per-task git journal), `src/review.ts` (the merge's
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
  `tests/fixtures/fake-engine.mjs` stands in for a CLI;
  `tests/helpers/project.ts` builds a per-test project and sweeps every
  process it spawned.
- `tests/<concern>.test.ts`: `node:test` with `node:assert/strict`;
  `tests/citations.test.ts` runs `tools/check-citations.mjs`, which fails
  `npm test` when a doc cites a line past a file's end or a symbol the file
  does not declare.
- `skills/cross-agent/SKILL.md`: the launcher skill, the one skill a host
  discovers. It carries what every mode shares — the roster, the brief, the
  watch budget, the report — what every host-placed mode shares — the merge
  policy a `worktree: true` task settles under, the `review` and `critique`
  verbs, the reconciliation pass, each naming `host` placement — and the
  engine-placement section a host follows while a lead runs the loop.
- `modes/{dev-team,dev-team-engine,solo}/{mode.json, SKILL.md, roles/*.md}`:
  the three built-in modes. `SKILL.md` is that mode's loop, served by
  `describe_mode` and never copied into a host's skill directory;
  `roles/*.md` is one prompt per role, launched with the specialist.
  `dev-team-engine`'s loop is the engine lead's own: the same ten steps,
  every root step through `git_root` and `run_command`, every question
  through `ask`.
- `.claude-plugin/plugin.json`: the Claude Code plugin manifest, which declares
  the MCP server inline under `mcpServers` (a repository-root `.mcp.json`
  would double as this repository's own project config); `tests/packaging.test.ts`
  pins it. A Claude Code host attaches with `claude --plugin-dir <this
  repository>`; a Grok host reads the same manifest as a plugin in place, named
  under `[plugins]` in the project's own `.grok/config.toml`, so no Grok
  manifest exists.
- `.codex-plugin/plugin.json`, its launcher `.codex-plugin/serve`, and
  `.agents/plugins/marketplace.json`: the Codex plugin, offered from this
  repository as a one-plugin marketplace. Codex runs it from a copy in its
  cache and starts the server there through the launcher, so a Codex host
  names its project in `CROSS_AGENT_PROJECT`; `assets/codex/mcp_servers.toml`
  is the configured-server fallback. `tests/packaging.test.ts` pins them too.
- `tools/probe.mjs`: a standalone harness for observing a real engine CLI
  (`--track` spawns the real runner from a delegate-shaped spec).
  `tools/e2e-verify.mjs` judges an end-to-end run by the design's eight
  conditions. `tools/from-openmaus.mjs` is the one-off that carried the
  devpack's dev-team text into `modes/`, run once, kept as history. None of
  `tools/` is product code.
- `docs/design.md`, `docs/probes.md`.

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
  (README, "Several branches at once").
- A project's tasks from a terminal, without writing anything: `node src/cli.ts
  tasks`, `node src/cli.ts show <id>`, `node src/cli.ts report` (each takes
  `--json`).
- A Codex host: export `HEAD` into a directory of its own (`git archive HEAD |
  tar -x -C <dir>`), `codex plugin marketplace add <dir>`, `codex plugin add
  cross-agent@cross-agent-cli`, then `CROSS_AGENT_PROJECT=<project root> codex`
  (README, "Install it in Codex").
- A Grok host: in the project, after `init`, `.grok/` added to `.gitignore` and
  that change committed, then `[plugins]` with `paths = ["<this repository's
  absolute path>"]` and `enabled = ["cross-agent"]`, and `[mcp]` with
  `max_output_bytes = 100000`, in `.grok/config.toml`, the folder trusted
  (README, "Install it in Grok").
- An engine probe: `node tools/probe.mjs --engine claude --cwd <dir> --sandbox read-only --prompt "…"`.

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
