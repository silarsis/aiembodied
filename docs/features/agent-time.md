# Agent time

Status: In Progress. Needs the workflows service and Temporal running (`pnpm dev:run` starts both).

Agents get a sense of time. They can remember what they promised, wake up later, watch for things, keep goals,
write small routines of their own, and go to sleep. A Temporal workflow runs each avatar's life, so this keeps
working while nobody is talking to the avatar, and it picks up again after the app restarts.

## How it fits together

- **Temporal** (`services/temporal`, `temporal.exe server start-dev` with a SQLite file, loopback only, port 7233,
  web UI on http://127.0.0.1:8233) keeps the timers. It starts and stops with the app.
- **The workflows service** (`services/workflows`, port 8198) holds the workflows: one life per avatar, reminders,
  wake-ups, watches and the agents' own flows.
- **The memory engine** keeps the "what and why": intentions, goals, the flows agents wrote, and whether each agent is asleep.
- **This app** does every action an agent takes. When a workflow needs the app to speak, think, run a tool or ask
  Kevin, it publishes an `agent.act` event to the switchboard. The app does it and answers with `agent.act.result`.
  The code is in `app/main/src/agent-time/`.

## What an agent can do

| Tool | What it does |
|------|--------------|
| `remind_me` | Say something to Kevin at a time (`at` or `inSeconds`); `alarm` makes it urgent |
| `wake_me_later` | Get a note back later and think again |
| `watch_for` | Watch a Home Assistant entity, a web search, a URL or a coding task, then say, think or run a flow |
| `write_flow`, `run_flow`, `my_flows` | Write and run routines (see below) |
| `set_intention`, `set_goal` | Keep something in mind; shown in the memory brief |
| `my_plans`, `change_plan`, `drop_plan` | See, pause, snooze or cancel what is running |
| `go_to_sleep` | Sleep until Kevin speaks or some hours pass |

None of these needs approval. A `confirm`-level tool called inside a flow still shows the normal approval card when
it runs, and a `block` tool never runs. A flow that fails validation returns the list of problems so the model can fix it.

Flows are lists of steps (think, choose, recall, remember, search, tool, say, ask, wait, wait_for, if, repeat,
run_flow, set_intention). The `write_flow` tool description teaches the language to the model. The service checks
every flow before saving it.

## The life workflow

Each avatar has a `life:<id>` workflow. About once a minute it asks the app for the avatar's `context`. At times
set by the restlessness setting it decides whether to say something, read, sleep or do nothing. It also makes a plan
for the day, reflects in the evening, brings an avatar back from next door, and puts the avatar to sleep after more than
24 hours awake (time with the app closed does not count). While the app is closed the life workflow does nothing.

With agent life on (the default) the life workflows replace the older proactive tick and next-door return. Those
classes stay in the code and run again with `AGENT_LIFE=0`.

## Sleep

A sleeping avatar does not wander, does not read, and the renderer's idle director skips it. Its inbox only
speaks urgent events; the rest is remembered quietly. It wakes when Kevin speaks to it, or after the sleep time.
The app keeps the sleep state in memory; the life workflow tells it again after a restart.

## Settings

| Variable | Default | Meaning |
|----------|---------|---------|
| `WORKFLOWS_ENABLED` | on | `0` turns off the tools, the acts, agent sync, the prompt note and both services |
| `AGENT_LIFE` | on | `0` keeps the tools but uses the proactive tick and next-door return instead of life workflows |
| `WORKFLOWS_URL` | `http://127.0.0.1:8198` | Where the app finds the service |
| `WORKFLOWS_API_TOKEN` | none | Bearer token for the service |
| `TEMPORAL_ADDRESS`, `TEMPORAL_UI_URL` | `127.0.0.1:7233`, `http://127.0.0.1:8233` | Used by the dev start script and the Status panel |
| `TEMPORAL_AUTOSTART`, `WORKFLOWS_AUTOSTART` | on | `0` stops `pnpm dev:run` from starting that service |

The service has its own settings (sleep hours, quiet hours, time zone); see `services/workflows/README.md`.

## In the app

- Every avatar's instructions get a short "Your time and plans" paragraph (`agent-time/prompt.ts`).
- The memory brief gains "What you're in the middle of", "Your goals" and "Your workflows" (`formatBrief`).
- The app tells the service which avatars exist (`PUT /v1/agents`) at start and when avatars are added, renamed or
  removed, retrying every 15 seconds while the service is down.
- Status and diagnostics shows the service with its Temporal state, the avatars with a life, who is asleep, and the
  Temporal UI link.

## Watching what happens

- App log: one line per act, `Agent act think for echo -> ok (4210 ms)`.
- Service log: `Get-Content .dev-home\logs\workflows.log -Wait` (also `%LOCALAPPDATA%\aiembodied\workflows\workflows.log`).
- Live events: `python -m switchboard tail --type "workflow.*"`.
- Temporal web UI: http://127.0.0.1:8233.

## Limits and known gaps

- Only one `think` or `tool` act runs at a time across avatars. A `think` waits up to 60 seconds for a live
  conversation to end, then answers `busy`; a voice turn that starts stops a `think` in progress.
- `think` ignores `maxTokens`: the chat client has no such setting.
- The `ask` and confirm-tool cards wait as long as the act deadline (up to 6 hours); nobody answering counts as "no".
- Sleep state is not saved by the app.
