import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from coder import github, gitops
from coder.app import create_app
from coder.manager import slugify
from conftest import new_task, wait_status


def git(repo, *a):
    return subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True).stdout.strip()


# ---- workspaces -------------------------------------------------------------------------------

def test_workspace_validation(client, ws, tmp_path):
    w = ws(kind="self")
    assert w["base_branch"] == "main"
    assert "services/coder/" in w["protected_paths"]
    assert client.get("/v1/workspaces").json()[0]["id"] == "proj"
    (tmp_path / "plain").mkdir()
    r = client.put("/v1/workspaces", json=[{"id": "x", "path": str(tmp_path / "plain")}])
    assert r.status_code == 400
    r = client.put("/v1/workspaces", json=[{"id": "Bad Id", "path": w["path"]}])
    assert r.status_code == 400
    r = client.put("/v1/workspaces", json=[{"id": "a", "path": w["path"]}, {"id": "a", "path": w["path"]}])
    assert r.status_code == 400
    r = client.put("/v1/workspaces", json=[{"id": "x", "path": w["path"], "kind": "weird"}])
    assert r.status_code == 422


def test_keys_never_returned(client):
    assert client.put("/v1/keys", json={"openai": "sk-secret"}).status_code == 204
    r = client.get("/v1/keys")
    assert r.json() == {"openai": True, "anthropic": False, "github": False}
    assert "sk-secret" not in r.text


def test_task_needs_key_for_provider(client, ws):
    ws()
    r = client.post("/v1/tasks", json={"workspace_id": "proj", "goal": "x", "model": {"provider": "openai", "id": "gpt"}})
    assert r.status_code == 400
    assert client.post("/v1/tasks", json={"workspace_id": "nope", "goal": "x"}).status_code == 404


# ---- full flow --------------------------------------------------------------------------------

def test_flow_to_review_with_diff_stats(client, ws, repo):
    ws(checks="echo checks-ran && true")
    t = new_task(client, acceptance=["file exists"], scope=["hello.txt"])
    assert t["id"][:8].isdigit() and t["branch"].startswith(f"echo/{t['id']}-add-a-hello-file")
    t = wait_status(client, t["id"], "review")
    assert t["files_touched"] == ["hello.txt"]
    assert t["last_text"] == "Wrote hello.txt"
    assert t["checks_ok"] is True and "checks-ran" in t["checks_output"]
    rev = t["review"]
    assert rev["changed_files"] == ["hello.txt"] and rev["added"] == 1 and rev["protected_violations"] == []
    assert git(t["worktree"], "log", "-1", "--format=%s") == "Add a hello file"
    # the checkout itself is untouched
    assert not (repo / "hello.txt").exists()
    diff = client.get(f"/v1/tasks/{t['id']}/diff").text
    assert "+hello from fake pi" in diff
    events = client.get(f"/v1/tasks/{t['id']}/events").json()
    types = {e["type"] for e in events}
    assert {"agent_start", "tool_execution_start", "future_unknown_event", "log", "status"} <= types
    seqs = [e["seq"] for e in events]
    assert seqs == sorted(seqs)
    assert client.get(f"/v1/tasks/{t['id']}/events?after={seqs[-1]}").json() == []
    assert [x["id"] for x in client.get("/v1/tasks").json()] == [t["id"]]
    assert client.get("/v1/tasks?status=failed").json() == []


def test_failing_checks_recorded(client, ws):
    ws(checks="echo nope; exit 3")
    t = wait_status(client, new_task(client)["id"], "review")
    assert t["checks_ok"] is False and "nope" in t["checks_output"]


def test_settles_without_agent_settled(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "nosettled")
    ws()
    wait_status(client, new_task(client)["id"], "review")


