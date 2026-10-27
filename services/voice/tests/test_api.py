import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from voice_service.app import create_app, float_to_pcm16
from voice_service.backends.fake import FakeSTT, FakeTTS


@pytest.fixture
def client():
    with TestClient(create_app(FakeSTT(), FakeTTS(), load_in_background=False)) as c:
        yield c


def tone(seconds: float, rate: int = 16000) -> bytes:
    t = np.arange(int(rate * seconds), dtype=np.float32) / rate
    return float_to_pcm16(0.3 * np.sin(2 * np.pi * 440 * t))


def test_health_ready(client):
    assert client.get("/health").json() == {
        "status": "ok", "ready": True,
        "stt": {"backend": "fake", "device": "cpu (fake)"},
        "tts": {"backend": "fake", "device": "cpu (fake)", "voice": "fake_voice"},
    }


def test_503_while_loading():
    with TestClient(create_app(FakeSTT(load_delay=0.5), FakeTTS())) as c:
        assert c.get("/health").json()["ready"] is False
        r = c.post("/v1/stt", content=tone(0.5))
        assert r.status_code == 503 and "loading" in r.json()["error"]
        for _ in range(50):
            if c.get("/health").json()["ready"]:
                break
            time.sleep(0.05)
        assert c.post("/v1/stt", content=tone(0.5)).status_code == 200


def test_stt(client):
    r = client.post("/v1/stt", content=tone(1.5), headers={"Content-Type": "application/octet-stream"})
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == "hello there"
    assert body["durationMs"] == 1500
    assert body["timings"]["sttMs"] >= 0


def test_stt_silence_is_empty(client):
    assert client.post("/v1/stt", content=bytes(16000)).json()["text"] == ""


@pytest.mark.parametrize("params,content,message", [
    ({"sample_rate": 24000}, tone(0.1), "sample_rate"),
    ({}, b"\x00\x01\x02", "16-bit"),
    ({}, bytes(16000 * 2 * 61), "at most"),
])
def test_stt_rejects_bad_audio(client, params, content, message):
    r = client.post("/v1/stt", params=params, content=content)
    assert r.status_code == 400 and message in r.json()["error"]


def test_tts(client):
    r = client.post("/v1/tts", json={"text": "Hello there, friend."})
    assert r.status_code == 200
    assert r.headers["x-sample-rate"] == "24000"
    samples = np.frombuffer(r.content, dtype="<i2")
    assert samples.size == int(24000 * 0.05 * 3)
    assert np.abs(samples).max() > 1000


@pytest.mark.parametrize("payload", [{"text": "   "}, {"text": "hi", "speed": 5}, {}])
def test_tts_validation(client, payload):
    r = client.post("/v1/tts", json=payload)
    assert r.status_code == 400 and r.json()["error"]


def test_voices(client):
    assert client.get("/v1/voices").json() == {"default": "fake_voice", "voices": ["fake_voice"]}
