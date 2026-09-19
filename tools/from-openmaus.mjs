#!/usr/bin/env node
// A one-off converter, beside `tools/probe.mjs` and not product code: it carries the
// dev-team text of an OpenMausBot package over to this runtime's mode directory. It ran
// once, against
// `~/Documents/agent-team-devpack/packages/dev-team/dev-team.openmaus.json` (format
// `openmaus.package` v1, release 0.1.x), to produce the drafts that became
// `modes/dev-team/roles/*.md`, `modes/dev-team-engine/roles/lead.md` and the first shape
// of `modes/dev-team/SKILL.md`. Nothing reads an `openmaus.package` at runtime, and
// nothing in `src/` imports this file.
//
//   node tools/from-openmaus.mjs --package <file> --out <dir> [--mode dev-team|dev-team-engine]
//
// It writes `<out>/roles/<key>.md` per role and `<out>/SKILL.md` from the
// `worktree-workflow` playbook, refuses to replace a file that is already there, and exits
// 0 when it wrote, 1 when it refused, 2 on a command line it could not read.
//
// **The transform, which is the whole of what the committed files owe this tool.**
//
// 1. *Roles by title.* A devpack agent becomes a role of this runtime when its `title` is
//    one of Planner, Plan Reviewer, Implementer, Code Reviewer or Team Lead; the lead is
//    written only for a mode that has a lead role. Any other title is reported and
//    skipped: this runtime has no analogue for it.
// 2. *The devpack's machinery is dropped.* A sentence naming `delegate_bot`, `ask_bot`,
//    `post_to_room`, `create_bot`, `list_bots`, a teammate, a room, a card or the wake
//    budget has nothing to map to — delegation here is one `delegate` call and one `wait`,
//    and the closing report is the task's own final message.
// 3. *Anything that mentions git is dropped* — any sentence naming git, a commit, a
//    rebase, a merge, a push or worktrees, which is broader than "the specialist runs
//    git" and deliberately so: in the devpack the implementer committed, rebased and
//    reported, while here a specialist writes no git metadata at all and the session that
//    delegated it commits through `git_mutate` and merges through `git_root` (design
//    section 4). The rule catches the sentences that had to be rewritten rather than
//    carried, and the ones it over-catches are cheaper to write back by hand than to
//    find. The coda below is what replaces them.
// 4. *One coda per role, this runtime's own text*, appended verbatim: what the role may
//    not do and what its final message is, because a specialist's final message is the
//    whole of what leaves its task.
//
// Every drop is reported on stderr, per file, so the draft is edited by someone who can
// see what was cut. **The committed files are these drafts edited**: tightened, reordered,
// and given the sentences this runtime needs that no devpack sentence could supply — the
// worktree and branch an implementer works on, the read-only sandbox a reviewer reads
// under, the verdict vocabulary the loop acts on. `tests/skills.test.ts` runs this
// converter against `tests/fixtures/openmaus-package.json` rather than against the devpack
// package, which lives outside this repository, and holds the committed files to the coda
// and to the two drop rules.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

function flag(name) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

function refuse(message, code = 1) {
  process.stderr.write(`from-openmaus: ${message}\n`);
  process.exit(code);
}

const packageFile = flag("package");
const out = flag("out");
const mode = flag("mode") ?? "dev-team";
if (packageFile === undefined || out === undefined) {
  refuse("usage: node tools/from-openmaus.mjs --package <file> --out <dir> [--mode <name>]", 2);
}

// The titles this runtime has a role for, and the key each becomes.
const keyByTitle = new Map([
  ["Planner", "planner"],
  ["Plan Reviewer", "plan-reviewer"],
  ["Implementer", "implementer"],
  ["Code Reviewer", "code-reviewer"],
  ["Team Lead", "lead"],
]);

// Rule 2: the devpack's own machinery.
const MACHINERY = /\b(delegate_bot|ask_bot|post_to_room|create_bot|list_bots|list_rooms|ListAgents|bots?|teammates?|rooms?|cards?|wake|woken|Project facts)\b/i;
// Rule 3: any sentence mentioning git, a commit, a rebase, a merge, a push or worktrees,
// which is broader than "the specialist runs git" on purpose; the header says why.
const GIT_WRITE = /\b(git|commits?|rebases?|pushe?s?|merges?|worktrees)\b/i;

