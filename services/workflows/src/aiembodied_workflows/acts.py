"""Acts (Contract 1): ask the app to do something through the switchboard and wait for its answer."""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

import httpx

from .timeutil import iso_z

ACT_TIMEOUTS: dict[str, float] = {
    "context": 15,
    "think": 180,
    "say": 15,
    "tool": 3600,
    "ask": 6 * 3600,
    "start_pursuit": 30,
    "return_home": 30,
    "sleep_state": 15,
}
THINK_QUEUE_KINDS = ("think", "tool", "ask")
POLL_SECONDS = 0.5
CLOSED = ("done", "failed", "cancelled", "expired")
PRODUCER = {"kind": "service", "id": "workflows"}


class AppOffline(Exception):
    """The app did not answer before the deadline, so it is not running."""


class ActFailed(Exception):
    def __init__(self, message: str, code: str = "failed"):
        super().__init__(message)
        self.code = code


def act_timeout(kind: str) -> float:
    return ACT_TIMEOUTS.get(kind, 60)


def build_act_event(avatar_id: str, kind: str, args: dict, workflow_id: str, txn_id: str, deadline: datetime) -> dict:
    return {
        "type": "agent.act",
        "producer": PRODUCER,
        "to": ["service:app"],
        "audience": "private",
        "priority": "normal",
        "txn": {"id": txn_id, "state": "open", "title": f"{kind} for {avatar_id}", "deadline": iso_z(deadline)},
        "payload": {"avatarId": avatar_id, "kind": kind, "args": args, "workflowId": workflow_id},
    }


def read_result(txn_body: dict) -> dict | None:
    """The agent.act.result payload out of a GET /v1/txns/{id} response (the newest one), or None."""
    for ev in reversed(txn_body.get("events") or []):
        if ev.get("type") == "agent.act.result":
            return ev.get("payload") or {}
    return None


async def run_act(
    http: httpx.AsyncClient,
    avatar_id: str,
    kind: str,
    args: dict[str, Any] | None = None,
    *,
    workflow_id: str = "",
    timeout: float | None = None,
    heartbeat: Callable[[], None] | None = None,
    poll: float = POLL_SECONDS,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> dict[str, Any]:
    """Publish one act and wait until the app has answered. Returns the result dict.

    Raises AppOffline when the txn expires (the app is not running) and ActFailed when the app reports a failure."""
    timeout = act_timeout(kind) if timeout is None else timeout
    txn_id = f"act:{uuid.uuid4()}"
    deadline = now() + timedelta(seconds=timeout)
    event = build_act_event(avatar_id, kind, args or {}, workflow_id, txn_id, deadline)
    resp = await http.post("/v1/events", json=event)
    resp.raise_for_status()
    # The switchboard expires open txns every 5 s, so allow a little past the deadline before giving up.
    give_up = deadline + timedelta(seconds=20)
    while True:
        r = await http.get(f"/v1/txns/{txn_id}")
        r.raise_for_status()
        body = r.json()
        state = (body.get("txn") or {}).get("state")
        if state in CLOSED:
            return _finish(state, body, kind)
        if heartbeat:
            heartbeat()
        if now() >= give_up:
            raise AppOffline(f"no answer to {kind} for {avatar_id} by the deadline")
        await sleep(poll)


def _finish(state: str, body: dict, kind: str) -> dict:
    result = read_result(body)
    if state == "expired" and result is None:
        raise AppOffline("the app did not pick up the act before its deadline")
    if result is None:
        raise ActFailed(f"{kind} ended as {state} with no result")
    if result.get("ok") is False or state == "failed":
        code = result.get("code") or "failed"
        text = str(result.get("error") or f"{kind} failed")
        if code == "offline":
            raise AppOffline(text)
        raise ActFailed(text, code)
    if state == "cancelled":
        raise ActFailed(f"{kind} was cancelled", "cancelled")
    out = result.get("result")
    return out if isinstance(out, dict) else {}


async def publish_event(http: httpx.AsyncClient, event: dict) -> None:
    resp = await http.post("/v1/events", json=event)
    resp.raise_for_status()


def journal_event(kind: str, workflow_id: str, avatar_id: str | None, text: str, extra: dict | None = None) -> dict:
    return {
        "type": f"workflow.{kind}",
        "producer": PRODUCER,
        "to": [],
        "audience": "private",
        "priority": "low",
        "payload": {"workflowId": workflow_id, "avatarId": avatar_id, "text": text, **(extra or {})},
    }
