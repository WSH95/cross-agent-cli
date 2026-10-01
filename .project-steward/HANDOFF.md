---
updated_at: 2026-10-01T10:44:12Z
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

2026-10-01: task 6b (pre-flight probes and hardening) is **merged** — `main` at
`d428145` (24 commits over `cb87b01`), `VERIFY.md` 6b section at `a0d97b6`;
`npm test` 659 / 658 / 1 skipped; checker 909 citations, 0 misses. Beads closed:
`.47`, `.49`, `.50`, `.51`, `.56`, `atc-3ub`; `.53` stays open for the Codex and
Grok hosts' hop counts. What it established: the current CLIs (claude 2.1.286,
codex-cli 0.159.2 — now 0.159.3 on the PATH, grok 1.0.44) answer a consult;
Grok's read-only sandbox needed `/run/podman` at 0711 on this machine
(`RISKS.md`); Claude specialists run with the operator's hooks disabled; the
authority walk allows 32 hops; the end-to-end verifier fails closed by class —
on a named line `pass` needs positive understanding — and reads Codex rollouts
(keep `~/.codex/sessions` until a Codex run is verified). Filed:
`atc-s96.57` (Claude specialists still load skills and commands), `.58` (the
suite's temp-dir leak), `.59` (U+2028/U+2029 in a request hang the server —
for S11), `.60` (verifier shapes outside its classes).

S11 (`atc-s96.24`, with `.59`) is **merged** — `main` at `ebc9960` (25 commits
over `886ae9f`), `VERIFY.md` S11 section at `b858d11`; `npm test` 703 / 702 / 1
skipped; checker 1011 citations, 0 misses. Engine placement works with a Claude
lead (E3) and a Codex lead (E2, E2b, E2c), each run 7 pass and a `?` a person read
as no launch; the mailbox, the CLI's `answer`/`report` and exit protocol, and
the launcher's placement routing are built. The sample
(`~/.cache/agent-team/cross-agent-e2e/slugkit`) is clean on its `main` at
`15e9f4e`, in `dev-team-engine` (T14 switches it for E4). Follow-up beads
`.61`–`.66`.

T16 (`atc-s96.16`, the operator CLI) is **merged** — `main` at `1f57683` (16
commits over `567a1f5`), `VERIFY.md` T16 section at `48084b6`; `npm test` 723 / 722 /
1 skipped; checker 1083 citations, 0 misses. The nine remaining verbs run on S11's
dispatcher, each calling what its tool calls; the reads write nothing; the writing
verbs refuse under `CROSS_AGENT_TASK`, `_DEPTH` or `_LINEAGE`. Filed from it: `.67`
(a lock taken before the ledger exists leaves an unexcluded `.cross-agent/`) and
`.68` (one source for the status list and the task-id alphabet). Next: T14 (Codex
packaging, E4 and E5), then T15.


## Next steps

1. **Task 6b first**, then **S11 — engine placement** (`atc-s96.24`,
   remainder). S11's brief,
   `.superpowers/sdd/the-development-of-this-calm-planet/task-7-brief.md`,
   needs refreshing: Codex is available again, so E2 runs, and the Codex
   lead needs `tool_timeout_sec` (Codex's per-tool default is 60 s).
   After each task run
   `node tools/check-citations.mjs --since <BASE>` — it must report 0 drifted
   and 0 not judged — because `npm test` cannot see a citation that moved.
2. **Then** T16 (`.16`, the operator CLI; its brief `task-10-brief.md` v2 is in
   plan review), then T14 (`.14`,
   Codex packaging), T15
   (`.15`, Grok packaging; the sample folder is trusted; `.53`'s hop
   measurement and the read-only Grok probe row belong here), docs nits (`.42`), the go/no-go (`.18`), the final
   whole-branch review, wrap.
3. **Merges.** Rebase `task/cross-agent-m3` onto `main` (main's own commits
   touch only `.project-steward/`, `AGENTS.md`, `VERIFY.md`), fast-forward,
   run `npm test` at the root, record the SHA and counts in `VERIFY.md`.
   Never push.

## Blockers

- Questions only you can answer are in `.project-steward/QUESTIONS.md`: the
  authority hop budget for nested hosts (`atc-s96.53`) and whether a Grok
  specialist in a linked worktree should reach the server through a
  user-scope mount (your Grok config).
- None hard. `atc-s96.53` (the hop
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
  `~/.claude/plans/the-development-of-this-calm-planet.md`, the SDD ledger
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
- Attaching a 150 KB diff to a Grok brief before `atc-s96.55`: `E2BIG`.
- Relying on Claude's default sandbox for a read-only role: it writes to the
  cwd by default (T6-R1-20; `denyWrite` of the cwd now).

## Warnings

- Never push. Checkpoints commit on `main`, Conventional Commits, ending with
  the Co-Authored-By trailer the session's attribution instruction names.
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
  a read-only `consult`; the sample is the target for everything else.
