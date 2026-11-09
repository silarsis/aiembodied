from uuid import uuid4

from test_recall import message, post


def fact(client, text, **extra):
    fact_id = str(uuid4())
    assert client.put(f"/v1/facts/{fact_id}", json={"text": text, **extra}).status_code == 200
    return fact_id


def test_brief_has_pinned_facts_first_and_the_last_conversation(client):
    fact(client, "Kevin grows tomatoes")
    fact(client, "Kevin's partner is Erika", pinned=True)
    fact(client, "Kevin's bank PIN hint", private=True)
    earlier, current = uuid4(), uuid4()
    post(
        client,
        message(earlier, "user", "the greenhouse door is broken", 0),
        message(earlier, "assistant", "I'll remind you to fix it.", 1),
    )
    post(client, message(current, "user", "hello again", 3600))
    body = client.get("/v1/brief", params={"session_id": str(current)}).json()
    assert [f["text"] for f in body["facts"]] == ["Kevin's partner is Erika", "Kevin grows tomatoes"]
    assert body["last_session"]["session_id"] == str(earlier)
    assert body["last_session"]["turns"] == ["User: the greenhouse door is broken\nAssistant: I'll remind you to fix it."]


def test_brief_is_empty_on_a_new_memory(client):
    assert client.get("/v1/brief").json() == {
        "agent": None, "facts": [], "handoff": None, "last_session": None, "recent_days": [],
        "recent_coding": [],
    }


def test_auto_recall_returns_strong_matches_from_other_sessions_only(client):
    earlier, current = uuid4(), uuid4()
    post(client, message(earlier, "user", "the tomatoes are planted in the greenhouse beds", 0))
    post(client, message(current, "user", "the tomatoes are planted in the greenhouse beds again", 3600))
    body = client.post(
        "/v1/recall",
        json={"text": "are the tomatoes planted in the greenhouse beds", "session_id": str(current), "min_similarity": 0.3},
    ).json()
    assert [item["session_id"] for item in body["items"]] == [str(earlier)]
    assert body["reason"] is None

    again = client.post(
        "/v1/recall",
        json={
            "text": "are the tomatoes planted in the greenhouse beds",
            "session_id": str(current),
            "exclude": [body["items"][0]["id"]],
            "min_similarity": 0.3,
        },
    ).json()
    assert again == {"items": [], "reason": "no strong match"}


def test_auto_recall_skips_short_turns_weak_matches_and_private_items(client):
    session = uuid4()
    post(client, message(session, "user", "my car registration expires in march", 0, private=True))
    post(client, message(session, "user", "a podcast about roman history", 10))
    assert client.post("/v1/recall", json={"text": "thanks!"}).json()["reason"] == "short"
    weak = client.post("/v1/recall", json={"text": "what should we cook for dinner tonight"}).json()
    assert weak["items"] == []
    private = client.post(
        "/v1/recall", json={"text": "when does my car registration expire", "min_similarity": 0.0}
    ).json()
    assert all("registration" not in item["text"] for item in private["items"])


def test_recall_log_records_each_call_and_forgets_with_the_session(client):
    earlier, current = uuid4(), uuid4()
    post(client, message(earlier, "user", "the dog's vet visit is booked for thursday", 0))
    client.post(
        "/v1/recall",
        json={"text": "when is the dog's vet visit booked", "session_id": str(current), "min_similarity": 0.2},
    )
    entries = client.get("/v1/recall-log", params={"session_id": str(current)}).json()["entries"]
    assert len(entries) == 1
    assert entries[0]["query"] == "when is the dog's vet visit booked"
    assert entries[0]["items"][0]["kind"] == "turn"
    post(client, message(current, "user", "hi", 3600))
    assert client.delete(f"/v1/sessions/{current}").status_code == 200
    assert client.get("/v1/recall-log", params={"session_id": str(current)}).json()["entries"] == []
