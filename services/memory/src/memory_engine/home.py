"""Home Assistant: a listener that keeps what the house did.

It connects to Home Assistant's WebSocket API, learns which entities to watch (those carrying a
label, plus any named in HA_ENTITIES), and records their changes: doors and alerts as events that
are also indexed for search, numbers as readings with a deadband and an hourly rollup. Everything
is flagged source = 'home_assistant' and stays out of the brief, auto-recall, summaries and fact
extraction; it is reached through the /v1/home routes and `/v1/search?source=`.

The access token is only ever held in memory and sent to Home Assistant; it is never logged or
stored.
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Mapping, Optional, Sequence
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import psycopg
from psycopg.types.json import Jsonb

if TYPE_CHECKING:
    from .app import Engine

log = logging.getLogger("memory_engine.home")

SOURCE = "home_assistant"
INDEX_KIND = "ha_event"

BACKOFF_MIN = 2.0
BACKOFF_MAX = 300.0
AUTH_REFUSED_WAIT = 300.0
REFRESH_SECONDS = 600.0
PRUNE_SECONDS = 3600.0
# A numeric entity that has not been kept for this long is kept at its next value.
KEEP_EVERY = timedelta(minutes=15)

ALERT_DEVICE_CLASSES = {"smoke", "gas", "carbon_monoxide", "moisture", "safety", "problem", "tamper", "heat", "cold"}
NUMERIC_DOMAINS = {"sensor", "number", "input_number"}
NO_VALUE = {"unavailable", "unknown"}


# --- configuration and status ----------------------------------------------------------------


@dataclass
class HomeConfig:
    url: Optional[str] = None
    token: Optional[str] = field(default=None, repr=False)  # never printed
    home_id: str = "home"
    name: str = "Home"
    label: str = "aiembodied"
    entities: list[str] = field(default_factory=list)
    raw_days: float = 7.0
    env_prefix: str = "HA"  # the environment variables it came from: HA, or HA_<NAME>
    source: str = "env"  # "env": from the environment; "app": pushed by the app (PUT /v1/home/servers)

    @property
    def off_reason(self) -> Optional[str]:
        if self.source == "app":
            if not self.url:
                return "the server has no address"
            if not self.token:
                return "the server has no token"
            return None
        prefix = self.env_prefix
        if not self.url:
            return f"{prefix}_URL is not set"
        if not self.token:
            return f"{prefix}_TOKEN is not set"
        return None

    @property
    def enabled(self) -> bool:
        return self.off_reason is None


def parse_entity_list(text: Optional[str]) -> list[str]:
    return [part.strip() for part in (text or "").split(",") if part.strip()]


DEFAULT_HOME_NAME = "Home"
# HA_<word>_URL names that belong to the single default home's settings, not to a home of their own.
RESERVED_NAMES = {"HOME", "RAW"}
_NAMED_URL = re.compile(r"^HA_([A-Za-z0-9_]+)_URL$")


def _float(text: Optional[str], default: float) -> float:
    try:
        return float(text) if text not in (None, "") else default
    except ValueError:
        return default


def homes_from_env(environ: Mapping[str, str]) -> list[HomeConfig]:
    """The homes the environment describes: the default one (HA_URL, HA_TOKEN, HA_HOME_ID,
    HA_HOME_NAME, HA_LABEL, HA_ENTITIES, HA_RAW_DAYS; listed if either of URL and token is set, so
    the status can say what is missing) and one for every HA_<NAME>_URL that has an HA_<NAME>_TOKEN."""
    label = environ.get("HA_LABEL") or "aiembodied"
    raw_days = _float(environ.get("HA_RAW_DAYS"), 7.0)
    homes: dict[str, HomeConfig] = {}
    if environ.get("HA_URL") or environ.get("HA_TOKEN"):
        config = HomeConfig(
            url=environ.get("HA_URL") or None,
            token=environ.get("HA_TOKEN") or None,
            home_id=environ.get("HA_HOME_ID") or "home",
            name=environ.get("HA_HOME_NAME") or DEFAULT_HOME_NAME,
            label=label,
            entities=parse_entity_list(environ.get("HA_ENTITIES")),
            raw_days=raw_days,
        )
        homes[config.home_id] = config
    for key in sorted(environ):
        found = _NAMED_URL.match(key)
        if not found:
            continue
        name = found.group(1)
        if name.upper() in RESERVED_NAMES:
            continue
        url, token = environ.get(key), environ.get(f"HA_{name}_TOKEN")
        if not url or not token:
            continue
        config = HomeConfig(
            url=url,
            token=token,
            home_id=name.lower(),
            name=environ.get(f"HA_{name}_NAME") or name,
            env_prefix=f"HA_{name}",
            label=environ.get(f"HA_{name}_LABEL") or label,
            entities=parse_entity_list(environ.get(f"HA_{name}_ENTITIES")),
            raw_days=raw_days,
        )
        homes[config.home_id] = config
    return list(homes.values())


def valid_server_url(url: str) -> bool:
    try:
        parts = urlsplit(url.strip())
        parts.port  # noqa: B018 - raises ValueError for a bad port
        return parts.scheme.lower() in ("http", "https") and bool(parts.hostname)
    except ValueError:
        return False


def public_url(url: Optional[str]) -> Optional[str]:
    """The address without any credentials in it."""
    if not url:
        return url
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if "@" not in parts.netloc:
        return url
    return urlunsplit(parts._replace(netloc=parts.netloc.rsplit("@", 1)[1]))


def ws_url(url: str) -> str:
    """http://host:8123 -> ws://host:8123/api/websocket (https -> wss)."""
    parts = urlsplit(url.strip())
    scheme = {"http": "ws", "https": "wss", "ws": "ws", "wss": "wss"}.get(parts.scheme.lower())
    if scheme is None or not parts.netloc:
        raise ValueError("HA_URL looks like http://homeassistant.local:8123")
    path = parts.path.rstrip("/")
    if not path.endswith("/api/websocket"):
        path += "/api/websocket"
    return urlunsplit((scheme, parts.netloc, path, "", ""))


