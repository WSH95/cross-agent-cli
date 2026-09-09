#!/usr/bin/env node
// Citation range checker for the docs. Every claim in docs/design.md and
// docs/probes.md that points at code cites it as `<path from the repository
// root>:<line>` — a single line, a range `a-b`, or a list `a,b`. A citation
// like that goes stale the moment the code moves, and the docs have drifted
// three times in one day. This reads every citation and checks the two things
// a machine can check: the file exists, and every number is a line that file
// has.
//
// It cannot check that the cited line says what the sentence claims. A
// citation that still lands inside the file but now points at a different
// statement passes here and is caught only by a reader — checking the claim
// against the code stays a review duty.
//
//   node tools/check-citations.mjs [FILE...]
//
// With no argument it reads every `.md` under `docs/`. It prints one line per
// miss on stdout,
//
//   docs/design.md:924: src/engines/spawn.ts:999 — file has 264 lines
//
// a summary on stderr, and exits 1 when any miss exists, 0 otherwise.
//
// A citation is a backticked token. `` `:88` `` on its own is a continuation:
// it cites the file of the citation before it, the way the prose reads
// ("`src/ledger.ts:216`, `:229`"). Fenced code blocks are not scanned, so an
// example inside one is not a citation.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// group 1: the path, absent on a continuation. group 2: the line numbers.
const CITATION = /`((?:[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@.+-]+)?:(\d+(?:[-,]\d+)*)`/g;
const FENCE = /^\s{0,3}(```|~~~)/;
// A bare name is still a citation — an ambiguous one — when it names a file.
const FILE_NAME = /\.[A-Za-z0-9]{1,5}$/;

const docs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultDocs();
const lineCounts = new Map();
const misses = [];
let citations = 0;

for (const doc of docs) {
  let text;
  try {
    text = readFileSync(doc, "utf8");
  } catch (err) {
    misses.push(`${label(doc)}: cannot read — ${err.code ?? err.message}`);
    continue;
  }
  let lastPath = null;
  let fenced = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const m of lines[i].matchAll(CITATION)) {
      const [whole, cited, numbers] = m;
      const at = `${label(doc)}:${i + 1}`;
      if (cited !== undefined && !FILE_NAME.test(cited)) continue; // `sandbox:0` and its like
      citations++;
      const target = cited ?? lastPath;
      if (cited !== undefined) lastPath = cited;
      if (target === null) {
        misses.push(`${at}: :${numbers} — continuation cites no file`);
        continue;
      }
      const miss = check(target, numbers);
      if (miss !== null) misses.push(`${at}: ${target}:${numbers} — ${miss}`);
    }
  }
}

for (const miss of misses) console.log(miss);
process.stderr.write(
  `${citations} citations in ${docs.length} file${docs.length === 1 ? "" : "s"}; ${misses.length} miss${misses.length === 1 ? "" : "es"}\n`,
);
process.exit(misses.length > 0 ? 1 : 0);

// The first thing wrong with one citation, or null when nothing is.
function check(cited, numbers) {
  const count = lineCount(cited);
  if (count === null) return "no such file";
  const parts = numbers.split(/[-,]/).map(Number);
  for (const n of parts) {
    if (n < 1) return "line 0 is not a line";
    if (n > count) return `file has ${count} lines`;
  }
  if (numbers.includes("-") && parts[0] > parts[parts.length - 1]) return "backwards range";
  return null;
}

// Lines in a file inside the repository, or null when it is not one.
function lineCount(cited) {
  if (lineCounts.has(cited)) return lineCounts.get(cited);
  const full = path.resolve(repoRoot, cited);
  let count = null;
  if (full === repoRoot || full.startsWith(repoRoot + path.sep)) {
    try {
      const text = readFileSync(full, "utf8");
      // A file ending in a newline has no line after it; one that does not
      // still has a last line.
      count = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    } catch { count = null; }
  }
  lineCounts.set(cited, count);
  return count;
}

function label(doc) {
  const full = path.resolve(doc);
  return full.startsWith(repoRoot + path.sep) ? path.relative(repoRoot, full) : doc;
}

function defaultDocs() {
  const dir = path.join(repoRoot, "docs");
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
    .map((f) => path.join(dir, f)).filter((f) => statSync(f).isFile());
}
