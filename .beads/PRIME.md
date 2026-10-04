# Beads workflow for cross-agent-cli

## Git policy

The user authorizes automatic local commits after successful validation. This is
the project's standing policy; do not ask again for permission to make those commits.

- Review the diff, stage only the completed task's changes, and make a Conventional
  Commit after its relevant checks pass. Include its Project Steward updates.
- Keep separate task fixes in separate commits. Preserve unrelated or unfinished work.
- Never push, force-push, rewrite published history, or run Dolt remote sync without
  explicit user approval. Local commit authority does not authorize a push.
- A missing Git remote affects remote operations, not permission to make local commits.
- Explicit current instructions and higher-priority restrictions take precedence.

## Resume and persistent memory

Read `.project-steward/HANDOFF.md` and run `bd prime --export --memories-only` when
starting or resuming. `--export` bypasses this override so `--memories-only` loads
current Beads memories without freezing a copy here.

Use `bd` for all durable task tracking. Do not use TodoWrite, TaskCreate, or Markdown
task lists. Use `bd remember` for persistent knowledge; do not create MEMORY.md files.

## Work and completion

1. Inspect the issue with `bd show <id>` and claim it with `bd update <id> --claim`.
   Create an issue before starting untracked work; use `bd ready` to find ready work.
2. Implement the agreed scope and run the relevant quality gates. This project's
   test command is `npm test`; document the actual validation results.
3. Record results in Beads and Project Steward, and close completed issues with
   `bd close <id> --reason="..."`.
4. Make the authorized local commit, verify its contents and remaining worktree
   changes, and report its hash. Do not push without explicit approval.
5. If a command is blocked, report the exact restriction and what remains pending.

Use `bd update` flags rather than `bd edit`, which opens an interactive editor.
Use `bd <command> --help` for the full command reference.
