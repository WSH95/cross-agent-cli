---
updated_at: 2026-10-04T11:56:18Z
updated_by: codex
session_status: active
branch: main
---
# Handoff

## Now

`atc-s96.111` is publishing the completed Codex setup change. The user explicitly
authorized pushing source `main` and updating the existing, still-open agent-plugins
PR #16 directly. The version is bumped to 0.1.1 in the package and both manifests;
33 packaging, dist, publisher and native Codex checks pass with no skips. The target
branch is `publish/cross-agent-0.1.0`; keep its history and leave the PR open. The
generated payload and PR description will refer to the frozen release commit.

## Completed implementation

`atc-s96.73` is complete and closed, with local integration under the repository's
automatic commit and merge policies.
The existing skill offers install/check/remove, and a stable launcher follows the
enabled installed marketplace version while inheriting each chat's project. No real
user Codex config changed. The 66 focused checks and native Codex 0.160.0 probe pass;
the latter covers solo, team, uninitialized and initialized worktree chats. Independent
review found no actionable findings, including the three skill-routing scenarios.
Final `npm test`: 1047 tests, 1045 pass, 0 fail, 2 guarded skips. One earlier full run
hit an existing reconciliation deadline; the unchanged server file passed 46/46 in
isolation and the unchanged full-suite rerun passed. Citations: 1643, no misses or
drift. Nothing was pushed or published; installed users need a later release.

## Previous release context

**Release 0.1.0 is published (`atc-s96.109`, closed 2026-10-04).** The project is public at
https://github.com/WSH95/cross-agent-cli under the MIT license, `main` at the release commit
`f996a46` and the closing records after it. The plugin's payloads are in
https://github.com/WSH95/agent-plugins/pull/16, open and mergeable, **not merged**: the
marketplace install (`cross-agent@agent-plugins`) works once the user merges it. The
release brought:
- `bin/cross-agent`, the CLI's launcher on Claude Code's Bash tool PATH, denied to
  specialists;
- `tools/build-dist.mjs`, the payloads from a commit, and `tools/publish_agent_artifact_pr.py`
  with `agent-artifacts.json`;
- a 150-line README, with the reference material in `docs/install.md` and
  `docs/operator-guide.md`;
- the release review's fixes. Decision 0016 and `VERIFY.md` ("atc-s96.109") have the record.

The follow-ups `.106` (`c492021`), `.108` (`5b0e529`), and `.107` are complete.
This checkpoint records `.107`'s cleanup-compatible runner probes. The final
suite passed 1021 tests with 0 failures and 1 guarded skip; the host cleanup audit
was empty. No next implementation task is selected, and nothing was pushed.

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
- **Codex:** install through the marketplace, then ask the existing cross-agent skill
  for one-time MCP setup. Reconnect and verify `describe_mode.projectRoot`. The legacy
  bundled mount still requires `CROSS_AGENT_PROJECT`; `docs/install.md` covers both.
- **Grok:** the project's own `.grok/config.toml`, with `[plugins] paths` naming this repository, `enabled = ["cross-agent"]` and `[mcp] max_output_bytes = 100000`, in a trusted folder.

## In flight

- `atc-s96.111`: commit/push 0.1.1, build and validate payloads, update PR #16, verify
  remote heads, and record completion. Its temporary target checkout is
  `/tmp/cross-agent-release-0.1.1-KbXLn0/agent-plugins`.
- No implementation remains in flight for `atc-s96.73`. The local commit includes the
  launcher skill/reference/helpers, bundled-mount diagnostic, installation/design/probe
  docs, setup/native/packaging/skill tests, and Project Steward records.
- The main checkout's `.beads/interactions.jsonl` is unrelated mutable history and stays
  uncommitted. Test-generated runner fixtures cleaned up before staging.

The requested prerequisite commits are complete: `.106` is `c492021`, and `.108`
is `5b0e529`. Both commits were reviewed for task separation; neither includes
the unfinished runner fix. Plain Beads output, native-hook JSON and the saved
PRIME override match. Local commits after validation are authorized; pushes and
remote sync still need approval. Resume memories with `bd prime --export --memories-only`.

