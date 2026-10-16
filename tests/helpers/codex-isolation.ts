import { realpathSync } from "node:fs";
import path from "node:path";
import codex from "../../src/engines/codex.ts";
import type { SpawnRequest } from "../../src/engines/types.ts";

// The reader and the judges `tests/engines/codex.test.ts#codexPluginIsolationReal` applies to
// a Codex thread's rollout, held to their rules by `#codexPluginProofShape` with synthetic
// rollouts. A judge answers pass, fail (a product defect: a leak, a plugin tool, something
// the child should have kept and lost) or unresolved (the evidence does not decide), and an
// unknown shape is never a pass.

export type Outcome = "pass" | "fail" | "unresolved";

/** One parsed rollout line, by its 1-based line number. */
export interface Entry { line: number; type: string; payload: Record<string, any> }
export interface Rollout { entries: Entry[]; unreadable: number[] }

export function parseRollout(text: string): Rollout {
  const entries: Entry[] = [];
  const unreadable: number[] = [];
  text.split("\n").forEach((raw, index) => {
    if (raw.trim() === "") return;
    try {
      const value = JSON.parse(raw);
      if (value === null || typeof value !== "object" || typeof value.type !== "string") throw new Error("not an entry");
      entries.push({ line: index + 1, type: value.type, payload: value.payload !== null && typeof value.payload === "object" ? value.payload : {} });
    } catch {
      unreadable.push(index + 1);
    }
  });
  return { entries, unreadable };
}

/** A turn's lines: from its `task_started` to the line before the next one, or to the end. */
export interface Segment { start: number; end: number }

export function segmentsOf(rollout: Rollout): Segment[] {
  const starts = rollout.entries.filter((entry) => entry.type === "event_msg" && entry.payload.type === "task_started").map((entry) => entry.line);
  const last = rollout.entries.at(-1)?.line ?? 0;
  return starts.map((start, k) => ({ start, end: k + 1 < starts.length ? starts[k + 1] - 1 : last }));
}

const within = (line: number, segment: Segment) => line >= segment.start && line <= segment.end;
const inSegment = (rollout: Rollout, segment: Segment) => rollout.entries.filter((entry) => within(entry.line, segment));

/**
 * A canonical carrier: the session's `base_instructions`, one content item of a
 * `response_item` message of any role, or one `function_call_output` or
 * `custom_tool_call_output`. These are what the turns' context is made of.
 */
export interface Carrier {
  line: number;
  kind: "base_instructions" | "message" | "output";
  role: string | null;
  type: string | null;
  callId: string | null;
  text: string;
}

/** An output as text: a string as it is, the text of each part of a list, anything else as JSON. */
export function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((part) => (typeof part?.text === "string" ? part.text : JSON.stringify(part))).join("");
  return JSON.stringify(output ?? null);
}

/** Every canonical carrier from line 1 through `through`: a turn's effective context when `through` is its end. */
export function carriersOf(rollout: Rollout, through = Number.POSITIVE_INFINITY): Carrier[] {
  const carriers: Carrier[] = [];
  for (const { line, type, payload } of rollout.entries) {
    if (line > through) break;
    if (type === "session_meta") {
      const base = payload.base_instructions;
      const text = typeof base === "string" ? base : typeof base?.text === "string" ? base.text : null;
      if (text !== null) carriers.push({ line, kind: "base_instructions", role: null, type: null, callId: null, text });
    } else if (type === "response_item" && payload.type === "message") {
      const role = typeof payload.role === "string" ? payload.role : null;
      const content = typeof payload.content === "string" ? [{ type: "input_text", text: payload.content }] : Array.isArray(payload.content) ? payload.content : [];
      for (const item of content) {
        carriers.push({ line, kind: "message", role, type: typeof item?.type === "string" ? item.type : null, callId: null,
          text: typeof item?.text === "string" ? item.text : JSON.stringify(item) });
      }
    } else if (type === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
      carriers.push({ line, kind: "output", role: null, type: payload.type, callId: typeof payload.call_id === "string" ? payload.call_id : null, text: outputText(payload.output) });
    }
  }
  return carriers;
}

/** Where a thread ran: the Codex home its plugins live under, the user's home, and the project directories. */
export interface Locations { codexHome: string; home: string; projectDirs: readonly string[] }
export type Origin = "plugin" | "system" | "user" | "project" | "other" | "unresolved";
export interface CatalogueEntry { line: number; name: string; locator: string; file: string | null; origin: Origin }
export interface SkillsBlock { line: number; roots: Record<string, string>; entries: CatalogueEntry[] }

function realOrSelf(file: string): string {
  try { return realpathSync(file); } catch { return file; }
}

function under(file: string, directory: string): boolean {
  const parent = directory.replace(/\/+$/, "");
  return file === parent || file.startsWith(`${parent}/`);
}

/** `<CODEX_HOME>/plugins` as written and as its realpath. */
export function pluginDirs(where: Locations): string[] {
  const directory = path.join(where.codexHome, "plugins");
  return [...new Set([directory, realOrSelf(directory)])];
}

/** A skill file's origin, by where the file is: never by the name it is listed under. */
export function originOf(file: string, where: Locations): Origin {
  const real = realOrSelf(file);
  if (pluginDirs(where).some((directory) => under(file, directory) || under(real, directory))) return "plugin";
  if (under(file, path.join(where.codexHome, "skills", ".system"))) return "system";
  if (under(file, path.join(where.home, ".agents", "skills"))) return "user";
  if (where.projectDirs.some((directory) => under(file, path.join(directory, ".agents", "skills")))) return "project";
  return "other";
}

