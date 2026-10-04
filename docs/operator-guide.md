# Operating cross-agent

How a project's team is configured and guarded, the operator CLI verb by verb, and how
several branches of one repository run their teams at once. Installing is in
`docs/install.md`; the design, which this guide follows, is `docs/design.md`.

## Team configuration

Once per project the team is to work in, write its bind-time config —
which mode, and the engine, model and effort each of that mode's roles runs on:

```
cd ~/code/my-project
cross-agent init --mode dev-team
```

`cross-agent` is the plugin's launcher (README, "The operator CLI"). `init` writes
`.cross-agent/config.json` with every role bound to a default you then edit, adds
`.cross-agent/` and the mode's worktree directory to `.gitignore`, and leaves an
existing config alone. Commit that `.gitignore` change before the
team's first task (`git add .gitignore && git commit -m '…' -- .gitignore`): a
loop's first step stops unless `git status --porcelain --untracked-files=normal`
prints nothing at the project's root. The server discovers that project from the
host session's working directory, so a session started anywhere inside it runs
that project's team.

In a `dev-team` project `init` binds the code reviewer to three seats — Claude,
Codex and Grok, each read-only — which review the committed branch in parallel, and
the resolver to a stronger model, which takes the findings two fix rounds have left
standing; a code reviewer bound to a writable profile is refused by field, since its
seats read beside each other in one worktree. A config written before the resolver
existed still loads, and its team's first task stops at the roster until you add
`roles.resolver` by hand, because `init` leaves an existing config alone.
`limits.planReviewRounds` (default 3) is how many consecutive plan reviews may find
major issues before the loop stops and asks you, and `review.afterResolver` — `ask`
by default, `lead-decides` or `always-ask` — says what it does when significant
findings outlast the resolver: ask you, let the lead rule and record the waiver, or
ask you whatever stands. Two guards back the loop, so that no misreading of its text
and no crash merges untested or unreviewed work; a session that races its own tools
against them is outside what they promise. `git_root merge` refuses a branch head
the configured suite has not passed on in a fresh checkout of that head under
`.cross-agent/gate/`, after the setup command, and, for a team task, one every
reviewer seat has not finished a clean review of, unless you waive it with
`cross-agent waive <slug> <commit>`. A reviewer is refused while the worktree holds
uncommitted changes or its setup command runs. `cross-agent journal <slug>` shows
the `tested` and `review-waived` steps.

## The operator CLI

`cross-agent <verb>` — the plugin's `bin/cross-agent`, which Claude Code puts on its
Bash tool's PATH, or a clone's `~/src/cross-agent-cli/bin/cross-agent` — is the
operator's own entry point. Every verb
takes `--project <root>`, `--json` for one JSON document on stdout whatever the
exit, and `--help`. Without `--project`, `init` writes in the current directory,
and every other verb reads the project the server would find:
`CROSS_AGENT_PROJECT`, then the nearest `.cross-agent/config.json`, then the git
toplevel — a directory inside a task's worktree read as its root, and a worktree
nobody initialized as its main checkout. Each verb calls the function its tool calls,
and a verb that reads writes nothing: not a record, not a lock, not a stall reading.

