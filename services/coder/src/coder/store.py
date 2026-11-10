"""SQLite storage for tasks and their events."""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

ACTIVE = ("starting", "working", "question", "checks", "pushing", "paused")
JSON_COLS = ("acceptance", "scope", "files_touched", "question", "questions", "review")
EVENT_CAP = 20_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, goal TEXT NOT NULL,
  acceptance TEXT, scope TEXT, provider TEXT, model TEXT, branch TEXT, worktree TEXT, base_commit TEXT,
  status TEXT NOT NULL, phase_detail TEXT, current_tool TEXT, files_touched TEXT, question TEXT, questions TEXT,
  last_text TEXT, checks_ok INTEGER, checks_output TEXT, review TEXT, pr_url TEXT, pr_state TEXT, ci_state TEXT, pr_checked_at TEXT, merged_at TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  task_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, payload TEXT,
  PRIMARY KEY (task_id, seq)
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.executescript(SCHEMA)
            cols = {r[1] for r in self.db.execute("PRAGMA table_info(tasks)")}
            if "questions" not in cols:  # database from before pending dialogs were a list
                self.db.execute("ALTER TABLE tasks ADD COLUMN questions TEXT")
            for col in ("pr_state", "ci_state", "pr_checked_at", "merged_at"):
                if col not in cols:  # database from before pull requests were followed
                    self.db.execute(f"ALTER TABLE tasks ADD COLUMN {col} TEXT")
            self.db.commit()

    def close(self) -> None:
        with self.lock:
            self.db.close()

    @staticmethod
    def _row(r: sqlite3.Row) -> dict[str, Any]:
        d = dict(r)
        for c in JSON_COLS:
            d[c] = json.loads(d[c]) if d.get(c) else None
        if d["checks_ok"] is not None:
            d["checks_ok"] = bool(d["checks_ok"])
        d["acceptance"] = d["acceptance"] or []
        d["scope"] = d["scope"] or []
        d["files_touched"] = d["files_touched"] or []
        d["questions"] = d["questions"] or ([d["question"]] if d["question"] else [])
        return d

    def new_id(self) -> str:
        while True:
            tid = time.strftime("%Y%m%d") + "-" + secrets.token_hex(2)
            if not self.get_task(tid):
                return tid

    def create_task(self, **f: Any) -> dict:
        t = now()
        f.setdefault("status", "queued")
        f["created_at"] = f["updated_at"] = t
        for c in JSON_COLS:
            if f.get(c) is not None:
                f[c] = json.dumps(f[c])
        cols = ", ".join(f)
        with self.lock:
            self.db.execute(f"INSERT INTO tasks ({cols}) VALUES ({', '.join('?' * len(f))})", list(f.values()))
            self.db.commit()
        return self.get_task(f["id"])  # type: ignore[return-value]

    def get_task(self, tid: str) -> Optional[dict]:
        with self.lock:
            r = self.db.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        return self._row(r) if r else None

    def update_task(self, tid: str, **f: Any) -> Optional[dict]:
        f["updated_at"] = now()
        for c in JSON_COLS:
            if c in f and f[c] is not None:
                f[c] = json.dumps(f[c])
        if "checks_ok" in f and f["checks_ok"] is not None:
            f["checks_ok"] = int(f["checks_ok"])
        sets = ", ".join(f"{k}=?" for k in f)
        with self.lock:
            self.db.execute(f"UPDATE tasks SET {sets} WHERE id=?", [*f.values(), tid])
            self.db.commit()
        return self.get_task(tid)

    def list_tasks(self, status: Optional[str] = None) -> list[dict]:
        q, args = "SELECT * FROM tasks", []
        if status:
            q += " WHERE status=?"
            args.append(status)
        with self.lock:
            rows = self.db.execute(q + " ORDER BY created_at DESC, id DESC", args).fetchall()
        return [self._row(r) for r in rows]

    def add_event(self, tid: str, type_: str, payload: Any) -> int:
        text = json.dumps(payload, default=str)
        if len(text) > EVENT_CAP:
            text = json.dumps({"truncated": True, "original_bytes": len(text), "preview": text[:2000]})
        with self.lock:
            seq = (self.db.execute("SELECT COALESCE(MAX(seq), 0) FROM events WHERE task_id=?", (tid,)).fetchone()[0]) + 1
            self.db.execute("INSERT INTO events VALUES (?,?,?,?,?)", (tid, seq, now(), type_, text))
            self.db.commit()
        return seq

    def events(self, tid: str, after: int = 0, limit: int = 1000) -> list[dict]:
        with self.lock:
            rows = self.db.execute(
                "SELECT seq, ts, type, payload FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?",
                (tid, after, limit)).fetchall()
        return [{"seq": r["seq"], "ts": r["ts"], "type": r["type"], "payload": json.loads(r["payload"]) if r["payload"] else None}
                for r in rows]

    def mark_stale_failed(self) -> list[str]:
        marks = ",".join("?" * len(ACTIVE))
        with self.lock:
            ids = [r[0] for r in self.db.execute(f"SELECT id FROM tasks WHERE status IN ({marks})", ACTIVE)]
        for tid in ids:
            self.update_task(tid, status="failed", error="runner restarted", question=None, questions=[], current_tool=None,
                             finished_at=now())
            self.add_event(tid, "runner", {"message": "runner restarted; task marked failed"})
        return ids
