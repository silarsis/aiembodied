"""Workflow tests against Temporal's time-skipping test server. Skipped when the server cannot be started.

The activities are fakes with the real names, so only the workflow logic runs."""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

from temporalio import activity
from temporalio.exceptions import ApplicationError
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner  # noqa: F401

from aiembodied_workflows.registry import WORKFLOWS, sandbox_runner
from aiembodied_workflows.timeutil import iso_z
from aiembodied_workflows.wf.flow import FlowInput
from aiembodied_workflows.wf.life import LifeInput
from aiembodied_workflows.wf.simple import DueInput
from aiembodied_workflows.wf.watch import WatchInput

CTX = {"avatarName": "Echo", "place": "lounge", "localTime": "2026-11-26T14:00:00+08:00", "hour": 14, "voicePhase": "idle",
       "conversationActive": False, "secondsSinceKevinSpoke": 3600, "secondsSinceAvatarSpoke": 3600,
       "secondsSinceFaceSeen": 3600, "doNotDisturb": False, "pursuitRunning": False, "pursuitOffers": [],
       "restlessness": None, "quietSaves": [], "asleep": False}


class FakeApp:
    """Stands in for every activity. `acts` records (kind, args); `replies` maps kind -> callable(args) -> dict."""

    def __init__(self):
        self.acts: list[tuple[str, dict]] = []
        self.replies: dict = {"context": lambda a: dict(CTX)}
        self.patched: list[dict] = []
        self.flow_patches: list[dict] = []
        self.flow_row: dict | None = None
        self.offline = False
        self.journal_events: list[dict] = []

    def kinds(self, kind):
        return [a for k, a in self.acts if k == kind]

    def activities(self):
        app = self

        @activity.defn(name="app_act")
        async def app_act(req: dict) -> dict:
            if app.offline:
                raise ApplicationError("app is closed", type="AppOffline", non_retryable=True)
            app.acts.append((req["kind"], req["args"]))
            fn = app.replies.get(req["kind"])
            return fn(req["args"]) if fn else {}

        @activity.defn(name="journal")
        async def journal(event: dict) -> None:
            app.journal_events.append(event)

        @activity.defn(name="mem_patch_intention")
        async def mem_patch_intention(req: dict) -> None:
            app.patched.append(req)

        @activity.defn(name="mem_decision_context")
        async def mem_decision_context(avatar: str) -> dict:
            return {"intentions": [], "flows": [], "agentState": None}

        @activity.defn(name="mem_run_summaries")
        async def mem_run_summaries(_: None) -> None:
            return None

        @activity.defn(name="mem_put_agent_state")
        async def mem_put_agent_state(req: dict) -> None:
            return None

        @activity.defn(name="mem_get_flow")
        async def mem_get_flow(req: dict) -> dict | None:
            return app.flow_row

        @activity.defn(name="mem_patch_flow")
        async def mem_patch_flow(req: dict) -> None:
            app.flow_patches.append(req["fields"])

        @activity.defn(name="mem_home_entities")
        async def mem_home_entities(_: None) -> list:
            return []

        @activity.defn(name="mem_create_intention")
        async def mem_create_intention(row: dict) -> dict:
            return row

        @activity.defn(name="mem_search")
        async def mem_search(req: dict) -> str:
            return "remembered"

        @activity.defn(name="mem_put_fact")
        async def mem_put_fact(req: dict) -> None:
            return None

        @activity.defn(name="web_search")
        async def web_search(q: str) -> list:
            return []

        @activity.defn(name="probe_url")
        async def probe_url(u: str) -> int:
            return 200

        @activity.defn(name="flow_runaway")
        async def flow_runaway(req: dict) -> None:
            return None

        return [app_act, journal, mem_patch_intention, mem_decision_context, mem_run_summaries, mem_put_agent_state,
                mem_get_flow, mem_patch_flow, mem_home_entities, mem_create_intention, mem_search, mem_put_fact,
                web_search, probe_url, flow_runaway]


class Harness:
    def __init__(self, env, app):
        self.env, self.app = env, app
        self.client = env.client

    async def __aenter__(self):
        acts = self.app.activities()
        self.workers = [
            Worker(self.client, task_queue="agents", workflows=WORKFLOWS, activities=acts, workflow_runner=sandbox_runner()),
            Worker(self.client, task_queue="think", activities=[a for a in acts if a.__temporal_activity_definition.name == "app_act"]),
        ]
        self.tasks = [asyncio.create_task(w.run()) for w in self.workers]
        await asyncio.sleep(0.2)
        return self

    async def __aexit__(self, *exc):
        for w in self.workers:
            await w.shutdown()
        await asyncio.gather(*self.tasks, return_exceptions=True)


