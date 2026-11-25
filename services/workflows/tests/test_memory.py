import json

import httpx
import pytest

from aiembodied_workflows.memory import MemoryClient, MemoryError


def make(handler):
    return MemoryClient("http://mem", "tok", client=httpx.AsyncClient(base_url="http://mem", transport=httpx.MockTransport(handler)))


async def test_intentions_and_flows_shapes():
    seen = []

    def handler(req: httpx.Request):
        seen.append((req.method, req.url.path, dict(req.url.params), req.content))
        if req.url.path == "/v1/intentions" and req.method == "GET":
            return httpx.Response(200, json={"intentions": [{"id": "1"}]})
        if req.url.path == "/v1/flows":
            return httpx.Response(200, json={"flows": [{"name": "a"}]})
        if req.url.path == "/v1/flows/echo/missing":
            return httpx.Response(404, json={"error": "no such flow"})
        return httpx.Response(200, json={"ok": True})

    m = make(handler)
    assert await m.intentions("echo", "open", limit=5) == [{"id": "1"}]
    assert seen[0][2] == {"avatar_id": "echo", "status": "open", "limit": "5"}
    assert await m.flows("echo") == [{"name": "a"}] and seen[1][2] == {"avatar_id": "echo"}
    assert await m.get_flow("echo", "missing") is None
    await m.put_flow("echo", "a", {"description": "d"})
    assert seen[-1][0] == "PUT" and json.loads(seen[-1][3]) == {"description": "d"}
    await m.patch_intention("9", {"status": "done"})
    assert seen[-1][:2] == ("PATCH", "/v1/intentions/9")


async def test_errors_use_the_error_field():
    m = make(lambda r: httpx.Response(422, json={"error": "bad status"}))
    with pytest.raises(MemoryError, match="bad status") as e:
        await m.create_intention({})
    assert e.value.status == 422


async def test_unreachable_is_a_memory_error():
    def boom(r):
        raise httpx.ConnectError("refused")

    with pytest.raises(MemoryError, match="unreachable"):
        await make(boom).intentions("echo")


async def test_brief_uses_avatar_id_and_fact_put():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json={})

    m = make(handler)
    await m.brief("echo")
    assert dict(seen[0].url.params) == {"avatar_id": "echo"}
    await m.put_fact("Kevin likes tea", "Echo")
    assert seen[1].method == "PUT" and seen[1].url.path.startswith("/v1/facts/")
    assert json.loads(seen[1].content) == {"text": "Kevin likes tea", "author": "agent", "agent": "Echo"}
