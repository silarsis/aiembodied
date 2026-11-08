import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from coder.app import create_app
from coder.config import Config

FAKE_PI = Path(__file__).parent / "fake_pi.py"


def sh(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True)


@pytest.fixture(autouse=True)
def clean_fake_env(monkeypatch):
    for k in list(os.environ):
        if k.startswith("FAKE_PI"):
            monkeypatch.delenv(k)


@pytest.fixture
def repo(tmp_path):
    """A repo with a bare origin; returns the work repo path."""
    origin, work = tmp_path / "origin.git", tmp_path / "work"
    sh("git", "init", "--bare", "-b", "main", str(origin))
    sh("git", "init", "-b", "main", str(work))
    for k, v in (("user.name", "Test"), ("user.email", "t@example.com")):
        sh("git", "config", k, v, cwd=work)
    (work / "README.md").write_text("hi\n")
    sh("git", "add", "-A", cwd=work)
    sh("git", "commit", "-m", "init", cwd=work)
    sh("git", "remote", "add", "origin", str(origin), cwd=work)
    sh("git", "push", "-u", "origin", "main", cwd=work)
    return work


@pytest.fixture
def cfg(tmp_path):
    return Config(data_dir=tmp_path / "data", pi_command=f'"{sys.executable}" "{FAKE_PI}"',
                  cancel_grace_s=0.2, settle_s=0.5, probe_timeout_s=10)


@pytest.fixture
def client(cfg):
    app = create_app(cfg)
    with TestClient(app) as c:
        c.manager = app.state.manager
        yield c


@pytest.fixture
def ws(client, repo):
    def make(**kw):
        body = {"id": "proj", "name": "Proj", "path": str(repo), "kind": "project", **kw}
        r = client.put("/v1/workspaces", json=[body])
        assert r.status_code == 200, r.text
        return r.json()[0]
    return make


def wait_status(client, tid, statuses, timeout=15):
    if isinstance(statuses, str):
        statuses = (statuses,)
    end = time.time() + timeout
    t = None
    while time.time() < end:
        t = client.get(f"/v1/tasks/{tid}").json()
        if t["status"] in statuses:
            return t
        time.sleep(0.05)
    raise AssertionError(f"task stuck at {t['status']} ({t.get('error')}), wanted {statuses}")


def new_task(client, **kw):
    r = client.post("/v1/tasks", json={"workspace_id": "proj", "goal": "Add a hello file", **kw})
    assert r.status_code == 200, r.text
    return r.json()
