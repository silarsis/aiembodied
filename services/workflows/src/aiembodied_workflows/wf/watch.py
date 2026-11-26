"""Watch: wait for something to happen (a sensor, a search result, a service, a coding task), then do something."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.workflow import ParentClosePolicy

from .. import conditions as cnd
from .. import life_rules as rules
from ..activities import format_results
from ..attrs import search_attrs
from ..settings import TASK_QUEUE
from ..timeutil import parse_iso
from .common import Controllable, best_effort, patch_intention, say_line, try_act, ts, wait_changed, wlog
from .flow import FlowInput, flow_workflow_id

RUNAWAY_SECONDS = 55


@dataclass
class WatchInput:
    avatar_id: str
    condition: dict[str, Any]
    then: dict[str, Any]
    until_at: str | None = None  # ISO; None = no end (flow watchers)
    intention_id: str | None = None
    flow_name: str | None = None  # set for a flow's own watcher: it loops and starts the flow each time
    config: dict[str, Any] = field(default_factory=dict)


@workflow.defn(name="Watch")
class Watch(Controllable):
    def __init__(self) -> None:
        self._init_control()
        self.home_events: list[dict] = []
        self.task_events: list[dict] = []
        self.condition: dict = {}
        self.flow_name: str | None = None

    @workflow.signal
    def home_change(self, payload: dict) -> None:
        self.home_events.append(payload or {})
        self.rev += 1

    @workflow.signal
    def task_status(self, payload: dict) -> None:
        self.task_events.append(payload or {})
        self.rev += 1

    @workflow.query(name="info")
    def info(self) -> dict:
        return {"condition": self.condition, "flowName": self.flow_name}

    @workflow.run
    async def run(self, inp: WatchInput) -> str:
        self.condition, self.flow_name = inp.condition, inp.flow_name
        cond, loop = inp.condition, inp.flow_name is not None
        kind = cond.get("kind")
        until = parse_iso(inp.until_at).timestamp() if inp.until_at else None
        await say_line("started", f"watching until {inp.until_at or 'stopped'}: {cnd.describe(cond)}", inp.avatar_id)

        hold = cnd.Hold(float(cond.get("forSeconds", 0) or 0))
        matched, armed = False, True
        h_scan = t_scan = 0
        first_urls: list[str] = []
        next_poll = 0.0
        last_fire: float | None = None
        if kind == "search":
            first = await best_effort("web_search", cond["query"]) or []
            first_urls = cnd.result_urls(first)
            wlog(f"first look at \"{cond['query']}\": {len(first_urls)} results")
            next_poll = ts() + cnd.poll_seconds(cond)

        while True:
            t = ts()
            if until is not None and t >= until:
                await say_line("completed", f"watch ended without firing: {cnd.describe(cond)}", inp.avatar_id)
                await patch_intention(inp.intention_id, {"status": "dropped", "outcome": "expired without firing"})
                return "expired"
            if self.paused:
                await wait_changed(lambda: self.rev, self.rev, None if until is None else until - t)
                continue

            info: str | None = None
            if kind == "entity":
                eid = cond["entityId"]
                if t >= next_poll:
                    rows = await best_effort("mem_home_entities", None) or []
                    next_poll = ts() + cnd.ENTITY_POLL_SECONDS
                    for r in rows:
                        if r.get("entity_id") == eid:
                            v = r.get("value") if ("below" in cond or "above" in cond) and r.get("value") is not None else r.get("state")
                            matched = cnd.entity_matches(cond, v)
                            info = f"{eid} is {r.get('state')}"
                while h_scan < len(self.home_events):
                    ev = self.home_events[h_scan]
                    h_scan += 1
                    if ev.get("entity_id") == eid:
                        matched = cnd.entity_matches(cond, ev.get("new"))
                        info = ev.get("text") or f"{eid} is now {cnd.entity_state_of(ev.get('new'))}"
                if not matched:
                    armed = True
                held = hold.update(ts(), matched)
                fired = matched and held and armed and ts() >= self.snooze_until
                info = info or cnd.describe(cond)
            elif kind == "search":
                fired = False
                if t >= next_poll:
                    results = await best_effort("web_search", cond["query"]) or []
                    next_poll = ts() + cnd.poll_seconds(cond)
                    new = cnd.new_results(first_urls, results)
                    if new and ts() >= self.snooze_until:
                        fired, info = True, format_results(new, 3)
                        first_urls += cnd.result_urls(new)
            elif kind == "service":
                fired = False
                if t >= next_poll:
                    status = await best_effort("probe_url", cond["url"])
                    next_poll = ts() + cnd.poll_seconds(cond)
                    down = cnd.service_is_down(status)
                    wlog(f"checked {cond['url']}: {status if status is not None else 'no answer'}")
                    if not down:
                        armed = True
                    elif armed and ts() >= self.snooze_until:
                        fired, info = True, f"{cond['url']} is down ({status if status is not None else 'no answer'})"
            else:  # coding_task
                fired = False
                while t_scan < len(self.task_events):
                    ev = self.task_events[t_scan]
                    t_scan += 1
                    if cnd.task_finished(ev):
                        fired = True
                        info = f"coding task {cond.get('taskId')} is {ev.get('state') or ev.get('status')}"
                        if ev.get("summary") or ev.get("text"):
                            info += f": {ev.get('summary') or ev.get('text')}"

            if fired:
                armed = False
                if loop and last_fire is not None and ts() - last_fire < RUNAWAY_SECONDS:
                    await say_line("failed", f"watch for flow {inp.flow_name} fired twice within a minute; stopping it",
                                   inp.avatar_id, "warning")
                    await best_effort("flow_runaway", {"avatarId": inp.avatar_id, "name": inp.flow_name, "source": "watch",
                                                       "gap": ts() - last_fire})
                    return "stopped: runaway"
                last_fire = ts()
                await say_line("fired", f"watch matched: {info}", inp.avatar_id)
                outcome = await self._then(inp, info or "")
                if not loop:
                    await patch_intention(inp.intention_id, {"status": "done", "outcome": f"fired: {outcome}"})
                    return outcome
                continue

            # sleep until something may change
            waits = []
            if until is not None:
                waits.append(until - ts())
            if kind in ("entity", "search", "service"):
                waits.append(next_poll - ts())
            if kind == "entity" and hold.remaining(ts()) is not None:
                waits.append(hold.remaining(ts()))
            wait = max(min(waits), 0.001) if waits else None
            await wait_changed(lambda: self.rev, self.rev, wait)

    async def _then(self, inp: WatchInput, info: str) -> str:
        avatar, then = inp.avatar_id, inp.then or {}
        if inp.flow_name:
            return await self._start_flow(inp, inp.flow_name, {"trigger_info": info}, "watch")
        if "say" in then:
            r = await try_act(avatar, "say", {"text": str(then["say"]), "urgent": True, "source": "a watch"})
            return "said it" if r.ok else f"could not say it: {r.error}"
        if "think" in then:
            prompt = f"{then['think']}\n\n(What just happened: {info}.)\nIf you have something to say, end with one line 'SAY: <one short sentence>'. Otherwise end with NOTHING."
            r = await try_act(avatar, "think", {"prompt": prompt, "tools": "safe"})
            if not r.ok:
                wlog(f"watch thinking failed: {r.error}", "warning")
                return f"think failed: {r.error}"
            action, arg = rules.parse_reply(r.data.get("text"))
            if action == "SAY":
                await try_act(avatar, "say", {"text": arg, "urgent": False, "source": "a watch"})
                return f'said "{rules.clip(arg, 80)}"'
            return "thought about it"
        if "flow" in then:
            return await self._start_flow(inp, str(then["flow"]), {**(then.get("inputs") or {}), "trigger_info": info}, "then")
        return "nothing to do"

    async def _start_flow(self, inp: WatchInput, name: str, inputs: dict, source: str) -> str:
        fid = flow_workflow_id(inp.avatar_id, name, str(workflow.uuid4()))
        await workflow.start_child_workflow(
            "AgentFlow", FlowInput(inp.avatar_id, name, inputs, source, 0, inp.config), id=fid,
            task_queue=TASK_QUEUE, parent_close_policy=ParentClosePolicy.ABANDON,
            search_attributes=search_attrs(inp.avatar_id, "flow", "agent", name))
        wlog(f"started flow {name} as {fid}")
        return f"started flow {name}"
