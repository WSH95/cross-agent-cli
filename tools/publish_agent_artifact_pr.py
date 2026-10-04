#!/usr/bin/env python3
"""Publish a generated agent skill/plugin artifact as a GitHub PR."""
from __future__ import annotations

import argparse
import datetime as _datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


DEFAULT_MANIFEST = "agent-artifacts.json"


class UsageError(Exception):
    pass


def _load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise UsageError("cannot read %s: %s" % (path, exc))
    except ValueError as exc:
        raise UsageError("invalid JSON in %s: %s" % (path, exc))


def _write_json(path, data):
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _select_artifact(manifest, name):
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise UsageError("manifest must contain a non-empty artifacts list")
    if name:
        for artifact in artifacts:
            if artifact.get("name") == name:
                return artifact
        raise UsageError("unknown artifact %r" % name)
    if len(artifacts) == 1:
        return artifacts[0]
    names = ", ".join(str(item.get("name", "<unnamed>")) for item in artifacts)
    raise UsageError("--artifact is required; available artifacts: %s" % names)


def _validate_rel_path(value, label):
    if not value or not isinstance(value, str):
        raise UsageError("%s is required" % label)
    path = Path(value)
    if path.is_absolute() or value in (".", os.curdir):
        raise UsageError("unsafe %s: %s" % (label, value))
    if any(part == ".." for part in path.parts):
        raise UsageError("unsafe %s: %s" % (label, value))
    if label == "target_path" and any(
        part.lower() == ".git" for part in path.parts
    ):
        raise UsageError("unsafe %s: %s" % (label, value))
    return path


def _is_under(child, parent):
    child_s = str(child.resolve())
    parent_s = str(parent.resolve())
    return child_s == parent_s or child_s.startswith(parent_s + os.sep)


def _run(command, cwd, capture=False, read_only=False):
    if isinstance(command, str):
        shell = True
    else:
        shell = False
    env = None
    if read_only:
        env = os.environ.copy()
        env["GIT_OPTIONAL_LOCKS"] = "0"
    if capture:
        result = subprocess.run(
            command,
            cwd=str(cwd),
            shell=shell,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        return result.stdout.strip()
    subprocess.run(
        command, cwd=str(cwd), shell=shell, check=True, env=env
    )
    return ""


def _ensure_target_repo(manifest_path, manifest, artifact, args):
    repo = args.target_repo or artifact.get("target_repo", "")
    if repo:
        if args.target_repo and args.save_target_repo:
            if args.dry_run:
                sys.stdout.write(
                    "DRY RUN: would save target_repo %s to %s\n"
                    % (repo, manifest_path)
                )
            else:
                artifact["target_repo"] = repo
                _write_json(manifest_path, manifest)
        return repo

    if args.non_interactive:
        raise UsageError(
            "target_repo is required; pass --target-repo or set it in %s"
            % manifest_path
        )

    prompt = (
        "Target repository for %s (for example "
        "git@github.com:USER/agent-%ss.git): "
    ) % (artifact.get("name", "artifact"), artifact.get("kind", "artifact"))
    repo = input(prompt).strip()
    if not repo:
        raise UsageError("target_repo is required")
    answer = input("Save target_repo to %s? [y/N] " % manifest_path).strip()
    if answer.lower() in ("y", "yes"):
        if args.dry_run:
            sys.stdout.write(
                "DRY RUN: would save target_repo %s to %s\n"
                % (repo, manifest_path)
            )
        else:
            artifact["target_repo"] = repo
            _write_json(manifest_path, manifest)
    return repo


def _validate_checkout(value):
    supplied = Path(value).expanduser()
    if supplied.is_symlink():
        raise UsageError("--target-checkout must not be a symlink")
    checkout = supplied.resolve()
    if not checkout.is_dir():
        raise UsageError("--target-checkout must be a git checkout")
    try:
        inside = _run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            checkout,
            capture=True,
            read_only=True,
        )
        top_level = Path(
            _run(
                ["git", "rev-parse", "--show-toplevel"],
                checkout,
                capture=True,
                read_only=True,
            )
        ).resolve()
    except subprocess.CalledProcessError:
        raise UsageError("--target-checkout must be a git checkout")
    if inside != "true" or top_level != checkout:
        raise UsageError("--target-checkout must be a git checkout root")
    return checkout


def _require_clean_checkout(checkout):
    status = _run(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        checkout,
        capture=True,
        read_only=True,
    )
    if status:
        raise UsageError(
            "target checkout is not clean; preserve or remove local changes "
            "before publishing:\n%s" % status
        )


def _literal_pathspec(target_path):
    return ":(literal)%s" % target_path.as_posix()


def _require_no_ignored_destination_files(checkout, target_path):
    raw = _run(
        [
            "git", "ls-files", "--others", "--ignored",
            "--exclude-standard", "-z", "--",
            _literal_pathspec(target_path),
        ],
        checkout,
        capture=True,
        read_only=True,
    )
    ignored = [path for path in raw.split("\0") if path]
    if ignored:
        raise UsageError(
            "target_path contains ignored local files; preserve or remove "
            "them before publishing:\n%s" % "\n".join(ignored)
        )


