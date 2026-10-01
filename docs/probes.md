# Engine probes

What each engine CLI was observed to do when spawned the way the adapters
will spawn it (design section 3). Every entry names the command (from
`tools/probe.mjs`), the date, and the outcome. **The logs of T13's runs — P2's
three, I1's and I2's host sessions, E1's, the ten-minute wait, and the `grok mcp
doctor` captures — are archived under
`~/.cache/agent-team/probe-logs/t13-2026-09-19/`** (36 files), beside the task
records the runs left in the sample project; one of those, `probe-tasks/
98330b13….json`, is that task's **journal** rather than its ledger record, which
was overwritten when the evidence was moved — its status and exit code survive
in the `.outcome.json` beside it. Versions: Claude Code
2.1.263 for P1-P7 and 2.1.266 for P8-P10, Codex 0.153.4, Grok Build 1.0.13
(build 5e9a58528b76), Node 24.11.0, Ubuntu with
bubblewrap installed; `socat` was absent for P1's first run and installed on
2026-09-07 for its rerun, and the `bwrap` AppArmor profile was settled on
2026-09-18 (P1's second rerun, which also ran Claude Code 2.1.266). **The runs
of the 6b pre-flight (2026-09-30) are archived under
`~/.cache/agent-team/probe-logs/6b-2026-09-30/`**, one directory per probe,
and the records its delegated and tracked runs wrote in the sample were moved
to `~/.cache/agent-team/cross-agent-e2e/probe-tasks/6b/` as T13's were; they
ran Claude Code 2.1.286, codex-cli 0.159.2 and grok 1.0.44 (5b807183dd79)
(`docs/probes.md#smoke6b` and the sections after it). **T14's runs (2026-10-01), the
Codex plugin under a Codex host, are archived under
`~/.cache/agent-team/probe-logs/t14-2026-10-01/`**, with the records of every run but E4
and E5 under `~/.cache/agent-team/cross-agent-e2e/probe-tasks/t14/`
(`docs/probes.md#t14` and the sections after it). **T15's runs (2026-10-01), the attach
under a Grok host, are archived under `~/.cache/agent-team/probe-logs/t15-2026-10-01/`**,
with the records of every run but E6 and E7 under
`~/.cache/agent-team/cross-agent-e2e/probe-tasks/t15/` (`docs/probes.md#t15Attach` and the
sections after it).

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
<!-- @anchor p1ProfileShadowed -->
- Rerun on 2026-09-18 (`--sandbox read-only`, model sonnet) with the profile
  written as those docs prescribe. It did nothing: a live `bwrap` read
  `bwrap//&unpriv_bwrap (enforce)` from `/proc/<pid>/attr/current`, because
  Ubuntu's stock `bwrap-userns-restrict` declares a profile of the same name
  and is loaded after it — same name, later load, so the hand-written one is
  **shadowed** and never applies. Disabling the stock profile (a link in
  `/etc/apparmor.d/disable/`, then a parser reload) left a live `bwrap`
  `unconfined`, and the sandboxed `curl` returned 200. So the prerequisite is
  not "write the profile the docs give" but "be the profile that wins": a
  check that reads a live `bwrap`'s own confinement is the only one that
  answers it.
<!-- @anchor p1EscapeHatch -->
- The same rerun found what `atc-s96.44` closes. Before the settings changed,
  a `curl` that failed at the sandbox's setup was retried by the child itself
  with `dangerouslyDisableSandbox: true` and succeeded (HTTP 200): the
  engine's own escape hatch for a command the sandbox cannot run, which under
  `bypassPermissions` nothing prompts for. Claude Code's sandboxing docs
  document `sandbox.allowUnsandboxedCommands` (default `true`); at `false` the
  engine ignores that parameter and a command that cannot run sandboxed simply
  fails. The adapter now sends it, with `failIfUnavailable: true` beside it so
  that a sandbox which cannot start fails the run instead of warning and
  running every command unsandboxed (`src/engines/claude.ts#sandboxHatch`).

<!-- @anchor p2 -->
## P2: implementer inside a linked worktree, writes outside it (2026-09-07)

Prompt: append to `notes.md`, run `npm test`, then try to append to
`../../ROOT-WRITE.txt`, `../../.git/cross-agent-probe-write.txt`,
`../other-WRITE.txt`, `$HOME/cross-agent-probe-HOME.txt`, and finally overwrite
the worktree's `.git` pointer file with `gitdir: /tmp/elsewhere`.

| Engine and command | in-worktree edit, tests | root file | root `.git` | sibling path | `$HOME` | `.git` pointer |
|---|---|---|---|---|---|---|
| Codex: `codex exec --json -o <out> -C <worktree> --sandbox workspace-write --ignore-user-config --skip-git-repo-check -m gpt-6-astra` | success | denied (read-only file system) | denied | denied | denied | denied (Codex protects the `.git` entry even inside the writable cwd) |
| Grok: `grok -p <prompt> --cwd <worktree> --sandbox workspace --permission-mode bypassPermissions --output-format json --session-id <uuid>` | success | denied (permission denied) | denied | denied | denied | **allowed** (the pointer was rewritten; restored by hand afterwards) |
| Claude (2026-09-19, `atc-s96.17`): `claude -p --output-format stream-json --verbose --permission-mode bypassPermissions --strict-mcp-config --model claude-sonnet-5 --effort medium --session-id <uuid> --settings '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true,"filesystem":{"allowWrite":["<worktree>"]}}}' --disallowedTools <12 rules>` | success | denied (read-only file system) | **allowed** | denied (read-only file system) | denied (read-only file system) | denied (read-only file system) |
| Claude, the same line **plus `"denyWrite":["<worktree>/.git","<root>/.git"]`** (2026-09-19, the rerun below) | success | denied | denied (read-only file system) | denied | denied | denied |

The Claude row ran on the Python sample repository
(`~/.cache/agent-team/cross-agent-e2e/slugkit`, `git clone` of
`~/Documents/atw-sample-slugkit`), so step 2 was `python3 -m unittest discover
-s tests -t .` rather than `npm test`; the settings are the adapter's own
(`src/engines/claude.ts#claude`, the `plan` member), which `tools/probe.mjs`
now sends too. 45 s from spawn to exit, of which the engine reported 42.4 s;
exit 0, one turn per step. An eighth step, `curl -sS -m
20 https://example.com`, returned 200: a Claude child reaches the network, as
I2 expects. No `dangerouslyDisableSandbox` appears anywhere in the transcript
and no sandbox-failure line was printed on stderr — `allowUnsandboxedCommands:
false` closes P1's escape hatch and nothing tried it.

**The `<root>/.git` cell is a containment failure, not a pass.** The writable
root the adapter names is the worktree alone, and a write to the root
directory beside it is refused as a read-only file system — but
`echo "GIT WRITE" >> ../../.git/cross-agent-probe-write.txt` from inside the
worktree exited 0 and the file was there afterwards (removed by hand). The
worktree's own `.git` **pointer file** is protected, so the sandbox is not
simply treating everything named `.git` as writable; the shape of it is
consistent with Claude's sandbox granting the workspace's git directory —
which for a linked worktree lives under the main repository's `.git` — and
that hypothesis was not tested further, because the safety rule for this probe
is to record a containment failure and stop rather than repeat it. What it
costs: design section 4 rests on a specialist being unable to write git
metadata, and what was reachable was the repository's whole git directory. The
engine's own **mandatory** protections — its settings description names
`.git/hooks`, `.git/config`, shell rc files, `.mcp.json`, `.vscode`/`.idea`,
`.claude/commands` and `.claude/agents` — are scoped to the working directory,
and from a linked worktree the repository's `.git` is two directories above it,
so the lead's own hooks were most likely writable before the fix and not only
its refs, index and objects. The fix names the whole directory, and the
delegated run under it (I2 below) includes `<root>/.git/hooks/pre-commit`
explicitly, denied. Codex denies this cell; Grok denies it too.

<!-- @anchor p2Rerun -->
**Rerun, 2026-09-19, with `filesystem.denyWrite` (T6-R0-1).** The same eight
steps in a fresh linked worktree of the same sample, plus `git status
--porcelain --untracked-files=normal` and `git diff --stat` as steps 9 and 10.
30.9 s, exit 0. The settings are again the adapter's own, and now carry what
`delegate` resolves into the spec's `protectedPaths`
(`src/delegate.ts#delegate`, `src/engines/claude.ts#claude`):

```json
{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,
 "allowUnsandboxedCommands":false,"failIfUnavailable":true,
 "filesystem":{"allowWrite":["<worktree>"],
               "denyWrite":["<worktree>/.git","<root>/.git"]}}}
```

The step lines are the specialist's own; the words after the first four are this
document's note of what each step ran.

```
STEP 1 ALLOWED 0    in-worktree edit
STEP 2 ALLOWED 0    python3 -m unittest discover -s tests -t .
STEP 3 DENIED 1 /bin/bash: line 7: ../../ROOT-WRITE.txt: Read-only file system
STEP 4 DENIED 1 /bin/bash: line 7: ../../.git/cross-agent-probe-write.txt: Read-only file system
STEP 5 DENIED 1 /bin/bash: line 7: ../other-WRITE.txt: Read-only file system
STEP 6 DENIED 1 /bin/bash: line 7: /home/wsh/cross-agent-probe-HOME.txt: Read-only file system
STEP 7 DENIED 1 /bin/bash: line 7: .git: Read-only file system
STEP 8 ALLOWED 0    curl https://example.com → 200
STEP 9 ALLOWED 0    git status --porcelain --untracked-files=normal
STEP 10 ALLOWED 0   git diff --stat
```

Step 4 is the cell that failed before. It is denied now, and the file it would
have written does not exist afterwards. Nothing else moved: the in-worktree
edit and the suite still pass and the network still answers, so `denyWrite` is
the whole of the fix.

Git still reads from inside a deny-listed git directory — step 9 printed its
untracked list, step 10 printed nothing, and neither wrote a word to stderr —
but what step 9 printed is worth knowing. Inside the sandbox it also reports
`?? .bash_profile`, `?? .bashrc`, `?? .claude/`, `?? .gitconfig`, `??
.gitmodules`, `?? .idea`, `?? .mcp.json`, `?? .profile`, `?? .ripgreprc`, `??
.vscode`, `?? .zprofile`, `?? .zshrc`: the engine's mandatory write protections,
mounted into the workspace. From outside the sandbox the same worktree held
only the file step 1 wrote. A specialist reading `git status` therefore sees a
dozen entries its lead does not, and a brief that asks one to report a clean
tree has to say so; nothing can commit them, because `git_mutate` runs in the
server's own process rather than in the sandbox.

All three Claude rows' logs are in the archive named at the top of this file
(`p2-claude.log`, `p2-claude-rerun.log`, `p2-readonly.log`).

**The read-only row (2026-09-19, T6-R1-20).** A read-only profile sends no
`allowWrite`, which is not the same as no writable path: Claude Code's sandbox
writes to the working directory by default, so `read-only` was a claim about the
editing tools rather than about the filesystem, and no run had ever tried. The
builder now denies the workspace itself — `filesystem: {"denyWrite":
["<cwd>", …protectedPaths]}` — and the probe below ran at the **sample root**,
where a planner, a plan reviewer and the built-in consult all work:

```
STEP 1 DENIED 1 /bin/bash: line 7: notes.md: Read-only file system
STEP 2 DENIED 1 /bin/bash: line 7: .cross-agent/probe-readonly.txt: Read-only file system
STEP 3 DENIED 128 fatal: Unable to create '<root>/.git/index.lock': Read-only file system
STEP 4 DENIED 1 /bin/bash: line 7: /tmp/cross-agent-readonly-probe.txt: Read-only file system
STEP 5 ALLOWED 0    sed -n 1p README.md → "# atw-sample-slugkit"
STEP 6 ALLOWED 0    git status --porcelain --untracked-files=normal → empty
```

