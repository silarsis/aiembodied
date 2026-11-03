"""Reads and writes against the memory schema. Every function takes a connection from the pool."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Optional, Sequence
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from .turns import Message, assemble_turns


@dataclass
class SessionIn:
    id: UUID
    started_at: datetime
    agent: Optional[str] = None
    channel: Optional[str] = None
    title: Optional[str] = None
    location: Optional[str] = None
    ended_at: Optional[datetime] = None
    meta: Optional[dict[str, Any]] = None


@dataclass
class MessageIn:
    id: UUID
    session_id: UUID
    role: str
    content: str
    created_at: datetime
    speaker: Optional[str] = None
    location: Optional[str] = None
    tool: Optional[dict[str, Any]] = None
    private: bool = False
    meta: Optional[dict[str, Any]] = None


def content_hash(role: str, content: str, tool: Optional[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    digest.update(role.encode())
    digest.update(b"\0")
    digest.update(content.encode())
    if tool:
        digest.update(b"\0")
        digest.update(repr(sorted(tool.items())).encode())
    return digest.hexdigest()


def upsert_session(conn: psycopg.Connection, session: SessionIn) -> None:
    """Create the session, or fill in what an earlier write didn't know. A session made up on
    the fly for a message that arrived first has agent and channel 'unknown'; the real values
    replace those, and the earliest start time wins."""
    conn.execute(
        """
        INSERT INTO sessions (id, agent, channel, title, location, started_at, ended_at, meta)
        VALUES (%(id)s, coalesce(%(agent)s, 'unknown'), coalesce(%(channel)s, 'unknown'),
                %(title)s, %(location)s, %(started_at)s, %(ended_at)s, %(meta)s)
        ON CONFLICT (id) DO UPDATE SET
            agent = CASE WHEN %(agent)s IS NULL THEN sessions.agent ELSE %(agent)s END,
            channel = CASE WHEN %(channel)s IS NULL THEN sessions.channel ELSE %(channel)s END,
            title = coalesce(%(title)s, sessions.title),
            location = coalesce(%(location)s, sessions.location),
            started_at = least(sessions.started_at, %(started_at)s),
            ended_at = coalesce(%(ended_at)s, sessions.ended_at),
            meta = sessions.meta || %(meta)s,
            updated_at = now()
        """,
        {
            "id": session.id,
            "agent": session.agent,
            "channel": session.channel,
            "title": session.title,
            "location": session.location,
            "started_at": session.started_at,
            "ended_at": session.ended_at,
            "meta": Jsonb(session.meta or {}),
        },
    )


def insert_messages(conn: psycopg.Connection, messages: Sequence[MessageIn]) -> tuple[int, int]:
    """Insert messages, ignoring IDs already stored. Unknown sessions are created from the
    message's time. Turns of every session touched are rebuilt. Returns (inserted, duplicates)."""
    inserted = 0
    touched: set[UUID] = set()
    for session_id, first in _earliest_per_session(messages).items():
        conn.execute(
            "INSERT INTO sessions (id, started_at) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
            (session_id, first),
        )
    for message in messages:
        row = conn.execute(
            """
            INSERT INTO messages (id, session_id, role, speaker, location, content, tool,
                                  created_at, content_hash, private, meta)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO NOTHING
            RETURNING id
            """,
            (
                message.id,
                message.session_id,
                message.role,
                message.speaker,
                message.location,
                message.content,
                Jsonb(message.tool) if message.tool is not None else None,
                message.created_at,
                content_hash(message.role, message.content, message.tool),
                message.private,
                Jsonb(message.meta or {}),
            ),
        ).fetchone()
        if row:
            inserted += 1
            touched.add(message.session_id)
    for session_id in touched:
        rebuild_turns(conn, session_id)
    return inserted, len(messages) - inserted


def _earliest_per_session(messages: Iterable[MessageIn]) -> dict[UUID, datetime]:
    earliest: dict[UUID, datetime] = {}
    for message in messages:
        current = earliest.get(message.session_id)
        if current is None or message.created_at < current:
            earliest[message.session_id] = message.created_at
    return earliest


