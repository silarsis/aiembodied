"""Settings, read from CODER_* environment variables."""

from __future__ import annotations

import os
import shlex
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Optional


def default_data_dir(env: Mapping[str, str]) -> Path:
    if os.name == "nt":
        base = env.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "aiembodied" / "coder"
    return Path.home() / ".local" / "share" / "aiembodied" / "coder"


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 8195
    data_dir: Path = field(default_factory=lambda: default_data_dir(os.environ))
    pi_command: str = "pi"
    max_tasks: int = 1
    time_limit_min: float = 60
    local_llm_url: str = "http://127.0.0.1:1236/v1"
    local_model: str = "qwen3-coder-next"
    git_remote: str = "origin"
    # Tuning knobs (mostly for tests).
    cancel_grace_s: float = 5.0
    settle_s: float = 3.0
    checks_timeout_s: float = 20 * 60
    probe_timeout_s: float = 20.0
    github_api: str = "https://api.github.com"

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "Config":
        env = os.environ if env is None else env
        c = cls()
        c.host = env.get("CODER_HOST", c.host)
        c.port = int(env.get("CODER_PORT", c.port))
        c.data_dir = Path(env["CODER_DATA_DIR"]) if env.get("CODER_DATA_DIR") else default_data_dir(env)
        c.pi_command = env.get("CODER_PI_COMMAND", c.pi_command)
        c.max_tasks = max(1, int(env.get("CODER_MAX_TASKS", c.max_tasks)))
        c.time_limit_min = float(env.get("CODER_TIME_LIMIT_MIN", c.time_limit_min))
        c.local_llm_url = env.get("CODER_LOCAL_LLM_URL", c.local_llm_url)
        c.local_model = env.get("CODER_LOCAL_MODEL", c.local_model)
        c.git_remote = env.get("CODER_GIT_REMOTE", c.git_remote)
        c.cancel_grace_s = float(env.get("CODER_CANCEL_GRACE_S", c.cancel_grace_s))
        c.settle_s = float(env.get("CODER_SETTLE_S", c.settle_s))
        c.github_api = env.get("CODER_GITHUB_API", c.github_api)
        return c

    @property
    def db_path(self) -> Path:
        return self.data_dir / "coder.sqlite"

    @property
    def workspaces_path(self) -> Path:
        return self.data_dir / "workspaces.json"

    @property
    def agent_dir(self) -> Path:
        return self.data_dir / "pi-agent"

    @property
    def worktrees_dir(self) -> Path:
        return self.data_dir / "worktrees"

    @property
    def sessions_dir(self) -> Path:
        return self.data_dir / "sessions"

    def pi_argv(self) -> list[str]:
        """CODER_PI_COMMAND split into an argument list; the program is resolved with PATH (pi.cmd on Windows)."""
        tokens = shlex.split(self.pi_command, posix=os.name != "nt")
        if os.name == "nt":
            tokens = [t[1:-1] if len(t) > 1 and t[0] == t[-1] and t[0] in "\"'" else t for t in tokens]
        if not tokens:
            tokens = ["pi"]
        tokens[0] = shutil.which(tokens[0]) or tokens[0]
        return tokens
