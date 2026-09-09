# Open questions

Record questions that the repository does not answer instead of guessing.
Add the answer to the item when it is resolved.

- [ ] Is the bwrap AppArmor profile from Claude Code's sandboxing docs
      installed on this machine? Probe P2 for Claude (`atc-s96.17`) waits
      on it.
- [ ] Does a `--deny "mcp__cross-agent__*"` rule hide this server's tools from
      a Grok child, or is the depth guard the only protection there?
      (integration probe I1, T15)
- [ ] Does Codex honour `tool_timeout_sec` from a plugin's `.mcp.json`, or
      only from `config.toml`? (T14)
- [ ] Under a Claude Code host, should Claude-engine specialists use the
      host's own Agent tool instead of a nested `claude -p`, to share the
      prompt cache? (after T13's end-to-end run)
