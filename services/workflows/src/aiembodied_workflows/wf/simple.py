"""Reminder and WakeMe: sleep until due, then act."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from temporalio import workflow

from .. import life_rules as rules
from ..timeutil import get_tz, hhmm, iso_z, parse_iso
from .common import Controllable, patch_intention, say_line, try_act, ts, wait_changed, wlog, now

LATE_SECONDS = 10 * 60
OFFLINE_RETRY_SECONDS = 60
OFFLINE_GIVE_UP_SECONDS = 7 * 24 * 3600


@dataclass
class DueInput:
    avatar_id: str
    text: str  # the reminder text, or the wake-up note
    due_at: str  # ISO
    alarm: bool = False
    intention_id: str | None = None
    config: dict[str, Any] = field(default_factory=dict)


def reminder_text(text: str, due: datetime, fired: datetime, tz) -> str:
    """"Reminder: <text>", plus when it was due if it is more than 10 minutes late."""
    out = f"Reminder: {text}"
    if (fired - due).total_seconds() > LATE_SECONDS:
        out += f" (this was due at {hhmm(due, tz)})"
    return out


class _Timed(Controllable):
    async def _wait_until_due(self, due_ts: float) -> None:
        """Sleep until due_ts, honouring pause, resume and snooze."""
        self.due_ts = due_ts
        while True:
            if self.paused:
                seen = self.rev
                await wait_changed(lambda: self.rev, seen, None)
                continue
            if self.snooze_until > self.due_ts:
                self.due_ts = self.snooze_until
            remaining = self.due_ts - ts()
            if remaining <= 0.001:
                return
            await wait_changed(lambda: self.rev, self.rev, remaining)


@workflow.defn(name="Reminder")
class Reminder(_Timed):
    def __init__(self) -> None:
        self._init_control()

    @workflow.run
    async def run(self, inp: DueInput) -> str:
        due = parse_iso(inp.due_at)
        await say_line("started", f"reminder set for {iso_z(due)}: {inp.text}", inp.avatar_id)
        await self._wait_until_due(due.timestamp())
        tz = get_tz(inp.config.get("timezone"))
        # If the app is closed, wait for it (up to 7 days), then say it anyway.
        waited = 0
        while True:
            res = await try_act(inp.avatar_id, "context")
            if res.ok or not res.offline or waited >= OFFLINE_GIVE_UP_SECONDS:
                break
            if waited == 0:
                wlog("reminder is due but the app is not running; waiting for it")
            await workflow.sleep(OFFLINE_RETRY_SECONDS)
            waited += OFFLINE_RETRY_SECONDS
        text = reminder_text(inp.text, due, now(), tz)
        # A reminder is due now, so it is always urgent: the app speaks it at once rather than weighing it first.
        r = await try_act(inp.avatar_id, "say", {"text": text, "urgent": True, "source": "reminder"})
        for _ in range(60):  # busy = a live conversation is on: try again in a minute
            if not r.busy:
                break
            wlog("a conversation is on; saying the reminder in a minute")
            await workflow.sleep(OFFLINE_RETRY_SECONDS)
            r = await try_act(inp.avatar_id, "say", {"text": text, "urgent": True, "source": "reminder"})
        outcome = "said" if r.ok else f"not delivered: {r.error}"
        await say_line("fired", f"reminder fired: {text} ({outcome})", inp.avatar_id, "info" if r.ok else "warning")
        await patch_intention(inp.intention_id, {"status": "done", "outcome": outcome})
        return outcome


@workflow.defn(name="WakeMe")
class WakeMe(_Timed):
    def __init__(self) -> None:
        self._init_control()

    @workflow.run
    async def run(self, inp: DueInput) -> str:
        due = parse_iso(inp.due_at)
        await say_line("started", f"wake-up set for {iso_z(due)}: {inp.text}", inp.avatar_id)
        await self._wait_until_due(due.timestamp())
        await say_line("fired", f"wake-up: {inp.text}", inp.avatar_id)
        res = await try_act(inp.avatar_id, "think", {"prompt": rules.wakeme_prompt(inp.text), "tools": "safe"})
        outcome = "thought about it"
        if not res.ok:
            outcome = f"failed: {res.error}"
            wlog(f"wake-up thinking failed: {res.error}", "warning")
        else:
            action, arg = rules.parse_reply(res.data.get("text"))
            wlog(f"wake-up answer: {action}")
            if action == "SAY":
                await try_act(inp.avatar_id, "say", {"text": arg, "urgent": False, "source": "own thoughts"})
                outcome = f'said "{rules.clip(arg, 80)}"'
        await patch_intention(inp.intention_id, {"status": "done", "outcome": outcome})
        return outcome
