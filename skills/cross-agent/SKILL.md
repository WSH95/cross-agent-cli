---
name: cross-agent
description: Use when the user asks to run work through a team, delegate to another harness, hand a bead or TODO to an agent, or says "ask codex to …", "ask grok to …", "ask claude to …". Also use to set up, check, repair, or remove cross-agent's one-time Codex MCP connection, including desktop Codex without a per-session CROSS_AGENT_PROJECT.
---

# cross-agent

A team here is a **mode**: roles, a loop, and a git policy. You dispatch the
roles, watch them, decide what happens next, and report. You do not do their
work, and you never start an engine CLI yourself — a `claude`, `codex` or `grok`
the server did not launch carries none of the guard the server puts around one,
and none of its tasks can be waited on, cancelled or reported.

## Codex host setup

When the user asks to set up, check, repair, or remove this plugin's Codex connection,
follow [Codex setup](references/codex-setup.md) **before** calling `describe_mode`.
Setup works while the MCP tools are missing. Run the bundled helper relative to this
skill's actual installed directory; do not ask the user to find a versioned cache path.
It configures MCP once for this Codex host, including local desktop chats, and keeps
the marketplace plugin responsible for updates and skill discovery.

This route is for a requested host-configuration change or diagnosis. An ordinary
delegation with missing tools does not authorize installing or repairing the connection.

## Before delegating

Call `describe_mode`. It answers with the active mode — its `lead` among the
rest — the mode's `loop`, its `roles` — each with its workspace, sandbox default
and prompt, and `seats: "many"` or `gates: "merge"` where the mode declares them —
its `git` policy: `worktreeDir`, `branchPattern`, and `implicit: true` where those
two are this build's defaults rather than the mode's own — and `projectRoot`, the
canonical root of the project this server serves, and `review`, the loop's two
settings: `planReviewRounds` and `afterResolver`.

`mode.lead.placement` decides who runs that loop. Under `host` — `dev-team`,
`solo` — **the `loop` it returns is your instructions for this project.** It is
served rather than copied into a skill directory, so it is current for the mode
this server actually loaded; where it spells a step differently from this skill,
follow it. Under `engine` — `dev-team-engine` — the loop is the lead's and not
yours: a spawned Claude or Codex session runs it, and your part is to start that
lead, watch it and answer it, as the `## Engine placement` section below says.
No step of an engine-placed loop is yours to run.

If `describe_mode` refuses, tell the user the reason and stop. A project with no
`.cross-agent/config.json` is not that case — it runs the built-in `solo` mode
on defaults, so a one-off delegation needs no setup at all. A refusal means the
config names a mode this server could not read, and `cross-agent init --mode
<name>` is what binds a team to this project; it exits 0 when it wrote the config
or found one already there, and 3 when the mode or the directory is not there, or
the directory is a worktree it cannot make a project of.

