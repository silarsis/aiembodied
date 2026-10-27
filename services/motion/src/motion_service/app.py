"""HTTP API (see ../../API.md): /health, /v1/motion/clip, /v1/motion/stream (NDJSON)."""

from __future__ import annotations

import json
import logging
import threading
import time
from contextlib import asynccontextmanager
from typing import Iterator, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from .backends.base import Backend
from .retarget import RootFrame, joint_names, slugify, to_vrma

log = logging.getLogger("motion_service")


class ClipRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    duration: float = Field(default=3.0, ge=0.5, le=10.0)
    steps: Optional[int] = Field(default=None, ge=1)
    name: Optional[str] = Field(default=None, max_length=80)

    @field_validator("prompt")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("prompt must not be empty")
        return v


class StreamRequest(ClipRequest):
    duration: float = Field(default=4.0, ge=0.5, le=20.0)


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


def _ms(seconds: float) -> int:
    return int(round(seconds * 1000))


def create_app(backend: Backend, load_in_background: bool = True) -> FastAPI:
    state = {"ready": False, "error": None}
    lock = threading.Lock()  # one generation at a time: the GPU is the bottleneck anyway

    def _load():
        try:
            t = time.perf_counter()
            backend.load()
            state["ready"] = True
            log.info("backend %s ready on %s in %.1fs", backend.name, backend.device_label, time.perf_counter() - t)
        except Exception as e:  # surfaced through /health
            log.exception("backend load failed")
            state["error"] = f"{type(e).__name__}: {e}"

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if load_in_background:
            threading.Thread(target=_load, name="motion-load", daemon=True).start()
        else:
            _load()
        yield

    app = FastAPI(title="aiembodied local motion service", lifespan=lifespan)
    app.state.motion = state

    @app.exception_handler(ApiError)
    async def _api_error(_req: Request, exc: ApiError):
        return JSONResponse(status_code=exc.status, content={"error": exc.message})

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_req: Request, exc: RequestValidationError):
        parts = []
        for err in exc.errors():
            loc = ".".join(str(p) for p in err.get("loc", []) if p != "body")
            parts.append(f"{loc}: {err.get('msg')}" if loc else str(err.get("msg")))
        return JSONResponse(status_code=400, content={"error": "; ".join(parts) or "invalid request"})

    @app.exception_handler(Exception)
    async def _internal_error(_req: Request, exc: Exception):
        log.exception("request failed")
        return JSONResponse(status_code=500, content={"error": f"{type(exc).__name__}: {exc}"})

    def _check(req: ClipRequest) -> tuple[int, int, str]:
        if not state["ready"]:
            msg = "model is still loading" if state["error"] is None else f"model failed to load: {state['error']}"
            raise ApiError(503, msg)
        steps = req.steps if req.steps is not None else backend.default_steps
        if backend.max_steps is not None and steps > backend.max_steps:
            raise ApiError(400, f"steps must be between 1 and {backend.max_steps} for the {backend.name} backend")
        frames = max(2, int(round(req.duration * backend.fps)))
        name = slugify(req.name) if req.name else slugify(req.prompt, 40)
        return frames, steps, name

    @app.get("/health")
    def health():
        body = {"status": "ok" if state["error"] is None else "error", "backend": backend.name,
                "device": backend.device_label, "ready": state["ready"]}
        if state["error"]:
            body["error"] = state["error"]
        return body

    @app.post("/v1/motion/clip")
    def clip(req: ClipRequest):
        frames, steps, name = _check(req)
        with lock:
            t0 = time.perf_counter()
            text = backend.encode(req.prompt)
            t1 = time.perf_counter()
            motion = backend.generate(text, frames, steps)
            t2 = time.perf_counter()
            vrma = to_vrma(motion.global_rot_mats, motion.posed_joints, motion.root_positions, name,
                           fps=backend.fps, kind=backend.name)
            t3 = time.perf_counter()
        return {"vrma": vrma, "timings": {"encodeMs": _ms(t1 - t0), "generateMs": _ms(t2 - t1),
                                          "retargetMs": _ms(t3 - t2), "totalMs": _ms(t3 - t0)}}

    @app.post("/v1/motion/stream")
    def stream(req: StreamRequest):
        frames, steps, name = _check(req)

        def lines() -> Iterator[bytes]:
            with lock:
                t_start = time.perf_counter()
                count = 0
                try:
                    t0 = time.perf_counter()
                    text = backend.encode(req.prompt)
                    encode_s = time.perf_counter() - t0
                    root_frame: Optional[RootFrame] = None
                    t_prev = time.perf_counter()
                    for chunk in backend.stream(text, frames, steps):
                        m = chunk.motion
                        t_gen = time.perf_counter()
                        if root_frame is None:  # every chunk shares the first chunk's floor and origin
                            root_frame = RootFrame.from_motion(m.posed_joints, m.root_positions,
                                                               joint_names(m.global_rot_mats.shape[1]))
                        vrma = to_vrma(m.global_rot_mats, m.posed_joints, m.root_positions, f"{name}-{count}",
                                       fps=backend.fps, kind=backend.name, root_frame=root_frame)
                        t_done = time.perf_counter()
                        timings = {"generateMs": _ms(t_gen - t_prev), "retargetMs": _ms(t_done - t_gen),
                                   "totalMs": _ms(t_done - t_prev + (encode_s if count == 0 else 0))}
                        if count == 0:
                            timings["encodeMs"] = _ms(encode_s)
                        yield (json.dumps({"type": "chunk", "index": count,
                                           "start": round(chunk.start_frame / backend.fps, 5),
                                           "vrma": vrma, "timings": timings}) + "\n").encode()
                        count += 1
                        t_prev = time.perf_counter()
                    yield (json.dumps({"type": "done", "chunks": count,
                                       "timings": {"totalMs": _ms(time.perf_counter() - t_start)}}) + "\n").encode()
                except Exception as e:  # headers are already sent: report in-band and end the stream
                    log.exception("stream failed")
                    yield (json.dumps({"type": "error", "message": f"{type(e).__name__}: {e}"}) + "\n").encode()

        return StreamingResponse(lines(), media_type="application/x-ndjson")

    return app
