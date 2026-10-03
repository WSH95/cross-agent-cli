# cross-agent

One MCP server plus a launcher skill that run a team of headless `claude`,
`codex`, and `grok` processes on your own subscriptions, each inside its own
CLI's sandbox. A host is anything that can attach an MCP server and load a
skill: Claude Code, Codex, and Grok today. What the team does is a **mode** —
data, not code: the roles, the loop the lead runs, and a git policy — and three
are built in: `dev-team`, the worktree team (planner, plan reviewer,
implementer, as many code reviewer seats as the config binds, and a resolver);
`dev-team-engine`, the same team with its loop in a lead the server launches; and
`solo`, one consultant and no team.
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
on `main`; one test needs a real `codex` binary and an account, so it runs only
under `CROSS_AGENT_REAL_CODEX=1` and is skipped otherwise. On top
of it: the mode loader and the three built-in modes, the authority model and
the thirteen tools it gates under every mode — `delegate`, `wait`, `check`,
`result`, `cancel`, `list_tasks`, `describe_mode`, `list_roles` and the worktree
provider's five — with the mailbox's `ask`, `list_asks` and `answer` beside them
under `dev-team-engine`, fifteen for the operator and for the lead; engine
placement, which launches the loop in a Claude or Codex lead of its own; the
operator CLI; the launcher skill with each mode's own loop; the packaging for Claude
Code, Codex and Grok; and branch worktrees as projects of their own, each running its
team on its own branch ("Several branches at once"). `docs/design.md`
is the design and the work plan; `docs/probes.md` records what each engine CLI
was observed to do, and `VERIFY.md` what each milestone's own runs showed.
Nothing of the design's work plan is left but its backlog row. The plan closed on
2026-10-02, and `.project-steward/DECISIONS.md` (0011) records its end-to-end runs
and the operator conditions they set.

## Install it in Claude Code

The repository root is the plugin root: `.claude-plugin/plugin.json` names the
plugin and declares this server under `mcpServers`, and `skills/` is found by
convention. In development, point a session at the checkout:

```
claude --plugin-dir ~/Documents/cross-agent-cli
```

The session should report the server as `plugin:cross-agent:cross-agent`,
connected, and offer thirteen tools spelled
`mcp__plugin_cross-agent_cross-agent__<tool>` — `delegate`, `wait`, `check`,
`result`, `cancel`, `list_tasks`, `describe_mode`, `list_roles`,
`verify_worktree`, `git_mutate`, `git_root`, `run_command`, `waive_review` — and, in a project
whose mode places its lead in an engine, `list_asks` and `answer` too. Fewer
means the server resolved a row below the operator's, and it says which on its
own stderr the first time a request asks it to resolve one. To undo the install,
drop the flag: nothing was copied anywhere, no global configuration was touched,
and no `.mcp.json` was added to any project. The flag holds for one session, so a
session you resume, `claude --resume <id>` or `claude -p --resume <id>`, attaches
the plugin only when it is given `--plugin-dir` again.

Then, once per project the team is to work in, write its bind-time config —
which mode, and the engine, model and effort each of that mode's roles runs on:

```
cd ~/code/my-project
cross-agent init --mode dev-team
```

`cross-agent` is `package.json`'s `bin`, so it is on `PATH` only where the
package is linked; everywhere else the same command is `node
~/Documents/cross-agent-cli/src/cli.ts init --mode dev-team`. Either way `init`
writes `.cross-agent/config.json` with every role bound to a default you then
edit, adds `.cross-agent/` and the mode's worktree directory to `.gitignore`,
and leaves an existing config alone. Commit that `.gitignore` change before the
team's first task (`git add .gitignore && git commit -m '…' -- .gitignore`): a
loop's first step stops unless `git status --porcelain --untracked-files=normal`
prints nothing at the project's root. The server discovers that project from the
host session's working directory, so a session started anywhere inside it runs
that project's team.

