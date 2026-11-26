"""Pure rules for the life workflow: when to decide, whether it is allowed, the prompts and the reply parser.

The hard rules are ported from app/main/src/presence/proactive-tick.ts. Nothing here reads a clock or does I/O.
"""

from __future__ import annotations

import re
from typing import Any

from .timeutil import in_quiet_hours, parse_quiet_hours

TICK_SECONDS = 60
MAX_TICK_CREDIT = 120
RECENT_SPEECH_SECONDS = 2 * 60
MIN_SAY_GAP_SECONDS = 20 * 60
AWAY_SECONDS = 30 * 60
FACE_NOW_SECONDS = 90
BUSY_PHASES = ("listening", "transcribing", "thinking", "responding")
DECISION_MINUTES = {"restless": 5, "normal": 10, "calm": 20}
RETURN_HOME_CHANCE = {"calm": 0.05, "normal": 0.1, "restless": 0.2}
HOST_AVATAR = "echo"
PLAN_AFTER_HOUR = 6
PLAN_SEEN_SECONDS = 10 * 60


def decision_interval_seconds(restlessness: str | None, rand: float) -> float | None:
    """Seconds until the next decision, with jitter x0.6..1.4 (`rand` is 0..1). None = never (idle life off)."""
    minutes = DECISION_MINUTES.get(restlessness or "")
    if minutes is None:
        return None
    return minutes * 60 * (0.6 + 0.8 * rand)


def return_home_chance(restlessness: str | None) -> float:
    return RETURN_HOME_CHANCE.get(restlessness or "", 0.0)


def is_arrival(seconds_since_face: float | None, previous_sighting_age: float | None) -> bool:
    """A face is in view now and the sighting before it was 30+ minutes ago.

    `previous_sighting_age` is how long ago the workflow last saw a face, measured before this tick."""
    if seconds_since_face is None or seconds_since_face > FACE_NOW_SECONDS:
        return False
    return previous_sighting_age is not None and previous_sighting_age >= AWAY_SECONDS


def unoffered_saves(quiet_saves: list[str], offered: list[str]) -> list[str]:
    return [s for s in quiet_saves if s not in offered]


def hard_rules(
    ctx: dict[str, Any],
    *,
    hour: int,
    quiet_hours: str | None,
    since_last_say: float | None,
    is_sleep_decision: bool = False,
) -> tuple[bool, str]:
    """May the avatar say something unprompted now? Returns (allowed, reason). Cheap checks only."""
    if ctx.get("asleep"):
        return False, "asleep"
    if ctx.get("doNotDisturb"):
        return False, "do not disturb"
    if ctx.get("conversationActive") or ctx.get("voicePhase") in BUSY_PHASES:
        return False, "in a conversation"
    for key in ("secondsSinceKevinSpoke", "secondsSinceAvatarSpoke"):
        v = ctx.get(key)
        if v is not None and v < RECENT_SPEECH_SECONDS:
            return False, "someone spoke a moment ago"
    if not is_sleep_decision and in_quiet_hours(parse_quiet_hours(quiet_hours), hour):
        return False, "quiet hours"
    if since_last_say is not None and since_last_say < MIN_SAY_GAP_SECONDS:
        return False, "spoke unprompted less than 20 minutes ago"
    return True, "ok"


def is_new_day_plan_time(ctx: dict[str, Any], local_date: str, hour: int, last_plan_date: str | None) -> bool:
    """Morning plan: a new local date, after 06:00, and Kevin was seen or spoke in the last 10 minutes."""
    if last_plan_date == local_date or hour < PLAN_AFTER_HOUR:
        return False
    for key in ("secondsSinceFaceSeen", "secondsSinceKevinSpoke"):
        v = ctx.get(key)
        if v is not None and v <= PLAN_SEEN_SECONDS:
            return True
    return False


def is_reflect_time(local_date: str, hour: int, quiet_hours: str | None, last_reflect_date: str | None) -> bool:
    """Evening reflection: the first tick at or after the start of quiet hours on each date."""
    q = parse_quiet_hours(quiet_hours)
    if not q or last_reflect_date == local_date:
        return False
    start, end = q
    if start < end:
        return hour >= start and hour < end
    return hour >= start or hour < end


def fmt_age(seconds: float | None) -> str:
    if seconds is None:
        return "not for a long time"
    s = int(seconds)
    if s < 90:
        return f"{s} seconds ago"
    if s < 90 * 60:
        return f"{round(s / 60)} minutes ago"
    return f"{s / 3600:.1f} hours ago"


def _lines(title: str, items: list[str]) -> list[str]:
    return [title, *[f"- {i}" for i in items]] if items else []


def describe_intention(row: dict[str, Any]) -> str:
    text = row.get("text") or ""
    kind = row.get("kind") or "intention"
    due = row.get("due_at") or row.get("dueAt")
    return f"[{kind}] {text}" + (f" (due {due})" if due else "")


