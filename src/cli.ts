#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, DEFAULT_MODE, initConfig } from "./config.ts";
import { parseFlags } from "./project.ts";

// `cross-agent`, the operator's own entry point (design section 10). `init --mode <name>`
// writes the bind-time config for a mode and is the one verb this step ships, because
// modes need it; `modes`, `tasks`, `report` and the rest are step 13.

const USAGE = "usage: cross-agent init [--mode <name>] [--project <root>]";

export interface CliOutput {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** The exit code this command line earns: 0 done, 1 it could not, 2 it could not be read. */
export function runCli(argv: readonly string[], cwd: string, write: CliOutput): number {
  const [command, ...rest] = argv;
  if (command !== "init") {
    write.err(`cross-agent: ${command === undefined ? "no command" : `unknown command ${JSON.stringify(command)}`}\n${USAGE}\n`);
    return 2;
  }
  const flags = parseFlags(rest, { "--mode": "name", "--project": "root" });
  if ("reason" in flags) {
    write.err(`cross-agent: ${flags.reason}\n${USAGE}\n`);
    return 2;
  }
  const mode = flags.values["--mode"] ?? DEFAULT_MODE;
  let root: string;
  try {
    // An existing directory, resolved before anything is written: `initConfig` creates
    // `.cross-agent/` with its parents, and a typo in `--project` would otherwise leave a
    // project tree somewhere nobody asked for one.
    root = realpathSync(path.resolve(cwd, flags.values["--project"] ?? "."));
  } catch (error) {
    write.err(`cross-agent: cannot resolve the project: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  try {
    const result = initConfig(root, { mode });
    const file = path.join(root, CONFIG_PATH);
    write.out(result.wrote
      ? `cross-agent: wrote ${file} for mode ${mode}\n`
      : `cross-agent: ${file} already exists; nothing was written\n`);
    if (result.ignored.length > 0) {
      write.out(`cross-agent: added ${result.ignored.join(", ")} to ${path.join(root, ".gitignore")}\n`);
    }
    if (result.warning !== undefined) write.err(`cross-agent: ${result.warning}\n`);
    return 0;
  } catch (error) {
    write.err(`cross-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = runCli(process.argv.slice(2), process.cwd(), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
