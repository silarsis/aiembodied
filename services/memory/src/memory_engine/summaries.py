"""Background understanding: an LLM summarises each conversation once it has gone quiet (with
a title, topic tags and any durable facts it finds), then each closed day, week and month.

Work is found from the data rather than a queue: a conversation needs a summary when it has
been quiet for a while and its summary (if any) saw fewer messages than it has now; a period
needs one when it is over and its summary saw fewer of the summaries below it. So a message
that arrives late, or a deletion, simply makes the summary due again.

The LLM call never holds a database transaction open: a job is read, the model is asked, and
the result is written with a fresh connection.

The Summariser only runs when the client is idle (no turn in progress, nothing written for a
while), so it never competes with a live conversation for the model."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any, Callable, ContextManager, Optional
from uuid import UUID

import psycopg

from .facts import FactIn, add_fact
from .llm import Llm, LlmError
from .store import _tombstone
from .turns import Message, render_message

log = logging.getLogger("memory_engine.summaries")

SESSION_IMPORTANCE = 0.6
PERIOD_IMPORTANCE = 0.5
MAX_TRANSCRIPT_CHARS = 24_000
MAX_EXISTING_FACTS = 60
MAX_FACTS_PER_SESSION = 8
FACT_NAMESPACE = uuid.UUID("6b0f3c1e-8f7a-4f0e-9a51-3d2c7b8e4a10")

SESSION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "topics": {"type": "array", "items": {"type": "string"}},
        "facts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "subject": {"type": "string"},
                    "replaces": {"type": ["string", "null"]},
                },
                "required": ["text"],
            },
        },
    },
    "required": ["title", "summary", "topics", "facts"],
}

PERIOD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "topics": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "summary", "topics"],
}

SYSTEM = (
    "You keep the long-term memory of a personal assistant that talks with one user. You write "
    "short, factual records that the assistant will read later to remember what happened. "
    "Write about the user in the third person as \"the user\". Answer with JSON only."
)


def resolve_timezone(name: Optional[str]) -> tzinfo:
    """MEMORY_TIMEZONE (an IANA name such as Australia/Melbourne), else this machine's offset."""
    if name:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    return datetime.now().astimezone().tzinfo or timezone.utc


def period_bounds(kind: str, when: datetime, tz: tzinfo) -> tuple[datetime, datetime]:
    """The local day, week (from Monday) or month containing `when`, as UTC instants."""
    local = when.astimezone(tz)
    day = datetime(local.year, local.month, local.day, tzinfo=tz)
    if kind == "day":
        start, end = day, _add_days(day, 1, tz)
    elif kind == "week":
        start = _add_days(day, -local.weekday(), tz)
        end = _add_days(start, 7, tz)
    elif kind == "month":
        start = datetime(local.year, local.month, 1, tzinfo=tz)
        end = datetime(local.year + (local.month == 12), local.month % 12 + 1, 1, tzinfo=tz)
    else:
        raise ValueError(kind)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def _add_days(day: datetime, days: int, tz: tzinfo) -> datetime:
    # Through the calendar date, so a daylight-saving change doesn't shift midnight.
    shifted = (day.replace(tzinfo=None) + timedelta(days=days)).date()
    return datetime(shifted.year, shifted.month, shifted.day, tzinfo=tz)


# --- finding work -----------------------------------------------------------------------


def due_sessions(conn: psycopg.Connection, now: datetime, quiet: timedelta, limit: int = 20) -> list[UUID]:
    rows = conn.execute(
        """
        SELECT s.id FROM sessions s
        JOIN LATERAL (
            SELECT max(created_at) AS last_at, max(seq) AS last_seq FROM messages
            WHERE session_id = s.id AND role IN ('user', 'assistant')
        ) m ON m.last_seq IS NOT NULL
        LEFT JOIN summaries su ON su.kind = 'session' AND su.session_id = s.id
        WHERE m.last_at <= %(cutoff)s AND (su.id IS NULL OR su.covered_seq < m.last_seq)
        ORDER BY m.last_at
        LIMIT %(limit)s
        """,
        {"cutoff": now - quiet, "limit": limit},
    ).fetchall()
    return [r[0] for r in rows]