def wid(prefix):
    return f"{prefix}:{uuid.uuid4()}"


async def test_reminder_fires_and_says(temporal_env):
    app = FakeApp()
    async with Harness(temporal_env, app) as h:
        due = datetime.now(timezone.utc) + timedelta(hours=2)
        out = await h.client.execute_workflow(
            "Reminder", DueInput("echo", "take the bins out", iso_z(due), True, "int-1", {}), id=wid("remind"),
            task_queue="agents", result_type=str)
    assert out == "said"
    say = app.kinds("say")[0]
    assert say["text"] == "Reminder: take the bins out" and say["urgent"] is True
    assert app.patched == [{"id": "int-1", "fields": {"status": "done", "outcome": "said"}}]
    assert any(e["kind"] == "fired" for e in app.journal_events)


async def test_late_reminder_mentions_when_it_was_due(temporal_env):
    app = FakeApp()
    async with Harness(temporal_env, app) as h:
        due = datetime.now(timezone.utc) - timedelta(hours=1)
        await h.client.execute_workflow("Reminder", DueInput("echo", "call mum", iso_z(due), False, None, {"timezone": "UTC"}),
                                        id=wid("remind"), task_queue="agents", result_type=str)
    assert "(this was due at " in app.kinds("say")[0]["text"]


async def test_reminder_waits_for_the_app(temporal_env):
    app = FakeApp()
    app.offline = True
    async with Harness(temporal_env, app) as h:
        handle = await h.client.start_workflow(
            "Reminder", DueInput("echo", "x", iso_z(datetime.now(timezone.utc) + timedelta(minutes=1)), False, None, {}),
            id=wid("remind"), task_queue="agents")
        await temporal_env.sleep(3600)
        assert app.kinds("say") == []  # still waiting
        app.offline = False
        await temporal_env.sleep(120)
        assert await handle.result() == "said"


async def test_life_sleeps_after_too_many_awake_hours_and_wakes_on_interaction(temporal_env):
    app = FakeApp()
    config = {"sleepAfterHours": 0.05, "sleepHours": 7, "quietHours": "22-7"}  # 180 s awake
    async with Harness(temporal_env, app) as h:
        handle = await h.client.start_workflow("AgentLife", LifeInput("echo", "Echo", config), id=wid("life"),
                                               task_queue="agents")
        await temporal_env.sleep(900)
        state = await handle.query("state")
        assert state["awake"] is False and state["awakeSeconds"] > 180
        assert {"asleep": True, "reason": "awake more than 0.05 hours"} in app.kinds("sleep_state")
        await handle.signal("interaction")
        await asyncio.sleep(0.3)
        state = await handle.query("state")
        assert state["awake"] is True and state["awakeSeconds"] == 0
        assert app.kinds("sleep_state")[-1]["asleep"] is False
        await handle.terminate()


async def test_life_sleeps_on_signal_and_wakes_after_sleep_hours(temporal_env):
    app = FakeApp()
    async with Harness(temporal_env, app) as h:
        handle = await h.client.start_workflow("AgentLife", LifeInput("echo", "Echo", {"sleepHours": 1}), id=wid("life"),
                                               task_queue="agents")
        await temporal_env.sleep(120)
        await handle.signal("sleep", "bedtime")
        await asyncio.sleep(0.3)
        assert (await handle.query("state"))["awake"] is False
        await temporal_env.sleep(3 * 3600)
        assert (await handle.query("state"))["awake"] is True
        await handle.terminate()


async def test_life_does_not_count_awake_time_while_the_app_is_closed(temporal_env):
    app = FakeApp()
    app.offline = True
    async with Harness(temporal_env, app) as h:
        handle = await h.client.start_workflow("AgentLife", LifeInput("echo", "Echo", {"sleepAfterHours": 0.05}),
                                               id=wid("life"), task_queue="agents")
        await temporal_env.sleep(3600)
        state = await handle.query("state")
        assert state["awake"] is True and state["awakeSeconds"] == 0
        await handle.terminate()