/** A locator's file: `rN/<rel>` through its own block's roots, or an absolute path; null when it names no file. */
function resolveLocator(locator: string, roots: Record<string, string>): string | null {
  const aliased = /^(r\d+)\/(.+)$/.exec(locator);
  let file: string;
  if (aliased !== null) {
    if (!Object.hasOwn(roots, aliased[1])) return null;
    file = `${roots[aliased[1]].replace(/\/+$/, "")}/${aliased[2]}`;
  } else if (locator.startsWith("/")) {
    file = locator;
  } else {
    return null;
  }
  if (!file.startsWith("/") || file.endsWith("/")) return null;
  if (file.split("/").slice(1).some((part) => part === "" || part === "." || part === "..")) return null;
  return file;
}

const rootLine = /^\s*- `(r\d+)` = `([^`]+)`\s*$/;

/**
 * The skills blocks among the carriers: developer items holding `<skills_instructions>`. Each
 * block's roots are its own `` - `rN` = `<path>` `` lines, and each `(file: …)` locator in it
 * resolves through those roots alone, since the aliases differ from one block to the next.
 */
export function skillsBlocks(carriers: readonly Carrier[], where: Locations): SkillsBlock[] {
  return carriers.filter((carrier) => carrier.kind === "message" && carrier.role === "developer" && carrier.text.includes("<skills_instructions>"))
    .map((carrier) => {
      const lines = carrier.text.split("\n");
      const roots: Record<string, string> = {};
      for (const line of lines) {
        const match = rootLine.exec(line);
        if (match !== null) roots[match[1]] = match[2];
      }
      const entries: CatalogueEntry[] = [];
      for (const line of lines) {
        for (const match of line.matchAll(/\(file: ([^)]*)\)/g)) {
          const file = resolveLocator(match[1], roots);
          entries.push({ line: carrier.line, name: /^\s*- (.+?): /.exec(line)?.[1]?.trim() ?? "", locator: match[1], file,
            origin: file === null ? "unresolved" : originOf(file, where) });
        }
      }
      return { line: carrier.line, roots, entries };
    });
}

/** A command a thread's calls ran or would have run, by the rollout line of its call. */
export interface Command { line: number; command: string }

/** What `tools/e2e-verify.mjs --read-rollout` prints for one thread, as far as the leak scan reads it. */
export interface CallReading {
  calls: Array<{ kind: string; line: number; commands?: string[]; arguments?: unknown }>;
}

/** The commands `readThread`'s reading shows: each exec cell's, and each function call's arguments. */
export function commandsOf(reading: CallReading): Command[] {
  return reading.calls.flatMap((call) => {
    if (call.kind === "exec") return (call.commands ?? []).map((command) => ({ line: call.line, command }));
    if (call.kind === "function_call") return [{ line: call.line, command: JSON.stringify(call.arguments ?? null) }];
    return [];
  });
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every plugin-origin item: a skill entry whose file is a plugin's, an absolute path under
 * `<CODEX_HOME>/plugins/` in a carrier, and a command touching one.
 */
export function leakItems(carriers: readonly Carrier[], blocks: readonly SkillsBlock[], commands: readonly Command[], where: Locations): string[] {
  const paths = pluginDirs(where).map((directory) => new RegExp(`${escaped(directory.replace(/\/+$/, ""))}(?:/|(?![\\w.@-]))`));
  const touches = (text: string) => paths.some((pattern) => pattern.test(text));
  const items: string[] = [];
  for (const block of blocks) {
    for (const entry of block.entries) if (entry.origin === "plugin") items.push(`line ${entry.line}: plugin-origin skill ${JSON.stringify(entry.name)} (${entry.file})`);
  }
  for (const carrier of carriers) {
    if (touches(carrier.text)) items.push(`line ${carrier.line}: a path under ${where.codexHome}/plugins in a ${carrier.kind}${carrier.role ? ` (${carrier.role})` : ""}`);
  }
  for (const command of commands) {
    if (touches(command.command)) items.push(`line ${command.line}: a command on a path under ${where.codexHome}/plugins: ${command.command.slice(0, 200)}`);
  }
  return items;
}

// The cells a native turn's brief prescribes, and the names its top-level calls use.
// Cell A prints one compact entry per tool, `[name, skill, plugin, annotated, snippet]`,
// inside the 0.163.0 `exec` output budget of 10,000 tokens, which the full descriptions
// overran: the snippet, at most 200 characters, only for an unannotated tool whose
// description mentions a skill or a plugin, as evidence of what it says.
export const cellA = 'text(JSON.stringify({ count: ALL_TOOLS.length, tools: ALL_TOOLS.map((tool) => { const d = String(tool.description); '
  + "const at = d.search(/skill|plugin/i); const annotated = /part of plugin/i.test(tool.description); return [tool.name, "
  + '/skill/i.test(tool.name + " " + tool.description), /plugin/i.test(tool.description), annotated, annotated || at < 0 ? null : '
  + "d.slice(Math.max(0, at - 80), at + 120)]; }) }));";
export const cellB = "const r = await tools.mcp__cross_agent__list_roles({});\ntext(JSON.stringify(r));";
// First in the brief, and saying that a refusal is the result: attempt 2's R2 made no call to
// any of the three names when Cell D followed the cells and asked for their results.
export const cellD = "First, before any exec cell, make three direct top-level tool calls — function calls in your response, the way you call "
  + "exec, never code inside exec — each exactly once with arguments `{}`, in this order: `crossagentabsent.list`, `skills.list`, "
  + "`skills.read`. These names may not appear among your tools; call them by these exact names anyway. A refusal or an error is "
  + "the expected result and is what this probe records, so do not skip a call because a tool seems unavailable. This turn is "
  + "incomplete until all three calls have been made.";
export const absentControl = "crossagentabsent.list";
export const coverageTargets = ["skills.list", "skills.read"] as const;
/** The engine-added interfaces rule E looks for, matched without regard to case. */
export const engineInterfaces = ["skills.list", "skills.read", "executor package", "cloud package", "custom resource"] as const;

/** A native turn's brief: Cell D first where the turn runs it, then Cell A and Cell B, then the reply. */
export function briefFor(marker: string, cells: { B: boolean; D: boolean }): string {
  const fenced = (script: string) => `\`\`\`js\n${script}\n\`\`\``;
  return [
    ...(cells.D ? [cellD] : []),
    `This turn is a probe. Run these exactly, then reply with exactly ${marker}.`,
    "Each cell below is one call to your code-mode exec tool whose whole script is the cell's text, copied character for "
      + "character: nothing added, removed or changed, one call per cell, in the order given, never retried. Read no file "
      + "and run no other command.",
    `Cell A:\n${fenced(cellA)}`,
    ...(cells.B ? [`Cell B:\n${fenced(cellB)}`] : []),
    `Then reply with exactly ${marker}.`,
  ].join("\n\n");
}

