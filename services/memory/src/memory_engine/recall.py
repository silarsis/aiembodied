"""Embedding the recall index, and finding things in it: hybrid search, the timeline, and the
full context of one memory."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Sequence
from uuid import UUID

import psycopg

from .embed import Embedder, to_pgvector

# Reciprocal rank fusion constant, and how many candidates each search contributes.
RRF_K = 60
CANDIDATES = 30
# Recency is a gentle boost, not a cut-off: a strong match from years ago still wins.
RECENCY_WEIGHT = 0.3
RECENCY_HALF_LIFE_DAYS = 90.0


def embed_pending(conn: psycopg.Connection, embedder: Embedder, limit: int = 64) -> int:
    """Embed index rows that have no vector from the current model. Returns how many."""
    rows = conn.execute(
        "SELECT id, text FROM recall_index WHERE embedding IS NULL OR embed_model IS DISTINCT FROM %s"
        " ORDER BY seq LIMIT %s",
        (embedder.name, limit),
    ).fetchall()
    if not rows:
        return 0
    vectors = embedder.embed([text for _, text in rows])
    for (row_id, text), vector in zip(rows, vectors):
        # Only if the text is unchanged since it was read: a rewrite clears the vector again.
        conn.execute(
            "UPDATE recall_index SET embedding = %s::vector, embed_model = %s, updated_at = now()"
            " WHERE id = %s AND text = %s",
            (to_pgvector(vector), embedder.name, row_id, text),
        )
    return len(rows)


def _filters(alias: str = "r") -> str:
    return f"""
          AND (%(start)s::timestamptz IS NULL OR {alias}.period_end >= %(start)s)
          AND (%(end)s::timestamptz IS NULL OR {alias}.period_start < %(end)s)
          AND (%(agent)s::text IS NULL OR {alias}.agent = %(agent)s)
          AND (%(kinds)s::text[] IS NULL OR {alias}.kind = ANY(%(kinds)s))
          AND (%(private)s OR NOT {alias}.private)
          AND NOT ({alias}.id = ANY(%(exclude)s))
    """


def hybrid_search(
    conn: psycopg.Connection,
    query: str,
    *,
    embedder: Optional[Embedder] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    agent: Optional[str] = None,
    kinds: Optional[Sequence[str]] = None,
    include_private: bool = True,
    exclude_ids: Sequence[UUID] = (),
    limit: int = 10,
    now: Optional[datetime] = None,
) -> list[dict[str, Any]]:
    """Full-text and vector search, each taking its best CANDIDATES, fused by reciprocal rank,
    then nudged by recency and importance. Full-text uses any of the query's words, so a spoken
    question still matches. Each result carries `similarity` (cosine, when embedded) so callers
    can set their own bar."""
    params: dict[str, Any] = {
        "query": query,
        "start": start,
        "end": end,
        "agent": agent,
        "kinds": list(kinds) if kinds else None,
        "private": include_private,
        "exclude": list(exclude_ids),
        "candidates": CANDIDATES,
    }
    ranks: dict[UUID, dict[str, float]] = {}

    text_rows = conn.execute(
        f"""
        WITH q AS (
            SELECT to_tsquery('english', coalesce(nullif(array_to_string(array(
                SELECT quote_literal(lexeme) FROM unnest(tsvector_to_array(to_tsvector('english', %(query)s))) lexeme
            ), ' | '), ''), quote_literal(''))) AS tsq
        )
        SELECT r.id FROM recall_index r, q
        WHERE r.search @@ q.tsq {_filters()}
        ORDER BY ts_rank_cd(r.search, q.tsq) DESC, r.period_start DESC
        LIMIT %(candidates)s
        """,
        params,
    ).fetchall()
    for rank, (row_id,) in enumerate(text_rows, start=1):
        ranks.setdefault(row_id, {})["text_rank"] = rank

    if embedder is not None:
        try:
            vector = embedder.embed([query])[0]
        except Exception:  # noqa: BLE001 - a broken model falls back to words alone
            vector = None
        if vector is not None:
            params["vector"] = to_pgvector(vector)
            params["model"] = embedder.name
            vector_rows = conn.execute(
                f"""
                SELECT r.id, 1 - (r.embedding <=> %(vector)s::vector) AS similarity
                FROM recall_index r
                WHERE r.embed_model = %(model)s AND r.embedding IS NOT NULL {_filters()}
                ORDER BY r.embedding <=> %(vector)s::vector
                LIMIT %(candidates)s
                """,
                params,
            ).fetchall()
            for rank, (row_id, similarity) in enumerate(vector_rows, start=1):
                entry = ranks.setdefault(row_id, {})
                entry["vector_rank"] = rank
                entry["similarity"] = float(similarity)

    if not ranks:
        return []
    rows = conn.execute(
        "SELECT id, kind, source_id, session_id, agent, period_start, period_end, text, importance, private"
        " FROM recall_index WHERE id = ANY(%s)",
        (list(ranks),),
    ).fetchall()
    now = now or datetime.now(timezone.utc)
    results = []
    for r in rows:
        rank = ranks[r[0]]
        fused = sum(1.0 / (RRF_K + rank[key]) for key in ("text_rank", "vector_rank") if key in rank)
        age_days = max(0.0, (now - r[6]).total_seconds() / 86400.0)
        recency = 1.0 + RECENCY_WEIGHT * math.pow(2.0, -age_days / RECENCY_HALF_LIFE_DAYS)
        importance = 0.75 + 0.5 * float(r[8])
        results.append(
            {
                "id": str(r[0]),
                "kind": r[1],
                "source_id": str(r[2]),
                "session_id": str(r[3]) if r[3] else None,
                "agent": r[4],
                "period_start": r[5].isoformat(),
                "period_end": r[6].isoformat(),
                "text": r[7],
                "private": r[9],
                "score": fused * recency * importance,
                "similarity": rank.get("similarity"),
                "matched": [key.removesuffix("_rank") for key in ("text_rank", "vector_rank") if key in rank],
            }
        )
    results.sort(key=lambda item: item["score"], reverse=True)
    return results[:limit]


def timeline(
    conn: psycopg.Connection,
    start: datetime,
    end: datetime,
    *,
    agent: Optional[str] = None,
    include_private: bool = True,
    turns_per_session: int = 6,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """What happened in [start, end): each session with activity in the range, oldest first,
    with the start of its first few turns. Day and week summaries take over in phase 4."""
    sessions = conn.execute(
        """
        SELECT s.id, s.agent, s.channel, s.title, s.started_at, m.last_at, m.count
        FROM sessions s
        JOIN LATERAL (
            SELECT count(*) AS count, max(created_at) AS last_at, min(created_at) AS first_at
            FROM messages WHERE session_id = s.id AND role IN ('user', 'assistant')
        ) m ON m.count > 0
        WHERE m.last_at >= %(start)s AND m.first_at < %(end)s
          AND (%(agent)s::text IS NULL OR s.agent = %(agent)s)
        ORDER BY m.first_at
        LIMIT %(limit)s
        """,
        {"start": start, "end": end, "agent": agent, "limit": limit},
    ).fetchall()
    out = []
    for s in sessions:
        turns = conn.execute(
            """
            SELECT id, period_start, text, private FROM recall_index
            WHERE kind = 'turn' AND session_id = %s AND period_start >= %s AND period_start < %s
              AND (%s OR NOT private)
            ORDER BY period_start LIMIT %s
            """,
            (s[0], start, end, include_private, turns_per_session),
        ).fetchall()
        out.append(
            {
                "session_id": str(s[0]),
                "agent": s[1],
                "channel": s[2],
                "title": s[3],
                "started_at": s[4].isoformat(),
                "last_at": s[5].isoformat(),
                "message_count": s[6],
                "summary": _session_summary(conn, s[0]),
                "turns": [{"id": str(t[0]), "at": t[1].isoformat(), "text": t[2][:300]} for t in turns],
            }
        )
    return out


def _session_summary(conn: psycopg.Connection, session_id: UUID) -> Optional[dict[str, Any]]:
    row = conn.execute(
        "SELECT r.id, s.title, s.text, s.topics FROM summaries s"
        " JOIN recall_index r ON r.source_id = s.id"
        " WHERE s.kind = 'session' AND s.session_id = %s",
        (session_id,),
    ).fetchone()
    return {"id": str(row[0]), "title": row[1], "text": row[2], "topics": list(row[3])} if row else None


def period_summaries(conn: psycopg.Connection, start: datetime, end: datetime, limit: int = 40) -> list[dict[str, Any]]:
    """Day, week or month summaries inside [start, end), the level picked by the span: days up
    to about a month, weeks up to about four months, months beyond."""
    days = (end - start).total_seconds() / 86400.0
    if days <= 2:
        return []
    kind = "day" if days <= 35 else "week" if days <= 125 else "month"
    rows = conn.execute(
        """
        SELECT r.id, s.kind, s.period_start, s.period_end, s.title, s.text, s.topics
        FROM summaries s JOIN recall_index r ON r.source_id = s.id
        WHERE s.kind = %s AND s.period_start >= %s AND s.period_end <= %s
        ORDER BY s.period_start LIMIT %s
        """,
        (kind, start - timedelta(hours=14), end + timedelta(hours=14), limit),
    ).fetchall()
    return [
        {
            "id": str(r[0]),
            "kind": r[1],
            "period_start": r[2].isoformat(),
            "period_end": r[3].isoformat(),
            "title": r[4],
            "text": r[5],
            "topics": list(r[6]),
        }
        for r in rows
    ]


def memory_detail(conn: psycopg.Connection, index_id: UUID, around: int = 1) -> Optional[dict[str, Any]]:
    """One memory in full: a turn with `around` turns either side, verbatim; or a fact with the
    messages it came from."""
    row = conn.execute(
        "SELECT id, kind, source_id, session_id, period_start, text FROM recall_index WHERE id = %s OR source_id = %s"
        " ORDER BY (id = %s) DESC LIMIT 1",
        (index_id, index_id, index_id),
    ).fetchone()
    if not row:
        return None
    kind, source_id, session_id = row[1], row[2], row[3]
    detail: dict[str, Any] = {"id": str(row[0]), "kind": kind, "period_start": row[4].isoformat()}
    if kind == "turn" and session_id:
        turns = conn.execute(
            "SELECT source_id, period_start, message_ids FROM recall_index"
            " WHERE kind = 'turn' AND session_id = %s ORDER BY period_start",
            (session_id,),
        ).fetchall()
        position = next((i for i, t in enumerate(turns) if t[0] == source_id), 0)
        chosen = turns[max(0, position - around): position + around + 1]
        message_ids = [mid for t in chosen for mid in t[2]]
        session = conn.execute("SELECT agent, channel, title FROM sessions WHERE id = %s", (session_id,)).fetchone()
        detail.update(
            {
                "session_id": str(session_id),
                "agent": session[0] if session else None,
                "messages": _messages(conn, message_ids),
            }
        )
    elif kind == "fact":
        fact = conn.execute(
            "SELECT text, subject, status, source_message_ids, created_at FROM facts WHERE id = %s", (source_id,)
        ).fetchone()
        detail.update({"text": row[5]})
        if fact:
            detail.update({"subject": fact[1], "status": fact[2], "messages": _messages(conn, fact[3])})
    else:  # a summary: the conversation, day, week or month as a whole
        detail["text"] = row[5]
        if session_id:
            detail["session_id"] = str(session_id)
    return detail


def _messages(conn: psycopg.Connection, ids: Sequence[UUID]) -> list[dict[str, Any]]:
    if not ids:
        return []
    rows = conn.execute(
        "SELECT id, role, speaker, content, tool, created_at FROM messages WHERE id = ANY(%s) ORDER BY created_at, seq",
        (list(ids),),
    ).fetchall()
    return [
        {"id": str(r[0]), "role": r[1], "speaker": r[2], "content": r[3], "tool": r[4], "created_at": r[5].isoformat()}
        for r in rows
    ]
