"""Helpers shared by the workflows. Deterministic: no I/O except through activities."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

from ..acts import THINK_QUEUE_KINDS, act_timeout
from ..settings import TASK_QUEUE, THINK_QUEUE

NO_RETRY_ACT = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=2),
                           non_retryable_error_types=["AppOffline", "ActFailed"])
ONE_TRY = RetryPolicy(maximum_attempts=1)


def wlog(msg: str, level: str = "info") -> None:
    """One readable line, with the workflow id as the column. Replay-safe: workflow.logger skips replays."""
    workflow.logger.workflow_info_on_message = False
    getattr(workflow.logger, level)(msg, extra={"wfid": workflow.info().workflow_id})


def ts() -> float:
    return workflow.now().timestamp()


def now() -> datetime:
    return workflow.now()


async def journal(kind: str, text: str, avatar_id: str | None = None, extra: dict | None = None) -> None:
    """Publish a workflow.<kind> event to the switchboard. Fire and forget: failures are ignored."""
    try:
        await workflow.execute_local_activity(
            "journal", {"kind": kind, "workflowId": workflow.info().workflow_id, "avatarId": avatar_id,
                        "text": text, "extra": extra},
            schedule_to_close_timeout=timedelta(seconds=10), retry_policy=ONE_TRY)
    except (ActivityError, ApplicationError):
        pass


async def say_line(kind: str, text: str, avatar_id: str | None, level: str = "info") -> None:
    """Log a line and journal it."""
    wlog(text, level)
    await journal(kind, text, avatar_id)


@dataclass
class ActResult:
    ok: bool
    data: dict
    offline: bool = False
    error: str | None = None
    code: str | None = None  # offline, refused, bad_args, failed or busy (a live conversation is on)

    @property
    def busy(self) -> bool:
        return self.code == "busy"


async def try_act(avatar_id: str, kind: str, args: dict | None = None, timeout: float | None = None) -> ActResult:
    """Run an act (Contract 1) through the app. Never raises for an offline app or a failed act."""
    seconds = act_timeout(kind) if timeout is None else timeout
    queue = THINK_QUEUE if kind in THINK_QUEUE_KINDS else TASK_QUEUE
    try:
        data = await workflow.execute_activity(
            "app_act", {"avatarId": avatar_id, "kind": kind, "args": args or {}, "workflowId": workflow.info().workflow_id},
            task_queue=queue, start_to_close_timeout=timedelta(seconds=seconds + 45),
            heartbeat_timeout=timedelta(seconds=30), retry_policy=NO_RETRY_ACT,
            result_type=dict)
        return ActResult(True, data or {})
    except ActivityError as exc:
        cause = exc.cause
        if isinstance(cause, ApplicationError):
            if cause.type == "AppOffline":
                return ActResult(False, {}, offline=True, error=str(cause.message), code="offline")
            code = cause.details[0] if cause.details and isinstance(cause.details[0], str) else None
            return ActResult(False, {}, error=str(cause.message), code=code)
        return ActResult(False, {}, error=str(cause or exc))


async def run_local_or_normal(name: str, arg: Any, *, seconds: float = 30, attempts: int = 3, result_type: Any = None) -> Any:
    return await workflow.execute_activity(
        name, arg, start_to_close_timeout=timedelta(seconds=seconds),
        retry_policy=RetryPolicy(maximum_attempts=attempts, initial_interval=timedelta(seconds=2),
                                 non_retryable_error_types=[]),
        result_type=result_type)


async def best_effort(name: str, arg: Any, seconds: float = 30) -> Any:
    """An activity whose failure does not matter (memory notes). Returns None on failure."""
    try:
        return await workflow.execute_activity(
            name, arg, start_to_close_timeout=timedelta(seconds=seconds), retry_policy=RetryPolicy(maximum_attempts=2))
    except (ActivityError, ApplicationError) as exc:
        wlog(f"{name} failed: {exc.cause or exc}", "warning")
        return None


async def patch_intention(intention_id: str | None, fields: dict) -> None:
    if intention_id:
        await best_effort("mem_patch_intention", {"id": intention_id, "fields": fields})


async def wait_changed(version_getter, seen: int, timeout: float | None) -> bool:
    """Wait until version_getter() != seen. Returns False on timeout."""
    try:
        await workflow.wait_condition(lambda: version_getter() != seen,
                                      timeout=None if timeout is None else timedelta(seconds=max(timeout, 0.001)))
        return True
    except asyncio.TimeoutError:
        return False


class Controllable:
    """Signals every plan accepts (Contract 3 POST /v1/plans/{id}/signal): pause, resume, snooze, note."""

    def _init_control(self) -> None:
        self.paused = False
        self.snooze_until = 0.0
        self.notes: list[str] = []
        self.rev = 0

    def _bump(self) -> None:
        self.rev += 1

    @workflow.signal
    def pause(self) -> None:
        self.paused = True
        wlog("paused")
        self._bump()

    @workflow.signal
    def resume(self) -> None:
        self.paused = False
        wlog("resumed")
        self._bump()

    @workflow.signal
    def snooze(self, args: dict | None = None) -> None:
        seconds = float((args or {}).get("seconds", 600))
        self.snooze_until = ts() + seconds
        wlog(f"snoozed for {int(seconds)} s")
        self._bump()

    @workflow.signal
    def note(self, args: dict | None = None) -> None:
        text = str((args or {}).get("text") or args or "")
        self.notes.append(text)
        wlog(f"note added: {text[:120]}")
        self._bump()
