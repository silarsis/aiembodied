"""faster-whisper for speech-to-text and Kokoro (kokoro-onnx) for text-to-speech, both on the CPU.

On the Z13 the GPU's unified memory goes to Qwen Next Flash (~92 GB) and ARDY, and both of these
are faster than real time on the Ryzen cores: whisper small.en int8 transcribes a few seconds of
speech in well under a second, and Kokoro speaks a sentence in ~0.2-0.5 s.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from .base import SpeechToText, Synthesis, TextToSpeech, Transcript


class WhisperSTT(SpeechToText):
    name = "faster-whisper"

    def __init__(self, model: str = "small.en", device: str = "cpu", compute_type: str = "int8",
                 language: Optional[str] = "en"):
        super().__init__()
        self.model_name = model
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self._model = None

    def load(self) -> None:
        from faster_whisper import WhisperModel

        self._model = WhisperModel(self.model_name, device=self.device, compute_type=self.compute_type)
        self.device_label = f"{self.model_name} on {self.device} ({self.compute_type})"
        # The first call pays for lazy initialisation; do it now instead of on the first utterance.
        self.transcribe(np.zeros(self.sample_rate // 2, dtype=np.float32))

    def transcribe(self, audio: np.ndarray) -> Transcript:
        segments, info = self._model.transcribe(
            audio, language=self.language, beam_size=1, vad_filter=False, condition_on_previous_text=False,
        )
        text = "".join(segment.text for segment in segments).strip()
        return Transcript(text=text, language=getattr(info, "language", self.language))


class KokoroTTS(TextToSpeech):
    name = "kokoro"

    def __init__(self, model_path: str, voices_path: str, default_voice: str = "af_heart"):
        super().__init__(default_voice)
        self.model_path = model_path
        self.voices_path = voices_path
        self._kokoro = None

    def load(self) -> None:
        from kokoro_onnx import Kokoro

        self._kokoro = Kokoro(self.model_path, self.voices_path)
        self.device_label = "kokoro-v1.0 on cpu"
        self.synthesize("Ready.")

    def voices(self) -> list[str]:
        return sorted(self._kokoro.get_voices()) if self._kokoro else []

    def synthesize(self, text: str, voice: Optional[str] = None, speed: float = 1.0) -> Synthesis:
        samples, sample_rate = self._kokoro.create(text, voice=voice or self.default_voice, speed=speed,
                                                   lang="en-us")
        return Synthesis(np.asarray(samples, dtype=np.float32), int(sample_rate))