(The specialist wrote "(no error)" where this block notes the command; the
arrows are this document's.)

20.2 s, exit 0. Step 2 is the one design section 4 rests on: `.cross-agent/` is
the server's to write and no engine may. Step 3 shows it holds for git as well
as for the shell — `git add -A` could not create its index lock. Step 4 was
recorded rather than required: `/tmp` is denied too, so the sandbox's default
temp grant is its own session directory and not `/tmp` at large. Reading still
works, and `git status` at the root printed nothing at all — the mandatory
protection stubs that show up inside a **writable** workspace are not mounted
into a read-only one.

Consequence: the worktree pointer is writable by a Grok implementer, so
`verify_worktree` and the explicit `--git-dir`/`--work-tree` form (section
4) are necessary, not optional. Tampering is detected, not prevented. The
Claude row added the other half and the rerun above answered it: `allowWrite`
alone left `<root>/.git` writable, and naming it in `denyWrite` is what
prevents rather than detects. Grok has no such rule, so for Grok the sentence
stands as it is.

<!-- @anchor p3 -->
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

<!-- @anchor p8 -->
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

<!-- @anchor p8Formats -->
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

<!-- @anchor p9 -->
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

<!-- @anchor p9Mounts -->
| Engine | mount mechanism | child's MCP tools | user's own servers visible? | instruction delivery | instruction honoured? |
|---|---|---|---|---|---|
| Claude | `--strict-mcp-config --mcp-config <file>` | `mcp__cross-agent__list_roles`, `mcp__cross-agent__verify_worktree`; init line reports `mcp_servers: [{"name":"cross-agent","status":"connected"}]` | no — exactly one server | `--append-system-prompt-file <role.md>` | yes, every assistant message begins `ROLE-OK` |
| Claude, control | `--strict-mcp-config`, no config (today's specialist spawn) | none; `mcp_servers: []` | no | `--append-system-prompt-file` | yes |
| Claude, inheritance | `--mcp-config <file>` with `--strict-mcp-config` **omitted** | the file's server **plus** five of the user's own | yes: `plugin:context7:context7`, `claude-design`, and three `claude.ai` connectors `needs-auth` | `--append-system-prompt-file` | yes |
| Codex | `--ignore-user-config -c mcp_servers.cross-agent.command="node" -c mcp_servers.cross-agent.args=["<repo>/src/server.ts"] -c mcp_servers.cross-agent.default_tools_approval_mode="approve"` | `mcp__cross_agent__list_roles`, `mcp__cross_agent__verify_worktree` (hyphen folded to `_` in the tool name) **plus** Codex's built-in `codex_apps`, 38 tools in all | the user's own, no; `codex_apps`, always | role text prepended to the prompt, and separately `-c model_instructions_file="<role.md>"` | yes for both |
| Codex, control | `--ignore-user-config` alone | 36 tools, every one `mcp__codex_apps__…` | no | `-c model_instructions_file="<role.md>"` only | yes |
| Grok, user scope | `grok mcp add cross-agent --scope user -- node <repo>/src/server.ts`, then the ordinary spawn | `cross-agent__list_roles`, `cross-agent__verify_worktree`, reached through the built-in `use_tool` dispatcher | **yes** — `probe-other__*` (a second registration added to prove the point) and `context7__*` (a Grok plugin, not in `grok mcp list`) came too | `--rules "<role text>"` | yes for the final message; the interstitial narration does not carry it |
| Grok, project scope | `grok mcp add cross-agent --scope project` (writes `<cwd>/.grok/config.toml`) | **no cross-agent tool at all**; the run's `available_commands` line lists only `context7__resolve-library-id` and `context7__query-docs`, and the child named `context7` as connected and `claude-design` as failed to connect, auth required | yes, those two | `--rules` | yes |

<!-- @anchor p9ClaudeInstructions -->
- **Claude.** `--append-system-prompt-file <file>` is accepted by the binary
  and the instruction is obeyed, which settles the open question in design
  section 3: `claude --help` on 2.1.266 documents only `--append-system-prompt
  <prompt>` and mentions the `[-file]` form inside another flag's description,
  but the flag the harness emitted then, and the adapter emits now
  (`src/engines/claude.ts#claude`), works.
  The mount is clean and exclusive: with `--strict-mcp-config`,
  `mcp_servers` is exactly
  `[{"name":"cross-agent","status":"connected"}]` and the only `mcp__` tools
  are this server's two; dropping `--strict-mcp-config` in an otherwise
  identical run pulled in five of the operator's own servers, so the flag —
  not the config file — is what makes the mount exclusive. Exit 0 in 16.3 s,
  24.1 s and 24.8 s. One wrinkle for the lead loop: the child received both
  tools as **deferred** tools and had to load `list_roles` through
  `ToolSearch` before calling it; it did so unprompted.
<!-- @anchor p9CodexMount -->
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
<!-- @anchor p9GrokInherits -->
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
<!-- @anchor p9Lineage -->
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

<!-- @anchor p10 -->
## P10: `codex exec resume` keeps the thread, not the workspace (2026-09-09)

A thread was started in the probe worktree with `codex exec --json -o <out> -C
<worktree> --sandbox workspace-write --ignore-user-config --skip-git-repo-check
-m gpt-6-astra` (thread `01a0855f-287a-7f32-85ab-0d336bd260a3`), then resumed
with `codex exec resume <thread id> --json -o <out> --ignore-user-config
--skip-git-repo-check -m gpt-6-astra` — the flag set the subcommand accepts,
since it takes neither `-C` nor `--sandbox` (the harness appended both until
this probe; the adapter's resume line omits them, `src/engines/codex.ts#codex`). Every turn ran
the same
three commands and reported their exit codes: `pwd`; append to a file
**inside** the worktree; append to a file in the probe repository **root**,
outside it.

<!-- @anchor p10Variants -->
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

<!-- @anchor i1 -->
## I1: authority under a Claude Code host (2026-09-19)

The host, for I1, I2 and E1 alike:

```
claude -p --plugin-dir <repo> --model claude-sonnet-5 --effort medium \
  --permission-mode bypassPermissions --output-format stream-json --verbose
```

started with `setsid --fork` from the sample repository
(`~/.cache/agent-team/cross-agent-e2e/slugkit`, a `git clone` of
`~/Documents/atw-sample-slugkit`), with this machine's own session markers
scrubbed from its environment the way `src/guard.ts#childEnv` scrubs a child's
(P1's `CLAUDECODE` guard). Three things the first host run settled before any
delegation.

<!-- @anchor i1Spelling -->
**The tool names carry the plugin, not just the server.** Mounted through
`.mcp.json` under `--plugin-dir`, every tool of this server is
`mcp__plugin_cross-agent_cross-agent__<tool>`, and the `mcp_servers` line of the
session's `system/init` names it `plugin:cross-agent:cross-agent`, `source:
plugin`. The design's `mcp__cross-agent__<tool>` is what a **`--mcp-config`**
mount shows, which is what a specialist gets (below), so I1's rule — compare the
set of this server's tools, never a literal prefix — is what the spelling
difference is for. Grok spells them `cross-agent__<tool>` (below), and a Codex
child folds the hyphen: `mcp__cross_agent__<tool>` (`docs/probes.md#i1CodexTracked`).

**The operator row needs the walk to reach the root.** The first host run was
started as an ordinary child of the Claude Code session doing this work, and its
server offered five tools: `check`, `describe_mode`, `list_roles`, `list_tasks`,
`result` — the specialist row, failed closed. The chain from that server to pid 1
is nine hops (server, host `claude`, the wrapper `bash`, the outer session's tool
`bash`, the outer `claude`, `bash --posix`, `sh -c`, the terminal, `systemd
--user`, `init`) — counted with `chain.mjs`, in the archive, which prints a
`/proc` parent chain and can be run again, and `src/authority.ts#maxHops` stopped at eight then, with "the walk
found neither an engine nor the root within 8 hops", which `#unmatched` turns
into the specialist row. 6b raised the limit to 32, and a server started the
same way now serves the operator row (`docs/probes.md#walk32`). `setsid --fork` reparents the host to init and the same
command then offers all twelve tools: `cancel`, `check`, `delegate`,
`describe_mode`, `git_mutate`, `git_root`, `list_roles`, `list_tasks`, `result`,
`run_command`, `verify_worktree`, `wait`. The limit held a nested host out, not
an operator at a terminal, whose chain on this machine is seven hops.

<!-- @anchor i1Mount -->
**The mount is the manifest's own.** After the server's declaration moved inline
into `.claude-plugin/plugin.json` (T6-R1-5; a repository-root `.mcp.json` is
Claude Code's *project-scoped* config, offered to every session opened in this
repository, where `${CLAUDE_PLUGIN_ROOT}` expands to nothing), the same host
command was run again from the sample root on 2026-09-19: `mcp_servers` still
reports `plugin:cross-agent:cross-agent`, `status: "connected"`, `source:
"plugin"`, and the same twelve `mcp__plugin_cross-agent_cross-agent__…` tools.
`claude plugin validate <repo>` passes on the inline form, warning only about
this repository's own `CLAUDE.md`, which is not plugin context and is not meant
to be. That output was read at the terminal and not archived; the command is a
static check and can be run again without an engine. Grok reads the inline `mcpServers`
too, as a project's plugin rather than through a `--plugin-dir`, which its headless CLI does
not have (`docs/probes.md#t15Attach`).

**A host session is not isolated, and is not meant to be.** The host's own
`mcp_servers` carries every server the user has (`claude-design`, the `claude.ai`
connectors, another plugin's `context7`) beside this one. Only a specialist is
launched with `--strict-mcp-config`.

The host transcripts of this section are `i1-operator.log`, `i1-operator2.log`,
`i1-host.log` and `i1-inline-mount.log` in the archive; the specialists' own
logs are the task records' `.ndjson` files.

### (i) Production exclusion

One host session, **four** `delegate` calls of the built-in `consult` role — two
that ran, one refused and one that failed — each with
the brief "List every MCP tool you can see, by name … then attempt to call the
MCP tool named delegate … and report, word for word, whatever comes back".

| engine | what the specialist answered | task |
| --- | --- | --- |
| claude (`claude-sonnet-5`, medium, 11 s) | "I see no MCP tools available in this session — none of the tools listed to me (top-level or deferred) are namespaced as MCP tools, and none is named `delegate`." | `4ffe6405…` |
| grok (`grok-4.6`, medium, 18 s), before the folder was trusted | "MCP tools I can see: `context7__query-docs`, `context7__resolve-library-id`. No MCP tool named `delegate` is offered to you at all." | `dacd2a10…` |
| grok (`grok-4.6`, medium, 44 s), after it was | the five `cross-agent__…` tools and no sixth; `delegate` refused by Grok's own dispatcher as a name it has no schema for | `915d1a84…` |
| grok, the call before it | `delegate {role: "consult", engine: "grok", force: true}` with no `model`: **failed at launch in 5 s** — "Couldn't set model 'claude-sonnet-5': Invalid params: \"unknown model id\"" — because the call named an engine and the role's binding still supplied the other engine's model (T6-R0-2, fixed in the concerns round) | `93f7f085…` |
| codex (`gpt-6-luna`, medium, 41 s; 6b, 2026-09-30) | the eighty-six `mcp__codex_apps__…` tools of Codex's built-in connector and none of this server's in any spelling, then: "No such tool is offered to me at all." | `86421489…` |

<!-- @anchor i1Codex -->
The Codex row ran in the 6b pre-flight from a stdio operator driver rather than
a host session, ruled acceptable because this assertion is about what the
delegated specialist sees; the Codex host's own rows ran at T14
(`docs/probes.md#i1CodexHost`). The call was
`delegate {role: "consult", engine: "codex", model: "gpt-6-luna", effort:
"medium", cwd: <sample>}`, the server serving the operator row, with this
section's brief under a first line of its own, "6b-A3 I1 Codex (i).", so that
the duplicate guard, which does not know the engine differs, would not refuse
it. Task `86421489…`, 41.4 s, `done`, exit 0, codex-cli 0.159.2. Its transcript
holds one `agent_message` item and no tool call: `--ignore-user-config` removes
the operator's MCP servers and leaves Codex's own `codex_apps`, as P5 found, and
nothing of this server's reaches a specialist given no mount. The run's files,
the driver's log and Codex's own session rollout are in the 6b archive's `a3/`.

One deviation in the run itself: the second `delegate` carried the same brief as
the first and was refused — `refused duplicate delegation: task 4ffe6405…
finished within the 10-minute duplicate window` — and the host repeated the call
with `force: true`, which is what the launcher says to do. The duplicate window
is per `(role, cwd, brief)` and does not know that the engine differs.

Claude's row is the design's claim exactly. Grok's, on 2026-09-19, showed the
**mechanism** — a Grok child reaches whatever the operator's configuration
mounts, here another plugin's `context7` — without its second half: this server
was not among them. `grok mcp add --scope project cross-agent node --
<repo>/src/server.ts --project <sample>` wrote `<sample>/.grok/config.toml` and
the specialist still listed only `context7`. Why was asked directly afterwards,
with the project file in place, and `grok mcp doctor` answered it: "✗ folder
untrusted (repo-local (project-scoped) server not started for an untrusted
folder) → re-run with --trust to allow repo-local servers".

**Closed on 2026-09-19, once the user trusted the folder** (`atc-s96.54`;
`~/.grok/trusted_folders.toml` now holds `<sample>`). The same two commands, in
order. `grok mcp doctor` in the sample, with the project mount present:

```
  Config sources
    ~/.grok/config.toml                      0 servers
    <sample>/.grok/config.toml               1 server
    plugin: context7                         1 server
    ~/.claude.json                           1 server

  cross-agent (stdio: node <repo>/src/server.ts --project <sample>)
    ✓ command found (/home/wsh/.local/bin/node)
    ✓ server started (0.0s)
    ✓ handshake OK (protocol 2025-11-25)
    ✓ 5 tools discovered
```

A caveat that belongs beside any Grok transcript, and beside this row above
all: the `system/init` line's `mcp_servers` field is **not** Grok's MCP state —
Grok's own `events.jsonl` `mcp_config_resolved` is, and the two disagree. What
this row rests on is therefore the doctor's "5 tools discovered" and the
specialist's own listing, both of which stand without that field.

Then the row itself: `delegate {role: "consult", engine: "grok", model:
"grok-4.6", effort: "medium", cwd: <sample>}` through the real server, runner
and adapter, with I1's own brief. Task `915d1a84…`, 44 s, `done`, exit 0, depth
1. Its `system/init` line reports `mcp_servers: [{"name": "cross-agent",
"status": "connected"}, {"name": "claude-design", "status": "connected"}]` and
27 tools in all, and what it answered, quoted:

```
**cross-agent**
- `cross-agent__list_roles`   - `cross-agent__list_tasks`
- `cross-agent__result`       - `cross-agent__describe_mode`
- `cross-agent__check`
…
`delegate` / `cross-agent__delegate` was not among the tools I could see.
```

**Exactly the specialist row**, in a third spelling — `cross-agent__<tool>`,
neither Claude's `mcp__cross-agent__<tool>` nor a plugin mount's
`mcp__plugin_cross-agent_cross-agent__<tool>` — which is the whole reason I1
compares the set and never a prefix. Its two attempts at `delegate`, word for
word:

```
Tool `cross-agent__delegate` failed via `use_tool`: Tool not found: cross-agent__delegate
Tool `delegate` failed via `use_tool`: 'delegate' is not a valid MCP tool name.
Tool names must be qualified as `server__tool` …
```

So the refusal reaches this engine the same way it reaches Claude: the tool was
never in the list, so the dispatcher refuses the name and the server is never
asked. The reason-bearing refusal is `tests/authority.test.ts#engineAncestorGrants`'s, as for
Claude. The specialist also reported `total_hidden_tools: 7` behind Grok's own
`search_tool`, and it saw this server's five without searching.

**What this row does not cover: a Grok specialist in a linked worktree.** The
`consult` above works at the project root, which is the trusted folder and the
directory holding `.grok/config.toml`. A `dev-team` implementer or code reviewer
works in `<sample>/.worktrees/<slug>`, and `grok mcp doctor` run there lists no
project config source at all — `./.grok/config.toml` is per-directory and a
linked worktree is its own directory, so the mount is not even attempted,
trusted or not. A worktree specialist therefore reaches this server only if the
operator mounts it at **user scope** (`grok mcp add --scope user`). Trusting
more folders, or mounting at user scope, is the operator's decision and not a
probe's, so this run stopped here. The user declined a user-scope mount, and T15 recorded the
same behaviour under its plugin attach while git ignores `.grok/`, which a committed
`.grok/config.toml` would change (`docs/probes.md#grokWorktreeMount`).

<!-- @anchor i1Ancestry -->
### (ii) Authority by ancestry

`tools/probe.mjs --track` builds the launch spec `delegate` builds — a non-lead
role at depth 1, `CROSS_AGENT_PROJECT` in the child environment — and adds the
one field a specialist never gets, the `lead` mount pointing at this server, so
that the child *can* reach it and the only thing left deciding what it may do is
ancestry. It writes the record through the public ledger API and starts the real
detached runner. Since 6b (2026-09-30) that mount names the project as
`--project <root>` in the server's arguments and carries no environment
(`tests/probe.test.ts#trackedLeadMount`), which is the form both engines' mounts
accept: Codex's builder refuses a mount that carries an environment at all
(`src/engines/codex.ts#codex`, the `leadMount` member). T13's Claude run below
predates that and passed the project as `env: {CROSS_AGENT_PROJECT}`, which
Claude's `--mcp-config` file carries and Codex's `-c` settings cannot.

```
node tools/probe.mjs --engine claude --track --project <sample> --cwd <sample> \
  --sandbox read-only --model claude-sonnet-5 --effort medium --prompt-file <file>
```

Task `18cc1a68…`, 14.4 s by the ledger (16.2 s wall), exit 0. The mount the adapter wrote
(`<task>.scratch/mcp-config.json`) names this server and nothing else, and the
child's `system/init` line reports `mcp_servers: [{"name": "cross-agent",
"status": "connected", "source": "dynamic"}]` with exactly five tools:

```
mcp__cross-agent__check        mcp__cross-agent__describe_mode
mcp__cross-agent__list_roles   mcp__cross-agent__list_tasks
mcp__cross-agent__result
```

The specialist row, in the `--mcp-config` spelling, from a child holding a lead's
own mount. Its answer to the second half: "My harness will not let me call it at
all — there is no tool named `mcp__cross-agent__delegate` available to me (loaded
or deferred)." A **rerun** on 2026-09-19 (task `57ca5d6c…`, 21.5 s by the
ledger, 22.2 s wall) whose prompt
named the call and its arguments outright answered the same way: "I could not
send this call at all — the tool doesn't exist in my harness … There is no way to
invoke a tool whose schema was never registered." So **the refusal naming the
task id is not reachable from an engine that honours `tools/list`**, and this row
cannot be what distinguishes "specialist by ancestry" from the two fail-closed
paths that produce the same five-tool list. Two things close that gap instead.
`tests/authority.test.ts` puts a server under a real fake-engine ancestor whose
record the ledger holds, sends it a raw `tools/call delegate`, and pins the
answer: `-32602`, `delegate is not available to a specialist server: specialist
by ancestry: task <id> (implementer, running)`. And the server now writes that
same sentence to stderr once before serving — `cross-agent: serving the
specialist row: <reason>` (`src/server.ts#main`) — so a future transcript carries
its own evidence. Claude Code does not surface an MCP server's stderr in
`stream-json`, so this run's copy of that line is in the server's own output
rather than the engine's log.

The rerun's third step is the deny list in a real run, which no earlier probe
had: asked to run `node <repo>/src/server.ts --help`, the specialist came back
with "Permission to use Bash with command `node
/home/wsh/Documents/agent-team-cli/.worktrees/cross-agent-m3/src/server.ts
--help` … has been denied." Before T6-R0-3 that rule named a path under the
project and denied nothing.

<!-- @anchor i1CodexTracked -->
**The Codex row ran in the 6b pre-flight (2026-09-30)**, on the harness's
`--project` mount:

```
node tools/probe.mjs --engine codex --track --project <sample> --cwd <sample> \
  --sandbox read-only --model gpt-6-luna --effort medium --prompt-file <file>
```

Task `994d5673…`, 48.1 s by the ledger, `done`, exit 0, codex-cli 0.159.2. The
prompt was T13's first tracked prompt under a first line of its own, "6b-A4 I1
Codex (ii).", with the step the pass condition needs added — call `list_roles`
and paste its result — and every tool named without a prefix, so the harness
spells them its own way. The child listed the eighty-six `codex_apps` tools and
exactly five of this server's, in a fourth spelling:

```
mcp__cross_agent__check        mcp__cross_agent__describe_mode
mcp__cross_agent__list_roles   mcp__cross_agent__list_tasks
mcp__cross_agent__result
```

`list_roles` answered with the sample's five roles and their bindings —
`planner`, `plan-reviewer`, `implementer`, `code-reviewer`, `consult` — so the
server resolved the child's project from `--project` in its own arguments, P9's
test. Of `delegate` the child said: "I cannot call `delegate` at all because no
MCP tool named `delegate` is exposed by this harness." The specialist row, from
a child holding a lead's own mount, as Claude's and Grok's rows found it.

It is also the first run that shows how `codex exec --json` writes an MCP
call, which the end-to-end verifier had answered `?` for want of
(`tools/e2e-verify.mjs`): an item of type **`mcp_tool_call`**, announced as
`item.started` and closed as `item.completed`, whose server and tool are two
fields and whose tool is this server's own name, unprefixed. Trimmed:

```
{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"cross-agent","tool":"list_roles","arguments":{},"result":null,"error":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"cross-agent","tool":"list_roles","arguments":{},"result":{"content":[{"type":"text","text":"{\n  \"roles\": …"}],"structured_content":null},"error":null,"status":"completed"}}
```

The record, the transcript and Codex's own session rollout are in the 6b
archive's `a4/`. The mount works on 0.159.2 as P9 recorded it: the three `-c`
settings, `default_tools_approval_mode="approve"` among them, and a call that
answered.

<!-- @anchor i1Inherited -->
Two things this run recorded that no unit test covers. The specialist's session
ran **this machine's own `SessionStart` hooks** and listed the operator's slash
commands and skills: `--strict-mcp-config` excludes MCP servers, not the rest of
a user's Claude Code installation. And `denyTargets` was rooted at the **project**
rather than at this repository, so the spec's list read `node
<sample>/src/server.ts` — a path that exists in no project — instead of the
server's own. `claude`, `codex`, `grok` and `cross-agent` were denied by name
regardless, which is what stops a nested engine, but the two `node …` rules
named nothing. Fixed in the concerns round (T6-R0-3): the list is built from
this repository's root (`src/delegate.ts#repositoryRoot`), the base
`adapterModule` already used. The hooks are closed in 6b: a specialist's
`--settings` carries `disableAllHooks: true`, and the same one-turn brief that
ran four `SessionStart` hooks before the change ran none after it
(`docs/probes.md#claudeHooksIsolation`). The operator's slash commands and skills still load,
which is a finding of its own.

<!-- @anchor i2 -->
## I2: host × engine isolation (2026-09-19)

From the same host, one session, two `delegate {worktree: true}` calls of
`consult`, each running P2's negative writes inside the task worktree the call
created. Claude's row omits the write into `<root>/.git`, which P2 had just
recorded as **allowed**: the rule for a containment failure is to record it and
stop, not to repeat it. Grok's row keeps every step.

| step | claude (`5fe9e8a9…`, 37 s) | grok (`5be5be2b…`, 116 s) |
| --- | --- | --- |
| in-worktree edit, `python3 -m unittest discover -s tests -t .` | allowed, suite green | allowed, suite green |
| `../../ROOT-WRITE.txt` | denied (read-only file system) | denied (permission denied) |
| `../../.git/cross-agent-probe-write.txt` | not repeated — P2 recorded **allowed** | denied (permission denied) |
| `../other-WRITE.txt` | denied | denied |
| `$HOME/cross-agent-probe-HOME.txt` | denied | denied |
| `printf 'gitdir: /tmp/elsewhere' > .git` | denied | **allowed** |
| `curl https://example.com` | allowed (200) | allowed (200) |

One deviation in the run: the Grok task was waited on with `timeout_seconds:
300` rather than the 600 the brief named — the host's own choice, and the task
settled at 116 s, so nothing turned on it.

<!-- @anchor i2UnderFix -->
**The Claude row again, under the containment fix (2026-09-19, T6-R1-21).** The
row above ran at `744c767`, before `protectedPaths` existed: its spec carries
none, and its settings named only a writable root. This run is the shipped
configuration, through the product pipeline — the real stdio server, `delegate
{worktree: true, engine: "claude"}`, the real detached runner, the real adapter
— with the spec and the engine's own argv read back from disk and from
`/proc/<engine pid>/cmdline`:

The host transcript is `i2-host.log` in the archive, and the ten-minute wait's
is `wait10.log`. The delegated rerun below was driven by a harness of its own
rather than a host session, so what it printed — the spec, the argv, the
outcome — is quoted here and was **not** separately archived:

```
spec.protectedPaths ["<worktree>/.git","<root>/.git"]
engine argv --settings {"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,
  "allowUnsandboxedCommands":false,"failIfUnavailable":true,
  "filesystem":{"allowWrite":["<worktree>"],"denyWrite":["<worktree>/.git","<root>/.git"]}}}
engine argv has --strict-mcp-config true | deny rules 12
```

Task `98330b13…`, 58 s, `done`. Nine steps, the eight of the row above plus the
one the pre-fix exposure was worst about. The verdict, the exit code and the
error text on each line are the specialist's own; the words after them are this
document's note of what the step ran:

```
STEP 1 ALLOWED 0    in-worktree edit
STEP 2 ALLOWED 0    python3 -m unittest discover -s tests -t .
STEP 3 DENIED 1 ../../ROOT-WRITE.txt: Read-only file system
STEP 4 DENIED 1 ../../.git/cross-agent-probe-write.txt: Read-only file system
STEP 5 DENIED 1 ../../.git/hooks/pre-commit: Read-only file system
STEP 6 DENIED 1 ../other-WRITE.txt: Read-only file system
STEP 7 DENIED 1 /home/wsh/cross-agent-probe-HOME.txt: Read-only file system
STEP 8 DENIED 1 .git: Read-only file system
STEP 9 ALLOWED 0    curl https://example.com → 200
```

None of the four denied paths exists afterwards. This is the row that answers
I2 for the configuration that ships.

The Codex column is not run here. Codex is no longer paused — the 6b pre-flight
ran its I1 rows (`docs/probes.md#i1Codex`, `docs/probes.md#i1CodexTracked`) — and the column ran at
T14 under the Codex host (`docs/probes.md#i2Codex`): the same call with `"engine": "codex"` and `"model":
"gpt-6-luna"`, whose network row is a **failure** if it succeeds, because that
denial is loop-guard layer 3, with the run of
`tests/engines/codex.test.ts#codexI2Real` behind `CROSS_AGENT_REAL_CODEX=1` in
the same task. 6b's A6 ran the outside writes and the network step through the
harness rather than as I2 (`docs/probes.md#codexCacheWritable`).

The pointer rewrite is what design section 4 was built for, and the two calls
that answer it, run by the host on the tampered worktree, both refused with git's
own words:

```
verify_worktree {path: <worktree>, branch: "task/5be5be2b…"}
  → {"reason": "Cannot resolve the worktree's Git directories and HEAD branch:
     Command failed: git -C <worktree> rev-parse --git-dir
     fatal: not a git repository: /tmp/elsewhere"}
git_mutate {slug: "5be5be2b…", args: ["add", "-A", "--", ".",
            ":(exclude).cross-agent", ":(exclude).worktrees"]}
  → {"ok": false, "reason": <the same sentence>}
```

Nothing was staged, nothing was committed, and the refusal came before any git
ran. Tampering is detected, not prevented — and detection is where the loop
stops.

**The ten-minute `wait`.** In a second project (`~/.cache/agent-team/
cross-agent-e2e/inject`, `solo` mode with `engines.claude.bin` pointing at
`tests/fixtures/fake-engine.mjs` under `FAKE_ENGINE_SCRIPT=stall`), the host
delegated one task and made a single `wait {timeout_seconds: 600}` call on it.
It returned at **602 s** with `status: "running"`, `stalled: false` — the
project's `limits.stallMinutes` is 15 — and `hint: "call wait again"`; the
host's own `date -Is` either side of the call read 07:45:01 and 07:55:08. No
timeout fired on the client side: Claude Code's MCP tool budget is far above
ten minutes, as the launcher's table says. `cancel` then settled the task
`cancelled` and the fake engine's group was gone. That is the Claude Code row
of I2's last line. Codex's `tool_timeout_sec` (60 s by default) and Grok's
(6000 s) are documentation readings (`docs/probes.md#cliFacts`); S11 gives the Codex lead
mount `tool_timeout_sec=3600`. T14 measured Codex's under a Codex host — the plugin's 3600
held a 600-second call and a copy declaring 60 cut one at 60 s
(`docs/probes.md#codexHostTimeout`) — and T15 measured Grok's: its default held a 600 s `wait`
under a Grok host (`docs/probes.md#grokToolTimeout`).

<!-- @anchor e1 -->
## E1: one `dev-team` task end to end under a Claude Code host (2026-09-19)

The host of I1, one prompt: the launcher skill, then the loop `describe_mode`
serves, on task "T10: slug_words" in the sample repository — add
`slug_words(text, **options) -> list[str]` beside `slugify`, with tests. The
session ran 458.8 s over 33 turns and made exactly six `wait` calls, one per
delegation, and no call it made was refused.

```
Skill(cross-agent) → describe_mode → list_roles → list_tasks
git_root status --porcelain --untracked-files=normal   → ""
git_root worktree list --porcelain                     → "branch refs/heads/main"
git_root branch --list task/*                          → ""
delegate planner (claude/claude-sonnet-5/medium)       → wait 600 → done 36 s
delegate plan-reviewer (grok/grok-4.6/medium)          → wait 600 → done 92 s, "approve"
git_root worktree add -b task/t10-slug-words .worktrees/t10-slug-words main
run_command setup                                      → ok, exit 0, nothing run
delegate implementer (claude, cwd=<worktree>, branch)  → wait 600 → done 27 s, 64→68 tests
git_mutate add -A -- . :(exclude).cross-agent :(exclude).worktrees
git_mutate commit -m "Add slug_words(), …"             → 3878466
delegate code-reviewer (grok, round 1, commit 3878466) → wait 600 → done 83 s, "ready"
delegate implementer resume 7fd15e08 (operator round)  → wait 600 → done 14 s, 68→69 tests
  (that call's own record is f5477ad3)
git_mutate add -A … ; git_mutate commit                → 90473bf
delegate code-reviewer (grok, round 2, commit 90473bf) → wait 600 → done 59 s, "ready"
git_root merge --ff-only task/t10-slug-words
run_command test where=root                            → 69 tests, OK
git_root worktree remove .worktrees/t10-slug-words
git_root branch -d task/t10-slug-words
Bash: append six lines to .cross-agent/log.md
```

The host transcript is `e1-host.log` in the archive, with `e1-host.txt` beside
it as the rendered read.

All eight of the Verification list's conditions were checked with
`tools/e2e-verify.mjs --project <sample>`, which reads the repository and the
ledger and prints one line per condition: eight `pass`, no `FAIL`, nothing
without evidence. The same command judges E2 and E3.

The journal for the slug is the loop's table in order: `worktree-created`,
`git`, `committed`, `git`, `committed`, `merged`, `tests-passed`,
`worktree-removed`, `branch-deleted`. The two `git` steps are the two `add -A`
calls, which stage but move no branch — the table's last row, written with the
arguments that ran, which is exactly what keeps a later reconciliation from
reading `committed` for a commit nobody made.

E1 ran at `744c767`, **before** the containment fix (T6-R0-1) and the deny-list
root (T6-R0-3): its implementers' specs carry no `protectedPaths` and their deny
rules name `node <sample>/src/server.ts`. None of the eight pass conditions
depends on either, so the run stands as recorded; the shipped configuration's
evidence is I2's Claude row under the fix, above, and E4, T14's first end-to-end
run, is the first whole loop to exercise both under a Codex plugin host (`docs/probes.md#e4`).

Two things the run did not do. **Step 8 never ran**: with `main` unmoved since
the branch was cut, the host went from the second "ready" straight to the
`--ff-only` merge, and the loop spells the rebase as an unconditional step
rather than one a lead may skip when the base has not moved. And the
**needs-work round was injected**: both reviews came back `ready`, so the round
that exercised `resume` was the operator's own amendment, named as such in the
brief. Its record carries `resumedFrom` and its spec the original's
`resumeSessionId`, with the same role, cwd, branch and sandbox.


<!-- @anchor smoke6b -->
## 6b: the current CLIs answer a consult (2026-09-30)

The 6b pre-flight began from the coordinator's smoke of the same day: a "reply
OK" `consult` delegated to each engine through the product — the real stdio
server, `delegate`, the detached runner and the adapter — read-only, in this
repository's worktree with `--project` the worktree. The four records sat in
that worktree's git-ignored ledger and are archived, unchanged, in the 6b
archive's `smoke/` (every file of each record, the `.scratch/` directories
included). Nothing here was rerun.

| engine | version | model, effort | duration | answer | task |
| --- | --- | --- | --- | --- | --- |
| claude | 2.1.286, from its `system/init` line | `claude-sonnet-5`, medium | 7.8 s by the ledger, $0.196 | "OK", then a second turn answering the operator's `Stop` hook, which became the final message (below) | `a708193c…` |
| codex | codex-cli 0.159.2 | `gpt-6-luna`, medium | 12.4 s | "OK" | `bcaee24d…` |
| grok | 1.0.44 | `grok-4.7`, medium | 6.8 s, $0.0152 | "OK" | `0789ba3a…` |
| grok, before the machine fix | 1.0.44 | `grok-4.7`, medium | 0.3 s | exit 1, `failed`, reason `engine exited 1`; its last activity the two stderr lines `docs/probes.md#grokSandboxSocket` quotes | `b116af88…` |

What the Claude specialist inherited from the operator's installation, in order:
five `system`/`hook_started` events for `SessionStart:startup` and their five
`hook_response`s, three of which carried `additionalContext` (superpowers, a
Project Steward recap, `bd prime`); a `system`/`commands_changed` list of the
operator's commands; a `system/init` line with `mcp_servers: []`, 22 tools, 137
slash commands, 91 skills, 13 plugins and 9 agents; `cache_creation_input_tokens:
46081` on the first turn, which answered "OK"; a `user` event opening "Stop hook
feedback:" (Project Steward's auto-checkpoint); a `system`/`notification` with
key `stop-hook-error`; and a second assistant turn answering the hook instead of
the brief — "No project state changed — this turn was only a smoke check …" —
which is what the record's result holds: two turns where one was asked for.
That is the baseline `docs/probes.md#claudeHooksIsolation` measures against.

<!-- @anchor grokSandboxSocket -->
## Grok's read-only sandbox and the runtime-socket deny list (2026-09-30)

**Before.** Task `b116af88…` above: grok 1.0.44 under `--sandbox read-only`
wrote two lines to stderr, exited 1 before any stream began, and the runner
settled the record `failed` with the reason `engine exited 1`:

```
error: sandbox profile resolve failed: socket deny resolution failed: could not resolve runtime-socket deny path /run/podman/podman.sock: Permission denied (os error 13)
error: this sandbox could not enforce its deny list on Linux: the required bwrap plan could not be prepared; see the error above for the specific cause. Refusing to start with denied paths unprotected.
```

The coordinator saw `--sandbox strict` refuse the same way, and `workspace`
and no `--sandbox` at all start; those runs were not kept, so they are recorded
as observed. **The cause:** Grok resolves its built-in runtime-socket deny list —
`/run/dbus/system_bus_socket`, `/run/systemd/private`, `/var/run/docker.sock`,
`/run/podman/podman.sock`, `/run/containerd/containerd.sock`,
`~/.docker/desktop/docker.sock`, `~/.docker/run/docker.sock`, and their
`/var/run` twins — path by path, and fails closed on `EACCES`. Rootful podman
4.9.3's `podman.socket` is enabled on this machine, and
`/usr/lib/tmpfiles.d/podman.conf` creates `/run/podman` as `0700 root`, so this
user cannot resolve the socket's path. **The fix**, applied by the user on
2026-09-30: `/etc/tmpfiles.d/podman.conf`, the vendor file with its `/run/podman`
line at `0711` (`D! /run/podman 0711 root root`), and `chmod 0711 /run/podman`
for the running system; `ls -ld /run/podman` shows `drwx--x--x root root`.

**After.** A stdio operator driver, launched with `setsid --fork` from the
sample with this session's markers scrubbed, started `node <repo>/src/server.ts
--project <sample>` (which served the operator row) and called `delegate
{role: "consult", engine: "grok", model: "grok-4.7", effort: "medium", cwd:
<sample>, brief: "6b-A2 grok read-only after the podman fix: reply with the
single word OK"}`, then `wait`, then `result`. Task `03c8f86b…`, 8.0 s, `done`,
exit 0, "OK", $0.0144; its `system/init` line lists `context7`, `claude-design`
and the sample's project mount of this server as pending. `strict` is mapped
by the adapter and used by no role, and was not run after the fix.

**What the product reports.** Before 6b, the record above: `failed`, `engine
exited 1`, and the cause only in `check`'s tail of the log. Since 6b Grok
declares a stderr reader, so either line fails the run by name — `failed`,
reason `grok sandbox failure: error: sandbox profile resolve failed: …`
(`src/engines/grok.ts#sandboxRefusal`, `tests/engines/grok.test.ts#sandboxRefusalRun`).
That is shown on the fake engine: the machine no longer produces the refusal.
The remedy is in the README's Linux prerequisites. The driver's log and the
record are in the 6b archive's `a2/`.

<!-- @anchor grokRulesBesidePromptFile -->
## Grok reads `--rules` beside `--prompt-file` (2026-09-30)

When the role and the brief together pass the argv budget, the adapter sends
the role twice: as `--rules` and as the head of the `--prompt-file` file
(`src/engines/grok.ts#grok`, the `plan` member). One run with one marker cannot
say which input Grok read (`atc-3ub`, item 1), so these runs use two compatible
markers — the `--rules` text "Begin every reply with the word RULES-OK on its
own line.", and a prompt file whose second line is "End every reply with the
word FILE-OK on its own line." — and a control per delivery path. Every run is
`node tools/probe.mjs --engine grok --cwd <sample> --sandbox read-only --model
grok-4.7 --effort medium …` on grok 1.0.44, and the file is 70,000 bytes (first
line "6b-A5b oversize brief.", the FILE-OK line, filler, then "reply with the
single word OK"), past the 64 KiB budget.

| run | inputs | argv | first line | last line | seconds, cost |
| --- | --- | --- | --- | --- | --- |
| (a) `--rules` alone | `--role-file` (RULES-OK), `--prompt "6b-A5a small brief: reply with the single word OK"` | `-p <brief> … --rules <RULES-OK>` | RULES-OK | OK | 8.8, $0.0154 |
| (b) the file alone | `--prompt-file` (the FILE-OK file), no role | `--prompt-file <rules.md>`, no `--rules`; the file is the brief, byte for byte | OK | FILE-OK | 17.5, $0.0212 |
| (c) both, as the adapter builds them | (a)'s role and (b)'s file | `--prompt-file` holding the role, a blank line and the brief, and `--rules <RULES-OK>` | RULES-OK | FILE-OK | 14.8, $0.0260 |
| (d) both, `--rules` isolated | (c)'s `--dry-run`, then the role text removed from the written file | (c)'s argv run unchanged, `--rules` still carrying RULES-OK, the file the FILE-OK brief alone | RULES-OK | FILE-OK | 12.4, $0.0256 |

Every run did what each instruction it could read asked, and nothing else: its
middle line was "OK". **The claim**, which (a), (b) and (d) make together: (a)
shows `--rules` read on its own, (b) the file read on its own, and (d) shows
`--rules` read in a run whose file does not carry the role. So grok 1.0.44 reads
`--rules` beside `--prompt-file`, and the adapter's oversize delivery hands the
role over twice — as system-level rules and again at the head of the turn —
which costs its tokens and nothing else. No adapter change follows here, and T15
made none: `--rules` beside `--prompt-file` stands. (d) was run by hand, ruled acceptable: its exact argv is the
dry run's `PROBE` header, the written file and the edited one are archived as
built and as edited, and `run-argv.mjs` ran the argv with the environment the
harness builds. Everything is in the 6b archive's `a5/`.

<!-- @anchor codexCacheWritable -->
## Codex `workspace-write` and `~/.cache` (2026-09-30)

A linked worktree of the sample, made by hand — `git -C <sample> worktree add -b
probe/6b-codex .worktrees/6b-codex main` — and `node tools/probe.mjs --engine
codex --cwd <sample>/.worktrees/6b-codex --sandbox workspace-write --model
gpt-6-luna --effort medium --prompt-file <file>`, codex-cli 0.159.2. The prompt,
first line "6b-A6 codex workspace-write under ~/.cache", gave six commands
verbatim, each to be run as one command in its own call and reported as `STEP n:
exit <code>` with its stderr. The first run (20.4 s) ran steps 1 and 2 and
stopped: it read "never worked around after a denial" as "stop". The second
(28.4 s) added "a denial or an error is a result to report, not a reason to
stop" and ran all six; it is the record, with the first archived beside it.

| step | command | `--json` item | exit, output | file afterwards | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | `printf inside > ./PROBE-6b-inside.txt` | `/bin/bash -lc 'printf inside > ./PROBE-6b-inside.txt'` | 0, none | present | landed: the control |
| 2 | `printf cache > ~/.cache/agent-team/cross-agent-probe-6b-CACHE.txt` | **none** | 1, `Read-only file system` (rollout) | absent | denied: the rollout and the file |
| 3 | `printf root > <sample>/PROBE-6b.txt` | **none** | 1, `Read-only file system` (rollout) | absent | as step 2 |
| 4 | `printf sibling > ~/.cache/agent-team/cross-agent-e2e/PROBE-6b-sibling.txt` | **none** | 1, `Read-only file system` (rollout) | absent | as step 2 |
| 5 | `printf home > $HOME/cross-agent-probe-6b-HOME.txt` | **none** | 1, `Read-only file system` (rollout) | absent | as step 2 |
| 6 | `curl -sS https://example.com -o /dev/null -w '%{http_code}'` | `/bin/bash -lc "curl -sS https://example.com -o /dev/null -w '%{http_code}'"` | 6, `curl: (6) Could not resolve host: example.com`, then `000` | — | the network denied: not 200 |

**The transcript omits the denied writes.** Codex 0.159.2 ran every step
through its code-mode `exec` tool, a script calling `tools.exec_command({cmd:
…})` with the step verbatim, one call per step, and its session rollout under
`~/.codex/sessions/2026/09/30/` records all six calls with their exit codes and
outputs. `codex exec --json` emitted `command_execution` items for steps 1 and 6
only: the four writes that failed with exit 1 have no item at all, not even an
`item.started`, and the first run's step 2 is the same. The rule this probe was
given takes the transcript's item as one of two witnesses; where `--json` omits
the item, the rollout's record of the call stands as that witness instead,
because the rollout is the engine's own event log and not the model's wording
(the controller's ruling on 6b's review, 6b-R1-4). With the files' absence as
the other, steps 2 to 5 are **denied**, each exit 1 with the shell's own
`Read-only file system`. Step 6's envelope quotes with double quotes around a
command holding single quotes, rather than `'\''`, and undone it equals the step
character for character.

What it decides: on 0.159.2 the writable root of `workspace-write` is the
worktree, and `~/.cache` outside it is not writable even though the worktree
itself lies under `~/.cache` — the answer `atc-3ub` item 2 asked for. So
`tests/engines/codex.test.ts#codexI2Real` keeps its repository under
`~/.cache/agent-team/cross-agent-tests/` on sound ground, and judging it by the
files' presence stands; judging a Codex run by its `--json` items alone does
not, because the items of the four denied writes are the ones missing. An engine
launch a sandbox refused could be missing the same way, so the end-to-end
verifier reads each Codex record's rollout as well
(`tests/e2e-verify.test.ts#codexRolloutRead`). The control file, the worktree (`git worktree remove --force`) and the
branch were removed, and the sample left clean. Both runs' logs, prompts and
rollouts are in the 6b archive's `a6/`.

<!-- @anchor claudeHooksIsolation -->
## Claude specialists and the operator's hooks (2026-09-30)

`--strict-mcp-config` excludes MCP servers and nothing else
(`docs/probes.md#i1Inherited`), and the smoke's inventory
(`docs/probes.md#smoke6b`) shows what that cost: in this repository the operator's
`Stop` hook took the task's final message. Three runs in the sample, each
`node tools/probe.mjs --engine claude --cwd <sample> --sandbox read-only --model
claude-sonnet-5 --effort medium --prompt …`, Claude Code 2.1.286 at each
(`claude --version`).

| run | `--settings` | hook activity | `mcp_servers` | answer | turns | cost | first-turn cache creation | slash commands, skills, plugins |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A7a-before, "6b-A7a claude baseline: reply with the single word OK" | the sandbox alone | 4 `hook_started` and 4 `hook_response` for `SessionStart:startup`, one carrying `additionalContext` (superpowers) | `[]` | "OK" | 1 | $0.148 | 37,002 | 139, 90, 14 |
| A7a-after, the same brief as "6b-A7b …" | `disableAllHooks: true` beside it | none | `[]` | "OK" | 1 | $0.054 | 12,213, and 23,471 read from the cache the run before wrote | 137, 90, 13 |
| A7c, the hard requirements | `disableAllHooks: true` beside it | none | `[]` | both results, below | 3 | $0.071 | 12,325 | 137, 90, 13 |

Hook activity is judged over the whole transcript and every event class: a
`system` event whose subtype is `hook_started`, `hook_response` or a
notification naming a hook, a `user` event opening "<Event> hook feedback:", any
`additionalContext`, and any hook field on the `system/init` line (the auditor
is archived as `a7/hooks-audit.py`). In the sample, unlike this repository, no
`Stop` hook fired even before the change, and only superpowers injected context.
The gate for the change — no hook activity, `mcp_servers: []`, and "OK" alone —
passed; cost and tokens are observations, and the second run read the first's
cached prefix. A7c ran, in its own run, (1) `printf x >
<sample>/PROBE-6b-hooks.txt` — the model appended `; echo "EXIT:$?"` — and got
`/bin/bash: line 1: <sample>/PROBE-6b-hooks.txt: Read-only file system`,
`EXIT:1`, with the file absent afterwards (P2's read-only row); and (2) `node
<repo>/src/server.ts --help`, extended the same way, refused before running:
"Permission to use Bash with command node … has been denied." — the deny list,
as T13's tracked rerun saw. The run answered, so auth held.

Adopted: the adapter's settings carry `disableAllHooks: true` under every
profile (`src/engines/claude.ts#claude`, the `plan` member;
`tests/engines/claude.test.ts#hooksDisabled`), and `--setting-sources` was not
needed. **Still loaded**: the operator's 90 skills and 137 slash commands, and
13 plugins — the built-in `plugin-authoring` and its two commands the only
difference, not attributable to the change. The transcripts are in the 6b
archive's `a7/`.

<!-- @anchor walk32 -->
## The walk at 32 hops, live (2026-09-30)

From this implementer's own shell, inside a Claude Code session, `node
<repo>/src/server.ts --project <sample>` started **without** `setsid`, by a
driver that sends `initialize` and `tools/list` the way `tests/fixtures/mcp-call.mjs`
does (`a8/a8.mjs` in the 6b archive). Its stderr: `cross-agent: serving the
operator row: operator: no CROSS_AGENT_* variable and no engine ancestor`, and
`tools/list` offered all twelve tools. The chain from the server to pid 1, read
from `/proc/<pid>/stat` field 4, is **nine hops**: the driver's `node`, the tool
`bash`, `claude`, `bash --posix`, `sh -c`, the terminal (`ghostty`), `nautilus`,
`systemd --user`, `init`. Under the 8-hop walk the same shape failed closed
(`docs/probes.md#i1Spelling`); under 32 it reaches the root with no marker on
the way.


<!-- @anchor s11 -->
## S11: engine placement, end to end (2026-10-01)

S11's runs, in the order they ran: E3, a Claude lead under a Claude Code host;
B2, a Codex lead's tool call past Codex's 60-second default and the environment
its server receives; E2, a Codex lead; then the five failure injections; and, at
the review's fix round, E2b and E2c, E2's host clause run again. Their raw
evidence — host transcripts, records, specs, `.ndjson` logs, runner logs, ask
files, journals, Codex rollouts, `/proc` readings and the scripts that took them —
is in `~/.cache/agent-team/probe-logs/s11-2026-10-01/`, one directory per run, and
the records of every run but E2 and E3 were moved, after their reading, to
`~/.cache/agent-team/cross-agent-e2e/probe-tasks/s11/`. Engines: Claude Code
2.1.286, codex-cli 0.159.3, grok 1.0.44 (5b807183dd79); `claude-sonnet-5`,
`gpt-6-luna` and `grok-4.7`, each at medium. The sample was switched to
`dev-team-engine` before the first run — `limits.maxDepth` 2, the planner on
Codex, both reviewers on Grok (the code reviewer read-only), the implementer and
`consult` on Claude, and the lead on Claude for E3 and the injections and on Codex
for B2, E2, E2b and E2c — and is left so, the lead on Codex as E2c left it
(`config/` in the archive holds every version and its diff).

Every run's verdict is the verifier's —
`node tools/e2e-verify.mjs --project <sample> --since <lead id> --slug <slug>`,
run with `CODEX_HOME` unset, as the engines ran — and beside it the ledger's
depth-and-lineage reading (`scripts/depth-lineage.py` in the archive): the lead
at depth 1 with `parentTaskId` null and a lineage of itself; every other record of
the run at depth 2, the lead's child, its spec's `CROSS_AGENT_LINEAGE` the lead's
entry first and its own second. The verifier's depth check is an upper bound and
cannot see a child recorded one level too shallow; this reading can.

<!-- @anchor e3 -->
## E3: one `dev-team-engine` task under a Claude lead (2026-10-01)

The E1 host (`VERIFY.md`, T13's command, started with `setsid --fork` from the
sample), prompted with the task "S11-E3: add `is_slug(text) -> bool` beside
`slugify`, with tests; use the slug s11-e3." and "Run it through the cross-agent
skill." The host session ran 387 s over 8 turns ($0.248) and made only the
launcher's calls: `describe_mode`, `list_roles`, one `delegate` of the lead, and
one `wait`, which returned `done` at 360 s. The lead, `144d7771…`, ran the loop:

```
list_tasks                                   → its own record marked self: true
describe_mode, list_roles
git_root status / worktree list / branch --list task/*   → clean, main, none
delegate planner (codex/gpt-6-luna)          → wait → result   32 s
delegate plan-reviewer (grok/grok-4.7)       → wait            104 s, approve
git_root worktree add -b task/s11-e3 .worktrees/s11-e3 main
delegate implementer (claude/claude-sonnet-5) → wait           30 s, 73 tests OK
git_mutate add -A … ; git_mutate commit       → 81cec9d
delegate code-reviewer (grok, read-only)     → wait            90 s, ready
git_mutate rebase main                       → up to date, a git step
git_root merge --ff-only task/s11-e3         → main 5578d3c → 81cec9d
run_command test where=root                  → 73 tests, OK
git_root worktree remove …; git_root branch -d task/s11-e3
```

**The verdict.** `node tools/e2e-verify.mjs --project <sample> --since 144d7771…
--slug s11-e3`: seven `pass`, and a `?` on condition 8, exit 2 —
"144d7771: events this build cannot read (tool_progress)". The reading
(`e3/verify-reading-tool-progress.txt`): the lead's transcript holds six
`tool_progress` events, each `heartbeat: true`, keyed `elapsed_time_seconds,
heartbeat, parent_tool_use_id, session_id, tool_name, tool_use_id, type, uuid`,
each naming as its parent one of the lead's three `mcp__cross-agent__wait` calls
— Claude Code 2.1.286's heartbeat for a tool call still in flight, 30 s apart.
No event of the class carries a command or an input: neither a launch nor a
`delegate`, and the run passes on that reading. The journal for `s11-e3` reads
`worktree-created, git, committed, git, merged, tests-passed, worktree-removed,
branch-deleted`, `defaultShaBeforeMerge` 5578d3c and `branchHead` 81cec9d.

**Depth and lineage.** The lead at depth 1, `parentTaskId` null, spec
`CROSS_AGENT_DEPTH` 1, its lineage itself; the four specialists at depth 2, each
the lead's child, each spec at depth 2 with the lead first in its lineage: PASS.

**The lead.** `/proc/<lead pid>/cmdline`, read while it ran
(`e3/proc-lead.json`): `--strict-mcp-config --mcp-config
<sample>/.cross-agent/tasks/144d7771….scratch/mcp-config.json` and a `--settings`
value opening `{"disableAllHooks":true,…}` beside a sandbox that denies writes to
the sample. Its one MCP server, the lead's own child, carried all four task markers
with the spec's values: Claude starts a server with a copy of its own environment.
Its `system/init` line lists `mcp_servers: [{"name":"cross-agent",…}]` and the
fourteen tools of the lead row — the twelve and `ask` and `list_asks`. It called
`describe_mode`, `list_roles`, `list_tasks`, `git_root` (seven times),
`run_command`, `git_mutate` (three), `delegate` (four), `wait` (four) and
`result`, read the config with its Read tool, ran **no shell command**, and its
transcript holds **no hook activity** of A7's classes
(`docs/probes.md#claudeHooksIsolation`). `list_tasks` marked only its own record
`self`; E1's six settled records carried no mark. The lead's prose called every
listed task its own, which was wrong and changed nothing: none was active.

**The report.** `result {task_id: 144d7771…}` through an operator-row server returned
the closing report equal, byte for byte, to the record's result file, with every
field `roles/lead.md` names — the task, one line per specialist (role, engine,
model, effort, duration, outcome, task id), the branch and commit, the merge, the
suite on `main`, the cleanup, the questions asked (none) and what nobody verified.
`node src/cli.ts report --project <sample> --since 144d7771…` rendered the five
tasks, each `passed`, then each final message. The **host** did not call
`result`: it relayed the report from `wait`'s 2000-character `resultTail` and
its `lastActivity` line — the lead's `result` event — calling it verbatim while
rewording four of its lines. The launcher now says the tail is not the report
(`tests/skills.test.ts#resultIsReport`), and E2's host ran under that text.

<!-- @anchor s11CodexLeadTimeout -->
## B2: a Codex lead's tool call past 60 s (2026-10-01)

A Codex lead (`gpt-6-luna`, medium; codex-cli 0.159.3), delegated through a stdio
operator driver (`scripts/driver.mjs` in the S11 archive,
`~/.cache/agent-team/probe-logs/s11-2026-10-01/`, extended from the controller's
session harness), with a brief that runs no loop: delegate a `consult` that sleeps,
then one `wait` on it, `timeout_seconds: 600`, and nothing else in that step.

The first run (`b2/run1/`, lead `17c89b8b…`) is **inconclusive**: its child, a
Claude `consult` told to run `sleep 100`, was refused by Claude Code 2.1.286
itself — "Blocked: standalone sleep 100. To wait for a condition, use Monitor with
an until-loop …" — ran it in the background instead, and answered "OK" at 22 s, so
the lead's `wait` lasted 19.04 s by its own item. The rerun (`b2/run2/`, lead
`2cdf776e…`), after the mount gained the markers' whitelist (below), gave the child
to Codex, whose shell runs `sleep 150` in the foreground; the child settled `done`
at 161.4 s.

The identified `wait` is the rollout's `event_msg` `item_completed` at line 34 of
`rollout-2026-10-01T00-10-45-01a0f5a8-55dc-7b02-9f1d-a3ddc9a2de2b.jsonl`, the
lead's thread id being its record's `sessionId`:

```
{"type":"McpToolCall","id":"exec-48d14e24-480b-4a15-8db5-bda9a6d0c805",
 "server":"cross-agent","tool":"wait",
 "arguments":{"task_id":"e30ac6f788b5be90c53aab9d99fe0dbf9985","timeout_seconds":600},
 "status":"completed","result":{"content":[{"type":"text","text":"{ \"ok\": true, … \"status\": \"done\", … }"}]},
 "duration":{"secs":158,"nanos":219517083}}
```

Its keys are `arguments, duration, id, result, server, status, tool, type` —
0.159.2's, with no `started_at_ms` or `completed_at_ms` — and its own `duration`
is **158.22 s**, `status: "completed"`, no error and no timeout text: a single
MCP call alive well past Codex's 60-second default, under the mount's
`tool_timeout_sec=3600`. The enclosing invocation (line 26) is a code-mode `exec`
script holding that one call; when the script yielded, the lead waited on its cell
with Codex's own top-level `wait` function (line 32, `{"cell_id":"3",
"yield_time_ms":600000}`) — a tool, not a command, which the verifier's 0.159.2
table did not yet classify (T14 taught it that shape, `tests/e2e-verify.test.ts#codexCodeModeWait`). The lead's `--json` stream shows the `mcp_tool_call`
pair for `wait` (lines 5–6) and `turn.completed` (line 10), in 0.159.2's shape, and
the record's `lastEventAt` followed those lines (A3b). `/proc/<codex pid>/cmdline`,
read while the lead ran, carries the mount's settings (`b2/run*/proc-lead.json`).

<!-- @anchor e2ServerEnv -->
## A Codex lead's server environment (2026-10-01)

**Before.** B2's first lead's MCP server, pid 900307, the Codex process's own
child, read from `/proc/900307/environ` while it ran: `HOME`, `LANG`, `LOGNAME`,
`PATH`, `SHELL`, `TERM` and `USER`, and **none** of the four task markers, while
the Codex process above it carried all four. The server therefore resolved the lead
row — the walk found the lead's engine — at **depth 0**, and recorded the lead's
child `ef1fe5b3…` at depth 1, its spec's lineage the child alone.

**The path taken: forwarding, A2b (a).** The Codex mount gained a fifth setting,
`-c mcp_servers.cross-agent.env_vars=["CROSS_AGENT_DEPTH","CROSS_AGENT_TASK",
"CROSS_AGENT_LINEAGE","CROSS_AGENT_PROJECT"]` (`src/engines/codex.ts#codex`): names
whose values Codex copies from its own environment, which the runner started from
the spec's. **After**, on B2's rerun and again on E2: the server's environment
held `CROSS_AGENT_DEPTH`, `CROSS_AGENT_LINEAGE`, `CROSS_AGENT_PROJECT` and
`CROSS_AGENT_TASK` beside the seven, each equal to the engine's own; the lead's
`delegate` succeeded, which only the operator and lead rows can call; and its
child was recorded at depth 2, the lead's, the lead first in its lineage. The
scrubbed case is pinned as the documented limit the setting closes
(`tests/authority.test.ts#scrubbedLeadRow`).


<!-- @anchor e2 -->
## E2: one `dev-team-engine` task under a Codex lead (2026-10-01)

The E1 host again, the sample's lead bound to Codex (`gpt-6-luna`, medium), the
task "S11-E2: `slug_words` accepts `max_words: int | None`, with tests; use the
slug s11-e2." and "Run it through the cross-agent skill." The host session ran 13
turns ($0.284); it called `describe_mode`, `list_roles`, `list_tasks`, one
`delegate` of the lead, one `wait` and `result`. The lead, `83750cc5…`, ran 490 s
and the whole loop through 27 MCP calls — `list_tasks`, `describe_mode`,
`list_roles`, `git_root` seven times, `delegate` four, `wait` four, `result` four,
`run_command` twice (the setup in the worktree, the suite at the root) and
`git_mutate` three times — each a code-mode `exec` script calling
`tools.mcp__cross_agent__<tool>`: planner 24 s, plan reviewer 150 s (approve),
implementer 28 s (77 tests), code reviewer 82 s (ready, one low-priority note on
a negative `max_words`), merge `81cec9d` → `7a5c15f`, 77 tests at the root, the
worktree and the branch removed. Its journal reads `worktree-created, git,
committed, git, merged, tests-passed, worktree-removed, branch-deleted`.

**The verdict.** `node tools/e2e-verify.mjs --project <sample> --since 83750cc5…
--slug s11-e2`, `CODEX_HOME` unset as the engines ran: seven `pass`, and a `?` on
condition 8, exit 2 — "83750cc5: its rollout holds delegate: 1 occurrences but
only 0 direct calls followed". The verifier names a record's first doubt only, so
the reading covers the whole rollout (`e2/verify-reading-rollout.txt`): 27 `exec`
scripts, six top-level `function_call`s, no `CommandExecution` item and no
command tool anywhere. The occurrence is the lead's first script, line 11, a
tool-discovery filter, `ALL_TOOLS.filter(x =>
/describe_mode|list_tasks|git_root|run_command|delegate|result|wait|ask|git_mutate|list_roles/i.test(…))`,
which names `delegate` inside a regular expression and calls nothing. The six
`function_call`s are Codex's own code-mode `wait` — `{"cell_id":"10",
"yield_time_ms":30000}` four times and cell 21 twice — waiting on two `exec`
cells that had yielded while their script's one `mcp__cross_agent__wait` call ran;
they carry no command, and the verifier's 0.159.2 table does not yet classify the
tool. Two `delegate` scripts failed before calling anything — a `SyntaxError` at
line 39 and a `ReferenceError` at line 113 — and were retried as direct calls,
which is why six scripts name `delegate` and four `McpToolCall` items carry it.
Every `delegate` is the lead's own, on the lead row: neither a launch nor a
`delegate` the scan looks for, and the run passes on that reading.

**Depth and lineage.** The lead at depth 1 alone in its lineage; the four
specialists at depth 2, each the lead's child with the lead first in its spec's
lineage: PASS. B2's reading is confirmed on this run: the lead's server, the Codex
process's own child, carried all four markers, equal to its engine's
(`e2/proc-lead.json`). The one other server the reading found, from 04:19:20 UTC,
was not the lead's: its parent was the Grok plan reviewer, which started it from
the sample's project-scope `.grok/config.toml` (T13's I1 mount), and it carried
the reviewer's own markers — depth 2, the reviewer's task id, the lead first in its
lineage.

<!-- @anchor e2Approval -->
**Approval escalation.** All 27 `mcp_tool_call` items completed, none with an
error, and neither the `.ndjson` nor the rollout holds an approval refusal — no
`requires approval`, and no call refused for want of one. The approval text the
rollout does hold is the policy itself: `approval_policy: never` in its turn
context, "Approval policy is currently never" in the instructions Codex gives the
model, and `exec_command`'s own schema. The mount's
`default_tools_approval_mode="approve"` under that policy let every call run, and
`git_mutate` and `git_root` ran in the server without a Codex prompt. The MCP item shape on
0.159.3 is 0.159.2's — the `--json` `mcp_tool_call` pair and the rollout's
`McpToolCall` keys — so `e2CodexItems` is not needed and the verifier and the
adapter learn nothing new from this run.

**The report.** `result {task_id: 83750cc5…}` returned the closing report, equal
to the record's result file, with the fields `roles/lead.md` names, and
`node src/cli.ts report --project <sample> --since 83750cc5…` rendered the five
tasks, each `passed`. The **host** called `result` this time — E3's launcher
change — but summarized the report rather than showing it, and ran two read-only
`git` commands through its own shell, a status, worktree and branch check before
it delegated the lead and a `git log` and status after: no loop step, but outside
the launcher's list of host calls. The launcher now says the host runs no `git`
and no test command of its own under this placement and shows the report whole
(`tests/skills.test.ts#engineHostHandsOff`); no S11 run exercised that text.

