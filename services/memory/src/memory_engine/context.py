"""What goes in front of the model without it asking: the session brief (built once when a
conversation starts) and auto-recall (a few strong matches added to a user message). Both leave
out private items, which only the tools can reach. The client formats the text, so the engine
stays free of any one app's prompt wording."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Optional, Sequence
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from . import handoffs
from .embed import Embedder
from .facts import ACCESSIBILITY_SQL, touch
from .recall import hybrid_search

BRIEF_FACT_CHARS = 1200
BRIEF_TURNS = 3
BRIEF_TURN_CHARS = 300

RECALL_LIMIT = 3
RECALL_MAX_CHARS = 1600
RECALL_ITEM_CHARS = 500
RECALL_MIN_SIMILARITY = 0.6
RECALL_MIN_WORDS = 4

_WORD = re.compile(r"[\w']+")


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def brief(
    conn: psycopg.Connection,
    *,
    session_id: Optional[UUID] = None,
    agent: Optional[str] = None,
    fact_chars: int = BRIEF_FACT_CHARS,
) -> dict[str, Any]:
    """Pinned facts then the most used and recent others, up to `fact_chars`; the newest note
    the agent left itself; and how the last conversation (not `session_id`, the one starting)
    ended. `agent` is reported, not filtered on: every
    character shares one memory."""
    # Pinned first, then the easiest to reach: what is used stays, what never comes up fades
    # out of the brief (still searchable). See facts.ACCESSIBILITY_SQL.
    rows = conn.execute(
        f"""
        SELECT id, text, subject, pinned, created_at, {ACCESSIBILITY_SQL} AS accessibility FROM facts
        WHERE status = 'active' AND NOT private
        ORDER BY pinned DESC, accessibility DESC, created_at DESC
        LIMIT 200
        """
    ).fetchall()
    facts: list[dict[str, Any]] = []
    used = 0
    for r in rows:
        if used + len(r[1]) > fact_chars:
            if r[3]:
                continue  # a long pinned fact shouldn't push out the rest
            break
        used += len(r[1])
        facts.append(
            {"id": str(r[0]), "text": r[1], "subject": r[2], "pinned": r[3], "created_at": r[4].isoformat()}
        )

    last = conn.execute(
        """
        SELECT s.id, s.agent, s.channel, s.title, m.first_at, m.last_at
        FROM sessions s
        JOIN LATERAL (
            SELECT min(created_at) AS first_at, max(created_at) AS last_at FROM messages
            WHERE session_id = s.id AND role IN ('user', 'assistant') AND NOT private
        ) m ON m.last_at IS NOT NULL
        WHERE (%(session)s::uuid IS NULL OR s.id <> %(session)s)
        ORDER BY m.last_at DESC
        LIMIT 1
        """,
        {"session": session_id},
    ).fetchone()
    last_session = None
    if last:
        turns = conn.execute(
            """
            SELECT text FROM (
                SELECT text, period_start FROM recall_index
                WHERE kind = 'turn' AND session_id = %s AND NOT private
                ORDER BY period_start DESC LIMIT %s
            ) t ORDER BY period_start
            """,
            (last[0], BRIEF_TURNS),
        ).fetchall()
        summary = conn.execute(
            "SELECT title, text FROM summaries WHERE kind = 'session' AND session_id = %s", (last[0],)
        ).fetchone()
        last_session = {
            "summary": summary[1] if summary else None,
            "session_id": str(last[0]),
            "agent": last[1],
            "channel": last[2],
            "title": last[3],
            "started_at": last[4].isoformat(),
            "last_at": last[5].isoformat(),
            "turns": [_clip(t[0], BRIEF_TURN_CHARS) for t in turns],
        }
    # The last two closed days with a summary, if they were in the past week.
    days = conn.execute(
        """
        SELECT period_start, title, text FROM summaries
        WHERE kind = 'day' AND period_end > now() - interval '7 days'
        ORDER BY period_start DESC LIMIT 2
        """
    ).fetchall()
    recent_days = [{"period_start": d[0].isoformat(), "title": d[1], "text": d[2]} for d in reversed(days)]
    return {
        "agent": agent,
        "facts": facts,
        "handoff": handoffs.latest(conn, exclude_session=session_id),
        "last_session": last_session,
        "recent_days": recent_days,
    }


def auto_recall(
    conn: psycopg.Connection,
    text: str,
    *,
    embedder: Optional[Embedder],
    session_id: Optional[UUID] = None,
    exclude_ids: Sequence[UUID] = (),
    limit: int = RECALL_LIMIT,
    max_chars: int = RECALL_MAX_CHARS,
    min_similarity: float = RECALL_MIN_SIMILARITY,
    min_words: int = RECALL_MIN_WORDS,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """Up to `limit` memories that clearly bear on `text`, or none. Each must be close in
    meaning (cosine >= `min_similarity`), so this needs embeddings; most turns get nothing.
    The current session is skipped (it is already in the transcript), as are `exclude_ids`
    (recalled earlier in it). Every call is written to recall_log."""
    items: list[dict[str, Any]] = []
    reason: Optional[str] = None
    if len(_WORD.findall(text)) < min_words:
        reason = "short"
    elif embedder is None:
        reason = "no embedder"
    else:
        found = hybrid_search(
            conn,
            text,
            embedder=embedder,
            include_private=False,
            exclude_ids=exclude_ids,
            skip_session=session_id,
            limit=limit * 4,
            now=now,
        )
        used = 0
        for result in found:
            if (result["similarity"] or 0.0) < min_similarity:
                continue
            result["text"] = _clip(result["text"], RECALL_ITEM_CHARS)
            if used + len(result["text"]) > max_chars:
                break
            used += len(result["text"])
            items.append(result)
            if len(items) >= limit:
                break
        if not items:
            reason = "no strong match"
        # What was put in front of the model was used: those facts are refreshed.
        touch(conn, [item["id"] for item in items if item["kind"] == "fact"], session_id)
    conn.execute(
        "INSERT INTO recall_log (session_id, query, items, reason) VALUES (%s, %s, %s, %s)",
        (
            session_id,
            text,
            Jsonb([{k: item[k] for k in ("id", "kind", "score", "similarity")} for item in items]),
            reason,
        ),
    )
    return {"items": items, "reason": reason}


def recall_log(
    conn: psycopg.Connection, *, session_id: Optional[UUID] = None, limit: int = 50
) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, at, session_id, query, items, reason FROM recall_log
        WHERE (%(session)s::uuid IS NULL OR session_id = %(session)s)
        ORDER BY id DESC LIMIT %(limit)s
        """,
        {"session": session_id, "limit": limit},
    ).fetchall()
    return [
        {
            "id": r[0],
            "at": r[1].isoformat(),
            "session_id": str(r[2]) if r[2] else None,
            "query": r[3],
            "items": r[4],
            "reason": r[5],
        }
        for r in rows
    ]
