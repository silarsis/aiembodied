"""The switchboard bridge (Contract 2): listens to the event stream and turns events into workflow signals."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .logs import get_logger

log = get_logger("bridge")

SUBSCRIBE_TYPES = ["speech.heard", "home.change", "home.alert", "task.status", "avatar.utterance"]
ACTOR = "service:workflows"


@dataclass(frozen=True)
class Signal:
    workflow_id: str
    name: str
    payload: dict | None = None


@dataclass
class WatchEntry:
    workflow_id: str
    avatar_id: str
    condition: dict


@dataclass
class WatchIndex:
    """The running watches, so an event can be sent to the ones it matters to."""

    entries: dict[str, WatchEntry] = field(default_factory=dict)

    def replace(self, entries: list[WatchEntry]) -> None:
        self.entries = {e.workflow_id: e for e in entries}

    def add(self, entry: WatchEntry) -> None:
        self.entries[entry.workflow_id] = entry

    def remove(self, workflow_id: str) -> None:
        self.entries.pop(workflow_id, None)

    def for_entity(self, entity_id: str) -> list[WatchEntry]:
        return [
            e
            for e in self.entries.values()
            if e.condition.get("kind") == "entity" and e.condition.get("entityId") == entity_id
        ]

    def for_task(self, task_id: str) -> list[WatchEntry]:
        return [
            e
            for e in self.entries.values()
            if e.condition.get("kind") == "coding_task" and e.condition.get("taskId") == task_id
        ]


def _avatar_of(address: str | None) -> str | None:
    if address and address.startswith("avatar:"):
        return address.split(":", 1)[1] or None
    return None


def event_to_signals(event: dict, index: WatchIndex) -> list[Signal]:
    """The signals one switchboard event causes. Pure."""
    typ = event.get("type", "")
    payload = event.get("payload") or {}
    out: list[Signal] = []
    if typ == "speech.heard":
        for addr in event.get("to") or []:
            avatar = _avatar_of(addr)
            if avatar:
                out.append(Signal(f"life:{avatar}", "interaction"))
    elif typ == "avatar.utterance":
        producer = event.get("producer") or {}
        if producer.get("kind") == "avatar" and producer.get("id"):
            out.append(Signal(f"life:{producer['id']}", "spoke"))
    elif typ in ("home.change", "home.alert"):
        entity = payload.get("entity_id")
        if entity:
            body = {k: payload.get(k) for k in ("entity_id", "new", "old", "text", "home_id")}
            out += [Signal(e.workflow_id, "home_change", body) for e in index.for_entity(str(entity))]
    elif typ == "task.status":
        txn_id = (event.get("txn") or {}).get("id") or ""
        task_id = txn_id[len("task:") :] if txn_id.startswith("task:") else payload.get("taskId")
        if task_id:
            body = {
                **payload,
                "taskId": task_id,
                "state": payload.get("state") or (event.get("txn") or {}).get("state"),
            }
            out += [Signal(e.workflow_id, "task_status", body) for e in index.for_task(str(task_id))]
    return out


SendSignal = Callable[[Signal], Awaitable[None]]


class Bridge:
    def __init__(self, switchboard_url: str, index: WatchIndex, send: SendSignal, *, connect: Any = None):
        self.url = switchboard_url.replace("http://", "ws://").replace("https://", "wss://").rstrip("/") + "/v1/stream"
        self.index = index
        self.send = send
        self.last_id: str | None = None
        self.connected = False
        self._connect = connect

    def hello(self) -> dict:
        return {
            "op": "hello",
            "actor": ACTOR,
            "subscribe": {"types": SUBSCRIBE_TYPES, "to": [ACTOR], "observe": True},
            "since": self.last_id,
        }

    async def handle(self, event: dict) -> None:
        if event.get("id"):
            self.last_id = event["id"]
        for sig in event_to_signals(event, self.index):
            try:
                await self.send(sig)
                log.info("signal %s -> %s (from %s)", sig.name, sig.workflow_id, event.get("type"))
            except Exception as exc:  # noqa: BLE001
                log.debug("signal %s to %s not delivered: %s", sig.name, sig.workflow_id, exc)

    async def run(self) -> None:
        """Connect, read, reconnect with backoff, for ever (cancel the task to stop)."""
        import websockets

        connect = self._connect or websockets.connect
        delay = 1.0
        while True:
            try:
                async with connect(self.url) as ws:
                    await ws.send(json.dumps(self.hello()))
                    self.connected = True
                    log.info(
                        "connected to the switchboard at %s%s",
                        self.url,
                        f" (resuming after {self.last_id})" if self.last_id else "",
                    )
                    delay = 1.0
                    async for raw in ws:
                        msg = json.loads(raw)
                        if msg.get("op") == "event":
                            await self.handle(msg.get("event") or {})
                    log.warning("the switchboard closed the connection; reconnecting")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                if self.connected:
                    log.warning("lost the switchboard (%s); reconnecting", exc)
                else:
                    log.debug("switchboard not reachable (%s); retrying in %.0f s", exc, delay)
            self.connected = False
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)