def rebuild_turns(conn: psycopg.Connection, session_id: UUID) -> int:
    """Rewrite the session's turn rows in recall_index from its messages. A turn whose text is
    unchanged keeps its row (and, later, its embedding). Returns the number of turns."""
    session = conn.execute("SELECT agent FROM sessions WHERE id = %s", (session_id,)).fetchone()
    agent = session[0] if session else None
    label = agent if agent and agent != "unknown" else "Assistant"
    rows = conn.execute(
        "SELECT id, role, content, created_at, seq, speaker, tool, private"
        " FROM messages WHERE session_id = %s",
        (session_id,),
    ).fetchall()
    turns = assemble_turns(
        [Message(id=r[0], role=r[1], content=r[2], created_at=r[3], seq=r[4], speaker=r[5], tool=r[6], private=r[7])
         for r in rows]
    )
    keep = [turn.source_id for turn in turns]
    deleted = conn.execute(
        "DELETE FROM recall_index WHERE kind = 'turn' AND session_id = %s AND NOT (source_id = ANY(%s))"
        " RETURNING id",
        (session_id, keep),
    ).fetchall()
    for (row_id,) in deleted:
        conn.execute("INSERT INTO tombstones (table_name, row_id) VALUES ('recall_index', %s)", (row_id,))
    for turn in turns:
        conn.execute(
            """
            INSERT INTO recall_index (kind, source_id, session_id, agent, period_start, period_end,
                                      text, message_ids, private)
            VALUES ('turn', %(source)s, %(session)s, %(agent)s, %(start)s, %(end)s, %(text)s, %(ids)s, %(private)s)
            ON CONFLICT (kind, source_id) DO UPDATE SET
                session_id = excluded.session_id,
                agent = excluded.agent,
                period_start = excluded.period_start,
                period_end = excluded.period_end,
                message_ids = excluded.message_ids,
                private = excluded.private,
                text = excluded.text,
                embedding = CASE WHEN recall_index.text = excluded.text THEN recall_index.embedding END,
                embed_model = CASE WHEN recall_index.text = excluded.text THEN recall_index.embed_model END,
                updated_at = now()
            WHERE recall_index.text IS DISTINCT FROM excluded.text
               OR recall_index.message_ids IS DISTINCT FROM excluded.message_ids
               OR recall_index.agent IS DISTINCT FROM excluded.agent
               OR recall_index.private IS DISTINCT FROM excluded.private
            """,
            {
                "source": turn.source_id,
                "session": session_id,
                "agent": agent,
                "start": turn.period_start,
                "end": turn.period_end,
                "text": turn.text(label),
                "ids": turn.message_ids,
                "private": turn.private,
            },
        )
    return len(turns)


def list_sessions(
    conn: psycopg.Connection,
    *,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    agent: Optional[str] = None,
    limit: int = 50,
    before_seq: Optional[int] = None,
) -> list[dict[str, Any]]:
    """Sessions newest first, with message counts and the time of their last message.
    `start`/`end` select sessions with any activity in that range."""
    rows = conn.execute(
        """
        SELECT s.id, s.agent, s.channel, s.title, s.location, s.started_at,
               coalesce(s.ended_at, m.last_at) AS ended_at, coalesce(m.count, 0), s.seq
        FROM sessions s
        LEFT JOIN LATERAL (
            SELECT count(*) AS count, max(created_at) AS last_at FROM messages WHERE session_id = s.id
        ) m ON true
        WHERE (%(start)s::timestamptz IS NULL OR coalesce(s.ended_at, m.last_at, s.started_at) >= %(start)s)
          AND (%(end)s::timestamptz IS NULL OR s.started_at < %(end)s)
          AND (%(agent)s::text IS NULL OR s.agent = %(agent)s)
          AND (%(before)s::bigint IS NULL OR s.seq < %(before)s)
        ORDER BY s.started_at DESC, s.seq DESC
        LIMIT %(limit)s
        """,
        {"start": start, "end": end, "agent": agent, "before": before_seq, "limit": limit},
    ).fetchall()
    return [
        {
            "id": str(r[0]),
            "agent": r[1],
            "channel": r[2],
            "title": r[3],
            "location": r[4],
            "started_at": r[5].isoformat(),
            "ended_at": r[6].isoformat() if r[6] else None,
            "message_count": r[7],
            "seq": r[8],
        }
        for r in rows
    ]


