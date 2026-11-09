"""Opening a pull request and following it: GitHub REST API with the app's token, or the gh CLI as a fallback."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from typing import Any, Optional

log = logging.getLogger(__name__)


class PrError(RuntimeError):
    pass


def create_pr_api(api_base: str, token: str, owner: str, repo: str, head: str, base: str,
                  title: str, body: str, draft: bool = False) -> str:
    req = urllib.request.Request(
        f"{api_base.rstrip('/')}/repos/{owner}/{repo}/pulls",
        data=json.dumps({"title": title, "head": head, "base": base, "body": body, "draft": draft}).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json", "User-Agent": "aiembodied-coding-runner",
                 "X-GitHub-Api-Version": "2022-11-28"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())["html_url"]
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise PrError(f"GitHub answered {e.code}: {detail}") from e
    except (urllib.error.URLError, OSError, KeyError, ValueError) as e:
        raise PrError(f"could not open the pull request: {e}") from e


def gh_available() -> bool:
    return shutil.which("gh") is not None


def create_pr_gh(cwd, head: str, base: str, title: str, body: str, draft: bool = False) -> str:
    args = [shutil.which("gh") or "gh", "pr", "create", "--head", head, "--base", base, "--title", title, "--body", body]
    if draft:
        args.append("--draft")
    try:
        r = subprocess.run(args, cwd=str(cwd), capture_output=True, text=True, timeout=60, env=dict(os.environ))
    except (OSError, subprocess.TimeoutExpired) as e:
        raise PrError(f"gh failed: {e}") from e
    if r.returncode != 0:
        raise PrError(f"gh pr create failed: {(r.stderr or r.stdout).strip()[:500]}")
    urls = [l for l in r.stdout.split() if l.startswith("http")]
    if not urls:
        raise PrError("gh pr create printed no URL")
    return urls[-1]


# ---- following a pull request ----------------------------------------------------------------

BAD_CONCLUSIONS = ("failure", "timed_out", "action_required", "startup_failure")
IGNORED_CONCLUSIONS = ("cancelled", "skipped", "neutral", "stale")
PR_READ_FAILED = "could not read the pull request from GitHub"


def parse_pr_url(url: Optional[str]) -> Optional[tuple[str, str, int]]:
    """(owner, repo, number) from https://github.com/owner/repo/pull/N, else None."""
    m = re.match(r"^https?://github\.com/([^/\s]+)/([^/\s]+)/pull/(\d+)", (url or "").strip())
    return (m.group(1), m.group(2), int(m.group(3))) if m else None


def http_get_json(api_base: str, token: str, path: str) -> Any:
    """GET one GitHub API path with the token. Raises PrError with a fixed message (details are logged)."""
    req = urllib.request.Request(
        f"{api_base.rstrip('/')}{path}", method="GET",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "User-Agent": "aiembodied-coding-runner", "X-GitHub-Api-Version": "2022-11-28"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        log.warning("GitHub answered %s for GET %s", e.code, path)
    except (urllib.error.URLError, OSError, ValueError):
        log.warning("GitHub request failed for GET %s", path, exc_info=True)
    raise PrError(PR_READ_FAILED)


def gh_get_json(path: str) -> Any:
    """GET one GitHub API path through the gh CLI (its own login). Raises PrError with a fixed message."""
    try:
        r = subprocess.run([shutil.which("gh") or "gh", "api", path], capture_output=True, text=True, timeout=60,
                           env=dict(os.environ))
        if r.returncode == 0:
            return json.loads(r.stdout)
        log.warning("gh api %s failed with exit code %s", path, r.returncode)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        log.warning("gh api %s failed", path, exc_info=True)
    raise PrError(PR_READ_FAILED)


def get_json(api_base: str, token: Optional[str], path: str) -> Any:
    """The one place that talks to GitHub for reads: the token when there is one, else gh."""
    return http_get_json(api_base, token, path) if token else gh_get_json(path)


def ci_state(check_runs: list[dict], statuses: list[dict]) -> Optional[str]:
    """failure, pending, success or None (no checks). Cancelled, skipped and neutral runs are ignored."""
    states = []
    for c in check_runs:
        if c.get("status") != "completed":
            states.append("pending")
        elif c.get("conclusion") in BAD_CONCLUSIONS:
            states.append("failure")
        elif c.get("conclusion") not in IGNORED_CONCLUSIONS:
            states.append("success")
    for s in statuses:
        states.append({"success": "success", "pending": "pending"}.get(s.get("state"), "failure"))
    for wanted in ("failure", "pending", "success"):
        if wanted in states:
            return wanted
    return None


def read_pr(api_base: str, token: Optional[str], owner: str, repo: str, number: int) -> dict:
    """Where a pull request stands: {"pr_state": open|merged|closed, "merged_at", "ci_state"}."""
    pr = get_json(api_base, token, f"/repos/{owner}/{repo}/pulls/{number}")
    if not isinstance(pr, dict):
        raise PrError(PR_READ_FAILED)
    merged = bool(pr.get("merged") or pr.get("merged_at"))
    state = "merged" if merged else ("open" if pr.get("state") == "open" else "closed")
    sha = (pr.get("head") or {}).get("sha")
    ci = None
    if sha:
        runs = get_json(api_base, token, f"/repos/{owner}/{repo}/commits/{sha}/check-runs?per_page=100")
        combined = get_json(api_base, token, f"/repos/{owner}/{repo}/commits/{sha}/status")
        ci = ci_state((runs or {}).get("check_runs") or [], (combined or {}).get("statuses") or [])
    return {"pr_state": state, "merged_at": pr.get("merged_at") if merged else None, "ci_state": ci}