def matches_entity(entity_id: str, patterns: Sequence[str]) -> bool:
    """An entity id, or `domain.*` (any shell-style wildcard works)."""
    return any(fnmatch.fnmatchcase(entity_id, pattern) for pattern in patterns)


# --- classification, deadband and wording (pure) ----------------------------------------------


def to_float(state: Any) -> Optional[float]:
    if state is None or isinstance(state, bool):
        return None
    try:
        value = float(state)
    except (TypeError, ValueError):
        return None
    return value if value == value and value not in (float("inf"), float("-inf")) else None


def classify(
    domain: str,
    device_class: Optional[str],
    entity_category: Optional[str],
    state: Optional[str],
    attributes: Optional[dict[str, Any]] = None,
) -> str:
    """alert, state, numeric or ignore. A sensor that has a unit (or a state class) is numeric
    even while it reports unavailable, so it is not mistaken for a state entity until the next
    refresh."""
    attributes = attributes or {}
    if entity_category in ("diagnostic", "config"):
        return "ignore"
    if domain == "alarm_control_panel" or (domain == "binary_sensor" and device_class in ALERT_DEVICE_CLASSES):
        return "alert"
    if domain in NUMERIC_DOMAINS and (attributes.get("unit_of_measurement") or attributes.get("state_class")):
        if to_float(state) is not None or state in NO_VALUE:
            return "numeric"
    return "state"


# device class -> (absolute floor or step, relative fraction of the last value or None)
_DEADBANDS: dict[str, tuple[float, Optional[float]]] = {
    "temperature": (0.3, None),
    "humidity": (2.0, None),
    "pressure": (1.0, None),
    "illuminance": (1.0, 0.10),
    "power": (0.1, 0.05),
    "energy": (0.1, 0.05),
    "current": (0.01, 0.05),
    "voltage": (0.1, 0.05),
    "battery": (5.0, None),
}


def deadband(device_class: Optional[str], last_value: Optional[float]) -> float:
    """How far a number must move from the last kept one to be kept. The relative ones have a
    small floor so a value sitting at zero doesn't keep every update."""
    last = abs(last_value) if last_value is not None else 0.0
    if device_class in _DEADBANDS:
        floor, relative = _DEADBANDS[device_class]
        return max(floor, relative * last) if relative else floor
    return max(0.5, 0.02 * last)


def keep_reading(
    value: float,
    last_value: Optional[float],
    last_kept_at: Optional[datetime],
    at: datetime,
    band: float,
) -> bool:
    if last_value is None or last_kept_at is None:
        return True
    if abs(value - last_value) >= band and value != last_value:
        return True
    return at - last_kept_at >= KEEP_EVERY


# binary_sensor device class -> (word for on, word for off)
_BINARY_WORDS = {
    "door": ("opened", "closed"),
    "window": ("opened", "closed"),
    "garage_door": ("opened", "closed"),
    "opening": ("opened", "closed"),
    "motion": ("detected", "clear"),
    "occupancy": ("detected", "clear"),
    "presence": ("detected", "clear"),
    "moisture": ("wet", "dry"),
    "smoke": ("detected", "clear"),
    "gas": ("detected", "clear"),
    "carbon_monoxide": ("detected", "clear"),
}


def _plain(state: str) -> str:
    return state.replace("_", " ")


def describe_change(
    name: str,
    area: Optional[str],
    domain: str,
    device_class: Optional[str],
    old: Optional[str],
    new: str,
    unit: Optional[str] = None,
    home_name: Optional[str] = None,
) -> str:
    """A readable sentence: "Front door (Hallway) opened, was closed." With a home that has a name
    of its own: "Front door (Hallway, SG) opened, was closed." """
    where = ", ".join(part for part in (area, home_name if home_name and home_name != DEFAULT_HOME_NAME else None) if part)
    who = f"{name} ({where})" if where else name
    if domain == "binary_sensor" and new in ("on", "off") and old in (None, "on", "off"):
        on_word, off_word = _BINARY_WORDS.get(device_class or "", ("turned on", "turned off"))
        head = f"{who} {on_word if new == 'on' else off_word}"
        # "opened, was closed": the old state in the state's own words.
        return head + "." if old is None else f"{head}, was {_state_word(device_class, old)}."
    if domain == "lock" and new in ("locked", "unlocked"):
        head = f"{who} {new}"
    elif new in ("on", "off") and old in (None, "on", "off"):
        head = f"{who} turned {new}"
    else:
        head = f"{who} changed to {_plain(new)}"
        if to_float(new) is not None and unit:
            head += f" {unit}"
    if old is None:
        return head + "."
    old_text = _plain(old)
    if to_float(old) is not None and unit:
        old_text += f" {unit}"
    return f"{head}, was {old_text}."


