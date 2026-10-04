import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The dist builder (`tools/build-dist.mjs`, design section 9): the install payloads published
// to WSH95/agent-plugins, one marketplace directory per host, built from a commit. These tests
// build from a fixture repository committed from this working tree's payload files, so they
// hold whatever the working tree holds, committed or not, and never read this repository's
// own history.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = path.join(repoRoot, "tools", "build-dist.mjs");
const PAYLOAD = ["bin", "src", "modes", "skills", "LICENSE", "package.json", ".claude-plugin", ".codex-plugin"];
const EXECUTABLE = ["bin/cross-agent", "src/cli.ts", ".codex-plugin/serve"];
const VERSIONED = ["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" }).trim();
}

function json(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
}

/** A repository holding this working tree's payload files and four that must never ship, committed. */
function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dist-source-"));
  for (const entry of PAYLOAD) fs.cpSync(path.join(repoRoot, entry), path.join(dir, entry), { recursive: true });
  for (const file of EXECUTABLE) fs.chmodSync(path.join(dir, file), fs.statSync(path.join(repoRoot, file)).mode);
  fs.mkdirSync(path.join(dir, ".agents", "plugins"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, ".agents", "plugins", "marketplace.json"), path.join(dir, ".agents", "plugins", "marketplace.json"));
  for (const file of ["tests/x.test.ts", "docs/x.md", "tools/x.mjs", "README.md"]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "development only\n");
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  return dir;
}

/** The fixture's three version fields set to `version`, committed. */
function commitVersion(source: string, version: string, files: readonly string[] = VERSIONED): void {
  for (const file of files) {
    const value = json(path.join(source, file));
    fs.writeFileSync(path.join(source, file), JSON.stringify({ ...value, version }, null, 2) + "\n");
  }
  git(source, "commit", "-q", "-am", `version ${version}`);
}

function build(source: string, out: string, ...extra: string[]) {
  return spawnSync(process.execPath, [builder, "--source", source, "--out", out, ...extra], { encoding: "utf8" });
}

/** The version a payload's server reports in its `initialize` reply, started in a scratch repository. */
async function initializeVersion(plugin: string): Promise<string> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "dist-project-"));
  try {
    git(project, "init", "-q");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CROSS_AGENT_")));
    const server = spawn(process.execPath, [path.join(plugin, "src", "server.ts")], { cwd: project, env, stdio: ["pipe", "pipe", "ignore"] });
    const reply = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      server.stdout.on("data", (chunk) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end >= 0) resolve(buffer.slice(0, end));
      });
      server.on("error", reject);
      server.on("exit", (code) => reject(new Error(`the server exited ${code} before it answered`)));
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dist-test", version: "0" } } }) + "\n");
    });
    server.stdin.end();
    await new Promise((resolve) => server.once("close", resolve));
    return (JSON.parse(reply) as { result: { serverInfo: { version: string } } }).result.serverInfo.version;
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
}

function outDir(): { out: string; scratch: string } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dist-out-"));
  return { out: path.join(scratch, "cross-agent"), scratch };
}

