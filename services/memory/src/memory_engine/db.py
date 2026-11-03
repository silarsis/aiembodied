"""Connections and schema migrations.

The engine keeps its tables in one schema (default "memory") and puts it first on the search
path of every connection, so the SQL never names it. Migrations are the numbered .sql files in
./migrations, each applied once in its own transaction and recorded in schema_migrations.
"""

from __future__ import annotations

import logging
import re
from importlib import resources

import psycopg
from psycopg_pool import ConnectionPool

log = logging.getLogger("memory_engine.db")

_SCHEMA_NAME = re.compile(r"^[a-z_][a-z0-9_]*$")


def search_path(schema: str) -> str:
    if not _SCHEMA_NAME.match(schema):
        raise ValueError(f"invalid schema name: {schema!r}")
    # "extensions" is where Supabase installs pgvector; it is ignored where it doesn't exist.
    return f"{schema}, public, extensions"


def open_pool(database_url: str, schema: str, *, min_size: int = 1, max_size: int = 8) -> ConnectionPool:
    path = search_path(schema)

    def configure(conn: psycopg.Connection) -> None:
        # Set per connection rather than as a startup option: Supabase's pooler drops those.
        conn.execute(f"SET search_path TO {path}")
        conn.commit()

    return ConnectionPool(
        database_url,
        min_size=min_size,
        max_size=max_size,
        configure=configure,
        open=False,
        kwargs={"autocommit": False},
    )


def migration_files() -> list[tuple[int, str, str]]:
    """(version, name, sql) for each migration, in order."""
    found = []
    for entry in resources.files("memory_engine.migrations").iterdir():
        match = re.match(r"^(\d+)_.+\.sql$", entry.name)
        if match:
            found.append((int(match.group(1)), entry.name, entry.read_text(encoding="utf-8")))
    return sorted(found)


def migrate(conn: psycopg.Connection, schema: str) -> list[str]:
    """Create the schema if needed and apply pending migrations. Returns the names applied."""
    path = search_path(schema)
    with conn.transaction():
        conn.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
        conn.execute(f"SET search_path TO {path}")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            " version integer PRIMARY KEY, name text NOT NULL,"
            " applied_at timestamptz NOT NULL DEFAULT now())"
        )
    applied = {row[0] for row in conn.execute("SELECT version FROM schema_migrations").fetchall()}
    done = []
    for version, name, sql in migration_files():
        if version in applied:
            continue
        with conn.transaction():
            # Serialise concurrent starters: only one applies each migration.
            conn.execute("SELECT pg_advisory_xact_lock(hashtext('memory_engine.migrate'))")
            if conn.execute("SELECT 1 FROM schema_migrations WHERE version = %s", (version,)).fetchone():
                continue
            conn.execute(sql)
            conn.execute("INSERT INTO schema_migrations (version, name) VALUES (%s, %s)", (version, name))
        log.info("Applied migration %s", name)
        done.append(name)
    return done


def schema_version(conn: psycopg.Connection) -> int:
    row = conn.execute("SELECT coalesce(max(version), 0) FROM schema_migrations").fetchone()
    return int(row[0]) if row else 0
