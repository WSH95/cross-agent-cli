import claude from "./claude.ts";
import codex from "./codex.ts";
import grok from "./grok.ts";
import type { EngineAdapter, EngineName, SandboxMode } from "./types.ts";

/**
 * The built-in adapter table: one file plus one entry per engine. Config-declared adapter
 * modules are not supported, because the runner imports the launch spec's `adapterModule`
 * into its own process, unsandboxed — a config-controlled path there would turn a config
 * file into arbitrary code execution in the orchestrator (design section 3).
 */
export const adapters = { claude, codex, grok } satisfies Record<EngineName, EngineAdapter>;

// `keyof` a union of the three would be the keys they share; each one's keys, unioned,
// is what a distributed conditional gives.
type ProfilesOf<T> = T extends { sandboxProfiles: infer Profiles } ? Extract<keyof Profiles, string> : never;

/** Every profile name a built-in engine accepts. Which engine accepts which is its own map. */
export type SandboxProfile = ProfilesOf<(typeof adapters)[EngineName]>;

export const sandboxProfiles: readonly SandboxProfile[] =
  [...new Set(Object.values(adapters).flatMap((adapter) => Object.keys(adapter.sandboxProfiles)))] as SandboxProfile[];

export function adapterFor(engine: EngineName): EngineAdapter {
  if (!Object.hasOwn(adapters, engine)) throw new Error(`no built-in adapter for engine ${JSON.stringify(engine)}`);
  return adapters[engine];
}

/**
 * Why `engine` has no sandbox profile `profile`, or null when it declares one: the
 * profile and the names the engine accepts, without the engine's own name, so a caller
 * whose message already names the engine names it once.
 */
export function profileFault(engine: EngineName, profile: string): string | null {
  const profiles = adapterFor(engine).sandboxProfiles;
  // Own keys only: `toString` is on every object and is nobody's sandbox profile.
  if (Object.hasOwn(profiles, profile)) return null;
  return `no sandbox profile ${JSON.stringify(profile)}; it accepts ${Object.keys(profiles).join(" | ")}`;
}

/**
 * The one place a `{mode, profile}` pair is constructed. A profile means nothing apart
 * from the engine that declares it, so the mode is never written by hand: everything that
 * needs one asks here, and everything that is handed one re-derives it the same way
 * (`src/engines/spawn.ts`, `src/reservation.ts`).
 */
export function sandboxFor(engine: EngineName, profile: string): { mode: SandboxMode; profile: string } {
  const fault = profileFault(engine, profile);
  if (fault !== null) throw new Error(`engine ${engine} has ${fault}`);
  return { mode: adapterFor(engine).sandboxProfiles[profile], profile };
}
