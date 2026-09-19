---
name: cross-agent
description: Run a task through a team of headless agent CLIs instead of doing it yourself. Use when the user asks to run something through the team, to delegate work to another harness, to hand a bead or a TODO item to an agent, or says "ask codex to …", "ask grok to …", "ask claude to …". Delegates each role to its engine, watches every task to settlement, merges what a task wrote under the project's own policy, and reports what each one did.
---

# cross-agent

A team here is a **mode**: roles, a loop, and a git policy. You dispatch the
roles, watch them, decide what happens next, and report. You do not do their
work, and you never start an engine CLI yourself — a `claude`, `codex` or `grok`
the server did not launch carries none of the guard the server puts around one,
and none of its tasks can be waited on, cancelled or reported.

## Before anything

Call `describe_mode`. It answers with the active mode's `loop`, its `roles` —
each with its workspace, sandbox default and prompt — and its `git` policy:
`worktreeDir`, `branchPattern`, and `implicit: true` where those two are this
build's defaults rather than the mode's own. **The `loop` it returns is your
instructions for this project.** It is served rather than copied into a skill
directory, so it is current for the mode this server actually loaded; where it
spells a step differently from this skill, follow it.

If `describe_mode` refuses, tell the user the reason and stop. A project with no
`.cross-agent/config.json` is not that case — it runs the built-in `solo` mode
on defaults, so a one-off delegation needs no setup at all. A refusal means the
config names a mode this server could not read, and `cross-agent init --mode
<name>` is what binds a team to this project.

Then call `list_roles` and show the roster before you dispatch anything: one
line per role with its engine, model, effort, workspace and sandbox. A role
whose `binding` is `null` is bound to no engine; it is still a role you can
delegate, but your call has to name the `engine`. A `warning` in the answer
means `.cross-agent/config.json` was pointed at another mode after this server
started: which tools exist was settled when it loaded, so report the drift and
ask for a restart instead of working around it.

## Starting a task

`delegate {role, brief, cwd}` launches one specialist and answers with its task
id. Add `branch` when the role works in a worktree — the mode's loop creates
that worktree and tells you the path and the branch — and `engine`, `model` or
`effort` to override the binding for this call alone. `worktree: true` gives a
role that works at the project root a writable task worktree of its own instead;
the record then carries `worktree: {path, branch, slug}` and the slug is the
task id.

The brief is the whole of what the specialist knows about your intent: what to
do, where, what counts as done, and the shape of the closing report you will
read back. Put the role's own standing duties in it as well — today `delegate`
launches a specialist with the `prompt` bound in `.cross-agent/config.json` or a
one-line default, so a role prompt the mode serves is text for you to draw on,
not something the engine has already been told.

Narrate every dispatch in one line before you wait on it: *delegating `<role>`
to `<engine>`/`<model>` at `<effort>` in `<cwd>`*. The user is paying for these
engines and cannot see them; a task nobody announced is a task nobody can stop.

A refusal is an answer, not an error to retry: a request identical to a live
task is refused with the id to wait on instead, one identical to a task that
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

- `running` — call `wait` again. So is a record still `launching` or
  `cancelling`: both are in motion.
- `stalled` — the engine has emitted nothing for the configured threshold; the
  task is still alive. Read the log the hint names, then keep waiting or
  `cancel`.
- `unsettled` — a flag beside the status, not a status: this call reconciled
  and the record did not move, and its `reason` says what the pass could not do.
  Call `list_tasks`, which reconciles again, and decide from what it reports.
- `orphaned` — the runner is gone. `list_tasks` reconciles it; `cancel`
  terminates whatever engine is left.
- `done` — call `result` for the final message in full. That message is the
  work product: quote what matters rather than paraphrasing it.
- `failed` — read `result` for whatever the engine said and the log for how it
  ended, and report both. A failed task is never retried silently.
- `cancelled` — somebody stopped it. Say who asked and what it had done.

Never declare a task done from `check` alone: `check` reconciles nothing, so a
record it reports as running may have lost its runner minutes ago. `check` is
for a glance at a task you are not waiting on; `wait` and `list_tasks` are the
two calls that see the ledger repaired.

Keep each `wait` inside your host's own tool timeout, and repeat it — a long
task costs you many short waits, not one long one:

| host | its MCP tool timeout | `timeout_seconds` to pass |
| --- | --- | --- |
| Claude Code | about 28 hours by default | 600 |
| Codex | `tool_timeout_sec` per server, 3600 in this repository's manifest | 600 |
| Grok | not settled until probe I2 of T15 | 300 |

Those are the budgets of the design's "Time limits": there is no cap on a task,
only on one call about it. `timeout_seconds` defaults to the project's
`limits.waitDefaultSeconds`, and the silence threshold that produces `stalled`
is `limits.stallMinutes`.

## A needs-work round

A second round on the same task is `delegate` with `resume: <task id>` and an
amended brief — the findings verbatim and what to do about them. The
continuation keeps the original's role, engine, cwd and sandbox, and a task that
was given a worktree is continued in that worktree, so a review round reaches
the same branch. Resume only after the task settled: an active task is refused,
and so is a chain that already has a successor, which answers with the latest id
to continue instead.

## Cancelling

`cancel {task_id}` terminates the task and everything it delegated, leaves
first, and answers with one outcome per task: the status each reached, or
`already <status>` for one that was over. A partial failure is reported as
such — call `cancel` again and it retries what is left, because a cascade that
claimed success while a descendant survived is the failure this lifecycle
exists to prevent. Cancelling settles the task; it does not undo what the
specialist already wrote to its worktree.

