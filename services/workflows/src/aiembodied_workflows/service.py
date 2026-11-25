"""The service: owns the Temporal client, the workers and every operation the HTTP API and the reconcile pass need."""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from temporalio.client import (Client, Schedule, ScheduleActionStartWorkflow, ScheduleAlreadyRunningError,
                               ScheduleIntervalSpec, SchedulePolicy, ScheduleOverlapPolicy, ScheduleSpec,
                               ScheduleUpdate, WorkflowHandle)
from temporalio.common import WorkflowIDConflictPolicy
from temporalio.service import RPCError, RPCStatusCode

from . import conditions as cnd
from . import flowdef
from .activities import Activities
from .attrs import attr_value, search_attrs, AGENT_ID, PURPOSE
from .bridge import Bridge, Signal, WatchEntry, WatchIndex
from .logs import get_logger
from .memory import MemoryClient, MemoryError
from .registry import make_workers
from .settings import TASK_QUEUE, Settings
from .timeutil import due_from, iso_z, parse_iso
from .wf.flow import FlowInput, flow_workflow_id
from .wf.life import LifeInput
from .wf.simple import DueInput
from .wf.watch import WatchInput

log = get_logger("service")


class ServiceError(Exception):
    """An error the API turns into an HTTP answer."""

    def __init__(self, status: int, detail: Any):
        super().__init__(str(detail))
        self.status, self.detail = status, detail


def _not_found(exc: Exception) -> bool:
    return isinstance(exc, RPCError) and exc.status == RPCStatusCode.NOT_FOUND


def sched_id(avatar: str, name: str) -> str:
    return f"sched:{avatar}:{name}"


def watcher_id(avatar: str, name: str) -> str:
    return f"flowwatch:{avatar}:{name}"


def build_schedule(avatar: str, name: str, trigger: dict, config: dict) -> Schedule:
    """The Temporal Schedule for a flow with a schedule trigger. Overlap SKIP, catch-up window 10 minutes."""
    if "cron" in trigger:
        spec = ScheduleSpec(cron_expressions=[trigger["cron"]], time_zone_name=config.get("timezone") or None)
    else:
        spec = ScheduleSpec(intervals=[ScheduleIntervalSpec(every=timedelta(minutes=float(trigger["everyMinutes"])))])
    action = ScheduleActionStartWorkflow(
        "AgentFlow", FlowInput(avatar, name, {}, "schedule", 0, config), id=flow_workflow_id(avatar, name, "sched"),
        task_queue=TASK_QUEUE, typed_search_attributes=search_attrs(avatar, "flow", "agent", name))
    return Schedule(action=action, spec=spec,
                    policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP, catchup_window=timedelta(minutes=10)))


