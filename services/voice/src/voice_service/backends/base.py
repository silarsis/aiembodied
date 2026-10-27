"""Backend interfaces. Calls are serialized per backend by the app."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class Transcript:
    text: str
    language: Optional[str] = None


@dataclass
class Synthesis:
    """Mono float32 samples in [-1, 1]."""

    samples: np.ndarray
    sample_rate: int


class SpeechToText:
    name = "base"
    sample_rate = 16000

    def __init__(self):
        self.device_label = "unloaded"

    def load(self) -> None:
        raise NotImplementedError

    def transcribe(self, audio: np.ndarray) -> Transcript:
        """`audio`: mono float32 at `sample_rate`."""
        raise NotImplementedError


class TextToSpeech:
    name = "base"

    def __init__(self, default_voice: str = ""):
        self.default_voice = default_voice
        self.device_label = "unloaded"

    def load(self) -> None:
        raise NotImplementedError

    def voices(self) -> list[str]:
        return []

    def synthesize(self, text: str, voice: Optional[str] = None, speed: float = 1.0) -> Synthesis:
        raise NotImplementedError
