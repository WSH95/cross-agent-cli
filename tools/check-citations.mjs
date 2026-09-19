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
// Neither counts inside a `/* … */` comment or a template literal that spans
// lines: the scan carries from line to line whether it is in code, a block
// comment or a template, and skips quotes, line comments and regular
// expressions within a line. It is a lexical scan over lines, not a parse, so
// a backtick inside a string inside `${…}` still reads as the template's end.
//
// It cannot check that the cited code says what the sentence claims. A
// citation that still lands inside the file but now points at a different
// statement passes here and is caught only by a reader — checking the claim
// against the code stays a review duty.
//
//   node tools/check-citations.mjs [--root DIR] [--since REV] [FILE...]
//
// With no file argument it reads every `.md` under `docs/`. `--root` resolves
// citations against DIR instead of this repository. `--since REV` adds the
// check this one cannot make on its own: for every line citation it compares
// the cited line's text at REV with the text now and reports each one that
// differs, or says it could not judge the citation — a line past REV's end of
// file, in a file that has grown since, is reported rather than skipped. A
// symbol or anchor citation moves with what it names and is never compared. It prints one line per
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
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const repoRoot = rootFlag === -1
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  : path.resolve(argv.splice(rootFlag, 2)[1] ?? ".");
const sinceFlag = argv.indexOf("--since");
const since = sinceFlag === -1 ? null : argv.splice(sinceFlag, 2)[1];

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
// A document declares nothing, so the only name it can offer is one it puts there: an
// HTML comment above the section, which moves with the section when the file grows. It is
// what lets a doc cite another doc's passage without a line number to go stale.
const MARKDOWN_ANCHOR = new RegExp(`^[ \\t]*<!--[ \\t]*@anchor (${SYMBOL})[ \\t]*-->`);
// Text before a slash that leaves an operand to come: the slash opens a
// regular expression rather than dividing.
const OPERAND = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|instanceof|case|do|else|in|of|delete|void|throw|yield|await))\s*$/;

const docs = argv.length > 0 ? argv : defaultDocs();
const files = new Map();
const historical = new Map();
const misses = [];
const drifts = [];
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
    // A citation that still lands inside its file may have stopped landing on what the
    // sentence claims: an insertion above it moves the content down and nothing here can
    // see that. Given a revision, the text of each cited line then is compared with the
    // text now, which is exactly the drift a passing checker hides.
    else if (since !== null && numbers !== undefined) {
      const moved = driftOf(target, numbers);
      if (moved === null) continue;
      drifts.push(moved.unjudged !== undefined
        ? `${at}: ${target}${ref} — not judged: ${moved.unjudged}`
        : `${at}: ${target}${ref} — drifted since ${since}\n    was: ${moved.was}\n    now: ${moved.now}`);
    }
  }
}

for (const miss of misses) console.log(miss);
for (const drift of drifts) console.log(drift);
process.stderr.write(
  `${lineCitations + symbolCitations} citations in ${docs.length} file${docs.length === 1 ? "" : "s"}` +
    ` (${lineCitations} by line, ${symbolCitations} by symbol);` +
    ` ${misses.length} miss${misses.length === 1 ? "" : "es"}` +
    (since === null ? "" : `; ${drifts.length} drifted since ${since}`) + "\n",
);
process.exit(misses.length + drifts.length > 0 ? 1 : 0);

/**
 * The first line of this citation whose text has changed since `--since`, with both
 * texts, or null when none has. Whitespace is normalised, because reindenting a line is
 * not moving the content out from under a sentence; a file the revision does not hold has
 * nothing to compare against, and a symbol citation never reaches here at all.
 */
function flat(line) {
  return line.replace(/\s+/g, " ").trim();
}

/**
 * The first line of this citation whose text has changed since `--since`, with both
 * texts — or the reason it could not be judged, which is never silence: a citation past
 * the revision's end of file is exactly the case that hid a whole document's stale
 * pointers, because the file had grown and nothing compared them. Whitespace is
 * normalised, because reindenting a line is not moving the content out from under a
 * sentence; a file the revision does not hold at all has nothing to compare against, and
 * a symbol citation never reaches here.
 */
