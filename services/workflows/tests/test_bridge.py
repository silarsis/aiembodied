import json

from aiembodied_workflows.bridge import Bridge, Signal, WatchEntry, WatchIndex, event_to_signals

INDEX = WatchIndex()
INDEX.replace([
    WatchEntry("watch:1", "echo", {"kind": "entity", "entityId": "binary_sensor.door", "state": "on"}),
    WatchEntry("flowwatch:echo:f", "echo", {"kind": "entity", "entityId": "binary_sensor.door", "state": "off"}),
    WatchEntry("watch:2", "echo", {"kind": "entity", "entityId": "sensor.other", "below": 5}),
    WatchEntry("watch:3", "echo", {"kind": "coding_task", "taskId": "20261108-1a2b"}),
    WatchEntry("watch:4", "echo", {"kind": "search", "query": "x"}),
])


def test_speech_heard_wakes_the_addressed_avatar():
    ev = {"type": "speech.heard", "to": ["avatar:sage", "scene:lounge"], "payload": {"text": "hi"}}
    assert event_to_signals(ev, INDEX) == [Signal("life:sage", "interaction")]
    assert event_to_signals({"type": "speech.heard", "to": ["scene:lounge"]}, INDEX) == []


def test_utterance_from_an_avatar():
    ev = {"type": "avatar.utterance", "producer": {"kind": "avatar", "id": "echo"}}
    assert event_to_signals(ev, INDEX) == [Signal("life:echo", "spoke")]
    assert event_to_signals({"type": "avatar.utterance", "producer": {"kind": "person", "id": "kevin"}}, INDEX) == []


def test_home_change_goes_to_matching_watches_only():
    payload = {"entity_id": "binary_sensor.door", "new": "on", "old": "off", "text": "Front door opened", "home_id": "h", "x": 1}
    for typ in ("home.change", "home.alert"):
        sigs = event_to_signals({"type": typ, "payload": payload}, INDEX)
        assert {s.workflow_id for s in sigs} == {"watch:1", "flowwatch:echo:f"}
        assert all(s.name == "home_change" and "x" not in s.payload and s.payload["new"] == "on" for s in sigs)
    assert event_to_signals({"type": "home.change", "payload": {"entity_id": "light.none", "new": "on"}}, INDEX) == []
    assert event_to_signals({"type": "home.change", "payload": {}}, INDEX) == []


def test_task_status_goes_to_the_coding_watch():
    ev = {"type": "task.status", "txn": {"id": "task:20261108-1a2b", "state": "done"}, "payload": {"summary": "PR opened"}}
    sigs = event_to_signals(ev, INDEX)
    assert [s.workflow_id for s in sigs] == ["watch:3"]
    assert sigs[0].payload["state"] == "done" and sigs[0].payload["taskId"] == "20261108-1a2b"
    assert event_to_signals({"type": "task.status", "txn": {"id": "task:other"}, "payload": {}}, INDEX) == []


def test_other_events_do_nothing():
    assert event_to_signals({"type": "tool.result"}, INDEX) == []


def test_index_add_remove():
    idx = WatchIndex()
    idx.add(WatchEntry("w", "echo", {"kind": "entity", "entityId": "a.b", "state": "on"}))
    assert idx.for_entity("a.b")
    idx.remove("w")
    assert not idx.for_entity("a.b")


async def test_bridge_hello_and_handle_resume_id():
    sent = []

    async def send(sig):
        sent.append(sig)

    b = Bridge("http://127.0.0.1:8196", INDEX, send)
    assert b.url == "ws://127.0.0.1:8196/v1/stream"
    hello = b.hello()
    assert hello["actor"] == "service:workflows" and hello["since"] is None and hello["subscribe"]["observe"] is True
    assert hello["subscribe"]["types"] == ["speech.heard", "home.change", "home.alert", "task.status", "avatar.utterance"]
    assert hello["subscribe"]["to"] == ["service:workflows"]
    await b.handle({"id": "01ABC", "type": "speech.heard", "to": ["avatar:echo"]})
    assert sent == [Signal("life:echo", "interaction")] and b.hello()["since"] == "01ABC"


async def test_bridge_a_failing_signal_does_not_stop_it():
    async def send(sig):
        raise RuntimeError("workflow not found")

    b = Bridge("http://x", INDEX, send)
    await b.handle({"id": "1", "type": "speech.heard", "to": ["avatar:echo"]})
    assert b.last_id == "1"


async def test_bridge_run_reads_events_and_reconnects():
    import asyncio

    sent = []

    async def send(sig):
        sent.append(sig)

    class WS:
        def __init__(self, messages):
            self.messages, self.out = messages, []

        async def send(self, text):
            self.out.append(json.loads(text))

        def __aiter__(self):
            async def gen():
                for m in self.messages:
                    yield json.dumps(m)

            return gen()

    class Conn:
        def __init__(self, ws):
            self.ws = ws

        async def __aenter__(self):
            return self.ws

        async def __aexit__(self, *a):
            return False

    sockets = [WS([{"op": "welcome"}, {"op": "event", "event": {"id": "A", "type": "speech.heard", "to": ["avatar:echo"]}}]),
               WS([{"op": "event", "event": {"id": "B", "type": "avatar.utterance", "producer": {"kind": "avatar", "id": "echo"}}}])]
    calls = []

    def connect(url):
        calls.append(url)
        if len(calls) > 2:
            raise asyncio.CancelledError()
        return Conn(sockets[len(calls) - 1])

    b = Bridge("http://sb", INDEX, send, connect=connect)
    import aiembodied_workflows.bridge as mod

    real_sleep = asyncio.sleep
    mod.asyncio.sleep = lambda s: real_sleep(0)  # type: ignore[assignment]
    try:
        try:
            await b.run()
        except asyncio.CancelledError:
            pass
    finally:
        mod.asyncio.sleep = real_sleep
    assert [s.name for s in sent] == ["interaction", "spoke"]
    assert sockets[1].out[0]["since"] == "A"  # the second connection resumes after the first event
