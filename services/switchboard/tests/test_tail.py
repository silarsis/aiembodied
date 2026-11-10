from switchboard.tail import format_event


def test_format_event():
    line = format_event({"type": "task.status", "at": "2026-11-10T12:34:56.789Z",
                         "producer": {"kind": "tool", "id": "coding"}, "to": ["avatar:echo"],
                         "txn": {"id": "task:1", "state": "progress"}, "payload": {"n": 1}})
    assert line == '12:34:56.789 task.status tool:coding -> avatar:echo [task:1 progress] {"n":1}'


def test_format_event_without_to_txn_and_long_payload():
    line = format_event({"type": "a.b", "at": "2026-11-10T12:34:56.789Z", "producer": {"kind": "service", "id": "x"},
                         "payload": {"t": "x" * 300}})
    assert line.startswith("12:34:56.789 a.b service:x -> - {") and len(line) < 150 and line.endswith("…")
