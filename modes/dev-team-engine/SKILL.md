# The dev-team loop, engine-placed

The loop is the `dev-team` one, step for step: the same four specialists, the
same worktree per task, the same order of git steps, the same journal. What
changes is who runs it. `lead.placement` is `engine`, so the loop runs in a
spawned Claude or Codex session — never Grok, which has no per-run isolation of
any kind — and that lead is read-only at the project root.

That is why every root step of the loop already goes through `git_root` and
`run_command`: one whitelisted verb or one selector at a time, under the same
locks and into the same journal as `git_mutate`. Under this placement they are
the lead's only reach at the root; under `host` they are what keeps the journal
one document rather than two. Nothing else in the ten steps differs, and a
worktree's git metadata is still written only by `git_mutate` and never by the
specialist working there.

Two rules bound the lead itself. It delegates specialists and never another
lead, and it waits on, resumes and cancels only tasks of its own lineage — the
ones it delegated and their descendants. A decision that is the operator's to
make is asked, never taken.

S11 extends this section: the mailbox that question travels through (`ask`,
`list_asks`, `answer`), the mount that carries this text into the lead's own
instruction file, exclusive reattach by task id, and the cascade that cancels a
lead together with its children. Until it lands nothing mounts an engine lead,
so a project on this mode is run from the host session exactly as `dev-team` is.
Either way the lead's closing report is its task's final message rather than a
line it appends: it cannot write `.cross-agent/log.md` from a read-only root,
and `cross-agent report` renders that log from the ledger instead.