def test_no_changes_is_done(client, ws, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_PI_MODE", "question")
    ws()
    t = wait_status(client, new_task(client)["id"], "question")
    client.post(f"/v1/tasks/{t['id']}/answer", json={"confirmed": False})
    t = wait_status(client, t["id"], "done")
    assert t["review"]["no_changes"] is True
    assert not Path(t["worktree"]).exists()


def test_follow_up_after_review(client, ws):
    ws()
    t = wait_status(client, new_task(client)["id"], "review")
    r = client.post(f"/v1/tasks/{t['id']}/follow_up", json={"message": "again"})
    assert r.status_code == 200, r.text
    t = wait_status(client, t["id"], "review")
    assert "run 2" in client.get(f"/v1/tasks/{t['id']}/diff").text
    assert client.post(f"/v1/tasks/{t['id']}/follow_up", json={"message": "x"}).status_code == 200
    wait_status(client, t["id"], "review")


# ---- apply ------------------------------------------------------------------------------------

def test_protected_violation_blocks_apply(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_FILE", "services/coder/x.txt")
    ws(protected_paths=["services/coder/"])
    t = wait_status(client, new_task(client)["id"], "review")
    assert t["review"]["protected_violations"] == ["services/coder/x.txt"]
    assert any("protected" in f for f in t["review"]["flags"])
    assert client.post(f"/v1/tasks/{t['id']}/apply").status_code == 409


def test_apply_pushes_branch(client, ws, repo, tmp_path):
    ws()
    t = wait_status(client, new_task(client)["id"], "review")
    r = client.post(f"/v1/tasks/{t['id']}/apply", json={})
    assert r.status_code == 200, r.text
    t = r.json()
    assert t["status"] == "done" and t["pr_url"] is None and "pushed" in t["phase_detail"]
    origin = tmp_path / "origin.git"
    assert git(origin, "rev-parse", "--verify", t["branch"])
    assert not Path(t["worktree"]).exists()
    assert client.post(f"/v1/tasks/{t['id']}/apply").status_code == 409


def test_apply_requires_review(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "hang")
    ws()
    t = new_task(client)
    wait_status(client, t["id"], "working")
    assert client.post(f"/v1/tasks/{t['id']}/apply").status_code == 409
    client.post(f"/v1/tasks/{t['id']}/cancel")


def test_parse_owner_repo():
    for url in ("https://github.com/acme/widgets.git", "git@github.com:acme/widgets.git",
                "ssh://git@github.com/acme/widgets", "https://tok@github.com/acme/widgets/"):
        assert gitops.parse_owner_repo(url) == ("acme", "widgets"), url
    assert gitops.parse_owner_repo("/tmp/origin.git") is None
    assert gitops.parse_owner_repo("https://gitlab.com/a/b") is None


def test_create_pr_api_against_stub():
    seen = {}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            seen["path"] = self.path
            seen["auth"] = self.headers["Authorization"]
            seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            data = json.dumps({"html_url": "https://github.com/acme/widgets/pull/7"}).encode()
            self.send_response(201); self.send_header("Content-Length", str(len(data))); self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = github.create_pr_api(f"http://127.0.0.1:{srv.server_port}", "tok", "acme", "widgets", "echo/x", "main",
                               "Title", "Body", True)
    srv.shutdown()
    assert url.endswith("/pull/7")
    assert seen["path"] == "/repos/acme/widgets/pulls" and seen["auth"] == "Bearer tok"
    assert seen["body"]["head"] == "echo/x" and seen["body"]["draft"] is True


# ---- questions, cancel, discard ----------------------------------------------------------------

def test_question_and_answer(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "question")
    ws()
    t = wait_status(client, new_task(client)["id"], "question")
    assert t["question"]["id"] == "q1" and t["question"]["method"] == "confirm"
    assert client.post(f"/v1/tasks/{t['id']}/answer", json={}).status_code == 400
    assert client.post(f"/v1/tasks/{t['id']}/answer", json={"confirmed": True}).status_code == 200
    t = wait_status(client, t["id"], "review")
    assert t["question"] is None and t["files_touched"] == ["hello.txt"]
    assert client.post(f"/v1/tasks/{t['id']}/answer", json={"confirmed": True}).status_code == 409
    types = [e["type"] for e in client.get(f"/v1/tasks/{t['id']}/events").json()]
    assert "extension_ui_request" in types


def test_cancel_keeps_worktree(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "hang")
    ws()
    t = new_task(client)
    t = wait_status(client, t["id"], "working")
    r = client.post(f"/v1/tasks/{t['id']}/cancel")
    assert r.json()["status"] == "cancelled"
    assert Path(t["worktree"]).is_dir()
    assert client.get(f"/v1/tasks/{t['id']}").json()["status"] == "cancelled"
    assert client.post(f"/v1/tasks/{t['id']}/cancel").status_code == 409


def test_steer_requires_running(client, ws):
    ws()
    t = wait_status(client, new_task(client)["id"], "review")
    assert client.post(f"/v1/tasks/{t['id']}/steer", json={"message": "x"}).status_code == 409


def test_discard_removes_worktree_and_branch(client, ws, repo):
    ws()
    t = wait_status(client, new_task(client)["id"], "review")
    assert Path(t["worktree"]).is_dir() and git(repo, "branch", "--list", t["branch"])
    r = client.post(f"/v1/tasks/{t['id']}/discard")
    assert r.json()["status"] == "discarded"
    assert not Path(t["worktree"]).exists()
    assert git(repo, "branch", "--list", t["branch"]) == ""
    assert client.get(f"/v1/tasks/{t['id']}/events").json()  # events kept


def test_time_limit(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "hang")
    ws(time_limit_min=0.02)
    t = wait_status(client, new_task(client)["id"], "failed")
    assert t["error"] == "time limit"


def test_queue_runs_one_at_a_time(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "hang")
    ws()
    a, b = new_task(client), new_task(client, goal="second")
    wait_status(client, a["id"], "working")
    assert client.get(f"/v1/tasks/{b['id']}").json()["status"] == "queued"
    client.post(f"/v1/tasks/{a['id']}/cancel")
    wait_status(client, b["id"], "working")
    client.post(f"/v1/tasks/{b['id']}/cancel")


# ---- restart, env, capabilities ----------------------------------------------------------------

def test_startup_marks_stale_tasks_failed(cfg, repo, ws, client):
    ws()
    store = client.app.state.store
    t = store.create_task(id="20260101-aaaa", workspace_id="proj", goal="g", status="working", branch="b")
    q = store.create_task(id="20260101-bbbb", workspace_id="proj", goal="g", status="review", branch="b2")
    app2 = create_app(cfg)
    s2 = app2.state.store
    assert s2.get_task(t["id"])["status"] == "failed" and s2.get_task(t["id"])["error"] == "runner restarted"
    assert s2.get_task(q["id"])["status"] == "review"


def test_env_is_stripped_and_provider_key_passed(client, ws, monkeypatch, tmp_path):
    dump = tmp_path / "env.json"
    monkeypatch.setenv("FAKE_PI_ENV_DUMP", str(dump))
    monkeypatch.setenv("FAKE_PI_ARGV_DUMP", str(tmp_path / "argv.json"))
    for k, v in {"GITHUB_TOKEN": "g", "GH_TOKEN": "g", "HA_URL": "u", "SOME_API_KEY": "k", "OPENAI_API_KEY": "host-key",
                 "MY_SECRET": "s", "DB_TOKEN": "t", "KEEP_ME": "yes"}.items():
        monkeypatch.setenv(k, v)
    ws(protected_paths=["a/", "b.ts"])
    client.put("/v1/keys", json={"openai": "sk-from-app", "github": "ghp"})
    wait_status(client, new_task(client, model={"provider": "openai", "id": "gpt-x"})["id"], "review")
    d = json.loads(dump.read_text())
    env = d["env"]
    for k in ("GITHUB_TOKEN", "GH_TOKEN", "HA_URL", "SOME_API_KEY", "MY_SECRET", "DB_TOKEN"):
        assert k not in env
    assert env["KEEP_ME"] == "yes" and env["OPENAI_API_KEY"] == "sk-from-app"
    assert "ANTHROPIC_API_KEY" not in env
    assert env["CODER_PROTECTED_PATHS"] == "a/;b.ts"
    assert env["PI_CODING_AGENT_DIR"].endswith("pi-agent")
    assert "worktrees" in d["cwd"]
    argv = json.loads((tmp_path / "argv.json").read_text())
    assert argv[:1] == ["--mode"] and "rpc" in argv and argv[argv.index("--provider") + 1] == "openai"
    assert argv[argv.index("--model") + 1] == "gpt-x"
    # keys are never stored or logged
    for p in (tmp_path / "data").rglob("*"):
        if p.is_file() and p.suffix in (".json", ".sqlite", ".log"):
            assert b"sk-from-app" not in p.read_bytes() and b"ghp" not in p.read_bytes()


def test_agent_dir_written(client, cfg):
    d = cfg.agent_dir
    models = json.loads((d / "models.json").read_text())
    assert models["providers"]["local"]["baseUrl"] == cfg.local_llm_url
    s = json.loads((d / "settings.json").read_text())
    assert s["defaultProvider"] == "local" and s["packages"] == []
    assert "tool_call" in (d / "extensions" / "aiembodied-guard.ts").read_text()
    assert not (d / "auth.json").exists()


def test_capabilities(client, ws, repo):
    (repo / "package.json").write_text(json.dumps({"scripts": {"typecheck": "tsc", "test": "vitest"}}))
    (repo / "pnpm-lock.yaml").write_text("")
    (repo / "pnpm-workspace.yaml").write_text("")
    (repo / "AGENTS.md").write_text("x")
    ws()
    t = wait_status(client, new_task(client)["id"], "review")
    client.post(f"/v1/tasks/{t['id']}/apply")
    c = client.get("/v1/capabilities").json()
    assert c["backend"]["name"] == "pi" and c["backend"]["version"] == "fake-pi 9.9.9"
    assert c["backend"]["models"] == [{"provider": "local", "id": "fake-model"}] and c["backend"]["error"] is None
    d = c["workspaces"][0]["detected"]
    assert d["package_manager"] == "pnpm" and d["checks_suggestion"] == "pnpm -w typecheck && pnpm test"
    assert d["has_agents_md"] and not d["has_claude_md"] and d["dirty"]
    assert d["remote_url"].endswith("origin.git") and d["base_branch"] == "main"
    tr = c["track_record"][0]
    assert tr["workspace_id"] == "proj" and tr["model"] == "qwen3-coder-next" and tr["started"] == 1 and tr["done"] == 1
    assert tr["median_minutes"] is not None
    assert client.get("/v1/capabilities?refresh=1").status_code == 200


def test_capabilities_probe_failure(cfg, ws):
    cfg.pi_command = "definitely-not-a-command-xyz"
    with TestClient(create_app(cfg)) as c:
        r = c.get("/v1/capabilities").json()
        assert r["backend"]["error"] and r["backend"]["models"] == []
        assert c.get("/v1/health").json()["pi"]["found"] is False


def test_health(client):
    h = client.get("/v1/health").json()
    assert h["ok"] and h["pi"]["found"] and h["pi"]["version"] == "fake-pi 9.9.9"


def test_event_hub_publish():
    import asyncio
    from coder.app import EventHub

    async def go():
        hub = EventHub()
        q = hub.subscribe()
        threading.Thread(target=hub.publish, args=({"task_id": "x", "status": "working"},)).start()
        return await asyncio.wait_for(q.get(), 2)

    assert asyncio.run(go())["status"] == "working"


def test_slugify():
    assert slugify("Fix the *bug* in X!!") == "fix-the-bug-in-x"
    assert len(slugify("a" * 100)) == 40 and slugify("???") == "task"


# ---- settings, local model wait, status, resume ------------------------------------------------

def test_settings_roundtrip_and_agent_dir(cfg, client, tmp_path):
    r = client.get("/v1/settings").json()
    assert r["default_model"] == {"provider": "local", "id": cfg.local_model}
    body = {"local_llm_url": "http://127.0.0.1:9/v1/", "local_model": "m2",
            "default_model": {"provider": "openai", "id": "gpt-x"}}
    r = client.put("/v1/settings", json=body)
    assert r.status_code == 200 and r.json()["local_llm_url"] == "http://127.0.0.1:9/v1"
    models = json.loads((cfg.agent_dir / "models.json").read_text())
    assert models["providers"]["local"]["baseUrl"] == "http://127.0.0.1:9/v1"
    assert models["providers"]["local"]["models"] == [{"id": "m2"}]
    # a new runner on the same data dir reads the saved file
    from coder.config import Config
    c2 = Config(data_dir=cfg.data_dir)
    create_app(c2)
    assert c2.local_model == "m2" and c2.default_model == {"provider": "openai", "id": "gpt-x"}
    # partial update keeps the rest
    client.put("/v1/settings", json={"local_model": "m3"})
    assert client.get("/v1/settings").json()["default_model"]["id"] == "gpt-x"
    assert client.put("/v1/settings", json={"default_model": {"provider": "bad", "id": "x"}}).status_code == 422


def test_task_without_model_uses_default_model(client, ws):
    ws()
    client.put("/v1/keys", json={"anthropic": "k"})
    client.put("/v1/settings", json={"default_model": {"provider": "anthropic", "id": "claude-x"}})
    t = new_task(client)
    assert (t["provider"], t["model"]) == ("anthropic", "claude-x")
    wait_status(client, t["id"], "review")


def test_local_task_waits_for_model(client, ws, llm):
    llm.ready = False
    ws()
    t = new_task(client)
    t = wait_status(client, t["id"], "starting")
    for _ in range(40):
        t = client.get(f"/v1/tasks/{t['id']}").json()
        if t["phase_detail"] == "waiting for the local model":
            break
        time.sleep(0.05)
    assert t["phase_detail"] == "waiting for the local model"
    assert client.get("/v1/status").json() == {"local_model_needed": True, "active": [t["id"]], "hold": False}
    llm.ready = True
    wait_status(client, t["id"], "review")
    assert client.get("/v1/status").json() == {"local_model_needed": False, "active": [], "hold": False}


def test_local_wait_times_out(cfg, client, ws, llm):
    llm.ready = False
    cfg.local_wait_s = 0.4
    ws()
    t = wait_status(client, new_task(client)["id"], "failed")
    assert t["error"] == "local model did not start"


def test_follow_up_waits_for_model(client, ws, llm):
    ws()
    t = wait_status(client, new_task(client)["id"], "review")
    llm.ready = False
    client.post(f"/v1/tasks/{t['id']}/follow_up", json={"message": "again"})
    assert client.get("/v1/status").json()["local_model_needed"] is True
    time.sleep(0.4)
    assert client.get(f"/v1/tasks/{t['id']}").json()["status"] == "starting"
    llm.ready = True
    wait_status(client, t["id"], "review")


def test_status_not_needed_for_remote_task(client, ws):
    ws()
    client.put("/v1/keys", json={"openai": "k"})
    t = new_task(client, model={"provider": "openai", "id": "gpt-x"})
    assert client.get("/v1/status").json()["local_model_needed"] is False
    wait_status(client, t["id"], "review")


def test_sse_messages_carry_local_model_needed(client, ws):
    ws()
    seen = []
    client.app.state.manager.on_change = seen.append
    wait_status(client, new_task(client)["id"], "review")
    # The store is written just before the change is published, so the last message can trail the status.
    deadline = time.time() + 5
    while not (seen and seen[-1].get("status") == "review") and time.time() < deadline:
        time.sleep(0.05)
    assert seen and all("local_model_needed" in m for m in seen)
    assert any(m["local_model_needed"] for m in seen) and seen[-1]["local_model_needed"] is False


def test_resume_after_restart(cfg, repo, client, ws, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_PI_MODE", "hang")
    ws()
    t = wait_status(client, new_task(client)["id"], "working")
    client.app.state.manager.shutdown()  # like a crash: the database still says working
    run = client.app.state.manager._runs[t["id"]]
    assert run.pi.exited.wait(5)
    time.sleep(0.3)  # let the old runner's last event writes finish before a second runner uses the database
    assert client.app.state.store.get_task(t["id"])["status"] == "working"
    monkeypatch.setenv("FAKE_PI_MODE", "normal")
    monkeypatch.setenv("FAKE_PI_ARGV_DUMP", str(tmp_path / "argv.json"))
    with TestClient(create_app(cfg)) as c2:
        t2 = wait_status(c2, t["id"], "review")
        assert t2["error"] is None
        events = c2.get(f"/v1/tasks/{t['id']}/events").json()
        assert any(e["type"] == "runner" and "resuming" in json.dumps(e["payload"]) for e in events)
    argv = json.loads((tmp_path / "argv.json").read_text())
    assert "--continue" in argv and argv[argv.index("--session-dir") + 1].endswith(t["id"])


def test_restart_recovery_other_states(cfg, repo, client, ws):
    ws()
    store = client.app.state.store
    wt = cfg.worktrees_dir / "20260101-cccc"
    gitops.create_worktree(repo, "origin", "main", "echo/x", wt)
    base = git(wt, "rev-parse", "HEAD")
    store.create_task(id="20260101-cccc", workspace_id="proj", goal="g", status="pushing", branch="echo/x",
                      worktree=str(wt), base_commit=base)
    store.create_task(id="20260101-dddd", workspace_id="proj", goal="g", status="working", branch="b",
                      worktree=str(cfg.worktrees_dir / "missing"), base_commit="abc")
    c2 = create_app(cfg).state.store
    a, b = c2.get_task("20260101-cccc"), c2.get_task("20260101-dddd")
    assert a["status"] == "review" and a["error"] == "runner restarted during push"
    assert b["status"] == "failed" and b["error"] == "runner restarted"


# ---- ask_echo, several dialogs, text questions, paused time limit -----------------------------

def test_ask_echo_question_kind_and_answer(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "ask")
    ws()
    t = wait_status(client, new_task(client)["id"], "question")
    q = t["question"]
    assert q["kind"] == "ask_echo" and q["method"] == "input" and q["message"] == "Which port?"
    assert q["title"] == "Question from pi" and q["asked_at"]
    assert t["questions"] == [q]
    r = client.post(f"/v1/tasks/{t['id']}/answer", json={"value": "8080"})
    assert r.status_code == 200
    t = wait_status(client, t["id"], "review")
    assert t["questions"] == [] and t["question"] is None
    assert "8080" in (Path(t["worktree"]) / "hello.txt").read_text()


def test_confirm_question_has_kind_confirm(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "question")
    ws()
    t = wait_status(client, new_task(client)["id"], "question")
    assert t["question"]["kind"] == "confirm"
    client.post(f"/v1/tasks/{t['id']}/answer", json={"confirmed": False})
    wait_status(client, t["id"], ("review", "done"))


def _dialog(client, ws, monkeypatch, mode):
    monkeypatch.setenv("FAKE_PI_MODE", mode)
    ws()
    return wait_status(client, new_task(client)["id"], "question")


def _note(client, tid):
    t = wait_status(client, tid, "review")
    return (Path(t["worktree"]) / "hello.txt").read_text()


def test_select_question_kind_options_and_answer(client, ws, monkeypatch):
    t = _dialog(client, ws, monkeypatch, "select")
    q = t["question"]
    assert q["kind"] == "select" and q["options"] == ["red", "green"]
    assert client.post(f"/v1/tasks/{t['id']}/answer", json={"value": "blue"}).status_code == 400
    assert client.post(f"/v1/tasks/{t['id']}/answer", json={"confirmed": True}).status_code == 400
    assert client.post(f"/v1/tasks/{t['id']}/answer", json={"value": "green"}).status_code == 200
    assert '{"value": "green"}' in _note(client, t["id"])


@pytest.mark.parametrize("mode", ["input", "editor"])
def test_input_and_editor_questions_answer_with_value(client, ws, monkeypatch, mode):
    t = _dialog(client, ws, monkeypatch, mode)
    assert t["question"]["kind"] == "input" and t["question"]["method"] == mode
    assert client.post(f"/v1/tasks/{t['id']}/answer", json={"confirmed": True}).status_code == 400
    assert client.post(f"/v1/tasks/{t['id']}/answer", json={"value": "hi"}).status_code == 200
    assert '{"value": "hi"}' in _note(client, t["id"])


def test_confirm_answer_sends_confirmed_only(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "question")
    ws()
    t = wait_status(client, new_task(client)["id"], "question")
    assert client.post(f"/v1/tasks/{t['id']}/answer", json={"value": "yes"}).status_code == 400
    assert client.post(f"/v1/tasks/{t['id']}/answer", json={"confirmed": True}).status_code == 200


def test_several_pending_dialogs_answer_by_id_or_oldest(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "two")
    ws()
    tid = new_task(client)["id"]
    end = time.time() + 10
    t = client.get(f"/v1/tasks/{tid}").json()
    while len(t["questions"]) < 2 and time.time() < end:
        time.sleep(0.05)
        t = client.get(f"/v1/tasks/{tid}").json()
    assert [q["id"] for q in t["questions"]] == ["q1", "a1"]
    assert t["question"]["id"] == "q1"
    assert client.post(f"/v1/tasks/{tid}/answer", json={"value": "x", "dialog_id": "nope"}).status_code == 404
    r = client.post(f"/v1/tasks/{tid}/answer", json={"value": "9000", "dialog_id": "a1"}).json()
    assert r["status"] == "question" and [q["id"] for q in r["questions"]] == ["q1"]
    r = client.post(f"/v1/tasks/{tid}/answer", json={"confirmed": True}).json()  # oldest = q1
    assert r["status"] == "working" and r["questions"] == []
    t = wait_status(client, tid, "review")
    assert "9000" in (Path(t["worktree"]) / "hello.txt").read_text()


def test_plain_text_question_then_answer_continues(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "textq")
    ws()
    t = wait_status(client, new_task(client)["id"], "question")
    assert t["question"]["kind"] == "text" and t["question"]["message"] == "Which database should I use?"
    assert client.post(f"/v1/tasks/{t['id']}/answer", json={}).status_code == 400
    assert client.post(f"/v1/tasks/{t['id']}/answer", json={"value": "Use sqlite"}).status_code == 200
    t = wait_status(client, t["id"], "review")
    assert "Use sqlite" in (Path(t["worktree"]) / "hello.txt").read_text()
    assert t["questions"] == []


def test_text_question_with_changes_goes_to_review(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "normal")
    ws()
    t = wait_status(client, new_task(client)["id"], "review")  # last text has no question mark
    assert t["questions"] == []


def test_time_limit_paused_while_question(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "ask")
    ws(time_limit_min=0.03)  # 1.8 s
    t = wait_status(client, new_task(client)["id"], "question")
    time.sleep(2.5)
    assert client.get(f"/v1/tasks/{t['id']}").json()["status"] == "question"
    client.post(f"/v1/tasks/{t['id']}/answer", json={"value": "ok"})
    wait_status(client, t["id"], "review")


def test_old_database_gets_questions_column(tmp_path):
    import sqlite3
    from coder.store import Store
    p = tmp_path / "old.sqlite"
    db = sqlite3.connect(p)
    db.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, goal TEXT NOT NULL, acceptance TEXT, "
               "scope TEXT, provider TEXT, model TEXT, branch TEXT, worktree TEXT, base_commit TEXT, status TEXT NOT NULL, "
               "phase_detail TEXT, current_tool TEXT, files_touched TEXT, question TEXT, last_text TEXT, checks_ok INTEGER, "
               "checks_output TEXT, review TEXT, pr_url TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, "
               "started_at TEXT, finished_at TEXT)")
    db.commit()
    db.close()
    st = Store(p)
    t = st.create_task(id="a", workspace_id="w", goal="g", files_touched=[])
    assert t["questions"] == []


# ---- hold: pause while Echo needs the local model -----------------------------------------------

def test_hold_pauses_and_release_resumes(client, ws, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_PI_MODE", "hang")
    ws()
    t = wait_status(client, new_task(client)["id"], "working")
    seen = []
    client.app.state.manager.on_change = seen.append
    r = client.put("/v1/local/hold", json={"hold": True, "reason": "test"})
    assert r.status_code == 200 and r.json()["hold"] is True
    t = client.get(f"/v1/tasks/{t['id']}").json()
    assert t["status"] == "paused" and "Kevin" in t["phase_detail"]
    assert any(m.get("status") == "paused" for m in seen)
    st = client.get("/v1/status").json()
    assert st["hold"] is True and st["local_model_needed"] is True and t["id"] in st["active"]
    assert client.app.state.manager._runs[t["id"]].pi.exited.is_set()
    monkeypatch.setenv("FAKE_PI_MODE", "normal")
    monkeypatch.setenv("FAKE_PI_ARGV_DUMP", str(tmp_path / "argv.json"))
    client.put("/v1/local/hold", json={"hold": False})
    wait_status(client, t["id"], "review")
    assert "--continue" in json.loads((tmp_path / "argv.json").read_text())
    assert client.get("/v1/status").json()["hold"] is False


def test_new_local_task_waits_during_hold(client, ws):
    ws()
    client.put("/v1/local/hold", json={"hold": True})
    t = new_task(client)
    time.sleep(0.6)
    assert client.get(f"/v1/tasks/{t['id']}").json()["status"] == "starting"
    client.put("/v1/local/hold", json={"hold": False})
    wait_status(client, t["id"], "review")


def test_paused_time_does_not_count_against_limit(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "hang")
    ws(time_limit_min=0.05)  # 3 s
    t = wait_status(client, new_task(client)["id"], "working")
    client.put("/v1/local/hold", json={"hold": True})
    time.sleep(3.5)
    assert client.get(f"/v1/tasks/{t['id']}").json()["status"] == "paused"
    monkeypatch.setenv("FAKE_PI_MODE", "normal")
    client.put("/v1/local/hold", json={"hold": False})
    wait_status(client, t["id"], "review")


def test_cancel_paused_task(client, ws, monkeypatch):
    monkeypatch.setenv("FAKE_PI_MODE", "hang")
    ws()
    t = wait_status(client, new_task(client)["id"], "working")
    client.put("/v1/local/hold", json={"hold": True})
    assert client.post(f"/v1/tasks/{t['id']}/cancel").json()["status"] == "cancelled"
    client.put("/v1/local/hold", json={"hold": False})
    time.sleep(0.3)
    assert client.get(f"/v1/tasks/{t['id']}").json()["status"] == "cancelled"
