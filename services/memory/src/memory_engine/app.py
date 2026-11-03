"""HTTP API (see ../../API.md).

The database may be down when the engine starts (its container still booting) or go away later.
The engine starts anyway, retries the connection and migrations in the background, reports the
state on /health, and answers 503 until the database is back. Clients queue their writes.
"""

from __future__ import annotations

import logging
import secrets
import threading
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Literal, Optional
from uuid import UUID

import psycopg
from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import __version__, db, facts, recall, store
from .embed import Embedder

log = logging.getLogger("memory_engine")

MAX_BATCH = 500


class SessionBody(BaseModel):
    started_at: datetime
    agent: Optional[str] = Field(default=None, max_length=200)
    channel: Optional[str] = Field(default=None, max_length=50)
    title: Optional[str] = Field(default=None, max_length=500)
    location: Optional[str] = Field(default=None, max_length=200)
    ended_at: Optional[datetime] = None
    meta: dict[str, Any] = Field(default_factory=dict)


class MessageBody(BaseModel):
    id: UUID
    session_id: UUID
    role: Literal["user", "assistant", "tool", "system"]
    content: str = Field(max_length=200_000)
    created_at: datetime
    speaker: Optional[str] = Field(default=None, max_length=200)
    location: Optional[str] = Field(default=None, max_length=200)
    tool: Optional[dict[str, Any]] = None
    private: bool = False
    meta: dict[str, Any] = Field(default_factory=dict)
    # Lets one call carry a message for a session the engine hasn't seen, with its details.
    session: Optional[SessionBody] = None


class FactBody(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    subject: Optional[str] = Field(default=None, max_length=200)
    author: Literal["agent", "user", "extractor"] = "agent"
    agent: Optional[str] = Field(default=None, max_length=200)
    session_id: Optional[UUID] = None
    source_message_ids: list[UUID] = Field(default_factory=list, max_length=100)
    supersedes: Optional[UUID] = None
    pinned: bool = False
    private: bool = False


class FactPatch(BaseModel):
    text: Optional[str] = Field(default=None, min_length=1, max_length=1000)
    subject: Optional[str] = Field(default=None, max_length=200)
    pinned: Optional[bool] = None
    status: Optional[Literal["active", "superseded", "retracted"]] = None
    private: Optional[bool] = None
    reviewed: bool = False


class MessagesBody(BaseModel):
    messages: list[MessageBody] = Field(max_length=MAX_BATCH)


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


class Engine:
    """Owns the pool and whether the database is ready."""

    def __init__(
        self,
        database_url: str,
        schema: str,
        retry_seconds: float = 5.0,
        embedder: Optional[Embedder] = None,
        embed_inline: bool = False,
    ):
        self.database_url = database_url
        self.schema = schema
        self.retry_seconds = retry_seconds
        # None: full-text search only. embed_inline (tests): embed during each write instead of
        # in the background worker.
        self.embedder = embedder
        self.embed_inline = embed_inline
        self.embed_error: Optional[str] = None
        self._wake_embedder = threading.Event()
        self._embed_thread: Optional[threading.Thread] = None
        self.pool = db.open_pool(database_url, schema)
        self.ready = False
        self.error: Optional[str] = None
        self.schema_version = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self, in_background: bool = True) -> None:
        if self.embedder is not None and not self.embed_inline:
            self._embed_thread = threading.Thread(target=self._embed_loop, name="memory-embed", daemon=True)
            self._embed_thread.start()
        if in_background:
            self._thread = threading.Thread(target=self._connect_loop, name="memory-db", daemon=True)
            self._thread.start()
        else:
            self._connect_once()
            if not self.ready:
                raise RuntimeError(self.error or "database not ready")

    def stop(self) -> None:
        self._stop.set()
        self._wake_embedder.set()
        self.pool.close()

    def written(self, conn) -> None:
        """Call after a write that may have added or changed index rows."""
        if self.embedder is None:
            return
        if self.embed_inline:
            while recall.embed_pending(conn, self.embedder):
                pass
        else:
            self._wake_embedder.set()

    def _embed_loop(self) -> None:
        """Embed new and changed index rows, a batch at a time, whenever there are any."""
        while not self._stop.is_set():
            done = 0
            if self.ready:
                try:
                    with self.pool.connection(timeout=10) as conn:
                        done = recall.embed_pending(conn, self.embedder)
                    if self.embed_error:
                        log.info("Embedding works again")
                    self.embed_error = None
                except Exception as error:  # noqa: BLE001 - keep the worker alive; search falls back to words
                    message = str(error).strip().splitlines()[0] if str(error).strip() else type(error).__name__
                    if message != self.embed_error:
                        log.warning("Embedding failed: %s", message)
                    self.embed_error = message
                    self._stop.wait(30)
                    continue
            if not done:
                self._wake_embedder.wait(10)
                self._wake_embedder.clear()

    def _connect_loop(self) -> None:
        while not self._stop.is_set() and not self.ready:
            self._connect_once()
            if not self.ready:
                self._stop.wait(self.retry_seconds)

    def _connect_once(self) -> None:
        try:
            with psycopg.connect(self.database_url, autocommit=True, connect_timeout=5) as conn:
                applied = db.migrate(conn, self.schema)
                self.schema_version = db.schema_version(conn)
            if applied:
                log.info("Database migrated to version %s", self.schema_version)
            self.pool.open(wait=False)
            self.ready = True
            self.error = None
            log.info("Memory database ready (schema %s, version %s)", self.schema, self.schema_version)
        except Exception as error:  # noqa: BLE001 - any failure means "not ready yet"
            message = str(error).strip().splitlines()[0] if str(error).strip() else type(error).__name__
            if message != self.error:
                log.warning("Memory database not ready: %s", message)
            self.error = message

    def connection(self):
        if not self.ready:
            raise ApiError(503, "memory database is not ready yet")
        try:
            return self.pool.connection(timeout=10)
        except Exception as error:  # noqa: BLE001
            log.warning("No database connection: %s", error)
            raise ApiError(503, "memory database is unavailable") from error


