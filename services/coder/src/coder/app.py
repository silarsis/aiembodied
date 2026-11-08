"""HTTP API (see ../../API.md)."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import __version__, capabilities as caps, gitops
from .agentdir import write_agent_dir
from .config import Config
from .manager import CoderError, TaskManager
from .store import Store
from . import settings as settings_mod
from .workspaces import ModelRef, Workspace, WorkspaceError, WorkspaceRegistry

log = logging.getLogger("coder")


class TaskBody(BaseModel):
    workspace_id: str
    goal: str = Field(min_length=1, max_length=20_000)
    acceptance: list[str] = Field(default_factory=list)
    scope: list[str] = Field(default_factory=list)
    model: Optional[ModelRef] = None


class MessageBody(BaseModel):
    message: str = Field(min_length=1, max_length=50_000)


class AnswerBody(BaseModel):
    value: Optional[str] = None
    confirmed: Optional[bool] = None
    cancelled: Optional[bool] = None
    dialog_id: Optional[str] = None


class ApplyBody(BaseModel):
    draft: bool = False


class EventHub:
    """Fans task changes out to the open /v1/events streams. publish() may be called from any thread."""

    def __init__(self) -> None:
        self.subs: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self.subs.append((asyncio.get_running_loop(), q))
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subs = [s for s in self.subs if s[1] is not q]

    def publish(self, msg: dict) -> None:
        for loop, q in list(self.subs):
            def put(q=q) -> None:
                try:
                    q.put_nowait(msg)
                except asyncio.QueueFull:
                    pass
            try:
                loop.call_soon_threadsafe(put)
            except RuntimeError:
                pass


def create_app(cfg: Optional[Config] = None) -> FastAPI:
    cfg = cfg or Config.from_env()
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    settings_mod.load(cfg)
    write_agent_dir(cfg)
    store = Store(cfg.db_path)
    registry = WorkspaceRegistry(cfg.workspaces_path)
    hub = EventHub()
    manager = TaskManager(cfg, store, registry, on_change=hub.publish)
    probe = caps.PiProbe(cfg)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        manager.resume_all()
        manager.pump()
        yield
        manager.shutdown()

    app = FastAPI(title="Coding runner", version=__version__, lifespan=lifespan)
    app.state.manager, app.state.store, app.state.hub, app.state.config = manager, store, hub, cfg

    @app.exception_handler(CoderError)
    async def coder_error(_req, exc: CoderError):
        return Response(json.dumps({"detail": exc.message}), status_code=exc.status_code, media_type="application/json")

    @app.get("/v1/health")
    def health() -> dict:
        found = probe.found()
        version = probe.version()[0] if found else None
        return {"ok": True, "version": __version__, "pi": {"found": found, "version": version}}

    @app.put("/v1/settings")
    def put_settings(body: settings_mod.SettingsBody) -> dict:
        return settings_mod.apply(cfg, body)

    @app.get("/v1/settings")
    def get_settings() -> dict:
        return settings_mod.snapshot(cfg)

    @app.get("/v1/status")
    def status() -> dict:
        return manager.status()

    @app.put("/v1/workspaces")
    def put_workspaces(items: list[Workspace]) -> list[Workspace]:
        try:
            return registry.replace(items)
        except WorkspaceError as e:
            raise HTTPException(400, str(e))

    @app.get("/v1/workspaces")
    def get_workspaces() -> list[Workspace]:
        return registry.all()

    @app.put("/v1/keys", status_code=204)
    def put_keys(keys: dict[str, Optional[str]]) -> Response:
        manager.set_keys(keys)
        return Response(status_code=204)

    @app.get("/v1/keys")
    def get_keys() -> dict:
        return manager.keys_set()

    @app.post("/v1/tasks")
    def create_task(body: TaskBody) -> dict:
        return manager.create_task(body.workspace_id, body.goal, body.acceptance, body.scope, body.model)

    @app.get("/v1/tasks")
    def list_tasks(status: Optional[str] = None) -> list[dict]:
        return store.list_tasks(status)

    @app.get("/v1/tasks/{tid}")
    def get_task(tid: str) -> dict:
        return manager._get(tid)

    @app.get("/v1/tasks/{tid}/events")
    def task_events(tid: str, after: int = 0, limit: int = Query(1000, le=5000)) -> list[dict]:
        manager._get(tid)
        return store.events(tid, after, limit)

    @app.get("/v1/tasks/{tid}/diff", response_class=PlainTextResponse)
    def task_diff(tid: str) -> str:
        t = manager._get(tid)
        ws = registry.get(t["workspace_id"])
        if not ws or not t["base_commit"]:
            raise HTTPException(404, "no diff yet")
        from pathlib import Path
        text = gitops.diff_text(Path(ws.path), Path(t["worktree"]) if t["worktree"] else None, t["base_commit"], t["branch"])
        if text is None:
            raise HTTPException(404, "the worktree and branch are gone")
        return text

    @app.post("/v1/tasks/{tid}/steer")
    def steer(tid: str, body: MessageBody) -> dict:
        return manager.steer(tid, body.message)

    @app.post("/v1/tasks/{tid}/follow_up")
    def follow_up(tid: str, body: MessageBody) -> dict:
        return manager.follow_up(tid, body.message)

    @app.post("/v1/tasks/{tid}/answer")
    def answer(tid: str, body: AnswerBody) -> dict:
        return manager.answer(tid, body.value, body.confirmed, body.cancelled, body.dialog_id)

    @app.post("/v1/tasks/{tid}/cancel")
    def cancel(tid: str) -> dict:
        return manager.cancel(tid)

    @app.post("/v1/tasks/{tid}/apply")
    def apply(tid: str, body: Optional[ApplyBody] = None) -> dict:
        return manager.apply(tid, body.draft if body else False)

    @app.post("/v1/tasks/{tid}/discard")
    def discard(tid: str) -> dict:
        return manager.discard(tid)

    @app.get("/v1/events")
    async def events() -> StreamingResponse:
        q = hub.subscribe()

        async def gen():
            try:
                yield ": connected\n\n"
                yield f"data: {json.dumps({'task_id': None, 'local_model_needed': manager.local_model_needed()})}\n\n"
                while True:
                    try:
                        msg = await asyncio.wait_for(q.get(), 15)
                        yield f"data: {json.dumps(msg)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                hub.unsubscribe(q)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    @app.get("/v1/capabilities")
    def capabilities(refresh: int = 0) -> dict:
        return caps.capabilities(cfg, probe, store, registry.all(), bool(refresh))

    return app
