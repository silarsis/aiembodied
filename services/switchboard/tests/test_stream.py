import pytest

from conftest import ev


def hello(ws, **kw):
    ws.send_json({"op": "hello", "actor": "avatar:echo", **kw})
    msg = ws.receive_json()
    assert msg == {"op": "welcome", "node": "testnode"}


def test_observer_gets_everything_addressed_client_only_its_own(client):
    with client.websocket_connect("/v1/stream") as obs, client.websocket_connect("/v1/stream") as echo:
        hello(obs, subscribe={"types": ["*"], "observe": True})
        hello(echo, subscribe={"types": ["tool.*", "speech.*"], "to": ["avatar:echo"]})
        client.post("/v1/events", json={"events": [
            ev("tool.result", "tool:x", ["avatar:echo"]),
            ev("tool.result", "tool:x", ["person:kevin"]),
            ev("speech.heard", "person:kevin", ["avatar:echo", "scene:lounge"]),
            ev("task.status", "tool:coding", ["avatar:echo"]),
        ]})
        got = [obs.receive_json() for _ in range(4)]
        assert [m["op"] for m in got] == ["event"] * 4
        assert [m["event"]["type"] for m in got] == ["tool.result", "tool.result", "speech.heard", "task.status"]
        mine = [echo.receive_json()["event"] for _ in range(2)]
        assert [(e["type"], e["to"][0]) for e in mine] == [("tool.result", "avatar:echo"), ("speech.heard", "avatar:echo")]
        assert client.get("/health").json()["clients"] == 2
    assert client.get("/health").json()["clients"] == 0


def test_replay_since_then_live(client, publish):
    ids = publish(ev("a.one", to=["avatar:echo"]), ev("a.two", to=["person:kevin"]), ev("b.three", to=["avatar:echo"]),
                  ev("a.four", to=["avatar:echo"]))
    with client.websocket_connect("/v1/stream") as ws:
        hello(ws, since=ids[0], subscribe={"types": ["a.*"], "to": ["avatar:echo"]})
        assert ws.receive_json()["event"]["id"] == ids[3]
        (live,) = publish(ev("a.five", to=["avatar:echo"]))
        assert ws.receive_json()["event"]["id"] == live


def test_publish_over_ws_acks(client):
    with client.websocket_connect("/v1/stream") as ws:
        hello(ws, subscribe={"observe": True})
        ws.send_json({"op": "publish", "ref": "r1", "event": ev("x.y", "avatar:echo")})
        event, ack = ws.receive_json(), ws.receive_json()  # the fanned-out event comes first, then the ack
        assert ack["op"] == "ack" and ack["ref"] == "r1" and len(ack["id"]) == 26
        assert event["event"]["id"] == ack["id"]
        ws.send_json({"op": "publish", "ref": "r2", "event": {"type": "BAD"}})
        err = ws.receive_json()
        assert err["op"] == "error" and err["ref"] == "r2" and err["message"]
        ws.send_json({"op": "ping"})
        assert ws.receive_json() == {"op": "pong"}
    assert [e["type"] for e in client.get("/v1/events").json()["events"]] == ["x.y"]


def test_first_message_must_be_hello(client):
    with client.websocket_connect("/v1/stream") as ws:
        ws.send_json({"op": "ping"})
        assert ws.receive_json()["op"] == "error"


def test_slow_client_is_dropped(client):
    from switchboard import hub as hub_mod

    h = client.app.state.hub
    c, _ = h.attach({"subscribe": {"observe": True}})
    for _ in range(hub_mod.CLIENT_QUEUE):
        assert c.offer({"op": "pong"})
    client.post("/v1/events", json=ev())
    assert c not in h.clients
    assert c.queue.qsize() == 1 and c.queue.get_nowait() is None