// @anchor distPayloads
test("the builder writes the Claude and Codex payloads from a commit, each with its own manifest and the shared files alone", () => {
  const source = fixture();
  const { out, scratch } = outDir();
  try {
    const built = build(source, out);
    assert.equal(built.status, 0, built.stderr);
    assert.deepEqual(fs.readdirSync(out).sort(), ["claude", "codex"]);
    const hosts = [["claude", ".claude-plugin/plugin.json", ".codex-plugin"], ["codex", ".codex-plugin/plugin.json", ".claude-plugin"]] as const;
    for (const [host, own, other] of hosts) {
      const plugin = path.join(out, host, "plugins", "cross-agent");
      for (const file of ["bin/cross-agent", "src/server.ts", "src/cli.ts", "src/runner.ts", "skills/cross-agent/SKILL.md", "modes/solo/mode.json", "LICENSE", "package.json", own]) {
        assert.ok(fs.statSync(path.join(plugin, file)).isFile(), `${host}: ${file}`);
      }
      assert.deepEqual(json(path.join(plugin, own)), json(path.join(source, own)), `${host}: the manifest is the commit's`);
      for (const absent of [other, "tests", "docs", "tools", ".agents", "README.md"]) {
        assert.equal(fs.existsSync(path.join(plugin, absent)), false, `${host} ships ${absent}`);
      }
      for (const file of host === "codex" ? EXECUTABLE : EXECUTABLE.slice(0, 2)) {
        assert.notEqual(fs.statSync(path.join(plugin, file)).mode & 0o111, 0, `${host}: ${file} is not executable`);
      }
      const pkg = json(path.join(plugin, "package.json"));
      const sourcePkg = json(path.join(source, "package.json"));
      assert.equal(pkg.scripts, undefined, "the trimmed package.json carries no scripts");
      for (const key of ["name", "version", "type", "license", "bin"]) assert.deepEqual(pkg[key], sourcePkg[key], key);
    }
    const manifest = json(path.join(source, ".claude-plugin", "plugin.json"));
    const claude = json(path.join(out, "claude", ".claude-plugin", "marketplace.json"));
    assert.equal(claude.name, "cross-agent-marketplace");
    assert.deepEqual(claude.owner, manifest.author);
    assert.deepEqual(claude.plugins, [{ name: "cross-agent", source: "./plugins/cross-agent", description: manifest.description }]);
    const listing = json(path.join(source, ".agents", "plugins", "marketplace.json")).plugins[0];
    const codex = json(path.join(out, "codex", ".agents", "plugins", "marketplace.json"));
    assert.equal(codex.name, "cross-agent-marketplace");
    assert.deepEqual(codex.plugins, [{ name: "cross-agent", source: { source: "local", path: "./plugins/cross-agent" }, policy: listing.policy, category: listing.category }]);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// @anchor distPayloadRuns
test("a built payload runs on its own: the launcher answers --help, and the server reports the version the commit carries", async () => {
  const source = fixture();
  const { out, scratch } = outDir();
  try {
    const built = build(source, out);
    assert.equal(built.status, 0, built.stderr);
    const version = json(path.join(source, "package.json")).version as string;
    for (const host of ["claude", "codex"]) {
      const plugin = path.join(out, host, "plugins", "cross-agent");
      const help = spawnSync(path.join(plugin, "bin", "cross-agent"), ["--help"], { cwd: scratch, encoding: "utf8" });
      assert.equal(help.status, 0, `${host}: ${help.stderr}`);
      assert.match(help.stdout, /cross-agent init/);
      assert.equal(await initializeVersion(plugin), version, host);
    }
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// @anchor distRefusals
test("the builder refuses an output it must not replace, and writes nothing there", () => {
  const source = fixture();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dist-refuse-"));
  try {
    const nonempty = path.join(scratch, "nonempty");
    fs.mkdirSync(nonempty);
    fs.writeFileSync(path.join(nonempty, "keep.txt"), "mine\n");
    const nested = path.join(scratch, "nested");
    assert.equal(build(source, nested).status, 0);
    fs.mkdirSync(path.join(nested, "claude", ".git"));
    const linked = path.join(scratch, "nested", "codex", "plugins", "cross-agent", "skills", "linked");
    fs.symlinkSync(scratch, linked);
    const viaLink = path.join(scratch, "link");
    fs.symlinkSync(scratch, viaLink);
    const home = path.join(scratch, "home");
    fs.mkdirSync(home);
    const cases: Array<[string, string, NodeJS.ProcessEnv?]> = [
      ["the source itself", source],
      ["an ancestor of the source", path.dirname(source)],
      ["a tracked source entry", path.join(source, "src", "dist")],
      ["Git metadata", path.join(source, ".git", "dist")],
      ["a path through a symlink", path.join(viaLink, "out")],
      ["an unrecognized nonempty directory", nonempty],
      ["a payload holding Git metadata and a symlink", nested],
      ["the home directory", home, { HOME: home }],
      ["the filesystem root", path.parse(scratch).root],
    ];
    for (const [what, out, env] of cases) {
      const refused = spawnSync(process.execPath, [builder, "--source", source, "--out", out], { encoding: "utf8", env: { ...process.env, ...env } });
      assert.equal(refused.status, 1, `${what}: ${refused.stdout}${refused.stderr}`);
      assert.match(refused.stderr, /refusing/, what);
    }
    assert.deepEqual(fs.readdirSync(nonempty), ["keep.txt"]);
    assert.equal(fs.existsSync(path.join(source, "src", "dist")), false);
    assert.equal(fs.existsSync(path.join(scratch, "out")), false);
    assert.deepEqual(fs.readdirSync(home), []);
    assert.deepEqual(fs.readdirSync(scratch).sort(), ["home", "link", "nested", "nonempty"], "no staging directory was left behind");
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// @anchor distFailedBuild
test("a build that fails leaves the previous output whole, and names the file the commit lacks", () => {
  const source = fixture();
  const { out, scratch } = outDir();
  try {
    assert.equal(build(source, out).status, 0);
    const skill = path.join("plugins", "cross-agent", "skills", "cross-agent", "SKILL.md");
    const before = fs.readFileSync(path.join(out, "claude", skill), "utf8");
    git(source, "rm", "-q", "skills/cross-agent/SKILL.md");
    git(source, "commit", "-q", "-m", "drop the launcher skill");
    const failed = build(source, out);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /skills\/cross-agent\/SKILL\.md is missing/);
    for (const host of ["claude", "codex"]) assert.equal(fs.readFileSync(path.join(out, host, skill), "utf8"), before, host);
    assert.deepEqual(fs.readdirSync(scratch), ["cross-agent"], "no staging directory was left behind");
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// @anchor distRebuildVersions
test("a rebuild over an older payload replaces it, the manifests and the initialize reply following each ref's version", async () => {
  const source = fixture();
  const { out, scratch } = outDir();
  try {
    const current = json(path.join(source, "package.json")).version as string;
    commitVersion(source, "0.0.9");
    for (const [ref, version] of [["HEAD", "0.0.9"], ["HEAD~1", current]] as const) {
      const built = build(source, out, "--ref", ref);
      assert.equal(built.status, 0, built.stderr);
      for (const host of ["claude", "codex"]) {
        const plugin = path.join(out, host, "plugins", "cross-agent");
        for (const file of ["package.json", host === "claude" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json"]) {
          assert.equal(json(path.join(plugin, file)).version, version, `${ref} ${host} ${file}`);
        }
      }
      assert.equal(json(path.join(out, "claude", ".claude-plugin", "marketplace.json")).metadata.version, version, ref);
      assert.equal(await initializeVersion(path.join(out, "claude", "plugins", "cross-agent")), version, ref);
    }
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// @anchor distVersionsAgree
test("the builder refuses a commit whose package.json and manifests disagree on the version, and reads its own command line", () => {
  const source = fixture();
  const { out, scratch } = outDir();
  try {
    commitVersion(source, "9.9.9", ["package.json"]);
    const refused = build(source, out);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /versions disagree/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(spawnSync(process.execPath, [builder, "--bogus"], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [builder, "--help"], { encoding: "utf8" }).status, 0);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