def _state_word(device_class: Optional[str], state: str) -> str:
    """The state as a word that follows "was": closed, open, clear, detected, dry, wet."""
    on_word, off_word = _BINARY_WORDS.get(device_class or "", ("on", "off"))
    word = on_word if state == "on" else off_word
    return {"opened": "open", "turned on": "on", "turned off": "off"}.get(word, word)


# --- recording (works on a connection; used by the listener and by the tests) ---------------


def parse_time(value: Any, default: Optional[datetime] = None) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return default or datetime.now(timezone.utc)


def upsert_home(conn: psycopg.Connection, config: HomeConfig, *, connected: bool) -> None:
    conn.execute(
        """
        INSERT INTO homes (id, name, url, connected_at) VALUES (%s, %s, %s, CASE WHEN %s THEN now() END)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, url = excluded.url, updated_at = now(),
            connected_at = CASE WHEN %s THEN now() ELSE homes.connected_at END
        """,
        (config.home_id, config.name, config.url or "", connected, connected),
    )


def upsert_entity(
    conn: psycopg.Connection,
    home_id: str,
    state: dict[str, Any],
    *,
    area: Optional[str] = None,
    registry_name: Optional[str] = None,
    entity_category: Optional[str] = None,
) -> str:
    """Add or refresh a watched entity from a Home Assistant state object, keeping what was last
    seen of it. Returns its class."""
    entity_id = state["entity_id"]
    attributes = state.get("attributes") or {}
    domain = entity_id.split(".", 1)[0]
    device_class = attributes.get("device_class")
    cls = classify(domain, device_class, entity_category, state.get("state"), attributes)
    name = attributes.get("friendly_name") or registry_name or entity_id
    conn.execute(
        """
        INSERT INTO ha_entities (home_id, entity_id, name, area, domain, device_class, unit, class)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (home_id, entity_id) DO UPDATE SET
            name = excluded.name, area = excluded.area, domain = excluded.domain,
            device_class = excluded.device_class, unit = excluded.unit, class = excluded.class,
            updated_at = now()
        """,
        (home_id, entity_id, name, area, domain, device_class, attributes.get("unit_of_measurement"), cls),
    )
    return cls


def record_state(
    conn: psycopg.Connection,
    home_id: str,
    entity_id: str,
    new_state: Optional[dict[str, Any]],
    *,
    catch_up: bool = False,
) -> Optional[dict[str, Any]]:
    """Take one new state of a watched entity (a Home Assistant state object). Stores an event
    when there is something worth keeping and returns {"kind", "indexed"}; None when not.
    `catch_up` is a state read after a gap rather than a live change: a number is only taken if
    it differs from the last one, and times come from last_changed."""
    if not new_state:
        return None
    row = conn.execute(
        "SELECT name, area, domain, device_class, unit, class, deadband, last_state, last_value, last_kept_at"
        " FROM ha_entities WHERE home_id = %s AND entity_id = %s FOR UPDATE",
        (home_id, entity_id),
    ).fetchone()
    if not row:
        return None
    name, area, domain, device_class, unit, cls, band_override, last_state, last_value, last_kept_at = row
    if cls == "ignore":
        return None
    state = new_state.get("state")
    if state is None:
        return None
    state = str(state)
    attributes = new_state.get("attributes") or {}
    changed_at = parse_time(new_state.get("last_changed"))
    updated_at = parse_time(new_state.get("last_updated"), changed_at)

    if cls in ("alert", "state"):
        if state == last_state:
            return None
        conn.execute(
            "UPDATE ha_entities SET last_state = %s, last_kept_at = %s, updated_at = now()"
            " WHERE home_id = %s AND entity_id = %s",
            (state, changed_at, home_id, entity_id),
        )
        if last_state is None:
            return None  # the first time it is seen: a starting point, not a change
        return _store_event(conn, home_id, entity_id, cls, changed_at, state, last_state, None, attributes,
                            name, area, domain, device_class, unit)

    # numeric
    value = to_float(state)
    if value is None:
        if state == last_state:
            return None
        conn.execute(
            "UPDATE ha_entities SET last_state = %s, last_value = NULL, last_kept_at = %s, updated_at = now()"
            " WHERE home_id = %s AND entity_id = %s",
            (state, changed_at, home_id, entity_id),
        )
        if last_state is None:
            return None
        return _store_event(conn, home_id, entity_id, "change", changed_at, state, last_state, None, attributes,
                            name, area, domain, device_class, unit)
    if catch_up and state == last_state:
        return None
    at = updated_at
    conn.execute(
        """
        INSERT INTO ha_readings (home_id, entity_id, hour, n, min, max, sum, last)
        VALUES (%(h)s, %(e)s, date_trunc('hour', %(at)s::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
                1, %(v)s, %(v)s, %(v)s, %(v)s)
        ON CONFLICT (home_id, entity_id, hour) DO UPDATE SET
            n = ha_readings.n + 1, min = least(ha_readings.min, excluded.min),
            max = greatest(ha_readings.max, excluded.max), sum = ha_readings.sum + excluded.sum,
            last = excluded.last
        """,
        {"h": home_id, "e": entity_id, "at": at, "v": value},
    )
    band = band_override if band_override is not None else deadband(device_class, last_value)
    kept = keep_reading(value, last_value, last_kept_at, at, band)
    if kept:
        conn.execute(
            "UPDATE ha_entities SET last_state = %s, last_value = %s, last_kept_at = %s, updated_at = now()"
            " WHERE home_id = %s AND entity_id = %s",
            (state, value, at, home_id, entity_id),
        )
        conn.execute(
            "INSERT INTO ha_events (id, home_id, entity_id, kind, at, state, value, attributes)"
            " VALUES (%s, %s, %s, 'reading', %s, %s, %s, %s)",
            (uuid4(), home_id, entity_id, at, state, value, Jsonb({})),
        )
        return {"kind": "reading", "indexed": False}
    conn.execute(
        "UPDATE ha_entities SET last_state = %s WHERE home_id = %s AND entity_id = %s", (state, home_id, entity_id)
    )
    return None


