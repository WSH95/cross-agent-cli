# Open questions

Record questions that the repository does not answer instead of guessing.
Add the answer to the item when it is resolved.

- [x] Is the bwrap AppArmor profile from Claude Code's sandboxing docs
      installed on this machine? **Yes** (2026-09-18: the docs' profile is
      loaded and Ubuntu's stock `bwrap-userns-restrict` is disabled). Probe
      P2 for Claude ran at T13 and `atc-s96.17` is closed.
- [ ] Does a `--deny "mcp__cross-agent__*"` rule hide this server's tools from
      a Grok child, or is the depth guard the only protection there?
      (integration probe I1, T15) Partly answered at T13: a Grok specialist
      at the project root lists exactly the specialist row and Grok's own
      dispatcher refuses `delegate` because the tool is not listed; whether
      the `--deny` rule itself hides tools is still unprobed.
- [ ] Does Codex honour `tool_timeout_sec` from a plugin's `.mcp.json`, or
      only from `config.toml`? (T14)
- [ ] Under a Claude Code host, should Claude-engine specialists use the
      host's own Agent tool instead of a nested `claude -p`, to share the
      prompt cache? (after T13's end-to-end run)
- [ ] The authority walk stops at 8 hops. A Claude Code host started inside
      another Claude Code session puts the MCP server 9 hops from init, so it
      fails closed to the specialist row and offers no `delegate` (T13; an
      operator at a terminal is 7 hops, `setsid --fork` is 4). Raise the
      limit, or document `setsid` for nested hosts? Measure under VS Code and
      the desktop app first. (`atc-s96.53`)
- [ ] A Grok specialist inside a linked worktree reaches no MCP server at
      all, because Grok reads `./.grok/config.toml` per directory and a
      worktree is its own directory (T13, `grok mcp doctor` in the worktree).
      That is the safe direction; reaching one needs a user-scope `grok mcp
      add`, a change to your Grok configuration. Leave it, or mount it
      user-wide? (T15)
- [ ] When does the Codex pause (2026-09-18) lift? T14 (Codex packaging,
      E4, E5), every recorded Codex row of I1/I2 and the guarded Codex I2
      test (`CROSS_AGENT_REAL_CODEX=1`) wait on it; each has its command
      recorded in `docs/probes.md` and `VERIFY.md`.
