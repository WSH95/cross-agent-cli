<!-- Approved design of 2026-09-07, rewritten 2026-09-09 as the authority for
cross-agent. Source of truth for this repository; the OpenMausBot pack's own
history lives in ~/Documents/agent-team-devpack. -->

# cross-agent: a multi-engine orchestrator for Claude Code, Codex, and Grok

## Context

This repository builds **cross-agent**: one MCP server plus a launcher skill
that let any host session — Claude Code, Codex, or Grok — run a team of
headless `claude`, `codex`, and `grok` processes on the operator's own
subscriptions, each inside its own sandbox. The four-role dev team that runs
on OpenMausBot in `~/Documents/agent-team-devpack` is **one operating mode**
of that tool, not the tool. Research on 2026-09-07 (read-only, summarised in
"Findings" at the end) established the feasibility: about 70% of the pack is
host-independent text, every engine CLI on this machine has a headless mode
with session resume and a sandbox, and the reasons Paperclip was dropped do
not apply to a plugin that composes public CLIs.

Decisions taken with the user:

- Standalone: no OpenMausBot dependency, no chat, no rooms. OpenMausBot code
  (Apache-2.0) may be referenced or ported. Its limits (wake budget, dropped
  wakes, four pending delegations, the 4-minute ask cap, one-hop chains,
  immutable playbooks, the 1,000-character cap) are not constraints.
- One MCP server core, TypeScript on Node 24, attached by every host with
  the same launcher skill text.
- Each CLI's own sandbox is the boundary. No approval broker.
- No time cap on a delegated task; `wait` reports a stall instead.
- Cooperative delegation loops (Claude Code delegates to Codex, Codex
  delegates back) must be impossible in code and tested.
- The user's `agent-plugins` marketplace and the `agent-artifact-maintainer`
  skill are unrelated to this project.
- New repository `~/Documents/agent-team-cli`, plugin name **`cross-agent`**.
  Its first feature tasks (T1 to T5) were M7's "first real repository" for the
  OpenMausBot pack, sent to Sudo one at a time. This repo is not bound by the
  devpack's AGENTS.md (no 500-line ceiling).
- Prose in prompts, briefs, and docs stays purposeful; no artificial length
  limit.
- The devpack's four-role team is the built-in mode **`dev-team`**. A mode is
  a directory of text plus one JSON descriptor; the core is mode-agnostic.
- The mode format is **native only**. OpenMausBot's `openmaus.package` v1 is
  not a supported import format; the devpack's role text is carried over once
  by a converter, not read at runtime.
- **Its own path** (2026-10-02). cross-agent follows its own development path:
  it is not the OpenMausBot pack's second binding and is not tied to the
  devpack. If team or workflow configuration needs importing or exporting,
  that is a feature of this repository, in its own format (`atc-s96.96`;
  Decision 0011).
- A **lead** is whichever session holds the lead tools and runs the mode's
  loop. `placement: "host"` puts that session in the operator's own host;
  `placement: "engine"` puts it in a spawned engine. `host` is built first;
  `engine` is the portability mechanism and is scheduled after the first
  end-to-end run.
- Parity with the vendor bridges `codex-plugin-cc` and `grok-build-plugin-cc`
  (installed as the Claude Code plugins `codex` 1.0.6 by OpenAI and
  `grok-build` 0.2.1 by xAI) is wanted **in principle only**: the `solo` mode
  covers the one-shot delegation those bridges offer; diff-scoped review and
  critique verbs are not copied.

Reviewed twice by Codex gpt-6-astra (effort xhigh) on 2026-09-07. Round one:
twelve findings, all adopted. Round two: ten new findings and nine partials,
all adopted; the two places where the plan takes a narrower option than
suggested are marked "(narrowed)". Reviewed twice more on 2026-09-08 and
2026-09-09, by the same reviewer, against the shipped code: round one found
four lifecycle defects in T1–T5 (sections 2 to 4 below carry the corrected
rules) and withdrew four wrong claims, which stay withdrawn; round two found
that an engine-placed lead needs a capability model rather than a token, that
a mode's loop text has no discovery path on any host, that the record lock is
required for the lifecycle fixes to hold, and that an engine lead has no path
to root git operations. All four are in this document.

## Design

### The lead model

Part of this section is built. T1–T5 ship the ledger, the config loader and
`verify_worktree`, the guard primitives, the adapter interface and spawn
pipeline, and the detached runner. T10a adds authority by ancestry — the
walk, the match, positive operator provenance and revalidation on every
request (`src/authority.ts#resolveAuthority`) — and project discovery
(`src/project.ts#discoverProject`), and the server offers and refuses its
tools by the row it resolves (`src/server.ts#createServer`). T10b adds the
delegation rows themselves: `delegate`, `check`, `result`, `cancel` and
`list_tasks`, each offered to the rows below and each applying its own half of
the matrix inside itself (`src/delegate.ts#delegate`, `src/tasks.ts#cancel`);
T11 adds `wait`, which shares `cancel`'s row and applies the same lineage check
before it polls (`src/wait.ts#wait`, `src/server.ts#projectTools`). S8 adds the
mode the entry point loads once at start, so the resolver is now given that
mode's `lead.role` and the cap it derives (`src/server.ts#main`,
`src/config.ts#effectiveMaxDepth`); under a host-placed mode there is no lead
role to match. S11 builds engine placement: `delegate` launches the mode's lead
role with this server mounted and the loop as its instructions
(`src/delegate.ts#delegate`), the mailbox carries its questions
(`src/mailbox.ts#ask`), and its rows join the matrix (`src/server.ts#projectTools`).
All of this section is built.

**A lead is a session holding the lead tools and running the mode's loop.
`placement` decides which process that session is.**

| | `placement: host` | `placement: engine` |
|---|---|---|
| Who runs the loop | your host session | a spawned engine: Claude or Codex (P9; not Grok, item 4) |
| Host loads | launcher skill + the mode's loop | launcher skill only |
| Your session while it runs | busy between `wait` calls | free — `wait`/`check`, `list_asks`/`answer`, `cancel`, `cross-agent report` |
| Survives closing the session | tasks yes, loop no | yes; exclusive reattach by task id |
| Lead asks you a question | natively | `ask`/`answer` mailbox |
| Root git operations | `git_root` and `run_command` | the same two tools, the lead's only reach at the root |
| Loop-guard layer 2 | intact | relaxed for the lead's server only |
| Cost per task | one engine per specialist | one more, for the lead |

#### Authority is process ancestry, not a token

A lead token carried in the launch spec was considered and rejected. It is
unsafe here for a structural reason, not a probed one: `LaunchSpec` serializes
the child environment (`src/ledger.ts#LaunchSpec`,
`src/engines/types.ts#SpawnRequest`) into `.cross-agent/tasks/<id>.spec.json`
(`src/ledger.ts#writeSpec`); `.cross-agent/` lives inside the project, and every
role — read-only ones above all — must be able to read the project to do its
work. P2 records that the profiles in use restrict *writes*, not reads, so
nothing stops a specialist from reading a lead's token out of a spec file.
Possession must therefore not equal authority.

The design requires instead that the server derive its authority from **who
spawned it**. Every engine CLI spawns its MCP servers as children of the
engine process, and the ledger already records each engine's identity as
`engineIdentity` — `{pid, startTime, bootId, pgid}`
(`src/ledger.ts#EngineIdentity`, `#ProcessIdentity`), written at
`src/runner.ts#acknowledge`.

**The walk.** At each hop the server reads `/proc/<pid>/stat` through
`readProcessStat` (`src/ledger.ts#readProcessStat`), which returns `ppid` —
stat field 4, the element before `pgrp` — beside `startTime`, `state`, `pgid`
and `sid`. Starting at its own parent, the walk follows `ppid` for at most **32
hops** — enough for a host nested inside another session, which sits nine or
more hops below pid 1 (`docs/probes.md#walk32`), and for any wrapper
an engine puts in between — and ends without a match only at a process whose
`ppid` is 0, the root (`src/authority.ts#maxHops`, the user's decision of
2026-09-30). The walk **fails
closed to the specialist row** on a stat it cannot read, on a cycle, on hop
exhaustion, and on a parent whose start time is later than its child's, which
means the chain was reparented and the ancestor is not the one that spawned this
server (`src/authority.ts#walk`). An environment it cannot read is not a
failure of the walk: it is evidence of nothing, and the match below treats it
so.

**Identity across boots.** `runnerIdentity` and `engineIdentity` carry a
`bootId`, read once from `/proc/sys/kernel/random/boot_id`
(`src/ledger.ts#currentBootId`), because a pid and start time from another boot
can collide with a live process; an identity whose `bootId` differs from the
current one is dead, full stop (`src/ledger.ts#isProcessAlive`,
`src/process.ts#inspectGroup`). That field is built (section 2), and the
authority match below compares it as well.

**What counts as a match.** An ancestor matches a task when all of these hold:
its `pid`, `startTime` and `bootId` equal that record's `engineIdentity`; its
`/proc/<pid>/environ` contains `CROSS_AGENT_TASK=<that record's id>`; exactly
one such record exists in the canonical project; and that record's status is
`running` or `stalled`. No other status carries authority — `launching` has
not been acknowledged, `cancelling` is being torn down, `orphaned` has lost
its runner, and a terminal record is over. The **nearest** engine ancestor
decides the row: the walk ends at the first ancestor holding any record's
engine identity, and the row is **lead** only when that ancestor matches and
its record's `role` equals the active mode's `lead.role`; otherwise
**specialist** (`src/authority.ts#decide`). An engine whose record left
`running|stalled`, or whose environment is unreadable or names another task,
still ends the walk, so its server never reaches the row of a lead above it.
Nearest-match makes a server started by a specialist under a lead resolve to
the specialist, and a Grok specialist that inherits the user's MCP
configuration (section 3) resolve to itself. Until a specialist's runner
acknowledges its engine, that engine holds no identity and the walk would pass
it to reach the lead's, so the lead row also requires that the nearest task
the server carries — its own `CROSS_AGENT_TASK`, else the nearest ancestor's
— is the lead's own. No secret exists to copy or replay.

**Operator provenance is positive, not the absence of a match.** A server is
the operator's own only when `CROSS_AGENT_DEPTH`, `CROSS_AGENT_LINEAGE` and
`CROSS_AGENT_TASK` are all absent from its environment **and** the walk
reached the root without meeting an engine ancestor or an ancestor whose
environment carries `CROSS_AGENT_TASK`. The ancestors' environments count
because an engine may start a server in a fresh environment rather than a copy
of its own, and then only the engine and its runner still carry the task. A
server that carries any of those variables, or sits under an ancestor that
does, but matches no record is a **specialist** (`src/authority.ts#unmatched`).
That also settles the spawn-versus-acknowledgement race: a lead's server that
starts before its record reaches `running` is a specialist until revalidation
sees `running`, which is the safe direction.

**A fresh server environment keeps the row and loses the depth.** Codex is such an
engine: 0.159.3 starts a stdio server with `HOME`, `LANG`, `LOGNAME`, `PATH`,
`SHELL`, `TERM` and `USER` and nothing of the task (`docs/probes.md#e2ServerEnv`).
The walk still finds the lead's engine, so the row is the lead's; but depth and
lineage are read from the server's own environment (`src/guard.ts#readDepth`,
`src/delegate.ts#delegate`), so such a server resolved the lead at depth 0 and
recorded its children at depth 1 with no lead in their lineage. The Codex mount
therefore names the four markers in `mcp_servers.<id>.env_vars`, a constant list of
names whose values Codex copies from the lead's own environment, which the runner
started from the spec's (`src/engines/codex.ts#codex`); the literal-values `env` stays
refused. Claude starts its servers with a copy of its own environment, markers
included (`docs/probes.md#e3`).

**Resolution is revalidated on every `tools/list` and `tools/call`**, never
cached for the connection's lifetime: the server calls the resolver for each
request (`src/server.ts#createServer`), and every resolution walks in full —
at most 33 stat reads, its own first and then up to 32 ancestors', 32
environment reads, and one scan of the records. So a lead whose record leaves
`running|stalled` loses the row on its next call, and a lead whose record
reaches `running` after its server started gains it on its next call; without
the re-walk the spawn-versus-acknowledgement race above would be permanent
rather than transient. Re-reading only a matched ancestor and its record would
save a few reads, but a full walk cannot go stale when the chain above the
server changes.

**Which project.** The server takes `--project <root>`, and the lead mount spec
passes it: `delegate` mounts `<this repository>/src/server.ts --project <root>`
with no environment, the one form both lead engines' mounts accept
(`src/engines/types.ts#LeadMountSpec`, `src/delegate.ts#engineLead`). `childEnv` also sets
`CROSS_AGENT_PROJECT=<canonical root>` (`src/guard.ts#childEnv`), so a server a
Grok child starts from inherited configuration finds the right ledger. For a
host session with neither, discovery reads the working directory in three passes
(`src/project.ts#projectStart`, `#discoverProject`). First, from outside in and before
any config is looked at, the working directory is taken out of every worktree that an
enclosing work tree registers inside itself, and read at the same place in that work
tree, lexically, since the path need not exist on its branch: a directory inside a
task's worktree is its root's, whatever became of the worktree's pointer
(`src/worktree.ts#enclosingWorktree`). A part of the mapped path that runs through a
file or round a symlink loop on the root's branch names no entry, as a missing one
does (`tests/project.test.ts#remapCrossesFile`). Then local opt-in: the nearest directory
holding a `.git` entry is a project of its own when it holds `.cross-agent/config.json`
too — a linked worktree `cross-agent init` was run in — and otherwise it is read at
its main checkout, the registry's first stanza when that is a work tree by its own
git, which keeps the old mapping wherever it was right. A separated main's first
stanza is its git directory, and a main checkout, a bare repository or a registry
that will not read leave the working directory where it is. Last, the walk: the
nearest directory at or above that start holding a config. Where **no** directory
does, the project is the main checkout the start was read at, or else the working
directory's own git toplevel, running `solo` on the defaults `loadConfig` answers with
when there is no file, so a one-off delegation needs no `init` first ("Modes"); a
directory in no git repository is still the reason there is none. Every root this
answers with, and every root a caller names, is checked against the registries of the
work trees enclosing it before it is returned and before any config is read
(`src/project.ts#named`), and the server exits naming the reason rather than guess
(`src/server.ts#main`). So a worktree project may not lie inside another work tree of
its repository: `M/branches/x` is refused as a root, as `M/.worktrees/<slug>` always
was a task's. The umbrella layout — `U/.git` a pointer file to the bare `U/.bare`,
with `U/main` and `U/feature` its worktrees — and a bare repository beside its
worktrees, `repo.git`, are fine, because neither `U` nor `repo.git` is a work tree by
its own git; and a submodule checkout is no project root. A Codex host's plugin
server is the exception: Codex starts it in its cache copy of the plugin, where
discovery finds no project the operator meant — nothing from an export's copy, and
from a checkout's, whose `.git` came along, a repository the operator did not name:
the copy itself, for a main checkout or a worktree initialized as a project of its
own, and the main checkout its pointer leads to, for any other linked worktree. So
the operator names the project in `CROSS_AGENT_PROJECT`, and the plugin's launcher
will not start the server without it (section 9, `docs/probes.md#codexPluginMount`).
A root a caller **names** — `--project` or `CROSS_AGENT_PROJECT` — must hold a config
even so: naming one is a claim about a project, and a typo in that claim is not a new
project.

#### Permission matrix

| Tool | operator | lead (engine) | specialist |
|---|---|---|---|
| `describe_mode`, `list_roles`, `list_tasks`, `check`, `result` | yes | yes | yes |
| `delegate` (a specialist) | yes | yes, lineage-checked | **no** |
| `delegate` (another lead) | yes | **no** | no |
| `wait`, `cancel` | yes | own children | no |
| `verify_worktree`, `git_mutate` | yes | yes | no |
| `git_root`, `run_command` | yes | yes | no |
| `ask` | — | yes | no |
| `list_asks` | yes | own asks | no |
| `answer` | yes | no | no |

A refused tool is refused at **`tools/call` by name**, not merely omitted from
`tools/list`. Each tool carries the rows it is offered to
(`src/server.ts#ToolDefinition`); `tools/list` lists those of the resolved
row, and a call to a registered tool outside it is answered
`<tool> is not available to a <row> server: <reason>`, the reason being the
resolver's evidence — the matched engine's task, role and status, the variable
that made the server a specialist, or the depth cap
(`src/server.ts#createServer`). A name nothing registers stays `unknown tool`.
The name a refusal acts on is this server's own — `verify_worktree` today,
`delegate` and `cancel` from T10b — never the host's rendering of it: a host
may prefix and fold it, as Codex does, turning `cross-agent` into
`mcp__cross_agent__list_roles` (`docs/probes.md#p9Mounts`). The server never sees
that spelling, so nothing in the matrix depends on it.

#### Engine placement needs four things the host placement does not

1. **Root git tools.** `git_mutate` operates only on a verified linked
   worktree; `verifyWorktree` rejects the main worktree, subdirectories, and any
   worktree not strictly under the project root (`src/worktree.ts#verifyWorktree`). The loop also creates worktrees, merges
   on the default branch, runs the tests there, removes worktrees and deletes
   branches (section 4). An engine lead is read-only at the root, so the design
   gives it two tools whose contracts section 4 states in full: `git_root`, one
   whitelisted verb at a time, journaled, under `git.lock`; and `run_command`,
   which takes a selector rather than a command string. A host-placed lead has
   its own tools and uses these two anyway, because the journal is one document
   and a step nobody wrote is a gap in it (plan decision 4).
2. **Cascade ownership.** A record carries `parentTaskId`, set to the lead's own
   task when a lead delegated it and preserved across `resume`: a continuation
   takes the parent of the record it continues, not the caller that asked for it,
   and a lead may continue only a task it owns — one resumed by a stranger would
   be an engine in the first lead's own workspace that its cascade could never
   reach (`src/ledger.ts#TaskRecord`, `src/delegate.ts#delegate`). **Ownership is by
   lineage ids**: a task's lineage ids are its own id and the ids of the records
   it continues, back along `resumedFrom`, and a lead owns a task whose
   `parentTaskId` chain reaches any of them (`src/tasks.ts#lineageIds`,
   `#ownedBy`). So a lead that has been killed and reattached twice still owns
   the children its first record delegated, and `wait`, `cancel` and a resume ask
   the same question of the same helper (`src/server.ts#projectTools`,
   `src/tasks.ts#cancel`, `src/delegate.ts#delegate`); the operator owns every
   task, and its CLI asks none.
   `cancel` on a lead writes
   `cancelling` on the **lead first**, under `spawn.lock` and with the snapshot
   of its descendants taken in the same hold — from that moment `delegate`
   refuses any child of a cancelling parent, so a delegation that races the
   cascade is either refused or already in the snapshot (`src/tasks.ts#cancel`,
   `src/delegate.ts#delegate`). It then cancels the descendants from the leaves
   upward, re-reading the ledger until a round finds nothing new, and the lead
   itself last, and returns one outcome per task. A partial failure is reported
   as such and a later `cancel` retries it, because a cascade that reported
   success while a descendant survived would be the field failure this whole
   lifecycle exists to prevent; one task that cannot be written is that task's
   outcome and never the end of the pass. **Reattach is exclusive** at both
   levels: one runner per task, by the `runner-<id>.lock` of section 2, and one
   live record per resume chain, by the two chain rules `delegate` applies
   before it writes (section 5, layer 4).
3. **The mailbox**, built (`src/mailbox.ts`). `ask`, `list_asks`, `answer`,
   backed by `.cross-agent/asks/<id>.json` and written by **the server or the
   operator CLI only**. No engine child can write there: it has no tool that
   does, and `.cross-agent/` sits at the project root, which no writable sandbox
   reaches — that second half holds because of the mode rule that no role may
   combine `{kind: "root"}` with a writable sandbox (the Modes section), so it
   is a guarantee and not an accident. An ask record is `{id, taskId,
   question, createdAt, status: "open" | "answered" | "cancelled", answer?,
   answeredAt?, cancelledAt?}`, its id from the ledger's alphabet, written whole,
   and a read of an ask nobody wrote creates nothing (`src/mailbox.ts#readAsk`);
   a damaged one is answered as a value naming the file, so `ask`, `answer` and
   `cross-agent answer` refuse it rather than throw (`#AskRead`,
   `tests/mailbox.test.ts#readAskDamaged`). The readers bound an ask's times by
   finiteness alone, and the mailbox's refusals print a time no date can hold as
   its number, as the operator CLI does, so `answer` and `cross-agent answer`
   refuse an answered or cancelled ask carrying one as they refuse any other
   (`src/mailbox.ts#printable`, `tests/mailbox.test.ts#askTimeOutOfRange`,
   `tests/server.test.ts#answerToolTimeOutOfRange`, `tests/cli.test.ts#answerTimeOutOfRange`).
   An id outside the ledger's alphabet names no ask either, and `ask`, `answer` and
   `cross-agent answer` refuse it by value through one predicate
   (`src/mailbox.ts#isAskId`, `tests/mailbox.test.ts#malformedAskId`).
   `ask` blocks up to `timeout_seconds` (default `waitDefaultSeconds`) and
   returns `{id, status, answer?}`: `open` with the hint to ask again by that
   `id` when the timeout passes first, which is what keeps a long wait inside
   the host's tool timeout, and `cancelled: true` with the record untouched when
   the call itself is aborted (`src/mailbox.ts#ask`). A lead asks under its own
   task and may wait again by id on any ask of its lineage — its own record and
   those it continues — and on no other. The first `answer` wins: under the
   ask's own lock the record is read again, and a second is refused naming when
   the first landed (`src/mailbox.ts#answerAsk`, `src/locks.ts#askLockName`).
   Cancelling a lead cancels the open asks of its lineage and reports their ids
   as `asksCancelled` (`src/tasks.ts#cancel`, `src/mailbox.ts#cancelAsks`); and a
   `resume` of a lead carries every ask of the original's lineage, with its
   status and answer, appended to the brief under `## Asks so far` while the
   record hashes the caller's own text (`src/mailbox.ts#asksSection`,
   `src/delegate.ts#delegate`), which is how an answer reaches a lead that was
   killed while waiting (`docs/probes.md#injectKilledLeadAsk`). A damaged ask
   file counts as a lineage's when it names a task of that lineage or no task a
   reader could find (`src/mailbox.ts#lineageAsks`): a resume refuses while one
   exists, naming the file, because the continuation would be told part of its
   history as the whole (`tests/delegate.test.ts#resumeRefusesUnreadableAsk`),
   and a cancel names it, and a mailbox it cannot list, under
   `asksNotCancelled` beside its cascade's outcomes, never instead of them
   (`tests/tasks.test.ts#cancelSurvivesMailbox`). `list_asks` shows a lead those
   files and the operator every one (`src/server.ts#mailboxTools`,
   `tests/server.test.ts#listAsksLeadDamaged`). The mailbox
   sidesteps every relay limit the OpenMausBot reference carries: cards that die
   with the turn, a three-per-five-minute wake budget, a four-minute ask cap, a
   fifteen-minute auto-deny. It is registered under engine placement only, and
   only to the rows the matrix gives it (`src/server.ts#projectTools`):
   specialists are **unauthorized** to ask, not unable to reach the server — a
   Grok specialist can reach an inherited server, since the Grok exclusion list
   is empty by necessity (`src/engines/grok.ts#exclusionArgs`).
4. **Injection, now probed per engine (P9, `docs/probes.md#p9`).** Two
   engines can carry a lead and one cannot.

   **Claude.** `--strict-mcp-config --mcp-config <file>` mounts exactly this
   server and nothing else: the child's `mcp_servers` is
   `[{"name":"cross-agent","status":"connected"}]` and the only `mcp__` tools
   are this server's (`docs/probes.md#p9Mounts`). The strict flag is what makes it
   exclusive — an otherwise identical run without it saw five of the
   operator's own servers (`docs/probes.md#p9Mounts`). Instructions go through
   `--append-system-prompt-file <file>`, accepted and obeyed, which closes the
   spelling question this design carried (`docs/probes.md#p9ClaudeInstructions`).

   **Codex.** `-c mcp_servers.cross-agent.command`, `…args` and
   `…default_tools_approval_mode="approve"`, all three under
   `--ignore-user-config`, mount this server plus Codex's built-in
   `codex_apps` and nothing of the operator's. The third setting is not
   optional: `codex exec` runs with approval policy `never`, so without it the
   lead sees the tools and every call is refused
   (`docs/probes.md#p9Mounts`, `#p9CodexMount`). S11 adds two more, so a lead's
   mount is five settings (`src/engines/codex.ts#codex`): `…tool_timeout_sec=3600`,
   because Codex gives an MCP call 60 s by default and a lead's `wait` and `ask`
   are 600 s calls — B2 timed a lead's `wait` at 158 s by Codex's own record of
   it (`docs/probes.md#s11CodexLeadTimeout`) — and `…env_vars=` the four task
   markers, because Codex starts the server in an environment of its own
   ("Operator provenance" above, `docs/probes.md#e2ServerEnv`). Instructions go
   through `-c model_instructions_file="<file>"`, accepted and obeyed with no role
   text in the prompt, so the loop costs a Codex lead no prompt space.

   **Grok is not supported as an engine-placed lead.** P9 found no per-run
   isolation of any kind (`docs/probes.md#p9Mounts`, `#p9GrokInherits`). A Grok child
   inherits the operator's `~/.grok/config.toml`, the operator's Grok plugins,
   and the servers the operator declared to *Claude* in `~/.claude.json` —
   that last, the load-bearing half, rests on archived output, while the single
   `grok inspect` listing that showed all three sources at once is transcribed,
   not archived (see the probe row). The one mount that is per-project — `grok
   mcp add --scope project` — is not started for an untrusted folder, and no
   `--trust` flag exists on `grok`, `grok mcp add` or `grok mcp doctor` in
   1.0.13, so a headless run cannot trust one; that doctor report is also
   transcribed, not archived (see the probe row). Mounting a Grok lead would
   therefore mean registering and unregistering a server in the operator's own
   global configuration around every run, and the lead would still see every
   other server the operator has. That is a mutation of the operator's machine
   as the price of a lead, and this design refuses it. Grok remains a
   **specialist** engine — held to the specialist row by ancestry, which is
   exactly the inheritance case section 5 was written for — and a **host**,
   where the loop runs in the operator's own Grok session and no mount is
   needed. Under an engine-placed mode, a config that binds the mode's
   `lead.role` to `grok` is refused at load **and again at the launch
   boundary**, where `delegate` checks the engine the call will actually start
   rather than the one config binds — a per-call `engine` override would
   otherwise reach exactly the mount this item rules out, and the server an
   inherited configuration hands that child resolves to the **lead row**
   (section 6, `src/delegate.ts#delegate`).

   So "the loop as the lead's system prompt" is settled rather than assumed:
   a file on Claude, a file on Codex, and no lead on Grok.

#### Two skills, and how the loop is delivered

`skills/cross-agent/SKILL.md` is the **launcher**, and it is written: select
the mode, start, watch, answer, cancel, reconcile, report, and the paragraphs
every host-placed mode shares — the merge policy a `worktree: true` task settles
under, the `review` and `critique` verbs, the reconciliation pass — each of which
says it is `host` placement's wherever it orders a loop step. It is host-independent,
and `tests/skills.test.ts` holds every tool it names to the row that may call it
(`src/server.ts#projectTools`). `modes/<name>/SKILL.md` is that mode's **loop**,
written for each of the three. Hosts discover only `skills/`,
and Codex's documented fallback copies that one directory (section 9), so a
mode's loop cannot be found by convention on any host. The server serves it
instead: `describe_mode` returns the active mode's loop text, its roles, and its
workspace and git policy, and the launcher's first step is to call it
(`src/modes.ts#describeMode`). The launcher routes on `mode.lead.placement`
right after that call: under `host` the loop is the host session's own
instructions; under `engine` the host starts the lead with one `delegate`,
watches it with `wait` and `check`, answers it through `list_asks` and `answer`,
cancels or resumes it, and reads its closing report through `result`, and never
runs a step of the loop itself (`skills/cross-agent/SKILL.md`, "Engine
placement"; `tests/skills.test.ts#launcherRoutesPlacement`, which fails on any
paragraph outside that section ordering a loop step without naming `host`).
Reconciliation follows who is live: the lead's step 1 while a lead is, and at the
start of a session too, when the host delegates the lead and leaves the root to it;
the continuing lead's when the user resumes a failed one; and the host's own pass
through `git_root` only over the leftovers of a lead that failed or was killed and
will not be resumed, as the operator's was after I4
(`tests/skills.test.ts#engineWhoReconciles`). An ask file a resume cannot read is
the operator's to repair or remove by hand before the lead is resumed. The test
that holds the paragraphs outside that section to naming `host` judges each list
item on its own and catches a bare `delegate` as well as a spelled one
(`tests/skills.test.ts#routingGuardBites`). Under `engine`
placement the loop reaches the lead through the engine's own instruction file —
`--append-system-prompt-file` on Claude, `-c model_instructions_file=` on Codex
(P9, item 4 above) — composed once by `delegate`: the mode's loop verbatim, a
blank line, then the lead's role prompt, or the prompt config binds for the role,
which replaces the role half only (`src/delegate.ts#engineLead`). No asset
copying, no per-host loader, and no second copy of the loop to keep in step.

### Modes

Modes are built. `modes/` holds three of them, `src/modes.ts` validates one and
serves its text, and `describe_mode` answers from the mode the config names
(`src/modes.ts#loadMode`, `#describeMode`, `src/server.ts#projectTools`). All
three are written through: each mode's loop in its own `SKILL.md` and each
role's prompt under `roles/`, the dev-team text carried over from the devpack by
`tools/from-openmaus.mjs` and edited for this runtime (section 8).
`modes/dev-team-engine/SKILL.md` is the engine lead's own loop, the dev-team's
ten steps in the same order with every root step through `git_root` and
`run_command`, every question through `ask`, and its ownership rules in step 1,
and `roles/lead.md` is the lead's identity, its limits, its wait budget per engine
and its closing report (`tests/skills.test.ts#engineLoopSteps`,
`#engineLoopOwnership`, `#leadRolePrompt`).

A mode is `modes/<name>/{mode.json, SKILL.md, roles/*.md}`, hand-validated in
the style of `src/config.ts` (no schema library, no dependency). `mode.json`
carries `id`, `release`, `name`, `summary`, `lead: {placement:
"host"|"engine", role?}`, `roles[{key, title, promptFile, workspace,
sandboxDefault}]`, a `git` policy, and `requires{engines?}`
(`src/modes.ts#Mode`). Validation refuses unknown fields, requires role keys to
be unique, requires `id` to equal the directory name, requires every
`promptFile` to resolve inside the mode directory, and requires `lead.role`
exactly when `placement` is `engine` — a host-placed mode has no lead role to
name, and an engine-placed one cannot resolve the lead row without it
(`src/modes.ts#loadMode`). Four rules are the containment argument rather than
hygiene, and each refuses by field and reason: a `promptFile` is checked by
**realpath**, so a symlink inside the mode pointing out of it is the same escape
as a `..`; a mode name is one directory under the shelf, never a path; the `git`
policy exists exactly when a role works in a worktree and must name that role's
own `dir` and `branchPattern`, because those two are what `git_mutate` defaults
`path` and `branch` from (section 4); and a worktree `dir` is relative and
inside the project, where section 4's guarantees are written.
`branchPattern` carries exactly one `*`, which the task slug fills, and a
worktree `dir` is none of `.`, `.cross-agent` or `.git`: the project root and the
two directories the root keeps for itself. `SKILL.md` is held to the prompt
files' rule and read **at load** rather than at the launcher's first call — it
must exist, be a file, and resolve inside the mode, and the path the loader
resolved is what `describeMode` reads (`src/modes.ts#loadMode`, `#Mode`). An
engine-placed `lead.role` must name a role that works at the project root,
because being read-only there is what makes `git_root` and `run_command` its way
of reaching git at all ("The lead model"). The mode directory itself is resolved
against the shelf, so a directory entry that is a symlink to a mode elsewhere is
not a mode of that shelf. `requires.engines` is validated as a list of engine
names and enforced by nothing: a preflight is deferred with a reason ("Not
built"), and the sandbox-or-refuse rule already fails closed at spawn time.

The **bind-time layer** stays out of the mode and lives in
`.cross-agent/config.json`: which engine, model and effort each role runs
on, and where each engine's binary is. A mode is therefore portable text;
binding it to this machine's engines is a separate, local act. That split,
the length caps on every text field, and stripping unknown fields on load
are borrowed as *design* from OpenMausBot's
`~/.cache/agent-team/openmausbot-src/server/bot-package.ts` (v0.1.56), whose
package parser is documented as "Unknown fields are stripped; ids, grants,
credentials, paths, model selections, and runtime state therefore cannot
ride through the package boundary." Its schema itself is **not** adopted:
`openmaus.package` v1 describes agents, playbooks, rooms, and routines, and
only the first has an analogue here.

Three modes ship built in (`modes/dev-team/mode.json`, `modes/solo/mode.json`,
`modes/dev-team-engine/mode.json`):

- **`dev-team`**: the devpack's four roles (planner, plan reviewer,
  implementer, code reviewer), `placement: host`, the worktree workspace
  provider, the git policy of section 4.
- **`solo`**: the built-in consultant alone, no worktree role, `placement:
  host`. It is the proof that the seam is real, the zero-ceremony one-shot
  delegation the vendor bridges offer, and the mode a project with no config
  runs as.
- **`dev-team-engine`**: those four roles plus a `lead` at `{kind: "root"}`
  read-only, under `placement: engine`. It is the same team with the loop moved
  into a spawned Claude or Codex session, so it needs the four things "The lead
  model" lists and the cap of 2 that `init` writes for it — and `delegate`
  refuses to launch its lead in a project whose cap would hold the lead's server
  to the specialist row (`src/delegate.ts#engineLead`). E3 and E2 ran it end to
  end under a Claude and a Codex lead (`docs/probes.md#e3`, `#e2`).

**Every mode carries the `consult` role.** `loadMode` gives any mode that does
not declare one `{key: "consult", title: "Consultant", workspace: {kind:
"root"}, sandboxDefault: "read-only"}` with this build's own prompt text,
listed after the mode's own roles (`src/modes.ts#loadMode`, `#CONSULT_ROLE`).
A mode may declare it to give it its own title and its own prompt file, and
nothing else: a declared `consult` that works anywhere but the project root, or
under anything but `read-only`, is refused at load by field, because a launcher
delegating this role against a mode it has never read is relying on exactly
those two (`src/modes.ts#loadMode`). A role this build supplies carries its
text rather than a file of the mode's, and `rolePrompt` is the one reader of
either (`src/modes.ts#rolePrompt`, `#ModeRole`). It is the role a one-off
delegation uses: at the project root it reads and answers, and with `worktree:
true` it takes a writable worktree of its own (section 1). `modes/solo/` is the
mode that declares it and declares nothing else, so the file documents itself,
and `modes/solo/roles/consult.md` holds the built-in text verbatim — a test
keeps the two copies saying the same thing (`tests/skills.test.ts`).

**A project with no config runs `solo`, bound to nothing.** Where no directory
at or above the working directory holds `.cross-agent/config.json`, the project
is that directory's git toplevel and its config is what `defaultConfig`
answers: mode `solo`, this document's project and limit defaults, and **no role
binding at all** (`src/project.ts#discoverProject`, `src/config.ts#loadConfig`,
`#defaultConfig`). A `delegate` there names its own `engine` — a role with no
binding is still a role of the mode, and the refusal without one names both
ways out, the argument and `cross-agent init --mode solo`
(`src/delegate.ts#delegate`). Nothing is written to reach that state: the first
`delegate` creates `.cross-agent/` for the ledger through `create`, the one
caller of `initialize` (`src/ledger.ts#initialize`) — a read of a task nobody
created writes nothing (`tests/tasks.test.ts#unknownTaskReads`,
`tests/wait.test.ts#unknownTaskWait`) — and `init` remains the only writer of a
config file, so a project stays unconfigured until someone configures it.

**Workspace is policy, with two kinds.** A role declares `workspace:
{kind:"root"}` or `workspace: {kind:"worktree", branchPattern, dir}`
(`src/modes.ts#Workspace`). The worktree provider's four tools register under
**every** mode (`src/server.ts#worktreeTools`, `#projectTools`): every mode
carries the `consult` role, every root role can be given a worktree of its own
by `delegate {worktree: true}` (section 1), and the branch that leaves behind
has to be testable, mergeable and removable through the journal like any other.
What a mode decides is the policy they act under, and `describe_mode`'s
`git.implicit` is what tells a launcher whether that policy is the mode's own or
this build's — which is the same question as "does this mode declare a role that
works in a worktree" (`src/modes.ts#declaresWorktreeProvider`, `#gitPolicy`).
Arbitrary-path workspace providers are deferred (see "Not built").

**No role may combine `{kind: "root"}` with a writable sandbox**, and mode
validation refuses one that does. A writable root role could edit
`.cross-agent/` itself — the ledger, the mailbox, the journal, the config —
and every containment argument in this document assumes those are the
server's to write. A role that must write does so in a worktree. The rule is
enforced three times, because three different things could break it: a mode's
own `sandboxDefault` for a root role must be `read-only`, the one profile name
every engine accepts, since a mode is bound to engines elsewhere and cannot know
which (`src/modes.ts#loadMode`); a config `sandbox` override is refused when the
profile is not read-only **under the engine that role is bound to**, which is
what makes Grok's `strict` a legal override and `off` an illegal one
(`src/config.ts#loadConfigWithMode`); and `delegate` re-runs every rule that
needs both files at the one place an engine is actually started, so a config
edited after the server read it cannot launch that engine
(`src/config.ts#bindingFault`, `src/delegate.ts#delegate`).

**A role's `workspace` and `sandboxDefault` belong to the mode, not to the
config.** Config binds `engine`, `model` and `effort` per role — `bin` is per
engine, under `engines.<e>.bin`, never per role — and may override `sandbox`
alone; a `workspace` key in `.cross-agent/config.json` is refused, by that name
and by the older spelling `cwd` an existing config carries
(`src/config.ts#loadConfig`), and every role key in config must name a role the
mode declares (`src/config.ts#loadConfigWithMode`).
Otherwise a local binding could move a read-only reviewer into a writable
worktree, and the mode's own containment argument (section 4) would no longer
be about the mode.

**`describe_mode` returns** `{mode: {id, release, name, summary, lead}, loop:
string, roles: [{key, title, workspace, sandboxDefault, prompt}], git}`, where
`loop` is `SKILL.md` verbatim, each `prompt` is that role's prompt file or the
text a built-in role carries, and `git` is always there: the mode's own policy,
or the implicit `{worktreeDir: ".worktrees", branchPattern: "task/*", implicit:
true}` that a mode with no worktree role creates a `worktree: true` one-shot
under, so a launcher can always name where a task's worktree will be
(`src/modes.ts#describeMode`, `#gitPolicy`, `#ModeDescription`). It refuses,
with a reason and never a throw, when the config's `mode` names no existing mode
directory, when that directory holds no `SKILL.md`, or when the mode does not
validate — the
launcher's first call is this one, so a missing mode has to fail loudly at step
one rather than half-way through a task, and the refusal is the tool's own
answer, marked as an error (`src/server.ts#projectTools`). It reads the mode the
config names **at the call**, from the shelf the server loaded its own mode
from, so a config edited mid-session is answered rather than cached.

