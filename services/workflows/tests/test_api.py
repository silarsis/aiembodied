from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
from aiembodied_workflows.api import create_app
from aiembodied_workflows.service import Service
from aiembodied_workflows.settings import Settings
from fakes import FakeClient, FakeMemory

GOOD_DEF = {"inputs": {}, "steps": [{"say": "hello"}]}


def make(token=None, agent_life=True):
    settings = Settings(api_token=token, agent_life=agent_life)
    mem = FakeMemory()
    svc = Service(settings, memory=mem)
    svc.client = FakeClient()
    app = create_app(settings, svc)
    http = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={"Authorization": f"Bearer {token}"} if token else {},
    )
    return http, svc, mem, svc.client


async def test_health_reports_temporal_and_agents():
    http, svc, *_ = make()
    r = await http.get("/health")
    assert r.json() == {
        "ok": True,
        "version": "0.1.0",
        "temporal": True,
        "namespace": "aiembodied",
        "agentLife": True,
        "agents": [],
    }
    svc.client = None
    assert (await http.get("/health")).json()["temporal"] is False


async def test_token_guard():
    http, *_ = make(token="s3cret")
    assert (await http.get("/health")).status_code == 200
    anon = httpx.AsyncClient(transport=http._transport, base_url="http://test")
    assert (await anon.get("/v1/flows")).status_code == 401
    assert (await http.get("/v1/flows")).status_code == 200


async def test_put_agents_starts_and_stops_life_workflows():
    http, svc, mem, client = make()
    client.listed = [SimpleNamespace(id="life:ghost")]
    client.running["life:ghost"] = "AgentLife"
    r = await http.put("/v1/agents", json={"agents": [{"id": "echo", "name": "Echo"}, {"id": "sage", "name": "Sage"}]})
    assert r.json() == {"agents": ["echo", "sage"], "started": ["echo", "sage"], "stopped": ["ghost"]}
    assert [s["id"] for s in client.started] == ["life:echo", "life:sage"]
    assert client.started[0]["arg"].name == "Echo" and client.started[0]["queue"] == "agents"
    assert client.cancelled == ["life:ghost"]
    assert (await http.get("/health")).json()["agents"] == ["echo", "sage"]
    # a second call starts nothing new
    client.listed = [SimpleNamespace(id="life:echo"), SimpleNamespace(id="life:sage")]
    r = await http.put("/v1/agents", json={"agents": [{"id": "echo"}, {"id": "sage"}]})
    assert r.json()["started"] == [] and r.json()["stopped"] == []


async def test_put_agents_with_life_off_starts_nothing():
    http, svc, mem, client = make(agent_life=False)
    r = await http.put("/v1/agents", json={"agents": [{"id": "echo"}]})
    assert r.json() == {"agents": ["echo"], "started": [], "stopped": []} and client.started == []


async def test_life_query_and_signals():
    http, svc, mem, client = make()
    client.running["life:echo"] = "AgentLife"
    client.queries[("life:echo", "state")] = {"awake": True, "awakeSeconds": 5}
    assert (await http.get("/v1/agents/echo/life")).json() == {"awake": True, "awakeSeconds": 5}
    assert (await http.post("/v1/agents/echo/sleep", json={"reason": "tired"})).status_code == 200
    assert (await http.post("/v1/agents/echo/wake")).status_code == 200
    assert client.signals == [("life:echo", "sleep", ("tired",)), ("life:echo", "wake", ())]
    assert (await http.post("/v1/agents/nobody/wake")).status_code == 404


async def test_503_when_temporal_is_down():
    http, svc, *_ = make()
    svc.client = None
    r = await http.put("/v1/agents", json={"agents": [{"id": "echo"}]})
    assert r.status_code == 503 and "Temporal" in r.json()["detail"]


