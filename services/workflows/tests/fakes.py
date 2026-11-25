"""Fakes for the Temporal client and the memory engine, used by the API and reconcile tests."""

from __future__ import annotations

from types import SimpleNamespace

from temporalio.client import ScheduleAlreadyRunningError
from temporalio.service import RPCError, RPCStatusCode


class FakeHandle:
    def __init__(self, client, wid):
        self.client, self.id = client, wid

    async def signal(self, name, *args):
        if self.id not in self.client.running:
            raise RPCError("not found", RPCStatusCode.NOT_FOUND, b"")
        self.client.signals.append((self.id, name, args))

    async def cancel(self):
        if self.id not in self.client.running:
            raise RPCError("not found", RPCStatusCode.NOT_FOUND, b"")
        self.client.cancelled.append(self.id)
        self.client.running.pop(self.id)

    async def query(self, name):
        return self.client.queries.get((self.id, name), {})

    async def describe(self):
        if self.id not in self.client.running:
            raise RPCError("not found", RPCStatusCode.NOT_FOUND, b"")
        return SimpleNamespace(status=SimpleNamespace(name="RUNNING"))


class FakeSchedule:
    def __init__(self, client, sid):
        self.client, self.id = client, sid

    def _need(self):
        if self.id not in self.client.schedules:
            raise RPCError("not found", RPCStatusCode.NOT_FOUND, b"")

    async def delete(self):
        self._need()
        del self.client.schedules[self.id]
        self.client.schedule_log.append(("delete", self.id))

    async def pause(self, note=None):
        self._need()
        self.client.schedule_log.append(("pause", self.id))

    async def unpause(self, note=None):
        self._need()
        self.client.schedule_log.append(("unpause", self.id))

    async def describe(self):
        self._need()
        return SimpleNamespace()

    async def update(self, fn):
        self._need()
        out = fn(None)
        self.client.schedules[self.id] = out.schedule
        self.client.schedule_log.append(("update", self.id))


class FakeClient:
    def __init__(self):
        self.started: list[dict] = []
        self.running: dict[str, str] = {}
        self.signals: list[tuple] = []
        self.cancelled: list[str] = []
        self.schedules: dict[str, object] = {}
        self.schedule_log: list[tuple] = []
        self.queries: dict[tuple, object] = {}
        self.listed: list[SimpleNamespace] = []

    async def start_workflow(self, name, arg, *, id, task_queue, **kw):
        self.started.append({"name": name, "arg": arg, "id": id, "queue": task_queue, **kw})
        self.running[id] = name
        return FakeHandle(self, id)

    def get_workflow_handle(self, wid):
        return FakeHandle(self, wid)

    def get_schedule_handle(self, sid):
        return FakeSchedule(self, sid)

    async def create_schedule(self, sid, schedule):
        if sid in self.schedules:
            raise ScheduleAlreadyRunningError()
        self.schedules[sid] = schedule
        self.schedule_log.append(("create", sid))

    def list_workflows(self, query=None, **kw):
        async def gen():
            for w in self.listed:
                yield w

        return gen()


class FakeMemory:
    def __init__(self):
        self.intentions_rows: list[dict] = []
        self.flows_rows: list[dict] = []
        self.created: list[dict] = []
        self.patched: list[tuple] = []
        self.put: list[tuple] = []
        self.deleted: list[tuple] = []
        self.fail = False

    async def intentions(self, avatar_id, status="active", kind=None, limit=100):
        return [r for r in self.intentions_rows if r.get("avatar_id") == avatar_id]

    async def all_active_intentions(self, limit=1000):
        return list(self.intentions_rows)

    async def create_intention(self, row):
        if self.fail:
            from aiembodied_workflows.memory import MemoryError

            raise MemoryError("memory down")
        self.created.append(row)
        return {"id": row.get("id", "generated-id"), **row}

    async def patch_intention(self, iid, fields):
        self.patched.append((iid, fields))
        return {}

    async def flows(self, avatar_id=None, include_disabled=False):
        return [f for f in self.flows_rows if avatar_id in (None, f.get("avatar_id"))]

    async def get_flow(self, avatar, name):
        for f in self.flows_rows:
            if f["avatar_id"] == avatar and f["name"] == name:
                return f
        return None

    async def put_flow(self, avatar, name, body):
        self.put.append((avatar, name, body))
        return {"avatar_id": avatar, "name": name, "version": 1, **body}

    async def patch_flow(self, avatar, name, fields):
        return {}

    async def delete_flow(self, avatar, name):
        self.deleted.append((avatar, name))
        return {}

    async def aclose(self):
        pass
