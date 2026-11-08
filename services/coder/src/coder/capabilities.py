"""What the runner can do: pi's version and models, what each workspace looks like, and a track record."""

from __future__ import annotations

import json
import statistics
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from . import gitops
from .config import Config
from .procs import clean_env
from .rpc import PiProcess
from .store import Store
from .workspaces import Workspace

CACHE_S = 600


class PiProbe:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._lock = threading.Lock()
        self._version: Optional[tuple[float, Optional[str], Optional[str]]] = None
        self._models: Optional[tuple[float, dict]] = None

    def found(self) -> bool:
        import shutil
        return shutil.which(self.cfg.pi_argv()[0]) is not None or Path(self.cfg.pi_argv()[0]).exists()

    def version(self, refresh: bool = False) -> tuple[Optional[str], Optional[str]]:
        """(version, error)"""
        with self._lock:
            if self._version and not refresh and time.time() - self._version[0] < CACHE_S:
                return self._version[1], self._version[2]
        try:
            r = subprocess.run(self.cfg.pi_argv() + ["--version"], capture_output=True, text=True, timeout=15,
                               encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL)
            out = (r.stdout.strip() or r.stderr.strip()).splitlines()
            v, err = (out[-1] if out else None), (None if r.returncode == 0 else f"exit code {r.returncode}")
        except (OSError, subprocess.TimeoutExpired) as e:
            v, err = None, str(e)
        with self._lock:
            self._version = (time.time(), v, err)
        return v, err

    def models(self, refresh: bool = False) -> dict:
        with self._lock:
            if self._models and not refresh and time.time() - self._models[0] < CACHE_S:
                return self._models[1]
        result = self._probe()
        with self._lock:
            self._models = (time.time(), result)
        return result

    def _probe(self) -> dict:
        got: dict[str, dict] = {}
        done = threading.Event()

        def on_event(ev: dict) -> None:
            if ev.get("type") == "response" and ev.get("id") in ("probe-models", "probe-commands"):
                got[ev["id"]] = ev
                if len(got) == 2:
                    done.set()

        self.cfg.data_dir.mkdir(parents=True, exist_ok=True)
        pi = PiProcess(self.cfg.pi_argv() + ["--mode", "rpc", "--no-session"], self.cfg.data_dir,
                       clean_env(extra={"PI_CODING_AGENT_DIR": str(self.cfg.agent_dir)}), on_event, lambda s, l: None)
        try:
            pi.start()
            pi.send({"id": "probe-models", "type": "get_available_models"})
            pi.send({"id": "probe-commands", "type": "get_commands"})
            if not done.wait(self.cfg.probe_timeout_s):
                return {"models": [], "commands": [], "error": "timed out waiting for pi"}
        except OSError as e:
            return {"models": [], "commands": [], "error": str(e)}
        finally:
            pi.kill()
        m, c = got["probe-models"], got["probe-commands"]
        err = None if m.get("success") else str(m.get("error") or "get_available_models failed")
        return {"models": (m.get("data") or {}).get("models", []) if m.get("success") else [],
                "commands": (c.get("data") or {}).get("commands", []) if c.get("success") else [], "error": err}


def detect(ws: Workspace, remote: str) -> dict:
    p = Path(ws.path)
    manager: Optional[str] = None
    suggestion: Optional[str] = None
    pkg = p / "package.json"
    if pkg.is_file():
        manager = "pnpm" if (p / "pnpm-lock.yaml").exists() else "yarn" if (p / "yarn.lock").exists() else "npm"
        try:
            scripts = json.loads(pkg.read_text(encoding="utf-8")).get("scripts", {}) or {}
        except (OSError, ValueError):
            scripts = {}
        w = " -w" if manager == "pnpm" and (p / "pnpm-workspace.yaml").exists() else ""
        run = {"pnpm": f"pnpm{w}", "yarn": "yarn", "npm": "npm run"}[manager]
        steps = [f"{run} {s}" for s in ("typecheck", "lint") if s in scripts]
        if "test" in scripts:
            steps.append({"pnpm": "pnpm test", "yarn": "yarn test", "npm": "npm test"}[manager])
        suggestion = " && ".join(steps) or None
    elif (p / "pyproject.toml").is_file() or (p / "requirements.txt").is_file():
        manager, suggestion = "python", "pytest"
    return {
        "package_manager": manager,
        "checks_suggestion": suggestion,
        "has_agents_md": (p / "AGENTS.md").is_file(),
        "has_claude_md": (p / "CLAUDE.md").is_file(),
        "remote_url": gitops.remote_url(p, remote),
        "base_branch": ws.base_branch,
        "dirty": gitops.is_dirty(p),
    }


def _minutes(t: dict) -> Optional[float]:
    if not (t["started_at"] and t["finished_at"]):
        return None
    try:
        return (datetime.fromisoformat(t["finished_at"]) - datetime.fromisoformat(t["started_at"])).total_seconds() / 60
    except ValueError:
        return None


def track_record(store: Store) -> list[dict]:
    groups: dict[tuple, list[dict]] = {}
    for t in store.list_tasks():
        groups.setdefault((t["workspace_id"], t["provider"], t["model"]), []).append(t)
    out = []
    for (wid, provider, model), tasks in sorted(groups.items(), key=lambda kv: tuple(str(x) for x in kv[0])):
        checked = [t for t in tasks if t["checks_ok"] is not None]
        mins = [m for m in (_minutes(t) for t in tasks if t["status"] in ("done", "failed", "cancelled")) if m is not None]
        out.append({
            "workspace_id": wid, "provider": provider, "model": model,
            "started": sum(1 for t in tasks if t["started_at"]),
            "done": sum(1 for t in tasks if t["status"] == "done"),
            "failed": sum(1 for t in tasks if t["status"] == "failed"),
            "cancelled": sum(1 for t in tasks if t["status"] == "cancelled"),
            "discarded": sum(1 for t in tasks if t["status"] == "discarded"),
            "with_pr": sum(1 for t in tasks if t["pr_url"]),
            "checks_pass_rate": (sum(1 for t in checked if t["checks_ok"]) / len(checked)) if checked else None,
            "median_minutes": round(statistics.median(mins), 2) if mins else None,
        })
    return out


def capabilities(cfg: Config, probe: PiProbe, store: Store, workspaces: list[Workspace], refresh: bool = False) -> dict:
    version, verr = probe.version(refresh)
    models = probe.models(refresh)
    backend: dict[str, Any] = {"name": "pi", "version": version, **models}
    if verr and not version:
        backend["error"] = backend.get("error") or verr
    return {
        "backend": backend,
        "workspaces": [{"id": w.id, "kind": w.kind, "detected": detect(w, cfg.git_remote)} for w in workspaces],
        "track_record": track_record(store),
    }