`cross-agent init --mode <name>` writes the bind-time config for a mode
(`src/cli.ts#runCli`, `src/config.ts#initConfig`). It loads the mode first, so
an unknown or invalid one is refused before anything is written; it binds every
role the mode has, the built-in consultant included, in the order they are
listed, from a table of built-in bindings — a mode this build ships no bindings
for is refused by name rather than bound by guess, because binding is a local
act; and it writes the
`maxDepth` that mode needs, since the effective cap is the lower of the mode's
and the config's and the documented default of 1 would hold an engine-placed
lead's specialists at the lead (`src/config.ts#effectiveMaxDepth`).

### 1. The `cross-agent` MCP server

`src/server.ts`: stdio, JSON-RPC 2.0 written by hand (the subset is
`initialize`, `tools/list`, `tools/call`, `ping`, `notifications/cancelled`;
no dependencies, so the setup command is `none` and Node 24 runs the `.ts`
sources directly). Requests are dispatched concurrently: a pending `wait`
never blocks `check`, `cancel`, or `list_tasks` on the same connection.
`notifications/cancelled` aborts the pending `wait` it names: the dispatcher
holds an `AbortController` per call in flight, keyed by the request id its
client addressed it with, and the notification aborts exactly that one — an id
nothing is running under is ignored (`src/server.ts#createServer`). The
controller is registered **before** the row is resolved, because resolving it
awaits and one stdin chunk reaches the dispatcher line by line: a cancellation
travelling with its own call would otherwise arrive before there was anything
to abort. The
aborted call answers for itself, with the status it last read and
`cancelled: true`, and its JSON-RPC reply is still written, which a client that
has moved on may ignore (`src/wait.ts#wait`). "Registered by" says which
part of the system offers the tool: **core** always; **worktree** the worktree
provider's four, which every mode registers because every mode has a role that
can be given a worktree ("Modes"); **engine lead** only under `placement:
engine`.

| Tool | Input | Behaviour | Registered by |
|---|---|---|---|
| `describe_mode` | — | the active mode's loop text verbatim, its roles with workspace, sandbox default and prompt, and its git policy | core |
| `list_roles` | — | each role **the mode has**: the workspace and the sandbox profile it gives that role, with the engine, model and effort config binds it to, or `binding: null` where config binds none — the engine a `delegate` call must then name itself; plus a `warning` when the config now names a mode other than the one served | core |
| `delegate` | `role`, `brief`, `cwd`, optional `branch` (required for a worktree role), `worktree` (a task worktree of its own, for a role that works at the root), `engine`, `model`, `effort`, `resume` (task id), `force` | under the spawn lock: validates (authority, role, workspace, reservation, running and recent duplicates, resume binding), creates the task's worktree through `git_root` when `worktree: true`, writes the ledger record as `launching`, starts the runner, returns `task_id` | core |
| `wait` | `task_id`, `timeout_seconds` (default `limits.waitDefaultSeconds`) | returns when the task settles, the timeout passes, or this call observes the stall threshold crossed: `status`, `stalled`, elapsed, last activity line, result tail, and the `hint` naming the call to make next | core |
| `check` | `task_id`, optional `lines` | non-blocking status and the last activity lines; it reads the stall clock as `wait` does and writes the `running ↔ stalled` it finds | core |
| `result` | `task_id` | the final message in full, the engine session id | core |
| `cancel` | `task_id` | identity-checked termination of the runner's and the engine's process groups, the task's descendants first, and the open asks of its lineage cancelled, as `asksCancelled` | core |
| `list_tasks` | optional `status` | ledger listing after reconciliation, with any invalid records reported; to a lead, its own records marked `self` and the tasks it owns marked `own` | core |
| `verify_worktree` | `path`, `branch` | the checks of section 4; returns the explicit git-dir and work-tree to use, or a refusal | worktree |
| `git_mutate` | `slug`, `args[]`, optional `path`, `branch` | the lead's only path for mutating git in a worktree: verify, `flock`, explicit `--git-dir`/`--work-tree`, journal (section 4) | worktree |
| `git_root` | `args[]`, optional `slug` | one whitelisted git verb at the project root, journaled under the slug it names, under `git.lock` (section 4) | worktree |
| `run_command` | `which: "test" \| "setup"`, `where: "root" \| <worktree path>`, optional `slug`, `timeout_seconds` | the configured command, by selector rather than by string; a passing root test run after the merge journals `tests-passed` (section 4) | worktree |
| `ask` | `question`, or `id` to keep waiting on an earlier ask of the lead's lineage; `timeout_seconds` | writes `.cross-agent/asks/<id>.json` and blocks until answered, cancelled or the timeout, which answers `open` with the id to ask again by | engine lead |
| `list_asks` | optional `status` | the asks of the lead's own lineage; every ask for the operator | engine lead |
| `answer` | `ask_id`, `text` | the operator's reply; the first one wins, and it is persisted, so it survives a killed lead | engine lead |

Statuses: `launching`, `running`, `stalled` (running, no engine event for
`stallMinutes`), `orphaned` (engine alive, runner dead), `cancelling`,
`done`, `failed`, `cancelled` (`src/ledger.ts#TaskStatus`).

`projectTools` registers twelve of these under every mode
(`src/server.ts#projectTools`): `describe_mode`, `list_roles`, `check`, `result`
and `list_tasks` for every row, `delegate`, `wait` and `cancel` for the operator
and lead rows, and `verify_worktree`, `git_mutate`, `git_root` and `run_command`
for those two rows (`src/server.ts#worktreeTools`) — and under `placement:
engine` the mailbox's three more: `ask` for the lead, `list_asks` for both rows
and `answer` for the operator, fourteen tools for each of those rows and still
five for a specialist (`src/server.ts#mailboxTools`). The
four worktree tools refuse on **mode drift** as `delegate` does at the launch
boundary: which tools exist was decided when this server loaded its mode, so a
config since pointed at another one is answered with a restart rather than
served under a policy this server is not serving (`src/server.ts#driftFault`,
`src/config.ts#modeDrift`, section 6). The
server offers and refuses each by the row it resolves, and `delegate`, `wait`
and `cancel` apply the lead's own half of the matrix inside themselves — a lead
delegates no lead and no child of a cancelling parent, and waits on and cancels
only what it delegated, refused by name with the lead task that did not delegate
it (`src/delegate.ts#delegate`, `src/server.ts#projectTools`,
`src/tasks.ts#cancel`). `git_root` and `run_command` are the worktree
provider's rather than engine placement's, because the journal is the same
document under both placements and a host-placed lead writes its root steps
through them too (plan decision 4); both are built and registered there
(`src/server.ts#worktreeTools`). The three mailbox rows are engine placement's
own, built with row 11.

**`delegate {worktree: true}`** gives a role that works at the project root a
writable workspace of its own instead of the root. Under `spawn.lock`, and only
once every other check has passed, `delegate` mints the task id — from hex, the
alphabet all four of its consumers accept, because the same id names the record,
the journal file, the directory and the branch and the journal's is the
narrowest (`src/ledger.ts#newTaskId`, `src/journal.ts#journalFile`) — creates
`<worktreeDir>/<id>` on the mode's branch pattern filled with that id through
`gitRoot` — so the mode's own policy judges the path and the `worktree-created`
step is journaled under the task's slug — verifies the result with
`verifyWorktree`, and writes a record whose `cwd` is that worktree and whose
`worktree: {path, branch, slug}` says what the task owns
(`src/delegate.ts#delegate`, `src/ledger.ts#TaskWorktree`). The sandbox is the
writable counterpart of the role's read-only root profile in the engine's own
spelling — `workspace-write`, or `workspace` under Grok
(`src/delegate.ts#writableProfiles`) — and the rule it steps around is not
weakened: the root rule is about a task that runs at the root, and this one
never does. A `git_root` refusal is the delegation's refusal; the reservation is
read against the new path before anything is created, so a task holding that
directory refuses the one-shot rather than losing it; and a `resume` takes no
new worktree, because it continues in the one its original was given (section
5, layer 4). Two roles of a request are refused with it: an engine-placed
mode's own `lead`, which is read-only at the project root because that is how it
reaches git at all ("The lead model"), and a `branch`, since the flag is what
creates this task's branch and one named beside it could only be another
task's. **Every failure from the `worktree add` to the runner discards
what exists** — the worktree, its branch and its journal, through the explicit
git form inside the `spawn.lock` this call already holds rather than through
`git_root worktree remove`, which takes that same lock; the discard takes
`git.lock` and then the repository lock itself, in the standing order
(`src/delegate.ts#discardWorktree`, `tests/delegate.test.ts#discardUnderGitLocks`).
That covers the three that leave something standing: a `git_root` refusal for a
command that ran, which is what a journal step that could not be written is; a
worktree that does not verify; and a throw while the record, its scratch directory
or its spec is written. Only what exists is removed, and each command's exit code is
read: the journal goes only once both the worktree and the branch have, and
otherwise it is kept and the refusal — or the error a failed record write throws —
names what survived (`tests/delegate.test.ts#discardKeepsJournalOnFailure`). A
lock the discard held and lost while its commands ran leaves them uncertified, since
another project's verb may have run beside them: the journal is kept then too, and
the answer says so, a refusal with `lockLost: true`
(`tests/delegate.test.ts#discardLockLostKeepsJournal`).
Reconciliation does not clean up worktrees — it reports an unmerged branch with a
dead task to the operator (section 7) — so the kept journal is what finds such a
leftover. A one-shot needs a repository the project can write: at a root with no
`.git`, or an unsupported one, it is refused before anything is minted (section 4). The
policy is the mode's where it declares one and the implicit `.worktrees` /
`task/*` where it does not, which is how `solo` has one at all
(`src/modes.ts#gitPolicy`). What becomes of the branch afterwards is the
launcher's, under `project.mergePolicy` (section 7).

A role that `.cross-agent/config.json` binds to no engine — which is every role
of a project with no config, and the built-in consultant in most projects — is
delegated with `engine` in the call, and refused without one by a message
naming both ways out (`src/delegate.ts#delegate`, "Modes"). Everything else a
binding carries is optional already.

### 2. Ledger, runner, locks

Step 2 of the work plan (S2, `atc-s96.20`, commits `45ee841..e426f35`) built
almost all of this section on top of what T1 and T5 shipped, the ledger and the
detached runner: the conditional update, the OS-held locks, `src/reconcile.ts`,
the environ scan and bounded settlement. Two reviews of that step — the task
review and the Codex milestone review of 2a and 2b — ruled on the questions
the code raised; each ruling is stated below as this design's decision, with the
line that implements it. Step 3 (T6, `atc-s96.6`, commits `58b90cf..69f3eac`,
with its review's fixes in `608c89a..53e5e45` and `ffbb84d`) then built the
rest: `limits.lockWaitSeconds` and the helper that reads it, the four lock
names, the per-cwd reservation in `src/reservation.ts`, and both locks under
`src/gitmutate.ts`. That review ruled on several more questions, and those
rulings are stated here as decisions too. Step 7's first half (T10b,
`atc-s96.10`) built what was left of this section's own callers: `delegate` and
`cancel` (`src/delegate.ts`, `src/tasks.ts`), which are what take `spawn.lock`,
read the reservation, refuse on an unreadable record and write `cancelling` —
`cancel` looks the task up before the lock as well, so a task nobody has is
refused with nothing locked and nothing created (`src/tasks.ts#cancel`,
`tests/tasks.test.ts#cancelUnknownWritesNothing`);
the reconciliation triggers; and the four delegation fields of the record.
Everything below is built, the operator CLI's listing among it
(`src/cli.ts#tasksVerb`).

- `src/ledger.ts`: `<project>/.cross-agent/tasks/<id>.json`, written by
  writing a temporary file and renaming it (`src/ledger.ts#writeAtomic`);
  `<id>.ndjson` is the engine's native event stream, with lines the engine wrote
  to stderr prefixed `stderr ` (`src/engines/spawn.ts#stderrPrefixed`), not a verbatim tee;
  `<id>.out` is the final message; `<id>.runner.log` is the runner's own
  diagnostic trail (`src/runner.ts#runnerLog`, `src/ledger.ts#runnerLogPath`). Ids
  are 18 random bytes in hex (`src/ledger.ts#newTaskId`), but the alphabet every
  reader accepts is letters, digits, `-` and `_` (`#isTaskId`), the base64url an
  earlier build minted in, so an id can begin with `-`, which is why the
  runner's argument parser consumes each option's value literally
  (`src/runner.ts#taskArgument`). `.cross-agent/` and `.worktrees/` are added to
  the repository's `info/exclude` by whichever comes first, the first `create` —
  the one caller of `initialize` — or the first project lock, which can precede any
  record and is what would otherwise make `.cross-agent/locks/` unexcluded
  (`src/ledger.ts#excludeLedger`, `#projectLock`,
  `tests/gitmutate.test.ts#gitMutateUninitializedExcluded`). The file is
  `<root>/.git/info/exclude` at a main checkout; at a worktree project, whose `.git`
  is a pointer file, it is the common directory's, which every worktree of the
  repository reads, reached by synchronous reads of the pointer's `gitdir:` line and
  that administrative directory's `commondir` — no git runs and no ancestor is read
  ahead of a lock — and a pointer that leads nowhere writes nothing
  (`src/ledger.ts#excludingDirectory`, `tests/ledger.test.ts#excludeLedgerLinkedRoot`).
  The two lines are the same whichever project writes them. The file is written
  whole, through a temporary and a rename, so two first callers — two projects of
  one repository among them — leave each entry once
  (`tests/ledger.test.ts#excludeLedgerIdempotent`, `#excludeLedgerConcurrent`,
  whose eight callers start together at a barrier); the rename keeps the file's
  mode, and where `info/exclude` is a link it is the file the link names that is
  written, the link left a link (`#excludeLedgerKeepsFile`).
  Every other reader resolves a record's path and writes nothing,
  so `find` and `read` of a task nobody created leave no directory and no
  exclusion line behind (`src/ledger.ts#initialize`, `#create`,
  `tests/ledger.test.ts#unknownReadWritesNothing`, bead `atc-s96.51`).
- Launch protocol: `delegate` creates the record as `launching` with a
  `launchDeadline` of now + 30 s (`ledger.create`, `src/ledger.ts#create`); the
  runner, once started, writes `running` with its own identity and the engine's
  identity in one atomic acknowledgement (`src/runner.ts#acknowledge`), conditional
  on the record still being `launching`. Both identities carry `{pid, startTime,
  bootId}`, the engine's with its `pgid` as well
  (`src/ledger.ts#ProcessIdentity`, `#EngineIdentity`); `bootId` is read once
  from `/proc/sys/kernel/random/boot_id` (`src/ledger.ts#currentBootId`),
  because a pid and start time from another boot can collide with a live
  process, so an identity from another boot is dead rather than reused
  (`src/ledger.ts#isProcessAlive`). `startTime`, `pgid`, `sid` and `state` all
  come from `/proc/<pid>/stat` (`src/ledger.ts#readProcessStat`). Four fields of
  a record are the delegation's own (`src/ledger.ts#TaskRecord`): `depth`
  (section 5, layer 1), `parentTaskId` for cascade ownership (the lead model)
  and `resumedFrom` for the resume chain, all three written by `delegate` where
  the task begins, and `acknowledgedAt`, written by the acknowledgement above
  and by nothing else (`src/runner.ts#acknowledge`), so a stall clock measures from
  the moment the engine was answered for rather than from a launch nobody
  answered. There is **no launch token**: `create` writes none
  (`src/ledger.ts#create`), and a token on the *runner's* argv could not
  identify the engine anyway, because the engine is a separate detached spawn
  with adapter-built argv (`src/engines/spawn.ts#adapterPlan`, `#detachedSpawn`). Its two jobs are
  done instead by two mechanisms that cannot be forged, and both are built:
  - **Identifying a stranded engine.** The engine carries
    `CROSS_AGENT_TASK=<id>` in its environment, and it is the **runner** that
    puts it there, from the id of the record it was started for
    (`src/runner.ts#engineTaskId`), beside the two paths it takes from the same
    record. `guard.childEnv` sets the same assignment in the environment it
    prepares for a spec (`src/guard.ts#childEnv`), but nothing validates a spec
    (`validateSpec` checks only that `adapterModule` is absolute,
    `src/ledger.ts#validateSpec`), and everything below rests on the assignment,
    so the runner does not take it on trust from a file. Reconciliation of a
    `launching` record past its deadline scans `/proc/*/environ` for that
    assignment (`src/process.ts#findByEnvironment`), adopts the identity it
    finds as `orphaned`, and writes `failed: launch` only when no such process
    exists (`src/reconcile.ts#adopt`). Without this, a SIGKILL between the spawn
    and the acknowledgement would leave a live engine that nothing will ever
    kill.
  - **Exclusive ownership.** The runner holds `runner-<id>.lock` for its whole
    lifetime, and a second runner for the same task takes it with a zero wait,
    fails, and exits 1 without touching the record (`src/runner.ts#runnerLock`),
    so one task can never own two engines at once.
  - **No sequential duplicate either.** The lock cannot stop one runner
    following another: a runner killed between its spawn and its
    acknowledgement leaves the record `launching` and the lock free, and a
    replacement that spawned again would give the task a second engine and
    strand the first. So before spawning, the runner runs the same environ scan
    for its own task id and puts what it finds to `foreignEngine`
    (`src/process.ts#foreignEngine`), which answers with the reason to stand
    down or `null`. Two things are reasons, and they are `adopt`'s own: a
    process carrying the id that is not this runner, its own group or its own
    session, and an environment the scan could not read, because one of those
    could be that engine. An environment it could not read is scanned for
    again — four scans, 250 ms apart, 750 ms of waiting in all, inside the 30 s
    launch deadline — because a process of this user's can be unreadable for a moment
    and then gone, and standing down on the first reading turned that moment
    into a failed delegate (`src/process.ts#foreignEngineSettled`, bead
    `atc-s96.49`); a foreign engine is answered on the scan that finds it. The
    wait opens a window in which a cancel, a lost runner lock or another
    writer's terminal write can settle the task with no engine to stop yet, so
    after it the runner checks again exactly what it checked before it —
    `settling`, then the record's own status — with nothing awaited between that
    and the spawn, and before its own stand-down, so a settlement in flight
    finishes and no engine starts after one (`src/runner.ts#rescanRecheck`;
    `tests/runner.test.ts#cancelDuringRescan`, `#settledDuringRescan`,
    `#lockLostDuringRescan`, `#clearedDuringRescan`). A reason that remains — a
    foreign engine, or a candidate still unreadable at the last scan — the
    runner logs as `not launching task <id>: <reason>` and exits 1 without
    spawning (`src/runner.ts#preSpawnScan`); reconciliation then adopts what is
    already there. The runner is started with the **server's
    own** environment and never the spec's (`src/delegate.ts#startRunner`), so
    the only process carrying `CROSS_AGENT_TASK=<id>` is the engine — the
    runner puts the assignment there itself, on the engine alone
    (`src/runner.ts#engineTaskId`). Excluding `self` is not optional all the same: a
    server that runs inside an engine carries that engine's task id, and so do
    the children it starts, so a scan that counted them would have a task stand
    down for itself. The unreadable case is decided by the asymmetry: standing
    down costs one failed delegate the lead can see and retry, and a second
    engine costs concurrent work in one worktree that no record accounts for.
    Its residual is the same one reconciliation has, and bounded differently:
    a same-uid non-dumpable leader keeps this runner from launching for as long
    as it lives, and what ends that is the record's own hold expiring in
    another pass, not this check. Because a task has at most one engine, the reconciler adopts
    the **lowest-pid** leader of the processes it finds — the scan returns
    them in pid order (`src/process.ts#findByEnvironment`) — and treats every
    other process carrying the id, extra leaders included, as a stray
    (`src/reconcile.ts#adopt`).
- Launch spec: `delegate` writes `<id>.spec.json` next to the record before
  starting the runner (`ledger.writeSpec`, `src/ledger.ts#writeSpec`): role,
  brief, role prompt, cwd, engine, model, effort, sandbox, deny targets, session
  id, resume session id, the adapter module path, and the prepared child
  environment. The runner rebuilds the spawn from that file and the record, so
  it never needs the server; three fields of the request come from the record
  rather than the spec — `logPath`, `resultPath`, and `CROSS_AGENT_TASK` in
  the engine's environment (`src/runner.ts#engineTaskId`) — because the record, not
  the spec, names what this runner spawns. The adapter module path is always an
  entry of the fixed built-in table of section 3; config cannot name one.
- `src/runner.ts`: a detached process per task (`node src/runner.ts --project
  <root> --task <id>`) that owns the engine child in its own process group,
  tees events, updates `lastEventAt` on a 2-second interval
  (`src/runner.ts#activityInterval`), and on engine exit writes the terminal record and
  `<id>.out` itself, so completion survives the MCP server. On SIGTERM
  (`src/runner.ts#sigterm`) it writes `cancelling` itself (`src/runner.ts#cancellingClaim`),
  terminates the engine group, and writes `cancelled`
  (`src/runner.ts#settle`). Group cleanup always precedes terminal
  settlement (`src/runner.ts#stopBeforeSettle`). The `cancelling` write is a claim the
  teardown may skip: a record already `cancelling` is the server's own write of
  this same cancel, and one that is `orphaned` may not pass through `cancelling`
  at all, because the ledger allows `orphaned → failed | cancelled` and
  nothing else — so from either the runner settles `cancelled` from where the
  record is (`src/runner.ts#cancellingClaim`, `#settleCancelled`, bead `atc-s96.39`). The
  settlement also reads the record for itself when it has none
  (`src/runner.ts#settleReadsRecord`), so a cancel or a lost lock arriving before the first
  read settles rather than exiting through `fatal` (bead `atc-s96.29`); both are
  recorded (`tests/runner.test.ts#runnerStartsAgainst`, `#cancelLandsAcknowledgement`). Three rulings from the
  reviews attach to this same teardown path:
  - **A lost lock is a lost task.** `acquire` watches its helper child and
    sets `lock.lost`, calling an optional `onLost`, if the child exits before
    `release` (`src/locks.ts#Lock`, `#AcquireOptions`, `#acquire`) — the
    kernel has already let the next waiter in, so a holder that carried on would
    be acting on exclusivity it no longer has. The runner registers `onLost` for
    `runner-<id>.lock` (`src/runner.ts#runnerLock`): it stops the engine group and
    settles `failed` with the reason `runner lock lost`. `update`'s own short
    lock ignores `lost`; it is released in the same call that took it.
  - **A group with no identity is still terminated.** If the leader exits
    after spawning a descendant and before `identityOf` succeeds, the runner
    has no `engineIdentity` to name the group with (`src/runner.ts#acknowledge`).
    But the detached spawn made `handle.pid` both the group and the session id,
    and the kernel keeps that id reserved while any member lives, so the runner
    terminates the group by scanning `/proc` for members holding that id
    (`src/process.ts#terminateGroupByPid`) before settling `failed`
    (`src/runner.ts#stopEngine`). Killing the direct child alone would settle the
    task with its descendants still running.
  - **`truncated` on every settlement.** The evidence patch the runner writes
    carries `truncated: outcome.truncated` whether the task ends `done`,
    `failed` or `cancelled` (`src/runner.ts#evidence`), because a completed task can
    be missing the tail of its log too; the `; output truncated` suffix on a
    failure's `reason` stays (`src/runner.ts#truncatedReason`).
- **The three cancel writers, all built.** `cancel` claims the record
  `cancelling` and sends SIGTERM to the runner it verified, then waits
  `limits.cancelGraceSeconds` **plus a second** for the runner to settle the
  task itself — a second longer than the runner's own SIGTERM grace, because a
  runner escalating on an engine that ignores SIGTERM is working, and killing it
  there would throw away the evidence it is about to write
  (`src/tasks.ts#terminate`, `src/config.ts#limitDefaults`, `src/runner.ts#stopBeforeSettle`).
  A runner it can see is dead is not waited for. Past the grace it re-reads the
  record — the runner that acknowledged meanwhile is a different process from
  the one it claimed against — SIGKILLs that runner and ends the engine group by
  the identity the record carries, escalating to SIGKILL there too. **A record
  that names no engine is not settled on that account**: a task cancelled inside
  its launch window has no identity to terminate and may still have an engine, so
  the same environ scan reconciliation adopts by runs here, what it finds is
  terminated and written with the settlement, and only a scan that finds nothing
  settles the record without one (`src/process.ts#strandedEngine`, design
  section 2, B5-i). An environment it could not read, or an engine that is this
  server's own, is named in the outcome and left for another pass. The second
  writer is the runner itself, which answers that SIGTERM
  (`src/runner.ts#cancellingClaim`) and, before it has spawned anything, stands down on
  a record that is already `cancelling` and settles it without an engine
  (`src/runner.ts#standDown`). The third is reconciliation, whose `cancelling`
  case runs the same scan (`src/reconcile.ts#judge`). So the terminal writers are
  the runner (`done`, `failed`, `cancelled`) and, only when the runner is dead
  and the engine group is verified dead, the reconciler (`cancelled` or
  `failed`).
- **Conditional update.** `ledger.update` is asynchronous: it takes
  `record-<id>.lock` around one read, one check, and one rename, and returns
  `{applied: true, record}` or `{applied: false, record, reason: "terminal" |
  "expect"}` (`src/ledger.ts#UpdateResult`, `#update`). `create`, `read`, and
  `list` stay synchronous. `options.expect?: (record) => boolean` is evaluated
  **inside** the lock (`src/ledger.ts#update`); there is no `TerminalTaskError`,
  because a caller that must distinguish "I wrote it" from "someone else owns
  it" needs a value, not an exception — any non-throwing return would
  otherwise make the runner's `write()` true (`src/runner.ts#write`) and let it
  carry on as if acknowledged. The lock is required, not optional: a predicate
  without cross-process exclusion still interleaves, and a stale reconciliation
  could otherwise overwrite a runner's fresh `running` write and make the runner
  kill its own healthy engine. The rest of the contract: the `record` returned
  with `applied: false` is the record as read **inside** the lock, so a caller
  can act on the state that beat it; the terminal check precedes `expect`, so a
  terminal record is always `reason: "terminal"` (`src/ledger.ts#update`); a
  lock timeout **throws** rather than returning `applied: false`
  (`src/locks.ts#acquire`), because a caller that could not even look at the
  record must not treat that as a refusal it can reason about; and the lock is
  released in `finally`. The legal transitions are `launching → running |
  cancelling | failed | orphaned`, `running ↔ stalled`, `running | stalled →
  cancelling | orphaned | done | failed`, `orphaned → done | failed |
  cancelled` (the `done` edge is reconciliation settling from the runner's
  recorded outcome, above), and
  `cancelling → cancelled | failed` (`src/ledger.ts#transitions`); any other
  transition throws, because it is a bug in a writer, not a race to be
  tolerated. `launching → orphaned` (`src/ledger.ts#transitions`) is the
  adoption edge, and it exists so that adoption never passes through `running`:
  a record that is `running` with an `engineIdentity` satisfies every clause of
  the authority match (the lead model), so an adoption that wrote `running`
  first and `orphaned` second would hand the stranded engine a lead's authority
  for as long as the second write was delayed or refused.
- **Acknowledgement and cancellation.** The runner acknowledges with `expect:
  status === "launching"` (`src/runner.ts#acknowledge`). On `applied: false` with
  `record.status === "cancelling"` it **treats the refusal as a cancel**
  (`src/runner.ts#acknowledgementRefused`): stop the engine group, then write `cancelled` with
  both identities, again conditionally. Mapping it to "someone else settled
  this" would kill the engine and skip settlement, leaving the record
  `cancelling` forever. The acceptance is eventual `cancelled` with identities
  preserved and no live group — not merely "never returns to `running`".
- **Reconciliation**, pass and triggers both built. The pass lives in
  `src/reconcile.ts`, because it needs both `ledger.ts` and `process.ts` and
  `src/process.ts` already imports `ledger.ts`; that leaves `ledger.ts` as
  record I/O. It is asynchronous and returns `{changed, invalid, errors}`
  (`src/reconcile.ts#Reconciled`). It runs **on server start, before the first
  request is served, and on every `list_tasks`** (`src/server.ts#main`,
  `src/tasks.ts#listTasks`), so no caller reads a `running` task whose runner
  died while no server was watching; what a pass could not decide is written to
  stderr at start and returned in `errors` and `skipped` to the listing. The
  operator CLI's `tasks` lists without a pass unless `--reconcile` asks for one,
  because an operator's read is side-effect free (`src/tasks.ts#listTasks`,
  `src/cli.ts#tasksVerb`). It
  judges an engine by the **group scan** (`src/process.ts#hasMember`,
  `#inspectGroup`), never by the leader's pid alone: a leader that has been
  reaped while a descendant lives becomes `orphaned` and is cleaned up, not
  `failed: runner lost`. It judges the runner, which is one process, by pid and
  start time, and a runner in state `Z` or `X` has exited and owns nothing
  (`src/ledger.ts#isProcessAlive`), which is the same test the group scan
  applies to a member (`src/process.ts#live`). Its six cases
  (`src/reconcile.ts#judge`, `src/process.ts#terminateOrphans`):
  - `launching` past its deadline: the environ scan above, then `orphaned` or
    `failed: launch`;
  - `running` or `stalled` with a dead runner: `orphaned` if the engine group
    is alive, otherwise the settlement below, read the same way — one piece of
    evidence cannot mean two things to two passes (`src/reconcile.ts#judge`,
    `src/process.ts#settlement`, finding T3b-3);
  - `cancelling` with a dead runner: terminate the group by the identity the
    record carries, then `cancelled`; a record that never acknowledged carries
    none, so the same environ scan runs first and what it finds is terminated
    and written with the settlement (`src/reconcile.ts#judge`,
    `src/process.ts#strandedEngine`);
  - an `orphaned` record whose group is dead, in the cleanup half of the same
    pass: `failed: runner lost` — unless the runner recorded how the engine
    ended first. **The evidence is the runner's, never the result file.** A
    runner writes `<id>.outcome.json` — `{kind: "done" | "failed", exitCode,
    sessionId, reason?, truncated?, at}`, atomically — immediately before it
    attempts its terminal ledger write, whatever becomes of that write
    (`src/ledger.ts#TaskOutcome`, `#writeOutcome`, `src/runner.ts`), because a
    record adopted while it was finishing is no longer its to settle: the
    adoption race leaves it settling `external` and writing nothing to the
    ledger. The result file cannot stand in for that: the pipeline writes an
    engine's final message there whether the run succeeded or **failed**
    (`src/engines/spawn.ts`), so text in it proves that something ended and
    nothing more — reading it as success settled a failed engine `done`
    (finding T3b-1). So the recorded outcome decides: `done` settles `done`
    with the exit code and session id it carries, `failed` settles `failed`
    with its reason, and an outcome older than the record itself is refused
    (`src/ledger.ts#readOutcome`). With none, the record settles `failed:
    runner lost`, and a result file with text in it is **named** —
    `runner lost; result text present at <resultPath>` — so an operator can
    find what is there without the ledger calling it a success
    (`src/process.ts#settlement`, `#terminateOrphans`, bead `atc-s96.30`).
    `orphaned → done` is a legal transition for this one writer
    (`src/ledger.ts#transitions`);
  - an `orphaned` record whose group this pass had to **kill**: `failed:
    runner lost; engine group terminated`, and no outcome is read at all
    (`src/process.ts#terminateOrphans`). The engine was still running when the
    pass met it, so it did not end on its own, and settling it from a record
    written earlier would report a task this pass has just ended as one that
    finished — a Codex task would settle from the empty `-o` file the pipeline
    pre-creates, and a Claude or Grok task in the same state from nothing at
    all (finding T3b-2);
  - anything else: untouched. In particular `running ↔ stalled` is not the
    reconciler's: it never revives a task. Both directions are written by the
    two tools that read the stall clock, `wait` and `check`, each through
    `observeStall` and each conditional on the record still saying inside the
    lock what it said outside it (`src/wait.ts#observeStall`, `#wait`,
    `src/tasks.ts#check`). A stall nobody wrote would be a reading every later
    reader had to take again, and a revival nobody wrote would leave a working
    engine reported as stalled for the rest of its run.

  **The conditional write is the decision point, and nothing is signalled
  before it.** The environ scan is read-only; then one `update` writes either
  `{status: "orphaned", engineIdentity}` or `failed: launch`, with an `expect`
  that re-reads all three preconditions — still `launching`, still no
  `runnerIdentity`, still past the deadline — inside the record lock; only
  once that write has applied are the strays killed (`src/reconcile.ts#adopt`).
  If the write is refused, the pass touches nothing and reports the refusal. A
  runner that acknowledged between the scan and the write owns the task, and
  killing what the scan found would then be killing that runner's own engine.

  **A failure is per record, never per pass.** `Reconciled.errors` is `[{id,
  reason}]`, each record's judgement runs inside its own boundary, and a record
  that could not be judged keeps its status for the next pass
  (`src/reconcile.ts#reconcile`): a group that survives SIGKILL, an EPERM from
  `process.kill`, a decision another writer overtook. A record whose write applied
  but whose cleanup did not — a stray that could not be signalled, an engine of the
  reconciler's own session left running — is in `changed`, with the trouble named
  in `errors` (`src/reconcile.ts#adopt`, `#settleCancelled`). A surviving group and
  an EPERM are answers, not exceptions, because **the escalation is one helper**: SIGTERM, a grace,
  SIGKILL, a shorter grace, written once as `terminate`
  (`src/process.ts#terminate`) and reached through `terminateGroup`
  (`#terminateGroup`). It never throws, and it **names** what it could not end:
  `dead`, `eperm`, or `survived` (`src/process.ts#TerminationOutcome`), because
  a permission this process does not have and a process that took SIGKILL and
  stayed are different repairs and the operator reads only the reason. Every
  caller carries that word into its own: `terminateOrphans` skips the record
  with its identity and the outcome named, `src/reconcile.ts#judge` leaves a
  `cancelling` record named for the next pass, and `src/tasks.ts#terminate`
  refuses the cancel with it. A caller judging many records has to be able to
  report a survivor and carry on. Its wait is `waitFor`
  (`src/process.ts#waitFor`), and `killStrays` waits with the same one. The
  runner runs the same ladder from the same
  place in both its branches — `terminateGroup` when it captured an identity
  and `terminateGroupByPid` when it did not (`src/runner.ts#stopEngine`) — and
  differs only in throwing where the reconciler reports, because a terminal
  record written over an engine still running would be a lie about the task.
  One thing changed when its identity branch joined the ladder: at a zero
  grace that branch used to send SIGKILL alone, and the ladder always opens
  with SIGTERM and escalates with no wait between them
  (`tests/process.test.ts#sharedLadderZero`). An engine that answers SIGTERM now sees it
  first even on a teardown with no grace, which is the signal a settling
  runner would rather it saw, and one that ignores it is killed just as
  quickly (finding T3b-5).
  Killing the strays is the one step that
  runs **after** the decision has been written, so it reports the pids it could
  not signal instead of throwing (`src/process.ts#killStrays`, `src/reconcile.ts#adopt`):
  losing the write to report a failed signal would drop a settled record from
  `changed`. Orphan cleanup runs in the **same pass** (`reconcileAndCleanup`,
  `src/reconcile.ts#reconcileAndCleanup`), so no caller can observe an
  `orphaned` record whose group is still being decided; `terminateOrphans`
  returns `{changed, skipped}` (`src/process.ts#terminateOrphans`) so that an
  identity the group scan calls invalid or reused is named rather than silently
  skipped, and `reconcileAndCleanup` surfaces `skipped` beside `errors`.

  **A pass sees every engine and signals none of its own.** The MCP server is a
  child of the engine and inherits `CROSS_AGENT_TASK` (`src/guard.ts#childEnv`),
  and reconciliation runs inside that server, so a pass judging its own task
  meets its own process, its own children, and the engine whose session it lives
  in. The scan reports all of them, each marked `self`
  (`src/process.ts#FoundProcess`, `#findByEnvironment`): exclusion belongs to
  signalling, never to seeing, because one of those processes may be the very
  engine the record is waiting for. Adoption then takes no `self` process as its
  leader and puts none in the stray set (`src/reconcile.ts#adopt`). When the
  **only** engine carrying the id is the one this server runs inside, the pass
  adopts nothing, settles nothing, and reports `engine <pid> shares this
  reconciler's session; adoption deferred to another server`
  (`src/reconcile.ts#adopt`) — adopting it would have cleanup kill the group
  this process lives in, calling it a stray would do so directly, and `failed:
  launch` would leave a terminal record with no identity beside a live engine
  nothing could reach. When another engine **is** adopted beside it, the record
  names that one and the one in this session is named in `errors` as left
  running (`src/reconcile.ts#adopt`), because nothing else would ever mention a
  live process still carrying a task id the record now answers for.

  **An in-session server may die with its engine, and judges its own record
  last.** Nothing above stops the pass from terminating a group this process
  lives in: an `orphaned` record's engine is an orphan and cleanup ends it
  (`src/process.ts#terminateOrphans`), and a `cancelling` record's engine is
  being cancelled (`src/reconcile.ts#judge`). Both are right, and both kill this
  server with the group. What that must not cost is the rest of the pass, so the
  records naming this process's own engine group are judged **last** — last in
  the pass, not last in each of its loops: `reconcileAndCleanup` holds them
  back through reconciliation's own loop and through cleanup, and judges them
  only when both have run (`src/process.ts#ownGroup`, `#selfLast`,
  `src/reconcile.ts#reconcileAndCleanup`, finding T3b-6). Every record this
  server can settle is settled before it dies, and its own record keeps its
  status for whatever server runs the next pass. That is the honest
  answer for a process that is about to stop existing, and the only one it can
  write. Adoption also takes only a **group leader** (`pid ===
  pgid === sid`), because only a leader can be recorded as an `engineIdentity`,
  and the scan reads `/proc/<pid>/stat` **before and after** the environment,
  keeping the match only when both reads agree on `startTime`
  (`src/process.ts#findByEnvironment`): a pid reused between the two reads is a
  different process, and its start time would bind the record to it. A forged
  `CROSS_AGENT_TASK` on a foreign process can therefore get that process killed
  — the operator's own foot — but it can never grant authority, since
  authority also requires a matching `engineIdentity` the server itself wrote
  (the lead model). A worktree reservation is never released while an engine
  identity is alive.

  **An unreadable environment never yields `failed: launch`.**
  `/proc/<pid>/environ` is readable only by the process's owner, and not even
  then if the process is non-dumpable, so the scan counts how many it could not
  read; while that count is non-zero and no leader was found, the record stays
  `launching` and the pass reports `environ unreadable for <n> processes` in
  `errors` for the next pass to retry (`src/reconcile.ts#adopt`). One of those
  processes could have been the engine, and calling the launch failed would
  leave it running with no record accounting for it. Only a **plausible
  candidate** is counted: a live process of this user that leads its own group
  and session and started no earlier than the record
  (`src/process.ts#findByEnvironment`), which is the only shape a detached
  engine spawn can have. That bound is read a second wide: a start time is
  ticks since a boot whose wall clock `/proc/stat` gives in whole seconds, so
  the engine a record spawned within its own second — the normal case — can
  compute as older than the record, and the margin is what keeps it countable
  (`src/process.ts#btimeMarginMs`, bead `atc-1p0`). **The hold is bounded.** A
  same-uid non-dumpable leader started during the task can never be read at
  all, and waiting for it for ever is not waiting but hanging, so five minutes
  past the launch deadline the pass writes `failed: launch` with the count it
  could not read on the record — `launch; environ unreadable for <n>
  processes` (`src/reconcile.ts#unreadableHoldMs`, `#adopt`,
  `tests/reconcile.test.ts#recordHeldOpen`). Nothing is signalled by that decision: the
  process it could not read is left exactly where it was, and only the strays
  it could read are killed. **A process still inside `execve` is waited for, not
  counted.** Between the kernel's `begin_new_exec` and `setup_new_exec` a
  starting process has neither its argv nor its dumpable flag, so
  `/proc/<pid>/cmdline` is empty and `/proc/<pid>/environ` answers EACCES —
  every detached spawn on the machine wears the plausible candidate's shape for
  those few milliseconds. So a candidate whose argv is not published yet is
  re-read in 5-millisecond steps for up to 250 (`src/process.ts#execWaitMs`,
  `#readEnvironment`) — a window measured at under 40 ms on an idle machine
  and over 55 ms on a loaded one — and counted only if it still cannot be read
  then; a pid
  that leaves or dies while that waits is no engine to stand down for and is
  not counted, and a process killed inside `execve` is exactly that — it keeps
  the empty argv and the unreadable environment for as long as its zombie entry
  lasts. Without it, a machine that starts processes at any rate holds
  launches off for engines that are nothing yet (bead `atc-s96.46`): the runner
  stands down, `cancel` refuses, and reconciliation defers. The residual is
  stated rather than hidden: a same-uid non-dumpable leader started during the
  task holds the record `launching` for the whole of that five-minute hold, and
  the launch then fails on a count nobody could ever read.
