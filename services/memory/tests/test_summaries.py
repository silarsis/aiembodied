from datetime import datetime, timedelta, timezone
from uuid import uuid4

from test_recall import T0, at, message, post

from memory_engine.summaries import period_bounds


def run(client, now):
    response = client.post("/v1/summaries/run", json={"now": now.isoformat(), "limit": 50})
    assert response.status_code == 200, response.text
    return response.json()["done"]


def test_period_bounds_are_local_days_weeks_from_monday_and_months():
    from zoneinfo import ZoneInfo

    melbourne = ZoneInfo("Australia/Melbourne")
    when = datetime(2026, 11, 3, 20, 0, tzinfo=timezone.utc)  # Wednesday 4 Nov, 7 am in Melbourne
    day = period_bounds("day", when, melbourne)
    assert day[0].astimezone(melbourne).isoformat() == "2026-11-04T00:00:00+11:00"
    week = period_bounds("week", when, melbourne)
    assert week[0].astimezone(melbourne).date().isoformat() == "2026-11-02"  # a Monday
    month = period_bounds("month", when, melbourne)
    assert (month[0].astimezone(melbourne).day, month[1].astimezone(melbourne).month) == (1, 12)


def test_a_quiet_conversation_is_summarised_titled_and_its_facts_saved(summary_client, llm):
    session = uuid4()
    summary_client.put(f"/v1/sessions/{session}", json={"started_at": at(0), "agent": "Echo"})
    post(
        summary_client,
        message(session, "user", "I've decided to sell the old Corolla next month", 0),
        message(session, "assistant", "Good plan.", 1),
    )
    llm.reply = lambda prompt: {
        "title": "Selling the Corolla",
        "summary": "The user decided to sell their old Corolla next month.",
        "topics": ["Car", "car", "money"],
        "facts": [{"text": "The user plans to sell their Corolla in December 2026.", "subject": "car"}],
    }
    # Not yet: still inside the ten quiet minutes.
    assert run(summary_client, T0 + timedelta(minutes=5)) == []
    done = run(summary_client, T0 + timedelta(minutes=11))
    assert done[0]["title"] == "Selling the Corolla" and done[0]["facts"] == 1
    assert "sell the old Corolla" in llm.prompts[0]

    sessions = summary_client.get("/v1/sessions").json()["sessions"]
    assert sessions[0]["title"] == "Selling the Corolla"
    facts = summary_client.get("/v1/facts").json()["facts"]
    assert facts[0]["author"] == "extractor" and facts[0]["session_id"] == str(session)
    found = summary_client.get("/v1/search", params={"q": "corolla", "kind": "session"}).json()["results"]
    assert found[0]["text"] == "Selling the Corolla: The user decided to sell their old Corolla next month.\nTopics: car, money"
    # Nothing new: nothing to do.
    assert run(summary_client, T0 + timedelta(minutes=20)) == []


def test_a_late_message_makes_the_summary_due_again(summary_client, llm):
    session = uuid4()
    post(summary_client, message(session, "user", "first thing", 0))
    run(summary_client, T0 + timedelta(minutes=11))
    post(summary_client, message(session, "user", "a late arrival", 30))
    done = run(summary_client, T0 + timedelta(minutes=11))
    assert [d["kind"] for d in done] == ["session"]
    assert "a late arrival" in llm.prompts[-1]
    assert len(summary_client.get("/v1/summaries", params={"kind": "session"}).json()["summaries"]) == 1


def test_closed_days_weeks_and_months_roll_up(summary_client, llm):
    monday = datetime(2026, 10, 5, 9, 0, tzinfo=timezone.utc)
    for day in range(3):
        session = uuid4()
        when = monday + timedelta(days=day)
        summary_client.post("/v1/messages", json={"messages": [
            {"id": str(uuid4()), "session_id": str(session), "role": "user", "content": f"day {day} chat",
             "created_at": when.isoformat()},
        ]})
    done = run(summary_client, datetime(2026, 11, 3, tzinfo=timezone.utc))
    kinds = [d["kind"] for d in done]
    assert kinds.count("session") == 3 and kinds.count("day") == 3
    assert kinds.count("week") == 1 and kinds.count("month") == 1
    assert kinds.index("day") > kinds.index("session") or kinds[0] == "session"
    week_prompt = next(p for p in llm.prompts if "the week starting Monday 05 October 2026" in p)
    assert week_prompt.count("They talked.") == 3

    timeline = summary_client.get(
        "/v1/timeline", params={"from": monday.isoformat(), "to": (monday + timedelta(days=7)).isoformat()}
    ).json()
    assert [s["kind"] for s in timeline["summaries"]] == ["day", "day", "day"]
    assert timeline["sessions"][0]["summary"]["title"] == "A chat"


def test_an_open_day_waits_and_forgetting_rebuilds(summary_client, llm):
    session = uuid4()
    post(summary_client, message(session, "user", "today's chat", 0))
    done = run(summary_client, T0 + timedelta(hours=1))
    assert [d["kind"] for d in done] == ["session"]  # the day isn't over yet
    run(summary_client, T0 + timedelta(days=1))
    assert len(summary_client.get("/v1/summaries", params={"kind": "day"}).json()["summaries"]) == 1

    assert summary_client.delete(f"/v1/sessions/{session}").status_code == 200
    assert summary_client.get("/v1/summaries").json()["summaries"] == []
    assert run(summary_client, T0 + timedelta(days=1)) == []


