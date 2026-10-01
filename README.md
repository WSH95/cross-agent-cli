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
the twelve tools it gates under every mode — `delegate`, `wait`, `check`,
`result`, `cancel`, `list_tasks`, `describe_mode`, `list_roles` and the worktree
provider's four — with the mailbox's `ask`, `list_asks` and `answer` beside them
under `dev-team-engine`, fourteen for the operator and for the lead; engine
placement, which launches the loop in a Claude or Codex lead of its own; the
operator CLI's `init`, `answer` and `report`; and the launcher skill with each
mode's own loop. What is left is a target: Codex's and Grok's packaging, and the
CLI's remaining verbs. `docs/design.md` is the design and the work plan;
`docs/probes.md` records what each engine CLI was observed to do, and
`VERIFY.md` what each milestone's own runs showed.

## Install it in Claude Code

The repository root is the plugin root: `.claude-plugin/plugin.json` names the
plugin and declares this server under `mcpServers`, and `skills/` is found by
convention. In development, point a session at the checkout:

```
claude --plugin-dir ~/Documents/agent-team-cli
```

The session should report the server as `plugin:cross-agent:cross-agent`,
connected, and offer twelve tools spelled
`mcp__plugin_cross-agent_cross-agent__<tool>` — `delegate`, `wait`, `check`,
`result`, `cancel`, `list_tasks`, `describe_mode`, `list_roles`,
`verify_worktree`, `git_mutate`, `git_root`, `run_command` — and, in a project
whose mode places its lead in an engine, `list_asks` and `answer` too. Fewer
means the server resolved a row below the operator's, and it says which on its
own stderr the first time a request asks it to resolve one. To undo the install,
drop the flag: nothing was copied anywhere, no global configuration was touched,
and no `.mcp.json` was added to any project.

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

### Prerequisites on Linux

Node 24 or later, which runs the server, the runner and the CLI from their
TypeScript sources. The rest is what each engine's own sandbox needs, because
every specialist runs inside one.

**Claude's sandbox** needs `bwrap` and `socat` on `PATH`, and on Ubuntu 24.04
and later an AppArmor profile for `/usr/bin/bwrap` with `flags=(unconfined)`
and `userns` (design section 3, probe P1). Ubuntu's stock
`bwrap-userns-restrict` profile declares the same name and loads later, so a
profile written from Claude Code's docs can be shadowed by it; only a live
`bwrap`'s own confinement says whether the sandbox works (`docs/probes.md`, P1).
What cross-agent reports: a missing `bwrap` or `socat` fails the task before
Claude starts, with a reason naming what is missing (`claude sandbox refused:
bwrap and socat not found on PATH; …`); a sandbox that engages and then cannot
start a command fails the task with `claude sandbox failure: <the line Claude
printed>` rather than letting it run unsandboxed.

**Grok's sandbox** resolves its own list of runtime sockets it must deny —
Docker's, containerd's, D-Bus's, systemd's and podman's among them — path by
path, and refuses to start when it cannot resolve one. With rootful podman's
socket enabled, `/run/podman` is created `0700 root`, and `grok --sandbox
read-only` exits 1 before doing anything:

```
error: sandbox profile resolve failed: socket deny resolution failed: could not resolve runtime-socket deny path /run/podman/podman.sock: Permission denied (os error 13)
error: this sandbox could not enforce its deny list on Linux: the required bwrap plan could not be prepared; see the error above for the specific cause. Refusing to start with denied paths unprotected.
```

The remedy keeps the socket itself private and lets the path be resolved: copy
`/usr/lib/tmpfiles.d/podman.conf` to `/etc/tmpfiles.d/podman.conf` and change
its `/run/podman` line to `D! /run/podman 0711 root root`, which holds from the
next boot, and run `sudo chmod 0711 /run/podman` for the running system. What
cross-agent reports: the task fails with `grok sandbox failure: error: sandbox
profile resolve failed: …`, the first of those two lines, rather than a bare
`engine exited 1` (`docs/probes.md`, "Grok's read-only sandbox and the
runtime-socket deny list").

## Run the tests

```
npm test
```

No dependencies; Node 24 or later runs the TypeScript sources directly.

## The operator CLI

`cross-agent <verb>` — or `node ~/Documents/agent-team-cli/src/cli.ts <verb>`
where the package is not linked — is the operator's own entry point. Every verb
takes `--project <root>` (otherwise the project is the one the server would
find), `--json` for one JSON document on stdout, and `--help`.

| verb | what it does |
| --- | --- |
| `init [--mode <name>]` | writes `.cross-agent/config.json` for a mode, every role bound to a default you then edit; an existing config is left alone |
| `answer <ask-id> <text>` | answers an engine-placed lead's open question from a terminal; the first answer stands, and a second is refused naming when the first landed |
| `report [--since <task id>]` | every task, newest first — role, engine, model, effort, duration, outcome, id — then each task's final message; the outcome is `passed` (done), `failed` (failed or cancelled) or `unknown` (not settled, or no result file) |

One exit protocol for every verb:

| code | meaning |
| --- | --- |
| 0 | ok |
| 1 | error: something the command did not anticipate failed |
| 2 | usage: the command line could not be read (nothing on stdout) |
| 3 | precondition: the project, the mode, the ask or the task is not in the state the verb needs — with `--json`, the reason is the document on stdout |
| 4 | still running: a task the verb reads has not settled |
| 5 | needs the operator: a lead is waiting on an open ask |
| 6 | stalled: a task's engine has been silent past `limits.stallMinutes` |

`init`, `answer` and `report` exit 0, 1, 2 or 3; 4, 5 and 6 are reserved now for
the verbs the work plan's step 13 adds (design section 10).

## The lead, in one paragraph

In the design, the lead is whichever session holds the lead tools and runs
the mode's loop, and the mode's `placement` decides which process that
session is. Under `placement: host` it is your own session: it loads the loop
and is busy between `wait` calls. Under `placement: engine` a spawned engine
runs the loop, your session stays free to check status, watch it, answer its
questions through a mailbox, and cancel it, and the run survives closing your
session. Both are built: `dev-team` and `solo` place the loop in your host
session, and `dev-team-engine` in a Claude or Codex lead it launches, which asks
you questions through `list_asks`/`answer` or `cross-agent answer`.
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
