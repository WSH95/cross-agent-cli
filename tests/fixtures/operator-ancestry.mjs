// Loaded with `node --import` into every CLI the suite starts as the operator, so the suite's
// own CLI runs walk as the operator wherever the suite runs, a task's engine included: this
// process's own /proc/<pid>/stat reads with its parent (field 4) as 0, so the walk of
// `src/authority.ts#resolveAuthority` reaches the root at its first step and meets no
// ancestor. It works because `src/ledger.ts#readProcessStat` reads through
// `fs.readFileSync(path, "utf8")`; every other path passes through unchanged. A test of the
// walk itself starts the CLI without it (`tests/authority.test.ts#cliBelowEngine`).
import fs from "node:fs";

const own = `/proc/${process.pid}/stat`;
const original = fs.readFileSync;

fs.readFileSync = function readFileSync(target, ...rest) {
  const read = original.call(fs, target, ...rest);
  if (target !== own) return read;
  const text = String(read);
  const end = text.lastIndexOf(")") + 1;
  const fields = text.slice(end).trim().split(/\s+/);
  fields[1] = "0";
  const rewritten = `${text.slice(0, end)} ${fields.join(" ")}\n`;
  return typeof read === "string" ? rewritten : Buffer.from(rewritten);
};