- **Malformed records.** `list` returns only valid records
  (`src/ledger.ts#list`); `scan(projectRoot)` returns `{records, invalid:
  [{file, reason}]}` (`src/ledger.ts#scan`, `#InvalidRecord`); reconciliation
  reports `invalid`. A read error is reported in `invalid` rather than thrown
  — only a file that vanished between the listing and its read is skipped,
  because that file is gone, not invalid (`src/ledger.ts#scan`) — so one
  damaged or unreadable `<id>.json` can never hide the rest. Validation also
  binds a record to its own file: `id` must equal the file's base name
  (`src/ledger.ts#recordFault`), because every writer addresses a record by id
  and reaches `<id>.json`, so `foo.json` carrying `"id":"bar"` would be read at
  one path and written at another. The consequence (E2): an invalid file
  **refuses every writer** until the operator repairs or removes it, because its
  `cwd` cannot be read and so no reservation check can clear any workspace while
  it exists. Refusing every writable operation is the conservative reading of
  "it never frees a workspace"; a read-only delegation is unaffected. `scan`'s
  `invalid` is carried through `reservations().unknown` verbatim
  (`src/reservation.ts#Reservations`, `#reservations`) and `git_mutate` refuses
  on it, naming each file and the reason it could not be read
  (`src/gitmutate.ts#mutate`); `delegate` refuses every **writable** delegation
  on the same reading, naming each file and what it could not be read as
  (`src/delegate.ts#delegate`), and `list_tasks` returns `invalid` beside the
  records so an operator is told which file to repair
  (`src/tasks.ts#listTasks`); `cross-agent tasks` names each such file with its
  reason too, read without a pass (`src/cli.ts#tasksVerb`,
  `tests/cli.test.ts#cliTasks`).
