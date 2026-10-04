#!/usr/bin/env node
// Builds the plugin's install payloads from a commit of this repository, in the layout
// WSH95/agent-plugins publishes, one marketplace directory per host:
//
//   <out>/claude/.claude-plugin/marketplace.json   a one-plugin marketplace: ./plugins/cross-agent
//   <out>/claude/plugins/cross-agent/              .claude-plugin/plugin.json and the shared files
//   <out>/codex/.agents/plugins/marketplace.json   the same for Codex
//   <out>/codex/plugins/cross-agent/               .codex-plugin/{plugin.json,serve} and the shared files
//
// Grok installs the Claude payload. The shared files are what an installed copy runs:
// `bin/cross-agent`, `src/`, `modes/`, `skills/`, `LICENSE`, and `package.json` trimmed to
// what a copy needs (`src/server.ts` reads its version there). They come from `git archive
// <ref>`, so a payload is exactly a commit: nothing untracked, ignored or uncommitted reaches
// it, and git's exec bits survive. The build happens in a staging directory beside the output
// and replaces it only when it is whole, so a refused or failed build leaves the previous
// output as it was. Not product code; `tests/dist.test.ts` holds it to this.
//
//   node tools/build-dist.mjs [--source <repo>] [--ref <rev>] [--out <dir>]
//
// Exits 0 when it built, 1 when it refused or failed, 2 on a command line it cannot read.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = "cross-agent";
const MARKETPLACE = `${PLUGIN}-marketplace`;
const SHARED = ["bin/cross-agent", "src", "modes", "skills", "LICENSE", "package.json"];
const HOSTS = {
  claude: { only: [".claude-plugin/plugin.json"], manifest: ".claude-plugin/plugin.json" },
  codex: { only: [".codex-plugin/plugin.json", ".codex-plugin/serve"], manifest: ".codex-plugin/plugin.json" },
};
// What a payload cannot run without, checked at the ref before anything is written.
const REQUIRED = [
  "bin/cross-agent", "src/server.ts", "src/cli.ts", "src/runner.ts", "skills/cross-agent/SKILL.md",
  "modes/dev-team/mode.json", "modes/dev-team-engine/mode.json", "modes/solo/mode.json",
  "LICENSE", "package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".codex-plugin/serve",
  ".agents/plugins/marketplace.json",
];
// The files an installed copy runs as programs.
const EXECUTABLE = ["bin/cross-agent", "src/cli.ts"];
// What a trimmed package.json keeps: identity, the module type Node needs for `src/`, and `bin`.
const PACKAGE_KEYS = ["name", "version", "private", "description", "type", "license", "homepage", "repository", "engines", "bin"];

class Refusal extends Error {}

const usage = "usage: node tools/build-dist.mjs [--source <repo>] [--ref <rev>] [--out <dir>]";

function parse(argv) {
  const values = { source: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), ref: "HEAD", out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    const key = { "--source": "source", "--ref": "ref", "--out": "out" }[flag];
    if (key === undefined || i + 1 >= argv.length || argv[i + 1] === "") return { error: `cannot read ${JSON.stringify(flag)}` };
    values[key] = argv[++i];
  }
  return { values };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
}

