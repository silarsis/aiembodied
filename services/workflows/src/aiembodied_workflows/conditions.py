"""Watch conditions (Contract 3): validation and pure evaluation. No I/O, no clocks."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

MAX_UNTIL_HOURS = 720
DEFAULT_UNTIL_HOURS = 24
ENTITY_POLL_SECONDS = 300


def validate_condition(cond: Any, path: str = "condition") -> list[str]:
    """Error strings for a bad watch condition; empty when it is fine."""
    if not isinstance(cond, dict):
        return [f"{path}: must be an object"]
    kind = cond.get("kind")
    errs: list[str] = []
    if kind == "entity":
        if not _text(cond.get("entityId")):
            errs.append(f"{path}.entityId: required text")
        modes = [k for k in ("state", "below", "above") if k in cond]
        if len(modes) != 1:
            errs.append(f"{path}: give exactly one of state, below, above")
        elif modes[0] == "state":
            if not isinstance(cond["state"], (str, int, float, bool)) or cond["state"] == "":
                errs.append(f"{path}.state: required text")
        elif not _num(cond[modes[0]]):
            errs.append(f"{path}.{modes[0]}: must be a number")
        if "forSeconds" in cond and (not _num(cond["forSeconds"]) or cond["forSeconds"] < 0):
            errs.append(f"{path}.forSeconds: must be a number of seconds, 0 or more")
    elif kind == "search":
        if not _text(cond.get("query")):
            errs.append(f"{path}.query: required text")
        errs += _every(cond, path)
    elif kind == "service":
        url = cond.get("url")
        if not _text(url) or not str(url).startswith(("http://", "https://")):
            errs.append(f"{path}.url: must be an http or https address")
        errs += _every(cond, path)
    elif kind == "coding_task":
        if not _text(cond.get("taskId")):
            errs.append(f"{path}.taskId: required text")
    else:
        errs.append(f"{path}.kind: must be one of entity, search, service, coding_task")
    return errs


def validate_then(then: Any, path: str = "then") -> list[str]:
    if not isinstance(then, dict):
        return [f"{path}: must be an object"]
    keys = [k for k in ("say", "think", "flow") if k in then]
    if len(keys) != 1:
        return [f"{path}: give exactly one of say, think, flow"]
    k = keys[0]
    if not _text(then[k]):
        return [f"{path}.{k}: required text"]
    if k == "flow" and "inputs" in then and not isinstance(then["inputs"], dict):
        return [f"{path}.inputs: must be an object"]
    return []


def clamp_until_hours(value: Any) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return DEFAULT_UNTIL_HOURS
    return min(max(v, 0.01), MAX_UNTIL_HOURS)


def _every(cond: dict, path: str) -> list[str]:
    v = cond.get("everyMinutes", 60)
    return [] if _num(v) and v >= 1 else [f"{path}.everyMinutes: must be a number, 1 or more"]


def _text(v: Any) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def poll_seconds(cond: dict) -> float:
    return float(cond.get("everyMinutes", 60)) * 60


def entity_state_of(value: Any) -> Any:
    """The state out of a home_change payload value, which may be plain or a small object."""
    if isinstance(value, dict):
        return value.get("state", value.get("value"))
    return value


def entity_matches(cond: dict, state: Any) -> bool:
    """Does one reading satisfy an entity condition? (The held-for part is handled by `Hold`.)"""
    state = entity_state_of(state)
    if state is None:
        return False
    if "state" in cond:
        return str(state).strip().lower() == str(cond["state"]).strip().lower()
    try:
        n = float(state)
    except (TypeError, ValueError):
        return False
    if "below" in cond:
        return n < float(cond["below"])
    return n > float(cond["above"])


@dataclass
class Hold:
    """Tracks "has the condition held for N seconds". Feed it each reading with the time in seconds."""

    for_seconds: float = 0.0
    since: float | None = None

    def update(self, now: float, matched: bool) -> bool:
        """True when the condition has now held long enough."""
        if not matched:
            self.since = None
            return False
        if self.since is None:
            self.since = now
        return now - self.since >= self.for_seconds

    def remaining(self, now: float) -> float | None:
        """Seconds until it would be satisfied if it keeps matching, or None when it is not matching."""
        if self.since is None:
            return None
        return max(0.0, self.for_seconds - (now - self.since))


def result_urls(results: list[dict]) -> list[str]:
    return [str(r.get("url")) for r in results if r.get("url")]


def new_results(first_urls: list[str], results: list[dict]) -> list[dict]:
    """Results whose address was not in the first look."""
    seen = set(first_urls)
    return [r for r in results if r.get("url") and str(r["url"]) not in seen]


def service_is_down(status: int | None) -> bool:
    """Down means no 2xx or 3xx answer (None = no answer at all)."""
    return status is None or not (200 <= status < 400)


def task_finished(payload: dict) -> bool:
    state = str(payload.get("state") or payload.get("status") or "").lower()
    return state in ("done", "failed", "cancelled", "canceled")


def describe(cond: dict) -> str:
    kind = cond.get("kind")
    if kind == "entity":
        if "state" in cond:
            what = f"is {cond['state']}"
        elif "below" in cond:
            what = f"is below {cond['below']}"
        else:
            what = f"is above {cond['above']}"
        held = f" for {int(cond['forSeconds'])} s" if cond.get("forSeconds") else ""
        return f"{cond.get('entityId')} {what}{held}"
    if kind == "search":
        return f"a new result for \"{cond.get('query')}\""
    if kind == "service":
        return f"{cond.get('url')} is down"
    if kind == "coding_task":
        return f"coding task {cond.get('taskId')} finishes"
    return str(kind)
