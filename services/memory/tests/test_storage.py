import time
import uuid
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import psycopg
import pytest

from test_recall import message, post


@pytest.fixture
def second_database(database_url):
    """A second, empty database on the same server: somewhere to move or mirror to."""
    name = f"memtest_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f"CREATE DATABASE {name}")
    parts = urlsplit(database_url)
    yield urlunsplit(parts._replace(path=f"/{name}"))
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


def make_client(database_url, schema, settings_file):
    from fastapi.testclient import TestClient

    from memory_engine.app import Engine, create_app
    from memory_engine.embed import FakeEmbedder

    engine = Engine(database_url, schema, embedder=FakeEmbedder(), embed_inline=True, settings_file=settings_file)
    return engine, TestClient(create_app(engine, connect_in_background=False))


def wait_ready(client, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if client.get("/health").json()["status"] == "ok":
            return
        time.sleep(0.2)
    raise AssertionError("engine did not become ready")


def count(url, schema, table):
    with psycopg.connect(url) as conn:
        return conn.execute(f"SELECT count(*) FROM {schema}.{table}").fetchone()[0]


def test_moving_to_an_empty_database_copies_everything_and_is_remembered(database_url, schema, second_database, tmp_path):
    settings = tmp_path / "engine-settings.json"
    engine, client = make_client(database_url, schema, settings)
    with client:
        session = uuid4()
        post(client, message(session, "user", "the tomatoes are in the greenhouse", 0))
        client.put(f"/v1/facts/{uuid4()}", json={"text": "Grows tomatoes", "pinned": True})

        view = client.put("/v1/storage", json={"database": second_database, "mirror": None}).json()
        assert view["database"]["local"] is False
        wait_ready(client)
        assert count(second_database, schema, "messages") == 1
        assert client.get("/v1/search", params={"q": "tomatoes"}).json()["results"]
        assert client.get("/v1/facts").json()["facts"][0]["text"] == "Grows tomatoes"
        # New writes carry on numbering after the copied rows.
        post(client, message(session, "user", "and the basil", 10))

    # A restart comes back to the same database, from the saved settings.
    engine2, client2 = make_client(database_url, schema, settings)
    with client2:
        assert engine2.database_url == second_database
        assert client2.get("/health").json()["storage"]["database"]["local"] is False


def test_a_mirror_gets_new_rows_changes_and_deletes(database_url, schema, second_database, tmp_path):
    engine, client = make_client(database_url, schema, tmp_path / "s.json")
    with client:
        keep, gone = uuid4(), uuid4()
        post(client, message(keep, "user", "keep this one", 0), message(gone, "user", "forget this one", 5))
        fact = str(uuid4())
        client.put(f"/v1/facts/{fact}", json={"text": "Likes tea"})
        for session in (keep, gone):
            client.post("/v1/recall", json={"text": "what did we say about that one", "session_id": str(session)})
        client.put("/v1/storage", json={"database": None, "mirror": second_database})
        assert client.post("/v1/storage/push").json()["sent"] > 0
        assert count(second_database, schema, "sessions") == 2
        assert count(second_database, schema, "recall_log") == 2

        # Forgetting one message also forgets it from the mirror's recall log.
        said = message(keep, "user", "my bank pin is in the drawer", 20)
        post(client, said)
        client.post("/v1/recall", json={"text": said["content"], "session_id": str(keep)})
        client.post("/v1/storage/push")
        assert count(second_database, schema, "recall_log") == 3
        client.delete(f"/v1/messages/{said['id']}")
        client.patch(f"/v1/facts/{fact}", json={"pinned": True})
        client.delete(f"/v1/sessions/{gone}")
        post(client, message(keep, "user", "a later message", 60))
        client.post("/v1/storage/push")
        with psycopg.connect(second_database) as conn:
            sessions = conn.execute(f"SELECT id FROM {schema}.sessions").fetchall()
            pinned = conn.execute(f"SELECT pinned FROM {schema}.facts WHERE id = %s", (fact,)).fetchone()[0]
            messages = conn.execute(f"SELECT count(*) FROM {schema}.messages").fetchone()[0]
            embedded = conn.execute(f"SELECT count(*) FROM {schema}.recall_index WHERE embedding IS NOT NULL").fetchone()[0]
        assert [str(r[0]) for r in sessions] == [str(keep)]
        # One session forgotten, one message forgotten: only keep's first query is left.
        assert count(second_database, schema, "recall_log") == 1
        assert pinned is True
        assert messages == 2
        assert embedded >= 1
        storage = client.get("/v1/storage").json()
        assert storage["mirror"]["pushed_at"] and storage["mirror"]["error"] is None
        # Nothing new: nothing (beyond the small resend window) changes.
        before = count(second_database, schema, "messages")
        client.post("/v1/storage/push")
        assert count(second_database, schema, "messages") == before


def test_moving_to_a_database_that_already_has_memory_uses_it_as_it_is(database_url, schema, second_database, tmp_path):
    engine, client = make_client(database_url, schema, tmp_path / "s.json")
    with client:
        post(client, message(uuid4(), "user", "on the first one", 0))
        client.put("/v1/storage", json={"database": second_database, "mirror": None})
        wait_ready(client)
        post(client, message(uuid4(), "user", "on the second one", 10))
        client.put("/v1/storage", json={"database": None, "mirror": None})
        wait_ready(client)
        texts = [r["text"] for r in client.get("/v1/search", params={"q": "one"}).json()["results"]]
        assert texts == ["User: on the first one"]


def test_storage_rejects_other_addresses_and_tests_a_connection(client, database_url):
    assert client.put("/v1/storage", json={"database": "http://example.com"}).status_code == 400
    ok = client.post("/v1/storage/test", json={"url": database_url}).json()
    assert ok["ok"] is True
    parts = urlsplit(database_url)
    wrong = urlunsplit(parts._replace(netloc=f"{parts.username or 'x'}:wrong@127.0.0.1:1"))
    failed = client.post("/v1/storage/test", json={"url": wrong}).json()
    assert failed["ok"] is False and "reached" in failed["error"]


def test_a_move_from_a_database_that_cannot_be_read_stays_put(database_url, schema, second_database, tmp_path, monkeypatch):
    from memory_engine import mirror

    def unreadable(*_args, **_kwargs):
        raise mirror.SourceUnavailable("connection refused")

    monkeypatch.setattr(mirror, "copy_all", unreadable)
    engine, client = make_client(database_url, schema, tmp_path / "s.json")
    with client:
        client.put("/v1/storage", json={"database": second_database, "mirror": None})
        deadline = time.monotonic() + 20
        while engine.moving and time.monotonic() < deadline:
            time.sleep(0.1)
        wait_ready(client)
        assert engine.database_url == database_url
        view = client.get("/v1/storage").json()
        assert view["database"]["local"] is True
        assert "couldn't be read" in view["move_error"]


def test_a_second_move_waits_for_the_first(database_url, schema, second_database, tmp_path):
    engine, client = make_client(database_url, schema, tmp_path / "s.json")
    with client:
        engine.moving = True
        try:
            response = client.put("/v1/storage", json={"database": second_database, "mirror": None})
        finally:
            engine.moving = False
        assert response.status_code == 503
        assert engine.database_url == database_url