If no `describe_mode` is offered to you, under any prefix, a Grok host looks first:
Grok lists an MCP server's tools behind its own `search_tool`, so search it for
`cross-agent` before you conclude they are missing. With `describe_mode` still
missing, this server did not start for your session, and nothing below can run
without it: tell the user the server did not start, and stop rather than do the
team's work yourself. Under Codex, suggest asking for the one-time setup above, or a
connection check if it was already set up. The legacy bundled mount requires
`CROSS_AGENT_PROJECT` to name a configured project before Codex starts; the one-time
setup uses each chat's directory and needs no config for `solo`. Under Grok it starts only in a
trusted project whose `.grok/config.toml` names this checkout. `docs/install.md` in the
cross-agent repository (https://github.com/WSH95/cross-agent-cli) gives the steps for each
host.

Then call `list_roles` and show the roster before you dispatch anything: its
first line is `projectRoot`, then one line per role with its engine, model,
effort, workspace and sandbox — and for a role bound to a list of seats, one line
per seat, `<role>#<seat>`, each with its own engine, model, effort and sandbox. A
role whose `binding` is `null` is bound to no engine; it is still a role you can
delegate, but your call has to name the `engine`. A team loop's own role
answering so — the resolver, in a config written before it existed — is bound in
`.cross-agent/config.json` before the loop starts, as its step 1 says;
`cross-agent init` leaves an existing config alone and does not add it. A
`warning` in the answer means `.cross-agent/config.json` was pointed at another
mode after this server started: which tools exist was settled when it loaded, so
report the drift and ask for a restart instead of working around it.

Judge `projectRoot` against the project the user works in before anything is
dispatched. It is not always the directory you were started in: a worktree nobody
initialized is served by its main project on purpose, and only `cross-agent init`
run in it makes it a project of its own.

- **Stop**, telling the user, when the working directory lies in an initialized
  project other than `projectRoot` — a worktree or checkout holding its own
  `.cross-agent/config.json` — and the user has not named or confirmed `projectRoot`
  in this session, or when the user named a project and `projectRoot` is another. A
  Grok attach copied with a binding in it, or a `CROSS_AGENT_PROJECT` left from
  another session, serves the wrong project this way. A `CROSS_AGENT_PROJECT` found
  only in the environment confirms nothing: it may be left from another session.
- **Proceed** when the working directory is in an uninitialized worktree of
  `projectRoot`'s repository, or anywhere in it that no config claims. Where
  `projectRoot` is not the nearest directory at or above the working directory that
  holds a `.git`, say so on the roster's first line: served by the main project at
  <projectRoot>; run `cross-agent init` here for a project of its own. Leave the
  `init` advice out when the working directory lies under `projectRoot`'s
  `git.worktreeDir`: that is a task's worktree, where `init` exits 3.
- **Proceed as asked** when the user named or confirmed `projectRoot` in this
  session — with `--project`, `CROSS_AGENT_PROJECT` or in words — wherever your host
  sits.
- **Otherwise** — a binding found only in the environment, with the working directory
  in no project or outside `projectRoot`'s repository — show `projectRoot` and ask the
  user to confirm it before you dispatch anything.

## Starting a task

`delegate {role, brief, cwd}` launches one task and answers with its task id:
under `host` placement each specialist your loop names, and under `engine`
placement the lead and no one else (`## Engine placement`), whose brief, narration,
refusals, waits, resume and cancel are the ones this skill describes for any task.
Add `branch` when the role works in a worktree — the mode's loop says where
that worktree comes from and on what branch — and `engine`, `model` or `effort`
to override the binding for this call alone. Naming another `engine` drops the
binding's `model` and `effort` rather than carrying them across: they belong to
the engine that was bound, and `grok --model claude-sonnet-5` is an unknown
model id. So name the model you want with the engine, or get that engine's own
default. Add `seat`, 1-based, for a role `.cross-agent/config.json` binds to a
list: required for such a role, refused for one bound to a single binding, and
recorded on the task, which every listing then spells `<role>#<seat>`.
`worktree: true` gives a role that works at the project root a writable task
worktree of its own instead;
the record then carries `worktree: {path, branch, slug}` and the slug is the
task id.

The brief is the whole of what the specialist knows about *this* task: what to
do, where, what counts as done, and the shape of the closing report you will
read back. It is not where the role's standing duties go — `delegate` launches each
task with the mode's own prompt for its role, a specialist's under `host` placement
and the lead's under `engine`, the same text `describe_mode`
serves you under `roles[].prompt`, or with the `prompt` bound in
`.cross-agent/config.json` where a project sets one. Read that text before you
write the brief: what the role is already told is what your brief need not
repeat, and what it does not cover is what your brief has to.

Narrate every dispatch in one line before you wait on it: *delegating `<role>` —
`<role>#<seat>` for a seated role — to `<engine>`/`<model>` at `<effort>` in
`<cwd>`*. The user is paying for these
engines and cannot see them; a task nobody announced is a task nobody can stop.

A refusal is an answer, not an error to retry: a request identical to a live
task — the same role, seat, cwd and brief — is refused with the id to wait on
instead, one identical to a task that
finished inside the duplicate window needs `force: true`, a workspace another
task reserved is named with that task's id and status, and a `(role, cwd)` pair
already in this session's lineage is a loop the server will not close. Read the
reason aloud and decide; `force` crosses the finished window and never a live
task.

## Watching

`wait {task_id, timeout_seconds}` is how you follow a task. It returns when the
task settles, when its engine has been silent long enough to count as stalled,
when the ledger turns out to be out of step with the kernel, or at your timeout,
and it carries `status`, `elapsedSeconds`, `lastActivity`, the `resultTail` of a
settled task, and a `hint` naming the call to make next. Act on the status:

- `running` — call `wait` again; a record still `launching` or `cancelling` is
  in motion too, and answers the same way.
- `stalled` — the engine has emitted nothing for the configured threshold; the
  task is still alive. Read the log the hint names, then keep waiting or
  `cancel`.
- `unsettled` — not a status but the word the `hint` opens with, beside a
  `reason`: this call reconciled and the record still did not move, and the
  reason is what the pass could not do. Call `list_tasks`, which reconciles
  again, and decide from what it reports.
- `orphaned` — the runner is gone. `list_tasks` reconciles it; `cancel`
  terminates whatever engine is left.
- `done` — call `result` for the final message in full. That message is the
  work product: quote what matters rather than paraphrasing it. `resultTail` is
  only its last 2000 characters, and `lastActivity` is the engine's last event,
  not the final message: neither stands in for `result`.
- `failed` — read `result` for whatever the engine said and the log for how it
  ended, and report both. A failed task is never retried silently.
- `cancelled` — somebody stopped it. Say who asked and what it had done.

After a `wait` that timed out or came back `stalled`, call `list_tasks` before
you wait again. `wait` runs a reconciliation pass itself when a record's own
evidence says the ledger is adrift, but `list_tasks` reconciles unconditionally
and refreshes the whole roster you are showing the user; one call per timeout is
the whole of its cost.

Never declare a task done from `check` alone: `check` reconciles nothing, so a
record it reports as running may have lost its runner minutes ago. `check` is
for a glance at a task you are not waiting on; `wait` and `list_tasks` are the
two calls that see the ledger repaired.

Keep each `wait` inside your host's own tool timeout, and repeat it — a long
task costs you many short waits, not one long one:

| host | its MCP tool timeout | `timeout_seconds` to pass |
| --- | --- | --- |
| Claude Code | about 28 hours by default | 600 |
| Codex | `tool_timeout_sec` per server, 3600 in `.codex-plugin/plugin.json` and in the lead mount (`docs/probes.md#codexHostTimeout`) | 600 |
| Grok | `tool_timeout_sec` per server, 6000 by default; a 600 s `wait` returned intact under a Grok host (`docs/probes.md#grokToolTimeout`) | 600 |

Those are the budgets of the design's "Time limits": there is no cap on a task,
only on one call about it. `timeout_seconds` defaults to the project's
`limits.waitDefaultSeconds`, and the silence threshold that produces `stalled`
is `limits.stallMinutes`.

## A needs-work round

A second round on the same task — a specialist's under `host` placement, a failed
lead's under `engine` — is `delegate` with `resume: <task id>` and an amended
brief: the findings verbatim and what to do about them. The call still carries
every key a first call does: the same `role` and `cwd` as the original, its `seat`
where it had one, and `branch` for a role that works in a worktree. They are not
optional and they are not defaults — the schema requires `role`, `brief` and `cwd`,
and the resume binding compares the role, the engine, the cwd and the sandbox with
the original and refuses any difference. The engine and the sandbox are the
original's; the model is not — it is resolved again on every call, from the `model`
the call names, the one config binds now for that engine, and failing both the one
the record already ran on, so a chain does not change model halfway through for
want of being named. A task that was given a worktree is continued in that
worktree, so a review round reaches the same branch.

Resume the **latest** id of the chain: an id that already has a successor is
refused with `resume the latest: <id>`, and a chain with an active member is
refused outright. Resume only after the task settled.

## Cancelling

`cancel {task_id}` terminates the task and everything it delegated, leaves
first, and answers with one outcome per task: the status each reached, or
`already <status>` for one that was over. A partial failure is reported as
such — call `cancel` again and it retries what is left, because a cascade that
claimed success while a descendant survived is the failure this lifecycle
exists to prevent. Cancelling settles the task; it does not undo what the
specialist already wrote to its worktree.

## Between tasks: reconcile

Under `host` placement this pass is yours: run it before the first task of a
session, after any interruption, and after **any** `git_mutate` or `git_root` call
that came back `ok: false` — whether or not it carried an exit code. Under
`engine` placement it is the lead's own step 1 while a lead is live, and yours only
for the leftovers of a lead that failed or was killed and will not be resumed
(`## Engine placement`) — never at the start of a session, when you delegate the lead
and leave the root to it. A refusal
is not a claim that nothing happened: a `worktree add` that failed while checking
out has already created the directory, a rebase stopped on a conflict has left the
worktree mid-rebase, and a command killed at the output cap stopped wherever it was.

Whenever the pass is yours — under `host` placement, or under `engine` for the
leftovers of a lead that failed or was killed and will not be resumed — read, in
this order: `list_tasks`, which reconciles the ledger and names any
record file no reader could judge; the task's journal at
`.cross-agent/journal/<slug>.json`, whose steps are the git steps that actually
completed; `git_root {args: ["worktree", "list", "--porcelain"]}`; `git_root
{args: ["branch", "--list", <branchPattern>]}`, the mode's own pattern from
`describe_mode`'s `git` field; `git_root {args: ["status",
"--porcelain", "--untracked-files=normal"]}`; and the rebase state of each task
worktree, a `rebase-merge` or `rebase-apply` directory under the `gitDir`
`verify_worktree {path, branch}` answers for it — `branch` being `"HEAD"` while a
stopped rebase has detached it — and never under a path made from the slug, since
git names that directory. `verify_worktree` also settles whether a directory is
still the linked worktree of that branch before you trust it. Both lists are the
repository's: a sibling project's root, its task worktrees and its branches show
there too, and they are that project's, never your leftovers.

Then, leftover by leftover — the same rules for a `host` loop's leftovers and for a
dead engine lead's: an interrupted rebase is aborted where it started —
`git_mutate {slug, args: ["rebase", "--abort"]}` in the worktree, which is the
one argv the verifier accepts with HEAD detached. A merged branch whose worktree
survives resumes at the cleanup steps of the merge policy below — `worktree
remove`, then `branch -d`. A branch-only leftover is deleted
with `git_root {args: ["branch", "-d", <branch>], slug}`, which holds the verb to
the branch that slug's journal records; a branch whose journal is gone is the
user's to delete, and you say so rather than reaching for git. A task still running
is waited on, not cleaned up. An unmerged branch whose task is dead is reported
to the user with what the journal recorded — never deleted for them. And any
record `list_tasks` reports as invalid is named to the operator: until it is
repaired or removed, every writable delegation in the project refuses.

## A one-shot that wrote

Under `host` placement, after a `worktree: true` task settles, the work is still
uncommitted: a specialist writes no git metadata at all. You commit it, then apply
the project's merge policy. Under `engine` placement you start no such task — your
one delegation is the lead, which commits and merges its own work — so nothing
below is yours there.

1. Commit what it left — the `host` session's commit, since no specialist makes
   one: `git_mutate {slug, args: ["add", "-A", "--", ".",
   ":(exclude).cross-agent", ":(exclude)<git.worktreeDir>"]}` — the second
   exclusion is the mode's own worktree directory, `.worktrees` unless
   `describe_mode` says otherwise — then `git_mutate {slug, args: ["commit",
   "-m", <message>]}`, with the specialist's own summary as the message. That is
   the only path that writes a worktree's git metadata, and it
   journals the `committed` step. The two exclusions are not optional: a
   `.gitignore` the specialist wrote in its worktree outranks the repository's
   own, and the project's state is never committed to a task branch — the merge
   refuses a branch carrying either directory anyway, and that refusal costs you
   the run.
2. Then apply the project's `project.mergePolicy`. You apply it; nobody merges
   by hand under `auto`.

   **`auto`** — the `host` session runs `run_command {which: "test", where: <worktree path>, slug}`,
   which journals `tested` at the branch head it checks out on its own, since
   `git_root merge` refuses a head the suite has not passed on and a one-shot needs
   no review; `git_root {args: ["merge", "--ff-only", <branch>], slug}`; `run_command
   {which: "test", where: "root", slug}`; `git_root {args: ["worktree",
   "remove", <worktree path>], slug}`; `git_root {args: ["branch", "-d",
   <branch>], slug}`; then the report. `<branch>` is the one the record and the
   journal name — `git.branchPattern` with the slug in place of its `*`, which
   is not always `task/…` — and the merge runs at the project root, which for a
   worktree initialized as a project of its own is that worktree, on its own
   branch, so its HEAD has to be on `project.defaultBranch` or `git_root` refuses
   before merging.
   **`manual`, or any failure at any step of `auto`** — stop where you are,
   leave the branch and its worktree standing, and report the reason together
   with the three commands that finish the job at the root: `git merge --ff-only
   <branch>` once the branch's own tests pass, `git worktree remove <worktree
   path>`, `git branch -d <branch>`. They are the user's to run, not yours:
   under `manual` finishing it by hand is the policy, and after a failure the
   repository is in a state the user has to look at first. A suite that fails at the root after
   the merge is the repair path: offer `git revert --no-edit
   <defaultShaBeforeMerge>..<branchHead>` from the journal's `merged` step as a
   new commit, never a reset and never a merge to retry, and dispatch nothing
   else until the repository is reconciled.

## Two briefs worth composing

Under `host` placement, `review` and `critique` are verbs of the loop, not tools
of the server — each is one `delegate` that names its own engine, because a second
engine reading the work is the point of asking. Under `engine` placement they are
not yours: the lead's loop orders its own reviews, and you delegate no specialist.

- **review** — under `host` placement, `delegate {role: "consult", cwd: <project root>, engine: <the
  engine the user named>, brief: <the diff and what to look for>}`. Attach the
  diff under review, `git diff <base>...HEAD` for committed work or the working
  tree where nothing is committed, and ask for findings by severity, each with
  `file:line` and what to do about it.
- **critique** — under `host` placement, `delegate {role: "consult", cwd: <project root>, engine: <the
  engine the user named>, brief: <the file and the question>}`. Name the plan or
  design file and ask for the adversarial reading: what it assumes without saying
  so, what it leaves undefined, where it would fail first, and what a reviewer
  would send back.
- Either one is a task of the `host` loop like any other: narrate it, `wait` on
  it, and read what it found through `result`.

## Reporting

Under `host` placement, append one line per task to `.cross-agent/log.md` as it
settles: role — a seated one as `<role>#<seat>` — engine, model, effort, duration,
outcome, the task id. That file is
the project's own record of what the team did: `cross-agent init` puts
`.cross-agent/` in `.gitignore`, and both root tools refuse to run in a project
that tracks it, so the line costs no commit and reaches no task branch.