`atc-s96.107` is complete and closed. It uses command-mode ssh-agent, a stdin-controlled command with a
60-second lifetime, an actual SIGKILL preflight, and awaited identity-checked
retirement. Harness cleanup continues after signal errors and removes fixtures
before reporting accumulated failures. Seven regressions went red to green; the
complete runner file then passed 83 tests. An independent review found one
Important missing-identity cleanup case. A real-agent regression reproduced it;
recovery by the unique socket argv fixed it. The final focused run passes all 12
cases with no skips. Final `npm test` in the direct desktop context passed 1021
of 1022 tests, with 0 failures and the guarded real Codex I2 skipped. The host
audit found no live probes, runner-marked processes, or generated fixtures.
No production code or host security policy changed. Evidence is in
`/tmp/cross-agent-atc107-4i7vMg/`. This checkpoint includes the runner change and
verification records. Only the expected Beads interaction log remains unstaged.

`atc-s96.106` is closed and committed on `main` as `c492021`. Before committing,
all 66 focused worktree/project tests passed again, and the citation checker
reported 1636 citations, no misses or drift. The six-file commit includes its
Project Steward records and excludes `.107` and `.108` changes.
The user approved skipping only readable, empty ancestor `.git` directories.
Nonempty entries, files and symlinks retain Git verification; unreadable entries
refuse, and the ancestor walk still detects registered task worktrees.

Validation on 2026-10-03: eight new regression cases went from failing to passing;
the focused worktree and project-discovery files pass; the full suite has 1014
tests, 1013 pass, 0 fail, 1 skipped (the guarded real Codex I2); 1636 citations,
no misses; one independent read-only review found no findings. The shared
`/tmp/.git` remained present and empty.

The passing `npm test` ran unchanged through a temporary user service. This app's
sandbox loses asynchronous Node child stdout/stderr, and its direct outside-sandbox
context cannot signal AppArmor-confined `ping` probes. That earlier full run had
four runner cleanup failures, tracked as `atc-s96.107`. All four probes were
terminated; ten generated fixture files left by failed or interrupted runs were
archived out of `tests/fixtures`. No generated runner fixture remains there.
Evidence and original-file review snapshots are in
`/tmp/cross-agent-atc106-review-ZRRfyD/`; the passing log is
`full-suite-user-service.log`. That earlier validation session did not commit;
the separate prerequisite commits above are now complete.

`atc-s96.104` is merged and closed.

**`atc-s96.104` merged on 2026-10-03** (`7de15c0`, 15 commits; Decision 0014). The built-in team modes now run the plan iteration and the review and fix rounds as short procedures, with N code reviewers and a `resolver` role. This was the user's request, with the user's decisions D1–D4.

What it does:
- **Code reviewer seats:** `roles.code-reviewer` may be a list of bindings, one seat each. Seats are a mode fact (`"seats": "many"`); `delegate` takes `seat`, and listings write `code-reviewer#2`. `init` binds three read-only seats and the resolver.
- **Two settings,** both read through `describe_mode`: `limits.planReviewRounds` (default 3) and `review.afterResolver` (`ask` by default, or `lead-decides` or `always-ask`).
- **The loop text:** short, with a "stop and ask the user" fallback and the user's convergence rules (scope; carried, introduced or newly noticed; a diagnosis with four options at a limit; proportion).
- **Guard 1:** `git_root merge` acts on one resolved head and needs a `tested` step for it. The step comes from a suite run in a detached checkout under `.cross-agent/gate/`.
- **Guard 2:** under a mode with a gating role, the merge also needs every seat's clean review of that head, read by the server from the result files, or a waiver (`waive_review`, `cross-agent waive`).
- **The limit:** deliberate self-subversion by a lead is outside the guarantee (`atc-s96.105`).

How it was checked:
- **Planning:** six reviews of a large plan did not converge. The user reset it to a smaller plan, then chose to simplify at the plateau.
- **Review:** two rounds. Round 1 found 3 Critical (all in the setup marker), 1 Important and 3 Minor. Round 2 found nothing Critical or Important, and a wrap-up fixed its two Minor findings. No escalation was needed.
- **The suite:** `npm test` at the root ran 1006 tests: 1005 pass, 1 skipped. Citations: 1608, then 1631 with E11's record.
- **E11:** three seats on three engines (claude, codex, grok) reviewed `f9eaf26` in parallel. The verifier gave 8 pass, and the merge passed both guards with no waiver (`docs/probes.md#e11Seats`, `VERIFY.md`). The run cost $1.555.
- **`AGENTS.md`:** updated with the user's approval (`c05671e`).

The task worktree is removed, and its ignored files are archived in `~/.cache/agent-team/probe-logs/t15-worktree-state/`.

**The stray empty `/tmp/.git`** is left by Codex's Linux sandbox, along with
`/tmp/.agents`, `/tmp/.codex` and `/tmp/.aws`. With the verified `atc-s96.106`
working-tree fix, readable empty ancestor `.git` directories are skipped; leave
this shared directory in place. Nonempty or unreadable metadata still refuses.

