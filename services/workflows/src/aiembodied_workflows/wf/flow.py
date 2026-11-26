"""AgentFlow: runs an agent-built flow definition through the interpreter, with activities, timers and signals."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RawValue, RetryPolicy
from temporalio.exceptions import ApplicationError

from .. import conditions
from ..activities import format_results
from ..attrs import search_attrs
from ..flowdef import validate_definition
from ..interpreter import FlowError, run_steps
from ..settings import TASK_QUEUE
from ..timeutil import get_tz, next_local_time, parse_iso
from .common import Controllable, best_effort, journal, now, try_act, ts, wait_changed, wlog

MAX_DEPTH = 5
RUNAWAY_SECONDS = 55


@dataclass
class FlowInput:
    avatar_id: str
    name: str
    inputs: dict[str, Any] = field(default_factory=dict)
    source: str = "manual"  # manual | schedule | watch | then | child
    depth: int = 0
    config: dict[str, Any] = field(default_factory=dict)


def flow_workflow_id(avatar_id: str, name: str, unique: str) -> str:
    return f"flow:{avatar_id}:{name}:{unique}"


def seconds_between(a_iso: str | None, b: datetime) -> float | None:
    if not a_iso:
        return None
    try:
        return (b - parse_iso(a_iso)).total_seconds()
    except ValueError:
        return None


class WorkflowRunner:
    """The interpreter's Runner, built from activities."""

    def __init__(self, wf: AgentFlow, inp: FlowInput):
        self.wf, self.inp, self.avatar = wf, inp, inp.avatar_id
        self.tz = get_tz(inp.config.get("timezone"))

    async def think(self, prompt: str, tools: bool) -> str:
        r = await try_act(self.avatar, "think", {"prompt": prompt, "tools": "safe" if tools else "none"})
        if not r.ok:
            raise FlowError(f"think failed: {r.error}")
        return str(r.data.get("text", ""))

    async def recall(self, query: str) -> str:
        return await best_effort("mem_search", {"query": query, "agent": self.avatar}) or "(memory unavailable)"

    async def remember(self, text: str) -> None:
        await best_effort("mem_put_fact", {"text": text, "avatarId": self.avatar})

    async def search(self, query: str) -> str:
        try:
            res = await workflow.execute_activity(
                "web_search",
                query,
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as exc:  # noqa: BLE001
            return f"(search failed: {exc})"
        return format_results(res)

    async def tool(self, name: str, params: dict[str, Any]) -> str:
        r = await try_act(self.avatar, "tool", {"name": name, "params": params})
        if not r.ok:
            return json.dumps({"ok": False, "error": r.error})
        return json.dumps(r.data)

    async def say(self, text: str, urgent: bool) -> None:
        r = await try_act(self.avatar, "say", {"text": text, "urgent": urgent, "source": f"flow {self.inp.name}"})
        if not r.ok:
            wlog(f"say failed: {r.error}", "warning")

    async def ask(self, question: str) -> bool:
        r = await try_act(self.avatar, "ask", {"question": question})
        return bool(r.ok and r.data.get("approved"))

    async def wait_seconds(self, seconds: float) -> None:
        if seconds > 0:
            await workflow.sleep(seconds)

    async def wait_until(self, until: str) -> None:
        try:
            if ":" in until and "T" not in until and "-" not in until:
                due = next_local_time(now(), until, self.tz)
            else:
                due = parse_iso(until)
        except ValueError as exc:
            raise FlowError(f"wait until {until!r}: {exc}") from exc
        delay = (due - now()).total_seconds()
        if delay > 0:
            await workflow.sleep(delay)

    async def wait_for_entity(self, entity_id: str, state: str, timeout: float) -> bool:
        return await self.wf.wait_entity(entity_id, state, timeout)

    async def wait_for_signal(self, name: str, timeout: float) -> bool:
        return await self.wf.wait_named_signal(name, timeout)

    async def run_flow(self, name: str, inputs: dict[str, Any]) -> str:
        if self.inp.depth + 1 > MAX_DEPTH:
            raise FlowError(f"run_flow {name}: nested more than {MAX_DEPTH} flows deep")
        child = FlowInput(self.avatar, name, inputs, "child", self.inp.depth + 1, self.inp.config)
        return await workflow.execute_child_workflow(
            "AgentFlow",
            child,
            id=flow_workflow_id(self.avatar, name, str(workflow.uuid4())),
            task_queue=TASK_QUEUE,
            result_type=str,
            search_attributes=search_attrs(self.avatar, "flow", "agent", name),
        )

    async def set_intention(self, text: str, kind: str) -> None:
        await best_effort(
            "mem_create_intention", {"avatar_id": self.avatar, "kind": kind, "text": text, "status": "open"}
        )

    async def step_done(self, label: str, kind: str, result: str) -> None:
        wlog(f"step {label} {kind} -> {result}")
        await journal("step", f"{self.inp.name} step {label} {kind} -> {result}", self.avatar)
        if self.wf.paused:
            wlog("waiting while paused")
            await workflow.wait_condition(lambda: not self.wf.paused)
        if self.wf.snooze_until > ts():
            await workflow.sleep(self.wf.snooze_until - ts())


@workflow.defn(name="AgentFlow")
class AgentFlow(Controllable):
    def __init__(self) -> None:
        self._init_control()
        self.home_events: list[dict] = []
        self.named: dict[str, int] = {}

    @workflow.signal
    def home_change(self, payload: dict) -> None:
        self.home_events.append(payload or {})
        self.rev += 1

    @workflow.signal(dynamic=True)
    def other_signal(self, name: str, args: Sequence[RawValue]) -> None:
        self.named[name] = self.named.get(name, 0) + 1
        wlog(f"signal received: {name}")
        self.rev += 1

    async def wait_named_signal(self, name: str, timeout: float) -> bool:
        before = self.named.get(name, 0)
        deadline = ts() + timeout
        while self.named.get(name, 0) <= before:
            left = deadline - ts()
            if left <= 0:
                return False
            await wait_changed(lambda: self.rev, self.rev, left)
        return True

    async def wait_entity(self, entity_id: str, state: str, timeout: float) -> bool:
        deadline = ts() + timeout
        cond = {"kind": "entity", "entityId": entity_id, "state": state}
        scanned = len(self.home_events)
        next_poll = 0.0
        while True:
            if ts() >= next_poll:
                rows = await best_effort("mem_home_entities", None) or []
                next_poll = ts() + conditions.ENTITY_POLL_SECONDS
                for r in rows:
                    if r.get("entity_id") == entity_id and conditions.entity_matches(cond, r.get("state")):
                        return True
            while scanned < len(self.home_events):
                ev = self.home_events[scanned]
                scanned += 1
                if ev.get("entity_id") == entity_id and conditions.entity_matches(cond, ev.get("new")):
                    return True
            left = min(deadline, next_poll) - ts()
            if deadline - ts() <= 0:
                return False
            if left > 0:
                await wait_changed(lambda: self.rev, self.rev, left)

    @workflow.run
    async def run(self, inp: FlowInput) -> str:
        label = f"{inp.name} (from {inp.source})"
        wlog(f"started {label}")
        await journal("started", f"flow {label} started", inp.avatar_id)
        row = await workflow.execute_activity(
            "mem_get_flow",
            {"avatarId": inp.avatar_id, "name": inp.name},
            start_to_close_timeout=timedelta(seconds=30),
            result_type=dict,
        )
        if not row:
            return await self._fail(inp, f"flow {inp.name} not found")
        if row.get("enabled") is False and inp.source not in ("manual", "child"):
            return await self._fail(inp, f"flow {inp.name} is disabled")
        definition = row.get("definition") or {}
        errors = validate_definition(definition)
        if errors:
            return await self._fail(inp, "the definition is not valid: " + "; ".join(errors[:3]))
        gap = seconds_between(row.get("last_run_at"), now())
        if inp.source == "schedule" and gap is not None and 0 <= gap < RUNAWAY_SECONDS:
            await workflow.execute_activity(
                "flow_runaway",
                {"avatarId": inp.avatar_id, "name": inp.name, "source": inp.source, "gap": gap},
                start_to_close_timeout=timedelta(seconds=30),
            )
            return await self._fail(inp, f"started again after {gap:.0f} s, schedule paused", log_level="warning")
        await best_effort(
            "mem_patch_flow",
            {
                "avatarId": inp.avatar_id,
                "name": inp.name,
                "fields": {"last_run_at": now().isoformat().replace("+00:00", "Z")},
            },
        )
        variables = {**(definition.get("inputs") or {}), **(inp.inputs or {})}
        runner = WorkflowRunner(self, inp)
        try:
            result = await run_steps(definition["steps"], variables, runner)
        except FlowError as exc:
            return await self._fail(inp, str(exc))
        except asyncio.CancelledError:
            wlog(f"{label} cancelled", "warning")
            await best_effort(
                "mem_patch_flow", {"avatarId": inp.avatar_id, "name": inp.name, "fields": {"last_outcome": "cancelled"}}
            )
            raise
        outcome = f"ok after {result.executed} steps" + (f": {result.last[:120]}" if result.last else "")
        await best_effort(
            "mem_patch_flow", {"avatarId": inp.avatar_id, "name": inp.name, "fields": {"last_outcome": outcome}}
        )
        wlog(f"completed {label}: {outcome}")
        await journal("completed", f"flow {label} completed: {outcome}", inp.avatar_id)
        return result.last or "ok"

    async def _fail(self, inp: FlowInput, message: str, log_level: str = "error") -> str:
        wlog(f"failed {inp.name}: {message}", log_level)
        await journal("failed", f"flow {inp.name} failed: {message}", inp.avatar_id)
        await best_effort(
            "mem_patch_flow",
            {"avatarId": inp.avatar_id, "name": inp.name, "fields": {"last_outcome": f"failed: {message}"[:300]}},
        )
        raise ApplicationError(message, type="FlowFailed", non_retryable=True)