def session_messages(conn: psycopg.Connection, session_id: UUID) -> Optional[list[dict[str, Any]]]:
    if not conn.execute("SELECT 1 FROM sessions WHERE id = %s", (session_id,)).fetchone():
        return None
    rows = conn.execute(
        "SELECT id, role, speaker, location, content, tool, created_at, private"
        " FROM messages WHERE session_id = %s ORDER BY created_at, seq",
        (session_id,),
    ).fetchall()
    return [
        {
            "id": str(r[0]),
            "role": r[1],
            "speaker": r[2],
            "location": r[3],
            "content": r[4],
            "tool": r[5],
            "created_at": r[6].isoformat(),
            "private": r[7],
        }
        for r in rows
    ]


def search_text(
    conn: psycopg.Connection,
    query: str,
    *,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    agent: Optional[str] = None,
    kinds: Optional[Sequence[str]] = None,
    include_private: bool = True,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Full-text search over the recall index, best match first. Embedding search joins this
    in phase 2; the result shape stays the same."""
    rows = conn.execute(
        """
        SELECT r.id, r.kind, r.source_id, r.session_id, r.agent, r.period_start, r.period_end,
               r.text, ts_rank_cd(r.search, q) AS rank, r.private
        FROM recall_index r, websearch_to_tsquery('english', %(query)s) q
        WHERE r.search @@ q
          AND (%(start)s::timestamptz IS NULL OR r.period_end >= %(start)s)
          AND (%(end)s::timestamptz IS NULL OR r.period_start < %(end)s)
          AND (%(agent)s::text IS NULL OR r.agent = %(agent)s)
          AND (%(kinds)s::text[] IS NULL OR r.kind = ANY(%(kinds)s))
          AND (%(private)s OR NOT r.private)
        ORDER BY rank DESC, r.period_start DESC
        LIMIT %(limit)s
        """,
        {
            "query": query,
            "start": start,
            "end": end,
            "agent": agent,
            "kinds": list(kinds) if kinds else None,
            "private": include_private,
            "limit": limit,
        },
    ).fetchall()
    return [
        {
            "id": str(r[0]),
            "kind": r[1],
            "source_id": str(r[2]),
            "session_id": str(r[3]) if r[3] else None,
            "agent": r[4],
            "period_start": r[5].isoformat(),
            "period_end": r[6].isoformat(),
            "text": r[7],
            "score": float(r[8]),
            "private": r[9],
        }
        for r in rows
    ]


def delete_session(conn: psycopg.Connection, session_id: UUID) -> bool:
    """Forget a session: its messages and everything indexed from them."""
    index_ids = conn.execute(
        "DELETE FROM recall_index WHERE session_id = %s RETURNING id", (session_id,)
    ).fetchall()
    message_ids = conn.execute("DELETE FROM messages WHERE session_id = %s RETURNING id", (session_id,)).fetchall()
    session = conn.execute("DELETE FROM sessions WHERE id = %s RETURNING id", (session_id,)).fetchone()
    conn.execute("DELETE FROM recall_log WHERE session_id = %s", (session_id,))
    tombstones = [("recall_index", r[0]) for r in index_ids] + [("messages", r[0]) for r in message_ids]
    if session:
        tombstones.append(("sessions", session[0]))
    _tombstone(conn, tombstones)
    return session is not None


def delete_message(conn: psycopg.Connection, message_id: UUID) -> bool:
    row = conn.execute("DELETE FROM messages WHERE id = %s RETURNING session_id, content", (message_id,)).fetchone()
    if not row:
        return False
    # Auto-recall logged the words as its query; forgetting them means there too.
    conn.execute("DELETE FROM recall_log WHERE session_id = %s AND query = %s", (row[0], row[1]))
    _tombstone(conn, [("messages", message_id)])
    rebuild_turns(conn, row[0])
    return True


def _tombstone(conn: psycopg.Connection, rows: Sequence[tuple[str, UUID]]) -> None:
    for table, row_id in rows:
        conn.execute("INSERT INTO tombstones (table_name, row_id) VALUES (%s, %s)", (table, row_id))


def counts(conn: psycopg.Connection) -> dict[str, int]:
    row = conn.execute(
        "SELECT (SELECT count(*) FROM sessions), (SELECT count(*) FROM messages),"
        " (SELECT count(*) FROM recall_index)"
    ).fetchone()
    return {"sessions": row[0], "messages": row[1], "indexed": row[2]}
