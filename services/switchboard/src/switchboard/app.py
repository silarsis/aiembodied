"""HTTP and WebSocket API (see ../../API.md)."""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import Any, Awaitable, Callable, Optional

import anyio
from fastapi import Body, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect

from . import __version__
from .hub import BusError, Client, Hub
from .models import Config

log = logging.getLogger("switchboard")

EXPIRY_CHECK_S = 5
PRUNE_EVERY_S = 3600
HELLO_TIMEOUT_S = 10


async def housekeeping(hub: Hub) -> None:
    last_prune = time.monotonic()
    while True:
        await asyncio.sleep(EXPIRY_CHECK_S)
        try:
            hub.expire()
            if time.monotonic() - last_prune >= PRUNE_EVERY_S:
                last_prune = time.monotonic()
                hub.prune()
        except Exception:
            log.exception("housekeeping failed")


def create_app(cfg: Optional[Config] = None) -> FastAPI:
    cfg = cfg or Config.from_env()
    hub = Hub(cfg)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        events, txns = hub.prune()
        if events or txns:
            log.info("pruned %d events and %d closed txns", events, txns)
        task = asyncio.create_task(housekeeping(hub))
        yield
        task.cancel()
        hub.close()

    app = FastAPI(title="Switchboard", version=__version__, lifespan=lifespan)
    app.state.hub = hub

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__, "node": cfg.node, "events": hub.store.count_events(),
                "open_txns": hub.store.count_open_txns(), "clients": len(hub.clients)}

    @app.post("/v1/events")
    async def publish(body: dict[str, Any] = Body(...)) -> dict[str, list[str]]:
        raws = body["events"] if isinstance(body.get("events"), list) else [body]
        try:
            return {"ids": hub.publish(raws)}
        except BusError as e:
            raise HTTPException(e.status, e.message) from None

    @app.get("/v1/events")
    async def events(since: Optional[str] = None, type: Optional[str] = None, producer: Optional[str] = None,
                     txn: Optional[str] = None, root: Optional[str] = None, scene: Optional[str] = None,
                     to: Optional[str] = None, limit: int = Query(200, ge=1, le=1000)) -> dict[str, Any]:
        found = hub.store.events(since, type, producer, txn, root, scene, to, limit)
        return {"events": found, "next": found[-1]["id"] if found else None}

    @app.get("/v1/txns")
    async def txns(state: Optional[str] = None, root: Optional[str] = None,
                   limit: int = Query(200, ge=1, le=1000)) -> dict[str, Any]:
        return {"txns": hub.store.txns(state, root, limit=limit)}

    @app.get("/v1/txns/{txn_id}")
    async def txn(txn_id: str) -> dict[str, Any]:
        row = hub.store.get_txn(txn_id)
        if row is None:
            raise HTTPException(404, f"no txn {txn_id}")
        return {"txn": row, "children": hub.store.txns(parent=txn_id, limit=1000),
                "events": hub.store.events(txn=txn_id, limit=1000)}

    @app.websocket("/v1/stream")
    async def stream(ws: WebSocket) -> None:
        await ws.accept()
        try:
            hello = await asyncio.wait_for(ws.receive_json(), HELLO_TIMEOUT_S)
            if hello.get("op") != "hello":
                raise ValueError("the first message must be a hello")
            client, replay = hub.attach(hello)
        except WebSocketDisconnect:
            return
        except (ValueError, AttributeError, TypeError, asyncio.TimeoutError) as e:
            await ws.send_json({"op": "error", "message": str(e) or "bad hello"})
            await ws.close(1008)
            return
        try:
            await ws.send_json({"op": "welcome", "node": cfg.node})
            for ev in replay:
                await ws.send_json({"op": "event", "event": ev})
            # An anyio task group, not bare asyncio tasks: when either side ends it cancels the other,
            # and a cancellation from outside (the server stopping) passes through cleanly.
            async with anyio.create_task_group() as group:

                async def run(side: Callable[[], Awaitable[None]]) -> None:
                    try:
                        await side()
                    except WebSocketDisconnect:
                        pass
                    finally:
                        group.cancel_scope.cancel()

                group.start_soon(run, lambda: _pump(ws, client))
                group.start_soon(run, lambda: _listen(ws, client, hub))
        except WebSocketDisconnect:
            pass
        finally:
            hub.detach(client)

    return app


async def _pump(ws: WebSocket, client: Client) -> None:
    """The only writer to the socket after the replay: sends whatever is queued for this client."""
    while (msg := await client.queue.get()) is not None:
        await ws.send_json(msg)
    await ws.close(1013)


async def _listen(ws: WebSocket, client: Client, hub: Hub) -> None:
    while True:
        msg = await ws.receive_json()
        op, ref = msg.get("op"), msg.get("ref")
        if op == "ping":
            client.offer({"op": "pong"})
        elif op == "publish":
            try:
                client.offer({"op": "ack", "ref": ref, "id": hub.publish([msg.get("event")])[0]})
            except BusError as e:
                client.offer({"op": "error", "ref": ref, "message": e.message})
        else:
            client.offer({"op": "error", "ref": ref, "message": f"unknown op {op!r}"})
