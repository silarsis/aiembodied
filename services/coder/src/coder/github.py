"""Opening a pull request: GitHub REST API with the app's token, or the gh CLI as a fallback."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import urllib.error
import urllib.request
from typing import Optional


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
