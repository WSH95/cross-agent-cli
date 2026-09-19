# The dev-team loop, engine-placed

Step 9 writes this loop in full, and step 11 builds the root tools it needs.
It is the `dev-team` loop with one difference that changes every git step: the
lead is a spawned Claude or Codex session, read-only at the project root, so it
creates worktrees, merges on the default branch, runs the tests there, removes
worktrees and deletes branches through `git_root` and `run_command` rather than
with its own tools, under the same lock and the same journal as `git_mutate`.
The lead asks its operator questions through `ask` and reads the answers through
the same mailbox, and its closing report is the task's final message, which
`cross-agent report` renders into the log the host would otherwise have written.
The order of the git steps, and the repair path when the suite fails after a
merge, are design section 4.
