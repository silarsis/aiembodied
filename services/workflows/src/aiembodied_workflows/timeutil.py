"""Small pure time helpers: quiet hours, ISO parsing, "next 07:30" in a local zone."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def parse_quiet_hours(value: str | None) -> tuple[int, int] | None:
    """Hours "22-7" (start-end, local, end exclusive, may wrap past midnight) as a pair, or None for none.

    Same rules as the app's PROACTIVE_QUIET_HOURS."""
    m = re.fullmatch(r"\s*(\d{1,2})\s*-\s*(\d{1,2})\s*", value or "")
    if not m:
        return None
    start, end = int(m.group(1)), int(m.group(2))
    if start > 24 or end > 24 or start == end:
        return None
    return start % 24, end % 24


def in_quiet_hours(hours: tuple[int, int] | None, hour: int) -> bool:
    if not hours:
        return False
    start, end = hours
    return start <= hour < end if start < end else hour >= start or hour < end


def parse_iso(value: str) -> datetime:
    """An ISO 8601 time; a trailing Z is UTC. A time with no zone is taken as UTC. Raises ValueError."""
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def iso_z(dt: datetime) -> str:
    """UTC with milliseconds and a Z, like the switchboard writes times."""
    u = dt.astimezone(timezone.utc)
    return u.strftime("%Y-%m-%dT%H:%M:%S.") + f"{u.microsecond // 1000:03d}Z"


def get_tz(name: str | None) -> tzinfo:
    """The named zone, else the machine's local zone."""
    if name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return datetime.now().astimezone().tzinfo or timezone.utc


def next_local_time(now: datetime, hhmm: str, tz: tzinfo) -> datetime:
    """The next time the wall clock in `tz` reads `HH:MM`, strictly after `now`. Returned in UTC."""
    m = re.fullmatch(r"\s*(\d{1,2}):(\d{2})\s*", hhmm)
    if not m:
        raise ValueError(f"not a time of day: {hhmm!r}")
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 23 or mi > 59:
        raise ValueError(f"not a time of day: {hhmm!r}")
    local = now.astimezone(tz)
    cand = local.replace(hour=h, minute=mi, second=0, microsecond=0)
    if cand <= local:
        cand = (local + timedelta(days=1)).replace(hour=h, minute=mi, second=0, microsecond=0)
    return cand.astimezone(timezone.utc)


def due_from(now: datetime, at: str | None, in_seconds: float | None) -> datetime:
    """Resolve `at` (ISO) or `in_seconds` to a UTC time. Raises ValueError when neither is usable."""
    if at:
        return parse_iso(at).astimezone(timezone.utc)
    if in_seconds is not None:
        if in_seconds < 0:
            raise ValueError("inSeconds must not be negative")
        return now.astimezone(timezone.utc) + timedelta(seconds=in_seconds)
    raise ValueError("give either `at` or `inSeconds`")


def hhmm(dt: datetime, tz: tzinfo | None = None) -> str:
    return (dt.astimezone(tz) if tz else dt).strftime("%H:%M")
