import path from "node:path";
import { commandPath } from "./binaries.ts";
import type { EngineAdapter, EngineEvent, LeadMount, LeadMountSpec, SpawnPlan, SpawnRequest } from "./types.ts";

const unimplemented = () => { throw new Error("claude adapter: not implemented (T7/T8/T9)"); };

/**
 * Claude Code. The static parts of the contract (design section 3); T7 writes `plan`,
 * `parseLine` and `finalMessage`, and either implements `finish` or removes it — a line
 * stream needs none, and only a declared `finish` makes the pipeline buffer raw stdout.
 */
const claude = {
  name: "claude",
  sandboxProfiles: { "read-only": "read-only", "workspace-write": "write", off: "off" },

  /**
   * P1's prerequisites are Linux's: `bwrap` for the sandbox and `socat` for its network
   * proxy. On Ubuntu 24.04 and later an AppArmor profile for `/usr/bin/bwrap` is needed
   * too, and probing that — the "Sandbox disabled" warning and a sandbox that engages but
   * can start no command — is `atc-s96.17`'s. No other platform's sandbox has been
   * observed, so none is refused here; the engine refuses on its own if its sandbox
   * cannot start.
   */
  sandboxSupport(): { ok: true } | { ok: false; reason: string } {
    if (process.platform !== "linux") return { ok: true };
    const missing = ["bwrap", "socat"].filter((command) => commandPath(command) === null);
    return missing.length === 0
      ? { ok: true }
      : { ok: false, reason: `${missing.join(" and ")} not found on PATH; Claude's Linux sandbox needs bwrap and socat (probe P1)` };
  },

  // Both forms in one appendable array, enforced under bypassPermissions (P3).
  denyArgs(targets: readonly string[]): string[] {
    return ["--disallowedTools", ...targets.flatMap((target) => [`Bash(${target} *)`, `Bash(${target})`])];
  },

  // What makes a mount exclusive: dropping it pulled in five of the operator's own
  // servers in an otherwise identical run (P9).
  exclusionArgs(): string[] {
    return ["--strict-mcp-config"];
  },

  leadMount(spec: LeadMountSpec, scratchDir: string): LeadMount {
    const file = path.join(scratchDir, "mcp-config.json");
    const contents = JSON.stringify(
      { mcpServers: { "cross-agent": { command: spec.command, args: spec.args, env: spec.env } } }, null, 2,
    ) + "\n";
    return { argv: ["--mcp-config", file], files: [{ path: file, contents }] };
  },

  plan(_request: SpawnRequest): SpawnPlan { return unimplemented(); },
  parseLine(_line: string): EngineEvent | null { return unimplemented(); },
  finish(_rawStdout: string): EngineEvent[] { return unimplemented(); },
  finalMessage(_events: EngineEvent[], _resultFileText: string | null): string { return unimplemented(); },
} satisfies EngineAdapter;

export default claude;