function normalized(script: string): string {
  return script.endsWith("\n") ? script.slice(0, -1) : script;
}

/** A top-level function call's name as the target compares to it: `name`, or `namespace.name`. */
function callNames(payload: Record<string, any>): string[] {
  const name = typeof payload.name === "string" ? payload.name : "";
  return typeof payload.namespace === "string" && payload.namespace !== "" ? [name, `${payload.namespace}.${name}`] : [name];
}

/** The outputs the exact Cells A, B and D were answered with, through `through`: rule E leaves them to their own gates. */
export function exactOutputIds(rollout: Rollout, through: number): Set<string> {
  const ids = new Set<string>();
  const cells = [cellA, cellB].map(normalized);
  const named = [absentControl, ...coverageTargets];
  for (const { line, type, payload } of rollout.entries) {
    if (line > through || type !== "response_item" || typeof payload.call_id !== "string") continue;
    if (payload.type === "custom_tool_call" && payload.name === "exec" && typeof payload.input === "string" && cells.includes(normalized(payload.input))) ids.add(payload.call_id);
    if (payload.type === "function_call" && callNames(payload).some((name) => named.includes(name))) ids.add(payload.call_id);
  }
  return ids;
}

/**
 * Rule E: every scanned carrier naming an engine-added interface, and every catalogue entry
 * whose locator resolves to no file. Left out, item by item: the paired outputs of the exact
 * cells, a user `input_text` byte-equal to its own turn's brief, and `base_instructions`
 * byte-equal to the role file. `event_msg` and `turn_context` are not carriers.
 */
export function ruleE(input: {
  carriers: readonly Carrier[]; segments: readonly Segment[]; briefs: readonly string[]; roleFile: string;
  excluded: ReadonlySet<string>; blocks: readonly SkillsBlock[];
}): string[] {
  const flagged: string[] = [];
  for (const carrier of input.carriers) {
    if (carrier.kind === "output" && carrier.callId !== null && input.excluded.has(carrier.callId)) continue;
    if (carrier.kind === "message" && carrier.role === "user" && carrier.type === "input_text") {
      const turn = input.segments.findIndex((segment) => within(carrier.line, segment));
      if (turn >= 0 && input.briefs[turn] === carrier.text) continue;
    }
    if (carrier.kind === "base_instructions" && carrier.text === input.roleFile) continue;
    const text = carrier.text.toLowerCase();
    const named = engineInterfaces.filter((name) => text.includes(name));
    if (named.length > 0) flagged.push(`line ${carrier.line}: a ${carrier.kind}${carrier.role ? ` (${carrier.role})` : ""} names ${named.join(", ")}`);
  }
  for (const block of input.blocks) {
    for (const entry of block.entries) {
      if (entry.file === null) flagged.push(`line ${entry.line}: catalogue entry ${JSON.stringify(entry.name)}'s locator ${JSON.stringify(entry.locator)} resolves to no file`);
    }
  }
  return flagged;
}

/**
 * Each `UserMessage` mirror in the turn byte-equals, in order, one canonical user message's
 * `input_text` texts, with every `text_elements` empty; what does not is unresolved.
 */
export function mirrorFailures(rollout: Rollout, segment: Segment): string[] {
  const own = inSegment(rollout, segment);
  const canonical = own.filter((entry) => entry.type === "response_item" && entry.payload.type === "message" && entry.payload.role === "user")
    .map((entry) => (Array.isArray(entry.payload.content) ? entry.payload.content : [])
      .filter((item: any) => item?.type === "input_text" && typeof item.text === "string").map((item: any) => item.text as string));
  const mirrors = own.filter((entry) => entry.type === "event_msg" && entry.payload.type === "item_completed" && entry.payload.item?.type === "UserMessage");
  const failures: string[] = [];
  let from = 0;
  for (const mirror of mirrors) {
    const content = mirror.payload.item.content;
    const shaped = Array.isArray(content) && content.length > 0 && content.every((part: any) =>
      part?.type === "text" && typeof part.text === "string" && Array.isArray(part.text_elements) && part.text_elements.length === 0);
    if (!shaped) { failures.push(`line ${mirror.line}: a UserMessage mirror of another shape`); continue; }
    const texts = content.map((part: any) => part.text as string);
    const at = canonical.findIndex((candidate, k) => k >= from && candidate.length === texts.length && candidate.every((text, n) => text === texts[n]));
    if (at < 0) failures.push(`line ${mirror.line}: a UserMessage mirror that no canonical user message of its turn matches`);
    else from = at + 1;
  }
  return failures;
}

