---
updated_at: 2026-09-19T17:02:17Z
updated_by: claude
session_status: closed
branch: main
---
# Handoff

## Now

`main` at `e9cbac0` holds M1, M3's skills half and T13. T13 (Claude
Code packaging, probe P2 for Claude, the integration probes I1 and I2, the
end-to-end run E1; `atc-s96.13`, closed) merged on 2026-09-19 as a
fast-forward of `task/cross-agent-m3` (19 commits over `3023e30`: a
pre-review concerns round and six fix rounds, each judged by the Opus 5 task
reviewer, a Grok second review run through cross-agent itself, and the
controller's closure checks; the task reviewer approved on round 5 and the
Grok seat's last item closed in round 7). `npm test` at the root: 617 tests, 616 pass, 0 fail, 1
skipped (the guarded Codex I2 test). Citation checker: 823 citations, 0
misses; `node tools/check-citations.mjs --since 3023e30` and
`--since 39505aa`: 0 drifted, 0 not judged. `node tools/e2e-verify.mjs
--project ~/.cache/agent-team/cross-agent-e2e/slugkit`: 8 pass. `VERIFY.md`
has the T13 section; `DECISIONS.md` 0010 has every ruling with its cost.

What T13 established, in one paragraph: the plugin manifest declares the MCP
server inline (`.claude-plugin/plugin.json`; no root `.mcp.json`, which
would be this repository's own project config); a writable Claude
specialist in a linked worktree could write into `<root>/.git` and a
read-only one could write its cwd — both closed by `protectedPaths` in the
launch spec and `filesystem.denyWrite` in the Claude adapter, proven by
real probes (P2's three rows, I2's delegated row through the product
pipeline including `<root>/.git/hooks/pre-commit`); the Grok adapter routes
a large brief through `--prompt-file` (a 150 KB review brief had failed with
`E2BIG`); a call naming another engine drops the binding's model and effort;
`denyTargets` is rooted at this repository; E1 passed all eight conditions
on the Python slugkit sample with three failure injections; I1's Grok row
closed with the sample folder trusted in `~/.grok/trusted_folders.toml`;
every Codex row is recorded as not run with the command that runs it later
(the user paused Codex on 2026-09-18). Raw evidence:
`~/.cache/agent-team/probe-logs/t13-2026-09-19/`.

## In flight

Nothing is running. The branch `task/cross-agent-m3` and its worktree
`.worktrees/cross-agent-m3` stay in place for S11; the worktree holds a
git-ignored `.cross-agent/` (a `solo` config and the records of the
controller's review delegations) — the review harness, not the product.
Open beads worth knowing before S11: `atc-s96.56` (the verifier's residual
launcher cases — `echo claude` counts as a launch; `claude;true`,
`$(claude)` and a bare backticked `claude` are missed; so is `node
--experimental-strip-types src/cli.ts` — and two non-positional citation
bundles at `docs/design.md` ~1572 and ~3176; do it before E4–E7 rely on
the verifier), `atc-3ub` (two
unprobed facts: `--rules` beside `--prompt-file`; Codex `workspace-write`
and `~/.cache`), `atc-s96.53` (the authority hop budget under other hosts),
`atc-s96.49` (the transient environ stand-down flake), `.42` (docs nits).

## Next steps

1. **S11 — engine placement** (`atc-s96.24`, remainder). Brief:
   `.superpowers/sdd/the-development-of-this-calm-planet/task-7-brief.md`
   (read its addendum: Codex paused → E2 not run, E3 with a Claude lead is
   the run; the T13 facts it builds on). Dispatch prompt, ready to send:
   `…/dispatch/s11-dispatch.md` — replace `__BASE__` with the branch HEAD
   and send it to a fresh `cross-agent-implementer` subagent (claude-opus-5,
   effort max, defined in `.claude/agents/cross-agent-implementer.md`).
   First rebase the branch onto `main` (`main`'s later commits touch only
   `VERIFY.md` and `.project-steward/`), then record BASE
   (`git -C .worktrees/cross-agent-m3 rev-parse HEAD`). After each task run
   `node tools/check-citations.mjs --since <BASE>` — it must report 0 drifted
   and 0 not judged — because `npm test` cannot see a citation that moved.
2. **Reviews per task**, in this order: (a) the task review — a
   `general-purpose` subagent on claude-opus-5 with the SDD task-reviewer
   shape (brief, report, review package from
   `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/subagent-driven-development/scripts/review-package PLAN BASE HEAD`,
   the binding constraints); (b) the second review through cross-agent
   itself:
   ```bash
   cd .worktrees/cross-agent-m3 && setsid --fork node \
     .superpowers/sdd/the-development-of-this-calm-planet/dispatch/cross-agent-review.mjs \
     --project "$PWD" --base <BASE> --engine grok --model grok-4.6 --effort xhigh \
     --out .superpowers/sdd/the-development-of-this-calm-planet/task-7-grok-review-round-1.md \
     --context <a short context file naming what the diff claims to do>
   ```
   It writes `<out>.log` and `<out>` (the check and the result as JSON),
   then `<out>.done` — the marker to wait on (poll it in bounded stretches,
   never sleep in the foreground). Extract the review text from the JSON's
   `result` field into `<out>.text.md`. The diff is attached by default (the
   Grok prompt-file budget, `atc-s96.55`, is merged); `--attach-diff no`
   makes the consultant read it from git instead. Expect 10–25 minutes at
   xhigh. Findings from both reviews go into `task-N-findings-round-R.md`
   with stable ids; fix rounds resume the same implementer by SendMessage.
   After each fix round: the Grok seat reviews the fix diff and the
   controller checks closure against the findings file; on the last round
   the Opus 5 task reviewer returns for the scoped re-review plus the
   cumulative whole-task review — never skip that seat (it was skipped on
   T13's rounds until the user caught it).
3. **Before E4–E7 rely on it**, do `atc-s96.56` (the verifier's residual
   regex cases and two non-positional citation bundles). **Then** T14 (`.14`,
   Codex packaging — blocked while Codex is paused:
   record its rows as not run with commands, or wait for the user), T15
   (`.15`, Grok packaging; the sample folder is trusted; `.53`'s hop
   measurement and the read-only Grok probe row belong here), T16
   (`task-10-brief.md`), docs nits (`.42`), the go/no-go (`.18`), the final
   whole-branch review, wrap.
4. **Merges.** Rebase `task/cross-agent-m3` onto `main` (main's own commits
   touch only `.project-steward/`, `AGENTS.md`, `VERIFY.md`), fast-forward,
   run `npm test` at the root, record the SHA and counts in `VERIFY.md`.
   Never push.

## Blockers

- Questions only you can answer are in `.project-steward/QUESTIONS.md`: the
  authority hop budget for nested hosts (`atc-s96.53`), whether a Grok
  specialist in a linked worktree should reach the server through a
  user-scope mount (your Grok config), and when the Codex pause lifts.
- None hard. Codex is paused by the user (2026-09-18); every Codex row is
  recorded with the command that runs it later. `atc-s96.53` (the hop
  budget under other hosts) is a measurement, not a blocker.

## Key files

- `docs/design.md`: the authority — "The lead model", sections 1 to 10, the
  work plan with what landed per row, Verification. `docs/probes.md`: P1–P10,
  I1, I2, E1 with the settings JSON and transcripts each run sent.
- `src/`: `server.ts`, `authority.ts`, `project.ts`, `delegate.ts`,
  `tasks.ts`, `wait.ts`, `modes.ts`, `cli.ts`, `gitroot.ts`, `runcommand.ts`,
  `config.ts`, `ledger.ts`, `locks.ts`, `process.ts`, `reconcile.ts`,
  `worktree.ts`, `reservation.ts`, `gitmutate.ts`, `journal.ts`, `runner.ts`,
  `guard.ts`; `engines/` (`types.ts`, `spawn.ts`, `registry.ts`,
  `binaries.ts`, `text.ts`, `claude.ts`, `codex.ts`, `grok.ts`). `tests/`
  mirrors it; `tests/fixtures/fake-engine.mjs` and `tests/helpers/`.
- `skills/cross-agent/SKILL.md` (the launcher), `modes/{dev-team,
  dev-team-engine,solo}/`, `.claude-plugin/plugin.json` (inline `mcpServers`).
- `tools/probe.mjs` (engine probes; `--track` spawns the real runner),
  `tools/e2e-verify.mjs` (the eight end-to-end checks), `tools/check-citations.mjs`,
  `tools/from-openmaus.mjs` (one-off, history).
- `VERIFY.md` (counts and runs per milestone), `.project-steward/DECISIONS.md`
  0010 (every ruling of M1–M3 with its cost), the plan
  `~/.claude/plans/the-development-of-this-calm-planet.md` (with the user's
  amendments), the SDD ledger
  `.superpowers/sdd/the-development-of-this-calm-planet/progress.md` (every
  dispatch, ruling and review; git-ignored), its `dispatch/` (the review
  driver, dispatch drafts, the citation-drift script).

## Tried and rejected

- An `O_EXCL` lock file with a TTL and a rename-based reclaim (Decision 0004).
- A per-process witness cache for engine liveness (replaced by the group scan).
- A lead token in the launch spec (readable by every sandbox; replaced by
  process ancestry).
- Grok as an engine-placed lead (P9: no per-run MCP isolation).
- A repository-root `.mcp.json` for the plugin: Claude Code reads it as this
  repository's own project-scoped config in every developer session, where
  `${CLAUDE_PLUGIN_ROOT}` is empty (T13; inline `mcpServers` instead).
- `/grok-build:review` as the second review seat: its bridge caps effort at
  `high` (the user wants xhigh; cross-agent's own `consult` does it).
- Attaching a 150 KB diff to a Grok brief before `atc-s96.55`: `E2BIG`.
- Relying on Claude's default sandbox for a read-only role: it writes to the
  cwd by default (T6-R1-20; `denyWrite` of the cwd now).

## Warnings

- Never push. Checkpoints commit on `main`, Conventional Commits, ending with
  the Co-Authored-By trailer the session's attribution instruction names (this
  session used Claude Fable 5.1, then Claude Opus 5 (1M context) after the
  user switched models); subagents are told the trailer in their brief.
- `AGENTS.md` and `CLAUDE.md` are user-owned: the user approved AGENTS.md
  changes for the 2026-09-19 session only (Decision 0010); a new session asks
  again and shows the diff first.
- The worktree `.worktrees/cross-agent-m3` holds a git-ignored `.cross-agent/`
  (a `solo` config and the review tasks' records): the controller's review
  harness, not the repository's. Leave it; never commit it.
- Anything spawned from a Claude Code shell has a `claude` ancestor: a
  cross-agent server started there resolves as a specialist. Launch the
  review driver (and any host session for an end-to-end run) with
  `setsid --fork` from the target directory.
- `pgrep -f`/`pkill -f` with a pattern that matches your own shell's command
  line kills the shell (exit 144, twice this session); anchor the pattern
  (`'^node .*script\.mjs'`).
- `npm test` runs the citation checker, which proves a cited line or symbol
  exists, not that it still says what the sentence claims. Cite tests by
  `// @anchor`, passages by `<!-- @anchor -->`, code by `#symbol`, and run
  `node tools/check-citations.mjs --since <task base>` after every task: it
  reports each line citation whose text moved and each one it cannot judge.
  An anchor on the wrong test is invisible to both — read the sentence
  against the test title (T13 needed three rounds for this).
- The suite is load-sensitive (`atc-s96.33`, `.49`): a timing assertion can
  fail under load about one run in four; rerun the file in isolation first.
- Projects under `/tmp` or `$TMPDIR` are not isolated by the Codex or Grok
  sandbox; the e2e sample lives under `~/.cache/agent-team/cross-agent-e2e/`.
- The git stash is shared across worktrees: never a bare `git stash`.
- Two dirty paths at the root are expected and never committed:
  `.beads/interactions.jsonl` (bd's own interaction log) and `.codex/agents/`
  (the Codex plugin's mirror of the implementer agent definition).
- Never run an engine at this repository's root or in the worktree except
  the review `consult` (read-only) the user asked for; the sample is the
  target for everything else.
