# dev-team

A standalone multi-engine dev team for coding agent CLIs. One MCP server
delegates planning, plan review, implementation, and code review to
`claude`, `codex`, or `grok` running headless on your own subscriptions,
each inside its own sandbox; one skill gives the host session (Claude
Code, Codex, or Grok) the lead's loop: plan, review, implement in a git
worktree, review, merge, clean up.

Status: scaffold. See `docs/design.md` for the design and the work plan,
`docs/probes.md` for what each engine CLI was observed to do.

## Run the tests

```
npm test
```

No dependencies; Node 24 or later runs the TypeScript sources directly.

## Loop guard, in one paragraph

No delegation loop can form through the `delegate` tool: a specialist runs
with a depth marker in its environment and the server refuses to offer
`delegate` at that depth; specialists are spawned so they cannot see this
server; and direct launches of `claude`, `codex`, `grok`, or this server
from a specialist are denied at each CLI's own permission layer. A
specialist that defeats its own CLI's permission rules is outside this
guarantee.

## License

Apache-2.0.