/** One exact cell's run: its call, its one paired output, and what its script printed. */
export interface CellRun { line: number; callId: string; outputLine: number; printed: unknown }

/**
 * What a cell printed, read only in the frame 0.163.0 recorded (attempt 1's R1): exactly two
 * `input_text` parts, the first `Script completed\nWall time <s> seconds\nOutput:\n` and the
 * second the printed text. A truncation warning, any other frame, or text that is not JSON is
 * a problem, never a reading.
 */
export function cellPrinted(output: unknown): { printed: unknown } | { problem: string } {
  const parts = Array.isArray(output) && output.length === 2
    && output.every((part) => part !== null && typeof part === "object" && part.type === "input_text" && typeof part.text === "string")
    ? output.map((part) => part.text as string) : null;
  if (parts === null) return { problem: "unfamiliar output shape" };
  const [header, body] = parts;
  if (!/^Script completed\nWall time \d+(\.\d+)? seconds\nOutput:\n$/.test(header)) return { problem: "unfamiliar output header" };
  if (body.startsWith("Warning: truncated output")) return { problem: `Codex truncated the output (${body.split("\n")[0]})` };
  try {
    return { printed: JSON.parse(body.endsWith("\n") ? body.slice(0, -1) : body) };
  } catch {
    return { problem: "prints no JSON" };
  }
}

/**
 * The turn's code-mode `exec` calls against the prescribed scripts, in order, one trailing
 * newline aside: each prescribed cell's run, null where none ran exactly, its output is not one
 * paired output, or `cellPrinted` cannot read it; every other call a recorded deviation.
 * `unread` holds the cells whose exact call ran and whose output the reader rejected.
 */
export function execCells(rollout: Rollout, segment: Segment, expected: readonly string[]): { runs: Array<CellRun | null>; failures: string[]; deviations: string[]; unread: number[] } {
  const own = inSegment(rollout, segment);
  const calls = own.filter((entry) => entry.type === "response_item" && entry.payload.type === "custom_tool_call" && entry.payload.name === "exec");
  const runs: Array<CellRun | null> = expected.map(() => null);
  const failures: string[] = [];
  const deviations: string[] = [];
  const unread: number[] = [];
  let next = 0;
  for (const call of calls) {
    const input = typeof call.payload.input === "string" ? call.payload.input : null;
    if (next >= expected.length || input === null || normalized(input) !== normalized(expected[next])) {
      deviations.push(`line ${call.line}: an exec call that is no prescribed cell: ${JSON.stringify((input ?? "").slice(0, 200))}`);
      continue;
    }
    const k = next++;
    const callId = call.payload.call_id;
    const outputs = typeof callId === "string"
      ? own.filter((entry) => entry.type === "response_item" && entry.payload.type === "custom_tool_call_output" && entry.payload.call_id === callId) : [];
    if (outputs.length !== 1) { failures.push(`cell ${k + 1} (line ${call.line}): ${outputs.length} paired outputs`); continue; }
    const read = cellPrinted(outputs[0].payload.output);
    if ("problem" in read) {
      failures.push(`cell ${k + 1} (line ${call.line}): ${read.problem}`);
      unread.push(k);
      continue;
    }
    runs[k] = { line: call.line, callId, outputLine: outputs[0].line, printed: read.printed };
  }
  for (let k = next; k < expected.length; k++) failures.push(`cell ${k + 1} was not run exactly`);
  return { runs, failures, deviations, unread };
}

/**
 * What Cell A printed: the tool count, and each tool's name with whether its name or
 * description says skill, its description says plugin, and its description carries Codex's
 * "part of plugin" annotation, with the words around a mention in an unannotated one.
 */
export interface Inventory {
  count: number;
  names: string[];
  tools: Array<{ name: string; skill: boolean; plugin: boolean; annotated: boolean; snippet: string | null }>;
}

/**
 * The compact form and nothing else: `{count, tools}`, `count` the number of entries, each
 * `[string, boolean, boolean, boolean, string | null]`, no name twice.
 */
export function inventoryOf(printed: unknown): Inventory | null {
  const value = printed as { count?: unknown; tools?: unknown } | null;
  if (value === null || typeof value !== "object" || Object.keys(value).sort().join(",") !== "count,tools") return null;
  if (!Number.isInteger(value.count) || !Array.isArray(value.tools) || value.count !== value.tools.length) return null;
  const tools: Inventory["tools"] = [];
  for (const entry of value.tools) {
    if (!Array.isArray(entry) || entry.length !== 5 || typeof entry[0] !== "string") return null;
    if (entry.slice(1, 4).some((flag) => typeof flag !== "boolean") || !(typeof entry[4] === "string" || entry[4] === null)) return null;
    tools.push({ name: entry[0], skill: entry[1], plugin: entry[2], annotated: entry[3], snippet: entry[4] });
  }
  const names = tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) return null;
  return { count: value.count, names, tools };
}

/** The tool Cell A must list for the inventory to be the turn's own: the mount's when a lead is set, the shell's otherwise. */
export function expectedInventoryControl(request: Pick<SpawnRequest, "lead">): string {
  return request.lead !== undefined ? "mcp__cross_agent__list_roles" : "exec_command";
}