def due_periods(conn: psycopg.Connection, now: datetime, tz: tzinfo, limit: int = 20) -> list[tuple[str, datetime, datetime]]:
    """Closed days with conversation summaries, then weeks and months with day summaries, whose
    own summary is missing or saw less than is there now. Oldest first within each level."""
    children = conn.execute("SELECT kind, seq, period_start FROM summaries WHERE kind IN ('session', 'day')").fetchall()
    existing = {
        (r[0], r[1]): r[2]
        for r in conn.execute("SELECT kind, period_start, covered_seq FROM summaries WHERE kind <> 'session'").fetchall()
    }
    wanted: dict[tuple[str, datetime, datetime], int] = {}
    for kind, seq, start in children:
        parents = ("day",) if kind == "session" else ("week", "month")
        for parent in parents:
            bounds = period_bounds(parent, start, tz)
            key = (parent, *bounds)
            wanted[key] = max(wanted.get(key, 0), seq)
    due = [
        key
        for key, covered in wanted.items()
        if key[2] <= now and existing.get((key[0], key[1]), -1) < covered
    ]
    order = {"day": 0, "week": 1, "month": 2}
    due.sort(key=lambda key: (order[key[0]], key[1]))
    return due[:limit]


# --- conversations ----------------------------------------------------------------------


@dataclass
class SessionJob:
    session_id: UUID
    agent: Optional[str]
    started_at: datetime
    last_at: datetime
    covered_seq: int
    transcript: str
    facts: list[tuple[str, str]] = field(default_factory=list)  # (id, text)


def load_session_job(conn: psycopg.Connection, session_id: UUID) -> Optional[SessionJob]:
    session = conn.execute("SELECT agent FROM sessions WHERE id = %s", (session_id,)).fetchone()
    if not session:
        return None
    rows = conn.execute(
        """
        SELECT id, seq, role, content, tool, created_at, speaker FROM messages
        WHERE session_id = %s AND role IN ('user', 'assistant', 'tool') AND NOT private
        ORDER BY created_at, seq
        """,
        (session_id,),
    ).fetchall()
    last_seq = conn.execute(
        "SELECT max(seq) FROM messages WHERE session_id = %s AND role IN ('user', 'assistant')", (session_id,)
    ).fetchone()[0]
    if not rows or last_seq is None:
        return None
    agent = session[0] or "Assistant"
    lines = []
    for r in rows:
        message = Message(id=r[0], seq=r[1], role=r[2], content=r[3], tool=r[4], created_at=r[5], speaker=r[6])
        line = render_message(message, agent)
        if line:
            lines.append(line)
    transcript = "\n".join(lines)
    if len(transcript) > MAX_TRANSCRIPT_CHARS:
        half = MAX_TRANSCRIPT_CHARS // 2
        transcript = transcript[:half] + "\n[… middle of the conversation left out …]\n" + transcript[-half:]
    facts = conn.execute(
        "SELECT id, text FROM facts WHERE status = 'active' ORDER BY pinned DESC, created_at DESC LIMIT %s",
        (MAX_EXISTING_FACTS,),
    ).fetchall()
    return SessionJob(
        session_id=session_id,
        agent=session[0],
        started_at=rows[0][5],
        last_at=rows[-1][5],
        covered_seq=last_seq,
        transcript=transcript,
        facts=[(str(f[0]), f[1]) for f in facts],
    )


def session_prompt(job: SessionJob, tz: tzinfo) -> str:
    known = "\n".join(f"- [{fid}] {text}" for fid, text in job.facts) or "(none yet)"
    when = job.started_at.astimezone(tz).strftime("%A %d %B %Y, %H:%M")
    return (
        f"Facts already known about the user:\n{known}\n\n"
        f"Conversation on {when} with {job.agent or 'the assistant'}:\n{job.transcript}\n\n"
        "Write:\n"
        "- title: 3 to 8 words naming what the conversation was about.\n"
        "- summary: 2 to 6 sentences in the past tense: what was discussed, decided or planned, "
        "with any names, dates and numbers that matter.\n"
        "- topics: 1 to 5 short lowercase topic tags, such as \"garden\" or \"car\".\n"
        "- facts: durable facts about the user or their world that the assistant should know in "
        "future conversations: preferences, decisions, plans with their dates, people, places, "
        "possessions. One short sentence each, third person. Not small talk, not facts about the "
        "assistant, and not facts already known. If one updates or contradicts a known fact, set "
        "\"replaces\" to that fact's id in square brackets, without the brackets. An empty list is "
        "fine and usual."
    )


