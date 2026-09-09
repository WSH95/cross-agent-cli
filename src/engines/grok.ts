import { commandPath, engineBin } from "./binaries.ts";
import type { EngineAdapter, EngineEvent, LeadMount, LeadMountSpec, SpawnPlan, SpawnRequest } from "./types.ts";

const unimplemented = () => { throw new Error("grok adapter: not implemented (T7/T8/T9)"); };

/**
 * Grok Build. The static parts of the contract (design section 3); T9 writes `plan`,
 * `parseLine` and `finalMessage` over `streaming-messages-json` (P8), and either
 * implements `finish` — the whole-output `json` fallback is what it would be for — or
 * removes it.
 */
const grok = {
  name: "grok",
  // `strict` is a read-only profile too, so it frees a workspace exactly as `read-only` does.
  sandboxProfiles: { "read-only": "read-only", strict: "read-only", workspace: "write", off: "off" },

  // Grok's sandbox is the binary's own, so the binary resolving is the whole of the check.
  sandboxSupport(): { ok: true } | { ok: false; reason: string } {
    const bin = engineBin("grok");
    return commandPath(bin) === null
      ? { ok: false, reason: `grok binary ${JSON.stringify(bin)} not found; set engines.grok.bin or CROSS_AGENT_GROK_BIN` }
      : { ok: true };
  },

  // One --deny per target, enforced (P3).
  denyArgs(targets: readonly string[]): string[] {
    return targets.flatMap((target) => ["--deny", `Bash(${target} *)`]);
  },

  // Grok has no per-invocation exclusion flag, only the persistent `grok mcp` subcommand.
  // A Grok child inherits the operator's servers, and what makes that safe is the
  // specialist row it resolves to by ancestry (design section 5), not a flag.
  exclusionArgs(): string[] {
    return [];
  },

  /**
   * There is no per-run mount: P9 found that a Grok child inherits `~/.grok/config.toml`,
   * the operator's Grok plugins and the servers declared to Claude in `~/.claude.json`,
   * and that a project-scoped registration is not started for an untrusted folder. So
   * Grok is not a supported engine-placed lead ("The lead model", item 4), and this value
   * describes the specialist path and the operator CLI's own registration instead.
   */
  leadMount(_spec: LeadMountSpec, _scratchDir: string): LeadMount {
    return { argv: [], inherited: true };
  },

  plan(_request: SpawnRequest): SpawnPlan { return unimplemented(); },
  parseLine(_line: string): EngineEvent | null { return unimplemented(); },
  finish(_rawStdout: string): EngineEvent[] { return unimplemented(); },
  finalMessage(_events: EngineEvent[], _resultFileText: string | null): string { return unimplemented(); },
} satisfies EngineAdapter;

export default grok;
