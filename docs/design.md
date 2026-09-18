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
  Its feature tasks are M7's "first real repository" for the OpenMausBot
  pack, sent to Sudo one at a time. This repo is not bound by the devpack's
  AGENTS.md (no 500-line ceiling).
- Prose in prompts, briefs, and docs stays purposeful; no artificial length
  limit.
- The devpack's four-role team is the built-in mode **`dev-team`**. A mode is
  a directory of text plus one JSON descriptor; the core is mode-agnostic.
- The mode format is **native only**. OpenMausBot's `openmaus.package` v1 is
  not a supported import format; the devpack's role text is carried over once
  by a converter, not read at runtime.
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
the matrix inside itself (`src/delegate.ts#delegate`, `src/tasks.ts#cancel`).
The server's entry point passes no lead role yet, because only a mode names one
(step 8), so today it resolves to the operator or the specialist row, and
nothing runs a loop; what is not built below is the target the remaining tasks
are measured against.

**A lead is a session holding the lead tools and running the mode's loop.
`placement` decides which process that session is.**

| | `placement: host` | `placement: engine` |
|---|---|---|
| Who runs the loop | your host session | a spawned engine: Claude or Codex (P9; not Grok, item 4) |
| Host loads | launcher skill + the mode's loop | launcher skill only |
| Your session while it runs | busy between `wait` calls | free — `status`, `watch`, `answer`, `cancel` |
| Survives closing the session | tasks yes, loop no | yes; exclusive reattach by task id |
| Lead asks you a question | natively | `ask`/`answer` mailbox |
| Root git operations | host runs them directly | `git_root` (whitelisted verbs) |
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
`src/runner.ts:241-252`.

**The walk.** At each hop the server reads `/proc/<pid>/stat` through
`readProcessStat` (`src/ledger.ts#readProcessStat`), which returns `ppid` —
stat field 4, the element before `pgrp` — beside `startTime`, `state`, `pgid`
and `sid`. Starting at its own parent, the walk follows `ppid` for at most **8
hops** — enough for any `sh -c` wrapper an engine puts in between — and ends
without a match only at a process whose `ppid` is 0, the root. The walk **fails
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

**Resolution is revalidated on every `tools/list` and `tools/call`**, never
cached for the connection's lifetime: the server calls the resolver for each
request (`src/server.ts#createServer`), and every resolution walks in full —
at most 9 stat reads, its own first and then up to 8 ancestors', 8 environment
reads, and one scan of the records. So a lead whose record leaves
`running|stalled` loses the row on its next call, and a lead whose record
reaches `running` after its server started gains it on its next call; without
the re-walk the spawn-versus-acknowledgement race above would be permanent
rather than transient. Re-reading only a matched ancestor and its record would
save a few reads, but a full walk cannot go stale when the chain above the
server changes.

**Which project.** The server takes `--project <root>`, and the lead mount spec
will pass it — a **target** of step 11, since no mount is built
(`src/engines/types.ts#LeadMountSpec`). `childEnv` also sets
`CROSS_AGENT_PROJECT=<canonical root>` (`src/guard.ts#childEnv`), so a server a
Grok child starts from inherited configuration finds the right ledger. For a
host session with neither, the fallback is the nearest ancestor directory of the
working directory containing `.cross-agent/config.json`, resolved through `git
rev-parse --git-common-dir` so a linked worktree maps back to its main project.
`discoverProject` applies that order and answers with the canonical root or the
reason there is none, and the server exits naming that reason rather than guess
(`src/project.ts#discoverProject`, `src/server.ts#main`).

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
`mcp__cross_agent__list_roles` (`docs/probes.md:266`). The server never sees
that spelling, so nothing in the matrix depends on it.

#### Engine placement needs four things the host placement does not

1. **Root git tools.** `git_mutate` operates only on a verified linked
   worktree; `verifyWorktree` rejects the main worktree and subdirectories
   (`src/worktree.ts#verifyWorktree`). The loop also creates worktrees, merges
   on the default branch, runs the tests there, removes worktrees and deletes
   branches (section 4). Under `host` placement the host session performs those
   directly, with its own tools. An engine lead is read-only at the root, so the
   design gives it two tools whose contracts section 4 states in full:
   `git_root`, one whitelisted verb at a time, journaled, under `git.lock`; and
   `run_command`, which takes a selector rather than a command string.
2. **Cascade ownership.** A record carries `parentTaskId`, set to the lead's own
   task when a lead delegated it and preserved across `resume`
   (`src/ledger.ts#TaskRecord`, `src/delegate.ts#delegate`). **Ownership is by
   lineage ids**: a task's lineage ids are its own id and the ids of the records
   it continues, back along `resumedFrom`, and a lead owns a task whose
   `parentTaskId` chain reaches any of them (`src/tasks.ts#lineageIds`,
   `#ownedBy`). So a lead that has been killed and reattached twice still owns
   the children its first record delegated, and `wait` (T11) and the operator
   CLI ask the same question of the same helper. `cancel` on a lead writes
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
3. **The mailbox.** `ask`, `list_asks`, `answer`, backed by
   `.cross-agent/asks/<id>.json` and written by **the server or the operator
   CLI only**. No engine child can write there: it has no tool that does, and
   `.cross-agent/` sits at the project root, which no writable sandbox
   reaches — that second half holds because of the mode rule that no role may
   combine `{kind: "root"}` with a writable sandbox (the Modes section), so it
   is a guarantee and not an accident. An ask record is `{id, taskId,
   question, createdAt, status: "open" | "answered" | "cancelled", answer?,
   answeredAt?}`. `ask` blocks up to `timeout_seconds` (default
   `waitDefaultSeconds`) and returns `{id, status, answer?}`; a lead that is
   still waiting re-calls `ask` with the same `id`, which is what keeps a
   long wait inside the host's tool timeout. The first `answer` wins and later
   ones are refused, so two operators cannot both reply; cancelling a lead
   cancels its open asks; and on `resume` the launcher lists the open and
   answered asks in the resume brief, which is how an answer reaches a lead
   that was killed while waiting. The mailbox sidesteps every relay limit the
   OpenMausBot reference carries: cards that die with the turn, a
   three-per-five-minute wake budget, a four-minute ask cap, a fifteen-minute
   auto-deny. It is not built earlier because specialists are
   **unauthorized** to ask, not because they cannot reach the server: a Grok
   specialist can reach an inherited server, since the Grok exclusion list is
   empty by necessity (`src/engines/grok.ts:72-77`).
4. **Injection, now probed per engine (P9, `docs/probes.md:248-361`).** Two
   engines can carry a lead and one cannot.

   **Claude.** `--strict-mcp-config --mcp-config <file>` mounts exactly this
   server and nothing else: the child's `mcp_servers` is
   `[{"name":"cross-agent","status":"connected"}]` and the only `mcp__` tools
   are this server's (`docs/probes.md:263`). The strict flag is what makes it
   exclusive — an otherwise identical run without it saw five of the
   operator's own servers (`docs/probes.md:265`). Instructions go through
   `--append-system-prompt-file <file>`, accepted and obeyed, which closes the
   spelling question this design carried (`docs/probes.md:271-275`).

   **Codex.** `-c mcp_servers.cross-agent.command`, `…args` and
   `…default_tools_approval_mode="approve"`, all three under
   `--ignore-user-config`, mount this server plus Codex's built-in
   `codex_apps` and nothing of the operator's. The third setting is not
   optional: `codex exec` runs with approval policy `never`, so without it the
   lead sees the tools and every call is refused
   (`docs/probes.md:266`, `:285-301`). Instructions go through `-c
   model_instructions_file="<file>"`, accepted and obeyed with no role text in
   the prompt, so the loop costs a Codex lead no prompt space.

   **Grok is not supported as an engine-placed lead.** P9 found no per-run
   isolation of any kind (`docs/probes.md:268-269`, `:302-339`). A Grok child
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
   `lead.role` to `grok` is refused at load, naming the reason (section 6).

   So "the loop as the lead's system prompt" is settled rather than assumed:
   a file on Claude, a file on Codex, and no lead on Grok.

#### Two skills, and how the loop is delivered

`skills/cross-agent/SKILL.md` is the **launcher**: select the mode, start,
watch, answer, cancel, reconcile, report. It is short and host-independent.
`modes/<name>/SKILL.md` is that mode's **loop**. Hosts discover only
`skills/`, and Codex's documented fallback copies that one directory (section
9), so a mode's loop cannot be found by convention on any host. The server
serves it instead: `describe_mode` returns the active mode's loop text, its
roles, and its workspace and git policy, and the launcher's first step is to
call it. Under `engine` placement the same text also reaches the lead through
the engine's own instruction file — `--append-system-prompt-file` on Claude,
`-c model_instructions_file=` on Codex (P9, item 4 above). No asset copying, no
per-host loader, and no second copy of the loop to keep in step.

### Modes

Modes are a target: no `modes/` directory, mode loader, or `describe_mode`
exists yet; they arrive with step 8 of the work plan.

A mode is `modes/<name>/{mode.json, SKILL.md, roles/*.md}`, hand-validated in
the style of `src/config.ts` (no schema library, no dependency). `mode.json`
carries `id`, `release`, `name`, `summary`, `lead: {placement:
"host"|"engine", role?}`, `roles[{key, title, promptFile, workspace,
sandboxDefault}]`, a `git` policy, and `requires{engines?}`. Validation
refuses unknown fields, requires role keys to be unique, requires `id` to
equal the directory name, requires every `promptFile` to resolve inside the
mode directory, and requires `lead.role` exactly when `placement` is
`engine` — a host-placed mode has no lead role to name, and an engine-placed
one cannot resolve the lead row without it.

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

Two modes will ship built in:

- **`dev-team`**: the devpack's four roles (planner, plan reviewer,
  implementer, code reviewer), `placement: host`, the worktree workspace
  provider, the git policy of section 4.
- **`solo`**: one role, no git provider, `placement: host`. It is the proof
  that the seam is real, and the zero-ceremony one-shot delegation the vendor
  bridges offer.

**Workspace is policy, with two kinds.** A role declares `workspace:
{kind:"root"}` or `workspace: {kind:"worktree", branchPattern, dir}`. The
worktree provider registers `verify_worktree` and `git_mutate`, and only when
a mode declares it; `solo` therefore yields a `tools/list` without them.
Arbitrary-path workspace providers are deferred (see "Not built").

**No role may combine `{kind: "root"}` with a writable sandbox**, and mode
validation refuses one that does. A writable root role could edit
`.cross-agent/` itself — the ledger, the mailbox, the journal, the config —
and every containment argument in this document assumes those are the
server's to write. A role that must write does so in a worktree.

**A role's `workspace` and `sandboxDefault` belong to the mode, not to the
config.** Config binds `engine`, `model` and `effort` per role — `bin` is per
engine, under `engines.<e>.bin`, never per role — and may override `sandbox`
alone; a `workspace` key in `.cross-agent/config.json` is refused, and every
role key in config must name a role the mode declares.
Otherwise a local binding could move a read-only reviewer into a writable
worktree, and the mode's own containment argument (section 4) would no longer
be about the mode.

**`describe_mode` returns** `{mode: {id, release, name, summary, lead}, loop:
string, roles: [{key, title, workspace, sandboxDefault, prompt}], git}`, where
`loop` is `SKILL.md` verbatim and each `prompt` is that role's prompt file. It
refuses, with a reason, when the config's `mode` names no existing mode
directory — the launcher's first call is this one, so a missing mode has to
fail loudly at step one rather than half-way through a task.

`cross-agent init --mode <name>` writes the bind-time config for a mode.
`initConfig` already exists (`src/config.ts#initConfig`); the CLI entry point
that calls it does not.

### 1. The `cross-agent` MCP server

`src/server.ts`: stdio, JSON-RPC 2.0 written by hand (the subset is
`initialize`, `tools/list`, `tools/call`, `ping`, `notifications/cancelled`;
no dependencies, so the setup command is `none` and Node 24 runs the `.ts`
sources directly). Requests are dispatched concurrently: a pending `wait`
never blocks `check`, `cancel`, or `list_tasks` on the same connection —
that part is built and tested. Having `notifications/cancelled` abort a
pending `wait` is a target for T11: the dispatcher accepts the notification
and ignores it today (`src/server.ts#createServer`). "Registered by" says which
part of the system offers the tool: **core** always; **worktree** only when the
active mode declares the worktree provider; **engine lead** only under
`placement: engine`.

