from datetime import datetime, timedelta, timezone
from uuid import uuid4

T0 = datetime(2026, 11, 3, 8, 0, tzinfo=timezone.utc)


def at(seconds):
    return (T0 + timedelta(seconds=seconds)).isoformat()


def message(session_id, role, content, seconds, **extra):
    return {"id": str(uuid4()), "session_id": str(session_id), "role": role, "content": content,
            "created_at": at(seconds), **extra}


def post(client, *messages):
    assert client.post("/v1/messages", json={"messages": list(messages)}).status_code == 200


def test_turns_are_embedded_and_health_names_the_embedder(client):
    post(client, message(uuid4(), "user", "the basil is flowering", 0))
    health = client.get("/health").json()
    assert health["embedder"] == "fake-hash-384"
    results = client.get("/v1/search", params={"q": "basil flowering"}).json()["results"]
    assert results[0]["matched"] == ["text", "vector"]
    assert results[0]["similarity"] > 0.5


def test_hybrid_search_matches_any_word_of_a_spoken_question(client):
    session = uuid4()
    post(
        client,
        message(session, "user", "I moved the tomatoes into the greenhouse", 0),
        message(session, "assistant", "Good idea, they like the warmth.", 1),
        message(session, "user", "what's a good podcast about history", 60),
    )
    results = client.get("/v1/search", params={"q": "where did I put the tomatoes again?"}).json()["results"]
    assert "greenhouse" in results[0]["text"]


def test_hybrid_search_filters_and_excludes(client):
    session = uuid4()
    post(client, message(session, "user", "garden plans for spring", 0), message(session, "user", "garden plans for autumn", 86400 * 40))
    later = client.get("/v1/search", params={"q": "garden plans", "from": at(86400)}).json()["results"]
    assert [r["text"] for r in later] == ["User: garden plans for autumn"]
    skip = client.get("/v1/search", params={"q": "garden plans", "exclude": [later[0]["id"]]}).json()["results"]
    assert [r["text"] for r in skip] == ["User: garden plans for spring"]


def test_recent_wins_a_tie_but_an_old_strong_match_still_wins(client):
    old, new = uuid4(), uuid4()
    post(client, message(old, "user", "the dentist appointment is on friday", 0))
    post(client, message(new, "user", "the dentist", 86400 * 300))
    results = client.get("/v1/search", params={"q": "dentist appointment friday"}).json()["results"]
    assert results[0]["text"] == "User: the dentist appointment is on friday"


def test_timeline_lists_sessions_and_their_turns_in_a_period(client):
    monday, tuesday = uuid4(), uuid4()
    client.put(f"/v1/sessions/{monday}", json={"started_at": at(0), "agent": "Echo"})
    post(client, message(monday, "user", "monday chat", 1), message(monday, "assistant", "hello monday", 2))
    post(client, message(tuesday, "user", "tuesday chat", 86400))
    body = client.get("/v1/timeline", params={"from": at(0), "to": at(86400)}).json()
    assert [s["session_id"] for s in body["sessions"]] == [str(monday)]
    assert body["sessions"][0]["agent"] == "Echo"
    assert body["sessions"][0]["turns"][0]["text"] == "User: monday chat\nEcho: hello monday"
    assert client.get("/v1/timeline", params={"from": at(10), "to": at(0)}).status_code == 400


def test_memory_detail_gives_the_turn_verbatim_with_its_neighbours(client):
    session = uuid4()
    post(
        client,
        message(session, "user", "first", 0),
        message(session, "user", "second about the car", 10),
        message(session, "tool", "full page text", 11, tool={"name": "web_search"}),
        message(session, "assistant", "the car answer", 12),
        message(session, "user", "third", 20),
        message(session, "user", "fourth", 30),
    )
    hit = client.get("/v1/search", params={"q": "car"}).json()["results"][0]
    detail = client.get(f"/v1/memories/{hit['id']}", params={"around": 1}).json()
    assert [m["content"] for m in detail["messages"]] == ["first", "second about the car", "full page text", "the car answer", "third"]
    alone = client.get(f"/v1/memories/{hit['id']}", params={"around": 0}).json()
    assert len(alone["messages"]) == 3
    assert client.get(f"/v1/memories/{uuid4()}").status_code == 404