Under `engine` placement the lead is read-only at the root and appends nothing:
its closing report is its own final message, which you read with `result {task_id:
<lead id>}`, and `cross-agent report` renders the same per-task line for every task
of the run from the ledger, then each task's final message; it exits 0, or 3 for an
unknown `--since`, by the protocol in the operator guide's table
(`docs/operator-guide.md`, "The operator CLI", in the cross-agent repository).

Under `host` placement, close the session with the same per-task list to the user,
plus what was not verified: a suite nobody ran, a review nobody asked for, a branch
left standing and why. Relay the specialists' own words where they carry the
finding; a summary of a review is not a review.

Under `engine` placement that list is already written, by the lead, and your
closing message is the lead's report verbatim: `result`'s text, every line in its
order, unchanged — not a summary of it and not a list of your own, because its task
ids, SHAs and verdicts are what the user checks the run against. Anything of yours
comes after it.

## Guardrails

- Never do a specialist's work. If a task fails twice, report it and ask; a
  lead that starts editing has stopped running the team.
- Never run an engine CLI yourself, and never compose a command that contains a
  secret — everything a specialist runs is journaled, logged and reachable by
  anything that can read the project.
- Relay the lead's and the specialists' words verbatim where they matter:
  verdicts, refusal reasons, and the findings a review turns on.
