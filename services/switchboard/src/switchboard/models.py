"""The event envelope (see ../../API.md) and the service settings."""

from __future__ import annotations

import os
import re
import socket
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

PRODUCER_KINDS = ("avatar", "person", "tool", "service", "sensor", "device", "remote")
ADDRESS_KINDS = PRODUCER_KINDS + ("scene", "cap")
CLOSED_STATES = ("done", "failed", "cancelled", "expired")
MAX_PAYLOAD_BYTES = 64 * 1024

TYPE_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$")
ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$", re.I)

TxnState = Literal["open", "accepted", "waiting", "progress", "done", "failed", "cancelled", "expired"]


def format_time(d: datetime) -> str:
    d = d.astimezone(timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def now_iso() -> str:
    return format_time(datetime.now(timezone.utc))


def parse_time(value: str) -> str:
    """Any ISO-8601 time -> UTC with milliseconds and Z (so times compare as strings). No zone means UTC."""
    try:
        d = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"not an ISO-8601 time: {value!r}") from None
    return format_time(d if d.tzinfo else d.replace(tzinfo=timezone.utc))


class Producer(BaseModel):
    kind: Literal["avatar", "person", "tool", "service", "sensor", "device", "remote"]
    id: str = Field(min_length=1, max_length=200)
    node: Optional[str] = None

    @property
    def address(self) -> str:
        return f"{self.kind}:{self.id}"


class Txn(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    parent: Optional[str] = None
    root: Optional[str] = None
    cause: Optional[str] = None
    state: Optional[TxnState] = None
    title: Optional[str] = None
    deadline: Optional[str] = None

    @field_validator("deadline")
    @classmethod
    def _deadline(cls, v: Optional[str]) -> Optional[str]:
        return parse_time(v) if v else None


class Event(BaseModel):
    id: Optional[str] = None
    type: str
    v: int = 1
    at: Optional[str] = None
    producer: Producer
    to: list[str] = Field(default_factory=list)
    scene: Optional[str] = None
    txn: Optional[Txn] = None
    audience: Literal["private", "household", "shareable"] = "household"
    priority: Literal["low", "normal", "high", "urgent"] = "normal"
    expires: Optional[str] = None
    payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator("id")
    @classmethod
    def _id(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not ULID_RE.match(v):
            raise ValueError("id must be a 26 character ULID")
        return v.upper() if v else None

    @field_validator("type")
    @classmethod
    def _type(cls, v: str) -> str:
        if not TYPE_RE.match(v):
            raise ValueError("type must be dotted lower-case, e.g. task.status")
        return v

    @field_validator("at", "expires")
    @classmethod
    def _time(cls, v: Optional[str]) -> Optional[str]:
        return parse_time(v) if v else None

    @field_validator("to")
    @classmethod
    def _to(cls, v: list[str]) -> list[str]:
        for a in v:
            kind, _, ident = a.partition(":")
            if kind not in ADDRESS_KINDS or not ident:
                raise ValueError(f"bad address {a!r}: expected <kind>:<id> with kind one of {', '.join(ADDRESS_KINDS)}")
        return v


def default_db_path() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "aiembodied" / "switchboard" / "switchboard.db"
    return Path.home() / ".local" / "share" / "aiembodied" / "switchboard" / "switchboard.db"


@dataclass
class Config:
    db_path: Path
    retention_days: int = 30
    node: str = field(default_factory=socket.gethostname)

    @classmethod
    def from_env(cls) -> "Config":
        env = os.environ
        return cls(db_path=Path(env.get("SWITCHBOARD_DB") or default_db_path()),
                   retention_days=int(env.get("SWITCHBOARD_RETENTION_DAYS") or 30),
                   node=env.get("SWITCHBOARD_NODE") or socket.gethostname())