function driftOf(cited, numbers) {
  const before = fileAtRevision(cited);
  if (before === null) return null;
  const now = fileAt(cited);
  if (now === null) return null;
  // A file ending in a newline leaves an empty last element, which is no line.
  const had = before.length > 0 && before[before.length - 1] === "" ? before.length - 1 : before.length;
  // Every line the citation covers, the interior of a range included: an insertion inside
  // one moves what it covers even when both ends still say what they said.
  const parts = numbers.split(/[-,]/).map(Number);
  const lines = numbers.includes("-")
    ? Array.from({ length: parts[parts.length - 1] - parts[0] + 1 }, (_value, index) => parts[0] + index)
    : parts;
  for (const n of lines) {
    if (n > had) return { unjudged: `the revision's file had ${had} line${had === 1 ? "" : "s"}` };
    if (n > now.count) continue;
    const was = before[n - 1];
    const text = now.lines[n - 1];
    if (flat(was) !== flat(text)) return { was: was.trim(), now: text.trim() };
  }
  return null;
}

/** The cited file's lines at `--since`, or null when the revision does not hold it. */
function fileAtRevision(cited) {
  if (historical.has(cited)) return historical.get(cited);
  let lines = null;
  try {
    lines = execFileSync("git", ["-C", repoRoot, "show", `${since}:${cited}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
  } catch {
    // Added since, or not tracked, or not a repository: nothing to compare.
  }
  historical.set(cited, lines);
  return lines;
}

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
      if (cited.endsWith(".md")) {
        // Prose, not code: the code state machine's quotes and backticks mean nothing
        // here, and the only names are the anchors the document writes down.
        for (const line of lines) {
          const named = MARKDOWN_ANCHOR.exec(line);
          if (named !== null) symbols.add(named[1]);
        }
      } else {
        let state = "code";
        for (const line of lines) {
          if (state === "code") {
            const named = DECLARATION.exec(line) ?? ANCHOR.exec(line);
            if (named !== null) symbols.add(named[1]);
          }
          state = stateAfter(line, state);
        }
      }
      // An empty file has no lines at all. A file ending in a newline has no
      // line after it; one that does not still has its last line.
      const count = text === "" ? 0 : text.endsWith("\n") ? lines.length - 1 : lines.length;
      // `lines` for `--since`, which compares a cited line's text with its text at a
      // revision; the checker's own pass needs only the count and the symbols.
      file = { count, symbols, lines };
    } catch { file = null; }
  }
  files.set(cited, file);
  return file;
}

// Whether the line after this one starts in code, in a block comment, or in a
// template literal. Quotes, line comments and regular expressions end with
// their line, so they are only skipped here. A slash starts a regular
// expression where an operand is expected and divides anywhere else.
function stateAfter(line, state) {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (state === "block") {
      if (c === "*" && line[k + 1] === "/") { state = "code"; k++; }
    } else if (state === "template") {
      if (c === "\\") k++;
      else if (c === "`") state = "code";
    } else if (c === "`") state = "template";
    else if (c === '"' || c === "'") k = closing(line, k) ?? line.length;
    else if (c === "/" && line[k + 1] === "/") break;
    else if (c === "/" && line[k + 1] === "*") { state = "block"; k++; }
    else if (c === "/" && OPERAND.test(line.slice(0, k))) k = closing(line, k) ?? k;
  }
  return state;
}

// The index of the quote or slash that closes the one at `start` on this
// line, past escapes and, for a regular expression, a `[…]` class; or null.
function closing(line, start) {
  let inClass = false;
  for (let k = start + 1; k < line.length; k++) {
    if (line[k] === "\\") k++;
    else if (line[start] === "/" && line[k] === "[") inClass = true;
    else if (line[start] === "/" && line[k] === "]") inClass = false;
    else if (line[k] === line[start] && !inClass) return k;
  }
  return null;
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
