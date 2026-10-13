# Setup skill: interactive project setup inside the plugin

Bead `atc-s96.134`. Approved section by section with the user on 2026-10-13.

## Goal

A user who has installed the cross-agent plugin sets a project up, and later changes that
setup, without typing a CLI command and without knowing the tool beforehand. A skill in the
plugin guides them, interactively and briefly, and nothing is written until they confirm.

Success means three things. A first-time user in Claude Code, Codex or Grok Build ends with a
valid `.cross-agent/config.json` whose team uses only engines they have installed, and whose
test command fits their project. The `.gitignore` change is committed, or they know they
must commit it. A later change ("use Claude for the plan reviewer", "tests run with
`pytest`") goes through the same skill.

## Decisions

| Decision | Choice |
|---|---|
| Scope | First setup **and** later changes, in one skill |
| Engines | Detect which of `claude`, `codex`, `grok` are installed and propose a team using only those |
| `.gitignore` | Offer to commit the change; on no, explain that the team cannot start until it is committed |
| Reconnect | Guide it per host; the server keeps reading its mode at startup (no live reload) |
| Mechanism | Approach A: a new skill drives the conversation; the plugin's bundled CLI detects, proposes, validates and writes |
| `AGENTS.md` | Layout lines for the new files only (user-approved) |

Approaches B (the skill alone, with the agent writing the config itself) and C (new MCP
tools) were rejected. B leaves the config unchecked until the server next loads it, and its
behaviour would differ from agent to agent. C needs the server attached before setup, and it
widens the server's permission matrix.

## 1. What the user experiences

### Per host

| | Claude Code | Codex | Grok Build |
|---|---|---|---|
| Start setup | `/cross-agent:setup`, or say "set up cross-agent" | type `$` and pick the setup skill, or say it in words | `/setup` (`/cross-agent:setup` when the name clashes), or say it in words |
| How questions are asked | its multiple-choice tool (`AskUserQuestion`) | numbered choices in chat; the user replies with a number or words | its multiple-choice tool (`ask_user_question`) |
| Reconnect after a mode change | run `/mcp`, choose cross-agent, Reconnect | restart MCP servers, or open a new chat | open a new session |

Codex 0.162.1's question tool is off in its default mode (feature
`default_mode_request_user_input`: under development, false), which is why Codex gets
numbered choices. The Codex `$` picker and its reconnect wording come from Codex's binary
and its features list. The operator confirms them live (section 3).

A question's options never carry a long preview: the user's terminal truncates one. Content
the user must read goes in the message itself, and options stay short.

### First setup (no config)

One short message per step:

1. **What this is**, in two sentences: cross-agent lets this chat hand work to other AI
   coding agents (Claude, Codex, Grok) and review their results. Setup writes one settings
   file, `.cross-agent/config.json`, and adds two lines to `.gitignore`; nothing else.
2. **What it found:** which engines are installed, the default branch, and the test and
   setup commands, each with where it came from, or "not found".
3. **How to work**, one question with three choices:
   - **Team** (`dev-team`, recommended): plans, codes on a separate branch, reviews with
     several models, and merges, all run from this chat.
   - **Background team** (`dev-team-engine`): the same team, run by a lead agent; you
     answer its questions.
   - **One-off help** (`solo`): ask another agent to do or check one thing.

   A choice the found engines cannot support is not offered, and the reason is stated.
4. **The proposal**, a compact table:
   - one row per role (one per seat for the code reviewer): what it does in a few words,
     and its engine, model and effort;
   - then the project settings: branch, test command, setup command, and merge policy
     ("auto: merge when tests and reviews pass", or "manual: you merge").

   Every substitution is listed ("plan reviewer: Codex not found, using Claude"). Then:
   *Looks right* / *Change something*. A change is described in plain words; the skill
   applies it, shows the updated table, and asks again.
5. **Write.** It confirms the file written and shows the `.gitignore` lines added, then
   asks *"Commit this .gitignore change now?"* On yes, it commits only `.gitignore`. On no,
   it says the team cannot start its first task until that change is committed.
6. **Reconnect**, only when the mode changed, with the host's step from the table above.
   It then checks the connection (`describe_mode`, `list_roles`), and ends with one example
   of what to ask next ("Use the team to …"). In Codex, if the check finds no cross-agent
   tools, it hands off to the plugin's existing one-time Codex connection setup
   (`skills/cross-agent/references/codex-setup.md`).

