"""HTTP API (see ../../API.md): /health, /v1/motion/clip, /v1/motion/stream (NDJSON)."""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Annotated, Iterator, Literal, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from .backends.base import Backend
from .calibration import REST_BONES, arm_forward_for_avatar
from .constraints import (DEFAULT_CORNER_RADIUS, PathParams, TargetParams, build_plan, end_pose,
                          scale_for, seconds_to_frame_ceil, snap_root)
from .retarget import RootFrame, chest_forward_deg, joint_names, slugify, to_vrma
from .sessions import Session, SessionStore

log = logging.getLogger("motion_service")


class ClipRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    duration: float = Field(default=3.0, ge=0.5, le=10.0)
    steps: Optional[int] = Field(default=None, ge=1)
    name: Optional[str] = Field(default=None, max_length=80)
    # The avatar's rest skeleton (bone -> [x, y, z] metres, facing +Z), for per-avatar arm calibration.
    avatar_rest: Optional[dict[str, list[float]]] = None

    @field_validator("avatar_rest")
    @classmethod
    def _rest(cls, v: Optional[dict[str, list[float]]]) -> Optional[dict[str, list[float]]]:
        if v is None:
            return None
        missing = [bone for bone in REST_BONES if bone not in v]
        if missing:
            raise ValueError(f"avatar_rest is missing {', '.join(missing)}")
        for bone in REST_BONES:
            if len(v[bone]) != 3 or not all(math.isfinite(x) for x in v[bone]):
                raise ValueError(f"avatar_rest.{bone} must be three finite numbers")
        if v["hips"][1] <= 0:
            raise ValueError("avatar_rest.hips must be above the floor")
        return {bone: v[bone] for bone in REST_BONES}

    @field_validator("prompt")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("prompt must not be empty")
        return v


Num = Annotated[float, Field(allow_inf_nan=False, ge=-10000, le=10000)]


class PathSpec(BaseModel):
    """A pelvis path on the floor, in the motion frame (avatar metres)."""

    points: list[tuple[Num, Num]] = Field(min_length=1, max_length=500)
    corner_radius: float = Field(default=DEFAULT_CORNER_RADIUS, ge=0, le=20, allow_inf_nan=False)
    speed: float = Field(default=1.0, gt=0, le=10, allow_inf_nan=False)
    start_s: float = Field(default=0.3, ge=0, le=60, allow_inf_nan=False)
    mode: Literal["dense", "waypoints"] = "dense"


class TargetSpec(BaseModel):
    """A timed keyframe: pelvis root / height / heading and, with `hand`, a wrist position."""

    t: float = Field(ge=0, le=60, allow_inf_nan=False)
    until: Optional[float] = Field(default=None, ge=0, le=60, allow_inf_nan=False)
    root: Optional[tuple[Num, Num]] = None
    height: Optional[float] = Field(default=None, gt=0, le=10, allow_inf_nan=False)
    heading: Optional[Num] = None
    hand: Optional[Literal["left", "right"]] = None
    position: Optional[tuple[Num, Num, Num]] = None
    reveal_s: float = Field(default=0.0, ge=0, le=60, allow_inf_nan=False)

    @model_validator(mode="after")
    def _shape(self):
        if self.until is not None and self.until < self.t:
            raise ValueError("until must not be before t")
        if self.hand is not None:
            if self.position is None:
                raise ValueError("a hand target needs position")
            if self.root is None or self.height is None or self.heading is None:
                raise ValueError("a hand target needs root, height and heading (the pelvis to hold)")
        elif self.position is not None:
            raise ValueError("position needs hand")
        elif self.root is None and self.height is None and self.heading is None:
            raise ValueError("a target needs root, height, heading or hand")
        return self