| Tool | Input | Behaviour | Registered by |
|---|---|---|---|
| `describe_mode` | — | the active mode's loop text, roles, workspace and git policy | core |
| `list_roles` | — | roles from config with engine, model, workspace kind, sandbox profile | core |
| `delegate` | `role`, `brief`, `cwd`, optional `engine`, `model`, `effort`, `resume` (task id), `force` | under the spawn lock: validates (authority, role, workspace, reservation, running and recent duplicates, resume binding), writes the ledger record as `launching`, starts the runner, returns `task_id` | core |
| `wait` | `task_id`, `timeout_seconds` (default 600) | returns when the task settles, the timeout passes, or the stall threshold is crossed: `status`, `stalled`, elapsed, last activity line, result tail | core |
| `check` | `task_id` | non-blocking status and the last activity lines | core |
| `result` | `task_id` | the final message in full, the engine session id | core |
| `cancel` | `task_id` | identity-checked termination of the runner's and the engine's process groups | core |
| `list_tasks` | optional `status` | ledger listing after reconciliation, with any invalid records reported | core |
| `verify_worktree` | `path`, `branch` | the checks of section 4; returns the explicit git-dir and work-tree to use, or a refusal | worktree |
| `git_mutate` | `slug`, `args[]`, optional `path`, `branch` | the lead's only path for mutating git in a worktree: verify, `flock`, explicit `--git-dir`/`--work-tree`, journal (section 4) | worktree |
| `git_root` | `args[]` | one whitelisted git verb at the project root, journaled, under `git.lock` (section 4) | engine lead |
| `run_command` | `which: "test" \| "setup"`, `where: "root" \| <worktree path>`, optional `timeout_seconds` | the configured command, by selector rather than by string (section 4) | engine lead |
| `ask` | `question`, optional `id` (to keep waiting on an earlier ask), `timeout_seconds` | writes `.cross-agent/asks/<id>.json` and blocks until answered or the timeout | engine lead |
| `list_asks` | optional `status` | this lead's open and answered asks; every ask for the operator | engine lead |
| `answer` | `ask_id`, `text` | the operator's reply; persisted, so it survives a killed lead | engine lead |

Statuses: `launching`, `running`, `stalled` (running, no engine event for
`stallMinutes`), `orphaned` (engine alive, runner dead), `cancelling`,
`done`, `failed`, `cancelled` (`src/ledger.ts#TaskStatus`).

Today `projectTools` registers seven of these (`src/server.ts#projectTools`):
`list_roles`, `check`, `result` and `list_tasks` for every row, `delegate`,
`cancel` and `verify_worktree` for the operator and lead rows. The server
offers and refuses each by the row it resolves, and `delegate` and `cancel`
apply the lead's own half of the matrix inside themselves — a lead delegates
no lead and no child of a cancelling parent, and cancels only what it delegated
(`src/delegate.ts#delegate`, `src/tasks.ts#cancel`). `wait` arrives with T11,
`describe_mode` with the mode loader it reads, and the rest with the tasks named
in the work plan.

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
read the reservation, refuse on an unreadable record and write `cancelling`;
the reconciliation triggers; and the four delegation fields of the record.
Everything below is built, and the one thing this section still names as a
target is `cross-agent tasks`, the operator CLI's listing (row 13).

- `src/ledger.ts`: `<project>/.cross-agent/tasks/<id>.json`, written by
  writing a temporary file and renaming it (`src/ledger.ts#writeAtomic`);
  `<id>.ndjson` is the engine's native event stream, with lines the engine wrote
  to stderr prefixed `stderr ` (`src/engines/spawn.ts:139`), not a verbatim tee;
  `<id>.out` is the final message; `<id>.runner.log` is the runner's own
  diagnostic trail (`src/runner.ts:17`). Ids are 18 random bytes in base64url
  (`src/ledger.ts#create`), so an id can begin with `-`, which is why the
  runner's argument parser consumes each option's value literally
  (`src/runner.ts:282-290`). `.cross-agent/` and `.worktrees/` are added to
  `.git/info/exclude` on first use (`src/ledger.ts#initialize`).
- Launch protocol: `delegate` creates the record as `launching` with a
  `launchDeadline` of now + 30 s (`ledger.create`, `src/ledger.ts#create`); the
  runner, once started, writes `running` with its own identity and the engine's
  identity in one atomic acknowledgement (`src/runner.ts:241-252`), conditional
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
  and by nothing else (`src/runner.ts:249-251`), so a stall clock measures from
  the moment the engine was answered for rather than from a launch nobody
  answered. There is **no launch token**: `create` writes none
  (`src/ledger.ts#create`), and a token on the *runner's* argv could not
  identify the engine anyway, because the engine is a separate detached spawn
  with adapter-built argv (`src/engines/spawn.ts:229`, `:238`). Its two jobs are
  done instead by two mechanisms that cannot be forged, and both are built:
  - **Identifying a stranded engine.** The engine carries
    `CROSS_AGENT_TASK=<id>` in its environment, and it is the **runner** that
    puts it there, from the id of the record it was started for
    (`src/runner.ts:232-235`), beside the two paths it takes from the same
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
    fails, and exits 1 without touching the record (`src/runner.ts:185-197`),
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
    could be that engine. The runner logs `not launching task <id>: <reason>`
    and exits 1 without spawning (`src/runner.ts:222-226`); reconciliation then
    adopts what is already there. The runner is started with the **server's
    own** environment and never the spec's (`src/delegate.ts#startRunner`), so
    the only process carrying `CROSS_AGENT_TASK=<id>` is the engine — the
    runner puts the assignment there itself, on the engine alone
    (`src/runner.ts:232-235`). Excluding `self` is not optional all the same: a
    server that runs inside an engine carries that engine's task id, and so do
    the children it starts, so a scan that counted them would have a task stand
    down for itself. The unreadable case is decided by the asymmetry: standing
    down costs one failed delegate the lead can see and retry, and a second
    engine costs concurrent work in one worktree that no record accounts for.
    Its residual is the same one reconciliation has — a same-uid non-dumpable
    leader holds launches off until it exits — and the same bead bounds it
    (`atc-s96.31`). Because a task has at most one engine, the reconciler adopts
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
  the engine's environment (`src/runner.ts:232-235`) — because the record, not
  the spec, names what this runner spawns. The adapter module path is always an
  entry of the fixed built-in table of section 3; config cannot name one.
- `src/runner.ts`: a detached process per task (`node src/runner.ts --project
  <root> --task <id>`) that owns the engine child in its own process group,
  tees events, updates `lastEventAt` on a 2-second interval
  (`src/runner.ts:263-271`), and on engine exit writes the terminal record and
  `<id>.out` itself, so completion survives the MCP server. On SIGTERM
  (`src/runner.ts:202`) it writes `cancelling` itself (`src/runner.ts:120-122`),
  terminates the engine group, and writes `cancelled`
  (`src/runner.ts:101-180`). Group cleanup always precedes terminal
  settlement (`src/runner.ts:132`). The `cancelling` write is a claim the
  teardown may skip: a record already `cancelling` is the server's own write of
  this same cancel, and one that is `orphaned` may not pass through `cancelling`
  at all, because the ledger allows `orphaned → failed | cancelled` and
  nothing else — so from either the runner settles `cancelled` from where the
  record is (`src/runner.ts:119-130`, `:172-175`, bead `atc-s96.39`). The
  settlement also reads the record for itself when it has none
  (`src/runner.ts:115`), so a cancel or a lost lock arriving before the first
  read settles rather than exiting through `fatal` (bead `atc-s96.29`); both are
  recorded (`tests/runner.test.ts:1295`, `:1321`). Three rulings from the
  reviews attach to this same teardown path:
  - **A lost lock is a lost task.** `acquire` watches its helper child and
    sets `lock.lost`, calling an optional `onLost`, if the child exits before
    `release` (`src/locks.ts#Lock`, `#AcquireOptions`, `#acquire`) — the
    kernel has already let the next waiter in, so a holder that carried on would
    be acting on exclusivity it no longer has. The runner registers `onLost` for
    `runner-<id>.lock` (`src/runner.ts:188-191`): it stops the engine group and
    settles `failed` with the reason `runner lock lost`. `update`'s own short
    lock ignores `lost`; it is released in the same call that took it.
  - **A group with no identity is still terminated.** If the leader exits
    after spawning a descendant and before `identityOf` succeeds, the runner
    has no `engineIdentity` to name the group with (`src/runner.ts:242-244`).
    But the detached spawn made `handle.pid` both the group and the session id,
    and the kernel keeps that id reserved while any member lives, so the runner
    terminates the group by scanning `/proc` for members holding that id
    (`src/process.ts#terminateGroupByPid`) before settling `failed`
    (`src/runner.ts:72-77`). Killing the direct child alone would settle the
    task with its descendants still running.
  - **`truncated` on every settlement.** The evidence patch the runner writes
    carries `truncated: outcome.truncated` whether the task ends `done`,
    `failed` or `cancelled` (`src/runner.ts:141`), because a completed task can
    be missing the tail of its log too; the `; output truncated` suffix on a
    failure's `reason` stays (`src/runner.ts:155`).
- **The three cancel writers, all built.** `cancel` claims the record
  `cancelling` and sends SIGTERM to the runner it verified, waits
  `limits.cancelGraceSeconds` for the runner to settle the task itself, and only
  then ends the engine group by the identity the record carries, escalating to
  SIGKILL on both (`src/tasks.ts#terminate`, `src/config.ts#limitDefaults`). A
  runner it can see is dead is not waited for, and a record with no engine
  identity is left `cancelling` and named in the outcome rather than settled
  over an engine nothing could reach again. The second writer is the runner
  itself, which answers that SIGTERM (`src/runner.ts:119-130`). The third is
  reconciliation, which settles a `cancelling` record whose runner is dead by
  terminating the engine group by identity and then writing `cancelled`
  (`src/reconcile.ts#judge`). So the terminal writers are the runner (`done`,
  `failed`, `cancelled`) and, only when the runner is dead and the engine group
  is verified dead, the reconciler (`cancelled` or `failed`).
- **Conditional update.** `ledger.update` is asynchronous: it takes
  `record-<id>.lock` around one read, one check, and one rename, and returns
  `{applied: true, record}` or `{applied: false, record, reason: "terminal" |
  "expect"}` (`src/ledger.ts#UpdateResult`, `#update`). `create`, `read`, and
  `list` stay synchronous. `options.expect?: (record) => boolean` is evaluated
  **inside** the lock (`src/ledger.ts#update`); there is no `TerminalTaskError`,
  because a caller that must distinguish "I wrote it" from "someone else owns
  it" needs a value, not an exception — any non-throwing return would
  otherwise make the runner's `write()` true (`src/runner.ts:36-51`) and let it
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
  cancelling | orphaned | done | failed`, `orphaned → failed | cancelled`, and
  `cancelling → cancelled | failed` (`src/ledger.ts#transitions`); any other
  transition throws, because it is a bug in a writer, not a race to be
  tolerated. `launching → orphaned` (`src/ledger.ts#transitions`) is the
  adoption edge, and it exists so that adoption never passes through `running`:
  a record that is `running` with an `engineIdentity` satisfies every clause of
  the authority match (the lead model), so an adoption that wrote `running`
  first and `orphaned` second would hand the stranded engine a lead's authority
  for as long as the second write was delayed or refused.
