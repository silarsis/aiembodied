import json
import time

import pytest
from fastapi.testclient import TestClient

from motion_service.app import create_app
from motion_service.backends.fake import FakeBackend

from vrma_check import assert_valid_vrma


@pytest.fixture
def client():
    with TestClient(create_app(FakeBackend(), load_in_background=False)) as c:
        yield c


def test_health_ready(client):
    assert client.get("/health").json() == {"status": "ok", "backend": "fake", "device": "cpu (fake)", "ready": True}


def test_health_and_503_while_loading():
    with TestClient(create_app(FakeBackend(load_delay=0.5))) as c:
        body = c.get("/health").json()
        assert body["ready"] is False and body["status"] == "ok"
        r = c.post("/v1/motion/clip", json={"prompt": "wave"})
        assert r.status_code == 503 and "loading" in r.json()["error"]
        for _ in range(50):
            if c.get("/health").json()["ready"]:
                break
            time.sleep(0.05)
        assert c.post("/v1/motion/clip", json={"prompt": "wave"}).status_code == 200


def test_clip(client):
    r = client.post("/v1/motion/clip", json={"prompt": "a person waves hello with their right hand", "duration": 2.0,
                                              "steps": 5, "name": "wave-hello"})
    assert r.status_code == 200
    body = r.json()
    assert_valid_vrma(body["vrma"])
    assert body["vrma"]["meta"]["name"] == "wave-hello"
    assert body["vrma"]["meta"]["kind"] == "fake"
    assert len(body["vrma"]["tracks"][0]["keyframes"]) == 60
    assert set(body["timings"]) == {"encodeMs", "generateMs", "retargetMs", "totalMs"}


def test_clip_defaults_name_to_prompt_slug_and_duration_3s(client):
    v = client.post("/v1/motion/clip", json={"prompt": "A person nods their head yes, several times over"}).json()["vrma"]
    assert v["meta"]["name"] == "a-person-nods-their-head-yes-several-tim"
    assert len(v["tracks"][0]["keyframes"]) == 90


@pytest.mark.parametrize("payload", [
    {},
    {"prompt": ""},
    {"prompt": "   "},
    {"prompt": "x", "duration": 0.2},
    {"prompt": "x", "duration": 10.5},
    {"prompt": "x", "steps": 0},
    {"prompt": "x", "steps": 51},  # over the fake backend's max_steps
])
def test_clip_bad_requests_are_400_with_error_body(client, payload):
    r = client.post("/v1/motion/clip", json=payload)
    assert r.status_code == 400
    assert isinstance(r.json()["error"], str) and r.json()["error"]


def _lines(r):
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


def test_stream_chunks_are_continuous(client):
    r = client.post("/v1/motion/stream", json={"prompt": "wave", "duration": 5.0, "name": "wave-hello"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-ndjson")
    lines = _lines(r)
    chunks, done = lines[:-1], lines[-1]
    assert [c["type"] for c in chunks] == ["chunk"] * 3
    assert [c["index"] for c in chunks] == [0, 1, 2]
    assert [c["start"] for c in chunks] == [0.0, 2.0, 4.0]
    assert [c["vrma"]["meta"]["name"] for c in chunks] == ["wave-hello-0", "wave-hello-1", "wave-hello-2"]
    assert [len(c["vrma"]["tracks"][0]["keyframes"]) for c in chunks] == [60, 60, 30]
    for c in chunks:
        assert_valid_vrma(c["vrma"])
        assert c["vrma"]["tracks"][0]["keyframes"][0]["t"] == 0
    assert "encodeMs" in chunks[0]["timings"] and "totalMs" in chunks[1]["timings"]
    assert done == {"type": "done", "chunks": 3, "timings": done["timings"]}
    # hips continue across the chunk boundary (shared floor/origin)
    end0 = chunks[0]["vrma"]["hips"]["position"]["keyframes"][-1]["p"]
    start1 = chunks[1]["vrma"]["hips"]["position"]["keyframes"][0]["p"]
    assert abs(start1[0] - end0[0]) < 0.01 and start1[1] == pytest.approx(end0[1], abs=1e-4)


def test_stream_allows_20s_but_not_more(client):
    assert client.post("/v1/motion/stream", json={"prompt": "x", "duration": 20}).status_code == 200
    assert client.post("/v1/motion/stream", json={"prompt": "x", "duration": 20.5}).status_code == 400


def test_stream_error_mid_way_is_reported_in_band():
    with TestClient(create_app(FakeBackend(fail_after_chunks=1), load_in_background=False)) as c:
        lines = _lines(c.post("/v1/motion/stream", json={"prompt": "x", "duration": 4}))
    assert [l["type"] for l in lines] == ["chunk", "error"]
    assert "fake backend failure" in lines[1]["message"]


def test_backend_load_failure_shows_in_health():
    class Broken(FakeBackend):
        def load(self):
            raise RuntimeError("no weights")

    with TestClient(create_app(Broken(), load_in_background=False)) as c:
        h = c.get("/health").json()
        assert h["ready"] is False and h["status"] == "error" and "no weights" in h["error"]
        r = c.post("/v1/motion/clip", json={"prompt": "x"})
        assert r.status_code == 503 and "no weights" in r.json()["error"]