def create_app(engine: Engine, *, api_token: Optional[str] = None, connect_in_background: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        engine.start(in_background=connect_in_background)
        try:
            yield
        finally:
            engine.stop()

    app = FastAPI(title="memory engine", version=__version__, lifespan=lifespan)

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, error: ApiError):
        return JSONResponse(status_code=error.status, content={"error": error.message})

    @app.exception_handler(psycopg.OperationalError)
    async def db_down(_request: Request, error: psycopg.OperationalError):
        log.warning("Memory database error: %s", error)
        return JSONResponse(status_code=503, content={"error": "memory database is unavailable"})

    def authorise(authorization: Optional[str] = Header(default=None)) -> None:
        if not api_token:
            return
        expected = f"Bearer {api_token}"
        if not authorization or not secrets.compare_digest(authorization, expected):
            raise ApiError(401, "missing or wrong bearer token")

    guarded = [Depends(authorise)]

    @app.get("/health")
    def health():
        body: dict[str, Any] = {
            "status": "ok" if engine.ready else "starting",
            "version": __version__,
            "database": "ready" if engine.ready else "unavailable",
            "schema": engine.schema,
            "schema_version": engine.schema_version,
            "embedder": engine.embedder.name if engine.embedder else None,
        }
        if engine.embed_error:
            body["embedder_error"] = "embedding is failing; see the engine's log"
        if engine.error:
            body["error"] = "database not reachable yet; see the engine's log"
        if engine.ready:
            try:
                with engine.pool.connection(timeout=2) as conn:
                    body["counts"] = store.counts(conn)
            except Exception:  # noqa: BLE001
                log.exception("Health check could not read the database")
                body["database"] = "unavailable"
                body["error"] = "database query failed; see the engine's log"
        return body

    @app.put("/v1/sessions/{session_id}", dependencies=guarded)
    def put_session(session_id: UUID, body: SessionBody):
        with engine.connection() as conn:
            store.upsert_session(conn, _session_in(session_id, body))
        return {"id": str(session_id)}

    @app.get("/v1/sessions", dependencies=guarded)
    def get_sessions(
        start: Optional[datetime] = Query(default=None, alias="from"),
        end: Optional[datetime] = Query(default=None, alias="to"),
        agent: Optional[str] = None,
        limit: int = Query(default=50, ge=1, le=500),
        before: Optional[int] = Query(default=None, description="cursor: the last seq of the previous page"),
    ):
        with engine.connection() as conn:
            sessions = store.list_sessions(conn, start=start, end=end, agent=agent, limit=limit, before_seq=before)
        cursor = sessions[-1]["seq"] if len(sessions) == limit else None
        return {"sessions": sessions, "next": cursor}

    @app.get("/v1/sessions/{session_id}/messages", dependencies=guarded)
    def get_session_messages(session_id: UUID):
        with engine.connection() as conn:
            messages = store.session_messages(conn, session_id)
        if messages is None:
            raise ApiError(404, "no such session")
        return {"session_id": str(session_id), "messages": messages}

    @app.delete("/v1/sessions/{session_id}", dependencies=guarded)
    def forget_session(session_id: UUID):
        with engine.connection() as conn:
            found = store.delete_session(conn, session_id)
        if not found:
            raise ApiError(404, "no such session")
        return {"deleted": str(session_id)}

    @app.post("/v1/messages", dependencies=guarded)
    def post_messages(body: MessagesBody):
        with engine.connection() as conn:
            for message in body.messages:
                if message.session is not None:
                    store.upsert_session(conn, _session_in(message.session_id, message.session))
            inserted, duplicates = store.insert_messages(conn, [_message_in(m) for m in body.messages])
            engine.written(conn)
        return {"inserted": inserted, "duplicates": duplicates}

    @app.delete("/v1/messages/{message_id}", dependencies=guarded)
    def forget_message(message_id: UUID):
        with engine.connection() as conn:
            found = store.delete_message(conn, message_id)
            engine.written(conn)
        if not found:
            raise ApiError(404, "no such message")
        return {"deleted": str(message_id)}

    @app.get("/v1/search", dependencies=guarded)
    def search(
        q: str = Query(min_length=1, max_length=2000),
        start: Optional[datetime] = Query(default=None, alias="from"),
        end: Optional[datetime] = Query(default=None, alias="to"),
        agent: Optional[str] = None,
        kind: Optional[list[str]] = Query(default=None),
        exclude: Optional[list[UUID]] = Query(default=None),
        include_private: bool = True,
        mode: Literal["hybrid", "text"] = "hybrid",
        limit: int = Query(default=10, ge=1, le=100),
    ):
        with engine.connection() as conn:
            if mode == "text":
                results = store.search_text(
                    conn, q, start=start, end=end, agent=agent, kinds=kind, include_private=include_private, limit=limit
                )
            else:
                results = recall.hybrid_search(
                    conn,
                    q,
                    embedder=engine.embedder,
                    start=start,
                    end=end,
                    agent=agent,
                    kinds=kind,
                    include_private=include_private,
                    exclude_ids=exclude or [],
                    limit=limit,
                )
        return {"results": results}

    @app.get("/v1/timeline", dependencies=guarded)
    def get_timeline(
        start: datetime = Query(alias="from"),
        end: datetime = Query(alias="to"),
        agent: Optional[str] = None,
        include_private: bool = True,
        turns: int = Query(default=6, ge=0, le=50),
        limit: int = Query(default=50, ge=1, le=200),
    ):
        if end <= start:
            raise ApiError(400, "'to' must be after 'from'")
        with engine.connection() as conn:
            sessions = recall.timeline(
                conn, start, end, agent=agent, include_private=include_private, turns_per_session=turns, limit=limit
            )
        return {"from": start.isoformat(), "to": end.isoformat(), "sessions": sessions}

    @app.get("/v1/memories/{memory_id}", dependencies=guarded)
    def get_memory(memory_id: UUID, around: int = Query(default=1, ge=0, le=10)):
        with engine.connection() as conn:
            detail = recall.memory_detail(conn, memory_id, around=around)
        if detail is None:
            raise ApiError(404, "no such memory")
        return detail

    @app.put("/v1/facts/{fact_id}", dependencies=guarded)
    def put_fact(fact_id: UUID, body: FactBody):
        with engine.connection() as conn:
            created = facts.add_fact(
                conn,
                facts.FactIn(
                    id=fact_id,
                    text=body.text,
                    subject=body.subject,
                    author=body.author,
                    agent=body.agent,
                    session_id=body.session_id,
                    source_message_ids=body.source_message_ids,
                    supersedes=body.supersedes,
                    pinned=body.pinned,
                    private=body.private,
                ),
            )
            engine.written(conn)
        return {"id": str(fact_id), "created": created}

    @app.get("/v1/facts", dependencies=guarded)
    def get_facts(
        status: Optional[Literal["active", "superseded", "retracted", "all"]] = "active",
        pinned: Optional[bool] = None,
        subject: Optional[str] = None,
        unreviewed: bool = False,
        include_private: bool = True,
        limit: int = Query(default=200, ge=1, le=1000),
    ):
        with engine.connection() as conn:
            found = facts.list_facts(
                conn,
                status=None if status == "all" else status,
                pinned=pinned,
                subject=subject,
                unreviewed=unreviewed,
                include_private=include_private,
                limit=limit,
            )
        return {"facts": found}

    @app.patch("/v1/facts/{fact_id}", dependencies=guarded)
    def patch_fact(fact_id: UUID, body: FactPatch):
        with engine.connection() as conn:
            found = facts.update_fact(
                conn,
                fact_id,
                text=body.text,
                subject=body.subject,
                pinned=body.pinned,
                status=body.status,
                private=body.private,
                reviewed=body.reviewed,
            )
            engine.written(conn)
        if not found:
            raise ApiError(404, "no such fact")
        return {"id": str(fact_id)}

    @app.delete("/v1/facts/{fact_id}", dependencies=guarded)
    def forget_fact(fact_id: UUID):
        with engine.connection() as conn:
            found = facts.delete_fact(conn, fact_id)
        if not found:
            raise ApiError(404, "no such fact")
        return {"deleted": str(fact_id)}

    return app


def _session_in(session_id: UUID, body: SessionBody) -> store.SessionIn:
    return store.SessionIn(
        id=session_id,
        started_at=body.started_at,
        agent=body.agent,
        channel=body.channel,
        title=body.title,
        location=body.location,
        ended_at=body.ended_at,
        meta=body.meta,
    )


def _message_in(body: MessageBody) -> store.MessageIn:
    return store.MessageIn(
        id=body.id,
        session_id=body.session_id,
        role=body.role,
        content=body.content,
        created_at=body.created_at,
        speaker=body.speaker,
        location=body.location,
        tool=body.tool,
        private=body.private,
        meta=body.meta,
    )
