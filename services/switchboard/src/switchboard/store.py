"""SQLite journal of events and the transaction table (one connection, guarded by a lock)."""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

from .models import CLOSED_STATES, Event

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  producer TEXT NOT NULL,
  node TEXT,
  to_json TEXT NOT NULL,
  scene TEXT,
  txn_id TEXT,
  audience TEXT,
  priority TEXT,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE INDEX IF NOT EXISTS events_type ON events(type);
CREATE INDEX IF NOT EXISTS events_txn ON events(txn_id);
CREATE TABLE IF NOT EXISTS txns (
  id TEXT PRIMARY KEY,
  parent TEXT, root TEXT, state TEXT NOT NULL, title TEXT,
  opened_by TEXT, owner TEXT, opened_at TEXT, updated_at TEXT, closed_at TEXT, deadline TEXT, last_event TEXT
);
CREATE INDEX IF NOT EXISTS txns_root ON txns(root);
CREATE INDEX IF NOT EXISTS txns_parent ON txns(parent);
CREATE INDEX IF NOT EXISTS txns_state ON txns(state);
"""

TXN_COLUMNS = ("id", "parent", "root", "state", "title", "opened_by", "owner", "opened_at", "updated_at",
               "closed_at", "deadline", "last_event")
_CLOSED_SQL = "(" + ",".join(f"'{s}'" for s in CLOSED_STATES) + ")"


class Store:
    def __init__(self, path: Path | str) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        with self.lock:
            self.db.close()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        with self.lock:
            self.db.execute("BEGIN")
            try:
                yield
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
            self.db.execute("COMMIT")

    # events

    def add_event(self, ev: Event) -> bool:
        """Journal the event. False when its id is already there (a retried publish), nothing is changed."""
        body = ev.model_dump(exclude_none=True)
        with self.lock:
            cur = self.db.execute(
                "INSERT OR IGNORE INTO events(id, at, type, producer, node, to_json, scene, txn_id, audience, priority, body)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (ev.id, ev.at, ev.type, ev.producer.address, ev.producer.node, json.dumps(ev.to), ev.scene,
                 ev.txn.id if ev.txn else None, ev.audience, ev.priority, json.dumps(body, ensure_ascii=False)))
            return cur.rowcount == 1

    def events(self, since: Optional[str] = None, type: Optional[str] = None, producer: Optional[str] = None,
               txn: Optional[str] = None, root: Optional[str] = None, scene: Optional[str] = None,
               to: Optional[str] = None, limit: int = 200) -> list[dict[str, Any]]:
        """Envelopes oldest first. `since` is exclusive; an id that is not (or no longer) in the journal
        is compared as a plain ULID, so any time-based id works."""
        where: list[str] = []
        args: list[Any] = []
        with self.lock:
            if since:
                row = self.db.execute("SELECT seq FROM events WHERE id=?", (since,)).fetchone()
                where.append("seq > ?" if row else "id > ?")
                args.append(row["seq"] if row else since)
            for clause, value in (("type GLOB ?", type), ("producer=?", producer), ("txn_id=?", txn),
                                  ("scene=?", scene),
                                  ("txn_id IN (SELECT id FROM txns WHERE root=?)", root),
                                  ("EXISTS (SELECT 1 FROM json_each(events.to_json) WHERE value=?)", to)):
                if value:
                    where.append(clause)
                    args.append(value)
            sql = "SELECT body FROM events" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY seq LIMIT ?"
            rows = self.db.execute(sql, (*args, limit)).fetchall()
        return [json.loads(r["body"]) for r in rows]

    def count_events(self) -> int:
        with self.lock:
            return self.db.execute("SELECT COUNT(*) FROM events").fetchone()[0]

    # txns

    def get_txn(self, txn_id: str) -> Optional[dict[str, Any]]:
        with self.lock:
            row = self.db.execute("SELECT * FROM txns WHERE id=?", (txn_id,)).fetchone()
        return dict(row) if row else None

    def put_txn(self, row: dict[str, Any]) -> None:
        with self.lock:
            self.db.execute(f"INSERT OR REPLACE INTO txns({','.join(TXN_COLUMNS)}) "
                            f"VALUES ({','.join(':' + c for c in TXN_COLUMNS)})", row)

    def txns(self, state: Optional[str] = None, root: Optional[str] = None, parent: Optional[str] = None,
             limit: int = 200) -> list[dict[str, Any]]:
        """Newest updated first. state: "open" = not closed, "closed" = any closed state, else that exact state."""
        where: list[str] = []
        args: list[Any] = []
        if state == "open":
            where.append(f"state NOT IN {_CLOSED_SQL}")
        elif state == "closed":
            where.append(f"state IN {_CLOSED_SQL}")
        elif state:
            where.append("state=?")
            args.append(state)
        for clause, value in (("root=?", root), ("parent=?", parent)):
            if value:
                where.append(clause)
                args.append(value)
        sql = "SELECT * FROM txns" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY updated_at DESC, last_event DESC LIMIT ?"
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, (*args, limit)).fetchall()]

    def overdue(self, now: str) -> list[dict[str, Any]]:
        with self.lock:
            rows = self.db.execute(f"SELECT * FROM txns WHERE deadline IS NOT NULL AND deadline < ? "
                                   f"AND state NOT IN {_CLOSED_SQL}", (now,)).fetchall()
        return [dict(r) for r in rows]

    def count_open_txns(self) -> int:
        with self.lock:
            return self.db.execute(f"SELECT COUNT(*) FROM txns WHERE state NOT IN {_CLOSED_SQL}").fetchone()[0]

    def prune(self, cutoff: str) -> tuple[int, int]:
        """Delete events older than cutoff and txns closed before it. Returns (events, txns) deleted."""
        with self.lock:
            e = self.db.execute("DELETE FROM events WHERE at < ?", (cutoff,)).rowcount
            t = self.db.execute("DELETE FROM txns WHERE closed_at IS NOT NULL AND closed_at < ?", (cutoff,)).rowcount
        return e, t