function isUnder(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The real path of `target`, through its deepest existing ancestor when it does not exist yet. */
function resolvedPath(target) {
  let existing = target;
  const rest = [];
  while (!fs.existsSync(existing)) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

/** The first `.git` entry or symlink inside `dir`, or null. */
function unsafeEntry(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name.toLowerCase() === ".git") return `${full} (Git metadata)`;
    if (entry.isSymbolicLink()) return `${full} (symlink)`;
    if (entry.isDirectory()) {
      const found = unsafeEntry(full);
      if (found !== null) return found;
    }
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Whether `dir` holds a payload this builder wrote: the same plugin, by its stable identity. */
function isGenerated(dir, identity) {
  for (const host of Object.keys(HOSTS)) {
    const manifest = readJson(path.join(dir, host, "plugins", PLUGIN, HOSTS[host].manifest));
    if (manifest === null) return false;
    for (const key of ["name", "author", "license", "homepage"]) {
      if (JSON.stringify(manifest[key]) !== JSON.stringify(identity[key])) return false;
    }
  }
  const claude = readJson(path.join(dir, "claude", ".claude-plugin", "marketplace.json"));
  const codex = readJson(path.join(dir, "codex", ".agents", "plugins", "marketplace.json"));
  if (claude?.name !== MARKETPLACE || codex?.name !== MARKETPLACE) return false;
  if (claude.plugins?.length !== 1 || claude.plugins[0]?.name !== PLUGIN || claude.plugins[0]?.source !== `./plugins/${PLUGIN}`) return false;
  if (codex.plugins?.length !== 1 || codex.plugins[0]?.name !== PLUGIN || codex.plugins[0]?.source?.path !== `./plugins/${PLUGIN}`) return false;
  return true;
}

/** The output directory, refused unless it is safe to replace (agent-artifact-maintainer's rules). */
function validateOutput(out, source, gitDirs, topEntries, identity) {
  const lexical = path.resolve(out);
  const target = resolvedPath(lexical);
  for (const candidate of [lexical, target]) {
    if (candidate.split(path.sep).some((part) => part.toLowerCase() === ".git")) throw new Refusal(`refusing ${out}: it names Git metadata`);
  }
  // A symlink the caller put in the path is refused; a system alias directly under `/` (macOS
  // `/tmp` → `/private/tmp`) is not the caller's, unless it is the output itself.
  let walked = path.parse(lexical).root;
  for (const part of path.relative(walked, lexical).split(path.sep).filter(Boolean)) {
    walked = path.join(walked, part);
    if (!fs.existsSync(walked) && !isSymlink(walked)) break;
    if (isSymlink(walked) && !(path.dirname(walked) === path.parse(walked).root && walked !== lexical)) {
      throw new Refusal(`refusing ${out}: ${walked} is a symlink`);
    }
  }
  if (target === path.parse(target).root || target === fs.realpathSync(os.homedir())) throw new Refusal(`refusing ${out}: ${target} is not an output directory`);
  if (isUnder(source, target)) throw new Refusal(`refusing ${out}: it is the source repository or an ancestor of it`);
  for (const dir of gitDirs) {
    if (isUnder(target, dir) || isUnder(dir, target)) throw new Refusal(`refusing ${out}: it overlaps the Git directory ${dir}`);
  }
  for (const entry of topEntries) {
    const tracked = path.join(source, entry);
    if (isUnder(target, tracked)) throw new Refusal(`refusing ${out}: it lies in the tracked source ${entry}`);
  }
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isDirectory()) throw new Refusal(`refusing ${out}: it is not a directory`);
    if (fs.readdirSync(target).length > 0) {
      const unsafe = unsafeEntry(target);
      if (unsafe !== null) throw new Refusal(`refusing ${out}: it holds ${unsafe}`);
      if (!isGenerated(target, identity)) throw new Refusal(`refusing ${out}: a nonempty directory this builder did not write`);
    }
  }
  return target;
}