def _clean_result(result: dict[str, Any]) -> tuple[str, str, list[str]]:
    title = str(result.get("title") or "").strip()[:200]
    summary = str(result.get("summary") or "").strip()
    if not summary:
        raise LlmError("the model gave no summary")
    topics = []
    for topic in result.get("topics") or []:
        text = str(topic).strip().lower()[:40]
        if text and text not in topics:
            topics.append(text)
    return title, summary, topics[:5]


def apply_session(conn: psycopg.Connection, job: SessionJob, result: dict[str, Any], model: str) -> dict[str, Any]:
    title, summary, topics = _clean_result(result)
    # The session may have been deleted, or written to again, while the model was busy.
    current = conn.execute(
        "SELECT max(seq) FROM messages WHERE session_id = %s AND role IN ('user', 'assistant')", (job.session_id,)
    ).fetchone()[0]
    if current is None:
        return {"kind": "session", "session_id": str(job.session_id), "skipped": "deleted"}

    _drop_summaries(conn, "kind = 'session' AND session_id = %s", (job.session_id,))
    summary_id = conn.execute(
        """
        INSERT INTO summaries (kind, session_id, period_start, period_end, title, text, topics, covered_seq, model)
        VALUES ('session', %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
        """,
        (job.session_id, job.started_at, job.last_at, title or None, summary, topics, job.covered_seq, model),
    ).fetchone()[0]
    _index(conn, summary_id, "session", job.session_id, job.agent, job.started_at, job.last_at, title, summary, topics,
           SESSION_IMPORTANCE)
    if title:
        conn.execute("UPDATE sessions SET title = %s WHERE id = %s AND title IS NULL", (title, job.session_id))

    known_ids = {fid for fid, _ in job.facts}
    known_texts = {text.strip().lower() for _, text in job.facts}
    added = 0
    for candidate in (result.get("facts") or [])[:MAX_FACTS_PER_SESSION]:
        if not isinstance(candidate, dict):
            continue
        text = str(candidate.get("text") or "").strip()
        if not 3 <= len(text) <= 300 or text.lower() in known_texts:
            continue
        replaces = str(candidate.get("replaces") or "").strip("[] ") or None
        fact_id = uuid.uuid5(FACT_NAMESPACE, f"{job.session_id}:{text.lower()}")
        created = add_fact(
            conn,
            FactIn(
                id=fact_id,
                text=text,
                subject=(str(candidate.get("subject") or "").strip() or None),
                author="extractor",
                agent=job.agent,
                session_id=job.session_id,
                supersedes=UUID(replaces) if replaces in known_ids else None,
            ),
        )
        if created:
            added += 1
            known_texts.add(text.lower())
    return {"kind": "session", "session_id": str(job.session_id), "title": title, "facts": added}


# --- calendar periods -------------------------------------------------------------------


@dataclass
class PeriodJob:
    kind: str
    start: datetime
    end: datetime
    covered_seq: int
    children: list[tuple[datetime, Optional[str], str]]  # (start, title, text)


CHILD_KIND = {"day": "session", "week": "day", "month": "day"}


def load_period_job(conn: psycopg.Connection, kind: str, start: datetime, end: datetime) -> Optional[PeriodJob]:
    rows = conn.execute(
        """
        SELECT period_start, title, text, seq FROM summaries
        WHERE kind = %s AND period_start >= %s AND period_start < %s
        ORDER BY period_start
        """,
        (CHILD_KIND[kind], start, end),
    ).fetchall()
    if not rows:
        return None
    return PeriodJob(kind, start, end, max(r[3] for r in rows), [(r[0], r[1], r[2]) for r in rows])