# Attributes worth keeping with a change; the rest (icons, supported features, ...) is noise.
_KEEP_ATTRIBUTES = ("device_class", "unit_of_measurement", "friendly_name")


def _store_event(
    conn: psycopg.Connection,
    home_id: str,
    entity_id: str,
    kind: str,
    at: datetime,
    state: str,
    old_state: Optional[str],
    value: Optional[float],
    attributes: dict[str, Any],
    name: str,
    area: Optional[str],
    domain: str,
    device_class: Optional[str],
    unit: Optional[str],
) -> dict[str, Any]:
    event_kind = "alert" if kind == "alert" else "change"
    event_id = uuid4()
    kept = {key: attributes[key] for key in _KEEP_ATTRIBUTES if key in attributes}
    conn.execute(
        "INSERT INTO ha_events (id, home_id, entity_id, kind, at, state, old_state, value, attributes)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (event_id, home_id, entity_id, event_kind, at, state, old_state, value, Jsonb(kept)),
    )
    home_name = conn.execute("SELECT name FROM homes WHERE id = %s", (home_id,)).fetchone()
    sentence = describe_change(name, area, domain, device_class, old_state, state, unit, home_name[0] if home_name else None)
    text = f"Alert: {sentence}" if event_kind == "alert" else sentence
    conn.execute(
        """
        INSERT INTO recall_index (kind, source, source_id, session_id, agent, period_start, period_end, text, importance)
        VALUES (%s, %s, %s, NULL, NULL, %s, %s, %s, %s)
        ON CONFLICT (kind, source_id) DO NOTHING
        """,
        (INDEX_KIND, SOURCE, event_id, at, at, text, 0.9 if event_kind == "alert" else 0.4),
    )
    return {"kind": event_kind, "indexed": True}


def handle_event(conn: psycopg.Connection, home_id: str, event: dict[str, Any]) -> Optional[dict[str, Any]]:
    """A state_changed event as Home Assistant sends it ({"event_type", "data": {"entity_id",
    "new_state", "old_state"}, ...}). Entities that aren't watched are ignored."""
    data = event.get("data") or {}
    entity_id = data.get("entity_id")
    if not entity_id:
        return None
    return record_state(conn, home_id, entity_id, data.get("new_state"))


def prune(conn: psycopg.Connection, raw_days: float, home_id: Optional[str] = None) -> int:
    """Delete raw readings older than raw_days (of one home, or of all); rollups and changes stay."""
    cur = conn.execute(
        "DELETE FROM ha_events WHERE kind = 'reading' AND at < now() - make_interval(secs => %s)"
        " AND (%s::text IS NULL OR home_id = %s)",
        (raw_days * 86400.0, home_id, home_id),
    )
    return cur.rowcount


# --- look-ups ---------------------------------------------------------------------------------

ENTITY_COLUMNS = (
    "e.home_id, e.entity_id, e.name, e.area, e.domain, e.device_class, e.class, e.unit, e.last_state, e.last_value,"
    " h.name"
)
ENTITY_FROM = "ha_entities e LEFT JOIN homes h ON h.id = e.home_id"
RAW_MAX_RANGE = timedelta(days=2)
READINGS_MAX = 2000


def _entity_json(row: tuple) -> dict[str, Any]:
    return {
        "home_id": row[0],
        "entity_id": row[1],
        "name": row[2],
        "area": row[3],
        "domain": row[4],
        "device_class": row[5],
        "class": row[6],
        "unit": row[7],
        "last_state": row[8],
        "last_value": row[9],
        "home_name": row[10] or row[0],
    }


