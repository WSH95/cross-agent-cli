# Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Engine CLI flags or output formats change (three vendors, frequent releases) | high | medium | Versions and spawn lines pinned in `docs/probes.md`; adapter parser tests on recorded samples; `sandboxSupport` checks before every spawn. |
| Claude's sandbox does not engage (missing `socat`, missing bwrap AppArmor profile on Ubuntu 24.04+) | high on a fresh machine | high | The adapter sends `failIfUnavailable: true` and `allowUnsandboxedCommands: false`, and treats "Sandbox disabled" and an `apply-seccomp` failure as refusals; prerequisites in README and `docs/probes.md`. |
| Claude's sandbox grants more than `allowWrite` names (the cwd by default; a linked worktree's git directory under `<root>/.git`) | found at T13 | high | The launch spec carries `protectedPaths` and the adapter sends `filesystem.denyWrite` for both profiles; P2's three rows and I2's delegated row prove the denials. Rerun P2 after any Claude Code upgrade. |
| Doc citations drift silently when code above a cited line moves | high | medium | Tests are cited by `// @anchor`, passages by `<!-- @anchor -->`, code by `#symbol`; `node tools/check-citations.mjs --since <task base>` after every task reports drift and what it cannot judge. |
| A project under `/tmp` or `$TMPDIR` is not isolated by the Codex or Grok sandbox | medium | high | `cross-agent init` warns; documented in `docs/probes.md`. |
| A Grok child inherits the user's MCP configuration and could see a cross-agent server | medium | medium | The server registers no `delegate` at depth 1; integration probe I1 verifies per host. |
| Process-spawning tests fail inside Codex's sandbox (empty output, EPERM) | high | low | Run the suite unsandboxed or with escalation; noted in AGENTS.md. |
| Two automated cleaners settle the same record between read and rename (until T6) | low | low | Duplicate settlement only; T6's per-record lock removes it. |
| A replacement process that reused the engine leader's pid cannot be told from ours | low | low | Documented limitation in `src/process.ts`; identities include start time. |
| The deny list covers only the listed launch forms | accepted | medium | Scope stated in the README; Codex children cannot reach a model API at all. |
