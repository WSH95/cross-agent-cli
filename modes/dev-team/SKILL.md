# The dev-team loop

One task at a time, through four specialists: the planner and the plan reviewer
read the project at its root, the implementer works in a linked worktree on its
own branch, and the code reviewer reads what it committed there. `lead.placement`
is `host`, so the session reading this runs the loop and owns every root git
operation. No specialist runs a git command that writes, and nothing here trusts
a worktree's `.git` pointer: Claude's and Codex's sandboxes keep the implementer
from writing it, and Grok's cannot.

`<slug>` is the short name you choose in step 1: the directory under the mode's
`git.worktreeDir`, the branch its `git.branchPattern` makes (`task/<slug>` for
this mode, written `<branch>` below), the journal file every git step appends
to, and the `slug` that `git_mutate`, `git_root` and `run_command` all take.
Because it is all four, its alphabet is the narrowest of them: letters, digits,
`.`, `_` and `-`, starting with a letter, a digit or an underscore, or the
journal refuses the call before any git runs.
`<default>` is `project.defaultBranch`, and `<worktree path>` is
`<project root>/<git.worktreeDir>/<slug>`, absolute. `describe_mode` gives you
the policy those come from, and each role's own prompt — the text `delegate`
launches that role with, so a brief below adds this task's own work to it and
never repeats it; `list_roles` gives you the engine, model and effort behind
each role name below, and you announce each of them as you dispatch it.

## 1. Root check

`list_tasks` first. It runs the reconciliation pass itself: a task whose runner
is gone is settled rather than believed, and any record file no reader could
judge is named back to you — until that file is repaired or removed, every
writable delegation in the project refuses. Read the journals of whatever it
reports and settle each leftover before you start something new: an interrupted
rebase is aborted in its own worktree, a merged branch whose worktree survives
goes to step 10, a branch with no worktree and no live task is deleted with
`git_root {args: ["branch", "-d", <branch>], slug}` — which needs that slug's
journal to still record the branch, and where the journal is gone the branch is
the user's to delete — a task still running is waited on, and an unmerged branch whose task is dead is reported to the user and
left standing.

Then `git_root {args: ["status", "--porcelain", "--untracked-files=normal"]}`
must print nothing; if it prints, show the user and stop. The root must also sit
on `<default>`, because step 9 refuses to merge anywhere else: `git_root {args:
["rev-parse", "--abbrev-ref", "HEAD"]}` prints the branch the project root has
checked out, `<default>` when the root is where it should be — anything else,
`HEAD` for a detached one included, stops the task here. Then choose the slug
against `git_root {args: ["worktree", "list", "--porcelain"]}` and `git_root
{args: ["branch", "--list", "task/*"]}`. Both list the repository's, not this
project's: a sibling project's root, its task worktrees and its branches show
there too, and they are not yours to touch. Choose a `<slug>` neither list shows,
and treat as a leftover only what lies under this project's `git.worktreeDir` or
what one of its own open journals names: a journal holding a `branch-deleted` step
is closed, and claims nothing about a branch of that name now.

## 2. Plan

`delegate {role: "planner", cwd: <project root>, brief}`, with the task text and
its acceptance criteria verbatim, `<default>`, the test command, and the
instruction to check the task's claims about the repository before planning
anything. `wait`, then `result`. A planner that answers `Premise fails: …` has
found the task wrong about the repository: report the claim and what it found,
and stop until the user corrects the task.

## 3. Plan review

`delegate {role: "plan-reviewer", cwd: <project root>, brief}` with the task text
and the plan verbatim. `wait`, then `result`, then act on the verdict. `approve`
— step 4. `revise` — `delegate {role: "planner", cwd: <project root>, resume:
<the latest planner task id>, brief: <the findings verbatim>}`, then review the
revision; at most two rounds, and then you stop and show the user both texts.
`human decision` — put the reviewer's question to the user in plain words, and
resume the planner the same way once you have the answer, carrying it in the
brief.