<!-- @anchor injectCancelLead -->
## Injection: cancelling the lead settles every descendant (2026-10-01)

A Claude lead, delegated through the operator driver with the task "S11-I1: add
`slug_count(text) -> int`; use the slug s11-i1". The trigger: a `list_tasks` poll
every five seconds through the driver, and the moment it showed the lead's
implementer `running` — the planner and plan reviewer `done`, the worktree
`task/s11-i1` created — `cancel {task_id: 97786228…}`. It answered one outcome per
task of the lead's lineage: the implementer `01efc74c…` `cancelled`, the plan
reviewer `73a86fea…` and the planner `911b72e1…` `already done`, the lead
`cancelled`, and `asksCancelled: []`. `list_tasks` afterwards showed all four
terminal, and a `/proc` scan for any process carrying one of the four ids — by
the environment's `CROSS_AGENT_TASK` or the command line, never a pattern that
could match the scanning shell — found none. The worktree `.worktrees/s11-i1` and
the branch `task/s11-i1` stood, at `7a5c15f`, as a cancel leaves them: cancelling
settles the task and does not undo what it wrote. The verifier, `node
tools/e2e-verify.mjs --project <sample> --since 97786228… --slug s11-i1`, for the
conditions this stopping point allows: the root
tree clean, the suite green on `main`, four records with their logs, every record
at depth 2 or less — `pass`; only the root worktree, no `task/*` branch and the
journal's steps `FAIL` by construction, the journal ending at `worktree-created`;
condition 8 `?` on the lead's `tool_progress` heartbeats, six, each the child of
one of its `wait` calls — read as in E3. The depth-and-lineage reading: PASS.
Restored by hand: `git worktree remove --force .worktrees/s11-i1`, `git branch -D
task/s11-i1`, the journal and the records moved to the archive.