def period_prompt(job: PeriodJob, tz: tzinfo) -> str:
    local = job.start.astimezone(tz)
    if job.kind == "day":
        name = local.strftime("%A %d %B %Y")
        parts = "conversations"
        fmt = "%H:%M"
    elif job.kind == "week":
        name = "the week starting " + local.strftime("%A %d %B %Y")
        parts = "days"
        fmt = "%A %d %B"
    else:
        name = local.strftime("%B %Y")
        parts = "days"
        fmt = "%A %d %B"
    children = "\n".join(
        f"- {start.astimezone(tz).strftime(fmt)}: {title + ': ' if title else ''}{text}" for start, title, text in job.children
    )
    length = "2 to 4 sentences" if job.kind == "day" else "3 to 6 sentences"
    return (
        f"Records of the {parts} in {name}:\n{children}\n\n"
        f"Write a record of {name} as a whole:\n"
        "- title: 3 to 8 words.\n"
        f"- summary: {length} in the past tense: the main things the user did, discussed, decided "
        "or planned, with the names and dates that matter.\n"
        "- topics: 1 to 5 short lowercase topic tags."
    )


def apply_period(conn: psycopg.Connection, job: PeriodJob, result: dict[str, Any], model: str) -> dict[str, Any]:
    title, summary, topics = _clean_result(result)
    _drop_summaries(conn, "kind = %s AND period_start = %s", (job.kind, job.start))
    summary_id = conn.execute(
        """
        INSERT INTO summaries (kind, period_start, period_end, title, text, topics, covered_seq, model)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
        """,
        (job.kind, job.start, job.end, title or None, summary, topics, job.covered_seq, model),
    ).fetchone()[0]
    _index(conn, summary_id, job.kind, None, None, job.start, job.end, title, summary, topics, PERIOD_IMPORTANCE)
    return {"kind": job.kind, "period_start": job.start.isoformat(), "title": title}


# --- shared -----------------------------------------------------------------------------


def _index(conn, summary_id, kind, session_id, agent, start, end, title, summary, topics, importance) -> None:
    text = f"{title}: {summary}" if title else summary
    if topics:
        text += "\nTopics: " + ", ".join(topics)
    conn.execute(
        """
        INSERT INTO recall_index (kind, source_id, session_id, agent, period_start, period_end, text, importance)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (kind, summary_id, session_id, agent, start, end, text, importance),
    )


def _drop_summaries(conn: psycopg.Connection, where: str, params: tuple) -> None:
    old = conn.execute(f"DELETE FROM summaries WHERE {where} RETURNING id", params).fetchall()  # noqa: S608 - fixed clauses
    if not old:
        return
    ids = [r[0] for r in old]
    index = conn.execute("DELETE FROM recall_index WHERE source_id = ANY(%s) RETURNING id", (ids,)).fetchall()
    _tombstone(conn, [("summaries", i) for i in ids] + [("recall_index", r[0]) for r in index])


def invalidate_for_session(conn: psycopg.Connection, session_id: UUID) -> None:
    """A session lost messages (or is going): drop its summary and the day, week and month
    summaries over its time, so they are made again from what is left."""
    span = conn.execute(
        "SELECT min(created_at), max(created_at) FROM messages WHERE session_id = %s", (session_id,)
    ).fetchone()
    summary_span = conn.execute(
        "SELECT period_start, period_end FROM summaries WHERE kind = 'session' AND session_id = %s", (session_id,)
    ).fetchone()
    starts = [v for v in (span[0], summary_span[0] if summary_span else None) if v]
    ends = [v for v in (span[1], summary_span[1] if summary_span else None) if v]
    _drop_summaries(conn, "kind = 'session' AND session_id = %s", (session_id,))
    if starts and ends:
        # Generous by a day each side, so the local day around it is always covered.
        _drop_summaries(
            conn,
            "kind <> 'session' AND period_end > %s AND period_start < %s",
            (min(starts) - timedelta(days=1), max(ends) + timedelta(days=1)),
        )


def list_summaries(
    conn: psycopg.Connection,
    *,
    kind: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, kind, session_id, period_start, period_end, title, text, topics, model, created_at
        FROM summaries
        WHERE (%(kind)s::text IS NULL OR kind = %(kind)s)
          AND (%(start)s::timestamptz IS NULL OR period_end > %(start)s)
          AND (%(end)s::timestamptz IS NULL OR period_start < %(end)s)
        ORDER BY period_start DESC
        LIMIT %(limit)s
        """,
        {"kind": kind, "start": start, "end": end, "limit": limit},
    ).fetchall()
    return [
        {
            "id": str(r[0]),
            "kind": r[1],
            "session_id": str(r[2]) if r[2] else None,
            "period_start": r[3].isoformat(),
            "period_end": r[4].isoformat(),
            "title": r[5],
            "text": r[6],
            "topics": list(r[7]),
            "model": r[8],
            "created_at": r[9].isoformat(),
        }
        for r in rows
    ]