const ownMount = (tool: { name: string }, mounted: boolean) => mounted && tool.name.startsWith("mcp__cross_agent__");

/**
 * Tools whose description says they are part of a plugin, Codex's own annotation, which the
 * approved gate fails a treatment on; a mounted turn's own server's are its mount.
 */
export function pluginTools(inventory: Inventory, mounted: boolean): string[] {
  return inventory.tools.filter((tool) => tool.annotated && !ownMount(tool, mounted)).map((tool) => `${tool.name} (part of a plugin)`);
}

/**
 * Tools whose description mentions plugins without the annotation, recorded with their
 * snippet and never gated: attempt 2's were Codex's own `codex_apps` connector tools, listed by
 * the same names under both arms and carrying the annotation flag under the control alone.
 */
export function pluginMentions(inventory: Inventory, mounted: boolean): Array<{ name: string; snippet: string | null }> {
  return inventory.tools.filter((tool) => tool.plugin && !tool.annotated && !ownMount(tool, mounted)).map(({ name, snippet }) => ({ name, snippet }));
}

export type Tri = "ABSENT" | "PRESENT" | "UNRESOLVED";

/**
 * The nested surface, for the two identified interfaces: present when a tool's name says
 * skill, which `skills.list` and `skills.read` would, however they were normalized.
 */
export function nestedCoverage(inventory: Inventory | null): Tri {
  if (inventory === null) return "UNRESOLVED";
  return inventory.tools.some((tool) => /skill/i.test(tool.name)) ? "PRESENT" : "ABSENT";
}

/** Tools whose description, not name, mentions skills: recorded with their snippet, outside the two-interface claim. */
export function skillMentions(inventory: Inventory): Array<{ name: string; snippet: string | null }> {
  return inventory.tools.filter((tool) => tool.skill && !/skill/i.test(tool.name)).map(({ name, snippet }) => ({ name, snippet }));
}

/** Facts from outside the turn the top-level control rests on. */
export interface ControlFacts { literalAbsent: boolean; fixtureClean: boolean }

export interface TopLevel {
  state: Tri;
  reason: string;
  preconditions: { literalAbsent: boolean; notListed: boolean; fixtureClean: boolean; controlCalled: boolean };
  /** True only where the turn made no top-level call to the target, and called it nowhere else: the accepted limitation. */
  notCalled: boolean;
}

function swapped(value: unknown, a: string, b: string): unknown {
  if (typeof value === "string") return value.split(a).map((part) => part.split(b).join(a)).join(b);
  if (Array.isArray(value)) return value.map((item) => swapped(item, a, b));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swapped(item, a, b)]));
  return value;
}

/** Recursively key-sorted, so two values compare equal whatever order their keys were written in. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function topCalls(rollout: Rollout, segment: Segment, name: string): Array<{ line: number; outputs: unknown[] }> {
  const own = inSegment(rollout, segment);
  return own.filter((entry) => entry.type === "response_item" && entry.payload.type === "function_call" && callNames(entry.payload).includes(name))
    .map((entry) => ({
      line: entry.line,
      outputs: typeof entry.payload.call_id === "string"
        ? own.filter((other) => other.type === "response_item" && other.payload.type === "function_call_output" && other.payload.call_id === entry.payload.call_id).map((other) => other.payload.output)
        : [],
    }));
}

/**
 * The top-level surface for one target: ABSENT only when the four control preconditions hold
 * and the target's one paired output equals the same-turn control's once the two names are
 * swapped; PRESENT when the outputs differ; UNRESOLVED for anything else.
 */
