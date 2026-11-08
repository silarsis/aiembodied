"""Text-to-speech engines beside Kokoro: Kitten TTS (ONNX) and Piper, with model downloads.

Kokoro stays the default engine (the synthesizer the service starts with). Kitten and Piper
models are downloaded on request into one folder (TTS_MODELS_DIR, default
~/.cache/aiembodied/tts-models) and loaded on first use:

    <root>/kitten/<model>/config.json, <model_file>, <voices>.npz
    <root>/piper/<voice>.onnx, <voice>.onnx.json

Kitten runs its ONNX graph directly with onnxruntime and espeak (both already installed with
kokoro-onnx); the kittenml package would pull in torch and transformers for models we don't use.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import numpy as np

log = logging.getLogger("speech_service.tts")

HF_BASE = "https://huggingface.co"


class TtsError(Exception):
    """A request the engines can't serve; `status` is the HTTP status to answer with."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class KittenModel:
    id: str
    repo: str
    label: str
    size_mb: int


KITTEN_MODELS = [
    KittenModel("mini-0.8", "KittenML/kitten-tts-mini-0.8", "Kitten mini 0.8", 80),
    KittenModel("nano-0.8", "KittenML/kitten-tts-nano-0.8", "Kitten nano 0.8", 25),
]
# The ONNX models' eight voices, by the names config.json's voice_aliases give them.
KITTEN_VOICES = ["Rosie", "Bella", "Luna", "Kiki", "Jasper", "Bruno", "Hugo", "Leo"]
KITTEN_DEFAULT_VOICE = "Rosie"
KITTEN_SAMPLE_RATE = 24000

# A few good English Piper voices; any other <voice>.onnx in the folder is listed too.
PIPER_VOICES = [
    "en_GB-alba-medium",
    "en_GB-jenny_dioco-medium",
    "en_GB-cori-high",
    "en_GB-northern_english_male-medium",
    "en_GB-southern_english_female-low",
    "en_US-lessac-high",
    "en_US-amy-medium",
    "en_US-ryan-high",
]
PIPER_VOICE_ID = re.compile(r"^([a-z]{2,3})_([A-Z]{2})-([A-Za-z0-9_]+)-(x_low|low|medium|high)$")


def piper_files(voice: str) -> tuple[str, str]:
    """The Hugging Face paths of a Piper voice (rhasspy/piper-voices), e.g. en/en_GB/alba/medium/..."""
    match = PIPER_VOICE_ID.match(voice)
    if not match:
        raise TtsError(400, f"not a Piper voice name: {voice!r} (like en_GB-alba-medium)")
    family, region, name, quality = match.groups()
    folder = f"{family}/{family}_{region}/{name}/{quality}"
    return f"{folder}/{voice}.onnx", f"{folder}/{voice}.onnx.json"


def trim_trailing_silence(samples: np.ndarray, rate: int, threshold: float = 0.004, keep_s: float = 0.08) -> np.ndarray:
    """Drop the quiet tail some engines leave (Kitten's runs up to a second), keeping a short fade."""
    if len(samples) == 0:
        return samples
    frame = max(1, int(rate * 0.01))
    loud = np.flatnonzero(np.abs(samples) > threshold)
    if len(loud) == 0:
        return samples
    end = min(len(samples), loud[-1] + frame + int(rate * keep_s))
    return samples[:end]


# --- downloads -------------------------------------------------------------------------------


@dataclass
class Download:
    status: str = "downloading"  # downloading | done | error
    received: int = 0
    total: int = 0
    error: Optional[str] = None

    def view(self) -> dict:
        return {"status": self.status, "received": self.received, "total": self.total, "error": self.error}


Opener = Callable[[urllib.request.Request], object]


def _fetch(url: str, target: Path, progress: Callable[[int, int], None], opener: Opener, token: str | None) -> None:
    """Download `url` to `target`, resuming a partial `.part` file, then move it into place."""
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": "aiembodied-speech-service"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if have:
        headers["Range"] = f"bytes={have}-"
    response = opener(urllib.request.Request(url, headers=headers))
    with response:  # type: ignore[attr-defined]
        status = getattr(response, "status", 200)
        if have and status != 206:
            have = 0  # The server sent the whole file again.
        length = int(response.headers.get("Content-Length") or 0)  # type: ignore[attr-defined]
        total = have + length if length else 0
        progress(have, total)
        with open(part, "ab" if have else "wb") as out:
            while True:
                chunk = response.read(1 << 20)  # type: ignore[attr-defined]
                if not chunk:
                    break
                out.write(chunk)
                have += len(chunk)
                progress(have, total)
    os.replace(part, target)


