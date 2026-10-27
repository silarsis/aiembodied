"""HTTP API (see ../../API.md): /health, /v1/stt (WAV in, text out), /v1/tts (JSON in, WAV out)."""

from __future__ import annotations

import io
import logging
import threading
import time
import wave
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, ValidationError

from .engines import STT_SAMPLE_RATE, Synthesizer, Transcriber

log = logging.getLogger("speech_service")

MAX_STT_SECONDS = 60


class TtsRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    voice: Optional[str] = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


def decode_wav(data: bytes) -> np.ndarray:
    """16-bit PCM WAV (any rate, any channel count) -> float32 mono at 16 kHz."""
    try:
        with wave.open(io.BytesIO(data), "rb") as reader:
            if reader.getsampwidth() != 2:
                raise ApiError(400, "audio must be 16-bit PCM WAV")
            rate, channels = reader.getframerate(), reader.getnchannels()
            frames = reader.readframes(reader.getnframes())
    except (wave.Error, EOFError) as error:
        raise ApiError(400, f"invalid WAV: {error}") from error

    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != STT_SAMPLE_RATE and len(audio) > 0:
        target = int(round(len(audio) * STT_SAMPLE_RATE / rate))
        audio = np.interp(np.linspace(0, len(audio) - 1, target), np.arange(len(audio)), audio).astype(np.float32)
    return audio


def encode_wav(samples: np.ndarray, rate: int) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(pcm.tobytes())
    return buffer.getvalue()


def _ms(seconds: float) -> int:
    return int(round(seconds * 1000))


def create_app(transcriber: Transcriber, synthesizer: Synthesizer, default_voice: str,
               language: str | None = "en", load_in_background: bool = True) -> FastAPI:
    state: dict = {"ready": False, "error": None}
    # One STT and one TTS at a time each; they use different engines, so they may overlap.
    stt_lock, tts_lock = threading.Lock(), threading.Lock()

    def _load() -> None:
        started = time.perf_counter()
        try:
            transcriber.load()
            synthesizer.load()
            state["ready"] = True
            log.info("engines ready in %.1f s (stt=%s, tts=%s)", time.perf_counter() - started,
                     transcriber.description, synthesizer.description)
        except Exception as error:  # noqa: BLE001 - surfaced through /health
            state["error"] = f"{type(error).__name__}: {error}"
            log.exception("engine load failed")

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if load_in_background:
            threading.Thread(target=_load, name="speech-load", daemon=True).start()
        else:
            _load()
        yield

    app = FastAPI(title="aiembodied speech service", lifespan=lifespan)

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, error: ApiError) -> JSONResponse:
        return JSONResponse({"error": error.message}, status_code=error.status)

    def _require_ready() -> None:
        if state["error"]:
            raise ApiError(503, f"engines failed to load: {state['error']}")
        if not state["ready"]:
            raise ApiError(503, "engines are still loading")

    @app.get("/health")
    def health() -> dict:
        return {
            "status": "error" if state["error"] else "ok" if state["ready"] else "loading",
            "ready": state["ready"],
            "error": state["error"],
            "stt": transcriber.description,
            "tts": {**synthesizer.description, "voices": list(synthesizer.voices), "default_voice": default_voice},
        }

    @app.post("/v1/stt")
    async def stt(request: Request) -> dict:
        _require_ready()
        audio = decode_wav(await request.body())
        seconds = len(audio) / STT_SAMPLE_RATE
        if seconds > MAX_STT_SECONDS:
            raise ApiError(413, f"audio is {seconds:.0f} s; the limit is {MAX_STT_SECONDS} s")
        started = time.perf_counter()
        with stt_lock:
            text = transcriber.transcribe(audio, language) if seconds > 0 else ""
        elapsed = time.perf_counter() - started
        log.info("stt %.2f s audio in %d ms: %r", seconds, _ms(elapsed), text[:80])
        return {"text": text, "timings": {"audio_ms": _ms(seconds), "transcribe_ms": _ms(elapsed)}}

    @app.post("/v1/tts")
    async def tts(request: Request) -> Response:
        _require_ready()
        try:
            body = TtsRequest.model_validate_json(await request.body())
        except ValidationError as error:
            raise ApiError(400, error.errors()[0]["msg"]) from error
        voice = body.voice or default_voice
        if synthesizer.voices and voice not in synthesizer.voices:
            raise ApiError(400, f"unknown voice {voice!r}")
        started = time.perf_counter()
        with tts_lock:
            samples, rate = synthesizer.synthesize(body.text.strip(), voice, body.speed)
        elapsed = time.perf_counter() - started
        log.info("tts %d chars -> %.2f s audio in %d ms", len(body.text), len(samples) / rate, _ms(elapsed))
        return Response(
            content=encode_wav(samples, rate), media_type="audio/wav",
            headers={"X-Audio-Ms": str(_ms(len(samples) / rate)), "X-Synthesize-Ms": str(_ms(elapsed))},
        )

    return app
