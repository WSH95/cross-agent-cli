---
name: setup
description: Use when the user asks, about cross-agent, to set up cross-agent, configure the team, change a role's model or engine, change the test command or the setup command, change the mode or the merge policy, or wants a cross-agent team in a project with no `.cross-agent/config.json`. Guides a first setup or a change in a few short questions; nothing is written until the user confirms.
user-invocable: true
---

# Setting up cross-agent

You run every command; the user only answers. Send one short message per step.
`<skill-dir>` is this file's folder. The CLI is `"<skill-dir>/../../bin/cross-agent"`, run
directly from the project root.

## Asking

- What the user must read goes in the message.
- An option is a content-free answer, or a short label for something the message just
  showed: never a preview, a table or a config.
- Ask with the host's question tool (`## Hosts`).
- Every question below is written `Ask: "<question>" — options: *A* / *B*`.

## Hosts

| | Claude Code | Codex | Grok |
|---|---|---|---|
| Start | `/cross-agent:setup` | `$`, then the setup skill | `/setup`, or `/cross-agent:setup` |
| Ask | `AskUserQuestion` | numbered choices in chat (its question tool is off by default), answered with a number or in words | `ask_user_question` |
| Reconnect | `/mcp`, choose cross-agent, Reconnect | restart MCP servers, or open a new chat | open a new session |
| Approval to run one command outside the sandbox | rerun it with the Bash tool's sandbox off, which asks the user | ask for escalated permissions for that command: its sandbox keeps `.git` read-only | use the approval Grok offers |

On any host the user can also ask for setup in words.

## Roles

The meaning each role shows in a table:

- `lead`: runs the background team's loop and asks you its questions.
- `planner`: reads the project and writes the plan.
- `plan-reviewer`: checks the plan before any code is written.
- `implementer`: writes the change on its own branch.
- `code-reviewer`: one seat per reviewer; every seat must pass before a merge.
- `resolver`: takes the findings two fix rounds leave standing.
- `consult`: answers one-off questions and reviews.

## First setup

1. **What this is.** Say, in two sentences: cross-agent lets this chat hand work to other
   AI coding agents (Claude, Codex, Grok) and review their results. Setup writes one
   settings file, `.cross-agent/config.json`, and adds two lines to `.gitignore` and to
   git's local exclude file.
2. **Look.** Run `"<skill-dir>/../../bin/cross-agent" init --propose --json`, then route in
   this order:
   - `ok:false` → `## Refusals`;
   - `existing.tracked` → `## Refusals`;
   - `existing.fault` set → `## A config the server refuses`;
   - a valid `existing.config` → `## Later changes`;
   - every proposal unavailable → `## Refusals`.

   Otherwise, say what was found: each engine (found at its `path`, or not found), and
   each `project` fact with its `from`, or "not found".
3. **Choose.** Say what each available mode means:
   - **Team** (`dev-team`, recommended): plans, codes on a separate branch, reviews with several models, and merges, all run from this chat.
   - **Background team** (`dev-team-engine`): the same team, run by a lead agent; you answer its questions.
   - **One-off help** (`solo`): ask another agent to do or check one thing.

   Name each unavailable mode with its `reason`. Then ask, offering only the available
   modes:

   Ask: "How should cross-agent work here?" — options: *Team (dev-team, recommended)* / *Background team (dev-team-engine)* / *One-off help (solo)*
4. **The proposal.**
   - Show a table from the chosen proposal's `document`: one row per role (one per seat
     for `code-reviewer`), with its meaning, engine, model and effort. Then the branch,
     test command, setup command and merge policy: "auto: merge when tests and reviews
     pass" or "manual: you merge".
   - List the substitutions in plain words:
     - a single role: "plan reviewer: Codex not found, using Claude" when
       `engines.<from>.found` is false; "implementer: Grok replaced by Claude, since Grok
       does not write while Claude or Codex is installed" when it is true; "unbound, using
       Claude" when `from` is null;
     - a seat with `to` null: "drops the <From> seat (not found)";
     - a seat with `from` null: "adds a <To> seat";
     - then the seats the document holds. Never show a substitution's seat number.
   - Show `notes` verbatim, and `copiedFrom` as "starts from the main checkout's team
     (<file>)".

   Ask: "Does this look right?" — options: *Looks right* / *Change something*

   On *Change something*, ask in plain words what to change, apply it through
   `## Applying a change`, then show the table again and ask again.