- **Locks** are OS-held and never reclaimed (`src/locks.ts#acquire`). A lock is
  `flock(2)` on a file under `.cross-agent/locks/`, taken by a helper that keeps
  a util-linux `flock` child alive on a pipe (`flock <file> sh -c 'echo held;
  read _'`, `src/locks.ts#acquire`): the helper knows it holds the lock when the
  child prints, releases it by closing the pipe, and the kernel releases it when
  the holder dies, so a dead holder needs no TTL, no stale detection, and no
  rename. (An earlier recipe, an `O_EXCL` file with a TTL and a rename-based
  reclaim, was refuted in T5's plan review: a reclaim by pathname can rename the
  winner's fresh lock, so two reclaimers could both succeed.) Five locks, all
  five named in one place and resolved through `lockPath`
  (`src/locks.ts#lockPath`), and taken through `src/ledger.ts#projectLock`, which
  writes the ledger's exclusions before a lock can make `.cross-agent/locks/`:
  `spawn.lock` around `delegate`'s validate-and-spawn
  and around the whole of a `git_mutate` call (`src/locks.ts#spawnLockName`,
  `src/gitmutate.ts#gitMutate`); `record-<id>.lock` around every ledger
  read-check-rename, taken inside `update` (`src/locks.ts#recordLockName`);
  `runner-<id>.lock` held by a runner for its lifetime
  (`src/locks.ts#runnerLockName`); `ask-<id>.lock` around each write to one ask,
  an answer or a cancel ("The lead model", item 3; `src/locks.ts#askLockName`);
  and `git.lock` around every lead git
  mutation, taken by `git_mutate` inside its `spawn.lock`
  (`src/locks.ts#gitLockName`, `src/gitmutate.ts#mutate`). All five are taken by
  built code today: `delegate` and `cancel` hold `spawn.lock` — the one around
  validate-and-spawn, the other around the parent's claim and the snapshot of
  its descendants (`src/delegate.ts#delegate`, `src/tasks.ts#cancel`). A sixth lock
  is no project's: the **repository lock**, `<commonDir>/cross-agent.lock` in the git
  directory every worktree of a repository shares, so the projects of one repository —
  its main checkout and the worktrees initialized as projects of their own — order
  their git writes against each other (`src/locks.ts#repositoryLockPath`). It is taken
  with `acquire` directly and innermost: the order is `spawn.lock` → `git.lock` →
  the repository lock, and no project lock is taken while it is held. Every
  `git_mutate`, `git_root`'s journaled verbs and `rebase --abort`, and `delegate`'s
  discard of a one-shot that never launched hold it; a read holds none
  (`src/gitmutate.ts#mutate`, `src/gitroot.ts#gitRoot`, `src/delegate.ts#discardWorktree`,
  `tests/gitmutate.test.ts#repositoryLockOrder`, `#repositoryLockContention`,
  `#repositoryLockReleasedOnError`, `tests/gitroot.test.ts#rebaseAbortTakesRepositoryLock`).
  Its loss is reported as a project lock's is, as `lockLost: true`
  (`tests/gitmutate.test.ts#lockLostWhile`). **One helper, one waiting rule**: every
  waiter blocks up to `lockWaitSeconds` and then refuses, naming the operation. The key is in config and validated — a
  finite number, defaulting to 5 and refused when negative, because `flock -w
  -1` sets no timer and exits before it looks at the file, which the helper
  would read as a live holder (`src/config.ts#CrossAgentConfig`,
  `#limitDefaults`, `#loadConfig`) — and the helper's own default is the same
  5 (`src/locks.ts#acquire`). Every acquisition but the runner's own claim reads
  the configured value — that one is `waitSeconds: 0` by design, below.
  `git_mutate` takes it as an argument, so that module stays a function of what
  it is handed (`src/gitmutate.ts#GitMutateOptions`); `update`'s callers read it
  once per process, per pass or per call, through `lockWaitSeconds(projectRoot)`
  or the config the call has already loaded (`src/runner.ts#lockWait`,
  `src/reconcile.ts#reconcile`, `src/process.ts#terminateOrphans`,
  `src/tasks.ts#check`, `src/wait.ts#wait`), a helper that answers with the documented
  5 when no config can be read (`src/config.ts#lockWaitSeconds`) — locks are
  taken on paths that run before anyone has a readable config, and a caller
  whose only question was how long to wait should not be thrown at (bead
  `atc-s96.34`, closed). Nothing uses `flock -n`; a caller that wants no wait
  passes `waitSeconds: 0`. The exceptions to the waiting rule are two.
  `runner-<id>.lock`'s whole purpose is an immediate failure, so the second runner
  takes it with a zero wait and exits. The repository lock waits at least sixty
  seconds, whatever `limits.lockWaitSeconds` says, because its holder may be another
  project's git step — a commit whose hooks run as long as they run — and a project
  whose own wait is a few seconds would refuse a step it only had to wait for; an
  operator whose hooks run longer raises `limits.lockWaitSeconds`, and no key of its
  own is needed (`src/config.ts#repositoryLockWait`).
- **Bounded settlement.** `spawnEngine` settles on the child's `exit` plus a
  bounded stdio drain (`drainMs`, default 2000; `src/engines/spawn.ts#exitDrain`)
  and on `close` if that arrives first (`src/engines/spawn.ts#closeSettles`); on timeout
  the data listeners are detached and the streams destroyed **before** the
  promise resolves, and the result carries `truncated: true`
  (`src/engines/spawn.ts#drainExpired`). Settling on `close` alone hangs whenever a
  grandchild inherited stdout and holds it open: `handle.result` would never
  resolve and the task would stay `running` with no engine. Probe P3b records
  the shape of it — a nested `claude -p` still running when its parent's turn
  ended — and the suite exercises both descendants: one that inherits stdout
  and one that does not (`tests/runner.test.ts#descendantHoldingEngine`, `#completionKillsDescendants`).
  The drain timer starts at `exit`, not at the last byte; `truncated` covers
  stdout and stderr together, since a reader cannot tell which stream lost the
  tail; and finalisation happens exactly
  once, claiming the `settled` flag **before** the final flush
  (`src/engines/spawn.ts#completeOnce`), so nothing entered twice and nothing after
  the flush is read as a child still worth signalling, while a buffered partial
  line is still evidence and is flushed into the result. A stream or process
  error arriving after the result has resolved is recorded and returned to its
  own caller but never mutates the result the caller already holds
  (`src/engines/spawn.ts#lateError`, `#resolvedLatch`) — a late error cannot rewrite a
  delivered outcome. `SpawnResult.truncated` is persisted on the task record
  for every settlement (`src/runner.ts#evidence`) and appended to `reason` when the
  task failed (`src/runner.ts#truncatedReason`), so an operator reading a failure knows
  whether the evidence is complete.
- **The worktree reservation**, computed and consulted by both callers that may
  let something write: `git_mutate` (section 4) and `delegate`
  (`src/delegate.ts#delegate`). `reservations(projectRoot)` walks one `scan`
  and returns `{reserved, unknown}` — a map from canonical cwd to the task
  holding it, and `scan`'s `invalid` verbatim
  (`src/reservation.ts#Reservations`, `#reservations`); `reservedBy(root,
  target, known)` answers for one path and takes an already-computed
  `Reservations`, so a caller that must also judge `unknown` scans once
  (`src/reservation.ts#reservedBy`). A record reserves when two things hold.
  **It is not settled**: `done`, `failed` and `cancelled` release the workspace
  and nothing else does (`src/ledger.ts#terminalStatuses`, `#isTerminal`,
  `src/reservation.ts#reservations`). **It may write**: the record carries no
  sandbox, so the launch spec beside it is read, and the rule is that the mode
  the spec carries and the mode re-derived from the spec's engine must **both**
  say `read-only` — section 3's map is the adapters' own, and `sandboxFor` is
  what turns the engine's profile name into a mode
  (`src/reservation.ts#reservesWorkspace`). So `off` reserves too, because an
  unsandboxed task is the least constrained writer there is, not the most
  constrained. A spec that cannot be read, a `sandbox` this build cannot read as
  that pair, an engine no adapter answers for, a profile that engine does not
  declare, and a pair whose halves disagree all leave the mode unknown, and an
  unknown mode has never been shown to be read-only, so it holds the workspace
  rather than letting a second writer in
  (`src/reservation.ts#reservesWorkspace`). Reservations are keyed by a
  **canonical** path: the closest existing ancestor's `realpath` with the
  unresolved remainder appended, so a worktree that has been removed still
  compares equal to itself and still holds its reservation
  (`src/reservation.ts#canonicalPath`). Two unsettled writable tasks on one path
  is what the check exists to prevent, but if one is ever seen the map answers
  with the task that took the path first, by `createdAt` then by id, so the
  answer does not depend on the order the directory happened to list
  (`src/reservation.ts#reservations`).

  **What a reservation refuses, exactly**, since `delegate` is written against
  this and nothing else. A cwd held by an unsettled writable task refuses
  **every** delegation onto it, read-only included, until that task settles.
  The mode's flow is sequential — implement, lead commit, then review — so a
  reviewer reading a worktree while its implementer is still writing would be
  reading a tree that is not the one the lead committed, and the reservation is
  the only thing that says so. This is stricter than `git_mutate`'s rule, which
  only ever runs a mutation, and deliberately so. An **`unknown`** record is
  the other case and a weaker one: an unreadable file's `cwd` cannot be matched
  against anything, so it refuses every **writable** delegation and leaves
  read-only ones alone (E2, the malformed-records bullet above) — the
  conservative reading of "it never frees a workspace" when the workspace
  cannot even be named.

  **A reservation covers its path and everything beneath it.** A delegation
  whose cwd is inside a reserved path, equals it, or contains it is refused:
  two tasks writing to `<w>` and `<w>/src` are writing to one tree, and a task
  at the project root would contain every worktree under it. `reservedBy`
  compares both directions segment by segment, never as a string prefix, so
  `/a/b` does not cover `/a/bc`, and where several reservations cover one path
  it answers with the task that took its own first, by `createdAt` then by id,
  as the map itself decides a single path (`src/reservation.ts#covers`,
  `#reservedBy`; bead `atc-vuu`, closed).

  Two things follow for the writer of a record. `record.cwd` must be
  **absolute**: the map is keyed by a canonical path, and a relative cwd would
  be resolved against whichever process happened to read it, so `delegate`
  refuses a cwd that is not absolute and canonicalizes the rest
  (`src/delegate.ts#delegate`). And a delegation is judged writable by the same
  rule its record will be reserved by, so `delegate` reads the role's own
  profile, not the request's. Its refusals are the ones this paragraph asks for:
  the holder and its status as `git_mutate` names them, and the `unknown`
  refusal for a writable delegation alone. `resume` of a task in `launching`,
  `running`, `stalled`, `orphaned`, or `cancelling` is refused, with `refused
  resume of task <id>: status <status> is active`
  (`src/guard.ts#resumeRefusal`), and the chain rules beside it are
  `delegate`'s, because they need the scan: while any record of a resume chain
  is active no record of it may be continued, and a record that already has a
  successor answers `resume the latest: <id>`, so one chain keeps one live task
  and never forks (`src/delegate.ts#resumeFault`).
- **The git lock.** Every lead git mutation runs while
  `.cross-agent/locks/git.lock` is held: `git_mutate` takes it around the
  command and the journal append and releases it in `finally`
  (`src/gitmutate.ts#mutate`); `git_root` takes the same lock around its own
  command and step, and `spawn.lock` before it for the one verb that reads a
  reservation, `worktree remove` (`src/gitroot.ts#gitRoot`, section 4);
  `run_command` takes `git.lock` for its journal append alone and never for the
  suite (`src/runcommand.ts#runCommand`); `cross-agent git` takes both as
  `git_mutate` does, because it calls the same function (`src/cli.ts#gitVerb`).
  What the locks give, stated exactly:
  `spawn.lock` serializes validate-and-spawn, so two hosts cannot both pass the
  reservation check and then both spawn; `git.lock` serializes lead git
  mutations against each other. What keeps a writable task and a git mutation
  off the same worktree is neither lock but the **per-cwd reservation** —
  `git_mutate` refuses while a task reserving that path is unsettled
  (`src/gitmutate.ts#mutate`). That check is a read of the ledger, and a
  `delegate` running beside it could pass its own check and write its record in
  between, so the reservation is made two-directional by a lock the two share:
  `git_mutate` holds `spawn.lock` for its whole duration, with `git.lock` taken
  inside it (`src/gitmutate.ts#gitMutate`), and `delegate` holds `spawn.lock`
  around validate-and-spawn. **The order is always `spawn.lock` then
  `git.lock`**, in both callers, because two orders are a deadlock.

  A lock lost mid-call is answered differently by the two, because they own
  different things. `git_mutate`'s command has already run, so it reports
  `lockLost` and returns (section 4). `delegate` has a window in which nothing
  yet exists: if `claim.lost` is set **before** the `launching` record is
  written, the launch is refused and nothing is spawned — the reservation
  check it passed was only true while the lock held it true, and a spawn on a
  workspace another delegate may have taken meanwhile is exactly what the lock
  exists to prevent. A one-shot's `git_root worktree add` that answers
  `lockLost: true` is refused the same way, before the record, with its worktree
  discarded and `lockLost: true` on the refusal: the worktree exists, but whether
  another project's verb ran beside its creation is unknown
  (`tests/delegate.test.ts#oneShotCreationLockLost`). Once the `launching` record
  exists the reservation is a fact in the ledger rather than a claim on a lock,
  `runner-<id>.lock` governs from there, and `delegate` returns normally however
  `spawn.lock` ends (`src/delegate.ts#delegate`). A read-only spawn during a git
  mutation is allowed and is not a defect: it reads a tree mid-change, which is
  what a reviewer reading a moving branch would see anyway.

The process model is Linux-only in these mechanisms: `/proc/<pid>/stat` for
identities and the group scan, `/proc/*/environ` for the stranded-engine scan,
`/proc/<pid>`'s owner and `/proc/stat`'s `btime` for the plausible-candidate
test (`src/process.ts#ownedByThisUser`, `#bootTimeMs`),
`/proc/sys/kernel/random/boot_id` for the boot identity, and util-linux `flock`
for the locks.

### 3. Engine adapters

Step 5 of the work plan (`atc-s96.22`, commits `734e1e9..193b511` with its
review's fix round in `cfaf2b0`) built the engine contract on top of what T4
shipped, the interface and the spawn pipeline: the adapter-owned profile map,
the deny and exclusion argv, `leadMount`, the `finish` hook, the
`{mode, profile}` pair, the built-in adapter table, and the per-engine profile
check at config load. Row 6 then built all three adapters — T7 Claude
(`d8bc672`, `90fd4d6`), T8 Codex (`aa3e8bc`, `1a20cc8`), T9 Grok (`992a830`) —
so the spawn lines below are the argv each `plan` emits today rather than the
line its task was briefed to build. Step 7's first half then gave this section
its production caller: `delegate` writes each task its own `<id>.scratch/`
directory at mode 0700 and puts it in the spec (`src/delegate.ts#delegate`, bead
`atc-s96.37`), rebuilds `denyTargets` from config at every launch, and exports a
configured `engines.<e>.bin` as `CROSS_AGENT_<ENGINE>_BIN` in the spec's
environment — the one environment both `plan` and `sandboxSupport` read, so
the binary that is checked is the binary that is spawned (`atc-s96.10.1`,
closed).

`src/engines/{types,spawn,registry,binaries,claude,codex,grok}.ts`: build argv
and env, capture the session id from the first native event, extract the final
message, support `resume`. Binaries are overridable through config
(`engines.<e>.bin`), which `delegate` carries to the adapter as
`CROSS_AGENT_<ENGINE>_BIN` in the launch spec's environment (tests use fake
engines the same way).
Every adapter must apply the configured sandbox or refuse to spawn (fail
closed); running without a sandbox requires a profile whose mode is `off`, and
the refusal is thrown synchronously by the pipeline, before anything is planned
or spawned (`src/engines/spawn.ts#spawnEngine`, `#sandboxSupportCheck`).

**The engine contract is adapter-owned and closed.** Flag knowledge is off
`src/guard.ts`'s per-engine switches — where the comment that replaced them
points at the contract instead (`src/guard.ts#adapterOwnsFlags`) — and on
`EngineAdapter` (`src/engines/types.ts#EngineAdapter`), which carries:

- `sandboxProfiles: Record<string, SandboxMode>`
  (`src/engines/types.ts#EngineAdapter`, `#SandboxMode`) — the profile names
  this engine accepts, each mapped to a portable mode. Claude `{"read-only":
  "read-only", "workspace-write": "write", "off": "off"}` and Codex the same,
  with Codex's `off` spawning `--sandbox danger-full-access`; Grok
  `{"read-only": "read-only", "strict": "read-only", "workspace": "write",
  "off": "off"}`, since `strict` is a read-only profile too and so frees a
  workspace exactly as `read-only` does. Each map is a literal in its own
  adapter file.
- `sandboxSupport(env)` (`src/engines/types.ts#EngineAdapter`), answered by each
  adapter from what can be seen before a spawn, against the environment the
  pipeline is about to spawn with (`src/engines/spawn.ts#spawnEngine`): Claude
  checks `bwrap` and `socat` on that environment's `PATH` on Linux and names
  whichever is missing, Codex and Grok check that their binary resolves there
  and name it. The Ubuntu 24.04 AppArmor half of P1 cannot be seen before the
  run at all, so it stays `atc-s96.17`'s. Neither can Grok's own refusal: its
  bubblewrap plan resolves the binary's built-in runtime-socket deny list path by
  path and refuses to start when one cannot be resolved
  (`docs/probes.md#grokSandboxSocket`), and that list is the binary's, so a check
  here would encode it and go stale. `parseStderrLine` reads the refusal instead.
- `denyArgs(targets)` and `exclusionArgs()`
  (`src/engines/types.ts#EngineAdapter`), each engine's own: Claude both deny
  forms in one appendable `--disallowedTools` array and `--strict-mcp-config`
  for exclusion, Codex an empty deny list and `--ignore-user-config`, Grok one
  `--deny` per target and no exclusion flag at all. Every `plan` spreads both
  into its argv whatever its own engine answers today
  (`src/engines/claude.ts#claude`, `#claude`, `src/engines/codex.ts#codex`,
  `src/engines/grok.ts#grok`), so an engine that gains a deny form or an
  exclusion flag gains it by returning one.
- `leadMount(spec: LeadMountSpec, scratchDir: string): LeadMount`
  (`src/engines/types.ts#EngineAdapter`, `#LeadMountSpec`, `#LeadMount`) — the
  argv that mounts exactly this server for a lead under `placement: engine`. P9
  settled what each engine can do (`docs/probes.md#p9Mounts`). Claude writes an
  MCP-config JSON into `scratchDir` and returns `--mcp-config <file>` beside the
  `--strict-mcp-config` its `exclusionArgs` already emits; the strict flag, not
  the config file, is what makes the mount exclusive, since dropping it from an
  otherwise identical run pulled in five of the operator's own servers
  (`docs/probes.md#p9Mounts`). Codex returns **five** settings — `-c
  mcp_servers.cross-agent.command=…`, `…args=…`, `-c
  mcp_servers.cross-agent.default_tools_approval_mode="approve"`,
  `…tool_timeout_sec=3600` and `…env_vars=[…]`. The third because `codex exec`
  runs with approval policy `never`, so without it the lead sees the tools and is
  refused every call (`docs/probes.md#p9CodexMount`); the fourth because Codex
  gives an MCP call 60 s by default and a lead's `wait` and `ask` are 600 s calls
  (`docs/probes.md#s11CodexLeadTimeout`); the fifth because Codex starts the
  server in an environment of its own, and names, not values, are what a
  constant list can carry: `CROSS_AGENT_DEPTH`, `CROSS_AGENT_TASK`,
  `CROSS_AGENT_LINEAGE` and `CROSS_AGENT_PROJECT`, whose values Codex copies from
  the lead's own environment (`docs/probes.md#e2ServerEnv`). It still refuses a
  non-empty `spec.env` (`src/engines/codex.ts#codex`), the literal-values map, and
  a lead's project reaches it through `args` — which I1's tracked Codex row ran on
  codex-cli 0.159.2, the server answering from the project `--project` named
  (`docs/probes.md#i1CodexTracked`). Grok returns an empty argv with `inherited: true`, because it
  has no per-invocation mount at all; that value describes the specialist path
  and the operator CLI's own registration, not a lead, because Grok is not a
  supported lead engine ("The lead model", item 4). Returning the files to
  write, rather than writing them, keeps the adapter a pure argv builder as
  `plan()` is.
- `parseStderrLine?(line: string): EngineEvent | null`
  (`src/engines/types.ts#EngineAdapter`), the same as `parseLine` for an engine
  that writes a fatal line to stderr rather than into its event stream. **Claude
  and Grok declare it, and Codex does not** (`src/engines/claude.ts#claude` and
  `src/engines/grok.ts#grok`, each its `parseStderrLine` member;
  `tests/engines/codex.test.ts#codexDeclaresFinish`, `tests/engines/grok.test.ts#grokDeclaresFinish`): P1's two
  sandbox failures — the "Sandbox disabled" warning and the `apply-seccomp`
  message every command inside a broken sandbox dies with — and Grok's refusal
  to start a sandbox whose deny list it cannot enforce, two lines and exit 1
  before any stream (`src/engines/grok.ts#sandboxRefusal`,
  `tests/engines/grok.test.ts#sandboxRefusalRun`), are invisible before the spawn
  and are not errors the engine reports in its stream, so the line is the
  verdict. The pipeline reads stderr for an adapter that declares this
  and for no other (`src/engines/spawn.ts#stderrParserBound`, `#parserForStream`), so everywhere else
  stderr stays log evidence and nothing more. Such an `error` event is **fatal**
  — `ok` is false however the engine exited (`src/engines/spawn.ts#okVerdict`) —
  and it advances `lastEventAt` exactly as a stdout event does, deliberately: an
  engine whose every command dies in the sandbox is working, not stalled, and
  the stall detector must not be the thing that reports a failure the events
  already carry (`src/engines/spawn.ts#stderrAdvancesClock`). The pipeline records **one**
  such event per run and stops asking after it, because a sandbox that engages
  and then fails at its own setup repeats itself once per command: the first
  `error` event parsed from stderr sets a latch, and every stderr line after it
  is skipped before the reader is asked, so it reaches the log and nothing
  else. The latch is the run's, not the adapter's, so `parseStderrLine` stays a
  pure function of one line and a singleton adapter leaks nothing from one run
  into the next (`src/engines/spawn.ts#stderrFailedLatch`).
- `finish?(rawStdout: string): EngineEvent[]`
  (`src/engines/types.ts#EngineAdapter`), for an engine whose output is one
  document at exit rather than a line stream. **No adapter declares it**, and
  the hook's only exercise is the fake engine's `grok-json` format
  (`tests/fixtures/fake-engine.mjs#grokJsonFormat`), which is the shape it exists for:
  all three formats below are line streams, and a declared `finish` would only
  make the pipeline buffer raw stdout for a call with nothing to read
  (`tests/engines/claude.test.ts#claudeDeclaresFinish`, `tests/engines/codex.test.ts#codexDeclaresFinish`,
  `tests/engines/grok.test.ts#grokDeclaresFinish`). The hook and the pipeline's half of it are
  built and tested all the same, because Grok's `json` mode is the fallback an
  adapter would need it for. The pipeline binds it once, before the spawn, and
  buffers raw stdout only for an adapter that declares it
  (`src/engines/spawn.ts#finishBound`, `#rawStdoutKept`); it runs once at completion, after the
  last byte and **before** `finalMessage`, and its events are appended, so a
  late `session` or `result` still counts (`src/engines/spawn.ts#finishRuns`). A
  throwing `finish` is reported as this engine's error and the events parsed
  before it survive. `finalMessage(events, resultFileText)` then runs exactly as
  it did (`src/engines/types.ts#EngineAdapter`).

`SpawnRequest.sandbox` is `{mode, profile}`, where `profile` is the engine's
own name for the profile and `mode` is what `sandboxProfiles` says that profile
means (`src/engines/types.ts#SpawnRequest`). The pair is a **claim, not a
fact**: `sandboxFor(engine, profile)` in the registry is the one place in `src/`
where one is constructed (`src/engines/registry.ts#sandboxFor`), resolving
through the engine's own map and refusing a name it does not declare as an
**own** key, so `toString` is nobody's profile; and every consumer re-derives
rather than trusts. The pipeline refuses a request whose `engine` is not the
adapter the runner imported — otherwise the map the mode comes from would
describe one engine while another builds the argv — then re-derives the mode
and refuses a pair whose halves disagree, and only then keys the fail-closed
check on the derived mode (`src/engines/spawn.ts#spawnChecks`). The reservation
re-derives the same way and frees a workspace only when the carried mode and the
derived mode both say `read-only` (`src/reservation.ts#reservesWorkspace`,
section 2). So neither the pipeline nor the reservation rule has to know any
engine's vocabulary, and neither takes a label's word for it. `SpawnRequest`
also carries `engine`, `scratchDir`, which is where `leadMount`'s files and a
role-prompt file go — never inside the specialist's own worktree — and
`lead`, set only for an engine-placed lead
(`src/engines/types.ts#SpawnRequest`). `scratchDir` is a **per-task** directory
`<tasks>/<id>.scratch/`, created at mode 0700 by `delegate` and written into the
launch spec (`src/delegate.ts#delegate`, `atc-s96.37`, closed). The shared tasks
directory it used to be would have two live tasks overwriting each other's
`role.md` and `mcp-config.json` — and a resumed Codex run re-reads its
instructions file, so the collision would outlast the spawn. The adapters needed
no change for it: each uses `scratchDir` as it is given. `SpawnPlan` carries the
`files` an adapter's argv points at (`src/engines/types.ts#SpawnPlan`); the
pipeline writes them, parents included and mode `0600`, before the spawn, and a
file it cannot write is a launch failure with nothing spawned
(`src/engines/spawn.ts#planFiles`, `#launchError`). `LaunchSpec` is
`Omit<SpawnRequest, "logPath" | "resultPath">` (`src/ledger.ts#LaunchSpec`), so
every one of those fields reaches the detached runner without a second shape to
keep in step.

**A role's profile must be a key of its engine's map, checked at config load.**
The loader takes the union of the adapters' keys as the profile vocabulary
(`src/engines/registry.ts#sandboxProfiles`, read in `src/config.ts#loadConfig`)
and then checks the pair: the role's profile must be an own key of *its own
engine's* map, or load fails naming the engine and the profiles it accepts.
Nothing type-checks the sources — `package.json` runs `node --test` and there
is no `tsconfig.json` — so `{engine: "codex", sandbox: "workspace"}` would
otherwise reach the Codex adapter unchallenged. It is refused instead, which is
A2.

**The adapter table is a fixed built-in.** One file plus one entry per new
engine: `adapters` and `adapterFor(name)` (`src/engines/registry.ts#adapters`,
`#adapterFor`), with `engineNames` and `EngineName` beside the contract rather
than in the config loader, so nothing an adapter needs imports `src/config.ts`
(`src/engines/types.ts#engineNames`, `#EngineName`). `src/engines/binaries.ts`
holds the two things every adapter needs and none of them owns:
`engineBin(engine, env)`, which reads `CROSS_AGENT_<ENGINE>_BIN` and otherwise
the engine's name (`src/engines/binaries.ts#engineBin`), and
`commandPath(command, env)`, which resolves a bare name on that environment's
`PATH` and takes anything carrying a separator as a path
(`src/engines/binaries.ts#commandPath`). `src/engines/text.ts` is the same
arrangement for reading an engine's output: `truncate` and `activityLimit`
(all three adapters), `assistantText` (Claude and Grok both read the Anthropic
Messages API wire shape) and `failureText(event, first, engine)`, whose `first`
is which field that engine puts a failure's message in — `result` for Claude,
`errors` for Grok — because that is the one thing the two dialects disagree
about (`src/engines/text.ts#failureText`, bead `atc-s96.41`). Each adapter's
`parseLine` stays its own: one engine's format changing must not retune
another's. Neither falls back to `process.env`:
`plan` and `sandboxSupport` are handed the same environment, which is the
spec's, so one binary is judged and spawned and a configured `engines.<e>.bin`
reaches both (`atc-s96.10.1`, closed). Config-declared adapter modules are not
supported, and the reason is in the code: the runner imports the spec's
`adapterModule` into its own process, unsandboxed (`src/runner.ts#adapterImport`), and
`validateSpec` checks only that the path is absolute
(`src/ledger.ts#validateSpec`). Making that path config-controlled would turn a
config file into arbitrary code execution in the orchestrator.

**The spawn lines, as built.** Each is the argv that engine's `plan` emits, in
the order it emits it; every flag is recorded by a Phase 0 probe except where a
bullet says otherwise, and each line is pinned byte for byte by its own test. A
flag with nothing to carry is not emitted at all, on any engine. `plan` builds
argv and names the files that argv points at and writes nothing itself, so the
three bullets below also say **how the prompt reaches the child** — Claude on
stdin, Codex on stdin behind a `-` positional, Grok as `-p`'s own value —
which is a property of the line, not of the pipeline.

- **Claude** (`src/engines/claude.ts#claude`): `claude -p --output-format
  stream-json --verbose --permission-mode dontAsk --tools <the role's tools>
  --setting-sources project --strict-mcp-config` — then, for an engine-placed
  lead only, `--mcp-config <file>` — then `--model <m>`, `--effort <e>`,
  `--session-id <uuid>` or `--resume <id>` and never both,
  `--append-system-prompt-file <role.md>`, `--settings <json>`
  (`disableAllHooks: true`, the sandbox and the permission rules), and last
  `--disallowedTools <deny list>`. cwd =
  the role's workspace, passed through as the request wrote it because it is
  already canonical and the writable root has to name the directory the child
  sees (`tests/engines/claude.test.ts#writableRootRequest`). **The mount goes immediately after
  the flag that makes it exclusive and before `--model`**, which is the order
  P9 ran and the one that leaves only one variadic flag at the end of the
  line: `--mcp-config` takes `<configs...>` (`docs/probes.md#cliClaude`), so the
  last flag has to be `--disallowedTools`, whose values end the argv. **The
  brief goes on stdin**, so no positional argument follows that variadic
  flag either (`src/engines/claude.ts#claude`). The four cases are pinned byte
  for byte — read-only, writable, resumed, and with a lead's mount and its
  config as a plan file (`tests/engines/claude.test.ts#readOnlyRole`, `#writeRoleArgv`,
  `#resumedRunCarries`, `#enginePlacedLead`).
  **The sandbox binds the shell; the file tools have a fence of their own.**
  Claude Code's sandbox applies to Bash and its children only, and the built-in
  file tools answer to the permission layer, which `bypassPermissions` used to
  open: a worktree consult's Write tool wrote the project root, its `.git`,
  `.cross-agent/`, `$HOME` and its own pointer file, and a read-only consult's
  `EnterWorktree` added a worktree and a branch to the project's repository, all
  while the sandbox denied the same writes to the shell
  (`docs/probes.md#t12Fix1`). So the line runs in `dontAsk`, which denies,
  headless, every call nothing pre-approves, and the settings say what each
  role may do beyond reading inside its workspace and running its sandboxed
  shell: read anywhere, as the shell can; edit its own workspace, for a role
  that may edit; run its shell when no sandbox approves it (`off`); call its
  lead mount's tools (`src/engines/claude.ts#fileToolRules`). The protected
  paths are denied by name in this layer as in the sandbox, and a deny rule
  holds in every mode. `--tools` names the built-in tools a role keeps — the
  shell, the reader and `ToolSearch`, and the editing tools for a role that
  may edit — so `EnterWorktree`, `Agent`, `Workflow`, `RemoteTrigger`,
  `SendMessage`, the `Cron` tools, `ScheduleWakeup` and the rest of the default
  set are offered to no role (`src/engines/claude.ts#claudeTools`,
  `tests/engines/claude.test.ts#fileToolsConfined`, `#claudeToolAllowlist`).
  `--setting-sources project` keeps the operator's user and local settings
  out — their allow rules would pre-approve what `dontAsk` denies — and keeps
  the project's own settings and instruction files, which an empty list and
  `--restricted` both drop (`docs/probes.md#t12Fix1`). A specialist therefore
  reads nothing of `~/.claude/settings.json` — not its `env`, not its
  `apiKeyHelper`, not the operator's own `deny` rules — and signs in with the
  credentials `claude login` stored, or under `billing: "api"` with the key in
  the server's environment (`src/guard.ts#childEnv`). **What the project's own
  settings can open is accepted rather than fenced.** Claude Code merges the
  project's `.claude/settings.json` into the run, and no setting source keeps the
  instruction files without it, so that file's `permissions.allow` rules join
  the adapter's and `dontAsk` honours them: a file-tool rule that reaches beyond
  the workspace — a bare `Edit` or `Write`, `Edit(//…)` outside the worktree,
  `Edit(~/…)`, `Edit(../…)` — or a `permissions.additionalDirectories` entry
  would pre-approve writes the line otherwise refuses. This build does not
  override them: the residual was accepted on 2026-10-02 as a limitation of
  Claude Code's own settings merge, and section 4's merge guard keeps
  specialists from changing `.claude/`, so only the operator or the project's
  history puts such a rule there. Claude Code applies the two keys only in a
  workspace its operator has trusted; in the untrusted sample it dropped them
  with a warning and every write outside the worktree was refused
  (`docs/probes.md#t12Fix2`), and the trusted case was not probed. **Two things
  `dontAsk` refuses that `bypassPermissions` allowed.** Inside its own
  workspace a role's file tools are refused Claude Code's sensitive paths:
  `.vscode/`, `.idea/`, `.husky/`, `.npmrc` and `.gitmodules` were refused
  where a file beside them was written, and the CLI's own list names more, so
  a task that has to change one is finished by hand. And a sandboxed role
  reaches no network host: the sandbox's request for a domain is refused where
  `bypassPermissions` approved it, a project's `sandbox.network.allowedDomains`
  does not change that because Claude Code ignores a project's sandbox grants
  once the run's settings set `allowUnsandboxedCommands: false`, and a
  dependency install belongs to the configured setup command, which
  `run_command` runs outside any sandbox (`docs/probes.md#t12Fix2`).
  Sandbox through the settings JSON (`sandbox.enabled`,
  `filesystem.allowWrite`, `filesystem.denyWrite`, `autoAllowBashIfSandboxed`,
  `allowUnsandboxedCommands`, `failIfUnavailable`;
  `src/engines/claude.ts#claude`, the `plan` member). A read-only role gets no
  `allowWrite` and no `Edit`/`Write` tools, and **that is not enough**: this
  sandbox writes to the working directory by default, so a read-only role at the
  project root could write the project — `.cross-agent/` included — through
  `Bash`. Its own workspace is therefore denied by name, with the protected paths
  after it, and a probe at the sample root found the project, `.cross-agent/`,
  `git add -A` and even `/tmp` all refused while reads still worked
  (`docs/probes.md`, P2's read-only row). **`allowWrite` is not the whole of a
  writable role's rule either.** P2's Claude row watched a specialist whose only writable root
  was its worktree write into the repository's common git directory beside it,
  which design section 4 rests on being impossible; `denyWrite` carries the
  spec's `protectedPaths` — the workspace's own `.git` pointer file and that
  common directory, both resolved by `verifyWorktree` and put in the spec by
  `delegate` — and a deny rule wins over an allow one. The rerun with the two
  paths named denied the write and changed nothing else
  (`docs/probes.md#p2Rerun`). At a project root that is not its repository's main
  checkout the same field carries the root's own pointer too, and a read-only role at
  such a root is denied that pointer and the common directory beside its own cwd, which
  is the only path its default rule names (section 4, `src/delegate.ts#protectedPathsFor`). The other two adapters take the same field
  differently: Codex needs no argument, because its `workspace-write` denies
  every write outside the workspace and protects the `.git` entry inside it
  (P2, Codex), and Grok cannot enforce it at all, which is why a Grok
  implementer's metadata is checked by `verify_worktree` rather than protected
  (`src/engines/types.ts#SpawnRequest`). **A sandboxed
  role may neither leave its sandbox nor run without one.** At
  `allowUnsandboxedCommands: false` the engine ignores the
  `dangerouslyDisableSandbox` parameter its own escape hatch retries a blocked
  command with, and at `failIfUnavailable: true` a sandbox that cannot start
  fails the run instead of warning and running every command unsandboxed
  (`src/engines/claude.ts#sandboxHatch`, `tests/engines/claude.test.ts#sandboxedRoleMay`). P1's
  rerun on 2026-09-18 is the reason and not a precaution: a sandboxed child
  whose `curl` died at bubblewrap's setup took that hatch by itself and
  reached the network, since nothing prompts a headless run
  (`docs/probes.md#p1EscapeHatch`). Both settings belong to a sandbox that is on, so
  the `off` profile — the one that asked for none — sends neither. **The
  operator's hooks are off under every profile.** `--strict-mcp-config` excludes
  MCP servers and nothing else, so a specialist ran every `SessionStart` hook of
  the operator's installation, took their `additionalContext` into its first
  turn and, in this repository, answered a `Stop` hook instead of its brief
  (`docs/probes.md#smoke6b`); the settings carry `disableAllHooks: true`
  (`tests/engines/claude.test.ts#hooksDisabled`), and a run under them showed no
  hook event of any kind (`docs/probes.md#claudeHooksIsolation`). The
  operator's plugins, and the skills and commands they bring, no longer load
  under `--setting-sources project`, and no role holds the `Skill` tool that
  would run one (`docs/probes.md#t12Fix1`).
  `--append-system-prompt-file <role.md>` is **settled by P9**
  (`docs/probes.md#p9Mounts`, `#p9ClaudeInstructions`): `claude --help` documents that
  spelling only as the `[-file]` form of `--append-system-prompt`, but the
  binary accepts the flag and the child obeys the instruction in every
  assistant message, so a Claude role prompt travels as a file and never as
  prompt text. That file is the task's own: it goes in `scratchDir`, never
  inside the specialist's worktree, which the role may edit
  (`src/engines/claude.ts#claude`, the `plan` member's role-prompt block). Prerequisites on Linux are three, all
  from P1: `bwrap`, `socat`, and on Ubuntu 24.04 or later an AppArmor profile
  for `/usr/bin/bwrap` with `flags=(unconfined)` and `userns` — the README's
  "Prerequisites on Linux" says how to set them up, beside Grok's own. The adapter
  answers the two failure modes in the two places each can be seen:
  `sandboxSupport()` names whichever of `bwrap` and `socat` is missing from
  `PATH` before the spawn (`src/engines/claude.ts#claudeSandboxSupport`), and
  `parseStderrLine` turns the
  "Sandbox disabled" warning and the `apply-seccomp` message of a sandbox that
  engages but cannot start any command into a fatal `error` event during the
  run (`src/engines/claude.ts#sandboxFailure`, `#claude`), because that half
  cannot be seen before it. The profile is a prerequisite with a trap of its
  own: a profile written from Claude Code's docs is **shadowed** by Ubuntu's
  stock `bwrap-userns-restrict`, which declares the same profile name and
  loads later, so only a live `bwrap`'s own confinement says whether the
  sandbox can work (`docs/probes.md#p1ProfileShadowed`).
- **Codex** (`src/engines/codex.ts#codex`): `codex exec --json -o <out> -C
  <cwd> --sandbox <read-only|workspace-write|danger-full-access>
  --ignore-user-config --skip-git-repo-check -m <m>
  -c model_reasoning_effort="<e>" -c model_instructions_file="<role.md>"` —
  then, for an engine-placed lead only, the five `-c mcp_servers…` settings
  — and last the positional `-`. **The brief goes on stdin and `-` holds its
  place** (`src/engines/codex.ts#codex`, `#codex`): a bare positional is
  misread as a flag the moment a brief begins with `-`, and a brief is prose a
  lead composes, not a string this file controls. Both heads document the
  spelling (`codex-cli` 0.153.4 `--help`, `docs/probes.md#cliCodex`), and the
  `-o` file is emptied before the spawn so a dead run cannot report the
  previous one's last message as its own (`src/engines/codex.ts#codex`,
  `tests/engines/codex.test.ts#fileEmptiedRun`). The lines are pinned byte for
  byte: the launch line (`tests/engines/codex.test.ts#readOnlyRole`), a writable role's
  (`#writeRoleArgv`), `off`'s (`#offProfileLaunches`), the resume (`#resumedRunExec`), an
  `off` resume (`#offRoleResumes`), and a lead's five settings (`#enginePlacedLead`). Resume is a **different flag set**: `codex
  exec resume <thread id>` accepts `-c/--config`, `--last`, `--all`,
  `--enable`, `--disable`, `-i/--image`, `--strict-config`, `-m/--model`,
  `--dangerously-bypass-approvals-and-sandbox`,
  `--dangerously-bypass-hook-trust`, `--thread-source`,
  `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`,
  `--ignore-rules`, `--output-schema`, `--json`, and
  `-o/--output-last-message`, and **neither `-C` nor `--sandbox`** (`codex exec
  resume --help`, 0.153.4, read 2026-09-09 and recorded at
  `docs/probes.md#cliCodex`). So the resume line is `codex exec resume <thread
  id> --json -o <out> --ignore-user-config --skip-git-repo-check -m <m> -c
  model_reasoning_effort="<e>" -c sandbox_mode="<the role's Codex profile>" -c
  model_instructions_file="<role.md>" -`, spawned with the **resuming
  process's** cwd set to the role's workspace
  (`src/engines/codex.ts#codex`, `#codex`, `#codex`). The instructions file is
  re-supplied for the same reason the sandbox is: a `-c` setting belongs to the
  process, and the resumed thread is a new one. The
  profile is the key of `sandboxProfiles` the role names, so `off` resumes as
  `-c sandbox_mode="danger-full-access"`, the same value the launch path gives
  `--sandbox`; there is no unsandboxed resume by omission. P10 settled why both
  halves are the adapter's work (`docs/probes.md#p10Variants`): a resumed thread
  keeps neither the cwd nor the sandbox of the original run. The writable root
  of a workspace-write sandbox follows the resuming process's cwd, so a resume
  started one directory up wrote a file into the repository root that the
  original turn had been refused — the failure is silent, not an error. `-c
  cwd=<dir>` is ignored; the process's own cwd is the only lever. The thread
  itself comes back read-only, which is the safe direction but not necessarily
  the role's, and `-c sandbox_mode=` restores it exactly. So
  `SpawnRequest.sandbox` is re-applied by the adapter on every resume, from
  `sandbox.profile`, and never assumed from the thread. `--ignore-user-config`
  keeps auth and raises no trust prompt — though the run still writes a trust entry
  for its repository into the operator's `~/.codex/config.toml`, as each guarded
  `codexI2Real` run did (`docs/probes.md#i2Codex`) — and removes the user's MCP servers,
  leaving only Codex's built-in `codex_apps` (P5) — and the user's plugins with
  them: a delegated Codex `consult`, with this repository's plugin enabled in the
  operator's configuration, listed no plugin skill root and no tool of this server
  (`docs/probes.md#i1CodexHost`). Codex carries **no deny list**: probe P3 showed that
  execpolicy rules files are not honoured by `codex exec`, so its sandbox's
  network denial is the layer that holds instead, and a launched engine cannot
  reach its API (P3b). `codex exec` is chosen over `codex app-server` — the
  transport `codex-plugin-cc` uses — because `exec` needs no dependency and no
  second JSON-RPC client inside this server; the cost is execpolicy and a
  native `review/start`, neither of which this design uses. A Codex lead's
  mount is the five `-c mcp_servers…` settings above under
  `--ignore-user-config`, and its instructions reach it through `-c
  model_instructions_file="<file>"` — accepted and obeyed with no role text in
  the prompt at all, so a Codex lead spends no prompt space on the loop (P9,
  `docs/probes.md#p9Mounts`, `#p9CodexMount`). Every role's instructions travel that way,
  lead or specialist, in a `role.md` under `scratchDir`
  (`src/engines/codex.ts#codex`, `tests/engines/codex.test.ts#rolePromptTravels`).
  Its reader answers `activity` for an `agent_message` item, a
  `command_execution` item and an `mcp_tool_call` item, announced and completed,
  as `mcp_tool_call <server>.<tool> <status>`: only a parsed event advances
  `lastEventAt`, the clock `wait` and `check` measure silence from ("Time
  limits"), and a lead that only calls this server's tools says nothing else for
  as long as its calls last (`tests/engines/codex.test.ts#mcpCallIsActivity`,
  `#mcpCallAdvancesClock`).
- **Grok** (`src/engines/grok.ts#grok`): `grok -p <prompt> --cwd <cwd>
  --sandbox <workspace|read-only|strict|off> --permission-mode
  bypassPermissions --output-format streaming-messages-json --session-id
  <uuid> | -r <id> --model <m> --reasoning-effort <e> --rules <role text>`
  plus one `--deny` per deny-list entry, ending the argv, the same on resume.
  There is **no lead head at all**: `plan` refuses a request carrying `lead`,
  because P9 found no per-run mount it could build one from, and that is the
  gate no configuration can reach around (`src/engines/grok.ts#grok`,
  `tests/engines/grok.test.ts#planRefusesEngine`). **The prompt is `-p`'s own value**, so
  nothing goes on stdin and the plan names no files: Grok reads none that this
  adapter writes, until the line grows too long for the kernel. Two budgets
  decide that, because the two flags are charged separately
  (`src/engines/grok.ts#promptLimit`, `#rulesLimit`): a role prompt past 100 KiB
  cannot be one `--rules` argument at all, and the role text **and the brief
  together** past 64 KiB cannot share the command line, whichever of them is
  large. Either way the pair travels as `--prompt-file`'s file — the role's
  text, a blank line, then the brief, P9's own comparison delivery — and
  `--rules` still carries the role when it fits there, because that is Grok's
  system-prompt path. The second budget is `atc-s96.55`: a `review` brief with
  a diff attached, 150,745 bytes, failed at launch with `spawn E2BIG` when only
  the role text was measured (`tests/engines/grok.test.ts#briefTooLarge`, `#promptBudgetRole`). `strict` and `off` are the two
  `--sandbox` values no recorded run has completed: P2 ran `workspace` and
  `read-only`, `strict` refused to start as `read-only` did before 6b's machine
  fix (`docs/probes.md#grokSandboxSocket`), and `--help` does not enumerate the
  profiles (`docs/probes.md#cliGrok`).
  Every flag takes exactly one value, which is what lets the deny list end the
  line without swallowing anything (`tests/engines/grok.test.ts#wholeDenyList`); the
  writable, read-only, every-profile and resumed lines are pinned byte for
  byte (`tests/engines/grok.test.ts#writeRoleArgv`, `#readOnlyRole`, `#profileReachesSandbox`, `#resumedRunCarries`). **P8 chose
  the format** (`docs/probes.md#p8Formats`). `streaming-messages-json` is NDJSON
  in the Anthropic Messages API wire shape — line for line what Claude Code's
  `stream-json` emits, so one line vocabulary serves both adapters. Its first
  line is `{"type":"system","subtype":"init"}` carrying `session_id`, on a
  resumed run (`-r <id>`) as well as a fresh one, which is what lets the
  adapter emit its `session` event from the first native event as this section
  requires; its last line is `{"type":"result","subtype":"success",…}` and the
  final text is that line's `result`. A failed run keeps the shape:
  `system/init`, then a `result` line whose `subtype` is
  `error_during_execution`, whose `is_error` is `true`, and whose message is
  in an `errors` array with no `result` field at all, exit 1. Success and
  failure therefore settle down one path, and `finalMessage` reads `result`
  when `is_error` is false and `errors` when it is true, joining that array
  with newlines: it is a list of messages, and an operator reading a failure
  needs all of them, one per line. `streaming-json` was **rejected**: it
  announces the session id only on its final `end` line, that line carries no
  message text, and a failed run emits a bare `{"type":"error",…}` and never
  closes, so an adapter would have to read a missing `end` as failure. It
  stays a fallback beside `json`, which remains the whole-output fallback for
  an adapter that declares `finish`; neither is sufficient on its own, because
  Grok's `json` mode prints one object at the end and nothing before it, which
  leaves `lastEventAt` null for the whole run (`src/engines/spawn.ts#parsedEvent`
  advances it only on a parsed event) and so makes every Grok task look
  stalled and `check` show nothing. That shape is the fake engine's
  `grok-json` format (`tests/fixtures/fake-engine.mjs#grokJsonFormat`, `#grokJsonResult`,
  `tests/spawn.test.ts#grokJsonFormat`), and it is what the pipeline's `finish` tests are
  run against, because it is the case the hook exists for
  (`tests/spawn.test.ts#declaredFinishCalled`, `#adapterDeclaresFinish`). `--effort` is an alias of
  `--reasoning-effort`. **The role prompt goes through `--rules <role
  text>`**, which is Grok's system-level path and so the counterpart of
  Claude's `--append-system-prompt-file` and Codex's `-c
  model_instructions_file=`: P9 honoured both it and a prompt prefix, and the
  system-level one keeps the role out of the turn's own text
  (`docs/probes.md#p9GrokInherits`). It takes a **string**, not a path — given a role
  file's path it put the path into the system prompt as literal text and the
  child read the file itself — so the adapter passes the role's *contents*,
  and only when the text would exceed the argv limit, which is the one case a
  flag cannot carry, does the delivery change. The ceiling is 100 KiB, below
  Linux's 128 KiB cap on a single argument with room for the rest of the line
  (`src/engines/grok.ts#rulesLimit`, `tests/engines/grok.test.ts#rolePromptTravels`,
  `#rolePromptPast`). Past it the role text, a blank line and the brief go to
  `<scratchDir>/rules.md` through the plan's `files`, and the argv carries
  `--prompt-file <path>` in place of `-p <prompt>` (`grok --help`, 1.0.34:
  "Single-turn prompt from a file", `docs/probes.md#cliGrok`). Prepending the
  role to `-p`'s value, which is what P9 honoured and this adapter used to do,
  would put the same text plus the brief into one argument again — strictly
  larger than the `--rules` value that did not fit — so the fallback for an
  argument that is too long cannot itself be an argument (bead `atc-s96.38`).
  Grok reads both inputs: in four runs on grok 1.0.44 a marker sent through
  `--rules` alone, one in the file alone, and the two together with the role
  taken out of the file were each obeyed, so `--rules` is read beside
  `--prompt-file`, and an oversize run hands the role over twice — as rules and
  at the head of the turn — which costs its tokens and nothing else
  (`docs/probes.md#grokRulesBesidePromptFile`). Grok is therefore the one engine
  whose role prompt reaches the child without a file on disk, until it is too
  big to. `--sandbox workspace` is
  deliberately stricter than `grok-build-plugin-cc`'s write mode, which omits
  `--sandbox` entirely.

Deny list for Claude and Grok, rebuilt from config at spawn
(`src/guard.ts#denyTargets`): the commands `claude`, `codex`, `grok`, each
configured `engines.<e>.bin` path, `node <absolute path of src/server.ts>`,
`node <absolute path of src/cli.ts>` — **this repository's**, the same base
`adapterModule` is built from and never the project's, which has neither file
(`src/delegate.ts#repositoryRoot`, I1) — and `cross-agent`. Those two are
best-effort by construction: the path is this module's realpath, so a checkout
reached through a symlink is denied under the real name and not the link's, and
a rule is a string the engine matches against a command line. The layer that
does not depend on spelling is the by-name one — `claude`, `codex`, `grok`,
`cross-agent` — and a configured `engines.<e>.bin` is denied exactly as config
spells it. The targets are the
guard's; the forms are each adapter's `denyArgs`. Claude `Bash(<target> *)` and
`Bash(<target>)` in one appendable `--disallowedTools` array (enforced under
`bypassPermissions`, P3, and under the `dontAsk` the adapter runs in since
`docs/probes.md#t12Fix1`); Grok one `--deny "Bash(<target> *)"` per target
(enforced, P3); Codex an empty argv, because `codex exec` does not honour an
execpolicy rules file and its children rely on the sandbox's network denial
instead (P3b). Each builder is unit-tested for the exact list in its adapter's
own test file. P3 ran four targets — `claude`, `codex`, `grok` and `node
<repo>/src/server.ts` — on Claude and on Grok, in fresh sessions. T12's fix round ran
the rest on both engines: `cross-agent`, `node <repo>/src/cli.ts` and a configured
bin, beside `node <repo>/src/server.ts` and `claude`, in a fresh session, then
`cross-agent`, `node <repo>/src/cli.ts`, the bin and `grok` in that session resumed;
the engine's own permission layer refused every one (`docs/probes.md#t12Fix1`).

Sandbox facts from the probes that the adapters must respect: Codex and Grok
treat `/tmp` and `$TMPDIR` as writable, so a project there is not isolated
(`cross-agent init` warns, `src/config.ts#temporaryLocationWarning`); Codex
refuses to rewrite the worktree's `.git` pointer, Grok allows it, so tampering
is detected by `verify_worktree`, not prevented (P2). A Grok child **does**
inherit the user's MCP configuration — Grok has no per-invocation exclusion
flag, only a persistent `grok mcp` subcommand — and P9 recorded how far that
reaches (`docs/probes.md#p9Mounts`, `#p9GrokInherits`): a Grok child sees the servers in
`~/.grok/config.toml`, the servers Grok plugins bring, and the servers the
operator declared to *Claude* in `~/.claude.json`. So a `cross-agent` server
started by that child is a real, reachable server, and what makes that safe is
the specialist row it resolves to by ancestry (section 5), not an exclusion
flag.

**Child env** (`src/guard.ts#childEnv`) is a **blocklist**, not an allowlist. It
copies the parent environment and removes: the exact names `CLAUDECODE`,
`CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_PROJECT_DIR` — Claude Code sets that last
one for every MCP server it starts, and a child inheriting it would be told it
works where the operator does; anything starting with `CLAUDE_CODE_`,
`CLAUDE_PLUGIN_`, `CODEX_COMPANION_`, `GROK_CC_`, or `MCP_`; and, when `billing`
is `subscription`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`. It then
sets `CROSS_AGENT_DEPTH`, `CROSS_AGENT_TASK`, `CROSS_AGENT_LINEAGE`, and
`CROSS_AGENT_PROJECT=<canonical root>`, the last so that a server started from
inherited configuration inside the child finds the right ledger (the lead
model). The residual is inherent to a blocklist: a host variable that matches no
listed name or prefix reaches the child. That is a deliberate trade — an
allowlist would have to enumerate every variable an engine CLI needs to run,
`PATH`, `HOME`, `XDG_*`, `CODEX_HOME`, terminal and locale settings, proxy
settings, and would break silently on the next CLI release — but it means the
blocklist grows when a new host marker appears, and a new marker is a change to
this list.

Provenance, stated once: every flag in this section is backed by a recorded run
in `docs/probes.md` — P1, P2, P3, P3b, P5 and P7 on 2026-09-07, and P8, P9 and
P10 on 2026-09-09, which exercised the output formats, both lead mounts, all
three instruction paths, and `codex exec resume` — with three exceptions, each
named where it occurs. P2 for Claude ran on 2026-09-19 (`atc-s96.17`) in three
rows — the first, its rerun under `filesystem.denyWrite`, and a read-only row —
so nothing in the Claude sandbox line is a `--help` fact any more, and the
permission layer beside it — `dontAsk`, `--tools`, `--setting-sources project` and
the file tools' rules — was chosen among four candidates by run and rerun through
the product (`docs/probes.md#t12Fix1`). And the flags
no run had to
exercise — `codex exec`'s and `codex exec resume`'s full option lists, the `-`
positional each of those two heads reads stdin behind, Claude's `--effort`,
Grok's `--reasoning-effort` and its `--effort` alias,
`--system-prompt-override` and `--include-partial-messages` — are `--help`
readings, recorded with their CLI
versions in the same file (`docs/probes.md#cliFacts`; Claude Code 2.1.266, Codex
0.153.4, Grok Build 1.0.13). No other claim in this section is waiting on a
probe.

### 4. Git ownership

The worktree half of this section is built and wired: `verify_worktree` and
`src/worktree.ts` from T2, `gitMutate` from T6 (`src/gitmutate.ts`) with the
reservation, both locks and the journal, and from row 8 both tools registered on
the mode's worktree provider, for the operator and lead rows, with `path` and
`branch` defaulting from that mode's own git policy
(`src/server.ts#worktreeTools`). The root half is built on that same provider:
`git_root` and `run_command` (`src/gitroot.ts#gitRoot`,
`src/runcommand.ts#runCommand`, `src/server.ts#worktreeTools`), and the
`cross-agent git` CLI calls `gitMutate` with the options the tool passes
(`src/cli.ts#gitVerb`).

**The project's repository.** A project root is its repository's main checkout, or a
linked worktree initialized as a project of its own: a user developing several
branches at once runs one loop per branch worktree, each merging into its own branch
("Which project"). Every git tool, `run_command`, `delegate`, `cross-agent init` and
discovery's named roots locate the repository once per call, and pass what they found
on — to `trackedStateFault`, `rootWriteFault`, the discard of a one-shot and
`verifyWorktree`, which takes its identity alone (`src/worktree.ts#locateRepository`).
The answer is `main`, `linked` or `bare-linked`, with the work tree, the root's own git
directory, the common directory, the branch checked out (null when detached), the
registry, and `main`, the main checkout's path where one is known; or `none` for a root
with no `.git`, a config-only project; or `unsupported`, carrying the root's git
directory, for a root whose git directory is bare, or is its own common directory and
lies outside the root; or `refused` for everything else. The checks run in this order. The root's nesting first, and from
outside it: `enclosingWorktree` must find nothing (`#rootNotNested`), whatever the
root's own `.git` holds now, so a task's worktree whose pointer was deleted, replaced
by a repository of its own or rewritten is still refused, naming the worktree and the
work tree that registers it. A `.git` directory is a main checkout unless the root's
own git, asked without a work tree named, calls it bare — `--work-tree=<root>` would
make a work tree of a bare repository at `<root>/.git` — and then it is `unsupported`.
A `.git` file is read as a candidate only, through its `gitdir:` line and that
administrative directory's `commondir`. With no `commondir`, and `rev-parse
--absolute-git-dir` and `--git-common-dir` both naming that directory, the root is a
main checkout with a separated git directory, a submodule, or the umbrella itself —
`unsupported` (`#rootIsLinked`). A `.git` that is a symbolic link is `unsupported` too,
carrying its target, when git at the root reads that target as both its git directory
and its own common directory, the root as its top level, and nothing as bare: a main
checkout whose git directory lies outside it, as a separated main's does. Any other
link is refused (`tests/worktree.test.ts#locateRepositorySymlinkedGitUnsupported`).
That is a deliberate change: before worktree projects, task worktrees made by hand
under such a root verified and took `git_mutate`, though the git directory they share
lay outside the denied cwd; now the root's own roles launch with the link and its
target protected, and its worktree roles, one-shots and git writes are refused, as at
a separated main. Otherwise git confirms a `.git` file's candidate on explicit
directories (`src/gitmutate.ts#run`), its administrative directory sits directly in
`<commonDir>/worktrees` (`src/worktree.ts#rootAdministrativeParent`), its `gitdir`
points back at the root's pointer (`#rootGitdirBacklink`), the root lies outside the
common directory — every task is denied the whole of it, so a root inside would deny
its own tasks their workspace, and the refusal says to place worktrees beside the git
directory (`#rootOutsideCommonDir`) — and the registry lists the root, with its branch
(`#rootListed`). The registry's first stanza is then classified by its own git, never
by the listing's `bare` label (`src/worktree.ts#ownGit`): a work tree at its own top
level is the main checkout, and the root `linked`; a bare repository makes the root
`bare-linked`; and a git directory that is neither — a separated main's, which git
2.43's `get_main_worktree` names after the common directory with `/.git` stripped —
makes it `linked` with no known main. The label cannot be trusted: under
`extensions.worktreeConfig`, `core.bare` lives in the main's own `config.worktree`,
which a listing from a linked worktree does not read (`tests/worktree.test.ts#locateRepositoryKinds`,
`#locateRepositoryRefusesNested`, `#locateRepositoryRemovedPointerStillNested`,
`#locateRepositoryReplacedPointerStillNested`, `#locateRepositoryRefusesRewrittenPointer`,
`#locateRepositoryRefusesRootInsideCommonDir`, `#locateRepositoryRefusesSubmodule`,
`#locateRepositorySeparatedMainUnsupported`, `#locateRepositoryBareDirectoryUnsupported`,
`#locateRepositorySymlinkedGitUnsupported`, `#locateRepositoryBareDotGitAllowed`,
`#locateRepositorySeparatedMainWorktreeMainNull`).

`enclosingWorktree` walks a canonical candidate's strict ancestors outside-in
(`src/worktree.ts#enclosingWorktree`). An ancestor without a `.git` entry is skipped.
For one with it, the ancestor's own git decides whether it is a work tree:
`--is-inside-work-tree` must print `true` and `--show-toplevel` name the ancestor
itself, which a bare repository at `A/.git` and the umbrella's pointer to a bare
directory never do, and which a separated main does. Only then is its registry read,
from its own `.git` (`#worktreeStanzas`), and the ancestor encloses the candidate when
a stanza strictly under it is or holds the candidate, the innermost one named. Every
registration whose directory exists counts, whatever its pointer or its annotation:
git marks one `prunable` only when its pointer fails `lstat`, and never marks a
`locked` one. An ancestor whose git fails refuses, naming it and git's own words
(`tests/worktree.test.ts#locateRepositoryUnreadableAncestorRefused`). The umbrella and
a bare repository beside or holding its worktrees pass, and a root under an unrelated
work tree that does not register it passes (`#locateRepositoryUmbrellaAllowed`,
`#locateRepositorySiblingBareAllowed`, `#locateRepositoryUnrelatedAncestor`); a linked
root inside its main checkout, `M/branches/x`, is refused, and a separated main
encloses its task worktrees by its own git, whatever their pointers
(`#locateRepositoryRefusesInsideMainCheckout`, `#locateRepositorySeparatedMainEnclosesTask`).
**Ownership is proven by the ancestors' registries alone**, metadata no specialist
confined to the candidate can write: the candidate's own pointer proves only that it
is self-consistent, which a forged registry inside the candidate also is
(`#locateRepositoryRefusesForgedRegistry`, and Grok's sandbox, which leaves the
pointer writable, `src/engines/grok.ts`, section 3). A registration pruned from the
common directory is outside the rule; there the specialist row's tool set is the
backstop, as for every task. The cost is one `lstat` per ancestor and up to three git
reads per ancestor holding a `.git`, and one or two more for a linked root's first
stanza, once per call and with nothing cached across calls.

**Writes at a root that is not the main checkout are opt-in**
(`src/worktree.ts#rootWriteFault`). A main checkout takes them as it always has.
Any other root takes none without its own `.cross-agent/config.json` — an
uninitialized worktree is served as its main checkout's project, or with no main as
one nobody configured — and the refusal names `cross-agent init`; with a config, a
write also needs the root's HEAD on a branch, and that branch to be
`project.defaultBranch`, the refusal naming both and the fix. Scope `"initialized"`
asks the first question alone and covers every `run_command` at such a root, a test
run with no slug, a setup run and a worktree run included; scope `"write"` asks all
three and covers `git_root`'s journaled verbs, every `git_mutate`, before
`spawn.lock`, and `run_command`'s journaled root run. Reads, and `rebase --abort`,
which undoes a stopped rebase, need neither, and an initialized main checkout on
another branch still runs setup (`tests/gitroot.test.ts#linkedRootRuns`, run over a
linked root, a bare repository's worktree beside it and under `U/.git`, and the
umbrella's; `#bareConfiglessRefused`, `#defaultBranchMismatch`;
`tests/runcommand.test.ts#linkedRootTests`, `#noSlugTestConfiglessRefused`,
`#setupConfiglessRefused`, `#initializedNonMainRunsSetup`,
`#mainOnOtherBranchRunsSetup`, `#linkedRootWorktreeRun`).

**`delegate` lets the located repository decide the launch.** A `refused` root — inside
a worktree its enclosing work tree registers, inside its own git directory, or with a
`.git` that does not verify — launches nothing
(`tests/delegate.test.ts#refusedRepositoryRefusesLaunch`). An `unsupported` root
launches root roles as it always did, read-only and with the tracked-state check
skipped, and refuses one-shots and worktree roles; a root with no `.git` keeps
launching. The paths a launch's sandbox must refuse are computed at every launch,
resumes included (`src/delegate.ts#protectedPathsFor`):

| root kind | root roles and their continuations | worktree roles and one-shots |
|---|---|---|
| main | none: the role's own read-only rule denies the root's `.git` with its cwd | `<wt>/.git` and the common directory |
| linked or bare-linked | the root's `.git` and the common directory, which lies outside the denied cwd | `<wt>/.git`, the common directory and the root's `.git` |
| unsupported | the root's `.git` and its own git directory | refused |

A Claude role reads them as `denyWrite` rules and `Edit` deny rules
(`tests/engines/claude.test.ts#readOnlyLinkedRootDenies`); Codex's read-only and
workspace-write sandboxes deny the paths without being told, and Grok's cannot take a
per-path rule (section 3). Two projects of one repository delegate side by side, each
in its own worktree directory, ledger and journals, sharing one `info/exclude` and the
repository lock (`tests/delegate.test.ts#protectedPathsLinkedRoot`,
`#oneShotInLinkedRoot`, `#oneShotBareConfiglessRefused`, `#twoProjectsOneRepository`,
`#consultAtSeparatedMainLaunches`, `#consultAtSymlinkedGitLaunches`).

Specialists never write git metadata. A linked worktree's `.git` is a file
inside the implementer's workspace — Claude's sandbox and file tools and Codex's
sandbox refuse a write to it, Grok's sandbox does not (P2, `docs/probes.md#t12Fix1`)
— so the lead never trusts it:
`git_mutate` (and the identical `cross-agent git <slug> -- <args>` CLI,
`src/cli.ts#gitVerb`) is the only way a lead mutates git in a worktree. Its
request is `{slug, path?, branch?, args}` (`src/gitmutate.ts#GitMutateRequest`):
`path` defaults to `<root>/<git.worktreeDir>/<slug>` and `branch` to the mode's
`git.branchPattern` with the slug in place of its one `*`, which the tool passes
from the active mode and which fall back to `.worktrees` and `task/*` for a
caller that has no mode to hand (`src/gitmutate.ts#gitMutate`,
`#GitMutateOptions`, `src/server.ts#worktreeTools`). The
slug is used for exactly four things — those two defaults, the lock's
operation label, and the journal file name — and never for the git directory.
Before the four steps, the **shape of the request** is judged, because it needs
no lock, no scan and no worktree (`src/gitmutate.ts#gitMutate`): `args` must be
a non-empty array of strings whose first element is a subcommand, not an option;
no element anywhere may be `--git-dir`, `--work-tree`, `-C` or `-c`, nor the
attached forms `--git-dir=` and `--work-tree=`
(`src/gitmutate.ts#globalOptions`, `#argumentFault`), each of which turns a
whitelisted verb into an arbitrary one against an arbitrary repository; and
`slug`'s journal must be readable, so the step it will append is known to be
recordable before anything runs. The repository is located then too, and a root that
is not its main checkout must take the write (`rootWriteFault`'s `"write"` scope,
above), before any lock is taken. The four steps then run with `spawn.lock` held
for all of them (`src/gitmutate.ts#gitMutate`), which is what stops the
reservation `git_mutate` reads in step 1 from racing a `delegate` about to take
the same workspace (section 2). Inside that lock, and only inside it, the
journal is read again and its recorded branch must equal the one this call names
(`src/gitmutate.ts#mutate`, section 7): two first calls on one slug, each
reading outside the lock, would both find no journal and both commit, on two
different branches. It

1. refuses while any task reserving that path is not settled — `<path> is
   reserved by task <id> (<status>); wait or cancel first` — and refuses every
   path at all while any task record cannot be read, naming each file and its
   reason (`src/gitmutate.ts#mutate`, section 2). A fault in the directory
   holding those records rather than in one of them — a mode nothing may read,
   a file where the directory belongs — refuses the same way and carries the
   operating system's own words: every stop a mutation can meet reaches the
   lead as a reason, and none of them as an exception (bead `atc-s96.40`);
2. verifies the worktree from the root, with the checks
   `verifyWorktree` performs (`src/worktree.ts#verifyWorktree`), the repository's
   identity taken from the call's own location of it: `realpath` of both paths, a
   relative worktree path read against the project root and never the server's own
   directory; the worktree appears in a `git worktree list --porcelain -z` taken on
   every call — `delegate` locates the repository before its `worktree add` and
   verifies after it — as a linked worktree, which excludes the main worktree and any
   subdirectory (`#linkedWorktree`); it lies strictly under the project root
   (`#underProjectRoot`), so a sibling project's root and its tasks are not this
   project's; no stanza strictly under the root encloses it (`#notNestedWorktree`),
   and no stanza at or above the root is read, since the root's own nesting was
   settled when its repository was located — a bare main, labelled or not, encloses
   every task (`tests/worktree.test.ts#verifyWorktreeContainment`,
   `#verifyWorktreeIgnoresStanzasAboveRoot`, `#verifyWorktreeFreshListing`); its `.git`
   is a regular file, not a symlink (`src/worktree.ts#pointerIsFile`); `git
   rev-parse --git-dir` resolves to a directory whose **parent** is
   `<commonDir>/worktrees` (`#administrativeParent`) — the check is on the parent directory,
   not on equality with a slug-derived name; `--git-common-dir` equals the
   repository's common directory (`#commonDirectory`); `--abbrev-ref HEAD` is exactly the requested
   branch (`#branchMatches`); and the administrative directory's own `gitdir` backlink resolves
   to that worktree's `.git` and no other (`#gitdirBacklink`), which is what rejects a
   pointer redirected at a sibling. On success it returns `{gitDir, workTree,
   branch, commonDir}` (`#verifiedResult`); a refusal is returned to the lead as the verifier's own
   `reason`, verbatim (`src/gitmutate.ts#mutate`). **One argv is verified
   differently**, because the branch check would otherwise refuse the only
   command that can undo a stopped rebase: a rebase that stops on a conflict
   leaves HEAD detached, so for `args` exactly `["rebase", "--abort"]` the
   requested branch is the detached `HEAD` — a name git will not take for a
   branch — and git's own rebase state must name this journal's branch, as
   `<gitDir>/rebase-merge/head-name` or `rebase-apply/head-name`
   (`src/gitmutate.ts#abortsRebase`, `#rebasing`, `#mutate`). Every other check
   still has to pass, the step is recorded against the branch that file names,
   and a HEAD detached for any other reason is refused as before. This is the
   conflict path of the loop below: the rebase runs **in the worktree**, so its
   abort does too, and `git_root rebase --abort` covers only a rebase started at
   the root, which the loop never does;
3. runs, while `.cross-agent/locks/git.lock` and, inside it, the repository lock
   are held, `git --git-dir=<the gitDir verify_worktree returned> --work-tree=<the
   workTree it returned> <args>`, so the pointer file is never consulted and the paths are never
   re-derived from the slug (`src/gitmutate.ts#run`, `#mutate`). It is
   `execFile` with an argv array, never a shell, with `cwd` the verified work
   tree and the **allowlisted** git environment of the paragraph below
   (`src/gitmutate.ts#run`). Output is capped at 16 MB
   (`src/gitmutate.ts#maxBuffer`): exceeding the cap kills the child, which for
   a mutation is worse than a truncated log;
4. appends the step to the task journal (section 7) with the SHAs around it —
   `git rev-parse --verify --quiet refs/heads/<branch>` through the same
   explicit form, before and after the command, and the default branch's SHA as
   this step's own `defaultSha` (`src/gitmutate.ts#revision`, `#mutate`). The
   step is named for what it completed — `committed` for a `commit`, `rebased`
   for a `rebase`, and `git` with the arguments it ran for anything else
   (`src/gitmutate.ts#stepName`, section 7's table). Of the document's own
   fields it writes the branch names and, on a journal this call creates, the
   work tree the verifier resolved (`src/gitmutate.ts#mutate`): the pre-merge
   SHA and the branch head belong to the `merged` step alone, for the reason
   section 7 gives. The append happens **while the lock is still held**
   (`src/gitmutate.ts#mutate`), so two callers' steps are ordered by the same
   lock that ordered their commands.

The result is `{ok: true, exitCode: 0, stdout, stderr, before?, after?,
lockLost?, journal}` or `{ok: false, reason, exitCode?, stdout?, stderr?}`
(`src/gitmutate.ts#GitMutateResult`); `journal` is the entry as written, so the
lead never re-reads the file to learn what it just recorded. A refusal before
the command carries a reason and nothing else. A non-zero git exit returns the
exit code and both streams and journals nothing (`src/gitmutate.ts#mutate`), and
so does a `GitRunError` — but **that is not a claim that nothing happened**. A
`worktree add` — a root operation, so through `git_root` — that failed while
checking out has already created the directory and its administrative entry
under `.git/worktrees`; a `rebase` that stops on a conflict leaves the worktree
mid-rebase and `REBASE_HEAD` on disk; a `merge` stopped on conflicts leaves an
index full of them; a command killed by the 16 MB cap was killed at whatever
point it had reached. The step is not journaled because `git_mutate` cannot say
which of those it was, and a journal of steps that may not have happened is
worse than a gap. So **any** `ok: false` is a **reconciliation trigger**,
whether or not it carries an exit code — a `GitRunError` carries none, and it
is the answer for the killed and part-way cases above: the lead reads the
reason, the exit code if there is one and the streams, and reconciles the
worktree by section 7's rules — `git status --porcelain`, `git worktree list`,
the rebase state, the journal — before it does anything else with that slug. A
journal write that fails **after** a successful command returns `ok: false`
saying the command ran and its step could not be written
(`src/gitmutate.ts#mutate`) — `ok: true` would tell the lead its journal is
current when it is not, and the result type has no honest slot for "it happened
but is unrecorded".

**What git works on is decided here, never inherited.** Every git invocation
in this project — the verifier's reads and `git_mutate`'s command alike —
gets one **allowlisted** environment, built in `gitEnvironment`
(`src/worktree.ts#gitEnvironment`, `#passedVariables`, `#passedPrefixes`, used
in `#git` and `src/gitmutate.ts#run`): `PATH`, `HOME`, `USER`, `LANG`, `LC_*`,
`TZ`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `SSH_AUTH_SOCK`,
`GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `GIT_SSH*` and `GIT_TERMINAL_PROMPT` pass,
and so do git's own two documented fallbacks: `EMAIL`, which git uses when no
author or committer address is set, and `GIT_EXEC_PATH`, without which a git
installed outside its default prefix cannot find its own subcommands. Everything
else is dropped: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
`GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`,
`GIT_CEILING_DIRECTORIES` and `GIT_CONFIG_*`. A server started from inside a git
command — a hook, `git rebase --exec` — carries those, and they would put
back exactly the `-c` settings the argument guard refuses, or point a verified
mutation at another index or object store. An allowlist rather than a deny list,
so a variable nobody has thought about does not reach git. It is also the fix
for the bug this found (`atc-s96.35`, closed): with `GIT_DIR` inherited, `git -C
<worktree> rev-parse --git-dir` answered with the inherited value and the
verifier refused *every* worktree. It failed closed, so it was never a hole,
but the lead could do nothing at all.

One residual is stated rather than hidden: there is no timeout on the git
child, so a command that hangs — a hook that never returns — holds `git.lock` and
the repository lock until it is killed. Every other mutation of the project then
waits `lockWaitSeconds` and refuses, and every git write of the repository's other
projects waits the repository lock's sixty seconds or more and refuses, naming the
lock; such a refusal is retryable after the loop's reconciliation. The call cannot be
cancelled from inside: `gitMutate` holds `spawn.lock` for the whole call, and
`cancel` needs that same lock. The README gives the operator's recovery: find the
hung git by its command line, `--work-tree=<the task's worktree>`, since no
`CROSS_AGENT_*` variable reaches git; end that process tree, hooks included; then
`cross-agent tasks --reconcile` and `cross-agent journal <slug>`, which say whether
the step landed.

`git_mutate` never throws for an operational failure. A missing git binary or
a signal-killed child has no exit code to judge, so it is named as its own
refusal; a lock that could not be taken, and a config that could not be read,
are refusals too (`src/gitmutate.ts#GitRunError`, `#run`, `#gitMutate`,
`#mutate`). The lead's loop reads a result and has no other way to hear one. And
a lock **lost** while the command ran (section 2: the helper child died, so the
kernel let the next waiter in) does not undo the command: the step is still
journaled, and the result carries `lockLost: true`
(`src/gitmutate.ts#GitMutateResult`, `#mutate`), so the lead knows the mutation
happened but was not exclusive for all of its life. **Any** lock's loss is
reported — `spawn.lock` guards the reservation this call passed, `git.lock`
the command against the project's other mutations, the repository lock the command
against the repository's other projects, and a caller told about only one would
draw the wrong conclusion from another's silence.

The lead creates the worktree after plan approval, commits the task branch
with the implementer's summary, rebases it, merges with `--ff-only`, runs the
tests on `<default>`, removes the worktree, deletes the branch. On a rebase
conflict the lead aborts the rebase and escalates to the user (narrowed: a
validated conflict-edit mode is a later enhancement). The flow per task: plan
(root), plan review (root), worktree, implement, lead commit, code review,
needs-work round through `resume`, lead commit, ready, merge. Branch-scoped
metadata grants are not part of this plan.

Every root operation — create the worktree, merge, run the tests, remove the
worktree, delete the branch — runs through `git_root` and `run_command` under
**both** placements, so the journal is complete under both (plan decision 4):
the two tools are the worktree provider's, registered whenever the mode
declares a worktree role and offered to the operator and lead rows alike
(`src/server.ts#worktreeTools`, `#projectTools`). Under `placement: engine`
that is also the lead's only reach at the root, because it has no write access
there. Under a Codex host the lead's own
sandbox protects `.git` too, so `git_mutate` calls made by a Codex lead need
that host's approval escalation, as EVIDENCE.md recorded for the 0.4.0 Codex
lead.

**Git the operator runs by hand** takes no lock of this project's, so while a
project's loop runs it can interleave with the loop's own steps as well as collide
with them. Git's own `.lock` files make a collision fail, to be retried; an
interleaving goes undetected: `git_root merge` checks HEAD and merges in two git
processes, and a `checkout` landing between them would put the merge on the branch
it checked out. So the operator's cooperating path is the two CLI verbs: root git
through `cross-agent git-root [--slug <slug>] -- <args…>`, which calls `gitRoot`
with the options the tool passes and so has the same whitelist, journal rules,
`rootWriteFault`, `git.lock` and repository lock (`src/cli.ts#gitRootVerb`), and
worktree git through `cross-agent git <slug> -- <args…>`. No `checkout`, `branch -f`
or `reset` is run by hand at a root while its loop runs. What remains is stated: a
plain git command outside these verbs can still interleave.

**`git_root`.** `gitRoot(root, {args, slug?}, options)`
(`src/gitroot.ts#gitRoot`, `#GitRootRequest`, `#GitRootOptions`). `args` is one
whitelisted verb **in the shape it is whitelisted in**: `worktree add -b
<branch> <dir> <base>`, `worktree remove <dir>`, `branch -d <branch>`, `merge
--ff-only <branch>`, `rebase --abort`, or the read-only `status`, `log`,
`rev-parse`, `rev-parse --abbrev-ref HEAD` — the branch the root has checked out,
what the loop's first step reads, matched before the generic `rev-parse`, which still
refuses `HEAD` — `merge-base`, `branch --list`, `worktree list` (`tests/gitroot.test.ts#revParseHead`). The whitelist is
the whole security argument for handing an engine any root git access at all,
so it is a fixed list in code, never config (`src/gitroot.ts#whitelist`), and it
carries each verb's own grammar: the options it accepts — `--porcelain`,
`--untracked-files=<mode>`, `-z`, `--oneline`, `--max-count=<n>`, `--verify` —
and the positionals it takes, so `worktree add` without `-b` is not this verb
and `--force` belongs to none of them (`src/gitroot.ts#parse`). No
global git option is accepted anywhere in `args` — `-c`, `--git-dir`,
`--work-tree` and `-C`, and the attached forms — because each of them turns a
whitelisted verb into an arbitrary one against an arbitrary repository
(`src/gitroot.ts#argumentFault`, `src/gitmutate.ts#globalOptions`). Every path
argument resolves under the mode's own worktree directory, which itself resolves
under the project root, with what exists of the path resolved through
`realpath` first, so a symlinked worktree directory is the same escape as a `..`
and is refused as one; a worktree this tool creates sits **directly** under that
directory, the `<worktreeDir>/<slug>` shape `git_mutate` defaults `path` to,
because a worktree nested inside another is a tree the outer one's own git would
then see (`src/gitroot.ts#within`, `#resolveExisting`). What was judged is what
runs: the directory positional git is given is the resolved path, not the token
the caller wrote (`src/gitroot.ts#execute`). **Every** branch argument matches
the mode's `branchPattern` — a new task branch, and the branch a merge or a
delete names, whatever its journal records — or, for a read, is the default
branch; a `<base>` is the default branch and nothing else
(`src/gitroot.ts#judge`, `#matchesPattern`). `git_mutate` takes any branch its
caller names, and its unbounded `args` reach the same ref store through the
worktree's git-dir, so this whitelist bounds `git_root` and says nothing about
what a worktree mutation can do.

**The journal is selected by `slug`, never inferred**, and it is authoritative
for its own branch and path (`src/gitroot.ts#journalFault`): `worktree add`
takes a slug with no journal yet, or one with no `worktree-created` step, and
creates the journal on that branch and that directory; `merge --ff-only
<branch>` and `branch -d <branch>` require `<branch>` to equal the slug's
recorded `branch`, and `worktree remove <dir>` requires `<dir>` to resolve to
its recorded `worktree` — which is how a journal `git_mutate` bound to a
worktree carrying another name's branch is still merged and cleaned up under
the name it recorded. A second `merged` step is refused before git runs, as the
journal itself refuses one after (section 7). **A closed journal is terminal**: every
journaled verb is refused on a journal holding a `branch-deleted` step, and `worktree
remove` after a `worktree-removed` one, naming the slug and the closing step. A closed
journal still names its branch, and a branch of that name now — a later task's of
this project, or a sibling project's that reused the name — is no task of it, so a
project retrying a finished cleanup would otherwise delete or merge another's
(`tests/gitroot.test.ts#closedJournalReusedNameTwoProjects`, `#closedJournalRepeatedDelete`,
`#worktreeRemoveTwiceRefused`). A verb that journals nothing —
the read-only set and `rebase --abort` — takes **no** slug, because silence
would let a lead believe its read was recorded (`src/gitroot.ts#gitRoot`).

The verb runs from the project root, in the same explicit form and the same
allowlisted environment as `git_mutate`'s — `git --git-dir=<the root's own git
directory> --work-tree=<root> <args>`, `<root>/.git` at a main checkout and its
administrative directory at a worktree project, `execFile` with an argv array and
never a shell, capped at 16 MB (`src/gitmutate.ts#run`,
`src/worktree.ts#locateRepository`). The root is located from outside it: a root
inside a worktree that an enclosing work tree's registry lists is refused naming both
— a server started inside a task's worktree is told which work tree to serve instead
— whatever that worktree's own pointer holds, and `run_command` locates the
repository the same way (`tests/gitroot.test.ts#linkedWorktreeRoot`, bead
`atc-s96.50`); a journaled verb at a root that is not the main checkout is held to
`rootWriteFault`'s `"write"` scope. It runs under `.cross-agent/locks/git.lock`, and
the journal's own checks, the command and the step all happen inside that one lock,
so two first calls on one slug cannot both find no journal and both create a
worktree (`src/gitroot.ts#execute`); a journaled verb and `rebase --abort` take the
repository lock inside it, so no other project of the repository runs git between
the merge's check of HEAD and the merge, which are two git processes. **One verb takes `spawn.lock` first**, in
the standing order: `worktree remove` takes a workspace away, and git removes a
clean worktree whatever is running in it, so that verb reads the reservation
`git_mutate` reads and refuses in the same words — `<path> is reserved by task
<id> (<status>); wait or cancel first`, and every path at all while any task
record cannot be read (`src/gitroot.ts#reservationFault`, `#gitRoot`, section
2). It is held across the reservation read and the removal, which is what stops
a `delegate` from taking that workspace in between. Every other verb reads no
reservation and takes no `spawn.lock`, because it takes no workspace away: the
project root is no task's to clear.

The result is `{ok: true, exitCode: 0, stdout, stderr, before?, after?,
journal?, lockLost?}` or `{ok: false, reason, exitCode?, stdout?, stderr?}`
(`src/gitroot.ts#GitRootResult`), with `before` and `after` the default branch's
SHA around the call and `journal` the step as written. A non-zero git exit
journals nothing and is a reconciliation trigger like any other `ok: false`, and
a journal write that fails after a successful command returns `ok: false`
saying the command ran and its step could not be written
(`src/gitroot.ts#execute`). Each journaled verb appends its own named step —
section 7's table says which — and `merge --ff-only` is the one that also
writes the journal's two merge fields, from `before` and from the branch head
read in that same locked call. That merge is refused unless the root's own HEAD
is the default branch (`src/gitroot.ts#execute`): `merge` merges into HEAD,
while both merge fields are read from the default branch, so a merge taken
anywhere else would journal a revert range that never existed.

**Both root tools and `delegate` refuse to work in a project that tracks its own
`.cross-agent/`** (`src/gitroot.ts#trackedStateFault`, `#gitRoot`,
`src/runcommand.ts#runCommand`, `src/delegate.ts#delegate`). What they run and what they journal are read
from files there — `testCommand`, a slug's journal — and the command string
being "config only" is safe exactly while a specialist cannot commit a change to
it. With `.cross-agent/` tracked, an implementer's own commit inside its
worktree reaches the default branch through the lead's merge, and the lead then
runs it at the root. The check is `git ls-files --error-unmatch --
.cross-agent` at the root, and the refusal names `.gitignore`, because that is
the repair. `cross-agent init` writes those entries — `.cross-agent/` and the
worktree directory this mode's tasks use, its own where it declares one and this
build's where it does not — appending only what the file lacks, so the verb
that creates the state is the one that ignores it
(`src/config.ts#ignoreProjectState`, `#initConfig`, `src/cli.ts`).
`delegate` runs the same check at the launch boundary, because it reads that
config on every call and hands the deny targets, the billing mode and
`engines.<e>.bin` from it to the runner: a config that somehow reached the root
is never acted on. `verify_worktree` and `git_mutate` need no such check:
neither reads a configured command, and a worktree mutation is already confined
to the branch its journal names.

**Nothing the project keeps for itself arrives by merge.** Every check above
reads the **root's** own state, and until the merge nothing reads the tree that
is about to arrive — which is the one path a specialist has to the root. A
`.gitignore` it writes in its own worktree outranks the repository's shared
`info/exclude`, so `git add -A` there stages `.cross-agent/`, the lead's commit
carries it, and a fast-forward lands it at the root. So `merge --ff-only`
refuses, before git merges anything, when `git diff --name-only
<defaultBranch>...<ref> -- .cross-agent <worktreeDir> :(icase).claude
:(icase).codex :(icase).grok :(icase).mcp.json` names any path — the last four
are a host's project configuration, the next paragraph's — and the refusal lists
every one (`src/gitroot.ts#smuggled`, `#execute`). Two rules back it
up: the loop's own commit step is `git_mutate ["add", "-A", "--", ".",
":(exclude).cross-agent", ":(exclude).worktrees"]`, so the ordinary case never
stages either directory (`skills/cross-agent/SKILL.md` for a one-shot, with the
mode's own `git.worktreeDir` in place of the literal, and
`modes/dev-team/SKILL.md` step 6; section 7); and `delegate`'s
check above means a config that did reach the root is still never read as one.

**Nor does a host's project configuration.** `.claude/` and `.mcp.json` are
where Claude Code reads a project's settings, hooks and MCP servers, `.codex/`
where Codex reads a project's configuration, `.grok/config.toml` where Grok
reads a project's plugins and servers (section 9), and each host reads them in
the operator's own session, outside any sandbox. A writable specialist can add
one in its worktree, or un-ignore `.grok/` where the README's recipe ignores it,
and the loop's step 6 stages it; until this build the diff a code reviewer read
was the only thing that would catch it. So the four paths are one list
(`src/gitmutate.ts#hostConfigPaths`), matched in any case — a host on a
filesystem that ignores case reads `.Claude/` as `.claude/` — and as those names
alone, so `.claude-plugin/`, `.claude.json`, `.mcp.json.bak` and a `.mcp.json`
below the root pass (`#hostConfigPathspecs`), and both git tools read it. The
root merge is the gate: `merge --ff-only` diffs the four beside `.cross-agent`
and the worktree directory, so whatever a branch carries, however it came to
carry it, is refused there, every path named (`src/gitroot.ts#smuggled`;
`tests/gitroot.test.ts#mergeRefusesHostConfig`, `#mergeHostConfigAnyCase`,
`#mergeNamesEveryPath`). `git_mutate`'s refusal of a `commit` is the early
warning, where the lead can still have the file taken out:
`git status --porcelain --untracked-files=all` over the four names anything in
the worktree — staged, changed or untracked — and `git ls-files -v` any tracked
one marked assume-unchanged whose working-tree bytes differ from its index
entry, a change the mark hides from that status while a commit naming the path
records it. The mark alone carries nothing, since git marks every tracked file
so under `core.ignoreStat`, and both reads are taken under `git.lock` before the
command runs (`src/gitmutate.ts#hostConfigFault`, `#carriedUnder`,
`#differsFromIndex`, `#mutate`; `tests/gitmutate.test.ts#commitRefusesHostConfig`,
`#hostConfigAnyCase`, `#commitRefusesAssumeUnchanged`,
`#commitUnderIgnoreStat`). **Host configuration must be regular files.** A symbolic link at any
of the four root paths, or anywhere below them, is refused by name even when
unchanged. At a worktree commit the check reads the commit's current tree
(`HEAD`), the index and the working tree, including ignored links. At the
root's merge it reads the incoming branch's tree. No link target is followed:
the operator must replace links with regular files, by hand at the root for
tracked configuration, before retrying
(`src/gitmutate.ts#hostConfigFault`, `#hostDiskLinks`, `#hostTreeLinks`,
`src/gitroot.ts#smuggled`; `tests/gitmutate.test.ts#commitMarkedSymlink`,
`#commitGuardsLinkReferent`, `#commitHostLinksEveryView`,
`#commitHostLinkTraversalClass`, `#commitRefusesOutsideLink`;
`tests/gitroot.test.ts#mergeGuardsLinkReferent`, `#mergeHostLinkTraversalClass`,
`#mergeRefusesOutsideLink`). This closes the link-traversal class for every link
the branch or the worktree carries — directory aliases and targets whose `..`
cancels a link component included — because the link itself is refused and no
target is read. It is a boundary, not a walk of everything the operator's own
configuration refers to: a host link the operator keeps at the root, excluded and
untracked, that aliases a tracked path is outside it — a change to that tracked
path commits and merges like any other, and the root's host then loads it, the
same way this repository's own plugin runs the tracked `src/server.ts`. The guard
keeps a task from *placing* host configuration at the root; it does not police what
the operator's existing root configuration points into the tree. So the operator
keeps the root's own host configuration as regular files too. A disk link's name is
read as bytes, so one whose name is not valid UTF-8 is still refused
(`tests/gitmutate.test.ts#commitHostLinkNonUtf8`).
The tree read lists only the four host pathspecs, never the whole tree; because
`ls-tree` does not support case-insensitive pathspecs, it uses `diff-tree`
against the empty tree to read modes under those four instead
(`src/gitmutate.ts#hostTreeLinks`,
`tests/gitroot.test.ts#mergeListsOnlyHostPaths`). The existing byte and
symlink-mode checks for assume-unchanged entries remain; a link replaced while
that check reads it differs rather than throwing, and a path that is both a change
and a link is named once, as the link
(`tests/gitmutate.test.ts#linkReplacedMidCheck`, `#commitMarkedSymlink`).
The commit check does not see a git alias for
`commit`, a `merge`, `cherry-pick`, `revert` or `am` run in the worktree, or
`commit --amend` over an older commit that already carries one; the merge
refuses each of those. A removal of a tracked one is carried the same way, in a
commit as in a merge: a server or a hook taken away changes the operator's
session as much as one added. The commit's rule reads the worktree rather than
the index because `commit -a`, `commit --include` and a pathspec commit record
what the index does not hold; the price is that an untracked regular host file
`.gitignore` does not cover blocks a commit even unstaged, and the refusal says
what clears it: remove the file, ignore it if it is the operator's own, or clear
its assume-unchanged mark. Git sees no empty directory, so an empty `.claude/`
subdirectory an engine leaves in a worktree — the T13 sample's root holds an
empty `.claude/.cc-writes/` — is never refused. Both team loops name the four
where they say what step 6 and step 9 refuse
(`tests/skills.test.ts#loopsNameHostConfig`). A project that tracks one of the
four changes it by hand at the root, never through a task. `AGENTS.md` and
`CLAUDE.md` were considered and are not in the list: a host reads them as
instruction text and starts nothing from them, and they are ordinary team edits
the code reviewer reads in the diff. The same guard bounds a Claude specialist's
own settings: Claude Code merges the project's tracked `.claude/settings.json`
into every Claude role, section 3 accepts the file-tool allow rules and
additional directories it may hold as a limitation of that merge, and with
`.claude/` out of every task's reach only the operator or the project's history
puts them there.

**`run_command`.** `{which: "test" | "setup", where: "root" | <a verified
worktree path>, slug?, timeout_seconds?}` as the wire spells it,
`runCommand(root, request, options)` in code (`src/runcommand.ts#runCommand`,
`#RunCommandRequest`, `src/server.ts#worktreeTools`) — a **selector, never a
command string**, so no argument the lead composes ever reaches a shell. What runs is the
project's configured `testCommand` or `setupCommand` through `sh -c`, with
`cwd` the project root or the verified worktree, the returned output tail capped
at 64 KB and the run at `timeout_seconds` (default 600, and no more than
`maxTimeoutSeconds`, because a `setTimeout` delay is a 32-bit millisecond count
and anything above it fires at once) (`src/runcommand.ts#tailBytes`,
`#defaultTimeoutSeconds`, `#maxTimeoutSeconds`, `#shell`). The cut is by byte
and the output is text, so the tail steps over the continuation bytes of a
character the cap landed inside (`src/runcommand.ts#shell`). The child
is a **process-group leader** and the timeout kills the group, not the leader
alone, because a suite that backgrounds a server would otherwise outlive the run
that started it; a run killed that way is `ok: false` and carries no exit code
to judge, but it still carries its `tail`: the last thing a hanging suite said
is what a lead has to report. It takes **no lock**: `git.lock` serializes git mutations against each
other, and holding it for a suite that may run for ten minutes would refuse
every mutation in the project for as long as the tests took. A configured value of `"none"` is a no-op success, which is what this
project's own `setupCommand` is, and it completes no step: `tests-passed` would
claim a suite passed that never ran.

The child environment is the specialist's own — the host markers a nested
engine must not inherit are gone, and so are the API keys under subscription
billing — with two differences: the command is **not a task**, so it carries no
`CROSS_AGENT_TASK` and no lineage, and the depth it carries is one below its
caller's, which is what makes a `cross-agent` server started inside a test suite
a specialist rather than the operator; and the variables that redirect git —
the ones `gitEnvironment` drops — are dropped here too, because a suite that
runs git would otherwise be pointed at another repository, index, object store
or configuration by whatever the server inherited
(`src/runcommand.ts#commandEnv`, `#redirectingGit`, `src/guard.ts#childEnv`,
`src/worktree.ts#gitEnvironment`, section 5). `where: "root"` runs at the located
repository's work tree. A worktree `where` is verified exactly as `git_mutate`
verifies it, against the repository this call located, with the branch taken from the
journal of the `slug` the call names — **required** there, because a worktree may
carry another slug's branch and the lead does not get to say which branch a directory
is on — and the journal's recorded path must be that worktree, where it then runs
(`src/runcommand.ts#runCommand`). At a root that is not its repository's main
checkout both kinds of `where` need the project initialized there, and the run that
journals needs `rootWriteFault`'s `"write"` scope as well (above).

The result is `{ok: true, exitCode, tail, journal?}` or `{ok: false, reason}`
(`src/runcommand.ts#RunCommandResult`). **A failing suite is an answer, not a
refusal**: it is where section 7's repair path starts, so the exit code and the
tail come back with `ok: true` and no step. The one step this tool completes is
`tests-passed`, and only for `which: "test"`, `where: "root"`, a `slug` whose
journal holds `merged` and no `tests-passed` yet, and a run that exits zero. The
journal is checked **before** the suite runs, because a run that could not be
journaled is worth knowing about before it takes ten minutes; a root run with no
slug runs and journals nothing; and a `setup` run at the root takes no slug at
all, since nothing it does completes a step (`src/runcommand.ts#runCommand`).

### 5. Loop guard

Scope, to be restated in the README by Task 1c: no delegation loop can form
through `delegate`;
direct engine launches from specialists are denied for exactly the deny-list
forms of section 3 at each CLI's own permission layer (Claude and Grok), or
cannot reach a model API (Codex, network denied by its sandbox). A specialist
that defeats its own CLI's permission rules (a copied binary, a wrapper
script) is outside the guarantee, as it is for OpenMausBot. Layer 1 is built:
the server resolves its row by ancestry on every request and offers exactly
that row (`src/authority.ts#resolveAuthority`, `src/server.ts#createServer`).
Layer 4's builders and parsers in `src/guard.ts` are wired: `delegate` reads the
lineage it was given, refuses a repeat, refuses a duplicate and binds a resume,
and it is `childEnv` and `denyTargets` there that prepare every child's
environment and every engine's deny list (`src/delegate.ts#delegate`). Layers,
each with its own unit test:

1. **Authority by ancestry; depth is a cap, not a second opinion.** Ancestry
   decides the row a server *may* receive — operator, lead, or specialist —
   by the nearest matching engine ancestor ("The lead model" above). Depth then
   caps it: at depth ≥ `maxDepth` the row is forced to specialist whatever the
   walk found, and so it is when `CROSS_AGENT_DEPTH` is malformed, or absent
   while `CROSS_AGENT_LINEAGE` is present (`src/guard.ts#readDepth` already
   reads it that way, returning `Infinity` for both). The effective row is the
   **lower of the two**, and the server offers exactly that row of the
   permission matrix; a call to a tool outside it is refused at `tools/call` by
   name, with the reason — by this server's own tool name, whatever prefix or
   folding a host applies to it on the way in ("The lead model", the permission
   matrix).

   `maxDepth` comes from the **active mode**, not from a constant: a mode
   with `placement: engine` needs 2, because its lead runs at depth 1 and the
   lead's specialists at 2; every other mode needs 1. `limits.maxDepth` in
   config may only lower that value, never raise it. Raising the cap to 2
   does not hand `delegate` to anyone new, because ancestry is primary: a
   server a depth-1 specialist starts — the Grok inheritance case — matches
   that specialist's own record and gets the specialist row at any cap. The
   cap exists to bound a chain whose ancestry the walk could not read, which
   is why it fails closed.

   The depth read is the server's own `CROSS_AGENT_DEPTH`, and the cap is now
   the mode's: `effectiveMaxDepth` takes 2 under `placement: engine` and 1
   otherwise, lowered by `limits.maxDepth` where that is smaller and never
   raised by it, and the entry point hands the resolver that number beside the
   mode's `lead.role` (`src/config.ts#effectiveMaxDepth`, `src/server.ts#main`).
   Because the two are combined by taking the lower, a config written for a
   host-placed mode would hold an engine-placed lead's specialists at depth 1,
   so `cross-agent init` writes the cap its mode needs
   (`src/config.ts#initConfig`), and `delegate` refuses to launch an
   engine-placed lead the cap would hold to the specialist row
   (`src/delegate.ts#engineLead`). Every record carries its own `depth`, written
   by `delegate` as the caller's plus one, and its lineage is the caller's server's
   own `CROSS_AGENT_LINEAGE` with the new entry appended (`src/ledger.ts#TaskRecord`,
   `src/delegate.ts#delegate`), so a finished run can be checked against the
   mode's cap as well as each call. Both come from **the server's own
   environment**, never from the walk, which decides the row alone
   (`src/authority.ts#resolveAuthority`, `src/guard.ts#readDepth`): a server an
   engine starts in an environment of its own resolves its lead at depth 0 and
   records the lead's children one too shallow with no lead in their lineage. So
   every lead engine's mount has to carry the markers: Claude's server inherits
   them, and Codex's mount names them in `env_vars`, its values the engine's own
   (`docs/probes.md#e2ServerEnv`, `src/engines/codex.ts#codex`). The ledger's
   depth-and-lineage reading of an end-to-end run is the proof, because the
   verifier's depth check is an upper bound and cannot see a child recorded one
   level too shallow (`docs/probes.md#e3`, `#e2`). The specialist row is the four read tools
   plus `describe_mode`, and all five are registered
   (`src/server.ts#projectTools`); the matrix's rows replaced `toolsAtDepth`, the
   depth-only tool list that used to approximate it.
2. **No self-mount**: `--strict-mcp-config` without this server, beside
   `--setting-sources project`, for Claude,
   `--ignore-user-config` for Codex, and nothing for Grok, whose headless CLI has
   no `--plugin-dir` at all — only `grok agent` does (`docs/probes.md#t15Attach`). Grok
   specialists **do** reach a server, because Grok has no per-invocation
   exclusion flag (`src/engines/grok.ts#exclusionArgs` returns an empty list),
   and P9 recorded exactly what a Grok child inherits: the operator's
   `~/.grok/config.toml`, the operator's Grok plugins, and the servers the
   operator declared to Claude in `~/.claude.json` (`docs/probes.md#p9GrokInherits`).
   Grok also hands the server it starts the session's whole environment, a task's
   markers included (`docs/probes.md#grokHostHops`), so a Grok session started inside
   a task — from a suite `run_command` runs, which carries `CROSS_AGENT_DEPTH`
   (`src/runcommand.ts#commandEnv`) — resolves the specialist row. Under a Grok host,
   layer 2's marker check rests on that pass-through, which this build does not
   reimplement; Codex hands a server only what `env_vars` names, so there the mount
   names the markers (`docs/probes.md#e2ServerEnv`). A project's `[permission] deny`
   on `MCPTool(cross-agent__*)` gated a Grok child's calls without hiding the tools (a
   driver run, `docs/probes.md#grokDenyMcp`); by Grok's guide it binds every Grok
   session in the folder, the operator's host too, which no run tried. Grok
   specialists are held to the specialist row by ancestry, not by exclusion — that is
   why layer 1 had to become a capability model, and it is the same finding that
   rules Grok out as a lead ("The lead model", item 4). Under `placement:
   engine` this layer is relaxed for the lead's own server only, through the
   adapter's `leadMount`, on Claude or Codex.
