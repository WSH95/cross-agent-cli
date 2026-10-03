import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtInModesDir, describeMode } from "../src/modes.ts";

// Claude Code packaging (design section 9). The attach contract is a stdio MCP server plus
// the launcher skill; for this host that is one file — `.claude-plugin/plugin.json`, which
// names the plugin and declares the server under `mcpServers` — with `skills/` discovered
// by convention, both at the repository root, which is the plugin root `claude
// --plugin-dir <repo>` names. There is deliberately no `.mcp.json` beside it: that file is
// Claude Code's project-scoped config for this repository, not a plugin's. These tests pin
// the shape a host reads, not behaviour: what the manifest claims has to still be true of
// this repository.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function json(relative: string): Record<string, unknown> {
  const file = path.join(repoRoot, relative);
  assert.ok(fs.existsSync(file), `${relative} is missing`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("the plugin manifest names this plugin at package.json's version", () => {
  const manifest = json(".claude-plugin/plugin.json");
  const pkg = json("package.json");
  assert.equal(manifest.name, "cross-agent");
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(typeof manifest.description, "string");
  assert.notEqual(manifest.description, "");
});

test("the plugin manifest starts this server from the plugin root", () => {
  const manifest = json(".claude-plugin/plugin.json");
  const servers = manifest.mcpServers as Record<string, { command?: unknown; args?: unknown }>;
  assert.deepEqual(Object.keys(servers), ["cross-agent"]);
  const server = servers["cross-agent"];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/src/server.ts"]);
  // `${CLAUDE_PLUGIN_ROOT}` is this repository when the host is given `--plugin-dir <repo>`,
  // so the argument has to name a file that exists there.
  const args = server.args as string[];
  const entry = path.join(repoRoot, args[0].replace("${CLAUDE_PLUGIN_ROOT}/", ""));
  assert.ok(fs.statSync(entry).isFile(), `${entry} is not a file`);
});

test("no .mcp.json sits at the repository root, where it would be this project's own config", () => {
  // A repository-root `.mcp.json` is Claude Code's **project-scoped** MCP config: every
  // session opened in this repository is prompted to enable what it declares, and there
  // `${CLAUDE_PLUGIN_ROOT}` expands to nothing, so the offer is a server that cannot
  // start. The plugin's own manifest is the only place this server is declared.
  assert.equal(fs.existsSync(path.join(repoRoot, ".mcp.json")), false);
});

test("the skills directory the plugin ships by convention holds the launcher skill", () => {
  const manifest = json(".claude-plugin/plugin.json");
  // No `skills` key: the directory is found by convention, which is what the Codex fallback
  // copy of `skills/` alone depends on too (design section 9).
  assert.equal(manifest.skills, undefined);
  const skill = path.join(repoRoot, "skills", "cross-agent", "SKILL.md");
  assert.ok(fs.statSync(skill).isFile(), `${skill} is not a file`);
});

// Codex packaging (design section 9). Codex reads `.codex-plugin/plugin.json` at the plugin
// root and installs a plugin from a marketplace: a directory holding
// `.agents/plugins/marketplace.json`, which here is this repository, offering itself as its
// one plugin. Codex runs the plugin from a copy of it in its own cache, so the manifest names
// nothing that belongs to one checkout, and the server starts in that copy (probe B1).

/** The servers a Codex manifest declares, inline. */
function codexServers(manifest: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const servers = manifest.mcpServers;
  assert.ok(servers !== null && typeof servers === "object" && !Array.isArray(servers), "mcpServers is declared inline");
  return servers as Record<string, Record<string, unknown>>;
}

// @anchor codexManifestNames
test("the Codex manifest names this plugin at package.json's version, ships the skills directory, and holds nothing else", () => {
  const manifest = json(".codex-plugin/plugin.json");
  const claude = json(".claude-plugin/plugin.json");
  const pkg = json("package.json");
  // The manifest whole but for its server, which `codexManifestMounts` pins whole: no key is
  // added, dropped or changed without this test saying so.
  const { mcpServers, ...named } = manifest;
  assert.notEqual(mcpServers, undefined, "the manifest declares its server");
  assert.deepEqual(named, {
    name: "cross-agent",
    version: pkg.version,
    description: claude.description,
    author: { name: "cross-agent-cli" },
    license: "Apache-2.0",
    // Codex finds a plugin's skills where `skills` points, relative to the plugin root.
    skills: "./skills/",
  });
  assert.equal(pkg.name, "cross-agent");
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(typeof manifest.description, "string");
  assert.notEqual(manifest.description, "");
  const skill = path.join(repoRoot, "skills", "cross-agent", "SKILL.md");
  assert.ok(fs.statSync(skill).isFile(), `${skill} is not a file`);
});

// @anchor codexManifestMounts
test("the Codex manifest starts this server through a launcher in the plugin's own directory, for the project the operator names, with a call budget and no approval prompt", () => {
  const servers = codexServers(json(".codex-plugin/plugin.json"));
  // The mount whole, each key for the reason beside it; no other key, so neither `enabled`
  // (whether the server runs is the operator's configuration's to say, never the product's)
  // nor `env` (a value belongs to one machine; Codex gives a stdio server seven names of its
  // own) nor `args`.
  assert.deepEqual(servers, {
    "cross-agent": {
      // codex-cli 0.159.3 substituted no `${PLUGIN_ROOT}` in an inline `command`, `args` or
      // `cwd` — `node ${PLUGIN_ROOT}/src/server.ts` was spawned as written and died at once —
      // ran a relative `command` from the server's working directory, which is the session's
      // when no `cwd` is given (`execve` ENOENT), and resolved a `cwd` against the plugin root
      // (probe B1). So the server starts in the plugin's own directory through a launcher there.
      command: "./.codex-plugin/serve",
      cwd: ".",
      // Codex hands a stdio server only the variables named here, beyond seven of its own. The
      // plugin's directory is Codex's cache copy of this repository, where discovery finds no
      // project the operator meant: a copy of an export holds no `.git` and no config, so
      // discovery finds nothing, and a copy of a checkout carries the checkout's `.git`, so
      // discovery finds a repository the operator did not name — the copy itself, for a main
      // checkout, or the checkout it was copied from, for a linked worktree. So the operator
      // names the project in `CROSS_AGENT_PROJECT`. A task's markers are named too: a Codex
      // session started inside a task — a suite `run_command` runs carries `CROSS_AGENT_DEPTH` —
      // hands them to its server, which then serves the specialist row
      // (src/runcommand.ts#commandEnv). A clean shell has none to hand on
      // (docs/probes.md#codexMarkers).
      env_vars: ["CROSS_AGENT_PROJECT", "CROSS_AGENT_TASK", "CROSS_AGENT_DEPTH", "CROSS_AGENT_LINEAGE"],
      // `codex exec` runs with approval policy `never`, which refuses every call that would ask (P9).
      default_tools_approval_mode: "approve",
      startup_timeout_sec: 30,
      // A `wait` is a 600 s call, and Codex gives an MCP call 60 s unless the server says otherwise.
      tool_timeout_sec: 3600,
    },
  });
  const launcher = path.join(repoRoot, ".codex-plugin", "serve");
  assert.ok(fs.statSync(launcher).isFile(), `${launcher} is not a file`);
  assert.notEqual(fs.statSync(launcher).mode & 0o111, 0, `${launcher} is not executable`);
});

// @anchor codexLauncherRunsServer
test("the Codex launcher runs the server beside it for the project the operator names, and without one does not start", () => {
  // A `node` that prints what it was asked to run, first on PATH: the launcher's job is the
  // path it hands node — this checkout's `src/server.ts`, whether started relative to the
  // plugin root, as Codex starts it, or by an absolute path — with the project the operator
  // named still in its environment, since from a copy of a checkout discovery would find the
  // checkout instead; and its refusal to start a server that could only find the project from
  // the plugin's own directory.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-project-"));
  try {
    fs.writeFileSync(path.join(bin, "node"), '#!/bin/sh\nprintf "%s\\n" "$PWD" "${CROSS_AGENT_PROJECT-(unset)}" "$@"\n', { mode: 0o755 });
    const base = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
    const server = path.join(repoRoot, "src", "server.ts");
    for (const [command, cwd] of [["./.codex-plugin/serve", repoRoot], [path.join(repoRoot, ".codex-plugin", "serve"), project]]) {
      const printed = execFileSync(command, ["--flag"], { cwd, env: { ...base, CROSS_AGENT_PROJECT: project }, encoding: "utf8" })
        .trimEnd().split("\n");
      assert.deepEqual(printed, [fs.realpathSync(cwd), project, fs.realpathSync(server), "--flag"], `${command} from ${cwd}`);
    }
    for (const value of [undefined, ""]) {
      const env: NodeJS.ProcessEnv = { ...base, CROSS_AGENT_PROJECT: value };
      if (value === undefined) delete env.CROSS_AGENT_PROJECT;
      const refused = spawnSync("./.codex-plugin/serve", [], { cwd: repoRoot, env, encoding: "utf8" });
      assert.notEqual(refused.status, 0, `CROSS_AGENT_PROJECT=${value}`);
      assert.equal(refused.stdout, "", "node was never run");
      assert.match(refused.stderr, /CROSS_AGENT_PROJECT/);
    }
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// @anchor codexLauncherRootUnresolved
test("the Codex launcher that cannot resolve its own directory starts nothing", () => {
  // The launcher's text read by a shell whose `$0` names a directory that does not exist, so
  // the `cd` that finds the plugin root fails: it must stop there rather than hand node a path
  // built from nothing (`/src/server.ts`).
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-project-"));
  try {
    fs.writeFileSync(path.join(bin, "node"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, CROSS_AGENT_PROJECT: project };
    const launcher = path.join(repoRoot, ".codex-plugin", "serve");
    const stranded = spawnSync("sh", ["-c", '. "$1"', "/nonexistent/.codex-plugin/serve", launcher], { cwd: project, env, encoding: "utf8" });
    assert.notEqual(stranded.status, 0, "the launcher went on without its root");
    assert.equal(stranded.stdout, "", `node was run: ${stranded.stdout}`);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// @anchor codexMarketplace
test("the repository is a marketplace offering this one plugin from its own root", () => {
  const marketplace = json(".agents/plugins/marketplace.json");
  assert.equal(marketplace.name, "cross-agent-cli");
  const plugins = marketplace.plugins as Array<Record<string, unknown>>;
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, "cross-agent");
  // A local source path starts with `./` and stays inside the marketplace; `./` is its root.
  assert.deepEqual(plugins[0].source, { source: "local", path: "./" });
  assert.equal((plugins[0].policy as Record<string, unknown>).installation, "AVAILABLE");
});

test("the Claude and Codex manifests agree on the plugin's name, version, description, author and license", () => {
  const codex = json(".codex-plugin/plugin.json");
  const claude = json(".claude-plugin/plugin.json");
  for (const key of ["name", "version", "description", "author", "license"]) assert.deepEqual(codex[key], claude[key], key);
});

// @anchor codexFallbackSnippet
test("the Codex fallback is the table codex mcp add writes plus the plugin mount's four keys, and the README installs, checks and removes both attaches", () => {
  const file = path.join(repoRoot, "assets", "codex", "mcp_servers.toml");
  assert.ok(fs.existsSync(file), "assets/codex/mcp_servers.toml is missing");
  // `codex mcp add cross-agent -- node <repo>/src/server.ts` writes the first three lines; the
  // other four are the plugin mount's: the names Codex hands on, so that a session started
  // inside a task hands its server the task's markers, what a `wait` and `codex exec` need,
  // and the start-up budget the plugin's manifest gives the server, so the two attaches
  // start the same server alike (task 12's review).
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  assert.deepEqual(lines, [
    "[mcp_servers.cross-agent]",
    'command = "node"',
    'args = ["<repo>/src/server.ts"]',
    'env_vars = ["CROSS_AGENT_PROJECT", "CROSS_AGENT_TASK", "CROSS_AGENT_DEPTH", "CROSS_AGENT_LINEAGE"]',
    "tool_timeout_sec = 3600",
    'default_tools_approval_mode = "approve"',
    "startup_timeout_sec = 30",
  ]);
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const claude = readme.indexOf("## Install it in Claude Code");
  const start = readme.indexOf("## Install it in Codex");
  const end = readme.indexOf("## Run the tests");
  assert.ok(claude >= 0 && start > claude && end > start, "the Codex section follows Claude Code's and precedes the tests");
  // The section runs to the next heading of its own level, so a word another host's section
  // carries does not stand in for one of Codex's.
  const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
  for (const words of [
    "codex plugin marketplace add", "codex plugin add cross-agent@cross-agent-cli", "codex plugin list", "codex plugin remove",
    "codex plugin marketplace remove", "codex mcp add cross-agent", "assets/codex/mcp_servers.toml", "~/.codex/skills/cross-agent",
    "codex mcp remove cross-agent",
    // The plugin's one extra step, and the switch that keeps its server off until a session asks.
    "CROSS_AGENT_PROJECT", "plugins.cross-agent@cross-agent-cli.enabled=true",
    // The install registers a clean export, since Codex copies the whole directory it is given,
    // and the fallback's table names the variables the server needs handed on.
    "git -C ~/Documents/cross-agent-cli archive HEAD", 'env_vars = ["CROSS_AGENT_PROJECT",',
  ]) {
    assert.ok(section.includes(words), `the Codex section names ${words}`);
  }
});

// Grok packaging (design section 9). grok 1.0.46 reads this repository as a plugin in place when
// a project's own `.grok/config.toml` names the checkout under `[plugins]`: the skill from
// `skills/` and the server from `.claude-plugin/plugin.json`'s `mcpServers`, with
// `${CLAUDE_PLUGIN_ROOT}` expanded to the checkout (T15's attach probe, A1). So no Grok manifest
// ships, and what this test pins is the README's recipe: the project-scoped lines, the trust
// they need, the result cap `describe_mode` needs, the checks and the way back.

// @anchor describeModeSizes
test("the README states the mode's text describe_mode answers with, without projectRoot, at its size today, which Grok's default cap cuts under both dev-team modes", () => {
  // The mode's text as the server sends it (`src/server.ts`, its `text`), in bytes, as
  // Grok's `max_output_bytes` counts them, without the `projectRoot` the handler adds beside
  // it, whose size is the root's own (`tests/server.test.ts#describeModeAnswerSize`). Task
  // 12's review found the README's sizes a merge behind.
  const size = (mode: string) => Buffer.byteLength(JSON.stringify(describeMode(builtInModesDir(), mode), null, 2));
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8").replace(/\s+/g, " ");
  const stated = /the mode's text, without `projectRoot`, is ([\d,]+) bytes under `dev-team`, ([\d,]+) under `dev-team-engine` and ([\d,]+) under `solo`/.exec(readme);
  assert.ok(stated !== null, "the README states the three sizes");
  assert.deepEqual(stated.slice(1).map((value) => Number(value.replace(/,/g, ""))), [size("dev-team"), size("dev-team-engine"), size("solo")]);
  assert.ok(size("dev-team") > 20_000 && size("dev-team-engine") > 20_000, "both dev-team answers pass Grok's default cap");
  assert.ok(size("dev-team-engine") < 100_000, "and the cap the attach sets holds the larger");
});

// @anchor readmeSeveralBranches
test("the README has a worktree project's .gitignore change committed first, and finds a hung git by either tool's command line", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const start = readme.indexOf("## Several branches at once");
  const end = readme.indexOf("\n## ", start + 1);
  assert.ok(start >= 0 && end > start, "the README has the section");
  const section = readme.slice(start, end).replace(/\s+/g, " ");
  // A loop's first step stops on a dirty root, and init's change to `.gitignore` is one.
  assert.match(section, /[Cc]ommit the `\.gitignore` change `init` makes there on the worktree's branch before its first task/);
  // A hung `git_mutate` step runs in the task's worktree, and a hung `git_root` step's hooks
  // at the project root: the recovery names both.
  assert.match(section, /`--work-tree=<the task's worktree>`[^.]*`git_mutate`[^.]*`--work-tree=<the project root>`[^.]*`git_root`/);
  const design = fs.readFileSync(path.join(repoRoot, "docs", "design.md"), "utf8").replace(/\s+/g, " ");
  assert.match(design, /hung git by its command line — `--work-tree=<the task's worktree>` for a `git_mutate` step, `--work-tree=<the project root>` for a `git_root` step/);
});

// @anchor hooksAndUnsupportedWording
test("the docs put each hook where git runs it, keep spawn.lock out of git_root's steps, and give the unsupported class's reason at a symlinked .git", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8").replace(/\s+/g, " ");
  const design = fs.readFileSync(path.join(repoRoot, "docs", "design.md"), "utf8").replace(/\s+/g, " ");
  // A merge's hooks run at the root and a worktree add's post-checkout hook in the new
  // worktree, both under a git whose command line names the project root.
  for (const [name, text] of [["README", readme], ["design", design]]) {
    assert.match(text, /a `merge`'s hooks run at the root, and a `worktree add`'s post-checkout hook in the new worktree/, name);
    assert.doesNotMatch(text, /`worktree add` and `merge` run the repository's hooks at the root/, name);
  }
  // git_root's steps hold git.lock and the repository lock, and cancel does not end their git;
  // the worktree add delegate runs for a one-shot is inside the delegation's own spawn.lock.
  assert.match(design, /holds `git\.lock` and the repository lock, not `spawn\.lock`/);
  assert.match(design, /`cancel` can run beside it — except the `worktree add` `delegate` runs for a one-shot, inside its own `spawn\.lock`, where `cancel` waits too — and still does not end that git child/);
  assert.doesNotMatch(design, /A `git_root` step holds both locks the same way/);
  // Worktree roles at a symlinked .git are refused because the class takes no writes.
  assert.match(design, /an `unsupported` root takes none, and no root git tool ever ran there/);
  assert.doesNotMatch(design, /though the git directory they share lay outside the denied cwd/);
});

// @anchor grokReadmeInstall
test("the README attaches Grok per project through the project's own .grok/config.toml, and checks and removes it", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const codex = readme.indexOf("## Install it in Codex");
  const start = readme.indexOf("## Install it in Grok");
  const end = readme.indexOf("## Run the tests");
  assert.ok(codex >= 0 && start > codex && end > start, "the Grok section follows Codex's and precedes the tests");
  // What the section says, rather than where its lines wrapped.
  const section = readme.slice(start, end).replace(/\s+/g, " ");
  const missing = [
    // The bind-time config first: Grok starts the plugin's server in the session's directory,
    // which finds the project by the config it holds; `cross-agent` is on PATH only where linked.
    "cross-agent init", "node ~/Documents/cross-agent-cli/src/cli.ts init",
    // `.grok/` ignored beside `init`'s entries, on a line of its own even after a last line with no
    // newline, and the change committed: a loop's first step stops on a dirty tree, and a committed
    // `.grok/config.toml` would reach every task worktree, which Grok takes as a project of its own.
    "printf '\\n.grok/\\n' >> .gitignore", "git add .gitignore && git commit", "Commit that `.gitignore` change",
    "every task worktree",
    // A project that already tracks the file untracks it in the same commit, by the index rather
    // than a pathspec: `-- .gitignore` leaves the removal staged, and naming the file re-adds it.
    "already tracks `.grok/config.toml`",
    "git rm --cached .grok/config.toml && git add .gitignore && git commit -m 'Ignore cross-agent and Grok state'",
    // The attach itself, project-scoped: the plugin read in place, at an absolute path (Grok
    // expands no `~` in `paths`), and the result cap `describe_mode` under `dev-team-engine` needs.
    ".grok/config.toml", "[plugins]", 'paths = ["$HOME/Documents/cross-agent-cli"]', 'enabled = ["cross-agent"]',
    "[mcp]", "max_output_bytes = 100000",
    // Into a file that already has the tables, the attach is merged, never declared twice: the
    // block itself points there, and a hand merge writes the path out and notes the cap it raises.
    "# If .grok/config.toml already has a [plugins] or [mcp] table, merge by hand",
    "add the checkout's absolute path, your home directory written out,", "to the existing `paths` array",
    'and `"cross-agent"` to the existing `enabled` array', "unless it is already larger", "note the value you replace",
    // A project file counts only in a trusted folder.
    "--trust",
    // The checks, the host spelling, and the operator row's count under the engine-placed mode.
    "grok inspect --json", "grok mcp doctor cross-agent", "cross-agent__", "fifteen",
    // The way back takes out only what the attach added, entry by entry, and the file only when
    // nothing else was in it; the attach never touches ~/.grok/.
    "To remove it", "only what the attach added", "the checkout's path from `paths`", '`"cross-agent"` from `enabled`',
    "restored to the value you noted", "only if the attach's lines were all it held", "~/.grok/",
    // A worktree specialist stays server-less only while the file stays out of the repository.
    "Only a committed `.grok/config.toml`, which the recipe keeps out, or a mount at user scope",
    // What a Grok specialist at the attached root is offered beside the server, and who refuses
    // its `delegate`: Grok's dispatcher, which lists no such tool, before the server is asked.
    "The launcher skill reaches a Grok specialist at the root", "refused by Grok's own dispatcher",
  ].filter((words) => !section.includes(words));
  assert.deepEqual(missing, [], "the Grok section names each of these");
  // `echo` would join `.grok/` onto a last line that has no newline, which `init` leaves alone
  // when it has nothing to add.
  assert.ok(!section.includes("echo '.grok/' >> .gitignore"), "the Grok section appends the ignore line with printf");
});

// @anchor readmeInitThenCommit
test("the README has the operator commit init's .gitignore change before a team's first task", () => {
  // A loop's first step stops unless the root's `git status --porcelain --untracked-files=normal`
  // prints nothing, and `init` itself leaves `.gitignore` modified or new.
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const start = readme.indexOf("## Install it in Claude Code");
  assert.ok(start >= 0, "the README has a Claude Code section");
  const section = readme.slice(start, readme.indexOf("\n## ", start + 1)).replace(/\s+/g, " ");
  assert.ok(section.includes("Commit that `.gitignore` change"), "the Claude Code section says to commit init's .gitignore change");
  assert.ok(section.includes("git status --porcelain --untracked-files=normal"), "and says why: the first step's clean-tree check");
});
