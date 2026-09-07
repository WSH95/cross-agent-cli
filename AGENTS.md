# agent-team-cli

`dev-team`: a standalone multi-engine dev team (planner, plan reviewer,
implementer, code reviewer) packaged as one MCP server plus one skill for
Claude Code, Codex, and Grok. The design in `docs/design.md` is
authoritative; `docs/probes.md` records what each engine CLI was observed
to do.

## Project facts

- Default branch: `main`.
- Test command: `npm test`.
- Setup command (run once in each new worktree): none. There are no
  dependencies; Node 24 runs the TypeScript sources directly.
- Merge policy: auto.

## Layout

- `src/server.ts`: the stdio JSON-RPC (MCP) server and its tool registry.
- `src/config.ts`: `.dev-team/config.json` loading and validation.
- `src/ledger.ts`, `src/runner.ts`, `src/locks.ts`, `src/guard.ts`,
  `src/gitmutate.ts`, `src/cli.ts`: one file per concern, as in the design.
- `src/engines/`: one adapter per engine CLI (`claude`, `codex`, `grok`) on
  the interface in `types.ts`.
- `tests/<concern>.test.ts`: `node:test` with `node:assert/strict`;
  `tests/fixtures/fake-engine.mjs` stands in for a CLI.
- `tools/probe.mjs`: a standalone harness for observing a real engine CLI.
  Not product code.
- `skills/dev-team/SKILL.md`, `roles/*.md`: the lead loop and the role
  prompts (design sections 7 and 8).
- `docs/design.md`, `docs/probes.md`.

## Conventions

- TypeScript with erasable syntax only (no enums, namespaces, parameter
  properties, or decorators), so Node runs it without a build step. Import
  paths carry the `.ts` extension. No dependencies: Node built-ins only.
- Test first. Every behaviour change starts with a failing test in
  `tests/`; the test names the behaviour. Test-only hooks never go into
  `src/`; tests inject through public options (for example a tool list or
  an engine binary path).
- The loop-guard scope (design section 5) and the deny list and exclusion
  flags (design section 3) are hard requirements: a change to spawn
  arguments keeps them and updates the builder tests.
- Specialists never write git metadata (design section 4). Code that runs
  git in a worktree goes through `git_mutate`.
- Every sentence in prompts, briefs, and docs serves a purpose. No
  artificial length caps.

## Commands

- Test: `npm test`
- Run the server: `node src/server.ts` (stdio; JSON-RPC lines in, lines out)
- Probe an engine: `node tools/probe.mjs --engine claude --cwd <dir> --sandbox read-only --prompt "…"`