3. **Denied launches**: the deny list of section 3 for Claude and Grok; for
   Codex, the sandbox's network denial, which stops a launched engine from
   reaching any model API (P3, P3b).
4. **Lineage, duplicates and the resume chain**: `CROSS_AGENT_LINEAGE` is an
   ordered list of `(task id, role, canonical cwd)`, encoded as a JSON array of
   `{taskId, role, cwd}` objects (`src/guard.ts#parseLineage`,
   `#formatLineage`), and the probe harness emits the same shape
   (`tools/probe.mjs#child`), so a probe child sees what a real child will see;
   `--track` hands the child `childEnv`'s own output instead, because there the
   runner is the real one (`tools/probe.mjs#track`).
   `delegate` appends its own entry — the new task's id, role and canonical
   cwd — to the lineage its own server carries, and `childEnv` writes the
   result into the spec's environment (`src/delegate.ts#delegate`,
   `src/guard.ts#childLineage`, `#childEnv`). The harness emitted a colon-joined
   placeholder until P9, which fixed it and verified the fix by feeding a
   child's received value back through `parseLineage`
   (`docs/probes.md#p9Lineage`). A `delegate` whose `(role, cwd)` is already in
   the lineage is refused (`src/guard.ts#lineageRefusal`). A request identical
   to a running task in `(role, canonical cwd, sha256(brief))` is refused with
   "already running, wait on <id>"; identical to a task finished within
   `duplicateWindowMinutes` (default 10) is refused unless `force: true`
   (`src/guard.ts#duplicateRefusal`). A `worktree: true` request is compared on
   `(role, sha256(brief))` against the tasks that were **given a worktree**
   instead: its own workspace is a path nothing has seen before, so a cwd could
   never match and the window would be inert on the one call that creates
   workspaces (`src/guard.ts#DuplicateRequest`, `src/delegate.ts#delegate`).
   The lineage rule is unchanged and keyed by the workspace as it always was. `force` crosses the finished window and
   never a live task: two engines in one workspace is what the first half
   refuses. `resume` skips the duplicate check, is refused for active tasks, and
   is bound to the original task's role, engine, cwd, and sandbox
   (`src/guard.ts#resumeRefusal`) — the profile read from the original's own
   launch spec, since the record carries none. A record that carries a
   `worktree` is continued **there**: the workspace and the profile come from
   that record and its spec rather than from the role, which works at the
   project root and would otherwise put the continuation back there read-only,
   and the worktree is verified to still be on that branch before anything
   launches — a lead that has already merged and cleaned up is told so by name
   (`src/delegate.ts#delegate`). That is what makes a needs-work round for a
   one-shot possible. Two rules of the chain are
   `delegate`'s, because they need the scan (section 2): no record of a chain
   with an active member may be continued, and a record that already has a
   successor answers `resume the latest: <id>` (`src/delegate.ts#resumeFault`).
5. **Prompt**: every role prompt says the specialist cannot delegate and
   reports back instead. Advisory only.

### 6. Config and validation

`<project>/.cross-agent/config.json`, created by `cross-agent init --mode
<name>`, validated on load (`src/config.ts#loadConfig`, `#loadConfigWithMode`). It carries the
**bind-time layer only**: which mode is active, which engine, model and
effort each of that mode's roles runs on, plus an optional `sandbox` override
per role, and, under `engines`, where each engine's binary is
(`engines.<e>.bin`, section 3) — a per-engine setting, never a per-role
one. Where a role works and what sandbox it defaults to belong
to the mode (the Modes section), so a `workspace` key here is refused and
every role key must name a role the mode declares.

```json
{
  "mode": "dev-team",
  "project": {"defaultBranch": "main", "testCommand": "npm test",
              "setupCommand": "none", "mergePolicy": "auto"},
  "roles": {
    "planner":       {"engine": "codex",  "model": "gpt-6-astra", "effort": "high"},
    "plan-reviewer": {"engine": "claude", "model": "claude-opus-5"},
    "implementer":   {"engine": "codex",  "model": "gpt-6-astra"},
    "code-reviewer": {"engine": "claude", "model": "claude-opus-5", "sandbox": "read-only"}
  },
  "engines": {"claude": {}, "codex": {"bin": "/opt/codex/bin/codex"}, "grok": {}},
  "limits": {"maxDepth": 1, "stallMinutes": 15, "waitDefaultSeconds": 600,
             "duplicateWindowMinutes": 10, "lockWaitSeconds": 5,
             "cancelGraceSeconds": 5},
  "billing": "subscription"
}
```

`cross-agent init` writes `engines` with an empty object per engine; the `bin`
above is what an operator adds when an engine is not on `PATH` under its own
name, and it is the value `delegate` carries to that engine's adapter
(section 3). The file is written whole — a temporary beside it, linked into
place — so a crash leaves a temporary rather than an empty config a later run
would call "already exists" and never repair, and the link is what keeps `init`
from replacing a config that is already there
(`src/config.ts#initConfig`). `limits.maxDepth` is a whole number of hops and
never negative; zero is legal, and is the cap that offers every server the
specialist row.

The `dev-team` mode supplies the rest (`modes/dev-team/mode.json`): `planner`
and `plan-reviewer` at `workspace: {kind: "root"}` with `sandboxDefault:
"read-only"`, `implementer` and `code-reviewer` at `{kind: "worktree",
branchPattern: "task/*", dir: ".worktrees"}` with the implementer defaulting to
a writable profile. A
`kind: "root"` role runs at the project root; a `kind: "worktree"` role
requires the `verify_worktree` checks of section 4 against the branch named in
the request, and a role whose sandbox mode is anything but read-only reserves
the path (section 2).

Every field above is validated, and the file is read by two loaders that answer
different questions. `loadConfig` reads the bind-time layer alone — `mode`,
`project`, each role's engine, model, effort and optional `sandbox`, `engines`,
all six limits and `billing`, `limits.lockWaitSeconds` and
`limits.cancelGraceSeconds` included (`src/config.ts#CrossAgentConfig`,
`#limitDefaults`, `#loadConfig`) — and it is what a runner, a lock or a
reconciliation reads, because those run where no mode has been loaded and must
not fail for want of one. Every lock acquisition but the runner's own claim
reads the first limit, through the caller's argument or through
`lockWaitSeconds(projectRoot)` (`src/config.ts#lockWaitSeconds`, section 2); the
second is how long `cancel` gives a runner to settle its own task (section 2).
`bindingFault` is every rule that needs both files, written once and answered as
a reason rather than a throw: every role key names a role the mode declares, the
effective profile — the override else the mode's default — is one the bound
engine accepts, no root role is writable, and an engine-placed mode's `lead.role`
is not bound to `grok` (P9: no per-run isolation, "The lead model", item 4), each
refused by field (`src/config.ts#bindingFault`). `loadConfigWithMode` raises it,
and is what the server loads before it serves, what `list_roles` answers from,
and what the entry point derives the depth cap from; `delegate` refuses with it
at the launch boundary, because these two files can change under a running
server and that is where an engine actually starts
(`src/config.ts#loadConfigWithMode`, `src/delegate.ts#delegate`). Which tools
exist is settled when the server loads its mode, so a config since pointed at
another mode is a refusal there and a `warning` from `list_roles`, both naming
the restart that fixes it (`src/config.ts#modeDrift`).

One thing config still carries that belongs to the mode: a role's own `prompt`,
the string `delegate` launches the role with (`src/config.ts#RoleConfig`,
section 8). It is an **override** now rather than the only source: `delegate`
falls back to the mode's own text for the role — the `roles/<key>.md` that
`describe_mode` serves, or the text a built-in role carries — read through the
one function that answers that question (`src/delegate.ts#delegate`,
`src/modes.ts#rolePrompt`). The one-line default that stood in for a mode's
prompt is gone with row 9, because a mode role carries a `prompt` or a
`promptFile` and never neither (`src/modes.ts#Mode`). The key stays because an
operator binding a role to a particular engine may want a sentence for that
engine without editing a portable mode.

### 7. The skills

Both skills are written. `skills/cross-agent/SKILL.md` is the launcher, with
the paragraphs every mode shares, those every host-placed mode shares — the merge
policy, the `review` and `critique` verbs, the reconciliation pass, each naming
`host` placement — and an engine-placement section for the rest;
`modes/dev-team/SKILL.md` is the ten-step loop
below, `modes/solo/SKILL.md` the zero-ceremony one, and
`modes/dev-team-engine/SKILL.md` the same ten steps for a lead in an engine: every
root step through `git_root` and `run_command`, every question through `ask`, no
shell command, ownership by `self` and `own` in step 1, and the closing report as
its final message (`tests/skills.test.ts#engineLoopSteps`, `#engineLoopOwnership`).
Which tools a loop may call is a test rather than a promise: every call-shaped
name in the launcher and in each loop — the names that carry an underscore — is
checked against the tools that mode registers for the row its placement runs it
in (the launcher's engine-placement section against `dev-team-engine`'s operator
row, everything else against every mode's), the bare ones (`delegate`, `wait`,
`check`, `result`, `cancel`) by a second test that names them, and every spelled
`delegate {…}` by a third that holds it to the keys the schema requires
(`tests/skills.test.ts`, `src/server.ts#projectTools`).

