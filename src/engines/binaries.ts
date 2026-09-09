import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { EngineName } from "./types.ts";

/**
 * The binary an engine spawns. `CROSS_AGENT_<ENGINE>_BIN` overrides it, which is how a
 * configured `engines.<e>.bin` and a test's fake engine both reach an adapter: the
 * contract's `sandboxSupport()` takes no request, so this environment is what it can read.
 */
export function engineBin(engine: EngineName, env: Readonly<NodeJS.ProcessEnv> = process.env): string {
  return env[`CROSS_AGENT_${engine.toUpperCase()}_BIN`] ?? engine;
}

/**
 * Where `command` resolves, or null. A command carrying a separator is a path and is
 * taken as one; a bare name is searched for on PATH, as the engine's own spawn will.
 */
export function commandPath(command: string, env: Readonly<NodeJS.ProcessEnv> = process.env): string | null {
  if (command === "") return null;
  if (command.includes("/") || command.includes(path.sep)) {
    const resolved = path.resolve(command);
    return executable(resolved) ? resolved : null;
  }
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    if (entry === "") continue;
    const candidate = path.resolve(entry, command);
    if (executable(candidate)) return candidate;
  }
  return null;
}

// A directory answers X_OK too, so the file check comes first.
function executable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