5. **Write,** only after *Looks right*:

   ```
   "<skill-dir>/../../bin/cross-agent" init --config - --json <<'CROSS_AGENT_CONFIG'
   <the confirmed document>
   CROSS_AGENT_CONFIG
   ```

   Then `## After a write`.

## Applying a change

- **New engine.** A role moved to another engine takes the model and effort another role
  on that engine has in the table. If none has, leave them out, so the engine uses its own
  default, and say so.
- **Grok.** An `implementer` or `resolver` moved to Grok gets `"sandbox": "workspace"` and
  the note that Grok's sandbox cannot protect the repository's git files, so cross-agent
  checks them after each step instead; a role moved off Grok drops its `sandbox`, shown
  before → after. The `lead` is never Grok.
- **Other changes.** Seats can be added or removed. The test and setup commands are
  strings. The merge policy is `auto` or `manual`.
- **New mode.** Use the new mode's proposal only when it is `available`; otherwise show its
  `reason` and follow `## Refusals`. Take its `mode` and `roles`. Keep the current
  `project`, `limits`, `review`, `billing` and `engines`. One exception: when the current
  `limits.maxDepth` (1 when the config sets none) is below the proposal's, raise it to the
  proposal's value. Show the raise as its own before → after line: "depth limit 1 → 2: the
  background team's lead cannot start below 2". Never lower `maxDepth`.

## Later changes

- Show the current setup from `existing.config` as the same table.
- A role the mode declares but the config leaves unbound shows as unbound. Offer the
  proposal's binding for it as a change when that proposal is `available`.
- Ask in plain words what to change, apply it through `## Applying a change`, and show
  each change as before → after. Then:

  Ask: "Write this change?" — options: *Write it* / *Change something else* / *Cancel*

  *Change something else* asks again; *Cancel* stops without writing.
- Write as in First setup step 5, adding `--replace --expect <existing.sha256>`. Then
  `## After a write`.

## A config the server refuses

`existing.fault` is set, and `existing.config` is null when the file is not JSON.

- Say the `fault` in plain words. There is no current table to show.
- With no proposal `available`, follow `## Refusals`. Otherwise offer a replacement
  through First setup steps 3 and 4, with the table titled "replaces the config the server
  refuses" and this question in place of step 4's:

  Ask: "Replace the refused config with this?" — options: *Replace it* / *Change something* / *Cancel*

  *Change something* goes as in step 4; *Cancel* stops without writing.
- Write as in First setup step 5, adding `--replace --expect <existing.sha256>`. The old
  file is kept as `config.json.prev`. Then `## After a write`.

## After a write

Every write ends here once it exits 0. A write that exits otherwise follows `## Refusals` or
`## When a step fails`, never this section.

1. Report `file`, and `previous` for a replacement. Show any `warning`.
2. When `ignored` is not empty, show everything the commit will hold: in `root`, run
   `git diff HEAD -- .gitignore`. When it fails because there is no commit yet, the commit
   holds the whole file, so show that. When it prints nothing, run
   `git ls-files -- .gitignore`: nothing printed means git does not track `.gitignore` yet,
   so show the whole file; the file's name means it already matches the last commit: say
   there is nothing to commit, so nothing blocks the team, and go to step 3. Mark the
   `ignored` lines as setup's; if anything else is there, say plainly that the commit holds
   it too. Then:

   Ask: "Commit this .gitignore change now?" — options: *Yes, commit it* / *No*

   On yes, in `root`, run `git add -- .gitignore`, then
   `git commit -m "chore: ignore cross-agent's state" -- .gitignore`. On no, say the team
   cannot start its first task until that change is committed.
3. When this setup ran `git init` in a folder that already held files, and the mode is
   `dev-team` or `dev-team-engine`, say plainly that a team task starts only from committed
   files, so the files already here need a first commit before the first team task, and
   that you can make it for them if they ask.
4. Go to `## Connection check` after a first setup, after replacing a refused config, or
   when `reconnect` is true. Otherwise say the change takes effect at once.

## When a step fails

