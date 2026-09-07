# Engine probes

What each engine CLI was observed to do when spawned the way the adapters
will spawn it (design section 3). Every entry names the command (from
`tools/probe.mjs`), the date, and the outcome. Versions: Claude Code
2.1.263, Codex 0.153.4, Grok Build 1.0.13, Node 24.11.0, Ubuntu with
bubblewrap installed and `socat` absent.

A first round ran in a repository under `/tmp`; both the Codex and the Grok
sandboxes treat `/tmp` as writable, so those write checks proved nothing
and were rerun under `~/.cache/agent-team/probe-repo`. Rule for the
product: a project under `/tmp` or `$TMPDIR` is not isolated; `dev-team
init` warns about it.

## P1: nested `claude -p` from inside a Claude Code session (2026-09-07)

`claude -p --output-format stream-json --verbose --permission-mode
bypassPermissions --strict-mcp-config --model sonnet --session-id <uuid>
--settings '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true}}'
--disallowedTools <deny list> Edit Write MultiEdit NotebookEdit`, prompt on
stdin, env scrubbed as in section 3, `DEV_TEAM_DEPTH=1`.

- Runs and exits 0 in 10 s; the `CLAUDECODE` guard in the binary does not
  stop a nested `-p` run. The child's shell still shows `CLAUDECODE=1`
  because Claude Code sets it for its own Bash tool, not because the scrub
  failed. `DEV_TEAM_DEPTH` and `DEV_TEAM_LINEAGE` are visible. MCP tools:
  none (`--strict-mcp-config` with no config).
- The sandbox did not engage: "Sandbox disabled: sandbox is enabled but
  dependencies are missing: socat not installed … Commands will run WITHOUT
  sandboxing." Prerequisite for the Claude adapter: `bwrap` and `socat`.
  The adapter must treat that warning as a refusal to spawn (fail closed).

## P2: implementer inside a linked worktree, writes outside it (2026-09-07)

Prompt: append to `notes.md`, run `npm test`, then try to append to
`../../ROOT-WRITE.txt`, `../../.git/dev-team-probe-write.txt`,
`../other-WRITE.txt`, `$HOME/dev-team-probe-HOME.txt`, and finally overwrite
the worktree's `.git` pointer file with `gitdir: /tmp/elsewhere`.

| Engine and command | in-worktree edit, tests | root file | root `.git` | sibling path | `$HOME` | `.git` pointer |
|---|---|---|---|---|---|---|
| Codex: `codex exec --json -o <out> -C <worktree> --sandbox workspace-write --ignore-user-config --skip-git-repo-check -m gpt-6-astra` | success | denied (read-only file system) | denied | denied | denied | denied (Codex protects the `.git` entry even inside the writable cwd) |
| Grok: `grok -p <prompt> --cwd <worktree> --sandbox workspace --permission-mode bypassPermissions --output-format json --session-id <uuid>` | success | denied (permission denied) | denied | denied | denied | **allowed** (the pointer was rewritten; restored by hand afterwards) |
| Claude | not run yet: the sandbox needs `socat` | | | | | |

Consequence: the worktree pointer is writable by a Grok implementer, so
`verify_worktree` and the explicit `--git-dir`/`--work-tree` form (section
4) are necessary, not optional. Tampering is detected, not prevented.

## P3: the deny list (2026-09-07)

Targets: `claude`, `codex`, `grok`, `node <repo>/src/server.ts`,
`node <repo>/src/cli.ts`, `dev-team`; the child is asked to run
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
  `<worktree>/.codex/rules/dev-team.rules`: **not enforced** in `codex
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
{"type": "item.completed", "item": {"id": "item_1", "type": "command_execution", "command": "/bin/bash -lc 'echo \"DEPTH=${DEV_TEAM_DEPTH:-NONE} LINEAGE=${DEV_TEAM_LINEAGE:-NONE}\"'", "aggregated_output": "DEPTH=1 LINEAGE=probe/915db2f4-e5b7-4d5c-a69c-66544ca1330b:codex:/tmp/claude-1000/-home-wsh-Documents-agent-team-devp…", "exit_code": 0, "status": "completed"}}
{"type": "item.completed", "item": {"id": "item_2", "type": "agent_message", "text": "```text\nDEPTH=1 LINEAGE=probe/915db2f4-e5b7-4d5c-a69c-66544ca1330b:codex:/tmp/claude-1000/-home-wsh-Documents-agent-t…"}}
```

### Grok Build, `grok -p … --output-format json`

Not line-delimited: one pretty-printed JSON object spanning many lines,
printed at the end, with `text` (the final message) and `sessionId` (the
resume id). An adapter parses the whole stdout once the process exits;
`--output-format streaming-json` would give line events instead (not
probed).

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
