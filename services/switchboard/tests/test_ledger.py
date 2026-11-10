from datetime import datetime, timedelta, timezone

from conftest import ev


def txn_ev(txn_id, state=None, producer="tool:coding", type_="task.status", **txn):
    return ev(type_, producer, txn={"id": txn_id, **({"state": state} if state else {}), **txn})


def row(client, txn_id):
    return client.get(f"/v1/txns/{txn_id}").json()["txn"]


def test_open_accepted_done(client, publish):
    publish(txn_ev("t1", producer="avatar:echo", title="Do it"))
    r = row(client, "t1")
    assert (r["state"], r["opened_by"], r["owner"], r["root"], r["parent"], r["title"], r["closed_at"]) == (
        "open", "avatar:echo", None, "t1", None, "Do it", None)
    publish(txn_ev("t1", "accepted"))
    r = row(client, "t1")
    assert (r["state"], r["owner"]) == ("accepted", "tool:coding")
    publish(txn_ev("t1", "progress", producer="tool:other"))
    publish(txn_ev("t1", "done", producer="tool:other"))
    r = row(client, "t1")
    assert (r["state"], r["owner"]) == ("done", "tool:coding") and r["closed_at"]
    assert client.get("/health").json()["open_txns"] == 0


def test_closed_ignores_later_state_changes(client, publish):
    publish(txn_ev("t1", "failed"))
    publish(txn_ev("t1", "progress"), txn_ev("t1", "done"))
    assert row(client, "t1")["state"] == "failed"
    assert len(client.get("/v1/events", params={"txn": "t1"}).json()["events"]) == 3


def test_event_without_state_leaves_state(client, publish):
    publish(txn_ev("t1", "waiting"), txn_ev("t1"))
    assert row(client, "t1")["state"] == "waiting"


def test_root_rules(client, publish):
    publish(txn_ev("a"), txn_ev("b", parent="a"), txn_ev("c", parent="b"), txn_ev("d", parent="unknown"),
            txn_ev("e", parent="a", root="custom"))
    assert {t: row(client, t)["root"] for t in "abcde"} == {"a": "a", "b": "a", "c": "a", "d": "unknown", "e": "custom"}
    assert {t["id"] for t in client.get("/v1/txns", params={"root": "a"}).json()["txns"]} == {"a", "b", "c"}


def test_closing_cancels_open_descendants(client, publish):
    publish(txn_ev("p", "progress"), txn_ev("c1", "waiting", parent="p"), txn_ev("c2", "done", parent="p"),
            txn_ev("g1", "progress", parent="c1"), txn_ev("other", "progress"))
    publish(txn_ev("p", "done"))
    assert {t: row(client, t)["state"] for t in ("p", "c1", "c2", "g1", "other")} == {
        "p": "done", "c1": "cancelled", "c2": "done", "g1": "cancelled", "other": "progress"}
    cancelled = client.get("/v1/events", params={"type": "txn.cancelled"}).json()["events"]
    assert sorted(e["txn"]["id"] for e in cancelled) == ["c1", "g1"]
    by_txn = {e["txn"]["id"]: e for e in cancelled}
    assert by_txn["c1"]["producer"] == {"kind": "service", "id": "switchboard"}
    assert by_txn["c1"]["payload"] == {"reason": "parent closed", "parent": "p"}
    assert by_txn["g1"]["payload"]["parent"] == "c1"
    detail = client.get("/v1/txns/p").json()
    assert {c["id"] for c in detail["children"]} == {"c1", "c2"}
    assert detail["events"][0]["txn"]["id"] == "p"
    assert client.get("/v1/txns/nope").status_code == 404


def test_txn_list_filters(client, publish):
    publish(txn_ev("a", "progress"), txn_ev("b", "done"), txn_ev("c", "waiting"))
    ids = lambda **p: {t["id"] for t in client.get("/v1/txns", params=p).json()["txns"]}  # noqa: E731
    assert ids(state="open") == {"a", "c"}
    assert ids(state="closed") == {"b"}
    assert ids(state="waiting") == {"c"}
    assert client.get("/v1/txns").json()["txns"][0]["id"] == "c"


def test_deadline_expiry(client, publish):
    soon = datetime.now(timezone.utc) + timedelta(minutes=5)
    publish(txn_ev("p", "progress", deadline=soon.isoformat()), txn_ev("c", "progress", parent="p"),
            txn_ev("late-but-done", "done", deadline=soon.isoformat()), txn_ev("no-deadline", "progress"))
    hub = client.app.state.hub
    assert hub.expire(soon - timedelta(minutes=1)) == 0
    assert hub.expire(soon + timedelta(seconds=1)) == 1
    assert {t: row(client, t)["state"] for t in ("p", "c", "late-but-done", "no-deadline")} == {
        "p": "expired", "c": "cancelled", "late-but-done": "done", "no-deadline": "progress"}
    expired = client.get("/v1/events", params={"type": "txn.expired"}).json()["events"]
    assert [e["txn"]["id"] for e in expired] == ["p"]
    assert hub.expire(soon + timedelta(hours=1)) == 0
