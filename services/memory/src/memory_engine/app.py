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
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional
from uuid import UUID

import psycopg
from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import __version__, context, db, facts, handoffs, home, mirror, recall, store, storage, summaries
from .embed import Embedder
from .summaries import Summariser

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
    model: Optional[str] = Field(default=None, max_length=200)


class CorrectBody(BaseModel):
    """Name the fact by `id` (a fact's, or its search result's) or by `about` (what it said)."""

    id: Optional[UUID] = None
    about: Optional[str] = Field(default=None, max_length=1000)
    action: Literal["replace", "retract"]
    text: Optional[str] = Field(default=None, min_length=1, max_length=1000)
    new_id: Optional[UUID] = None
    author: Literal["agent", "user"] = "agent"
    agent: Optional[str] = Field(default=None, max_length=200)
    model: Optional[str] = Field(default=None, max_length=200)
    session_id: Optional[UUID] = None


class HandoffBody(BaseModel):
    text: str = Field(min_length=1, max_length=handoffs.HANDOFF_MAX_CHARS)
    agent: Optional[str] = Field(default=None, max_length=200)
    model: Optional[str] = Field(default=None, max_length=200)


class RecallBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    session_id: Optional[UUID] = None
    exclude: list[UUID] = Field(default_factory=list, max_length=500)
    limit: int = Field(default=context.RECALL_LIMIT, ge=1, le=10)
    max_chars: int = Field(default=context.RECALL_MAX_CHARS, ge=100, le=10000)
    min_similarity: float = Field(default=context.RECALL_MIN_SIMILARITY, ge=0.0, le=1.0)


class StorageBody(BaseModel):
    database: Optional[str] = Field(default=None, max_length=2000)
    mirror: Optional[str] = Field(default=None, max_length=2000)


class StorageTestBody(BaseModel):
    url: str = Field(min_length=1, max_length=2000)


class ActivityBody(BaseModel):
    busy: bool


class SummaryRunBody(BaseModel):
    now: Optional[datetime] = None
    limit: int = Field(default=10, ge=1, le=200)


class FactPatch(BaseModel):
    text: Optional[str] = Field(default=None, min_length=1, max_length=1000)
    subject: Optional[str] = Field(default=None, max_length=200)
    pinned: Optional[bool] = None
    status: Optional[Literal["active", "superseded", "retracted"]] = None
    private: Optional[bool] = None
    reviewed: bool = False


class MessagesBody(BaseModel):
    messages: list[MessageBody] = Field(max_length=MAX_BATCH)


