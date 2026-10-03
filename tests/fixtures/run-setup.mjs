#!/usr/bin/env node
// One worktree setup through `run_command`'s own function, in a process a test can kill
// while the setup runs: a server that dies under a setup it started.
//   node run-setup.mjs <projectRoot> <worktree> <slug>
import { runCommand } from "../../src/runcommand.ts";

const [root, where, slug] = process.argv.slice(2);
const result = await runCommand(root, { which: "setup", where, slug });
process.stdout.write(`${JSON.stringify(result)}\n`);
