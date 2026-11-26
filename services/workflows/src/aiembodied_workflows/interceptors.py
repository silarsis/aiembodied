"""An activity interceptor that logs every activity start and finish with its duration and outcome."""

from __future__ import annotations

import time
from typing import Any

from temporalio import activity
from temporalio.worker import ActivityInboundInterceptor, ExecuteActivityInput, Interceptor

from .logs import get_logger

log = get_logger("activity")


def describe_call(name: str, args: tuple | list) -> str:
    """A short readable summary of an activity call."""
    first = args[0] if args else None
    if name == "app_act" and isinstance(first, dict):
        return f"act {first.get('kind')} for {first.get('avatarId')}"
    if isinstance(first, dict):
        bits = [str(first[k]) for k in ("avatarId", "name", "id") if k in first]
        return f"{name} {' '.join(bits)}".strip()
    return f"{name} {first}" if isinstance(first, (str, int)) else name


class _Inbound(ActivityInboundInterceptor):
    async def execute_activity(self, input: ExecuteActivityInput) -> Any:
        info = activity.info()
        what = describe_call(info.activity_type, input.args)
        who = info.workflow_id or "activity"
        attempt = f" (attempt {info.attempt})" if info.attempt > 1 else ""
        log.info("start %s%s", what, attempt, extra={"wfid": who})
        t0 = time.monotonic()
        try:
            out = await super().execute_activity(input)
        except BaseException as exc:
            ms = (time.monotonic() - t0) * 1000
            kind = type(exc).__name__
            cause = getattr(exc, "type", None)
            level = log.info if cause in ("AppOffline",) else log.warning
            level(
                "failed %s -> %s%s: %s (%.0f ms)",
                what,
                kind,
                f"/{cause}" if cause else "",
                exc,
                ms,
                extra={"wfid": who},
            )
            raise
        log.info("done  %s -> ok (%.0f ms)", what, (time.monotonic() - t0) * 1000, extra={"wfid": who})
        return out


class ActivityLogInterceptor(Interceptor):
    def intercept_activity(self, next: ActivityInboundInterceptor) -> ActivityInboundInterceptor:
        return _Inbound(next)