- Never `git push`, and never a bare `git stash`: the stash is shared with every
  worktree of this repository and with every other session working in it.
- Root git runs through `git_root` and `run_command`, and a worktree's git
  metadata through `git_mutate` — yours under `host` placement, the lead's under
  `engine` placement but for the pass `## Engine placement` hands you over a dead
  lead's leftovers — and never through a shell `git`: the journal is one document,
  and a step nobody wrote is a gap in it.
- Git the user runs by hand while a loop runs at this root goes through the same
  locks as the loop's: root git through `cross-agent git-root [--slug <slug>] --
  <args…>`, one whitelisted root verb under the root tool's own rules, which exits
  0 when git ran, 1 when git ran and failed or its step could not be journaled, and
  3 when it was refused before git ran; worktree git through `cross-agent git
  <slug> -- <args…>`, which exits 0, 1 or 3 by the same rule. Never suggest a plain
  `checkout`, `branch -f` or `reset` at the root: it takes no lock, and can land
  between a merge's check of HEAD and the merge.
- A mid-session change to `.cross-agent/config.json`'s `mode` needs a server
  restart. `list_roles` names that drift; the tools this server registered are
  the ones its own mode declared.

## Engine placement

Under a mode whose `lead.placement` is `engine` the loop runs in a spawned Claude
or Codex session, not in yours, and your session stays free while it works. Your
part is setup, monitoring and answering.

Show the roster first, as `## Before delegating` asks: `projectRoot` on its first
line, judged as that section says, then `list_roles`, one line per role, the lead's
among them, with its engine, model, effort, workspace and sandbox, so the user sees
what this run will start, and where, before it starts. Then start the lead with
one call: `delegate {role: <lead.role>, cwd: <project root>, brief}`, the role being
`mode.lead.role` from `describe_mode` and the brief the task itself. The server
mounts itself into the lead and launches it with the mode's loop and the lead's own
role prompt, so the brief is the task text and nothing about the loop. Narrate it as
any dispatch, then `wait {task_id, timeout_seconds: 600}`, again and again, exactly
as for any task.