| verb | what it does | exits |
| --- | --- | --- |
| `init [--mode <name>] [--from <dir>]` | writes `.cross-agent/config.json` for a mode, every role bound to a default you then edit; an existing config is left alone. In a linked worktree it copies the config of the main checkout, or of `--from`, with the worktree's own branch as the default, or with `--mode` writes that mode's defaults instead, and copies the Grok attach of `--from` or of the main checkout beside it; `--mode` with `--from` is a 2; 3 for a task worktree, a detached HEAD, or a branch the mode's task pattern matches | 0, 3 |
| `modes` | the installed modes, the active one starred, each with its roles; a config naming a mode this build does not have is a 3, with the listing still printed | 0, 3 |
| `tasks [--status <status>] [--reconcile]` | every task, newest first — id, status, role (`code-reviewer#2` for a code reviewer's second seat; `--json` keeps `role` and `seat` apart), engine, depth, age, cwd — as the ledger holds it, a task whose runner is gone marked so, and every record file no reader could judge named; `--reconcile` runs `list_tasks`' reconciliation pass first, the one read that writes | 0 |
| `show <id> [--lines <n>]` | one task: its record, the role spelled as `tasks` spells it and a review's `underReview` commit among its fields, the last lines of its engine's stream, its outcome, its journal and its final message; 4 while it runs and 6 when it is stalled, by the status the last `wait` or `check` wrote | 0, 3, 4, 6 |
| `log <id> [--lines <n>]` | the last lines of a task's engine event stream, 50 by default | 0, 3 |
| `cancel <id>` | cancels a task and every task it delegated, leaves first, and its lineage's open asks; 4 while a task of the cascade is still active, which a second cancel retries | 0, 3, 4 |
| `verify-worktree <path> <branch>` | verifies a linked worktree on its exact branch, as `verify_worktree` does | 0, 3 |
| `git <slug> [--path <dir>] [--branch <name>] -- <args…>` | runs one git subcommand in a verified worktree, under the project's locks and journaled, as `git_mutate` does; 1 when git itself ran and failed, with its own output | 0, 1, 3 |
| `git-root [--slug <slug>] -- <args…>` | runs one whitelisted git verb at the project root, under the project's locks and the repository lock, and journals the step it completes, as `git_root` does; 1 when git itself ran and failed, or ran and its step could not be journaled | 0, 1, 3 |
| `journal [<slug>]` | one task's git journal, step by step, or every journal's slug; 1 when the journal file does not read, naming it | 0, 1, 3 |
| `waive <slug> <commit>` | records your waiver of the review guard for the branch head of a task, as `waive_review` does; 3 when the commit is not that head or the task is merged or closed | 0, 3 |
| `list-asks [--status <status>]` | every question an engine-placed lead has put to you, in the order asked; 5 while one it printed is open, and a damaged ask file is named rather than hiding the rest | 0, 5 |
| `answer <ask-id> <text>` | answers an engine-placed lead's open question from a terminal; the first answer stands, and a second is refused naming when the first landed | 0, 3 |
| `report [--since <task id>]` | every task, newest first — role (as `tasks` spells it), engine, model, effort, duration, outcome, id — then each task's final message, indented under its heading; the outcome is `passed` (done), `failed` (failed or cancelled) or `unknown` (not settled, or no result file) | 0, 3 |

One exit protocol for every verb:

| code | meaning |
| --- | --- |
| 0 | ok |
| 1 | error: something the command did not anticipate failed, or, for `git` and `git-root`, git itself — with `--json`, `{ok: false, error}` on stdout, or the git verb's answer whole |
| 2 | usage: the command line could not be read — with `--json`, `{ok: false, error, usage}` on stdout, and nothing there without it |
| 3 | precondition: the project, the mode, the ask or the task is not in the state the verb needs — with `--json`, the verb's answer naming the reason is the document on stdout |
| 4 | still running: a task the verb names has not settled |
| 5 | needs the operator: a lead is waiting on an open ask |
| 6 | stalled: a task's engine has been silent past `limits.stallMinutes` |

Beside the codes in the verb table, any verb exits 1 for an error nothing
anticipated and 2 for a command line it cannot read, and every verb but `init`
exits 3 when no project resolves. 4, 5 and 6 are verdicts and print on stdout:
`show` exits 4 for a task still running and 6 for a stalled one, `cancel` 4
for a cascade that left a task active, and `list-asks` 5 for an open ask. A verb
that writes — `init`, `answer`, `cancel`, `git`, `git-root`, `waive` and `tasks --reconcile` — exits
3 when its own environment carries `CROSS_AGENT_TASK`, `CROSS_AGENT_DEPTH` or
`CROSS_AGENT_LINEAGE`, the markers of a task's process tree: writing is the
operator's, and an engine reaches the project through the server.

## Several branches at once

A worktree can be a project of its own, its team running on its own branch: its tasks
branch from and merge into that branch, its root roles and its suite run in it, and the
projects of one repository run at the same time. Make the worktree beside the main
checkout, then initialize it:

```
cd ~/code/my-project
git worktree add ../my-project-x -b x
cd ../my-project-x
cross-agent init
```

`init` there copies the main checkout's `.cross-agent/config.json` — the team as you
bound it — with `project.defaultBranch` set to the worktree's branch, `x`, and writes
the mode's defaults where the main checkout holds no config or you name a mode with
`--mode`. Commit the `.gitignore` change `init` makes there on the worktree's branch
before its first task (`git add .gitignore && git commit -m '…' -- .gitignore`), as
in any project: a loop's first step stops unless the root's tree is clean. A worktree
nobody initialized stays its main checkout's project, as before: a host started in it
serves the main checkout, and the roster's first line says so. Where the repository's git
directory is separate from its checkout (`git init --separate-git-dir`), git records no
path to the checkout, so name it: `cross-agent init --from <main checkout>`, or `--mode
<name>` for the defaults. `init` refuses a worktree with a detached HEAD, one on a
branch the mode's task pattern matches (`task/*`), and one on a branch outside the names
the root tools take: letters, digits, `.`, `_`, `/` and `-`.

A worktree project may not lie inside another work tree of its repository: one under
the main checkout, such as `my-project/branches/x`, is refused, as a task's worktree
under `.worktrees/` always was. A bare repository works too, with its worktrees beside
it — `repo.git` with `main/` and `x/` next to it — or in the umbrella layout, `U/.git` a
file reading `gitdir: ./.bare` with `U/main` and `U/x` its worktrees; there `init`
writes the mode's defaults, having no main checkout to copy. Put worktrees beside a bare
repository, never inside it: a root inside its own git directory is refused, because
every task is denied that whole directory.

Grok loads a project's plugin from the `.grok/config.toml` of the folder it runs in,
which git does not carry into a new worktree, so `init` copies the main checkout's file
there and ignores `.grok/` beside it, as it does beside an attach the worktree already
holds; trust the new folder in Grok, which cross-agent never does for you. A file that
binds a project with `--project` or `CROSS_AGENT_PROJECT` is not copied, since it would
serve the main project from the worktree: `init` prints the binding, and you set that
worktree's attach up by hand. A
Codex host names each worktree's project in `CROSS_AGENT_PROJECT`, as for any project,
and Codex may add a trust entry for each new directory to `~/.codex/config.toml` on its
own, which cross-agent cannot prevent.

While a project's loop runs, run git at its root by hand only through `cross-agent
git-root [--slug <slug>] -- <args…>`, which takes the loop's own locks and exits 0, 1
or 3 as `git` does, and git in a task's worktree only through `cross-agent git <slug>
-- <args…>`. No `checkout`, `branch -f` or `reset` at that root: a plain git command
takes no lock, and one landing between the merge's check of the root's branch and the
merge itself would put the merge on another branch.

The projects of one repository take turns at a lock in its git directory for every git
write, and a project waits for it at least sixty seconds, whatever its own
`limits.lockWaitSeconds`; where your hooks run longer than that, raise
`limits.lockWaitSeconds`. A hook that hangs holds the lock until it is killed, and a
call stuck behind it cannot be cancelled from inside. Recover by hand:

1. Find the hung git by its command line, with `ps -eo pid,ppid,args`: it carries
   `--work-tree=<the task's worktree>` for a `git_mutate` step, the `git <slug>` verb's
   included, and `--work-tree=<the project root>` for a `git_root` step, the `git-root`
   verb's included: a `merge`'s hooks run at the root, and a `worktree add`'s
   post-checkout hook in the new worktree, each under that git.
2. End that process tree, the hook's children included, and check that it has exited.
3. Run `cross-agent tasks --reconcile`, then `cross-agent journal <slug>`, which says
   whether the step landed.

## The lead, in one paragraph

In the design, the lead is whichever session holds the lead tools and runs
the mode's loop, and the mode's `placement` decides which process that
session is. Under `placement: host` it is your own session: it loads the loop
and is busy between `wait` calls. Under `placement: engine` a spawned engine
runs the loop, your session stays free to check status, watch it, answer its
questions through a mailbox, and cancel it, and the run survives closing your
session. Both are built: `dev-team` and `solo` place the loop in your host
session, and `dev-team-engine` in a Claude or Codex lead it launches, which asks
you questions through `list_asks`/`answer` or `cross-agent answer`.
Either way the design derives a server's authority from process ancestry
rather than from depth or a token: the server walks its own parent chain for
the engine that spawned it, matches that against the ledger, and serves the
operator, lead, or specialist row of the permission matrix accordingly,
failing closed to specialist. Depth only caps that row, never raises it, and
no token could grant it — the launch spec holding a child's environment sits
in the project, where every role can read it, so possession must not equal
authority. This is built: `src/authority.ts` walks the ancestry and resolves
the row, and `src/server.ts` offers each tool to the rows it belongs to and
refuses a call from any other by name.

## Loop guard, in one paragraph

The design's guarantee is that no delegation loop can form through
`delegate`. The ancestry walk resolves a specialist to the specialist row of
the permission matrix and it gets exactly that row — the four read tools plus
`describe_mode`, never `delegate` — with a call to any other tool refused at
`tools/call` by name and told why; and its own direct launches of `claude`,
`codex`, `grok`, this server, or the CLI are denied at the Claude and Grok
permission layers, while a Codex child cannot reach a model API at all
because its sandbox denies the network. All of it is built: the server
resolves the row by ancestry on every request and offers exactly that row;
`delegate` refuses a role its caller's lineage already holds in the same
workspace, a duplicate of a delegation still running or finished within the
window, and a resume that would change the task, and it hands every child its
depth and lineage; and each engine's adapter puts the deny list and the
exclusion flag its engine takes onto every spawn line it builds. A specialist
that defeats its own CLI's permission rules is outside the guarantee.
