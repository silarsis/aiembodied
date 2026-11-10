"""The transaction ledger: turns events that carry a `txn` into rows, and closes what belongs to a closed parent."""

from __future__ import annotations

from typing import Any

from .models import CLOSED_STATES, Event, Producer, Txn
from .store import Store

SWITCHBOARD = Producer(kind="service", id="switchboard")


class Ledger:
    def __init__(self, store: Store) -> None:
        self.store = store

    def apply(self, ev: Event) -> list[Event]:
        """Update the txn row for a journaled event. Returns events the switchboard itself must now publish
        (a `txn.cancelled` for each open child when this event closed its txn)."""
        t = ev.txn
        if t is None:
            return []
        who = ev.producer.address
        row = self.store.get_txn(t.id)
        was_closed = row is not None and row["state"] in CLOSED_STATES
        if row is None:
            parent = self.store.get_txn(t.parent) if t.parent else None
            row = {"id": t.id, "parent": t.parent, "root": t.root or (parent["root"] if parent else t.parent) or t.id,
                   "state": "open", "title": t.title, "opened_by": who, "owner": None, "opened_at": ev.at,
                   "closed_at": None, "deadline": t.deadline}
        if t.state and not was_closed:
            row["state"] = t.state
            if t.state != "open" and not row["owner"]:
                row["owner"] = who
            if t.state in CLOSED_STATES:
                row["closed_at"] = ev.at
        row["updated_at"], row["last_event"] = ev.at, ev.id
        self.store.put_txn(row)
        if was_closed or row["state"] not in CLOSED_STATES:
            return []
        return [self._system("txn.cancelled", c, "cancelled", {"reason": "parent closed", "parent": row["id"]})
                for c in self.store.txns(state="open", parent=row["id"], limit=1000)]

    def expire(self, now: str) -> list[Event]:
        """`txn.expired` for every open txn whose deadline has passed (applying them cascades to the children)."""
        return [self._system("txn.expired", row, "expired", {"deadline": row["deadline"]})
                for row in self.store.overdue(now)]

    @staticmethod
    def _system(type_: str, row: dict[str, Any], state: str, payload: dict[str, Any]) -> Event:
        return Event(type=type_, producer=SWITCHBOARD, txn=Txn(id=row["id"], parent=row["parent"], state=state),
                     payload=payload)
