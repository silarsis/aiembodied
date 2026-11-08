# Coding runner API

JSON over HTTP, prefix `/v1`. Errors are `{"detail": "..."}` with 400 (bad input), 404, 409 (wrong
state), 422 (bad shape) or 502 (push failed).

## Status values

`queued, starting, working, question, checks, review, pushing, done, failed, cancelled, discarded`

## Setup

- `GET /v1/health` -> `{"ok": true, "version": "0.1.0", "pi": {"found": true, "version": "1.5.0"}}`
- `PUT /v1/settings` -> the stored settings. Partial; saved in `settings.json` and applied to pi's config.
  `{"local_llm_url": "http://127.0.0.1:1236/v1", "local_model": "qwen3-coder-next", "default_model": {"provider": "local", "id": "qwen3-coder-next"}}`
  Tasks created without `model` (and without a workspace model) use `default_model`.
- `GET /v1/settings` -> the same shape.
- `GET /v1/status` -> `{"local_model_needed": true, "active": ["20261108-1a2b"]}`. `local_model_needed` is
  true while any task on the `local` provider is `starting`, `working` or `question`. `active` lists tasks
  in `starting, working, question, checks, pushing`.
- `PUT /v1/workspaces` replaces the whole list. 400 if a path is not a git repository. Returns the stored list.
  ```json
  [{"id": "aiembodied", "name": "aiembodied", "path": "C:\\src\\aiembodied", "kind": "self",
    "base_branch": "main", "checks": "pnpm -w typecheck && pnpm test",
    "protected_paths": ["services/coder/"], "model": {"provider": "local", "id": "qwen3-coder-next"},
    "time_limit_min": 60}]
  ```
- `GET /v1/workspaces`
- `PUT /v1/keys` -> 204. Merges; an empty or null value clears a key.
  `{"openai": "sk-...", "anthropic": "sk-ant-...", "github": "ghp_..."}`
- `GET /v1/keys` -> `{"openai": true, "anthropic": false, "github": true}` (never the keys)
- `GET /v1/capabilities[?refresh=1]` -> `{"backend": {"name": "pi", "version": "1.5.0", "models": [...], "commands": [...], "error": null}, "workspaces": [{"id", "kind", "detected": {"package_manager", "checks_suggestion", "has_agents_md", "has_claude_md", "remote_url", "base_branch", "dirty"}}], "track_record": [{"workspace_id", "provider", "model", "started", "done", "failed", "cancelled", "discarded", "with_pr", "checks_pass_rate", "median_minutes"}]}`.
  The pi probe is cached for 10 minutes.

## Tasks

- `POST /v1/tasks`
  ```json
  {"workspace_id": "aiembodied", "goal": "Add a retry to the memory client",
   "acceptance": ["tests pass"], "scope": ["app/main/src/memory/"],
   "model": {"provider": "openai", "id": "gpt-5"}}
  ```
  Returns the task: `id` (`20261108-1a2b`), `branch` (`echo/<id>-<slug>`), `status`, `phase_detail`,
  `current_tool`, `files_touched`, `question`, `last_text`, `checks_ok`, `checks_output`, `review`,
  `pr_url`, `error`, `worktree`, `base_commit`, timestamps. 400 if the provider needs a key that was not set.
- `GET /v1/tasks[?status=review]` newest first
- `GET /v1/tasks/{id}`
- `GET /v1/tasks/{id}/events?after=<seq>` -> `[{"seq": 12, "ts": "...", "type": "tool_execution_start", "payload": {...}}]`
  (pi events as received, plus `status`, `log` and `runner` events; payloads over 20 KB are truncated)
- `GET /v1/tasks/{id}/diff` -> text, at most 500 KB
- `POST /v1/tasks/{id}/steer` `{"message": "use the existing helper"}` (working or question)
- `POST /v1/tasks/{id}/follow_up` `{"message": "also add a test"}` (while running: queued for pi; in
  review: restarts pi with `--continue` if needed and runs again, then back to review)
- `POST /v1/tasks/{id}/answer` `{"confirmed": true}` or `{"value": "text"}` or `{"cancelled": true}`, plus
  optional `"dialog_id"` (default: the oldest pending question). Status must be `question`. For a
  `text` question a `value` is required; it is sent to pi as a new prompt and the task continues.
- `POST /v1/tasks/{id}/cancel` keeps the worktree
- `POST /v1/tasks/{id}/apply` `{"draft": false}` -> 409 unless status is `review` and no protected
  path changed. Pushes the branch, opens the pull request (GitHub key, else `gh`), removes the
  worktree. Without a way to open a PR the task is `done` with `pr_url: null` and `phase_detail`
  says the branch was pushed.
- `POST /v1/tasks/{id}/discard` removes worktree and local branch; events are kept

Review shape: `{"no_changes": false, "summary": "2 file(s) changed, +10 -3", "files": [{"path", "added", "deleted", "binary"}], "changed_files": [...], "added": 10, "deleted": 3, "changed_lines": 13, "protected_violations": [], "flags": ["lockfile changed: pnpm-lock.yaml"]}`

Question shape: `{"id": "q1", "method": "confirm", "kind": "confirm", "title": "...", "message": "...", "options": [...], "asked_at": "..."}`.
`task.questions` lists all pending questions, oldest first; `task.question` is the first one (or null).
`kind` is `confirm` (a guard confirmation, answer with `confirmed`), `ask_echo` (pi called its `ask_echo`
tool; `message` is the question, answer with `value`) or `text` (pi ended its turn with a question and
changed no files; `method` is `text`, answer with `value`). The time limit does not run while a
question is pending.

## Live updates

`GET /v1/events` is a server-sent event stream. Each message is
`data: {"task_id": "...", "status": "working", "current_tool": "write", "question": null, "local_model_needed": true}`
sent whenever a task's status, current tool or question changes. `local_model_needed` is in every
message. On connect the stream sends one message with `task_id: null` and the current value.

A task on the local model waits in `starting` ("waiting for the local model") until the model server
answers; after `CODER_LOCAL_WAIT_S` it fails. After a runner restart, running tasks with a worktree
are resumed (see README). Comment lines are keep-alives.