def _prepare_checkout(target_repo, args, supplied_checkout=None):
    if supplied_checkout is not None:
        if not args.dry_run:
            return supplied_checkout, None
        temp_dir = tempfile.mkdtemp(prefix="agent-artifact-preview-")
        checkout = Path(temp_dir) / "target"
        _run(
            [
                "git",
                "clone",
                "--no-hardlinks",
                str(supplied_checkout),
                str(checkout),
            ],
            Path.cwd(),
        )
        return checkout, temp_dir

    temp_dir = tempfile.mkdtemp(prefix="agent-artifact-pr-")
    checkout = Path(temp_dir) / "target"
    # Say so: without --target-checkout even a dry run reaches the network.
    sys.stdout.write("Cloning %s (network)...\n" % target_repo)
    _run(["git", "clone", target_repo, str(checkout)], Path.cwd())
    return checkout, temp_dir


def _source_path(project_root, source_path):
    source = (project_root / source_path).resolve()
    if not _is_under(source, project_root):
        raise UsageError("unsafe source_path: %s" % source_path)
    if not source.exists():
        raise UsageError("source_path does not exist: %s" % source_path)
    return source


def _unsafe_destination_entry(path):
    if path.is_symlink():
        return path, "symlink"
    if not path.is_dir():
        return None
    for current, directories, files in os.walk(str(path), followlinks=False):
        current_path = Path(current)
        for name in directories + files:
            candidate = current_path / name
            if name.lower() == ".git":
                return candidate, "Git metadata"
            if candidate.is_symlink():
                return candidate, "symlink"
    return None


def _destination_path(checkout, target_path):
    checkout = checkout.resolve()
    destination = checkout
    for part in target_path.parts:
        destination = destination / part
        if destination.is_symlink():
            raise UsageError(
                "unsafe symlinked target_path: %s" % target_path
            )
    resolved = destination.resolve()
    if not _is_under(resolved, checkout):
        raise UsageError("unsafe target_path: %s" % target_path)
    unsafe = _unsafe_destination_entry(destination)
    if unsafe:
        unsafe_path, reason = unsafe
        raise UsageError(
            "unsafe target_path contains %s: %s" % (reason, unsafe_path)
        )
    return destination


def _copy_source(source, destination):
    if destination.exists():
        if destination.is_dir():
            shutil.rmtree(str(destination))
        else:
            destination.unlink()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(str(source), str(destination))
    else:
        shutil.copy2(str(source), str(destination))


def _branch_name(artifact):
    stamp = _datetime.datetime.now(_datetime.timezone.utc).strftime(
        "%Y%m%d%H%M%S"
    )
    raw = str(artifact.get("name", "artifact"))
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-").lower()
    return "publish/%s/%s" % (safe or "artifact", stamp)


def _git_has_changes(checkout, target_path):
    output = _run(
        ["git", "status", "--short", "--", _literal_pathspec(target_path)],
        checkout,
        capture=True,
        read_only=True,
    )
    return bool(output)


def _assert_index_scope(checkout, target_path):
    raw = _run(
        ["git", "diff", "--cached", "--name-only", "-z"],
        checkout,
        capture=True,
        read_only=True,
    )
    staged = [path for path in raw.split("\0") if path]
    expected = target_path.as_posix().rstrip("/")
    outside = [
        path for path in staged
        if path != expected and not path.startswith(expected + "/")
    ]
    if outside:
        raise UsageError(
            "refusing to commit paths outside target_path %s: %s"
            % (target_path, ", ".join(outside))
        )
    if not staged:
        raise UsageError("no staged changes for target_path %s" % target_path)


def _print_preview_diff(checkout, target_path):
    git_path = _literal_pathspec(target_path)
    summary = _run(
        ["git", "diff", "--cached", "--stat", "--", git_path],
        checkout,
        capture=True,
        read_only=True,
    )
    diff = _run(
        ["git", "diff", "--cached", "--no-ext-diff", "--", git_path],
        checkout,
        capture=True,
        read_only=True,
    )
    if diff:
        sys.stdout.write("DRY RUN: proposed artifact diff\n")
        if summary:
            sys.stdout.write(summary + "\n")
        sys.stdout.write(diff + "\n")
    else:
        sys.stdout.write("DRY RUN: no artifact changes proposed.\n")


def _source_commit(project_root):
    try:
        return _run(["git", "rev-parse", "--short", "HEAD"],
                    project_root, capture=True, read_only=True)
    except Exception:
        return "unknown"