class Service:
    def __init__(self, settings: Settings, *, memory: MemoryClient | None = None):
        self.settings = settings
        self.memory = memory or MemoryClient(settings.memory_url, settings.memory_token)
        self.client: Client | None = None
        self.agents: dict[str, str] = {}
        self.index = WatchIndex()
        self.activities = Activities(settings, memory=self.memory, client_getter=lambda: self.client,
                                      agent_name=lambda avatar: self.agents.get(avatar, avatar))
        self.bridge = Bridge(settings.switchboard_url, self.index, self.send_signal)
        self._tasks: list[asyncio.Task] = []
        self._workers_task: asyncio.Task | None = None
        self.config = settings.flow_config()

    # --- connection ---------------------------------------------------------------------------------
    @property
    def temporal_ok(self) -> bool:
        return self.client is not None

    def require_client(self) -> Client:
        if self.client is None:
            raise ServiceError(503, "Temporal is not reachable yet; try again in a few seconds")
        return self.client

    async def start(self) -> None:
        """Start the background tasks: connecting to Temporal (with retries) and the switchboard bridge."""
        self._tasks = [asyncio.create_task(self._connect_loop(), name="temporal-connect"),
                       asyncio.create_task(self.bridge.run(), name="bridge")]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        await self.activities.aclose()

    async def _connect_loop(self) -> None:
        failing = False
        while True:
            try:
                client = await Client.connect(self.settings.temporal_address, namespace=self.settings.namespace)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                if not failing:
                    log.warning("Temporal at %s is not reachable (%s); retrying every 5 s",
                                self.settings.temporal_address, str(exc)[:120])
                    failing = True
                await asyncio.sleep(5)
                continue
            failing = False
            log.info("connected to Temporal at %s (namespace %s)", self.settings.temporal_address, self.settings.namespace)
            self.client = client
            try:
                await self._run_workers(client)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.error("workers stopped: %s; reconnecting", exc)
            self.client = None
            await asyncio.sleep(5)

    async def _run_workers(self, client: Client) -> None:
        workers = make_workers(client, self.activities)
        async with _All(workers) as group:
            log.info("workers running on task queues agents and think")
            try:
                await self.reconcile()
            except Exception as exc:  # noqa: BLE001
                log.warning("reconcile failed: %s", exc)
            await self.refresh_index()
            if self.settings.agent_life and self.agents:
                await self.sync_agents(list(self.agents.items()))
            last = 0.0
            while True:
                await asyncio.sleep(5)
                for t in group.tasks:
                    if t.done():
                        raise t.exception() or RuntimeError("a worker stopped")
                last += 5
                if last >= 60:
                    last = 0
                    await self.refresh_index()

    # --- signals and the watch index ------------------------------------------------------------------
    async def send_signal(self, sig: Signal) -> None:
        client = self.require_client()
        h = client.get_workflow_handle(sig.workflow_id)
        if sig.payload is None:
            await h.signal(sig.name)
        else:
            await h.signal(sig.name, sig.payload)

    async def refresh_index(self) -> None:
        client = self.client
        if client is None:
            return
        entries: list[WatchEntry] = []
        try:
            async for wf in client.list_workflows('Purpose = "watch" AND ExecutionStatus = "Running"'):
                try:
                    info = await client.get_workflow_handle(wf.id).query("info")
                except Exception:  # noqa: BLE001
                    continue
                avatar = attr_value(wf.typed_search_attributes, AGENT_ID) or ""
                entries.append(WatchEntry(wf.id, avatar, info.get("condition") or {}))
        except Exception as exc:  # noqa: BLE001
            log.warning("could not list the running watches: %s", exc)
            return
        self.index.replace(entries)
        log.debug("watch index rebuilt: %d watches", len(entries))

    # --- agents / life ----------------------------------------------------------------------------------
    async def _life_running(self, client: Client) -> set[str]:
        out: set[str] = set()
        async for wf in client.list_workflows('Purpose = "life" AND ExecutionStatus = "Running"'):
            out.add(wf.id)
        return out

    async def sync_agents(self, agents: list[tuple[str, str]]) -> dict:
        """Start a life workflow for each avatar and stop those of avatars no longer listed."""
        self.agents = dict(agents)
        started: list[str] = []
        stopped: list[str] = []
        if not self.settings.agent_life:
            return {"agents": list(self.agents), "started": started, "stopped": stopped}
        client = self.require_client()
        running = await self._life_running(client)
        for avatar, name in agents:
            wid = f"life:{avatar}"
            if wid in running:
                continue
            await client.start_workflow(
                "AgentLife", LifeInput(avatar, name, self.config), id=wid, task_queue=TASK_QUEUE,
                search_attributes=search_attrs(avatar, "life", "system"),
                id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING)
            started.append(avatar)
            log.info("life workflow started for %s (%s)", name, wid)
        for wid in running - {f"life:{a}" for a, _ in agents}:
            try:
                await client.get_workflow_handle(wid).cancel()
                stopped.append(wid.split(":", 1)[1])
                log.info("life workflow %s stopped (avatar no longer listed)", wid)
            except Exception as exc:  # noqa: BLE001
                log.warning("could not stop %s: %s", wid, exc)
        return {"agents": list(self.agents), "started": started, "stopped": stopped}

    async def life_state(self, avatar: str) -> dict:
        client = self.require_client()
        try:
            return await client.get_workflow_handle(f"life:{avatar}").query("state")
        except Exception as exc:  # noqa: BLE001
            if _not_found(exc) or "not found" in str(exc).lower() or "completed" in str(exc).lower():
                raise ServiceError(404, f"no life workflow is running for {avatar}") from exc
            raise

    async def signal_life(self, avatar: str, name: str, *args: Any) -> None:
        client = self.require_client()
        try:
            await client.get_workflow_handle(f"life:{avatar}").signal(name, *args)
        except Exception as exc:  # noqa: BLE001
            if _not_found(exc):
                raise ServiceError(404, f"no life workflow is running for {avatar}") from exc
            raise
        log.info("signal %s -> life:%s (from the API)", name, avatar)

    # --- reminders, wake-ups, watches ----------------------------------------------------------------
    async def _record_intention(self, row: dict) -> str | None:
        try:
            made = await self.memory.create_intention(row)
            return made.get("id") or row["id"]
        except MemoryError as exc:
            log.warning("could not record the intention in memory (%s); the workflow runs anyway", exc)
            return None

    async def create_due(self, kind: str, avatar: str, text: str, at: str | None, in_seconds: float | None,
                         alarm: bool = False) -> dict:
        """A reminder (`remind:`) or a wake-up (`wake:`)."""
        try:
            due = due_from(datetime.now(timezone.utc), at, in_seconds)
        except ValueError as exc:
            raise ServiceError(422, str(exc)) from exc
        uid = str(uuid.uuid4())
        wid = f"{'remind' if kind == 'reminder' else 'wake'}:{uid}"
        params = {"text": text, "alarm": alarm} if kind == "reminder" else {"text": text}
        row = {"id": uid, "avatar_id": avatar, "kind": kind, "text": text, "status": "open", "workflow_id": wid,
               "template": kind, "params": params, "due_at": iso_z(due)}
        intention_id = await self._record_intention(row)
        await self._start_due(kind, wid, DueInput(avatar, text, iso_z(due), alarm, intention_id, self.config))
        return {"workflowId": wid, "intentionId": intention_id, "dueAt": iso_z(due)}

    async def _start_due(self, kind: str, wid: str, inp: DueInput) -> None:
        client = self.require_client()
        await client.start_workflow(
            "Reminder" if kind == "reminder" else "WakeMe", inp, id=wid, task_queue=TASK_QUEUE,
            search_attributes=search_attrs(inp.avatar_id, kind))

    async def create_watch(self, avatar: str, condition: dict, then: dict, until_hours: Any) -> dict:
        errors = cnd.validate_condition(condition) + cnd.validate_then(then)
        if errors:
            raise ServiceError(422, {"errors": errors})
        until = datetime.now(timezone.utc) + timedelta(hours=cnd.clamp_until_hours(until_hours if until_hours is not None else cnd.DEFAULT_UNTIL_HOURS))
        uid = str(uuid.uuid4())
        wid = f"watch:{uid}"
        text = f"Watch for {cnd.describe(condition)}"
        row = {"id": uid, "avatar_id": avatar, "kind": "watch", "text": text, "status": "open", "workflow_id": wid,
               "template": "watch", "params": {"condition": condition, "then": then, "untilAt": iso_z(until)},
               "due_at": iso_z(until)}
        intention_id = await self._record_intention(row)
        await self._start_watch(wid, WatchInput(avatar, condition, then, iso_z(until), intention_id, None, self.config))
        return {"workflowId": wid, "intentionId": intention_id}

    async def _start_watch(self, wid: str, inp: WatchInput, *, replace: bool = False) -> None:
        client = self.require_client()
        await client.start_workflow(
            "Watch", inp, id=wid, task_queue=TASK_QUEUE,
            search_attributes=search_attrs(inp.avatar_id, "watch", "agent", inp.flow_name),
            id_conflict_policy=WorkflowIDConflictPolicy.TERMINATE_EXISTING if replace else WorkflowIDConflictPolicy.UNSPECIFIED)
        self.index.add(WatchEntry(wid, inp.avatar_id, inp.condition))

    # --- flows -----------------------------------------------------------------------------------------
    async def put_flow(self, avatar: str, name: str, description: str, definition: Any, trigger: Any,
                       enabled: bool = True) -> dict:
        errors = flowdef.validate_flow(name, definition, trigger)
        if errors:
            raise ServiceError(422, {"errors": errors})
        try:
            saved = await self.memory.put_flow(avatar, name, {"description": description, "definition": definition,
                                                              "trigger": trigger, "enabled": enabled})
        except MemoryError as exc:
            raise ServiceError(502, str(exc)) from exc
        log.info("flow %s/%s saved (version %s), trigger %s", avatar, name, saved.get("version", "?"), trigger.get("kind"))
        applied = True
        try:
            await self.apply_trigger(avatar, name, trigger if enabled else {"kind": "manual"})
        except ServiceError:
            applied = False
            log.warning("flow %s/%s saved but its trigger could not be applied (Temporal is not reachable); "
                        "it will be applied when Temporal is back", avatar, name)
        return {**saved, "triggerApplied": applied}

    async def apply_trigger(self, avatar: str, name: str, trigger: dict) -> None:
        client = self.require_client()
        kind = trigger.get("kind")
        if kind == "schedule":
            await self._stop_watcher(client, avatar, name)
            schedule = build_schedule(avatar, name, trigger, self.config)
            try:
                await client.create_schedule(sched_id(avatar, name), schedule)
                log.info("schedule %s created (%s)", sched_id(avatar, name), trigger.get("cron") or f"every {trigger.get('everyMinutes')} min")
            except ScheduleAlreadyRunningError:
                await client.get_schedule_handle(sched_id(avatar, name)).update(lambda _i: ScheduleUpdate(schedule=schedule))
                log.info("schedule %s updated", sched_id(avatar, name))
        elif kind == "watch":
            await self._delete_schedule(client, avatar, name)
            inp = WatchInput(avatar, trigger["condition"], {}, None, None, name, self.config)
            await self._start_watch(watcher_id(avatar, name), inp, replace=True)
            log.info("flow watcher %s started", watcher_id(avatar, name))
        else:
            await self._delete_schedule(client, avatar, name)
            await self._stop_watcher(client, avatar, name)

    async def _delete_schedule(self, client: Client, avatar: str, name: str) -> None:
        try:
            await client.get_schedule_handle(sched_id(avatar, name)).delete()
            log.info("schedule %s deleted", sched_id(avatar, name))
        except Exception as exc:  # noqa: BLE001
            if not _not_found(exc):
                log.debug("schedule delete: %s", exc)

    async def _stop_watcher(self, client: Client, avatar: str, name: str) -> None:
        try:
            await client.get_workflow_handle(watcher_id(avatar, name)).cancel()
            self.index.remove(watcher_id(avatar, name))
            log.info("flow watcher %s stopped", watcher_id(avatar, name))
        except Exception as exc:  # noqa: BLE001
            if not _not_found(exc) and "already completed" not in str(exc).lower():
                log.debug("watcher stop: %s", exc)

    async def run_flow(self, avatar: str, name: str, inputs: dict | None) -> dict:
        try:
            flow = await self.memory.get_flow(avatar, name)
        except MemoryError as exc:
            raise ServiceError(502, str(exc)) from exc
        if not flow:
            raise ServiceError(404, f"no flow {name} for {avatar}")
        client = self.require_client()
        wid = flow_workflow_id(avatar, name, str(uuid.uuid4()))
        await client.start_workflow("AgentFlow", FlowInput(avatar, name, inputs or {}, "manual", 0, self.config),
                                    id=wid, task_queue=TASK_QUEUE, search_attributes=search_attrs(avatar, "flow", "agent", name))
        log.info("flow %s/%s run started as %s", avatar, name, wid)
        return {"workflowId": wid}

    async def delete_flow(self, avatar: str, name: str) -> dict:
        try:
            await self.memory.delete_flow(avatar, name)
        except MemoryError as exc:
            if exc.status == 404:
                raise ServiceError(404, f"no flow {name} for {avatar}") from exc
            raise ServiceError(502, str(exc)) from exc
        if self.client is not None:
            await self.apply_trigger(avatar, name, {"kind": "manual"})
        log.info("flow %s/%s deleted", avatar, name)
        return {"ok": True}

    # --- plans -----------------------------------------------------------------------------------------
    async def plans(self, avatar: str) -> dict:
        client = self.require_client()
        intentions: list[dict] = []
        flows: list[dict] = []
        try:
            intentions = await self.memory.intentions(avatar)
            flows = await self.memory.flows(avatar)
        except MemoryError as exc:
            log.warning("plans: memory unavailable: %s", exc)
        by_wf = {i.get("workflow_id"): i for i in intentions if i.get("workflow_id")}
        rows: list[dict] = []
        query = f'AgentId = "{avatar}" AND ExecutionStatus = "Running" AND Purpose != "life"'
        async for wf in client.list_workflows(query):
            it = by_wf.get(wf.id) or {}
            purpose = attr_value(wf.typed_search_attributes, PURPOSE) or wf.workflow_type
            rows.append({
                "workflowId": wf.id, "purpose": purpose, "title": it.get("text") or wf.id, "status": "running",
                "startedAt": iso_z(wf.start_time) if wf.start_time else None, "nextAt": it.get("due_at")})
        return {
            "workflows": rows,
            "intentions": intentions,
            "flows": [{"name": f.get("name"), "trigger": f.get("trigger"), "enabled": f.get("enabled", True),
                       "lastRun": f.get("last_run_at")} for f in flows],
        }

    async def signal_plan(self, workflow_id: str, signal: str, args: dict | None) -> None:
        client = self.require_client()
        if workflow_id.startswith("sched:"):
            h = client.get_schedule_handle(workflow_id)
            try:
                if signal == "pause":
                    await h.pause(note="paused through the API")
                elif signal == "resume":
                    await h.unpause(note="resumed through the API")
                else:
                    raise ServiceError(400, f"a schedule can only be paused or resumed, not {signal}")
            except ServiceError:
                raise
            except Exception as exc:  # noqa: BLE001
                if _not_found(exc):
                    raise ServiceError(404, f"no schedule {workflow_id}") from exc
                raise
            log.info("schedule %s %s (from the API)", workflow_id, signal)
            return
        h = client.get_workflow_handle(workflow_id)
        try:
            if signal in ("pause", "resume"):
                await h.signal(signal)
            else:
                await h.signal(signal, args or {})
        except Exception as exc:  # noqa: BLE001
            if _not_found(exc):
                raise ServiceError(404, f"no running workflow {workflow_id}") from exc
            raise
        log.info("signal %s -> %s (from the API)", signal, workflow_id)

    async def drop_plan(self, workflow_id: str, why: str | None) -> dict:
        client = self.require_client()
        if workflow_id.startswith("sched:"):
            try:
                await client.get_schedule_handle(workflow_id).delete()
            except Exception as exc:  # noqa: BLE001
                if _not_found(exc):
                    raise ServiceError(404, f"no schedule {workflow_id}") from exc
                raise
        else:
            try:
                await client.get_workflow_handle(workflow_id).cancel()
            except Exception as exc:  # noqa: BLE001
                if _not_found(exc):
                    raise ServiceError(404, f"no running workflow {workflow_id}") from exc
                raise
            self.index.remove(workflow_id)
        log.info("plan %s dropped%s", workflow_id, f": {why}" if why else "")
        try:
            for it in await self.memory.all_active_intentions():
                if it.get("workflow_id") == workflow_id and it.get("id"):
                    await self.memory.patch_intention(it["id"], {"status": "dropped", "outcome": why or "dropped"})
        except MemoryError as exc:
            log.warning("could not mark the intention dropped: %s", exc)
        return {"ok": True}

    # --- reconcile ---------------------------------------------------------------------------------------
    async def reconcile(self) -> dict:
        """At start: make sure what memory says should be running is running. Late is better than never."""
        client = self.require_client()
        restarted: list[str] = []
        try:
            rows = await self.memory.all_active_intentions()
        except MemoryError as exc:
            log.warning("reconcile: memory not reachable (%s); skipping intentions", exc)
            rows = []
        for row in rows:
            wid, template, params = row.get("workflow_id"), row.get("template"), row.get("params") or {}
            if not wid or template not in ("reminder", "wakeup", "watch"):
                continue
            if await self._is_running(client, wid):
                continue
            avatar = row.get("avatar_id") or ""
            try:
                if template in ("reminder", "wakeup"):
                    kind = "reminder" if template == "reminder" else "wakeup"
                    due = row.get("due_at") or params.get("dueAt") or iso_z(datetime.now(timezone.utc))
                    await self._start_due(kind, wid, DueInput(avatar, params.get("text") or row.get("text") or "", due,
                                                              bool(params.get("alarm")), row.get("id"), self.config))
                else:
                    until = params.get("untilAt") or row.get("due_at")
                    await self._start_watch(wid, WatchInput(avatar, params.get("condition") or {}, params.get("then") or {},
                                                            until, row.get("id"), None, self.config))
                restarted.append(wid)
                log.info("reconcile: %s was not running; started it again (late)", wid)
            except Exception as exc:  # noqa: BLE001
                log.warning("reconcile: could not restart %s: %s", wid, exc)
        try:
            flows = await self.memory.flows()
        except MemoryError as exc:
            log.warning("reconcile: could not read flows (%s)", exc)
            flows = []
        for f in flows:
            trig, avatar, name = f.get("trigger") or {}, f.get("avatar_id"), f.get("name")
            if not avatar or not name or f.get("enabled") is False:
                continue
            try:
                if trig.get("kind") == "schedule":
                    try:
                        await client.get_schedule_handle(sched_id(avatar, name)).describe()
                        continue
                    except Exception as exc:  # noqa: BLE001
                        if not _not_found(exc):
                            raise
                elif trig.get("kind") == "watch":
                    if await self._is_running(client, watcher_id(avatar, name)):
                        continue
                else:
                    continue
                await self.apply_trigger(avatar, name, trig)
                log.info("reconcile: trigger of flow %s/%s restored", avatar, name)
            except Exception as exc:  # noqa: BLE001
                log.warning("reconcile: flow %s/%s: %s", avatar, name, exc)
        log.info("reconcile done: %d restarted", len(restarted))
        return {"restarted": restarted}

    async def _is_running(self, client: Client, wid: str) -> bool:
        try:
            d = await client.get_workflow_handle(wid).describe()
        except Exception as exc:  # noqa: BLE001
            if _not_found(exc):
                return False
            raise
        return d.status is not None and d.status.name == "RUNNING"


class _All:
    """Run several workers together as one async context."""

    def __init__(self, workers):
        self.workers = workers
        self.tasks: list[asyncio.Task] = []

    async def __aenter__(self):
        self.tasks = [asyncio.create_task(w.run()) for w in self.workers]
        await asyncio.sleep(0)
        return self

    async def __aexit__(self, *exc):
        for w in self.workers:
            try:
                await w.shutdown()
            except Exception:  # noqa: BLE001
                pass
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