export function topLevelCoverage(rollout: Rollout, segment: Segment, target: string, inventory: Inventory | null, facts: ControlFacts): TopLevel {
  const own = inSegment(rollout, segment);
  const controls = topCalls(rollout, segment, absentControl);
  const preconditions = {
    literalAbsent: facts.literalAbsent,
    notListed: inventory !== null && !inventory.names.some((name) => name.includes("crossagentabsent")),
    fixtureClean: facts.fixtureClean,
    controlCalled: controls.length === 1 && controls[0].outputs.length === 1 && outputText(controls[0].outputs[0]).trim() !== "",
  };
  const unresolved = (reason: string, notCalled = false): TopLevel => ({ state: "UNRESOLVED", reason, preconditions, notCalled });
  const custom = own.filter((entry) => entry.type === "response_item" && entry.payload.type === "custom_tool_call");
  const inExec = custom.some((entry) => entry.payload.name === "exec" && JSON.stringify(entry.payload.input ?? "").includes(target));
  const otherShape = custom.some((entry) => entry.payload.name !== "exec" && JSON.stringify(entry.payload).includes(target))
    || own.some((entry) => entry.type === "response_item"
      && !["message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(entry.payload.type)
      && JSON.stringify(entry.payload).includes(target));
  const calls = topCalls(rollout, segment, target);
  if (inExec) return unresolved(`${target} was called inside exec`);
  if (otherShape) return unresolved(`${target} appears in an item of an unknown shape`);
  // Reached only once the target is called neither inside exec nor in an item of another shape.
  if (calls.length === 0) return unresolved(`no top-level call to ${target}`, true);
  if (calls.length !== 1 || calls[0].outputs.length !== 1) return unresolved(`unknown shape: ${calls.length} top-level calls to ${target}, ${calls[0].outputs.length} outputs to the first`);
  const unmet = Object.entries(preconditions).filter(([, held]) => !held).map(([name]) => name);
  if (unmet.length > 0) return unresolved(`the control's preconditions are unmet: ${unmet.join(", ")}`);
  return same(swapped(controls[0].outputs[0], absentControl, target), calls[0].outputs[0])
    ? { state: "ABSENT", reason: `${target}'s output is the control's, the names swapped`, preconditions, notCalled: false }
    : { state: "PRESENT", reason: `${target}'s output differs from the control's`, preconditions, notCalled: false };
}

export interface Coverage { nested: Tri; topLevel: Record<string, TopLevel> }

export function coverageOf(rollout: Rollout, segment: Segment, inventory: Inventory | null, facts: ControlFacts): Coverage {
  return {
    nested: nestedCoverage(inventory),
    topLevel: Object.fromEntries(coverageTargets.map((target) => [target, topLevelCoverage(rollout, segment, target, inventory, facts)])),
  };
}

/**
 * Why coverage does not pass: every state that is not ABSENT, on either surface, except a
 * top-level target the turn made no call to, which the user accepted as a limitation of the
 * proof (`docs/probes.md#codexPluginIsolation`, "Bounded acceptance").
 */
export function coverageGaps(coverage: Coverage): string[] {
  const gaps = coverage.nested === "ABSENT" ? [] : [`nested surface ${coverage.nested} for ${coverageTargets.join(" and ")}`];
  for (const [target, reading] of Object.entries(coverage.topLevel)) {
    if (reading.state !== "ABSENT" && !(reading.state === "UNRESOLVED" && reading.notCalled)) gaps.push(`top-level ${target} ${reading.state}: ${reading.reason}`);
  }
  return gaps;
}

/** The accepted limitation, per target: availability unknown where the turn made no top-level call. Never ABSENT. */
export function coverageLimitations(coverage: Coverage): string[] {
  return Object.entries(coverage.topLevel).filter(([, reading]) => reading.state === "UNRESOLVED" && reading.notCalled)
    .map(([target, reading]) => `top-level ${target} availability unknown (accepted limitation): ${reading.reason}`);
}

/**
 * Cell B's correlation with the mount: the exact cell, its paired output, and between the two,
 * in the same turn, a completed `McpToolCall` of `cross-agent`'s `list_roles` whose
 * `result.content` is the printed result's `content`.
 */
export function leadFailures(rollout: Rollout, segment: Segment, run: CellRun | null): string[] {
  if (run === null) return ["Cell B did not run exactly with one paired output: a printed list_roles result without the exact script proves no mount"];
  const records = inSegment(rollout, segment).filter((entry) => entry.line > run.line && entry.line < run.outputLine
    && entry.type === "event_msg" && entry.payload.type === "item_completed" && entry.payload.item?.type === "McpToolCall");
  const ours = records.filter((entry) => entry.payload.item.server === "cross-agent" && entry.payload.item.tool === "list_roles");
  if (ours.length === 0) return [`no McpToolCall of cross-agent list_roles between Cell B's call (line ${run.line}) and its output (line ${run.outputLine})`];
  const printed = (run.printed as { content?: unknown } | null)?.content;
  if (ours.some((entry) => entry.payload.item.status === "completed" && printed !== undefined && same(entry.payload.item.result?.content, printed))) return [];
  return [`Cell B's McpToolCall is not completed with the printed content: ${JSON.stringify(ours.map((entry) => ({ line: entry.line, status: entry.payload.item.status })))}`];
}

// The arms of one native turn, built from the adapter's own line.
export const isolationArgs = ["-c", "features.plugins=false", "-c", "features.remote_plugin=false"] as const;
export const forcedPlugins = [
  "-c", "plugins.frontend-design-premium@openai-curated-remote.enabled=true",
  "-c", "plugins.visualize@openai-bundled.enabled=true",
] as const;

export interface Arms { exact: string[]; treatment: string[]; control: string[] }

function runAt(list: readonly string[], run: readonly string[]): number {
  for (let at = 0; at + run.length <= list.length; at++) if (run.every((value, k) => list[at + k] === value)) return at;
  return -1;
}

function without(list: readonly string[], run: readonly string[]): string[] {
  const at = runAt(list, run);
  return at < 0 ? [...list] : [...list.slice(0, at), ...list.slice(at + run.length)];
}

/** Exact is the adapter's line; treatment adds the forced pair before `-`; control is treatment without the isolation. */
export function armsFrom(exact: readonly string[]): Arms {
  const treatment = exact.at(-1) === "-" ? [...exact.slice(0, -1), ...forcedPlugins, "-"] : [...exact, ...forcedPlugins];
  return { exact: [...exact], treatment, control: without(treatment, isolationArgs) };
}

export function armsFor(request: SpawnRequest): Arms {
  return armsFrom(codex.plan(request).argv);
}

/** Why the arms are not the protocol's: their relations, their prompt placeholder, and the mount each carries. */
export function armFailures(arms: Arms, mounted: boolean): string[] {
  const failures: string[] = [];
  for (const [name, argv] of Object.entries(arms)) {
    const mount = argv.filter((value, k) => argv[k - 1] === "-c" && value.startsWith("mcp_servers.cross-agent.")).length;
    if (mount !== (mounted ? 5 : 0)) failures.push(`${name}: ${mount} mcp_servers.cross-agent. settings where ${mounted ? 5 : 0} belong`);
    if (argv.at(-1) !== "-") failures.push(`${name}: - is not last`);
  }
  const at = runAt(arms.treatment, isolationArgs);
  if (at < 0) failures.push("treatment: the isolation elements are not there");
  else if (JSON.stringify([...arms.control.slice(0, at), ...isolationArgs, ...arms.control.slice(at)]) !== JSON.stringify(arms.treatment)) {
    failures.push("control and treatment differ by more than the isolation elements at their position");
  }
  if (arms.control.some((value) => value.startsWith("features.plugins=") || value.startsWith("features.remote_plugin="))) failures.push("control: a features setting remains");
  if (JSON.stringify(without(arms.treatment, forcedPlugins)) !== JSON.stringify(arms.exact)) failures.push("treatment without the forced pair is not exact");
  if (runAt(arms.treatment, forcedPlugins) < 0 || runAt(arms.control, forcedPlugins) < 0) failures.push("the forced pair is missing from an arm that needs it");
  return failures;
}

// The operator's configuration, read through Codex's own `config/read`.

/** The user layer's `plugins`, `marketplaces` and `features`, as canonical JSON: equal exactly when their values are. */
export function preferenceSubtrees(config: unknown): string {
  const layer = (config ?? {}) as Record<string, unknown>;
  return JSON.stringify(canonical({ plugins: layer.plugins ?? null, marketplaces: layer.marketplaces ?? null, features: layer.features ?? null }));
}

/** Project keys the run added that the fixture owns: absent before, and the fixture root or a path inside it. */
export function ownedProjectKeys(before: readonly string[], after: readonly string[], fixtureRoot: string): string[] {
  return after.filter((key) => !before.includes(key) && under(key, fixtureRoot));
}

/** One native turn as the protocol defines it. */
export interface TurnSpec { id: string; class: "control" | "treatment" | "legacy"; fresh: boolean; mounted: boolean; cellB: boolean; cellD: boolean }

export interface TurnEvidence {
  rollout: Rollout;
  /** The brief each turn of the thread was given, in order; this turn's last. */
  briefs: readonly string[];
  roleFile: string;
  agentsMarker: string;
  replyMarker: string;
  run: { exitCode: number | null; completed: boolean; finalMessage: string };
  expect: { model: string; cwd: string; sandbox: string; approval: string };
  where: Locations;
  commands: readonly Command[];
  /** The fixture skill's file, as each project directory would list it. */
  fixtureFiles: readonly string[];
  /** The same-cwd fresh control's non-plugin skill files, or null for that control itself. */
  controlFiles: readonly string[] | null;
  inventoryControl: string;
  facts: ControlFacts;
  /** For the legacy turn: whether the thread's lines before it are what they were. */
  prefixUnchanged?: boolean;
}

export interface TurnVerdict {
  outcome: Outcome;
  failed: string[];
  unresolved: string[];
  coverage: Coverage | null;
  recorded: Record<string, unknown>;
  /** The accepted limitation's readings in this turn, recorded and never a stop (`coverageLimitations`). */
  limitations: string[];
}

/** Every gate of the protocol for one turn: the first failure is a defect, anything undecided is unresolved. */
export function judgeTurn(spec: TurnSpec, evidence: TurnEvidence): TurnVerdict {
  const { rollout, where } = evidence;
  const failed: string[] = [];
  const unresolved: string[] = [];
  const limitations: string[] = [];
  const recorded: Record<string, unknown> = {};
  const segments = segmentsOf(rollout);
  const segment = segments.at(-1);
  const verdict = (coverage: Coverage | null): TurnVerdict => ({
    outcome: failed.length > 0 ? "fail" : unresolved.length > 0 ? "unresolved" : "pass", failed, unresolved, coverage, recorded, limitations,
  });
  if (rollout.unreadable.length > 0) unresolved.push(`unreadable rollout lines: ${rollout.unreadable.join(", ")}`);
  if (segments.length !== evidence.briefs.length) unresolved.push(`the thread holds ${segments.length} turns where ${evidence.briefs.length} ran`);
  if (segment === undefined) return verdict(null);

  const context = carriersOf(rollout, segment.end);
  const own = context.filter((carrier) => within(carrier.line, segment));
  const blocks = skillsBlocks(context, where);
  const ownBlocks = blocks.filter((block) => within(block.line, segment));
  const turnContexts = inSegment(rollout, segment).filter((entry) => entry.type === "turn_context");

  // Every turn: it completed, as the account it ran under; it ran where and as it was told.
  if (evidence.run.exitCode !== 0 || !evidence.run.completed) failed.push(`the turn did not complete: exit ${evidence.run.exitCode}, turn.completed ${evidence.run.completed}`);
  if (!evidence.run.finalMessage.includes(evidence.replyMarker)) unresolved.push("the reply does not carry the turn's marker");
  if (turnContexts.length === 0) unresolved.push("no turn_context in the turn");
  for (const { line, payload } of turnContexts) {
    const seen = { model: payload.model, cwd: payload.cwd, sandbox: payload.sandbox_policy?.type, approval: payload.approval_policy };
    for (const [key, value] of Object.entries(evidence.expect)) {
      if (seen[key as keyof typeof seen] !== value) failed.push(`line ${line}: turn_context ${key} ${JSON.stringify(seen[key as keyof typeof seen])}, not ${JSON.stringify(value)}`);
    }
  }
  if (!context.some((carrier) => carrier.text.includes(evidence.agentsMarker))) failed.push("AGENTS.md's marker is not in the turn's effective context");

  const cells = execCells(rollout, segment, spec.cellB ? [cellA, cellB] : [cellA]);
  unresolved.push(...cells.failures);
  const inventory = cells.runs[0] === null ? null : inventoryOf(cells.runs[0].printed);
  if (cells.runs[0] !== null && inventory === null) unresolved.push("Cell A printed something other than the complete inventory");
  if (inventory !== null && !inventory.names.includes(evidence.inventoryControl)) unresolved.push(`Cell A's names lack the inventory control ${evidence.inventoryControl}`);

  unresolved.push(...ruleE({ carriers: context, segments, briefs: evidence.briefs, roleFile: evidence.roleFile, excluded: exactOutputIds(rollout, segment.end), blocks }));
  unresolved.push(...mirrorFailures(rollout, segment));

  // What the child keeps: the fixture skill, established in the fresh controls, and the
  // same-cwd control's other non-plugin skill files.
  const files = new Set(blocks.flatMap((block) => block.entries.map((entry) => entry.file)).filter((file): file is string => file !== null));
  const establishing = spec.class === "control" && spec.fresh;
  if (!evidence.fixtureFiles.some((file) => files.has(file))) {
    (establishing ? unresolved : failed).push(`the fixture skill is not in the catalogue${establishing ? ": not established" : ""}`);
  }
  if (evidence.controlFiles !== null) {
    const lost = evidence.controlFiles.filter((file) => !files.has(file));
    if (lost.length > 0) failed.push(`non-plugin skill files the control listed are gone: ${lost.join(", ")}`);
  }

  const pluginSkills = (from: readonly SkillsBlock[]) => from.flatMap((block) => block.entries.filter((entry) => entry.origin === "plugin"));
  const commandsThrough = evidence.commands.filter((command) => command.line <= segment.end);
  if (spec.class === "control" && pluginSkills(ownBlocks).length === 0) unresolved.push("the control records no plugin-origin skill in its own turn");
  if (spec.class === "treatment") {
    failed.push(...leakItems(context, blocks, commandsThrough, where));
    if (inventory !== null) {
      const tools = pluginTools(inventory, spec.mounted);
      if (tools.length > 0) failed.push(`plugin tools offered: ${tools.join(", ")}`);
    }
  }
  if (spec.class === "legacy") {
    failed.push(...leakItems(own, ownBlocks, commandsThrough.filter((command) => within(command.line, segment)), where));
    if (evidence.prefixUnchanged !== true) unresolved.push("the resumed thread's earlier lines changed");
    recorded.newBlock = ownBlocks.length > 0;
    recorded.retainedPluginOrigin = pluginSkills(blocks.filter((block) => block.line < segment.start)).map((entry) => entry.file);
    recorded.backendReceipt = "unknown";
  }

  let coverage: Coverage | null = null;
  if (spec.cellD) {
    coverage = coverageOf(rollout, segment, inventory, evidence.facts);
    unresolved.push(...coverageGaps(coverage));
    limitations.push(...coverageLimitations(coverage));
  }
  // An exact Cell B whose output the reader could not read is a question for the harness,
  // already unresolved above; a missing, altered or uncorrelated one is a lost mount.
  if (spec.cellB && !cells.unread.includes(1)) failed.push(...leadFailures(rollout, segment, cells.runs[1] ?? null));

  if (inventory !== null) {
    recorded.pluginMentions = pluginMentions(inventory, spec.mounted);
    recorded.skillMentions = skillMentions(inventory);
  }
  recorded.recommendedPlugins = context.some((carrier) => carrier.text.includes("<recommended_plugins>"));
  recorded.disabledPluginIds = turnContexts.map((entry) => entry.payload.disabled_plugin_ids ?? null);
  recorded.effort = turnContexts.map((entry) => entry.payload.effort ?? null);
  recorded.calls = inSegment(rollout, segment).filter((entry) => entry.type === "response_item" && ["function_call", "custom_tool_call"].includes(entry.payload.type))
    .map((entry) => ({ line: entry.line, type: entry.payload.type, name: entry.payload.name ?? null, namespace: entry.payload.namespace ?? null }));
  recorded.deviations = cells.deviations;
  recorded.fixtureNames = blocks.flatMap((block) => block.entries.filter((entry) => entry.file !== null && evidence.fixtureFiles.includes(entry.file)).map((entry) => entry.name));
  recorded.pluginSkills = pluginSkills(ownBlocks).map((entry) => entry.file);
  recorded.nonPluginFiles = [...new Set(ownBlocks.flatMap((block) => block.entries.filter((entry) => entry.file !== null && entry.origin !== "plugin").map((entry) => entry.file as string)))];
  recorded.origins = Object.fromEntries(["plugin", "system", "user", "project", "other", "unresolved"].map((origin) =>
    [origin, blocks.flatMap((block) => block.entries).filter((entry) => entry.origin === origin).length]));
  return verdict(coverage);
}

/**
 * A native run's acceptance: none unless every listed turn has a verdict that passed, then
 * `bounded` where any turn recorded the accepted limitation and `full` where none did. The
 * limitations every recorded turn holds are listed whether or not the run completed.
 */
export function acceptanceOf(turns: Readonly<Record<string, TurnVerdict>>, ids: readonly string[]): {
  acceptance: "full" | "bounded" | null; limitations: Array<{ turn: string; reason: string }>;
} {
  const limitations = Object.entries(turns).flatMap(([turn, verdict]) => (verdict.limitations ?? []).map((reason) => ({ turn, reason })));
  const passed = ids.every((id) => Object.hasOwn(turns, id) && turns[id].outcome === "pass");
  return { acceptance: !passed ? null : limitations.length > 0 ? "bounded" : "full", limitations };
}