`skills/cross-agent/SKILL.md` is the launcher, and it is the only skill a host
loads: read the config, call `describe_mode` **first** to get the active
mode's loop and roles, then start, watch, answer, cancel, reconcile, report.
It is short and identical on all three hosts.

**After a `worktree: true` task settles, the launcher applies
`project.mergePolicy` — nobody merges by hand under `auto`.** First it commits
what the specialist left, with `git_mutate`, because a specialist writes no git
metadata (section 4) and an uncommitted worktree would merge nothing. Then,
under `auto`: `run_command {which: "test", where: <worktree>, slug}`, `git_root
merge --ff-only task/<id>`, `run_command {which: "test", where: "root", slug}`,
`git_root worktree remove <path>`, `git_root branch -d task/<id>`, and the
closing report. Under `manual`, or after any failure anywhere in that order, it
stops where it is, leaves the branch and its worktree standing, and reports the
reason together with the commands that finish the job by hand; a suite that
fails at the root after the merge is the repair path below and never a merge to
retry. Those paragraphs live in
`skills/cross-agent/SKILL.md`, which carries them for every host-placed mode —
`solo` hands a one-shot that wrote straight to them; under `engine` placement the
host starts no one-shot, and the lead's loop carries its own merge — and
`tests/skills.test.ts` holds them to that order.

**`review` and `critique` are verbs of that loop, not tools.** Each is one
`delegate` of the `consult` role that names its own engine, because a second
engine reading the same work is the point of asking: `review` attaches the diff
under review — `git diff <base>...HEAD`, or the working tree where nothing is
committed — and asks for findings by severity, each with `file:line` and what to
do about it; `critique` names a plan or a design file and asks for the
adversarial reading, what it assumes without saying so and where it would fail
first (`skills/cross-agent/SKILL.md`). Composing them costs no second protocol, which is
why the diff-scoped verbs of the vendor bridges are not built ("Not built").

`modes/<name>/SKILL.md` is that mode's loop, served by `describe_mode` and
never copied into a host's skill directory. For `dev-team` it is the devpack's
`worktree-workflow` with the verbs remapped (`delegate_bot` and `ask_bot`
became `delegate` then `wait`; "end your turn, you are woken" became "call
`wait` again while it reports running"; roles are names; the closing room post
became the task's closing report), plus the git ownership and ordering of
section 4 — ten steps, from the root check to the record
(`modes/dev-team/SKILL.md`), and:

Where that closing report goes depends on placement. Under `host` the host
session appends one line to `.cross-agent/log.md` itself, as it appends
anything else. Under `engine` the lead is read-only at the root and cannot
append it: its closing report **is** the task's final message, which the host
reads through `result`, and `cross-agent report` renders the log from the ledger
(`src/cli.ts#reportVerb`). An engine lead writes no project file itself; the
ledger, the journal and the mailbox are all written by the server on its behalf.
E3 is the case (`docs/probes.md#e3`): `result` on the lead returned the report
byte for byte as its result file holds it, and `cross-agent report` rendered the
run's five tasks, each `passed`.

- Journal: `.cross-agent/journal/<slug>.json`, built in `src/journal.ts`. The
  document is `{slug, branch, worktree?, defaultBranch, defaultShaBeforeMerge?,
  branchHead?, steps}` and each step is `{step, at, before?, after?,
  defaultSha?, args?}` (`src/journal.ts#Journal`, `#JournalEntry`). The step
  names are the completed git steps of the loop — `worktree-created`,
  `committed`, `rebased`, `merged`, `tests-passed`, `worktree-removed`,
  `branch-deleted` — plus `git`, which is any other `git_mutate` call and
  records the arguments it ran instead of a name (`src/journal.ts#JournalStep`).

  **Each named step is written by the tool that performs it**, under the lock
  that orders the writers — `git_mutate` and `git_root` while they still hold
  the lock their command ran under, `run_command` under `git.lock` taken for the
  re-check and the append alone, because a suite may run for ten minutes
  (`src/runcommand.ts#runCommand`) — so nothing has to remember to journal
  afterwards and no separate journal verb exists for the lead to forget or
  misuse. A step is named for what it **moved**: `git commit --dry-run` and a
  rebase that replayed nothing leave the branch where it was, and a
  reconciliation pass reading `committed` would go looking for a commit that is
  not there (`src/gitmutate.ts#stepName`):

  | step | written by | built |
  | --- | --- | --- |
  | `worktree-created` | `git_root worktree add -b <branch> <dir> <base>` | `src/gitroot.ts#whitelist`, `#execute` |
  | `committed` | a `git_mutate` `commit` that moved the branch | `src/gitmutate.ts#stepName` |
  | `rebased` | a `git_mutate` `rebase` that moved the branch, its own control flags apart | `src/gitmutate.ts#stepName`, `#rebaseControls` |
  | `merged` | `git_root merge --ff-only <branch>` | `src/gitroot.ts#whitelist`, `#execute` |
  | `tests-passed` | `run_command {which: "test", where: "root", slug}` exiting zero after the merge | `src/runcommand.ts#runCommand` |
  | `worktree-removed` | `git_root worktree remove <dir>` | `src/gitroot.ts#whitelist`, `#execute` |
  | `branch-deleted` | `git_root branch -d <branch>` | `src/gitroot.ts#whitelist`, `#execute` |
  | `git` | any other `git_mutate` call, with its `args` — a dry run, a rebase abort, a `git add` | `src/gitmutate.ts#mutate` |

  The `merged` step is the one that carries the document's two merge fields,
  and `git_root` takes both values **inside the same `git.lock` it holds for
  the merge**: `defaultShaBeforeMerge` is the default branch's `before` SHA,
  the one `git_root` already reads to report `before`, and `branchHead` is the
  head of the branch it is about to merge, read through the same explicit form
  (`src/gitroot.ts#execute`, `src/gitmutate.ts#revision`). Taken anywhere else
  they would be a different repository's state. Every row of this table is
  built, and both loops that call it name the step each of their own calls
  completes (`modes/dev-team/SKILL.md`, `modes/dev-team-engine/SKILL.md`).

  Three functions: `appendStep(root, slug, step, data)` reads, appends, and
  writes through the ledger's own atomic write — a temporary file and a
  rename — so a reader sees the whole previous document or the whole new
  one (`src/journal.ts#appendStep`, `src/ledger.ts#writeAtomic`); `readJournal`
  returns null when the task has none and **throws, naming the file**, when the
  document is damaged (`src/journal.ts#readJournal`), because an append that
  silently started from an empty journal would drop every step the file still
  holds; `listJournals` returns the slugs, sorted, ignoring temporary files and
  anything else that is not a journal (`src/journal.ts#listJournals`). A slug
  names a file here, a directory under `.worktrees` and a branch, so it is one
  path segment of the ledger's own alphabet and never `.` or `..`
  (`src/journal.ts#journalFile`).

  Five fields are the document's rather than a step's, and **which writer owns
  each of them is what makes the repair path below trustworthy.** The step that
  *creates* a journal must name both branches rather than have them invented
  (`src/journal.ts#appendStep`). `defaultBranch` follows the project's config.
  `branch` is **write-once**: a journal belongs to one task branch, and a later
  step naming another would silently rewrite what every earlier step's SHAs were
  recorded against (`src/journal.ts#appendStep`). `worktree` is write-once for
  the same reason and holds the work tree every step ran in — the directory
  `git_root worktree add` created or the one the verifier resolved for
  `git_mutate`'s first call (`src/journal.ts#Journal`, `#appendStep`,
  `src/gitmutate.ts#mutate`, `src/gitroot.ts#execute`) — and it is what holds a
  later `worktree remove` to this task's own directory.
  `defaultShaBeforeMerge` and
  `branchHead` are the **merge**'s to write, and only the merge's: an
  `appendStep` reads them from its data only when its step is `merged`, and a
  second `merged` step for one slug is refused — `journal <slug>: a merged
  step is already recorded; a task merges once` — so a task merges once and
  the pair is written once (`src/journal.ts#appendStep`). `tests-passed` is
  refused the same way and for the same kind of reason — a task's suite passes
  once, and two runs that both finished before either recorded a step would
  otherwise both record one (`src/journal.ts#appendStep`, `#once`). Every other step
  records the default branch's SHA it observed in **its own** step, as
  `steps[].defaultSha` beside `before` and `after`
  (`src/journal.ts#JournalEntry`, `#appendStep`), and never touches the
  document-level field; `git_mutate` passes exactly that
  (`src/gitmutate.ts#mutate`), and so does `git_root`, where it is the same SHA
  as that step's own `before` (`src/gitroot.ts#execute`). `tests-passed` records
  the default branch's SHA read **before** its suite starts
  (`src/runcommand.ts#runCommand`), which is the commit that passed: a long
  suite runs while the branch can move, and a journal that only said "the tests
  passed" would not say on what.

  The reason is the repair path. `defaultShaBeforeMerge` is a **revert target**,
  and a revert is only safe if it names the commit this task's merge sat on. A
  task's first `git_mutate` is typically a commit inside the worktree, made long
  before the merge and after other tasks have merged their own work; letting it
  pin the field would aim `git revert <that SHA>..<merged head>` at a range
  containing other tasks' merges, and the repair for one bad task would discard
  them. Per-step `defaultSha` keeps that observation — it is useful evidence
  of what the default branch looked like while the task ran — without letting
  it masquerade as the merge point.

  Both tools enforce those two rules from their own side as well, because the
  document keeping the first value is not a refusal a lead can read. A
  `git_mutate` call whose branch differs from the one its journal records is
  refused, `slug <a> is journaled on <task/b>; refusing <task/c>`, and one whose
  verified work tree differs is refused the same way, both before any git runs.
  That comparison happens **inside** `spawn.lock`, beside the reservation check
  it belongs with (`src/gitmutate.ts#mutate`): two first calls on one slug read
  outside the lock would both find no journal and both commit, on two different
  branches. `git_root` compares the same two fields inside `git.lock`, and adds
  the rules only it can apply — a slug whose journal already has a
  `worktree-created` step takes no second worktree, and a slug already merged
  takes no second merge (`src/gitroot.ts#journalFault`).
- Reconciliation at the start of every task, after any interruption, and after
  **any** `git_mutate` or `git_root` call that came back `ok: false` — with an
  exit code or without one. A `GitRunError` carries none, and it is the answer
  for a git that was killed at the 16 MB cap or died part-way, which is exactly
  the case where the repository may have changed; a journal write that failed
  after a successful command carries a zero one, which is no better a signal —
  the command ran and its step is missing. So the trigger is the refusal, not
  the exit code: any `ok: false` call may have changed the repository without
  journaling a step (section 4). What the pass reads: `list_tasks`, the
  journal, `git worktree list`, `git branch --list 'task/*'`,
  `git status --porcelain --untracked-files=normal`, and `git rebase` state,
  read under the `gitDir` `verify_worktree` answers for the worktree — with
  `branch: "HEAD"` while a stopped rebase has detached it — and never under a path
  made from the slug, since git names the administrative directory and a worktree
  project's lies in the repository's common directory. The root check reads the
  root's own branch with `git_root rev-parse --abbrev-ref HEAD`, not the registry's
  first stanza, which is the main worktree's. The worktree and branch lists are the
  repository's, so a sibling project's root, its task worktrees and its branches show
  there too: the loop chooses a slug neither list shows, and reconciles only what lies
  under its own `worktreeDir` or what one of its own **open** journals names. A
  journal holding a `branch-deleted` step is closed and claims nothing about a branch
  of that name now (`tests/skills.test.ts#rootCheckOwnBranch`, section 4).
  Rules: an interrupted rebase is aborted; a merged branch with a surviving
  worktree continues at the cleanup gate; a branch-only leftover is deleted
  with `branch -d`; a running task is waited on; an unmerged branch with a
  dead task is reported to the user; and any file `list_tasks` reports as
  invalid is named to the operator, who must repair or remove it before the
  next writable delegation can run.
- Repair path: never reset or rewrite `<default>`. If the suite fails on
  `<default>` after a merge, stop, report, and offer `git revert --no-edit
  <defaultShaBeforeMerge>..<branchHead>` as a new commit — the two fields the
  `merged` step wrote, which is why only that step may write them; the operator
  dispatches no further task until the repository is reconciled.

### 8. Role prompts

Every role's prompt is written, served verbatim by `describe_mode` and launched
with by `delegate`: one string, read by `rolePrompt` for both readers, so what a
host is shown and what the engine is told cannot drift
(`modes/dev-team/roles/planner.md` and its siblings,
`src/modes.ts#describeMode`, `#rolePrompt`, `src/delegate.ts#delegate`). A
`prompt` bound in `.cross-agent/config.json` overrides it for that project
(section 6); nothing else does.

`modes/<name>/roles/*.md`. For `dev-team` they are
`{planner,plan-reviewer,implementer,code-reviewer}.md`, written for this
runtime and using the devpack's role text for the review and reporting
conventions only: planner and plan reviewer read at the root; the implementer
edits and runs the tests in its worktree and reports a commit summary but
never runs git write commands; the code reviewer reads the committed branch in
the worktree; nobody delegates. `solo` has one role prompt. Acceptance is
behavioural (the end-to-end runs). The devpack's text was carried over once by
`tools/from-openmaus.mjs`, a harness beside `tools/probe.mjs` and not product
code: it drops the sentences naming the devpack's own machinery, drops the git
steps a devpack specialist ran itself, and appends this runtime's rule for the
role as a coda, reporting every drop so the draft is edited by someone who can
see what was cut. The committed files are those drafts edited. Nothing reads
`openmaus.package` at runtime, and the converter is tested against a fixture
package rather than the devpack's, which lives outside this repository
(`tests/fixtures/openmaus-package.json`, `tests/skills.test.ts`).

### 9. Host packaging

Claude Code's manifest ships (step 10): `.claude-plugin/plugin.json` naming
the plugin at `package.json`'s version and declaring this server **inline**
under `mcpServers`, with `skills/` found by convention and no `skills` key to
say so (`tests/packaging.test.ts`). There is deliberately no `.mcp.json` at the
repository root: that file is Claude Code's *project-scoped* MCP config, offered
to every session opened in this repository, and `${CLAUDE_PLUGIN_ROOT}` has no
value outside a plugin, so it would offer every developer here a server that
cannot start. The plugin manifest is the one declaration, and the server name in
it is what a host spells its tools after. `claude plugin validate <repo>` passes on
them, warning only that the repository's own `CLAUDE.md` is not plugin context,
which it is not meant to be. The Codex manifest is built, below; Grok needs none
of its own and reads this one as a plugin in place (below).

A host mounts this server one way and a specialist another, and the tool names
differ accordingly: under `--plugin-dir` the host's tools are
`mcp__plugin_cross-agent_cross-agent__<tool>`, while a `--mcp-config` mount —
every specialist's, and an engine-placed lead's — spells them
`mcp__cross-agent__<tool>`, and a Grok session, host or specialist, reaches them as
`cross-agent__<tool>`, the server's name and the tool's, through its own `use_tool`
(`docs/probes.md#t15Attach`). No spelling appears in the deny list, which names commands
and not tools. A test of any of them compares the set of this server's tools, never a
prefix (I1, `docs/probes.md#i1Spelling`). And the exclusion flag excludes **MCP servers**: a
specialist's session still loaded the host installation's slash commands and
skills (`docs/probes.md#i1Inherited`) — a Grok specialist's still does, and a Claude
one's stopped loading the operator's plugins when `--setting-sources project` left
the operator's settings out (`docs/probes.md#t12Fix1`); its hooks it loaded too, until 6b turned
them off in the run's own settings (`docs/probes.md#claudeHooksIsolation`). That is why an end-to-end run's last condition is a
scan of the tool calls and shell commands a transcript holds rather than a grep
of its text — a Grok session's inherited slash commands include one called
`delegate`, and the word proves nothing (`tools/e2e-verify.mjs`). That scan
reads Claude's and Grok's `tool_use` blocks against each engine's own tool
vocabulary, the names its archived transcripts call, Grok's `use_tool` dispatcher
in the one shape a run recorded (`tool_name` naming this server's tool, `tool_input` an
object, nothing else), and Codex's `agent_message`,
`command_execution` and `mcp_tool_call` items, and **nothing else**: a tool outside
its engine's list or a call with no name answers `?`
(`tests/e2e-verify.test.ts#closedToolVocabulary`) — but for one event it reads by its whole shape and passes as no
call: Claude Code 2.1.286's heartbeat for a call still in flight, a `tool_progress`
with `heartbeat: true`, exactly the keys E3's lead recorded, an id that is its
parent's `-heartbeat-<n>`, and a parent that is a call of the same transcript under
the same tool name (`docs/probes.md#e3`, `tests/e2e-verify.test.ts#claudeHeartbeat`);
any other `tool_progress` still answers `?`. I1's Codex row closed the last of those: a Codex MCP call is
an `mcp_tool_call` item whose `tool` field is this server's own name for the
tool (`docs/probes.md#i1CodexTracked`, `tests/e2e-verify.test.ts#codexMcpItem`),
and a Codex log carrying any other item type is still answered `?` rather than
guessed at. Under an engine-placed lead the lead's own records below the
effective depth cap are judged by the lead row, whose `delegate` is no offence,
and the depth condition uses that cap — the lower of the mode's placement cap
and `limits.maxDepth`, which is 1 when the file omits it
(`tests/e2e-verify.test.ts#engineLeadRow`, `#effectiveCap`, `#unshippedMode`); `--lead-role`
renames that lead and never changes a shipped mode's placement or cap
(`#leadRoleNamesOnly`). A Codex transcript is not the whole of what its
specialist ran: codex-cli 0.159.2's `--json` carried no `command_execution` item
for four writes its sandbox denied, while its own session rollout recorded every
call (`docs/probes.md#codexCacheWritable`). So the scan also reads each Codex
record's rollout — `$CODEX_HOME/sessions/**/rollout-*-<sessionId>.jsonl`,
`CODEX_HOME` defaulting to `~/.codex` — and judges every command it shows
attempted, denied ones included; a Codex record with no rollout to read answers
`?`, named (`tests/e2e-verify.test.ts#codexRolloutRead`), and so does one whose
rollout lacks a command the transcript shows, holds an unclassified tool-bearing
item, or changes a known command field's shape (`#codexRolloutUnclassified`,
`#rolloutItemShapes`). codex-cli 0.159.3's own `wait` on a code-mode cell that
yielded — a `function_call` whose arguments decode to exactly `{cell_id,
yield_time_ms}`, with `max_tokens` or without — names a cell and no command, and
is classified as a call that runs none in those two recorded shapes and no other,
its payload carrying exactly the keys every recorded one carries, so a field beside
them or inside its passthrough leaves the call unclassified (`#codexCodeModeWait`). An output carrying a command is judged like the call, and a
tool-bearing item is one with a field naming a tool, its arguments or a command,
by any spelling, on it or one object below (`#rolloutOutputs`). A code-mode
script is tokenized as JavaScript: a direct `exec_command` or `write_stdin` call
must give one object argument with a literal `cmd` or `chars`, without spread or
computed keys. An independent inventory counts
command-tool and delegate names in raw source and decoded token text; any excess
over direct calls followed answers `?`, including names hidden by tokenization.
Aliases, `eval`, `Function`, `import`, legacy octal escapes, slashes whose token
roles the reader cannot determine, and strings, comments or regexes naming
launches also answer `?` (`tests/e2e-verify.test.ts#codexScriptRead`,
`#codexScriptFailClosed`, `#scriptNameAccounting`). A word after `.` or `?.` is a
property, never a control keyword or one that opens a regular expression, and a
regular expression's escapes are decoded for the inventory (`#memberNames`). Under a
Codex host E4's Codex implementer showed a shape the table still answers `?`: codex-cli
0.159.3's `--json` writes an `apply_patch` edit as a `file_change` item, which a person read
as patches to files inside the task's worktree (`docs/probes.md#e4`).
`--read-rollout <session id>` prints what that reader makes of one session's
rollout — each code-mode `exec` with the commands it decoded, the exit code its one
output holds, paired by `call_id`, and whether its script is `direct` — and judges
nothing, so a test that has to prove what a Codex child attempted proves it through
the reader every verdict uses (`tools/e2e-verify.mjs#readRollout`,
`tests/e2e-verify.test.ts#readRollout`). A cell's output is whatever its script printed,
so a paired exit is the command's own only for a `direct` script: one awaited
`exec_command` with a literal `cmd`, its result printed as `{exit_code, output}` read off
that result, and no other statement (`tools/e2e-verify.mjs#directScript`,
`tests/e2e-verify.test.ts#readRolloutDirect`).

Whether a command is a launch is a shell's question, and the scan's contract for
it is that **`pass` on a named line requires positive understanding**: every
construct must be modeled and no launch found. A line is named when an engine,
configured binary or `src/server.ts` / `src/cli.ts` entry point appears anywhere
in its raw text or decoded words, including nested quotes, assignments, comments,
heredocs and redirection targets (`tests/e2e-verify.test.ts#wholeLineNames`).
The grammar decodes and judges what it models — simple commands at
operators; quotes, escapes and `$'…'`; substitutions wherever they stand, inside
`${…}`, `$((…))`, double quotes and unquoted heredocs; heredocs, here-strings and
pipes feeding a shell; exec wrappers, shells, interpreters and node, their options
walked letter by letter; ssh's command-carrying options; busybox's applets;
function definitions (`tests/e2e-verify.test.ts#nestedSubstitutions`,
`#optionWalk`, `#functionDefinitions`); a `$'…'` inside `${…}`, whose decoded
names count (`#parameterAnsiC`). `--` ends option parsing; words after
inline node code and `--` are arguments (`#optionTerminators`). Expansions where
an option, operand or code must be literal are `?` (`#expandedOperands`).
`NODE_OPTIONS` assignments, including `+=`, are read for loaders in prefixes,
declarations, `env` and `env -S`. `PROMPT_COMMAND` is read as commands; startup
paths and prompt templates are read for substitutions. Unreadable values and
named startup files answer `?` (`#codeAssignments`). node's table is audited
whole: an option that reads a file as code or as options that load code —
`--env-file` and `--env-file-if-exists`, the config files, `--run`,
`--snapshot-blob`, the snapshot and SEA builders, `--openssl-config` — is unread
code like a module loader, and its own code-loading environment variables
(`OPENSSL_CONF`, `OPENSSL_MODULES`, `NODE_REPL_EXTERNAL_MODULE`, `NODE_PATH`)
join the unread set; under `--entry-url` the script is read as a URL — query and
fragment dropped, path percent-decoded, a `file:` URL reduced to its path —
before the entry test (`#nodeConfigFilesUnread`, `#nodeEntryUrlScript`). Beyond
`NODE_OPTIONS` and the modeled builtins, every way bash writes a variable is an
assignment of unknown value, `?` on a named line when the name is unread
environment or code, when an expansion hides which name it is, or when a nameref
may alias it: an expanded destination anywhere, `getopts` past its own options
and `--`, `wait -p`, a `{NAME}` redirection on any command, `${NAME=…}`/`${NAME:=}`,
and any `-n` declaration whatever its operands (`#builtinAssignmentForms`).
Arithmetic is read wherever bash evaluates it: `(( ))`, `$(( ))`, `$[ ]`, and
`let` and `for (( ;; ))`, which stay unmodeled; an indexed array's subscript
wherever it stands — an assignment word, a compound array's `[key]=`, any
`${a[…]…}` with `${#a[…]}`, a builtin's variable operand (`read`, `printf -v`,
the declarations, `unset`, `wait -p`, `getopts`), and `test -v`, `[ -v` and
`[[ -v`, though not the `@` and `*` subscripts; a substring's offset and length;
the operands of `[[`'s `-eq`, `-ne`, `-lt`, `-le`, `-gt` and `-ge`; an unquoted
heredoc's body, which the current shell expands for a builtin; and every
assignment to an integer variable. On a named line an arithmetic text answers `?`
when it holds an expansion, when it reads a name — bash evaluates a name's value
as arithmetic in turn, so `x='HOME=5'; (( x ))` assigns `HOME`, and reading any
variable can assign any other — or when it assigns a name in the sets; an
indirect `${!name}`, whose name's value may carry a subscript, answers `?` too,
and so does any `-i` declaration whatever its operands, as `-n` does. Numbers and
operators alone, and a literal number assigned to an ordinary name (`(( i = 0 ))`,
`a[0]=1`, `${a[1]}`, `${x:0:2}`), stay as they are (`#arithmeticContexts`).
The data readers account for stdin and arguments as data except for execution
options, code assignments and deferred arithmetic/subscript evaluation; quoted
substitutions at those readers, including values carried into arithmetic on the
same line, answer `?` (`#deferredArithmetic`), and a `[[ … ]]` or `(( … ))` after
`if`, `while` or `!` is read as at a command's start, in `PROMPT_COMMAND` too
(`#reservedArithmetic`). Known stdin left unconsumed by a modeled reader answers
`?` if it names a target or judges as a launch; unknown
stdin at a shell, wrapper or remote command answers `?` on a named line
(`#unreadStdin`). A pipe into a `{ … }` or `( … )` group feeds every command in
it; a later command reads what the earlier ones left, so a launch it reads is
`?` (`#groupStdin`). Other unmodeled constructs on named lines are also `?`
(`#commandWordsModeled`); malformed syntax (`#nestedSubstitutions`), `case`
statements and engine-named functions cap the line at `?`. Otherwise a modeled
launch takes precedence over a doubt. Inline interpreter code naming a target
is `?` (`#inlineCodeUnjudged`). Script files remain unread. Stdin is an
interpreter's program only when it has no script or its script is stdin (`-`,
`/dev/stdin`); given to inline code, a module or a script file it is input the code
may read and run, which no modeled reader consumes, so it answers `?` when it
names a target or judges as a launch (`#interpreterStdin`). Unnamed lines pass
unless a modeled launch or the recursion limit decides them; names assembled
beyond the supported decoding are outside this transcript audit.

**The attach contract is the definition of a host: a stdio MCP server plus the
launcher skill.** Everything else is per-host manifest detail, and the three
manifests below are examples of satisfying that contract, not the contract
itself. Repo root is the plugin root for all three hosts:
`.claude-plugin/plugin.json` (manifest and `mcpServers` in one) + `skills/` for Claude Code
(`claude --plugin-dir ~/Documents/agent-team-cli` in development);
`.codex-plugin/plugin.json` with `skills: "./skills/"` and the server inline under
`mcpServers` for Codex, and `.agents/plugins/marketplace.json` making the repository a
marketplace whose one plugin's `source.path` is `"./"`, the repository's own root.
Codex runs the plugin from a copy of the marketplace directory taken at install time,
substituted no `${PLUGIN_ROOT}` in an inline `command`, `args` or `cwd` (the forms B1 ran),
and runs a relative command from the server's working directory, so the server is
`./.codex-plugin/serve` with `cwd: "."`: a launcher in the plugin's own directory that runs
the `src/server.ts` beside it (`docs/probes.md#codexPluginMount`). From there discovery finds
no project the operator meant — nothing from an export's copy, and a repository the operator
did not name from a checkout's, through the `.git` that came along — so the operator names
the project in `CROSS_AGENT_PROJECT` and the launcher refuses to start without it
(`tests/packaging.test.ts#codexManifestMounts`, `#codexLauncherRunsServer`,
`#codexLauncherRootUnresolved`). Codex gives a stdio server seven variables of its own and
passes on only the names `env_vars` lists (`docs/probes.md#codexHostEnvironment`), so the
list names `CROSS_AGENT_PROJECT` and the three task markers: a Codex session started inside
a task — a suite `run_command` runs carries `CROSS_AGENT_DEPTH` — hands them to its server,
which then serves the specialist row, as that depth is there to make it
(`src/runcommand.ts#commandEnv`), while from a clean shell Codex
passes none, leaving out an unset name rather than passing it empty, and the operator keeps
its row (`docs/probes.md#codexMarkers`, `tests/authority.test.ts#operatorNamesProject`). The
mount also carries `tool_timeout_sec: 3600`, `default_tools_approval_mode: "approve"` and
`startup_timeout_sec: 30`, and no `enabled`: whether the server runs is the operator's
configuration's to say, through the plugin-level key (`docs/probes.md#codexPluginMount`).
The documented fallback is a configured server — `codex mcp add cross-agent -- node
<repo>/src/server.ts` plus the four keys it does not write, the same `env_vars`, the call
budget, the approval mode and the start-up budget, `assets/codex/mcp_servers.toml` giving the
whole table, and a copy into `~/.codex/skills/cross-agent/`, a copy that takes
`skills/` alone, which is why a mode's loop is served by `describe_mode` rather than shipped
as a second skill. That server starts where the session runs and needs no
`CROSS_AGENT_PROJECT`, and it shadows the plugin's server of the same name
(`docs/probes.md#codexPluginInstall`, `tests/packaging.test.ts#codexFallbackSnippet`). Grok
reads the Claude manifest as a plugin in place: a project's own `.grok/config.toml` names the
checkout under `[plugins]` — `paths`, an absolute path, since Grok expands no `~` there, and
`enabled = ["cross-agent"]` — and grok 1.0.46 takes `skills/` and the inline `mcpServers`,
`${CLAUDE_PLUGIN_ROOT}` expanded to the checkout, with no copy and nothing written under
`~/.grok/`, in a folder Grok trusts (`docs/probes.md#t15Attach`,
`tests/packaging.test.ts#grokReadmeInstall`). `--plugin-dir` is not that route: the headless
`grok` has no such flag, only `grok agent`, which an ACP client drives. Nor is `grok plugin
install <path> --trust`, the documented one: it installs at user scope, which would put this
server in every Grok session on the machine, Grok specialists in linked worktrees among them,
where a project's file does not reach while git ignores `.grok/`: Grok takes a linked worktree
as a project of its own, so a committed file would be read in every one, which is why the
README's recipe ignores it (`docs/probes.md#grokWorktreeMount`). The plugin's
server carries no `--project`; Grok starts it in the session's working directory, where
discovery finds the project's config (`src/project.ts#discoverProject`). A branch worktree
made a project of its own needs the attach in its own directory, which git does not
carry there: `cross-agent init` copies the main checkout's `.grok/config.toml` into it,
as a regular file through no link, unless the file binds a project, and trusting the
folder stays the user's (section 10, `src/cli.ts#copyGrokAttach`). The same project file
raises Grok's result cap, `[mcp] max_output_bytes = 100000`: Grok cuts an MCP tool's answer at
20,000 bytes by default, and the mode's text `describe_mode` answers with, without the
`projectRoot` beside it, is 21,156 bytes under `dev-team` and 26,261 under
`dev-team-engine` (`tests/packaging.test.ts#describeModeSizes`,
`tests/server.test.ts#describeModeAnswerSize`). Grok's MCP
tool timeout, `tool_timeout_sec`, is 6000 s by default and reaches the plugin's server, and a
600-second `wait` returned intact under it (`docs/probes.md#grokToolTimeout`).

Why an MCP core is the portable choice, and not a subagent as the vendor
bridges use: **neither `codex-plugin-cc` 1.0.6 nor `grok-build-plugin-cc`
0.2.1 registers an MCP server at all.** Both are a set of Claude Code
commands, one `model: sonnet, tools: Bash` forwarding subagent, hooks, and
skills, with the engine reached by shelling out from that subagent. That shape
is Claude-Code-only and gives the host no typed tools; an MCP server is the
one attachment surface all three hosts share. Provenance: the installed plugin
sources under `~/.claude/plugins/cache/`, read 2026-09-08.

### 10. Operator CLI

`src/cli.ts` is a table of verbs over one parser and one exit protocol
(`src/cli.ts#runCli`, `#EXIT`): 0 ok, 1 an error nothing anticipated, 2 a
command line it cannot read, 3 a precondition the verb needs and does not have,
4 a task still running, 5 a lead waiting on the operator, 6 a task stalled.
Every verb takes `--project`, `--json` — one JSON document on stdout whatever
the exit: a 2 is `{ok: false, error, usage}`, a 1 `{ok: false, error}` but for
`git`'s, which is git's own failure and its `GitMutateResult`, and every other
code the verb's own answer (`tests/cli.test.ts#jsonOnEveryExit`) —
and `--help`, which prints the verbs, the project rule and the protocol, as text
or, under `--json`, as that one document. Without `--json` an answer that
carries a verdict — 0, 4, 5 or 6 — is stdout's and a failure — 1, 2 or 3 — is
stderr's unless the verb says otherwise, as `modes` and `git` do below, and a
warning beside either goes to stderr. A time a person reads is ISO-8601, or the
number itself where no date can hold it, so a time the readers accept never
crashes a renderer (`src/cli.ts#iso`). The `--flag <value>` pairs
go through the parser the server's own argv does, so adding one does not break
the other (`src/project.ts#parseFlags`, `#discoverProject`); a verb may also
take a flag with no value, an optional argument, or a tail after `--` that is
never read as flags, and any misuse of one is a 2
(`tests/cli.test.ts#cliUsage`). Every verb but `init` finds its project as the
server does. `package.json` names the entry point under `bin`, and the file
carries a `#!/usr/bin/env node` shebang, which Node 24 strips from a `.ts`
source as it does from any other.

Each verb calls the function its tool calls, with the options the tool's
handler passes:

- `cross-agent init [--mode <name>] [--from <dir>] [--project <root>]` writes the
  bind-time config for a mode (`src/cli.ts#initVerb`); a project that already holds
  one is not rewritten, and that is a 0 with a line saying so; a `--project` that does
  not resolve to an existing directory, and a mode this build has not got or
  cannot validate, are a 3, because `initConfig` creates `.cross-agent/` with
  its parents and a typo would otherwise leave a project tree nobody asked for.
  Its document is `{wrote, file, mode, ignored, warning?}`. Every target is judged
  from outside it first: one inside a worktree an enclosing work tree registers is a
  3 with nothing written, before its own `.git` is looked at, so a task worktree
  whose pointer was deleted or replaced is never initialized
  (`tests/cli.test.ts#initRemovedPointerRefused`, `#initReplacedPointerRefused`). A
  main checkout is unchanged, and still writes `defaultBranch: "main"` whatever it
  has checked out; a directory holding a bare repository at `.git` is no work tree
  of it, and a 3. At a `.git` file the repository is located, and a refused or
  unsupported root — a root inside its own git directory, a submodule — is a 3 naming
  the kind (`#initInsideCommonDirRefused`, `#initSubmoduleRefused`), and so is a
  detached HEAD (`#initDetachedRefused`). The worktree's branch becomes the default
  branch, so it must be a name `git_root` takes in every read of it —
  `src/gitroot.ts#nameFault`'s letters, digits, `.`, `_`, `/` and `-`, no `..`, no
  trailing `/` or `.lock`, where `git check-ref-format` would take `feature+one`
  (`tests/cli.test.ts#initBranchOutsideAlphabetRefused`) — and, once the mode is settled, a branch the
  mode's task pattern does not match, since every root verb, row 2 of the verifier and
  a sibling's journaled `branch -d` act on that pattern (`src/gitroot.ts#matchesPattern`,
  `tests/cli.test.ts#initTaskPatternBranchRefused`). The config is a copy, its default branch replaced
  and everything else carried: of `--from`'s, which must hold one, checked before it is
  loaded (`tests/cli.test.ts#initFrom`, `#initFromMissing`, `#initFromNoConfig`), or else of the main
  checkout's when it holds one (`#initInWorktree`). A bare repository's worktree takes
  the mode's defaults (`#initUmbrellaWorktree`, `#initBareDotGitDefaults`), and a
  separated main's needs `--from <main checkout>` or `--mode`, since git records no path
  to that checkout (`#initSeparatedMainNeedsFrom`); `--mode` beside a config it would
  copy is a 2. A worktree's document adds `defaultBranch`, `from` and `attach`.
  The source's Grok attach, `.grok/config.toml`, is copied with it, byte for byte: it is
  host configuration, so it moves as a regular file and never through a link — both
  directories and the file judged by `lstat`, nothing at the destination replaced, a
  dangling link included, and the file opened `wx` — `.grok/` is ignored beside it, and
  `init` says the folder may still need Grok's trust, which cross-agent never edits
  (`src/cli.ts#copyGrokAttach`, `tests/cli.test.ts#initCopiesGrokAttach`). A source that binds a project
  through `--project` or `CROSS_AGENT_PROJECT` is not copied — an explicit binding
  outranks the working directory, and would serve that project from the worktree — and
  `init` prints the binding to set up by hand (`tests/cli.test.ts#initBoundGrokAttachNotCopied`).
- `cross-agent modes` lists every built-in mode as the loader reads it, with its
  roles, and marks the one the config names — the read `describe_mode` makes
  (`src/cli.ts#modesVerb`). A config naming a mode this build does not have is
  a 3, because every verb that loads the mode would refuse, and the listing is
  still on stdout with the reason beside it; the document is `{active,
  installed, modes, reason?}` (`tests/cli.test.ts#cliModes`).
- `cross-agent tasks [--status <s>] [--reconcile]` is `listTasks` without the
  reconciliation pass (`src/cli.ts#tasksVerb`, `src/tasks.ts#listTasks`): every
  task newest first, an active one whose runner is gone marked so, and every
  record file no reader could judge named with its reason, as the `list_tasks`
  answer with `reconciled`, and always a 0. `--reconcile` runs the pass first
  and writes what `list_tasks` would: it is the one read that reconciles
  (`tests/cli.test.ts#cliTasks`, `#cliTasksReconcileFlag`).
- `cross-agent show <id> [--lines <n>]` reads what `check` and `result` read —
  the record, the tail of its engine stream, the outcome sidecar, its journal,
  and the final message of a record it shows settled — as `{record,
  elapsedSeconds, lastActivity, result, outcome, journal, journalError?,
  runnerLog}` (`src/cli.ts#showVerb`), and takes no stall reading: the status is
  the one the last `wait` or `check` wrote ("Time limits"), and the exit is that
  status's — 0 settled, 6 `stalled`, 4 anything else — or 3 for a task nobody
  has, an id no task file could have among them (`tests/cli.test.ts#cliShow`,
  `#cliIdOutsideAlphabet`). The status and the exit come from one read of the
  record; only when that read is settled does `result` read the record again for
  its message, and a settled status has no transition left to contradict it, so
  a runner that settles between two reads never puts a message beside an
  unsettled record (`#cliShowOneRead`). A journal that does not read is named
  beside the record, on stderr and as `journalError`, rather than in its place
  (`#cliJournal`).
- `cross-agent log <id> [--lines <n>]` is the tail of a task's engine stream,
  fifty lines unless asked otherwise, as `{id, logPath, lines}`; a task whose
  engine has said nothing is an empty answer and a 0, a task nobody has a 3
  (`src/cli.ts#logVerb`, `tests/cli.test.ts#cliLog`).
- `cross-agent cancel <id>` is `cancel` for the operator row, naming no lead
  (`src/cli.ts#cancelVerb`, `src/tasks.ts#cancel`), its document the
  `CancelResult`: a 0 when every task of the cascade is settled
  (`tests/cli.test.ts#cliCancel`), a 4 when one is still active, which a second
  cancel retries (`#cliCancelStillActive`), and a 3 for a refusal. An ask file it
  could not write is named for the operator beside a verdict it does not change,
  in both of those tests, and a task nobody has is refused before any lock is
  taken (`#cliIdOutsideAlphabet`).
