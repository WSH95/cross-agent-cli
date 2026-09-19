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
merged, and no worktree exists. Close with the launcher's own report line —
role, engine, model, effort, duration, outcome — and the consultant's answer
where it matters, in its own words.

## A change

Add `worktree: true` to the same call. The server creates `task/<id>` at
`<worktreeDir>/<id>` through `git_root`, journaled, and runs the task there under
the engine's writable profile. The task id `delegate` returns is the `<id>` in
both and the `slug` every later call names; `describe_mode`'s `git` field gives
the `<worktreeDir>` and the branch pattern they were built from, with `implicit:
true` where those are this build's rather than this mode's own. The record keeps
the same three as `worktree: {path, branch, slug}`, and so does the task's
journal.

The specialist edits files and runs no git, so when its task settles the work is
uncommitted and the branch is standing. The launcher takes it from there: its
merge-policy steps — the commit through `git_mutate`, then `project.mergePolicy`
— are written once and apply to a one-shot under every mode, this one included.
