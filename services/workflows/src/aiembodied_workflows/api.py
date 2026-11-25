"""The HTTP API (Contract 3). See ../../API.md."""

from __future__ import annotations

import hmac
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import __version__
from .logs import get_logger
from .memory import MemoryError
from .service import Service, ServiceError
from .settings import Settings

log = get_logger("api")


class AgentIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = ""


class AgentsIn(BaseModel):
    agents: list[AgentIn]


class SleepIn(BaseModel):
    reason: str = "asked to sleep"


class DueIn(BaseModel):
    avatarId: str
    at: str | None = None
    inSeconds: float | None = None
    text: str | None = None
    note: str | None = None
    alarm: bool = False


class WatchIn(BaseModel):
    avatarId: str
    condition: dict[str, Any]
    then: dict[str, Any]
    untilHours: float | None = None


class FlowIn(BaseModel):
    description: str = ""
    definition: Any
    trigger: Any = Field(default_factory=lambda: {"kind": "manual"})
    enabled: bool = True


class RunIn(BaseModel):
    inputs: dict[str, Any] = Field(default_factory=dict)


class IntentionIn(BaseModel):
    avatarId: str
    kind: str = "intention"
    text: str = Field(min_length=1)
    why: str | None = None
    dueAt: str | None = None
    parentId: str | None = None


class PlanSignalIn(BaseModel):
    signal: str
    args: dict[str, Any] | None = None


def create_app(settings: Settings, service: Service | None = None) -> FastAPI:
    svc = service or Service(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if service is None:  # a service passed in (tests) is not started or stopped here
            await svc.start()
        try:
            yield
        finally:
            if service is None:
                await svc.stop()

    app = FastAPI(title="aiembodied workflows", version=__version__, lifespan=lifespan)
    app.state.service = svc

    def guard(authorization: str | None = Header(default=None)) -> None:
        if not settings.api_token:
            return
        sent = (authorization or "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(sent, settings.api_token):
            raise HTTPException(401, "missing or wrong bearer token")

    @app.middleware("http")
    async def log_changes(request: Request, call_next):
        t0 = time.monotonic()
        response = await call_next(request)
        if request.method != "GET" and request.url.path != "/health":
            log.info("%s %s -> %s (%.0f ms)", request.method, request.url.path, response.status_code,
                     (time.monotonic() - t0) * 1000)
        return response

    @app.exception_handler(ServiceError)
    async def _service_error(_r: Request, exc: ServiceError):
        return JSONResponse({"detail": exc.detail}, status_code=exc.status)

    @app.exception_handler(MemoryError)
    async def _memory_error(_r: Request, exc: MemoryError):
        return JSONResponse({"detail": str(exc)}, status_code=502)

    @app.exception_handler(RequestValidationError)
    async def _bad_body(_r: Request, exc: RequestValidationError):
        msgs = [f"{'.'.join(str(p) for p in e['loc'][1:])}: {e['msg']}" for e in exc.errors()]
        return JSONResponse({"detail": {"errors": msgs}}, status_code=422)

    @app.get("/health")
    async def health():
        return {"ok": True, "version": __version__, "temporal": svc.temporal_ok, "namespace": settings.namespace,
                "agentLife": settings.agent_life, "agents": list(svc.agents)}

    @app.put("/v1/agents", dependencies=[Depends(guard)])
    async def put_agents(body: AgentsIn):
        return await svc.sync_agents([(a.id, a.name or a.id) for a in body.agents])

    @app.get("/v1/agents/{avatar}/life", dependencies=[Depends(guard)])
    async def life(avatar: str):
        return await svc.life_state(avatar)

    @app.post("/v1/agents/{avatar}/sleep", dependencies=[Depends(guard)])
    async def sleep(avatar: str, body: SleepIn | None = None):
        await svc.signal_life(avatar, "sleep", (body.reason if body else "asked to sleep"))
        return {"ok": True}

    @app.post("/v1/agents/{avatar}/wake", dependencies=[Depends(guard)])
    async def wake(avatar: str):
        await svc.signal_life(avatar, "wake")
        return {"ok": True}

    @app.post("/v1/reminders", dependencies=[Depends(guard)])
    async def reminder(body: DueIn):
        if not (body.text or "").strip():
            raise ServiceError(422, {"errors": ["text: required"]})
        return await svc.create_due("reminder", body.avatarId, body.text.strip(), body.at, body.inSeconds, body.alarm)

    @app.post("/v1/wakeups", dependencies=[Depends(guard)])
    async def wakeup(body: DueIn):
        note = (body.note or body.text or "").strip()
        if not note:
            raise ServiceError(422, {"errors": ["note: required"]})
        return await svc.create_due("wakeup", body.avatarId, note, body.at, body.inSeconds)

    @app.post("/v1/watches", dependencies=[Depends(guard)])
    async def watch(body: WatchIn):
        return await svc.create_watch(body.avatarId, body.condition, body.then, body.untilHours)

    @app.get("/v1/flows", dependencies=[Depends(guard)])
    async def flows(avatarId: str | None = Query(default=None)):
        return {"flows": await svc.memory.flows(avatarId)}

    @app.get("/v1/flows/{avatar}/{name}", dependencies=[Depends(guard)])
    async def get_flow(avatar: str, name: str):
        row = await svc.memory.get_flow(avatar, name)
        if not row:
            raise ServiceError(404, f"no flow {name} for {avatar}")
        return row

    @app.put("/v1/flows/{avatar}/{name}", dependencies=[Depends(guard)])
    async def put_flow(avatar: str, name: str, body: FlowIn):
        return await svc.put_flow(avatar, name, body.description, body.definition, body.trigger, body.enabled)

    @app.post("/v1/flows/{avatar}/{name}/run", dependencies=[Depends(guard)])
    async def run_flow(avatar: str, name: str, body: RunIn | None = None):
        return await svc.run_flow(avatar, name, body.inputs if body else None)

    @app.delete("/v1/flows/{avatar}/{name}", dependencies=[Depends(guard)])
    async def delete_flow(avatar: str, name: str):
        return await svc.delete_flow(avatar, name)

    @app.post("/v1/intentions", dependencies=[Depends(guard)])
    async def intention(body: IntentionIn):
        if body.kind not in ("goal", "intention", "promise"):
            raise ServiceError(422, {"errors": ["kind: must be goal, intention or promise"]})
        row = {"avatar_id": body.avatarId, "kind": body.kind, "text": body.text, "why": body.why,
               "status": "open", "due_at": body.dueAt, "parent_id": body.parentId}
        return await svc.memory.create_intention({k: v for k, v in row.items() if v is not None})

    @app.get("/v1/plans", dependencies=[Depends(guard)])
    async def plans(avatarId: str):
        return await svc.plans(avatarId)

    @app.post("/v1/plans/{workflow_id}/signal", dependencies=[Depends(guard)])
    async def plan_signal(workflow_id: str, body: PlanSignalIn):
        if body.signal not in ("pause", "resume", "snooze", "note"):
            raise ServiceError(422, {"errors": ["signal: must be pause, resume, snooze or note"]})
        await svc.signal_plan(workflow_id, body.signal, body.args)
        return {"ok": True}

    @app.delete("/v1/plans/{workflow_id}", dependencies=[Depends(guard)])
    async def drop_plan(workflow_id: str, why: str | None = None):
        return await svc.drop_plan(workflow_id, why)

    return app
