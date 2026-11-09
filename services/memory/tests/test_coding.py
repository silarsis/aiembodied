from datetime import datetime, timedelta, timezone

from memory_engine import coding


def task(task_id="20261108-1a2b", **extra):
    base = {
        "task_id": task_id,
        "workspace_id": "aiembodied",
        "workspace_name": "aiembodied",
        "title": "Fix the retry in the memory client",
        "outcome": "done",
        "pr_url": "https://github.com/x/y/pull/7",
        "branch": "echo/20261108-1a2b-fix-retry",
        "files_changed": ["a.ts", "b.ts", "c.ts"],
        "added": 10,
        "removed": 3,
        "review_flags": [],
        "summary": "Added a retry with backoff.",
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }
    return {**base, **extra}


def test_describe_is_a_compact_sentence():
    text = coding.describe({**task(), "pr_state": None})
    assert text.startswith("Coding task in aiembodied (done, PR https://github.com/x/y/pull/7): Fix the retry")
    assert "Changed 3 files: a.ts, b.ts, c.ts." in text
    assert text.endswith("pi said: Added a retry with backoff.")


def test_describe_without_pr_and_with_many_files():
    files = [f"f{i}.ts" for i in range(12)]
    text = coding.describe({**task(files_changed=files, pr_url=None, outcome="failed"), "pr_state": None})
    assert "(failed)" in text and "and 4 more" in text


def test_posting_stores_indexes_and_is_idempotent(client):
    assert client.post("/v1/coding/tasks", json=task()).status_code == 200
    assert client.post("/v1/coding/tasks", json=task()).status_code == 200
    found = client.get("/v1/search", params={"q": "retry memory client", "source": "coding"}).json()["results"]
    assert len(found) == 1
    assert found[0]["source"] == "coding" and found[0]["kind"] == "coding_task"


def test_reposting_updates_the_text_with_the_pr_state(client):
    client.post("/v1/coding/tasks", json=task())
    client.post("/v1/coding/tasks", json=task(pr_state="merged"))
    found = client.get("/v1/search", params={"q": "retry", "source": "coding"}).json()["results"]
    assert len(found) == 1 and "merged" in found[0]["text"]


def test_coding_rows_stay_out_of_default_search_and_recall(client):
    client.post("/v1/coding/tasks", json=task())
    assert client.get("/v1/search", params={"q": "retry"}).json()["results"] == []
    assert len(client.get("/v1/search", params={"q": "retry", "source": "all"}).json()["results"]) == 1
    assert client.post("/v1/recall", json={"text": "fix the retry in the memory client please"}).json()["items"] == []


def test_validation(client):
    assert client.post("/v1/coding/tasks", json=task(outcome="running")).status_code == 422
    assert client.post("/v1/coding/tasks", json=task(files_changed=["x"] * 201)).status_code == 422
    assert client.post("/v1/coding/tasks", json=task(summary="x" * 4001)).status_code == 422


def test_brief_lists_up_to_three_recent_tasks_from_the_last_week(client):
    now = datetime.now(timezone.utc)
    for i in range(4):
        client.post("/v1/coding/tasks", json=task(f"t{i}", title=f"Job {i}", finished_at=(now - timedelta(hours=i)).isoformat()))
    client.post("/v1/coding/tasks", json=task("old", title="Ancient", finished_at=(now - timedelta(days=9)).isoformat()))
    brief = client.get("/v1/brief").json()
    assert [t["title"] for t in brief["recent_coding"]] == ["Job 0", "Job 1", "Job 2"]
    assert brief["recent_coding"][0]["workspace"] == "aiembodied"
