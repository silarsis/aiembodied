"""AgentLife: one avatar's life. A workflow with a one-minute heartbeat that decides when to speak, plan, reflect and sleep."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from temporalio import workflow

from .. import life_rules as rules
from ..settings import HOST_AVATAR
from ..timeutil import iso_z
from .common import best_effort, journal, now, say_line, try_act, ts, wlog

MAX_TICKS_BEFORE_CONTINUE = 200


@dataclass
class LifeState:
    awake_seconds: float = 0.0
    asleep: bool = False
    sleep_until: float = 0.0
    last_tick: float | None = None
    last_say: float | None = None
    last_face: float | None = None
    next_decision: float | None = None
    last_decision_at: str | None = None
    last_decision_summary: str | None = None
    mood: str | None = None
    last_plan_date: str | None = None
    last_reflect_date: str | None = None
    offered_saves: list[str] = field(default_factory=list)
    pending_arrival_minutes: int | None = None
    pending_arrival_at: float | None = None
    ticks: int = 0
    offline: bool = False
    last_skip: str | None = None


@dataclass
class LifeInput:
    avatar_id: str
    name: str = ""
    config: dict[str, Any] = field(default_factory=dict)
    state: LifeState | None = None


def _iso(t: float | None) -> str | None:
    return iso_z(datetime.fromtimestamp(t, timezone.utc)) if t else None


@workflow.defn(name="AgentLife")
class AgentLife:
    def __init__(self) -> None:
        self.s = LifeState()
        self.avatar = ""
        self.name = ""
        self.cfg: dict[str, Any] = {}
        self.paused = False
        self.interaction = False
        self.wake_req: str | None = None
        self.sleep_req: str | None = None
        self.rev = 0

    # --- signals and query ------------------------------------------------------------------------
    @workflow.signal(name="interaction")
    def _interaction(self, payload: dict | None = None) -> None:
        self.interaction = True
        self.rev += 1

    @workflow.signal(name="spoke")
    def _spoke(self, payload: dict | None = None) -> None:
        wlog("heard itself speak")
        self.rev += 1

    @workflow.signal(name="sleep")
    def _sleep(self, reason: str | dict | None = None) -> None:
        text = reason.get("reason") if isinstance(reason, dict) else reason
        self.sleep_req = text or "asked to sleep"
        self.rev += 1

    @workflow.signal(name="wake")
    def _wake(self, payload: dict | None = None) -> None:
        self.wake_req = "woken"
        self.rev += 1

    @workflow.signal(name="pause")
    def _pause(self) -> None:
        self.paused = True
        wlog("paused")
        self.rev += 1

    @workflow.signal(name="resume")
    def _resume(self) -> None:
        self.paused = False
        wlog("resumed")
        self.rev += 1

    @workflow.query(name="state")
    def state(self) -> dict:
        s = self.s
        return {
            "awake": not s.asleep,
            "awakeSeconds": int(s.awake_seconds),
            "nextDecisionAt": _iso(s.next_decision),
            "lastDecision": {"at": s.last_decision_at, "summary": s.last_decision_summary}
            if s.last_decision_at
            else None,
            "mood": s.mood,
            "lastPlanDate": s.last_plan_date,
            "lastReflectDate": s.last_reflect_date,
            "paused": self.paused,
        }

    # --- the loop ---------------------------------------------------------------------------------
    @workflow.run
    async def run(self, inp: LifeInput) -> None:
        self.avatar, self.name, self.cfg = inp.avatar_id, inp.name or inp.avatar_id, inp.config or {}
        if inp.state is None:
            await self._restore()
            await say_line("started", f"life of {self.name} started", self.avatar)
        else:
            self.s = inp.state
            wlog(f"life of {self.name} continues ({self.s.ticks} ticks so far)")
        next_tick = ts()
        while True:
            if self.paused:
                await workflow.wait_condition(lambda: not self.paused)
                continue
            await self._handle_signals()
            if ts() >= next_tick:
                await self._tick()
                next_tick = ts() + rules.TICK_SECONDS
                if self.s.ticks >= MAX_TICKS_BEFORE_CONTINUE or workflow.info().is_continue_as_new_suggested():
                    await workflow.wait_condition(workflow.all_handlers_finished)
                    wlog(f"continuing as new after {self.s.ticks} ticks")
                    self.s.ticks = 0
                    workflow.continue_as_new(LifeInput(self.avatar, self.name, self.cfg, self.s))
            seen = self.rev
            try:
                await workflow.wait_condition(
                    lambda: self.rev != seen or self.paused, timeout=timedelta(seconds=max(next_tick - ts(), 0.05))
                )
            except asyncio.TimeoutError:
                pass

    async def _restore(self) -> None:
        ctx = await best_effort("mem_decision_context", self.avatar)
        st = (ctx or {}).get("agentState") or {}
        if st.get("asleep"):
            since = st.get("last_sleep_at")
            try:
                t0 = datetime.fromisoformat(since.replace("Z", "+00:00")).timestamp() if since else ts()
            except ValueError:
                t0 = ts()
            self.s.asleep = True
            self.s.sleep_until = t0 + float(self.cfg.get("sleepHours", 7)) * 3600
            wlog("memory says this avatar was asleep; staying asleep until it is time")

    async def _handle_signals(self) -> None:
        if self.sleep_req is not None:
            reason, self.sleep_req = self.sleep_req, None
            if not self.s.asleep:
                await self._go_to_sleep(reason)
        if self.s.asleep and (self.wake_req or self.interaction):
            reason = "Kevin spoke to it" if self.interaction and not self.wake_req else (self.wake_req or "woken")
            self.wake_req = None
            await self._wake_up(reason)
        if self.interaction:
            self.interaction = False
            self.s.next_decision = None  # idle starts over after an interaction
        self.wake_req = None

    # --- sleep and wake -----------------------------------------------------------------------------
    async def _go_to_sleep(self, reason: str) -> None:
        hours = float(self.cfg.get("sleepHours", 7))
        self.s.asleep = True
        self.s.sleep_until = ts() + hours * 3600
        await try_act(self.avatar, "sleep_state", {"asleep": True, "reason": reason})
        await say_line(
            "sleep",
            f"sleeping: {reason} (until about {datetime.fromtimestamp(self.s.sleep_until, timezone.utc):%H:%M} UTC)",
            self.avatar,
        )
        await best_effort("mem_run_summaries", None, seconds=300)
        await best_effort(
            "mem_put_agent_state", {"avatarId": self.avatar, "state": {"asleep": True, "last_sleep_at": iso_z(now())}}
        )

    async def _wake_up(self, reason: str) -> None:
        self.s.asleep = False
        self.s.awake_seconds = 0.0
        self.s.next_decision = None
        self.s.last_tick = None
        await try_act(self.avatar, "sleep_state", {"asleep": False, "reason": reason})
        await say_line("wake", f"waking up: {reason}", self.avatar)
        await best_effort(
            "mem_put_agent_state",
            {
                "avatarId": self.avatar,
                "state": {"asleep": False, "awake_since": iso_z(now()), "last_wake_at": iso_z(now())},
            },
        )

    # --- one tick ---------------------------------------------------------------------------------
    async def _tick(self) -> None:
        s = self.s
        s.ticks += 1
        res = await try_act(self.avatar, "context")
        t = ts()
        if not res.ok:
            if res.offline and not s.offline:
                wlog("app is not running; waiting (awake time is not counted)")
            elif not res.offline:
                wlog(f"context failed: {res.error}", "warning")
            s.offline = True
            s.last_tick = t
            return
        if s.offline:
            wlog("app is back")
        s.offline = False
        ctx = res.data
        if not s.asleep and s.last_tick is not None:
            s.awake_seconds += min(max(t - s.last_tick, 0.0), rules.MAX_TICK_CREDIT)
        s.last_tick = t

        if s.asleep:
            if not ctx.get("asleep"):  # the app lost its sleep flag (it restarted)
                await try_act(self.avatar, "sleep_state", {"asleep": True, "reason": "still asleep"})
            if t >= s.sleep_until:
                await self._wake_up("slept long enough")
            return
        limit = float(self.cfg.get("sleepAfterHours", 24)) * 3600
        if s.awake_seconds > limit:
            await self._go_to_sleep(f"awake more than {self.cfg.get('sleepAfterHours', 24):g} hours")
            return
        if ctx.get("asleep"):  # the app thinks it sleeps, we do not
            await try_act(self.avatar, "sleep_state", {"asleep": False, "reason": "awake"})

        await self._maybe_return_home(ctx)
        arrival = self._note_arrival(ctx, t)
        local_date = str(ctx.get("localTime", ""))[:10]
        hour = int(ctx.get("hour", 12))
        quiet = self.cfg.get("quietHours")

        if rules.is_reflect_time(local_date, hour, quiet, s.last_reflect_date):
            if rules.hard_rules(ctx, hour=hour, quiet_hours=quiet, since_last_say=None, is_sleep_decision=True)[0]:
                await self._reflect(ctx, local_date)
                return
        if (
            rules.is_new_day_plan_time(ctx, local_date, hour, s.last_plan_date)
            and rules.hard_rules(ctx, hour=hour, quiet_hours=quiet, since_last_say=None)[0]
        ):
            await self._plan(ctx, local_date)
            return
        await self._maybe_decide(ctx, t, hour, quiet, arrival)

    async def _maybe_return_home(self, ctx: dict) -> None:
        if ctx.get("place") != "next-door":
            return
        chance = rules.return_home_chance(ctx.get("restlessness"))
        if chance > 0 and workflow.random().random() < chance:
            r = await try_act(self.avatar, "return_home")
            if r.ok:
                wlog(f"going home from next door: {'moved' if r.data.get('moved') else r.data.get('reason', 'stayed')}")
                await journal("step", f"{self.name} tried to go home from next door", self.avatar)

    def _note_arrival(self, ctx: dict, t: float) -> bool:
        if self.avatar != HOST_AVATAR:
            return False
        sec = ctx.get("secondsSinceFaceSeen")
        if sec is None:
            return False
        seen_at = t - float(sec)
        arrival = False
        if float(sec) <= rules.FACE_NOW_SECONDS:
            gap = seen_at - self.s.last_face if self.s.last_face is not None else None
            arrival = rules.is_arrival(float(sec), gap)
            if arrival:
                minutes = round(gap / 60)
                self.s.pending_arrival_minutes, self.s.pending_arrival_at = minutes, t
                wlog(f"arrival: a face after {minutes} minutes away")
        if self.s.last_face is None or seen_at > self.s.last_face:
            self.s.last_face = seen_at
        return arrival

    # --- decisions ----------------------------------------------------------------------------------
    def _interval(self, ctx: dict) -> float | None:
        return rules.decision_interval_seconds(ctx.get("restlessness"), workflow.random().random())

    async def _maybe_decide(self, ctx: dict, t: float, hour: int, quiet: str | None, arrival: bool) -> None:
        s = self.s
        if ctx.get("restlessness") is None:
            s.next_decision = None
            return
        if s.pending_arrival_at is not None and t - s.pending_arrival_at > 600:
            s.pending_arrival_minutes = s.pending_arrival_at = None
        saves = [x for x in ctx.get("quietSaves") or [] if x not in s.offered_saves]
        if s.next_decision is None:
            s.next_decision = t + (self._interval(ctx) or 600)
            wlog(f"next decision at about {datetime.fromtimestamp(s.next_decision, timezone.utc):%H:%M:%S} UTC")
        due = t >= s.next_decision or s.pending_arrival_minutes is not None or bool(saves)
        if not due:
            return
        since_say = t - s.last_say if s.last_say is not None else None
        ok, why = rules.hard_rules(ctx, hour=hour, quiet_hours=quiet, since_last_say=since_say)
        if not ok:
            if s.last_skip != why:
                wlog(f"decision waiting: {why}")
                s.last_skip = why
            return
        s.last_skip = None
        await self._decide(ctx, t, saves)

    async def _decide(self, ctx: dict, t: float, saves: list[str]) -> None:
        s = self.s
        mem = await best_effort("mem_decision_context", self.avatar) or {}
        intentions = [rules.describe_intention(r) for r in mem.get("intentions") or []][:12]
        flows = [f"{f.get('name')}: {f.get('description') or ''}".strip() for f in mem.get("flows") or []][:12]
        arrival_minutes = s.pending_arrival_minutes
        prompt = rules.decision_prompt(
            self.name,
            ctx,
            hours_awake=s.awake_seconds / 3600,
            intentions=intentions,
            flows=flows,
            quiet_saves=saves,
            offers=ctx.get("pursuitOffers") or [],
            arrival_minutes=arrival_minutes,
        )
        why = "arrival" if arrival_minutes is not None else "saved notes" if saves else "time"
        wlog(f"deciding ({why})")
        t0 = now()
        res = await try_act(self.avatar, "think", {"prompt": prompt, "tools": "safe"})
        took = (now() - t0).total_seconds()
        if res.busy:
            # A live conversation is on: try again at the next tick.
            s.next_decision = t
            wlog("decision postponed: a conversation is on")
            return
        s.offered_saves = (s.offered_saves + saves)[-20:]
        s.pending_arrival_minutes = s.pending_arrival_at = None
        s.next_decision = ts() + (self._interval(ctx) or 600)
        if not res.ok:
            await say_line("decision", f"decision failed: {res.error} (think {took:.1f} s)", self.avatar, "warning")
            return
        action, arg = rules.parse_reply(res.data.get("text"))
        summary = action + (f' "{rules.clip(arg, 120)}"' if arg else "")
        s.last_decision_at, s.last_decision_summary = iso_z(now()), summary
        await say_line("decision", f"decision: {summary} (think {took:.1f} s)", self.avatar)
        if action == "SAY":
            r = await try_act(self.avatar, "say", {"text": arg, "urgent": False, "source": "own thoughts"})
            s.last_say = ts()
            wlog("said it" if r.ok else f"could not say it: {r.error}")
        elif action == "READ":
            r = await try_act(self.avatar, "start_pursuit", {"stationId": arg})
            wlog(f"started reading {arg}: {'ok' if r.data.get('ok', r.ok) else r.data.get('reason', r.error)}")
        elif action == "SLEEP":
            await self._go_to_sleep("chose to sleep")

    async def _plan(self, ctx: dict, local_date: str) -> None:
        s = self.s
        s.last_plan_date = local_date
        mem = await best_effort("mem_decision_context", self.avatar) or {}
        prompt = rules.plan_prompt(
            self.name,
            ctx,
            hours_awake=s.awake_seconds / 3600,
            intentions=[rules.describe_intention(r) for r in mem.get("intentions") or []][:12],
            flows=[f.get("name", "") for f in mem.get("flows") or []][:12],
        )
        await say_line("step", f"morning plan for {local_date}", self.avatar)
        t0 = now()
        res = await try_act(self.avatar, "think", {"prompt": prompt, "tools": "safe"})
        took = (now() - t0).total_seconds()
        if res.ok:
            await say_line(
                "step", f"plan: {rules.clip(str(res.data.get('text', '')), 160)} (think {took:.1f} s)", self.avatar
            )
        else:
            wlog(f"morning plan failed: {res.error}", "warning")

    async def _reflect(self, ctx: dict, local_date: str) -> None:
        s = self.s
        s.last_reflect_date = local_date
        mem = await best_effort("mem_decision_context", self.avatar) or {}
        prompt = rules.reflect_prompt(
            self.name,
            ctx,
            hours_awake=s.awake_seconds / 3600,
            intentions=[rules.describe_intention(r) for r in mem.get("intentions") or []][:12],
            flows=[f.get("name", "") for f in mem.get("flows") or []][:12],
        )
        await say_line("step", f"evening reflection for {local_date}", self.avatar)
        t0 = now()
        res = await try_act(self.avatar, "think", {"prompt": prompt, "tools": "safe"})
        took = (now() - t0).total_seconds()
        if not res.ok:
            wlog(f"reflection failed: {res.error}", "warning")
            return
        action, _ = rules.parse_reply(res.data.get("text"))
        await say_line("step", f"reflection done: {action} (think {took:.1f} s)", self.avatar)
        if action == "SLEEP":
            await self._go_to_sleep("chose to sleep after reflecting")
