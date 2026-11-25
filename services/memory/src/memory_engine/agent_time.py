"""Agents and time: intentions (what an avatar means to do and why), the flows it built for
itself, and whether it is asleep. The workflows service runs the flows; this keeps the record.
Everything is per avatar (the avatar's id, such as 'echo'). None of it is indexed for search,
and none of it is mirrored."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

ACTIVE = ("open", "waiting")
BRIEF_INTENTIONS = 12
BRIEF_FLOWS = 12
BRIEF_TEXT_CHARS = 300

INTENTION_COLUMNS = (
    "id, avatar_id, kind, text, why, status, parent_id, workflow_id, template, params, due_at, "
    "origin_message_id, outcome, created_at, updated_at"
)
FLOW_COLUMNS = (
    "avatar_id, name, description, version, definition, trigger, enabled, deleted_at, last_run_at, "
    "last_outcome, created_at, updated_at"
)
STATE_COLUMNS = "avatar_id, asleep, awake_since, last_sleep_at, last_wake_at, updated_at"


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


# Intentions


def _intention(r: tuple) -> dict[str, Any]:
    return {
        "id": str(r[0]),
        "avatar_id": r[1],
        "kind": r[2],
        "text": r[3],
        "why": r[4],
        "status": r[5],
        "parent_id": str(r[6]) if r[6] else None,
        "workflow_id": r[7],
        "template": r[8],
        "params": r[9],
        "due_at": _iso(r[10]),
        "origin_message_id": r[11],
        "outcome": r[12],
        "created_at": r[13].isoformat(),
        "updated_at": r[14].isoformat(),
    }


def intention_exists(conn: psycopg.Connection, intention_id: UUID) -> bool:
    return conn.execute("SELECT 1 FROM intentions WHERE id = %s", (intention_id,)).fetchone() is not None


def create_intention(conn: psycopg.Connection, intention_id: UUID, values: dict[str, Any]) -> dict[str, Any]:
    row = conn.execute(
        f"""
        INSERT INTO intentions (id, avatar_id, kind, text, why, status, parent_id, workflow_id, template,
            params, due_at, origin_message_id, outcome)
        VALUES (%(id)s, %(avatar_id)s, %(kind)s, %(text)s, %(why)s, %(status)s, %(parent_id)s, %(workflow_id)s,
            %(template)s, %(params)s, %(due_at)s, %(origin_message_id)s, %(outcome)s)
        RETURNING {INTENTION_COLUMNS}
        """,  # noqa: S608 - fixed names
        {
            "outcome": None,
            **values,
            "id": intention_id,
            "params": Jsonb(values["params"]) if values.get("params") is not None else None,
        },
    ).fetchone()
    return _intention(row)


# Columns a PATCH may change, and the ones holding JSON.
INTENTION_PATCHABLE = ("status", "outcome", "workflow_id", "text", "why", "due_at", "params", "template")


def update_intention(conn: psycopg.Connection, intention_id: UUID, changes: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Change the named columns (a value of None clears a nullable one). None if there is no such row."""
    sets = ["updated_at = now()"]
    args: dict[str, Any] = {"id": intention_id}
    for column in INTENTION_PATCHABLE:
        if column in changes:
            sets.append(f"{column} = %({column})s")
            value = changes[column]
            args[column] = Jsonb(value) if column == "params" and value is not None else value
    row = conn.execute(
        f"UPDATE intentions SET {', '.join(sets)} WHERE id = %(id)s RETURNING {INTENTION_COLUMNS}",  # noqa: S608
        args,
    ).fetchone()
    return _intention(row) if row else None