def _context_lines(name: str, ctx: dict[str, Any], hours_awake: float, extras: dict[str, Any]) -> list[str]:
    who = []
    if ctx.get("secondsSinceFaceSeen") is not None and ctx["secondsSinceFaceSeen"] <= FACE_NOW_SECONDS:
        who.append("Kevin is in view of the camera")
    elif ctx.get("secondsSinceFaceSeen") is not None:
        who.append(f"Kevin was last seen {fmt_age(ctx['secondsSinceFaceSeen'])}")
    else:
        who.append("nobody has been seen lately")
    if ctx.get("secondsSinceKevinSpoke") is not None:
        who.append(f"Kevin last spoke {fmt_age(ctx['secondsSinceKevinSpoke'])}")
    lines = [
        f"It is {ctx.get('localTime', 'unknown time')} and you are in the {ctx.get('place', 'house')}.",
        f"Around you: {'; '.join(who)}.",
        f"You have been awake for {hours_awake:.1f} hours.",
    ]
    if extras.get("arrival_minutes"):
        lines.append(f"Kevin has just come back after about {extras['arrival_minutes']} minutes away.")
    return lines


def decision_prompt(
    name: str,
    ctx: dict[str, Any],
    *,
    hours_awake: float,
    intentions: list[str],
    flows: list[str],
    quiet_saves: list[str],
    offers: list[dict[str, Any]],
    arrival_minutes: int | None = None,
    can_say: bool = True,
) -> str:
    """The first-person prompt for one decision. It asks for exactly one reply line."""
    lines = [f"This is a quiet moment in your day, {name}. Nobody is asking you for anything."]
    lines += _context_lines(name, ctx, hours_awake, {"arrival_minutes": arrival_minutes})
    lines += _lines("Things you are keeping in mind:", intentions)
    lines += _lines("Workflows you have written:", flows)
    lines += _lines("Things that were saved quietly while you were busy:", [f'"{s}"' for s in quiet_saves])
    if offers:
        lines += _lines(
            "You could read or look at:",
            [f"{o.get('label', o.get('stationId'))} (id {o.get('stationId')})" for o in offers],
        )
    lines += [
        "",
        "If you want to, use your tools first (set an intention, write or run a workflow, set a reminder).",
        "Then end with exactly one line, and nothing after it, in one of these forms:",
    ]
    if can_say:
        lines.append("SAY: <one short sentence you say out loud now>")
    if offers:
        lines.append("READ: <the id of what you want to read or look at>")
    lines += [
        "SLEEP",
        "NOTHING",
        "Choosing NOTHING is fine and is usually right. Only speak when you have a real reason.",
    ]
    return "\n".join(lines)


def plan_prompt(name: str, ctx: dict[str, Any], *, hours_awake: float, intentions: list[str], flows: list[str]) -> str:
    lines = [f"A new day is starting, {name}."]
    lines += _context_lines(name, ctx, hours_awake, {})
    lines += _lines("Things you are keeping in mind:", intentions)
    lines += _lines("Workflows you have written:", flows)
    lines += [
        "",
        "Plan your day. Pick one to three things you want to do or look into and record each with your set_intention tool.",
        "Reply with one short line saying what you chose.",
    ]
    return "\n".join(lines)


def reflect_prompt(
    name: str, ctx: dict[str, Any], *, hours_awake: float, intentions: list[str], flows: list[str]
) -> str:
    lines = [f"The day is winding down, {name}."]
    lines += _context_lines(name, ctx, hours_awake, {})
    lines += _lines("Things you are keeping in mind:", intentions)
    lines += _lines("Workflows you have written:", flows)
    lines += [
        "",
        "Reflect on the day. What went well, what is left over, what should you carry into tomorrow?",
        "Use your tools to note something for next time, mark things done or drop them, and adjust your goals or workflows.",
        "End with exactly one line: SLEEP if you want to go to sleep now, otherwise NOTHING.",
    ]
    return "\n".join(lines)


def wakeme_prompt(note: str) -> str:
    return (
        f"You asked to be reminded to look at this: {note}\n"
        "Do it now. Use your tools if you need them. If you have something to tell Kevin, end with one line "
        "'SAY: <one short sentence>'. Otherwise end with NOTHING."
    )


_REPLY = re.compile(r"^\s*(SAY|READ)\s*:\s*(.+?)\s*$|^\s*(SLEEP|NOTHING)\s*\.?\s*$", re.IGNORECASE)


def parse_reply(text: str | None) -> tuple[str, str]:
    """The last line of the reply as (action, argument). Action is SAY, READ, SLEEP or NOTHING; anything else is NOTHING.

    The model may think aloud first, so only the last non-empty line counts."""
    for raw in reversed((text or "").strip().splitlines()):
        line = raw.strip().strip("`*_ ")
        if not line:
            continue
        m = _REPLY.match(line)
        if not m:
            return "NOTHING", ""
        if m.group(3):
            return m.group(3).upper(), ""
        arg = m.group(2).strip().strip('"').strip("“”").strip()
        return (m.group(1).upper(), arg) if arg else ("NOTHING", "")
    return "NOTHING", ""


def clip(text: str, limit: int = 200) -> str:
    t = " ".join(text.split())
    return t if len(t) <= limit else t[: limit - 1] + "…"
