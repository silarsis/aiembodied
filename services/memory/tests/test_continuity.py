"""Windowed embeddings, handoff notes, correcting facts, fading facts and who wrote them."""

from uuid import uuid4

import psycopg

from memory_engine import recall
from test_recall import message, post

def long_text():
    """Thirty sentences with no word in common, so one vector of the whole matches none well."""
    return " ".join(f"Item{i} part{i} piece{i} box{i} crate{i} shelf{i}." for i in range(30))


def db(database_url, schema):
    conn = psycopg.connect(database_url, autocommit=True)
    conn.execute(f"SET search_path TO {schema}, public")
    return conn


def put_fact(client, text, **extra):
    fact_id = str(uuid4())
    assert client.put(f"/v1/facts/{fact_id}", json={"text": text, **extra}).status_code == 200
    return fact_id


# --- windowed embeddings ----------------------------------------------------------------------


def test_short_texts_get_no_windows_and_long_ones_overlap_to_the_end():
    assert recall.passages("A short note.") == []
    text = long_text()
    windows = recall.passages(text)
    assert len(windows) > 1
    assert all(len(w) <= recall.PASSAGE_CHARS for w in windows)
    assert windows[-1].endswith(text[-30:])
    # Each window starts on the sentence the one before ended with.
    first_sentences = windows[0].split(". ")
    assert windows[1].startswith(first_sentences[-1].rstrip("."))


def test_a_run_on_text_is_cut_at_word_breaks():
    text = " ".join(["word"] * 400)
    windows = recall.passages(text)
    assert windows and all(len(w) <= recall.PASSAGE_CHARS for w in windows)
    assert all(not w.startswith(" ") and "wo rd" not in w for w in windows)


def test_a_long_turn_is_found_by_what_it_says_near_the_end(client, database_url, schema):
    session = uuid4()
    post(client, message(session, "user", long_text(), 0))
    with db(database_url, schema) as conn:
        parts = conn.execute("SELECT count(*) FROM recall_passages").fetchone()[0]
        pending = conn.execute("SELECT count(*) FROM recall_index WHERE passages_model IS NULL").fetchone()[0]
    assert parts > 1 and pending == 0

    # The last window, asked for as it stands, matches it closely; the whole text doesn't.
    last = recall.passages(long_text())[-1]
    body = client.get("/v1/search", params={"q": last, "mode": "hybrid"}).json()
    assert body["results"][0]["similarity"] > 0.99
    with db(database_url, schema) as conn:
        whole = conn.execute(
            "SELECT 1 - (embedding <=> (SELECT embedding FROM recall_passages ORDER BY part DESC LIMIT 1))"
            " FROM recall_index WHERE kind = 'turn'"
        ).fetchone()[0]
    assert whole < 0.9


def test_changing_a_turn_remakes_its_windows(client, database_url, schema):
    session = uuid4()
    post(client, message(session, "user", long_text(), 0))
    post(client, message(session, "assistant", "Noted, every last one of them.", 1))
    with db(database_url, schema) as conn:
        texts = [r[0] for r in conn.execute("SELECT text FROM recall_passages ORDER BY part").fetchall()]
    assert any("every last one" in t for t in texts)


# --- handoff notes ------------------------------------------------------------------------------


def test_the_newest_note_from_another_conversation_goes_in_the_brief_whole(client):
    earlier, current = uuid4(), uuid4()
    post(client, message(earlier, "user", "let's plan the garden", 0))
    note = "We were halfway through the garden plan. Kevin wants raised beds; ask about the budget. " * 5
    first = client.put(f"/v1/sessions/{earlier}/handoff", json={"text": "draft", "agent": "Echo"}).json()
    again = client.put(
        f"/v1/sessions/{earlier}/handoff", json={"text": note, "agent": "Echo", "model": "qwen-next-flash"}
    ).json()
    assert first["id"] == again["id"]

    brief = client.get("/v1/brief", params={"session_id": str(current)}).json()
    assert brief["handoff"]["text"] == note.strip()
    assert brief["handoff"]["model"] == "qwen-next-flash"
    # The conversation that wrote it doesn't need it back.
    assert client.get("/v1/brief", params={"session_id": str(earlier)}).json()["handoff"] is None
    # It can be searched, too.
    found = client.get("/v1/search", params={"q": "raised beds budget", "kind": "handoff"}).json()["results"]
    assert found and found[0]["kind"] == "handoff"


def test_a_note_for_a_conversation_not_yet_written_creates_it_and_forgetting_removes_it(client, database_url, schema):
    session = uuid4()
    assert client.put(f"/v1/sessions/{session}/handoff", json={"text": "Pick up the car tomorrow."}).status_code == 200
    assert client.delete(f"/v1/sessions/{session}").status_code == 200
    assert client.get("/v1/brief").json()["handoff"] is None
    with db(database_url, schema) as conn:
        tombstones = conn.execute("SELECT count(*) FROM tombstones WHERE table_name = 'handoffs'").fetchone()[0]
        indexed = conn.execute("SELECT count(*) FROM recall_index WHERE kind = 'handoff'").fetchone()[0]
    assert tombstones == 1 and indexed == 0


# --- correcting facts -------------------------------------------------------------------------


