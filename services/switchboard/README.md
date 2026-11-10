# Switchboard

The event bus between Echo, her tools and people. Everything that happens (Kevin said something, Echo
answered, a tool returned, a coding task changed state, an approval was asked for) is an *event* with a
small JSON envelope. The switchboard does three things with it:

- **Journal**: every event is stored in SQLite (WAL) and can be queried or replayed.
- **Ledger**: events that carry a `txn` open and update a *transaction* (a turn, a tool call, an approval, a
  task). The ledger knows its state, owner, parent and deadline. When a transaction closes, its still-open
  children are cancelled; when a deadline passes, it expires.
- **Stream**: connected clients get matching events live over a WebSocket, or replayed from an event id.

Phase 1: the app only *mirrors* what it already does onto the switchboard. Nothing in the app waits for it,
and the app works the same when it is not running.

## Run

```powershell
.\scripts\start.ps1                # http://127.0.0.1:8196, venv in .venv
```

Or by hand: `pip install -e .[test]`, then `python -m switchboard [serve] [--host 127.0.0.1] [--port 8196]`
(or `switchboard`). Tests: `pytest`. Needs Python 3.10+. It listens on `127.0.0.1` by default and has no
authentication, so do not expose it.

Watch what is going on:

```powershell
python -m switchboard tail                          # live, every event
python -m switchboard send "The washing is done" --source "my test" --urgent   # tell Echo something
python -m switchboard tail --type "task.*" --txn task:20261108-1a2b
python -m switchboard tail --since 01JC... --url ws://127.0.0.1:8196
```

One line per event: `HH:MM:SS.mmm type producer -> to [txn state] payload` (time in UTC). `tail` uses the
`websockets` package; if it is missing it polls `GET /v1/events` every second.

## Settings (environment variables, all optional)

| Variable | Default | |
|---|---|---|
| `SWITCHBOARD_DB` | `%LOCALAPPDATA%\aiembodied\switchboard\switchboard.db`, else `~/.local/share/aiembodied/switchboard/switchboard.db` | the SQLite file |
| `SWITCHBOARD_RETENTION_DAYS` | `30` | events and closed transactions older than this are deleted (at start and hourly) |
| `SWITCHBOARD_NODE` | the host name | reported by `/health` and the WebSocket welcome |

## Echo's inbox and decision step

In the app (`app/main/src/switchboard/inbox.ts`), events addressed to `avatar:echo` follow a rule table.
`home.alert` and high or urgent `avatar.inbox` events speak at once and never wait for a model.
Other `avatar.inbox` events have the action `deliberate`: a small model (the `idle` model use, 6 s timeout,
no tools; `switchboard/deliberate.ts`) sees a presence summary (`presence/presence.ts`: microphone, voice
phase, when Kevin and Echo last spoke, camera, do not disturb, local time) plus the event and answers
`ignore`, `remember` or `say`. `say` is spoken as an urgent update so it is announced even when no conversation
is running. `remember` saves a `system` message in the recent session, `[Update from <source>, not from Kevin,
saved quietly] ...`. With do not disturb on (Status panel), non-urgent events are remembered without a model
call. If the model fails or times out, the event is spoken when idle, as before. Every decision is published as a
private `avatar.decision` event (payload: event, type, action, reason, ms, fallback, doNotDisturb) and closes
the event's transaction.

## Code

`models.py` envelope and settings, `store.py` SQLite, `ledger.py` transaction rules, `hub.py` publishing and
fan-out, `app.py` HTTP and WebSocket routes, `tail.py` and `__main__.py` the command line, `ulid.py` ids.
The HTTP and WebSocket interface is in [API.md](API.md).
