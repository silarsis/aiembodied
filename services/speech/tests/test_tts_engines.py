import io
import json
import shutil
import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from speech_service.app import create_app
from speech_service.engines import FakeSynthesizer, FakeTranscriber
from speech_service.tts_engines import (TtsError, TtsModels, kitten_chunks, kitten_tokens, piper_files,
                                        trim_trailing_silence)

PIPER_SAMPLE = Path("/mnt/user-data/uploads/aiembodied/experiments/tts-compare/models/piper")


class FakeResponse:
    def __init__(self, data: bytes, status: int = 200):
        self._data = io.BytesIO(data)
        self.status = status
        self.headers = {"Content-Length": str(len(data))}

    def read(self, size=-1):
        return self._data.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def hub(files: dict[str, bytes], seen: list[str]):
    def opener(request):
        seen.append(request.full_url)
        for suffix, data in files.items():
            if request.full_url.endswith(suffix):
                return FakeResponse(data)
        raise OSError(f"404 {request.full_url}")
    return opener


class FakeVoice:
    def __init__(self, path):
        self.path = path

    def voice_names(self):
        return ["Rosie", "Bella"]

    def synthesize(self, text, voice_or_speed, speed=None):
        return np.full(2400, 0.1, dtype=np.float32), 24000


def kitten_files():
    config = {"type": "ONNX2", "model_file": "kitten_tts_mini_v0_8.onnx", "voices": "voices.npz",
              "voice_aliases": {"Rosie": "expr-voice-3-f"}}
    return {"/config.json": json.dumps(config).encode(), "/kitten_tts_mini_v0_8.onnx": b"m" * 3000,
            "/voices.npz": b"v" * 1000}


def client_for(models: TtsModels) -> TestClient:
    return TestClient(create_app(FakeTranscriber(), FakeSynthesizer(), "fake_voice", load_in_background=False,
                                 models=models))


def test_engines_list_kokoro_kitten_and_piper(tmp_path):
    with client_for(TtsModels(tmp_path)) as client:
        engines = {engine["id"]: engine for engine in client.get("/v1/tts/engines").json()["engines"]}
    assert list(engines) == ["kokoro", "kitten", "piper"]
    assert engines["kokoro"]["models"][0]["voices"] == ["fake_voice"]
    kitten = {model["id"]: model for model in engines["kitten"]["models"]}
    assert kitten["mini-0.8"]["installed"] is False
    assert kitten["mini-0.8"]["default_voice"] == "Rosie"
    assert "en_GB-alba-medium" in [model["id"] for model in engines["piper"]["models"]]


def test_kitten_download_then_speak(tmp_path):
    seen: list[str] = []
    models = TtsModels(tmp_path, opener=hub(kitten_files(), seen), kitten_factory=FakeVoice)
    view = models.start_download("kitten", "mini-0.8", background=False)
    assert view["status"] == "done"  # Run in the foreground here.
    assert seen[0] == "https://huggingface.co/KittenML/kitten-tts-mini-0.8/resolve/main/config.json"
    assert models.kitten_installed("mini-0.8")
    with client_for(models) as client:
        listed = client.get("/v1/tts/engines").json()["engines"][1]["models"][0]
        assert listed["installed"] is True
        assert listed["download"] == {"status": "done", "received": 4000, "total": 4000, "error": None}
        response = client.post("/v1/tts", json={"text": "hi", "engine": "kitten", "model": "mini-0.8", "voice": "Rosie"})
    assert response.status_code == 200
    with wave.open(io.BytesIO(response.content)) as reader:
        assert reader.getframerate() == 24000


def test_piper_download_paths_and_errors(tmp_path):
    seen: list[str] = []
    models = TtsModels(tmp_path, opener=hub({".onnx.json": b"{}", ".onnx": b"x" * 10}, seen), piper_factory=FakeVoice)
    models.start_download("piper", "en_GB-northern_english_male-medium", background=False)
    assert seen == [
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx.json",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx",
    ]
    assert models.installed_piper_voices() == ["en_GB-northern_english_male-medium"]
    failed = TtsModels(tmp_path / "other", opener=hub({}, []))
    failed.start_download("piper", "en_GB-alba-medium", background=False)
    assert failed.engines()[1]["models"][0]["download"]["status"] == "error"
    with pytest.raises(TtsError):
        piper_files("../../etc/passwd")
    with client_for(models) as client:
        assert client.post("/v1/tts/download", json={"engine": "kokoro", "model": "x"}).status_code == 400
        missing = client.post("/v1/tts", json={"text": "hi", "engine": "piper", "voice": "en_GB-alba-medium"})
        assert missing.status_code == 409


def test_resumes_a_partial_download(tmp_path):
    target = tmp_path / "piper" / "en_GB-alba-medium.onnx"
    target.parent.mkdir(parents=True)
    target.with_name(target.name + ".part").write_bytes(b"12345")
    ranges = []

    def opener(request):
        ranges.append(request.headers.get("Range"))
        if request.full_url.endswith(".json"):
            return FakeResponse(b"{}")
        return FakeResponse(b"67890", status=206)

    TtsModels(tmp_path, opener=opener).start_download("piper", "en_GB-alba-medium", background=False)
    assert target.read_bytes() == b"1234567890"
    assert ranges == [None, "bytes=5-"]


def test_trailing_silence_is_trimmed():
    rate = 24000
    audio = np.concatenate([np.full(rate // 2, 0.2, dtype=np.float32), np.zeros(rate, dtype=np.float32)])
    trimmed = trim_trailing_silence(audio, rate)
    assert rate // 2 < len(trimmed) < rate // 2 + int(rate * 0.1)


def test_kitten_text_helpers():
    assert kitten_tokens("hɛlˈoʊ, wˈɜːld")[0] == 0
    assert kitten_tokens("hɛlˈoʊ")[-2:] == [10, 0]
    assert kitten_chunks("Hello there. How are you") == ["Hello there.", "How are you,"]


@pytest.mark.skipif(not (PIPER_SAMPLE / "en_GB-alba-medium.onnx").exists(), reason="no Piper voice file here")
def test_real_piper_voice(tmp_path):
    folder = tmp_path / "piper"
    folder.mkdir()
    for name in ("en_GB-alba-medium.onnx", "en_GB-alba-medium.onnx.json"):
        shutil.copy(PIPER_SAMPLE / name, folder / name)
    with client_for(TtsModels(tmp_path)) as client:
        response = client.post("/v1/tts", json={"text": "Good night, mate.", "engine": "piper", "voice": "en_GB-alba-medium"})
    assert response.status_code == 200, response.text
    with wave.open(io.BytesIO(response.content)) as reader:
        assert reader.getframerate() == 22050
        assert 0.5 < reader.getnframes() / 22050 < 3
