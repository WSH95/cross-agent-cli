# cross-agent-cli project charter

cross-agent: a multi-engine orchestrator that runs a dev team (planner, plan
reviewer, implementer, code reviewer) as one MCP server plus one skill for
Claude Code, Codex, and Grok.
The host session is the lead; specialists run as headless `claude`, `codex`,
or `grok` processes on the user's own subscriptions, each inside its own
CLI's sandbox, in git worktrees the lead owns.

- Created: 2026-09-07 (Project Steward 0.3.4); scaffolded the same day
- Stack: TypeScript with erasable syntax only, run directly by Node 24; no
  dependencies; `node:test`
- Design authority: `docs/design.md`; observed engine behaviour:
  `docs/probes.md`
- Origin: the OpenMausBot dev-team pack in `~/Documents/agent-team-devpack`
  (its Decision 0008), whose four roles became the built-in `dev-team` mode;
  design reviewed twice by Codex gpt-6-astra on 2026-09-07. Since 2026-10-02
  the project follows its own path and is not the pack's second binding
  (Decision 0011, the user's word)
- License: MIT

## Goals

- One MCP server core (`delegate`, `wait`, `check`, `result`, `cancel`,
  `list_tasks`, `verify_worktree`, `git_mutate`) that all three hosts attach
  with the same skill text.
- Each CLI's own sandbox as the safety boundary; no approval broker.
- No delegation loop can form through `delegate`; direct engine launches
  from specialists are denied at each CLI's permission layer or cannot reach
  a model API (design section 5).
- Specialists never write git metadata; the lead owns commit, rebase, merge,
  and cleanup through explicit git-dir commands under an OS-held lock.
- Every claim about an engine CLI is backed by a recorded probe.

## Non-goals

- Chat, rooms, a roster UI, runtime bot creation, persistence of the lead's
  own state, ACP engines, branch-scoped git metadata grants, a conflict-edit
  mode for rebases (all listed in `docs/design.md`, "Not built").
- Any dependency on OpenMausBot.

## Users and maintainers

- One human operator on Ubuntu, using Claude Code, Codex, and Grok on
  subscriptions.
- The operator's own CLI sessions maintain the repository through Beads and
  Project Steward. T1 to T5 were built by the OpenMausBot dev-team pack as
  that pack's validation run (Decision 0003).

## Constraints

- Claude's sandbox needs `bwrap`, `socat`, and on Ubuntu 24.04 or later the
  bwrap AppArmor profile; the adapter refuses to spawn without them.
- Codex and Grok treat `/tmp` and `$TMPDIR` as writable, so a project there
  is not isolated.
- Process-spawning test suites do not run inside Codex's sandbox.
- Never push. Commits follow Conventional Commits and include
  `.project-steward/` at checkpoints (commit policy auto).
