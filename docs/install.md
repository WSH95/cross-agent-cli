# Installing cross-agent

cross-agent attaches to a host — Claude Code, Codex or Grok — as one MCP server and the
`cross-agent` launcher skill. Claude Code and Codex install it from the
[agent-plugins](https://github.com/WSH95/agent-plugins) marketplace; Grok attaches it per
project from a clone of this repository. Each host's section gives the install, the check
and the way back, and the install from a clone for development.

## Requirements

- **Linux.** cross-agent reads `/proc` for process identities and holds its locks with
  util-linux `flock`, so it runs on Linux alone.
- **git**, **Node.js 24 or later** and **`flock`** on `PATH`. Node runs the TypeScript
  sources directly; there are no dependencies.
- **The engine CLIs your roles use** — `claude`, `codex`, `grok` — installed and signed in.
- **Each engine's sandbox prerequisites**, below.

## Linux prerequisites

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

**A Claude specialist signs in with the credentials `claude login` stored**, or
under `"billing": "api"` with `ANTHROPIC_API_KEY` from the server's environment. It
reads nothing of your `~/.claude/settings.json` — not its `env`, not its
`apiKeyHelper`, not your `deny` rules — because its line loads the project's
settings alone (design section 3).

**It does load the project's tracked `.claude/settings.json`**, which Claude Code
merges into every Claude role, and cross-agent does not override what that file
allows. A `permissions.allow` rule there for a file tool that reaches beyond the
role's workspace — a bare `Edit` or `Write`, `Edit(//…)`, `Edit(~/…)`,
`Edit(../…)` — or a `permissions.additionalDirectories` entry pre-approves writes
the specialist is otherwise refused, in a workspace you have trusted. Do not
commit such a rule in a project where specialists run; keep it in
`.claude/settings.local.json`, which a specialist does not load. For
information, the tracked `.claude/settings.json` also brings a specialist its
`env` (probed), while its `apiKeyHelper` reaching a specialist remains unprobed,
and its `sandbox.network.allowedDomains` does not reach a sandboxed one.

**Inside its sandbox a Claude specialist reaches no network host**, and inside its
own workspace its file tools are refused Claude Code's sensitive paths —
`.vscode/`, `.idea/`, `.husky/`, `.npmrc`, `.gitmodules` and more. Put a
dependency install in the project's `setupCommand`, which the lead runs outside
any sandbox with `run_command`, and change a sensitive file by hand
(`docs/probes.md`, "T12 fix round 2").

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

## Install it in Claude Code

From the marketplace, in a Claude Code session:

```
/plugin marketplace add WSH95/agent-plugins
/plugin install cross-agent@agent-plugins
```

or from a shell, `claude plugin marketplace add WSH95/agent-plugins` and `claude plugin
install cross-agent@agent-plugins`. The scope is yours: `user`, the default, attaches the
server to every Claude Code session, and `--scope local` to the one project, through its
untracked `.claude/settings.local.json`. Do not install it with `--scope project`: that
writes the tracked `.claude/settings.json`, which every Claude specialist loads, so each
would carry the plugin's skill and launcher. Claude Code runs the plugin from its cache,
`~/.claude/plugins/cache/agent-plugins/cross-agent/<version>/`, and keeps that copy until
the plugin's version changes. The plugin also puts `bin/cross-agent`, the operator CLI, on
the session's Bash tool PATH.

To check the install, start a session in a git repository: it should report the server
as `plugin:cross-agent:cross-agent`, connected, and offer thirteen tools spelled
`mcp__plugin_cross-agent_cross-agent__<tool>` — `delegate`, `wait`, `check`,
`result`, `cancel`, `list_tasks`, `describe_mode`, `list_roles`,
`verify_worktree`, `git_mutate`, `git_root`, `run_command`, `waive_review` — and, in a project
whose mode places its lead in an engine, `list_asks` and `answer` too. Fewer
means the server resolved a row below the operator's, and it says which on its
own stderr the first time a request asks it to resolve one.

To remove it, `/plugin uninstall cross-agent@agent-plugins`. That leaves the agent-plugins
marketplace registered for its other plugins; remove the marketplace too only if you use
none of them.

**If you also run Grok on this machine.** Grok loads the plugins Claude Code installs,
through its `.claude/plugins/` compatibility: `grok mcp doctor` lists a Claude Code plugin's
server, `plugin: context7`, among a Grok session's sources. So a Claude Code install of
cross-agent can reach your Grok sessions too, specialists in task worktrees included, where
its server serves the specialist row's read tools and never `delegate`. Grok's documented
switch is `[plugins] disabled = ["cross-agent"]` in `~/.grok/config.toml`, and a project's
own `.grok/config.toml` takes precedence over it for `[plugins]`; `grok inspect --json`
shows what a Grok session in a project loads. How a `--scope local` install and that switch
behave across projects has not been verified end to end.

### From a clone

```
git clone https://github.com/WSH95/cross-agent-cli ~/src/cross-agent-cli
claude --plugin-dir ~/src/cross-agent-cli
```

The repository root is the plugin root: `.claude-plugin/plugin.json` names the plugin and
declares this server under `mcpServers`, and `skills/` and `bin/` are found by convention.
To undo the install, drop the flag: nothing was copied anywhere, no global configuration
was touched, and no `.mcp.json` was added to any project. The flag holds for one session,
so a session you resume, `claude --resume <id>` or `claude -p --resume <id>`, attaches the
plugin only when it is given `--plugin-dir` again. For the CLI from a terminal, link the
clone's launcher onto your `PATH` (`ln -s ~/src/cross-agent-cli/bin/cross-agent
~/.local/bin/cross-agent`) or run `npm link` in the clone.

## Install it in Codex

From the marketplace:

```
codex plugin marketplace add https://github.com/WSH95/agent-plugins
codex plugin add cross-agent@agent-plugins
```

Then ask Codex: **“Use cross-agent to set up its MCP connection once for this host.”**
The installed skill can do this even when its MCP tools are not connected yet. It runs
its bundled `scripts/codex-setup.mjs install`; you do not need to locate the cache's
version directory or export a project variable. Restart MCP using Codex's restart
control, or open a new session. Ask it to call `describe_mode` and confirm `projectRoot`
and then `list_roles`.

This works for the CLI and local desktop Codex on a Linux host with Node 24+, Git,
util-linux `flock`, and the Codex CLI on its PATH. The helper also accepts an absolute
Codex executable via `--codex`. A remote host needs setup there, with the same Codex
home that runs the chat. Cross-agent requires Linux; attaching a skill does not make
its `/proc` process guards run on native macOS, Windows, or cloud ChatGPT.

Each chat's MCP process starts in that chat's project directory. A Git repository
without `.cross-agent/config.json` uses `solo` defaults. For a team, ask the skill to
run the bundled CLI's `init --mode dev-team` or `init --mode dev-team-engine` in the
project, then reconnect. The skill resolves the CLI relative to its own installed
location. Worktrees keep the ordinary project rules: an uninitialized worktree belongs
to its main project; running `init` in a branch worktree makes it a separate project.

### What setup changes

The helper writes one configured MCP entry, `mcp_servers.cross-agent`, in
`$CODEX_HOME/config.toml` (default `~/.codex/config.toml`), and an owned launcher and
state in `$CODEX_HOME/cross-agent/`. A persistent OS lock file serializes setup changes.
There is no project path or MCP `cwd` in that registration. It intentionally shadows
the plugin's bundled server; keep the plugin installed and enabled for its skill and
updates. Codex's native config API checks the config version when writing, preserving
unrelated settings and comments instead of replacing the whole file.

Setup forwards `CROSS_AGENT_PROJECT` and the three task markers (`CROSS_AGENT_TASK`,
`CROSS_AGENT_DEPTH`, `CROSS_AGENT_LINEAGE`) if they exist. You normally leave
`CROSS_AGENT_PROJECT` unset; an explicit value still selects a configured project.
Default startup and tool timeouts are 30 and 3600 seconds, and tool approval mode is
`approve`, matching the plugin mount. On repair, existing approval rules, disabled
tools and server-disable settings on its connection are preserved. A custom registration or another config layer
defining cross-agent is reported for you to resolve, never overwritten. Setup writes
are refused inside a cross-agent task.

Ask the skill to **check the Codex connection** for a read-only diagnostic, or to
**remove the Codex MCP setup** to undo it. `check` validates configuration and the
installed server, while `describe_mode` verifies the live connection and its project.
Removal deletes the owned connection, including its per-server policy, and leaves the
marketplace plugin and unrelated settings alone. Run it before `codex plugin remove cross-agent@agent-plugins` when
uninstalling. If you already removed the plugin, remove the leftover registration with
`codex mcp remove cross-agent`; the inert `$CODEX_HOME/cross-agent/` files can then be
removed. Keep the marketplace registered if you use its other plugins.

### Marketplace updates

Install and update through Codex's marketplace normally. On each new MCP connection,
the launcher reads Codex's installed-plugin inventory and runs that installed version,
including after the old cache copy has been deleted. A catalog refresh alone does not
install an update; once Codex installs it, reconnect to use it. You do not need to
repeat setup for each plugin version. Disabled or uninstalled plugins refuse new
connections, even if an old cache directory remains. Running tasks and existing MCP
processes are not replaced mid-session by a marketplace update.

`codex plugin list --json` shows the installed identity, version and enabled state;
`codex mcp get cross-agent` shows the stable configured launcher and no working-directory
binding. Tool names may carry the prefix `mcp__cross_agent__` (Codex folds the hyphen).

### Legacy explicit-project mount

Without the one-time setup, the bundled mount still runs in Codex's cached plugin
folder. It requires `CROSS_AGENT_PROJECT` to name a directory already initialized with
`cross-agent init`, even for `solo`:

```
cd ~/code/my-project
CROSS_AGENT_PROJECT="$PWD" codex
```

The setup helper removes the need for this launch convention. The legacy limitation
was observed with Codex 0.159.3 and remains in its inline manifest on 0.160.0;
`docs/probes.md#codexPluginMount` records why the relative launcher exists.

### From a clone

Codex installs plugins from marketplaces, and this repository is one:
`.agents/plugins/marketplace.json` offers `cross-agent` from the repository's own
root, and `.codex-plugin/plugin.json` gives it the launcher skill and this server.
Codex installs a plugin by copying the whole marketplace directory into its cache, so
register a clean export of the checkout's `HEAD`, in a directory of its own, and
install the plugin from it:

```
sha=$(git -C ~/src/cross-agent-cli rev-parse HEAD)
mkdir -p ~/.cache/cross-agent/codex-export/$sha
git -C ~/src/cross-agent-cli archive HEAD | tar -x -C ~/.cache/cross-agent/codex-export/$sha
codex plugin marketplace add ~/.cache/cross-agent/codex-export/$sha
codex plugin add cross-agent@cross-agent-cli
```

Codex runs the plugin from the copy it took at install time, under
`~/.codex/plugins/cache/cross-agent-cli/cross-agent/<version>/`, and the marketplace
stays registered at the export, so keep the export while it is. To move to a newer
checkout, export its `HEAD` into a new directory as above and register that one in
place of the old, so that no file deleted since lingers in the copy:

```
codex plugin remove cross-agent@cross-agent-cli
codex plugin marketplace remove cross-agent-cli
codex plugin marketplace add ~/.cache/cross-agent/codex-export/<new sha>
codex plugin add cross-agent@cross-agent-cli
```

Registering the checkout itself, `codex plugin marketplace add
~/src/cross-agent-cli`, works too, at a cost: the copy then takes everything in
the directory — the `.git` directory, `.worktrees/` with each worktree's
`.cross-agent/` task records, untracked and ignored files — 89 MB of this checkout on
2026-10-01 against 2.9 MB for an export, and every update is the remove and add above.

Everything above holds for this install under its own id, `cross-agent@cross-agent-cli`,
in place of `cross-agent@agent-plugins`.

Remove the one-time MCP setup through the skill first, if configured, then:

```
codex plugin remove cross-agent@cross-agent-cli
codex plugin marketplace remove cross-agent-cli
```

The first deletes the `[plugins."cross-agent@cross-agent-cli"]` table, whatever it
says, and the cached copy, leaving the empty directory
`~/.codex/plugins/cache/cross-agent-cli/`; the second deletes the
`[marketplaces.cross-agent-cli]` table. The export is yours to delete after that.

### Without the plugin

The same server can be attached as a configured MCP server instead. It runs the
checkout itself rather than a copy, and it starts where the session runs, so it finds
the project as the Claude Code plugin does and needs no `CROSS_AGENT_PROJECT`:

```
codex mcp add cross-agent -- node ~/src/cross-agent-cli/src/server.ts
rm -rf ~/.codex/skills/cross-agent
mkdir -p ~/.codex/skills/cross-agent
cp -R ~/src/cross-agent-cli/skills/cross-agent/. ~/.codex/skills/cross-agent/
```

The skill's copy replaces any earlier one rather than landing inside it. Its
directory, `~/.codex/skills/`, is where Codex's own skill installer puts a skill, as
the codex-cli 0.159.3 binary's text says; no run here has loaded a skill from it.
The copy does not follow the checkout: after each update of the checkout, run the
three lines that replace it again, or the session keeps the launcher skill it was
given while the server it calls has moved on.
`codex mcp add` writes the command alone. Add the four keys it does not write to the
`[mcp_servers.cross-agent]` table it wrote, or paste `assets/codex/mcp_servers.toml`
with `<repo>` replaced in place of the `add`: `env_vars = ["CROSS_AGENT_PROJECT",
"CROSS_AGENT_TASK", "CROSS_AGENT_DEPTH", "CROSS_AGENT_LINEAGE"]`, so that a session
started inside a task hands its server the task's markers; `tool_timeout_sec = 3600`,
without which a `wait` gets Codex's 60 seconds; `default_tools_approval_mode =
"approve"`, without which a call under `codex exec`, whose approval policy is `never`,
failed with "MCP tool call requires approval, but approval policy is never"
(`docs/probes.md`, "P9: per-engine lead mount and instruction delivery"); and
`startup_timeout_sec = 30`, the start-up budget the plugin's manifest gives the same
server. The skill is a copy of `skills/` alone; each mode's own loop
reaches the session through `describe_mode`. `codex mcp get cross-agent` shows the table
as Codex reads it, and `codex mcp remove cross-agent` with `rm -r
~/.codex/skills/cross-agent` undoes it. This manual checkout route is separate from
the marketplace setup above: do not combine the two configurations. Both use a
`[mcp_servers.cross-agent]` table, which shadows the plugin's bundled server, budget
and all. A copied standalone skill has no installed plugin for its Codex setup helper
to resolve; keep using this checkout recipe or install through a marketplace.

## Install it in Grok

Grok attaches cross-agent per project, from a clone of this repository that the attach
reads in place, so keep the clone where it is and `git pull` it to update:

```
git clone https://github.com/WSH95/cross-agent-cli ~/src/cross-agent-cli
```

Grok reads this repository as a plugin in place, per project: the project's own
`.grok/config.toml` names the checkout under `[plugins]`, and grok 1.0.46 then takes the
launcher skill from `skills/` and this server from `.claude-plugin/plugin.json`'s
`mcpServers`, expanding `${CLAUDE_PLUGIN_ROOT}` to the checkout. Nothing is installed
or copied. The headless `grok` has no `--plugin-dir` (only `grok agent`, which an ACP
client drives, takes one), and `grok plugin install` would put this server in every Grok
session on the machine, so the attach lives in the project:

```
cd ~/code/my-project
cross-agent init --mode dev-team
printf '\n.grok/\n' >> .gitignore
git add .gitignore && git commit -m 'Ignore cross-agent and Grok state' -- .gitignore
# If .grok/config.toml already has a [plugins] or [mcp] table, merge by hand: see below.
mkdir -p .grok
cat >> .grok/config.toml <<EOF
[plugins]
paths = ["$HOME/src/cross-agent-cli"]
enabled = ["cross-agent"]

[mcp]
max_output_bytes = 100000
EOF
```

`init` comes first because the server finds its project from where it runs: Grok starts
the plugin's server in the session's own working directory, and the server serves the
project whose `.cross-agent/config.json` it finds there or above it. `cross-agent` is on
`PATH` only where you linked it; elsewhere the command is
`~/src/cross-agent-cli/bin/cross-agent init --mode dev-team`.
`.grok/` goes into `.gitignore` beside `init`'s own entries because its file names your
checkout's path, and because a committed `.grok/config.toml` would reach every task
worktree: Grok takes a linked worktree as a project of its own, so it would load the
plugin for every worktree specialist, and a specialist's edit to it — or to `.claude/`,
`.codex/` or `.mcp.json` — is refused at the worktree's commit and at the merge, naming
the path, so the ignore is what keeps the file out of the worktrees in the first place.
Host configuration must be regular files: a symbolic link at any of the four root
paths, or anywhere below them, is refused by name, case-insensitively. A commit checks
its current tree, index and working tree (even ignored links); a merge checks the
incoming branch's tree. Replace links with regular files before retrying, by hand at
the root for tracked configuration. This refuses every link a task's branch or worktree
carries; it does not police a link you keep at the root yourself, outside git, that
points into the tree — so keep the root's own host configuration as regular files too,
the same way you keep the servers and hooks they name as tracked files.
The `printf` that appends `.grok/` puts it on a line of its own: `init` leaves a last line
with no newline alone when it has nothing to add, and `echo` would join `.grok/` onto it.
Commit that `.gitignore` change before the team's first task: a loop's first step stops on anything `git status --porcelain
--untracked-files=normal` prints. `paths` takes an absolute path, which is why the lines
are written through the shell: Grok expands no `~` there, and a `~/Documents/…` entry
loaded no plugin at all.

A project that already tracks `.grok/config.toml` needs one step more, since `.gitignore`
does not cover a tracked file: in place of the commit line, with nothing else staged, run
`git rm --cached .grok/config.toml && git add .gitignore && git commit -m 'Ignore
cross-agent and Grok state'`, before you edit the file. That commits the file's removal
with the `.gitignore` change and keeps the file on your disk, though other clones lose it at
their next pull. A commit limited to `-- .gitignore` would leave the removal staged, and one
that also named `.grok/config.toml` would track the file again.

The heredoc is for a project whose `.grok/config.toml` has no `[plugins]` or `[mcp]` table
yet: TOML refuses a table, or a key, declared twice. Where the file has them, edit them
instead: add the checkout's absolute path, your home directory written out, to the existing
`paths` array — what the heredoc's `$HOME/src/cross-agent-cli` becomes once the shell
expands it — and `"cross-agent"` to the existing `enabled` array, and set
`max_output_bytes` under `[mcp]` to 100000 unless it is already larger, keeping the larger
value. Where you raise it, note the value you replace, for the removal below.

The `[mcp]` table raises the size at which Grok cuts an MCP tool's answer, 20,000 bytes by
default, past what `describe_mode` answers: the mode's text, without `projectRoot`, is
35,474 bytes under `dev-team`, 40,997 under `dev-team-engine` and 3,463 under `solo`, and
the answer adds the project's root beside it, so the default cuts both dev-team modes. Under the
default, a Grok host in a `dev-team-engine` project read the first 19.5 KB of the mode and
a note naming the file under its session directory where Grok had written the rest; with
the line, it read the answer whole (`docs/probes.md`, "T15: the Grok attach").

A project's `.grok/config.toml` counts only in a folder Grok trusts: a headless session in
an untrusted folder loads no project plugin and starts no project server. Trust the
project once, by accepting Grok's prompt the first time you open it there or by starting
Grok there with `--trust`; Grok's own guide says the grant is recorded in
`~/.grok/trusted_folders.toml` and covers the repository's subdirectories but not a nested
checkout, yet a linked worktree under a trusted project was reported trusted, as a project
root of its own (`docs/probes.md`, "A Grok specialist in a linked worktree, B5").

To check the attach, from the project:

```
grok inspect --json
grok mcp doctor cross-agent
```

`grok inspect --json` should show `"projectTrusted": true`, a plugin `cross-agent` of
scope `config` at the checkout, the skill `cross-agent` whose source is that plugin, and
the server `cross-agent` from the same plugin. `grok mcp doctor cross-agent` lists `plugin:
cross-agent` among its config sources and reports `cross-agent (stdio: node
<checkout>/src/server.ts)` started, its handshake OK, and the operator row's tools
discovered: thirteen in a project bound to `dev-team` or `solo`, fifteen under
`dev-team-engine`. `grok mcp list` and `grok plugin list` show neither, because they list
configured servers and installed plugins only. In a session the tools are spelled
`cross-agent__<tool>`, the server's name and the tool's, and Grok reaches them through its
own `search_tool` and `use_tool`. The session's first `system/init` line names the server
as `pending` and lists its tools in some sessions and not in others: that line is a
snapshot taken before the handshake, and the session's own `events.jsonl` records the
connection and the tools.

Grok gives an MCP call `tool_timeout_sec`, 6000 seconds by default, and the plugin's
server gets that default: its calls' `mcp_tool_call_started` events read `timeout_sec:
6000`. So the launcher's 600-second `wait` fits with room: one returned intact under a
Grok host, at 600.003 s by Grok's own record of the call (`docs/probes.md`, "B3: a
ten-minute wait under a Grok host").

To remove it, take out of the project's `.grok/config.toml` only what the attach added:
the checkout's path from `paths`, `"cross-agent"` from `enabled`, and `max_output_bytes`,
restored to the value you noted, or deleted where the attach added it; delete the file
itself only if the attach's lines were all it held. The `.grok/` line can stay in
`.gitignore`. That is the whole attach: it writes nothing under `~/.grok/`, installs no
plugin and reads the checkout where it is. The folder's trust stays in
`~/.grok/trusted_folders.toml`, which is yours to keep or edit.

Four things hold for every Grok session attached this way:

- **Grok is never a lead.** A `dev-team-engine` project binds its `lead` to Claude or
  Codex; the config refuses a Grok lead, and `delegate` refuses to launch one. Every other
  role may run on Grok.
- **A Grok specialist working in a linked worktree reaches no server.** Grok reads a
  project's `.grok/config.toml` from the session's directory up to its git root, and a
  linked worktree is a root of its own, holding no `.grok/` while `.grok/` stays ignored,
  so the attach is not there: `grok mcp doctor` run in one lists no project source, and a
  Grok code reviewer in E6's worktree mounted no server (`docs/probes.md`, "A Grok
  specialist in a linked worktree, B5"). Only a committed `.grok/config.toml`, which the
  recipe keeps out, or a mount at user scope would change that, and neither is there. A
  Grok specialist at the project root inherits the attach and gets the specialist row's
  five read tools.
- **A server Grok starts gets the session's environment**: the host's whole environment
  plus `GROK_SESSION_ID`, read from `/proc` while a host ran, and inside a task the task's
  `CROSS_AGENT_*` markers, as a Grok plan reviewer's server held them in S11's runs. So a
  Grok session started inside a task, from a test suite a lead runs, say, gets a
  specialist's tools, never the operator's: a host started with `CROSS_AGENT_DEPTH=1` and
  no task was served the specialist row's five (`docs/probes.md`, "The hop count and the
  server's environment under a Grok host, B4").
- **The launcher skill reaches a Grok specialist at the root.** The attach carries the
  `cross-agent` skill with the server, so a Grok specialist working at the project root is
  offered the launcher too — every one T15 ran there listed it — while its row still has
  no `delegate`: a specialist that follows the skill and calls it is refused by Grok's own
  dispatcher, which holds no such tool, before the server is ever asked (`docs/probes.md`,
  "I1: authority under a Claude Code host"), and is never served.
