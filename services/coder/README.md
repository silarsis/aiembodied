# Coding runner

A small HTTP service that lets the aiembodied app (its character Echo) hand coding tasks to the
[pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`pi`).

Each task runs `pi --mode rpc` in its own git worktree on its own branch (`echo/<id>-<slug>`).
When pi is done the runner commits, runs the workspace's checks and prepares a review (diff stats and
flags). Only after approval (`POST /v1/tasks/{id}/apply`) does it push the branch and open a pull
request. Echo never edits a checkout directly.

## Run

```powershell
npm install -g @earendil-works/pi-coding-agent     # once
.\scripts\start.ps1                                # http://127.0.0.1:8195, venv in .venv
```

Or by hand: `pip install -e .[test]`, then `python -m coder` (or `coding-runner`). Tests: `pytest`
(they use a fake pi, so neither pi nor a model is needed). Needs Python 3.10+ and git.

## Settings (environment variables, all optional)

| Variable | Default | |
|---|---|---|
| `CODER_HOST` / `CODER_PORT` | `127.0.0.1` / `8195` | listen address |
| `CODER_DATA_DIR` | `%LOCALAPPDATA%\aiembodied\coder`, else `~/.local/share/aiembodied/coder` | database, worktrees, pi config |
| `CODER_PI_COMMAND` | `pi` | command line for pi (split like a shell would; `python fake_pi.py` works) |
| `CODER_MAX_TASKS` | `1` | tasks running at once; others wait in `queued` |
| `CODER_TIME_LIMIT_MIN` | `60` | per task; a workspace can set its own |
| `CODER_LOCAL_LLM_URL` | `http://127.0.0.1:1236/v1` | OpenAI-compatible server for provider `local` |
| `CODER_LOCAL_MODEL` | `qwen3-coder-next` | model id served there |
| `CODER_GIT_REMOTE` | `origin` | remote to fetch from and push to |
| `CODER_PR_POLL_S` | `300` | how often open pull requests are checked (merged / closed / CI result); `0` disables |
| `CODER_LOCAL_WAIT_S` | `900` | how long a local-model task waits for the model server before it fails |

The local model URL, local model id and default model can also be set by the app with
`PUT /v1/settings`. They are saved in `settings.json` in the data directory and override the
variables above.

Test knobs: `CODER_CANCEL_GRACE_S` (5), `CODER_SETTLE_S` (3), `CODER_LOCAL_POLL_S` (3), `CODER_GITHUB_API`.

Data directory layout: `coder.sqlite`, `workspaces.json`, `worktrees/<id>/`, `settings.json`, `sessions/<id>/` (pi
sessions), `pi-agent/` (pi's config dir, rewritten on every start).

## Models and keys

Providers are `local` (default), `openai` and `anthropic`. API keys come from the app with
`PUT /v1/keys`; they are held in memory only, never written to disk or logged, and passed to pi as
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` only for tasks that use that provider. The `github` key is used
to open pull requests. The runner never reads your own `~/.pi/agent/auth.json`.

## Local model and restarts

A task on the `local` provider first waits (status `starting`, detail "waiting for the local model")
until `<local_llm_url>/models` answers 200, checking every 3 s for up to `CODER_LOCAL_WAIT_S`. On
timeout it fails with "local model did not start". The same wait happens before a follow-up restarts
pi. `GET /v1/status` and every `/v1/events` message say whether any local task needs the model
(`local_model_needed`), so the app can load and unload the model server around tasks.

When the runner restarts, tasks that were `starting`, `working` or `question` and still have their
worktree are resumed: pi is started with `--continue --session-dir <same session dir>` and gets a
prompt telling it the runner restarted. Tasks in `checks` run their checks again. A task in `pushing`
goes back to `review` with the error "runner restarted during push". Tasks whose worktree is gone fail
with "runner restarted".

## Asking Echo

The guard extension also gives pi a tool `ask_echo(question)`. It opens an `input` dialog titled
`Question from pi: <question>`, which the runner stores as a pending question of kind `ask_echo`. The
answer becomes the tool result. If pi ends a turn with a question mark and changed no files, the task
waits in `question` (kind `text`) and the answer is sent to pi as a new prompt.

## Safety rules

- Every task works in its own worktree; the original checkout is never touched.
- pi runs with `PI_CODING_AGENT_DIR=<data>/pi-agent`, which has only the `local` provider and no
  packages (no browser control), plus a guard extension (`aiembodied-guard.ts`) that blocks
  `git push`, `gh pr`, `gh api`, `git remote`, `git config --global`; reads and writes of `.env`,
  `.ssh`, `auth.json`, `.pi/agent`; writes outside the worktree; writes to the workspace's protected
  paths; and asks before `rm -rf`, `del /s`, `Remove-Item -Recurse`.
- pi's environment has no `GITHUB_TOKEN`, `GH_TOKEN`, `HA_*` variables, or anything ending in
  `_API_KEY`, `_TOKEN` or `_SECRET` (except the one provider key the task needs).
- The runner, not pi, commits, pushes and opens the pull request, and only on `apply`.
- `apply` is refused (409) when the diff touches protected paths. For a workspace of kind `self`
  (Echo's own code) these default to `services/coder/`, `app/main/src/coding/`,
  `app/main/src/tools/tool-registry.ts` and `app/main/src/crash-guard.ts`.
- Review flags: deleted test files, `.env*` files, lockfile changes, more than 1000 changed lines.
- Time limit per task; `cancel` aborts pi and kills it after 5 s.
- Listens on localhost only. There is no authentication, so do not expose the port.

## Workspace example

```json
PUT /v1/workspaces
[
  {"id": "aiembodied", "name": "aiembodied", "path": "C:\\Users\\me\\src\\aiembodied", "kind": "self",
   "base_branch": "main", "checks": "pnpm -w typecheck && pnpm test"},
  {"id": "notes", "path": "C:\\Users\\me\\src\\notes", "kind": "project",
   "model": {"provider": "anthropic", "id": "claude-sonnet-4-5"}, "time_limit_min": 30}
]
```

See [API.md](API.md) for all endpoints.
