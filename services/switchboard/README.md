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

## Avatars in the app

The app knows its avatars through `app/main/src/avatars/avatar-registry.ts` (profiles `{ id, name, vrmModelId }`
in the memory store key `avatars.profiles`; today just `echo`). Each avatar gets its own mirror and inbox
(`startAvatarPlumbing(profile)` in `main.ts`), its own `LocalVoiceService` (own history, brief and queued notes;
engines are shared; `avatars/voice-services.ts`), and approvals it asks for are published as
`avatar:<id>`. `notifyAvatar(avatarId, text, urgent)` puts a note on that avatar's inbox. Presence stays single:
it describes Kevin, not an avatar.

## Who speaks: the floor (phase 3 step 2)

With more than one avatar in the scene, `app/main/src/floor/` decides who answers. Rules first, then bids:

- **Kevin speaks** (`local-voice:respond` without an `avatarId`): the avatars he names ("Sage, what do you think?", "hey Sage", any case) in the order named; "you two", "both", "everyone", "all of you" mean every avatar in scene order (the first speaks, the rest are queued); otherwise the avatar he last talked with if that was within 5 minutes; otherwise the host (`echo`). His speech always wins: it cancels avatar speech and clears the queue.
- **An avatar speaks** (its finished reply is routed again): only another avatar may answer. A name in the text picks that avatar; otherwise one call to the `idle` model route (6 s) returns a `want` 0..1 per candidate and the highest at 0.5 or more wins (ties go to scene order; a failure or timeout means silence). At most 4 avatar-to-avatar turns and 60 s since Kevin last spoke; then silence until he speaks.
- One avatar speaks at a time (a slot and a FIFO queue).
- The reply to another avatar is a normal turn of that avatar's own `LocalVoiceService` (own history, memory, tools) whose input is `[<Name> said to you, not Kevin: "<text>"]`. **Hear avatar chatter** (Status panel, KV `floor.hearChatter`, default off) decides whether it is spoken (`silent: false`, events carry `avatarId`) or a text back channel (`silent: true`: no speech is synthesised). Out-loud chatter is not audible until the renderer plays several voices (step 3). The reply is saved in the conversation with `speaker` set to the replying avatar.

**Review fixes.** An avatar's answer to Kevin no longer opens chatter by itself: it is routed with `toPerson`, so the other avatars reply only if the line names one of them (or Kevin asked them to talk); otherwise they just overhear it and no bid call is made. Avatars hear the room: `LocalVoiceService.overhear()` buffers the last 12 lines (400 chars each, no model call) and the next real turn carries them in front as `[Heard in the room since you last spoke, for context only; ...]`. `FloorController.heard()` feeds it: after Kevin spoke to X, everyone else hears `Kevin (to X): ...` and `X: ...`; after a chatter turn A to B, others hear A's line and B's reply, and no avatar hears a line it already got as its own turn input. `local-voice:respond` does the same for turns that name an avatar by `avatarId`. Chatter turns run with `noTools`. The decision step's prompt uses the avatar's own name, and `floor:interrupt` (barge-in from the renderer) cancels avatar speech and queued work.

Journal (private, fire-and-forget; in Kevin's turn txn `turn:<requestId>` when there is one, else `chatter:<time>:<n>`): `floor.decision` (payload `from`, `text`, `speakers`, `channel`, `trace`), `floor.grant` and `floor.release` (`avatar`, `reason`/`next`), `floor.budget` (when chatter is cut off: `kind`, `turns`, `ms`).

Try it with several avatars: open Controls > Characters and add Sage and Rex under "In the scene" (each gets its own history; "Add by name" makes a character that shares Echo's body). Then watch the journal.

```powershell
pnpm dev:run
# in another terminal
python -m switchboard tail --type "floor.*"
```

Say "Sage, what do you think?" and watch `floor.decision` (trace shows the name rule), `floor.grant` and `floor.release`. Sage's reply is then routed to Echo or Rex through a bid; turn on "Hear avatar chatter" to have those turns spoken (inaudible until step 3).

## Code

`models.py` envelope and settings, `store.py` SQLite, `ledger.py` transaction rules, `hub.py` publishing and
fan-out, `app.py` HTTP and WebSocket routes, `tail.py` and `__main__.py` the command line, `ulid.py` ids.
The HTTP and WebSocket interface is in [API.md](API.md).