A resume call carries every key a first call does — the same `role` and `cwd`,
and the branch where the role works in a worktree — and it names the **latest**
id of the chain: a resumed task's own id supersedes the one it continued, and
the id before it is refused with `resume the latest: <id>`.

## 4. The worktree

`git_root {args: ["worktree", "add", "-b", <branch>, <worktree path>, <default>], slug}`
creates the branch and its work tree in one call and opens the task's journal on
both, which is the `worktree-created` step. The base is `<default>` and nothing
else, and the directory sits directly under the mode's worktree directory. Then
run the project's setup command in it unless the config says `none`:
`run_command {which: "setup", where: <worktree path>, slug}`.

## 5. Implement

`delegate {role: "implementer", cwd: <worktree path>, branch: <branch>, brief}`.
The brief carries the task text, the approved plan verbatim, the test command,
`<default>`, the branch and the worktree path, and the closing report you need
back: what changed, what ran, what the result was, and the one-line summary you
will commit under. `wait`, then `result`. A `BLOCKED` report caused by a plan
step naming a path that does not exist is a correction you send back the way
step 7 does — a `resume` naming the same `cwd` and `branch` and the latest
implementer id; any other `BLOCKED` ends the task with its worktree standing and
goes to the user.

## 6. Commit what it left

The implementer wrote no git metadata, so its work is uncommitted when the task
settles. Commit it yourself, in two calls:

`git_mutate {slug, args: ["add", "-A", "--", ".", ":(exclude).cross-agent", ":(exclude).worktrees"]}`

`git_mutate {slug, args: ["commit", "-m", <the implementer's summary>]}`

which journals the `committed` step. The two exclusions are not optional: a
`.gitignore` the specialist wrote in its own worktree outranks the repository's
own, and step 9 refuses a branch that carries either directory at all, or a
host's project configuration — `.claude/`, `.codex/`, `.grok/`, `.mcp.json` —
which the commit above refuses first, naming the path. Those paths must be
regular files: a symbolic link at any of them, anywhere in the project's tree,
blocks every commit and every merge until the operator replaces it with a
regular file at the root by hand.

## 7. Code review

`delegate {role: "code-reviewer", cwd: <worktree path>, branch: <branch>, brief}`
with the task text, the plan, the branch, `<default>`, and the four verdicts you
will act on: ready, needs work, needs rebase, discard. It reads the committed
branch under a read-only sandbox and runs nothing that writes. Needs work —
`delegate {role: "implementer", cwd: <worktree path>, branch: <branch>, resume:
<the latest implementer task id>, brief: <the findings verbatim>}`, then step 6
again; at most two rounds before you stop and report. Needs rebase — step 8,
then review again. Discard — stop and report, worktree standing. Ready — step 8.

Every review after the first names its round and the commit it is reviewing in
the brief. A brief identical to one a task in this cwd finished inside
`limits.duplicateWindowMinutes` is refused as a duplicate, and a rebase and a
re-review take less time than that window; naming the round is also what tells
the reviewer which findings it is checking. `force: true` is the override, and
it is for a brief you meant to repeat.

## 8. Rebase

`git_mutate {slug, args: ["rebase", <default>]}` journals `rebased` when the
branch moved. Run it even when `<default>` has not moved since step 4: it costs
one call, git answers that the branch is up to date, and the journal then shows
a `git` step with the arguments rather than `rebased`, which is what the table
at the end of this file says a call that moved nothing writes. Skipping it
means the journal cannot tell a rebase that found nothing to do from a rebase
nobody ran. A conflict leaves the worktree mid-rebase with HEAD detached:
`git_mutate {slug, args: ["rebase", "--abort"]}` — the one argv the worktree
verifier accepts with a detached HEAD, and the reason the abort runs here rather
than at the root — and then escalate to the user with the file names. You do not
resolve the conflict yourself, and you do not send it to the implementer as a
plan. A rebase that moved the branch has put the work on commits the suite never
saw, so run `run_command {which: "test", where: <worktree path>, slug}` before
you merge.