In a `dev-team` project `init` binds the code reviewer to three seats — Claude,
Codex and Grok, each read-only — which review the committed branch in parallel, and
the resolver to a stronger model, which takes the findings two fix rounds have left
standing; a code reviewer bound to a writable profile is refused by field, since its
seats read beside each other in one worktree. A config written before the resolver
existed still loads, and its team's first task stops at the roster until you add
`roles.resolver` by hand, because `init` leaves an existing config alone.
`limits.planReviewRounds` (default 3) is how many consecutive plan reviews may find
major issues before the loop stops and asks you, and `review.afterResolver` — `ask`
by default, `lead-decides` or `always-ask` — says what it does when significant
findings outlast the resolver: ask you, let the lead rule and record the waiver, or
ask you whatever stands. Two guards back the loop, so that no misreading of its text
and no crash merges untested or unreviewed work; a session that races its own tools
against them is outside what they promise. `git_root merge` refuses a branch head
the configured suite has not passed on in a fresh checkout of that head under
`.cross-agent/gate/`, after the setup command, and, for a team task, one every
reviewer seat has not finished a clean review of, unless you waive it with
`cross-agent waive <slug> <commit>`. A reviewer is refused while the worktree holds
uncommitted changes or its setup command runs. `cross-agent journal <slug>` shows
the `tested` and `review-waived` steps.

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

## Install it in Codex

Codex installs plugins from marketplaces, and this repository is one:
`.agents/plugins/marketplace.json` offers `cross-agent` from the repository's own
root, and `.codex-plugin/plugin.json` gives it the launcher skill and this server.
Codex installs a plugin by copying the whole marketplace directory into its cache, so
register a clean export of the checkout's `HEAD`, in a directory of its own, and
install the plugin from it:

```
sha=$(git -C ~/Documents/cross-agent-cli rev-parse HEAD)
mkdir -p ~/.cache/agent-team/codex-plugin-export/$sha
git -C ~/Documents/cross-agent-cli archive HEAD | tar -x -C ~/.cache/agent-team/codex-plugin-export/$sha
codex plugin marketplace add ~/.cache/agent-team/codex-plugin-export/$sha
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
codex plugin marketplace add ~/.cache/agent-team/codex-plugin-export/<new sha>
codex plugin add cross-agent@cross-agent-cli
```

Registering the checkout itself, `codex plugin marketplace add
~/Documents/cross-agent-cli`, works too, at a cost: the copy then takes everything in
the directory — the `.git` directory, `.worktrees/` with each worktree's
`.cross-agent/` task records, untracked and ignored files — 89 MB of this checkout on
2026-10-01 against 2.9 MB for an export, and every update is the remove and add above.

Codex starts the plugin's server in its copy, not where the session runs: codex-cli
0.159.3 resolves a plugin server's working directory against the plugin, and it
substituted no `${PLUGIN_ROOT}` in the inline `command`, `args` and `cwd` it was given.
From the copy the server cannot find your project. A copy of an export holds no
project, and a copy of a checkout carries the checkout's `.git`, which leads discovery
to a repository you did not name: the copy itself, for a main checkout or a worktree
initialized as a project of its own, or, for any other linked worktree, the main
checkout its pointer leads to. So name the project, as the absolute path of a directory
holding `.cross-agent/config.json`, before Codex starts:

```
cd ~/code/my-project
CROSS_AGENT_PROJECT="$PWD" codex
```

A resumed session is a process of its own and reads the variable again, so start
`codex resume` or `codex exec resume` the same way, from the project with
`CROSS_AGENT_PROJECT` set.
Without `CROSS_AGENT_PROJECT` the plugin's launcher exits before any server starts,
and Codex does not say so: under `codex exec` nothing reached its stderr, its `--json`
events or the session's rollout, and the session simply had none of the server's
tools (`docs/probes.md`, "The task's markers through the plugin's whitelist"). The
plugin also hands its server a task's markers, `CROSS_AGENT_TASK`, `CROSS_AGENT_DEPTH`
and `CROSS_AGENT_LINEAGE`, whenever the session has them, so a Codex session started
inside a task — from a test suite the lead runs, say — gets a specialist's tools, never
the operator's; from a clean shell there are none to hand on.

To check the install, `codex plugin list --json` lists `cross-agent@cross-agent-cli`
with `"installed": true` and `"enabled": true`, `codex mcp list` shows a server
`cross-agent` whose command is `./.codex-plugin/serve`, and a session started as
above answers `list_roles` with the project's roles. Its tools are the ones Claude
Code offers, spelled `mcp__cross_agent__<tool>`: Codex folds the hyphen. The manifest
gives the server `tool_timeout_sec: 3600` where Codex's own default is 60 seconds, so
a `wait` of 600 seconds returns with room: one did, at 600.004 s by Codex's own
record, while a copy declaring 60 cut the same call at 60 s
(`docs/probes.md`, "B3: a ten-minute wait under a Codex host").

