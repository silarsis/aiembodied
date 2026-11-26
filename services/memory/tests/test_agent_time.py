"""Intentions, agent-built flows and sleep state: the memory side of the agents' sense of time."""

from uuid import uuid4

import psycopg


def db(database_url, schema):
    conn = psycopg.connect(database_url, autocommit=True)
    conn.execute(f"SET search_path TO {schema}, public")
    return conn


def intention(client, text, **extra):
    body = {"avatar_id": "echo", "kind": "intention", "text": text, **extra}
    response = client.post("/v1/intentions", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_an_intention_is_created_listed_and_changed(client):
    row = intention(client, "Ask Kevin about the budget", why="He mentioned it twice", due_at="2030-01-01T09:00:00Z")
    assert row["status"] == "open" and row["why"] == "He mentioned it twice" and row["parent_id"] is None
    assert row["due_at"].startswith("2030-01-01T09:00:00")

    patched = client.patch(
        f"/v1/intentions/{row['id']}", json={"status": "waiting", "workflow_id": "wf-1", "params": {"a": 1}}
    ).json()
    assert patched["status"] == "waiting" and patched["workflow_id"] == "wf-1" and patched["params"] == {"a": 1}
    assert patched["text"] == row["text"] and patched["due_at"] == row["due_at"]

    # null clears a field that may be empty.
    assert client.patch(f"/v1/intentions/{row['id']}", json={"due_at": None}).json()["due_at"] is None

    assert [i["id"] for i in client.get("/v1/intentions", params={"avatar_id": "echo"}).json()["intentions"]] == [
        row["id"]
    ]
    assert client.get("/v1/intentions", params={"avatar_id": "other"}).json()["intentions"] == []

    done = client.patch(f"/v1/intentions/{row['id']}", json={"status": "done", "outcome": "He said 500"}).json()
    assert done["outcome"] == "He said 500"
    assert client.get("/v1/intentions").json()["intentions"] == []
    assert len(client.get("/v1/intentions", params={"status": "done"}).json()["intentions"]) == 1
    assert len(client.get("/v1/intentions", params={"status": "all"}).json()["intentions"]) == 1


def test_intentions_filter_by_kind_and_reject_bad_input(client):
    intention(client, "Be a better gardener", kind="goal")
    intention(client, "Water the plants", kind="reminder")
    found = client.get("/v1/intentions", params={"kind": "goal"}).json()["intentions"]
    assert [i["text"] for i in found] == ["Be a better gardener"]
    assert client.post("/v1/intentions", json={"avatar_id": "echo", "kind": "hope", "text": "x"}).status_code == 422
    missing = {"avatar_id": "echo", "kind": "goal", "text": "x", "parent_id": str(uuid4())}
    assert client.post("/v1/intentions", json=missing).status_code == 404
    assert client.patch(f"/v1/intentions/{uuid4()}", json={"status": "done"}).status_code == 404


def test_an_intention_can_have_a_parent(client):
    goal = intention(client, "Learn the piano", kind="goal")
    child = intention(client, "Practise scales", parent_id=goal["id"])
    assert child["parent_id"] == goal["id"]


def test_a_flow_is_saved_with_versions_and_deleted_softly(client, database_url, schema):
    definition = {"inputs": {"city": "Singapore"}, "steps": [{"say": "Good morning"}]}
    first = client.put("/v1/flows/echo/morning", json={"description": "Greet", "definition": definition}).json()
    assert first["version"] == 1 and first["enabled"] is True and first["trigger"] == {"kind": "manual"}

    trigger = {"kind": "schedule", "cron": "30 7 * * 1-5"}
    second = client.put(
        "/v1/flows/echo/morning",
        json={"description": "Greet", "definition": {"steps": [{"say": "Hi"}]}, "trigger": trigger},
    ).json()
    assert (
        second["version"] == 2 and second["trigger"] == trigger and second["definition"] == {"steps": [{"say": "Hi"}]}
    )
    with db(database_url, schema) as conn:
        saved = conn.execute("SELECT version FROM agent_flow_versions ORDER BY version").fetchall()
    assert saved == [(1,), (2,)]

    assert client.get("/v1/flows/echo/morning").json()["version"] == 2
    assert client.get("/v1/flows/echo/nothing").status_code == 404
    assert client.get("/v1/flows/echo/Bad Name").status_code == 422

    patched = client.patch(
        "/v1/flows/echo/morning", json={"last_run_at": "2030-01-01T07:30:00Z", "last_outcome": "ok"}
    ).json()
    assert patched["last_outcome"] == "ok" and patched["version"] == 2 and patched["enabled"] is True
    assert client.patch("/v1/flows/echo/morning", json={"enabled": False}).json()["enabled"] is False
    assert client.get("/v1/flows", params={"avatar_id": "echo"}).json()["flows"] == []
    assert len(client.get("/v1/flows", params={"avatar_id": "echo", "include_disabled": True}).json()["flows"]) == 1

    assert client.delete("/v1/flows/echo/morning").json() == {"deleted": "morning"}
    assert client.delete("/v1/flows/echo/morning").status_code == 404
    assert client.get("/v1/flows/echo/morning").status_code == 404
    assert client.get("/v1/flows", params={"include_disabled": True}).json()["flows"] == []
    with db(database_url, schema) as conn:
        row = conn.execute("SELECT enabled, deleted_at IS NOT NULL FROM agent_flows").fetchone()
    assert row == (False, True)

    # Saving it again brings it back as version 3.
    again = client.put("/v1/flows/echo/morning", json={"definition": definition}).json()
    assert again["version"] == 3 and again["enabled"] is True and again["deleted_at"] is None


def test_agent_state_starts_empty_and_keeps_fields_not_sent(client):
    assert client.get("/v1/agents/echo/state").status_code == 404
    first = client.put("/v1/agents/echo/state", json={"asleep": False, "awake_since": "2030-01-01T06:00:00Z"}).json()
    assert first["asleep"] is False and first["awake_since"].startswith("2030-01-01T06:00:00")
    asleep = client.put(
        "/v1/agents/echo/state", json={"asleep": True, "last_sleep_at": "2030-01-02T06:00:00Z", "awake_since": None}
    ).json()
    assert asleep["asleep"] is True and asleep["awake_since"] is None and asleep["last_sleep_at"]
    woke = client.put("/v1/agents/echo/state", json={"asleep": False, "last_wake_at": "2030-01-02T14:00:00Z"}).json()
    assert woke["last_sleep_at"] == asleep["last_sleep_at"] and woke["last_wake_at"]
    assert client.get("/v1/agents/echo/state").json() == woke


def test_the_brief_lists_an_avatars_intentions_flows_and_state(client):
    intention(client, "Call the plumber", kind="reminder", due_at="2030-01-03T09:00:00Z")
    intention(client, "Sooner thing", kind="intention", due_at="2030-01-02T09:00:00Z")
    intention(client, "No date", kind="promise")
    intention(client, "Grow tomatoes", kind="goal")
    intention(client, "Already done", status="done")
    intention(client, "Someone else's", avatar_id="nova")
    client.put("/v1/flows/echo/morning", json={"description": "Greet", "definition": {"steps": []}})
    client.put("/v1/flows/echo/off", json={"definition": {"steps": []}, "enabled": False})
    client.put("/v1/flows/nova/other", json={"definition": {"steps": []}})
    client.put("/v1/agents/echo/state", json={"asleep": True})

    brief = client.get("/v1/brief", params={"avatar_id": "echo"}).json()
    assert [i["text"] for i in brief["intentions"]] == ["Grow tomatoes", "Sooner thing", "Call the plumber", "No date"]
    assert set(brief["intentions"][0]) >= {"id", "kind", "text", "due_at", "status", "workflow_id"}
    assert [f["name"] for f in brief["flows"]] == ["morning"]
    assert brief["flows"][0]["trigger"] == {"kind": "manual"} and brief["flows"][0]["description"] == "Greet"
    assert brief["agent_state"]["asleep"] is True

    # `agent` is used as the avatar id (lower-cased) when avatar_id is not given.
    by_name = client.get("/v1/brief", params={"agent": "Echo"}).json()
    assert [i["text"] for i in by_name["intentions"]] == [i["text"] for i in brief["intentions"]]
    assert by_name["agent"] == "Echo"

    everyone = client.get("/v1/brief").json()
    assert len(everyone["intentions"]) == 5 and {f["name"] for f in everyone["flows"]} == {"morning", "other"}
    assert everyone["agent_state"] is None
    assert client.get("/v1/brief", params={"avatar_id": "nobody"}).json()["agent_state"] is None