// Rule 4: this runtime's own rule for each role, appended verbatim.
const coda = new Map([
  ["planner", "You write no files and you delegate nothing; your final message is the plan."],
  ["plan-reviewer", "You write no files and you delegate nothing; your final message is the review."],
  ["implementer", "You run no git command that writes: the session that delegated you commits what you leave. You delegate nothing; your final message is the report that commit is made from."],
  ["code-reviewer", "You write no files and you delegate nothing; your final message is the review, verdict first."],
  ["lead", "You run this mode's loop: every root git step through `git_root` and `run_command`, every worktree's git metadata through `git_mutate`, and never a specialist's work with your own hands. You delegate specialists and never another lead, you wait on and cancel only the tasks you delegated, and your final message is the closing report."],
]);

let document;
try {
  document = JSON.parse(readFileSync(packageFile, "utf8"));
} catch (error) {
  refuse(`cannot read ${packageFile}: ${error.message}`);
}
if (document.format !== "openmaus.package" || document.version !== 1) {
  refuse(`${packageFile} is ${JSON.stringify(document.format)} v${document.version}, not openmaus.package v1`);
}
const pack = document.package ?? {};

/** The sentences of `text`, kept in order; a sentence ends at a period before a space. */
function sentences(text) {
  return String(text).split(/(?<=\.)\s+/).map((one) => one.trim()).filter((one) => one.length > 0);
}

/** What survives both drop rules, and what each rule took. */
function carry(text) {
  const kept = [];
  const machinery = [];
  const git = [];
  for (const sentence of sentences(text)) {
    if (MACHINERY.test(sentence)) machinery.push(sentence);
    else if (GIT_WRITE.test(sentence)) git.push(sentence);
    else kept.push(sentence);
  }
  return { kept, machinery, git };
}

/** Prose at a width a prompt file is read at. */
function wrap(text, width = 84) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

function write(relative, body) {
  const file = path.join(out, relative);
  if (existsSync(file)) refuse(`${relative} is already there; this converter never replaces a draft`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${body.trimEnd()}\n`, "utf8");
}

function report(name, dropped) {
  const parts = [];
  if (dropped.machinery.length > 0) parts.push(`${dropped.machinery.length} naming the devpack's machinery`);
  if (dropped.git.length > 0) parts.push(`${dropped.git.length} running git`);
  process.stderr.write(`from-openmaus: ${name}: dropped ${parts.length === 0 ? "nothing" : parts.join(", ")}\n`);
  for (const sentence of [...dropped.machinery, ...dropped.git]) process.stderr.write(`    - ${sentence}\n`);
}

const wanted = new Set(mode === "dev-team-engine" ? keyByTitle.values() : [...keyByTitle.values()].filter((key) => key !== "lead"));
const skipped = [];
let written = 0;

for (const agent of pack.agents ?? []) {
  const key = keyByTitle.get(agent.title);
  if (key === undefined) { skipped.push(`${agent.title} (${agent.name})`); continue; }
  if (!wanted.has(key)) continue;
  const dropped = carry(agent.description ?? "");
  write(path.join("roles", `${key}.md`), `${wrap(dropped.kept.join(" "))}\n\n${wrap(coda.get(key))}`);
  report(key, dropped);
  written++;
}

// The loop draft: the playbook's numbered steps, each held to the same two rules. A step
// that survives is one this runtime still performs; the steps that go are where the
// remapping had to be written by hand, against design section 4's order.
const playbook = (pack.playbooks ?? []).find((one) => one.key === "worktree-workflow");
if (playbook !== undefined) {
  const lines = [];
  const dropped = { machinery: [], git: [] };
  for (const line of String(playbook.instructions).split("\n")) {
    const step = carry(line);
    dropped.machinery.push(...step.machinery);
    dropped.git.push(...step.git);
    if (step.kept.length > 0) lines.push(wrap(step.kept.join(" ")));
  }
  write("SKILL.md", `# The ${playbook.name} loop (draft)\n\n${lines.join("\n\n")}`);
  report("SKILL.md", dropped);
  written++;
}

for (const title of skipped) process.stderr.write(`from-openmaus: no role for ${title}; skipped\n`);
process.stderr.write(`from-openmaus: ${written} draft${written === 1 ? "" : "s"} in ${out}; edit them for this runtime before committing\n`);
