"""Start the real service in-process with no Temporal server and no switchboard: /health must still answer."""

import asyncio
import socket

import httpx
import uvicorn
from aiembodied_workflows.api import create_app
from aiembodied_workflows.settings import Settings


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def test_health_answers_with_temporal_false_when_the_server_is_down():
    tport = free_port()  # nothing listens here
    settings = Settings(
        temporal_address=f"127.0.0.1:{tport}",
        switchboard_url=f"http://127.0.0.1:{free_port()}",
        memory_url=f"http://127.0.0.1:{free_port()}",
    )
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(create_app(settings), host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as http:
            for _ in range(100):
                try:
                    r = await http.get("/health")
                    break
                except httpx.HTTPError:
                    await asyncio.sleep(0.05)
            await asyncio.sleep(0.3)  # let the first connection attempt fail
            r = await http.get("/health")
            assert r.status_code == 200
            assert r.json() == {
                "ok": True,
                "version": "0.1.0",
                "temporal": False,
                "namespace": "aiembodied",
                "agentLife": True,
                "agents": [],
            }
            # Calls that need Temporal answer 503, not a crash.
            r = await http.put("/v1/agents", json={"agents": [{"id": "echo", "name": "Echo"}]})
            assert r.status_code == 503
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 10)
