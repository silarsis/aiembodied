"""Temporal activities: everything that does I/O. Workflows only call these."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from .acts import ActFailed, AppOffline, journal_event, publish_event, run_act
from .logs import get_logger
from .memory import MemoryClient, MemoryError
from .settings import Settings

log = get_logger("activities")

APP_ACT = "app_act"
JOURNAL = "journal"


def format_results(results: list[dict], limit: int = 5) -> str:
    """Web results as short text lines."""
    lines = []
    for r in results[:limit]:
        title = (r.get("title") or "").strip()
        content = " ".join((r.get("content") or "").split())[:240]
        url = r.get("url") or ""
        lines.append(f"- {title}: {content} ({url})".strip())
    return "\n".join(lines) if lines else "(no results)"


def format_memory_hits(hits: list[dict], limit: int = 5) -> str:
    lines = []
    for h in hits[:limit]:
        text = " ".join(str(h.get("text") or "").split())[:300]
        if text:
            lines.append(f"- {text}")
    return "\n".join(lines) if lines else "(nothing found)"


class Activities:
    def __init__(
        self,
        settings: Settings,
        *,
        switchboard: httpx.AsyncClient | None = None,
        memory: MemoryClient | None = None,
        web: httpx.AsyncClient | None = None,
        client_getter: Callable[[], Any] | None = None,
        agent_name: Callable[[str], str] | None = None,
    ):
        self.settings = settings
        # memory keys facts and search by the agent's display name, as the app does
        self.agent_name = agent_name or (lambda avatar: avatar)
        self.client_getter = client_getter or (lambda: None)
        self.switchboard = switchboard or httpx.AsyncClient(base_url=settings.switchboard_url, timeout=15.0)
        self.memory = memory or MemoryClient(settings.memory_url, settings.memory_token)
        self.web = web or httpx.AsyncClient(timeout=15.0, follow_redirects=False)

    def all(self) -> list:
        return [
            self.app_act,
            self.journal,
            self.mem_decision_context,
            self.mem_create_intention,
            self.mem_patch_intention,
            self.mem_get_flow,
            self.mem_patch_flow,
            self.mem_put_agent_state,
            self.mem_put_fact,
            self.mem_search,
            self.mem_home_entities,
            self.mem_run_summaries,
            self.web_search,
            self.probe_url,
            self.flow_runaway,
        ]

    # --- acts -----------------------------------------------------------------------------------
    @activity.defn(name=APP_ACT)
    async def app_act(self, req: dict) -> dict:
        """Contract 1. `req` = {avatarId, kind, args, workflowId}."""
        info = activity.info()
        try:
            return await run_act(
                self.switchboard,
                req["avatarId"],
                req["kind"],
                req.get("args") or {},
                workflow_id=req.get("workflowId") or info.workflow_id or "",
                heartbeat=lambda: activity.heartbeat(req["kind"]),
            )
        except AppOffline as exc:
            raise ApplicationError(str(exc), type="AppOffline", non_retryable=True) from exc
        except ActFailed as exc:
            raise ApplicationError(str(exc), exc.code, type="ActFailed", non_retryable=True) from exc
        except httpx.HTTPError as exc:
            raise ApplicationError(f"switchboard: {exc}", type="SwitchboardError") from exc  # retryable

    @activity.defn(name=JOURNAL)
    async def journal(self, event: dict) -> None:
        """Publish a `workflow.*` event. Never fails the workflow."""
        try:
            await publish_event(
                self.switchboard,
                journal_event(
                    event.get("kind", "step"),
                    event.get("workflowId", ""),
                    event.get("avatarId"),
                    event.get("text", ""),
                    event.get("extra"),
                ),
            )
        except Exception as exc:  # noqa: BLE001
            log.debug("journal event not published: %s", exc)

    # --- memory ---------------------------------------------------------------------------------
    def _memory_error(self, exc: MemoryError) -> ApplicationError:
        permanent = exc.status is not None and 400 <= exc.status < 500
        return ApplicationError(str(exc), type="MemoryError", non_retryable=permanent)

    @activity.defn(name="mem_decision_context")
    async def mem_decision_context(self, avatar_id: str) -> dict:
        """What the life workflow needs to write a decision prompt. Pieces that fail come back empty."""
        out: dict[str, Any] = {"intentions": [], "flows": [], "agentState": None}
        for key, call in (
            ("intentions", self.memory.intentions(avatar_id)),
            ("flows", self.memory.flows(avatar_id)),
            ("agentState", self.memory.agent_state(avatar_id)),
        ):
            try:
                out[key] = await call
            except MemoryError as exc:
                log.warning("memory %s for %s unavailable: %s", key, avatar_id, exc)
        return out

    @activity.defn(name="mem_create_intention")
    async def mem_create_intention(self, row: dict) -> dict:
        try:
            return await self.memory.create_intention(row)
        except MemoryError as exc:
            raise self._memory_error(exc) from exc

    @activity.defn(name="mem_patch_intention")
    async def mem_patch_intention(self, req: dict) -> None:
        """`req` = {id, fields}. A missing intention is not an error."""
        try:
            await self.memory.patch_intention(req["id"], req["fields"])
        except MemoryError as exc:
            if exc.status == 404:
                return
            raise self._memory_error(exc) from exc

    @activity.defn(name="mem_get_flow")
    async def mem_get_flow(self, req: dict) -> dict | None:
        try:
            return await self.memory.get_flow(req["avatarId"], req["name"])
        except MemoryError as exc:
            raise self._memory_error(exc) from exc

    @activity.defn(name="mem_patch_flow")
    async def mem_patch_flow(self, req: dict) -> None:
        try:
            await self.memory.patch_flow(req["avatarId"], req["name"], req["fields"])
        except MemoryError as exc:
            if exc.status == 404:
                return
            raise self._memory_error(exc) from exc

    @activity.defn(name="mem_put_agent_state")
    async def mem_put_agent_state(self, req: dict) -> None:
        """Best effort: the state is also kept in the life workflow."""
        try:
            await self.memory.put_agent_state(req["avatarId"], req["state"])
        except MemoryError as exc:
            log.warning("agent state for %s not saved: %s", req["avatarId"], exc)

    @activity.defn(name="mem_put_fact")
    async def mem_put_fact(self, req: dict) -> None:
        try:
            await self.memory.put_fact(req["text"], req.get("agent") or self.agent_name(req["avatarId"]))
        except MemoryError as exc:
            raise self._memory_error(exc) from exc

    @activity.defn(name="mem_search")
    async def mem_search(self, req: dict) -> str:
        try:
            return format_memory_hits(
                await self.memory.search(req["query"], self.agent_name(req["agent"]) if req.get("agent") else None)
            )
        except MemoryError as exc:
            return f"(memory search failed: {exc})"

    @activity.defn(name="mem_home_entities")
    async def mem_home_entities(self, _: None = None) -> list[dict]:
        try:
            rows = await self.memory.home_entities()
        except MemoryError as exc:
            log.warning("home entities unavailable: %s", exc)
            return []
        return [
            {"entity_id": r.get("entity_id"), "state": r.get("last_state"), "value": r.get("last_value")}
            for r in rows
            if r.get("entity_id")
        ]

    @activity.defn(name="mem_run_summaries")
    async def mem_run_summaries(self, _: None = None) -> None:
        """Consolidation when an avatar goes to sleep. Best effort (409 = no summary model)."""
        try:
            await self.memory.run_summaries()
        except MemoryError as exc:
            log.info("summaries not run: %s", exc)

    # --- the web --------------------------------------------------------------------------------
    @activity.defn(name="web_search")
    async def web_search(self, query: str) -> list[dict]:
        resp = await self.web.get(f"{self.settings.searxng_url}/search", params={"q": query, "format": "json"})
        if resp.status_code >= 400:
            raise ApplicationError(f"search answered {resp.status_code}", type="SearchError")
        results = resp.json().get("results") or []
        return [{"title": r.get("title"), "url": r.get("url"), "content": r.get("content")} for r in results[:10]]

    @activity.defn(name="probe_url")
    async def probe_url(self, url: str) -> int | None:
        """The HTTP status of a GET, or None when nothing answered."""
        try:
            return (await self.web.get(url, timeout=10.0)).status_code
        except (httpx.HTTPError, asyncio.TimeoutError):
            return None

    @activity.defn(name="flow_runaway")
    async def flow_runaway(self, req: dict) -> None:
        """A flow started again within a minute of its last start by its own trigger: stop the trigger and leave a note.

        `req` = {avatarId, name, source, gap}."""
        avatar, name, source = req["avatarId"], req["name"], req.get("source")
        log.warning(
            "flow %s/%s started again after %.0f s by its %s; stopping the trigger",
            avatar,
            name,
            float(req.get("gap") or 0),
            source,
            extra={"wfid": activity.info().workflow_id},
        )
        client = self.client_getter()
        if source == "schedule" and client is not None:
            try:
                await client.get_schedule_handle(f"sched:{avatar}:{name}").pause(
                    note="runaway: started twice within a minute"
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("could not pause the schedule for %s/%s: %s", avatar, name, exc)
        try:
            if source == "watch":
                await self.memory.patch_flow(avatar, name, {"enabled": False})
            await self.memory.create_intention(
                {
                    "avatar_id": avatar,
                    "kind": "intention",
                    "status": "open",
                    "text": f'My workflow "{name}" kept starting again within a minute, so I stopped its '
                    f"{'schedule' if source == 'schedule' else 'watcher'}. Fix it, then turn it back on.",
                }
            )
        except MemoryError as exc:
            log.warning("could not write the runaway note: %s", exc)

    async def aclose(self) -> None:
        await asyncio.gather(self.switchboard.aclose(), self.memory.aclose(), self.web.aclose(), return_exceptions=True)
