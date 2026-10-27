"""Speech engines. Speech-to-text: an OpenAI-compatible server (Qwen3-ASR on llama-server by
default) or faster-whisper in-process. Text-to-speech: Kokoro (ONNX).

Engines load lazily in `load()` so the HTTP server can come up first and report readiness.
The fake engines need no models and are used by the tests and `--engines fake`.
"""

from __future__ import annotations

import base64
import io
import json
import math
import re
import urllib.request
import wave
from typing import Protocol

import numpy as np

STT_SAMPLE_RATE = 16000


class Transcriber(Protocol):
    description: dict

    def load(self) -> None: ...
    def transcribe(self, audio: np.ndarray, language: str | None) -> str: ...


class Synthesizer(Protocol):
    description: dict
    voices: list[str]

    def load(self) -> None: ...
    def synthesize(self, text: str, voice: str, speed: float) -> tuple[np.ndarray, int]: ...


class WhisperTranscriber:
    """faster-whisper (CTranslate2). On a Ryzen AI Max CPU, small.en takes ~1 s per 4 s utterance."""

    def __init__(self, model: str = "small.en", device: str = "auto", compute_type: str = "default",
                 beam_size: int = 1):
        self.model_name = model
        self.device = device
        self.compute_type = compute_type
        self.beam_size = beam_size
        self._model = None
        self.description = {"engine": "faster-whisper", "model": model, "device": device}

    def load(self) -> None:
        from faster_whisper import WhisperModel

        self._model = WhisperModel(self.model_name, device=self.device, compute_type=self.compute_type)
        self.description["device"] = getattr(self._model.model, "device", self.device)

    def transcribe(self, audio: np.ndarray, language: str | None) -> str:
        assert self._model is not None, "load() first"
        segments, _info = self._model.transcribe(
            audio, language=language, beam_size=self.beam_size, condition_on_previous_text=False,
            vad_filter=True, without_timestamps=True,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()


class ChatAudioTranscriber:
    """Speech-to-text through an OpenAI-compatible chat endpoint that takes `input_audio`, such as
    llama-server running Qwen3-ASR-0.6B with its audio mmproj (scripts/start-local-asr.ps1).

    On the Radeon 8060S it transcribes a 5 s utterance in ~0.15 s, against ~1 s for whisper
    small.en on the CPU, and runs alongside the Qwen Flash-Next server without slowing it.
    """

    # Qwen3-ASR prefixes its transcript with the detected language: "language English<asr_text>…"
    _PREFIX = re.compile(r"^\s*language\s+[^<]*<asr_text>\s*", re.IGNORECASE)

    def __init__(self, base_url: str, model: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.description = {"engine": "openai-compatible", "model": model, "url": self.base_url}

    def load(self) -> None:
        # Nothing to load here; a server that is down shows up as a failed request instead, so the
        # service still comes up if the ASR server is started after it.
        pass

    def transcribe(self, audio: np.ndarray, language: str | None) -> str:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(STT_SAMPLE_RATE)
            writer.writeframes((np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes())
        body = {
            "model": self.model,
            "temperature": 0,
            "max_tokens": 512,
            "messages": [{"role": "user", "content": [{
                "type": "input_audio",
                "input_audio": {"data": base64.b64encode(buffer.getvalue()).decode("ascii"), "format": "wav"},
            }]}],
        }
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions", data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            reply = json.loads(response.read())
        return self.clean(reply["choices"][0]["message"].get("content") or "")

    @classmethod
    def clean(cls, text: str) -> str:
        return cls._PREFIX.sub("", text).strip()


# Kokoro voices hold one style vector per input length (510 rows, indexed by phoneme count), and
# kokoro-onnx picks the row matching the text. Speaking a reply one sentence at a time then gives
# every sentence a different style: short ones ("Sure.", "Anything else?") use rows far from long
# ones, and af_heart sounded like a different person part-way through a reply. Rows settle above
# ~80 phonemes, so every sentence uses this long-text row instead.
FIXED_STYLE_ROW = 120


class KokoroSynthesizer:
    """Kokoro 82M via kokoro-onnx; CPU is fast enough for sentence-at-a-time streaming."""

    def __init__(self, model_path: str, voices_path: str, style_row: int | None = FIXED_STYLE_ROW):
        self.model_path = model_path
        self.voices_path = voices_path
        self.style_row = style_row
        self._kokoro = None
        self.voices: list[str] = []
        self.description = {"engine": "kokoro", "model": model_path, "style_row": style_row}

    def load(self) -> None:
        from kokoro_onnx import Kokoro

        self._kokoro = Kokoro(self.model_path, self.voices_path)
        self.voices = sorted(self._kokoro.get_voices())

    def synthesize(self, text: str, voice: str, speed: float) -> tuple[np.ndarray, int]:
        assert self._kokoro is not None, "load() first"
        lang = "en-gb" if voice.startswith("b") else "en-us"
        style = voice
        if self.style_row is not None:
            row = min(self.style_row, 509)
            style = self._kokoro.get_voice_style(voice)[row:row + 1]
        samples, rate = self._kokoro.create(text, voice=style, speed=speed, lang=lang)
        return np.asarray(samples, dtype=np.float32), int(rate)


class FakeTranscriber:
    description = {"engine": "fake", "model": "none", "device": "cpu"}

    def load(self) -> None:
        pass

    def transcribe(self, audio: np.ndarray, language: str | None) -> str:
        return f"fake transcript of {len(audio) / STT_SAMPLE_RATE:.2f} seconds"


class FakeSynthesizer:
    description = {"engine": "fake", "model": "none"}
    voices = ["fake_voice"]

    def load(self) -> None:
        pass

    def synthesize(self, text: str, voice: str, speed: float) -> tuple[np.ndarray, int]:
        """A 220 Hz tone, 60 ms per word, so lip-sync and playback can be wired without models."""
        rate = 24000
        seconds = max(0.2, 0.06 * len(text.split()) / max(speed, 0.1))
        t = np.arange(int(rate * seconds), dtype=np.float32) / rate
        return (0.2 * np.sin(2 * math.pi * 220 * t)).astype(np.float32), rate
