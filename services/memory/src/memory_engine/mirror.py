"""Copy one memory database into another: a mirror kept up to date (a Supabase project as an
off-site copy), or a one-off move when the engine is switched to a new, empty database.

Rows keep their ids and `seq` numbers, so the copy is exact and either side could take over.
Each table is sent in `seq` order, and tables whose rows change in place (sessions, facts, the
index) are also sent by `updated_at`; every write is an upsert, so sending a row twice is
harmless. Deletes travel as tombstones. The marks of how far each mirror has got live in the
source's mirror_state table. Only the source writes; the mirror is never written by anyone
else, which is why no conflict handling is needed."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlsplit

import psycopg
from psycopg.types.json import Jsonb

from . import db

log = logging.getLogger("memory_engine.mirror")

BATCH = 500
# Rows numbered just before the mark may have committed after it was taken (two writes at once):
# each pass sends the last few again. Upserts make that harmless.
RESEND = 100
# Rows committed late can carry an updated_at a little before the mark; look back this far.
LOOKBACK = timedelta(minutes=2)

# (table, columns, changes in place). Order matters: parents before children.
TABLES: list[tuple[str, list[str], bool]] = [
    ("sessions", ["id", "seq", "agent", "channel", "title", "location", "started_at", "ended_at", "meta",
                  "created_at", "updated_at"], True),
    ("messages", ["id", "seq", "session_id", "role", "speaker", "location", "content", "tool", "created_at",
                  "received_at", "content_hash", "private", "meta"], False),
    ("facts", ["id", "seq", "text", "subject", "status", "pinned", "author", "agent", "session_id",
               "source_message_ids", "supersedes", "private", "reviewed_at", "created_at", "updated_at"], True),
    ("summaries", ["id", "seq", "kind", "session_id", "period_start", "period_end", "title", "text", "topics",
                   "covered_seq", "model", "created_at"], False),
    ("recall_index", ["id", "seq", "kind", "source_id", "session_id", "agent", "period_start", "period_end", "text",
                      "message_ids", "importance", "private", "embedding", "embed_model", "updated_at"], True),
]
JSON_COLUMNS = {"meta", "tool"}
TOMBSTONE_TABLES = {name for name, _, _ in TABLES}


def target_name(url: str) -> str:
    """user@host:port/database: names a mirror without its password."""
    parts = urlsplit(url)
    user = parts.username or ""
    host = parts.hostname or ""
    port = f":{parts.port}" if parts.port else ""
    return f"{user}@{host}{port}{parts.path or ''}"


def connect_target(url: str, schema: str) -> psycopg.Connection:
    """Open the other database and bring its schema up to date."""
    conn = psycopg.connect(url, autocommit=True, connect_timeout=10)
    try:
        db.migrate(conn, schema)
        conn.execute(f"SET search_path TO {db.search_path(schema)}")
    except Exception:
        conn.close()
        raise
    conn.autocommit = False
    return conn


def _select(table: str, columns: list[str]) -> str:
    return ", ".join("embedding::text" if c == "embedding" else c for c in columns)


def _upsert_sql(table: str, columns: list[str]) -> str:
    values = ", ".join("%s::vector" if c == "embedding" else "%s" for c in columns)
    updates = ", ".join(f"{c} = excluded.{c}" for c in columns if c not in ("id", "seq"))
    return (
        f"INSERT INTO {table} ({', '.join(columns)}) OVERRIDING SYSTEM VALUE VALUES ({values}) "  # noqa: S608 - fixed names
        f"ON CONFLICT (id) DO UPDATE SET {updates}"
    )


def _row(columns: list[str], row: tuple) -> list[Any]:
    return [Jsonb(value) if column in JSON_COLUMNS and value is not None else value for column, value in zip(columns, row)]


def push(source: psycopg.Connection, target: psycopg.Connection, marks: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Send everything newer than `marks` from source to target. Returns the new marks and how
    many rows (and tombstones) were sent. The target's changes are committed per table."""
    marks = dict(marks)
    sent = 0
    for table, columns, changes in TABLES:
        seq_key, time_key = f"{table}.seq", f"{table}.updated_at"
        after = max(0, marks.get(seq_key, 0) - RESEND)
        while True:
            rows = source.execute(
                f"SELECT {_select(table, columns)} FROM {table} WHERE seq > %s ORDER BY seq LIMIT %s",  # noqa: S608
                (after, BATCH),
            ).fetchall()
            if not rows:
                break
            target.cursor().executemany(_upsert_sql(table, columns), [_row(columns, r) for r in rows])
            after = rows[-1][columns.index("seq")]
            if after > marks.get(seq_key, 0):
                sent += sum(1 for r in rows if r[columns.index("seq")] > marks.get(seq_key, 0))
                marks[seq_key] = after
        if changes:
            since = marks.get(time_key)
            if since:
                start = datetime.fromisoformat(since) - LOOKBACK
                rows = source.execute(
                    f"SELECT {_select(table, columns)} FROM {table}"  # noqa: S608
                    " WHERE updated_at >= %s AND seq <= %s ORDER BY updated_at",
                    (start, marks.get(seq_key, 0)),
                ).fetchall()
                if rows:
                    target.cursor().executemany(_upsert_sql(table, columns), [_row(columns, r) for r in rows])
                    sent += len(rows)
            newest = source.execute(f"SELECT max(updated_at) FROM {table}").fetchone()[0]  # noqa: S608
            if newest:
                marks[time_key] = newest.isoformat()
        # Keep the target's own counter past the copied numbers, should it ever take over.
        target.execute(
            f"SELECT setval(pg_get_serial_sequence('{table}', 'seq'), greatest((SELECT max(seq) FROM {table}), 1))"  # noqa: S608
        )
        target.commit()

    while True:
        rows = source.execute(
            "SELECT seq, table_name, row_id FROM tombstones WHERE seq > %s ORDER BY seq LIMIT %s",
            (marks.get("tombstones.seq", 0), BATCH),
        ).fetchall()
        if not rows:
            break
        for _, table, row_id in rows:
            if table in TOMBSTONE_TABLES:
                target.execute(f"DELETE FROM {table} WHERE id = %s", (row_id,))  # noqa: S608 - checked name
        target.execute(
            "INSERT INTO tombstones (table_name, row_id) VALUES " + ", ".join(["(%s, %s)"] * len(rows)),
            [value for _, table, row_id in rows for value in (table, row_id)],
        )
        target.commit()
        marks["tombstones.seq"] = rows[-1][0]
        sent += len(rows)
    return marks, sent


