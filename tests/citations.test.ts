import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

test("every citation in docs/design.md and docs/probes.md names a line its file has", async () => {
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
  assert.match(err, /3 citations in 1 file; 0 misses/);
});

test("a fenced code block is not scanned, so an example citation is not a miss", async (t) => {
  const doc = await docWith(t, "Example:\n\n```\nsee `src/nowhere.ts:99999`\n```\n\nback to prose.\n");
  const { code, out } = await run([doc]);
  assert.equal(code, 0, out);
});
