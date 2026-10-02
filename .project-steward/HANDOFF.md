---
updated_at: 2026-10-02T12:25:32Z
updated_by: claude
session_status: closed
branch: main
---
# Handoff

## Now

The plan is closed. `main` (`128df05` and the wrap commit above it) holds every milestone, M0 to M4.

**What it built.** `cross-agent` runs headless `claude`, `codex` and `grok` processes as a team: one MCP server and a launcher skill, attached to a Claude Code, Codex or Grok host. Each team is a mode kept as data:
- `dev-team`: the planner, the plan reviewer, the implementer and the code reviewer, each task in its own git worktree;
- `dev-team-engine`: the same team, with its loop in a Claude or Codex lead the server spawns;
- `solo`.

Its guarantees:
- **The permission matrix.** Rows are resolved from process ancestry and task markers, so no specialist delegates.
- **The deny list.** Each adapter's exclusion flags keep specialists from launching an engine.
- **The sandboxes.** Each role writes only its own workspace. Claude roles run `dontAsk` with a tool allowlist and workspace-only edit rules.
- **Git ownership.** Specialists never write git metadata: `git_mutate` and `git_root` own git, and both refuse host configuration and the project's own state.
- **The audit.** A fail-closed verifier judges every end-to-end run by eight conditions.

**Counts at the close.**
- `npm test` at the root: 813 tests, 812 pass, 0 fail, 1 skipped (the guarded Codex I2 test).
- Citation checker: 1306 citations, none by line, 0 misses.

**The final review.** Three independent reviews in four rounds, from `4bcc986`, with two fix rounds, one escalation pass and a controller-verified wrap-up. Every finding was fixed, accepted as a limitation by the user's word, or ruled with its evidence (`VERIFY.md` "T12" and "Close of the plan").

**Decision 0011** (`.project-steward/DECISIONS.md`) records the eleven end-to-end runs, E1 to E9 with E2b and E2c. Each ended clean: six read eight `pass`, and five carry a `?` that a person read.

It was written as a go or no-go on the plugin as the devpack's second binding. On 2026-10-02 the user withdrew that binding: cross-agent follows its own development path, untied to the OpenMausBot devpack, and any team or workflow configuration import and export is built here (`atc-s96.96`).

What stands is the project's own record. The operator conditions a release names:
- (a) a Codex host exports `CROSS_AGENT_PROJECT`;
- (b) a Grok host trusts the folder and keeps `[plugins]` and the result cap in an ignored `.grok/config.toml`;
- (c) `/run/podman` is at 0711 where Grok runs read-only on a rootful-podman machine;
- (d) `bwrap`, `socat` and the AppArmor profile are in place where Claude runs on Linux.

**Attaching each host:**
- **Claude Code:** `claude --plugin-dir <this repository>`.
- **Codex:** an exported `HEAD` added as a local marketplace (`codex plugin marketplace add`, `codex plugin add cross-agent@agent-team-cli`), then started as `CROSS_AGENT_PROJECT="$PWD" codex`.
- **Grok:** the project's own `.grok/config.toml`, with `[plugins] paths` naming this repository, `enabled = ["cross-agent"]` and `[mcp] max_output_bytes = 100000`, in a trusted folder.

## In flight

Nothing. The task worktree and its branch are removed. Their ignored state is archived and verified under `~/.cache/agent-team/probe-logs/close-2026-10-02/worktree-state/`.

## Next steps

