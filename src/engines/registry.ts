import claude from "./claude.ts";
import codex from "./codex.ts";
import grok from "./grok.ts";
import type { EngineAdapter, EngineName } from "./types.ts";

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
