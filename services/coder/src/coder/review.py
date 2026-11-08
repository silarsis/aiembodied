"""The review a person sees before approving a task: what changed and what looks risky."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from . import gitops

LOCKFILES = {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "uv.lock", "Cargo.lock",
             "Pipfile.lock", "bun.lockb", "composer.lock", "Gemfile.lock", "go.sum"}
TEST_DIR = re.compile(r"(^|/)(tests?|__tests__|spec|specs)/", re.I)
MAX_LINES = 1000


def build_review(worktree: Path, base_commit: str, protected: list[str]) -> dict:
    files = gitops.numstat(worktree, base_commit)
    deleted = gitops.deleted_files(worktree, base_commit)
    added = sum(f["added"] for f in files)
    removed = sum(f["deleted"] for f in files)
    paths = [f["path"] for f in files]
    violations = [p for p in paths if gitops.matches_protected(p, protected)]
    flags: list[str] = []
    for p in sorted(deleted):
        name = p.rsplit("/", 1)[-1]
        if TEST_DIR.search(p) or "test" in name.lower():
            flags.append(f"deleted test file: {p}")
    flags += [f"env file changed: {p}" for p in paths if p.rsplit("/", 1)[-1].startswith(".env")]
    flags += [f"lockfile changed: {p}" for p in paths if p.rsplit("/", 1)[-1] in LOCKFILES]
    if added + removed > MAX_LINES:
        flags.append(f"large change: {added + removed} lines (over {MAX_LINES})")
    if violations:
        flags.append("protected paths changed: " + ", ".join(violations))
    return {
        "no_changes": not files,
        "summary": f"{len(files)} file(s) changed, +{added} -{removed}",
        "files": files,
        "changed_files": paths,
        "added": added,
        "deleted": removed,
        "changed_lines": added + removed,
        "protected_violations": violations,
        "flags": flags,
    }


def no_changes_review() -> dict:
    return {"no_changes": True, "summary": "No changes were made.", "files": [], "changed_files": [], "added": 0,
            "deleted": 0, "changed_lines": 0, "protected_violations": [], "flags": []}
