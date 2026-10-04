import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Publication (design section 9): `tools/publish_agent_artifact_pr.py`, kept verbatim from
// WSH95/project-steward, opens the pull request that carries `dist/cross-agent` into
// WSH95/agent-plugins at `cross-agent/`, as `agent-artifacts.json` says. These tests pin the
// manifest and run the publisher's dry run offline, against a checkout of a fixture target.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publisher = path.join(repoRoot, "tools", "publish_agent_artifact_pr.py");
const python = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

function manifest(): Record<string, string> {
  const { artifacts } = JSON.parse(fs.readFileSync(path.join(repoRoot, "agent-artifacts.json"), "utf8")) as { artifacts: Array<Record<string, string>> };
  assert.equal(artifacts.length, 1);
  return artifacts[0];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" }).trim();
}

// @anchor publishManifest
test("the publish manifest carries the built payload to agent-plugins at cross-agent/ on main", () => {
  const artifact = manifest();
  assert.equal(artifact.kind, "plugin");
  assert.equal(artifact.target_repo, "git@github.com:WSH95/agent-plugins.git");
  assert.equal(artifact.target_path, "cross-agent");
  assert.equal(artifact.base_branch, "main");
  assert.equal(artifact.source_path, "dist/cross-agent");
  // The build writes where the publisher reads.
  assert.equal(artifact.build_command, `node tools/build-dist.mjs --out ${artifact.source_path}`);
});

// @anchor publishDryRun
test("the publisher's dry run previews the payload at cross-agent/ and leaves the target checkout as it was", { skip: !python && "python3 is not installed" }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "publish-"));
  try {
    // The project side: this manifest beside a built payload where it points.
    const project = path.join(scratch, "project");
    const artifact = manifest();
    const payload = path.join(project, artifact.source_path);
    for (const file of ["claude/.claude-plugin/marketplace.json", "claude/plugins/cross-agent/README", "codex/plugins/cross-agent/README"]) {
      fs.mkdirSync(path.dirname(path.join(payload, file)), { recursive: true });
      fs.writeFileSync(path.join(payload, file), `${file}\n`);
    }
    fs.copyFileSync(path.join(repoRoot, "agent-artifacts.json"), path.join(project, "agent-artifacts.json"));
    // The target side: a clean checkout of a marketplace on its base branch.
    const target = path.join(scratch, "agent-plugins");
    fs.mkdirSync(path.join(target, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(target, ".claude-plugin", "marketplace.json"), "{}\n");
    git(target, "init", "-q", "-b", artifact.base_branch);
    git(target, "add", "-A");
    git(target, "commit", "-q", "-m", "marketplace");
    const head = git(target, "rev-parse", "HEAD");

    const run = spawnSync("python3", [publisher, "--manifest", path.join(project, "agent-artifacts.json"), "--target-checkout", target, "--dry-run", "--non-interactive"],
      { cwd: project, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /DRY RUN: proposed artifact diff/);
    assert.match(run.stdout, /cross-agent\/claude\/plugins\/cross-agent\/README/);
    assert.doesNotMatch(run.stdout, /^diff --git a\/(?!cross-agent\/)/m, "the preview touches nothing outside cross-agent/");
    assert.equal(git(target, "rev-parse", "HEAD"), head);
    assert.equal(git(target, "status", "--porcelain", "--untracked-files=all"), "");
    assert.equal(fs.existsSync(path.join(target, artifact.target_path)), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