# --- the scheduler ----------------------------------------------------------------------


class Summariser:
    """Runs one job at a time, only while the client is idle. A job that fails waits longer
    each time before it is tried again (in memory; a restart tries everything again)."""

    BUSY_EXPIRES = 600.0  # a client that said "busy" and then vanished

    def __init__(
        self,
        llm: Llm,
        tz: tzinfo,
        *,
        session_quiet: timedelta = timedelta(minutes=10),
        idle_seconds: float = 120.0,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.llm = llm
        self.tz = tz
        self.session_quiet = session_quiet
        self.idle_seconds = idle_seconds
        self.clock = clock
        self.error: Optional[str] = None
        self.done = 0
        self._busy_since: Optional[float] = None
        self._last_activity = clock() - idle_seconds
        self._retry_at: dict[Any, tuple[float, float]] = {}
        self._lock = threading.Lock()

    # Activity, from the client: a turn starting (busy) or ending, and every write.
    def activity(self, busy: Optional[bool] = None) -> None:
        now = self.clock()
        self._last_activity = now
        if busy is True:
            self._busy_since = now
        elif busy is False:
            self._busy_since = None

    def idle(self) -> bool:
        now = self.clock()
        if self._busy_since is not None and now - self._busy_since < self.BUSY_EXPIRES:
            return False
        return now - self._last_activity >= self.idle_seconds

    def run_once(
        self,
        connect: Callable[[], ContextManager[psycopg.Connection]],
        now: Optional[datetime] = None,
    ) -> Optional[dict[str, Any]]:
        """Do the next due job, if any. Returns what was done, or None when nothing is due."""
        with self._lock:
            now = now or datetime.now(timezone.utc)
            with connect() as conn:
                job = self._next_job(conn, now)
            if job is None:
                return None
            key, load = job
            try:
                with connect() as conn:
                    loaded = load(conn)
                if loaded is None:
                    # Everything in it is private, say: look again much later, not every pass.
                    self._retry_at[key] = (self.clock() + 6 * 3600.0, 6 * 3600.0)
                    return {"key": str(key), "skipped": "nothing to summarise"}
                if isinstance(loaded, SessionJob):
                    result = self.llm.complete_json(SYSTEM, session_prompt(loaded, self.tz), SESSION_SCHEMA)
                    with connect() as conn:
                        outcome = apply_session(conn, loaded, result, self.llm.name)
                else:
                    result = self.llm.complete_json(SYSTEM, period_prompt(loaded, self.tz), PERIOD_SCHEMA)
                    with connect() as conn:
                        outcome = apply_period(conn, loaded, result, self.llm.name)
            except (LlmError, ValueError, TypeError) as error:
                self._failed(key, str(error))
                return {"key": str(key), "error": "the model's answer could not be used; see the engine's log"}
            self._retry_at.pop(key, None)
            self.error = None
            self.done += 1
            return outcome

    def _next_job(self, conn: psycopg.Connection, now: datetime):
        clock = self.clock()
        for session_id in due_sessions(conn, now, self.session_quiet):
            key = ("session", session_id)
            if self._retry_at.get(key, (0.0, 0.0))[0] <= clock:
                return key, lambda c, s=session_id: load_session_job(c, s)
        for kind, start, end in due_periods(conn, now, self.tz):
            key = (kind, start)
            if self._retry_at.get(key, (0.0, 0.0))[0] <= clock:
                return key, lambda c, k=kind, s=start, e=end: load_period_job(c, k, s, e)
        return None

    def _failed(self, key: Any, message: str) -> None:
        _, delay = self._retry_at.get(key, (0.0, 30.0))
        self._retry_at[key] = (self.clock() + delay, min(delay * 2, 6 * 3600.0))
        if message != self.error:
            log.warning("Summary %s failed: %s", key, message)
        self.error = message
