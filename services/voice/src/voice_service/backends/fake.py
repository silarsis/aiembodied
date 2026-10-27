"""Deterministic stand-ins for tests and wiring checks: no models, no downloads."""

from __future__ import annotations

import time
from typing import Optional

import numpy as np

from .base import SpeechToText, Synthesis, TextToSpeech, Transcript


class FakeSTT(SpeechToText):
    name = "fake"

    def __init__(self, text: str = "hello there", load_delay: float = 0.0):
        super().__init__()
        self.text = text
        self.load_delay = load_delay

    def load(self) -> None:
        time.sleep(self.load_delay)
        self.device_label = "cpu (fake)"

    def transcribe(self, audio: np.ndarray) -> Transcript:
        # Silence transcribes to nothing, like whisper on an empty clip.
        if audio.size == 0 or float(np.abs(audio).max()) < 1e-3:
            return Transcript(text="", language="en")
        return Transcript(text=self.text, language="en")


class FakeTTS(TextToSpeech):
    name = "fake"
    sample_rate = 24000

    def __init__(self):
        super().__init__("fake_voice")

    def load(self) -> None:
        self.device_label = "cpu (fake)"

    def voices(self) -> list[str]:
        return ["fake_voice"]

    def synthesize(self, text: str, voice: Optional[str] = None, speed: float = 1.0) -> Synthesis:
        # 50 ms of a 220 Hz tone per word, so lengths are predictable in tests.
        seconds = 0.05 * max(1, len(text.split())) / max(speed, 0.1)
        t = np.arange(int(self.sample_rate * seconds), dtype=np.float32) / self.sample_rate
        return Synthesis((0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), self.sample_rate)
