import io
import wave

import numpy as np
from fastapi.testclient import TestClient

from speech_service.app import create_app, decode_wav, encode_wav
from speech_service.engines import FakeSynthesizer, FakeTranscriber


def make_client() -> TestClient:
    app = create_app(FakeTranscriber(), FakeSynthesizer(), "fake_voice", load_in_background=False)
    return TestClient(app)


def wav_bytes(seconds: float, rate: int = 16000, channels: int = 1) -> bytes:
    samples = np.zeros(int(seconds * rate) * channels, dtype="<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(samples.tobytes())
    return buffer.getvalue()


def test_health_reports_ready_and_voices():
    with make_client() as client:
        body = client.get("/health").json()
    assert body["ready"] is True
    assert body["status"] == "ok"
    assert body["tts"]["voices"] == ["fake_voice"]
    assert body["tts"]["default_voice"] == "fake_voice"


def test_stt_resamples_to_16k():
    with make_client() as client:
        response = client.post("/v1/stt", content=wav_bytes(1.5, rate=48000, channels=2),
                               headers={"Content-Type": "audio/wav"})
    assert response.status_code == 200
    assert response.json()["text"] == "fake transcript of 1.50 seconds"
    assert response.json()["timings"]["audio_ms"] == 1500


def test_stt_rejects_non_wav():
    with make_client() as client:
        response = client.post("/v1/stt", content=b"not a wav")
    assert response.status_code == 400
    assert "invalid WAV" in response.json()["error"]


def test_tts_returns_wav():
    with make_client() as client:
        response = client.post("/v1/tts", json={"text": "hello there friend"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(response.content), "rb") as reader:
        assert reader.getframerate() == 24000
        assert reader.getnframes() > 0


def test_tts_rejects_unknown_voice():
    with make_client() as client:
        response = client.post("/v1/tts", json={"text": "hi", "voice": "nope"})
    assert response.status_code == 400
    assert "unknown voice" in response.json()["error"]


def test_wav_round_trip():
    samples = np.linspace(-0.5, 0.5, 16000, dtype=np.float32)
    decoded = decode_wav(encode_wav(samples, 16000))
    assert np.allclose(decoded, samples, atol=1e-3)


def test_chat_audio_transcriber_posts_wav_and_strips_language_prefix(monkeypatch):
    import base64
    import json

    from speech_service import engines

    sent = {}

    class FakeResponse:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return self.body

    def fake_urlopen(request, timeout):
        sent["url"] = request.full_url
        sent["body"] = json.loads(request.data)
        reply = {"choices": [{"message": {"content": "language English<asr_text>What is the capital of Australia?"}}]}
        return FakeResponse(json.dumps(reply).encode())

    monkeypatch.setattr(engines.urllib.request, "urlopen", fake_urlopen)
    transcriber = engines.ChatAudioTranscriber("http://asr:1235/v1/", "qwen3-asr")

    text = transcriber.transcribe(np.zeros(8000, dtype=np.float32), "en")

    assert text == "What is the capital of Australia?"
    assert sent["url"] == "http://asr:1235/v1/chat/completions"
    assert sent["body"]["model"] == "qwen3-asr"
    part = sent["body"]["messages"][0]["content"][0]
    assert part["type"] == "input_audio" and part["input_audio"]["format"] == "wav"
    with wave.open(io.BytesIO(base64.b64decode(part["input_audio"]["data"])), "rb") as reader:
        assert reader.getframerate() == 16000
        assert reader.getnframes() == 8000


def test_chat_audio_transcriber_leaves_plain_transcripts_alone():
    from speech_service.engines import ChatAudioTranscriber

    assert ChatAudioTranscriber.clean("  hello there ") == "hello there"
    assert ChatAudioTranscriber.clean("language None<asr_text>") == ""
