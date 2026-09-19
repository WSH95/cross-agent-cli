# cross-agent

One MCP server plus a launcher skill that run a team of headless `claude`,
`codex`, and `grok` processes on your own subscriptions, each inside its own
CLI's sandbox. A host is anything that can attach an MCP server and load a
skill: Claude Code, Codex, and Grok today. What the team does is a **mode** —
data, not code: the roles, the loop the lead runs, and a git policy — and the
design builds in two, `dev-team`, the four-role worktree team (planner, plan
reviewer, implementer, code reviewer), and `solo`, one consultant and no team.
Every mode carries that consultant, and a project with no config at all runs as
`solo` at its git toplevel, so a one-off delegation to another engine — read the
code and answer, or take one change in a worktree of its own — costs no setup.

## Status

The core everything else is built on: the task ledger with conditional
updates under an OS-held lock and a transition table, reconciliation on the
process-group scan that adopts a stranded engine by its `CROSS_AGENT_TASK`,
config loading that checks each role's sandbox profile against its engine,
worktree verification, workspace reservation, `git_mutate` on the verified
git-dir with a per-task journal, the loop-guard helpers, the engine contract
with its three adapters (Claude, Codex, Grok) and the spawn pipeline, and
the detached runner with its orphan handling. `npm test` covers each of
those, runs the citation checker over the docs, and is green at every commit
on `main`; one test stays skipped until a real `codex` binary runs it. On top
of it: the mode loader and the three built-in modes, the authority model and
the twelve tools it gates — `delegate`, `wait`, `check`, `result`, `cancel`,
`list_tasks`, `describe_mode`, `list_roles` and the worktree provider's four —
and `cross-agent init`, and the launcher skill with each mode's own loop. What
is left is a target: the mailbox an engine-placed lead needs, and Codex's and
Grok's packaging. `docs/design.md` is the design and the work plan;
`docs/probes.md` records what each engine CLI was observed to do, and
`VERIFY.md` what each milestone's own runs showed.

## Install it in Claude Code

The repository root is the plugin root: `.claude-plugin/plugin.json` names the
plugin, `.mcp.json` starts this server from it, and `skills/` is found by
convention. In development, point a session at the checkout:

```
claude --plugin-dir ~/Documents/agent-team-cli
```

Then, once per project the team is to work in, write its bind-time config —
which mode, and the engine, model and effort each of that mode's roles runs on:

```
cd ~/code/my-project
cross-agent init --mode dev-team
```

`cross-agent` is `package.json`'s `bin`, so it is on `PATH` only where the
package is linked; everywhere else the same command is `node
~/Documents/agent-team-cli/src/cli.ts init --mode dev-team`. Either way `init`
writes `.cross-agent/config.json` with every role bound to a default you then
edit, adds `.cross-agent/` and the mode's worktree directory to `.gitignore`,
and leaves an existing config alone. The server discovers that
project from the host session's working directory, so a session started
anywhere inside it runs that project's team.

## Run the tests

```
npm test
```

No dependencies; Node 24 or later runs the TypeScript sources directly.

## The lead, in one paragraph

In the design, the lead is whichever session holds the lead tools and runs
the mode's loop, and the mode's `placement` decides which process that
session is. Under `placement: host` it is your own session: it loads the loop
and is busy between `wait` calls. Under `placement: engine` a spawned engine
runs the loop, your session stays free to check status, watch it, answer its
questions through a mailbox, and cancel it, and the run survives closing your
session. `host` is built first; `engine` follows the first end-to-end run.
Either way the design derives a server's authority from process ancestry
rather than from depth or a token: the server walks its own parent chain for
the engine that spawned it, matches that against the ledger, and serves the
operator, lead, or specialist row of the permission matrix accordingly,
failing closed to specialist. Depth only caps that row, never raises it, and
no token could grant it — the launch spec holding a child's environment sits
in the project, where every role can read it, so possession must not equal
authority. This is built: `src/authority.ts` walks the ancestry and resolves
the row, and `src/server.ts` offers each tool to the rows it belongs to and
refuses a call from any other by name.

## Loop guard, in one paragraph

The design's guarantee is that no delegation loop can form through
`delegate`. The ancestry walk resolves a specialist to the specialist row of
the permission matrix and it gets exactly that row — the four read tools plus
`describe_mode`, never `delegate` — with a call to any other tool refused at
`tools/call` by name and told why; and its own direct launches of `claude`,
`codex`, `grok`, this server, or the CLI are denied at the Claude and Grok
permission layers, while a Codex child cannot reach a model API at all
because its sandbox denies the network. None of that is enforced at this
commit: the depth reader, the lineage and duplicate checks, and the deny-list
and exclusion argument builders exist in `src/guard.ts` under unit test, but
the server registers no `delegate` and gates nothing, so the guard is still
design rather than behaviour. A specialist that defeats its own CLI's
permission rules is outside the guarantee.

## License

Apache-2.0.
