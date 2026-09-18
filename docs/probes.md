# Engine probes

What each engine CLI was observed to do when spawned the way the adapters
will spawn it (design section 3). Every entry names the command (from
`tools/probe.mjs`), the date, and the outcome. Versions: Claude Code
2.1.263 for P1-P7 and 2.1.266 for P8-P10, Codex 0.153.4, Grok Build 1.0.13
(build 5e9a58528b76), Node 24.11.0, Ubuntu with
bubblewrap installed; `socat` was absent for P1's first run and installed on
2026-09-07 for its rerun, and the `bwrap` AppArmor profile is still pending.

A first round ran in a repository under `/tmp`; both the Codex and the Grok
sandboxes treat `/tmp` as writable, so those write checks proved nothing
and were rerun under `~/.cache/agent-team/probe-repo`. Rule for the
product: a project under `/tmp` or `$TMPDIR` is not isolated; `cross-agent
init` warns about it.

## P1: nested `claude -p` from inside a Claude Code session (2026-09-07)

`claude -p --output-format stream-json --verbose --permission-mode
bypassPermissions --strict-mcp-config --model sonnet --session-id <uuid>
--settings '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true}}'
--disallowedTools <deny list> Edit Write MultiEdit NotebookEdit`, prompt on
stdin, env scrubbed as in section 3, `CROSS_AGENT_DEPTH=1`.

- Runs and exits 0 in 10 s; the `CLAUDECODE` guard in the binary does not
  stop a nested `-p` run. The child's shell still shows `CLAUDECODE=1`
  because Claude Code sets it for its own Bash tool, not because the scrub
  failed. `CROSS_AGENT_DEPTH` and `CROSS_AGENT_LINEAGE` are visible. MCP tools:
  none (`--strict-mcp-config` with no config).
- The sandbox did not engage: "Sandbox disabled: sandbox is enabled but
  dependencies are missing: socat not installed … Commands will run WITHOUT
  sandboxing." Prerequisite for the Claude adapter: `bwrap` and `socat`.
  The adapter must treat that warning as a refusal to spawn (fail closed).
- Rerun after `socat` was installed (2026-09-07, 21:30Z): the sandbox
  engaged, and every command then failed at the sandbox's own setup with
  "apply-seccomp: write /proc/self/setgroups (nested userns is
  capability-restricted; caller must provide CAP_SYS_ADMIN): Permission
  denied", including a plain `curl`. Cause: Ubuntu 24.04 sets
  `kernel.apparmor_restrict_unprivileged_userns=1`; the stock
  `bwrap-userns-restrict` profile lets bubblewrap itself create a user
  namespace but confines its children, and Claude Code's helper needs a
  nested one. Claude Code's sandboxing docs prescribe an AppArmor profile
  for `/usr/bin/bwrap` with `flags=(unconfined)` and `userns`, then
  `systemctl reload apparmor`. So the Claude adapter's prerequisites on
  Linux are three: `bwrap`, `socat`, and on Ubuntu 24.04 or later that
  profile; the adapter's sandbox check must detect this failure mode too
  (a command that cannot even start), not only the "Sandbox disabled"
  warning. The P2 row for Claude stays open until the profile is in place.

## P2: implementer inside a linked worktree, writes outside it (2026-09-07)

Prompt: append to `notes.md`, run `npm test`, then try to append to
`../../ROOT-WRITE.txt`, `../../.git/cross-agent-probe-write.txt`,
`../other-WRITE.txt`, `$HOME/cross-agent-probe-HOME.txt`, and finally overwrite
the worktree's `.git` pointer file with `gitdir: /tmp/elsewhere`.

| Engine and command | in-worktree edit, tests | root file | root `.git` | sibling path | `$HOME` | `.git` pointer |
|---|---|---|---|---|---|---|
| Codex: `codex exec --json -o <out> -C <worktree> --sandbox workspace-write --ignore-user-config --skip-git-repo-check -m gpt-6-astra` | success | denied (read-only file system) | denied | denied | denied | denied (Codex protects the `.git` entry even inside the writable cwd) |
| Grok: `grok -p <prompt> --cwd <worktree> --sandbox workspace --permission-mode bypassPermissions --output-format json --session-id <uuid>` | success | denied (permission denied) | denied | denied | denied | **allowed** (the pointer was rewritten; restored by hand afterwards) |
| Claude | not run yet: with `socat` installed the sandbox still needs the `bwrap` AppArmor profile (see P1) | | | | | |

Consequence: the worktree pointer is writable by a Grok implementer, so
`verify_worktree` and the explicit `--git-dir`/`--work-tree` form (section
4) are necessary, not optional. Tampering is detected, not prevented.

## P3: the deny list (2026-09-07)