async def test_life_decision_say(temporal_env):
    app = FakeApp()
    app.replies["context"] = lambda a: {**CTX, "restlessness": "restless", "secondsSinceFaceSeen": 30}
    app.replies["think"] = lambda a: {"text": "Hmm.\nSAY: The bins go out tonight.", "toolCalls": []}
    async with Harness(temporal_env, app) as h:
        handle = await h.client.start_workflow("AgentLife", LifeInput("echo", "Echo", {"quietHours": "22-7"}),
                                               id=wid("life"), task_queue="agents")
        await temporal_env.sleep(1500)
        state = await handle.query("state")
        await handle.terminate()
    says = [a for a in app.kinds("say") if a["source"] == "own thoughts"]
    assert says and says[0]["text"] == "The bins go out tonight." and says[0]["urgent"] is False
    assert state["lastDecision"]["summary"].startswith("SAY") and state["nextDecisionAt"]
    think = app.kinds("think")[0]
    assert think["tools"] == "safe" and "SAY:" in think["prompt"]


async def test_flow_runs_a_small_definition(temporal_env):
    app = FakeApp()
    app.replies["think"] = lambda a: {"text": "Sunny and warm", "toolCalls": []}
    app.flow_row = {"avatar_id": "echo", "name": "weather", "enabled": True, "trigger": {"kind": "manual"}, "definition": {
        "inputs": {"city": "Paris"},
        "steps": [{"think": "Weather in {{city}}?", "as": "w"}, {"wait": {"seconds": 30}},
                  {"if": {"var": "w", "op": "contains", "value": "sunny"}, "then": [{"say": "It is {{w}}"}]}]}}
    async with Harness(temporal_env, app) as h:
        out = await h.client.execute_workflow("AgentFlow", FlowInput("echo", "weather", {}, "manual", 0, {}),
                                              id="flow:echo:weather:" + str(uuid.uuid4()), task_queue="agents", result_type=str)
    assert out == "It is Sunny and warm"
    assert app.kinds("think")[0] == {"prompt": "Weather in Paris?", "tools": "none"}
    assert app.kinds("say")[0]["text"] == "It is Sunny and warm"
    assert app.flow_patches[-1]["last_outcome"].startswith("ok after")


async def test_flow_with_a_bad_definition_fails_and_records_why(temporal_env):
    app = FakeApp()
    app.flow_row = {"enabled": True, "definition": {"steps": [{"wait": {"minutes": 1}}]}}
    async with Harness(temporal_env, app) as h:
        try:
            await h.client.execute_workflow("AgentFlow", FlowInput("echo", "bad", {}, "manual", 0, {}),
                                            id="flow:echo:bad:" + str(uuid.uuid4()), task_queue="agents")
            raise AssertionError("should have failed")
        except Exception as exc:  # noqa: BLE001
            assert "not valid" in str(exc.__cause__ or exc)
    assert app.flow_patches[-1]["last_outcome"].startswith("failed:")


async def test_watch_fires_on_a_home_change_signal(temporal_env):
    app = FakeApp()
    cond = {"kind": "entity", "entityId": "binary_sensor.front_door", "state": "on"}
    until = iso_z(datetime.now(timezone.utc) + timedelta(hours=24))
    async with Harness(temporal_env, app) as h:
        handle = await h.client.start_workflow(
            "Watch", WatchInput("echo", cond, {"say": "The front door opened"}, until, "int-9", None, {}),
            id=wid("watch"), task_queue="agents")
        await handle.signal("home_change", {"entity_id": "binary_sensor.other", "new": "on"})  # not ours
        await asyncio.sleep(0.3)
        assert app.kinds("say") == []
        await handle.signal("home_change", {"entity_id": "binary_sensor.front_door", "new": "on", "old": "off"})
        out = await handle.result()
    assert out == "said it"
    assert app.kinds("say")[0]["text"] == "The front door opened"
    assert app.patched[-1]["fields"]["status"] == "done"


async def test_watch_ends_at_its_deadline_without_firing(temporal_env):
    app = FakeApp()
    cond = {"kind": "entity", "entityId": "binary_sensor.front_door", "state": "on"}
    until = iso_z(datetime.now(timezone.utc) + timedelta(hours=1))
    async with Harness(temporal_env, app) as h:
        out = await h.client.execute_workflow("Watch", WatchInput("echo", cond, {"say": "x"}, until, "i", None, {}),
                                              id=wid("watch"), task_queue="agents", result_type=str)
    assert out == "expired" and app.kinds("say") == []
    assert app.patched[-1]["fields"]["status"] == "dropped"