class MoveInProgress(Exception):
    """Memory is being copied to another database; it can't be pointed elsewhere until then."""


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
        summariser: Optional[Summariser] = None,
        settings_file: Optional[Path] = None,
        mirror_interval: float = 60.0,
        home_config: Optional[home.HomeConfig] = None,
    ):
        # This machine's database; the saved storage settings may point elsewhere.
        self.local_url = database_url
        self.settings_file = settings_file
        self.storage = storage.load(settings_file)
        self.database_url = self.storage.database or database_url
        self.schema = schema
        self.mirror_interval = mirror_interval
        self.mirror_error: Optional[str] = None
        self.mirror_pushed_at: Optional[str] = None
        self.moving = False
        self.move_error: Optional[str] = None
        self._wake_mirror = threading.Event()
        self._mirror_thread: Optional[threading.Thread] = None
        self._storage_lock = threading.Lock()
        self.retry_seconds = retry_seconds
        # None: full-text search only. embed_inline (tests): embed during each write instead of
        # in the background worker.
        self.embedder = embedder
        self.embed_inline = embed_inline
        self.embed_error: Optional[str] = None
        self._wake_embedder = threading.Event()
        self._embed_thread: Optional[threading.Thread] = None
        # None: no background summaries or fact extraction (no LLM configured).
        self.summariser = summariser
        self._summary_thread: Optional[threading.Thread] = None
        # Home Assistant: the listener only exists when it has an address and a token.
        self.home_config = home_config
        self.home: Optional[home.HomeListener] = (
            home.HomeListener(self, home_config) if home_config is not None and home_config.enabled else None
        )
        self.pool = db.open_pool(self.database_url, schema)
        self.ready = False
        self.error: Optional[str] = None
        self.schema_version = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self, in_background: bool = True) -> None:
        if in_background:
            self._mirror_thread = threading.Thread(target=self._mirror_loop, name="memory-mirror", daemon=True)
            self._mirror_thread.start()
        if self.summariser is not None and in_background:
            self._summary_thread = threading.Thread(target=self._summary_loop, name="memory-summaries", daemon=True)
            self._summary_thread.start()
        if self.embedder is not None and not self.embed_inline:
            self._embed_thread = threading.Thread(target=self._embed_loop, name="memory-embed", daemon=True)
            self._embed_thread.start()
        if self.home is not None and in_background:
            self.home.start()
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
        self._wake_mirror.set()
        if self.home is not None:
            self.home.stop()
        self.pool.close()

    def home_status(self) -> dict[str, Any]:
        if self.home is None:
            return home.unconfigured_status(self.home_config)
        return self.home.status()

    # --- where memory is kept ------------------------------------------------------------

    def storage_view(self) -> dict[str, Any]:
        return {
            "database": {
                "local": self.storage.database is None,
                "where": storage.describe(self.database_url),
            },
            "mirror": (
                {
                    "where": storage.describe(self.storage.mirror),
                    "pushed_at": self.mirror_pushed_at,
                    "error": "the mirror is failing; see the engine's log" if self.mirror_error else None,
                }
                if self.storage.mirror
                else None
            ),
            "moving": self.moving,
            "move_error": self.move_error,
        }

    def set_storage(self, database: Optional[str], mirror: Optional[str], *, background: bool = True) -> None:
        """Use another database (None: this machine's) and/or mirror (None: none). A move to a
        database that is still empty copies everything there first; until that is done the API
        answers 503, so the client queues its writes."""
        with self._storage_lock:
            new_url = database or self.local_url
            changed = new_url != self.database_url
            if changed and self.moving:
                # A second move now would copy from a database that is still being filled.
                raise MoveInProgress()
            self.storage = storage.StorageSettings(database=database, mirror=mirror if mirror != new_url else None)
            storage.save(self.settings_file, self.storage)
            self._wake_mirror.set()
            if not changed:
                return
            old_url, old_pool = self.database_url, self.pool
            self.ready = False
            self.moving = True
            self.move_error = None
            self.database_url = new_url
            self.pool = db.open_pool(new_url, self.schema)
        try:
            old_pool.close()
        except Exception:  # noqa: BLE001
            log.exception("Closing the old database pool failed")
        if background:
            threading.Thread(target=self._move, args=(old_url, new_url), name="memory-move", daemon=True).start()
        else:
            self._move(old_url, new_url)

    def _move(self, old_url: str, new_url: str) -> None:
        try:
            copied = mirror.copy_all(old_url, new_url, self.schema)
            if copied:
                log.info("Copied %s rows to the new memory database %s", copied, storage.describe(new_url))
        except Exception as error:  # noqa: BLE001
            # Back to where the memory is, rather than starting on an empty or half-copied
            # database. That includes an old database that can't be read right now (its
            # container not started yet, say): moving without a copy would quietly lose memory.
            log.warning("Moving memory to %s failed, staying where it was: %s", storage.describe(new_url), error)
            with self._storage_lock:
                self.storage = storage.StorageSettings(
                    database=None if old_url == self.local_url else old_url, mirror=self.storage.mirror
                )
                storage.save(self.settings_file, self.storage)
                self.database_url = old_url
                self.pool = db.open_pool(old_url, self.schema)
            self.move_error = (
                "the current memory database couldn't be read, so nothing was moved"
                if isinstance(error, mirror.SourceUnavailable)
                else "moving to the new database failed; see the engine's log"
            )
            self.error = self.move_error
        finally:
            self.moving = False
        while not self._stop.is_set() and not self.ready:
            self._connect_once()
            if not self.ready:
                self._stop.wait(self.retry_seconds)

    def push_mirror(self) -> int:
        """Send what the mirror doesn't have yet. Returns how many rows went."""
        target_url = self.storage.mirror
        if not target_url or not self.ready:
            return 0
        name = mirror.target_name(target_url)
        with self.pool.connection(timeout=10) as source:
            marks = mirror.load_marks(source, name)
            try:
                with mirror.connect_target(target_url, self.schema) as target:
                    marks, sent = mirror.push(source, target, marks)
            except Exception as error:
                source.rollback()
                mirror.save_marks(source, name, marks, error=str(error).splitlines()[0][:500] if str(error) else "failed")
                raise
            mirror.save_marks(source, name, marks)
        self.mirror_error = None
        self.mirror_pushed_at = mirror.now_iso()
        return sent

    def _mirror_loop(self) -> None:
        while not self._stop.is_set():
            self._wake_mirror.wait(self.mirror_interval)
            self._wake_mirror.clear()
            if self._stop.is_set():
                return
            try:
                sent = self.push_mirror()
                if sent:
                    log.info("Mirror: sent %s rows to %s", sent, storage.describe(self.storage.mirror))
            except Exception as error:  # noqa: BLE001 - keep trying; the source is untouched
                message = str(error).strip().splitlines()[0] if str(error).strip() else type(error).__name__
                if message != self.mirror_error:
                    log.warning("Mirror push failed: %s", message)
                self.mirror_error = message
                self._stop.wait(min(self.mirror_interval * 4, 600))

    def written(self, conn) -> None:
        """Call after a write that may have added or changed index rows."""
        if self.summariser is not None:
            self.summariser.activity()
        if self.embedder is None:
            return
        if self.embed_inline:
            while recall.embed_pending(conn, self.embedder):
                pass
        else:
            self._wake_embedder.set()

    def wake_embedder(self, conn=None) -> None:
        """Embed new index rows soon, without counting as user activity (Home Assistant events
        come in at all hours). With embed_inline, embeds now on `conn`."""
        if self.embedder is None:
            return
        if self.embed_inline:
            if conn is not None:
                while recall.embed_pending(conn, self.embedder):
                    pass
        else:
            self._wake_embedder.set()

    def _embed_loop(self) -> None:
        """Embed new and changed index rows, a batch at a time, whenever there are any."""
        while not self._stop.is_set():
            done = 0
            # Cleared before looking for work, not after waiting: a wake that arrives while this
            # pass runs (a write just committed) then ends the wait at once instead of being lost
            # for ten seconds. Home Assistant writes made that window easy to hit.
            self._wake_embedder.clear()
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

    def _summary_loop(self) -> None:
        """While the client is idle, work through due summaries one at a time."""
        assert self.summariser is not None
        while not self._stop.wait(15):
            while self.ready and self.summariser.idle() and not self._stop.is_set():
                try:
                    outcome = self.summariser.run_once(lambda: self.pool.connection(timeout=10))
                except Exception:  # noqa: BLE001 - keep the worker alive
                    log.exception("Summary pass failed")
                    break
                if outcome is None:
                    break
                log.info("Summary: %s", outcome)
                if self.embedder is not None:
                    self._wake_embedder.set()

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
    app.state.engine = engine

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
        home_status = engine.home_status()
        body["home"] = {"configured": home_status["configured"], "connected": home_status["connected"]}
        if engine.summariser is not None:
            body["summariser"] = {
                "model": engine.summariser.llm.name,
                "idle": engine.summariser.idle(),
                "done": engine.summariser.done,
            }
            if engine.summariser.error:
                body["summariser"]["error"] = "summaries are failing; see the engine's log"
        else:
            body["summariser"] = None
        body["storage"] = engine.storage_view()
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
        touch: bool = Query(default=False, description="the agent is using what it finds: refresh those facts"),
        session_id: Optional[UUID] = None,
        source: Literal["conversation", "home_assistant", "all"] = Query(
            default="conversation", description="where to search: conversation memory, Home Assistant events, or both"
        ),
    ):
        sources = None if source == "all" else [source]
        with engine.connection() as conn:
            if mode == "text":
                results = store.search_text(
                    conn,
                    q,
                    start=start,
                    end=end,
                    agent=agent,
                    kinds=kind,
                    include_private=include_private,
                    exclude_ids=exclude or [],
                    limit=limit,
                    sources=sources,
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
                    sources=sources,
                )
            # Looking (the Memory panel) changes nothing; the agent recalling strengthens.
            if touch:
                facts.touch(conn, [r["id"] for r in results if r["kind"] == "fact"], session_id)
        return {"results": results}

    @app.get("/v1/home/status", dependencies=guarded)
    def home_status():
        return engine.home_status()

    @app.get("/v1/home/entities", dependencies=guarded)
    def home_entities(home_id: Optional[str] = Query(default=None, alias="home"), q: Optional[str] = None):
        with engine.connection() as conn:
            return {"entities": home.list_entities(conn, home_id, q)}

    @app.get("/v1/home/history", dependencies=guarded)
    def home_history(
        entity: Optional[str] = Query(default=None, max_length=300),
        q: Optional[str] = Query(default=None, max_length=300),
        start: Optional[datetime] = Query(default=None, alias="from"),
        end: Optional[datetime] = Query(default=None, alias="to"),
        limit: int = Query(default=200, ge=1, le=1000),
        home_id: Optional[str] = Query(default=None, alias="home"),
    ):
        if not (entity or q):
            raise ApiError(400, "give entity or q")
        end = end or datetime.now(timezone.utc)
        start = start or end - timedelta(hours=24)
        if end <= start:
            raise ApiError(400, "to must be after from")
        with engine.connection() as conn:
            return home.history(conn, home_id, entity, q, start, end, limit)

    @app.get("/v1/storage", dependencies=guarded)
    def get_storage():
        return engine.storage_view()

    @app.put("/v1/storage", dependencies=guarded)
    def put_storage(body: StorageBody):
        """Where memory is kept (null: this machine's database) and the optional mirror."""
        for url in (body.database, body.mirror):
            if url is not None and not storage.valid_url(url):
                raise ApiError(400, "database addresses look like postgresql://user:password@host:5432/database")
        try:
            engine.set_storage(body.database, body.mirror)
        except MoveInProgress:
            raise ApiError(503, "memory is still being copied to a new database; try again when it is done") from None
        return engine.storage_view()

    @app.post("/v1/storage/test", dependencies=guarded)
    def test_storage(body: StorageTestBody):
        """Can the engine use this database? Connects, and checks pgvector is available."""
        if not storage.valid_url(body.url):
            raise ApiError(400, "database addresses look like postgresql://user:password@host:5432/database")
        try:
            with psycopg.connect(body.url, connect_timeout=8) as conn:
                version = conn.execute("SHOW server_version").fetchone()[0]
                vector = conn.execute("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'").fetchone() is not None
        except psycopg.OperationalError as error:
            text = str(error).lower()
            log.info("Database test failed: %s", error)
            if "password" in text or "authentication" in text:
                reason = "the user name or password was refused"
            elif "does not exist" in text:
                reason = "that database does not exist"
            elif "timeout" in text or "could not connect" in text or "connection refused" in text or "translate host" in text:
                reason = "the server could not be reached"
            else:
                reason = "the connection failed; see the engine's log"
            return {"ok": False, "error": reason}
        if not vector:
            return {"ok": False, "version": version, "error": "the pgvector extension is not available there"}
        return {"ok": True, "version": version}

    @app.post("/v1/storage/push", dependencies=guarded)
    def push_storage():
        """Send the mirror what it is missing now."""
        if not engine.storage.mirror:
            raise ApiError(409, "no mirror is set")
        if not engine.ready:
            raise ApiError(503, "memory database is not ready yet")
        try:
            sent = engine.push_mirror()
        except Exception as error:  # noqa: BLE001
            log.warning("Mirror push failed: %s", error)
            engine.mirror_error = str(error)
            raise ApiError(502, "the mirror could not be updated; see the engine's log") from None
        return {"sent": sent}

    @app.post("/v1/activity", dependencies=guarded)
    def post_activity(body: ActivityBody):
        """The client says a turn started (busy) or finished, so background work stays out of
        the model's way."""
        if engine.summariser is not None:
            engine.summariser.activity(body.busy)
        return {"idle": engine.summariser.idle() if engine.summariser else None}

    @app.post("/v1/summaries/run", dependencies=guarded)
    def run_summaries(body: SummaryRunBody):
        """Do due summaries now, idle or not (for a manual catch-up, and tests)."""
        if engine.summariser is None:
            raise ApiError(409, "no summary model is configured (MEMORY_LLM_URL)")
        if not engine.ready:
            raise ApiError(503, "memory database is not ready yet")
        done = []
        for _ in range(body.limit):
            outcome = engine.summariser.run_once(engine.connection, now=body.now)
            if outcome is None:
                break
            done.append(outcome)
        if engine.embedder is not None:
            with engine.connection() as conn:
                engine.written(conn)
        return {"done": done}

    @app.get("/v1/summaries", dependencies=guarded)
    def get_summaries(
        kind: Optional[Literal["session", "day", "week", "month"]] = None,
        start: Optional[datetime] = Query(default=None, alias="from"),
        end: Optional[datetime] = Query(default=None, alias="to"),
        limit: int = Query(default=100, ge=1, le=1000),
    ):
        with engine.connection() as conn:
            return {"summaries": summaries.list_summaries(conn, kind=kind, start=start, end=end, limit=limit)}

    @app.get("/v1/brief", dependencies=guarded)
    def get_brief(session_id: Optional[UUID] = None, agent: Optional[str] = None):
        with engine.connection() as conn:
            return context.brief(conn, session_id=session_id, agent=agent)

    @app.post("/v1/recall", dependencies=guarded)
    def post_recall(body: RecallBody):
        with engine.connection() as conn:
            return context.auto_recall(
                conn,
                body.text,
                embedder=engine.embedder,
                session_id=body.session_id,
                exclude_ids=body.exclude,
                limit=body.limit,
                max_chars=body.max_chars,
                min_similarity=body.min_similarity,
            )

    @app.get("/v1/recall-log", dependencies=guarded)
    def get_recall_log(session_id: Optional[UUID] = None, limit: int = Query(default=50, ge=1, le=500)):
        with engine.connection() as conn:
            return {"entries": context.recall_log(conn, session_id=session_id, limit=limit)}

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
            # Day, week and month summaries cover every character, so a filtered timeline leaves them out.
            periods = recall.period_summaries(conn, start, end) if agent is None else []
        return {"from": start.isoformat(), "to": end.isoformat(), "summaries": periods, "sessions": sessions}

    @app.get("/v1/memories/{memory_id}", dependencies=guarded)
    def get_memory(
        memory_id: UUID,
        around: int = Query(default=1, ge=0, le=10),
        touch: bool = False,
        session_id: Optional[UUID] = None,
    ):
        with engine.connection() as conn:
            detail = recall.memory_detail(conn, memory_id, around=around)
            if touch and detail is not None and detail["kind"] == "fact":
                facts.touch(conn, [detail["id"]], session_id)
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
                    model=body.model,
                ),
            )
            engine.written(conn)
        return {"id": str(fact_id), "created": created}

    @app.post("/v1/facts/correct", dependencies=guarded)
    def correct_fact(body: CorrectBody):
        """Replace a fact with new words, or retract it. The old one is kept, marked."""
        if body.id is None and not (body.about or "").strip():
            raise ApiError(400, "name the fact by 'id' or 'about'")
        if body.action == "replace" and not (body.text or "").strip():
            raise ApiError(400, "a replacement needs 'text'")
        with engine.connection() as conn:
            outcome = facts.correct(
                conn,
                target=body.id,
                about=body.about,
                action=body.action,
                text=body.text,
                new_id=body.new_id,
                author=body.author,
                agent=body.agent,
                model=body.model,
                session_id=body.session_id,
                embedder=engine.embedder,
            )
            engine.written(conn)
        return outcome

    @app.put("/v1/sessions/{session_id}/handoff", dependencies=guarded)
    def put_handoff(session_id: UUID, body: HandoffBody):
        """The agent's note for its next conversation; replaces this conversation's earlier one."""
        with engine.connection() as conn:
            written = handoffs.put_handoff(conn, session_id, body.text, agent=body.agent, model=body.model)
            engine.written(conn)
        return written

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
