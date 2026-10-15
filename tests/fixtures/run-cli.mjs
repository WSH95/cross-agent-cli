// The last link of a chain of processes (`tests/fixtures/spawn-child.mjs`): it runs this
// repository's CLI once for each command, each its own child, in this process's environment
// without the three task markers, as a specialist below its engine would after unsetting
// them. So what the CLI answers rests on its ancestry alone. Waits for `<answer>.go` first,
// so the test can write the record the walk has to match before any CLI runs.
//   node run-cli.mjs <answer> <commands>
// <commands> is the path of a JSON array of {args, cwd, preload?}; with `preload`, the CLI
// starts with `operator-ancestry.mjs` imported, as every CLI the suite runs as the operator
// does (`tests/helpers/project.ts#cliEnv`). Renames {results: [{args, code, stdout, stderr}]}
// into <answer> whole, then exits: each CLI has already been waited for.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const [answer, commands] = process.argv.slice(2);
const fixtures = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(fixtures, "..", "..", "src", "cli.ts");
const operator = `--import=${pathToFileURL(path.join(fixtures, "operator-ancestry.mjs")).href}`;
while (!existsSync(`${answer}.go`)) await delay(10);

const markers = ["CROSS_AGENT_TASK", "CROSS_AGENT_DEPTH", "CROSS_AGENT_LINEAGE"];
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !markers.includes(name)));
const results = [];
for (const { args, cwd, preload } of JSON.parse(readFileSync(commands, "utf8"))) {
  const ran = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: "utf8",
    env: preload ? { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, operator].filter(Boolean).join(" ") } : env,
  });
  results.push({ args, code: ran.status, stdout: ran.stdout, stderr: ran.error === undefined ? ran.stderr : String(ran.error) });
}
writeFileSync(`${answer}.tmp`, JSON.stringify({ results }));
renameSync(`${answer}.tmp`, answer);
