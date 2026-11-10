"""Publishing pipeline (validate, journal, ledger) and the fan-out to live subscribers."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from fnmatch import fnmatchcase
from typing import Any, Optional

from pydantic import ValidationError

from .ledger import Ledger
from .models import MAX_PAYLOAD_BYTES, Config, Event, format_time, now_iso
from .store import Store
from .ulid import new_ulid

log = logging.getLogger("switchboard")

MAX_BATCH = 500
CLIENT_QUEUE = 1000


class BusError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status, self.message = status, message


class Client:
    """One live subscriber. Messages for its socket wait in `queue`; None means "drop this client"."""

    def __init__(self, actor: Optional[str], types: list[str], to: list[str], observe: bool) -> None:
        self.actor, self.types, self.to, self.observe = actor, types, set(to), observe
        self.queue: asyncio.Queue[Optional[dict[str, Any]]] = asyncio.Queue(CLIENT_QUEUE)

    def matches(self, ev: dict[str, Any]) -> bool:
        return (any(fnmatchcase(ev["type"], g) for g in self.types)
                and (self.observe or any(a in self.to for a in ev.get("to", ()))))

    def offer(self, msg: dict[str, Any]) -> bool:
        """Queue a message; on overflow throw the backlog away and queue the drop marker instead."""
        try:
            self.queue.put_nowait(msg)
            return True
        except asyncio.QueueFull:
            while not self.queue.empty():
                self.queue.get_nowait()
            self.queue.put_nowait(None)
            return False


class Hub:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.store = Store(cfg.db_path)
        self.ledger = Ledger(self.store)
        self.clients: set[Client] = set()

    def close(self) -> None:
        self.store.close()

    def publish(self, raws: list[dict[str, Any]]) -> list[str]:
        """Journal events (all or none), update the ledger, fan out. Returns the ids in order."""
        if not 1 <= len(raws) <= MAX_BATCH:
            raise BusError(422, f"publish 1 to {MAX_BATCH} events at a time")
        try:
            events = [Event.model_validate(r) for r in raws]
        except ValidationError as e:
            raise BusError(422, str(e)) from None
        for ev in events:
            if len(json.dumps(ev.payload, separators=(",", ":"), ensure_ascii=False).encode()) > MAX_PAYLOAD_BYTES:
                raise BusError(413, f"payload of {ev.type} is over {MAX_PAYLOAD_BYTES // 1024} KB")
        for ev in events:
            self._stamp(ev)
        stored: list[Event] = []
        with self.store.transaction():
            todo = list(events)
            while todo:
                ev = self._stamp(todo.pop(0))
                if self.store.add_event(ev):
                    stored.append(ev)
                    todo.extend(self.ledger.apply(ev))
        for ev in stored:
            self._fan_out(ev.model_dump(exclude_none=True))
        return [ev.id for ev in events]  # type: ignore[misc]

    @staticmethod
    def _stamp(ev: Event) -> Event:
        ev.id = ev.id or new_ulid()
        ev.at = ev.at or now_iso()
        return ev

    def expire(self, now: Optional[datetime] = None) -> int:
        """Expire open txns past their deadline. Returns how many events that published."""
        events = self.ledger.expire(format_time(now or datetime.now(timezone.utc)))
        if events:
            self.publish([e.model_dump(exclude_none=True) for e in events])
        return len(events)

    def prune(self, now: Optional[datetime] = None) -> tuple[int, int]:
        cutoff = format_time((now or datetime.now(timezone.utc)) - timedelta(days=self.cfg.retention_days))
        return self.store.prune(cutoff)

    def attach(self, hello: dict[str, Any]) -> tuple[Client, list[dict[str, Any]]]:
        """Register a subscriber from its hello message. Returns it with the journal events to replay first."""
        sub = hello.get("subscribe") or {}
        client = Client(hello.get("actor"), list(sub.get("types") or ["*"]), list(sub.get("to") or []),
                        bool(sub.get("observe")))
        replay: list[dict[str, Any]] = []
        cursor = hello.get("since")
        while cursor:
            batch = self.store.events(since=cursor, limit=1000)
            replay += [e for e in batch if client.matches(e)]
            cursor = batch[-1]["id"] if len(batch) == 1000 else None
        self.clients.add(client)
        return client, replay

    def detach(self, client: Client) -> None:
        self.clients.discard(client)

    def _fan_out(self, body: dict[str, Any]) -> None:
        for c in list(self.clients):
            if c.matches(body) and not c.offer({"op": "event", "event": body}):
                self.clients.discard(c)
                log.warning("dropped slow client %s (queue full)", c.actor or "anonymous")
