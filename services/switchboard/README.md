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

With more than one avatar in the scene, `app/main/src/floor/` decides who answers. The quick model first for Kevin's lines, then bids for avatar chatter:

- **Kevin speaks** (`local-voice:respond` without an `avatarId`). No code looks at the words of his line. With one avatar in the scene that avatar answers and nothing is asked. With two or more:
  1. **The quick model** (`createSystemOneIntent` in `floor/system-one-floor.ts`, on the `decide` route via `SystemOneClient`) gets the exact prompt it was trained on (`services/laya/training/floor_prompt.py`: a plain-string state with the room, who Kevin last spoke with, up to four recent lines and his line, and the three choice questions `addressed`, `wants`, `other`). Its confidence is the lowest top probability of `addressed`, `wants` and, for `converse` or `relay`, `other`. At or above 0.8 (`quickIntentThreshold`) the answer decides (`decidedBy: 'quick'`). Limit 1.5 s (`quickIntentTimeoutMs`). **The decide route's model must be the fine-tuned floor checkpoint** (for example `laya-floor-v1` served through `LAYA_EXTRA_MODELS`); the stock checkpoint is near chance on this prompt, so its lines mostly fall through to step 2.
  2. **The chat model** (`floor/intent-router.ts`, the `idle` model route, JSON-schema answer, 2.5 s) reads the line when the quick model is unsure, fails, times out or is off (`decidedBy: 'model'`).
  3. If that fails too and the quick model gave an unsure answer, that answer is used (`'quick-low'`).
  4. Otherwise the avatar Kevin last talked with within 5 minutes, else the host (`'default'`, also the label for a one-avatar scene).
  An answer becomes a decision like this: `unclear` is the last partner if recent and not `other`, else the host if not `other`, else the first other avatar; `answer` has that avatar answer Kevin; `everyone` calls every avatar in scene order; `converse` with a valid other makes that avatar start a conversation with the other (talk mode for the pair, out loud); `relay` with a valid other has the addressed avatar answer Kevin and pass the question on, and the target then answers out loud; a `converse` or `relay` without a usable other counts as `answer`. If Kevin speaks again while a call is pending, it is aborted and its answer dropped.
  The journal's `floor.decision` carries `decidedBy` (`quick`, `model`, `quick-low` or `default`) and the trace says which step ran ("person: quick intent decided -> sage answer (confidence 0.97, 180 ms)", "person: quick intent unsure ...", "person: chat model decided -> ..."). `pnpm floor:check` measures the models on 54 sentences.
  His speech always wins: it cancels avatar speech, clears the queue and ends any talk mode.
- **An avatar speaks** (its finished reply is routed again, with action tags such as `{move:...}` removed): only another avatar may answer. In talk mode with a pair, the other one of the pair answers, whatever the line says, aloud even when "Hear avatar chatter" is off, until Kevin speaks; a third avatar only overhears. Otherwise a name in the text picks that avatar; otherwise one call to the `idle` model route (6 s) returns a `want` 0..1 per candidate and the highest at 0.5 or more wins (ties go to scene order; a failure or timeout means silence).
- **Limits.** There is no limit on the number of avatar-to-avatar turns. A conversation Kevin asked for has no time limit either; it runs until he speaks. Spontaneous chatter (nobody asked for it) stops 5 minutes after it started (`chatterMaxMs` on `FloorManager`) and is journalled as `floor.budget` with `kind: 'time'`; then silence until Kevin speaks.
- One avatar speaks at a time (a slot and a FIFO queue).
- The reply to another avatar is a normal turn of that avatar's own `LocalVoiceService` (own history, memory, tools) whose input is `[<Name> says to you, not Kevin: "<text>" Answer in your own words; do not repeat what was said.]`. In a conversation Kevin asked for, the last sentence is instead `You are in a conversation with <Name> that Kevin asked for. Reply to <Name> in your own words in one or two sentences, do not repeat what was said, and keep the conversation moving.` The receiving avatar's history keeps this as a user-role message, never as its own words, and action tags are removed from every line that is passed on, overheard or journalled. **Hear avatar chatter** (Status panel, KV `floor.hearChatter`, default off) decides whether it is spoken (`silent: false`, events carry `avatarId`) or a text back channel (`silent: true`: no speech is synthesised). Out-loud chatter is not audible until the renderer plays several voices (step 3). The reply is saved in the conversation with `speaker` set to the replying avatar.

**Review fixes.** An avatar's answer to Kevin no longer opens chatter by itself: it is routed with `toPerson`, so the other avatars reply only if the line names one of them (or Kevin asked them to talk); otherwise they just overhear it and no bid call is made. Avatars hear the room: `LocalVoiceService.overhear()` buffers the last 12 lines (400 chars each, no model call) and the next real turn carries them in front as `[Heard in the room since you last spoke, for context only; ...]`. `FloorController.heard()` feeds it: after Kevin spoke to X, everyone else hears `Kevin (to X): ...` and `X: ...`; after a chatter turn A to B, others hear A's line and B's reply, and no avatar hears a line it already got as its own turn input. `local-voice:respond` does the same for turns that name an avatar by `avatarId`. Chatter turns run with `noTools`. The decision step's prompt uses the avatar's own name, and `floor:interrupt` (barge-in from the renderer) cancels avatar speech and queued work.

Journal (private, fire-and-forget; in Kevin's turn txn `turn:<requestId>` when there is one, else `chatter:<time>:<n>`): `floor.decision` (payload `from`, `text`, `speakers`, `channel`, `trace`), `floor.grant` and `floor.release` (`avatar`, `reason`/`next`), `floor.budget` (when spontaneous chatter is cut off by the time limit: `kind: 'time'`, `ms`).

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
