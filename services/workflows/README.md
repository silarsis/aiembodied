# Workflows

The avatars' sense of time. A Python service that runs [Temporal](https://temporal.io) workflows (the Temporal server
itself is in `../temporal`). Memory holds the "what and why" (intentions, flows the agents wrote, sleep state). The
Electron app does every action an agent takes (speaking, thinking with the model, tools, pursuits) when a workflow asks
for it through the switchboard.

What runs:

| Workflow | Id | What it does |
|---|---|---|
| `AgentLife` | `life:<avatar>` | One per avatar. Every minute it asks the app for the avatar's context. It tracks hours awake, decides now and then whether to speak, read or sleep, plans the morning, reflects in the evening, and sends the avatar to sleep after 24 hours awake. |
| `Reminder` | `remind:<uuid>` | Waits until due, then says the reminder (urgent for an alarm). |
| `WakeMe` | `wake:<uuid>` | Waits until due, then lets the avatar think about a note it left itself. |
| `Watch` | `watch:<uuid>`, `flowwatch:<avatar>:<name>` | Waits for a sensor, a new search result, a service going down or a coding task finishing, then says something, thinks, or starts a flow. |
| `AgentFlow` | `flow:<avatar>:<name>:<uuid>` | Runs a flow the avatar wrote (see the step language in `API.md` and `src/aiembodied_workflows/flowdef.py`). Schedules (`sched:<avatar>:<name>`) start it on a cron or an interval. |

Task queues: `agents` (all workflows and light activities) and `think` (acts that call the `think`, `tool` and `ask`
kinds; one at a time, so only one model call or tool runs at a time).

## Run

```powershell
.\scripts\start.ps1                # http://127.0.0.1:8198, venv in .venv
```

Or by hand: `pip install -e .[test]`, then `python -m aiembodied_workflows serve [--host 127.0.0.1] [--port 8198]`.
Tests: `python -m pytest -q`. Needs Python 3.12 or later (the app's start script uses 3.13).

The service needs the Temporal server (`..\temporal\scripts\start.ps1`), the switchboard (8196) and the memory engine
(8194). It starts without them: the API answers, `/health` says `"temporal": false`, and it retries Temporal every 5 s.
Once connected it starts the workers and runs a reconcile pass (restarts reminders, wake-ups and watches memory says are
open but Temporal does not know, and restores flow schedules and watchers). It listens on `127.0.0.1` and has no
authentication unless `WORKFLOWS_API_TOKEN` is set.

## Settings (environment variables, all optional)

| Variable | Default | |
|---|---|---|
| `TEMPORAL_ADDRESS` | `127.0.0.1:7233` | the Temporal gRPC address |
| `TEMPORAL_NAMESPACE` | `aiembodied` | |
| `MEMORY_SERVICE_URL` | `http://127.0.0.1:8194` | memory engine |
| `MEMORY_API_TOKEN` | none | bearer token for memory |
| `SWITCHBOARD_URL` | `http://127.0.0.1:8196` | event bus |
| `SEARXNG_URL` | `http://127.0.0.1:8888` | web search for flows and search watches |
| `WORKFLOWS_HOST`, `WORKFLOWS_PORT` | `127.0.0.1`, `8198` | where the API listens |
| `WORKFLOWS_API_TOKEN` | none | when set, every `/v1` call needs `Authorization: Bearer <token>` |
| `AGENT_LIFE` | `1` | `0` = no life workflows (reminders, watches and flows still work) |
| `SLEEP_AFTER_HOURS` | `24` | hours awake (app running) before an avatar is put to sleep |
| `SLEEP_HOURS` | `7` | how long a sleep lasts, unless the avatar is woken |
| `WORKFLOWS_TIMEZONE` | `MEMORY_TIMEZONE`, else the machine's zone | for `wait until "07:30"` and cron schedules |
| `QUIET_HOURS` | `22-7` | local hours, `start-end`, may wrap midnight; same as the app's `PROACTIVE_QUIET_HOURS` |
| `WORKFLOWS_LOG_LEVEL` | `INFO` | |
| `WORKFLOWS_LOG_FILE` | `%LOCALAPPDATA%\aiembodied\workflows\workflows.log`, else `~/.local/share/aiembodied/workflows/workflows.log` | rotating file, 5 MB x 5; `off` disables it |

## Watch what is happening

One readable line for everything, to stdout and to the log file:

```
2026-11-26 01:23:45.678 INFO  life:echo              decision: SAY "Morning! The bins go out tonight." (think 4.2 s)
2026-11-26 01:23:46.002 INFO  flow:echo:weather:7f3  step 3/7 think -> 212 chars
2026-11-26 01:23:47.411 INFO  life:echo              act say for echo -> ok (35 ms)
```

The second column is the workflow id (or the part of the service that wrote the line). Lines cover: workflow started,
each decision and its outcome, sleeping and waking, a reminder firing, a watch matching, every flow step, completed,
failed and continued-as-new; every activity start and finish with its duration (`start ...`, `done  ...`, `failed ...`);
each API request that changes something; the switchboard bridge connecting, disconnecting and each signal it sends.

```powershell
Get-Content .dev-home\logs\workflows.log -Wait                      # when started by pnpm dev:run
Get-Content $env:LOCALAPPDATA\aiembodied\workflows\workflows.log -Wait
python -m switchboard tail --type "workflow.*"                      # the key moments as bus events
```

The bus events are `workflow.started|decision|step|fired|sleep|wake|completed|failed` (private, producer
`service:workflows`), with a `text` line in the payload. The Temporal UI is at http://127.0.0.1:8233.

## How the app and the service talk

- **Acts** (workflows to app): a workflow publishes `agent.act` to `service:app`; the app answers with
  `agent.act.result` on the same transaction. The activity polls `GET /v1/txns/{id}` every 0.5 s. A transaction that
  expires means the app is not running (the life workflow then counts no awake time; a reminder waits for the app).
- **Signals** (switchboard to workflows): the service listens on `/v1/stream` for `speech.heard`, `avatar.utterance`,
  `home.change`, `home.alert` and `task.status`, and turns them into workflow signals. It resumes from the last event
  id after a reconnect.
- **Memory**: intentions, flows and agent state are stored in the memory engine; the service keeps no database of its own.

## Files

`src/aiembodied_workflows/`: `wf/` (the workflow classes), `life_rules.py`, `conditions.py`, `flowdef.py`,
`interpreter.py` (pure logic, unit-tested without Temporal), `acts.py`, `activities.py`, `memory.py`, `bridge.py`,
`service.py`, `api.py`, `logs.py`, `interceptors.py`.
