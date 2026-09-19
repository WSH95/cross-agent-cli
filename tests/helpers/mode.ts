import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { loadMode } from "../../src/modes.ts";
import type { Mode } from "../../src/modes.ts";

// Modes under test are written to disk, because that is the only way a mode reaches
// `loadMode`: it validates a directory, not an object, and a fixture built in memory
// would skip the realpath and existence rules that are half the contract.

export interface RoleSpec {
  key: string;
  /** `root` unless this role works in a worktree; the `worktree` shape is the mode's own. */
  workspace?: "root" | "worktree";
  sandboxDefault?: string;
  title?: string;
  /** The paragraph written to `roles/<key>.md`, which `describeMode` returns verbatim. */
  prompt?: string;
}

const worktreeWorkspace = { kind: "worktree", branchPattern: "task/*", dir: ".worktrees" };

/** A `mode.json` document carrying every field a valid mode has, patched by the caller. */
export function modeDocument(id: string, roles: RoleSpec[], patch: Record<string, unknown> = {}): Record<string, unknown> {
  const declared = roles.map((role) => ({
    key: role.key,
    title: role.title ?? role.key,
    promptFile: `roles/${role.key}.md`,
    workspace: role.workspace === "worktree" ? worktreeWorkspace : { kind: "root" },
    sandboxDefault: role.sandboxDefault ?? (role.workspace === "worktree" ? "workspace-write" : "read-only"),
  }));
  const document: Record<string, unknown> = {
    id,
    release: "0.1.0",
    name: id,
    summary: `The ${id} mode, written for a test.`,
    lead: { placement: "host" },
    roles: declared,
    requires: { engines: [] },
  };
  if (roles.some((role) => role.workspace === "worktree")) {
    document.git = { worktreeDir: ".worktrees", branchPattern: "task/*" };
  }
  return { ...document, ...patch };
}

/**
 * Writes `<modesDir>/<name>/{mode.json, SKILL.md, roles/*.md}` exactly as given: the
 * document is written whatever shape it has, so a test can name the rule it breaks. Every
 * role the document declares gets its prompt file unless `prompts` says otherwise.
 */
export function writeMode(
  modesDir: string, name: string, document: unknown,
  files: { loop?: string | null; prompts?: Record<string, string | null> } = {},
): string {
  const dir = path.join(modesDir, name);
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mode.json"), typeof document === "string" ? document : JSON.stringify(document, null, 2));
  if (files.loop !== null) fs.writeFileSync(path.join(dir, "SKILL.md"), files.loop ?? `The ${name} loop, in one line.\n`);
  const roles = (document as { roles?: Array<{ key?: unknown; promptFile?: unknown }> })?.roles;
  for (const role of Array.isArray(roles) ? roles : []) {
    if (typeof role?.promptFile !== "string" || typeof role?.key !== "string") continue;
    const override = files.prompts?.[role.key];
    if (override === null) continue;
    const file = path.resolve(dir, role.promptFile);
    if (!file.startsWith(dir + path.sep)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, override ?? `The ${role.key} of ${name} does the work of its brief.\n`);
  }
  return dir;
}

/** A modes directory of this test's own, removed when the test ends. */
export function modesRoot(t: TestContext): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "cross-agent-modes-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One written, validated mode: what a server loads once at start and hands its tools. */
export function buildMode(modesDir: string, id: string, roles: RoleSpec[], patch: Record<string, unknown> = {}): Mode {
  writeMode(modesDir, id, modeDocument(id, roles, patch), {
    prompts: Object.fromEntries(roles.filter((role) => role.prompt !== undefined).map((role) => [role.key, role.prompt!])),
  });
  return loadMode(modesDir, id);
}
