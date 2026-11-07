"""Facts: short durable statements about the user and their world, each mirrored into the
recall index (kind 'fact') while it is active."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Sequence
from uuid import UUID, uuid4

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
    model: Optional[str] = None


def add_fact(conn: psycopg.Connection, fact: FactIn) -> bool:
    """Store a fact (a repeat of the same id is ignored). If it supersedes another, that one is
    marked superseded and leaves the index. Returns False for a repeat."""
    session_id = fact.session_id
    if session_id and not conn.execute("SELECT 1 FROM sessions WHERE id = %s", (session_id,)).fetchone():
        session_id = None  # the session's write may still be queued; the link is a nicety
    row = conn.execute(
        """
        INSERT INTO facts (id, text, subject, author, agent, session_id, source_message_ids, supersedes, pinned,
                           private, model)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
            (fact.model or "").strip() or None,
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


# Fading. A fact is as easy to reach as 2^(-days since it was last used / its half-life). The
# half-life starts at FADE_HALF_LIFE_DAYS and doubles with each conversation it was recalled in
# (up to FADE_MAX_DOUBLINGS times), so what keeps coming up settles and what never does fades.
# Fading only decides what the brief has room for: nothing is deleted or hidden from search,
# and pinned facts don't fade. Computed when read, so no background job is needed.
FADE_HALF_LIFE_DAYS = 30.0
FADE_MAX_DOUBLINGS = 4

ACCESSIBILITY_SQL = (
    "CASE WHEN pinned THEN 1.0 ELSE power(2.0, -(extract(epoch FROM (now() - coalesce(last_recalled_at, created_at)))"
    f" / 86400.0) / ({FADE_HALF_LIFE_DAYS} * power(2.0, least(recall_count, {FADE_MAX_DOUBLINGS})))) END"
)


def touch(conn: psycopg.Connection, index_ids: Sequence[str], session_id: Optional[UUID] = None) -> int:
    """The facts among these recall-index rows were just used: each is refreshed, and counted
    once per conversation (a fact recalled five times in one chat is not five times as settled).
    Returns how many facts were touched."""
    if not index_ids:
        return 0
    rows = conn.execute(
        """
        UPDATE facts f SET
            recall_count = f.recall_count + CASE
                WHEN %(session)s::uuid IS NULL OR f.last_recalled_session IS DISTINCT FROM %(session)s THEN 1 ELSE 0 END,
            last_recalled_at = now(),
            last_recalled_session = coalesce(%(session)s::uuid, f.last_recalled_session),
            updated_at = now()
        FROM recall_index r
        WHERE r.kind = 'fact' AND r.source_id = f.id AND r.id = ANY(%(ids)s::uuid[])
        RETURNING f.id
        """,
        {"ids": [str(i) for i in index_ids], "session": session_id},
    ).fetchall()
    return len(rows)


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
        f"""
        SELECT id, text, subject, status, pinned, author, agent, session_id, source_message_ids,
               supersedes, private, reviewed_at, created_at, model, recall_count, last_recalled_at,
               {ACCESSIBILITY_SQL} AS accessibility
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
            "model": r[13],
            "recall_count": r[14],
            "last_recalled_at": r[15].isoformat() if r[15] else None,
            "accessibility": round(float(r[16]), 4),
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


# Correcting. The agent names a fact by its id (from a search) or by what it said; a match by
# words must be clear, or the closest candidates come back for it to pick from.
CORRECT_MIN_SIMILARITY = 0.8
CORRECT_MARGIN = 0.1


def find_fact(conn: psycopg.Connection, about: str, embedder: Any = None) -> tuple[Optional[UUID], list[dict[str, Any]]]:
    """The one active fact `about` clearly means, or (None, the closest few)."""
    from .recall import hybrid_search

    found = hybrid_search(conn, about, embedder=embedder, kinds=["fact"], limit=3)
    # By meaning when the fact has a vector; by words only when it hasn't one yet (just saved,
    # or no embedder), since nearly every fact shares a word with the question.
    candidates = [
        r for r in found
        if (r["similarity"] is not None and r["similarity"] >= 0.6) or (r["similarity"] is None and "text" in r["matched"])
    ]
    if not candidates:
        return None, []
    top = candidates[0]
    clear = len(candidates) == 1 or (
        (top["similarity"] or 0.0) >= CORRECT_MIN_SIMILARITY
        and (candidates[1]["similarity"] or 0.0) <= (top["similarity"] or 0.0) - CORRECT_MARGIN
    )
    if clear:
        return UUID(top["source_id"]), []
    return None, [{"id": r["source_id"], "text": r["text"]} for r in candidates]


def correct(
    conn: psycopg.Connection,
    *,
    target: Optional[UUID] = None,
    about: Optional[str] = None,
    action: str,
    text: Optional[str] = None,
    new_id: Optional[UUID] = None,
    author: str = "agent",
    agent: Optional[str] = None,
    model: Optional[str] = None,
    session_id: Optional[UUID] = None,
    embedder: Any = None,
) -> dict[str, Any]:
    """Replace a fact with new words (the old one is kept, superseded) or retract it (kept,
    marked retracted, out of the brief and search). `target` may be a fact id or the id of its
    search result. The agent can't change a pinned fact; only the user can. Returns
    {"status": "replaced" | "retracted" | "not_found" | "ambiguous" | "not_a_fact" | "inactive"
    | "pinned", ...}."""
    fact_id: Optional[UUID] = None
    if target is not None:
        row = conn.execute(
            "SELECT id FROM facts WHERE id = %s"
            " UNION ALL SELECT source_id FROM recall_index WHERE id = %s AND kind = 'fact' LIMIT 1",
            (target, target),
        ).fetchone()
        if row:
            fact_id = row[0]
        elif conn.execute("SELECT 1 FROM recall_index WHERE id = %s", (target,)).fetchone():
            return {"status": "not_a_fact"}
        else:
            return {"status": "not_found"}
    elif about and about.strip():
        fact_id, candidates = find_fact(conn, about.strip(), embedder)
        if fact_id is None:
            return {"status": "ambiguous" if candidates else "not_found", "candidates": candidates}
    else:
        return {"status": "not_found"}

    row = conn.execute(
        "SELECT text, subject, status, pinned, private, recall_count FROM facts WHERE id = %s", (fact_id,)
    ).fetchone()
    if not row:
        return {"status": "not_found"}
    old = {"id": str(fact_id), "text": row[0]}
    if row[2] != "active":
        return {"status": "inactive", "fact": old}
    if row[3] and author != "user":
        return {"status": "pinned", "fact": old}
    if action == "retract":
        update_fact(conn, fact_id, status="retracted")
        return {"status": "retracted", "fact": old}
    if not text or not text.strip():
        raise ValueError("a replacement needs the new wording")
    replacement = new_id or uuid4()
    add_fact(
        conn,
        FactIn(
            id=replacement,
            text=text,
            subject=row[1],
            author=author,
            agent=agent,
            session_id=session_id,
            supersedes=fact_id,
            pinned=row[3],
            private=row[4],
            model=model,
        ),
    )
    # The new wording inherits how settled the old one was.
    conn.execute(
        "UPDATE facts SET recall_count = %s, last_recalled_at = now(), last_recalled_session = %s WHERE id = %s",
        (row[5], session_id, replacement),
    )
    return {"status": "replaced", "fact": old, "replacement": {"id": str(replacement), "text": text.strip()}}
