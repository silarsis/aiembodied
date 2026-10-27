"""HTTP API (see ../../API.md): /health, /v1/stt, /v1/tts, /v1/voices."""

from __future__ import annotations

import logging
import threading
import time
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, field_validator

from .backends.base import SpeechToText, TextToSpeech

log = logging.getLogger("voice_service")

MAX_STT_SECONDS = 60


class TtsRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    voice: Optional[str] = Field(default=None, max_length=64)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)

    @field_validator("text")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("text must not be empty")
        return v


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


def _ms(seconds: float) -> int:
    return int(round(seconds * 1000))


def pcm16_to_float(data: bytes) -> np.ndarray:
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def float_to_pcm16(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def create_app(stt: SpeechToText, tts: TextToSpeech, load_in_background: bool = True) -> FastAPI:
    state = {"ready": False, "error": None}
    # One transcription and one synthesis at a time; the two can overlap.
    stt_lock = threading.Lock()
    tts_lock = threading.Lock()

    def _load():
        try:
            t = time.perf_counter()
            stt.load()
            tts.load()
            state["ready"] = True
            log.info("voice backends ready in %.1fs: stt=%s, tts=%s", time.perf_counter() - t,
                     stt.device_label, tts.device_label)
        except Exception as e:  # surfaced through /health
            log.exception("backend load failed")
            state["error"] = f"{type(e).__name__}: {e}"

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if load_in_background:
            threading.Thread(target=_load, name="voice-load", daemon=True).start()
        else:
            _load()
        yield

    app = FastAPI(title="aiembodied local voice service", lifespan=lifespan)
    app.state.voice = state

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

    def _check_ready() -> None:
        if not state["ready"]:
            msg = "models are still loading" if state["error"] is None else f"models failed to load: {state['error']}"
            raise ApiError(503, msg)

    @app.get("/health")
    def health():
        body = {
            "status": "ok" if state["error"] is None else "error",
            "ready": state["ready"],
            "stt": {"backend": stt.name, "device": stt.device_label},
            "tts": {"backend": tts.name, "device": tts.device_label, "voice": tts.default_voice},
        }
        if state["error"]:
            body["error"] = state["error"]
        return body

    @app.get("/v1/voices")
    def voices():
        _check_ready()
        return {"default": tts.default_voice, "voices": tts.voices()}

    @app.post("/v1/stt")
    async def transcribe(request: Request, sample_rate: int = 16000):
        _check_ready()
        if sample_rate != stt.sample_rate:
            raise ApiError(400, f"sample_rate must be {stt.sample_rate}")
        data = await request.body()
        if len(data) % 2:
            raise ApiError(400, "body must be 16-bit little-endian mono PCM")
        if len(data) > MAX_STT_SECONDS * sample_rate * 2:
            raise ApiError(400, f"audio must be at most {MAX_STT_SECONDS} seconds")
        audio = pcm16_to_float(data)
        with stt_lock:
            t0 = time.perf_counter()
            result = stt.transcribe(audio)
            elapsed = time.perf_counter() - t0
        return {"text": result.text, "language": result.language,
                "durationMs": _ms(audio.size / sample_rate), "timings": {"sttMs": _ms(elapsed)}}

    @app.post("/v1/tts")
    def synthesize(req: TtsRequest):
        _check_ready()
        with tts_lock:
            t0 = time.perf_counter()
            result = tts.synthesize(req.text, req.voice, req.speed)
            elapsed = time.perf_counter() - t0
        return Response(content=float_to_pcm16(result.samples), media_type="application/octet-stream",
                        headers={"X-Sample-Rate": str(result.sample_rate), "X-Tts-Ms": str(_ms(elapsed))})

    return app