def test_facts_are_searchable_supersede_and_retract(client):
    first, second = uuid4(), uuid4()
    assert client.put(f"/v1/facts/{first}", json={"text": "Kevin drives a Subaru", "subject": "car"}).json()["created"]
    assert not client.put(f"/v1/facts/{first}", json={"text": "Kevin drives a Subaru"}).json()["created"]
    hits = client.get("/v1/search", params={"q": "what car does Kevin drive"}).json()["results"]
    assert hits[0]["kind"] == "fact" and hits[0]["text"] == "car: Kevin drives a Subaru"

    client.put(f"/v1/facts/{second}", json={"text": "Kevin drives a Tesla", "subject": "car", "supersedes": str(first)})
    hits = client.get("/v1/search", params={"q": "Kevin drive car", "kind": "fact"}).json()["results"]
    assert [h["text"] for h in hits] == ["car: Kevin drives a Tesla"]
    everything = client.get("/v1/facts", params={"status": "all"}).json()["facts"]
    assert {f["status"] for f in everything} == {"active", "superseded"}

    client.patch(f"/v1/facts/{second}", json={"status": "retracted"})
    assert client.get("/v1/search", params={"q": "Tesla", "kind": "fact"}).json()["results"] == []
    client.patch(f"/v1/facts/{second}", json={"status": "active", "pinned": True, "reviewed": True})
    pinned = client.get("/v1/facts", params={"pinned": "true"}).json()["facts"]
    assert pinned[0]["text"] == "Kevin drives a Tesla" and pinned[0]["reviewed_at"]
    assert client.get("/v1/facts", params={"unreviewed": "true"}).json()["facts"] == []

    assert client.delete(f"/v1/facts/{second}").status_code == 200
    assert client.get("/v1/search", params={"q": "Tesla"}).json()["results"] == []


def test_a_fact_survives_forgetting_its_session(client):
    session = uuid4()
    post(client, message(session, "user", "I'm allergic to penicillin", 0))
    client.put(f"/v1/facts/{uuid4()}", json={"text": "Kevin is allergic to penicillin", "session_id": str(session)})
    client.delete(f"/v1/sessions/{session}")
    hits = client.get("/v1/search", params={"q": "penicillin"}).json()["results"]
    assert [h["kind"] for h in hits] == ["fact"]


def test_background_worker_embeds_without_blocking_writes(database_url, schema):
    import time

    from fastapi.testclient import TestClient

    from memory_engine.app import Engine, create_app
    from memory_engine.embed import FakeEmbedder

    engine = Engine(database_url, schema, embedder=FakeEmbedder())
    with TestClient(create_app(engine, connect_in_background=False)) as c:
        post(c, message(uuid4(), "user", "background embedding check", 0))
        for _ in range(50):
            hits = c.get("/v1/search", params={"q": "background embedding"}).json()["results"]
            if hits and "vector" in hits[0]["matched"]:
                break
            time.sleep(0.1)
        assert "vector" in hits[0]["matched"]


def test_failed_model_load_waits_before_retrying(monkeypatch):
    import fastembed

    from memory_engine.embed import FastEmbedEmbedder

    calls = []

    class Broken:
        def __init__(self, **kwargs):
            calls.append(kwargs)
            raise ValueError("Could not load model from any source.")

    monkeypatch.setattr(fastembed, "TextEmbedding", Broken)
    embedder = FastEmbedEmbedder(cache_dir="unused")
    for _ in range(3):
        try:
            embedder.embed(["hello"])
        except Exception:
            pass
    assert len(calls) == 1