An installed plugin is enabled, and every Codex session on the machine then runs its
launcher; each one started with `CROSS_AGENT_PROJECT` set gets the server. To have it
only when you ask for it, turn it off in `~/.codex/config.toml`:

```
[plugins."cross-agent@cross-agent-cli"]
enabled = false
```

and on for one session with `codex -c plugins.cross-agent@cross-agent-cli.enabled=true`.
The key is unquoted on the command line; quoted, it names nothing. `codex plugin add`
writes `enabled = true` again, so turn it off again after every reinstall. Do not write
`enabled = false` under `[mcp_servers.cross-agent]` while the plugin is installed:
that declares a server with no command, and Codex then refuses to load its
configuration at all.

Codex writes to that file on its own as well: a session in a project with no trust
entry adds `[projects."<path>"] trust_level = "trusted"` for it, with no prompt. A host
session started as above did (`docs/probes.md`, "B3: a ten-minute wait under a Codex
host"), and so does every Codex specialist the team runs in that project,
`--ignore-user-config` notwithstanding (`docs/probes.md`, "I2 under a Codex host
(B6)"). So a project the team has worked in is one Codex trusts afterwards, the
entries outlive the repositories they name, and they are yours to delete.

To remove it:

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
codex mcp add cross-agent -- node ~/Documents/cross-agent-cli/src/server.ts
rm -rf ~/.codex/skills/cross-agent
mkdir -p ~/.codex/skills/cross-agent
cp -R ~/Documents/cross-agent-cli/skills/cross-agent/. ~/.codex/skills/cross-agent/
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
~/.codex/skills/cross-agent` undoes it. Install one attach or the other, not both: a
`[mcp_servers.cross-agent]` table shadows the plugin's server of the same name, budget
and all.

## Install it in Grok

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
paths = ["$HOME/Documents/cross-agent-cli"]
enabled = ["cross-agent"]

[mcp]
max_output_bytes = 100000
EOF
```

`init` comes first because the server finds its project from where it runs: Grok starts
the plugin's server in the session's own working directory, and the server serves the
project whose `.cross-agent/config.json` it finds there or above it. `cross-agent` is on
`PATH` only where the package is linked; elsewhere the command is `node
~/Documents/cross-agent-cli/src/cli.ts init --mode dev-team`, as in the Claude Code section.
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
Commit that `.gitignore` change before the team's first task, as the Claude Code section
says: a loop's first step stops on anything `git status --porcelain
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
`paths` array — what the heredoc's `$HOME/Documents/cross-agent-cli` becomes once the shell
expands it — and `"cross-agent"` to the existing `enabled` array, and set
`max_output_bytes` under `[mcp]` to 100000 unless it is already larger, keeping the larger
value. Where you raise it, note the value you replace, for the removal below.

The `[mcp]` table raises the size at which Grok cuts an MCP tool's answer, 20,000 bytes by
default, past what `describe_mode` answers: the mode's text, without `projectRoot`, is
35,424 bytes under `dev-team`, 40,946 under `dev-team-engine` and 3,463 under `solo`, and
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

## Run the tests

```
npm test
```

No dependencies; Node 24 or later runs the TypeScript sources directly.

## The operator CLI

`cross-agent <verb>` — or `node ~/Documents/cross-agent-cli/src/cli.ts <verb>`
where the package is not linked — is the operator's own entry point. Every verb
takes `--project <root>`, `--json` for one JSON document on stdout whatever the
exit, and `--help`. Without `--project`, `init` writes in the current directory,
and every other verb reads the project the server would find:
`CROSS_AGENT_PROJECT`, then the nearest `.cross-agent/config.json`, then the git
toplevel — a directory inside a task's worktree read as its root, and a worktree
nobody initialized as its main checkout. Each verb calls the function its tool calls,
and a verb that reads writes nothing: not a record, not a lock, not a stall reading.

| verb | what it does | exits |
| --- | --- | --- |
| `init [--mode <name>] [--from <dir>]` | writes `.cross-agent/config.json` for a mode, every role bound to a default you then edit; an existing config is left alone. In a linked worktree it copies the config of the main checkout, or of `--from`, with the worktree's own branch as the default, or with `--mode` writes that mode's defaults instead, and copies the Grok attach of `--from` or of the main checkout beside it; `--mode` with `--from` is a 2; 3 for a task worktree, a detached HEAD, or a branch the mode's task pattern matches | 0, 3 |
| `modes` | the installed modes, the active one starred, each with its roles; a config naming a mode this build does not have is a 3, with the listing still printed | 0, 3 |
| `tasks [--status <status>] [--reconcile]` | every task, newest first — id, status, role (`code-reviewer#2` for a code reviewer's second seat; `--json` keeps `role` and `seat` apart), engine, depth, age, cwd — as the ledger holds it, a task whose runner is gone marked so, and every record file no reader could judge named; `--reconcile` runs `list_tasks`' reconciliation pass first, the one read that writes | 0 |
| `show <id> [--lines <n>]` | one task: its record, the role spelled as `tasks` spells it and a review's `underReview` commit among its fields, the last lines of its engine's stream, its outcome, its journal and its final message; 4 while it runs and 6 when it is stalled, by the status the last `wait` or `check` wrote | 0, 3, 4, 6 |
| `log <id> [--lines <n>]` | the last lines of a task's engine event stream, 50 by default | 0, 3 |
| `cancel <id>` | cancels a task and every task it delegated, leaves first, and its lineage's open asks; 4 while a task of the cascade is still active, which a second cancel retries | 0, 3, 4 |
| `verify-worktree <path> <branch>` | verifies a linked worktree on its exact branch, as `verify_worktree` does | 0, 3 |
| `git <slug> [--path <dir>] [--branch <name>] -- <args…>` | runs one git subcommand in a verified worktree, under the project's locks and journaled, as `git_mutate` does; 1 when git itself ran and failed, with its own output | 0, 1, 3 |
| `git-root [--slug <slug>] -- <args…>` | runs one whitelisted git verb at the project root, under the project's locks and the repository lock, and journals the step it completes, as `git_root` does; 1 when git itself ran and failed, or ran and its step could not be journaled | 0, 1, 3 |
| `journal [<slug>]` | one task's git journal, step by step, or every journal's slug; 1 when the journal file does not read, naming it | 0, 1, 3 |
| `waive <slug> <commit>` | records your waiver of the review guard for the branch head of a task, as `waive_review` does; 3 when the commit is not that head or the task is merged or closed | 0, 3 |
| `list-asks [--status <status>]` | every question an engine-placed lead has put to you, in the order asked; 5 while one it printed is open, and a damaged ask file is named rather than hiding the rest | 0, 5 |
| `answer <ask-id> <text>` | answers an engine-placed lead's open question from a terminal; the first answer stands, and a second is refused naming when the first landed | 0, 3 |
| `report [--since <task id>]` | every task, newest first — role (as `tasks` spells it), engine, model, effort, duration, outcome, id — then each task's final message, indented under its heading; the outcome is `passed` (done), `failed` (failed or cancelled) or `unknown` (not settled, or no result file) | 0, 3 |

One exit protocol for every verb:

| code | meaning |
| --- | --- |
| 0 | ok |
| 1 | error: something the command did not anticipate failed, or, for `git` and `git-root`, git itself — with `--json`, `{ok: false, error}` on stdout, or the git verb's answer whole |
| 2 | usage: the command line could not be read — with `--json`, `{ok: false, error, usage}` on stdout, and nothing there without it |
| 3 | precondition: the project, the mode, the ask or the task is not in the state the verb needs — with `--json`, the verb's answer naming the reason is the document on stdout |
| 4 | still running: a task the verb names has not settled |
| 5 | needs the operator: a lead is waiting on an open ask |
| 6 | stalled: a task's engine has been silent past `limits.stallMinutes` |

Beside the codes in the verb table, any verb exits 1 for an error nothing
anticipated and 2 for a command line it cannot read, and every verb but `init`
exits 3 when no project resolves. 4, 5 and 6 are verdicts and print on stdout:
`show` exits 4 for a task still running and 6 for a stalled one, `cancel` 4
for a cascade that left a task active, and `list-asks` 5 for an open ask. A verb
that writes — `init`, `answer`, `cancel`, `git`, `git-root`, `waive` and `tasks --reconcile` — exits
3 when its own environment carries `CROSS_AGENT_TASK`, `CROSS_AGENT_DEPTH` or
`CROSS_AGENT_LINEAGE`, the markers of a task's process tree: writing is the
operator's, and an engine reaches the project through the server.

## Several branches at once

A worktree can be a project of its own, its team running on its own branch: its tasks
branch from and merge into that branch, its root roles and its suite run in it, and the
projects of one repository run at the same time. Make the worktree beside the main
checkout, then initialize it:

```
cd ~/code/my-project
git worktree add ../my-project-x -b x
cd ../my-project-x
cross-agent init
```

`init` there copies the main checkout's `.cross-agent/config.json` — the team as you
bound it — with `project.defaultBranch` set to the worktree's branch, `x`, and writes
the mode's defaults where the main checkout holds no config or you name a mode with
`--mode`. Commit the `.gitignore` change `init` makes there on the worktree's branch
before its first task (`git add .gitignore && git commit -m '…' -- .gitignore`), as
in any project: a loop's first step stops unless the root's tree is clean. A worktree
nobody initialized stays its main checkout's project, as before: a host started in it
serves the main checkout, and the roster's first line says so. Where the repository's git
directory is separate from its checkout (`git init --separate-git-dir`), git records no
path to the checkout, so name it: `cross-agent init --from <main checkout>`, or `--mode
<name>` for the defaults. `init` refuses a worktree with a detached HEAD, one on a
branch the mode's task pattern matches (`task/*`), and one on a branch outside the names
the root tools take: letters, digits, `.`, `_`, `/` and `-`.

A worktree project may not lie inside another work tree of its repository: one under
the main checkout, such as `my-project/branches/x`, is refused, as a task's worktree
under `.worktrees/` always was. A bare repository works too, with its worktrees beside
it — `repo.git` with `main/` and `x/` next to it — or in the umbrella layout, `U/.git` a
file reading `gitdir: ./.bare` with `U/main` and `U/x` its worktrees; there `init`
writes the mode's defaults, having no main checkout to copy. Put worktrees beside a bare
repository, never inside it: a root inside its own git directory is refused, because
every task is denied that whole directory.

Grok loads a project's plugin from the `.grok/config.toml` of the folder it runs in,
which git does not carry into a new worktree, so `init` copies the main checkout's file
there and ignores `.grok/` beside it, as it does beside an attach the worktree already
holds; trust the new folder in Grok, which cross-agent never does for you. A file that
binds a project with `--project` or `CROSS_AGENT_PROJECT` is not copied, since it would
serve the main project from the worktree: `init` prints the binding, and you set that
worktree's attach up by hand. A
Codex host names each worktree's project in `CROSS_AGENT_PROJECT`, as for any project,
and Codex may add a trust entry for each new directory to `~/.codex/config.toml` on its
own, which cross-agent cannot prevent.

While a project's loop runs, run git at its root by hand only through `cross-agent
git-root [--slug <slug>] -- <args…>`, which takes the loop's own locks and exits 0, 1
or 3 as `git` does, and git in a task's worktree only through `cross-agent git <slug>
-- <args…>`. No `checkout`, `branch -f` or `reset` at that root: a plain git command
takes no lock, and one landing between the merge's check of the root's branch and the
merge itself would put the merge on another branch.

The projects of one repository take turns at a lock in its git directory for every git
write, and a project waits for it at least sixty seconds, whatever its own
`limits.lockWaitSeconds`; where your hooks run longer than that, raise
`limits.lockWaitSeconds`. A hook that hangs holds the lock until it is killed, and a
call stuck behind it cannot be cancelled from inside. Recover by hand:

1. Find the hung git by its command line, with `ps -eo pid,ppid,args`: it carries
   `--work-tree=<the task's worktree>` for a `git_mutate` step, the `git <slug>` verb's
   included, and `--work-tree=<the project root>` for a `git_root` step, the `git-root`
   verb's included: a `merge`'s hooks run at the root, and a `worktree add`'s
   post-checkout hook in the new worktree, each under that git.
2. End that process tree, the hook's children included, and check that it has exited.
3. Run `cross-agent tasks --reconcile`, then `cross-agent journal <slug>`, which says
   whether the step landed.

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
because its sandbox denies the network. All of it is built: the server
resolves the row by ancestry on every request and offers exactly that row;
`delegate` refuses a role its caller's lineage already holds in the same
workspace, a duplicate of a delegation still running or finished within the
window, and a resume that would change the task, and it hands every child its
depth and lineage; and each engine's adapter puts the deny list and the
exclusion flag its engine takes onto every spawn line it builds. A specialist
that defeats its own CLI's permission rules is outside the guarantee.

## License

Apache-2.0.
