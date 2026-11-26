from datetime import datetime, timedelta, timezone

import httpx
import pytest
from aiembodied_workflows import acts


class FakeSwitchboard:
    """Answers POST /v1/events and GET /v1/txns/{id} like the switchboard. `script` is the list of txn states to show."""

    def __init__(self, script, result=None):
        self.script = list(script)
        self.result = result
        self.posted: list[dict] = []
        self.gets = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            import json

            self.posted.append(json.loads(request.content))
            return httpx.Response(200, json={"ids": ["01X"]})
        self.gets += 1
        state = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        events = []
        if self.result is not None and state in acts.CLOSED:
            events = [{"type": "agent.act", "payload": {}}, {"type": "agent.act.result", "payload": self.result}]
        return httpx.Response(200, json={"txn": {"id": "x", "state": state}, "children": [], "events": events})


def client(sb):
    return httpx.AsyncClient(base_url="http://sb", transport=httpx.MockTransport(sb.handler))


async def no_sleep(_):
    return None


async def test_done_returns_the_result_and_publishes_the_contract_shape():
    sb = FakeSwitchboard(["open", "accepted", "done"], {"ok": True, "result": {"hour": 9}})
    beats = []
    out = await acts.run_act(
        client(sb), "echo", "context", {}, workflow_id="life:echo", heartbeat=lambda: beats.append(1), sleep=no_sleep
    )
    assert out == {"hour": 9} and len(beats) == 2 and sb.gets == 3
    ev = sb.posted[0]
    assert ev["type"] == "agent.act" and ev["to"] == ["service:app"] and ev["audience"] == "private"
    assert ev["producer"] == {"kind": "service", "id": "workflows"}
    assert ev["txn"]["id"].startswith("act:") and ev["txn"]["state"] == "open"
    assert ev["txn"]["title"] == "context for echo" and ev["txn"]["deadline"].endswith("Z")
    assert ev["payload"] == {"avatarId": "echo", "kind": "context", "args": {}, "workflowId": "life:echo"}


async def test_deadline_is_now_plus_the_act_timeout():
    sb = FakeSwitchboard(["done"], {"ok": True, "result": {}})
    t0 = datetime(2026, 11, 26, 1, 0, 0, tzinfo=timezone.utc)
    await acts.run_act(client(sb), "echo", "think", {"prompt": "hi"}, now=lambda: t0, sleep=no_sleep)
    assert sb.posted[0]["txn"]["deadline"] == "2026-11-26T01:03:00.000Z"
    assert acts.act_timeout("ask") == 6 * 3600 and acts.act_timeout("tool") == 3600 and acts.act_timeout("say") == 15


async def test_failed_raises_actfailed_with_text_and_code():
    sb = FakeSwitchboard(["failed"], {"ok": False, "error": "no such tool", "code": "bad_args"})
    with pytest.raises(acts.ActFailed) as e:
        await acts.run_act(client(sb), "echo", "tool", {"name": "x"}, sleep=no_sleep)
    assert str(e.value) == "no such tool" and e.value.code == "bad_args"


async def test_failed_with_offline_code_means_app_offline():
    sb = FakeSwitchboard(["failed"], {"ok": False, "error": "app closing", "code": "offline"})
    with pytest.raises(acts.AppOffline):
        await acts.run_act(client(sb), "echo", "say", {}, sleep=no_sleep)


async def test_expired_means_app_offline():
    sb = FakeSwitchboard(["open", "expired"])
    with pytest.raises(acts.AppOffline):
        await acts.run_act(client(sb), "echo", "context", {}, sleep=no_sleep)


async def test_failed_without_result_event():
    sb = FakeSwitchboard(["failed"])
    with pytest.raises(acts.ActFailed):
        await acts.run_act(client(sb), "echo", "say", {}, sleep=no_sleep)


async def test_done_with_ok_false_is_a_failure():
    sb = FakeSwitchboard(["done"], {"ok": False, "error": "refused", "code": "refused"})
    with pytest.raises(acts.ActFailed) as e:
        await acts.run_act(client(sb), "echo", "tool", {}, sleep=no_sleep)
    assert e.value.code == "refused"


async def test_never_closing_txn_gives_up_after_the_deadline():
    sb = FakeSwitchboard(["open"])
    clock = [datetime(2026, 11, 26, 1, 0, 0, tzinfo=timezone.utc)]

    async def tick(_):
        clock[0] += timedelta(seconds=10)

    with pytest.raises(acts.AppOffline):
        await acts.run_act(client(sb), "echo", "context", {}, now=lambda: clock[0], sleep=tick)


async def test_http_error_is_raised_for_retry():
    def boom(_req):
        return httpx.Response(500)

    with pytest.raises(httpx.HTTPStatusError):
        await acts.run_act(
            httpx.AsyncClient(base_url="http://sb", transport=httpx.MockTransport(boom)), "echo", "say", {}
        )


def test_journal_event_shape():
    ev = acts.journal_event("decision", "life:echo", "echo", "decision: NOTHING")
    assert ev["type"] == "workflow.decision" and ev["audience"] == "private" and ev["producer"]["id"] == "workflows"
    assert ev["payload"] == {"workflowId": "life:echo", "avatarId": "echo", "text": "decision: NOTHING"}