def publish(args):
    manifest_path = Path(args.manifest).expanduser().resolve()
    project_root = manifest_path.parent
    manifest = _load_json(manifest_path)
    artifact = _select_artifact(manifest, args.artifact)
    target_repo = _ensure_target_repo(manifest_path, manifest, artifact, args)
    source_rel = _validate_rel_path(
        artifact.get("source_path"), "source_path"
    )
    target_path = _validate_rel_path(
        artifact.get("target_path"), "target_path"
    )
    supplied_checkout = None
    if args.target_checkout:
        supplied_checkout = _validate_checkout(args.target_checkout)
        _require_clean_checkout(supplied_checkout)
        _destination_path(supplied_checkout, target_path)
        _require_no_ignored_destination_files(
            supplied_checkout, target_path
        )

    build_command = artifact.get("build_command", "")

    if build_command:
        if args.dry_run and not args.build:
            # A dry run should not execute a shell command in the user's
            # project. Preview the existing source_path instead.
            sys.stdout.write(
                "DRY RUN: not running the build command (%s); "
                "pass --build to run it.\n" % build_command)
        else:
            sys.stdout.write("Running build command: %s\n" % build_command)
            _run(build_command, project_root)

    source = _source_path(project_root, source_rel)
    checkout, temp_dir = _prepare_checkout(
        target_repo, args, supplied_checkout=supplied_checkout
    )
    # Publishing into the user's own checkout switches branches; remember
    # where they were so the finally block can put them back.
    original_branch = ""
    if temp_dir is None and not args.dry_run:
        original_branch = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"],
                               checkout, capture=True, read_only=True)
    try:
        base_branch = args.base or artifact.get("base_branch", "main")
        if args.dry_run:
            _run(["git", "checkout", base_branch], checkout)
        else:
            _require_clean_checkout(checkout)
            _run(["git", "checkout", base_branch], checkout)
            _run(["git", "pull", "--ff-only", "origin", base_branch], checkout)
            _require_clean_checkout(checkout)
            branch = args.branch or _branch_name(artifact)
            _run(["git", "checkout", "-b", branch], checkout)

        destination = _destination_path(checkout, target_path)
        _require_no_ignored_destination_files(checkout, target_path)
        _copy_source(source, destination)

        if args.dry_run:
            if _git_has_changes(checkout, target_path):
                _run(
                    ["git", "add", "--", _literal_pathspec(target_path)],
                    checkout,
                )
                _assert_index_scope(checkout, target_path)
            _print_preview_diff(checkout, target_path)
            if args.keep_temp:
                sys.stdout.write("DRY RUN: preview retained at %s\n" % checkout)
            else:
                sys.stdout.write(
                    "DRY RUN: target checkout unchanged; preview was temporary.\n"
                )
            return 0

        if not _git_has_changes(checkout, target_path):
            sys.stdout.write("No changes after copy; no PR created.\n")
            return 0

        _run(
            ["git", "add", "--", _literal_pathspec(target_path)],
            checkout,
        )
        _assert_index_scope(checkout, target_path)
        title = args.pr_title or "Update %s" % artifact.get("name", "artifact")
        commit_message = args.commit_message or title
        _run(
            [
                "git", "commit", "-m", commit_message,
                "--only", "--", _literal_pathspec(target_path),
            ],
            checkout,
        )
        _run(["git", "push", "-u", "origin", branch], checkout)
        body = args.pr_body or (
            "Published from %s at %s." % (Path.cwd().name,
                                         _source_commit(project_root))
        )
        _run([
            "gh",
            "pr",
            "create",
            "--base",
            base_branch,
            "--head",
            branch,
            "--title",
            title,
            "--body",
            body,
        ], checkout)
        return 0
    finally:
        if temp_dir and not args.keep_temp:
            shutil.rmtree(temp_dir, ignore_errors=True)
        elif original_branch:
            try:
                _run(["git", "checkout", original_branch], checkout)
            except Exception as exc:          # never mask the real outcome
                sys.stdout.write(
                    "warning: could not restore branch %s in %s (%s)\n"
                    % (original_branch, checkout, exc))


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Publish an agent skill/plugin artifact as a GitHub PR."
    )
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    parser.add_argument("--artifact")
    parser.add_argument("--target-repo")
    parser.add_argument(
        "--save-target-repo",
        action="store_true",
        help=(
            "save an explicit target repo to the manifest; with --dry-run, "
            "report the proposed update without writing it"
        ),
    )
    parser.add_argument("--target-checkout")
    parser.add_argument("--base")
    parser.add_argument("--branch")
    parser.add_argument("--pr-title")
    parser.add_argument("--pr-body")
    parser.add_argument("--commit-message")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "build in the source checkout, create a temporary publication "
            "preview, and print its diff without changing the target checkout"
        ),
    )
    parser.add_argument(
        "--build", action="store_true",
        help="run the artifact's build_command even under --dry-run")
    parser.add_argument("--keep-temp", action="store_true")
    parser.add_argument("--non-interactive", action="store_true")
    args = parser.parse_args(argv)

    try:
        return publish(args)
    except UsageError as exc:
        sys.stderr.write("%s\n" % exc)
        return 2
    except subprocess.CalledProcessError as exc:
        sys.stderr.write("command failed with exit %s: %s\n" %
                         (exc.returncode, exc.cmd))
        return exc.returncode or 1


if __name__ == "__main__":
    sys.exit(main())
