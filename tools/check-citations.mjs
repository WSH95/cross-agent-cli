#!/usr/bin/env node
// Citation checker for the docs. Every claim in docs/design.md and
// docs/probes.md that points at code cites it by a path from the repository
// root and either a symbol or a line: `src/ledger.ts#update` names a
// top-level declaration, and `src/ledger.ts:216` names a line — a single
// line, a range `a-b`, or a list `a,b`. A line citation goes stale the moment
// the code above it moves, and the docs have drifted three times in one day;
// a symbol citation moves with its declaration. This reads every citation and
// checks what a machine can check: the file exists, every number is a line
// that file has, and every symbol is one that file names.
//
// A file names a symbol when it declares it at column 0 — `function`,
// `async function`, `const`, `let`, `class`, `interface` or `type`, each
// optionally after `export ` — or when it carries a comment line
// `// @anchor <symbol>`, which may be indented to name a spot inside a body.
// The lookup is a regular expression over the file's lines, not a parse.
//
// It cannot check that the cited code says what the sentence claims. A
// citation that still lands inside the file but now points at a different
// statement passes here and is caught only by a reader — checking the claim
// against the code stays a review duty.
//
//   node tools/check-citations.mjs [--root DIR] [FILE...]
//
// With no file argument it reads every `.md` under `docs/`. `--root` resolves
// citations against DIR instead of this repository. It prints one line per
// miss on stdout,
//
//   docs/design.md:924: src/engines/spawn.ts:999 — file has 264 lines
//   docs/design.md:931: src/engines/spawn.ts#spawnEngin — no such symbol
//
// a summary on stderr that counts line and symbol citations separately, and
// exits 1 when any miss exists, 0 otherwise.
//
// A citation is a backticked token. `` `:88` `` or `` `#update` `` on its own
// is a continuation: it cites the file of the citation before it, the way the
// prose reads ("`src/ledger.ts:216`, `:229`"). A citation that a line wrap
// split — the path ending one line and the `:88` or `#update` beginning the
// next — is joined and reported at the line it starts on. A
// **brace-expansion** path (`src/engines/{codex,grok}.ts:12`) is a miss rather
// than a skip: a line number or a symbol belongs to one file, and there is no
// way to tell which. Fenced code blocks are not scanned, so an example inside
// one is not a citation.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const repoRoot = rootFlag === -1
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  : path.resolve(argv.splice(rootFlag, 2)[1] ?? ".");

// group 1: the path, absent on a continuation. group 2: the line numbers of a
// line citation; group 3: the symbol of a symbol citation. A line wrap may
// fall on either side of the colon or the hash, so one newline is allowed
// there; nothing but blanks may travel with it.
const GAP = "[ \\t]*\\n?[ \\t]*";
const NAME = "[A-Za-z0-9_@.+{},-]";
const SYMBOL = "[A-Za-z_$][A-Za-z0-9_$]*";
const CITATION = new RegExp(
  `\`((?:${NAME}+/)*${NAME}+)?${GAP}(?::${GAP}(\\d+(?:[-,]\\d+)*)|#${GAP}(${SYMBOL}))\``, "g");
