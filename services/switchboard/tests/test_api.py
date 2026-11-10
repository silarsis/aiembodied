from datetime import datetime, timedelta, timezone

from conftest import ev
from switchboard.ulid import ALPHABET, new_ulid


def test_publish_assigns_id_and_time(client):
    r = client.post("/v1/events", json=ev("avatar.utterance", "avatar:echo", ["person:kevin"], payload={"text": "hi"}))
    assert r.status_code == 200
    (eid,) = r.json()["ids"]
    assert len(eid) == 26 and set(eid) <= set(ALPHABET)
    (got,) = client.get("/v1/events").json()["events"]
    assert got["id"] == eid and got["at"].endswith("Z") and len(got["at"]) == 24
    assert got["audience"] == "household" and got["priority"] == "normal" and got["v"] == 1
    assert got["payload"] == {"text": "hi"}


def test_client_id_and_time_are_kept_and_retries_are_idempotent(client, publish):
    e = ev(id="01JABCDEFGHJKMNPQRSTVWXYZ0", at="2026-11-10T12:00:00+01:00")
    assert publish(e) == ["01JABCDEFGHJKMNPQRSTVWXYZ0"]
    assert publish(e) == ["01JABCDEFGHJKMNPQRSTVWXYZ0"]
    (got,) = client.get("/v1/events").json()["events"]
    assert got["at"] == "2026-11-10T11:00:00.000Z"


def test_ulids_increase():
    ids = [new_ulid() for _ in range(2000)]
    assert ids == sorted(ids) and len(set(ids)) == len(ids)


def test_query_filters(client, publish):
    ids = publish(
        ev("task.status", "tool:coding", ["avatar:echo"], txn={"id": "task:1", "state": "open"}),
        ev("task.progress", "tool:coding", ["scene:lounge"], scene="lounge"),
        ev("avatar.utterance", "avatar:echo", ["person:kevin"], txn={"id": "turn:1"}),
    )

    def q(**params):
        return [e["id"] for e in client.get("/v1/events", params=params).json()["events"]]

    assert q() == ids
    assert q(type="task.*") == ids[:2]
    assert q(producer="avatar:echo") == ids[2:]
    assert q(txn="task:1") == ids[:1]
    assert q(root="task:1") == ids[:1]
    assert q(scene="lounge") == ids[1:2]
    assert q(to="person:kevin") == ids[2:]
    assert q(since=ids[0]) == ids[1:]
    assert q(limit=2) == ids[:2]
    assert client.get("/v1/events", params={"limit": 2}).json()["next"] == ids[1]
    assert client.get("/v1/events", params={"since": ids[2]}).json() == {"events": [], "next": None}


def test_validation_errors(client):
    assert client.post("/v1/events", json=ev("Bad Type")).status_code == 422
    assert client.post("/v1/events", json=ev(to=["nobody"])).status_code == 422
    assert client.post("/v1/events", json=ev(to=["robot:r2"])).status_code == 422
    assert client.post("/v1/events", json=ev(producer="thing:x")).status_code == 422
    assert client.post("/v1/events", json={"type": "x.y"}).status_code == 422
    assert client.post("/v1/events", json={"events": []}).status_code == 422
    assert client.post("/v1/events", json={"events": [ev()] * 501}).status_code == 422
    assert client.get("/v1/events").json()["events"] == []


def test_batch_is_all_or_nothing(client):
    r = client.post("/v1/events", json={"events": [ev(), ev("Bad")]})
    assert r.status_code == 422
    assert client.get("/v1/events").json()["events"] == []


def test_payload_too_big(client):
    assert client.post("/v1/events", json=ev(payload={"x": "a" * 70_000})).status_code == 413
    assert client.post("/v1/events", json=ev(payload={"x": "a" * 60_000})).status_code == 200


def test_health(client, publish):
    publish(ev(txn={"id": "t1"}))
    assert client.get("/health").json() == {"ok": True, "version": "0.1.0", "node": "testnode", "events": 1,
                                            "open_txns": 1, "clients": 0}


def test_prune(client, cfg, publish):
    now = datetime.now(timezone.utc)
    old = (now - timedelta(days=40)).isoformat()
    publish(ev(at=old, txn={"id": "old-done", "state": "done"}),
            ev(at=old, txn={"id": "old-open", "state": "progress"}),
            ev(txn={"id": "new-done", "state": "done"}))
    assert client.get("/health").json()["events"] == 3
    assert client.app.state.hub.prune(now) == (2, 1)
    assert [e["txn"]["id"] for e in client.get("/v1/events").json()["events"]] == ["new-done"]
    assert {t["id"] for t in client.get("/v1/txns").json()["txns"]} == {"old-open", "new-done"}