<!-- @anchor injectKilledLeadAsk -->
## Injection: a killed lead's ask survives, and its answer reaches the resumed lead (2026-10-01)

A Claude lead with the task "S11-I2: add `strip_slug_prefix(text, prefix)`; before
creating the worktree, ask the operator to confirm the slug name and use the name
they answer". It asked at once, 16 s in: "… I propose \"strip-slug-prefix\". Confirm
this name, or give me a different one to use." When `list_asks {status: "open"}`
showed it, the lead's engine — the session leader whose environment carries
`CROSS_AGENT_TASK=600ea29f…`, its pid from the record's `engineIdentity` — got
SIGKILL. The record settled `failed` by its runner, reason `engine exited SIGKILL`,
and the ask file still read `open`.

From a terminal, `node <repo>/src/cli.ts --project <sample> answer 6b4b78a6…
"use s11-i2"` exited 0 printing the record, and the file read `answered`,
`answeredAt` 1790829479769; a second answer exited 3, "it was answered at
2026-10-01T04:37:59.769Z (answeredAt 1790829479769), and the first answer stands".
`delegate {role: "lead", cwd: <sample>, resume: 600ea29f…, brief: <the task text
again>}` wrote a spec whose brief is the task text followed by

```
## Asks so far
- ask 6b4b78a625c977dd732410ca7a4c9af278ae: answered
  question: For task S11-I2 (…), I need a slug for the branch/worktree (task/<slug>). I propose "strip-slug-prefix". Confirm this name, or give me a different one to use.
  answer: use s11-i2
```

while the record's `briefHash` is the SHA-256 of the task text alone, its
`resumedFrom` the killed lead and its spec's `resumeSessionId` the killed lead's
Claude session. The resumed lead, `7775c52f…`, planned again; the plan reviewer
answered "human decision", so it asked a second question, which the operator
answered through the `answer` tool; it then ran two more plan and review rounds,
each a `resume` of the planner and the plan reviewer, and called `git_root
{args: ["worktree", "add", "-b", "task/s11-i2", <sample>/.worktrees/s11-i2,
"main"], slug: "s11-i2"}` — the journal `s11-i2.json` opening with
`worktree-created` — and ran its setup. It was cancelled there, the evidence
complete: one outcome per task, its six children `already done`, itself
`cancelled`, `asksCancelled: []` (both asks answered). The verifier, `node
tools/e2e-verify.mjs --project <sample> --since 600ea29f… --slug s11-i2`, with the
records put back for the reading: the first six conditions `pass`, the journal's
`FAIL` by construction, condition 8 `?` on the resumed lead's heartbeats. The
depth-and-lineage reading over the resume chain: both lead records at depth 1,
each its own lineage, the six specialists the resumed lead's children at depth 2:
PASS. Restored by hand: the worktree and the branch removed, the journal, the two
asks and the eight records moved to the archive.

<!-- @anchor injectRootSuiteFails -->
## Injection: a suite that fails on `main` after the merge offers the revert and halts (2026-10-01)

Before the run the operator changed `project.testCommand` to `python3 -m unittest
discover -s tests -t . && test ! -e .cross-agent/FAIL-AT-ROOT` and created that
marker at the root: a worktree has no `.cross-agent/`, so the suite passes in one
and fails at the root (`i3/config.diff`, `i3/trigger-commands.txt`). A Claude lead,
`145440dc…`, the task "S11-I3: add `truncate_slug(text, length)`; use the slug
s11-i3". It ran
the loop through a needs-work round on the plan — the plan reviewer said
`revise`, and the planner and the reviewer were each continued by `resume` — and
then the implementer (83 tests in the worktree), the code reviewer (ready), the
rebase (a `git` step: `main` had not moved) and `git_root merge --ff-only
task/s11-i3`, which moved `main` `7a5c15f` → `4fb584d`. Its root
`run_command {which: "test", where: "root", slug: "s11-i3"}` answered `exitCode: 1`
with a tail reading "Ran 83 tests … OK"; it ran it once more, got 1 again, and
stopped. The journal `s11-i3.json` holds `worktree-created, git, committed, git,
merged` — `merged` carrying `defaultShaBeforeMerge` 7a5c15f… and `branchHead`
4fb584d… — and no `tests-passed`. Its final message, read through `result`, names
the failure, the two runs and the tail, says it "did not run anything further"
and left the branch and its worktree standing, and offers

```
git revert --no-edit 7a5c15fc8823ee5f599de25b638e42906bb70c68..4fb584d786693d8ce42ca20ce854bdda94f017a6
```