### Later changes (a config exists)

The skill shows the current setup as the same table and asks what to change. It shows each
change as before → after and asks for confirmation before writing. A reconnect is needed
only when the mode changed. Engines, models and commands take effect at once, because
`delegate`, `list_roles` and `run_command` read the config on every call and the server
refuses only a mode it is not serving.

### Refusals

Each refusal is said in plain words, with the next step:
- the folder is not a git repository;
- the folder is inside a task's worktree;
- `.cross-agent/` is committed to the repository, which blocks every git step;
- no engine is installed (with where to get Claude Code, Codex or Grok).

## 2. What the plugin's CLI does

The skill runs the plugin's own copy of the CLI, `node "<skill-dir>/../../bin/cross-agent"
…`, as the Codex setup guide already does, so nothing depends on the user's `PATH`. `init`
gains options rather than a new verb, so one code path still writes the config.

### `init --propose --json`: look and propose; writes nothing

It returns one JSON document:

- **`root`**, or a plain-words **refusal** when the folder cannot be a project. The checks
  are the ones `init` already makes: no git repository, a task worktree, an unsupported
  layout.
- **`engines`**: for `claude`, `codex` and `grok`, whether each is found, and its path. The
  lookup is the one the server uses when it starts an engine: an existing config's
  `engines.<e>.bin`, else the name on `PATH`.
- **`project`**: each fact with `from` (where it was found) or not found:
  - **default branch:** the remote's default (`origin/HEAD`), else the current branch,
    else `main`;
  - **test command:** `package.json` with `scripts.test` → `npm test`; a `Makefile` with a
    `test:` target → `make test`; `pyproject.toml` or `pytest.ini` → `pytest`;
    `Cargo.toml` → `cargo test`; `go.mod` → `go test ./...`; otherwise not found, and the
    proposal uses `none`;
  - **setup command:** from a lockfile: `package-lock.json` → `npm ci`, `pnpm-lock.yaml`
    → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`,
    `uv.lock` → `uv sync`, `poetry.lock` → `poetry install`, `Cargo.lock` → none needed;
    otherwise `none`;
  - **merge policy:** `auto`.
- **`existing`**: the current config and the SHA-256 of its bytes, or none. Also, whether
  `.gitignore` already has the entries, and whether `.cross-agent/` is tracked (blocking).
- **`proposals`**: for each of `dev-team`, `dev-team-engine` and `solo`:
  - `available`, or `unavailable` with a reason;
  - the full config document;
  - `substitutions`: each role whose default engine was not found, and what replaced it.

#### The team rule