def test_a_fact_is_replaced_by_id_keeping_its_subject_and_the_old_one(client):
    old = put_fact(client, "Kevin drives a blue Corolla", subject="car", model="qwen-next-flash")
    result = client.post(
        "/v1/facts/correct",
        json={"id": old, "action": "replace", "text": "Kevin drives a red Mazda", "model": "gpt-4.1-mini"},
    ).json()
    assert result["status"] == "replaced"
    facts = {f["id"]: f for f in client.get("/v1/facts", params={"status": "all"}).json()["facts"]}
    new = facts[result["replacement"]["id"]]
    assert new["subject"] == "car" and new["supersedes"] == old and new["model"] == "gpt-4.1-mini"
    assert facts[old]["status"] == "superseded" and facts[old]["model"] == "qwen-next-flash"


def test_a_fact_is_found_by_what_it_said_or_the_candidates_come_back(client):
    put_fact(client, "Kevin's dog is called Biscuit")
    put_fact(client, "Kevin's cat is called Pickle")
    clear = client.post("/v1/facts/correct", json={"about": "dog called Biscuit", "action": "retract"}).json()
    assert clear["status"] == "retracted" and "Biscuit" in clear["fact"]["text"]
    assert [f["text"] for f in client.get("/v1/facts").json()["facts"]] == ["Kevin's cat is called Pickle"]

    put_fact(client, "Kevin's cat is called Mango")
    unclear = client.post("/v1/facts/correct", json={"about": "Kevin's cat is called", "action": "retract"}).json()
    assert unclear["status"] == "ambiguous" and len(unclear["candidates"]) == 2
    nothing = client.post("/v1/facts/correct", json={"about": "submarine", "action": "retract"}).json()
    assert nothing["status"] == "not_found"


def test_the_agent_cant_change_a_pinned_fact_or_a_conversation(client):
    pinned = put_fact(client, "Kevin's partner is Erika", pinned=True)
    refused = client.post("/v1/facts/correct", json={"id": pinned, "action": "retract"}).json()
    assert refused["status"] == "pinned"
    by_user = client.post("/v1/facts/correct", json={"id": pinned, "action": "retract", "author": "user"}).json()
    assert by_user["status"] == "retracted"

    session = uuid4()
    post(client, message(session, "user", "the greenhouse door is broken", 0))
    turn = client.get("/v1/search", params={"q": "greenhouse"}).json()["results"][0]["id"]
    assert client.post("/v1/facts/correct", json={"id": turn, "action": "retract"}).json()["status"] == "not_a_fact"
    assert client.post("/v1/facts/correct", json={"action": "retract"}).status_code == 400


# --- fading -------------------------------------------------------------------------------------


def age(database_url, schema, fact_id, days):
    with db(database_url, schema) as conn:
        conn.execute("UPDATE facts SET created_at = now() - make_interval(days => %s) WHERE id = %s", (days, fact_id))


def test_unused_facts_fade_out_of_the_brief_and_recalled_ones_come_back(client, database_url, schema):
    old = put_fact(client, "Kevin once owned a canoe")
    put_fact(client, "Kevin grows tomatoes")
    age(database_url, schema, old, 120)
    pinned = put_fact(client, "Kevin's partner is Erika", pinned=True)
    age(database_url, schema, pinned, 400)

    brief = client.get("/v1/brief").json()["facts"]
    assert [f["text"] for f in brief] == ["Kevin's partner is Erika", "Kevin grows tomatoes", "Kevin once owned a canoe"]
    listed = {f["text"]: f for f in client.get("/v1/facts").json()["facts"]}
    assert listed["Kevin once owned a canoe"]["accessibility"] < 0.1
    assert listed["Kevin's partner is Erika"]["accessibility"] == 1.0

    # Looking it up in the Memory panel changes nothing; the agent recalling it does.
    client.get("/v1/search", params={"q": "canoe"})
    assert client.get("/v1/brief").json()["facts"][-1]["text"] == "Kevin once owned a canoe"
    session = str(uuid4())
    client.get("/v1/search", params={"q": "canoe", "touch": "true", "session_id": session})
    client.get("/v1/search", params={"q": "canoe", "touch": "true", "session_id": session})
    canoe = next(f for f in client.get("/v1/facts").json()["facts"] if "canoe" in f["text"])
    assert canoe["recall_count"] == 1  # once per conversation
    assert canoe["last_recalled_at"] is not None and canoe["accessibility"] > 0.99


def test_auto_recall_and_opening_a_fact_count_as_using_it(client):
    fact_id = put_fact(client, "Kevin's greenhouse tomatoes are planted in raised beds")
    session = str(uuid4())
    client.post(
        "/v1/recall",
        json={"text": "how are the greenhouse tomatoes planted", "session_id": session, "min_similarity": 0.3},
    )
    other = str(uuid4())
    client.get(f"/v1/memories/{fact_id}", params={"touch": "true", "session_id": other})
    counted = next(f for f in client.get("/v1/facts").json()["facts"] if f["id"] == fact_id)
    assert counted["recall_count"] == 2


def test_the_extractor_signs_facts_with_its_model(summary_client, llm):
    from datetime import datetime, timezone

    llm.reply = lambda prompt: {
        "title": "Cars",
        "summary": "They talked about cars.",
        "topics": ["car"],
        "facts": [{"text": "Kevin drives a red Mazda", "subject": "car"}],
    }
    session = uuid4()
    post(summary_client, message(session, "user", "I drive a red Mazda now", 0))
    summary_client.post("/v1/summaries/run", json={"now": datetime(2026, 11, 4, tzinfo=timezone.utc).isoformat()})
    facts = summary_client.get("/v1/facts").json()["facts"]
    assert facts and facts[0]["author"] == "extractor" and facts[0]["model"] == "fake-llm"