- **Acknowledgement and cancellation.** The runner acknowledges with `expect:
  status === "launching"` (`src/runner.ts:249-250`). On `applied: false` with
  `record.status === "cancelling"` it **treats the refusal as a cancel**
  (`src/runner.ts:254-258`): stop the engine group, then write `cancelled` with
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
  stderr at start and returned in `errors` and `skipped` to the listing. It
  judges an engine by the **group scan** (`src/process.ts#hasMember`,
  `#inspectGroup`), never by the leader's pid alone: a leader that has been
  reaped while a descendant lives becomes `orphaned` and is cleaned up, not
  `failed: runner lost`. It judges the runner, which is one process, by pid and
  start time, and a runner in state `Z` or `X` has exited and owns nothing
  (`src/ledger.ts#isProcessAlive`), which is the same test the group scan
  applies to a member (`src/process.ts#live`). Its four cases
  (`src/reconcile.ts#judge`):
  - `launching` past its deadline: the environ scan above, then `orphaned` or
    `failed: launch`;
  - `running` or `stalled` with a dead runner: `orphaned` if the engine group
    is alive, otherwise `failed: runner lost`;
  - `cancelling` with a dead runner: terminate the group by identity, then
    `cancelled`;
  - anything else: untouched. In particular `stalled → running` when events
    resume is T11's job, not the reconciler's; the reconciler never revives a
    task.

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
  `process.kill`, a decision another writer overtook. Those two are answers, not
  exceptions, because **the escalation is one helper**: SIGTERM, a grace,
  SIGKILL, a shorter grace, written once as `terminate`
  (`src/process.ts#terminate`) and reached through `terminateGroup`
  (`#terminateGroup`). It never throws — an EPERM or a group that will not die
  is reported as `false` — and both callers consume that boolean,
  `terminateOrphans` to skip the record with its identity named and
  `src/reconcile.ts#judge` to leave a `cancelling` record named for the next
  pass. A caller judging many records has to be able to report a survivor and
  carry on. One escalation is still written out by hand: the runner's
  identity-captured branch, which sequences `killGroup` and `waitForGroup`
  itself and throws when the group survives (`src/runner.ts:66-71`). That is the
  remaining duplicate, and folding it onto the helper — with telling an EPERM
  apart from a group that would not die — is `atc-s96.31`. The runner's other
  branch, the one with no identity to name the group by, already goes through
  the helper (`src/runner.ts:72-77` → `src/process.ts#terminateGroupByPid`),
  as the settlement bullet above states. Killing the strays is the one step that
  runs **after** the decision has been written, so it reports the pids it could
  not signal instead of throwing (`src/reconcile.ts#killStrays`, `#adopt`):
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
  nothing could reach. Adoption also takes only a **group leader** (`pid ===
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
  engine spawn can have. The residual is stated rather than hidden: a same-uid
  non-dumpable leader started during the task holds the record `launching` until
  it exits, and bounding that hold in time is a later bead (`atc-s96.31`).
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
  (`src/tasks.ts#listTasks`). **Target**: `cross-agent tasks` naming the file
  (row 13).
- **Locks** are OS-held and never reclaimed (`src/locks.ts#acquire`). A lock is
  `flock(2)` on a file under `.cross-agent/locks/`, taken by a helper that keeps
  a util-linux `flock` child alive on a pipe (`flock <file> sh -c 'echo held;
  read _'`, `src/locks.ts#acquire`): the helper knows it holds the lock when the
  child prints, releases it by closing the pipe, and the kernel releases it when
  the holder dies, so a dead holder needs no TTL, no stale detection, and no
  rename. (An earlier recipe, an `O_EXCL` file with a TTL and a rename-based
  reclaim, was refuted in T5's plan review: a reclaim by pathname can rename the
  winner's fresh lock, so two reclaimers could both succeed.) Four locks, all
  four named in one place and resolved through `lockPath`
  (`src/locks.ts#lockPath`): `spawn.lock` around `delegate`'s validate-and-spawn
  and around the whole of a `git_mutate` call (`src/locks.ts#spawnLockName`,
  `src/gitmutate.ts#gitMutate`); `record-<id>.lock` around every ledger
  read-check-rename, taken inside `update` (`src/locks.ts#recordLockName`);
  `runner-<id>.lock` held by a runner for its lifetime
  (`src/locks.ts#runnerLockName`); and `git.lock` around every lead git
  mutation, taken by `git_mutate` inside its `spawn.lock`
  (`src/locks.ts#gitLockName`, `src/gitmutate.ts#mutate`). All four are taken by
  built code today: `delegate` and `cancel` hold `spawn.lock` — the one around
  validate-and-spawn, the other around the parent's claim and the snapshot of
  its descendants (`src/delegate.ts#delegate`, `src/tasks.ts#cancel`). **One
  helper, one waiting rule**: every waiter blocks up to `lockWaitSeconds` and
  then refuses, naming the operation. The key is in config and validated — a
  finite number, defaulting to 5 and refused when negative, because `flock -w
  -1` sets no timer and exits before it looks at the file, which the helper
  would read as a live holder (`src/config.ts#CrossAgentConfig`,
  `#limitDefaults`, `#loadConfig`) — and the helper's own default is the same
  5 (`src/locks.ts#acquire`). Every acquisition but the runner's own claim reads
  the configured value — that one is `waitSeconds: 0` by design, below.
  `git_mutate` takes it as an argument, so that module stays a function of what
  it is handed (`src/gitmutate.ts#GitMutateOptions`); `update`'s callers read it
  once per process or per pass through `lockWaitSeconds(projectRoot)`
  (`src/runner.ts:20`, `src/reconcile.ts#reconcile`,
  `src/process.ts#terminateOrphans`), a helper that answers with the documented
  5 when no config can be read (`src/config.ts#lockWaitSeconds`) — locks are
  taken on paths that run before anyone has a readable config, and a caller
  whose only question was how long to wait should not be thrown at (bead
  `atc-s96.34`, closed). Nothing uses `flock -n`; a caller that wants no wait
  passes `waitSeconds: 0`. The one exception to the waiting rule is
  `runner-<id>.lock`, whose whole purpose is an immediate failure, so the second
  runner takes it with a zero wait and exits.
- **Bounded settlement.** `spawnEngine` settles on the child's `exit` plus a
  bounded stdio drain (`drainMs`, default 2000; `src/engines/spawn.ts:254-267`)
  and on `close` if that arrives first (`src/engines/spawn.ts:249`); on timeout
  the data listeners are detached and the streams destroyed **before** the
  promise resolves, and the result carries `truncated: true`
  (`src/engines/spawn.ts:258-265`). Settling on `close` alone hangs whenever a
  grandchild inherited stdout and holds it open: `handle.result` would never
  resolve and the task would stay `running` with no engine. Probe P3b records
  the shape of it — a nested `claude -p` still running when its parent's turn
  ended — and the suite exercises both descendants: one that inherits stdout
  and one that does not (`tests/runner.test.ts:142`, `:146`, `:640`, `:660`).
  The drain timer starts at `exit`, not at the last byte; `truncated` covers
  stdout and stderr together, since a reader cannot tell which stream lost the
  tail; and finalisation happens exactly
  once, claiming the `settled` flag **before** the final flush
  (`src/engines/spawn.ts:176-185`), so nothing entered twice and nothing after
  the flush is read as a child still worth signalling, while a buffered partial
  line is still evidence and is flushed into the result. A stream or process
  error arriving after the result has resolved is recorded and returned to its
  own caller but never mutates the result the caller already holds
  (`src/engines/spawn.ts:114-116`, `:225`) — a late error cannot rewrite a
  delivered outcome. `SpawnResult.truncated` is persisted on the task record
  for every settlement (`src/runner.ts:141`) and appended to `reason` when the
  task failed (`src/runner.ts:155`), so an operator reading a failure knows
  whether the evidence is complete.
- **The worktree reservation**: computed, and consulted by `git_mutate`; its
  use in `delegate` is a target. `reservations(projectRoot)` walks one `scan`
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
  (`src/gitmutate.ts#mutate`); `git_root` and `cross-agent git` are targets of
  rows 11 and 13 and take the same lock. What the locks give, stated exactly:
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
  exists to prevent. Once the `launching` record exists the reservation is a
  fact in the ledger rather than a claim on a lock, `runner-<id>.lock` governs
  from there, and `delegate` returns normally however `spawn.lock` ends
  (`src/delegate.ts#delegate`). A read-only spawn during a git mutation is
  allowed and is not a defect: it reads a tree mid-change, which is what a
  reviewer reading a moving branch would see anyway.

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
or spawned (`src/engines/spawn.ts#spawnEngine`, `:79-83`).

**The engine contract is adapter-owned and closed.** Flag knowledge is off
`src/guard.ts`'s per-engine switches — where the comment that replaced them
points at the contract instead (`src/guard.ts:120-121`) — and on
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
  run at all, so it stays `atc-s96.17`'s.
- `denyArgs(targets)` and `exclusionArgs()`
  (`src/engines/types.ts#EngineAdapter`), each engine's own: Claude both deny
  forms in one appendable `--disallowedTools` array and `--strict-mcp-config`
  for exclusion, Codex an empty deny list and `--ignore-user-config`, Grok one
  `--deny` per target and no exclusion flag at all. Every `plan` spreads both
  into its argv whatever its own engine answers today
  (`src/engines/claude.ts:106`, `:137`, `src/engines/codex.ts:109`,
  `src/engines/grok.ts:131`), so an engine that gains a deny form or an
  exclusion flag gains it by returning one.
- `leadMount(spec: LeadMountSpec, scratchDir: string): LeadMount`
  (`src/engines/types.ts#EngineAdapter`, `#LeadMountSpec`, `#LeadMount`) — the
  argv that mounts exactly this server for a lead under `placement: engine`. P9
  settled what each engine can do (`docs/probes.md:261-269`). Claude writes an
  MCP-config JSON into `scratchDir` and returns `--mcp-config <file>` beside the
  `--strict-mcp-config` its `exclusionArgs` already emits; the strict flag, not
  the config file, is what makes the mount exclusive, since dropping it from an
  otherwise identical run pulled in five of the operator's own servers
  (`docs/probes.md:265`). Codex returns **three** settings — `-c
  mcp_servers.cross-agent.command=…`, `…args=…`, and `-c
  mcp_servers.cross-agent.default_tools_approval_mode="approve"` — because
  `codex exec` runs with approval policy `never`, so without the third the lead
  sees the tools and is refused every call (`docs/probes.md:285-301`); it
  refuses a non-empty `spec.env` (`src/engines/codex.ts:79-81`), because no
  probed setting carries a server environment and a lead's project reaches it
  through `args`. Grok returns an empty argv with `inherited: true`, because it
  has no per-invocation mount at all; that value describes the specialist path
  and the operator CLI's own registration, not a lead, because Grok is not a
  supported lead engine ("The lead model", item 4). Returning the files to
  write, rather than writing them, keeps the adapter a pure argv builder as
  `plan()` is.
- `parseStderrLine?(line: string): EngineEvent | null`
  (`src/engines/types.ts#EngineAdapter`), the same as `parseLine` for an engine
  that writes a fatal line to stderr rather than into its event stream. **Claude
  declares it and no other adapter does** (`src/engines/claude.ts:186-188`;
  `tests/engines/codex.test.ts:401`, `tests/engines/grok.test.ts:370`): P1's two
  sandbox failures — the "Sandbox disabled" warning and the `apply-seccomp`
  message every command inside a broken sandbox dies with — are invisible
  before the spawn and are not errors the engine reports of itself, so the line
  is the verdict. The pipeline reads stderr for an adapter that declares this
  and for no other (`src/engines/spawn.ts:92`, `:149-150`), so everywhere else
  stderr stays log evidence and nothing more. Such an `error` event is **fatal**
  — `ok` is false however the engine exited (`src/engines/spawn.ts:222`) —
  and it advances `lastEventAt` exactly as a stdout event does, deliberately: an
  engine whose every command dies in the sandbox is working, not stalled, and
  the stall detector must not be the thing that reports a failure the events
  already carry (`src/engines/spawn.ts:163-166`). The pipeline records **one**
  such event per run and stops asking after it, because a sandbox that engages
  and then fails at its own setup repeats itself once per command; the latch is
  the run's, not the adapter's, so `parseStderrLine` stays a pure function of
  one line and a singleton adapter leaks nothing from one run into the next
  (`src/engines/spawn.ts:105-107`, `:148`, `:162`).
- `finish?(rawStdout: string): EngineEvent[]`
  (`src/engines/types.ts#EngineAdapter`), for an engine whose output is one
  document at exit rather than a line stream. **No adapter declares it**, and
  the hook's only exercise is the fake engine's `grok-json` format
  (`tests/fixtures/fake-engine.mjs:50-53`), which is the shape it exists for:
  all three formats below are line streams, and a declared `finish` would only
  make the pipeline buffer raw stdout for a call with nothing to read
  (`tests/engines/claude.test.ts:413`, `tests/engines/codex.test.ts:401`,
  `tests/engines/grok.test.ts:370`). The hook and the pipeline's half of it are
  built and tested all the same, because Grok's `json` mode is the fallback an
  adapter would need it for. The pipeline binds it once, before the spawn, and
  buffers raw stdout only for an adapter that declares it
  (`src/engines/spawn.ts:90`, `:151`); it runs once at completion, after the
  last byte and **before** `finalMessage`, and its events are appended, so a
  late `session` or `result` still counts (`src/engines/spawn.ts:193-202`). A
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
check on the derived mode (`src/engines/spawn.ts:67-83`). The reservation
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
(`src/engines/spawn.ts:230-236`, `:269-272`). `LaunchSpec` is
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
(`src/engines/binaries.ts#commandPath`). Neither falls back to `process.env`:
`plan` and `sandboxSupport` are handed the same environment, which is the
spec's, so one binary is judged and spawned and a configured `engines.<e>.bin`
reaches both (`atc-s96.10.1`, closed). Config-declared adapter modules are not
supported, and the reason is in the code: the runner imports the spec's
`adapterModule` into its own process, unsandboxed (`src/runner.ts:208-209`), and
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

- **Claude** (`src/engines/claude.ts:96-143`): `claude -p --output-format
  stream-json --verbose --permission-mode bypassPermissions
  --strict-mcp-config` — then, for an engine-placed lead only, `--mcp-config
  <file>` — then `--model <m>`, `--effort <e>`, `--session-id <uuid>` or
  `--resume <id>` and never both, `--append-system-prompt-file <role.md>`,
  `--settings <sandbox json>`, and last `--disallowedTools <deny list>`. cwd =
  the role's workspace, passed through as the request wrote it because it is
  already canonical and the writable root has to name the directory the child
  sees (`tests/engines/claude.test.ts:292`). **The mount goes immediately after
  the flag that makes it exclusive and before `--model`**, which is the order
  P9 ran and the one that leaves only one variadic flag at the end of the
  line: `--mcp-config` takes `<configs...>` (`docs/probes.md:436-437`), so the
  last flag has to be `--disallowedTools`, whose values end the argv. **The
  brief goes on stdin**, so no positional argument follows that variadic
  flag either (`src/engines/claude.ts:143`). The four cases are pinned byte
  for byte — read-only, writable, resumed, and with a lead's mount and its
  config as a plan file (`tests/engines/claude.test.ts:189`, `:213`, `:236`,
  `:251`).
  Sandbox through the settings JSON (`sandbox.enabled`,
  `filesystem.allowWrite`, `autoAllowBashIfSandboxed`;
  `src/engines/claude.ts:97-102`). Read-only roles get no `allowWrite` and no
  `Edit`/`Write` tools (`src/engines/claude.ts:102`, `:138`).
  `--append-system-prompt-file <role.md>` is **settled by P9**
  (`docs/probes.md:263`, `:271-275`): `claude --help` documents that
  spelling only as the `[-file]` form of `--append-system-prompt`, but the
  binary accepts the flag and the child obeys the instruction in every
  assistant message, so a Claude role prompt travels as a file and never as
  prompt text. That file is the task's own: it goes in `scratchDir`, never
  inside the specialist's worktree, which the role may edit
  (`src/engines/claude.ts:127-131`). Prerequisites on Linux are three, all
  from P1: `bwrap`, `socat`, and on Ubuntu 24.04 or later an AppArmor profile
  for `/usr/bin/bwrap` with `flags=(unconfined)` and `userns`. The adapter
  answers the two failure modes in the two places each can be seen:
  `sandboxSupport()` names whichever of `bwrap` and `socat` is missing from
  `PATH` before the spawn (`src/engines/claude.ts:62-69`), and
  `parseStderrLine` turns the
  "Sandbox disabled" warning and the `apply-seccomp` message of a sandbox that
  engages but cannot start any command into a fatal `error` event during the
  run (`src/engines/claude.ts#sandboxFailure`, `:186-188`), because that half
  cannot be seen before it.
- **Codex** (`src/engines/codex.ts:100-150`): `codex exec --json -o <out> -C
  <cwd> --sandbox <read-only|workspace-write|danger-full-access>
  --ignore-user-config --skip-git-repo-check -m <m>
  -c model_reasoning_effort="<e>" -c model_instructions_file="<role.md>"` —
  then, for an engine-placed lead only, the three `-c mcp_servers…` settings
  — and last the positional `-`. **The brief goes on stdin and `-` holds its
  place** (`src/engines/codex.ts:140-145`, `:150`): a bare positional is
  misread as a flag the moment a brief begins with `-`, and a brief is prose a
  lead composes, not a string this file controls. Both heads document the
  spelling (`codex-cli` 0.153.4 `--help`, `docs/probes.md:462-473`), and the
  `-o` file is emptied before the spawn so a dead run cannot report the
  previous one's last message as its own (`src/engines/codex.ts:119`,
  `tests/engines/codex.test.ts:291`). The launch, write, `off` and resumed
  lines are pinned byte for byte (`tests/engines/codex.test.ts:162`, `:187`,
  `:204`, `:217`, `:244`, `:301`). Resume is a **different flag set**: `codex
  exec resume <thread id>` accepts `-c/--config`, `--last`, `--all`,
  `--enable`, `--disable`, `-i/--image`, `--strict-config`, `-m/--model`,
  `--dangerously-bypass-approvals-and-sandbox`,
  `--dangerously-bypass-hook-trust`, `--thread-source`,
  `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`,
  `--ignore-rules`, `--output-schema`, `--json`, and
  `-o/--output-last-message`, and **neither `-C` nor `--sandbox`** (`codex exec
  resume --help`, 0.153.4, read 2026-09-09 and recorded at
  `docs/probes.md:457-462`). So the resume line is `codex exec resume <thread
  id> --json -o <out> --ignore-user-config --skip-git-repo-check -m <m> -c
  model_reasoning_effort="<e>" -c sandbox_mode="<the role's Codex profile>" -c
  model_instructions_file="<role.md>" -`, spawned with the **resuming
  process's** cwd set to the role's workspace
  (`src/engines/codex.ts:106-108`, `:114`, `:150`). The instructions file is
  re-supplied for the same reason the sandbox is: a `-c` setting belongs to the
  process, and the resumed thread is a new one. The
  profile is the key of `sandboxProfiles` the role names, so `off` resumes as
  `-c sandbox_mode="danger-full-access"`, the same value the launch path gives
  `--sandbox`; there is no unsandboxed resume by omission. P10 settled why both
  halves are the adapter's work (`docs/probes.md:377-399`): a resumed thread
  keeps neither the cwd nor the sandbox of the original run. The writable root
  of a workspace-write sandbox follows the resuming process's cwd, so a resume
  started one directory up wrote a file into the repository root that the
  original turn had been refused — the failure is silent, not an error. `-c
  cwd=<dir>` is ignored; the process's own cwd is the only lever. The thread
  itself comes back read-only, which is the safe direction but not necessarily
  the role's, and `-c sandbox_mode=` restores it exactly. So
  `SpawnRequest.sandbox` is re-applied by the adapter on every resume, from
  `sandbox.profile`, and never assumed from the thread. `--ignore-user-config`
  keeps auth, raises no trust prompt, and removes the user's MCP servers,
  leaving only Codex's built-in `codex_apps` (P5; P5 does not speak to plugins
  or marketplaces). Codex carries **no deny list**: probe P3 showed that
  execpolicy rules files are not honoured by `codex exec`, so its sandbox's
  network denial is the layer that holds instead, and a launched engine cannot
  reach its API (P3b). `codex exec` is chosen over `codex app-server` — the
  transport `codex-plugin-cc` uses — because `exec` needs no dependency and no
  second JSON-RPC client inside this server; the cost is execpolicy and a
  native `review/start`, neither of which this design uses. A Codex lead's
  mount is the three `-c mcp_servers…` settings above under
  `--ignore-user-config`, and its instructions reach it through `-c
  model_instructions_file="<file>"` — accepted and obeyed with no role text in
  the prompt at all, so a Codex lead spends no prompt space on the loop (P9,
  `docs/probes.md:266`, `:285-301`). Every role's instructions travel that way,
  lead or specialist, in a `role.md` under `scratchDir`
  (`src/engines/codex.ts:126-130`, `tests/engines/codex.test.ts:260`).