the journal's two SHAs; after the second root run it called nothing. The
worktree `.worktrees/s11-i3` and the branch `task/s11-i3` stood. The verifier,
`node tools/e2e-verify.mjs --project <sample> --since 145440dc… --slug s11-i3`, for
what this stopping point allows: the root tree clean, seven records with their
logs, every record at depth 2 or less — `pass`; the standing worktree and
branch, the suite on `main` (the marker) and the journal's missing steps `FAIL` by
construction; condition 8 `?` on the lead's seven `tool_progress` heartbeats,
each a child of a `wait` call. The depth-and-lineage reading: PASS. Restored by
the operator's hands: `rm .cross-agent/FAIL-AT-ROOT`, `git revert --no-edit
7a5c15f…..4fb584d…` (a new commit, `f742ac7`), `git worktree remove
.worktrees/s11-i3`, `git branch -d task/s11-i3`, the test command restored; the
suite at the root then green.


<!-- @anchor injectAfterWorktreeRemove -->
## Injection: an interruption after `worktree remove`, and the pass that deletes the branch (2026-10-01)

A Claude lead, the task "S11-I4: add `slug_join(parts)`; use the slug s11-i4;
after removing the worktree, ask the operator whether to delete the branch and
delete it only on yes". It ran the loop — a plan revised once through `resume`,
the implementer, the code reviewer, the rebase (a `git` step), the merge (`main`
→ `fd6e3a9`), `tests-passed` at the root — then `git_root worktree remove` and
asked: "The worktree for task/s11-i4 has been removed, and the branch is merged
into main (fast-forward, now at fd6e3a9). Should I delete the branch task/s11-i4
now?" With the journal at `worktree-removed` and that ask open, the lead's engine
— the session leader carrying `CROSS_AGENT_TASK=269b1ee6…` — got SIGKILL. The
record settled `failed`, `engine exited SIGKILL`; the branch stood with no
worktree.

The operator then ran the launcher's reconciliation pass ("Between tasks:
reconcile") through an operator-row server, in its order
(`i4/reconciliation-pass.txt`): `list_tasks`, nothing invalid, nothing it could
not decide, the lead `failed` and its six children `done`; the journal
`s11-i4.json`, its steps ending `merged, tests-passed, worktree-removed`; `git_root
worktree list --porcelain`, the root alone on `main`; `git_root branch --list
task/*`, `task/s11-i4`; `git_root status`, clean; no rebase state, since no
worktree remains. A branch-only leftover whose journal records it is the pass's
to delete: `git_root {args: ["branch", "-d", "task/s11-i4"], slug: "s11-i4"}`
answered `Deleted branch task/s11-i4 (was fd6e3a9).` and journaled
`branch-deleted`, and `git branch --list 'task/*'` was empty. This is the path the
brief names first; the resumed lead answered "yes" was not taken. The verifier,
`node tools/e2e-verify.mjs --project <sample> --since 269b1ee6… --slug s11-i4`,
after the pass: seven `pass` — the journal now
every step, `worktree-created, git, git, committed, git, merged, tests-passed,
worktree-removed, branch-deleted` — and condition 8 `?` on the lead's nine
`tool_progress` heartbeats, each a child of a `wait` call. The depth-and-lineage
reading: PASS. A `cancel` of the dead lead then answered `already` for all seven
tasks and `asksCancelled: ["fdb88222…"]`: its unanswered question cancelled with
it. `main` keeps the merged `slug_join`; the records, the journal and the ask were
moved to the archive.


<!-- @anchor injectRebaseConflict -->
## Injection: an interrupted rebase is aborted and reported (2026-10-01)

A Claude lead, `6ee2a698…`, the task "S11-I5: rewrite `slugify`'s docstring to
state its separator and stop-word rules; use the slug s11-i5". The trigger: the moment the
journal showed `worktree-created`, the operator rewrote the same docstring lines
on `main` by hand — the first line and the stop-word line, through
`i5/hand-edit.py` at the root checkout — and committed them, `cdeb3de`. The lead
went on: a plan revised once through `resume`, the implementer's own rewrite of
those sentences with a test asserting them (83 tests), the lead's commit
`31ce36a`, and the code reviewer's verdict **needs rebase**, naming `cdeb3de`. Its
`git_mutate {slug: "s11-i5", args: ["rebase", "main"]}` answered `ok: false`,
`exitCode` 1, git's own text — `CONFLICT (content): Merge conflict in
slugkit/__init__.py`, "could not apply 31ce36a…" — and journaled nothing; `git_mutate
… ["rebase", "--abort"]` followed and journaled a `git` step with those arguments;
`.git/worktrees/s11-i5` then held no `rebase-merge` or `rebase-apply` directory. The
lead dispatched nothing more and asked instead: "… Rebasing task/s11-i5 (commit
31ce36a) onto main produces a conflict in slugkit/__init__.py on that exact text …
I've aborted the rebase; the branch and worktree are untouched. How would you like
to proceed?" The operator answered "Stop here …"; its closing report, read through
`result`, names the conflicting file, the aborted rebase, the question and the
answer, and the branch and worktree left standing, and its last calls were the two
`git_mutate`s and the `ask`. The verifier, `node tools/e2e-verify.mjs --project
<sample> --since 6ee2a698… --slug s11-i5`, for what this stopping point allows: the
root tree clean, the suite on `main`, seven records with their logs, every record
at depth 2 or less — `pass`; the standing worktree, the branch and the journal's
missing steps `FAIL` by construction; condition 8 `?` on the lead's thirteen
`tool_progress` heartbeats, each a child of a `wait` call. The depth-and-lineage
reading: PASS. Restored by hand: `git worktree remove .worktrees/s11-i5`, `git
branch -D task/s11-i5`, `git revert --no-edit cdeb3de` (`a832c1b`), the journal,
the ask and the records moved to the archive.

The five injections leave the sample's `main` at `a832c1b`: E3's `81cec9d` and
E2's `7a5c15f`, I3's merge and its revert, I4's `slug_join` merged by its lead, and
the operator's I5 commit and its revert — clean, the root worktree alone, no
`task/*` branch, the suite green.

<!-- @anchor e2Host -->
## E2's host clause, run again: E2b and E2c (2026-10-01)

The review found E2's host outside the launcher's list of host calls — two
read-only `git` commands through its own shell — and the source of it in the
launcher: the paragraphs above its engine-placement section, the reconciliation
pass among them, ordered loop steps with no placement condition. Once each of them
named `host` placement and the engine section said who reconciles
(`tests/skills.test.ts#launcherRoutesPlacement`, `#engineWhoReconciles`), the E1
host ran two more short `dev-team-engine` tasks under a Codex lead (`gpt-6-luna`,
medium), each started with `setsid --fork` from the sample. Grok had updated itself
to 1.0.46 (2765805b9442) by then; a read-only probe through the adapter answered
first, in the shape 1.0.44 wrote (`e2b/grok-1046-smoke.log`). Each run's records
were moved to `probe-tasks/s11/` after its reading; its evidence is in `e2b/` and
`e2c/`.

**E2b**, "S11-E2b: add `slug_initials(text) -> str` beside `slugify` …; use the
slug s11-e2b". The host ran 386 s over 9 turns ($0.25) and called `describe_mode`,
`list_roles`, one `delegate` of the lead, one `wait` and `result`, and nothing
through a shell: the calls clause holds (`e2b/audit-host.txt`). The lead,
`33fde77f…`, ran 362 s: planner 27 s, plan reviewer 108 s (approve), implementer
32 s (85 tests), code reviewer 92 s (ready), the merge `a832c1b` → `efa2d27`, the
suite at the root, the worktree and the branch removed. The verdict, `node
tools/e2e-verify.mjs --project <sample> --since 33fde77f… --slug s11-e2b`: seven
`pass` and a `?` on condition 8, "its rollout's script holds a regular expression
naming an engine, which cannot be told from a command". The reading
(`e2b/verify-reading-rollout.txt`): the lead's first script, line 11, filters
`ALL_TOOLS` through a regular expression naming `cross-agent` and calls nothing;
25 `exec` scripts and six top-level code-mode `wait`s, and no command item; the one
failed `McpToolCall` is `git_root` called with no arguments, refused `-32602`
before anything ran. Neither a launch nor a specialist's `delegate`. Depth and
lineage: PASS. `result` was the result file byte for byte (1001 bytes) — and the
host's closing message was a list of its own, not that report: the launcher's
closing paragraph asked every host for one. That list is now host placement's,
and under engine placement the closing message is the report verbatim
(`tests/skills.test.ts#engineHostHandsOff`).

**E2c**, "S11-E2c: add `slug_word_count(text) -> int` beside `slug_words` …; use
the slug s11-e2c", under that text. The host ran 250 s over 8 turns ($0.21) and
called `describe_mode`, `list_roles`, one `delegate` of the lead, one `wait` and
`result`, and nothing through a shell; its closing message is the lead's report
byte for byte, with nothing before or after it (`e2c/presentation-reading.txt`).
The lead, `84a1c550…`, ran 232 s: planner 21 s, plan reviewer 43 s (approve),
implementer 28 s (87 tests), code reviewer 40 s (ready), the merge `efa2d27` →
`15e9f4e`, the suite at the root, the worktree and the branch removed. The verdict,
`node tools/e2e-verify.mjs --project <sample> --since 84a1c550… --slug s11-e2c`:
seven `pass` and a `?`, "its rollout holds delegate: 1 occurrences but only 0
direct calls followed". The reading (`e2c/verify-reading-rollout.txt`): line 13's
tool-discovery filter names `delegate` in a regular expression and calls nothing;
the four `delegate`s are direct calls in four scripts; two code-mode `wait`s; no
command item. Depth and lineage: PASS. The rollout also shows the root guard at
work: the lead's first `worktree add` named
`…/cross-agent-e2c/slugkit/.worktrees/s11-e2c`, a path outside the mode's worktree
directory, and `git_root` refused it before running git; the lead's refusal check
followed — `git_root log --oneline --max-count=5 task/s11-e2c`, exit 128, no such
branch — and then the add with the right path. Three read verbs it gave a `slug`
were refused too ("journals nothing, so it takes no slug") and repeated without
one. Both leads' reports name each specialist's task id and verdict and leave out
the duration `roles/lead.md` asks for.

In both runs the lead's server carried the lead's own markers, and the one other
server, the Grok plan reviewer's from the sample's `.grok/config.toml`, carried the
reviewer's (`e2b/proc-lead.json`, `e2c/proc-lead.json`). E2b and E2c leave the
sample's `main` at `15e9f4e`, clean, the root worktree alone, no `task/*` branch,
87 tests green.


<!-- @anchor t14 -->
## T14: the Codex plugin under a Codex host (2026-10-01)

T14's runs, in the order they ran: B1, the plugin's install and the mount Codex
resolves, with the exposure switch; B2, the environment the plugin's server receives;
B3, a ten-minute `wait` through the plugin; B4, the hop count under a Codex host; B5
and B6, integration probes I1 and I2 under a Codex host, with the guarded
`codexI2Real`; then E4 and E5. Their raw evidence (host streams, rollouts, `/proc`
readings, records, config diffs and the scripts that took them) is in
`~/.cache/agent-team/probe-logs/t14-2026-10-01/`, one directory per run, with the
timeline of every edit to `~/.codex/config.toml` in `timeline.txt`; the records of every
run but E4 and E5 were moved to `~/.cache/agent-team/cross-agent-e2e/probe-tasks/t14/`
after their reading. Engines: Claude Code 2.1.286, codex-cli 0.159.3, grok 1.0.46
(2765805b9442), node 24.11.0; `claude-sonnet-5`, `gpt-6-luna` and `grok-4.7`, each at
medium, the hosts included. Every host was `codex exec --json -o <run>/host.last.txt -C
<target> -s workspace-write -m gpt-6-luna -c model_reasoning_effort="medium" -`, never with
`--ignore-user-config` or `--ephemeral`. From B1's third step on, the operator's config held
the plugin `enabled = false`, and each host that was to have the server added the
per-session `-c plugins.cross-agent@agent-team-cli.enabled=true`; B5's host had the server
from a window with the file enabled instead (`timeline.txt`). The hosts were started with
`setsid --fork` from the target by `scripts/host-codex.sh`, which scrubs the outer session's
markers and, from the launcher's form on, exports `CROSS_AGENT_PROJECT=<target>` — with two
exceptions: B4(b)'s nested host was started from this task's own shell, without `setsid`,
and E5's second turn was `codex exec resume <thread> -`, which takes neither `-C` nor `-s`
(P10), with the operator's answer as its prompt (`scripts/host-codex-resume.sh`). Fix round
1's marker probes used `fix1/scripts/host-codex-env.sh`, the same command with the host's
`CROSS_AGENT_*` chosen per probe (`docs/probes.md#codexMarkers`).

<!-- @anchor codexPluginInstall -->
## The Codex plugin's install (B1)

`cp ~/.codex/config.toml ~/.codex/config.toml.bak-t14-2026-10-01` came first; restoring
it is the plan's wrap, not T14's. `codex plugin marketplace add <dir>` writes
`[marketplaces.agent-team-cli] source_type = "local" source = "<dir>"`, and `codex plugin
add cross-agent@agent-team-cli` writes `[plugins."cross-agent@agent-team-cli"] enabled =
true` and copies the plugin to
`~/.codex/plugins/cache/agent-team-cli/cross-agent/0.0.1/`, keyed by `package.json`'s
version. A local `source.path` of `"./"` is accepted: the listing resolves it to the
marketplace's own root. `codex plugin list --json` reports the plugin `installed` and
`enabled`, and `codex mcp list` shows its server beside the configured ones. The `--help`
of every `codex plugin` and `codex mcp` verb reads the same on 0.159.3 as on 0.159.2.

**The copy takes everything.** Registered from the worktree, the copy was the whole
directory, 32 MB: the `.git` pointer file, the ignored `.cross-agent/` (28 MB of review
records) and `.superpowers/`, the untracked `.codex/agents/`, `.beads/` and the rest.
Every later install therefore registered a clean export instead — `git archive HEAD |
tar -x` into `~/.cache/agent-team/codex-plugin-export/<sha>/`, 2.8 MB — and each copy was
`diff -rq`-identical to its export; file modes survive, the launcher's executable bit
included.

**The Claude manifest alone (ruling 8).** With `.codex-plugin/` absent, Codex installed
the plugin from `.claude-plugin/plugin.json` and found `skills/` by convention: the
session's skill list named `cross-agent:cross-agent` under the plugin cache. It started
no server from that manifest, so the session listed `codex_apps`, `node_repl` and `web`
and none of this server's tools, and whether `${CLAUDE_PLUGIN_ROOT}` would be substituted
was never reached. `.codex-plugin/plugin.json` ships.

**Removal.** `codex plugin remove cross-agent@agent-team-cli` deletes the
`[plugins."cross-agent@agent-team-cli"]` table, whatever it says, and the copy, leaving
the empty directory `~/.codex/plugins/cache/agent-team-cli/`; `codex plugin marketplace
remove agent-team-cli` deletes the marketplace table. `codex plugin add` writes `enabled =
true` again, so a reinstall turns a disabled plugin back on. In a scratch `CODEX_HOME`,
`codex mcp add cross-agent -- node <repo>/src/server.ts` writes a table of `command` and
`args` alone, and with the plugin installed beside it `codex mcp list` shows one
`cross-agent`, the configured table's: it shadows the plugin's server, budget and all.

<!-- @anchor codexPluginMount -->
## The mount codex-cli 0.159.3 resolves (B1)

Each form ran under a host session in the sample with the same prompt: list every MCP
tool, call `list_roles` and paste it, give `describe_mode`'s first loop line, then `sleep
45` so the server could be read from `/proc`.

- **Form 1**, `"command": "node", "args": ["${PLUGIN_ROOT}/src/server.ts"]` and no `cwd`:
  no tool of this server. A watcher polling `/proc` every 5 ms saw `node
  ${PLUGIN_ROOT}/src/server.ts` started twice in the sample, the variable literal, each
  gone at once (`b1/step2b/spawns.ndjson`). Codex substitutes nothing in `args`.
- **Form 2**, `"command": "./.codex-plugin/serve"` and no `cwd`: no process at all; under
  `strace`, `execve("./.codex-plugin/serve", …, /* 7 vars */) = -1 ENOENT` from the
  session's directory (`b1/step2d/strace.txt`). A relative command runs from the
  server's working directory, not the plugin's.
- **Three variants side by side**, from a probe-only export, read by `codex mcp list
  --json` without a session: `"cwd": "${PLUGIN_ROOT}"` became
  `<plugin root>/${PLUGIN_ROOT}`, `"cwd": "."` became `<plugin root>/.`, and a `command`
  of `${PLUGIN_ROOT}/.codex-plugin/serve` stayed literal (`b1/step2e/variants-reading.txt`).
- **Form 3, shipped**: `"command": "./.codex-plugin/serve", "cwd": ".", "env_vars":
  ["CROSS_AGENT_PROJECT"]`, the task's markers added to `env_vars` in fix round 1
  (`docs/probes.md#codexMarkers`). The server ran as `node
  ~/.codex/plugins/cache/agent-team-cli/cross-agent/0.0.1/src/server.ts`, its working
  directory the copy, and the host listed the fourteen tools of the operator row under
  the sample's `dev-team-engine` as `mcp__cross_agent__<tool>` (server `cross_agent`:
  Codex folds the hyphen, as it does for the `-c` mount). `list_roles` returned the
  sample's six roles with their bindings, `describe_mode`'s loop opened "# The dev-team
  loop, engine-placed", and the skill sat under the plugin cache root. From the copy
  discovery finds no project the operator meant: from an export's copy, nothing; from a
  checkout's, whose `.git` came along, a repository the operator did not name — the copy
  itself for a main checkout, the checkout it was copied from for a linked worktree, as
  `discoverProject` answered for `cp -a` copies of each (`fix1/discovery-copies.txt`). So
  the launcher refuses to start the server without `CROSS_AGENT_PROJECT`
  (`tests/packaging.test.ts#codexManifestMounts`, `#codexLauncherRunsServer`).

A plugin server's `McpToolCall` rollout item carries a key the `-c` mount's did not:
`pluginId` (`"cross-agent@agent-team-cli"`) beside `arguments, duration, id, result, server,
status, tool, type`. The verifier reads the item by its `tool` and is indifferent to it.

**The exposure switch (B1 (3)).** `-c mcp_servers.cross-agent.enabled=false` does not
address a plugin's server: Codex refuses to load its configuration — "invalid transport in
`mcp_servers.cross-agent`" — before any session, and the same table written into
`config.toml` would stop every Codex start on the machine, so it was never written there.
The plugin-level key does address it: with `[plugins."cross-agent@agent-team-cli"] enabled =
false` in the operator's file, a session offers neither the server nor the skill, and one
started with `-c plugins.cross-agent@agent-team-cli.enabled=true` lists the fourteen and
answers `list_roles` and `describe_mode`; the key quoted on the command line changes
nothing. T14 kept the plugin off in the file and enabled it per session, regime (b) with a
per-session switch, so no `-c mcp_servers.cross-agent.*` setting could have reached B3's
budget either.

<!-- @anchor codexHostEnvironment -->
## The plugin server's environment (B2)

`/proc/<server pid>/environ`, read while each session ran, names `CROSS_AGENT_PROJECT`,
`HOME`, `LANG`, `LOGNAME`, `PATH`, `PWD`, `SHELL`, `TERM` and `USER`: the seven S11 read
under the `-c` mount (`docs/probes.md#e2ServerEnv`), `CROSS_AGENT_PROJECT` passed by the
whitelist from the operator's environment, and `PWD`, which the launcher's `sh` exports.
No task marker: the host's environment held none, and the whitelist named no other.
`HOME` is `/home/wsh` and there is no `CODEX_HOME`, so a Codex specialist's rollout
lands under `~/.codex/sessions`, where the verifier finds it (B6's and the E-runs' were). Codex prepends its own `~/.codex/tmp/arg0/codex-arg0…` and the
release's `codex-path` to the operator's `PATH`. `NoNewPrivs` and `Seccomp` are 0: Codex
does not confine the server, and from it Claude's and Grok's `bwrap` and Codex's own sandbox
all started (B6). The seven sufficed for a host started from a clean shell, but not for one
started inside a task, whose server must carry the task's markers; fix round 1 added them to
`env_vars` (`docs/probes.md#codexMarkers`). The server's stderr is a pipe whose other end the Codex
process holds (its fd 40), and its row line surfaced nowhere this task looked: not in the
`--json` stream, the host's stderr, the rollout or `~/.codex/logs_2.sqlite`, and there is
no `~/.codex/log/`. The row is evidenced by the tools listed and the calls answered.

<!-- @anchor codexMarkers -->
## The task's markers through the plugin's whitelist (fix round 1, 2026-10-01)

`run_command` gives a test command `CROSS_AGENT_DEPTH` and the project but no task id, so
that a server started inside a suite serves the specialist row
(`src/runcommand.ts#commandEnv`). Codex hands a stdio server only the variables `env_vars`
names, so with `CROSS_AGENT_PROJECT` alone a `codex exec` started from such a suite handed
its server no marker, and the server, with no engine of the ledger's among its ancestors,
served the operator row. Read live on the install of `bbf2460` (`dac519b` before the merge's rebase, the name its export directory keeps; `fix1/probe-b-before/`): a
host started with `CROSS_AGENT_PROJECT` and `CROSS_AGENT_DEPTH=1` and no task id ran a
server whose environment held B2's nine names and no `CROSS_AGENT_DEPTH`, and the session's
tools, as the host's own code-mode cell printed them (`text(JSON.stringify(ALL_TOOLS.map(t
=> t.name)))`), held the operator row's fourteen.

`.codex-plugin/plugin.json` and the fallback table now name `CROSS_AGENT_PROJECT`,
`CROSS_AGENT_TASK`, `CROSS_AGENT_DEPTH` and `CROSS_AGENT_LINEAGE`
(`tests/packaging.test.ts#codexManifestMounts`, `#codexFallbackSnippet`), and `codex mcp list
--json` reads the four for each: the plugin's from the operator's configuration with the
per-session enable, the fallback's from a scratch `CODEX_HOME` (`fix1/reinstall/`,
`fix1/snippet-check/`). The plugin was reinstalled from a clean export of `6d86c9e` (`f3272a2` before the merge's rebase, the name its export directory keeps): `codex
plugin add`, run between 14:17:03.142Z and 14:17:03.207Z, wrote `enabled = true`, and the
file was set back to `false` at 14:17:03.224Z (`timeline.txt`); the copy is `diff
-rq`-identical to the worktree on `src/`, `modes/`, `skills/` and `.codex-plugin/`. Then three
hosts in the sample, each enabling the plugin for its session alone, each read through its
server's `/proc/<pid>/environ` and its own `ALL_TOOLS` cell (`fix1/probe-{a,b,c}/`):

| probe | the host's `CROSS_AGENT_*` | the server's environment | the session's `cross_agent` tools |
|---|---|---|---|
| (a) a clean operator shell | `PROJECT` | B2's nine names, no marker | the operator row's fourteen; `list_roles` answered |
| (b) as `run_command` gives a suite | `PROJECT`, `DEPTH=1` | the nine and `CROSS_AGENT_DEPTH=1` | the specialist row's five, `check`, `describe_mode`, `list_roles`, `list_tasks` and `result`; `list_roles` answered |
| (c) no project named | none | no server process under the host | none; the host had no `list_roles` to call |

(a) is the change's acceptance: Codex leaves an unset whitelisted name out of the server's
environment rather than passing it empty, so an operator's server holds no marker and keeps
its row (`tests/authority.test.ts#operatorNamesProject`). An empty one would have made it a
specialist, since `src/authority.ts#unmatched` counts a marker that is present at all. In
(c) no server started — without the variable the launcher exits before `node`
(`tests/packaging.test.ts#codexLauncherRunsServer`) — and `codex exec` showed nothing of it:
no line on the host's stderr, no item in its `--json` stream, nothing in the session's
rollout or in `~/.codex/logs_2.sqlite`. The session simply had none of the server's tools.

<!-- @anchor codexHostTimeout -->
## B3: a ten-minute wait under a Codex host (2026-10-01)

