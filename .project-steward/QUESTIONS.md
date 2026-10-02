# Open questions

Record questions that the repository does not answer instead of guessing.
Add the answer to the item when it is resolved.

- [x] Is the bwrap AppArmor profile from Claude Code's sandboxing docs
      installed on this machine? **Yes** (2026-09-18: the docs' profile is
      loaded and Ubuntu's stock `bwrap-userns-restrict` is disabled). Probe
      P2 for Claude ran at T13 and `atc-s96.17` is closed.
- [x] Does a deny rule on this server's tools — asked as the `--deny
      "mcp__cross-agent__*"` flag, probed at T15 as `[permission] deny =
      ["MCPTool(cross-agent__*)"]` in the project's `.grok/config.toml`, the flag
      not run — hide them from a Grok child, or is the depth guard the only
      protection there?
      (integration probe I1, T15) Partly answered at T13: a Grok specialist
      at the project root lists exactly the specialist row and Grok's own
      dispatcher refuses `delegate` because the tool is not listed; whether
      a deny rule itself hides tools was left to T15. **It gates
      them, it does not hide them** (T15, a driver run): with
      `MCPTool(cross-agent__*)` denied in the project's `.grok/config.toml`, a
      Grok child under `bypassPermissions` still lists the five and has every
      call refused at Grok's permission layer before the server sees it
      (`docs/probes.md#grokDenyMcp`); the specialist row by ancestry stays the
      guard.
- [x] Does Codex honour `tool_timeout_sec` from a plugin's `.mcp.json`, or
      only from `config.toml`? (T14) **Answered at T14**: Codex's plugin form is
      `.codex-plugin/plugin.json`, not an `.mcp.json`, and its
      `tool_timeout_sec: 3600` was honoured: a 600-second `wait` through the
      plugin returned at 600.004 s, and a copy declaring 60 cut the same call at
      60 s (`docs/probes.md#codexHostTimeout`; `VERIFY.md` T14, "Probes", B3).
- [x] Under a Claude Code host, should Claude-engine specialists use the
      host's own Agent tool instead of a nested `claude -p`, to share the
      prompt cache? (after T13's end-to-end run) **Out of scope** (the plan the
      user approved, 2026-09-30): a specialist is a headless CLI process the
      server spawns under its own sandbox, found by the ledger and the environ
      scan and bound by the deny list; a host's own subagent tool would run a
      specialist outside all three, and the design's loop guard and "Not built"
      list are written for processes the server spawns.
- [x] The authority walk stops at 8 hops. A Claude Code host started inside
      another Claude Code session puts the MCP server 9 hops from init, so it
      fails closed to the specialist row and offers no `delegate` (T13; an
      operator at a terminal is 7 hops, `setsid --fork` is 4). Raise the
      limit, or document `setsid` for nested hosts? Measure under VS Code and
      the desktop app first. (`atc-s96.53`) **Raise it to 32** (user,
      2026-09-30): the walk still stops at the first engine record or
      `CROSS_AGENT_*` marker, so only the too-deep refusal moves; T14 and T15
      record the hop counts under the Codex and Grok hosts.
- [x] A Grok specialist inside a linked worktree reaches no MCP server at
      all, because Grok reads `./.grok/config.toml` per directory and a
      worktree is its own directory (T13, `grok mcp doctor` in the worktree).
      That is the safe direction; while git ignores `.grok/` (design section
      9), reaching one needs a user-scope `grok mcp add`, a change to your
      Grok configuration. Leave it, or mount it
      user-wide? (T15) **Leave it** (user, 2026-09-30): no user-scope mount;
      T15 records the behaviour. Recorded at T15 (`docs/probes.md#grokWorktreeMount`):
      under the shipped plugin attach too, a Grok specialist in a linked
      worktree mounts no server of ours.