- **Grok** (`src/engines/grok.ts:95-136`): `grok -p <prompt> --cwd <cwd>
  --sandbox <workspace|read-only|strict|off> --permission-mode
  bypassPermissions --output-format streaming-messages-json --session-id
  <uuid> | -r <id> --model <m> --reasoning-effort <e> --rules <role text>`
  plus one `--deny` per deny-list entry, ending the argv, the same on resume.
  There is **no lead head at all**: `plan` refuses a request carrying `lead`,
  because P9 found no per-run mount it could build one from, and that is the
  gate no configuration can reach around (`src/engines/grok.ts:101-103`,
  `tests/engines/grok.test.ts:271`). **The prompt is `-p`'s own value**, so
  nothing goes on stdin and the plan names no files: Grok reads none that this
  adapter writes (`src/engines/grok.ts:136`,
  `tests/engines/grok.test.ts:143`). `strict` and `off` are the two
  `--sandbox` values no run has exercised: P2 ran `workspace` and `read-only`,
  and `--help` does not enumerate the profiles (`docs/probes.md:428-435`).
  Every flag takes exactly one value, which is what lets the deny list end the
  line without swallowing anything (`tests/engines/grok.test.ts:224`); the
  writable, read-only, every-profile and resumed lines are pinned byte for
  byte (`tests/engines/grok.test.ts:143`, `:168`, `:190`, `:205`). **P8 chose
  the format** (`docs/probes.md:187-246`). `streaming-messages-json` is NDJSON
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
  leaves `lastEventAt` null for the whole run (`src/engines/spawn.ts:158-166`
  advances it only on a parsed event) and so makes every Grok task look
  stalled and `check` show nothing. That shape is the fake engine's
  `grok-json` format (`tests/fixtures/fake-engine.mjs:50-53`, `:88-90`,
  `tests/spawn.test.ts:705`), and it is what the pipeline's `finish` tests are
  run against, because it is the case the hook exists for
  (`tests/spawn.test.ts:780`, `:799`). `--effort` is an alias of
  `--reasoning-effort`. **The role prompt goes through `--rules <role
  text>`**, which is Grok's system-level path and so the counterpart of
  Claude's `--append-system-prompt-file` and Codex's `-c
  model_instructions_file=`: P9 honoured both it and a prompt prefix, and the
  system-level one keeps the role out of the turn's own text
  (`docs/probes.md:302-339`). It takes a **string**, not a path — given a role
  file's path it put the path into the system prompt as literal text and the
  child read the file itself — so the adapter passes the role's *contents*,
  and falls back to prepending them to the prompt only when the text would
  exceed the argv limit, which is the one case a flag cannot carry. The
  ceiling is 100 KiB, below Linux's 128 KiB cap on a single argument with room
  for the rest of the line (`src/engines/grok.ts#rulesLimit`, `:109-110`,
  `tests/engines/grok.test.ts:236`, `:249`). So Grok is the one engine whose
  role prompt reaches the child without a file on disk. `--sandbox workspace` is
  deliberately stricter than `grok-build-plugin-cc`'s write mode, which omits
  `--sandbox` entirely.

Deny list for Claude and Grok, rebuilt from config at spawn
(`src/guard.ts#denyTargets`): the commands `claude`, `codex`, `grok`, each
configured `engines.<e>.bin` path, `node <absolute path of src/server.ts>`,
`node <absolute path of src/cli.ts>`, and `cross-agent`. The targets are the
guard's; the forms are each adapter's `denyArgs`. Claude `Bash(<target> *)` and
`Bash(<target>)` in one appendable `--disallowedTools` array (enforced under
`bypassPermissions`, P3); Grok one `--deny "Bash(<target> *)"` per target
(enforced, P3); Codex an empty argv, because `codex exec` does not honour an
execpolicy rules file and its children rely on the sandbox's network denial
instead (P3b). Each builder is unit-tested for the exact list in its adapter's
own test file; P3 covers each target on each engine, including a resumed
session.

Sandbox facts from the probes that the adapters must respect: Codex and Grok
treat `/tmp` and `$TMPDIR` as writable, so a project there is not isolated
(`cross-agent init` warns, `src/config.ts#temporaryLocationWarning`); Codex
refuses to rewrite the worktree's `.git` pointer, Grok allows it, so tampering
is detected by `verify_worktree`, not prevented (P2). A Grok child **does**
inherit the user's MCP configuration — Grok has no per-invocation exclusion
flag, only a persistent `grok mcp` subcommand — and P9 recorded how far that
reaches (`docs/probes.md:268-269`, `:302-339`): a Grok child sees the servers in
`~/.grok/config.toml`, the servers Grok plugins bring, and the servers the
operator declared to *Claude* in `~/.claude.json`. So a `cross-agent` server
started by that child is a real, reachable server, and what makes that safe is
the specialist row it resolves to by ancestry (section 5), not an exclusion
flag.