## Between tasks: reconcile

Run this pass before the first task of a session, after any interruption, and
after **any** `git_mutate` or `git_root` call that came back `ok: false` —
whether or not it carried an exit code. A refusal is not a claim that nothing
happened: a `worktree add` that failed while checking out has already created
the directory, a rebase stopped on a conflict has left the worktree mid-rebase,
and a command killed at the output cap stopped wherever it was.

Read, in this order: `list_tasks`, which reconciles the ledger and names any
record file no reader could judge; the task's journal at
`.cross-agent/journal/<slug>.json`, whose steps are the git steps that actually
completed; `git_root {args: ["worktree", "list", "--porcelain"]}`; `git_root
{args: ["branch", "--list", "task/*"]}`; `git_root {args: ["status",
"--porcelain", "--untracked-files=normal"]}`; and the rebase state of each task
worktree, which is a `rebase-merge` or `rebase-apply` directory under
`.git/worktrees/<slug>`. `verify_worktree {path, branch}` settles whether a
directory is still the linked worktree of that branch before you trust it.

Then, leftover by leftover: an interrupted rebase is aborted where it started —
`git_mutate {slug, args: ["rebase", "--abort"]}` in the worktree, which is the
one argv the verifier accepts with HEAD detached. A merged branch whose worktree
survives resumes at the cleanup steps of the merge policy below — `worktree
remove`, then `branch -d`. A branch-only leftover is deleted
with `git_root {args: ["branch", "-d", <branch>], slug}`. A task still running
is waited on, not cleaned up. An unmerged branch whose task is dead is reported
to the user with what the journal recorded — never deleted for them. And any
record `list_tasks` reports as invalid is named to the operator: until it is
repaired or removed, every writable delegation in the project refuses.

## A one-shot that wrote

After a `worktree: true` task settles, the work is still uncommitted: a
specialist writes no git metadata at all. You commit it, then apply the
project's merge policy.

1. Commit what it left: `git_mutate {slug, args: ["add", "-A", "--", ".",
   ":(exclude).cross-agent", ":(exclude).worktrees"]}`, then `git_mutate {slug,
   args: ["commit", "-m", <message>]}`, with the specialist's own summary as the
   message. That is the only path that writes a worktree's git metadata, and it
   journals the `committed` step. The two exclusions are not optional: a
   `.gitignore` the specialist wrote in its worktree outranks the repository's
   own, and the project's state is never committed to a task branch — the merge
   refuses a branch carrying either directory anyway, and that refusal costs you
   the run.
2. Then apply the project's `project.mergePolicy`. You apply it; nobody merges
   by hand under `auto`.

   **`auto`** — `run_command {which: "test", where: <worktree path>, slug}`;
   `git_root {args: ["merge", "--ff-only", <branch>], slug}`; `run_command
   {which: "test", where: "root", slug}`; `git_root {args: ["worktree",
   "remove", <worktree path>], slug}`; `git_root {args: ["branch", "-d",
   <branch>], slug}`; then the report. `<branch>` is the one the record and the
   journal name — `git.branchPattern` with the slug in place of its `*`, which
   is not always `task/…` — and the merge runs at the project root, so its HEAD
   has to be on `project.defaultBranch` or `git_root` refuses before merging.
   **`manual`, or any failure at any step of `auto`** — stop where you are,
   leave the branch and its worktree standing, and report the reason with the
   commands that finish the job by hand. A suite that fails at the root after
   the merge is the repair path: offer `git revert --no-edit
   <defaultShaBeforeMerge>..<branchHead>` from the journal's `merged` step as a
   new commit, never a reset and never a merge to retry, and dispatch nothing
   else until the repository is reconciled.

## Two briefs worth composing

`review` and `critique` are verbs of the loop, not tools of the server —
each is one `delegate` that names its own engine, because a second engine
reading the work is the point of asking:

- **review** — attach the diff under review, `git diff <base>...HEAD` for
  committed work or the working tree where nothing is committed, and ask for
  findings by severity, each with `file:line` and what to do about it.
- **critique** — name the plan or design file and ask for the adversarial
  reading: what it assumes without saying so, what it leaves undefined, where it
  would fail first, and what a reviewer would send back.

## Reporting

Append one line per task to `.cross-agent/log.md` as it settles: role, engine,
model, effort, duration, outcome, the task id. That file is the project's own
record of what the team did: `cross-agent init` puts `.cross-agent/` in
`.gitignore`, and both root tools refuse to run in a project that tracks it, so
the line costs no commit and reaches no task branch.

Close the session with the same per-task list to the user, plus what was not
verified: a suite nobody ran, a review nobody asked for, a branch left standing
and why. Relay the specialists' own words where they carry the finding;
a summary of a review is not a review.

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
  metadata through `git_mutate`, under both placements — the journal is one
  document, and a step nobody wrote is a gap in it.
- A mid-session change to `.cross-agent/config.json`'s `mode` needs a server
  restart. `list_roles` names that drift; the tools this server registered are
  the ones its own mode declared.

## Engine placement

S11 extends this section: under a mode with `lead.placement: "engine"` the loop
runs in a spawned Claude or Codex session rather than yours, your own session
stays free while it works, and three things arrive that do not exist yet — the
lead asks you questions through a mailbox you read with `list_asks` and reply to
with `answer`, or from a terminal with `cross-agent answer`; the lead's closing
report is its task's final message rather than a line it appends; and
`cross-agent report` renders the per-task log from the ledger in place of
`.cross-agent/log.md`. Until then every mode runs its loop in your own session.
