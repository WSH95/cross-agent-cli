# The solo loop

One role, one turn, no ceremony. `solo` is also the mode a project with no
`.cross-agent/config.json` runs as, so this loop works with nothing bound: every
`delegate` names its own `engine` — `claude`, `codex` or `grok` — and may name
`model` and `effort` beside it. `cross-agent init --mode solo` writes the
binding once if you would rather not repeat it.

## A question

`delegate {role: "consult", cwd: <project root>, engine: <engine>, brief: <the
brief>}`, `wait` on the task id it returns, then read `result`. The consultant is
read-only at the root: it answers, it cites what it read by path and symbol, and
its final message is the whole of the answer. Nothing is branched, nothing is
merged, and no worktree exists.

Two briefs are worth composing rather than improvising. They are verbs of this
loop, not tools of the server — each is one `delegate` that names its own engine,
because a second engine reading your work is the point of asking:

- **review** — attach the diff under review, `git diff <base>...HEAD` for
  committed work or the working tree for uncommitted, and ask for findings by
  severity, each with `file:line` and what to do about it.
- **critique** — name the plan or design file and ask for the adversarial
  reading: what it assumes without saying so, what it leaves undefined, where it
  would fail first, and what a reviewer would send back.

## A change

Add `worktree: true` to the same call. The server creates `task/<id>` at
`<worktreeDir>/<id>` through `git_root`, journaled, and runs the task there under
the engine's writable profile. The task id `delegate` returns is the `<id>` in
both and the `slug` every step below names; `describe_mode`'s `git` field gives
the `<worktreeDir>` and the branch pattern they were built from, with `implicit:
true` where those are this build's rather than this mode's own. The record keeps
the same three as `worktree: {path, branch, slug}`, and so does the task's
journal.

The specialist edits files and runs no git. Once its task settles:

1. Commit what it left: `git_mutate {slug, args: ["add", "-A", "--", ".",
   ":(exclude).cross-agent", ":(exclude).worktrees"]}`, then `git_mutate {slug,
   args: ["commit", "-m", <message>]}`. That is the only path that writes a
   worktree's git metadata, and it journals the `committed` step. The two
   exclusions are not optional: a `.gitignore` the specialist wrote in its
   worktree outranks the repository's own, and the project's state is never
   committed to a task branch — `git_root merge --ff-only` refuses a branch that
   carries either directory anyway, and that refusal costs you the run.
2. Then apply the project's `project.mergePolicy`. You apply it; nobody merges
   by hand under `auto`.

   **`auto`** — `run_command {which: "test", where: <worktree path>, slug}`;
   `git_root {args: ["merge", "--ff-only", "task/<id>"], slug}`; `run_command
   {which: "test", where: "root", slug}`; `git_root {args: ["worktree", "remove",
   <worktree path>], slug}`; `git_root {args: ["branch", "-d", "task/<id>"],
   slug}`; then the closing report.

   **`manual`, or any failure at any step of `auto`** — stop where you are, leave
   the branch and its worktree standing, and report the reason with the commands
   that finish it by hand. A suite that fails at the root after the merge is the
   repair path of design section 4 — `git revert --no-edit
   <defaultShaBeforeMerge>..<branchHead>` from the journal's `merged` step — and
   never a merge to retry.