**Child env** (`src/guard.ts#childEnv`) is a **blocklist**, not an allowlist. It
copies the parent environment and removes: the exact names `CLAUDECODE`,
`CLAUDE_PID`, `CLAUDE_EFFORT`; anything starting with `CLAUDE_CODE_`,
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
named where it occurs. P2 for Claude is **outstanding**, waiting on the
`bwrap` AppArmor profile (`atc-s96.17`), so the Claude sandbox row of that
probe is a `--help` and P1 fact rather than a run. And the flags no run had to
exercise — `codex exec`'s and `codex exec resume`'s full option lists, the `-`
positional each of those two heads reads stdin behind, Claude's `--effort`,
Grok's `--reasoning-effort` and its `--effort` alias,
`--system-prompt-override` and `--include-partial-messages` — are `--help`
readings, recorded with their CLI
versions in the same file (`docs/probes.md:408-465`; Claude Code 2.1.266, Codex
0.153.4, Grok Build 1.0.13). No other claim in this section is waiting on a
probe.

### 4. Git ownership

The worktree half of this section is built: `verify_worktree` and
`src/worktree.ts` from T2, and `gitMutate` from T6 (`src/gitmutate.ts`) with
the reservation, both locks and the journal. What is left is the wiring and
the root half — registering the two tools on a mode's worktree provider
(row 8; `verify_worktree` itself is registered today for the operator and lead
rows, `src/server.ts#projectTools`), `git_root` and `run_command` (row 11), and
the `cross-agent git` CLI (row 13).

Specialists never write git metadata. A linked worktree's `.git` is a writable
file inside the implementer's sandbox, so the lead never trusts it:
`git_mutate` (and the identical `cross-agent git <slug> -- <args>` CLI) is the
only way a lead mutates git in a worktree. Its request is `{slug, path?,
branch?, args}` (`src/gitmutate.ts#GitMutateRequest`): `path` defaults to
`<root>/.worktrees/<slug>` and `branch` to `task/<slug>`, the worktree
provider's own defaults (`src/gitmutate.ts#gitMutate`), and row 8 makes both the
mode's to configure, since `dir` and `branchPattern` are already the mode's. The
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
recordable before anything runs. The four steps then run with `spawn.lock` held
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
   reason (`src/gitmutate.ts#mutate`, section 2);
2. verifies the worktree from the root, with the checks
   `verifyWorktree` performs (`src/worktree.ts#verifyWorktree`): `realpath` of
   both paths; the worktree appears in `git worktree list --porcelain -z` as a
   linked worktree, which excludes the main worktree and any subdirectory
   (`:72`); its `.git` is a regular file, not a symlink (`:76-78`); `git
   rev-parse --git-dir` resolves to a directory whose **parent** is
   `<root>/.git/worktrees` (`:85-88`) — the check is on the parent directory,
   not on equality with a slug-derived name; `--git-common-dir` equals
   `<root>/.git` (`:89-91`); `--abbrev-ref HEAD` is exactly the requested branch
   (`:92-94`); and the administrative directory's own `gitdir` backlink resolves
   to that worktree's `.git` and no other (`:96-102`), which is what rejects a
   pointer redirected at a sibling. On success it returns `{gitDir, workTree,
   branch}` (`:103`); a refusal is returned to the lead as the verifier's own
   `reason`, verbatim (`src/gitmutate.ts#mutate`);
3. runs, while `.cross-agent/locks/git.lock` is held, `git --git-dir=<the
   gitDir verify_worktree returned> --work-tree=<the workTree it returned>
   <args>`, so the pointer file is never consulted and the paths are never
   re-derived from the slug (`src/gitmutate.ts#run`, `#mutate`). It is
   `execFile` with an argv array, never a shell, with `cwd` the verified work
   tree and the **allowlisted** git environment of the paragraph below
   (`src/gitmutate.ts#run`). Output is capped at 16 MB
   (`src/gitmutate.ts#maxBuffer`): exceeding the cap kills the child, which for
   a mutation is worse than a truncated log;
4. appends the step to the task journal (section 7) with the SHAs around it —
   `git rev-parse --verify --quiet refs/heads/<branch>` through the same
   explicit form, before and after the command, and the default branch's SHA as
   this step's own `defaultSha` (`src/gitmutate.ts#revision`, `#mutate`). It
   writes no document-level field but the branch names: the pre-merge SHA and
   the branch head belong to the `merged` step alone, for the reason section 7
   gives. The append happens **while the lock is still held**
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
child, so a command that hangs holds `git.lock` until it is killed, and every
other mutation then waits `lockWaitSeconds` and refuses.

`git_mutate` never throws for an operational failure. A missing git binary or
a signal-killed child has no exit code to judge, so it is named as its own
refusal; a lock that could not be taken, and a config that could not be read,
are refusals too (`src/gitmutate.ts#GitRunError`, `#run`, `#gitMutate`,
`#mutate`). The lead's loop reads a result and has no other way to hear one. And
a lock **lost** while the command ran (section 2: the helper child died, so the
kernel let the next waiter in) does not undo the command: the step is still
journaled, and the result carries `lockLost: true`
(`src/gitmutate.ts#GitMutateResult`, `#mutate`), so the lead knows the mutation
happened but was not exclusive for all of its life. **Either** lock's loss is
reported — `spawn.lock` guards the reservation this call passed, `git.lock`
the command itself, and a caller told about only one would draw the wrong
conclusion from the other's silence.

The lead creates the worktree after plan approval, commits the task branch
with the implementer's summary, rebases it, merges with `--ff-only`, runs the
tests on `<default>`, removes the worktree, deletes the branch. On a rebase
conflict the lead aborts the rebase and escalates to the user (narrowed: a
validated conflict-edit mode is a later enhancement). The flow per task: plan
(root), plan review (root), worktree, implement, lead commit, code review,
needs-work round through `resume`, lead commit, ready, merge. Branch-scoped
metadata grants are not part of this plan.

Under `placement: host` the host session performs every root operation
directly — create the worktree, merge, run the tests, remove the worktree,
delete the branch — with its own tools; `git_mutate` covers only the worktree.
Under `placement: engine` the lead has no write access at the root, and the
same operations run through `git_root` and `run_command`, under the same
`git.lock` and the same reservation rule. Under a Codex host the lead's own
sandbox protects `.git` too, so `git_mutate` calls made by a Codex lead need
that host's approval escalation, as EVIDENCE.md recorded for the 0.4.0 Codex
lead.

**`git_root`.** `args[0]` is the verb, and it must be one of `worktree add -b
<branch> <dir> <base>`, `worktree remove <dir>`, `branch -d <branch>`, `merge
--ff-only <branch>`, `rebase --abort`, or the read-only set `status`, `log`,
`rev-parse`, `merge-base`, `branch --list`, `worktree list`. No global git
option is accepted — `-c`, `--git-dir`, `--work-tree` and `-C` are refused,
because each of them turns a whitelisted verb into an arbitrary one against an
arbitrary repository. Every path argument must resolve under the project root
or its `.worktrees/`, and every branch argument must match the mode's
`branchPattern` or be the default branch. The result is `{exitCode, stdout,
stderr, before, after}`, where `before` and `after` are the default branch's
SHA around the call, and each verb appends its own named step under the same
lock — section 7's table says which, and `merge --ff-only` is the one that
also writes the journal's two merge fields, from `before` and from `rev-parse
<branch>` taken in that same locked call. The whitelist is the whole security
argument for handing an engine any root git
access at all, so it is a fixed list in code, never config.

**`run_command`.** `run_command({which: "test" | "setup", where: "root" | <a
verified worktree path>, timeout_seconds?})` — a **selector, never a command
string**, so no argument the lead composes ever reaches a shell. The server
runs the project's configured `testCommand` or `setupCommand` through `sh -c`
in the same child environment a specialist gets, capping the returned output
tail at 64 KB and the run at `timeout_seconds` (default 600), and returns
`{exitCode, tail}`. A configured value of `"none"` is a no-op success, which
is what this project's own `setupCommand` is. A worktree `where` is verified
exactly as `git_mutate` verifies it, with the branch taken from the journal
entry for that worktree.

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

   The depth read today is the server's own `CROSS_AGENT_DEPTH`, and until
   modes exist (step 8) the cap is `limits.maxDepth` as the config states it
   (`src/server.ts#main`). Every record carries its own `depth`, written by
   `delegate` as the caller's plus one (`src/ledger.ts#TaskRecord`,
   `src/delegate.ts#delegate`), so a finished run can be checked against the
   mode's cap as well as each call. The specialist row is the four read tools
   plus `describe_mode`; three of them are registered — `check`, `result` and
   `list_tasks` beside `list_roles` (`src/server.ts#projectTools`) — and the
   matrix's rows replaced `toolsAtDepth`, the depth-only tool list that used to
   approximate it.
2. **No self-mount**: `--strict-mcp-config` without this server for Claude,
   `--ignore-user-config` for Codex, no `--plugin-dir` for Grok. Grok
   specialists **do** reach a server, because Grok has no per-invocation
   exclusion flag (`src/engines/grok.ts:72-77` returns an empty list for it),
   and P9 recorded exactly what a Grok child inherits: the operator's
   `~/.grok/config.toml`, the operator's Grok plugins, and the servers the
   operator declared to Claude in `~/.claude.json` (`docs/probes.md:302-339`).
   They are held to the specialist row by ancestry, not by exclusion — that is
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
   (`tools/probe.mjs:97`), so a probe child sees what a real child will see.
   `delegate` appends its own entry — the new task's id, role and canonical
   cwd — to the lineage its own server carries, and `childEnv` writes the
   result into the spec's environment (`src/delegate.ts#delegate`,
   `src/guard.ts#childLineage`, `#childEnv`). The harness emitted a colon-joined
   placeholder until P9, which fixed it and verified the fix by feeding a
   child's received value back through `parseLineage`
   (`docs/probes.md:340-345`). A `delegate` whose `(role, cwd)` is already in
   the lineage is refused (`src/guard.ts#lineageRefusal`). A request identical
   to a running task in `(role, canonical cwd, sha256(brief))` is refused with
   "already running, wait on <id>"; identical to a task finished within
   `duplicateWindowMinutes` (default 10) is refused unless `force: true`
   (`src/guard.ts#duplicateRefusal`). `force` crosses the finished window and
   never a live task: two engines in one workspace is what the first half
   refuses. `resume` skips the duplicate check, is refused for active tasks, and
   is bound to the original task's role, engine, cwd, and sandbox
   (`src/guard.ts#resumeRefusal`) — the profile read from the original's own
   launch spec, since the record carries none. Two rules of the chain are
   `delegate`'s, because they need the scan (section 2): no record of a chain
   with an active member may be continued, and a record that already has a
   successor answers `resume the latest: <id>` (`src/delegate.ts#resumeFault`).
5. **Prompt**: every role prompt says the specialist cannot delegate and
   reports back instead. Advisory only.

### 6. Config and validation

`<project>/.cross-agent/config.json`, created by `cross-agent init --mode
<name>`, validated on load (`src/config.ts#loadConfig`). It carries the
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
(section 3).

The `dev-team` mode supplies the rest: `planner` and `plan-reviewer` at
`workspace: {kind: "root"}` with `sandboxDefault: "read-only"`, `implementer`
and `code-reviewer` at `{kind: "worktree", branchPattern: "task/*", dir:
".worktrees"}` with the implementer defaulting to a writable profile. A
`kind: "root"` role runs at the project root; a `kind: "worktree"` role
requires the `verify_worktree` checks of section 4 against the branch named in
the request, and a role whose sandbox mode is anything but read-only reserves
the path (section 2).

