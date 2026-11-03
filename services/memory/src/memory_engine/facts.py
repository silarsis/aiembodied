"""Facts: short durable statements about the user and their world, each mirrored into the
recall index (kind 'fact') while it is active."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Sequence
from uuid import UUID

import psycopg

from .store import _tombstone

PINNED_IMPORTANCE = 1.0
FACT_IMPORTANCE = 0.8


@dataclass
class FactIn:
    id: UUID
    text: str
    subject: Optional[str] = None
    author: str = "agent"
    agent: Optional[str] = None
    session_id: Optional[UUID] = None
    source_message_ids: Sequence[UUID] = field(default_factory=list)
    supersedes: Optional[UUID] = None
    pinned: bool = False
    private: bool = False


def add_fact(conn: psycopg.Connection, fact: FactIn) -> bool:
    """Store a fact (a repeat of the same id is ignored). If it supersedes another, that one is
    marked superseded and leaves the index. Returns False for a repeat."""
    session_id = fact.session_id
    if session_id and not conn.execute("SELECT 1 FROM sessions WHERE id = %s", (session_id,)).fetchone():
        session_id = None  # the session's write may still be queued; the link is a nicety
    row = conn.execute(
        """
        INSERT INTO facts (id, text, subject, author, agent, session_id, source_message_ids, supersedes, pinned, private)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (id) DO NOTHING RETURNING id
        """,
        (
            fact.id,
            fact.text.strip(),
            (fact.subject or "").strip() or None,
            fact.author,
            fact.agent,
            session_id,
            list(fact.source_message_ids),
            fact.supersedes,
            fact.pinned,
            fact.private,
        ),
    ).fetchone()
    if not row:
        return False
    if fact.supersedes:
        conn.execute(
            "UPDATE facts SET status = 'superseded', updated_at = now() WHERE id = %s AND status = 'active'",
            (fact.supersedes,),
        )
        _unindex(conn, fact.supersedes)
    _index(conn, fact.id)
    return True


def update_fact(
    conn: psycopg.Connection,
    fact_id: UUID,
    *,
    text: Optional[str] = None,
    subject: Optional[str] = None,
    pinned: Optional[bool] = None,
    status: Optional[str] = None,
    private: Optional[bool] = None,
    reviewed: bool = False,
) -> bool:
    row = conn.execute(
        """
        UPDATE facts SET
            text = coalesce(%s, text),
            subject = coalesce(%s, subject),
            pinned = coalesce(%s, pinned),
            status = coalesce(%s, status),
            private = coalesce(%s, private),
            reviewed_at = CASE WHEN %s THEN now() ELSE reviewed_at END,
            updated_at = now()
        WHERE id = %s RETURNING status
        """,
        (text.strip() if text else None, subject, pinned, status, private, reviewed, fact_id),
    ).fetchone()
    if not row:
        return False
    if row[0] == "active":
        _index(conn, fact_id)
    else:
        _unindex(conn, fact_id)
    return True


def delete_fact(conn: psycopg.Connection, fact_id: UUID) -> bool:
    _unindex(conn, fact_id)
    row = conn.execute("DELETE FROM facts WHERE id = %s RETURNING id", (fact_id,)).fetchone()
    if row:
        _tombstone(conn, [("facts", fact_id)])
    return row is not None


def list_facts(
    conn: psycopg.Connection,
    *,
    status: Optional[str] = "active",
    pinned: Optional[bool] = None,
    subject: Optional[str] = None,
    unreviewed: bool = False,
    include_private: bool = True,
    limit: int = 200,
) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, text, subject, status, pinned, author, agent, session_id, source_message_ids,
               supersedes, private, reviewed_at, created_at
        FROM facts
        WHERE (%(status)s::text IS NULL OR status = %(status)s)
          AND (%(pinned)s::boolean IS NULL OR pinned = %(pinned)s)
          AND (%(subject)s::text IS NULL OR lower(subject) = lower(%(subject)s))
          AND (NOT %(unreviewed)s OR reviewed_at IS NULL)
          AND (%(private)s OR NOT private)
        ORDER BY pinned DESC, created_at DESC
        LIMIT %(limit)s
        """,
        {
            "status": status,
            "pinned": pinned,
            "subject": subject,
            "unreviewed": unreviewed,
            "private": include_private,
            "limit": limit,
        },
    ).fetchall()
    return [
        {
            "id": str(r[0]),
            "text": r[1],
            "subject": r[2],
            "status": r[3],
            "pinned": r[4],
            "author": r[5],
            "agent": r[6],
            "session_id": str(r[7]) if r[7] else None,
            "source_message_ids": [str(x) for x in r[8]],
            "supersedes": str(r[9]) if r[9] else None,
            "private": r[10],
            "reviewed_at": r[11].isoformat() if r[11] else None,
            "created_at": r[12].isoformat(),
        }
        for r in rows
    ]


def _index(conn: psycopg.Connection, fact_id: UUID) -> None:
    row = conn.execute(
        "SELECT text, subject, agent, session_id, pinned, private, created_at, status FROM facts WHERE id = %s",
        (fact_id,),
    ).fetchone()
    if not row or row[7] != "active":
        return
    text = f"{row[1]}: {row[0]}" if row[1] else row[0]
    conn.execute(
        """
        INSERT INTO recall_index (kind, source_id, session_id, agent, period_start, period_end, text, importance, private)
        VALUES ('fact', %(id)s, %(session)s, %(agent)s, %(at)s, %(at)s, %(text)s, %(importance)s, %(private)s)
        ON CONFLICT (kind, source_id) DO UPDATE SET
            text = excluded.text,
            importance = excluded.importance,
            private = excluded.private,
            embedding = CASE WHEN recall_index.text = excluded.text THEN recall_index.embedding END,
            embed_model = CASE WHEN recall_index.text = excluded.text THEN recall_index.embed_model END,
            updated_at = now()
        """,
        {
            "id": fact_id,
            "session": None,  # facts outlive their session; the link lives on the fact
            "agent": row[2],
            "at": row[6],
            "text": text,
            "importance": PINNED_IMPORTANCE if row[4] else FACT_IMPORTANCE,
            "private": row[5],
        },
    )


def _unindex(conn: psycopg.Connection, fact_id: UUID) -> None:
    rows = conn.execute(
        "DELETE FROM recall_index WHERE kind = 'fact' AND source_id = %s RETURNING id", (fact_id,)
    ).fetchall()
    _tombstone(conn, [("recall_index", r[0]) for r in rows])
