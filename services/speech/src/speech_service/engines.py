"""Speech engines. Speech-to-text: an OpenAI-compatible server (Qwen3-ASR on llama-server by
default) or faster-whisper in-process. Text-to-speech: Kokoro (ONNX), or Chatterbox (ONNX) for a
more expressive voice cloned from a reference clip, with Kokoro still serving its own presets.

Engines load lazily in `load()` so the HTTP server can come up first and report readiness.
The fake engines need no models and are used by the tests and `--engines fake`.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import math
import re
from pathlib import Path
import urllib.request
import wave
from typing import Protocol

import numpy as np

STT_SAMPLE_RATE = 16000

log = logging.getLogger("speech_service")

# Stage directions for Chatterbox ("[laugh]", "[sigh]"); other engines would read them aloud.
TAG = re.compile(r"\s*\[[a-z _-]{2,20}\]\s*", re.IGNORECASE)


def strip_tags(text: str) -> str:
    return re.sub(r"\s{2,}", " ", TAG.sub(" ", text)).strip()


class Transcriber(Protocol):
    description: dict

    def load(self) -> None: ...
    def transcribe(self, audio: np.ndarray, language: str | None) -> str: ...


class Synthesizer(Protocol):
    description: dict
    voices: list[str]

    def load(self) -> None: ...
    def synthesize(self, text: str, voice: str, speed: float,
                   exaggeration: float | None = None) -> tuple[np.ndarray, int]: ...


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

    def synthesize(self, text: str, voice: str, speed: float,
                   exaggeration: float | None = None) -> tuple[np.ndarray, int]:
        assert self._kokoro is not None, "load() first"
        text = strip_tags(text) or text
        lang = "en-gb" if voice.startswith("b") else "en-us"
        style = voice
        if self.style_row is not None:
            row = min(self.style_row, 509)
            style = self._kokoro.get_voice_style(voice)[row:row + 1]
        samples, rate = self._kokoro.create(text, voice=style, speed=speed, lang=lang)
        return np.asarray(samples, dtype=np.float32), int(rate)


# Chatterbox ONNX exports. The original (0.5B Llama) has an emotion "exaggeration" dial (0.5 is
# neutral, 0.7+ is more animated); Turbo (350M, one-step decoder) is faster and reads stage
# directions like "[laugh]" and "[sigh]" but has no dial. Both clone a voice from a reference clip,
# so the accent comes from the clip. The generation loop follows the model cards' sample code.
CHATTERBOX_ORIGINAL = "onnx-community/chatterbox-ONNX"
CHATTERBOX_TURBO = "ResembleAI/chatterbox-turbo-ONNX"


class ChatterboxSynthesizer:
    """Chatterbox through ONNX Runtime, so it needs no PyTorch (PyTorch on ROCm is unreliable on
    the Radeon 8060S). Voices are the WAV files in `voices_dir`, named by file stem."""

    SAMPLE_RATE = 24000
    START_SPEECH, STOP_SPEECH, SILENCE = 6561, 6562, 4299
    REFERENCE_SECONDS = 10  # what Chatterbox conditions its decoder on
    PROVIDERS = {"cpu": "CPUExecutionProvider", "dml": "DmlExecutionProvider",
                 "cuda": "CUDAExecutionProvider"}

    def __init__(self, model: str = CHATTERBOX_ORIGINAL, voices_dir: str = "voices", dtype: str = "fp32",
                 exaggeration: float = 0.6, providers: str = "cpu", threads: int = 0,
                 max_new_tokens: int = 1000, repetition_penalty: float = 1.2):
        self.model = model
        self.voices_dir = Path(voices_dir)
        self.dtype = dtype
        self.exaggeration = exaggeration
        self.providers = [self.PROVIDERS.get(p.strip().lower(), p.strip()) for p in providers.split(",") if p.strip()]
        self.threads = threads
        self.max_new_tokens = max_new_tokens
        self.repetition_penalty = repetition_penalty
        self.voices: list[str] = []
        self.variant: str | None = None
        self._sessions: dict = {}
        self._tokenizer = None
        self._conditioning: dict[str, tuple] = {}
        self.description = {"engine": "chatterbox", "model": model, "dtype": dtype,
                            "voices_dir": str(self.voices_dir)}

    def scan_voices(self) -> list[str]:
        self.voices = sorted(p.stem for p in self.voices_dir.glob("*.wav")) if self.voices_dir.is_dir() else []
        return self.voices

    def _graph(self, name: str) -> str:
        suffix = "" if self.dtype == "fp32" else "_quantized" if self.dtype == "q8" else f"_{self.dtype}"
        filename = f"{name}{suffix}.onnx"
        local = Path(self.model)
        if local.is_dir():
            return str(local / "onnx" / filename)
        from huggingface_hub import hf_hub_download

        graph = hf_hub_download(self.model, subfolder="onnx", filename=filename)
        hf_hub_download(self.model, subfolder="onnx", filename=f"{filename}_data")
        return graph

    def load(self) -> None:
        import onnxruntime
        from transformers import AutoTokenizer

        if not self.scan_voices():
            raise RuntimeError(f"no reference voices (*.wav) in {self.voices_dir}; "
                               "make one with python -m speech_service.make_voice")
        options = onnxruntime.SessionOptions()
        if self.threads > 0:
            options.intra_op_num_threads = self.threads
        available = onnxruntime.get_available_providers()
        providers = [p for p in self.providers if p in available] or ["CPUExecutionProvider"]
        for name in ("speech_encoder", "embed_tokens", "language_model", "conditional_decoder"):
            self._sessions[name] = onnxruntime.InferenceSession(self._graph(name), options, providers=providers)
        self._tokenizer = AutoTokenizer.from_pretrained(self.model)
        embed_inputs = {i.name for i in self._sessions["embed_tokens"].get_inputs()}
        self.variant = "original" if "exaggeration" in embed_inputs else "turbo"
        self.description.update(variant=self.variant, providers=providers,
                                exaggeration=self.exaggeration if self.variant == "original" else None)
        self._condition(self.voices[0])  # warm up

    def _condition(self, voice: str) -> tuple:
        """Speech-encoder outputs for a reference clip; computed once per voice."""
        if voice not in self._conditioning:
            import librosa

            audio, _ = librosa.load(str(self.voices_dir / f"{voice}.wav"), sr=self.SAMPLE_RATE,
                                    duration=self.REFERENCE_SECONDS)
            self._conditioning[voice] = tuple(self._sessions["speech_encoder"].run(
                None, {"audio_values": audio[np.newaxis, :].astype(np.float32)}))
        return self._conditioning[voice]

    def _embed(self, ids: np.ndarray, positions: np.ndarray, exaggeration: float) -> np.ndarray:
        inputs = {"input_ids": ids}
        if self.variant == "original":
            inputs.update(position_ids=positions, exaggeration=np.array([exaggeration], dtype=np.float32))
        return self._sessions["embed_tokens"].run(None, inputs)[0]

    def _penalize(self, generated: np.ndarray, scores: np.ndarray) -> np.ndarray:
        score = np.take_along_axis(scores, generated, axis=1)
        score = np.where(score < 0, score * self.repetition_penalty, score / self.repetition_penalty)
        scores = scores.copy()
        np.put_along_axis(scores, generated, score, axis=1)
        return scores

    def synthesize(self, text: str, voice: str, speed: float,
                   exaggeration: float | None = None) -> tuple[np.ndarray, int]:
        """`speed` is ignored: Chatterbox has no rate control (higher exaggeration speeds it up)."""
        assert self.variant is not None, "load() first"
        cond_emb, prompt_token, speaker_embeddings, speaker_features = self._condition(voice)
        exaggeration = self.exaggeration if exaggeration is None else exaggeration
        language_model = self._sessions["language_model"]

        ids = self._tokenizer(text, return_tensors="np")["input_ids"].astype(np.int64)
        text_positions = np.where(ids >= self.START_SPEECH, 0, np.arange(ids.shape[1])[np.newaxis, :] - 1)
        embeds = np.concatenate((cond_emb, self._embed(ids, text_positions.astype(np.int64), exaggeration)), axis=1)

        seq_len = embeds.shape[1]
        past = {}
        for spec in language_model.get_inputs():
            if "past_key_values" in spec.name:
                heads = spec.shape[1] if isinstance(spec.shape[1], int) else 16
                head_dim = spec.shape[3] if isinstance(spec.shape[3], int) else 64
                dtype = np.float16 if spec.type == "tensor(float16)" else np.float32
                past[spec.name] = np.zeros([1, heads, 0, head_dim], dtype=dtype)
        takes_positions = any(spec.name == "position_ids" for spec in language_model.get_inputs())
        attention_mask = np.ones((1, seq_len), dtype=np.int64)
        positions = np.arange(seq_len, dtype=np.int64)[np.newaxis, :]
        generated = np.array([[self.START_SPEECH]], dtype=np.int64)

        for step in range(self.max_new_tokens):
            inputs = {"inputs_embeds": embeds, "attention_mask": attention_mask, **past}
            if takes_positions:
                inputs["position_ids"] = positions
            logits, *present = language_model.run(None, inputs)
            scores = self._penalize(generated, logits[:, -1, :])
            token = np.argmax(scores, axis=-1, keepdims=True).astype(np.int64)
            if int(token[0, 0]) == self.STOP_SPEECH:
                break
            generated = np.concatenate((generated, token), axis=1)
            embeds = self._embed(token, np.array([[step + 1]], dtype=np.int64), exaggeration)
            attention_mask = np.concatenate((attention_mask, np.ones((1, 1), dtype=np.int64)), axis=1)
            positions = positions[:, -1:] + 1
            past = dict(zip(past, present))
        else:
            log.warning("chatterbox hit %d tokens without finishing: %r", self.max_new_tokens, text[:80])

        tokens = [prompt_token, generated[:, 1:]]
        if self.variant == "turbo":
            tokens.append(np.full((1, 3), self.SILENCE, dtype=np.int64))
        wav = self._sessions["conditional_decoder"].run(None, {
            "speech_tokens": np.concatenate(tokens, axis=1),
            "speaker_embeddings": speaker_embeddings,
            "speaker_features": speaker_features,
        })[0]
        return np.asarray(wav, dtype=np.float32).reshape(-1), self.SAMPLE_RATE


class RoutingSynthesizer:
    """Chatterbox for its reference voices, Kokoro for its presets. If Chatterbox fails to load,
    Kokoro speaks its voices instead (in `fallback_voice`), so the avatar is never mute."""

    def __init__(self, primary: ChatterboxSynthesizer, fallback: KokoroSynthesizer, fallback_voice: str):
        self.primary = primary
        self.fallback = fallback
        self.fallback_voice = fallback_voice
        self.primary_error: str | None = None
        self.voices: list[str] = []
        self.description: dict = {}

    def load(self) -> None:
        self.fallback.load()
        try:
            self.primary.load()
        except Exception as error:  # noqa: BLE001 - reported through /health
            self.primary_error = f"{type(error).__name__}: {error}"
            log.exception("chatterbox failed to load; speaking with Kokoro %s", self.fallback_voice)
            self.primary.scan_voices()
        self.voices = sorted(set(self.primary.voices) | set(self.fallback.voices))
        self.description = {
            **(self.fallback.description if self.primary_error else self.primary.description),
            "engine": "kokoro (chatterbox failed)" if self.primary_error else "chatterbox",
            "fallback": {**self.fallback.description, "voice": self.fallback_voice},
            "chatterbox_error": self.primary_error,
        }

    def synthesize(self, text: str, voice: str, speed: float,
                   exaggeration: float | None = None) -> tuple[np.ndarray, int]:
        if voice in self.primary.voices:
            if not self.primary_error:
                return self.primary.synthesize(text, voice, speed, exaggeration)
            voice = self.fallback_voice
        return self.fallback.synthesize(text, voice, speed, exaggeration)


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

    def synthesize(self, text: str, voice: str, speed: float,
                   exaggeration: float | None = None) -> tuple[np.ndarray, int]:
        """A 220 Hz tone, 60 ms per word, so lip-sync and playback can be wired without models."""
        rate = 24000
        seconds = max(0.2, 0.06 * len(text.split()) / max(speed, 0.1))
        t = np.arange(int(rate * seconds), dtype=np.float32) / rate
        return (0.2 * np.sin(2 * math.pi * 220 * t)).astype(np.float32), rate
