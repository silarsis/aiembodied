"""Following pull requests: state, CI result, SSE event, track record, poller and refresh endpoint."""

from datetime import datetime, timedelta, timezone

from coder import github
from coder.app import create_app
from coder.capabilities import track_record
from fastapi.testclient import TestClient

PR = "https://github.com/acme/widgets/pull/7"


class FakeGitHub:
    """Stands in for github.get_json: serves a PR, check runs and a legacy status."""

    def __init__(self):
        self.state, self.merged, self.merged_at = "open", False, None
        self.runs, self.statuses = [], []
        self.fail = False
        self.calls = 0

    def __call__(self, api_base, token, path):
        self.calls += 1
        if self.fail:
            raise github.PrError(github.PR_READ_FAILED)
        if path.endswith("/pulls/7"):
            return {"state": self.state, "merged": self.merged, "merged_at": self.merged_at, "head": {"sha": "abc"}}
        if "/check-runs" in path:
            return {"check_runs": self.runs}
        if path.endswith("/status"):
            return {"statuses": self.statuses}
        raise AssertionError(path)


def run(status, conclusion=None):
    return {"status": status, "conclusion": conclusion}


def make_task(client, **kw):
    store = client.manager.store
    tid = store.new_id()
    f = {"id": tid, "workspace_id": "proj", "goal": "g", "status": "done", "provider": "local", "model": "m",
         "pr_url": PR, "finished_at": datetime.now(timezone.utc).isoformat()}
    f.update(kw)
    return store.create_task(**f)


def fake(monkeypatch, client):
    gh = FakeGitHub()
    monkeypatch.setattr(github, "get_json", gh)
    client.manager.keys["github"] = "tok"
    return gh


def test_ci_state_rules():
    assert github.ci_state([], []) is None
    assert github.ci_state([run("completed", "success"), run("completed", "skipped")], []) == "success"
    assert github.ci_state([run("completed", "cancelled")], []) is None
    assert github.ci_state([run("completed", "success"), run("in_progress")], []) == "pending"
    assert github.ci_state([run("queued"), run("completed", "timed_out")], []) == "failure"
    assert github.ci_state([run("completed", "success")], [{"state": "failure"}]) == "failure"
    assert github.ci_state([], [{"state": "success"}]) == "success"


def test_parse_pr_url():
    assert github.parse_pr_url(PR) == ("acme", "widgets", 7)
    assert github.parse_pr_url("https://example.com/a/b/pull/1") is None
    assert github.parse_pr_url(None) is None


def test_columns_in_task_json_and_migration(client, tmp_path):
    t = make_task(client)
    j = client.get(f"/v1/tasks/{t['id']}").json()
    assert j["pr_state"] is None and j["ci_state"] is None and j["pr_checked_at"] is None and j["merged_at"] is None
    import sqlite3
    from coder.store import Store
    db = sqlite3.connect(str(tmp_path / "old.sqlite"))
    db.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, questions TEXT, pr_url TEXT)")
    db.commit(); db.close()
    s = Store(tmp_path / "old.sqlite")
    cols = {r[1] for r in s.db.execute("PRAGMA table_info(tasks)")}
    s.close()
    assert {"pr_state", "ci_state", "pr_checked_at", "merged_at"} <= cols


def test_open_then_merged_with_event(client, monkeypatch):
    gh = fake(monkeypatch, client)
    got = []
    client.manager.on_change = got.append
    t = make_task(client)
    gh.runs = [run("in_progress")]
    r = client.post(f"/v1/tasks/{t['id']}/pr/refresh")
    assert r.status_code == 200
    assert (r.json()["pr_state"], r.json()["ci_state"]) == ("open", "pending") and r.json()["pr_checked_at"]
    assert got == [{"type": "pr", "task_id": t["id"], "pr_state": "open", "ci_state": "pending"}]
    client.post(f"/v1/tasks/{t['id']}/pr/refresh")
    assert len(got) == 1  # nothing changed, no event
    gh.state, gh.merged, gh.merged_at, gh.runs = "closed", True, "2026-11-09T10:00:00Z", [run("completed", "success")]
    j = client.post(f"/v1/tasks/{t['id']}/pr/refresh").json()
    assert (j["pr_state"], j["ci_state"], j["merged_at"]) == ("merged", "success", "2026-11-09T10:00:00Z")
    assert got[-1]["pr_state"] == "merged" and len(got) == 2
    assert "pr" in [e["type"] for e in client.get(f"/v1/tasks/{t['id']}/events").json()]


