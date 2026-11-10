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
    # Context size (tokens) the local llama-server runs with; pi is told the same number.
    local_context: int = 65536
    git_remote: str = "origin"
    # Default model for tasks that name none. Empty id with provider "local" means local_model.
    default_provider: str = "local"
    default_model_id: str = ""
    # How long a task waits for the local model server, and how often it asks.
    local_wait_s: float = 900.0
    local_poll_s: float = 3.0
    # How often open pull requests are looked at, in seconds (0 turns it off).
    pr_poll_seconds: float = 300.0
    # Tuning knobs (mostly for tests).
    cancel_grace_s: float = 5.0
    settle_s: float = 3.0
    checks_timeout_s: float = 20 * 60
    # Installing dependencies in a fresh worktree can be slow (pnpm install on Windows), so it has its own limit.
    setup_timeout_s: float = 15 * 60
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
        c.local_context = max(1, int(env.get("CODER_LOCAL_CONTEXT", c.local_context)))
        c.setup_timeout_s = float(env.get("CODER_SETUP_TIMEOUT_S", c.setup_timeout_s))
        c.git_remote = env.get("CODER_GIT_REMOTE", c.git_remote)
        c.local_wait_s = float(env.get("CODER_LOCAL_WAIT_S", c.local_wait_s))
        c.local_poll_s = float(env.get("CODER_LOCAL_POLL_S", c.local_poll_s))
        c.cancel_grace_s = float(env.get("CODER_CANCEL_GRACE_S", c.cancel_grace_s))
        c.settle_s = float(env.get("CODER_SETTLE_S", c.settle_s))
        c.pr_poll_seconds = float(env.get("CODER_PR_POLL_S", c.pr_poll_seconds))
        c.github_api = env.get("CODER_GITHUB_API", c.github_api)
        return c

    @property
    def db_path(self) -> Path:
        return self.data_dir / "coder.sqlite"

    @property
    def workspaces_path(self) -> Path:
        return self.data_dir / "workspaces.json"

    @property
    def settings_path(self) -> Path:
        return self.data_dir / "settings.json"

    @property
    def default_model(self) -> dict:
        if self.default_model_id:
            return {"provider": self.default_provider, "id": self.default_model_id}
        return {"provider": "local", "id": self.local_model}

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