**`atc-s96.103` is done (2026-10-03).** The repository is now `~/Documents/cross-agent-cli`, renamed from `~/Documents/agent-team-cli`.
- **What changed:** its live names (the Codex marketplace and install id `cross-agent@cross-agent-cli`, both manifests' `author`, the README, the design, `AGENTS.md`, the steward project name) were merged at `1a17004` and `6c3e5c3`.
- **What kept the old path:** records of past runs keep the paths they ran at, with one note each in `docs/probes.md` and `VERIFY.md`.
- **The move:** the controller moved the directory. `core.hooksPath` is now the relative `.beads/hooks`, and the e2e sample's Grok attach was repointed.
- **The smoke test:** it passed, with the plugin loaded from the new path, its server connected, and the operator row's fourteen tools.

Decision 0013 records all of it.

**Left to the user:**
- trust the new folder when Claude Code first starts there;
- in the Codex desktop app, add the folder at the new path, and remove the stale `agent-team-cli` and `cross-agent-m3` projects;
- reopen VS Code at the new path.

Codex writes its own trust entry for the new path. Stale entries that name the old path (`~/.claude.json`'s project key, `~/.codex/config.toml`'s trust entry, and the dormant OpenMausBot data under `~/.cache/agent-team/`) are harmless.

**`atc-s96.97` merged on 2026-10-03** (`fb0d050`; the feature's 45 commits end at `1c75090`).
A linked worktree, or a bare repository's worktree, becomes a cross-agent project of its own when
`cross-agent init` is run in it, so several branches of one repository can each run their own
loop at once (README, "Several branches at once").

What it does:
- `init` copies the main checkout's config, or `--from <dir>`'s, onto the worktree's own branch,
  and copies the Grok attach;
- the repository is located from outside the candidate, so a task worktree is never a project root;
- writes at a root that is not the main checkout need the opt-in;
- `<commonDir>/cross-agent.lock` serializes the projects' git;
- protected paths are set per root kind;
- closed journals are terminal, and `branch -d` holds a branch to its recorded tip;
- a new `cross-agent git-root` verb;
- `describe_mode` carries `projectRoot`;
- verifier rows 1 and 2 are scoped to the project.

How it was checked:
- **Review:** three review rounds and a wrap-up, with no escalation.
- **E10:** the sample's main checkout and a `feature/dotted` worktree each ran one
  `dev-team-engine` task at the same time, every engine `claude-sonnet-5`. Both verdicts read
  8 pass, and the containment probe was refused by the sandbox (`docs/probes.md#worktreeProjects`,
  `VERIFY.md` "T13").
- **The suite:** `npm test` at the root ran 933 tests: 932 pass, 1 skipped.
- **Citations:** 1458, none by line.

The task worktree is removed, and its ignored files are archived in
`~/.cache/agent-team/probe-logs/t13-worktree-state/`.

## Next steps

1. Finish the authorized publication in `atc-s96.111`: source main and the existing
   PR branch only; no force-push or PR merge. No Dolt remote sync is authorized.
2. For an isolated native regression check, run
   `CODEX_SETUP_PROBE=/absolute/path/to/codex node --test tests/codex-native.test.ts`.
   It creates its own temporary Codex home and makes no model turn. `VERIFY.md` records
   the suite, focused checks, review and initial timeout.

Previous release and backlog pointers:

1. **The user:** review and merge https://github.com/WSH95/agent-plugins/pull/16. After the
   merge, `/plugin marketplace update agent-plugins` (or a fresh `marketplace add`) offers
   `cross-agent@agent-plugins`.
2. `atc-s96.110` (P3): settle how a Claude Code install of cross-agent reaches Grok
   sessions, and whether a marketplace install can stay per project. This needs a
   signed-in isolated Grok home, since a fresh signed-out one keeps path plugins off.
3. Later releases follow the README's "Development": bump the version in all three files,
   commit, push `main`, then run the publisher.
1. Run `bd ready` before choosing the next task. `.106`, `.108`, and `.107` are
   closed; no push or remote sync is authorized.
2. **The team-mode follow-ups:**
   - `.105` (P4): deliberate self-subversion of the merge guards;
   - optional, the user's call: trim the loops' text, which grew with `atc-s96.104` (`modes/dev-team/SKILL.md` 13,065 → 20,684 bytes).
3. **The deferred beads** (`bd ready`; each carries its class and reason from Decision 0011):
   - P3: `.60`, `.76`, `.92` (Grok specialists' extra tools), `.95` (a lead's report names bindings it never read);
   - P4: the rest, `.96` included (team and workflow configuration import and export, in this project's own format);
   - the backlog, `.25`, `.26` and `.28`, and `prune`, `.48`.
4. **The worktree-project follow-ups:**
   - `.98`: cancelling a running git child;
   - `.99`: worktree projects inside the main checkout;
   - `.100`: writes at a separated main or a submodule;
   - `.101`: widen `nameFault`;
   - `.102`: `describe_mode` warns when the server's own working directory lies in another initialized project.

## Blockers

None. The `AGENTS.md` diff for `atc-s96.104` was approved and applied on 2026-10-03 (`c05671e`, Decision 0014).

## Key files

- `docs/design.md`: the authority — "The lead model", sections 1 to 10, the work plan with what landed per row, and Verification.
- `docs/probes.md`: every probe and end-to-end run with its transcripts. It covers P1–P10, I1, I2 and E1–E11; T12's fix rounds are `#t12Fix1`, `#t12Fix2` and `#t12Fix3`, E10 is `#worktreeProjects` and E11 is `#e11Seats`.
- `src/`:
  - the top level: `server.ts`, `authority.ts`, `project.ts`, `delegate.ts`, `tasks.ts`, `wait.ts`, `mailbox.ts`, `modes.ts`, `cli.ts`, `gitroot.ts`, `runcommand.ts`, `config.ts`, `ledger.ts`, `locks.ts`, `process.ts`, `reconcile.ts`, `worktree.ts`, `reservation.ts`, `gitmutate.ts`, `journal.ts`, `review.ts`, `runner.ts`, `guard.ts`;
  - `engines/`: `types.ts`, `spawn.ts`, `registry.ts`, `binaries.ts`, `text.ts`, `claude.ts`, `codex.ts`, `grok.ts`;
  - `tests/` mirrors it, with `tests/fixtures/fake-engine.mjs` and `tests/helpers/`.
- The skill, the modes and the packaging:
  - `skills/cross-agent/SKILL.md`, the launcher;
  - `skills/cross-agent/references/codex-setup.md` and `scripts/codex-{setup,config,serve}.mjs`,
    one-time native Codex configuration and installed-version resolution;
  - `modes/{dev-team,dev-team-engine,solo}/`;
  - `.claude-plugin/plugin.json`, with inline `mcpServers`;
  - `.codex-plugin/` with `.agents/plugins/marketplace.json`, and `assets/codex/mcp_servers.toml`, the configured-server fallback.
- `tools/`:
  - `probe.mjs`: engine probes; `--track` spawns the real runner;
  - `e2e-verify.mjs`: the eight end-to-end checks, which fail closed;
  - `check-citations.mjs`;
  - `from-openmaus.mjs`: a one-off, kept as history.
- The records:
  - `VERIFY.md`: counts and runs per merge, ending with "T13" and `atc-s96.104`;
  - `.project-steward/DECISIONS.md`: 0010, the rulings of M1–M3; 0011, the go or no-go with its conditions, limitations and deferred beads; 0012–0014, the worktree projects, the rename and the team modes;
  - the plan, `~/.claude/plans/the-development-of-this-calm-planet.md`.
- The close's raw evidence: `~/.cache/agent-team/probe-logs/close-2026-10-02/` (`fix1/`, `fix2/`, `wrapup/`, `e9/`, `worktree-state/`).
- The sample, `~/.cache/agent-team/cross-agent-e2e/slugkit`: `main` at `f9eaf26` (E11's `slug_final_letters`), 116 tests, in `dev-team-engine` with E11's config kept (three code reviewer seats on claude, codex and grok, and the resolver), and `feature/dotted` kept at `0ed8097`. Its `.grok/config.toml` names this checkout.

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

- **Push only with explicit approval.** The user authorized this 0.1.1 source push
  and update to PR #16; future pushes still need approval. Checkpoints use Conventional Commits.
- **`AGENTS.md` and `CLAUDE.md` are user-owned.** They change only by hunks the user approved after seeing the diff.
- **Start end-to-end host sessions with `setsid --fork`**, from the target directory, with the session's markers scrubbed.
  - A server's permission row is decided by `CROSS_AGENT_*` markers and ledger identities in its process ancestry, not by a `claude` process name.
  - A server started inside a plain Claude Code session serves the operator row (`docs/probes.md#walk32`).
  - One under a task's process tree does not, and `setsid --fork` keeps a host out of any such tree.
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