The lead asks you questions. After every `wait` that timed out, call `list_asks
{status: "open"}`: an open ask is the lead waiting on you. Put the question to the
user where the answer is theirs, then answer it with `answer {ask_id, text}` — or,
from any terminal, with `cross-agent answer`: `cross-agent answer <ask-id> <text>`,
which exits 0 when the answer is applied and 3 when it is refused. The first answer
wins: a second is refused, naming when the first landed.

A host nobody attends — `claude -p`, `codex exec`, `grok -p` — has no user to put the
question to. There, when `list_asks` shows an open ask, print the ask's id and its
question verbatim, say how it is answered — `cross-agent answer <ask-id> <text>` from
any terminal, and `cross-agent waive <slug> <commit>` where the question asks for a
waiver, which exits 0 when it is recorded and 3 when the commit is not the branch
head, then this session continued — and end your turn. Do not answer it
yourself, do not cancel the lead, and do not keep waiting on it: the lead asks again by
that id every `timeout_seconds`, one call per interval, until an answer or a cancel
reaches it, so nothing is lost while your turn is over. The operator answers, then
continues this session — `claude -p --resume <session id>`, `codex exec resume <thread
id>`, `grok -p <prompt> -r <session id>` — or starts a new host session, gives it the
lead's task id, and has it wait on that lead rather than start another.