def test_ci_failure_and_closed(client, monkeypatch):
    gh = fake(monkeypatch, client)
    t = make_task(client)
    gh.state, gh.runs = "closed", [run("completed", "failure"), run("completed", "success")]
    j = client.post(f"/v1/tasks/{t['id']}/pr/refresh").json()
    assert (j["pr_state"], j["ci_state"], j["merged_at"]) == ("closed", "failure", None)


def test_refresh_errors(client, monkeypatch):
    assert client.post("/v1/tasks/nope/pr/refresh").status_code == 404
    t = make_task(client, pr_url=None)
    assert client.post(f"/v1/tasks/{t['id']}/pr/refresh").status_code == 409
    gh = fake(monkeypatch, client)
    t = make_task(client)
    gh.fail = True
    r = client.post(f"/v1/tasks/{t['id']}/pr/refresh")
    assert r.status_code == 502 and r.json()["detail"] == github.PR_READ_FAILED


def test_poll_checks_only_followed_prs(client, monkeypatch):
    gh = fake(monkeypatch, client)
    fresh = make_task(client)
    merged = make_task(client, pr_state="merged")
    old = make_task(client, finished_at=(datetime.now(timezone.utc) - timedelta(days=31)).isoformat())
    nopr = make_task(client, pr_url=None)
    assert client.manager.poll_prs() == 1
    store = client.manager.store
    assert store.get_task(fresh["id"])["pr_state"] == "open"
    assert store.get_task(merged["id"])["pr_checked_at"] is None
    assert store.get_task(old["id"])["pr_state"] is None and store.get_task(nopr["id"])["pr_state"] is None
    gh.fail = True
    assert client.manager.poll_prs() == 0  # failure is survived


def test_poller_disabled_at_zero_and_runs_when_on(cfg, monkeypatch):
    import time
    gh = FakeGitHub()
    monkeypatch.setattr(github, "get_json", gh)
    cfg.pr_poll_seconds = 0
    app = create_app(cfg)
    with TestClient(app) as c:
        c.manager = app.state.manager
        c.manager.keys["github"] = "tok"
        t = make_task(c)
        time.sleep(0.4)
        assert gh.calls == 0 and c.manager.store.get_task(t["id"])["pr_state"] is None
    cfg.pr_poll_seconds = 0.05
    app = create_app(cfg)
    with TestClient(app) as c:
        c.manager = app.state.manager
        c.manager.keys["github"] = "tok"
        end = time.time() + 5
        while time.time() < end and c.manager.store.get_task(t["id"])["pr_state"] is None:
            time.sleep(0.05)
        assert c.manager.store.get_task(t["id"])["pr_state"] == "open"


def test_track_record_numbers(client):
    for st, ci in (("merged", "success"), ("merged", "failure"), ("closed", "failure"), ("open", "pending"), (None, None)):
        make_task(client, pr_state=st, ci_state=ci)
    tr = track_record(client.manager.store)[0]
    assert tr["with_pr"] == 5 and tr["merged"] == 2 and tr["closed_unmerged"] == 1
    assert tr["ci_pass_rate"] == 1 / 3 and "checks_pass_rate" in tr and "median_minutes" in tr


def test_poll_setting(client):
    assert client.get("/v1/settings").json()["pr_poll_seconds"] == 300
    assert client.put("/v1/settings", json={"pr_poll_seconds": 0}).json()["pr_poll_seconds"] == 0
