"""The list of repositories the app lets the runner work in (workspaces.json)."""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field

from . import gitops

SELF_PROTECTED = [
    "services/coder/",
    "app/main/src/coding/",
    "app/main/src/tools/tool-registry.ts",
    "app/main/src/crash-guard.ts",
]
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class ModelRef(BaseModel):
    provider: Literal["openai", "anthropic", "local"]
    id: str = Field(min_length=1)


class Workspace(BaseModel):
    id: str
    name: str = ""
    path: str
    kind: Literal["project", "self"] = "project"
    base_branch: str = "main"
    checks: Optional[str] = None
    protected_paths: Optional[list[str]] = None
    model: Optional[ModelRef] = None
    time_limit_min: Optional[float] = Field(default=None, gt=0)


class WorkspaceError(ValueError):
    pass


def normalise(ws: Workspace) -> Workspace:
    if not ID_RE.match(ws.id):
        raise WorkspaceError(f"workspace id {ws.id!r} must be a lowercase slug (a-z, 0-9, - and _)")
    p = Path(ws.path).expanduser()
    if not p.is_absolute() or not gitops.is_git_repo(p):
        raise WorkspaceError(f"{ws.path!r} is not an absolute path to a git repository")
    ws = ws.model_copy(update={"path": str(p.resolve()), "name": ws.name or ws.id})
    if ws.protected_paths is None:
        ws.protected_paths = list(SELF_PROTECTED) if ws.kind == "self" else []
    if ws.checks is not None and not ws.checks.strip():
        ws.checks = None
    return ws


class WorkspaceRegistry:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._items: list[Workspace] = []
        if path.exists():
            try:
                self._items = [Workspace(**w) for w in json.loads(path.read_text(encoding="utf-8"))]
            except Exception:
                self._items = []

    def all(self) -> list[Workspace]:
        with self._lock:
            return list(self._items)

    def get(self, wid: str) -> Optional[Workspace]:
        return next((w for w in self.all() if w.id == wid), None)

    def replace(self, items: list[Workspace]) -> list[Workspace]:
        seen = set()
        out = []
        for w in items:
            w = normalise(w)
            if w.id in seen:
                raise WorkspaceError(f"duplicate workspace id {w.id!r}")
            seen.add(w.id)
            out.append(w)
        with self._lock:
            self._items = out
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps([w.model_dump() for w in out], indent=2), encoding="utf-8")
            os.replace(tmp, self.path)
        return out