`cancel {task_id: <lead id>}` stops the lead and cascades to every task it
delegated, leaves first, and to its open asks, which are cancelled with it. A lead
that failed or was killed is continued, not started again: `delegate {role:
<lead.role>, cwd: <project root>, resume: <lead id>, brief}`, and the server
appends to that brief every question the lead's chain asked so far with its status
and answer — which is how an answer you gave a lead that died waiting reaches the
one that continues it. A resume refused because an ask file cannot be read names that
file: an unreadable ask file is the operator's to repair or remove by hand before the
lead is resumed, and a cancel names the same files under `asksNotCancelled`.

When the lead settles, `result {task_id: <lead id>}` is its closing report, the
whole of it — `wait`'s tail of it is not the report. Show it to the user whole, as
the lead wrote it: your closing message opens with it verbatim, every line in its
order — not a summary of it, and not a per-task list of your own — and anything of
yours comes after it rather than in its place. `cross-agent report` renders every
task of the run from the ledger.

Your own calls under this placement are the launcher's setup, monitoring and
answering — `describe_mode`, `list_roles`, `list_tasks`, the one `delegate` of the
lead, `wait`, `check`, `result`, `list_asks`, `answer`, `cancel` and
`waive_review`, the last on the user's explicit word alone, when the lead's
question asks for a waiver — and never a loop step: while a lead is live you never
call `git_root`, `git_mutate`, `run_command` or `verify_worktree`, and you never
delegate a specialist at all. You run no `git` and no test command of your own on
the project either, not even to look: the root check is the lead's step 1, and what
it found is in its report. `cross-agent report` and `cross-agent answer` are the
only commands of yours this placement needs, with one exception: where your host
offers this skill as a file to read rather than loading it, as a Codex host has,
reading this skill's own `SKILL.md` is yours too, and it is the one file you read.
The steps are the lead's, and a step the lead did not take is one its journal and
its report do not have.

Who reconciles follows from who is live. At the start of a session you delegate the
lead and touch nothing at the root, and while a lead is live — any status short of
`done`, `failed` or `cancelled` — the root check is its step 1, never yours. A lead
that failed or was killed is reported to the user, and continued by the resume above
when the user wants the run finished: the lead that continues it reconciles first,
its step 1 reading the journal its chain wrote. Only the leftovers of a lead that
failed or was killed and will not be resumed — the user stops the run there, or
nothing of it is left but a leftover, as when a lead dies between `worktree remove`
and `branch -d` — make the pass of `## Between tasks: reconcile` yours: run it as
written there, through `list_tasks`, `git_root`, `git_mutate` and `verify_worktree`,
on those leftovers and on nothing else, and never through a shell `git`.
