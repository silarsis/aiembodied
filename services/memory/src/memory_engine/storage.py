"""Where the engine keeps memory: this machine's database (the container scripts/start.ps1 runs,
or MEMORY_DATABASE_URL) or another PostgreSQL such as a Supabase project, and optionally a
mirror that gets a copy of everything. The choice is made in the client (aiembodied's Models and
servers pop-up) and saved here, in a small JSON file beside the local database's password, so
the engine starts on the same database next time even before the client is running."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit


@dataclass
class StorageSettings:
    """None means "this machine's database" for `database`, and "no mirror" for `mirror`."""

    database: Optional[str] = None
    mirror: Optional[str] = None


def default_settings_file() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return Path(base) / "aiembodied" / "memory" / "engine-settings.json"


def load(path: Optional[Path]) -> StorageSettings:
    if path is None or not path.exists():
        return StorageSettings()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return StorageSettings()
    return StorageSettings(database=_url_or_none(data.get("database")), mirror=_url_or_none(data.get("mirror")))


def save(path: Optional[Path], settings: StorageSettings) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(asdict(settings), indent=2), encoding="utf-8")
    try:
        os.chmod(temporary, 0o600)  # it holds passwords; a no-op on Windows
    except OSError:
        pass
    temporary.replace(path)


def valid_url(url: Optional[str]) -> bool:
    if not url:
        return False
    parts = urlsplit(url)
    return parts.scheme in ("postgres", "postgresql") and bool(parts.hostname)


def _url_or_none(value: object) -> Optional[str]:
    return value if isinstance(value, str) and valid_url(value) else None


def describe(url: Optional[str]) -> Optional[str]:
    """host:port/database, for showing where memory is without the user or password."""
    if not url:
        return None
    parts = urlsplit(url)
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.hostname}{port}{parts.path or ''}"
