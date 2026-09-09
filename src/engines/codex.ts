import { commandPath, engineBin } from "./binaries.ts";
import type { EngineAdapter, EngineEvent, LeadMount, LeadMountSpec, SpawnPlan, SpawnRequest } from "./types.ts";

const unimplemented = () => { throw new Error("codex adapter: not implemented (T7/T8/T9)"); };

/**
 * Codex. The static parts of the contract (design section 3); T8 writes `plan` — where
 * `off` becomes `--sandbox danger-full-access` and a resume re-applies the profile as
 * `-c sandbox_mode=` (P10) — `parseLine` and `finalMessage`, and either implements
 * `finish` or removes it.
 */
const codex = {
  name: "codex",
  sandboxProfiles: { "read-only": "read-only", "workspace-write": "write", off: "off" },

  // Codex's sandbox is the binary's own, so the binary resolving is the whole of the check.
  sandboxSupport(): { ok: true } | { ok: false; reason: string } {
    const bin = engineBin("codex");
    return commandPath(bin) === null
      ? { ok: false, reason: `codex binary ${JSON.stringify(bin)} not found; set engines.codex.bin or CROSS_AGENT_CODEX_BIN` }
      : { ok: true };
  },

  // No deny list: `codex exec` does not honour execpolicy rules files, so the sandbox's
  // own network denial is the layer that holds instead (probes P3/P3b).
  denyArgs(_targets: readonly string[]): string[] {
    return [];
  },

  // Keeps auth, raises no trust prompt, and removes the operator's MCP servers (P5).
  exclusionArgs(): string[] {
    return ["--ignore-user-config"];
  },

  /**
   * The three settings P9 recorded. The third is not optional: `codex exec` runs with
   * approval policy `never`, so without it the lead sees the tools and every call is
   * refused. The values are TOML, so the quotes are part of the argument.
   */
  leadMount(spec: LeadMountSpec, _scratchDir: string): LeadMount {
    // No probed setting carries a server environment, and emitting an unprobed one would
    // be the only flag in this file no run has exercised. A lead's project reaches it
    // through `args` (`--project <root>`), so refusing here loses nothing.
    if (spec.env !== undefined && Object.keys(spec.env).length > 0) {
      throw new Error("codex leadMount: no probed setting carries an env for a mounted server; pass what the lead needs in args");
    }
    return {
      argv: [
        "-c", `mcp_servers.cross-agent.command=${JSON.stringify(spec.command)}`,
        "-c", `mcp_servers.cross-agent.args=${JSON.stringify(spec.args)}`,
        "-c", 'mcp_servers.cross-agent.default_tools_approval_mode="approve"',
      ],
    };
  },

  plan(_request: SpawnRequest): SpawnPlan { return unimplemented(); },
  parseLine(_line: string): EngineEvent | null { return unimplemented(); },
  finish(_rawStdout: string): EngineEvent[] { return unimplemented(); },
  finalMessage(_events: EngineEvent[], _resultFileText: string | null): string { return unimplemented(); },
} satisfies EngineAdapter;

export default codex;
