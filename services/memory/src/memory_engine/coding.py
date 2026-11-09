"""Coding work: the tasks the coding runner finished, kept as memories.

The app posts a task when it ends (and again if its pull request changes state). Each is stored in
coding_tasks and indexed in recall_index with source = 'coding' and a short sentence, so Echo can
search "what did I change last week" and the brief can list the latest work. Like Home Assistant
rows these stay out of auto-recall, summaries and fact extraction, and are not mirrored."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional
from uuid import NAMESPACE_URL, UUID, uuid5

import psycopg
from psycopg.types.json import Jsonb

SOURCE = "coding"
INDEX_KIND = "coding_task"

MAX_FILES = 200
MAX_SUMMARY_CHARS = 4000
# The index text names at most this many files and quotes at most this much of what pi said.
TEXT_FILES = 8
TEXT_SUMMARY_CHARS = 600
BRIEF_DAYS = 7
BRIEF_TASKS = 3
BRIEF_TITLE_CHARS = 100


def _clip(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def index_id_for(task_id: str) -> UUID:
    """recall_index keys on a uuid; the runner's task ids are not, so derive a stable one."""
    return uuid5(NAMESPACE_URL, f"aiembodied-coding-task:{task_id}")


def describe(task: dict[str, Any]) -> str:
    """The sentence indexed for a task, e.g. "Coding task in aiembodied (done, PR https://…
    merged): Fix the retry. Changed 3 files: a.ts, b.ts, c.ts. pi said: …"."""
    details = [task["outcome"]]
    if task.get("pr_url"):
        pr = f"PR {task['pr_url']}"
        if task.get("pr_state"):
            pr += f" {task['pr_state']}"
        details.append(pr)
    text = f"Coding task in {task['workspace_name']} ({', '.join(details)}): {_clip(task['title'], 300)}."
    files = task.get("files_changed") or []
    if files:
        shown = ", ".join(files[:TEXT_FILES])
        more = f" and {len(files) - TEXT_FILES} more" if len(files) > TEXT_FILES else ""
        text += f" Changed {len(files)} file{'s' if len(files) != 1 else ''}: {shown}{more}."
        if task.get("added") or task.get("removed"):
            text += f" (+{task['added']} -{task['removed']})"
    if task.get("review_flags"):
        text += f" Review flags: {'; '.join(task['review_flags'][:5])}."
    if task.get("summary"):
        text += f" pi said: {_clip(task['summary'], TEXT_SUMMARY_CHARS)}"
    return text


def upsert_task(conn: psycopg.Connection, task: dict[str, Any]) -> dict[str, Any]:
    """Store (or update) a finished task and its index row. `task` is already validated."""
    index_id = index_id_for(task["task_id"])
    finished = task["finished_at"] or datetime.now(timezone.utc)
    task = {**task, "finished_at": finished}
    conn.execute(
        """
        INSERT INTO coding_tasks (task_id, index_id, workspace_id, workspace_name, title, outcome, pr_url,
            pr_state, branch, files_changed, added, removed, review_flags, summary, model, provider, agent,
            started_at, finished_at)
        VALUES (%(task_id)s, %(index_id)s, %(workspace_id)s, %(workspace_name)s, %(title)s, %(outcome)s,
            %(pr_url)s, %(pr_state)s, %(branch)s, %(files)s, %(added)s, %(removed)s, %(flags)s, %(summary)s,
            %(model)s, %(provider)s, %(agent)s, %(started_at)s, %(finished_at)s)
        ON CONFLICT (task_id) DO UPDATE SET
            workspace_id = excluded.workspace_id, workspace_name = excluded.workspace_name,
            title = excluded.title, outcome = excluded.outcome, pr_url = excluded.pr_url,
            pr_state = excluded.pr_state, branch = excluded.branch, files_changed = excluded.files_changed,
            added = excluded.added, removed = excluded.removed, review_flags = excluded.review_flags,
            summary = excluded.summary, model = excluded.model, provider = excluded.provider,
            agent = excluded.agent, started_at = excluded.started_at, finished_at = excluded.finished_at,
            updated_at = now()
        """,
        {
            **task,
            "index_id": index_id,
            "files": Jsonb(task["files_changed"]),
            "flags": Jsonb(task["review_flags"]),
        },
    )
    text = describe(task)
    conn.execute(
        """
        INSERT INTO recall_index (kind, source, source_id, session_id, agent, period_start, period_end, text, importance)
        VALUES (%(kind)s, %(source)s, %(id)s, NULL, %(agent)s, %(at)s, %(at)s, %(text)s, 0.6)
        ON CONFLICT (kind, source_id) DO UPDATE SET
            text = excluded.text,
            agent = excluded.agent,
            period_start = excluded.period_start,
            period_end = excluded.period_end,
            embedding = CASE WHEN recall_index.text = excluded.text THEN recall_index.embedding END,
            embed_model = CASE WHEN recall_index.text = excluded.text THEN recall_index.embed_model END,
            updated_at = now()
        """,
        {"kind": INDEX_KIND, "source": SOURCE, "id": index_id, "agent": task.get("agent"), "at": finished, "text": text},
    )
    return {"task_id": task["task_id"], "indexed": True, "text": text}


def recent(conn: psycopg.Connection, limit: int = BRIEF_TASKS, days: int = BRIEF_DAYS) -> list[dict[str, Any]]:
    """The newest tasks finished within `days`, one short line's worth of fields each (for the brief)."""
    rows = conn.execute(
        """
        SELECT task_id, workspace_name, title, outcome, pr_url, pr_state, finished_at FROM coding_tasks
        WHERE finished_at > now() - make_interval(days => %s)
        ORDER BY finished_at DESC LIMIT %s
        """,
        (days, limit),
    ).fetchall()
    return [
        {
            "task_id": r[0],
            "workspace": r[1],
            "title": _clip(r[2], BRIEF_TITLE_CHARS),
            "outcome": r[3],
            "pr_url": r[4],
            "pr_state": r[5],
            "finished_at": r[6].isoformat(),
        }
        for r in rows
    ]