class PhaseSpec(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    start_s: float = Field(ge=0, le=60, allow_inf_nan=False)

    @field_validator("prompt")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("prompt must not be empty")
        return v


class StreamRequest(ClipRequest):
    duration: float = Field(default=4.0, ge=0.5, le=30.0)
    phases: Optional[list[PhaseSpec]] = Field(default=None, max_length=16)
    path: Optional[PathSpec] = None
    targets: Optional[list[TargetSpec]] = Field(default=None, max_length=64)
    constraint_weight: float = Field(default=2.0, ge=0, le=10, allow_inf_nan=False)
    continue_from: Optional[str] = Field(default=None, max_length=64)
    snap_s: float = Field(default=0.3, ge=0, le=5, allow_inf_nan=False)


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


def _ms(seconds: float) -> int:
    return int(round(seconds * 1000))


def _arm_forward(req: ClipRequest) -> Optional[float]:
    """The calibrated arm swing for the request's avatar; None (env or default) when MOTION_ARM_FORWARD_DEG
    is set as a manual override or the request carries no skeleton."""
    if req.avatar_rest is None or os.environ.get("MOTION_ARM_FORWARD_DEG", "").strip():
        return None
    try:
        return arm_forward_for_avatar(req.avatar_rest, chest_forward_deg())
    except Exception:  # a malformed skeleton should not cost the motion
        log.warning("arm calibration failed; using the default arm swing", exc_info=True)
        return None


def create_app(backend: Backend, load_in_background: bool = True, keep_warm_seconds: float = 0,
               session_ttl_seconds: float = 600.0, max_sessions: int = 8) -> FastAPI:
    """keep_warm_seconds > 0: after that much idle time, run a tiny generation (and repeat) so the
    first request after a long pause doesn't pay to page the 8B text encoder back in (measured ~11 s
    after several idle hours on a Radeon 8060S, vs ~0.15 s warm)."""
    state = {"ready": False, "error": None, "last_used": time.monotonic(), "warmups": 0}
    lock = threading.Lock()  # one generation at a time: the GPU is the bottleneck anyway
    stop = threading.Event()
    sessions = SessionStore(max_entries=max_sessions, ttl_s=session_ttl_seconds)

    def _keep_warm():
        while not stop.wait(min(keep_warm_seconds, 30.0)):
            if not state["ready"] or time.monotonic() - state["last_used"] < keep_warm_seconds:
                continue
            if not lock.acquire(blocking=False):
                continue
            try:
                backend.warm()
                state["warmups"] += 1
            except Exception:
                log.exception("keep-warm generation failed")
            finally:
                state["last_used"] = time.monotonic()
                lock.release()

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
        if keep_warm_seconds > 0:
            threading.Thread(target=_keep_warm, name="motion-keep-warm", daemon=True).start()
        yield
        stop.set()

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
        arm_forward = _arm_forward(req)
        with lock:
            t0 = time.perf_counter()
            text = backend.encode(req.prompt)
            t1 = time.perf_counter()
            motion = backend.generate(text, frames, steps)
            t2 = time.perf_counter()
            vrma = to_vrma(motion.global_rot_mats, motion.posed_joints, motion.root_positions, name,
                           fps=backend.fps, kind=backend.name, arm_forward=arm_forward)
            t3 = time.perf_counter()
            state["last_used"] = time.monotonic()
        return {"vrma": vrma, "timings": {"encodeMs": _ms(t1 - t0), "generateMs": _ms(t2 - t1),
                                          "retargetMs": _ms(t3 - t2), "totalMs": _ms(t3 - t0)}}

    @app.post("/v1/motion/stream")
    def stream(req: StreamRequest):
        frames, steps, name = _check(req)
        previous: Optional[Session] = None
        if req.continue_from is not None:
            previous = sessions.get(req.continue_from)
            if previous is None:
                raise ApiError(404, "unknown session")
        arm_forward = _arm_forward(req)
        fps = backend.fps
        scale = scale_for(req.avatar_rest)
        plan = None
        if req.path is not None or req.targets:
            path = None if req.path is None else PathParams(**req.path.model_dump())
            targets = [TargetParams(**t.model_dump()) for t in req.targets or []]
            plan = build_plan(path, targets, fps, scale, frames)
        phase_specs = sorted(req.phases or [], key=lambda p: p.start_s)

        def lines() -> Iterator[bytes]:
            with lock:
                t_start = time.perf_counter()
                count = 0
                try:
                    t0 = time.perf_counter()
                    text = backend.encode(req.prompt)
                    encoded = {req.prompt: text}  # each distinct prompt is encoded once
                    phase_texts = []
                    for p in phase_specs:
                        if p.prompt not in encoded:
                            encoded[p.prompt] = backend.encode(p.prompt)
                        phase_texts.append((seconds_to_frame_ceil(p.start_s, fps), encoded[p.prompt]))
                    encode_s = time.perf_counter() - t0
                    root_frame: Optional[RootFrame] = None if previous is None else previous.root_frame
                    carry = (0.0, 0.0) if previous is None else previous.carry
                    last_history = None
                    t_prev = time.perf_counter()
                    for chunk in backend.stream(text, frames, steps, plan=plan, phase_texts=phase_texts or None,
                                                history=None if previous is None else previous.history,
                                                constraint_weight=req.constraint_weight):
                        m = chunk.motion
                        t_gen = time.perf_counter()
                        names = joint_names(m.global_rot_mats.shape[1])
                        if root_frame is None:  # every chunk shares the first chunk's floor and origin
                            root_frame = RootFrame.from_motion(m.posed_joints, m.root_positions, names)
                        if plan is not None or previous is not None:
                            _snapped, delta = snap_root(m.root_positions, plan, fps, req.snap_s,
                                                        chunk.start_frame, carry if chunk.start_frame == 0 else None)
                            if delta.any():
                                m = m.translated(delta)
                            carry_out = (float(delta[-1, 0]), float(delta[-1, 2]))
                        else:
                            carry_out = (0.0, 0.0)
                        vrma = to_vrma(m.global_rot_mats, m.posed_joints, m.root_positions, f"{name}-{count}",
                                       fps=fps, kind=backend.name, root_frame=root_frame, arm_forward=arm_forward)
                        pose = end_pose(m.root_positions, m.posed_joints, names,
                                        (root_frame.origin_x, root_frame.origin_z), scale)
                        t_done = time.perf_counter()
                        timings = {"generateMs": _ms(t_gen - t_prev), "retargetMs": _ms(t_done - t_gen),
                                   "totalMs": _ms(t_done - t_prev + (encode_s if count == 0 else 0))}
                        if count == 0:
                            timings["encodeMs"] = _ms(encode_s)
                        yield (json.dumps({"type": "chunk", "index": count,
                                           "start": round(chunk.start_frame / fps, 5),
                                           "vrma": vrma, "timings": timings, "end_pose": pose}) + "\n").encode()
                        count += 1
                        if chunk.history is not None:
                            last_history = chunk.history
                            carry = carry_out
                        t_prev = time.perf_counter()
                    done = {"type": "done", "chunks": count,
                            "timings": {"totalMs": _ms(time.perf_counter() - t_start)}}
                    if last_history is not None and root_frame is not None:
                        done["session"] = sessions.put(Session(last_history, root_frame, carry))
                    yield (json.dumps(done) + "\n").encode()
                except Exception as e:  # headers are already sent: report in-band and end the stream
                    log.exception("stream failed")
                    yield (json.dumps({"type": "error", "message": f"{type(e).__name__}: {e}"}) + "\n").encode()
                finally:
                    state["last_used"] = time.monotonic()

        return StreamingResponse(lines(), media_type="application/x-ndjson")

    return app