- `cross-agent verify-worktree <path> <branch>` is `verifyWorktree` on a path
  read against the working directory, without the tool's drift check, because
  the CLI serves no mode: 0 verified, 3 refused, the verifier's answer as the
  document (`src/cli.ts#verifyWorktreeVerb`,
  `tests/cli.test.ts#cliVerifyWorktree`).
- `cross-agent git <slug> [--path <dir>] [--branch <name>] -- <args…>` is
  `gitMutate` with what `git_mutate`'s handler passes — the project's lock wait
  and the mode's git policy — and everything after `--` is git's own argv
  (`src/cli.ts#gitVerb`). `--path` is read against the working directory, as
  `verify-worktree`'s path is, where the tool reads it against the project root.
  A step journaled is a 0; git that ran and failed is a 1, its own output
  printed and the answer carrying its exit code, a journal step that could not
  be written after a zero exit included; every refusal before git ran is a 3, a
  held `git.lock` among them. The document is the `GitMutateResult` whatever the
  code (`tests/cli.test.ts#cliGit`).
- `cross-agent git-root [--slug <slug>] -- <args…>` is `gitRoot` with what `git_root`'s
  handler passes, so it has the tool's whitelist, journal rules, `rootWriteFault`,
  `git.lock` and repository lock (`src/cli.ts#gitRootVerb`): the operator's
  cooperating path for root git while a loop runs (section 4). `--slug` is required
  exactly when the verb journals. Its exits mirror `git`'s, through the same answer
  (`src/cli.ts#gitAnswer`): 0 when git ran, a 1 when git ran and failed or exited 0
  with its step unjournaled, a 3 for a refusal before git ran
  (`tests/cli.test.ts#cliGitRootRuns`, `#cliGitRootExitCodes`, `#cliGitRootTakesLocks`).
  Every call takes `git.lock`, which writes the ledger's exclusions and the lock
  directory, so the whole verb, a read included, is a write and is refused inside a
  task's environment before anything changes (`#cliGitRootRefusedInTask`): a task reads
  the root through the tool.
- `cross-agent journal [<slug>]` is one journal whole, or with no slug every
  journal's slug as `{slugs}` (`src/cli.ts#journalVerb`,
  `src/journal.ts#readJournal`, `#listJournals`): a 0, a 3 for a journal nobody
  wrote, a 2 for a slug no journal file could have, and a 1 for a journal that
  does not read, a step of it included, which names its file
  (`tests/cli.test.ts#cliJournal`).
- `cross-agent list-asks [--status <s>]` is `list_asks` for the operator row:
  every ask, in the order asked, as `{asks, invalid}` (`src/cli.ts#listAsksVerb`,
  `src/mailbox.ts#listAsks`). It is a 5 while an ask it printed is open — the
  filter scopes the verdict as it scopes the listing — and a 0 otherwise; a
  damaged ask file is named on stderr and in `invalid`, never thrown, and
  changes no verdict (`tests/cli.test.ts#cliListAsks`).
- `cross-agent answer <ask-id> <text>` answers an engine-placed lead's open
  question through the function the `answer` tool calls
  (`src/cli.ts#answerVerb`, `src/mailbox.ts#answerAsk`): 0 and the record, or 3
  for a second answer — naming when the first landed — a cancelled ask or one
  nobody asked, and an unknown ask writes nothing. A damaged ask file is a 3 as
  well, naming the file, and is left as it was
  (`tests/cli.test.ts#answerDamagedAsk`). A project with no config,
  found as a git toplevel when nothing else names one, is a 3 before anything is
  read or locked: no lead of it can have asked
  (`tests/cli.test.ts#answerWritesNothing`).
- `cross-agent report [--since <task id>]` renders every task of the ledger
  newest first — role, engine, model, effort, duration, outcome, id — then each
  task's final message, every line of it indented four spaces under its heading
  so that a table inside a message is never read as a row; the outcome is
  three-valued: `passed` for `done`, `failed` for `failed` and `cancelled`,
  `unknown` for a task not yet settled or one whose result file is missing
  (`src/cli.ts#reportVerb`, `tests/cli.test.ts#reportVerb`). Its document is
  `{tasks, invalid?}`, each message verbatim, and an unknown `--since` is a 3.

The reads write nothing. In a repository nobody has initialized every read is an
answer — an empty listing is a 0 — and leaves no `.cross-agent/`, no change to
`.git/info/exclude` and nothing for `git status` to show
(`tests/cli.test.ts#cliReadsWriteNothingUninitialized`); over a ledger holding a
task in every status, a damaged record and a damaged ask, each read leaves every
file under `.cross-agent/` byte for byte, a `running` task far past its stall
threshold included (`#cliReadsLeaveSeededLedger`). The verbs that write —
`init`, `answer`, `cancel`, `git`, `git-root` and `tasks --reconcile` — refuse with 3,
naming the variable, when the CLI's own environment carries `CROSS_AGENT_TASK`,
`CROSS_AGENT_DEPTH` or `CROSS_AGENT_LINEAGE`, the markers `childEnv` gives a
task's process tree (`src/guard.ts#childEnv`): writing is the operator's power,
and the deny list keeps only the launch forms it names out of an engine's hands
(section 3), so a write that reaches this CLI some other way is refused here
(`src/cli.ts#taskMarker`, `tests/cli.test.ts#cliRefusesInsideEngine`). The rule
fails closed: a verb that does not declare that it only reads is refused as a
write (`#cliWritesFailsClosed`).
`CROSS_AGENT_PROJECT` is no marker, being also the operator's own way to name a
project, and the reads answer the same with a marker as without one.

`src/cli.ts`: `cross-agent init --mode <name> | modes | tasks | show <id> |
log <id> | cancel <id> | verify-worktree <path> <branch> | git <slug> --
<args> | git-root -- <args> | journal [<slug>] | list-asks | answer <ask-id> <text> | report`.
`modes` lists the installed modes and marks the active one; `answer` replies to
a pending `ask` without a host session, and `list-asks` shows a terminal the
questions it can answer; `report` renders the per-task summary from the ledger
and each task's final message. Under `host` placement `.cross-agent/log.md`
already holds that summary, because the host appended it (section 7); under
`engine` placement `report` is where the log comes from.

### Time limits, as agreed

No cap on a task. `wait` returns early with `stalled: true` when the engine has
emitted nothing for `stallMinutes`; the task keeps running and the lead decides
(`src/wait.ts#wait`). The clock that silence is measured from is the engine's
last event, else the acknowledgement that answered for the engine —
`lastEventAt ?? acknowledgedAt` (`src/wait.ts#stallClock`) — so a task that has
emitted nothing yet is read from the moment its runner claimed it. The reading
is taken for two statuses and no others, `running` and `stalled`
(`src/wait.ts#observeStall`), so a `launching` record never stalls whatever
clock it carries: an unacknowledged launch is the reconciler's deadline to
judge, not a silence to measure. The operator CLI takes no reading of its own:
`cross-agent show` reports the status the last `wait` or `check` wrote, so a
task past its threshold that neither has read since is shown `running`, and a
look from a terminal changes nothing a lead's next `wait` will answer
(`src/cli.ts#showVerb`, `tests/cli.test.ts#cliReadsLeaveSeededLedger`).
A stall that **begins while a call is
polling** is that call's answer, whoever wrote it — its own reading or another
reader's, because the crossing is the event and not the write; the stall a call
arrived on is not, or a second `wait` on a stalled task would return the same
reading for ever, so that one polls on and answers when the task settles, when
it stalls again after another `stallMinutes` of silence, or at the timeout. The
resolution of all of this is the runner's two-second activity interval, which is
how often a live engine's `lastEventAt` reaches the record
(`src/runner.ts#activityInterval`). A `wait` that finds the ledger out of step with the
kernel — a launch past its deadline, a task whose runner is gone, which is what
`orphaned` means — runs one reconciliation pass, once per call, and reports what
it settled (`src/reconcile.ts#reconcileAndCleanup`). Evidence outranks silence:
the pass runs before a fresh stall is answered, so a quiet task whose runner has
died is reconciled rather than reported as stalled. A record still adrift after
that one pass is answered at once, with what the pass could not do as `reason`
and a hint naming `list_tasks` — polling on would be waiting for a mover that no
longer exists (`src/wait.ts#passReason`, `#hintFor`). `timeout_seconds` bounds one call so
the lead's turn never hangs and defaults to `limits.waitDefaultSeconds`; the
upper bound is the caller's. Claude Code's MCP tool timeout defaults to about
28 hours, Codex takes `tool_timeout_sec` per server, 60 s unless set: an
engine-placed Codex lead's mount sets it to 3600 s, so each of its 600 s `wait`
and `ask` calls fits with room (`src/engines/codex.ts#codex`), and B2 timed one at
158 s by Codex's own record of it (`docs/probes.md#s11CodexLeadTimeout`). The Codex
plugin's manifest sets the same 3600 s for a Codex host's own server, and Codex honours it
from there: one 600 s `wait` completed at 600.004 s by Codex's own record, while a copy
declaring 60 s cut the same call at 60 s (`docs/probes.md#codexHostTimeout`). Grok gives an
MCP call `tool_timeout_sec`, 6000 s by default, a project's plugin server included, and one
600 s `wait` under a Grok host returned intact at 600.003 s by Grok's own record of the call
(`docs/probes.md#grokToolTimeout`). `ask`
is bounded the same way and asked again by id. The clock silence is measured
from advances on a Codex lead's MCP calls too, announced and completed, because
those are the whole of what a lead that only calls this server's tools says
while its calls last (`src/engines/codex.ts#codex`).

### Not built