def _like_all(term: str) -> list[str]:
    """One ILIKE pattern per word, each matched against the id, name and area together."""
    words = [w for w in term.replace("_", " ").replace(".", " ").split() if w]
    return ["%" + w.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%" for w in words]


_HAYSTACK = (
    "(coalesce(e.name, '') || ' ' || coalesce(e.area, '') || ' ' || replace(replace(e.entity_id, '_', ' '), '.', ' ')"
    " || ' ' || CASE WHEN h.name IS NOT NULL AND h.name <> 'Home' THEN h.name ELSE '' END)"
)


def find_entities(conn: psycopg.Connection, home_id: Optional[str], term: Optional[str], limit: int = 200) -> list[dict[str, Any]]:
    patterns = _like_all(term or "")
    rows = conn.execute(
        f"SELECT {ENTITY_COLUMNS} FROM {ENTITY_FROM}"  # noqa: S608 - fixed text
        f" WHERE (%(home)s::text IS NULL OR e.home_id = %(home)s)"
        f" AND (cardinality(%(patterns)s::text[]) = 0 OR {_HAYSTACK} ILIKE ALL(%(patterns)s))"
        " ORDER BY e.area NULLS LAST, e.name, e.entity_id LIMIT %(limit)s",
        {"home": home_id, "patterns": patterns, "limit": limit},
    ).fetchall()
    return [_entity_json(r) for r in rows]


def list_entities(conn: psycopg.Connection, home_id: Optional[str], q: Optional[str]) -> list[dict[str, Any]]:
    return find_entities(conn, home_id, q, 1000)


def history(
    conn: psycopg.Connection,
    home_id: Optional[str],
    entity: Optional[str],
    q: Optional[str],
    start: datetime,
    end: datetime,
    limit: int,
) -> dict[str, Any]:
    """What one entity did in [start, end). If `entity` or `q` does not single one out, the
    candidates come back as {"matches": [...]} and no history."""
    chosen: Optional[dict[str, Any]] = None
    exact = conn.execute(
        f"SELECT {ENTITY_COLUMNS} FROM {ENTITY_FROM} WHERE e.entity_id = ANY(%s)"  # noqa: S608
        " AND (%s::text IS NULL OR e.home_id = %s) LIMIT 2",
        ([t for t in (entity, q) if t], home_id, home_id),
    ).fetchall()
    if len(exact) == 1:
        chosen = _entity_json(exact[0])
    matches: list[dict[str, Any]] = []
    if chosen is None:
        for term in (entity, q):
            if term:
                matches = find_entities(conn, home_id, term, 50)
                if matches:
                    break
        named = [m for m in matches if (m["name"] or "").lower() == (entity or q or "").strip().lower()]
        if len(matches) == 1:
            chosen = matches[0]
        elif len(named) == 1:
            chosen = named[0]
        else:
            return {"matches": matches}
    entity_id, home = chosen["entity_id"], chosen["home_id"]
    changes = conn.execute(
        "SELECT at, kind, state, old_state, value FROM ha_events"
        " WHERE home_id = %s AND entity_id = %s AND kind IN ('alert', 'change') AND at >= %s AND at < %s"
        " ORDER BY at DESC LIMIT %s",
        (home, entity_id, start, end, limit),
    ).fetchall()
    out: dict[str, Any] = {
        "entity": chosen,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "changes": [
            {
                "at": r[0].isoformat(),
                "kind": r[1],
                "state": r[2],
                "old_state": r[3],
                "value": r[4],
                "text": describe_change(
                    chosen["name"] or entity_id, chosen["area"], chosen["domain"], chosen["device_class"],
                    r[3], r[2] or "", chosen["unit"], chosen["home_name"],
                ),
            }
            for r in changes
        ],
        "readings": [],
        "raw": [],
    }
    if chosen["class"] == "numeric":
        rollups = conn.execute(
            "SELECT hour, n, min, max, sum, last FROM ha_readings"
            " WHERE home_id = %s AND entity_id = %s AND hour >= date_trunc('hour', %s::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
            " AND hour < %s ORDER BY hour LIMIT %s",
            (home, entity_id, start, end, READINGS_MAX),
        ).fetchall()
        out["readings"] = [
            {"hour": r[0].isoformat(), "n": r[1], "min": r[2], "mean": r[4] / r[1] if r[1] else None, "max": r[3], "last": r[5]}
            for r in rollups
        ]
        if end - start <= RAW_MAX_RANGE:
            raw = conn.execute(
                "SELECT at, value FROM ha_events WHERE home_id = %s AND entity_id = %s AND kind = 'reading'"
                " AND at >= %s AND at < %s ORDER BY at LIMIT %s",
                (home, entity_id, start, end, limit),
            ).fetchall()
            out["raw"] = [{"at": r[0].isoformat(), "value": r[1]} for r in raw]
    return out


# --- the listener -----------------------------------------------------------------------------


class AuthRefused(Exception):
    pass


class HomeListener:
    """Runs in a daemon thread with an event loop of its own."""

    def __init__(self, engine: "Engine", config: HomeConfig):
        self.engine = engine
        self.config = config
        self.connected = False
        self.error: Optional[str] = None
        self.note: Optional[str] = None
        self.watched: set[str] = set()
        self.last_event_at: Optional[datetime] = None
        self._events_day = datetime.now().date()
        self._events_today = 0
        self._thread: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._stop_event: Optional[asyncio.Event] = None
        self._stopping = threading.Event()
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        # Events that arrive while the first sync runs, handled once it is done.
        self._held: Optional[list[dict[str, Any]]] = None

    # --- thread control ----

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"memory-home-{self.config.home_id}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        loop, event = self._loop, self._stop_event
        if loop is not None and event is not None:
            try:
                loop.call_soon_threadsafe(event.set)
            except RuntimeError:  # the loop is already closed
                pass
        # Let a write in progress finish before the engine closes its pool (and, in tests,
        # before the schema is dropped under it).
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=5)

    def status(self) -> dict[str, Any]:
        if self._events_day != datetime.now().date():
            self._events_day, self._events_today = datetime.now().date(), 0
        return {
            "id": self.config.home_id,
            "name": self.config.name,
            "source": self.config.source,
            "configured": True,
            "connected": self.connected,
            "url": public_url(self.config.url),
            "label": self.config.label,
            "watched": len(self.watched),
            "events_today": self._events_today,
            "last_event_at": self.last_event_at.isoformat() if self.last_event_at else None,
            "error": self.error,
            "note": self.note,
        }

    def _run(self) -> None:
        try:
            asyncio.run(self._main())
        except Exception:  # noqa: BLE001
            log.exception("The Home Assistant listener for %s stopped", self.config.home_id)
            self.error = "the listener stopped; see the engine's log"
        self.connected = False

    async def _main(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._stop_event = asyncio.Event()
        if self._stopping.is_set():
            return
        pruner = asyncio.create_task(self._prune_loop())
        try:
            await self._connect_loop()
        finally:
            pruner.cancel()

    async def _sleep(self, seconds: float) -> bool:
        """Wait; False if the listener was stopped meanwhile."""
        assert self._stop_event is not None
        try:
            await asyncio.wait_for(self._stop_event.wait(), seconds)
            return False
        except asyncio.TimeoutError:
            return True

    async def _connect_loop(self) -> None:
        assert self._stop_event is not None
        backoff = BACKOFF_MIN
        while not self._stop_event.is_set():
            started = time.monotonic()
            wait = backoff
            try:
                await self._session()
                self.error = None
            except AuthRefused:
                self.error = "token refused"
                log.warning("Home Assistant (%s) refused the access token; trying again in %d minutes",
                            self.config.home_id, AUTH_REFUSED_WAIT // 60)
                wait = AUTH_REFUSED_WAIT
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - drop the connection and try again
                message = _first_line(error)
                if message != self.error:
                    log.warning("Home Assistant (%s) connection failed: %s", self.config.home_id, message)
                self.error = message
            finally:
                self.connected = False
                self._fail_pending()
            if self._stop_event.is_set():
                return
            # A connection that held for a while starts the backoff over.
            if wait == AUTH_REFUSED_WAIT:
                backoff = BACKOFF_MIN
            elif time.monotonic() - started > 60:
                backoff, wait = BACKOFF_MIN, BACKOFF_MIN
            else:
                backoff = min(backoff * 2, BACKOFF_MAX)
            if not await self._sleep(wait):
                return

    def _fail_pending(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(ConnectionError("connection closed"))
        self._pending.clear()

    # --- one connection ----

    async def _call(self, ws, kind: str, **fields: Any) -> Any:
        assert self._loop is not None
        self._next_id += 1
        command_id = self._next_id
        future: asyncio.Future = self._loop.create_future()
        self._pending[command_id] = future
        await ws.send(json.dumps({"id": command_id, "type": kind, **fields}))
        message = await asyncio.wait_for(future, 60)
        if not message.get("success", False):
            error = message.get("error") or {}
            raise CommandFailed(kind, error.get("code") or "failed")
        return message.get("result")

    async def _session(self) -> None:
        from websockets.asyncio.client import connect

        assert self._stop_event is not None
        url = ws_url(self.config.url or "")
        self._next_id = 0
        self._held = []
        # max_size: a house's whole state list is far bigger than the default 1 MiB.
        async with connect(url, ping_interval=30, ping_timeout=30, max_size=64 * 1024 * 1024, open_timeout=15) as ws:
            first = json.loads(await asyncio.wait_for(ws.recv(), 15))
            if first.get("type") != "auth_required":
                raise ConnectionError("unexpected greeting from Home Assistant")
            await ws.send(json.dumps({"type": "auth", "access_token": self.config.token}))
            reply = json.loads(await asyncio.wait_for(ws.recv(), 15))
            if reply.get("type") == "auth_invalid":
                raise AuthRefused()
            if reply.get("type") != "auth_ok":
                raise ConnectionError("Home Assistant did not accept the login")

            reader = asyncio.create_task(self._read(ws))
            stopper = asyncio.create_task(self._stop_event.wait())
            worker = asyncio.create_task(self._work(ws))
            try:
                done, _ = await asyncio.wait({reader, stopper, worker}, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    if task is not stopper:
                        task.result()  # raises what went wrong
            finally:
                for task in (reader, stopper, worker):
                    task.cancel()
                await asyncio.gather(reader, stopper, worker, return_exceptions=True)

    async def _read(self, ws) -> None:
        async for raw in ws:
            message = json.loads(raw)
            kind = message.get("type")
            if kind == "result":
                future = self._pending.pop(message.get("id"), None)
                if future is not None and not future.done():
                    future.set_result(message)
            elif kind == "event":
                event = message.get("event") or {}
                if self._held is not None:
                    self._held.append(event)  # the watched set isn't known yet; see _work
                else:
                    await asyncio.to_thread(self._on_event, event)
        raise ConnectionError("connection closed")

    async def _work(self, ws) -> None:
        """Set up, then keep the registries and watched set fresh."""
        # Nothing can be stored until the database is up; Home Assistant is read after that.
        while not self.engine.ready:
            if not await self._sleep(1.0):
                return
        await self._refresh(ws, first=True)
        await self._call(ws, "subscribe_events", event_type="state_changed")
        self.connected = True
        self.error = None
        # Subscribed before the states are read, so nothing slips between the two.
        await self._refresh(ws)
        log.info("Home Assistant (%s) connected; watching %d entities", self.config.home_id, len(self.watched))
        held, self._held = self._held or [], None
        for event in held:
            await asyncio.to_thread(self._on_event, event)
        while await self._sleep(REFRESH_SECONDS):
            await self._refresh(ws)

    async def _refresh(self, ws, first: bool = False) -> None:
        """Load the registries and states, work out which entities are watched, and catch up on
        anything that changed while we were away. The first pass only fills the registry."""
        config = self.config
        registry: Optional[dict[str, Any]] = None
        try:
            labels = await self._call(ws, "config/label_registry/list")
            entries = await self._call(ws, "config/entity_registry/list")
            devices = await self._call(ws, "config/device_registry/list")
            areas = await self._call(ws, "config/area_registry/list")
            registry = {"labels": labels, "entries": entries, "devices": devices, "areas": areas}
            self.note = None
        except CommandFailed:
            self.note = (
                "Could not read Home Assistant's registries (the token's user may not be an admin), "
                "so only HA_ENTITIES is watched"
            )
            if not config.entities:
                self.note += "; HA_ENTITIES is empty, so nothing is watched"
        if first:
            await asyncio.to_thread(self._upsert_home)
            return
        states = await self._call(ws, "get_states")
        await asyncio.to_thread(self._sync, registry, states)

    def _upsert_home(self) -> None:
        if not self.engine.ready:
            return
        with self.engine.pool.connection(timeout=10) as conn:
            upsert_home(conn, self.config, connected=True)

    def _sync(self, registry: Optional[dict[str, Any]], states: list[dict[str, Any]]) -> None:
        config = self.config
        by_state = {s["entity_id"]: s for s in states if isinstance(s, dict) and "entity_id" in s}
        meta: dict[str, dict[str, Any]] = {}
        watched: set[str] = set()
        labelled: set[str] = set()
        if registry:
            label_id = _find_label(registry["labels"], config.label)
            area_names = {a.get("area_id"): a.get("name") for a in registry["areas"]}
            device_area = {d.get("id"): d.get("area_id") for d in registry["devices"]}
            for entry in registry["entries"]:
                entity_id = entry.get("entity_id")
                if not entity_id or entry.get("disabled_by"):
                    continue
                area_id = entry.get("area_id") or device_area.get(entry.get("device_id"))
                meta[entity_id] = {
                    "area": area_names.get(area_id) if area_id else None,
                    "name": entry.get("name") or entry.get("original_name"),
                    "category": entry.get("entity_category"),
                }
                if label_id is not None and label_id in (entry.get("labels") or []):
                    watched.add(entity_id)
                    labelled.add(entity_id)
        disabled = {e["entity_id"] for e in (registry or {}).get("entries", []) if e.get("disabled_by")}
        for entity_id in by_state:
            if entity_id not in disabled and matches_entity(entity_id, config.entities):
                watched.add(entity_id)
        watched &= set(by_state)  # an entity with no state yet is picked up at a later refresh
        # Diagnostic and config entities are not kept at all.
        # An entity someone chose on purpose (it carries the label, or is named exactly in
        # HA_ENTITIES) is kept even if HA calls it diagnostic: a phone's tracker is, for one.
        named = {pattern for pattern in config.entities if "*" not in pattern and "?" not in pattern} | labelled
        for entity_id in list(watched):
            if entity_id in named:
                continue
            state = by_state[entity_id]
            attributes = state.get("attributes") or {}
            if classify(entity_id.split(".", 1)[0], attributes.get("device_class"),
                        meta.get(entity_id, {}).get("category"), state.get("state"), attributes) == "ignore":
                watched.discard(entity_id)
        if registry and not watched:
            # Connected but watching nothing: say why, so the status explains an empty memory.
            self.note = (
                f'No entity carries the label "{config.label}" in Home Assistant'
                + (" and nothing matches HA_ENTITIES" if config.entities else "")
                + "; add the label to the entities to remember"
            )
        if not self.engine.ready:
            self.watched = watched
            return
        indexed = False
        with self.engine.pool.connection(timeout=10) as conn:
            upsert_home(conn, config, connected=False)
            for entity_id in sorted(watched):
                state = by_state[entity_id]
                info = meta.get(entity_id, {})
                upsert_entity(
                    conn, config.home_id, state, area=info.get("area"), registry_name=info.get("name"),
                    entity_category=None if entity_id in named else info.get("category"),
                )
                result = record_state(conn, config.home_id, entity_id, state, catch_up=True)
                if result and result["indexed"]:
                    self._count(state)
                    indexed = indexed or result["indexed"]
            conn.execute(
                "DELETE FROM ha_entities WHERE home_id = %s AND NOT (entity_id = ANY(%s))",
                (config.home_id, sorted(watched)),
            )
        self.watched = watched
        if indexed:
            self.engine.wake_embedder()

    def _on_event(self, event: dict[str, Any]) -> None:
        data = event.get("data") or {}
        entity_id = data.get("entity_id")
        if entity_id not in self.watched:
            return
        if not self.engine.ready:
            log.debug("Dropped a Home Assistant event for %s: the database is not ready", entity_id)
            return
        try:
            with self.engine.pool.connection(timeout=10) as conn:
                result = handle_event(conn, self.config.home_id, event)
        except Exception as error:  # noqa: BLE001 - one bad event must not end the connection
            log.warning("Could not store a Home Assistant event: %s", _first_line(error))
            return
        if result and result["indexed"]:  # alerts and changes; readings aren't counted
            self._count(data.get("new_state") or {})
            self.engine.wake_embedder()

    def _count(self, state: dict[str, Any]) -> None:
        today = datetime.now().date()
        if self._events_day != today:
            self._events_day, self._events_today = today, 0
        self._events_today += 1
        self.last_event_at = parse_time(state.get("last_updated") or state.get("last_changed"))

    async def _prune_loop(self) -> None:
        while await self._sleep(PRUNE_SECONDS if self.engine.ready else 30):
            if not self.engine.ready:
                continue
            try:
                def run() -> int:
                    with self.engine.pool.connection(timeout=10) as conn:
                        return prune(conn, self.config.raw_days, self.config.home_id)

                removed = await asyncio.to_thread(run)
                if removed:
                    log.info("Pruned %d old Home Assistant readings (%s)", removed, self.config.home_id)
            except Exception as error:  # noqa: BLE001
                log.warning("Pruning Home Assistant readings failed: %s", _first_line(error))


class CommandFailed(Exception):
    def __init__(self, kind: str, code: str):
        super().__init__(f"{kind} failed: {code}")


def _find_label(labels: list[dict[str, Any]], wanted: str) -> Optional[str]:
    wanted_lower = wanted.lower()
    for label in labels:
        if (label.get("name") or "").lower() == wanted_lower or label.get("label_id") == wanted:
            return label.get("label_id")
    return None


def _first_line(error: BaseException) -> str:
    text = str(error).strip()
    return text.splitlines()[0][:300] if text else type(error).__name__


def unconfigured_status(config: HomeConfig) -> dict[str, Any]:
    return {
        "id": config.home_id,
        "name": config.name,
        "source": config.source,
        "configured": False,
        "connected": False,
        "url": public_url(config.url),
        "label": config.label,
        "watched": 0,
        "events_today": 0,
        "last_event_at": None,
        "error": None,
        "note": f"Home Assistant is off: {config.off_reason or 'not configured'}",
    }


class HomeManager:
    """One HomeListener per home, keyed by home id. The environment's homes are fixed; the app's
    are replaced as a set (set_app). An app home with the id of an environment home replaces it
    while it is there. Tokens live in memory only."""

    def __init__(self, engine: "Engine", env_configs: Sequence[HomeConfig] = ()):
        self.engine = engine
        self.env: dict[str, HomeConfig] = {c.home_id: c for c in env_configs}
        self.app: dict[str, HomeConfig] = {}
        self.raw_days = next(iter(self.env.values())).raw_days if self.env else 7.0
        self.listeners: dict[str, HomeListener] = {}
        self.configs: dict[str, HomeConfig] = {}  # what is in effect, listed in the status
        self.started = False
        self._lock = threading.RLock()
        self._reconcile()

    def start(self) -> None:
        with self._lock:
            self.started = True
            self._reconcile()

    def stop(self) -> None:
        with self._lock:
            self.started = False
            listeners, self.listeners = list(self.listeners.values()), {}
        for listener in listeners:
            listener.stop()

    def set_app(self, configs: Sequence[HomeConfig]) -> None:
        with self._lock:
            self.app = {c.home_id: c for c in configs}
            self._reconcile()

    def _reconcile(self) -> None:
        """Start, restart or stop listeners so they match the homes in effect."""
        wanted = {**self.env, **self.app}
        self.configs = wanted
        for home_id in list(self.listeners):
            listener = self.listeners[home_id]
            if home_id not in wanted or not wanted[home_id].enabled or listener.config != wanted[home_id]:
                del self.listeners[home_id]
                listener.stop()
        if not self.started:
            return
        for home_id, config in wanted.items():
            if config.enabled and home_id not in self.listeners:
                listener = HomeListener(self.engine, config)
                self.listeners[home_id] = listener
                listener.start()

    def status(self) -> list[dict[str, Any]]:
        with self._lock:
            out = []
            for home_id, config in self.configs.items():
                listener = self.listeners.get(home_id)
                if listener is not None:
                    out.append(listener.status())
                elif config.enabled:  # configured, not started (yet)
                    out.append({**unconfigured_status(config), "configured": True, "note": None})
                else:
                    out.append(unconfigured_status(config))
            return out