1. A role keeps its built-in binding (`init`'s defaults) when that engine is found.
2. Otherwise it takes the first found engine able to do the role, with that engine's
   default model and effort for the role:
   - roles that write (implementer, resolver) and the engine-placed lead: Claude, then
     Codex;
   - the consultant: Claude, then Codex, then Grok, whose `worktree: true` one-shots
     cannot write (rule 4);
   - read-only roles (planner, plan reviewer): Claude, Codex, then Grok.
3. Code reviewer seats: the built-in seats whose engine is found, in their order, at least
   one. With only one engine found, there is one seat.
4. Without Claude or Codex, `dev-team` and `dev-team-engine` are unavailable ("the team
   needs Claude or Codex to write code"). `solo` binds its consultant to a found engine;
   with only Grok, its one-shots stay read-only, and the proposal says so.

Each engine's default model and effort for substitutions sits next to the built-in
bindings in the code. These are Claude `claude-opus-5-5` `xhigh`; Codex `gpt-6-astra`
`xhigh` (`max` for the resolver); and Grok `grok-4.7` `xhigh`.

### `init --config - --json`: write the confirmed setup

- It reads the confirmed config document on standard input and checks all of it before
  writing anything:
  - the checks the server applies when it loads a config, against its mode;
  - each role's engine has a sandbox profile for what the role needs (Grok has
    `read-only` only);
  - the engine-placed lead is not Grok.

  A failure names the field and the rule, and nothing is written.
- With no config, it creates one exclusively, as `init` does today.
- With a config, it refuses unless given `--replace --expect <hash>` with the hash
  `--propose` returned. A file changed since, for example edited by hand, is never silently
  overwritten. The replacement is written whole, then renamed into place.
- It adds the `.gitignore` entries, as `init` does today.
- It returns:
  - the file written;
  - the `.gitignore` lines added;
  - `reconnect`: true when the new mode differs from the mode the server serves, which is
    the old config's mode, or `solo` when there was no config.

`init --mode <name>` keeps working exactly as now for terminal users.

### The `.gitignore` commit

After the user says yes, the skill runs, at the project root:

```
git commit -m "chore: ignore cross-agent's state" -- .gitignore
```

This commits only `.gitignore`, even if other changes are staged. If the commit fails (for
example, a sandbox blocks writing `.git`), the skill shows the reason and the exact command
for the user.

## 3. Files, tests, verification

### Files

| File | Change |
|---|---|
| `skills/setup/SKILL.md` | New. Frontmatter: `name: setup`, `user-invocable: true`, and a description carrying the triggers ("set up cross-agent", "configure the team", "change a role's model or engine", "change the test command"). It holds the flow (section 1), the CLI calls (section 2), the per-host notes, and a one-line meaning for each mode and role. Concise; it assumes no prior knowledge. |
| `src/setup.ts` | New, one concern: project detection (engines, branch, test and setup commands) and the team rule, producing `--propose`'s document. |
| `src/config.ts` | `initConfig` writes a given document; it replaces only with the expected hash; the write-time checks; each engine's default model and effort. |
| `src/cli.ts` | `init --propose`, `--config -`, `--replace`, `--expect`, with `--help` text. |
| `skills/cross-agent/SKILL.md`, `skills/cross-agent/references/codex-setup.md` | Send "no config / set up a team" to the setup skill instead of telling anyone to run `init`. |
| `README.md`, `docs/install.md` | After installing, run setup in the host; no terminal step. |
| `docs/design.md` | `init`'s new options, and the plugin now ships two skills (it says one today). |
| `AGENTS.md` | Layout lines for the new files only (user-approved). |
| `tests/setup.test.ts` | New. |
| `tests/cli.test.ts`, `tests/skills.test.ts`, `tests/packaging.test.ts`, `tests/dist.test.ts` | Extended. |

### Tests (written first, each seen red)

- **Detection:** each project type, and none. The branch: remote default, current branch,
  empty repository. Engines on a fake `PATH`, and a configured `bin`.
- **The team rule:** all three engines; Claude only; Codex only; Claude and Grok; Codex
  and Grok; Grok only (no team, with the reason). A lead and a writing role are never
  Grok. Every available proposal passes the server's own config check
  (`loadConfigWithMode`).
- **CLI:**
  - `--propose` writes nothing (the repository and `.cross-agent/` are byte-identical
    afterwards);
  - `--config` writes a valid config and adds the `.gitignore` entries;
  - it refuses an invalid one, naming the field: a Grok implementer, a Grok lead, an
    unknown role, a bad merge policy;
  - it never overwrites without `--replace` and the matching `--expect`;
  - `reconnect` is right for first setup and for a mode change versus a binding change.
- **Skill text:**
  - frontmatter `name: setup` and `user-invocable: true`;
  - it calls only CLI options that exist;
  - it names each host's question tool and reconnect step;
  - it never tells the user to type a CLI command;
  - it asks before writing and before the commit;
  - it never offers an option whose content does not appear in the message;
  - the launcher routes setup to it.
- **Packaging:** both plugin payloads ship `skills/setup/`.

### Verification after the gate (operator)

- **Scratch repositories:** Node, Python and none, with all engines and with Claude only.
  `--propose` and `--config` give the expected proposal and a config the server loads.
- **Discovery, per host:** Claude Code lists `cross-agent:setup`; Grok lists `/setup`;
  Codex offers the skill. Codex's `$` picker and reconnect wording are confirmed live.
- **One end-to-end run in Claude Code:** setup in a scratch repository, the reconnect,
  `describe_mode`.

### Delivery

Users get the skill with the next release, 0.1.4. Implementation goes through the
repository's `dev-team` loop, which plans it from this spec, and may split it in two tasks:
the CLI (`src/setup.ts`, `src/config.ts`, `src/cli.ts` and their tests), then the skill,
docs and packaging.

## Out of scope

- Reloading the mode in a running server (the user chose a guided reconnect).
- Role prompts under `modes/` (`atc-s96.117`).
- Detecting engine versions, logins or model availability. Setup checks that an engine is
  installed, not that it is signed in. The first delegation surfaces a login problem, as
  it does today.
