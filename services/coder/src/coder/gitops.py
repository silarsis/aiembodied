"""Git operations, all through the git command line with argument lists."""

from __future__ import annotations

import fnmatch
import os
import re
import subprocess
from pathlib import Path
from typing import Optional


class GitError(RuntimeError):
    pass


def git(*args: str, cwd: Optional[Path | str] = None, check: bool = True, timeout: float = 120) -> subprocess.CompletedProcess:
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    try:
        r = subprocess.run(
            ["git", *args], cwd=str(cwd) if cwd else None, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout, env=env,
        )
    except subprocess.TimeoutExpired as e:
        raise GitError(f"git {' '.join(args[:2])} timed out") from e
    except FileNotFoundError as e:
        raise GitError("git is not installed or not on PATH") from e
    if check and r.returncode != 0:
        raise GitError((r.stderr or r.stdout).strip() or f"git {args[0]} failed")
    return r


def is_git_repo(path: Path | str) -> bool:
    p = Path(path)
    if not p.is_dir():
        return False
    try:
        return git("rev-parse", "--git-dir", cwd=p, check=False).returncode == 0
    except GitError:
        return False


def remote_url(repo: Path | str, remote: str) -> Optional[str]:
    r = git("remote", "get-url", remote, cwd=repo, check=False)
    return r.stdout.strip() or None if r.returncode == 0 else None


def parse_owner_repo(url: Optional[str]) -> Optional[tuple[str, str]]:
    """github.com owner and repo from an https, ssh:// or scp-style remote URL."""
    if not url:
        return None
    m = re.match(r"^(?:https?://(?:[^@/]+@)?|ssh://(?:[^@/]+@)?|git@)github\.com[:/](?:\d+/)?([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", url.strip())
    return (m.group(1), m.group(2)) if m else None


def rev_exists(repo: Path | str, ref: str) -> bool:
    return git("rev-parse", "--verify", "--quiet", ref + "^{commit}", cwd=repo, check=False).returncode == 0


def head(repo: Path | str) -> str:
    return git("rev-parse", "HEAD", cwd=repo).stdout.strip()


def is_dirty(repo: Path | str) -> bool:
    return bool(git("status", "--porcelain", cwd=repo, check=False).stdout.strip())


def create_worktree(repo: Path, remote: str, base: str, branch: str, path: Path) -> tuple[str, str]:
    """Fetch the base (best effort) and add a worktree on a new branch. Returns (start ref, base commit)."""
    fetch = git("fetch", remote, base, cwd=repo, check=False, timeout=120)
    start = f"{remote}/{base}"
    if fetch.returncode != 0 or not rev_exists(repo, start):
        start = base
    if not rev_exists(repo, start):
        raise GitError(f"base branch {base!r} not found in {repo}")
    path.parent.mkdir(parents=True, exist_ok=True)
    git("worktree", "add", "--no-track", "-b", branch, str(path), start, cwd=repo)
    return start, head(path)


def remove_worktree(repo: Path, path: Path, branch: Optional[str] = None) -> None:
    git("worktree", "remove", "--force", str(path), cwd=repo, check=False)
    if path.exists():
        import shutil
        shutil.rmtree(path, ignore_errors=True)
    git("worktree", "prune", cwd=repo, check=False)
    if branch:
        git("branch", "-D", branch, cwd=repo, check=False)


def commit_all(worktree: Path, message: str) -> None:
    git("add", "-A", cwd=worktree)
    if not git("status", "--porcelain", cwd=worktree).stdout.strip():
        return
    ident = []
    if not git("config", "user.email", cwd=worktree, check=False).stdout.strip():
        ident = ["-c", "user.name=Echo", "-c", "user.email=echo@localhost"]
    git(*ident, "commit", "--no-verify", "-m", message, cwd=worktree)


def numstat(worktree: Path, base: str) -> list[dict]:
    out = git("-c", "core.quotepath=false", "diff", "--numstat", "--no-renames", f"{base}..HEAD", cwd=worktree).stdout
    files = []
    for line in out.splitlines():
        a, d, p = (line.split("\t", 2) + ["", "", ""])[:3]
        files.append({"path": p, "added": int(a) if a.isdigit() else 0, "deleted": int(d) if d.isdigit() else 0,
                      "binary": a == "-"})
    return files


def deleted_files(worktree: Path, base: str) -> set[str]:
    out = git("-c", "core.quotepath=false", "diff", "--name-status", "--no-renames", f"{base}..HEAD", cwd=worktree).stdout
    return {l.split("\t", 1)[1] for l in out.splitlines() if l.startswith("D\t")}


def matches_protected(path: str, patterns: list[str]) -> bool:
    p = path.replace("\\", "/")
    p = p[2:] if p.startswith("./") else p
    for pat in patterns:
        pat = pat.replace("\\", "/")
        pat = pat[2:] if pat.startswith("./") else pat
        if not pat:
            continue
        if any(c in pat for c in "*?["):
            if fnmatch.fnmatch(p, pat) or fnmatch.fnmatch(p, pat.rstrip("/") + "/*"):
                return True
        elif p.startswith(pat):
            return True
    return False


def diff_text(repo: Path, worktree: Optional[Path], base: str, branch: str, cap: int = 500_000) -> Optional[str]:
    if worktree and worktree.is_dir():
        r = git("diff", base, cwd=worktree, check=False)
    elif rev_exists(repo, branch):
        r = git("diff", f"{base}..{branch}", cwd=repo, check=False)
    else:
        return None
    text = r.stdout
    if len(text) > cap:
        text = text[:cap] + "\n... diff truncated ...\n"
    return text
