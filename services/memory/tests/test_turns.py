from datetime import datetime, timedelta, timezone
from uuid import uuid4

from memory_engine.turns import Message, assemble_turns

T0 = datetime(2026, 11, 3, 8, 0, tzinfo=timezone.utc)


def msg(role, content, seconds, **extra):
    return Message(id=uuid4(), role=role, content=content, created_at=T0 + timedelta(seconds=seconds), **extra)


def test_user_message_starts_each_turn_and_replies_follow():
    messages = [
        msg("user", "what's the weather", 0),
        msg("tool", "Sunny, 24C", 1, tool={"name": "web_search", "arguments": {"query": "weather"}}),
        msg("assistant", "Sunny and 24.", 2),
        msg("user", "thanks", 10),
        msg("assistant", "Any time.", 11),
    ]
    turns = assemble_turns(messages)
    assert [len(t.messages) for t in turns] == [3, 2]
    assert turns[0].source_id == messages[0].id
    assert turns[0].period_end == messages[2].created_at
    text = turns[0].text("Echo")
    assert text.splitlines() == [
        "User: what's the weather",
        "[web_search({'query': 'weather'})] Sunny, 24C",
        "Echo: Sunny and 24.",
    ]


def test_order_comes_from_time_not_arrival():
    late_user = msg("user", "first question", 0)
    reply = msg("assistant", "first answer", 1)
    turns = assemble_turns([reply, late_user])
    assert len(turns) == 1 and turns[0].source_id == late_user.id


def test_greeting_before_any_user_message_is_its_own_turn_and_system_is_skipped():
    turns = assemble_turns([
        msg("system", "Wake word detected", 0),
        msg("assistant", "Hello!", 1),
        msg("user", "hi", 2),
    ])
    assert [t.text() for t in turns] == ["Assistant: Hello!", "User: hi"]


def test_long_tool_results_are_cut_and_privacy_carries():
    turns = assemble_turns([
        msg("user", "search", 0, private=True),
        msg("tool", "x" * 5000, 1, tool={"name": "web_search", "ok": False}),
    ])
    text = turns[0].text()
    assert "[web_search failed]" in text
    assert len(text) < 800
    assert turns[0].private is True
