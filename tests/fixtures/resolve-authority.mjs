// Resolves this process's own authority on request, as the server does on every
// `tools/list` and `tools/call`, so a test can place it anywhere in a chain of
// processes and ask again after changing a record. Request n is
// <dir>/request-<n>.json holding the resolver's options; the answer,
// {authority} or {error}, is renamed into <dir>/answer-<n>.json whole, with
// an Infinity depth written as the string "Infinity".
//   node resolve-authority.mjs <dir> <projectRoot>
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveAuthority } from "../../src/authority.ts";

const [dir, projectRoot] = process.argv.slice(2);
for (let n = 1; ; n++) {
  const request = path.join(dir, `request-${n}.json`);
  while (!existsSync(request)) await delay(10);
  let answer;
  try {
    answer = { authority: resolveAuthority(projectRoot, process.env, JSON.parse(readFileSync(request, "utf8"))) };
  } catch (error) {
    answer = { error: error instanceof Error ? error.stack : String(error) };
  }
  const file = path.join(dir, `answer-${n}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(answer, (_key, value) => value === Infinity ? "Infinity" : value));
  renameSync(`${file}.tmp`, file);
}