# --- engines ---------------------------------------------------------------------------------


class _Espeak:
    """espeak-ng from espeakng_loader, set up once for phonemizer (as kokoro-onnx does)."""

    _lock = threading.Lock()
    _ready = False

    @classmethod
    def backend(cls, language: str):
        with cls._lock:
            if not cls._ready:
                import espeakng_loader
                from phonemizer.backend.espeak.wrapper import EspeakWrapper

                EspeakWrapper.set_library(espeakng_loader.get_library_path())
                os.environ["ESPEAK_DATA_PATH"] = espeakng_loader.get_data_path()
                cls._ready = True
        import phonemizer

        return phonemizer.backend.EspeakBackend(language=language, preserve_punctuation=True, with_stress=True)


# Kitten's symbol table (its TextCleaner): pad, punctuation, letters, IPA.
_KITTEN_SYMBOLS = (
    ["$"]
    + list(';:,.!?¡¿—…"«»"" ')
    + list("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
    + list("ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ")
)
_KITTEN_INDEX = {symbol: index for index, symbol in enumerate(_KITTEN_SYMBOLS)}


def kitten_tokens(phonemes: str) -> list[int]:
    """Phonemes to Kitten's input ids: words and punctuation spaced apart, then start/end marks."""
    spaced = " ".join(re.findall(r"\w+|[^\w\s]", phonemes))
    ids = [_KITTEN_INDEX[char] for char in spaced if char in _KITTEN_INDEX]
    return [0, *ids, 10, 0]


def kitten_chunks(text: str, max_len: int = 400) -> list[str]:
    """Sentences, long ones split at word boundaries, each ending in punctuation (as Kitten does)."""
    pieces = [piece.strip() for piece in re.split(r"(?<=[.!?])\s+", text.strip()) if piece.strip()]
    chunks: list[str] = []
    for piece in pieces:
        words, current = piece.split(), ""
        for word in words:
            if current and len(current) + len(word) + 1 > max_len:
                chunks.append(current)
                current = word
            else:
                current = f"{current} {word}" if current else word
        if current:
            chunks.append(current)
    return [chunk if chunk[-1] in ".!?,;:" else chunk + "," for chunk in chunks]


class KittenSynthesizer:
    """One Kitten ONNX model (KittenTTS 0.8 'ONNX1'/'ONNX2' repositories)."""

    def __init__(self, folder: Path):
        import onnxruntime as ort

        config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
        self.session = ort.InferenceSession(str(folder / config["model_file"]), providers=["CPUExecutionProvider"])
        self.voices = dict(np.load(folder / config["voices"]))
        self.aliases: dict[str, str] = config.get("voice_aliases", {})
        self.speed_priors: dict[str, float] = config.get("speed_priors", {})
        self.phonemizer = _Espeak.backend("en-us")
        self.lock = threading.Lock()

    def voice_names(self) -> list[str]:
        names = [alias for alias, target in self.aliases.items() if target in self.voices]
        return names or sorted(self.voices)

    def synthesize(self, text: str, voice: str, speed: float) -> tuple[np.ndarray, int]:
        key = self.aliases.get(voice, voice)
        if key not in self.voices:
            raise TtsError(400, f"unknown voice {voice!r}")
        speed = speed * float(self.speed_priors.get(key, 1.0))
        styles = self.voices[key]
        parts = []
        with self.lock:
            for chunk in kitten_chunks(text):
                phonemes = self.phonemizer.phonemize([chunk])[0]
                ids = np.array([kitten_tokens(phonemes)], dtype=np.int64)
                row = min(len(chunk), styles.shape[0] - 1)
                audio = self.session.run(None, {
                    "input_ids": ids,
                    "style": styles[row:row + 1],
                    "speed": np.array([speed], dtype=np.float32),
                })[0]
                # Kitten's own trim of the end-of-utterance noise.
                parts.append(np.asarray(audio, dtype=np.float32).reshape(-1)[:-5000])
        samples = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        return trim_trailing_silence(samples, KITTEN_SAMPLE_RATE), KITTEN_SAMPLE_RATE


class PiperSynthesizer:
    """One Piper voice (piper-tts)."""

    def __init__(self, model_path: Path):
        from piper import PiperVoice

        self.voice = PiperVoice.load(str(model_path))
        self.lock = threading.Lock()

    def synthesize(self, text: str, speed: float) -> tuple[np.ndarray, int]:
        from piper import SynthesisConfig

        config = SynthesisConfig(length_scale=1.0 / max(speed, 0.1))
        with self.lock:
            chunks = list(self.voice.synthesize(text, syn_config=config))
        if not chunks:
            return np.zeros(0, dtype=np.float32), 22050
        samples = np.concatenate([np.asarray(chunk.audio_float_array, dtype=np.float32) for chunk in chunks])
        return trim_trailing_silence(samples, chunks[0].sample_rate), int(chunks[0].sample_rate)


def _importable(module: str) -> Optional[str]:
    """None when `module` imports, else why not."""
    try:
        __import__(module)
        return None
    except Exception as error:  # noqa: BLE001 - reported to the app
        return f"{type(error).__name__}: {error}"


@dataclass
class TtsModels:
    """Downloadable models for Kitten and Piper, and the loaded ones."""

    root: Path
    opener: Opener = field(default=urllib.request.urlopen)
    token: Optional[str] = None
    kitten_factory: Callable[[Path], object] = KittenSynthesizer
    piper_factory: Callable[[Path], object] = PiperSynthesizer
    _downloads: dict = field(default_factory=dict)
    _loaded: dict = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def kitten_dir(self, model: str) -> Path:
        return self.root / "kitten" / model

    def piper_path(self, voice: str) -> Path:
        return self.root / "piper" / f"{voice}.onnx"

    def kitten_installed(self, model: str) -> bool:
        folder = self.kitten_dir(model)
        try:
            config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
            return (folder / config["model_file"]).exists() and (folder / config["voices"]).exists()
        except (OSError, KeyError, ValueError):
            return False

    def piper_installed(self, voice: str) -> bool:
        path = self.piper_path(voice)
        return path.exists() and path.with_name(path.name + ".json").exists()

    def installed_piper_voices(self) -> list[str]:
        folder = self.root / "piper"
        if not folder.is_dir():
            return []
        return sorted(p.name[: -len(".onnx")] for p in folder.glob("*.onnx") if self.piper_installed(p.name[: -len(".onnx")]))

    # -- listing --

    def engines(self) -> list[dict]:
        kitten_problem = _importable("onnxruntime") or _importable("phonemizer") or _importable("espeakng_loader")
        piper_problem = _importable("piper")
        kitten_models = []
        for model in KITTEN_MODELS:
            installed = self.kitten_installed(model.id)
            loaded = self._loaded.get(("kitten", model.id))
            kitten_models.append({
                "id": model.id,
                "label": model.label,
                "size_mb": model.size_mb,
                "installed": installed,
                "voices": loaded.voice_names() if loaded else list(KITTEN_VOICES),
                "default_voice": KITTEN_DEFAULT_VOICE,
                "download": self._download_view("kitten", model.id),
            })
        piper_ids = list(dict.fromkeys([*PIPER_VOICES, *self.installed_piper_voices()]))
        piper_models = [{
            "id": voice,
            "label": voice,
            "installed": self.piper_installed(voice),
            "voices": [voice],
            "default_voice": voice,
            "download": self._download_view("piper", voice),
        } for voice in piper_ids]
        return [
            {"id": "kitten", "label": "Kitten TTS", "available": kitten_problem is None, "error": kitten_problem,
             "models": kitten_models},
            {"id": "piper", "label": "Piper", "available": piper_problem is None, "error": piper_problem,
             "models": piper_models},
        ]

    def _download_view(self, engine: str, model: str) -> Optional[dict]:
        download = self._downloads.get((engine, model))
        return download.view() if download else None

    # -- downloads --

    def start_download(self, engine: str, model: str, background: bool = True) -> dict:
        if engine == "kitten":
            if not any(entry.id == model for entry in KITTEN_MODELS):
                raise TtsError(400, f"unknown Kitten model {model!r}")
        elif engine == "piper":
            piper_files(model)  # Validates the name.
        else:
            raise TtsError(400, f"{engine!r} has no downloads")
        key = (engine, model)
        with self._lock:
            current = self._downloads.get(key)
            if current and current.status == "downloading":
                return current.view()
            download = Download()
            self._downloads[key] = download
        work = lambda: self._run_download(engine, model, download)  # noqa: E731
        if background:
            threading.Thread(target=work, name=f"tts-download-{engine}-{model}", daemon=True).start()
        else:
            work()
        return download.view()

    def _run_download(self, engine: str, model: str, download: Download) -> None:
        done_bytes = {"before": 0}

        def progress(received: int, total: int) -> None:
            download.received = done_bytes["before"] + received
            if total:
                download.total = max(download.total, done_bytes["before"] + total)

        try:
            if engine == "kitten":
                repo = next(entry.repo for entry in KITTEN_MODELS if entry.id == model)
                folder = self.kitten_dir(model)
                config_path = folder / "config.json"
                _fetch(f"{HF_BASE}/{repo}/resolve/main/config.json", config_path, lambda *_: None, self.opener, self.token)
                config = json.loads(config_path.read_text(encoding="utf-8"))
                files = [config["model_file"], config["voices"]]
                for name in files:
                    _fetch(f"{HF_BASE}/{repo}/resolve/main/{name}", folder / name, progress, self.opener, self.token)
                    done_bytes["before"] = download.received
            else:
                onnx, meta = piper_files(model)
                target = self.piper_path(model)
                _fetch(f"{HF_BASE}/rhasspy/piper-voices/resolve/main/{meta}", target.with_name(target.name + ".json"),
                       lambda *_: None, self.opener, self.token)
                _fetch(f"{HF_BASE}/rhasspy/piper-voices/resolve/main/{onnx}", target, progress, self.opener, self.token)
            download.total = max(download.total, download.received)
            download.status = "done"
            log.info("downloaded %s %s (%d bytes)", engine, model, download.received)
        except Exception as error:  # noqa: BLE001 - reported through the engine list
            download.status = "error"
            download.error = f"{type(error).__name__}: {error}"
            log.warning("download of %s %s failed: %s", engine, model, download.error)

    # -- synthesis --

    def synthesize(self, engine: str, model: Optional[str], voice: Optional[str], text: str,
                   speed: float) -> tuple[np.ndarray, int]:
        if engine == "kitten":
            model = model or KITTEN_MODELS[0].id
            if not self.kitten_installed(model):
                raise TtsError(409, f"Kitten model {model} is not downloaded")
            synth = self._load(("kitten", model), lambda: self.kitten_factory(self.kitten_dir(model)))
            return synth.synthesize(text, voice or KITTEN_DEFAULT_VOICE, speed)  # type: ignore[attr-defined]
        if engine == "piper":
            name = voice or model
            if not name:
                raise TtsError(400, "pick a Piper voice")
            if not self.piper_installed(name):
                raise TtsError(409, f"Piper voice {name} is not downloaded")
            synth = self._load(("piper", name), lambda: self.piper_factory(self.piper_path(name)))
            return synth.synthesize(text, speed)  # type: ignore[attr-defined]
        raise TtsError(400, f"unknown engine {engine!r}")

    def _load(self, key: tuple[str, str], build: Callable[[], object]):
        with self._lock:
            loaded = self._loaded.get(key)
        if loaded is None:
            log.info("loading %s %s", *key)
            loaded = build()
            with self._lock:
                # Piper voices are small; keep only one Kitten model in memory at a time.
                if key[0] == "kitten":
                    for other in [k for k in self._loaded if k[0] == "kitten"]:
                        del self._loaded[other]
                self._loaded[key] = loaded
        return loaded


def default_models_dir() -> Path:
    configured = os.environ.get("TTS_MODELS_DIR")
    return Path(configured) if configured else Path.home() / ".cache" / "aiembodied" / "tts-models"