Chat, rooms, a roster UI, an approval broker, runtime bot creation, the lead's
own persistence under `placement: host` (the host's job), ACP engines,
branch-scoped git metadata grants, a conflict-edit mode for rebases. Deferred
with reasons. Three have a backlog bead (`atc-s96.25`, `.26`, `.28`); two are
**not planned** and have none, because nothing would trigger them:

- **Arbitrary-path workspace providers** (`atc-s96.25`). Only `root` and
  `worktree` are in scope. A provider that hands a role any path would have to
  carry its own containment argument, and section 4's guarantees are written
  for a linked worktree.
- **Config-declared adapter modules** (`atc-s96.26`). The reason is in section
  3: the runner imports that path unsandboxed and only its absoluteness is
  validated.
- **An engine `doctor` / preflight** (`atc-s96.28`). The sandbox-or-refuse
  rule already fails closed at spawn time (`src/engines/spawn.ts#sandboxSupportCheck`), so a
  preflight would report the same refusal one step earlier and could go stale
  between the two.
- **`openmaus.package` as an import format.** Not planned: native modes only,
  and the converter runs once.
- **Session transfer between engines.** Not planned: resume is bound to the
  original task's engine (`src/guard.ts#resumeRefusal`), and a transfer would
  have to reconstruct one engine's session state inside another's.

Four limits of worktree projects are deferred the same way, each for its reason:

- **A worktree project inside its main checkout's directory** — `M/branches/x`, or
  a host's own `.claude/worktrees/<name>` — is refused as a root. Supporting it needs
  task-directory containment, `<root>/<worktreeDir>/`, enforced first at every task
  entry point — `delegate`, `git_mutate`, `run_command`, `verify_worktree` — so that
  only a worktree there counts as nested.
- **Writes at a separated main's checkout or a submodule**, which take none today:
  they need a kind of their own with the external git directory protected. A
  separated main's checkout cannot be found from its worktrees, since git records no
  path to it, which is why `init` there asks for `--from`.
- **Cancelling a hung git child.** `gitMutate` holds `spawn.lock` for the whole call
  and `cancel` needs that lock, so cancelling one needs subprocess ownership that does
  not first take it; the README gives the operator's recovery by hand (section 4).
- **A wider branch alphabet**, what `git check-ref-format --branch` accepts less
  paths, ranges and options, where `src/gitroot.ts#nameFault` now refuses a name such
  as `feature+one` that a worktree project's default branch could otherwise carry.

## Repository layout (`~/Documents/agent-team-cli`)

```
.claude-plugin/plugin.json   .codex-plugin/plugin.json   .codex-plugin/serve
.agents/plugins/marketplace.json                         assets/codex/mcp_servers.toml
skills/cross-agent/SKILL.md  modes/<name>/mode.json
modes/<name>/SKILL.md        modes/<name>/roles/*.md
src/server.ts     src/config.ts     src/ledger.ts     src/process.ts
src/reconcile.ts  src/runner.ts     src/guard.ts      src/worktree.ts
src/locks.ts      src/reservation.ts                  src/gitmutate.ts
src/journal.ts    src/delegate.ts   src/tasks.ts      src/cli.ts
src/mailbox.ts
src/engines/{types,spawn,registry,binaries}.ts
src/engines/{claude,codex,grok}.ts
tests/*.test.ts   tests/engines/*.test.ts
tests/fixtures/fake-engine.mjs
tools/probe.mjs   tools/check-citations.mjs   tools/from-openmaus.mjs
tools/e2e-verify.mjs
docs/design.md    docs/probes.md
AGENTS.md         README.md         package.json      .gitignore
LICENSE (Apache-2.0)
```

Present today:
`src/{server,config,ledger,process,reconcile,runner,locks,guard,worktree}.ts`,
`src/{reservation,journal,gitmutate}.ts`, `src/{delegate,tasks}.ts` from row 7,
`src/{modes,cli}.ts` and `modes/{dev-team,dev-team-engine,solo}/` from row 8,
`src/mailbox.ts` and the CLI's `answer` and `report` from row 11, and all seven of
`src/engines/`: the contract and pipeline from T4, the registry and the binary
helpers from row 5, and the three adapters, complete, from row 6. Plus the
tests, `tools/probe.mjs`, `tools/check-citations.mjs` (the citation checker
`npm test` runs), `tools/e2e-verify.mjs` (row 10's, which every end-to-end run
is judged by), the two docs, and the root files. From row 9:
`skills/cross-agent/SKILL.md`, every mode's own `SKILL.md` and every
`roles/*.md`, with `tools/from-openmaus.mjs` beside the other two harnesses.
From row 10: `.claude-plugin/plugin.json`, which carries the server as well. From row 12, T14:
`.codex-plugin/plugin.json` with its launcher `.codex-plugin/serve`,
`.agents/plugins/marketplace.json` and `assets/codex/mcp_servers.toml`. From row 12, T15:
no file, because Grok reads `.claude-plugin/plugin.json` as a plugin in place.

`package.json`: no dependencies, `"test": "node --test 'tests/**/*.test.ts'"`,
and `"bin": {"cross-agent": "src/cli.ts"}`.
AGENTS.md carries the Project facts (default branch `main`, test command `npm
test`, setup command `none`, merge policy `auto`), the layout, the conventions
(one file per concern, tests next to behaviour, no dependency without a
reason), and the loop-guard scope as a hard requirement.

## Work plan

### Phase 0: scaffold and engine-level probes

1. Create the repository: `git init`, LICENSE, package.json, `.gitignore`
   (`.cross-agent/`, `.worktrees/`, `node_modules/`), AGENTS.md, README.md,
   `docs/design.md` (this design), `src/server.ts` with the JSON-RPC loop,
   `initialize`, `tools/list`, `list_roles` from a config file, concurrent
   dispatch; `tests/server.test.ts` over stdio, including one test that
   answers `ping` while a slow tool call is pending;
   `tests/fixtures/fake-engine.mjs` (emits JSONL in a per-engine format
   chosen by `FAKE_ENGINE_FORMAT`; `FAKE_ENGINE_SCRIPT` selects `ok`, `fail`,
   `stall`, `stall-ignore-term`, or the `quiet-then-active` T11 added for the
   stall detector — silent, then its format's lines, then alive and silent
   again before a normal finish (`tests/fixtures/fake-engine.mjs#fakeEngineScripts`, `#quietThenActive`,
   `#lingerAfterOutput`). Its `grok` format emitted nothing until a final whole-output
   object — Grok's `json` mode — until **T9
   rewrote it to the `streaming-messages-json` shape** P8 adopted, which is the
   `claude` case's lines with a Grok `system/init`
   (`tests/fixtures/fake-engine.mjs#grokFormat`, `#grokResult`); a fixture that cannot
   produce the adopted format cannot test the adapter that parses it. The
   whole-output shape stayed, as a fifth format `grok-json`, because the
   pipeline's `finish` tests need an engine that says nothing until exit
   (`tests/fixtures/fake-engine.mjs#grokJsonFormat`, `#grokJsonResult`). `tools/probe.mjs`, a
   standalone harness that spawns one engine with the section 3 argv (no
   server, no runner) so the probes do not wait on feature tasks. It stays a
   manual tool, but not a second builder: round 1 of T13 moved it onto the
   adapters' own `plan`, so what a probe records is what a specialist meets
   (`tools/probe.mjs`). `npm test` green.
   First commit. **Done.**
2. Probes with the harness, each a short real run recorded in
   `docs/probes.md` with the exact command and outcome:
   - P1 nested `claude -p` from inside a Claude Code session with the
     scrubbed env (the binary carries a `CLAUDECODE` guard). **Done**; the
     Claude sandbox needs `bwrap`, `socat`, and the bwrap AppArmor profile.
   - P2 each engine as implementer inside a linked worktree under its
     sandbox. Recorded: an in-worktree edit and the tests succeed, and writes
     to a root file, to a sibling path, and to `$HOME` are denied by all
     three; the rewrite of the worktree's `.git` pointer is denied by Codex
     and Claude and **allowed by Grok**; a write into `<root>/.git` is denied
     by Codex and Grok and **allowed by Claude**. **Done for all three**
     (`atc-s96.17` closes with the Claude row, `docs/probes.md#p2`). The
     Claude cell was a containment failure and is **answered**: the adapter
     names the workspace's `.git` pointer and the repository's git directory in
     `filesystem.denyWrite`, the rerun denies the write, and a third row shows a
     read-only role refused its own workspace as well. Outstanding variants, not
     yet
     recorded: a write into another *registered* worktree, a write to
     `<root>/.git/refs/heads/<default>` specifically, the whole set on a resumed
     session, and `$TMPDIR`/`/tmp` for a **writable** Claude role — the
     read-only row found `/tmp` denied, and nothing of the ledger, the spec or
     the journal lives there, so it is an unmeasured cell rather than an open
     risk.
   - P3 the deny list. Recorded (`docs/probes.md#p3`): four targets
     (`claude`, `codex`, `grok`, `node <repo>/src/server.ts`) attempted on
     each engine, with `node --version` as the control. **Done** — Claude and
     Grok deny all four and allow the control; Codex ignores an execpolicy
     rules file in `exec`, see P3b. The rest ran in task 12's fix round, on
     Claude and on Grok: the `cross-agent` and `node <repo>/src/cli.ts`
     targets and a configured `engines.<e>.bin` path, in a fresh session and
     in that session resumed, each refused (`docs/probes.md#t12Fix1`).
   - P3b Codex network: a workspace-write child cannot reach a model API or
     complete a nested engine run. **Done.**
   - P5 `codex exec --ignore-user-config`: auth kept, no trust prompt, no user
     MCP servers. **Done.**
   - P7 lead-owned git with explicit `--git-dir`/`--work-tree` under `flock`,
     over a worktree edited by a sandboxed implementer: commit, rebase,
     `--ff-only` merge, cleanup. **Done.**
   - P8 Grok streaming output, in both NDJSON formats, after `tools/probe.mjs`
     gained an `--output-format` flag. **Recorded 2026-09-09**
     (`docs/probes.md#p8`): `streaming-json` announces its session id only
     on the last line, carries no final message text at all, and emits no
     closing line when the run fails; `streaming-messages-json` announces the
     session id on its **first** line — on a resumed run as well as a fresh
     one — puts the final text in the last line's `result`, and closes even a
     failed run with a parseable `result` line carrying `is_error` and
     `errors`. **Adopted for T9: `streaming-messages-json`** (§3).
   - P9 lead mount and instruction delivery, per engine, each CLI spawned with
     only this server intended. **Recorded 2026-09-09**
     (`docs/probes.md#p9`): Claude mounts exactly this server under
     `--strict-mcp-config --mcp-config <file>` and obeys
     `--append-system-prompt-file`; Codex mounts it with three `-c
     mcp_servers…` settings under `--ignore-user-config`, the third being
     `default_tools_approval_mode="approve"`, and obeys `-c
     model_instructions_file="<file>"`; Grok has no per-run isolation of any
     kind, and a child inherits the operator's Grok configuration, Grok plugins
     and `~/.claude.json` servers. Ruling: **no Grok lead** ("The lead model",
     item 4). The run also recorded the `--help` facts of section 3
     (`docs/probes.md#cliFacts`).
   - P10 `codex exec resume`. **Recorded 2026-09-09**
     (`docs/probes.md#p10`): the subcommand takes neither `-C` nor
     `--sandbox`, and a resumed thread keeps neither the cwd nor the sandbox of
     the original run — the writable root follows the resuming process's cwd,
     a resume one directory up wrote where the original turn had been refused,
     `-c cwd=` is ignored, and `-c sandbox_mode=` restores the profile exactly.
     So T8 resumes with the process cwd set to the role's workspace and the
     sandbox re-supplied (§3). These three probes and the harness flags they
     needed were the S4 bead `atc-s96.21`, now closed.
3. Task records: the devpack's own record of this work — Decision 0008, the
   T-series beads under epic `atw-07l`, the `bd remember` notes, the
   EVIDENCE.md section header for M7 — lives in
   `~/Documents/agent-team-devpack`. This repository's issues live under epic
   **`atc-s96`**, and the bead ids in the table below are the authority for
   what is left.
4. Bring up the pack: headless server on `openmausbot-data-4`, rebind every
   bot and the room to `~/Documents/agent-team-cli` with
   `scripts/bind-team.sh`, set the lead's Project facts, lead on Claude for
   T1. Operator rule: the next task is dispatched only after the previous one
   settled and the repository reconciled. **Done through T5.**

### Phase 1: build order

T1–T5 (ledger, config and `verify_worktree`, guard, adapter interface and
spawn pipeline, detached runner) are built and green, and so are steps 1 to 4
below: the rename and this document's rewrite, the lifecycle step that closed
the five correctness defects in shipped code, the T6 remainder, and the probes
the adapters depend on. Steps 5 to 8 — the engine contract, all three adapters,
the tools, and the modes with the worktree provider and `init --mode` — are
built and green too, and so are steps 9 to 13: the skills and the mode loops,
then each host's packaging with its integration probes and end-to-end run right
after it. What is left is the backlog, row 14.
Rows 7 and 8 were where the built git and reservation machinery was finally
reached by a caller: `delegate` consults a reservation, and `git_mutate` is
registered by the mode that declares the worktree provider.

| # | Work | Bead | Notes |
|---|---|---|---|
| 1 | Rename and design rewrite | `atc-s96.19` | **Done.** One pass; `npm test` gated the rename. History files untouched. |
| 2 | Locks primitive, conditional update, lifecycle | `atc-s96.20` | **Done** (`45ee841..e426f35`). `src/locks.ts` (the `flock` child); `update` with `expect` and `{applied}`; B1 (reconcile on the group scan in `src/reconcile.ts`, the `cancelling` case), B2 (bounded drain, `truncated`), B3, B4, B5 (environ scan, runner lock, `launchToken` removed), A4-a (record validation); plus the two review rounds' rulings, which section 2 states with the line that implements each. The reconciliation **triggers** are not in this step: they belong to row 7. |
| 3 | T6 remainder | `atc-s96.6` | **Done** (`58b90cf..69f3eac`, with its review's two fix rounds in `608c89a..53e5e45` and `ffbb84d`). `limits.lockWaitSeconds` and `lockWaitSeconds(root)` (`src/config.ts`); `gitLockName`/`spawnLockName` (`src/locks.ts`); `src/reservation.ts`; `src/journal.ts`; `src/gitmutate.ts` — the four steps of section 4 on the verified git-dir, under `spawn.lock` then `git.lock`, journaled; `gitEnvironment` for every git invocation (`src/worktree.ts`). The review's rulings are stated in sections 2, 4 and 7 with the line that implements each. Three beads came out of it: `atc-s96.33` (a pre-existing suite flake in `reconcile`/`process` under load, open), `.34` (`lockWaitSeconds` through `update`'s callers, closed) and `.35` (an inherited `GIT_DIR` makes `verify_worktree` refuse, closed). Not in this row: registering the two worktree tools (row 8), `delegate`'s reservation check and `spawn.lock` (row 7), `git_root` (Task 4b), `cross-agent git` (row 13). |
| 4 | Probe harness flags, P8, P9, P10 | `atc-s96.21` | **Done** (397763c, 649b8e5, f40cadb). `--output-format`, `--mcp-config`/`-c`/`--rules` passthrough; the resume argv no longer pushes `-C` and `--sandbox` onto `exec resume`, which accepts neither. Outcomes in Phase 0 above: `streaming-messages-json` for T9, three `-c` settings for a Codex lead mount, no Grok lead, and a Codex resume that keeps neither cwd nor sandbox. |
| 5 | Engine contract and profile validation | `atc-s96.22` | **Done** (`734e1e9..193b511`, with its review's fix round in `cfaf2b0`). A2; the adapter fields of section 3, `sandboxFor` as their one construction site, the built-in table in `src/engines/registry.ts`, `src/engines/binaries.ts`, and `EngineName` moved beside the contract; informed by P8 and P9. The three adapters carried the static half only at this point: `plan`, `parseLine` and `finalMessage` threw, and so did the `finish` stub each declared; row 6 replaced all four. |
| 6 | Adapters | `atc-s96.7`, `.8`, `.9` | **Done.** `.7` T7 Claude (`d8bc672`, with its review's fix round in `90fd4d6`): `--append-system-prompt-file` for the role file (P9), `parseStderrLine` for P1's two sandbox failures, and the mount immediately after `--strict-mcp-config`. `.8` T8 Codex (`aa3e8bc`, fix round `1a20cc8`): **without an execpolicy rules file**, resuming with the process cwd and `-c sandbox_mode=` re-supplied (P10), and the prompt on stdin behind a `-` positional on both heads. `.9` T9 Grok (`992a830`): `--output-format streaming-messages-json`, `finalMessage` reading `result` or `errors` joined with newlines, the role prompt through `--rules` (P8, P9), no engine-placed lead, and `tests/fixtures/fake-engine.mjs`'s `grok` format rewritten to that shape with the old one kept as `grok-json`. Section 3 was refreshed against the built adapters in one pass afterwards (`atc-vao`). |
| 7 | delegate, check, result, cancel; wait with stall | `atc-s96.10`, `.11` | **T10a and T10b done.** T10a: ancestry-bound authority, project discovery, tools by row, `tools/call` refusal by name (`src/authority.ts`, `src/project.ts`). T10b: `delegate`, `check`, `result`, `cancel` and `list_tasks` (`src/delegate.ts`, `src/tasks.ts`), the guard wiring, reconciliation on server start and on every `list_tasks`, the four delegation record fields, `limits.cancelGraceSeconds`, the prefix reservation (`atc-vuu`), the per-task scratch directory (`atc-s96.37`), one source for the engine binary (`atc-s96.10.1`), and the two runner SIGTERM edges (`atc-s96.39`, `.29`). T11 (`atc-s96.11`): `wait` with stall detection, `observeStall` shared with `check` as the only writers of `running ↔ stalled`, the one reconciliation pass a waiter runs when a record's own evidence says the ledger is out of step, and `notifications/cancelled` aborting the pending `wait` it names (`src/wait.ts`, `src/server.ts#createServer`). `describe_mode` registered with step 8, which built the mode loader it reads. |
| 8 | Modes, worktree provider, `init --mode` | `atc-s96.23` | **Done.** `src/modes.ts` (the loader, `describeMode`, `builtInModesDir`), `modes/{dev-team,solo,dev-team-engine}/`, `describe_mode` and the worktree provider's two tools registered by the mode (`src/server.ts#worktreeTools`), `loadConfigWithMode` and `effectiveMaxDepth` (`src/config.ts`), `src/cli.ts` with `init`. The per-role directory kind left config with this row: `cwd` is refused by name, `workspace` with it, and where a role works is the mode's. Not in this row: `git_root` and `run_command` on the same provider (Task 4b), the real loop and role-prompt text (row 9), and `delegate` reading the mode's role prompt rather than config's (row 9). |
| 9 | Launcher skill and mode loops | `atc-s96.12` | **Done.** `skills/cross-agent/SKILL.md` (the launcher, carrying the merge policy and the `review`/`critique` verbs for every mode); `modes/dev-team/SKILL.md` (the ten steps), `modes/solo/SKILL.md` (shortened to the one-shot, which hands over to the launcher) and `modes/dev-team-engine/SKILL.md` (the placement delta row 11 completes); every `dev-team` and `dev-team-engine` `roles/*.md` through `tools/from-openmaus.mjs` and its fixture tests, `modes/solo/roles/consult.md` being 4c's own text; `tests/skills.test.ts` holding each loop's calls to the tools that mode registers for its row; and, in the fix round, `delegate` launching a role with the mode's own prompt file rather than a one-line default, the config's `prompt` becoming the override it was meant to be (`src/delegate.ts#delegate`, `src/modes.ts#rolePrompt`, section 8). |
| 10 | Claude Code packaging | `atc-s96.13` | **Done**; I2's Codex column ran with row 12. `.claude-plugin/plugin.json` carrying the server inline, and
`tests/packaging.test.ts`; `tools/probe.mjs --track`; probe P2's Claude row (`atc-s96.17`), which found one containment failure; I1's Claude rows and I2's Claude and Grok rows; E1 under `placement: host`, green on every pass condition. What is not run and why is in `VERIFY.md`, "M3, second merge — T13". I1's two Codex rows ran in the 6b pre-flight (2026-09-30), from a stdio operator driver and `tools/probe.mjs --track` rather than a Codex host: a delegated `consult` sees none of this server's tools, and a child given a lead's mount sees exactly the five specialist tools as `mcp__cross_agent__<tool>`, answers `list_roles` from the project `--project` names, and has no `delegate` (`docs/probes.md#i1Codex`, `#i1CodexTracked`); the refusal by name was not reached from Codex, as from no engine that honours `tools/list`. I2's Codex column and the guarded `tests/engines/codex.test.ts#codexI2Real` ran at T14 (row 12, `docs/probes.md#i2Codex`). I1's Grok row is **closed** (`atc-s96.54`): with the sample folder trusted, a Grok `consult` at the project root sees exactly the five specialist tools and is refused `delegate`; while git ignores `.grok/` (section 9), a Grok specialist inside a linked worktree would need a user-scope mount, which is the operator's decision. |
| 11 | Engine placement | `atc-s96.24`, `.59` | **Done** (S11, from `cc10a2a`). `git_root`, `run_command` and the journal's named steps had moved forward as Task 4b, on the worktree provider (plan decision 4). S11 built the rest: stdin split on newlines alone (`atc-s96.59`); the mailbox and its three rows (`src/mailbox.ts`, `src/server.ts#mailboxTools`); `delegate`'s engine-placed lead — the mount with `--project`, the cap, the loop and the role prompt composed once, and the asks a resume carries (`src/delegate.ts#engineLead`); the Codex mount's per-tool timeout and its markers' whitelist, and an MCP call as activity (`src/engines/codex.ts#codex`); the cancel cascade over asks; `list_tasks`' `self` and `own`; the operator CLI's dispatcher with `answer` and `report` (`src/cli.ts#runCli`); the `dev-team-engine` loop and `roles/lead.md`; the launcher's routing on placement. End to end with the lead on **each supported lead engine** from one host — E3 on Claude, E2 on Codex — and the five failure injections (`docs/probes.md#e3`, `#e2`, `#injectCancelLead`, `#injectKilledLeadAsk`, `#injectRootSuiteFails`, `#injectAfterWorktreeRemove`, `#injectRebaseConflict`). Grok is out of this row: P9 found no per-run isolation, so it is a specialist and a host only ("The lead model", item 4), and config load and `delegate` refuse `placement: engine` with a Grok lead. |
| 12 | Codex and Grok packaging | `atc-s96.14`, `.15` | Thin-launcher end-to-end under each host. **Codex done** (T14, from `388a885`): `.codex-plugin/plugin.json` with its launcher `.codex-plugin/serve`, its `env_vars` handing the server the project and a task's markers (`docs/probes.md#codexMarkers`), the marketplace entry and the fallback snippet (section 9); the verifier's `--read-rollout` and its reading of Codex's code-mode `wait`; the guarded `codexI2Real` run; I1 and I2 under a Codex host, the ten-minute `wait` through the plugin and its hop counts (`docs/probes.md#t14` and the sections after it); E4 under host placement and E5 under engine placement (`docs/probes.md#e4`, `#e5`). **Grok done** (T15, from `f4d6647`): no manifest of its own — a project's `.grok/config.toml` names the checkout under `[plugins]` and raises `[mcp] max_output_bytes`, and Grok reads the Claude manifest, skill and inline server alike (section 9, `docs/probes.md#t15Attach`); I1 and I2 under a Grok host, its read-only row at the root, a deny rule on this server's tools, the ten-minute `wait`, the hop counts and the worktree mount (`docs/probes.md#i1GrokHost` and the sections after it); E6 under host placement and E7 under engine placement (`docs/probes.md#e6`, `#e7`). |
| 13 | Operator CLI remainder | `atc-s96.16` | **Done** (T16: fifteen commits, `f8d4507` to `8efa717`, its review's fix round and wrap-up included). `modes`, `tasks`, `show`, `log`, `cancel`, `verify-worktree`, `git`, `journal` and `list-asks` on row 11's dispatcher and exit protocol, each calling the function its tool calls (section 10): `listTasks` reads without a pass for the operator (`src/tasks.ts#listTasks`); the reads proved side-effect free over an uninitialized repository and over a seeded ledger; the verbs that write refused inside a task's environment; `list-asks` naming a damaged ask file rather than throwing, the CLI half of `atc-s96.65`; `report`'s messages indented. `answer` and `report` shipped with row 11. |
| 14 | Backlog | `atc-s96.25`, `.26`, `.28` | Arbitrary-path workspaces; config-declared adapters; engine `doctor`. `atc-s96.27` left this row as Task 4c (plan decision 10): the built-in `consult` role, the no-config default to `solo`, `delegate {worktree: true}`, the launcher's merge-policy steps, and `review` and `critique` as verbs of the loop rather than a second protocol. |
| — | Claude P2 | `atc-s96.17` | **Done** (2026-09-19): three rows — the first run, the rerun under `filesystem.denyWrite`, and a read-only role at the project root. The first found the containment failure `atc-s96.52` records; the other two are the fix. |

Integration probes after each packaging task, run by the operator:

- **I1, authority.** With the plugin installed in that host, each of the three
  engines spawned as a specialist lists its MCP tools and sees **exactly the
  specialist row** of the permission matrix — the four read tools plus
  `describe_mode`, and no `delegate` — including a Grok specialist that
  inherits the user's MCP configuration and therefore does reach a server. The
  row is checked **per host, in that host's own spelling**: Claude shows
  `mcp__cross-agent__<tool>`, Codex folds the hyphen and shows
  `mcp__cross_agent__<tool>` beside its built-in `codex_apps`
  (`docs/probes.md#p9Mounts`), and Grok reaches the tools through its
  `use_tool` dispatcher (`docs/probes.md#p9Mounts`), so the test compares the set of
  this server's tools, not a literal string — four spellings have now been
  observed for the same five tools, and none of them is the design's own. A direct `tools/call delegate`
  from that session is refused by name, with the reason. **Run for Claude**
  (`docs/probes.md#i1`). **Run for Grok too**, once the operator trusted the
  sample folder (`atc-s96.54`): a `consult` delegated normally into the project
  root reached this server through the configuration it inherits and listed
  exactly the five specialist tools as `cross-agent__<tool>`, with `delegate`
  refused by Grok's own dispatcher as a name it was given no schema for. A Grok
  specialist **in a linked worktree** is not covered and is not a trust
  question: `./.grok/config.toml` is per-directory, and a worktree is its own
  directory, so while git ignores `.grok/` (section 9) only a user-scope mount would
  reach one — recorded at T15 under the
  plugin attach, the user having declined a user-scope mount
  (`docs/probes.md#grokWorktreeMount`). **Run for Codex** in the
  6b pre-flight (2026-09-30), from a stdio operator driver and `tools/probe.mjs
  --track` rather than a Codex host, whose own rows came at T14: a delegated
  `consult` lists Codex's built-in `codex_apps` and nothing of this server's, and
  a child given a lead's own mount lists exactly the five specialist tools as
  `mcp__cross_agent__<tool>`, answers `list_roles` from the project its mount
  names with `--project`, and has no `delegate` (`docs/probes.md#i1Codex`,
  `#i1CodexTracked`); a direct call was not reached from it either. **Run for Codex
  under a Codex host** at T14 (`docs/probes.md#i1CodexHost`): from a host whose own
  tools are `mcp__cross_agent__<tool>`, a delegated Claude `consult` saw no MCP tool, a
  Codex one saw `codex_apps` alone — `--ignore-user-config` dropped the plugin, enabled
  in the operator's configuration, with the rest of that configuration — and a Grok one
  saw exactly the five specialist tools and no `delegate`. **Run for all three engines
  under a Grok host** at T15 (`docs/probes.md#i1GrokHost`): from a host reaching this
  server's fourteen as `cross-agent__<tool>`, a delegated Claude `consult` saw no MCP tool,
  a Codex one nothing of this server's, and a Grok one exactly the five specialist tools,
  through the project's attach it inherits, and never attempted `delegate`. For Claude: a delegated
  `consult` sees no MCP tool at all,
  and one given a lead's own mount by `tools/probe.mjs --track` sees exactly
  the five specialist tools as `mcp__cross-agent__<tool>` — while the host's
  own plugin mount spells them `mcp__plugin_cross-agent_cross-agent__<tool>`,
  which is why the set and not the prefix is the test. The refusal by name was
  not reached from an engine: a client that honours `tools/list` never sends a
  call for a tool that is not in it — two runs said so in those words — so that
  path is a test's: a server started by a fake engine whose record the ledger
  holds, sent a raw `tools/call delegate`, answers `-32602` with the reason
  naming the matched task id (`tests/authority.test.ts#specialistOwnServer`). A server also
  writes its row and that reason to stderr at its first resolution
  (`src/server.ts#main`), which is what a future transcript carries.
- **I2, host × engine isolation.** Each engine spawned by the server launched
  from that host repeats the P2 negative writes, all of which must be denied.
  Claude and Grok children can reach the network; **a Codex child must not** —
  its network denial is layer 3 of the loop guard, so reachability there would
  be a failure, not a pass. Plus a ten-minute `wait` completing under that
  host's MCP tool timeout. **Run for Claude and Grok under Claude Code**
  (`docs/probes.md#i2`): every outside-worktree write denied on both, both
  reaching the network, Grok's `.git` pointer rewrite allowed and answered by
  `verify_worktree` and `git_mutate` refusing with git's own words and mutating
  nothing, and a 600-second `wait` returning at 602 s with the task still
  running. Claude's `<root>/.git` cell was not repeated in that first pair: P2
  had just recorded it as allowed, and a containment failure is recorded once.
  It is answered twice over now — in P2's own rerun with `filesystem.denyWrite`
  carrying the spec's `protectedPaths` (`docs/probes.md#p2Rerun`), and in a
  **delegated** writable Claude task through the server, the runner and the
  adapter, whose nine steps include `<root>/.git/hooks/pre-commit` and whose
  engine argv was read from `/proc` while it ran (`docs/probes.md#i2UnderFix`).
  **Run for all three engines under a Codex host** at T14, through the plugin's server
  (`docs/probes.md#i2Codex`): every outside-worktree write denied, Claude and Grok
  reaching the network and Codex not (`curl: (6) Could not resolve host`), Grok's
  pointer rewrite answered by both refusals with nothing mutated, and a 600-second `wait`
  completing at 600.004 s by Codex's own record with the task still running
  (`docs/probes.md#codexHostTimeout`). **Run for all three engines under a Grok host** at
  T15 (`docs/probes.md#i2GrokHost`): every outside-worktree write denied, Claude and Grok
  reaching the network and Codex not, Grok's pointer rewrite answered by `verify_worktree`
  refusing with git's own words; the Grok read-only row at the root
  (`docs/probes.md#i2GrokReadOnly`), its writes to the cwd, `<root>/.git`, `$HOME` and the
  sibling directory denied, `/tmp` and `~/.grok` the profile's own exceptions, its network
  cut; and the Grok host's 600-second `wait` returning intact under Grok's 6000 s default
  (`docs/probes.md#grokToolTimeout`).

### Phase 2: evidence and decisions

The probes and the end-to-end runs are recorded in `docs/probes.md` and
`VERIFY.md`. Decision 0011 (`atc-s96.18`) holds the record of the eleven runs and
the operator conditions they set. Phase 2 was first planned as a go or no-go on
the plugin as the devpack's second binding; on 2026-10-02 the user withdrew that
binding, and the project follows its own path (Context).

## Verification

- `npm test` green after every task; T3, T5, and the locks task are gates: no
  adapter or tool task is briefed before they pass.
- **Probes gate the tasks that cite them.** P1, P2 (Codex and Grok), P3, P3b,
  P5, P7, P8, P9 and P10 are recorded, and so is P2 for Claude (`atc-s96.17`)
  with the rerun and the read-only row its findings forced. A failed negative
  probe — a denied write that succeeded, a pointer rewrite `verify-worktree`
  accepted — blocks the corresponding adapter.
- **B1:** runner dead, leader reaped, descendant alive → `orphaned` →
  cleanup kills it. `cancelling` with a dead runner → group terminated →
  `cancelled`.
- **B2:** a descendant that **inherits** stdout does not prevent settlement;
  the result carries `truncated: true`; the existing delayed-tail and
  missing-binary tests in `tests/spawn.test.ts` stay green.
- **B3:** two processes racing one record under the lock — exactly one
  `applied: true`; a stale reconciliation is `applied: false` and the task
  lives.
- **B4:** a cancel inside the launch window → eventual `cancelled`, both
  identities present, no live group.
- **B5:** SIGKILL between the spawn and the acknowledgement → the engine is
  found by `CROSS_AGENT_TASK` and terminated; two runners started for one task
  → one engine.
- **T6 (recorded).** Locks: two acquirers of one file serialize
  (`tests/locks.test.ts#acquirersFileSerialize`), a waiter refuses after its wait naming the
  operation and the file (`#waiterRefusesWait`), and a lock whose holder was SIGKILLed is
  taken by the next holder in under a second, with the lock file never deleted
  (`#lockHeldSigkilled`) — no TTL, no stale detection, no reclaim. The same over `git.lock`:
  two mutations take it one after the other, and their journal steps chain
  `before` to the previous `after` (`tests/gitmutate.test.ts#mutationWaitsGit`), while a
  mutation behind a SIGKILLed holder completes well inside the five-second wait
  (`#gitLockHeld`); `spawn.lock` is held for the whole call with `git.lock` inside it
  (`#gitMutateHolds`). `limits.lockWaitSeconds` is read where a config is loadable and
  answers with the default where none is (`tests/config.test.ts#lockwaitsecondsReadsConfigured`).
  Reservation: a writable task holds its cwd until it settles, every profile
  but the read-only ones reserves, an unreadable launch spec holds the
  workspace anyway, paths compare canonically, and a removed workspace is still
  reserved (`tests/reservation.test.ts#writableTaskReserves`, `#profileReadOnly`, `#runningTaskWhose`, `#unreadableRecordReported`, `#reservationsComparePaths`,
  `#removedWorkspaceReserved`), and a sandbox this build cannot read as a `{mode, profile}` pair
  keeps it too (`#launchSpecWhose`). `git_mutate` refuses: a workspace an unsettled
  writable task is holding (`tests/gitmutate.test.ts#gitMutateRefusesWorkspace`), every workspace
  while a record
  cannot be read (`#recordCannotBeRead`), a worktree the verifier rejects — the main
  worktree, a subdirectory, the wrong branch, a missing path, a pointer
  redirected at a sibling — with the verifier's own reason (`#gitMutateRefusesWorktree`), an
  argument list that is not one subcommand in this worktree (`#gitMutateRefusesArguments`), and a step
  that could not be recorded, **before** it runs anything (`#gitMutateRefusesRuns`). Two first
  calls on one slug settle on one branch and the other is refused (`#firstCallsSlug`). A
  failing git command returns its exit code and both streams and journals
  nothing (`#failingGitCommand`); a config, a lock, or a git that could not run is refused
  rather than thrown (`#configLockGit`); a lock lost while the command ran is reported and
  the step is still journaled (`#lockLostWhile`). Journal: a commit lands on the task
  branch and is journaled with the SHAs around it (`#commitLandsBranch`); steps accumulate in
  order with only the fields they carry (`tests/journal.test.ts#stepsAccumulateOrder`),
  each append is a rename that leaves no temporary behind (`#appendReplacesFile`), the
  branch a journal was created on is write-once (`#branchJournalCreated`), the revert
  target and the branch head are set once and only by the merge
  (`#revertTargetBranch`), and a damaged journal is named rather than replaced
  (`#damagedJournalNamed`). Environment: `gitEnvironment` passes what git
  needs to run as this user and nothing else, and the verifier ignores what the
  server's own environment says about a repository
  (`tests/worktree.test.ts#gitenvironmentPassesGit`, `#verifyworktreeIgnoresServer`).
- **T7 (recorded).** The Claude line is P1's, in the order P9 ran it, pinned
  byte for byte for a read-only role, a writable one, a resume, and an
  engine-placed lead whose `--mcp-config` sits immediately after
  `--strict-mcp-config` and whose config file is written as a plan file
  (`tests/engines/claude.test.ts#readOnlyRole`, `#writeRoleArgv`, `#resumedRunCarries`, `#enginePlacedLead`). The brief is
  `plan.stdin` and appears nowhere in the argv; the writable root is
  `request.cwd` exactly, even when the worktree was reached through a symlink
  (`#writableRootRequest`); a flag with nothing to carry is not emitted (`#flagNothingCarry`); and the
  sandbox check names whichever of `bwrap` and `socat` it cannot find on `PATH`
  (`#claudeSandboxSupport`). P1's two stderr failures become **one** fatal `error` event: a run
  the engine itself calls a success fails on it (`#sandboxFailureStderr`), and a sandbox
  that fails at its own setup once per command still yields exactly one event with
  every line still in the log (`#sandboxFailsCommand`). A whole run through `spawnEngine`
  against the fake engine's `claude` format settles with the session, the
  activity and the final text in order, and a failed one with the engine's own
  message (`#fakeClaudeRun`, `#failedRunSettles`).
- **A1 / P8 (T9, recorded):** the Grok adapter runs `--output-format
  streaming-messages-json`; per-line events arrive before the final one; the
  session id is read from the first line's `system/init`, on a resumed run as
  well as a fresh one; `finalMessage` reads the last line's `result` when
  `is_error` is false and its `errors` when it is true, so a failed run settles
  down the same path as a successful one. Recorded through a `spawnEngine` run
  against the rewritten fixture — the session, the activity and the final text
  in order on a success, and the joined `errors` with exit 1 on a failure
  (`tests/engines/grok.test.ts#fakeGrokRun`, `#failedRunSettles`) — and at the parser, where a
  `result` line that omits `is_error` fails closed rather than passing as a
  success (`#grokParselineReads`, `#resultLineRun`, `#grokFinalMessage`).
- **A2 (recorded):** `{engine: "codex", sandbox: "workspace"}` is refused at
  config load, naming the engine and the profiles it does accept
  (`tests/config.test.ts#sandboxProfileEngine`). The same rule holds past config: `sandboxFor`
  answers for every profile of each engine and refuses any other name,
  including `toString` (`tests/engines/claude.test.ts#sandboxforPairsProfile`,
  `tests/engines/codex.test.ts#sandboxforPairsProfile`, `tests/engines/grok.test.ts#sandboxforPairsProfile`); the
  pipeline refuses a contradicted pair, a foreign profile and a spec naming
  another engine before the capability check, the plan and the spawn
  (`tests/spawn.test.ts#modeEngineMap`); and the reservation holds a workspace for every
  one of those (`tests/reservation.test.ts#modeEngineOwn`). The contract's own members
  are recorded per adapter: the profile map, `denyArgs`, `exclusionArgs` and
  `leadMount` byte for byte against P9
  (`tests/engines/claude.test.ts#claudeDeclaresOwn`, `#claudeDenyargsAppendable`, `#claudeExclusionargsFlag`, `#claudeLeadmountReturns`,
  `tests/engines/codex.test.ts#codexDeclaresOwn`, `#codexCarriesDeny`, `#codexExclusionargsRemoves`, `#codexLeadmountSettings`,
  `tests/engines/grok.test.ts#grokDeclaresFour`, `#grokDenyargsDeny`, `#grokPerInvocation`, `#grokLeadmountInherits`), and the
  pipeline's half of `finish` — called once with the whole raw stdout, nothing
  buffered for an adapter that declares none, a throwing one reported without
  losing the run — plus plan files written `0600` with their parents before
  the spawn and a file it cannot write settling as a launch failure with nothing
  spawned (`tests/spawn.test.ts#declaredFinishCalled`, `#adapterDeclaresFinish`, `#failingFinishReported`, `#planFilesWritten`, `#planFileCannot`).
- **A3 (recorded):** a mismatched slug and path → `git_mutate` uses the
  `gitDir` `verify_worktree` returned. The commit lands on the branch of the
  worktree at `path` and the slug's own branch is untouched
  (`tests/gitmutate.test.ts#gitMutateRuns`); a `git` shim on `PATH` captures the argv and
  asserts `--git-dir=<realpath of the verified administrative directory>` with
  no argument naming the slug's worktree, and that the child is handed no
  `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` or `GIT_CONFIG_*` (`#gitMutatePasses`).
- **A4-a:** a malformed record file is reported by name and refuses every
  writer until it is repaired or removed. Recorded for `git_mutate`
  (`tests/gitmutate.test.ts#recordCannotBeRead`), for `delegate`, which refuses a writable
  delegation naming the file and leaves a read-only one alone
  (`tests/delegate.test.ts#recordNobodyCan`), and for `list_tasks`, which returns the file
  beside the records it could read (`tests/tasks.test.ts#listTasksReconciles`).
- **Authority (T10a, recorded but for its last two clauses):** a server whose
  nearest engine ancestor is a specialist gets the specialist row even when
  the process also carries a lead's environment (`tests/authority.test.ts#nearestEngineDecides`),
  and an engine ancestor whose record grants nothing still ends the walk, so
  its server never reaches the lead above it (`#specialistHoldsNoAuthority`); a server carrying
  `CROSS_AGENT_TASK` that matches no record gets the specialist row, not the
  operator row (`#serverCarryingAny`), and so does one whose engine passed it no
  environment while an ancestor carries the task (`#serverWhoseEngine`); a walk that hits a
  read error, a cycle, 32 hops, or a parent younger than its child gets the
  specialist row (`#walkFailsClosed`, `#walkReachesEngine`, the latter over real chains of
  31 and 32 wrapper processes), while the operator row takes a clean
  environment and a walk that reached the root (`#operatorCleanEnvironment`); a lead's row is lost
  on the first call after its record leaves `running|stalled`, and gained on
  the first after it reaches `running` (`#leadHoldsRow`); an identity from another boot,
  or an engine not carrying its task, matches nothing (`#identityAnotherBoot`); and the depth
  cap only ever lowers a row (`#engineAncestorGrants`). A direct `tools/call` of a tool outside
  the resolved row is refused by name with the reason
  (`tests/server.test.ts#callToolOutside`), the entry point refuses by the row it
  resolves for itself (`#entryPointResolves`), and both the list and the refusal follow
  the row from one request to the next (`#rowResolvedAgain`); a specialist's `delegate`, `wait` and `cancel` are refused by
  this server's own name with the resolver's reason, and its read tools answer
  (`#specialistRowCannot`). The project is `--project`, then `CROSS_AGENT_PROJECT`, then
  the nearest configured directory, an uninitialized linked worktree resolving to its
  main project, an initialized one to itself, a directory inside a task's worktree to
  its root whatever the worktree's pointer holds, and no config anywhere to a reason
  (`tests/project.test.ts#projectWinsCross`, `#workingDirectoryResolves`,
  `#workingDirectoryInside`, `#linkedWorktreeOwnProject`, `#cwdInsideTaskWorktreeMapsToRoot`,
  `#removedPointerCwdMapsToRoot`, `#replacedPointerCwdMapsToRoot`, `#namedTaskWorktreeRefused`,
  `#projectConfigAnywhere`; `tests/server.test.ts#startsAtRootFromDamagedTaskWorktree`). A resolver that throws is answered `-32603`, lists
  nothing and runs no handler (`tests/server.test.ts#resolverThrowsAnswers`). **Recorded** on 2026-09-19: a Grok
  specialist inheriting the operator's MCP configuration — the project-scoped
  mount, in a folder its operator trusts — sees exactly the specialist row and
  has its own `delegate` refused (I1, `atc-s96.54`). A Grok specialist in a
  linked worktree still reaches no server while git ignores `.grok/` (section 9),
  because a project-scoped mount is per-directory. On grok 1.0.46 a Grok specialist's
  server at the project root runs
  inside the engine's bubblewrap and cannot read the identity-holding ancestor's environment, so it
  resolves the specialist row by `src/authority.ts#decide`'s fail-closed branch: the row
  is right, and its reason — the environment cannot be read — is one no test pins yet
  (`docs/probes.md#i1GrokHost`). A Grok host's server is 4 processes from pid 1 under
  `setsid --fork` and 11 nested in an agent session's own shell, one of them a
  `timeout` the run wrapped it in, serving the operator row either way
  (`docs/probes.md#grokHostHops`).
- **T11 (recorded).** An engine that says nothing from its launch stalls on the
  acknowledgement clock while its group stays alive, comes back to `running`
  through `check` when it emits, stalls again on the next silence, and settles
  with the tail of its result — one fake engine, one task, four readings
  (`tests/wait.test.ts#quietEngineStalls`). A settled task is answered on the first read
  (`#settledTaskAnswered`); `check` answers while a `wait` is pending and an aborted `wait`
  returns the status it found, in under 100 ms, having written nothing (`#checkAnswersWhile`);
  a `launching` record never stalls however old its clock (`#launchingRecordStalls`); the timeout
  with no argument is the project's `waitDefaultSeconds` (`#defaultTimeoutProject`); a runner
  SIGKILLed under a pending `wait` is settled by that call's one reconciliation
  pass, engine group and all (`#runnerKilledDuring`), while an orphan the pass cannot settle is
  answered as `orphaned`, with the reason it was skipped, rather than waited on
  (`#orphanCleanupCannot`); a second `wait` run in a **fresh process** reads the same stall from
  the ledger and the task is still running when it does (`#secondWaitFresh`); a lead is
  answered for a task it delegated, refused by name for one it did not, and told
  `no task` for one nobody has (`#leadWaitsTasks`); and `observeStall` writes each
  transition once, leaves a reading it has already written alone, and returns the
  record that beat it when another writer settled the task (`#observestallWritesTransition`). A stall
  another reader wrote while a `wait` slept ends that wait too, because the
  crossing is the event and not the write (`#stallAnotherReader`); a quiet task whose runner has
  died is reconciled rather than reported as stalled (`#quietTaskWhose`); a launch past its
  deadline is adopted and settled by the waiter's own pass (`#launchPastDeadline`), and one that
  pass cannot judge — the engine's environment unreadable — is answered at once
  with that reason and a `list_tasks` hint, having written and killed nothing
  (`#recordPassCould`); a call aborted before it polls answers `cancelled` and runs no pass
  at all (`#callAbortedPolls`); and a project whose `lockWaitSeconds` is zero has both readers
  refuse the contended record by that rule rather than the helper's own default
  (`#lockWaitZero`). The cancellation is recorded at the protocol edge as well: an unknown
  request id is ignored, and the one the notification names is answered within
  100 ms with `cancelled: true` and a reply that is still sent
  (`tests/server.test.ts#cancelledEndsWait`), including when the notification shares one stdin
  chunk with the call it cancels (`#cancellationSharingChunk`). `check` is the other writer of the two
  transitions, and writes both (`tests/tasks.test.ts#checkWritesStall`).
- **Modes (recorded, except the hosts).** `init --mode dev-team` writes section
  6's config byte for byte and it loads against the built-in mode, whose four
  roles default to read-only, read-only, `workspace-write` and read-only, with
  the temporary-directory warning on stderr (`tests/cli.test.ts#initModeDev`); `--mode
  dev-team-engine` binds the `lead` and writes the cap of 2 the placement needs,
  and `--mode solo` binds its one role and declares no git policy (`#initModeBinds`);
  `--project` writes where it names, in either flag order (`#initProjectWrites`); a mode this
  build does not have is exit 3 with nothing written, and a command line it
  cannot read is exit 2 (`#modeBuildError`); and the shebang entry point runs as `bin`
  names it (`#shebangEntryPoint`). A config carrying a `workspace` or `cwd` key, or a role key
  the mode does not declare, is refused by key and rule
  (`tests/config.test.ts#configNamesWhere`, `#loadconfigwithmodeBindsEvery`); so is an override that would make a root
  role writable, a mode default the bound engine does not accept, and a
  grok-bound lead under engine placement (`#overrideMayMake`, `#grokBoundLead`); the cap follows the
  placement and only ever falls (`#effectiveMaxDepthLower`), and `init` leaves the config directory
  holding the config alone (`#initconfigLeavesConfig`). Every mode, `solo` included, yields a
  `tools/list` with the worktree provider's four tools for the operator and lead rows and
  never for the specialist (`tests/server.test.ts#worktreeProviderTools`); `git_mutate` defaults its
  workspace and branch from that mode's own policy (`#gitMutateTakes`); `describe_mode`
  returns the loop and every role prompt byte for byte with nothing written
  anywhere (`tests/modes.test.ts#describemodeReturnsLoop`), answers every row and refuses
  with a reason when the config names a mode that is not there
  (`tests/server.test.ts#describeModeServes`), and answers a name it was given directly
  the same way rather than throwing (`tests/modes.test.ts#describemodeAnswersMissing`). The mode loader
  refuses each of its own rules by field (`tests/modes.test.ts#loadmodeRefusesMode`, `#loadmodeRefusesDocument`,
  `#loadmodeRefusesPrompt`, `#worktreeDirectoryProject`, `#enginePlacedLead`, `#loopFileContained`, `#promptFileDirectory`, `#modeDirectorySymlink`), the three built-in modes
  validate (`#builtInModesValidate`), and the two dev-team modes' role prompts are pinned equal
  until step 9 generates both (`#devTeamModes`). **No delegation starts a Grok engine as
  an engine-placed lead**, whether the config binds one or a single call names
  one, and a config edited after the server read it — a writable root role, a
  role the mode does not declare, a foreign profile, a mode swapped under a
  server whose tools are registered — is refused at the launch boundary by
  field and rule (`tests/delegate.test.ts#delegationStartsGrok`, `#configEditedAfter`). A server whose mode
  does not load, or whose config names a role it does not declare, exits 1 with
  the reason and answers nothing (`tests/server.test.ts#serverWhoseMode`). The profile a
  specialist runs under is the mode's default unless config overrides it, and a
  role the mode declares but config does not bind is refused by file
  (`tests/delegate.test.ts#profileSpecialistRuns`). Under a Claude Code host `describe_mode`
  serves that same text through `mcp__plugin_cross-agent_cross-agent__…`, the
  spelling a plugin mount gives this server (I1, `docs/probes.md#i1Spelling`), and
  under a Codex host through `mcp__cross_agent__…`, the hyphen folded
  (`docs/probes.md#codexPluginMount`); and under a Grok host as `cross-agent__…`, through
  Grok's own `use_tool`, the fourteen tools of `dev-team-engine` (`docs/probes.md#t15Attach`).
- **Operator CLI (recorded).** The listing reads without a pass when asked to,
  writing nothing (`tests/tasks.test.ts#listTasksWithoutPass`), and on it each
  read verb writes nothing: in a repository nobody initialized
  (`tests/cli.test.ts#cliReadsWriteNothingUninitialized`) and over a ledger
  holding a task in every status, byte for byte (`#cliReadsLeaveSeededLedger`);
  `tasks --reconcile` is the one read that reconciles (`#cliTasksReconcileFlag`),
  and `show` takes what it shows of a task from one read of its record, which a
  FIFO serving a second read would contradict (`#cliShowOneRead`).
  Over that ledger each verb answers by the protocol: `modes` (`#cliModes`),
  `tasks` (`#cliTasks`), `show` (`#cliShow`), `log` (`#cliLog`), `cancel`
  (`#cliCancel`), `verify-worktree` (`#cliVerifyWorktree`), `git`, the held
  `git.lock` timed (`#cliGit`), `journal` (`#cliJournal`) and `list-asks`
  (`#cliListAsks`); `cancel`'s 4 for a cascade that left a task active
  (`#cliCancelStillActive`) and an id no task file could have
  (`#cliIdOutsideAlphabet`). The verbs that write refuse inside a task's
  environment by the variable that marks it (`#cliRefusesInsideEngine`), the
  rule failing closed (`#cliWritesFailsClosed`), every misuse of a command line
  is a 2 and help names every verb and code (`#cliUsage`),
  `report` indents each final message (`#reportVerb`), and the README and the
  launcher are held to the dispatcher's verbs and protocol
  (`#cliDocsNameVerbs`).
- **Follow-ups (recorded).** A sandbox profile the engine does not declare is
  refused naming the engine once (`tests/spawn.test.ts#spawnRefusesProfileOnce`).
  The citation checker's two lexer limits are pinned as they are, so a lexer that
  learns either shape changes its header with it
  (`tests/citations.test.ts#lexerContinuedString`, `#lexerRegexAfterParen`), and
  no doc cites a line any more. A damaged ask read by id is a refusal naming the
  file, in the mailbox, in both tools and in `cross-agent answer`
  (`tests/mailbox.test.ts#readAskDamaged`, `tests/cli.test.ts#answerDamagedAsk`),
  and a lead's `list_asks` names only the damaged files that may be its own
  (`tests/server.test.ts#listAsksLeadDamaged`). In a repository nobody
  initialized, a cancel of a task nobody has writes nothing
  (`tests/tasks.test.ts#cancelUnknownWritesNothing`) and a first lock leaves its
  directory excluded (`tests/gitmutate.test.ts#gitMutateUninitializedExcluded`);
  the exclusions are written once however often and however concurrently they
  are asked for (`tests/ledger.test.ts#excludeLedgerIdempotent`,
  `#excludeLedgerConcurrent`). A host's project configuration is refused at the
  worktree's commit — in any case, and changed under an assume-unchanged mark,
  though not for the mark alone — and at the merge, which names every path it
  carries (`tests/gitmutate.test.ts#commitRefusesHostConfig`, `#hostConfigAnyCase`,
  `#commitRefusesAssumeUnchanged`, `#commitUnderIgnoreStat`,
  `tests/gitroot.test.ts#mergeRefusesHostConfig`,
  `#mergeHostConfigAnyCase`, `#mergeNamesEveryPath`), and both team loops name it
  where they say what those refuse (`tests/skills.test.ts#loopsNameHostConfig`).
  The statuses, the id alphabet and the runner log path each have one exported
  source (`tests/ledger.test.ts#taskStatusesOneSource`). The suite leaves no
  temporary directory: one `npm test` changes the listing of `/tmp` by nothing,
  where it had left 42 directories. Reconcile's helpers die before their
  directory goes: every teardown a test registers runs in order whatever an
  earlier one did, and the directory's removal comes last
  (`tests/reconcile.test.ts#teardownDrainsAll`); a helper the file spawns by
  hand has its close listened for and its cleanup registered before anything is
  awaited, so one that ends first is still heard and one whose wait fails is
  still ended (`#handSpawnedHelper`).
- **P9 (recorded):** Claude clean — `--strict-mcp-config --mcp-config <file>`
  shows exactly this server's tools and none of the operator's, and
  `--append-system-prompt-file` is obeyed; Codex clean with three settings —
  the two `mcp_servers…` keys plus
  `default_tools_approval_mode="approve"`, without which every call is refused,
  and `-c model_instructions_file="<file>"` obeyed — to which S11 added the
  per-tool timeout and the markers' whitelist; Grok not isolable — a
  child inherits the operator's servers and a project-scoped mount will not
  start in an untrusted folder (that second observation transcribed, not
  archived — see the probe row), so there is no Grok lead. **Shown at S11**: a
  mounted lead resolves to the **lead row** of the permission matrix, which is
  authority, not mounting — a real engine whose record is a running lead lists
  the lead's fourteen tools through its own server and is refused `answer` by
  name, and the same chain under a specialist's record lists five and is refused
  `ask` (`tests/authority.test.ts#mountedLeadRow`); and both real leads, Claude
  and Codex, listed the fourteen and ran the loop through them
  (`docs/probes.md#e3`, `#e2`).
- **P10 (recorded) / T8:** `codex exec resume` takes neither `-C` nor
  `--sandbox`, and keeps neither the cwd nor the sandbox of the original run.
  T8's acceptance follows from that: a resume is spawned with the process cwd
  set to the role's workspace and `-c sandbox_mode=<the role's profile>`
  re-supplied — `danger-full-access` when the role's profile is `off`, never
  an omission — and the P2 negative writes are denied on a **resumed** session
  — a write to a root file, into `<root>/.git`, to a sibling path and to
  `$HOME` — not only on the session that launched it. **Recorded** at the plan
  for every head: the launch line (`tests/engines/codex.test.ts#readOnlyRole`), a writable
  role (`#writeRoleArgv`), `off` as `danger-full-access` (`#offProfileLaunches`), the resume
  with neither `-C` nor `--sandbox` and `-c sandbox_mode=` restored
  (`#resumedRunExec`), an `off` resume (`#offRoleResumes`), and a lead's five settings
  before the prompt (`#enginePlacedLead`); and through `spawnEngine`, where the fake engine records the stdin
  and argv it was actually given (`#fakeCodexRun`, `#failedTurnSettles`). Two halves need the real
  binary, and both **ran at T14** (`tests/engines/codex.test.ts#codexI2Real`, guarded
  behind `CROSS_AGENT_REAL_CODEX=1`, so `npm test` skips it): `codex exec … -` and `codex
  exec resume <id> … -` each took the brief from stdin rather than send the literal `-`
  as the prompt, as `--help` said they would (`docs/probes.md#cliCodex`), and each of the
  resumed session's five attempts — a write inside the worktree and the four above — was
  proved from the thread's own rollout through the end-to-end verifier's reader: one
  `exec` call each, every call in the thread a `direct` script running one step, its own
  output's exit 0 inside the worktree and a denial for the root file, `<root>/.git`, the
  sibling path and `$HOME`, with the filesystem as the second witness
  (`docs/probes.md#i2Codex`). A script of any other shape fails that proof wherever it
  stands, since what it prints is its own word: a command inside a function never called,
  an exit printed by hand, a statement more, a computed command, a cell beside the steps
  (`tests/engines/codex.test.ts#codexI2ProofShape`).
- **Engine placement (recorded at S11):** end-to-end with the lead on each
  supported lead engine — **E3** under a Claude lead and **E2** under a Codex
  lead, each from a Claude Code host, each judged seven `pass` and a `?` on
  condition 8 resolved by its recorded reading, and each passing the ledger's
  depth-and-lineage reading: the lead at depth 1 alone in its lineage, every
  specialist at depth 2, the lead's child, the lead first in its lineage
  (`docs/probes.md#e3`, `#e2`). P9 rules Grok out. Cancelling the lead settles
  every descendant and reports one outcome per task
  (`docs/probes.md#injectCancelLead`); a killed lead's `ask` survives and its answer
  reaches the resumed lead (`docs/probes.md#injectKilledLeadAsk`); `git_root`
  refuses any verb outside the whitelist, any global git option, and any path
  outside the project; `run_command` refuses anything but its two selectors.
- **Failure injection, all six recorded**: a suite that fails on `<default>`
  after a merge — the journal's `merged` with both SHAs and no `tests-passed`,
  the repair path offered as `git revert --no-edit` over those two SHAs, and
  nothing dispatched after it (`docs/probes.md#injectRootSuiteFails`); an
  interruption after `worktree remove` and before `branch -d` — the operator's
  reconciliation pass deletes the branch through `git_root` and the journal
  gains `branch-deleted` (`#injectAfterWorktreeRemove`); an interrupted rebase —
  `git_mutate rebase` refused with git's conflict, `rebase --abort` journaled as a
  `git` step, no rebase state left, and the conflict put to the operator
  (`#injectRebaseConflict`); a server killed during a task (the runner records the
  outcome; a restarted server adopts it); a runner killed with the engine alive
  (engine terminated); a needs-work round through `resume`. The second three are
  recorded in `VERIFY.md`, "M3, second merge — T13", under "Failure injections": the two kills against the fake engine bound as
  `engines.claude.bin`, over the real stdio server and the real detached runner,
  and the `resume` round inside E1 with the real implementer; S11's leads ran more
  `resume` rounds on their plans. The first three ran at S11 under a Claude lead,
  beside engine placement's own two: a cancelled lead settles every descendant
  with one outcome each (`#injectCancelLead`), and a killed lead's question
  survives, is answered from a terminal, and reaches the resumed lead in its brief
  (`#injectKilledLeadAsk`).
- End-to-end under each host: plan and plan review at the root, worktree,
  implement, lead commit, code review, merge, tests, cleanup; `git worktree
  list` shows only the root, no `task/*` branch remains, `git status
  --porcelain --untracked-files=normal` is empty, the suite is green on
  `main`; `.cross-agent/tasks/` holds one record per delegation with native
  logs; the journal shows every step; no record's `depth` exceeds the cap the
  server ran under, the lower of the mode's placement cap and `limits.maxDepth`;
  the specialists' transcripts show no `delegate` and no engine launch. The eight are checked by `tools/e2e-verify.mjs`, which reads the
  project and its ledger and prints `pass`, `FAIL` or `?` — evidence missing is
  not evidence of a pass — so every host's run is judged the same way rather
  than by whatever a report greps that day. Its first two rows read the project's
  own part of the repository, since a worktree project shares the registry and the
  branches with its main checkout and its siblings. Row 1 counts the stanzas at or
  under `--project`, which must be exactly the root, naming any extra
  (`tests/e2e-verify.test.ts#rowsScopedToProject`). Row 2 first exempts a branch
  checked out exactly at a project root, this one's or a sibling's — a sibling being
  any stanza that holds a config — and names it (`#row2ProjectRootBranchExempt`); it
  then classes every other live branch of the pattern by positive evidence: checked
  out under `--project`, or named by an open journal of this project, fails the row
  (`#row2LocalLeftoverFails`, `#row2ReusedNameOpenHereFails`); checked out under a
  sibling's root, or named by an open journal there, is that sibling's, named and
  ignored (`#row2SiblingProven`); evidence on both sides, or none, is `?` with the
  claims in the detail (`#row2ConflictQuestioned`, `#row2UnknownOwnerQuestioned`). A
  journal with a `branch-deleted` step is closed and claims nothing
  (`#row2ClosedJournalClaimsNothing`), a current checkout outranks history, and an
  unjournaled branch is never taken as another project's. **E1 met all eight under Claude
  Code** — six records at depth 1, a journal of nine steps, 69 tests green on
  `main` — and is recorded in `VERIFY.md`, "M3, second merge — T13", under "E1", with its transcript in
  `docs/probes.md#e1`. **E3 and E2**, the engine-placed runs under Claude Code,
  are judged with `--since <lead id> --slug <slug>` — `s11-e3` and `s11-e2` —
  because the sample's ledger holds every earlier run's records and journals;
  each met seven, and each `?` on condition 8 was read and recorded as neither a
  launch nor a `delegate` of a specialist: E3's lead transcript holds Claude Code's
  `tool_progress` heartbeats, which the verifier has since learned in the shape E3
  recorded (`tests/e2e-verify.test.ts#claudeHeartbeat`), and E2's lead rollout a
  tool-discovery script naming `delegate` in a regular expression, which stays a
  question by the verifier's contract (`docs/probes.md#e3`, `#e2`). E2's host ran two
  read-only `git` commands of its own; once the launcher's host-loop paragraphs
  named `host` placement, E2b's host kept to the launcher's calls but closed on a
  list of its own, and E2c's, under the launcher's closing paragraph conditioned
  too, closed on the lead's report verbatim (`docs/probes.md#e2Host`). **E4 and E5
  ran under a Codex host** at T14, through the plugin, each judged with `--since` and
  `--slug`: E4, `dev-team` with Codex planning and implementing, met seven and its `?`
  on condition 8 was read as two `file_change` patches inside the task's worktree, neither
  a launch nor a `delegate` (`docs/probes.md#e4`); E5, `dev-team-engine` with a Claude
  lead, met all eight and the depth-and-lineage reading, its host kept to the launcher's
  calls, put the lead's question to the operator, and closed on the lead's report
  verbatim, with one deviation: one shell command outside the launcher's two, `cat` of the
  skill it was reading (`docs/probes.md#e5`). **E6 and E7 ran under a Grok host** at
  T15, through the project's plugin attach, each judged with `--since` and `--slug`: E6,
  `dev-team` with a Grok plan reviewer at the root and a Grok code reviewer in the task's
  worktree, met all eight, its host running the loop through the server's tools and no
  shell command (`docs/probes.md#e6`); E7, `dev-team-engine` with a Claude lead, met all
  eight and the depth-and-lineage reading, its host showed the roster before the lead,
  kept to the launcher's calls and closed on the lead's report verbatim, every specialist
  line in `cross-agent report`'s form with its duration (`docs/probes.md#e7`).
- **Docs:** every changed claim in this document matches a checked `file:line`
  or `file#symbol` in this repository or a recorded probe. `npm test` runs the
  checker, which proves a citation still lands **inside** its file; it cannot
  see a citation whose content moved out from under it, and three citation
  passes in T13 alone went stale that way. `node tools/check-citations.mjs
  --since <rev>` is the check that does: for every line citation it compares the
  cited line's text at `<rev>` with the text now and reports each one that
  differs, exiting non-zero when any does. What it cannot compare it **says**
  rather than skips — a citation past the end of `<rev>`'s copy of the file is
  reported as not judged, which is the case that hid a whole document's stale
  pointers once, `docs/probes.md` having doubled in length since the base they
  were checked against. A range is compared line by line, interior included.
  The controller runs it after every task with that task's BASE, and with the
  last commit of the previous round when a round adds lines of its own. A citation by symbol or by anchor moves with what
  it names and never reports, which is why a test is cited by an `// @anchor`
  on its `test(` line and a passage of `docs/probes.md` by an
  `<!-- @anchor -->` above it.
- For the pack (M7): every task ends with no worktree, no task branch, a clean
  root, and `npm test` green on `main`, as in 0.4.0.

## Findings from the research (kept for reference)

- Pack anatomy: zero lines of product code; one JSON package, two playbooks,
  three skill mirrors. Host-independent: the four role prompts, the lifecycle,
  the merge policy, Project facts. Host-specific: the delegation verbs, the
  wake, `create_bot`, rooms, id lookup, bind script.
- OpenMausBot 0.1.56 (Apache-2.0): Claude via `claude -p` stream-json with an
  MCP permission proxy; Codex via `codex app-server` JSON-RPC; Grok and seven
  others via ACP; team tools are a stdio MCP server injected into the engine
  process; durable delegation ledger with a wake budget; no git worktrees;
  loopback HTTP API with SSE; a shipped MCP server
  (`dist-server/mcp-server.js`) with `send_bot_message` and a 120 s
  `wait_for_conversation`. Worth porting: the recursion budget wording in
  `room-post-budget.ts`, the native event tee, the ledger shape, and the
  bind-time split its package format enforces.
- Vendor bridges installed here (`codex` 1.0.6 by OpenAI, `grok-build` 0.2.1
  by xAI): thin Sonnet forwarder agents around 4 to 5 thousand lines of
  runtime each; `codex app-server` through a broker, `grok -p
  --always-approve`; both pin cwd to the git root; both persist jobs and
  resume sessions; neither registers an MCP server. Reference for argv, job
  control, and result rendering; not a dependency.
- CLIs, as observed on 2026-09-07: Claude Code 2.1.263 (`-p`, stream-json,
  `--resume`, `--strict-mcp-config`, `--settings` sandbox JSON,
  `--disallowedTools` with `Bash(<prefix> *)` patterns, bubblewrap present,
  `--bg`); Codex 0.153.4
  (`exec --json -o -C --sandbox --add-dir --ignore-user-config
  --ignore-rules`, `exec resume`, `mcp-server`, `multi_agent` enabled, plugins
  with skills and MCP servers only); Grok 1.0.13 (`-p`, json output, `--cwd`,
  `--sandbox off|workspace|read-only|strict`, `--session-id`/`-r`, `--deny`,
  `--disallowed-tools Agent`, plugins).
- Decision 0034's Paperclip reasons: boundary bloat and private patches do not
  transfer; "wrong face" does (a plugin is terminal-shaped), which is why the
  OpenMausBot pack stays the primary binding.
- Provenance note: the vendor-plugin comparison (section 9) and the
  OpenMausBot package-schema facts (the Modes section) were established by
  reading installed sources **outside this repository** —
  `~/.claude/plugins/cache/`, read 2026-09-08, and
  `~/.cache/agent-team/openmausbot-src/` at v0.1.56. Neither is a dependency
  and neither is vendored here, so both claims are dated rather than
  reproducible from this checkout alone.
