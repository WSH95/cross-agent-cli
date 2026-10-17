# OpenClaw MCP setup

Use on the local Linux host where the OpenClaw gateway runs, with Node 24+, Git, util-linux
`flock`, and the engines the team binds installed. An OpenClaw host runs `solo` and
`dev-team-engine`: the launcher stops on any other mode before it starts anything.

Resolve `<skill-dir>` to the cross-agent skill's directory, the one holding this file's
`references/`, also when the setup skill sent you here, and resolve `<payload>` with
`realpath "<skill-dir>/../.."`, `<skill-dir>` written out whole with a leading `~` as `$HOME`,
since a `~` inside the quotes does not expand; `<payload>` is the absolute path it prints: the
plugin's own copy, holding `src/server.ts`, `bin/` and `skills/`. OpenClaw links an installed plugin's skills into its `plugin-skills/` directory,
so the path it shows you for this skill is a link, and `<skill-dir>/../..` read as text names
the wrong directory; `realpath` follows the link. For the plugin installed from the
marketplace, as the install guide says, `<payload>` is `$HOME/.openclaw/extensions/cross-agent`;
for a development build listed in `skills.load.extraDirs`, it is that build's directory. Where
the user's OpenClaw runs under a named profile, every `openclaw` command below carries
`--profile <name>`, and the plugin's directory is `$HOME/.openclaw-<name>/extensions/cross-agent`;
otherwise none does.

## What it registers

One `mcp.servers.cross-agent` entry, complete in itself: the plugin declares a server of the
same name, which starts in the plugin's own directory, where there is no project, and OpenClaw
replaces that server with the entry rather than merging the two, so the entry carries every key
the server needs. Its
`cwd` is the project: OpenClaw starts two copies of the server for a session, its own and
the one its Codex runtime gives the model, and both start there, so the server serves the
project at that directory as it would under any other host. A Git repository with no
`.cross-agent/config.json` runs `solo` on defaults; a team needs the setup skill beside this
one (`<skill-dir>/../setup/SKILL.md`), which proposes it and writes the config once the user
confirms. The entry takes one project per entry: changing the project changes the entry.

## Writing it

Every command in this section and the two below runs only on the user's own explicit answer
to its question, in this conversation. If `CROSS_AGENT_TASK`, `CROSS_AGENT_DEPTH` or
`CROSS_AGENT_LINEAGE` is set in your environment, stop: this session belongs to a task, and
host configuration is the operator's. First print the config file's path with `openclaw
config file`, and copy that file beside itself as `<path>.cross-agent-backup` so it is
backed up before anything changes. Then, with `<project root>` the absolute root of the
user's repository:

```
openclaw mcp add cross-agent --command node --arg "<payload>/src/server.ts" --cwd "<project root>" --timeout 3600 --connect-timeout 30 --approval approve
```

`--timeout 3600` gives each tool call an hour, as the Codex plugin's own mount does, so a
`wait` of 600 seconds returns whole; without it the runtime's own default applies, which no
run has measured at 600 seconds. `--approval approve` lets the model call the tools without
asking at each call. `mcp add` starts the server once from your shell to
check it before it saves the entry; a refusal names why, and saves nothing. An entry already
named `cross-agent` is refused: show it with `openclaw mcp show cross-agent` and change it
as below.

To serve another project, show the entry, then write it back whole with the new `cwd`:

```
openclaw mcp show cross-agent
openclaw mcp set cross-agent '<the entry as shown, with "cwd" the new project root>'
```

## After a write

The running gateway applies the change at once, without a restart. A chat whose session
already started the server keeps the copy it started, in the old project, so the change
reaches the next new session: ask the user to start one (`/new` in the chat) and check
there. `openclaw mcp reload` disposes of the runtimes of the `openclaw` command you ran it
in, not the gateway's, so it is not that step.

The check, in the new session: call `describe_mode` with `view: "summary"`, verify that
`projectRoot` is the project root the entry names, and call `list_roles`. Both must answer
without error and without a `warning`. Without changing anything, `openclaw mcp show
cross-agent` shows the entry, `openclaw mcp probe cross-agent` starts the server once and
counts its tools, and `openclaw skills info cross-agent` shows where the skill is read from.
Only `describe_mode` in a session proves the live connection and the project.

## Removing it

For an explicitly requested removal, after the backup above, and each step checked by what
`openclaw mcp show` and `openclaw skills list` answer afterwards:

- The server: `openclaw mcp unset cross-agent`. A running chat keeps the copy it started
  until its session ends.
- The plugin and its skills: `openclaw plugins uninstall cross-agent --force`, `--force` because
  your shell has no terminal for its confirmation prompt; the user's answer is the confirmation.
- For a development build instead: read the list with `openclaw config get
  skills.load.extraDirs --json` and write it back without this payload's `skills` directory,
  keeping every other entry, with `openclaw config set skills.load.extraDirs '<the remaining
  list>' --strict-json`. Removal edits `skills.load.extraDirs` and never deletes the payload
  directory, which another host's installation may share.

Keep unrelated servers and skill directories as they are. Do not invent a profile, a path,
or a project binding: ask the user for any you cannot read from the commands above.