## 9. Merge, and the suite on the default branch

`git_root {args: ["merge", "--ff-only", <branch>], slug}` journals `merged`
together with the two SHAs the repair path needs. It refuses unless the root's
HEAD is `<default>`, and unless the branch carries nothing from `.cross-agent`,
the worktree directory or a host's project configuration — `.claude/`,
`.codex/`, `.grok/`, `.mcp.json` — which step 6's commit refuses too, naming the
path. A symbolic link at any of those paths is refused the same way, at every
commit and every merge, until it is replaced with a regular file at the root.
Then `run_command {which: "test", where: "root", slug}`, which journals
`tests-passed` when it exits zero.

A failing suite here is an answer rather than a refusal, and it is the repair
path: stop, report it, and offer `git revert --no-edit
<defaultShaBeforeMerge>..<branchHead>` — the two SHAs from the journal's
`merged` step — as a new commit. Never reset `<default>` and never rewrite it,
and dispatch no further task until the repository is reconciled.

## 10. Clean up and record

`git_root {args: ["worktree", "remove", <worktree path>], slug}`, then `git_root
{args: ["branch", "-d", <branch>], slug}`, journalling `worktree-removed` and
`branch-deleted`. Both refuse the shortcut that would lose work: the removal is refused outright
while a live task reserves that workspace — `<path> is reserved by task <id>
(<status>); wait or cancel first` — so you settle that task before you retry,
and `-d` refuses a branch git does not see as merged, which is this loop's
cleanup gate. Stop at the first failure
and report exactly what was removed and what is still standing.

Then record the task: one line per specialist appended to `.cross-agent/log.md`
— role, engine, model, effort, duration, outcome, task id — the bead closed if
the task named one, and the closing report to the user: the task, the files the
plan touched, the branch and the commit it merged as, where the suite ran and
what it said, every verdict, the cleanup result, and anything nobody verified.

## The journal, and what a refusal means

| step | the call that writes it |
| --- | --- |
| `worktree-created` | step 4's `git_root worktree add -b` |
| `committed` | step 6's `git_mutate commit`, when it moved the branch |
| `rebased` | step 8's `git_mutate rebase`, when it moved the branch |
| `merged` | step 9's `git_root merge --ff-only` |
| `tests-passed` | step 9's `run_command` at the root, exiting zero |
| `worktree-removed` | step 10's `git_root worktree remove` |
| `branch-deleted` | step 10's `git_root branch -d` |
| `git` | any other `git_mutate` call, recorded with the arguments it ran |

Each step is written by the tool that performed it, while it still holds the
lock that ordered it, so no step of this loop has to remember to journal
afterwards and no journal verb exists for you to misuse. A named step is written for
what a call **moved**: a commit that committed nothing and a rebase that
replayed nothing are journaled as a `git` step with their arguments instead, the
table's last row, which is what keeps a reconciliation pass reading `committed`
from looking for a commit that was never made.

Any `ok: false` from `git_mutate` or `git_root`, with an exit code or without
one, is a reconciliation trigger — a refusal is not a claim that nothing
happened. Stop the loop and reconcile this slug before anything else: `list_tasks`, this
task's journal, `git_root {args: ["worktree", "list", "--porcelain"]}`,
`git_root {args: ["status", "--porcelain", "--untracked-files=normal"]}`, and
the `rebase-merge` or `rebase-apply` directory under the `gitDir` `verify_worktree
{path: <worktree path>, branch}` answers, `branch` being `"HEAD"` while a stopped
rebase has detached it — what the journal records is what completed, and the difference between that and
what git shows is what you repair, by step 1's rules, before you decide whether
the step can be repeated. An `ok: true` carrying
`lockLost: true` says the command ran but was not exclusive for all of its life:
reconcile that slug too before you trust the next step.