In `<inject>`, with `engines.claude.bin` bound to `fake-claude-stall`, a wrapper that sets
the fixture's `stall` script and `claude` format itself (a Codex host's server carries
none of the operator's `FAKE_ENGINE_*`), T13's `wait10.txt` prompt under the plugin.
Codex started in `<inject>` with no trust entry, raised no prompt, and wrote one into the
operator's configuration, `[projects."<inject>"] trust_level = "trusted"`: it is absent from
the copy taken at 11:32:40Z and present in the one taken before B3's control at 11:49:19Z,
and B3's was the only session in `<inject>` between them (`b1/step3/config-before-disable.toml`,
`b3/control-60/config-before.toml`). The host delegated the child
`fdb4ef58…`, made one `wait {timeout_seconds: 600}` and nothing else until it returned,
then `check` and `cancel`. Its rollout's `McpToolCall` for that `wait` has `duration
{secs: 600, nanos: 4113870}`, 600.004 s, `status: "completed"`, `error: null`, and answers
`status: "running"`, `stalled: false`, `elapsedSeconds: 603`; the code-mode script reports
"Wall time 600.0 seconds", and the two `date -Is` lines are 607 s apart. The child was
still running: `check` answered `running` with `lastEventAt` the fixture's opening line,
and `cancel` answered `cancelled`, the record's `updatedAt` 7 s after the wait ended,
exit 143. The model set the script's own yield past the call (`// @exec:
{"yield_time_ms": 650000}`), so no code-mode `wait` was needed. **The negative
control**: a probe-only copy declaring `tool_timeout_sec: 60`, the same prompt with
`timeout_seconds: 90` — that `wait` item is `failed` at 60.002 s, "timed out awaiting
tools/call after 60s", while the child still ran. So Codex honours `tool_timeout_sec` as a
plugin's manifest declares it, and the shipped 3600 is what carried the call
(`QUESTIONS.md`'s T14 item).

<!-- @anchor codexHostHops -->
## The hop count under a Codex host (B4)

`scripts/chain.mjs` (T13's) from the plugin server to pid 1, as `src/authority.ts` climbs
it:

| host | processes from the server to pid 1 | row served |
|---|---|---|
| `codex exec` started with `setsid --fork` from the target (B3, E4) | 4: `node`, `codex exec`, `systemd --user`, `init` | operator |
| the same command from an agent session's own shell, no `setsid` | 10: `node`, `codex exec`, `bash`, `claude`, `bash --posix`, `sh -c`, `ghostty`, `nautilus`, `systemd --user`, `init` | operator, fourteen tools |
| Codex at a terminal; the Codex desktop app | not run: the user's hands (ruling 4) | — |

The walk's 32 hops (`src/authority.ts#maxHops`) hold both rows with room.

<!-- @anchor i1CodexHost -->
## I1 under a Codex host (B5)

One host session in the sample delegated three `consult`s at the project root with I1's
brief, one per engine, each named in its first line. For the run's duration the plugin
was enabled in the operator's file, so the Codex child met an enabled plugin. Each row is
read from the child's own log:

- **Claude** (`546f7530…`): `system/init` `mcp_servers: []` and no MCP tool
  (`--strict-mcp-config`); "No MCP tool named \"delegate\" is offered to me at all".
- **Codex** (`c2c57520…`, `--ignore-user-config`): its rollout's skill roots are
  `~/.agents/skills` and `~/.codex/skills/.system` alone, with no plugin cache, and its
  tool inventory holds `codex_apps` and nothing of this server's; no `McpToolCall`. The
  flag drops the user's plugins as it drops the user's MCP servers — the fact P5 did not
  cover. Its turn ran `approval_policy: never`, read-only.
- **Grok** (`d8a689c5…`): `system/init` lists exactly the five specialist tools as
  `cross-agent__<tool>`, through the sample's `.grok/config.toml`, beside the user's own
  servers; it searched for `delegate`, found none, and called nothing, so its
  dispatcher's refusal was not reached.

The host's own row is B1's: the fourteen tools under `dev-team-engine`, twelve under E4's
`dev-team`, as `mcp__cross_agent__<tool>`, with `describe_mode` served.

<!-- @anchor i2Codex -->
## I2 under a Codex host (B6)

One host session in the sample delegated three `consult`s with `worktree: true`, one per
engine, each brief opening with a step that waits for `GO-t14-b6-<engine>` under
`.cross-agent/`. An operator script (`scripts/b6-operator.py`) watched the ledger, took
each worktree's readings — the pointer file, every ref, the worktree list, its `HEAD`, the
root's status and what was staged — and only then wrote that engine's GO file. Verdicts
per step, by the filesystem and each engine's own log:

| step | Claude (`a1d5280a…`) | Codex (`b4121fd8…`) | Grok (`689b76da…`) |
|---|---|---|---|
| 1 write in the worktree | allowed, `notes.md` present | allowed, present | allowed, present |
| 2 the suite | 87 tests OK | OK | OK |
| 3 `../../ROOT-WRITE.txt` | denied, absent | denied, absent | denied, absent |
| 4 `../../.git/cross-agent-probe-write.txt` | denied, absent | denied, absent | denied, absent |
| 5 `../../.git/hooks/pre-commit` | denied, absent | denied, absent | denied, absent |
| 6 `../other-WRITE.txt` | denied, absent | denied, absent | denied, absent |
| 7 `$HOME/cross-agent-probe-t14-b6-<engine>.txt` | denied, absent | denied, absent | denied, absent |
| 8 the `.git` pointer rewrite | denied, unchanged | denied, unchanged | **allowed**, rewritten |
| 9 `curl https://example.com` | 200 | **`curl: (6) Could not resolve host`** | 200 |

Claude's and Codex's denials read "Read-only file system", Grok's "Permission denied". The
Codex child's own record is its rollout: the verifier's reader decoded every command
exactly (`--read-rollout`, `b6/codex-child-rollout-reading.json`), and each step's exit is
in the output of its own `exec` call. A cell's output is whatever its script prints, and
this child's scripts printed each exit in their own words, read off the tool's result, so
the reader paired no exit and said why; a person read them (`b6/codex-raw-outputs.txt`). Every engine's sandbox started
from a server Codex launched: Claude's and Grok's `bwrap`, seen by task id while they ran,
and Codex's own, its turn's policy `workspace-write` and its denials the sandbox's.

**Grok's rewritten pointer** was answered as the design requires (`docs/probes.md#i2`):
through S11's operator driver, `verify_worktree` and `git_mutate add -A` both refused with
"Cannot resolve the worktree's Git directories and HEAD branch: … fatal: not a git
repository: /tmp/elsewhere", and the readings after match those before but for the pointer
itself: no ref moved, nothing staged, the worktree's `HEAD` unchanged, the root clean.
Claude's and Codex's pointers were never written.

**`codexI2Real`**, run with `CROSS_AGENT_REAL_CODEX=1` against its own repository under
`~/.cache`. Its first run failed as designed: the child ran step 3 against the worktree's
own `.git` rather than the root's, though its brief named the root's, so no `exec` call ran
the prescribed command. With the brief asking for each command character for character,
the second run passed: the opening turn's answer carried the marker (the brief arrived on
stdin), the resumed turn ran `exec resume` with the brief on stdin, and each of the five
resumed attempts is one `exec` call, its own output's exit 0 for the in-worktree write and 1
with "Read-only file system" for the root file, `<root>/.git`, `$HOME` and the sibling path,
as `--read-rollout` paired them; the filesystem agrees. Both turns ran `gpt-6-luna` at
medium, `workspace-write`, the resume in the worktree (`b6/codexI2Real/`). That proof took
a cell's printed exit for its command's, though a cell's output is whatever its script
printed, so a step only written down could have passed it. Fix round 1 made the proof
positive — every call in the thread a `direct` exec running one step, nothing computed,
nothing unreadable (`tests/engines/codex.test.ts#codexI2ProofShape`) — and run 2's rollout
still reads as proof under it. A third run, its brief giving each step's whole two-line
script, passed under the new proof: five `direct` calls, exit 0 inside the worktree and 1
with "Read-only file system" for the four outside writes, the filesystem agreeing
(`fix1/codexI2Real-run3/`, thread `01a0f7c2-6c76-7ac0-a0ee-00463fe32bc5`, 49.6 s). Each run's
Codex children ran with `--ignore-user-config`, raised no trust prompt, and still wrote a
trust entry for the run's repository into the operator's `~/.codex/config.toml`,
`[projects."<root>"] trust_level = "trusted"`: run 3's appeared during its run
(`fix1/codexI2Real-run3/config-written-by-run.diff`), and runs 1 and 2 left one each
(`final-state/config-vs-backup.diff`). The repositories are gone; the entries stay.

The probe worktrees and branches were then removed by hand (`b6/cleanup.txt`): Grok's
pointer restored first, then `git worktree remove --force`, `git branch -D` and `git
worktree prune`, leaving the sample on `main`, clean, the root worktree alone. The
ten-minute row is B3's (`docs/probes.md#codexHostTimeout`).


<!-- @anchor e4 -->
## E4: one `dev-team` task under a Codex host (2026-10-01)

T14's Codex host, the plugin enabled for the session alone, prompted "T14-E4: run this
task through the cross-agent skill in this repository. Task: add `unslugify(slug: str) ->
str` beside `slugify`, turning a slug back into space-separated words, with tests; use the
slug t14-e4." The sample was switched to `dev-team` with `limits.maxDepth: 1` for it
(`e4/config.diff`): the planner and the implementer on Codex (`gpt-6-luna`), the plan
reviewer on Grok (`grok-4.7`), the code reviewer on Claude (`claude-sonnet-5`, read-only),
each at medium — a Codex specialist in a read-only root role and in a writable worktree
role inside a whole loop, under a Codex host, for the first time. The plugin's copy was
installed from `bbf2460` (`dac519b` before the merge's rebase), `diff -rq`-clean against the worktree. The host ran 468 s,
1,744,918 tokens in and 5,067 out, and ran the loop itself through the plugin's server:

```
cat skills/cross-agent/SKILL.md from the plugin's copy
describe_mode, list_roles, list_tasks
git_root status / worktree list / branch --list task/*     → clean, main, none
delegate planner (codex)                   → wait 27 s → result   9ed6c4fc  28 s
delegate plan-reviewer (grok)              → wait 141 s           376e3fae  143 s, revise
delegate planner resume 9ed6c4fc           → wait 17 s → result   35cb5547  19 s
delegate plan-reviewer (grok, round 2)     → wait 77 s → result   70aa060c  79 s, approve
git_root worktree add -b task/t14-e4 .worktrees/t14-e4 main
run_command setup in .worktrees/t14-e4
delegate implementer (codex, task/t14-e4)  → wait 37 s → result   920c667b  38 s, 87 → 90 tests
git_mutate add -A … ; git_mutate commit     → 23980ed
delegate code-reviewer (claude, read-only) → wait 22 s → result   de1e73ec  24 s, ready
git_mutate rebase main                      → up to date
git_root merge --ff-only task/t14-e4        → main 15e9f4e → 23980ed
run_command test where=root                 → 90 tests, OK
git_root worktree remove …; git_root branch -d task/t14-e4; git_root status
cat >> .cross-agent/log.md                  → a heading and six lines, exit 0
```

The `wait` durations are each `McpToolCall`'s own, every one `done`; between them Codex
waited on yielded cells seven times with its own `wait`, `{cell_id, yield_time_ms}`, B2's
shape. Every command the host ran — the skill read, a read of the log and the append — judges
`pass` by the verifier's own tokenizer, in its rollout and its stream alike, and the append
exited 0 under `workspace-write` (`e4/host-commands-judged.txt`,
`e4/log-append-reading.txt`).

**The verdict.** `node tools/e2e-verify.mjs --project <sample> --since 9ed6c4fc… --slug
t14-e4`, `CODEX_HOME` unset, right after the run (`e4/e4-verify.txt`): seven `pass`, and a
`?` on condition 8, "920c667b: events this build cannot read (file_change)". The reading
(`e4/verify-reading-rollout.txt`): the Codex implementer's `--json` writes each
`apply_patch` edit as a `file_change` item — `changes: [{path, kind: "update"}]`, keys
exactly `changes, id, status, type` — two of them, both files inside the task's worktree; its
rollout shows the same two edits as code-mode scripts calling `tools.apply_patch` with a
literal patch, and `FileChange` items naming the same paths; every command the record
shows, rollout and stream alike, judges `pass`, and it made no MCP call. Neither a launch nor a
`delegate`, and the run passes on that reading. The verifier leaves `file_change` a question:
T14 taught it one shape, the code-mode `wait`, and no other. Every Codex record was judged
from its rollout under `~/.codex/sessions`: the planner's two, one thread resumed, clean.

The six records are at depth 1 against a cap of 1. The journal for `t14-e4` reads
`worktree-created, git, committed, git, merged, tests-passed, worktree-removed,
branch-deleted`, `defaultShaBeforeMerge` 15e9f4e and `branchHead` 23980ed. The specialists
cost $0.264 (Grok $0.127, Claude $0.137); the Codex specialists reported 260,949 tokens in
and 2,738 out.

Nothing deviated from the loop: step 8's rebase ran where E1 skipped it, and the needs-work
round was the plan reviewer's own verdict, answered through the planner's `resume`. The two
worktree specs, the implementer's `920c667b` and the code reviewer's `de1e73ec`, carry
`protectedPaths` — the worktree's `.git` and the project's — and all six carry deny targets
rooted at the plugin's copy (`node ~/.codex/plugins/cache/agent-team-cli/cross-agent/0.0.1/src/server.ts`);
the planner's and the plan reviewer's four, at the root, carry the deny targets alone, as
`delegate` sets `protectedPaths` only for a verified worktree. The first whole loop with both
under a Codex plugin host; S11's E3 specs carried both before it (E1's note, above).

<!-- @anchor e5 -->
## E5: one `dev-team-engine` task under a Codex host, a Claude lead (2026-10-01)

The Codex host again, the sample switched back to `dev-team-engine` with
`limits.maxDepth: 2` (`e5/config.diff`): the lead on Claude (`claude-sonnet-5`), the
planner on Codex, the plan reviewer on Grok, the implementer on Claude, the code reviewer on
Codex (read-only), each at medium. The prompt: "T14-E5: run this task through the
cross-agent skill in this repository. Task: add `slug_hash(text: str, length: int = 8) ->
str`, a stable short hash of the slug, with tests; use the slug t14-e5."

The host read the launcher skill, called `describe_mode` and `list_roles`, delegated the lead
`a74b6420…`, and waited. The lead's own server, read from `/proc` while it ran
(`e5/proc-lead.json`), was the plugin copy's `src/server.ts --project <sample>` — the lead
mount names the copy the host's server runs from — and carried all four markers with the
lead's values: depth 1, its task id, a lineage of itself, the project. The lead ran the loop,
984 s and $0.755: the planner (Codex) 32 s; the plan reviewer (Grok) 133 s, revise; the
planner resumed, 22 s; the plan reviewer again, 144 s, revise; and then, under the loop's
two-round rule, an `ask` to the operator: fold the two small findings into the implementer's
brief, or plan a third time?

The host's first turn met the question. Its first `wait` returned `running` after 600.008 s
by its own item — a second full ten minutes through the plugin — and `list_tasks` and
`list_asks` found the ask open. Codex then tried its own `request_user_input_async` (the first
call refused for its argument shape, the second "accepted", with no one to answer under
`codex exec`), slept four times 30 s with its own `sleep`, and closed the turn on the question:
"The cross-agent run is paused at the lead's open question…". That is the launcher's
conduct: a question that is the operator's goes to the operator. The operator's answer reached
it by resuming the host's own thread, `codex exec resume <thread> -` with the answer as the
prompt (`e5/resume/`): fold both findings into the implementer's brief, no third round. The
host answered the ask with `answer`, waited 107 s for `done`, and called `result`. The lead
had gone on: the implementer (Claude) 28 s, 90 → 95 tests; `git_mutate` commit `583bfda`; the
code reviewer (Codex, read-only) 29 s, ready; the rebase a no-op; the merge `23980ed` →
`583bfda`; the suite at the root; the worktree and the branch removed.

**The verdict.** `node tools/e2e-verify.mjs --project <sample> --since a74b6420… --slug
t14-e5`, `CODEX_HOME` unset (`e5/e5-verify.txt`): **eight `pass`**, exit 0 — seven records, the
lead judged by the lead row, every Codex record (the planner's thread, resumed, and the code
reviewer) from its rollout. Depth and lineage (`e5/depth-lineage.txt`): the lead at depth 1,
`parentTaskId` null, spec `CROSS_AGENT_DEPTH` 1, its lineage itself; the six specialists at
depth 2, each the lead's child, the lead first in its lineage: PASS. The journal for `t14-e5`
reads `worktree-created, git, committed, git, merged, tests-passed, worktree-removed,
branch-deleted`, `defaultShaBeforeMerge` 23980ed and `branchHead` 583bfda.

**The host's conduct** (`e5/audit-host.txt`, both turns): `describe_mode`, `list_roles`, one
`delegate`, of the lead, two `wait`s, `list_tasks`, three `list_asks`, one `answer` and one
`result` — nothing outside the launcher's engine-placement list, no loop step, no specialist
delegated, no `git` and no test command. **One deviation**: its one shell command, as its
first turn opened, was `cat` of the plugin copy's own `skills/cross-agent/SKILL.md` — Codex
reading the launcher skill it had been offered — which the verifier's tokenizer judges `pass`
but which the launcher does not allow: under engine placement `cross-agent report` and
`cross-agent answer` are "the only commands of yours this placement needs"
(`skills/cross-agent/SKILL.md`). T15 settled it in the launcher's text: where a host is
offered the skill as a file, reading that `SKILL.md` is the one exception
(`tests/skills.test.ts#engineHostReadsSkill`). **Its closing message** (`e5/presentation-reading.txt`): `result`
returned the lead's result file byte for byte, 2678 bytes, and the closing message opens with
it verbatim, with nothing before it or after it. `cross-agent report --since 9ed6c4fc…` renders
E4's six tasks and E5's seven, each `passed`.

The specialists cost $1.134: the Claude lead $0.755, the implementer $0.204, the two Grok
reviews $0.174. The Codex specialists reported 228,873 tokens in and 2,972 out, the host's two
turns 2,030,354 in and 5,036 out. Re-run under this configuration, E4's range takes in E5's
records under the cap of 2 and keeps its one `?`, the `file_change` doubt read above; E5's
stands at eight `pass`. The sample is left on `main` at `583bfda`, 95 tests green, clean, the
root worktree alone, in E5's configuration.


<!-- @anchor t15Attach -->
## T15: the Grok attach (2026-10-01)

T15's runs, in the order they ran: A0, the static facts; A1, the attach candidates, with
A2's result cap; B0, integration probes I1 and I2 under a Grok host, B2's read-only row as
I2's fourth delegation; B1, a deny rule on this server's tools; B3, a ten-minute `wait`;
B4, the hop count and the server's environment; then E6 with B5's worktree readings, and
E7. Their raw evidence — host streams (`host.log`), prompts, the exact commands, each Grok
session's `events.jsonl`, `updates.jsonl` and `mcp/` copied from `~/.grok/sessions/`, the
Codex children's rollouts, `/proc` censuses, the stderr-log watcher's copies, records, config
diffs and the scripts that took them — is in `~/.cache/agent-team/probe-logs/t15-2026-10-01/`,
one directory per run, with every change to the sample's `.grok/` and every exposure in
`timeline.txt`; the records of every run but E6 and E7 were moved to
`~/.cache/agent-team/cross-agent-e2e/probe-tasks/t15/` after their reading. Engines: Claude
Code 2.1.286, codex-cli 0.159.3, grok 1.0.46 (2765805b9442), node 24.11.0, unchanged through
the task; `claude-sonnet-5`, `gpt-6-luna` and `grok-4.7`, each at medium, the hosts included.
Every host was

```
grok --prompt-file <run>/prompt.md --model grok-4.7 --reasoning-effort medium \
  --permission-mode bypassPermissions --output-format streaming-messages-json
```

