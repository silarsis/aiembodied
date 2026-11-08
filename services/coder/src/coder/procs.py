"""Child process helpers: environment stripping and killing a whole process tree."""

from __future__ import annotations

import os
import signal
import subprocess
from typing import Mapping, Optional


def is_secret_name(name: str) -> bool:
    n = name.upper()
    return n in ("GITHUB_TOKEN", "GH_TOKEN") or n.startswith("HA_") or n.endswith(("_API_KEY", "_TOKEN", "_SECRET"))


def clean_env(base: Optional[Mapping[str, str]] = None, extra: Optional[Mapping[str, str]] = None) -> dict[str, str]:
    """The environment for pi and checks: no tokens, keys or Home Assistant settings; plus `extra`."""
    env = {k: v for k, v in (os.environ if base is None else base).items() if not is_secret_name(k)}
    env.update(extra or {})
    return env


def popen_flags() -> dict:
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
    return {"start_new_session": True}


def kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, timeout=10)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except Exception:
        pass
    try:
        proc.kill()
    except Exception:
        pass
