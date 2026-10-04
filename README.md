# cross-agent

Run headless `claude`, `codex` and `grok` processes as one team, from whichever of the
three you work in. cross-agent is an MCP server and a launcher skill: your session, the
**host**, hands work to other engines, each running headless in its own CLI's sandbox on
your own subscription, and a **mode** decides the team — its roles, the loop its lead runs,
and its git policy.

| Mode | The team | The loop runs in |
| --- | --- | --- |
| `solo` | one consultant: another engine reads and answers, or takes one change in a worktree of its own | your session |
| `dev-team` | planner, plan reviewer, implementer, as many code reviewer seats as you bind, and a resolver; the planners read the project, and each task's change is made and reviewed in a git worktree of its own | your session |
| `dev-team-engine` | the same team | a Claude or Codex lead the server launches, so your session stays free |

A git repository with no cross-agent config runs as `solo`, so a one-off delegation needs
no setup.

## How it works

- **One server, three hosts.** The same MCP server and skill attach to Claude Code, Codex
  and Grok. `.cross-agent/config.json` binds each role to an engine, a model and an effort.
- **Authority from process ancestry, not tokens.** Your session gets the operator's tools,
  a lead the loop's, and a specialist a few read tools and never `delegate`, so no
  delegation loop can form.
- **Every specialist in its engine's sandbox.** It writes only its own workspace, and it is
  denied launching `claude`, `codex`, `grok`, this server or its CLI.
- **Git stays with the server.** Specialists never write git metadata; worktree and root
  git go through the server's `git_mutate` and `git_root`, journaled per task.
- **Two merge guards.** A merge needs the configured test suite to have passed on that
  exact branch head and, for a team task, a clean review from every reviewer seat, or your
  recorded waiver.

## Requirements

- Linux, `git`, Node.js 24 or later, and util-linux `flock`. There are no other
  dependencies: Node runs the TypeScript sources directly.
- The engine CLIs your roles use — `claude`, `codex`, `grok` — installed and signed in.
- Each engine's sandbox prerequisites, such as `bwrap` and `socat` for Claude:
  [Linux prerequisites](docs/install.md#linux-prerequisites).

## Install

Claude Code and Codex install it from the
[agent-plugins](https://github.com/WSH95/agent-plugins) marketplace; Grok attaches it per
project from a clone of this repository. [docs/install.md](docs/install.md) has every
step, check and removal, and the installs from a clone.

**Claude Code**, in a session:

```
/plugin marketplace add WSH95/agent-plugins
/plugin install cross-agent@agent-plugins
```

Keep the default user scope, or use `--scope local` for one project; never
`--scope project`, which every Claude specialist would load.

**Codex:**

```
codex plugin marketplace add https://github.com/WSH95/agent-plugins
codex plugin add cross-agent@agent-plugins
```

Under Codex the server serves only the project you name, and only once that project has a
config, even for `solo`: run `init` there (below), then start Codex from the project with
`CROSS_AGENT_PROJECT="$PWD" codex`.

**Grok:** clone this repository and name it in the project's own `.grok/config.toml`:
[Install it in Grok](docs/install.md#install-it-in-grok).

## Quick start

**Ask another engine, with no setup.** In any git repository, under Claude Code or Grok,
ask your session, for example: *"Use cross-agent to have Codex review src/parser.ts and
tell me what it finds."*

**Run a team.** Once per project, write its config — the mode, and the engine, model and
effort of each role. In Claude Code, ask your session to run `cross-agent init --mode
dev-team` in the project; from a terminal, run the installed copy's launcher
([The operator CLI](#the-operator-cli)):

```
cd ~/code/my-project
cross-agent init --mode dev-team
```

Edit `.cross-agent/config.json` to bind the roles as you like. Commit that `.gitignore`
change `init` made before the team's first task (`git add .gitignore && git commit -m '…'
-- .gitignore`): a loop's first step stops unless `git status --porcelain
--untracked-files=normal` prints nothing at the project's root. Start a new session in the
project — the server reads the mode once, when it starts — and ask it for the work, for
example: *"Use the cross-agent dev team to add a --json flag to the export command."* Under `dev-team` your session runs the loop — plan, plan review, implementation
in a worktree, parallel code review, fixes, a tested merge. Under `dev-team-engine` a lead
runs it and puts its questions to you, which you answer with `cross-agent answer`.

[docs/operator-guide.md](docs/operator-guide.md) covers the team's settings, the merge
guards and the waiver, and running teams on several branches at once.

## The operator CLI

The CLI ships inside the plugin, so it needs no separate install, but installing the
plugin does not put a `cross-agent` command on your shell's `PATH`:

- **In Claude Code** the plugin's `bin/cross-agent` is on the session's Bash tool `PATH`:
  ask Claude to run `cross-agent init --mode dev-team`.
- **From a terminal** run the installed copy's launcher, for example
  `~/.codex/plugins/cache/agent-plugins/cross-agent/<version>/bin/cross-agent`, or link a
  clone's `bin/cross-agent` onto your `PATH`.

You need it for `init` once per project — for the team modes, and under the Codex plugin
for `solo` too. The rest is optional, since your session reaches the same operations
through the plugin's tools:

| Command | What it does |
| --- | --- |
| `cross-agent tasks`, `cross-agent show <id>` | what the team is doing |
| `cross-agent report` | every task, its outcome and its final message |
| `cross-agent list-asks`, `cross-agent answer <ask-id> <text>` | a lead's questions to you |
| `cross-agent cancel <id>` | stop a task and everything it delegated |

Every verb and its exit codes: [The operator CLI](docs/operator-guide.md#the-operator-cli).

## Documentation

- [docs/install.md](docs/install.md): installing, checking and removing it per host; the
  Linux prerequisites; installs from a clone.
- [docs/operator-guide.md](docs/operator-guide.md): team configuration and the merge
  guards, every CLI verb, several branches at once.
- [docs/design.md](docs/design.md): the design, which is authoritative, and
  [docs/probes.md](docs/probes.md): what each engine CLI was observed to do.

## Development

```
npm test                                              # the suite, node:test
node tools/build-dist.mjs                             # the Claude and Codex payloads, from HEAD, into dist/cross-agent
python3 tools/publish_agent_artifact_pr.py --dry-run  # preview the agent-plugins pull request
```

A release bumps the version in `package.json` and both plugin manifests (Claude Code keeps
users on their cached copy until it changes), commits, and pushes `main`. Then
`python3 tools/publish_agent_artifact_pr.py --build --commit-message "…" --pr-title "…"
--pr-body "…" --keep-temp` builds the payloads from that commit and opens the pull request,
which replaces `cross-agent/` alone: the marketplace's root entries for cross-agent came with
its first publication.

## License

MIT. See [LICENSE](LICENSE).