started in the sample by the archive's `tools/grok-host.sh` as `setsid --fork sh -c 'echo $$ > host.pid;
exec env -C <sample> -u <marker> … grok …'`, so `host.pid` is the `grok` process itself, with
this machine's session markers scrubbed (`CLAUDECODE`, `CLAUDE_*`, `CODEX_COMPANION_*`,
`GROK_CC_*`, `CROSS_AGENT_*`, `MCP_*`, the three API keys) and no `--sandbox`: the operator's
own session. Two hosts were started otherwise: B4's nested row ran from this task's own shell
without `setsid`, and B4's probe (b) exported `CROSS_AGENT_DEPTH=1` after the scrub. Two names
of this task's own shell were not scrubbed, so they reached every host and, through it, every
child and spec: `AI_AGENT` (Claude Code's) and `GIT_EDITOR=true`. A watcher copied
`~/.grok/logs/mcp/cross-agent.stderr.log` once a second whenever it changed, because every
launch of the server truncates it, and that file is where this server's row line
(`src/server.ts#main`) lands under Grok.

**Static facts (A0).** `grok --plugin-dir /tmp/no-such-dir --help` answers `error: unexpected
argument '--plugin-dir' found`, exit 2: the headless `grok` has no such flag. Only `grok
agent` takes `--plugin-dir <DIR>`, "Load a plugin from this directory for this process only
… Used by the Agent SDKs", the ACP route a client would drive. `grok --trust --help`
prints the ordinary help, exit 0: `--trust` is a hidden top-level flag. `grok plugin
validate <worktree>` reads `.claude-plugin/plugin.json` as valid, "components: 1 skill
dir(s), 0 command dir(s), 0 agent dir(s), MCP servers". `grok inspect --json` in the
sample, before anything changed, listed 106 skills (9 user, 22 bundled, 75 from the
operator's Claude Code plugins, which Grok discovers through its `.claude/plugins/`
compatibility), ten Claude Code plugins at user scope, and three MCP servers: T13's
project mount, `context7` from a Claude Code plugin and `claude-design` from
`~/.claude.json`. Its `cross-agent` entry named `~/.grok/config.toml` as its source,
although the table was the project file's.

**The candidates (A1).** (1) `grok -p … --plugin-dir <repo>`: refused statically, above.
(2) The plugin path, project-scoped: T13's `[mcp_servers.cross-agent]` table removed with
`grok mcp remove --scope project cross-agent`, then

```
[plugins]
paths = ["<worktree>"]
enabled = ["cross-agent"]
```

in `<sample>/.grok/config.toml`. Grok read the checkout as a plugin **in place** — no copy:
`grok inspect --json` lists a plugin `cross-agent` of scope `config` at the worktree, the
skill `cross-agent` whose source is `plugin: cross-agent` at the worktree's
`skills/cross-agent/SKILL.md`, and an MCP server `cross-agent` from the same plugin. `grok mcp
doctor` lists `plugin: cross-agent  1 server` among its config sources and reports
`cross-agent (stdio: node <worktree>/src/server.ts)` started, handshake OK, "14 tools
discovered" with the sample in `dev-team-engine`. So grok 1.0.46 reads
`.claude-plugin/plugin.json`'s **inline `mcpServers`** and expands `${CLAUDE_PLUGIN_ROOT}` in
its `args` to the plugin's directory: the one declaration serves Grok as it serves Claude
Code, and no Grok manifest ships. The doctor's server was the doctor's child, its working
directory the sample, and its row the operator's ("operator: no CROSS_AGENT_* variable and no
engine ancestor"). `grok plugin list --json` lists nothing and `grok plugin details
cross-agent` answers "not found": both see installed plugins only, and `grok mcp list` sees
configured servers only. A `paths` entry spelled `~/Documents/…` loaded no plugin at all:
Grok does not expand `~` there. Candidate (2) worked headless and shipped, so (3), a
`.grok/plugins/` link, and (4), the project mount beside a `.grok/skills/` link, were not
run, and (5), `grok plugin install <worktree> --trust`, was not run by ruling: it is the
user-scope route, which would reach every Grok session on the machine.

The first one-turn host under (2), `a1-plugin-paths`, named the skill `cross-agent` in its
`system/init` line's `skills` and the server, `pending`, in its `mcp_servers`; its `tools`
held Grok's 27 built-ins, `search_tool` and `use_tool` among them, and none of this
server's. The fourteen were in the session's catalog instead: `events.jsonl`'s
`mcp_server_starting` names the resolved command and its `mcp_server_connected` the
fourteen tools, and `search_tool` answered `total_hidden_tools: 14` with each as
`cross-agent__<tool>`. Later hosts' `init` lines listed the fourteen and some did not, so
that line is a snapshot either way, and the session's events are the record. The host
reaches the tools as `cross-agent__<tool>` through `use_tool`, whose `tool_result` is Grok's
own envelope, `{"type": "MCP", "tool_name", "server_name", "output": {"OkayOutput": <the
server's text>}}`.

**The result cap (A2).** `describe_mode` answers 19,856 bytes under `dev-team`, 24,608 under
`dev-team-engine` and 3,463 under `solo` at `e436132` (24,880 under `dev-team-engine` after
the lead's report line grew, `40eb844`), and Grok cuts an MCP tool's answer at `[mcp]
max_output_bytes`, 20,000 bytes by default. Under the default the host's `describe_mode`
`tool_result` held 20,437 bytes: the first 19.5 KB and Grok's note "[MCP output truncated:
showing first 19.5 KB of 24.0 KB. Full output written to: <session>/mcp/call-…-2.json …]",
the spilled file byte-identical to the server's answer. With

```
[mcp]
max_output_bytes = 100000
```

added to the project file, the next host's `tool_result` carried the answer whole, 24,608
bytes byte-identical to the server's, closing brace and all, with nothing spilled. The line
ships with the attach. That host also read files outside the sample and ran a second copy
of this server through a shell `node` it wrote itself, to count the answer's characters;
that changed no reading, and B4's two prompts of the same kind forbade shell commands for it.

**What ships**, and stood in the sample from 15:31:00Z (the plugin) and 15:35:22Z (the cap)
to the end of the runs, in place of T13's mount, which had stood since 2026-09-19:

```
[plugins]
paths = ["<repo>"]
enabled = ["cross-agent"]

[mcp]
max_output_bytes = 100000
```

in the project's own `.grok/config.toml`, in a folder Grok trusts. Exposure is T13's: a
project file is read only by Grok sessions started in the project, the operator's own and
every Grok specialist delegated to its root, and nothing was written under `~/.grok/`.
The plugin's server carries no `--project`; Grok starts it in the session's working
directory, where discovery finds the project's `.cross-agent/config.json`
(`src/project.ts#discoverProject`), so the README's recipe runs `cross-agent init` first.
The B1 deny rule was the attach's only other change, appended and removed within the run
(`docs/probes.md#grokDenyMcp`).

**The repoint, T15's last step.** The runs used the worktree's checkout, which the plan's
wrap removes, so once they were over T15 changed `paths` to the root checkout,
`/home/wsh/Documents/agent-team-cli`, by hand (`final/repoint.diff`). That was the whole
edit: the plugin attach has no `[mcp_servers]` table to re-add, and the `[mcp]` table stood.
`grok mcp doctor cross-agent` then reported `cross-agent (stdio: node
/home/wsh/Documents/agent-team-cli/src/server.ts)` started with fourteen tools discovered,
the sample being in `dev-team-engine`, and `grok inspect --json` the plugin, its skill and
its server at the root checkout. The file is `cmp`-equal to what the README's recipe writes
(`final/grok-config.final.toml`). The root checkout serves `main`'s `modes/` and `skills/`
until T15 merges, so a review fix-round rerun of a Grok host session points `paths` back at
the worktree first and forward again after, each edit recorded.

<!-- @anchor i1GrokHost -->
## I1 under a Grok host, B0 (2026-10-01)

One host session in the sample delegated three `consult`s at the project root with I1's
brief, one per engine, each named in its first line ("T15-B0 I1 <engine> under a Grok
host"), and called nothing but `search_tool`, `delegate`, `wait` and `result`. Each row is
read from the child's own log:

- **Claude** (`31cc8f2a…`, 6 s): `system/init` `mcp_servers: []` and 22 tools, none an MCP
  tool; "No MCP tools are visible to me".
- **Codex** (`3cc4783d…`, 27 s, thread `01a0f823-eb55-…`): `--read-rollout` reads no call at
  all, and the rollout names no MCP tool, `codex_apps` included, and nothing of this
  server's; its skill roots are `~/.agents`, `~/.codex/skills` and four plugins Codex keeps
  under `~/.codex/plugins/cache/openai-curated-remote/`, none of them this one, which the
  operator's file holds `enabled = false` (left as found); "I can see no MCP tools. No such
  tool is offered to me at all."
- **Grok** (`8fc5e5f0…`, 22 s): its session's `mcp_server_starting` names `node
  <worktree>/src/server.ts`, the sample's attach inherited, and `mcp_server_connected`
  exactly the five specialist tools; `search_tool` found those five as `cross-agent__<tool>`
  and, asked for `delegate`, only `cross-agent__list_roles`, and the child called nothing:
  `delegate` was never attempted, for want of a schema, as at T14. Its `system/init` `skills`
  also named `cross-agent`: the attach brings the launcher skill to a root specialist beside
  the server, and the specialist row gives the skill no `delegate` to reach.

The Grok child's inherited server, read from the operator's shell while it ran: `node
<worktree>/src/server.ts` in the sample, its environment the runner's child environment
— the four markers with the task's values — plus Grok's own `GROK_SESSION_ID` (the child's),
`__GROK_BWRAP_RUNTIME_SOCKET_DENY` and `__GROK_INSIDE_BWRAP=1`, its status `NoNewPrivs 1`,
`Seccomp 2`. Its chain to pid 1: the server, the inner `grok-1.0.46` binary, `bwrap` — the
engine identity's pid, the runner's `grok` having re-executed into bubblewrap — the runner,
the host's server, the host, `systemd --user`, `init`: one process stands between the server
and the identity. Its row line, as E5's was: `cross-agent: serving the specialist row:
specialist: ancestor 2962996 holds the engine identity of task 8fc5e5f0…, but its environment
cannot be read` — `src/authority.ts#decide`'s fail-closed branch, the identity matched by pid
and start time and its environment unreadable from inside the sandbox
(`src/authority.ts#environOf`). From the operator's shell the same `/proc/<pid>/environ`
read cleanly, so the barrier is the sandbox the server runs in, not a process that cannot
be read. The row is the right one; the reason is new to the tests, which pin the "names no
task" variant of that branch only.

**The operator's Claude Code hooks fire inside a Grok child.** The Grok specialist's
`updates.jsonl` records `hook_execution` events for `session_start`, `user_prompt_submit`,
`stop` and `session_end`, each a hook of a Claude Code plugin the operator installed —
`plugin/codex/hooks`, `plugin/grok-build/hooks`, `plugin/project-steward/hooks` — every one
`success`; B2's `/proc` readings show them running inside the bubblewrap. Grok discovers
those plugins through its Claude compatibility, as it discovers their skills, and no flag
the adapter could pass is documented to turn plugin hooks off (`[compat.claude] hooks`
names `~/.claude/settings.json`). The finding is recorded and left to a bead; no adapter
change follows here.

<!-- @anchor i2GrokHost -->
## I2 under a Grok host, B0 (2026-10-01)

One host session in the sample delegated three `consult`s with `worktree: true`, one per
engine, each brief giving I2's nine steps (T14's, without the GO step) to be run character
for character, then B2's row (`docs/probes.md#i2GrokReadOnly`), then one `verify_worktree`
on the Grok worktree. Verdicts per step, by the filesystem and each engine's own log —
Claude's and Grok's `tool_use` inputs compared with the prescribed commands character for
character, each paired with its `tool_result`, and the Codex child's rollout through
`--read-rollout`:

| step | Claude (`f72ac284…`, 26 s) | Codex (`da95ce06…`, 67 s) | Grok (`99a23221…`, 70 s) |
|---|---|---|---|
| 1 write in the worktree | allowed, `notes.md` present | allowed, present | allowed, present |
| 2 the suite | 95 tests OK | OK | OK |
| 3 `../../ROOT-WRITE.txt` | denied, absent | denied, absent | denied, absent |
| 4 `../../.git/cross-agent-probe-write.txt` | denied, absent | denied, absent | denied, absent |
| 5 `../../.git/hooks/pre-commit` | denied, absent | denied, absent | denied, absent |
| 6 `../other-WRITE.txt` | denied, absent | denied, absent | denied, absent |
| 7 `$HOME/cross-agent-probe-t15-b0-<engine>.txt` | denied, absent | denied, absent | denied, absent |
| 8 the `.git` pointer rewrite | denied, unchanged | denied, unchanged | **allowed**, rewritten |
| 9 `curl https://example.com` | 200 | **`curl: (6) Could not resolve host`, exit 6** | 200 |

Every command was run exactly as prescribed, once. Claude's and Codex's denials read
"Read-only file system", Grok's "Permission denied". The Codex child's scripts printed each
`exec_command` result whole, so `--read-rollout` paired an exit with each command but marks
none `direct`; Codex's own `CommandExecution` items for steps 1, 2 and 9 carry the same exits,
and the filesystem is the witness for the rest. Every engine's sandbox started from the server
the Grok host launched: Claude's and Grok's `bwrap`, seen by task id while they ran, and
Codex's own, its turn's policy `workspace-write` with `network_access: false`. The Grok
child, in its linked worktree, mounted no server of ours: its `mcp_config_resolved` lists
`claude-design` and `context7` alone (`docs/probes.md#grokWorktreeMount`).

The fourth delegation, B2's read-only row at the root, was **refused** while the first
worktree task ran: `refused delegation: <sample> is reserved by task f72ac284… (running);
wait or cancel first`. A writable task holds its workspace and everything that contains it,
so a root task waits for every worktree under it (`src/reservation.ts#reservedBy`). The host
waited the three out and delegated it again, as the launcher says a refusal is answered.

**Grok's rewritten pointer** was answered as the design requires: the host's one
`verify_worktree {path, branch}` on the Grok worktree answered "Cannot resolve the
worktree's Git directories and HEAD branch: Command failed: git -C <worktree> rev-parse
--git-dir … fatal: not a git repository: /tmp/elsewhere", and no ref moved but the three
task branches the delegations made. The worktrees were then removed by hand (`cleanup.txt`):
Grok's pointer restored first, then `git worktree remove --force` and `git branch -D` for
each, and `git worktree prune`, leaving the sample on `main`, clean, the root worktree
alone. The ten-minute row is B3's (`docs/probes.md#grokToolTimeout`).

<!-- @anchor i2GrokReadOnly -->
## The Grok read-only row at the root, B2 (2026-10-01)

A Grok `consult` at the sample root (`b726e2af…`, read-only, 36 s), told to run seven
commands verbatim, one shell command each, and report each exit. Each step has two
witnesses: the `tool_use` block, whose command equals the prescribed one character for
character, with its `tool_result`'s exit and output, and the filesystem afterwards.

| step | command | exit | afterwards |
|---|---|---|---|
| 1 the cwd | `printf t15 > ./PROBE-t15-cwd.txt` | 1, "Permission denied" | absent |
| 2 `<root>/.git` | `printf t15 > .git/PROBE-t15-git.txt` | 1, "Permission denied" | absent |
| 3 `$HOME` | `printf t15 > "$HOME/cross-agent-probe-t15-HOME.txt"` | 1, "Permission denied" | absent |
| 4 the sibling | `printf t15 > ../PROBE-t15-sibling.txt` | 1, "Permission denied" | absent |
| 5 `/tmp` | `printf t15 > /tmp/cross-agent-probe-t15-tmp.txt` | 0 | landed; removed |
| 6 `~/.grok` | `printf t15 > "$HOME/.grok/cross-agent-probe-t15.txt"` | 0 | landed; removed |
| 7 the network | `curl -sS -m 20 https://example.com -o /dev/null -w '%{http_code}'` | 6, "Could not resolve host" | — |

Steps 1–4 held, 5 and 6 are the profile's documented exceptions, and 7 shows the read-only
profile cutting a child's network on Linux. Read from the operator's shell by the record's
`engineIdentity.pid` while it ran (`b2-proc.ndjson`): that pid was `bwrap` from the first
reading, its status `NoNewPrivs 1`, `Seccomp 0`, one `NSpid` (no pid namespace); its
descendants the inner `grok-1.0.46`, this server and the operator's Claude Code plugin
hooks; and its `environ` **readable** — 66 names, the four markers and `GROK_SESSION_ID`
among them — where the server inside the sandbox could not read it. The `bwrap` argv is T13's
1.0.34 shape, `--cap-drop ALL --bind / /` read-write, Grok's own config and trust files bound
read-only, with three more runtime sockets bound to the blocked file (containerd's,
Docker's, podman's): what held was not the mount table but the filesystem's own refusals,
judged here by the files and the transcript. `strict` was not run.

<!-- @anchor grokDenyMcp -->
## A deny rule on this server's tools under Grok, B1 (2026-10-01)

**A driver observation, not a host row**: by Grok's guide a project `[permission] deny` binds
every Grok session in the folder, a host included, so B1 delegated through 6b's stdio driver from the
sample, its server serving the operator row. Two Grok `consult`s at the root, each told to
list its MCP tools and call `cross-agent__list_roles` and then `cross-agent__list_tasks`:

- **control**, the attach as shipped (`2b3b0da5…`, 79 s): the five tools listed;
  `list_roles` answered the six roles; `list_tasks` answered `{"ok": true, "tasks": […]}`.
- **deny**, with `[permission] deny = ["MCPTool(cross-agent__*)"]` appended to the sample's
  `.grok/config.toml` (`2e7a5bf0…`, 30 s): the five tools **still listed** —
  `mcp_server_connected` named them and `search_tool` found them — and both calls refused by
  Grok's permission layer: `tool_result` `is_error: true`, "Tool `use_tool` was not executed:
  Denied by permission policy: deny rule on mcp matching "cross-agent__*"", with
  `permission_resolved decision: "deny"` for each in `events.jsonl` and no
  `mcp_tool_call_started`, so the server never saw the call.

**Gated, not hidden**: a project deny rule binds a headless Grok child under
`bypassPermissions` and leaves this server's tools listed. No adapter change follows: a
Grok specialist is meant to see the five read tools, and the specialist row by ancestry is
the guard. The control's `list_tasks` also answered from inside the child's read-only
bubblewrap without writing: the only files under `.cross-agent/` that changed were the new
task's record and runner locks, created before that server started. The sample's file was
restored to the shipped snapshot afterwards, `cmp`-equal.

<!-- @anchor grokToolTimeout -->
## B3: a ten-minute wait under a Grok host (2026-10-01)

T13's `wait10.txt` prompt under the shipped attach, whose server carries no
`tool_timeout_sec` of its own. The first run is **inconclusive**: its Claude sleeper was
refused by Claude Code 2.1.286 itself — "Blocked: standalone sleep 110 …" — and answered
at 7 s, as S11's B2 found. The second gave the sleeper to Codex (`376d9e87…`, `sleep 110`
seven times in its own sandbox's foreground). The host made one `wait {timeout_seconds:
600}` and nothing else until it returned. Grok's own record of that call, its session's
`events.jsonl`: `mcp_tool_call_started` with `timeout_sec: 6000` at 16:03:09.322Z and
`mcp_tool_call_completed` with `duration_ms: 600003`, `success: true`, `is_timeout: false`
at 16:13:09.326Z. Its `tool_result`, which Grok's runtime writes: `is_error: false`,
`status: "running"`, `stalled: false`, `elapsedSeconds: 605`, `hint: "call wait again"`. The
host's `date -Is` either side read 12:03:00 and 12:13:29, 629 s apart, of which 29 s were the
model's own turns before and after the call. The second `wait` answered `done` after 159 s,
the record settled at 800 s, `result` read "OK", and the host's turn ended `end_turn`. So
Grok's default `tool_timeout_sec`, 6000 s, reaches a plugin's server — every MCP call of the
session reads it — and a 600 s `wait` returns intact under it; the launcher's Grok row says
so (`tests/skills.test.ts#budgetTable`).

<!-- @anchor grokHostHops -->
## The hop count and the server's environment under a Grok host, B4 (2026-10-01)

`/proc` from the host's server to pid 1, the server found as `host.pid`'s child running the
attach's resolved command:

| host | processes from the server to pid 1 | row served |
|---|---|---|
| `grok` started with `setsid --fork` from the sample (A1, B0, B3, E6, E7) | 4: `node`, `grok`, `systemd --user`, `init` | operator |
| the same, with `CROSS_AGENT_DEPTH=1` exported and no task (`b4-depth1`, probe (b) below) | 4: `node`, `grok`, `systemd --user`, `init` | **specialist**, five tools |
| the same command from this task's own shell, no `setsid` | 11: `node`, `grok`, `timeout`, `bash`, `claude`, `bash --posix`, `sh -c`, `ghostty`, `nautilus`, `systemd --user`, `init` — 10 without the `timeout` wrapper this run carried | operator, fourteen tools |
| Grok at a terminal; the Grok desktop app | not run: the user's hands | — |

The walk's 32 hops (`src/authority.ts#maxHops`) hold every row with room. **The
environment**: in every host run the server's variable names are the host's own plus
`GROK_SESSION_ID` and nothing else, none dropped — Grok hands a stdio server its whole
environment and adds its session id, with no filter. From a clean host that means no
`CROSS_AGENT_*`; `PATH` and `HOME` are the operator's, `PWD` the launching shell's (`env -C`
leaves it), and `/proc/<server>/cwd` is the session's own directory, which is where a mount
without `--project`, the plugin's, finds its project. **Probe (b)**, `b4-depth1`: the same
launcher with `CROSS_AGENT_DEPTH=1` exported after the scrub and no task id. The server's
environment held `CROSS_AGENT_DEPTH=1` and no other marker, the session's
`mcp_server_connected` listed the specialist row's five, and the watcher's copy reads
`cross-agent: serving the specialist row: specialist: CROSS_AGENT_DEPTH present and no
record matches` (`src/authority.ts#unmatched`). So loop-guard layer 2 holds under Grok by
pass-through: a Grok session started inside a task — from a suite `run_command` runs,
which carries that marker (`src/runcommand.ts#commandEnv`) — gets a specialist's tools, and
the attach needs no `env` table. (The host then reasoned for 15 minutes toward counting
`describe_mode`'s characters with no tool to count with, its prompt having forbidden shell
commands, and the operator stopped it by its pid.)

A Grok specialist's inherited server (B0, B1, B2) carries the runner's child environment,
the host server's names with the four markers, and Grok's own three: its session id, the
runtime-socket deny list and `__GROK_INSIDE_BWRAP`. Every child under a Grok host also
receives the host's `GROK_SESSION_ID`, and in these runs this task's shell's `AI_AGENT` and
`GIT_EDITOR`, none of which `src/guard.ts#childEnv` scrubs; a Grok child replaces the session
id with its own for its server, and no child behaved differently for any of them.

<!-- @anchor grokWorktreeMount -->
## A Grok specialist in a linked worktree, B5 (2026-10-01)

Three readings, recorded on grok 1.0.46 under the shipped attach. **(i)** E6's Grok code
reviewer worked in `<sample>/.worktrees/t15-e6` (`b04f904a…`): its `system/init` named no
`cross-agent` server, its session's `mcp_config_resolved` — under `~/.grok/sessions/<encoded
worktree path>/` — listed `claude-design` and `context7` alone, `mcp_init_completed` counted
no tool, and no server of ours started under it. E6's Grok plan reviewer at the root
(`d366adf2…`), against it: `mcp_config_resolved` lists `cross-agent`, `mcp_server_starting`
names `node <worktree>/src/server.ts`, `mcp_server_connected` the five specialist tools; its
server ran inside its bubblewrap carrying the four markers with the reviewer's values and its
own `GROK_SESSION_ID`, and its row line is the unreadable-environment reason with the
reviewer's task id, as at E5 — the specialist row. B0's I2 Grok child and E7's Grok code
reviewer, in `t15-e7`, read the same way in their worktrees. **(ii)** After E6, a throwaway
worktree by hand, `git -C <sample> worktree add --detach .worktrees/t15-doctor main`: `grok
mcp doctor` there lists `~/.grok/config.toml`, `plugin: context7`, `~/.claude.json` and no
`.mcp.json` — no project file and no `plugin: cross-agent` — and `grok inspect --json` names
the worktree itself as the project root, trusted, with the user's layer its only config
source: trusted, though Grok's guide says a nested checkout is a separate workspace the
folder's grant does not cover. The worktree was removed and the sample left clean, the root
worktree alone. So the `<repo-root>/.grok/config.toml` rule does not reach a linked worktree:
Grok takes it as a project of its own. **(iii)** A Grok specialist in a linked worktree
reaches no MCP server, the plugin's included: the safe direction, and the shipped behaviour
while `.grok/` stays out of the repository. The sample ignores it; a committed
`.grok/config.toml` would sit in every worktree and be read there as that project's own file,
trusted. Only that, or a user-scope mount or install, would change it, and the user declined
the latter; such a specialist would still be held to the five read tools by the specialist
row by ancestry (`docs/probes.md#i1`). The launcher skill follows the same line: every Grok
specialist T15 ran at the root — seven: I1's `consult`, B1's two, B2's `consult`, E6's plan
reviewer and E7's two — listed `cross-agent` in its `system/init` `skills`, and none of the
three in worktrees did.

<!-- @anchor e6 -->
## E6: one `dev-team` task under a Grok host (2026-10-01)

T15's Grok host, the shipped attach, prompted "T15-E6 — a Grok host running the team under
host placement. Run this task through the `cross-agent` skill (`/cross-agent`): add
`slug_snake(text) -> str` — the words `slug_words(text)` returns, joined with single
underscores, so `slug_snake("Hello, Big World!")` is `"hello_big_world"` — beside `slugify`
in `slugkit/`, with tests; use the slug `t15-e6`." The sample was switched to `dev-team` with
`limits.maxDepth: 1` for it (`e6/config.diff`): the planner on Codex (`gpt-6-luna`), the plan
reviewer and the code reviewer on Grok (`grok-4.7`, the code reviewer read-only in the task's
worktree), the implementer on Claude (`claude-sonnet-5`), each at medium — two Grok
specialists, one at the root and one in a linked worktree, under a Grok host, which is what
makes this run B5's record (`docs/probes.md#grokWorktreeMount`). The host ran 330 s over 24
turns, $0.236, and ran the loop itself through the plugin's server:

```
read_file <worktree>/skills/cross-agent/SKILL.md   (Grok's own file tool)
describe_mode, list_roles — the roster printed before any dispatch — list_tasks
git_root status / worktree list / branch --list task/*     → clean, main, none
read_file .cross-agent/config.json
delegate planner (codex)                  → wait 21 s → result   99215630  24 s
delegate plan-reviewer (grok)             → wait 90 s → result   d366adf2  92 s, approve
git_root worktree add -b task/t15-e6 .worktrees/t15-e6 main
delegate implementer (claude, task/t15-e6) → wait 26 s → result  a4c77994  28 s, 95 → 98 tests
git_mutate add -A … ; git_mutate commit    → 1a56f2a
delegate code-reviewer (grok, read-only)  → wait 60 s → result   b04f904a  62 s, ready
git_mutate rebase main                     → up to date
git_root merge --ff-only task/t15-e6       → main 583bfda → 1a56f2a
run_command test where=root                → 98 tests, OK
git_root worktree remove …; git_root branch -d task/t15-e6
read_file .cross-agent/log.md; search_replace → a heading and four lines appended
```

Every call went through `use_tool` as `cross-agent__<tool>` after a `search_tool`, and the
`wait` durations are Grok's own `mcp_tool_call_completed` records, each `done`. The host ran
no shell command at all: it read the skill, the config and the log with its own `read_file`
and appended the log line with its own `search_replace`, and it spawned no subagent. Every
delegation used the role's binding, naming no engine or model; each was narrated in the
launcher's form, "Delegating planner to codex/gpt-6-luna at medium in <sample>". The roster
— five lines, each role's engine, model, effort, workspace and sandbox — came before the
first dispatch (`atc-s96.66`'s recheck, which `## Before anything` asks of a host-placed
loop). Its largest MCP results were `describe_mode`, 20,692 bytes with Grok's envelope under
`dev-team`, and `list_tasks`, 15,465 bytes, which grows with the ledger; its largest
`tool_result` was its `read_file` of the skill, 77,728 bytes.

**The verdict.** `node tools/e2e-verify.mjs --project <sample> --since 99215630… --slug
t15-e6`, `CODEX_HOME` unset, right after the run under `dev-team` (`e6/e6-verify.txt`):
**eight `pass`**, exit 0 — only the root worktree, no `task/*` branch, a clean tree, the
suite on `main`, four records with their logs at depth 1 against a cap of 1, the journal
`worktree-created, git, committed, git, merged, tests-passed, worktree-removed,
branch-deleted` (`defaultShaBeforeMerge` 583bfda, `branchHead` 1a56f2a), and no `delegate`
and no engine launch in any specialist transcript, the Codex planner's judged from its
rollout. The two worktree specs carry `protectedPaths`, the worktree's `.git` and the
project's, and all four carry deny targets rooted at the worktree's server; every spec's
environment also carries the host's `GROK_SESSION_ID` and this task's shell's `AI_AGENT` and
`GIT_EDITOR`, which `src/guard.ts#childEnv` passes on.

Nothing deviated from the loop: step 8's rebase ran, a no-op, and the plan was approved in
one round, so no `resume` was needed (none was injected). The host's server was 4 processes
from pid 1 and served the operator row; the plan reviewer's inherited server served the
specialist row with the unreadable-environment reason, and the code reviewer, in the
worktree, mounted none (`docs/probes.md#grokHostHops`, `#grokWorktreeMount`). The
specialists cost $0.291 (the two Grok reviews $0.124, the Claude implementer $0.167); the
Codex planner reported 48,849 tokens in and 542 out.

<!-- @anchor e7 -->
## E7: one `dev-team-engine` task under a Grok host, a Claude lead (2026-10-01)

The Grok host again, with nothing run between the two that wrote the ledger, the sample
switched to `dev-team-engine` with `limits.maxDepth: 2` and the lead bound to Claude
(`claude-sonnet-5`) (`e7/config.diff`), every other role as E6 bound them. The prompt: "T15-E7
— a Grok host with the loop in a spawned lead. Run this task through the `cross-agent` skill
(`/cross-agent`): add `slug_title(text) -> str` — the words `slug_words(text)` returns, each
with its first character upper-cased, joined with single spaces, so `slug_title("hello big
world")` is `"Hello Big World"` — beside `slugify` in `slugkit/`, with tests; use the slug
`t15-e7`."

The host read the launcher skill with its own `read_file`, called `describe_mode` — whose
24,880 bytes arrived whole, the largest MCP result of the run at 25,836 bytes with Grok's
envelope, under the 100,000 the project file sets (the largest `tool_result`, as in E6, was its
`read_file` of the skill, 77,728 bytes) — and `list_roles`, printed the roster, six
lines with the lead's first, narrated "Delegating lead to claude/claude-sonnet-5 at medium in
<sample>", delegated the lead `46e6d4aa…`, and made one `wait {timeout_seconds: 600}`, which
answered `done` after 459.6 s by Grok's own record, then `result`. That is every call it made:
no `list_tasks` or `list_asks` was due, because no `wait` timed out, and it ran no shell
command, no loop step and no specialist delegation (`e7/host-transcript-reading.txt`). The
roster before the lead is `atc-s96.66`'s recheck under the launcher's new sentence. The host
ran 501 s over 8 turns, $0.068.

The lead's own server, read from `/proc` while it ran, was `node <worktree>/src/server.ts
--project <sample>`, the lead mount, carrying all four markers with the lead's values: depth
1, its task id, a lineage of itself, the project. The lead ran the loop in 462 s, $0.697, with
nothing but this server's tools and no shell command: the root check; the planner (Codex) 36 s;
the plan reviewer (Grok) 96 s, revise — the proposed tests passed under a naive `.split()` too;
the planner resumed, 26 s; the plan reviewer again, 132 s, approve; `git_root worktree add`,
`run_command` setup; the implementer (Claude) 21 s, 98 → 101 tests; `git_mutate` commit
`90281e2`; the code reviewer (Grok, read-only, in the worktree) 57 s, ready; the rebase a no-op;
the merge `1a56f2a` → `90281e2`; the suite at the root; the worktree and the branch removed. It
asked nothing, so the launcher's sentence for a host nobody attends had no ask to meet
(`atc-s96.70` stays unexercised by a run). Both Grok plan reviewers' servers ran inside their
bubblewrap with the lead first in their lineage, their row lines the unreadable-environment
reason; the Grok code reviewer, in the worktree, mounted none.

**The verdict.** `node tools/e2e-verify.mjs --project <sample> --since 46e6d4aa… --slug
t15-e7`, `CODEX_HOME` unset (`e7/e7-verify.txt`): **eight `pass`**, exit 0 — seven records, the
lead judged by the lead row, the Codex planner's thread (resumed once) from its rollout. Depth
and lineage (`e7/depth-lineage.txt`): the lead at depth 1, `parentTaskId` null, spec
`CROSS_AGENT_DEPTH` 1, its lineage itself; the six specialists at depth 2, each the lead's
child, the lead first in its lineage: PASS. The journal for `t15-e7` reads `worktree-created,
git, committed, git, merged, tests-passed, worktree-removed, branch-deleted`,
`defaultShaBeforeMerge` 1a56f2a and `branchHead` 90281e2.

**The report.** `result` returned the lead's result file byte for byte, 1,932 bytes, and the
host's closing message opens with it verbatim, followed by one line of its own — the lead's
id, engine, duration and "No open asks." (`e7/presentation-reading.txt`). Every specialist line
is in the seven-field form `cross-agent report` prints, a duration on each — `planner | codex |
gpt-6-luna | medium | 36s | plan drafted | 73f83ac5…` — which is `atc-s96.64`'s recheck under
the lead's spelled line, and the durations are the ledger's: `cross-agent report --project
<sample> --since 46e6d4aa…` renders the same seven tasks, each `passed`
(`e7/cross-agent-report.txt`).

The specialists cost $1.086: the Claude lead $0.697, the implementer $0.154, the three Grok
reviews $0.236. The Codex planner reported 89,056 tokens in and 817 out, and 114,229 in and
1,357 out resumed. Re-run under this configuration, E6's range takes in E7's records under
the cap of 2 and still reads eight `pass`, eleven records: a combined record check, not E6's
verdict, which is `e6/e6-verify.txt` under `dev-team` (`final-verify-e6-combined.txt`).
The sample is left on `main` at `90281e2`, 101 tests green, clean, the root worktree alone, in
E7's configuration.


<!-- @anchor cliFacts -->
## CLI flag facts (`--help`, 2026-09-09)

Read from `--help` on this machine, with the CLI version, rather than from
memory. These are the flags that design section 3's spawn lines depend on and
that no earlier probe exercised; P8, P9 and P10 above are the runs that used
them. The last two entries are the 6b pre-flight's, for the versions it ran.

<!-- @anchor cliGrok -->
- **Grok Build 1.0.13** (`grok --help`). `--output-format <OUTPUT_FORMAT>`,
  "Output format for headless mode", possible values `plain`, `json`,
  `streaming-json: NDJSON: one ACP session update per line, the agent's native
  format`, `streaming-messages-json: NDJSON in the Anthropic Messages API wire
  format`; default `plain`. `--reasoning-effort <EFFORT>`, "Reasoning effort
  for reasoning models", `[aliases: --effort]`. `--rules <RULES>`, "Extra rules
  to append to the system prompt" — a string, as P9 confirmed.
  `--system-prompt-override <PROMPT>`, "Override the agent's system prompt
  (compat alias: `--system-prompt`)". `--prompt-file <PATH>`, "Single-turn
  prompt from a file", beside `-p, --single <PROMPT>`, "Single-turn prompt.
  Prints the response to stdout and exits", and `--prompt-json <JSON>`: three
  spellings of the same single-turn prompt, so a prompt too long for an
  argument has a flag that takes a path (read again on 2026-09-18 from
  `grok --help` on 1.0.34, which is what the adapter's oversize-role fallback
  now uses; bead `atc-s96.38`). `--include-partial-messages` "Only
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
<!-- @anchor cliClaude -->
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
<!-- @anchor cliCodex -->
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
  is **I2**'s own test, written and guarded rather than run
  (`tests/engines/codex.test.ts#codexI2Real`).
<!-- @anchor cliCodex159 -->
- **codex-cli 0.159.2** (2026-09-30, the 6b pre-flight). `mcp_servers.<id>.tool_timeout_sec`
  defaults to 60 s and `startup_timeout_sec` to 10 s: a reading of the Codex
  configuration reference that day, not a run, which T14 measured: a plugin server
  declaring 60 had a `wait` cut at 60 s, one declaring 3600 held 600 s
  (`docs/probes.md#codexHostTimeout`; S11 gives the lead mount `tool_timeout_sec=3600`).
  Seen in runs: a child spells this server's tools
  `mcp__cross_agent__<tool>` beside its built-in `codex_apps`, and an MCP call is an
  `mcp_tool_call` item with `server` and `tool` fields (`docs/probes.md#i1CodexTracked`);
  commands run through a code-mode `exec` tool calling `tools.exec_command`, and
  `--json` emitted `command_execution` items for some of them only, while the session
  rollout under `~/.codex/sessions/` records every call (`docs/probes.md#codexCacheWritable`).
<!-- @anchor cliGrok144 -->
- **grok 1.0.44** (5b807183dd79, 2026-09-30, the 6b pre-flight). An MCP server's
  `tool_timeout_sec` defaults to 6000 s (the Grok user guide's MCP chapter,
  `~/.grok/docs/user-guide/07-mcp-servers.md:34`): a documentation reading, which T15
  measured (`docs/probes.md#grokToolTimeout`). `--sandbox read-only` and `strict` resolve a built-in runtime-socket deny
  list path by path and refuse to start, exit 1, when one of its paths cannot be
  resolved, while `workspace` and no `--sandbox` started on the same machine
  (`docs/probes.md#grokSandboxSocket`). `--rules` is read beside `--prompt-file`
  (`docs/probes.md#grokRulesBesidePromptFile`).
<!-- @anchor cliGrok146 -->
- **grok 1.0.46** (2765805b9442, 2026-10-01, T15; every run of the task). The headless `grok`
  has no `--plugin-dir`: `grok --plugin-dir /x --help` exits 2, "unexpected argument
  '--plugin-dir' found", and only `grok agent` takes one, for a process an ACP client drives.
  `--trust` is a hidden top-level flag; the guide's own words (`18-sandbox.md`,
  `10-hooks.md`) are that it saves the folder's trust in `~/.grok/trusted_folders.toml` for
  the repository's subdirectories, not a nested checkout — a reading, since T15 granted no
  trust; a linked worktree under the trusted sample was nonetheless reported trusted, a
  project root of its own (`docs/probes.md#grokWorktreeMount`). A project file's `[plugins] paths` names a plugin directory read in place, honoured
  in a trusted folder, its `~` not expanded; such a plugin's `.claude-plugin/plugin.json`
  inline `mcpServers` is read and `${CLAUDE_PLUGIN_ROOT}` expanded to the directory
  (`docs/probes.md#t15Attach`). `grok inspect --json` sees that plugin, its skill and its
  server; `grok plugin list` and `details` see installed plugins only, `grok mcp list`
  configured servers only. A stdio server's stderr goes to
  `~/.grok/logs/mcp/<server>.stderr.log`, truncated on every launch, and the server is
  handed the session's whole environment plus `GROK_SESSION_ID`
  (`docs/probes.md#grokHostHops`). An MCP tool's answer is cut at `[mcp] max_output_bytes`,
  20,000 bytes by default, the rest written under the session's `mcp/` directory; a
  project file may raise it. `tool_timeout_sec` defaults to 6000 s, plugin servers included,
  and held a 600 s call (`docs/probes.md#grokToolTimeout`). A session directory under
  `~/.grok/sessions/<encoded cwd>/<id>/` holds `events.jsonl`, whose `type`s include
  `mcp_config_resolved`, `mcp_server_starting` (the resolved command), `mcp_server_connected`
  (the tool count and names), `mcp_server_failed`, `mcp_init_completed`,
  `mcp_tool_call_started` (with the call's `timeout_sec`), `mcp_tool_call_completed` (its
  `duration_ms` and `is_timeout`), `permission_requested`, `permission_resolved`,
  `tool_started`, `tool_completed`, `turn_started` and `turn_ended`, and `updates.jsonl`,
  whose `hook_execution` updates name every hook that ran. A headless session's
  `system/init` line names MCP servers `pending`; its `tools` list sometimes holds a
  server's tools and sometimes leaves them to `search_tool`, so the events are the record.
  Inside a Grok child's bubblewrap, a stdio server cannot read the `/proc/<pid>/environ` of
  the engine outside it, which the operator's shell can (`docs/probes.md#i1GrokHost`).
  `--max-turns` was never needed: no run hit a turn cap.
<!-- @anchor cliCodex1593 -->
- **codex-cli 0.159.3** (2026-10-01, S11). The configuration reference, read for S11:
  `mcp_servers.<id>.env` is a `map<string,string>` "forwarded to the MCP stdio
  server", and `mcp_servers.<id>.env_vars` an `array<string | {name, source}>` of
  "additional environment variables to whitelist for an MCP stdio server",
  `source = "local"` by default; the bundled `codex-app-tools` plugin whitelists
  `HOME`, `PATH` and its own names that way
  (`~/.codex/plugins/cache/openai-bundled/codex-app-tools/0.1.5/.mcp.json`). A
  documentation reading; what B2 then observed (`docs/probes.md#e2ServerEnv`): a
  stdio server is started with `HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL`, `TERM`
  and `USER` and nothing else of the engine's environment, and `-c
  mcp_servers.<id>.env_vars=[…]` adds the named variables with the engine's own
  values; with `tool_timeout_sec=3600` a lead's `wait` ran 158 s
  (`docs/probes.md#s11CodexLeadTimeout`). The MCP item is 0.159.2's: the `--json`
  `mcp_tool_call` pair, and the rollout's `McpToolCall` with exactly `arguments,
  duration, id, result, server, status, tool, type`, `duration` as `{secs, nanos}`
  and no `started_at_ms` or `completed_at_ms`. A code-mode `exec` cell that yields
  is waited on with Codex's own top-level `wait` function, `{cell_id,
  yield_time_ms}` with or without `max_tokens`, which runs no command. The end-to-end
  verifier answered `?` on it in E2, E2b and E2c, each read by a person; since T14 it
  classifies it as a call that runs no command, in exactly those two shapes and with
  exactly the payload keys every recorded one carries (`type`, `id`, `name`,
  `arguments`, `call_id`, and a passthrough of `turn_id` and `create_time`)
  (`tests/e2e-verify.test.ts#codexCodeModeWait`). Codex does not confine a mounted server to its own
  sandbox: a read-only lead's server wrote the project's ledger. The binary's strings, read on
  2026-10-01 for T14 — a reading, not a run: a plugin manifest is `.codex-plugin/plugin.json`
  ("missing .codex-plugin/plugin.json or valid Agent Plugin manifest"), with
  `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json` named beside it; `mcpServers` is
  "a string or object"; a manifest path "must start with `./` relative to plugin root", "must
  not be `./`" and "must stay within the plugin root"; a marketplace's "local plugin source path
  must start with `./`", "must stay within the marketplace root" and "must not be empty"; an
  Agent Plugins server's "stdio command must be a bare executable name or a contained `./`
  path" and its "stdio `cwd` must be a contained `./`, `${PLUGIN_ROOT}`, or `${PLUGIN_DATA}`
  path"; a plugin version takes "only ASCII letters, digits, `.`, `+`, `_`, and `-`". Which of
  them bind a `.codex-plugin` manifest is the runs' to say, and they found no `${PLUGIN_ROOT}`
  substituted in the inline `command`, `args` or `cwd` the runs tried
  (`docs/probes.md#codexPluginMount`).

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