async def test_reminder_creates_intention_and_workflow():
    http, svc, mem, client = make()
    r = await http.post(
        "/v1/reminders", json={"avatarId": "echo", "inSeconds": 600, "text": "Take the bins out", "alarm": True}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["workflowId"].startswith("remind:") and body["intentionId"] and body["dueAt"].endswith("Z")
    row = mem.created[0]
    assert row["kind"] == "reminder" and row["template"] == "reminder" and row["workflow_id"] == body["workflowId"]
    assert row["params"] == {"text": "Take the bins out", "alarm": True} and row["due_at"] == body["dueAt"]
    start = client.started[0]
    assert (
        start["name"] == "Reminder" and start["arg"].alarm is True and start["arg"].intention_id == body["intentionId"]
    )


async def test_reminder_validation():
    http, *_ = make()
    assert (await http.post("/v1/reminders", json={"avatarId": "echo", "text": "x"})).status_code == 422
    assert (await http.post("/v1/reminders", json={"avatarId": "echo", "inSeconds": 5, "text": " "})).status_code == 422
    assert (await http.post("/v1/reminders", json={"avatarId": "echo", "at": "soon", "text": "x"})).status_code == 422
    assert (await http.post("/v1/reminders", json={"text": "x"})).status_code == 422


async def test_reminder_still_starts_when_memory_is_down():
    http, svc, mem, client = make()
    mem.fail = True
    r = await http.post("/v1/reminders", json={"avatarId": "echo", "inSeconds": 60, "text": "x"})
    assert r.status_code == 200 and r.json()["intentionId"] is None and client.started


async def test_wakeup():
    http, svc, mem, client = make()
    r = await http.post(
        "/v1/wakeups", json={"avatarId": "sage", "at": "2099-01-01T00:00:00Z", "note": "check the kiln"}
    )
    assert r.json()["dueAt"] == "2099-01-01T00:00:00.000Z" and r.json()["workflowId"].startswith("wake:")
    assert client.started[0]["name"] == "WakeMe" and mem.created[0]["kind"] == "wakeup"


async def test_watch_created_and_validated():
    http, svc, mem, client = make()
    good = {
        "avatarId": "echo",
        "condition": {"kind": "entity", "entityId": "binary_sensor.door", "state": "on"},
        "then": {"say": "The door opened"},
        "untilHours": 5000,
    }
    r = await http.post("/v1/watches", json=good)
    assert r.status_code == 200 and r.json()["workflowId"].startswith("watch:")
    inp = client.started[0]["arg"]
    until = datetime.fromisoformat(inp.until_at.replace("Z", "+00:00"))
    assert 719 < (until - datetime.now(timezone.utc)).total_seconds() / 3600 <= 720  # clamped to 30 days
    assert mem.created[0]["template"] == "watch" and mem.created[0]["params"]["untilAt"] == inp.until_at
    assert svc.index.for_entity("binary_sensor.door")
    bad = await http.post("/v1/watches", json={**good, "condition": {"kind": "entity"}})
    assert bad.status_code == 422 and bad.json()["detail"]["errors"]
    assert (await http.post("/v1/watches", json={**good, "then": {}})).status_code == 422


async def test_flow_put_validates_then_saves_and_schedules():
    http, svc, mem, client = make()
    bad = await http.put(
        "/v1/flows/echo/morning",
        json={"description": "x", "trigger": {"kind": "manual"}, "definition": {"steps": [{"wait": {"minutes": 1}}]}},
    )
    assert bad.status_code == 422 and bad.json()["detail"]["errors"][0].startswith("steps[0].wait")
    assert mem.put == []
    r = await http.put(
        "/v1/flows/echo/morning",
        json={
            "description": "Weekday weather",
            "definition": GOOD_DEF,
            "trigger": {"kind": "schedule", "cron": "30 7 * * 1-5"},
        },
    )
    assert r.status_code == 200 and r.json()["version"] == 1 and r.json()["triggerApplied"] is True
    assert mem.put[0][2]["trigger"]["cron"] == "30 7 * * 1-5"
    assert "sched:echo:morning" in client.schedules
    sched = client.schedules["sched:echo:morning"]
    assert sched.spec.cron_expressions == ["30 7 * * 1-5"]
    assert sched.policy.overlap.name == "SKIP" and sched.policy.catchup_window.total_seconds() == 600
    assert sched.action.workflow == "AgentFlow" and sched.action.task_queue == "agents"
    # saving again updates the schedule
    await http.put(
        "/v1/flows/echo/morning", json={"definition": GOOD_DEF, "trigger": {"kind": "schedule", "everyMinutes": 60}}
    )
    assert ("update", "sched:echo:morning") in client.schedule_log
    assert client.schedules["sched:echo:morning"].spec.intervals[0].every.total_seconds() == 3600


async def test_flow_trigger_switching():
    http, svc, mem, client = make()
    await http.put(
        "/v1/flows/echo/door",
        json={
            "definition": GOOD_DEF,
            "trigger": {
                "kind": "watch",
                "condition": {"kind": "entity", "entityId": "binary_sensor.door", "state": "on"},
            },
        },
    )
    watcher = client.started[-1]
    assert watcher["id"] == "flowwatch:echo:door" and watcher["arg"].flow_name == "door"
    # a manual trigger removes the watcher and any schedule
    await http.put("/v1/flows/echo/door", json={"definition": GOOD_DEF, "trigger": {"kind": "manual"}})
    assert "flowwatch:echo:door" in client.cancelled
    # disabling removes a schedule
    await http.put(
        "/v1/flows/echo/x", json={"definition": GOOD_DEF, "trigger": {"kind": "schedule", "everyMinutes": 5}}
    )
    await http.put(
        "/v1/flows/echo/x",
        json={"definition": GOOD_DEF, "trigger": {"kind": "schedule", "everyMinutes": 5}, "enabled": False},
    )
    assert ("delete", "sched:echo:x") in client.schedule_log


async def test_flow_saved_even_when_temporal_down():
    http, svc, mem, client = make()
    svc.client = None
    r = await http.put(
        "/v1/flows/echo/a", json={"definition": GOOD_DEF, "trigger": {"kind": "schedule", "everyMinutes": 5}}
    )
    assert r.status_code == 200 and r.json()["triggerApplied"] is False and mem.put


async def test_flow_run_and_delete_and_get():
    http, svc, mem, client = make()
    assert (await http.post("/v1/flows/echo/nope/run", json={})).status_code == 404
    mem.flows_rows.append(
        {"avatar_id": "echo", "name": "morning", "description": "d", "trigger": {"kind": "manual"}, "enabled": True}
    )
    r = await http.post("/v1/flows/echo/morning/run", json={"inputs": {"city": "Paris"}})
    wid = r.json()["workflowId"]
    assert wid.startswith("flow:echo:morning:")
    s = client.started[-1]
    assert s["arg"].inputs == {"city": "Paris"} and s["arg"].source == "manual"
    assert (await http.get("/v1/flows?avatarId=echo")).json()["flows"][0]["name"] == "morning"
    assert (await http.get("/v1/flows/echo/morning")).json()["description"] == "d"
    assert (await http.get("/v1/flows/echo/none")).status_code == 404
    assert (await http.delete("/v1/flows/echo/morning")).json() == {"ok": True}
    assert mem.deleted == [("echo", "morning")]


async def test_intention_is_pure_memory():
    http, svc, mem, client = make()
    r = await http.post(
        "/v1/intentions",
        json={"avatarId": "echo", "kind": "goal", "text": "learn piano", "dueAt": "2027-01-01T00:00:00Z"},
    )
    assert r.status_code == 200 and client.started == []
    assert mem.created[0] == {
        "avatar_id": "echo",
        "kind": "goal",
        "text": "learn piano",
        "status": "open",
        "due_at": "2027-01-01T00:00:00Z",
    }
    assert (
        await http.post("/v1/intentions", json={"avatarId": "echo", "kind": "watch", "text": "x"})
    ).status_code == 422


async def test_plans_listing_signal_and_drop():
    http, svc, mem, client = make()
    mem.intentions_rows = [
        {
            "id": "i1",
            "avatar_id": "echo",
            "kind": "reminder",
            "text": "bins",
            "workflow_id": "remind:1",
            "due_at": "2026-11-26T10:00:00.000Z",
        }
    ]
    mem.flows_rows = [
        {"avatar_id": "echo", "name": "morning", "trigger": {"kind": "manual"}, "enabled": True, "last_run_at": "t"}
    ]
    client.listed = [
        SimpleNamespace(
            id="remind:1",
            typed_search_attributes=None,
            workflow_type="Reminder",
            start_time=datetime(2026, 11, 26, 9, 0, tzinfo=timezone.utc),
        )
    ]
    client.running["remind:1"] = "Reminder"
    plans = (await http.get("/v1/plans?avatarId=echo")).json()
    assert plans["workflows"] == [
        {
            "workflowId": "remind:1",
            "purpose": "Reminder",
            "title": "bins",
            "status": "running",
            "startedAt": "2026-11-26T09:00:00.000Z",
            "nextAt": "2026-11-26T10:00:00.000Z",
        }
    ]
    assert plans["intentions"][0]["id"] == "i1" and plans["flows"] == [
        {"name": "morning", "trigger": {"kind": "manual"}, "enabled": True, "lastRun": "t"}
    ]

    assert (
        await http.post("/v1/plans/remind:1/signal", json={"signal": "snooze", "args": {"seconds": 300}})
    ).status_code == 200
    assert (await http.post("/v1/plans/remind:1/signal", json={"signal": "pause"})).status_code == 200
    assert client.signals == [("remind:1", "snooze", ({"seconds": 300},)), ("remind:1", "pause", ())]
    assert (await http.post("/v1/plans/remind:1/signal", json={"signal": "explode"})).status_code == 422
    assert (await http.post("/v1/plans/remind:zzz/signal", json={"signal": "pause"})).status_code == 404

    assert (await http.delete("/v1/plans/remind:1?why=not%20needed")).status_code == 200
    assert client.cancelled == ["remind:1"] and mem.patched == [("i1", {"status": "dropped", "outcome": "not needed"})]
    assert (await http.delete("/v1/plans/remind:1")).status_code == 404


async def test_schedules_as_plans():
    http, svc, mem, client = make()
    client.schedules["sched:echo:morning"] = object()
    assert (await http.post("/v1/plans/sched:echo:morning/signal", json={"signal": "pause"})).status_code == 200
    assert (await http.post("/v1/plans/sched:echo:morning/signal", json={"signal": "snooze"})).status_code == 400
    assert (await http.delete("/v1/plans/sched:echo:morning")).status_code == 200
    assert ("pause", "sched:echo:morning") in client.schedule_log and (
        "delete",
        "sched:echo:morning",
    ) in client.schedule_log


async def test_reconcile_restarts_missing_workflows_and_triggers():
    http, svc, mem, client = make()
    mem.intentions_rows = [
        {
            "id": "a",
            "avatar_id": "echo",
            "kind": "reminder",
            "text": "bins",
            "workflow_id": "remind:a",
            "template": "reminder",
            "params": {"text": "bins", "alarm": False},
            "due_at": "2026-11-25T08:00:00.000Z",
        },
        {
            "id": "b",
            "avatar_id": "echo",
            "kind": "watch",
            "text": "w",
            "workflow_id": "watch:b",
            "template": "watch",
            "params": {
                "condition": {"kind": "entity", "entityId": "x.y", "state": "on"},
                "then": {"say": "hi"},
                "untilAt": "2099-01-01T00:00:00.000Z",
            },
        },
        {
            "id": "c",
            "avatar_id": "echo",
            "kind": "reminder",
            "text": "alive",
            "workflow_id": "remind:c",
            "template": "reminder",
            "params": {},
        },
        {"id": "d", "avatar_id": "echo", "kind": "goal", "text": "no workflow"},
    ]
    client.running["remind:c"] = "Reminder"
    mem.flows_rows = [
        {
            "avatar_id": "echo",
            "name": "sched-flow",
            "trigger": {"kind": "schedule", "everyMinutes": 30},
            "enabled": True,
        },
        {
            "avatar_id": "echo",
            "name": "watch-flow",
            "trigger": {"kind": "watch", "condition": {"kind": "service", "url": "http://x"}},
            "enabled": True,
        },
        {"avatar_id": "echo", "name": "off", "trigger": {"kind": "schedule", "everyMinutes": 30}, "enabled": False},
    ]
    out = await svc.reconcile()
    assert out["restarted"] == ["remind:a", "watch:b"]
    assert [s["id"] for s in client.started] == ["remind:a", "watch:b", "flowwatch:echo:watch-flow"]
    assert list(client.schedules) == ["sched:echo:sched-flow"]
    again = await svc.reconcile()  # everything exists now
    assert again["restarted"] == []
