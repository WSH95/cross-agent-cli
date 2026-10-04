# One-time Codex MCP setup

Use on the local Linux host where Codex runs, with Node 24+, Git, util-linux `flock`,
and the Codex CLI installed. Desktop Codex uses the same local MCP configuration as
the CLI on that host. A cloud chat or a different host needs its own installation;
native macOS and Windows hosts cannot run cross-agent's Linux process guards.

Resolve `<skill-dir>` to the directory of the `SKILL.md` you are reading. Run from
the user's project, not the plugin's cache directory:

```
node "<skill-dir>/scripts/codex-setup.mjs" install
```

The user's request to set up or repair this connection authorizes this step. No
MCP tool is needed. The helper uses Codex's installed-plugin inventory and native
config API; it does not start an engine or a model turn. It writes only the
`mcp_servers.cross-agent` entry in the current `CODEX_HOME/config.toml` (default
`~/.codex`), an owned launcher and state in `CODEX_HOME/cross-agent/`, and an OS lock
file. It keeps the task markers and default timeouts (30-second startup, 3600-second
calls), preserves tool restrictions when repairing its connection, and refuses custom registrations or
conflicting config layers. It stores neither a project path nor an MCP working
directory. The configured connection intentionally shadows the plugin's bundled
mount; leave the marketplace plugin enabled so its skill and updates remain available.

After a successful install, restart Codex's MCP servers using the host's restart
control, or open a new session. If no restart control is available to you, report
this remaining step; do not claim the current chat has tools yet. Then call
`describe_mode`, verify `projectRoot` against the user's project, and call `list_roles`.
A Git repository without a config runs `solo` on defaults. For a team, run the
bundled CLI `"<skill-dir>/../../bin/cross-agent" init --mode dev-team` (or
`dev-team-engine`) in the project, then reconnect because the mode selects tools at
server startup. Do not initialize `solo` merely to make Codex attach.

For diagnosis, without changing setup:

```
node "<skill-dir>/scripts/codex-setup.mjs" check
```

Report its reason if it fails. `check` validates configuration and the selected
installed server; only `describe_mode` proves the live connection and project.
An installed update takes effect on the next MCP connection. Refreshing the
marketplace catalog alone does not install an update. The launcher follows Codex's
installed version, even after the previous cached copy disappears, and refuses a
disabled or removed plugin. It never picks the newest-looking cache directory.

For an explicitly requested removal, before uninstalling the plugin:

```
node "<skill-dir>/scripts/codex-setup.mjs" remove
```

This removes the owned connection (including its per-server policy) and launcher, and
keeps unrelated configuration and the marketplace installation. Reconnect afterwards.
If the user already uninstalled the plugin, `codex mcp remove cross-agent` removes
the leftover registration; the inert `CODEX_HOME/cross-agent/` files can then be
removed after inspecting their ownership. Never remove a replacement custom server.

If Codex is outside `PATH`, pass `--codex <absolute-executable>`. If multiple copies
of cross-agent are installed, use `codex plugin list --json` to identify them and
ask which marketplace installation to select, then pass `--plugin <plugin-id>`.
Do not invent a marketplace name, cache path, version, or project binding. A config
version conflict means another process edited it: rerun `check`, inspect the current
entry, then retry the authorized setup. Keep any custom registration for the user
to resolve; do not bypass the helper by rewriting their TOML.
