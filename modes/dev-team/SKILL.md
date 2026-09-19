# The dev-team loop

Step 9 of the work plan writes this loop in full; what is here says what it
will be, and `describe_mode` already serves it, so whatever lands in this file
is what a lead reads on every host. The loop is one task at a time: delegate
`planner` at the project root and `wait`; delegate `plan-reviewer` on the plan
and `wait`; create the worktree and its `task/<slug>` branch yourself, because
under `placement: host` your own session owns every root git operation;
delegate `implementer` into that worktree with the branch named, `wait`, and
commit its work with `git_mutate`, which is the only path that writes git
metadata for a worktree; delegate `code-reviewer` on the committed branch and
send a needs-work round back through `resume`; then merge on the default
branch, run the test command there, remove the worktree and delete the branch,
and append the task's closing line to `.cross-agent/log.md`. Every git step of
that order, and the repair path when the suite fails after a merge, is design
section 4; the journal each step writes is section 7.
