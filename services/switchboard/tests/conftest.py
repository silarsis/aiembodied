import pytest
from fastapi.testclient import TestClient

from switchboard.app import create_app
from switchboard.models import Config


def ev(type_="test.ping", producer="tool:test", to=(), **kw):
    kind, _, ident = producer.partition(":")
    return {"type": type_, "producer": {"kind": kind, "id": ident}, "to": list(to), **kw}


@pytest.fixture
def cfg(tmp_path):
    return Config(db_path=tmp_path / "sb" / "switchboard.db", retention_days=30, node="testnode")


@pytest.fixture
def client(cfg):
    app = create_app(cfg)
    with TestClient(app) as c:
        c.hub = app.state.hub
        yield c


@pytest.fixture
def publish(client):
    def go(*events):
        r = client.post("/v1/events", json={"events": list(events)})
        assert r.status_code == 200, r.text
        return r.json()["ids"]
    return go
