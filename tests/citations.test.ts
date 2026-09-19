import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const checker = path.join(repoRoot, "tools", "check-citations.mjs");

function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [checker, ...args], { cwd: repoRoot });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.stderr.on("data", (chunk: string) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end();
  });
}

async function docWith(t: { after: (fn: () => unknown) => void }, body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "citations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const doc = path.join(dir, "doc.md");
  await writeFile(doc, body, "utf8");
  return doc;
}

// A throwaway repository root holding the given files; cite them with `--root`.
async function rootWith(t: { after: (fn: () => unknown) => void }, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "citations-root-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body, "utf8");
  return dir;
}

// A repository of its own, so `--since` has a revision to compare against.
async function repositoryWith(t: { after: (fn: () => unknown) => void }, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "citations-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body, "utf8");
  const git = promisify(execFile);
  await git("git", ["-C", dir, "init", "-b", "main"]);
  await git("git", ["-C", dir, "add", "-A"]);
  await git("git", ["-C", dir, "-c", "user.name=Cross Agent Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "base"]);
  return dir;
}

test("--since reports a citation whose cited line moved under it, and what it cannot judge", async (t) => {
  const dir = await repositoryWith(t, {
    "code.ts": "export function first() {}\nexport function second() {}\n",
    "doc.md": "The second one (`code.ts:2`) is what this sentence is about.\n",
  });
  const doc = path.join(dir, "doc.md");

  // Nothing has moved yet: the line still says what it said at the revision.
  const clean = await run(["--root", dir, "--since", "HEAD", doc]);
  assert.equal(clean.code, 0, clean.out);
  assert.equal(clean.out, "");

  // An insertion above the cited line leaves the citation in range, so the checker's own
  // pass still sees nothing wrong — and the sentence now points at the wrong function.
  await writeFile(path.join(dir, "code.ts"), "// a new line\nexport function first() {}\nexport function second() {}\n", "utf8");
  const blind = await run(["--root", dir, doc]);
  assert.equal(blind.code, 0, blind.out);
  const drifted = await run(["--root", dir, "--since", "HEAD", doc]);
  assert.equal(drifted.code, 1);
  assert.match(drifted.err, /1 drifted since HEAD, 0 not judged/);
  const lines = drifted.out.trim().split("\n");
  assert.equal(lines.length, 3, drifted.out);
  assert.match(lines[0], /doc\.md:1: code\.ts:2 — drifted since HEAD$/);
  assert.match(lines[1], /^ {4}was: export function second\(\) \{\}$/);
  assert.match(lines[2], /^ {4}now: export function first\(\) \{\}$/);

  // Re-pointed at the line the sentence means, the drift is gone — and what is left is
  // the honest answer that the revision's file never had a third line, so this citation
  // is one the comparison cannot judge rather than one it has cleared.
  await writeFile(doc, "The second one (`code.ts:3`) is what this sentence is about.\n", "utf8");
  const repointed = await run(["--root", dir, "--since", "HEAD", doc]);
  assert.equal(repointed.code, 1);
  assert.match(repointed.out, /doc\.md:1: code\.ts:3 — not judged: the revision's file had 2 lines/);
  assert.equal(repointed.out.includes("drifted"), false, repointed.out);
});

test("--since says so when a cited line is past what the revision had, and walks a range's interior", async (t) => {
  const dir = await repositoryWith(t, {
    "code.ts": "export function first() {}\nexport function second() {}\n",
    "doc.md": "The pair (`code.ts:1-2`) and a line past the end (`code.ts:4`).\n",
  });
  const doc = path.join(dir, "doc.md");
  // At HEAD the file has two lines, so `:4` is a citation the comparison cannot judge —
  // and silence about it is what let a whole document's pointers go stale unnoticed.
  await writeFile(path.join(dir, "code.ts"), "export function first() {}\nexport function second() {}\nexport function third() {}\nexport function fourth() {}\n", "utf8");
  const answered = await run(["--root", dir, "--since", "HEAD", doc]);
  assert.equal(answered.code, 1);
  assert.match(answered.out, /doc\.md:1: code\.ts:4 — not judged: the revision's file had 2 lines/);

  // A range is its interior too: an insertion inside one moves what the range covers,
  // even when both ends still say what they said.
  await writeFile(path.join(dir, "code.ts"), "export function first() {}\nconst between = 1;\nexport function second() {}\n", "utf8");
  await writeFile(doc, "The pair (`code.ts:1-3`).\n", "utf8");
  const interior = await run(["--root", dir, "--since", "HEAD", doc]);
  assert.equal(interior.code, 1);
  assert.match(interior.out, /doc\.md:1: code\.ts:1-3 — drifted since HEAD/);
  assert.match(interior.out, /was: export function second\(\) \{\}/);
  assert.match(interior.out, /now: const between = 1;/);
});

test("--since ignores whitespace, a file the revision does not have, and every symbol citation", async (t) => {
  const dir = await repositoryWith(t, {
    "code.ts": "export function only() {}\n",
    "doc.md": "Here (`code.ts:1`) and by name (`code.ts#only`).\n",
  });
  const doc = path.join(dir, "doc.md");
  // Respaced, not moved: a line whose text differs only in whitespace has not drifted.
  await writeFile(path.join(dir, "code.ts"), "export function only() {}   \n", "utf8");
  const reindented = await run(["--root", dir, "--since", "HEAD", doc]);
  assert.equal(reindented.code, 0, reindented.out);

  // A file the revision does not hold has nothing to compare against, and a symbol
  // citation moves with its own declaration, which is the whole reason to prefer one.
  await writeFile(path.join(dir, "added.ts"), "export const fresh = 1;\n", "utf8");
  await writeFile(doc, "New (`added.ts:1`), by name (`code.ts#only`), and respaced (`code.ts:1`).\n", "utf8");
  const mixed = await run(["--root", dir, "--since", "HEAD", doc]);
  assert.equal(mixed.code, 0, mixed.out);
  assert.equal(mixed.out, "");
});

test("every citation in docs/design.md and docs/probes.md names a line or a symbol its file has", async () => {
  const { code, out, err } = await run([]);
  assert.equal(code, 0, `check-citations reported misses:\n${out}${err}`);
});

test("a line past the end of the cited file is a miss, named with both locations", async (t) => {
  const doc = await docWith(t, "First line.\nThe pipeline refuses (`src/engines/spawn.ts:99999`).\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 1);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^.*doc\.md:2: src\/engines\/spawn\.ts:99999 — file has \d+ lines$/);
});

test("a citation to a file that does not exist is a miss", async (t) => {
  const doc = await docWith(t, "The mode lives in `src/nowhere.ts:3`.\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 1);
  assert.match(out, /doc\.md:1: src\/nowhere\.ts:3 — no such file/);
});

test("a bare file name is a miss: a citation names a path from the repository root", async (t) => {
  const doc = await docWith(t, "It reaches `spawn.ts:3` from there.\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 1);
  assert.match(out, /doc\.md:1: spawn\.ts:3 — no such file/);
});

test("every number in a range and in a list is checked, and the first miss in one citation is reported once", async (t) => {
  const doc = await docWith(t, "Ranges (`src/config.ts:1-99999`) and lists (`src/config.ts:1,99998`).\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 1);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /doc\.md:1: src\/config\.ts:1-99999 — file has \d+ lines/);
  assert.match(lines[1], /doc\.md:1: src\/config\.ts:1,99998 — file has \d+ lines/);
});

test("a backwards range is a miss even when both ends exist", async (t) => {
  const doc = await docWith(t, "Backwards (`src/config.ts:20-10`).\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 1);
  assert.match(out, /doc\.md:1: src\/config\.ts:20-10 — backwards range/);
});

test("a continuation citation is checked against the file named before it", async (t) => {
  const doc = await docWith(t, "The pair (`src/engines/types.ts:1`, `:99999`) is built once.\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 1);
  assert.match(out, /doc\.md:1: src\/engines\/types\.ts:99999 — file has \d+ lines/);
});

test("a continuation before any file citation is a miss rather than a silent skip", async (t) => {
  const doc = await docWith(t, "It refuses (`:12`) outright.\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 1);
  assert.match(out, /doc\.md:1: :12 — continuation cites no file/);
});

test("citations inside their files pass, and the run says on stderr how many it read", async (t) => {
  const doc = await docWith(t, "Lines (`src/config.ts:1`, `:2-3`) and a doc (`docs/design.md:1`).\n");
  const { code, out, err } = await run([doc]);
  assert.equal(code, 0, out);
  assert.equal(out, "");
  assert.match(err, /3 citations in 1 file \(3 by line, 0 by symbol\); 0 misses/);
});

test("the summary on stderr counts line citations and symbol citations separately", async (t) => {
  const dir = await rootWith(t, {
    "a.ts": "export function alpha() {}\nexport const beta = 1;\n",
    "doc.md": "A line (`a.ts:1`), its symbol (`#alpha`), and another (`a.ts#beta`).\n",
  });
  const { code, out, err } = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(code, 0, out);
  assert.match(err, /3 citations in 1 file \(1 by line, 2 by symbol\); 0 misses/);
});

test("a symbol citation passes when the file declares the symbol at top level, in any declaration form", async (t) => {
  const dir = await rootWith(t, {
    "forms.ts": [
      "function plain() {}",
      "async function waited() {}",
      "const fixed = 1;",
      "let moving = 2;",
      "class Thing {}",
      "interface Shape {}",
      "type Alias = string;",
      "export function exportedPlain() {}",
      "export async function exportedWaited() {}",
      "export const exportedFixed = 1;",
      "export let exportedMoving = 2;",
      "export class ExportedThing {}",
      "export interface ExportedShape {}",
      "export type ExportedAlias<T> = T[];",
      "",
    ].join("\n"),
    "doc.md": [
      "Plain (`forms.ts#plain`, `forms.ts#waited`, `forms.ts#fixed`, `forms.ts#moving`,",
      "`forms.ts#Thing`, `forms.ts#Shape`, `forms.ts#Alias`) and exported",
      "(`forms.ts#exportedPlain`, `forms.ts#exportedWaited`, `forms.ts#exportedFixed`,",
      "`forms.ts#exportedMoving`, `forms.ts#ExportedThing`, `forms.ts#ExportedShape`,",
      "`forms.ts#ExportedAlias`).",
      "",
    ].join("\n"),
  });
  const { code, out, err } = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(code, 0, out);
  assert.equal(out, "");
  assert.match(err, /14 citations in 1 file \(0 by line, 14 by symbol\); 0 misses/);
});

test("a symbol the file does not declare, even the start of one it does, is a miss naming the file and the symbol", async (t) => {
  const dir = await rootWith(t, {
    "spawn.ts": "export function spawnEngine() {}\n",
    "doc.md": "First line.\nThe pipeline refuses (`spawn.ts#spawn`).\n",
  });
  const { code, out } = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(code, 1);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^.*doc\.md:2: spawn\.ts#spawn — no such symbol$/);
});

test("a declaration inside a body is not a top-level symbol, so citing it is a miss", async (t) => {
  const dir = await rootWith(t, {
    "nested.ts": "export function outer() {\n  function inner() {}\n  const local = 1;\n}\n",
    "doc.md": "The outer one (`nested.ts#outer`) passes; (`nested.ts#inner`) and (`nested.ts#local`) do not.\n",
  });
  const { code, out } = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(code, 1);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /doc\.md:1: nested\.ts#inner — no such symbol$/);
  assert.match(lines[1], /doc\.md:1: nested\.ts#local — no such symbol$/);
});

test("an // @anchor comment names a symbol, at the margin or indented inside a body", async (t) => {
  const dir = await rootWith(t, {
    "anchored.ts": [
      "export function run(retrying: boolean) {",
      "  if (retrying) {",
      "    // @anchor retryBranch",
      "    return 2;",
      "  }",
      "  return 1;",
      "}",
      "// @anchor tail",
      "",
    ].join("\n"),
    "doc.md": "The retry (`anchored.ts#retryBranch`) and the tail (`anchored.ts#tail`).\n",
  });
  const { code, out, err } = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(code, 0, out);
  assert.match(err, /2 citations in 1 file \(0 by line, 2 by symbol\); 0 misses/);
});

test("a markdown anchor names a symbol, so a section can be cited by name rather than by line", async (t) => {
  const dir = await rootWith(t, {
    "record.md": [
      "# Probes",
      "",
      "<!-- @anchor grokRow -->",
      "## The Grok row",
      "",
      "What it did.",
      "",
    ].join("\n"),
    "doc.md": "The row (`record.md#grokRow`) and a line of it (`record.md:6`).\n",
  });
  const { code, out, err } = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(code, 0, out);
  assert.match(err, /2 citations in 1 file \(1 by line, 1 by symbol\); 0 misses/);

  // A prose file declares nothing, so only its anchors name anything — and an anchor a
  // document does not carry is a miss like any other.
  await writeFile(path.join(dir, "doc.md"), "A section that is not there (`record.md#noSuchSection`).\n", "utf8");
  const missing = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /record\.md#noSuchSection — no such symbol/);
});

test("a # continuation cites a symbol in the file of the citation before it, and is a miss before any file", async (t) => {
  const dir = await rootWith(t, {
    "a.ts": "export function alpha() {}\nexport const beta = 1;\n",
    "b.ts": "export function gamma() {}\n",
    "doc.md": "Too soon (`#alpha`).\nIn a (`a.ts#alpha`, `#beta`); in b (`b.ts:1`, `#gamma`, `#beta`).\n",
  });
  const { code, out } = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(code, 1);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /doc\.md:1: #alpha — continuation cites no file$/);
  assert.match(lines[1], /doc\.md:2: b\.ts#beta — no such symbol$/);
});

test("a symbol citation into a file that does not exist is a miss", async (t) => {
  const doc = await docWith(t, "The mode lives in `src/nowhere.ts#loadMode`.\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 1);
  assert.match(out, /doc\.md:1: src\/nowhere\.ts#loadMode — no such file/);
});

test("a symbol citation wrapped across a line break is joined and reported where it starts", async (t) => {
  const doc = await docWith(t, "Line one.\nThe pipeline refuses (`src/engines/spawn.ts\n#noSuchSymbol`) outright.\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 1);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /doc\.md:2: src\/engines\/spawn\.ts#noSuchSymbol — no such symbol$/);
});

test("a brace-expansion path with a symbol is a miss: a symbol belongs to one file", async (t) => {
  const doc = await docWith(t, "The adapters (`src/engines/{codex,grok}.ts#truncate`) declare it.\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 1);
  assert.match(out, /doc\.md:1: src\/engines\/\{codex,grok\}\.ts#truncate — brace expansion cannot be checked; cite one file/);
});

test("only the listed declaration forms name a symbol: not export default, var, function*, declare, abstract class, or a second declarator", async (t) => {
  const dir = await rootWith(t, {
    "excluded.ts": [
      "export default function fallback() {}",
      "var legacy = 1;",
      "function* generate() {}",
      "declare const ambient: number;",
      "abstract class Shape {}",
      "const first = 1, second = 2;",
      "",
    ].join("\n"),
    "doc.md": "Cited (`excluded.ts#fallback`, `#legacy`, `#generate`, `#ambient`, `#Shape`, `#first`, `#second`).\n",
  });
  const { code, out } = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(code, 1);
  assert.deepEqual(out.trim().split("\n").map((line) => line.replace(/^.*doc\.md:1: /, "")), [
    "excluded.ts#fallback — no such symbol",
    "excluded.ts#legacy — no such symbol",
    "excluded.ts#generate — no such symbol",
    "excluded.ts#ambient — no such symbol",
    "excluded.ts#Shape — no such symbol",
    "excluded.ts#second — no such symbol",
  ]);
});

test("a declaration inside a block comment names no symbol, and a declaration after the comment still does", async (t) => {
  const dir = await rootWith(t, {
    "commented.ts": "/*\nfunction removed() {}\nexport const gone = 1;\n*/\nexport function kept() {}\n",
    "doc.md": "Removed (`commented.ts#removed`, `#gone`) and kept (`commented.ts#kept`).\n",
  });
  const { code, out } = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(code, 1);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /doc\.md:1: commented\.ts#removed — no such symbol$/);
  assert.match(lines[1], /doc\.md:1: commented\.ts#gone — no such symbol$/);
});

test("an // @anchor inside a block comment does not count", async (t) => {
  const dir = await rootWith(t, {
    "anchored.ts": "/*\n  // @anchor buried\n*/\n// @anchor kept\n",
    "doc.md": "Buried (`anchored.ts#buried`) and kept (`anchored.ts#kept`).\n",
  });
  const { code, out } = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(code, 1);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /doc\.md:1: anchored\.ts#buried — no such symbol$/);
});

test("a declaration inside a template literal that spans lines names no symbol, and one after the literal still does", async (t) => {
  const dir = await rootWith(t, {
    "templated.ts": [
      "export const page = `",
      "function removed() {}",
      "// @anchor quoted",
      "`;",
      "export function after() {}",
      "",
    ].join("\n"),
    "doc.md": "Inside (`templated.ts#removed`, `#quoted`); around (`templated.ts#page`, `#after`).\n",
  });
  const { code, out } = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(code, 1);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /doc\.md:1: templated\.ts#removed — no such symbol$/);
  assert.match(lines[1], /doc\.md:1: templated\.ts#quoted — no such symbol$/);
});

test("a comment marker or backtick inside a string, a line comment or a regular expression opens nothing, and a division is no regular expression", async (t) => {
  const dir = await rootWith(t, {
    "markers.ts": [
      "const glob = \"src/*.ts\";",
      "export function afterString() {}",
      "const tick = '`';",
      "export function afterQuotedTick() {}",
      "// a ` in a line comment",
      "export function afterLineComment() {}",
      "const fence = /^(```|~~~)/;",
      "export function afterRegex() {}",
      "const ratio = total / count; // a ` after a division",
      "export function afterDivision() {}",
      "",
    ].join("\n"),
    "doc.md": "After each (`markers.ts#afterString`, `#afterQuotedTick`, `#afterLineComment`, `#afterRegex`, `#afterDivision`).\n",
  });
  const { code, out, err } = await run(["--root", dir, path.join(dir, "doc.md")]);
  assert.equal(code, 0, out);
  assert.match(err, /5 citations in 1 file \(0 by line, 5 by symbol\); 0 misses/);
});

test("a fenced code block is not scanned, so an example citation is not a miss", async (t) => {
  const doc = await docWith(t, "Example:\n\n```\nsee `src/nowhere.ts:99999`\n```\n\nback to prose.\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 0, out);
});

test("a brace-expansion path is a miss: a line belongs to one file", async (t) => {
  const doc = await docWith(t, "The adapters (`src/engines/{codex,grok}.ts:12`) declare it.\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 1);
  assert.match(out, /doc\.md:1: src\/engines\/\{codex,grok\}\.ts:12 — brace expansion cannot be checked; cite one file/);
});

test("a brace-expansion path with no line numbers is not a citation at all", async (t) => {
  const doc = await docWith(t, "The adapters (`src/engines/{codex,grok}.ts`) declare it.\n");
  const { code, out, err } = await run([doc]);
  assert.equal(code, 0, out);
  assert.match(err, /0 citations/);
});

test("a citation wrapped across a line break is joined and reported where it starts", async (t) => {
  const doc = await docWith(t, "Line one.\nThe pipeline refuses (`src/engines/spawn.ts\n:99999`) outright.\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 1);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /doc\.md:2: src\/engines\/spawn\.ts:99999 — file has \d+ lines/);
});

test("a wrapped citation that is in range passes, and counts once", async (t) => {
  const doc = await docWith(t, "The loader (`src/config.ts:\n1`) reads it.\n");
  const { code, out, err } = await run([doc]);
  assert.equal(code, 0, out);
  assert.match(err, /1 citations/);
});

test("an empty file has no lines, so even :1 into it is a miss", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "citations-root-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "empty.ts"), "", "utf8");
  const doc = path.join(dir, "doc.md");
  await writeFile(doc, "It is here (`empty.ts:1`).\n", "utf8");
  const { code, out } = await run(["--root", dir, doc]);
  assert.equal(code, 1);
  assert.match(out, /doc\.md:1: empty\.ts:1 — file has 0 lines/);
});

test("a file whose last line has no terminator still has that line", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "citations-root-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "two.ts"), "one\ntwo", "utf8");
  const doc = path.join(dir, "doc.md");
  await writeFile(doc, "Here (`two.ts:2`) and past it (`two.ts:3`).\n", "utf8");
  const { code, out } = await run(["--root", dir, doc]);
  assert.equal(code, 1);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /doc\.md:1: two\.ts:3 — file has 2 lines/);
});