What is a target here and what is not: the `mode` field, the refusal of
`workspace`, the per-engine profile check, and the refusal of a `grok`-bound
`lead.role` under an engine-placed mode (P9: no per-run isolation, "The lead
model", item 4) all arrive with the tasks that need them. `project`, `roles`'
engine/model/effort, `engines`, all six limits and `billing` are validated
today — `limits.lockWaitSeconds` and `limits.cancelGraceSeconds` included
(`src/config.ts#CrossAgentConfig`, `#limitDefaults`, `#loadConfig`), and every
lock acquisition but the runner's own claim reads the first, through the
caller's argument or through `lockWaitSeconds(projectRoot)`
(`src/config.ts#lockWaitSeconds`, section 2); the second is how long `cancel`
gives a runner to settle its own task (section 2). The shipped loader still
carries the role's directory kind as `cwd`, and a role's own prompt with it
(`src/config.ts#RoleConfig`, `#loadConfig`) — a mode's job from step 8, and
until then the string `delegate` launches the role with, falling back to a
one-line default that tells a specialist it cannot delegate
(`src/delegate.ts#defaultPrompt`, section 8). The Work plan says what happens to
`cwd` in the meantime.

### 7. The skills

Neither skill is written; both arrive with step 9 of the work plan.

`skills/cross-agent/SKILL.md` is the launcher, and it is the only skill a host
loads: read the config, call `describe_mode` **first** to get the active
mode's loop and roles, then start, watch, answer, cancel, reconcile, report.
It is short and identical on all three hosts.

`modes/<name>/SKILL.md` is that mode's loop, served by `describe_mode` and
never copied into a host's skill directory. For `dev-team` it is the devpack's
`worktree-workflow` with the verbs remapped (`delegate_bot` and `ask_bot`
become `delegate` then `wait`; "end your turn, you are woken" becomes "call
`wait` again while it reports running"; roles are names; the closing room post
becomes the task's closing report), plus the git ownership and ordering of
section 4, and:

Where that closing report goes depends on placement. Under `host` the host
session appends one line to `.cross-agent/log.md` itself, as it appends
anything else. Under `engine` the lead is read-only at the root and cannot
append it: its closing report **is** the task's final message, and `cross-agent
report` renders the log from the ledger. An engine lead writes no project file
itself; the ledger, the journal and the mailbox are all written by the server
on its behalf.

- Journal: `.cross-agent/journal/<slug>.json`, built in `src/journal.ts`. The
  document is `{slug, branch, defaultBranch, defaultShaBeforeMerge?,
  branchHead?, steps}` and each step is `{step, at, before?, after?,
  defaultSha?, args?}` (`src/journal.ts#Journal`, `#JournalEntry`). The step
  names are the completed git steps of the loop — `worktree-created`,
  `committed`, `rebased`, `merged`, `tests-passed`, `worktree-removed`,
  `branch-deleted` — plus `git`, which is any other `git_mutate` call and
  records the arguments it ran instead of a name (`src/journal.ts#JournalStep`).
  Today `git_mutate` writes exactly one of them, `git`
  (`src/gitmutate.ts#mutate`).

  **Each named step is written by the tool that performs it**, in the same
  locked call, so nothing has to remember to journal afterwards and no separate
  journal verb exists for the lead to forget or misuse:

  | step | written by |
  | --- | --- |
  | `worktree-created` | `git_root worktree add -b <branch> <dir> <base>` |
  | `committed` | `git_mutate` whose `args[0]` is `commit` |
  | `rebased` | `git_mutate` whose `args[0]` is `rebase` |
  | `merged` | `git_root merge --ff-only <branch>` |
  | `tests-passed` | `run_command {which: "test", where: "root"}` succeeding
  after the merge | | `worktree-removed` | `git_root worktree remove <dir>` | |
  `branch-deleted` | `git_root branch -d <branch>` | | `git` | any other
  `git_mutate` call, with its `args` |

  The `merged` step is the one that carries the document's two merge fields,
  and `git_root` takes both values **inside the same `git.lock` it holds for
  the merge**: `defaultShaBeforeMerge` is the default branch's `before` SHA,
  the one `git_root` already reads to report `before`, and `branchHead` is
  `rev-parse <branch>` on the branch it is about to merge. Taken anywhere else
  they would be a different repository's state. **Target**: `git_root` (row 11)
  and the lead loop that calls it (rows 7 and 9); of this table only the `git`
  row is built.

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

  Four fields are the document's rather than a step's, and **which writer owns
  each of them is what makes the repair path below trustworthy.** The step that
  *creates* a journal must name both branches rather than have them invented
  (`src/journal.ts#appendStep`). `defaultBranch` follows the project's config.
  `branch` is **write-once**: a journal belongs to one task branch, and a later
  step naming another would silently rewrite what every earlier step's SHAs were
  recorded against (`src/journal.ts#appendStep`). `defaultShaBeforeMerge` and
  `branchHead` are the **merge**'s to write, and only the merge's: an
  `appendStep` reads them from its data only when its step is `merged`, and a
  second `merged` step for one slug is refused — `journal <slug>: a merged
  step is already recorded; a task merges once` — so a task merges once and
  the pair is written once (`src/journal.ts#appendStep`). Every other step
  records the default branch's SHA it observed in **its own** step, as
  `steps[].defaultSha` beside `before` and `after`
  (`src/journal.ts#JournalEntry`, `#appendStep`), and never touches the
  document-level field; `git_mutate` passes exactly that
  (`src/gitmutate.ts#mutate`).

  The reason is the repair path. `defaultShaBeforeMerge` is a **revert target**,
  and a revert is only safe if it names the commit this task's merge sat on. A
  task's first `git_mutate` is typically a commit inside the worktree, made long
  before the merge and after other tasks have merged their own work; letting it
  pin the field would aim `git revert <that SHA>..<merged head>` at a range
  containing other tasks' merges, and the repair for one bad task would discard
  them. Per-step `defaultSha` keeps that observation — it is useful evidence
  of what the default branch looked like while the task ran — without letting
  it masquerade as the merge point.

  `git_mutate` enforces the branch rule from its own side as well: a call whose
  branch differs from the one its journal already records is refused, `slug <a>
  is journaled on <task/b>; refusing <task/c>`, before any git runs. That
  comparison happens **inside** `spawn.lock`, beside the reservation check it
  belongs with (`src/gitmutate.ts#mutate`): two first calls on one slug read
  outside the lock would both find no journal and both commit, on two different
  branches.
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
  `git status --porcelain --untracked-files=normal`, and `git rebase` state.
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

Not written yet; they arrive with step 9, from the converter.

`modes/<name>/roles/*.md`. For `dev-team` they are
`{planner,plan-reviewer,implementer,code-reviewer}.md`, written for this
runtime and using the devpack's role text for the review and reporting
conventions only: planner and plan reviewer read at the root; the implementer
edits and runs the tests in its worktree and reports a commit summary but
never runs git write commands; the code reviewer reads the committed branch in
the worktree; nobody delegates. `solo` has one role prompt. Acceptance is
behavioural (the end-to-end runs). The devpack's text is carried over once by
a converter beside `tools/probe.mjs`, run to generate `dev-team` and then
kept only as history; nothing reads `openmaus.package` at runtime.

### 9. Host packaging

No manifest exists yet; Claude Code packaging is step 10 and the other two are
step 12.

**The attach contract is the definition of a host: a stdio MCP server plus the
launcher skill.** Everything else is per-host manifest detail, and the three
manifests below are examples of satisfying that contract, not the contract
itself. Repo root is the plugin root for all three hosts:
`.claude-plugin/plugin.json` + `.mcp.json` + `skills/` for Claude Code
(`claude --plugin-dir ~/Documents/agent-team-cli` in development);
`.codex-plugin/plugin.json` with `skills` and `mcpServers`
(`tool_timeout_sec: 3600`) for Codex, plus `codex mcp add cross-agent -- node
<repo>/src/server.ts` and a copy into `~/.codex/skills/cross-agent/` as the
documented fallback — a copy that takes `skills/` alone, which is why a mode's
loop is served by `describe_mode` rather than shipped as a second skill; Grok
through `--plugin-dir` or `grok plugin install <path>`, which reads the Claude
manifest. Grok's MCP tool timeout is settled by integration probe I2.

Why an MCP core is the portable choice, and not a subagent as the vendor
bridges use: **neither `codex-plugin-cc` 1.0.6 nor `grok-build-plugin-cc`
0.2.1 registers an MCP server at all.** Both are a set of Claude Code
commands, one `model: sonnet, tools: Bash` forwarding subagent, hooks, and
skills, with the engine reached by shelling out from that subagent. That shape
is Claude-Code-only and gives the host no typed tools; an MCP server is the
one attachment surface all three hosts share. Provenance: the installed plugin
sources under `~/.claude/plugins/cache/`, read 2026-09-08.

### 10. Operator CLI

`src/cli.ts` does not exist. `init --mode` lands with step 8 because modes need
it; the rest is step 13.

`src/cli.ts`: `cross-agent init --mode <name> | modes | tasks | show <id> |
log <id> | cancel <id> | answer <ask-id> <text> | report | verify-worktree
<path> <branch> | git <slug> -- <args> | journal <slug>`. `modes` lists the
installed modes and marks the active one; `answer` replies to a pending `ask`
without a host session; `report` renders the per-task summary from the ledger
and each task's final message. Under `host` placement `.cross-agent/log.md`
already holds that summary, because the host appended it (section 7); under
`engine` placement `report` is where the log comes from.

### Time limits, as agreed

No cap on a task. `wait` returns early with `stalled: true` when the engine has
emitted nothing for `stallMinutes`; the task keeps running and the lead
decides. `timeout_seconds` bounds one call so the lead's turn never hangs;
Claude Code's MCP tool timeout defaults to about 28 hours, Codex takes
`tool_timeout_sec` per server.

### Not built

Chat, rooms, a roster UI, an approval broker, runtime bot creation, the lead's
own persistence under `placement: host` (the host's job), ACP engines,
branch-scoped git metadata grants, a conflict-edit mode for rebases. Deferred
with reasons. Four have a backlog bead (`atc-s96.25`–`.28`); two are **not
planned** and have none, because nothing would trigger them:

- **Arbitrary-path workspace providers** (`atc-s96.25`). Only `root` and
  `worktree` are in scope. A provider that hands a role any path would have to
  carry its own containment argument, and section 4's guarantees are written
  for a linked worktree.
- **Config-declared adapter modules** (`atc-s96.26`). The reason is in section
  3: the runner imports that path unsandboxed and only its absoluteness is
  validated.
- **Diff-scoped review and critique verbs** (`atc-s96.27`). The vendor
  bridges' `/review` and `/critique`; `solo` covers the same ground without a
  second protocol.
- **An engine `doctor` / preflight** (`atc-s96.28`). The sandbox-or-refuse
  rule already fails closed at spawn time (`src/engines/spawn.ts:80-83`), so a
  preflight would report the same refusal one step earlier and could go stale
  between the two.
- **`openmaus.package` as an import format.** Not planned: native modes only,
  and the converter runs once.
- **Session transfer between engines.** Not planned: resume is bound to the
  original task's engine (`src/guard.ts#resumeRefusal`), and a transfer would
  have to reconstruct one engine's session state inside another's.

## Repository layout (`~/Documents/agent-team-cli`)

```
.claude-plugin/plugin.json   .codex-plugin/plugin.json   .mcp.json
skills/cross-agent/SKILL.md  modes/<name>/mode.json
modes/<name>/SKILL.md        modes/<name>/roles/*.md
src/server.ts     src/config.ts     src/ledger.ts     src/process.ts
src/reconcile.ts  src/runner.ts     src/guard.ts      src/worktree.ts
src/locks.ts      src/reservation.ts                  src/gitmutate.ts
src/journal.ts    src/delegate.ts   src/tasks.ts      src/cli.ts
src/engines/{types,spawn,registry,binaries}.ts
src/engines/{claude,codex,grok}.ts
tests/*.test.ts   tests/engines/*.test.ts
tests/fixtures/fake-engine.mjs
tools/probe.mjs   tools/check-citations.mjs
docs/design.md    docs/probes.md
AGENTS.md         README.md         package.json      .gitignore
LICENSE (Apache-2.0)
```

Present today:
`src/{server,config,ledger,process,reconcile,runner,locks,guard,worktree}.ts`,
`src/{reservation,journal,gitmutate}.ts`, `src/{delegate,tasks}.ts` from row 7,
and all seven of
`src/engines/`: the contract and pipeline from T4, the registry and the binary
helpers from row 5, and the three adapters, complete, from row 6. Plus the
tests, `tools/probe.mjs`, `tools/check-citations.mjs` (the citation checker
`npm test` runs), the two docs, and the root files. Still to be written:
`src/cli.ts`, both plugin manifests, `.mcp.json`, `skills/`, and `modes/`.

`package.json`: no dependencies, `"test": "node --test 'tests/**/*.test.ts'"`.
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
   `stall`, or `stall-ignore-term`,
   `tests/fixtures/fake-engine.mjs:3`). Its `grok` format emitted nothing
   until a final whole-output object — Grok's `json` mode — until **T9
   rewrote it to the `streaming-messages-json` shape** P8 adopted, which is the
   `claude` case's lines with a Grok `system/init`
   (`tests/fixtures/fake-engine.mjs:39-49`, `:79-87`); a fixture that cannot
   produce the adopted format cannot test the adapter that parses it. The
   whole-output shape stayed, as a fifth format `grok-json`, because the
   pipeline's `finish` tests need an engine that says nothing until exit
   (`tests/fixtures/fake-engine.mjs:50-53`, `:88-90`). `tools/probe.mjs`, a
   standalone harness that spawns one engine with the section 3 argv (no
   server, no runner) so the probes do not wait on feature tasks. It stays a
   manual tool; it is not moved onto the adapter interface. `npm test` green.
   First commit. **Done.**
2. Probes with the harness, each a short real run recorded in
   `docs/probes.md` with the exact command and outcome:
   - P1 nested `claude -p` from inside a Claude Code session with the
     scrubbed env (the binary carries a `CLAUDECODE` guard). **Done**; the
     Claude sandbox needs `bwrap`, `socat`, and the bwrap AppArmor profile.
   - P2 each engine as implementer inside a linked worktree under its
     sandbox. Recorded (`docs/probes.md:48-63`): an in-worktree edit and the
     tests succeed, and writes to a root file, to a path inside `<root>/.git`,
     to a sibling path, and to `$HOME` are all denied; the rewrite of the
     worktree's `.git` pointer is denied by Codex and **allowed by Grok**.
     **Done for Codex and Grok**; the Claude row waits on the AppArmor profile
     (`atc-s96.17`). Outstanding variants, not yet recorded: a write into
     another *registered* worktree, a write to
     `<root>/.git/refs/heads/<default>` specifically, and the whole set on a
     resumed session.
   - P3 the deny list. Recorded (`docs/probes.md:65-87`): four targets
     (`claude`, `codex`, `grok`, `node <repo>/src/server.ts`) attempted on
     each engine, with `node --version` as the control. **Done** — Claude and
     Grok deny all four and allow the control; Codex ignores an execpolicy
     rules file in `exec`, see P3b. Outstanding: the `cross-agent` and `node
     <repo>/src/cli.ts` targets, a configured `engines.<e>.bin` path, and a
     resumed session.
   - P3b Codex network: a workspace-write child cannot reach a model API or
     complete a nested engine run. **Done.**
   - P5 `codex exec --ignore-user-config`: auth kept, no trust prompt, no user
     MCP servers. **Done.**
   - P7 lead-owned git with explicit `--git-dir`/`--work-tree` under `flock`,
     over a worktree edited by a sandboxed implementer: commit, rebase,
     `--ff-only` merge, cleanup. **Done.**
   - P8 Grok streaming output, in both NDJSON formats, after `tools/probe.mjs`
     gained an `--output-format` flag. **Recorded 2026-09-09**
     (`docs/probes.md:140-246`): `streaming-json` announces its session id only
     on the last line, carries no final message text at all, and emits no
     closing line when the run fails; `streaming-messages-json` announces the
     session id on its **first** line — on a resumed run as well as a fresh
     one — puts the final text in the last line's `result`, and closes even a
     failed run with a parseable `result` line carrying `is_error` and
     `errors`. **Adopted for T9: `streaming-messages-json`** (§3).
   - P9 lead mount and instruction delivery, per engine, each CLI spawned with
     only this server intended. **Recorded 2026-09-09**
     (`docs/probes.md:248-361`): Claude mounts exactly this server under
     `--strict-mcp-config --mcp-config <file>` and obeys
     `--append-system-prompt-file`; Codex mounts it with three `-c
     mcp_servers…` settings under `--ignore-user-config`, the third being
     `default_tools_approval_mode="approve"`, and obeys `-c
     model_instructions_file="<file>"`; Grok has no per-run isolation of any
     kind, and a child inherits the operator's Grok configuration, Grok plugins
     and `~/.claude.json` servers. Ruling: **no Grok lead** ("The lead model",
     item 4). The run also recorded the `--help` facts of section 3
     (`docs/probes.md:408-465`).
   - P10 `codex exec resume`. **Recorded 2026-09-09**
     (`docs/probes.md:363-406`): the subcommand takes neither `-C` nor
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
the adapters depend on. Steps 5 and 6 — the engine contract and all three
adapters — are built and green too. What is left starts at step 7, the tools,
and then runs through the modes, the skills, and each host's packaging with its
integration probes and end-to-end run right after it.
Rows 7 and 8 are where the built git and reservation machinery is finally
reached by a caller: until then no tool registers `git_mutate` and no
`delegate` consults a reservation.

| # | Work | Bead | Notes |
|---|---|---|---|
| 1 | Rename and design rewrite | `atc-s96.19` | **Done.** One pass; `npm test` gated the rename. History files untouched. |
| 2 | Locks primitive, conditional update, lifecycle | `atc-s96.20` | **Done** (`45ee841..e426f35`). `src/locks.ts` (the `flock` child); `update` with `expect` and `{applied}`; B1 (reconcile on the group scan in `src/reconcile.ts`, the `cancelling` case), B2 (bounded drain, `truncated`), B3, B4, B5 (environ scan, runner lock, `launchToken` removed), A4-a (record validation); plus the two review rounds' rulings, which section 2 states with the line that implements each. The reconciliation **triggers** are not in this step: they belong to row 7. |
| 3 | T6 remainder | `atc-s96.6` | **Done** (`58b90cf..69f3eac`, with its review's two fix rounds in `608c89a..53e5e45` and `ffbb84d`). `limits.lockWaitSeconds` and `lockWaitSeconds(root)` (`src/config.ts`); `gitLockName`/`spawnLockName` (`src/locks.ts`); `src/reservation.ts`; `src/journal.ts`; `src/gitmutate.ts` — the four steps of section 4 on the verified git-dir, under `spawn.lock` then `git.lock`, journaled; `gitEnvironment` for every git invocation (`src/worktree.ts`). The review's rulings are stated in sections 2, 4 and 7 with the line that implements each. Three beads came out of it: `atc-s96.33` (a pre-existing suite flake in `reconcile`/`process` under load, open), `.34` (`lockWaitSeconds` through `update`'s callers, closed) and `.35` (an inherited `GIT_DIR` makes `verify_worktree` refuse, closed). Not in this row: registering the two worktree tools (row 8), `delegate`'s reservation check and `spawn.lock` (row 7), `git_root` (row 11), `cross-agent git` (row 13). |
| 4 | Probe harness flags, P8, P9, P10 | `atc-s96.21` | **Done** (397763c, 649b8e5, f40cadb). `--output-format`, `--mcp-config`/`-c`/`--rules` passthrough; the resume argv no longer pushes `-C` and `--sandbox` onto `exec resume`, which accepts neither. Outcomes in Phase 0 above: `streaming-messages-json` for T9, three `-c` settings for a Codex lead mount, no Grok lead, and a Codex resume that keeps neither cwd nor sandbox. |
| 5 | Engine contract and profile validation | `atc-s96.22` | **Done** (`734e1e9..193b511`, with its review's fix round in `cfaf2b0`). A2; the adapter fields of section 3, `sandboxFor` as their one construction site, the built-in table in `src/engines/registry.ts`, `src/engines/binaries.ts`, and `EngineName` moved beside the contract; informed by P8 and P9. The three adapters carried the static half only at this point: `plan`, `parseLine` and `finalMessage` threw, and so did the `finish` stub each declared; row 6 replaced all four. |
| 6 | Adapters | `atc-s96.7`, `.8`, `.9` | **Done.** `.7` T7 Claude (`d8bc672`, with its review's fix round in `90fd4d6`): `--append-system-prompt-file` for the role file (P9), `parseStderrLine` for P1's two sandbox failures, and the mount immediately after `--strict-mcp-config`. `.8` T8 Codex (`aa3e8bc`, fix round `1a20cc8`): **without an execpolicy rules file**, resuming with the process cwd and `-c sandbox_mode=` re-supplied (P10), and the prompt on stdin behind a `-` positional on both heads. `.9` T9 Grok (`992a830`): `--output-format streaming-messages-json`, `finalMessage` reading `result` or `errors` joined with newlines, the role prompt through `--rules` (P8, P9), no engine-placed lead, and `tests/fixtures/fake-engine.mjs`'s `grok` format rewritten to that shape with the old one kept as `grok-json`. Section 3 was refreshed against the built adapters in one pass afterwards (`atc-vao`). |
| 7 | delegate, check, result, cancel; wait with stall | `atc-s96.10`, `.11` | **T10a and T10b done.** T10a: ancestry-bound authority, project discovery, tools by row, `tools/call` refusal by name (`src/authority.ts`, `src/project.ts`). T10b: `delegate`, `check`, `result`, `cancel` and `list_tasks` (`src/delegate.ts`, `src/tasks.ts`), the guard wiring, reconciliation on server start and on every `list_tasks`, the four delegation record fields, `limits.cancelGraceSeconds`, the prefix reservation (`atc-vuu`), the per-task scratch directory (`atc-s96.37`), one source for the engine binary (`atc-s96.10.1`), and the two runner SIGTERM edges (`atc-s96.39`, `.29`). Left in this row: `wait` with stall detection (`atc-s96.11`). `describe_mode` registers with step 8, which builds the mode loader it reads. |
| 8 | Modes, worktree provider, `init --mode` | `atc-s96.23` | `dev-team` and `solo`; `describe_mode`; `mode.json` validation. Until this step lands, `.cross-agent/config.json` keeps a per-role directory kind — the shipped `cwd` (`src/config.ts#RoleConfig`), renamed `workspace` when a step needs it; from this step on the key moves to the mode and config refuses it. |
| 9 | Launcher skill and mode loops | `atc-s96.12` | `skills/cross-agent/SKILL.md`; `modes/*/SKILL.md` and roles through the converter. |
| 10 | Claude Code packaging | `atc-s96.13` | `.claude-plugin/plugin.json`, `.mcp.json`; I1 and I2; end-to-end run 1 under `placement: host`. |
| 11 | Engine placement | `atc-s96.24` | `git_root`, `run_command`, the mailbox, `parentTaskId` and cascade cancel, exclusive reattach; end-to-end with the lead on **each supported lead engine — claude and codex** — from one host, because one lead engine under three hosts would not validate both injection paths. Grok is out of this row: P9 found no per-run isolation, so it is a specialist and a host only ("The lead model", item 4). Config load refuses `placement: engine` with a Grok lead. |
| 12 | Codex and Grok packaging | `atc-s96.14`, `.15` | Thin-launcher end-to-end under each host. |
| 13 | Operator CLI remainder | `atc-s96.16` | `modes`, `answer`, `report`, and the rest of section 10, over a seeded ledger. |
| 14 | Backlog | `atc-s96.25`–`.28` | Arbitrary-path workspaces; config-declared adapters; review and critique verbs; engine `doctor`. |
| — | Claude P2 | `atc-s96.17` | Waiting on the bwrap AppArmor profile (needs sudo). |

Integration probes after each packaging task, run by the operator:

- **I1, authority.** With the plugin installed in that host, each of the three
  engines spawned as a specialist lists its MCP tools and sees **exactly the
  specialist row** of the permission matrix — the four read tools plus
  `describe_mode`, and no `delegate` — including a Grok specialist that
  inherits the user's MCP configuration and therefore does reach a server. The
  row is checked **per host, in that host's own spelling**: Claude shows
  `mcp__cross-agent__<tool>`, Codex folds the hyphen and shows
  `mcp__cross_agent__<tool>` beside its built-in `codex_apps`
  (`docs/probes.md:263`, `:266`), and Grok reaches the tools through its
  `use_tool` dispatcher (`docs/probes.md:268`), so the test compares the set of
  this server's tools, not a literal string. A direct `tools/call delegate`
  from that session is refused by name, with the reason.
- **I2, host × engine isolation.** Each engine spawned by the server launched
  from that host repeats the P2 negative writes, all of which must be denied.
  Claude and Grok children can reach the network; **a Codex child must not** —
  its network denial is layer 3 of the loop guard, so reachability there would
  be a failure, not a pass. Plus a ten-minute `wait` completing under that
  host's MCP tool timeout.

### Phase 2: evidence and decisions

EVIDENCE.md gets one table per pack task (as for T7 to T9 in 0.4.0) plus the
probes and the end-to-end runs. Pack findings feed 0.4.x fixes; a Decision
records the go or no-go for the plugin as the second binding (`atc-s96.18`).

## Verification

- `npm test` green after every task; T3, T5, and the locks task are gates: no
  adapter or tool task is briefed before they pass.
- **Probes gate the tasks that cite them.** P1, P2 (Codex and Grok), P3, P3b,
  P5, P7, P8, P9 and P10 are recorded. Only P2 for Claude is outstanding, and
  it gates the Claude adapter's sandbox row (`atc-s96.17`). A failed negative
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
  (`tests/locks.test.ts:45`), a waiter refuses after its wait naming the
  operation and the file (`:99`), and a lock whose holder was SIGKILLed is
  taken by the next holder in under a second, with the lock file never deleted
  (`:68`) — no TTL, no stale detection, no reclaim. The same over `git.lock`:
  two mutations take it one after the other, and their journal steps chain
  `before` to the previous `after` (`tests/gitmutate.test.ts:503`), while a
  mutation behind a SIGKILLed holder completes well inside the five-second wait
  (`:533`); `spawn.lock` is held for the whole call with `git.lock` inside it
  (`:303`). `limits.lockWaitSeconds` is read where a config is loadable and
  answers with the default where none is (`tests/config.test.ts:209`).
  Reservation: a writable task holds its cwd until it settles, every profile
  but the read-only ones reserves, an unreadable launch spec holds the
  workspace anyway, paths compare canonically, and a removed workspace is still
  reserved (`tests/reservation.test.ts:69`, `:88`, `:139`, `:157`, `:176`,
  `:191`), and a sandbox this build cannot read as a `{mode, profile}` pair
  keeps it too (`:126`). `git_mutate` refuses: a workspace an unsettled
  writable task is holding (`tests/gitmutate.test.ts:189`), every workspace
  while a record
  cannot be read (`:208`), a worktree the verifier rejects — the main
  worktree, a subdirectory, the wrong branch, a missing path, a pointer
  redirected at a sibling — with the verifier's own reason (`:225`), an
  argument list that is not one subcommand in this worktree (`:380`), and a step
  that could not be recorded, **before** it runs anything (`:413`). Two first
  calls on one slug settle on one branch and the other is refused (`:283`). A
  failing git command returns its exit code and both streams and journals
  nothing (`:431`); a config, a lock, or a git that could not run is refused
  rather than thrown (`:472`); a lock lost while the command ran is reported and
  the step is still journaled (`:443`). Journal: a commit lands on the task
  branch and is journaled with the SHAs around it (`:152`); steps accumulate in
  order with only the fields they carry, each append is a rename that leaves no
  temporary behind, the branch a journal was created on is write-once, the
  revert target and the branch head are set once and only by the merge, and a
  damaged journal is named rather than replaced (`tests/journal.test.ts:62`,
  `:115`, `:51`, `:85`, `:148`). Environment: `gitEnvironment` passes what git
  needs to run as this user and nothing else, and the verifier ignores what the
  server's own environment says about a repository
  (`tests/worktree.test.ts:125`, `:150`).
- **T7 (recorded).** The Claude line is P1's, in the order P9 ran it, pinned
  byte for byte for a read-only role, a writable one, a resume, and an
  engine-placed lead whose `--mcp-config` sits immediately after
  `--strict-mcp-config` and whose config file is written as a plan file
  (`tests/engines/claude.test.ts:189`, `:213`, `:236`, `:251`). The brief is
  `plan.stdin` and appears nowhere in the argv; the writable root is
  `request.cwd` exactly, even when the worktree was reached through a symlink
  (`:292`); a flag with nothing to carry is not emitted (`:316`); and the
  sandbox check names whichever of `bwrap` and `socat` it cannot find on `PATH`
  (`:153`). P1's two stderr failures become **one** fatal `error` event: a run
  the engine itself calls a success fails on it (`:483`), and a sandbox that
  fails at its own setup once per command still yields exactly one event with
  every line still in the log (`:506`). A whole run through `spawnEngine`
  against the fake engine's `claude` format settles with the session, the
  activity and the final text in order, and a failed one with the engine's own
  message (`:419`, `:464`).
- **A1 / P8 (T9, recorded):** the Grok adapter runs `--output-format
  streaming-messages-json`; per-line events arrive before the final one; the
  session id is read from the first line's `system/init`, on a resumed run as
  well as a fresh one; `finalMessage` reads the last line's `result` when
  `is_error` is false and its `errors` when it is true, so a failed run settles
  down the same path as a successful one. Recorded through a `spawnEngine` run
  against the rewritten fixture — the session, the activity and the final text
  in order on a success, and the joined `errors` with exit 1 on a failure
  (`tests/engines/grok.test.ts:392`, `:435`) — and at the parser, where a
  `result` line that omits `is_error` fails closed rather than passing as a
  success (`:304`, `:336`, `:380`).
- **A2 (recorded):** `{engine: "codex", sandbox: "workspace"}` is refused at
  config load, naming the engine and the profiles it does accept
  (`tests/config.test.ts:130`). The same rule holds past config: `sandboxFor`
  answers for every profile of each engine and refuses any other name,
  including `toString` (`tests/engines/claude.test.ts:174`,
  `tests/engines/codex.test.ts:147`, `tests/engines/grok.test.ts:128`); the
  pipeline refuses a contradicted pair, a foreign profile and a spec naming
  another engine before the capability check, the plan and the spawn
  (`tests/spawn.test.ts:220`); and the reservation holds a workspace for every
  one of those (`tests/reservation.test.ts:104`). The contract's own members
  are recorded per adapter: the profile map, `denyArgs`, `exclusionArgs` and
  `leadMount` byte for byte against P9
  (`tests/engines/claude.test.ts:113,117,126,130`,
  `tests/engines/codex.test.ts:93,98,103,107`,
  `tests/engines/grok.test.ts:90,94,102,106`), and the
  pipeline's half of `finish` — called once with the whole raw stdout, nothing
  buffered for an adapter that declares none, a throwing one reported without
  losing the run — plus plan files written `0600` with their parents before
  the spawn and a file it cannot write settling as a launch failure with nothing
  spawned (`tests/spawn.test.ts:766`, `:795`, `:811`, `:828`, `:849`).
- **A3 (recorded):** a mismatched slug and path → `git_mutate` uses the
  `gitDir` `verify_worktree` returned. The commit lands on the branch of the
  worktree at `path` and the slug's own branch is untouched
  (`tests/gitmutate.test.ts:255`); a `git` shim on `PATH` captures the argv and
  asserts `--git-dir=<realpath of the verified administrative directory>` with
  no argument naming the slug's worktree, and that the child is handed no
  `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` or `GIT_CONFIG_*` (`:333`).
- **A4-a:** a malformed record file is reported by name and refuses every
  writer until it is repaired or removed. Recorded for `git_mutate`
  (`tests/gitmutate.test.ts:208`), for `delegate`, which refuses a writable
  delegation naming the file and leaves a read-only one alone
  (`tests/delegate.test.ts:222`), and for `list_tasks`, which returns the file
  beside the records it could read (`tests/tasks.test.ts:196`).
- **Authority (T10a, recorded but for its last two clauses):** a server whose
  nearest engine ancestor is a specialist gets the specialist row even when
  the process also carries a lead's environment (`tests/authority.test.ts:253`),
  and an engine ancestor whose record grants nothing still ends the walk, so
  its server never reaches the lead above it (`:267`); a server carrying
  `CROSS_AGENT_TASK` that matches no record gets the specialist row, not the
  operator row (`:84`, `:231`), and so does one whose engine passed it no
  environment while an ancestor carries the task (`:294`); a walk that hits a
  read error, a cycle, 8 hops, or a parent younger than its child gets the
  specialist row (`:103`, `:328`), while the operator row takes a clean
  environment and a walk that reached the root (`:75`); a lead's row is lost
  on the first call after its record leaves `running|stalled`, and gained on
  the first after it reaches `running` (`:231`); an identity from another boot,
  or an engine not carrying its task, matches nothing (`:309`); and the depth
  cap only ever lowers a row (`:204`). A direct `tools/call` of a tool outside
  the resolved row is refused by name with the reason, the entry point
  refuses by the row it resolves for itself, and both the list and the refusal
  follow the row from one request to the next (`tests/server.test.ts:127`,
  `:301`, `:151`); a specialist's `delegate` and `cancel` are refused by this
  server's own name with the resolver's reason, and its read tools answer
  (`:362`). The project is `--project`, then `CROSS_AGENT_PROJECT`, then
  the nearest configured directory, a linked worktree resolving to its main
  project and no config anywhere to a reason (`tests/project.test.ts:24`,
  `:40`, `:50`, `:66`). A resolver that throws is answered `-32603`, lists
  nothing and runs no handler (`tests/server.test.ts:410`). Still to record: a
  Grok specialist inheriting the user's MCP configuration sees exactly the
  specialist row (this is I1).
- **Modes:** `init --mode dev-team` yields the four roles with the engines,
  models and efforts of section 6 and the profiles of the mode's
  `sandboxDefault`; a config carrying a `workspace`
  key, or a role key the mode does not declare, is refused; `solo` yields a
  `tools/list` without the worktree tools; `describe_mode` returns the loop
  text on all three hosts with no file copied, and refuses with a reason when
  the mode directory is missing.
- **P9 (recorded):** Claude clean — `--strict-mcp-config --mcp-config <file>`
  shows exactly this server's tools and none of the operator's, and
  `--append-system-prompt-file` is obeyed; Codex clean with three settings —
  the two `mcp_servers…` keys plus
  `default_tools_approval_mode="approve"`, without which every call is refused,
  and `-c model_instructions_file="<file>"` obeyed; Grok not isolable — a
  child inherits the operator's servers and a project-scoped mount will not
  start in an untrusted folder (that second observation transcribed, not
  archived — see the probe row), so there is no Grok lead. What T10 and S11
  must still show is that a mounted lead resolves to the **lead row** of the
  permission matrix, which is authority, not mounting.
- **P10 (recorded) / T8:** `codex exec resume` takes neither `-C` nor
  `--sandbox`, and keeps neither the cwd nor the sandbox of the original run.
  T8's acceptance follows from that: a resume is spawned with the process cwd
  set to the role's workspace and `-c sandbox_mode=<the role's profile>`
  re-supplied — `danger-full-access` when the role's profile is `off`, never
  an omission — and the P2 negative writes are denied on a **resumed** session
  — a write to a root file, into `<root>/.git`, to a sibling path and to
  `$HOME` — not only on the session that launched it. **Recorded** at the plan
  for every head: the launch line, a writable role, `off` as
  `danger-full-access`, the resume with neither `-C` nor `--sandbox` and `-c
  sandbox_mode=` restored, an `off` resume, and a lead's three settings before
  the prompt (`tests/engines/codex.test.ts:162`, `:187`, `:204`, `:217`, `:244`,
  `:301`); and through `spawnEngine`, where the fake engine records the stdin
  and argv it was actually given (`:424`, `:484`). Two halves need the real
  binary and wait for **I2**, a skipped placeholder that names them
  (`tests/engines/codex.test.ts:515`): that `codex exec … -` and `codex exec
  resume <id> … -` each take the brief from stdin rather than send the literal
  `-` as the prompt — `--help` settles the flag on both heads
  (`docs/probes.md:462-473`), so what is left is that a run behaves as the help
  says — and the resumed-session negative writes above.
- **Engine placement:** end-to-end with the lead on each supported lead engine,
  Claude and Codex (P9 rules Grok out); cancelling
  the lead settles every descendant and reports one outcome per task; a killed
  lead's `ask` survives and its answer reaches the resumed lead; `git_root`
  refuses any verb outside the whitelist, any global git option, and any path
  outside the project; `run_command` refuses anything but its two selectors.
- Failure injection, each recorded once: a suite that fails on `<default>`
  after a merge (repair path offered, dispatch halted); an interruption after
  `worktree remove` and before `branch -d` (reconciliation deletes the
  branch); an interrupted rebase (aborted and reported); a server killed
  during a task (the runner records the outcome; a restarted server adopts
  it); a runner killed with the engine alive (engine terminated); a needs-work
  round through `resume`.
- End-to-end under each host: plan and plan review at the root, worktree,
  implement, lead commit, code review, merge, tests, cleanup; `git worktree
  list` shows only the root, no `task/*` branch remains, `git status
  --porcelain --untracked-files=normal` is empty, the suite is green on
  `main`; `.cross-agent/tasks/` holds one record per delegation with native
  logs; the journal shows every step; no record's `depth` exceeds the mode's
  `maxDepth`; the specialists' transcripts show no `delegate` and no engine
  launch.
- **Docs:** every changed claim in this document matches a checked `file:line`
  or `file#symbol` in this repository or a recorded probe.
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
