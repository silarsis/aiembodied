"""Settings, read from environment variables (all optional)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_PORT = 8198
TASK_QUEUE = "agents"
THINK_QUEUE = "think"
NAMESPACE = "aiembodied"
HOST_AVATAR = "echo"


def _flag(value: str | None, default: bool) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() not in ("0", "false", "no", "off")


def _number(value: str | None, default: float) -> float:
    try:
        return float(value) if value not in (None, "") else default
    except ValueError:
        return default


def default_log_file(env: dict[str, str] | None = None) -> str:
    """`%LOCALAPPDATA%\\aiembodied\\workflows\\workflows.log`, else `~/.local/share/aiembodied/workflows/workflows.log`."""
    env = os.environ if env is None else env
    local = env.get("LOCALAPPDATA")
    base = Path(local) / "aiembodied" if local else Path.home() / ".local" / "share" / "aiembodied"
    return str(base / "workflows" / "workflows.log")


@dataclass(frozen=True)
class Settings:
    temporal_address: str = "127.0.0.1:7233"
    namespace: str = NAMESPACE
    memory_url: str = "http://127.0.0.1:8194"
    memory_token: str | None = None
    switchboard_url: str = "http://127.0.0.1:8196"
    searxng_url: str = "http://127.0.0.1:8888"
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    api_token: str | None = None
    agent_life: bool = True
    sleep_after_hours: float = 24.0
    sleep_hours: float = 7.0
    timezone: str | None = None
    log_level: str = "INFO"
    log_file: str | None = field(default=None)
    quiet_hours: str = "22-7"

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Settings:
        e = dict(os.environ if env is None else env)
        log_file = e.get("WORKFLOWS_LOG_FILE")
        if log_file is None or log_file.strip() == "":
            log_file = default_log_file(e)
        elif log_file.strip().lower() == "off":
            log_file = None
        return cls(
            temporal_address=e.get("TEMPORAL_ADDRESS") or "127.0.0.1:7233",
            namespace=e.get("TEMPORAL_NAMESPACE") or NAMESPACE,
            memory_url=(e.get("MEMORY_SERVICE_URL") or "http://127.0.0.1:8194").rstrip("/"),
            memory_token=e.get("MEMORY_API_TOKEN") or None,
            switchboard_url=(e.get("SWITCHBOARD_URL") or "http://127.0.0.1:8196").rstrip("/"),
            searxng_url=(e.get("SEARXNG_URL") or "http://127.0.0.1:8888").rstrip("/"),
            host=e.get("WORKFLOWS_HOST") or "127.0.0.1",
            port=int(_number(e.get("WORKFLOWS_PORT"), DEFAULT_PORT)),
            api_token=e.get("WORKFLOWS_API_TOKEN") or None,
            agent_life=_flag(e.get("AGENT_LIFE"), True),
            sleep_after_hours=_number(e.get("SLEEP_AFTER_HOURS"), 24.0),
            sleep_hours=_number(e.get("SLEEP_HOURS"), 7.0),
            timezone=e.get("WORKFLOWS_TIMEZONE") or e.get("MEMORY_TIMEZONE") or None,
            log_level=(e.get("WORKFLOWS_LOG_LEVEL") or "INFO").upper(),
            log_file=log_file,
            quiet_hours=e.get("QUIET_HOURS") or "22-7",
        )

    def flow_config(self) -> dict:
        """The settings a workflow needs, passed in as input so replays never read the environment."""
        return {
            "sleepAfterHours": self.sleep_after_hours,
            "sleepHours": self.sleep_hours,
            "timezone": self.timezone,
            "quietHours": self.quiet_hours,
        }
