"""A small async client for the memory engine (services/memory/API.md)."""

from __future__ import annotations

import uuid
from typing import Any

import httpx


class MemoryError(Exception):
    """The memory engine answered with an error, or could not be reached."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def _rows(data: Any, key: str) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        v = data.get(key)
        return v if isinstance(v, list) else []
    return []


class MemoryClient:
    def __init__(self, base_url: str, token: str | None = None, *, client: httpx.AsyncClient | None = None,
                 timeout: float = 15.0):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._http = client or httpx.AsyncClient(base_url=base_url, headers=headers, timeout=timeout)
        self.base_url = base_url

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _call(self, method: str, path: str, *, params: dict | None = None, json: Any = None,
                    allow_404: bool = False) -> Any:
        try:
            resp = await self._http.request(method, path, params=_clean(params), json=json)
        except httpx.HTTPError as exc:
            raise MemoryError(f"memory engine unreachable: {exc}") from exc
        if resp.status_code == 404 and allow_404:
            return None
        if resp.status_code >= 400:
            detail = resp.text[:300]
            try:
                body = resp.json()
                detail = str(body.get("error") or body.get("detail") or detail)
            except Exception:  # noqa: BLE001
                pass
            raise MemoryError(f"memory {method} {path} -> {resp.status_code}: {detail}", resp.status_code)
        if not resp.content:
            return {}
        return resp.json()

    # intentions
    async def intentions(self, avatar_id: str, status: str = "active", kind: str | None = None,
                         limit: int = 100) -> list[dict]:
        data = await self._call("GET", "/v1/intentions",
                                params={"avatar_id": avatar_id, "status": status, "kind": kind, "limit": limit})
        return _rows(data, "intentions")

    async def all_active_intentions(self, limit: int = 1000) -> list[dict]:
        data = await self._call("GET", "/v1/intentions", params={"status": "active", "limit": limit})
        return _rows(data, "intentions")

    async def create_intention(self, row: dict) -> dict:
        return await self._call("POST", "/v1/intentions", json=row)

    async def patch_intention(self, intention_id: str, fields: dict) -> dict:
        return await self._call("PATCH", f"/v1/intentions/{intention_id}", json=fields)

    # flows
    async def flows(self, avatar_id: str | None = None, include_disabled: bool = False) -> list[dict]:
        data = await self._call("GET", "/v1/flows",
                                params={"avatar_id": avatar_id, "include_disabled": "true" if include_disabled else None})
        return _rows(data, "flows")

    async def get_flow(self, avatar_id: str, name: str) -> dict | None:
        return await self._call("GET", f"/v1/flows/{avatar_id}/{name}", allow_404=True)

    async def put_flow(self, avatar_id: str, name: str, body: dict) -> dict:
        return await self._call("PUT", f"/v1/flows/{avatar_id}/{name}", json=body)

    async def patch_flow(self, avatar_id: str, name: str, fields: dict) -> dict:
        return await self._call("PATCH", f"/v1/flows/{avatar_id}/{name}", json=fields)

    async def delete_flow(self, avatar_id: str, name: str) -> dict:
        return await self._call("DELETE", f"/v1/flows/{avatar_id}/{name}")

    # agent state
    async def agent_state(self, avatar_id: str) -> dict | None:
        return await self._call("GET", f"/v1/agents/{avatar_id}/state", allow_404=True)

    async def put_agent_state(self, avatar_id: str, state: dict) -> dict:
        return await self._call("PUT", f"/v1/agents/{avatar_id}/state", json=state)

    # the rest of memory
    async def brief(self, avatar_id: str | None = None) -> dict:
        """The brief with the intentions, flows and agent_state of one avatar (`avatar_id`) added."""
        return await self._call("GET", "/v1/brief", params={"avatar_id": avatar_id})

    async def put_fact(self, text: str, agent: str, subject: str | None = None) -> dict:
        body = {"text": text, "author": "agent", "agent": agent, "subject": subject}
        return await self._call("PUT", f"/v1/facts/{uuid.uuid4()}", json={k: v for k, v in body.items() if v is not None})

    async def search(self, query: str, agent: str | None = None, limit: int = 5) -> list[dict]:
        data = await self._call("GET", "/v1/search", params={"q": query, "agent": agent, "limit": limit})
        return _rows(data, "results")

    async def home_entities(self, q: str | None = None) -> list[dict]:
        data = await self._call("GET", "/v1/home/entities", params={"q": q})
        return _rows(data, "entities")

    async def run_summaries(self) -> dict:
        return await self._call("POST", "/v1/summaries/run", json={})


def _clean(params: dict | None) -> dict | None:
    return {k: v for k, v in params.items() if v is not None} if params else None