1. **The deferred beads** (`bd ready`; each carries its class and reason from Decision 0011):
   - P3: `.60`, `.76`, `.92` (Grok specialists' extra tools), `.95` (a lead's report names bindings it never read);
   - P4: the rest, `.96` included (team and workflow configuration import and export, in this project's own format);
   - the backlog, `.25`, `.26` and `.28`, and `prune`, `.48`.
2. **The Codex backups.** `~/.codex/config.toml` lost T14's tables only. The backup `~/.codex/config.toml.bak-t14-2026-10-01` and the copy `~/.codex/config.toml.pre-restore-2026-10-02` are kept for the user to delete when they choose.

## Blockers

None. The `AGENTS.md` diff was approved and applied on 2026-10-02.

## Key files

- `docs/design.md`: the authority — "The lead model", sections 1 to 10, the work plan with what landed per row, and Verification.
- `docs/probes.md`: every probe and end-to-end run with its transcripts. It covers P1–P10, I1, I2 and E1–E9; T12's fix rounds are `#t12Fix1`, `#t12Fix2` and `#t12Fix3`.
- `src/`:
  - the top level: `server.ts`, `authority.ts`, `project.ts`, `delegate.ts`, `tasks.ts`, `wait.ts`, `mailbox.ts`, `modes.ts`, `cli.ts`, `gitroot.ts`, `runcommand.ts`, `config.ts`, `ledger.ts`, `locks.ts`, `process.ts`, `reconcile.ts`, `worktree.ts`, `reservation.ts`, `gitmutate.ts`, `journal.ts`, `runner.ts`, `guard.ts`;
  - `engines/`: `types.ts`, `spawn.ts`, `registry.ts`, `binaries.ts`, `text.ts`, `claude.ts`, `codex.ts`, `grok.ts`;
  - `tests/` mirrors it, with `tests/fixtures/fake-engine.mjs` and `tests/helpers/`.
- The skill, the modes and the packaging:
  - `skills/cross-agent/SKILL.md`, the launcher;
  - `modes/{dev-team,dev-team-engine,solo}/`;
  - `.claude-plugin/plugin.json`, with inline `mcpServers`;
  - `.codex-plugin/` with `.agents/plugins/marketplace.json`, and `assets/codex/mcp_servers.toml`, the configured-server fallback.
- `tools/`:
  - `probe.mjs`: engine probes; `--track` spawns the real runner;
  - `e2e-verify.mjs`: the eight end-to-end checks, which fail closed;
  - `check-citations.mjs`;
  - `from-openmaus.mjs`: a one-off, kept as history.
- The records:
  - `VERIFY.md`: counts and runs per merge, ending with "T12" and "Close of the plan";
  - `.project-steward/DECISIONS.md`: 0010, the rulings of M1–M3, and 0011, the go or no-go with its conditions, limitations and deferred beads;
  - the plan, `~/.claude/plans/the-development-of-this-calm-planet.md`.
- The close's raw evidence: `~/.cache/agent-team/probe-logs/close-2026-10-02/` (`fix1/`, `fix2/`, `wrapup/`, `e9/`, `worktree-state/`).
- The sample, `~/.cache/agent-team/cross-agent-e2e/slugkit`: `main` at `5f391d4`, 109 tests, 51 records, in `dev-team-engine` as E7 and E9 left it. Its `.grok/config.toml` names this checkout.

## Tried and rejected

- An `O_EXCL` lock file with a TTL and a rename-based reclaim (Decision 0004).
- A per-process witness cache for engine liveness (replaced by the group scan).
- A lead token in the launch spec (readable by every sandbox; replaced by process ancestry).
- Grok as an engine-placed lead (P9: no per-run MCP isolation).
- A repository-root `.mcp.json` for the plugin. Claude Code reads it as this repository's own project-scoped config in every developer session, where `${CLAUDE_PLUGIN_ROOT}` is empty (T13). The plugin declares `mcpServers` inline instead.
- Attaching a 150 KB diff to a Grok brief before `atc-s96.55` (`E2BIG`).
- Relying on Claude's default sandbox for a read-only role. It writes to the cwd by default (T6-R1-20); the cwd is now in `denyWrite`.
- `bypassPermissions` for Claude roles behind a sandbox that binds only Bash. The Write tool wrote outside the workspace, and `EnterWorktree` made git metadata (T12, `docs/probes.md#t12Fix1`). Roles now run `dontAsk` with a tool allowlist.
- A spawn-time refusal of a project's `.claude/settings.json` allow rules. It was built, probed and withdrawn, because it would refuse legitimate projects. The residue is an accepted limitation (Decision 0011).
- Following host-configuration links to what they load. Three review rounds each found a new link shape, so a link at or under the four host paths is now refused by rule.

## Warnings

- **Never push.** Checkpoints commit on `main` as Conventional Commits.
- **`AGENTS.md` and `CLAUDE.md` are user-owned.** They change only by hunks the user approved after seeing the diff.
- **Start host sessions with `setsid --fork`.** Anything spawned from a Claude Code shell has a `claude` ancestor, so a cross-agent server started there resolves as a specialist. Start any host session for an end-to-end run with `setsid --fork` from the target directory, with the session's markers scrubbed.
- **Anchor `pgrep -f` and `pkill -f` patterns.** A pattern that matches your own shell's command line kills the shell. Anchor it, for example `'^node .*script\.mjs'`.
- **The citation checker's limits.** `npm test` runs it, and it proves that a cited line or symbol exists, not that it still says what the sentence claims.
  - Cite tests by `// @anchor`, passages by `<!-- @anchor -->` and code by `#symbol`.
  - Run `node tools/check-citations.mjs --since <task base>` after every task.
  - An anchor on the wrong test is invisible to both checks: read each sentence against the test title.
- **The suite is load-sensitive.** A timing assertion can fail under load; rerun the file in isolation first.
- **Keep projects out of `/tmp` and `$TMPDIR`.** The Codex and Grok sandboxes do not isolate them; the e2e sample lives under `~/.cache/agent-team/cross-agent-e2e/`.
- **Never run a bare `git stash`.** The stash is shared across worktrees.
- **Two dirty paths at the root are expected and never committed:** `.beads/interactions.jsonl` (bd's own log) and `.codex/agents/` (the Codex plugin's mirror of the implementer agent definition).
- **No engine at this repository's root,** except a read-only `consult`. The sample is the target for everything else.
- **`~/.codex/config.toml` changes under you.** The user's own Codex processes (the desktop app, a `codex` session) rewrite it; on 2026-10-02 they changed `model` once and `service_tier` three times. Compare a fresh copy and check its mtime before any edit.
