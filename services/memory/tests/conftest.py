"""Database tests need a PostgreSQL with pgvector: set MEMORY_TEST_DATABASE_URL, e.g.
postgresql://memory:memory@127.0.0.1:5433/memory (scripts/start.ps1 -DatabaseOnly starts one).
Each test gets a schema of its own, dropped afterwards, so a real database is safe to use."""

from __future__ import annotations

import os
import uuid

import pytest

TEST_DATABASE_URL = os.environ.get("MEMORY_TEST_DATABASE_URL")


@pytest.fixture
def database_url():
    if not TEST_DATABASE_URL:
        pytest.skip("MEMORY_TEST_DATABASE_URL is not set")
    return TEST_DATABASE_URL


@pytest.fixture
def schema(database_url):
    import psycopg

    name = f"memtest_{uuid.uuid4().hex[:12]}"
    yield name
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f"DROP SCHEMA IF EXISTS {name} CASCADE")


@pytest.fixture
def client(database_url, schema):
    from fastapi.testclient import TestClient

    from memory_engine.app import Engine, create_app
    from memory_engine.embed import FakeEmbedder

    engine = Engine(database_url, schema, embedder=FakeEmbedder(), embed_inline=True)
    with TestClient(create_app(engine, connect_in_background=False)) as test_client:
        yield test_client


class FakeLlm:
    """Answers summary prompts from `reply(prompt)`; records every prompt it was given."""

    name = "fake-llm"

    def __init__(self, reply=None):
        self.prompts = []
        self.reply = reply or (lambda prompt: {"title": "A chat", "summary": "They talked.", "topics": ["chat"], "facts": []})

    def complete_json(self, system, user, schema):
        self.prompts.append(user)
        return self.reply(user)


@pytest.fixture
def llm():
    return FakeLlm()


@pytest.fixture
def summary_client(database_url, schema, llm):
    from datetime import timezone as tz

    from fastapi.testclient import TestClient

    from memory_engine.app import Engine, create_app
    from memory_engine.embed import FakeEmbedder
    from memory_engine.summaries import Summariser

    # UTC days, so test times land on predictable dates.
    summariser = Summariser(llm, tz.utc, idle_seconds=0)
    engine = Engine(database_url, schema, embedder=FakeEmbedder(), embed_inline=True, summariser=summariser)
    with TestClient(create_app(engine, connect_in_background=False)) as test_client:
        yield test_client
