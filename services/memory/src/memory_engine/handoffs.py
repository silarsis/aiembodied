"""Handoff notes: what the agent writes for its next conversation, in its own words (where
things stand, what it was in the middle of, what to follow up). One per conversation; writing
again replaces it. The newest from another conversation goes in the brief whole, never cut or
paraphrased, and each is indexed (kind 'handoff') so it can be searched later."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

import psycopg

from .store import _tombstone

HANDOFF_MAX_CHARS = 2000
HANDOFF_IMPORTANCE = 0.7
HANDOFF_NAMESPACE = uuid.UUID("5b0f6c1e-8a43-4d0a-9a55-6f1f0d3b7a21")


def handoff_id(session_id: UUID) -> UUID:
    """One note per conversation, with an id anyone can work out from the conversation's."""
    return uuid.uuid5(HANDOFF_NAMESPACE, str(session_id))


def put_handoff(
    conn: psycopg.Connection,
    session_id: UUID,
    text: str,
    *,
    agent: Optional[str] = None,
    model: Optional[str] = None,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """Write (or replace) the note for this conversation. The conversation is created if its
    own write is still queued."""
    at = now or datetime.now(timezone.utc)
    text = text.strip()[:HANDOFF_MAX_CHARS]
    conn.execute("INSERT INTO sessions (id, started_at) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING", (session_id, at))
    note_id = handoff_id(session_id)
    conn.execute(
        """
        INSERT INTO handoffs (id, session_id, agent, model, text, created_at, updated_at)
        VALUES (%(id)s, %(session)s, %(agent)s, %(model)s, %(text)s, %(at)s, %(at)s)
        ON CONFLICT (session_id) DO UPDATE SET
            agent = excluded.agent, model = excluded.model, text = excluded.text, updated_at = excluded.updated_at
        """,
        {"id": note_id, "session": session_id, "agent": agent, "model": (model or "").strip() or None, "text": text, "at": at},
    )
    conn.execute(
        """
        INSERT INTO recall_index (kind, source_id, session_id, agent, period_start, period_end, text, importance)
        VALUES ('handoff', %(id)s, %(session)s, %(agent)s, %(at)s, %(at)s, %(text)s, %(importance)s)
        ON CONFLICT (kind, source_id) DO UPDATE SET
            agent = excluded.agent,
            period_start = excluded.period_start,
            period_end = excluded.period_end,
            text = excluded.text,
            embedding = CASE WHEN recall_index.text = excluded.text THEN recall_index.embedding END,
            embed_model = CASE WHEN recall_index.text = excluded.text THEN recall_index.embed_model END,
            updated_at = now()
        """,
        {"id": note_id, "session": session_id, "agent": agent, "at": at, "text": text, "importance": HANDOFF_IMPORTANCE},
    )
    return {"id": str(note_id), "session_id": str(session_id)}


def latest(conn: psycopg.Connection, *, exclude_session: Optional[UUID] = None) -> Optional[dict[str, Any]]:
    """The newest note left in any conversation but `exclude_session` (the one starting)."""
    row = conn.execute(
        """
        SELECT id, session_id, agent, model, text, updated_at FROM handoffs
        WHERE %(session)s::uuid IS NULL OR session_id <> %(session)s
        ORDER BY updated_at DESC LIMIT 1
        """,
        {"session": exclude_session},
    ).fetchone()
    if not row:
        return None
    return {
        "id": str(row[0]),
        "session_id": str(row[1]),
        "agent": row[2],
        "model": row[3],
        "text": row[4],
        "written_at": row[5].isoformat(),
    }


def delete_for_session(conn: psycopg.Connection, session_id: UUID) -> None:
    rows = conn.execute("DELETE FROM handoffs WHERE session_id = %s RETURNING id", (session_id,)).fetchall()
    _tombstone(conn, [("handoffs", r[0]) for r in rows])
