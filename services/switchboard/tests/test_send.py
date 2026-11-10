import io

from switchboard import send


def test_build_event_addresses_the_inbox():
    ev = send.build_event("hi", to="avatar:echo", source="me", urgent=True, type_="avatar.inbox", producer="person:cli")
    assert ev["to"] == ["avatar:echo"] and ev["priority"] == "urgent"
    assert ev["payload"] == {"text": "hi", "source": "me"} and ev["producer"] == {"kind": "person", "id": "cli"}


def test_unreachable_switchboard_is_reported():
    out = io.StringIO()
    assert send.run("http://127.0.0.1:1", "hi", to="avatar:echo", source="me", urgent=False,
                    type_="avatar.inbox", producer="person:cli", out=out) == 1
    assert "Could not reach" in out.getvalue()


def test_send_reaches_the_journal(client, monkeypatch):
    sent = {}

    class Reply(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_open(request, timeout):
        sent["body"] = request.data
        r = client.post("/v1/events", content=request.data, headers={"content-type": "application/json"})
        return Reply(r.content)

    monkeypatch.setattr(send.urllib.request, "urlopen", fake_open)
    out = io.StringIO()
    assert send.run("http://x", "hello", to="avatar:echo", source="me", urgent=False, type_="avatar.inbox",
                    producer="person:cli", out=out) == 0
    assert [e["type"] for e in client.get("/v1/events").json()["events"]] == ["avatar.inbox"]
