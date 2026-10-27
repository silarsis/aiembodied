"""Speech engines: faster-whisper for speech-to-text, Kokoro (ONNX) for text-to-speech.

Both load lazily in `load()` so the HTTP server can come up first and report readiness.
The fake engines need no models and are used by the tests and `--engines fake`.
"""

from __future__ import annotations

import math
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


class KokoroSynthesizer:
    """Kokoro 82M via kokoro-onnx; CPU is fast enough for sentence-at-a-time streaming."""

    def __init__(self, model_path: str, voices_path: str):
        self.model_path = model_path
        self.voices_path = voices_path
        self._kokoro = None
        self.voices: list[str] = []
        self.description = {"engine": "kokoro", "model": model_path}

    def load(self) -> None:
        from kokoro_onnx import Kokoro

        self._kokoro = Kokoro(self.model_path, self.voices_path)
        self.voices = sorted(self._kokoro.get_voices())

    def synthesize(self, text: str, voice: str, speed: float) -> tuple[np.ndarray, int]:
        assert self._kokoro is not None, "load() first"
        lang = "en-gb" if voice.startswith("b") else "en-us"
        samples, rate = self._kokoro.create(text, voice=voice, speed=speed, lang=lang)
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