def test_an_extracted_fact_can_replace_one_it_contradicts_and_is_forgotten_with_its_session(summary_client, llm):
    old_fact = str(uuid4())
    summary_client.put(f"/v1/facts/{old_fact}", json={"text": "The user drives a Corolla", "subject": "car"})
    session = uuid4()
    post(summary_client, message(session, "user", "I sold the Corolla and bought a bike", 0))
    llm.reply = lambda prompt: {
        "title": "New bike",
        "summary": "The user sold the Corolla.",
        "topics": [],
        "facts": [
            {"text": "The user rides a bike now", "subject": "car", "replaces": f"[{old_fact}]"},
            {"text": "The user drives a Corolla"},  # already known: skipped
        ],
    }
    run(summary_client, T0 + timedelta(minutes=11))
    active = summary_client.get("/v1/facts").json()["facts"]
    assert [f["text"] for f in active] == ["The user rides a bike now"]
    assert summary_client.get("/v1/facts", params={"status": "superseded"}).json()["facts"][0]["id"] == old_fact

    summary_client.delete(f"/v1/sessions/{session}")
    assert summary_client.get("/v1/facts").json()["facts"] == []


def test_a_failing_model_backs_off_and_the_brief_uses_summaries(summary_client, llm):
    session = uuid4()
    post(summary_client, message(session, "user", "about the garden", 0))

    def broken(prompt):
        from memory_engine.llm import LlmError

        raise LlmError("unreachable")

    llm.reply = broken
    done = run(summary_client, T0 + timedelta(minutes=11))
    assert "error" in done[0] and len(done) == 1  # tried once, then waits
    assert summary_client.get("/health").json()["summariser"]["error"]

    assert summary_client.get("/v1/brief").json()["last_session"]["summary"] is None

    later = uuid4()
    post(summary_client, message(later, "user", "about the shed", 60))
    llm.reply = lambda prompt: {"title": "Shed", "summary": "The user talked about the shed.", "topics": [], "facts": []}
    done = run(summary_client, T0 + timedelta(minutes=12))
    assert [d.get("title") for d in done] == ["Shed"]  # the garden one is still waiting
    assert summary_client.get("/v1/brief").json()["last_session"]["summary"] == "The user talked about the shed."


def test_a_summary_of_a_transcript_that_changed_meanwhile_is_dropped(summary_client, llm, database_url, schema):
    import psycopg

    session = uuid4()
    secret = message(session, "user", "my locker code is 4471", 0)
    post(summary_client, secret, message(session, "user", "anyway, the weather", 1), message(session, "assistant", "Sunny.", 2))

    def reply(prompt):
        if "4471" in prompt:
            # The user forgets that message while the model is still writing.
            with psycopg.connect(database_url) as conn:
                conn.execute(f"DELETE FROM {schema}.messages WHERE id = %s", (secret["id"],))
            return {"title": "Locker", "summary": "The locker code is 4471.", "topics": [], "facts": [{"text": "Locker code 4471"}]}
        return {"title": "Weather", "summary": "They talked about the weather.", "topics": [], "facts": []}

    llm.reply = reply
    first = run(summary_client, T0 + timedelta(minutes=11))
    assert first and first[0].get("skipped") == "changed"
    assert summary_client.get("/v1/facts").json()["facts"] == []
    run(summary_client, T0 + timedelta(minutes=12))
    texts = [s["text"] for s in summary_client.get("/v1/summaries").json()["summaries"]]
    assert texts == ["They talked about the weather."]


def test_a_timeline_for_one_character_leaves_out_shared_period_summaries(summary_client, llm):
    session = uuid4()
    summary_client.put(f"/v1/sessions/{session}", json={"started_at": at(0), "agent": "Echo"})
    post(summary_client, message(session, "user", "hello", 0))
    run(summary_client, T0 + timedelta(days=3))
    span = {"from": at(-3600), "to": at(86400 * 3)}
    assert summary_client.get("/v1/timeline", params=span).json()["summaries"]
    assert summary_client.get("/v1/timeline", params={**span, "agent": "Echo"}).json()["summaries"] == []


def test_naming_a_session_marks_it_changed_for_the_mirror(summary_client, llm, database_url, schema):
    import psycopg

    session = uuid4()
    post(summary_client, message(session, "user", "planning the trip to Hobart", 0))
    with psycopg.connect(database_url) as conn:
        before = conn.execute(f"SELECT updated_at FROM {schema}.sessions WHERE id = %s", (session,)).fetchone()[0]
    run(summary_client, T0 + timedelta(minutes=11))
    with psycopg.connect(database_url) as conn:
        title, after = conn.execute(f"SELECT title, updated_at FROM {schema}.sessions WHERE id = %s", (session,)).fetchone()
    assert title == "A chat" and after > before