function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `git archive <sha> -- <paths>` unpacked into `dir`. */
function extract(source, sha, paths, dir) {
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve, reject) => {
    const archive = spawn("git", ["archive", "--format=tar", sha, "--", ...paths], { cwd: source, stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-f", "-", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
    archive.stdout.pipe(tar.stdin);
    let errors = "";
    archive.stderr.on("data", (chunk) => { errors += chunk; });
    tar.stderr.on("data", (chunk) => { errors += chunk; });
    let pending = 2;
    let failed = false;
    const settle = (name) => (code) => {
      if (code !== 0) failed = true;
      if (code !== 0) errors += `${name} exited ${code}\n`;
      if (--pending === 0) failed ? reject(new Error(`extracting ${sha}: ${errors.trim()}`)) : resolve();
    };
    archive.on("close", settle("git archive"));
    tar.on("close", settle("tar"));
  });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

async function build({ source, ref, out }) {
  source = fs.realpathSync(path.resolve(source));
  let top;
  try {
    top = fs.realpathSync(git(source, "rev-parse", "--show-toplevel"));
  } catch {
    throw new Refusal(`${source} is not a git work tree`);
  }
  if (top !== source) throw new Refusal(`${source} is not the top of its work tree (${top} is)`);
  let sha;
  try {
    sha = git(source, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  } catch {
    throw new Refusal(`${ref} names no commit in ${source}`);
  }
  for (const file of REQUIRED) {
    try {
      git(source, "cat-file", "-e", `${sha}:${file}`);
    } catch {
      throw new Refusal(`${file} is missing at ${ref} (${sha.slice(0, 12)})`);
    }
  }
  const show = (file) => JSON.parse(git(source, "show", `${sha}:${file}`));
  const pkg = show("package.json");
  const manifests = { claude: show(HOSTS.claude.manifest), codex: show(HOSTS.codex.manifest) };
  for (const [name, value] of [["package.json", pkg], ...Object.entries(manifests).map(([host, m]) => [HOSTS[host].manifest, m])]) {
    if (value.name !== PLUGIN) throw new Refusal(`${name} names ${JSON.stringify(value.name)}, not ${PLUGIN}`);
  }
  const versions = new Set([pkg.version, manifests.claude.version, manifests.codex.version]);
  if (versions.size !== 1) {
    throw new Refusal(`versions disagree at ${ref}: package.json ${pkg.version}, ${HOSTS.claude.manifest} ${manifests.claude.version}, ${HOSTS.codex.manifest} ${manifests.codex.version}`);
  }
  const listing = show(".agents/plugins/marketplace.json").plugins?.find((entry) => entry.name === PLUGIN);
  if (listing === undefined) throw new Refusal(`.agents/plugins/marketplace.json lists no ${PLUGIN}`);

  const gitDirs = [...new Set(["--absolute-git-dir", "--git-common-dir"].map((flag) => fs.realpathSync(path.resolve(source, git(source, "rev-parse", flag)))))];
  const topEntries = git(source, "ls-tree", "--name-only", sha).split("\n").filter(Boolean);
  const target = validateOutput(out ?? path.join(source, "dist", PLUGIN), source, gitDirs, topEntries, manifests.claude);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), `.${path.basename(target)}.staging-`));
  try {
    const trimmed = Object.fromEntries(PACKAGE_KEYS.filter((key) => key in pkg).map((key) => [key, pkg[key]]));
    for (const [host, spec] of Object.entries(HOSTS)) {
      const plugin = path.join(staging, host, "plugins", PLUGIN);
      await extract(source, sha, [...SHARED, ...spec.only], plugin);
      writeJson(path.join(plugin, "package.json"), trimmed);
      for (const file of [...EXECUTABLE, ...(host === "codex" ? [".codex-plugin/serve"] : [])]) {
        if ((fs.statSync(path.join(plugin, file)).mode & 0o111) === 0) throw new Refusal(`${file} is not executable at ${ref}`);
      }
    }
    writeJson(path.join(staging, "claude", ".claude-plugin", "marketplace.json"), {
      name: MARKETPLACE,
      owner: manifests.claude.author,
      metadata: { description: `Marketplace for the ${PLUGIN} plugin`, version: pkg.version },
      plugins: [{ name: PLUGIN, source: `./plugins/${PLUGIN}`, description: manifests.claude.description }],
    });
    writeJson(path.join(staging, "codex", ".agents", "plugins", "marketplace.json"), {
      name: MARKETPLACE,
      description: `Marketplace exposing the ${PLUGIN} plugin to Codex (\`codex plugin marketplace add <path-or-repo>\`).`,
      interface: { displayName: PLUGIN },
      plugins: [{ name: PLUGIN, source: { source: "local", path: `./plugins/${PLUGIN}` }, policy: listing.policy, category: listing.category }],
    });
    // The swap: the old output moves aside, the staging takes its name, and only then is the
    // old one removed; a failed rename puts the old output back.
    const aside = fs.existsSync(target) ? `${staging}.previous` : null;
    if (aside !== null) fs.renameSync(target, aside);
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      if (aside !== null) fs.renameSync(aside, target);
      throw error;
    }
    if (aside !== null) fs.rmSync(aside, { recursive: true, force: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { target, sha, version: pkg.version };
}

const parsed = parse(process.argv.slice(2));
if (parsed.help) {
  process.stdout.write(`${usage}\n`);
} else if (parsed.error !== undefined) {
  process.stderr.write(`build-dist: ${parsed.error}\n${usage}\n`);
  process.exitCode = 2;
} else {
  try {
    const { target, sha, version } = await build(parsed.values);
    process.stdout.write(`build-dist: built ${PLUGIN} ${version} from ${sha} in ${target}\n`);
  } catch (error) {
    process.stderr.write(`build-dist: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