def load_marks(conn: psycopg.Connection, target: str) -> dict[str, Any]:
    row = conn.execute("SELECT marks FROM mirror_state WHERE target = %s", (target,)).fetchone()
    return dict(row[0]) if row else {}


def save_marks(conn: psycopg.Connection, target: str, marks: dict[str, Any], error: Optional[str] = None) -> None:
    conn.execute(
        """
        INSERT INTO mirror_state (target, marks, last_push_at, last_error) VALUES (%s, %s, now(), %s)
        ON CONFLICT (target) DO UPDATE SET marks = excluded.marks, last_push_at = now(), last_error = excluded.last_error
        """,
        (target, Jsonb(marks), error),
    )


def is_empty(conn: psycopg.Connection) -> bool:
    return conn.execute("SELECT NOT EXISTS (SELECT 1 FROM sessions) AND NOT EXISTS (SELECT 1 FROM facts)").fetchone()[0]


class SourceUnavailable(Exception):
    """The database being moved from can't be read, so there is nothing to copy."""


def copy_all(source_url: str, target_url: str, schema: str) -> int:
    """Copy one database into another that is empty (a move). Returns rows copied; 0 when the
    target already has memory in it, which is then used as it is."""
    try:
        source = psycopg.connect(source_url, autocommit=False, connect_timeout=10)
        source.execute(f"SET search_path TO {db.search_path(schema)}")
        source.execute("SELECT 1 FROM sessions LIMIT 1")
    except psycopg.Error as error:
        raise SourceUnavailable(str(error)) from error
    with source:
        with connect_target(target_url, schema) as target:
            if not is_empty(target):
                return 0
            _, sent = push(source, target, {})
            return sent


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