- **Permission failure.** A failure naming a path under `.git` with `EROFS`, `EACCES`,
  `EPERM`, "Read-only file system" or "Permission denied" may be the host's sandbox, or the
  folder's own permissions.
  1. Say which steps completed.
  2. Run only the failed command once more, with the host's approval to run it outside
     its sandbox (`## Hosts`).
  3. That one retry is all. Stop if it fails too, if the host offers no approval, or if
     the user declines.
  4. A later command that writes `.git` needs the same approval.
- **Any other failure: stop, no retry.** This covers a `config-lock-failed` from a lock
  folder that cannot be made, a lock that could not be taken or was lost, and a git step
  refused by a hook, a missing identity or anything else.
- **Every stop** shows the reason, the failed command and what is done. Be accurate:
  - a refused `--config` did not write the config, though git's `info/exclude` may have
    gained cross-agent's two entries;
  - after a written config and a failed add or commit, the config is written and
    `.gitignore` is changed but not committed, and the team cannot start until it is.

## Refusals

A refusal is an exit 3 with a `code`. Say each in plain words, with its next step:

- `not-a-git-repository`: say in one line that cross-agent needs git for its branches and
  merges, then:

  Ask: "Make this folder a git repository now?" — options: *Yes* / *No*

  On yes, run `git init` and look again; on no, stop.
- `not-the-repository-root`: offer to set up in the top folder the reason names; on yes,
  add `--project <toplevel>` to every CLI call and run git there.
- `task-worktree`, `inside-a-task`: this folder or session belongs to a task; say so and
  stop.
- `unsupported`, `no-such-directory`: say the reason and stop.
- `detached-head`, `branch-name`: the branch rule below.
- `invalid-config`: fix the field it names and ask again.
- `config-exists`, `config-changed`: look again, show what is there now, and ask again.
- `config-busy`: try once more, then report.
- `config-lock-failed`: `## When a step fails`.
- Exit 1 or 2: show the error and stop.
- **A tracked `.cross-agent/`** (`trackedReason`): every git step of the team refuses until
  it is removed from git's index and that removal is committed. Say so and stop before
  writing.
- **No engine found:** install one, sign in, and ask again. Claude Code:
  https://claude.com/claude-code. Codex: https://github.com/openai/codex. Grok Build:
  https://x.ai/cli.
- **Every proposal unavailable, or the one a change needs, while engines were found:** show
  each `reason`, and the branch rule when a reason names the branch.
- **The branch rule:** a default branch whose name starts with a letter or digit, uses
  only letters, digits, `.`, `_`, `/` and `-`, has no `..`, does not end in `/` or
  `.lock`, and does not match `task/*`. A branch worktree's default branch is its own
  checked-out branch.

## Connection check

- **When:** after every first setup, whatever `reconnect` says, because a Codex server
  bound by `CROSS_AGENT_PROJECT` starts only once a config exists. Also after any
  reconnect.
- **Reconnect first** when `reconnect` is true, or when this setup ran `git init`: give the
  host's reconnect step and wait for the user.
- **Check:** call `describe_mode` and `list_roles`. It is connected when both answer
  without error, `projectRoot` is `root`, the mode is the one written, and `list_roles`
  has no `warning`. A `warning` means the server still serves its old mode: give the
  reconnect step and check again.
- **Another project or mode** answering with no `warning`: say in plain words which
  `projectRoot` and mode answered, and that the connection is not verified. Under Codex,
  offer the hand-off below.
- **New session needed** (Grok, or Codex without a restart): the check cannot finish here.
  Say the connection is not yet verified, and give the request to start the new session
  with; the launcher checks the connection first there.
- **Missing tools:**
  - under Grok, search `search_tool` for `cross-agent` first;
  - under Codex, offer the hand-off below;
  - under Claude Code, the server did not start, and `/mcp` shows why.
- **The Codex hand-off:**

  Ask: "Connect cross-agent to Codex now?" — options: *Yes* / *Not now*

  On yes, follow `<skill-dir>/../cross-agent/references/codex-setup.md`. *Not now* leaves
  the connection not verified.
- **End**, once connected, with one example request: *"Use the cross-agent dev team to …"*,
  or *"Use cross-agent to have Codex review …"* for `solo`.