const FENCE = /^\s{0,3}(```|~~~)/;
// A bare name is still a citation — an ambiguous one — when it names a file.
const FILE_NAME = /\.[A-Za-z0-9]{1,5}$/;
// A declaration names a symbol only at column 0, where it is top level; an
// anchor comment names one at any indentation.
const DECLARATION = new RegExp(`^(?:export )?(?:async function|function|const|let|class|interface|type) (${SYMBOL})`);
const ANCHOR = new RegExp(`^[ \\t]*// @anchor (${SYMBOL})`);

const docs = argv.length > 0 ? argv : defaultDocs();
const files = new Map();
const misses = [];
let lineCitations = 0;
let symbolCitations = 0;

for (const doc of docs) {
  let text;
  try {
    text = readFileSync(doc, "utf8");
  } catch (err) {
    misses.push(`${label(doc)}: cannot read — ${err.code ?? err.message}`);
    continue;
  }
  // The scan is over the whole document, so a wrapped citation is one match
  // and continuations still bind in reading order. Fenced blocks are excluded
  // by the line a match starts on.
  const lines = text.split("\n");
  const fenced = new Set();
  let inFence = false;
  const starts = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(offset);
    offset += lines[i].length + 1;
    if (FENCE.test(lines[i])) { inFence = !inFence; fenced.add(i); continue; }
    if (inFence) fenced.add(i);
  }
  let lastPath = null;
  for (const m of text.matchAll(CITATION)) {
    const [, cited, numbers, symbol] = m;
    const line = lineOf(starts, m.index);
    if (fenced.has(line)) continue;
    const at = `${label(doc)}:${line + 1}`;
    if (cited !== undefined && !FILE_NAME.test(cited)) continue; // `sandbox:0` and its like
    const ref = numbers !== undefined ? `:${numbers}` : `#${symbol}`;
    if (numbers !== undefined) lineCitations++; else symbolCitations++;
    if (cited !== undefined && /[{}]/.test(cited)) {
      misses.push(`${at}: ${cited}${ref} — brace expansion cannot be checked; cite one file`);
      continue;
    }
    const target = cited ?? lastPath;
    if (cited !== undefined) lastPath = cited;
    if (target === null) {
      misses.push(`${at}: ${ref} — continuation cites no file`);
      continue;
    }
    const miss = numbers !== undefined ? checkLines(target, numbers) : checkSymbol(target, symbol);
    if (miss !== null) misses.push(`${at}: ${target}${ref} — ${miss}`);
  }
}

for (const miss of misses) console.log(miss);
process.stderr.write(
  `${lineCitations + symbolCitations} citations in ${docs.length} file${docs.length === 1 ? "" : "s"}` +
    ` (${lineCitations} by line, ${symbolCitations} by symbol);` +
    ` ${misses.length} miss${misses.length === 1 ? "" : "es"}\n`,
);
process.exit(misses.length > 0 ? 1 : 0);

// The first thing wrong with one line citation, or null when nothing is.
function checkLines(cited, numbers) {
  const file = fileAt(cited);
  if (file === null) return "no such file";
  const parts = numbers.split(/[-,]/).map(Number);
  for (const n of parts) {
    if (n < 1) return "line 0 is not a line";
    if (n > file.count) return `file has ${file.count} line${file.count === 1 ? "" : "s"}`;
  }
  if (numbers.includes("-") && parts[0] > parts[parts.length - 1]) return "backwards range";
  return null;
}

// What is wrong with one symbol citation, or null when nothing is.
function checkSymbol(cited, symbol) {
  const file = fileAt(cited);
  if (file === null) return "no such file";
  return file.symbols.has(symbol) ? null : "no such symbol";
}

// A file inside the repository — how many lines it has and the symbols it
// names — or null when it is not one.
function fileAt(cited) {
  if (files.has(cited)) return files.get(cited);
  const full = path.resolve(repoRoot, cited);
  let file = null;
  if (full === repoRoot || full.startsWith(repoRoot + path.sep)) {
    try {
      const text = readFileSync(full, "utf8");
      const lines = text.split("\n");
      const symbols = new Set();
      for (const line of lines) {
        const named = DECLARATION.exec(line) ?? ANCHOR.exec(line);
        if (named !== null) symbols.add(named[1]);
      }
      // An empty file has no lines at all. A file ending in a newline has no
      // line after it; one that does not still has its last line.
      const count = text === "" ? 0 : text.endsWith("\n") ? lines.length - 1 : lines.length;
      file = { count, symbols };
    } catch { file = null; }
  }
  files.set(cited, file);
  return file;
}

// The 0-based line a byte offset falls on.
function lineOf(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid; else high = mid - 1;
  }
  return low;
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