Targets: `claude`, `codex`, `grok`, `node <repo>/src/server.ts`,
`node <repo>/src/cli.ts`, `cross-agent`; the child is asked to run
`claude --version`, `codex --version`, `grok --version`,
`node <repo>/src/server.ts --help`, and `node --version` as a control.

- Claude, `--disallowedTools "Bash(claude *)" "Bash(claude)" …` with
  `--permission-mode bypassPermissions` and the sandbox off: all four
  targets denied ("Permission to use Bash with command `claude --version`
  has been denied"); `node --version` allowed. Deny rules hold under
  `bypassPermissions`.
- Grok, one `--deny "Bash(<target> *)"` per target with
  `--permission-mode bypassPermissions`: all four targets "blocked by
  policy"; control allowed.
- Codex, an execpolicy rules file (`prefix_rule(pattern=["claude"],
  decision="forbidden")` and the others; `codex execpolicy check --rules
  <file> claude --version` reports `forbidden`) installed as
  `<worktree>/.codex/rules/cross-agent.rules`: **not enforced** in `codex
  exec`, neither with `--ignore-user-config` nor with an added
  `-c 'projects."<worktree>".trust_level="trusted"'`. All three CLIs ran
  and printed their versions. Rules files are not a usable deny layer for
  Codex children. See P3b for what holds instead.

## P3b: network from a Codex workspace-write child (2026-09-07)

Same spawn line as P2 (Codex), in the worktree, no deny list. The child was
asked to run `curl -sS -m 15 https://api.anthropic.com/`, `claude -p "reply
with OK" --model sonnet --max-turns 1`, and `grok -p "reply with OK"
--max-turns 1`.

- `curl`: exit 6, "Could not resolve host: api.anthropic.com". The sandbox
  denies network access, DNS included.
- `grok -p`: exit 1, "Couldn't create session … Read-only file system":
  Grok cannot even write its session store from inside the Codex sandbox.
- `claude -p`: no output, still running when the Codex turn ended after
  123 s; it cannot reach its API. The runner kills the task's process
  group when the task settles, so such a hang does not outlive the task.

Consequence: a Codex specialist cannot complete a nested engine run, so the
network denial is Codex's "denied launches" layer (design section 5).

## P5: `codex exec --ignore-user-config` (2026-09-07)

`codex exec --json -o <out> -C <dir> --sandbox read-only
--ignore-user-config --skip-git-repo-check -m gpt-6-astra
-c model_reasoning_effort="low"` in a directory that is not a git
repository.

- Auth kept (the turn completed, 24 s), no trust prompt, the depth and
  lineage variables visible.
- The user's MCP servers from `~/.codex/config.toml` are gone; the only MCP
  server reported is Codex's built-in `codex_apps`.

## P7: lead-owned git with explicit dirs under `flock` (2026-09-07)

In a throwaway repository with a linked worktree `.worktrees/g` on
`task/g`, after an "implementer" edit of `notes.md`:

- From the root, `git -C <worktree> rev-parse --git-dir --git-common-dir
  --abbrev-ref HEAD` prints `<root>/.git/worktrees/g`, `<root>/.git`,
  `task/g`: the three checks of section 4 are cheap and exact.
- `flock -n <lock> git --git-dir=<root>/.git/worktrees/g --work-tree=<worktree>
  add -A` and `… commit` succeed; after `main` moves, `… rebase main`
  succeeds through the same explicit form.
- With the pointer rewritten to `gitdir: /tmp/elsewhere`, `git -C
  <worktree>` fails ("not a git repository") while the explicit form still
  resolves `task/g`.
- `git merge --ff-only task/g` from the root, `git merge-base --is-ancestor`,
  `git worktree remove`, and `git branch -d` complete the lifecycle.
- A second `flock -n` on the same lock file is refused while the first
  holder lives.

## P8: Grok `--output-format streaming-json` (2026-09-09)

`node tools/probe.mjs --engine grok --cwd <probe worktree> --sandbox read-only
--output-format streaming-json --prompt "Read the file package.json in your
working directory, then reply with the value of its \"name\" field and nothing
else."`, which spawns `grok -p <prompt> --cwd <worktree> --sandbox read-only
--permission-mode bypassPermissions --output-format streaming-json --session-id
<uuid>` plus one `--deny` per deny-list entry. The harness gained
`--output-format` for this run; the probe worktree was a fresh linked
worktree of `~/.cache/agent-team/probe-repo`, removed afterwards. The logs
this section and P9 and P10 quote are archived outside any repository at
`~/.cache/agent-team/probe-logs/p8-p9-p10-2026-09-09/`, under the file names
named below.

- One JSON object per line: 57 event lines, exit 0 in 11.7 s, nothing on
  stderr. The types in order were `available_commands` ×2, `thought` ×22,
  `available_commands`, `usage`, `tool_call`, `tool_call_update` ×2, `thought`
  ×22, `text` ×3, `available_commands`, `usage`, `end`.
- **The session id is on the last line only.** `end` carries `sessionId`; no
  earlier line carries one, and the first line is `available_commands` (the
  child's whole tool list). The id equals the `--session-id` uuid the harness
  passed, so an adapter that supplies the uuid knows it before the run and does
  not need to read it back — but it cannot emit a `session` event from the
  first native event, the way design section 3 describes.
- Activity lines: a tool call is one `tool_call` with `status:"pending"` and
  the tool's `rawInput`, then `tool_call_update` lines carrying its output and
  a terminal `status:"completed"`. The first update for a call can be empty —
  `"status":null,"content":[],"rawOutput":null`, with only `locations`
  filled — so an adapter must not read an update's `status` as a state. Text
  arrives as `{"type":"text","data":…}` token deltas and reasoning as
  `{"type":"thought","data":…}` deltas.
- **The final line carries no message text.** `end` has `stopReason`,
  `sessionId`, `requestId`, `usage`, `num_turns`, `total_cost_usd` and
  `modelUsage` — there is no `text` field, unlike `--output-format json`. A
  `finalMessage` for this format has to concatenate the `text` deltas and
  ignore the `thought` ones.
- Resume with the same format works: `-r b6388f11-…` and `--output-format
  streaming-json` returned the earlier answer from context, exit 0 in 8.7 s.
  The resumed run's first line is again `available_commands`, and its `end`
  line carries the **same** session id, so resume neither renames nor
  re-announces the session.
- Forced failure, `--model no-such-model`: **exit 1** in 5.4 s, one stdout line
  `{"type":"error","message":"Couldn't set model 'no-such-model': Invalid
  params: \"unknown model id\". Run 'grok models' to see available models."}`
  and the same sentence on stderr as `Error: …`. No `end` line, so an adapter
  must treat a missing `end` as failure rather than waiting for one.

`--output-format streaming-messages-json`, same prompt (exit 0, 11.8 s), is
NDJSON in the Anthropic Messages API wire format: five lines, opening with
`{"type":"system","subtype":"init"}` carrying `session_id`, `cwd`, `model`,
`permissionMode` and `tools`, then whole `assistant` and `user` (tool result)
messages rather than token deltas, and closing with
`{"type":"result","subtype":"success",…,"result":"probe-repo"}`. That is
line-for-line the shape Claude Code's `stream-json` emits (see the samples
below), and it honours `--session-id` as well.

Because the two runs above took the resume and failure paths in
`streaming-json`, both paths were then probed in the adopted format too, in a
second probe worktree (`.worktrees/p8b`, removed afterwards) whose opening
turn (exit 0, 51.8 s) created session
`8d718a3f-32eb-4254-b991-acf067cb13d0`.

- Resume, `-r 8d718a3f-… --output-format streaming-messages-json` (exit 0,
  16.9 s): three lines, and the **first** one re-announces the session under
  the key `session_id`, carrying the resumed session's id rather than a new
  one, where `streaming-json` announces nothing until its last line. The run
  still closes with
  `{"type":"result","subtype":"success",…,"result":"probe-repo"}`, so the
  final text sits in the same field on a resumed turn as on a fresh one.

```
{"type":"system","subtype":"init","session_id":"8d718a3f-32eb-4254-b991-acf067cb13d0","apiKeySource":"oauth","model":"grok-4.6","cwd":"…/.worktrees/p8b","permissionMode":"bypassPermissions","tools":["run_terminal_command","read_file","…"]}
```

- Forced failure, `--model no-such-model` in the same format (exit 1, 5.3 s):
  **the shape differs from `streaming-json`'s.** Two stdout lines rather than
  one — a `system/init` line first, carrying `session_id`,
  `"model":"no-such-model"` and an empty `tools` array, then a closing
  `result` line whose `subtype` is `error_during_execution`, whose `is_error`
  is `true`, and whose message is in an **`errors` array**; on a failed turn
  there is no `result` field at all. Stderr carries the same sentence as
  `Error: …`. So in this format a failure still ends in a `result` line,
  where `streaming-json` emits a bare `{"type":"error",…}` and never closes.

```
{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":0,"num_turns":0,"stop_reason":null,"total_cost_usd":0.0,"usage":{…},"modelUsage":{},"errors":["Couldn't set model 'no-such-model': Invalid params: \"unknown model id\". Run 'grok models' to see available models."],"session_id":"221ec7b9-eb81-4ea7-a55f-80c85e2fc994"}
```

Three real lines from the `streaming-json` run, shortened:

```
{"type":"available_commands","tools":["run_terminal_command","read_file","search_replace","list_dir","grep","kill_command_or_subagent","todo_write","get_command_or_subagent_output","spawn_subagent","scheduler_create","…"]}
{"type":"tool_call","toolCallId":"call-1adf9901-7d80-4a6b-a4b8-b924a34403cf-0","title":"read_file","kind":"read","status":"pending","toolName":"read_file","rawInput":{"target_file":"package.json","limit":50},"content":[],"locations":[]}
{"type":"end","stopReason":"end_turn","sessionId":"b6388f11-4276-4036-8988-8aea5a48ddac","requestId":"13be70e7-9fce-46fd-a102-ec0de99aad61","usage":{"input_tokens":18967,"cache_read_input_tokens":19072,"output_tokens":75,"reasoning_tokens":65,"total_tokens":38114},"num_turns":2,"total_cost_usd":0.0081464,"modelUsage":{"grok-4.6-build":{…}}}
```

Adopted format for T9: **`--output-format streaming-messages-json`**, because
it carries the session id on its first line — on a resumed turn too — and the
final message in its last line's `result`, in the line shapes the Claude
adapter will parse (the fake engine's `claude` format), and because even a
failed run closes with a parseable `result` line (`is_error`, `errors`)
instead of stopping at a bare `error` line, so one settle path serves success
and failure. `streaming-json` carries the session id only in its last line,
has no final-message field at all, and emits no closing line on failure; it
stays the fallback, and both formats fix the `json` mode's silence that would
leave `lastEventAt` null for a whole run. A `finalMessage` for the adopted
format reads `result` when `is_error` is false and `errors` when it is true.

## P9: per-engine lead mount and instruction delivery (2026-09-09)

Each engine was spawned in the same fresh probe worktree with the current
`src/server.ts` (`list_roles`, `verify_worktree`) as its only intended MCP
server, a role file whose one instruction is "Begin every reply with the word
ROLE-OK, on its own line, before anything else", and this prompt: list every
MCP tool available, verbatim, then call `list_roles` and paste the result. The
worktree held the default `.cross-agent/config.json` (four roles), so a
`list_roles` result that names planner, plan-reviewer, implementer and
code-reviewer also proves the server resolved **the child's** project root.
Claude ran with `--sandbox off` (P1: the `bwrap` AppArmor profile is still
pending), Codex and Grok with their read-only profiles.

| Engine | mount mechanism | child's MCP tools | user's own servers visible? | instruction delivery | instruction honoured? |
|---|---|---|---|---|---|
| Claude | `--strict-mcp-config --mcp-config <file>` | `mcp__cross-agent__list_roles`, `mcp__cross-agent__verify_worktree`; init line reports `mcp_servers: [{"name":"cross-agent","status":"connected"}]` | no — exactly one server | `--append-system-prompt-file <role.md>` | yes, every assistant message begins `ROLE-OK` |
| Claude, control | `--strict-mcp-config`, no config (today's specialist spawn) | none; `mcp_servers: []` | no | `--append-system-prompt-file` | yes |
| Claude, inheritance | `--mcp-config <file>` with `--strict-mcp-config` **omitted** | the file's server **plus** five of the user's own | yes: `plugin:context7:context7`, `claude-design`, and three `claude.ai` connectors `needs-auth` | `--append-system-prompt-file` | yes |
| Codex | `--ignore-user-config -c mcp_servers.cross-agent.command="node" -c mcp_servers.cross-agent.args=["<repo>/src/server.ts"] -c mcp_servers.cross-agent.default_tools_approval_mode="approve"` | `mcp__cross_agent__list_roles`, `mcp__cross_agent__verify_worktree` (hyphen folded to `_` in the tool name) **plus** Codex's built-in `codex_apps`, 38 tools in all | the user's own, no; `codex_apps`, always | role text prepended to the prompt, and separately `-c model_instructions_file="<role.md>"` | yes for both |
| Codex, control | `--ignore-user-config` alone | 36 tools, every one `mcp__codex_apps__…` | no | `-c model_instructions_file="<role.md>"` only | yes |
| Grok, user scope | `grok mcp add cross-agent --scope user -- node <repo>/src/server.ts`, then the ordinary spawn | `cross-agent__list_roles`, `cross-agent__verify_worktree`, reached through the built-in `use_tool` dispatcher | **yes** — `probe-other__*` (a second registration added to prove the point) and `context7__*` (a Grok plugin, not in `grok mcp list`) came too | `--rules "<role text>"` | yes for the final message; the interstitial narration does not carry it |
| Grok, project scope | `grok mcp add cross-agent --scope project` (writes `<cwd>/.grok/config.toml`) | **no cross-agent tool at all**; the run's `available_commands` line lists only `context7__resolve-library-id` and `context7__query-docs`, and the child named `context7` as connected and `claude-design` as failed to connect, auth required | yes, those two | `--rules` | yes |

- **Claude.** `--append-system-prompt-file <file>` is accepted by the binary
  and the instruction is obeyed, which settles the open question in design
  section 3: `claude --help` on 2.1.266 documents only `--append-system-prompt
  <prompt>` and mentions the `[-file]` form inside another flag's description,
  but the flag the harness has been emitting (`tools/probe.mjs:54`) works.
  The mount is clean and exclusive: with `--strict-mcp-config`,
  `mcp_servers` is exactly
  `[{"name":"cross-agent","status":"connected"}]` and the only `mcp__` tools
  are this server's two; dropping `--strict-mcp-config` in an otherwise
  identical run pulled in five of the operator's own servers, so the flag —
  not the config file — is what makes the mount exclusive. Exit 0 in 16.3 s,
  24.1 s and 24.8 s. One wrinkle for the lead loop: the child received both
  tools as **deferred** tools and had to load `list_roles` through
  `ToolSearch` before calling it; it did so unprompted.
- **Codex.** The `-c mcp_servers…` mount works, but on the first run the call
  failed with `{"error":{"message":"MCP tool call requires approval, but
  approval policy is never"}}` while the tool was plainly visible. `codex exec`
  runs with approval policy `never`, and an MCP tool call needs approval unless
  the server says otherwise, so the mount needs a third setting: `-c
  mcp_servers.cross-agent.default_tools_approval_mode="approve"` (the field
  name is `McpServerConfig.default_tools_approval_mode`, whose
  `AppToolApproval` values in the 0.153.4 binary are `prompt`, `writes` and
  `approve`). With it
  the call returned the four roles. `--ignore-user-config` removes the user's
  servers but never `codex_apps` (P5, reconfirmed: 36 of them). `-c
  model_instructions_file="<file>"` — the value is TOML, so the quotes are
  part of the argument — is accepted and obeyed with **no** role text
  in the prompt, so a Codex lead has a real instruction path and does not have
  to spend prompt space on the loop; whether that file replaces or appends to
  Codex's own model instructions was not probed. Exit 0 in 37.0 s, 53.4 s and
  40.2 s.
- **Grok.** There is no per-run mount. Registered at user scope, the server was
  visible and callable, and so was everything else the operator has: `grok
  inspect` in the probe worktree listed four servers from **three** sources —
  `config` (both this server and the deliberate second one), `plugin:
  context7`, and **`~/.claude.json [claude]`**, so Grok reads the operator's
  *Claude* MCP configuration as well as its own. That listing was transcribed
  from the terminal and is **not archived**; it cannot be reproduced without
  re-registering. What is archived is a `grok inspect` run after removal
  (`p9-grok-inspect-after-removal.txt`), which still shows `claude-design
  (http) ~/.claude.json [claude]` and `context7 (http) plugin: context7`, and
  a Grok child's own init line naming that server —
  `"mcp_servers":[{"name":"claude-design","status":"connected"}]` in
  `p8b-sm-badmodel.log` — so the load-bearing half of the claim, that a Grok
  child inherits servers the operator declared to *Claude*, rests on archived
  output. Registered at project scope instead — `<cwd>/.grok/config.toml`,
  which would have been a per-project mount that never touches the operator's
  file — the server was **not started**: `grok mcp doctor` reports "folder
  untrusted (repo-local (project-scoped) server not started for an untrusted
  folder) → re-run with `--trust`" (also transcribed from the terminal, **not
  archived**, and not reproducible without re-registering), and no `--trust`
  flag exists on `grok`, `grok mcp add` or `grok mcp doctor` in 1.0.13, so a
  headless Grok run cannot trust a folder. (That doctor listing also
  miscounts: it credits `~/.grok/config.toml` with the one server that is
  actually in the project file.) `--rules` takes a **string**, not a path:
  given the role file's path it put the path into the system prompt as
  literal text and the agent read the file with its own `read_file` tool
  before answering — which only worked because the file was inside a readable
  sandbox. Registration and removal: `grok mcp add cross-agent --scope user --
  node <repo>/src/server.ts` writes `[mcp_servers.cross-agent]` into
  `~/.grok/config.toml`; `grok mcp remove cross-agent` removed it, and `grok
  mcp list` afterwards reports "No MCP servers configured". The comparison run
  that delivered the role by **prepending** it to the prompt instead of
  through `--rules` (`p9-grok-prefix.log`, exit 0, 12.2 s) answered
  `ROLE-OK\nREADY` with no tool call at all, so both delivery paths are
  honoured and the prepended one carries the instruction into the first text
  the model emits. Exit 0 throughout: 48.1 s for the user-scope run, 12.2 s
  for that prepended-role run, 16.8 s for `--rules <path>` and 40.6 s for the
  project-scope run.
- The harness's `CROSS_AGENT_LINEAGE` was fixed for these runs: it emitted
  `probe/<uuid>:<engine>:<cwd>`, which `parseLineage`
  (`src/guard.ts#parseLineage`) rejects, and now emits the JSON array
  `[{"taskId":"probe-<uuid>","role": "probe-<engine>","cwd":"<cwd>"}]`, verified
  by feeding the value a child actually received back through `parseLineage`.
  Probe children now see the shape real children will see.

Consequence for engine placement. A Claude lead can be mounted exactly:
`--strict-mcp-config --mcp-config <file>` gives it this server and nothing
else, and `--append-system-prompt-file` delivers the loop, so `leadMount` for
Claude is settled as design section 3 describes it. A Codex lead can be
mounted exactly too, but its `leadMount` needs a third `-c` —
`default_tools_approval_mode="approve"` — without which the lead sees the
tools and is refused every call, and its loop can go through
`-c model_instructions_file="<file>"` instead of the prompt.
A Grok lead cannot be isolated at all: the only mount that works is the
operator's own user-scope configuration, which also hands the lead every other
server the operator has, from `~/.grok/config.toml`, from Grok plugins, and
from `~/.claude.json` — so `leadMount` for Grok returns `inherited: true`, the
launcher has to register and unregister the server around the run, and the
design's answer to a child reaching an inherited server (the specialist row it
resolves to by ancestry, section 5) is doing all of the work.

## P10: `codex exec resume` keeps the thread, not the workspace (2026-09-09)

A thread was started in the probe worktree with `codex exec --json -o <out> -C
<worktree> --sandbox workspace-write --ignore-user-config --skip-git-repo-check
-m gpt-6-astra` (thread `01a0855f-287a-7f32-85ab-0d336bd260a3`), then resumed
with `codex exec resume <thread id> --json -o <out> --ignore-user-config
--skip-git-repo-check -m gpt-6-astra` — the flag set the subcommand accepts,
since it takes neither `-C` nor `--sandbox` (the harness appended both until
this probe; `tools/probe.mjs:63-68` now omits them on resume). Every turn ran
the same
three commands and reported their exit codes: `pwd`; append to a file
**inside** the worktree; append to a file in the probe repository **root**,
outside it.

| Variant | process cwd | extra flags | `pwd` | write inside worktree | write outside worktree | exit |
|---|---|---|---|---|---|---|
| start (`exec … -C <worktree> --sandbox workspace-write`) | worktree | — | worktree | OK | denied, "Read-only file system" | 0, 28.5 s |
| resume, as launched | worktree | — | worktree | **denied**, "Read-only file system" | denied | 0, 31.0 s |
| resume | worktree | `-c sandbox_mode="workspace-write"` | worktree | OK | denied | 0, 27.5 s |
| resume | **repo root** | `-c sandbox_mode="workspace-write"` | **repo root** | OK | **OK — the write landed** | 0, 28.5 s |
| resume | **repo root** | `-c cwd="<worktree>"` and `-c sandbox_mode="workspace-write"` | **repo root** | OK | **OK — the write landed** | 0, 24.4 s |

- **The resumed thread does not keep the original run's cwd.** It uses the
  cwd of the `codex exec resume` process, and the workspace-write sandbox's
  writable root follows that cwd: resumed one directory up, the child wrote a
  file into the probe repository root that the original turn had been refused.
  Verified on disk afterwards, not only from the transcript.
- **`-c cwd=<dir>` is not honoured.** With it set to the worktree and the
  process still in the repository root, `pwd` printed the repository root and
  the outside write still succeeded. The process's own cwd is the only lever.
- **The resumed thread does not keep the original run's sandbox either**, and
  the default is the safe direction: the workspace-write thread came back
  read-only, so the in-worktree write that had succeeded was refused.
  `-c sandbox_mode="workspace-write"` restores it exactly — inside allowed,
  outside denied.
- Every variant exited 0, the failed writes included: a denied write is a
  non-zero *command* inside a turn that still completes.

Consequence for T8: a Codex resume must be spawned with the process cwd set to
the role's workspace **and** `-c sandbox_mode=<the role's profile>`
re-supplied, because resuming from the wrong directory silently moves the
writable root rather than failing. The two facts together mean
`SpawnRequest.sandbox` has to be re-applied on resume by the adapter, not
assumed from the thread.

## CLI flag facts (`--help`, 2026-09-09)

Read from `--help` on this machine, with the CLI version, rather than from
memory. These are the flags that design section 3's spawn lines depend on and
that no earlier probe exercised; P8, P9 and P10 above are the runs that used
them.

- **Grok Build 1.0.13** (`grok --help`). `--output-format <OUTPUT_FORMAT>`,
  "Output format for headless mode", possible values `plain`, `json`,
  `streaming-json: NDJSON: one ACP session update per line, the agent's native
  format`, `streaming-messages-json: NDJSON in the Anthropic Messages API wire
  format`; default `plain`. `--reasoning-effort <EFFORT>`, "Reasoning effort
  for reasoning models", `[aliases: --effort]`. `--rules <RULES>`, "Extra rules
  to append to the system prompt" — a string, as P9 confirmed.
  `--system-prompt-override <PROMPT>`, "Override the agent's system prompt
  (compat alias: `--system-prompt`)". `--include-partial-messages` "Only
  affects `--output-format streaming-messages-json`". There is no per-run MCP
  flag: `grok mcp` is a subcommand (`list`, `add`, `remove`, `enable`,
  `disable`, `doctor`), and `grok mcp add` writes to `~/.grok/config.toml`
  (`--scope user`, the default) or `./.grok/config.toml` (`--scope project`).
  `--sandbox <PROFILE>`, "Sandbox profile for filesystem and network access",
  `[env: GROK_SANDBOX=]`; the profiles are not enumerated. A name is resolved
  when the run starts, against the built-ins and `~/.grok/sandbox.toml` or
  `.grok/sandbox.toml`: `grok --sandbox bogus -p hi` fails with "Custom sandbox
  profile 'bogus' not found. Define it in ~/.grok/sandbox.toml or
  .grok/sandbox.toml" before doing anything else, and `grok inspect` does not
  list them. The adapter's map names `workspace`, `read-only`, `strict` and
  `off`; P2 ran the first two, and no run has exercised `strict` or `off`.
- **Claude Code 2.1.266** (`claude --help`). `--mcp-config <configs...>`, "Load
  MCP servers from JSON files or strings (space-separated)";
  `--strict-mcp-config`, "Only use MCP servers from `--mcp-config`, ignoring
  all other MCP configurations"; `--append-system-prompt <prompt>`, "Append a
  system prompt to the default system prompt". The `-file` spelling has no
  entry of its own — it appears only inside another flag's description, as
  "`--system-prompt[-file]`, `--append-system-prompt[-file]`" — but
  `--append-system-prompt-file <path>` is accepted and honoured by the binary
  (P9). `--effort <level>`, "Effort level for the current session", read on
  this machine during T7; it is Claude's counterpart of Grok's
  `--reasoning-effort` and no run has exercised it.
- **Codex 0.153.4** (`codex exec --help`, `codex exec resume --help`). `codex
  exec` takes `-c/--config <key=value>`, `-m/--model`, `-C/--cd <DIR>`,
  `-s/--sandbox <SANDBOX_MODE>`, `--add-dir`, `--json`,
  `-o/--output-last-message`, `--ignore-user-config`, `--ignore-rules`,
  `--skip-git-repo-check`, `--ephemeral`, `--strict-config`,
  `--enable`/`--disable`, `-i/--image`,
  `--output-schema`, `--thread-source`, `--oss`, `--local-provider`,
  `-p/--profile`, `--approve-for-me`, `--color`, and the two `--dangerously-*`
  flags — **no system-prompt flag of any kind**, which is why instructions
  reach a Codex child through the prompt or through `-c
  model_instructions_file=<file>` (P9). `codex exec resume [SESSION_ID]
  [PROMPT]` takes `-c`, `--last`, `--all`, `--enable`, `--disable`, `-i`,
  `--strict-config`, `-m`, `--thread-source`, `--skip-git-repo-check`,
  `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema`,
  `--json`, `-o`, and the two `--dangerously-*` flags — **neither `-C` nor
  `--sandbox`** (P10). Both heads take the prompt as a **positional argument
  and read it from stdin behind `-`**, which is how the adapter delivers a
  brief: `codex exec [PROMPT]` is "Initial instructions for the agent. If not
  provided as an argument (or if `-` is used), instructions are read from
  stdin. If stdin is piped and a prompt is also provided, stdin is appended as
  a `<stdin>` block", and `codex exec resume [SESSION_ID] [PROMPT]` is "Prompt
  to send after resuming the session. If `-` is used, read from stdin". So the
  literal `-` is never sent as a prompt on either head, and there is no
  double-send: stdin is appended as a `<stdin>` block only when a prompt is
  *also* given as an argument, and `-` is not one. This is a `--help` reading
  of 0.153.4, not a run; the run that confirms a child behaves as the help says
  is the **I2** placeholder (`tests/engines/codex.test.ts:515`).

## Native output samples (2026-09-07)

Real lines from the probe logs above, shortened. The adapters and the fake
engine's per-engine formats (T4) follow these shapes.

### Claude Code, `claude -p --output-format stream-json --verbose`

One JSON object per line. The first line with `"subtype":"init"` carries the
session id; assistant turns are `"type":"assistant"`; the last line is
`"type":"result"` with the final text in `result`.

```
{"type": "system", "subtype": "init", "cwd": "/tmp/claude-1000/-home-wsh-Documents-agent-team-devpack/39995ccc-23f3-4582-80eb-ff073a86fe7e/scratchpad/probe-repo", "session_id": "138a9c9e-f573-45c5-80fc-fda76dddc834", "tools": ["Task", "Bash", "CronCreate", "…"], "mcp_servers": [], "model": "claude-sonnet-5", "permissionMode": "bypassPermissions", "slash_commands": ["humanizer", "show-me", "deep-research", "…"], "terminal_slash_commands": ["doctor", "color", "reload-plugins"], "apiKeySource": "none", "claude_code_version": "2.1.263", "output_style": "default", "agents": ["claude", "code-simplifier:code-simplifier", "codex:codex-rescue", "…"]}
{"type": "assistant", "message": {"model": "claude-sonnet-5", "id": "msg_011CepP2wAGvGKQdcLYgbkfa", "type": "message", "role": "assistant", "content": [{"type": "thinking", "thinking": "", "signature": "EtgECqgBCBEYAipASVvJq1aMZc+Xkz8O4WgNxLNeNNDJXXJ6MdW0AWF8RokHyULr6Q27479zWCGBuz9/TqDXP5ojh8jdx23VxYZITDIPY2xhdWRlLXNvb…"}], "stop_reason": null, "stop_sequence": null, "stop_details": null, "usage": {"input_tokens": 2, "cache_creation_input_tokens": 14580, "cache_read_input_tokens": 17595, "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 14580}, "output_tokens": 2, "service_tier": "standard", "inference_geo": "not_available"}, "diagnostics": null, "context_manage…
{"duration_api_ms": 6970, "stop_reason": "end_turn", "session_id": "138a9c9e-f573-45c5-80fc-fda76dddc834", "total_cost_usd": 0.07443, "usage": {"input_tokens": 4, "cache_creation_input_tokens": 15032, "cache_read_input_tokens": 49770, "output_tokens": 434, "output_tokens_details": {"thinking_tokens": 119}, "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0}, "service_tier": "standard", "cache_creation": {"ephemeral_1h_input_tokens": 15032, "ephemeral_5m_input_tokens": 0}, "inference_geo": "not_available", "iterations": [{"input_tokens": 2, "output_tokens": 153, "cache_read_input_tokens": 32175, "cache_creation_input_tokens": 452, "cache_creation": {"ephemeral_5m_input_toke…
```

### Codex, `codex exec --json`

One JSON object per line. `thread.started` carries the thread id (the
resume id); `item.completed` items of type `agent_message` carry text,
`command_execution` items carry a command and its output; `turn.completed`
ends the run. The final message is also written to the `-o` file.

```
{"type": "thread.started", "thread_id": "01a07ca9-83fb-78a0-a330-6b7555f3632f"}
{"type": "turn.started"}
{"type": "item.completed", "item": {"id": "item_0", "type": "agent_message", "text": "I’ll run the command and check the available MCP tools."}}
{"type": "item.completed", "item": {"id": "item_1", "type": "command_execution", "command": "/bin/bash -lc 'echo \"DEPTH=${CROSS_AGENT_DEPTH:-NONE} LINEAGE=${CROSS_AGENT_LINEAGE:-NONE}\"'", "aggregated_output": "DEPTH=1 LINEAGE=probe/915db2f4-e5b7-4d5c-a69c-66544ca1330b:codex:/tmp/claude-1000/-home-wsh-Documents-agent-team-devp…", "exit_code": 0, "status": "completed"}}
{"type": "item.completed", "item": {"id": "item_2", "type": "agent_message", "text": "```text\nDEPTH=1 LINEAGE=probe/915db2f4-e5b7-4d5c-a69c-66544ca1330b:codex:/tmp/claude-1000/-home-wsh-Documents-agent-t…"}}
```

### Grok Build, `grok -p … --output-format json`

Not line-delimited: one pretty-printed JSON object spanning many lines,
printed at the end, with `text` (the final message) and `sessionId` (the
resume id). An adapter parses the whole stdout once the process exits; the two
streaming formats give line events instead, and P8 records both.

```
{
  "text": "…the agent's final message…",
  "stopReason": "end_turn",
  "sessionId": "a78170b7-3e60-4f87-ae45-fde2f99b6519",
  "requestId": "ec9abfff-de65-4c08-bfa3-98dfdf0cbfc0",
  "thought": "…",
  "usage": {
    "input_tokens": 40749,
    "cache_read_input_tokens": 118528,
    "cache_creation_input_tokens": 0,
    "output_tokens": 583,
    "reasoning_tokens": 302,
    "total_tokens": 159860
  },
  "num_turns": 8,
  "total_cost_usd": 0.0245242,
  "total_cost_usd_ticks": 245242000,
  "modelUsage": {
    "grok-4.6-build": {
      "inputTokens": 40749,
      "outputTokens": 583,
      "cacheReadInputTokens": 118528,
      "cacheCreationInputTokens": 0,
      "modelCalls": 8,
      "costUSD": 0.0245242
    }
  }
}
```
