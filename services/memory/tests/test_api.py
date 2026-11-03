from datetime import datetime, timedelta, timezone
from uuid import uuid4

T0 = datetime(2026, 11, 3, 8, 0, tzinfo=timezone.utc)


def at(seconds):
    return (T0 + timedelta(seconds=seconds)).isoformat()


def message(session_id, role, content, seconds, **extra):
    return {"id": str(uuid4()), "session_id": str(session_id), "role": role, "content": content,
            "created_at": at(seconds), **extra}


def test_health_reports_ready(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["database"] == "ready"
    assert body["schema_version"] >= 1
    assert body["counts"] == {"sessions": 0, "messages": 0, "indexed": 0}


def test_messages_are_stored_once_and_indexed_as_turns(client):
    session = uuid4()
    assert client.put(f"/v1/sessions/{session}", json={"started_at": at(0), "agent": "Echo", "channel": "voice"}).status_code == 200
    batch = [
        message(session, "user", "My tomatoes are getting blight", 1),
        message(session, "tool", "Copper spray helps", 2, tool={"name": "web_search", "arguments": {"query": "blight"}}),
        message(session, "assistant", "Try a copper spray and water at the base.", 3),
    ]
    first = client.post("/v1/messages", json={"messages": batch}).json()
    again = client.post("/v1/messages", json={"messages": batch}).json()
    assert first == {"inserted": 3, "duplicates": 0}
    assert again == {"inserted": 0, "duplicates": 3}

    messages = client.get(f"/v1/sessions/{session}/messages").json()["messages"]
    assert [m["role"] for m in messages] == ["user", "tool", "assistant"]
    assert messages[1]["tool"]["name"] == "web_search"

    results = client.get("/v1/search", params={"q": "tomato blight"}).json()["results"]
    assert len(results) == 1
    assert results[0]["kind"] == "turn"
    assert results[0]["text"].startswith("User: My tomatoes")
    assert "Echo: Try a copper spray" in results[0]["text"]


def test_message_for_unknown_session_creates_it_and_details_fill_in_later(client):
    session = uuid4()
    client.post("/v1/messages", json={"messages": [message(session, "user", "hello there", 5)]})
    listed = client.get("/v1/sessions").json()["sessions"]
    assert listed[0]["agent"] == "unknown" and listed[0]["message_count"] == 1
    client.put(f"/v1/sessions/{session}", json={"started_at": at(0), "agent": "Echo", "channel": "voice"})
    listed = client.get("/v1/sessions").json()["sessions"]
    assert listed[0]["agent"] == "Echo"
    assert listed[0]["started_at"] == at(0)


def test_message_can_carry_its_session(client):
    session = uuid4()
    body = message(session, "user", "remember the dentist", 1)
    body["session"] = {"started_at": at(0), "agent": "Mei", "channel": "phone"}
    client.post("/v1/messages", json={"messages": [body]})
    listed = client.get("/v1/sessions").json()["sessions"]
    assert (listed[0]["agent"], listed[0]["channel"]) == ("Mei", "phone")


def test_late_user_message_splits_the_turn(client):
    session = uuid4()
    client.post("/v1/messages", json={"messages": [
        message(session, "user", "question one", 0),
        message(session, "assistant", "answer one", 1),
        message(session, "assistant", "answer two", 3),
    ]})
    client.post("/v1/messages", json={"messages": [message(session, "user", "question two", 2)]})
    results = client.get("/v1/search", params={"q": "answer"}).json()["results"]
    texts = sorted(r["text"] for r in results)
    assert texts == ["User: question one\nAssistant: answer one", "User: question two\nAssistant: answer two"]


def test_search_filters_by_time_and_privacy(client):
    session = uuid4()
    client.post("/v1/messages", json={"messages": [
        message(session, "user", "garden plans for spring", 0),
        message(session, "user", "garden plans for autumn", 86400 * 30, private=True),
    ]})
    later = client.get("/v1/search", params={"q": "garden", "from": at(86400)}).json()["results"]
    assert [r["text"] for r in later] == ["User: garden plans for autumn"]
    public = client.get("/v1/search", params={"q": "garden", "include_private": "false"}).json()["results"]
    assert [r["text"] for r in public] == ["User: garden plans for spring"]


def test_sessions_list_by_date_range(client):
    early, late = uuid4(), uuid4()
    client.put(f"/v1/sessions/{early}", json={"started_at": at(0)})
    client.put(f"/v1/sessions/{late}", json={"started_at": at(86400 * 3)})
    in_range = client.get("/v1/sessions", params={"from": at(86400), "to": at(86400 * 4)}).json()["sessions"]
    assert [s["id"] for s in in_range] == [str(late)]


def test_forgetting_a_session_removes_everything(client):
    session = uuid4()
    client.post("/v1/messages", json={"messages": [message(session, "user", "secret plan", 0)]})
    assert client.delete(f"/v1/sessions/{session}").status_code == 200
    assert client.get("/v1/search", params={"q": "secret"}).json()["results"] == []
    assert client.get(f"/v1/sessions/{session}/messages").status_code == 404
    assert client.delete(f"/v1/sessions/{session}").status_code == 404


def test_forgetting_a_message_rebuilds_its_turn(client):
    session = uuid4()
    question = message(session, "user", "what about the tomatoes", 0)
    answer = message(session, "assistant", "they need water", 1)
    client.post("/v1/messages", json={"messages": [question, answer]})
    client.delete(f"/v1/messages/{answer['id']}")
    results = client.get("/v1/search", params={"q": "tomatoes"}).json()["results"]
    assert results[0]["text"] == "User: what about the tomatoes"


def test_bearer_token_is_required_when_set(database_url, schema):
    from fastapi.testclient import TestClient

    from memory_engine.app import Engine, create_app

    with TestClient(create_app(Engine(database_url, schema), api_token="s3cret", connect_in_background=False)) as c:
        assert c.get("/v1/sessions").status_code == 401
        assert c.get("/v1/sessions", headers={"Authorization": "Bearer s3cret"}).status_code == 200
        assert c.get("/health").status_code == 200


def test_starts_without_a_database_and_answers_503():
    from fastapi.testclient import TestClient

    from memory_engine.app import Engine, create_app

    engine = Engine("postgresql://nobody@127.0.0.1:1/none", "memory", retry_seconds=60)
    with TestClient(create_app(engine)) as c:
        health = c.get("/health").json()
        assert health["status"] == "starting"
        assert c.get("/v1/sessions").status_code == 503