def list_intentions(
    conn: psycopg.Connection,
    *,
    avatar_id: Optional[str] = None,
    statuses: Optional[tuple[str, ...]] = ACTIVE,
    kind: Optional[str] = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Newest first. `statuses` None means every status."""
    rows = conn.execute(
        f"""
        SELECT {INTENTION_COLUMNS} FROM intentions
        WHERE (%(avatar)s::text IS NULL OR avatar_id = %(avatar)s)
          AND (%(statuses)s::text[] IS NULL OR status = ANY(%(statuses)s))
          AND (%(kind)s::text IS NULL OR kind = %(kind)s)
        ORDER BY created_at DESC, id LIMIT %(limit)s
        """,  # noqa: S608
        {"avatar": avatar_id, "statuses": list(statuses) if statuses else None, "kind": kind, "limit": limit},
    ).fetchall()
    return [_intention(r) for r in rows]


# Flows


def _flow(r: tuple) -> dict[str, Any]:
    return {
        "avatar_id": r[0],
        "name": r[1],
        "description": r[2],
        "version": r[3],
        "definition": r[4],
        "trigger": r[5],
        "enabled": r[6],
        "deleted_at": _iso(r[7]),
        "last_run_at": _iso(r[8]),
        "last_outcome": r[9],
        "created_at": r[10].isoformat(),
        "updated_at": r[11].isoformat(),
    }


def list_flows(conn: psycopg.Connection, *, avatar_id: Optional[str] = None, include_disabled: bool = False) -> list[dict[str, Any]]:
    """Flows that are not deleted, by avatar then name; switched-off ones only when asked for."""
    rows = conn.execute(
        f"""
        SELECT {FLOW_COLUMNS} FROM agent_flows
        WHERE deleted_at IS NULL
          AND (%(avatar)s::text IS NULL OR avatar_id = %(avatar)s)
          AND (%(all)s OR enabled)
        ORDER BY avatar_id, name
        """,  # noqa: S608
        {"avatar": avatar_id, "all": include_disabled},
    ).fetchall()
    return [_flow(r) for r in rows]


def get_flow(conn: psycopg.Connection, avatar_id: str, name: str) -> Optional[dict[str, Any]]:
    """None when there is no such flow or it was deleted."""
    row = conn.execute(
        f"SELECT {FLOW_COLUMNS} FROM agent_flows WHERE avatar_id = %s AND name = %s AND deleted_at IS NULL",  # noqa: S608
        (avatar_id, name),
    ).fetchone()
    return _flow(row) if row else None


def put_flow(
    conn: psycopg.Connection,
    avatar_id: str,
    name: str,
    *,
    description: str,
    definition: dict[str, Any],
    trigger: dict[str, Any],
    enabled: bool,
) -> dict[str, Any]:
    """Create the flow or save a new version of it (a deleted flow comes back). Every save writes a version row."""
    row = conn.execute(
        f"""
        INSERT INTO agent_flows (avatar_id, name, description, version, definition, trigger, enabled)
        VALUES (%(avatar)s, %(name)s, %(description)s, 1, %(definition)s, %(trigger)s, %(enabled)s)
        ON CONFLICT (avatar_id, name) DO UPDATE SET
            description = excluded.description,
            version = agent_flows.version + 1,
            definition = excluded.definition,
            trigger = excluded.trigger,
            enabled = excluded.enabled,
            deleted_at = NULL,
            updated_at = now()
        RETURNING {FLOW_COLUMNS}
        """,  # noqa: S608
        {
            "avatar": avatar_id,
            "name": name,
            "description": description,
            "definition": Jsonb(definition),
            "trigger": Jsonb(trigger),
            "enabled": enabled,
        },
    ).fetchone()
    flow = _flow(row)
    conn.execute(
        """
        INSERT INTO agent_flow_versions (avatar_id, name, version, definition, trigger)
        VALUES (%s, %s, %s, %s, %s) ON CONFLICT (avatar_id, name, version) DO NOTHING
        """,
        (avatar_id, name, flow["version"], Jsonb(definition), Jsonb(trigger)),
    )
    return flow


def update_flow(conn: psycopg.Connection, avatar_id: str, name: str, changes: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Change `enabled`, `last_run_at` or `last_outcome`; the definition's version stays as it is."""
    sets = ["updated_at = now()"]
    args: dict[str, Any] = {"avatar": avatar_id, "name": name}
    for column in ("enabled", "last_run_at", "last_outcome"):
        if column in changes:
            sets.append(f"{column} = %({column})s")
            args[column] = changes[column]
    row = conn.execute(
        f"UPDATE agent_flows SET {', '.join(sets)} WHERE avatar_id = %(avatar)s AND name = %(name)s"  # noqa: S608
        f" AND deleted_at IS NULL RETURNING {FLOW_COLUMNS}",
        args,
    ).fetchone()
    return _flow(row) if row else None


def delete_flow(conn: psycopg.Connection, avatar_id: str, name: str) -> bool:
    """Switch the flow off and mark it deleted; its versions are kept."""
    row = conn.execute(
        "UPDATE agent_flows SET enabled = false, deleted_at = now(), updated_at = now()"
        " WHERE avatar_id = %s AND name = %s AND deleted_at IS NULL RETURNING name",
        (avatar_id, name),
    ).fetchone()
    return row is not None


# Sleep state


def _state(r: tuple) -> dict[str, Any]:
    return {
        "avatar_id": r[0],
        "asleep": r[1],
        "awake_since": _iso(r[2]),
        "last_sleep_at": _iso(r[3]),
        "last_wake_at": _iso(r[4]),
        "updated_at": r[5].isoformat(),
    }


def get_state(conn: psycopg.Connection, avatar_id: str) -> Optional[dict[str, Any]]:
    row = conn.execute(f"SELECT {STATE_COLUMNS} FROM agent_state WHERE avatar_id = %s", (avatar_id,)).fetchone()  # noqa: S608
    return _state(row) if row else None


def put_state(conn: psycopg.Connection, avatar_id: str, changes: dict[str, Any]) -> dict[str, Any]:
    """Create the row or change the named fields (a value of None clears a time); the rest stay."""
    columns = [c for c in ("asleep", "awake_since", "last_sleep_at", "last_wake_at") if c in changes]
    args: dict[str, Any] = {"avatar": avatar_id, **{c: changes[c] for c in columns}}
    if "asleep" in columns and changes["asleep"] is None:
        args["asleep"] = False
    insert_columns = ", ".join(["avatar_id", *columns])
    insert_values = ", ".join(["%(avatar)s", *[f"%({c})s" for c in columns]])
    updates = ", ".join([*(f"{c} = excluded.{c}" for c in columns), "updated_at = now()"])
    row = conn.execute(
        f"""
        INSERT INTO agent_state ({insert_columns}) VALUES ({insert_values})
        ON CONFLICT (avatar_id) DO UPDATE SET {updates}
        RETURNING {STATE_COLUMNS}
        """,  # noqa: S608
        args,
    ).fetchone()
    return _state(row)


# The brief


def brief_parts(conn: psycopg.Connection, avatar_id: Optional[str]) -> dict[str, Any]:
    """Active intentions (goals first, then by due date, at most 12), enabled flows (at most 12)
    and the sleep state, for one avatar, or for all of them when `avatar_id` is None."""
    rows = conn.execute(
        """
        SELECT id, kind, text, due_at, status, workflow_id, avatar_id FROM intentions
        WHERE status IN ('open', 'waiting') AND (%(avatar)s::text IS NULL OR avatar_id = %(avatar)s)
        ORDER BY (kind = 'goal') DESC, due_at ASC NULLS LAST, created_at, id
        LIMIT %(limit)s
        """,
        {"avatar": avatar_id, "limit": BRIEF_INTENTIONS},
    ).fetchall()
    intentions = [
        {
            "id": str(r[0]),
            "kind": r[1],
            "text": _clip(r[2], BRIEF_TEXT_CHARS),
            "due_at": _iso(r[3]),
            "status": r[4],
            "workflow_id": r[5],
            "avatar_id": r[6],
        }
        for r in rows
    ]
    flow_rows = conn.execute(
        """
        SELECT name, description, trigger, avatar_id FROM agent_flows
        WHERE enabled AND deleted_at IS NULL AND (%(avatar)s::text IS NULL OR avatar_id = %(avatar)s)
        ORDER BY avatar_id, name LIMIT %(limit)s
        """,
        {"avatar": avatar_id, "limit": BRIEF_FLOWS},
    ).fetchall()
    flows = [{"name": r[0], "description": _clip(r[1], BRIEF_TEXT_CHARS), "trigger": r[2], "avatar_id": r[3]} for r in flow_rows]
    state = get_state(conn, avatar_id) if avatar_id else None
    return {"intentions": intentions, "flows": flows, "agent_state": state}
