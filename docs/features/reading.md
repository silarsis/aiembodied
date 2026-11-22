# Reading

Status: In Progress (phase 3: the body of reading, on top of phase 2, the character's own pursuit).

Reading is something a character does because it wants to. It is not a tool Kevin triggers and not a feature of Echo alone: every character may read, on its own conversation model, so the notes sound like the one who wrote them.

A character in a room with a station (the Reading room's bookshelf holds the DAIR Academy papers library) may choose "read something at the bookshelf" when it is idle. From then on it asks itself what it wants to find out, searches the library with the station's tools, picks something, reads it, writes notes in its own voice, and decides whether to go on, stop, or tell Kevin about it. There is no daily budget: it reads as much as it feels like.

## The pursuit engine (`app/main/src/pursuits/`)

No Electron imports.

- `pursuit.ts`: the generic `Pursuit` shape and `runPursuit`. A round is **want → act → choose → consume → note → next**. `runPursuit` owns the order and the bounds and never throws; the result says how it ended (`finished`, `limit`, `aborted`, `failed`). `finish(end)` always runs last.
- `reading-pursuit.ts`: `ReadingPursuit`, the first pursuit. Each step is one model call the character makes in the first person:
  - **want**: "What do you feel like reading about right now?" given its persona (system message), its idle habits, the last few lines of its conversations, the memory brief, its own recent reading notes and open questions, and what it already read in this visit. Output: one sentence.
  - **act**: the model calls the station's tools itself (OpenAI-style tool calling, up to `MAX_QUERY_ROUNDS`). Only what the library really returned counts.
  - **choose**: `PICK: <title> | <link> | <why>`, `REFINE: <idea>` (look again, at most `MAX_REFINEMENTS` times) or `NOTHING`.
  - **consume**: the model fetches the item with the tools. A text longer than `CHUNK_CHARS` (6000) is read in chunks (at most `MAX_CHUNKS`, 6), each call carrying only a running summary of the earlier parts. What was not read is said in the notes.
  - **note**: `TAKEAWAY`, `OPINION`, `KEVIN` (how it ties to Kevin or its interests), `QUESTIONS`, written in its own voice. Saved at once (see below).
  - **next**: `NEXT: continue | stop` and `TELL: <one short line to Kevin, or none>`. A tell goes to the avatar's inbox as an update from itself (`mirror.noteQueued(text, false, 'your own reading')`); the existing decide step may ignore, remember or say it. The pursuit never speaks. At most `MAX_TELLS` (2) per session. Two wishes in a row that find nothing end the session.
- `pursuit-llm.ts`: the model calls. **It reuses the avatar's own conversation client** (`LocalVoiceService.chat()`, the `ChatClient` its voice talks with; the same one for every avatar today, as the engines are shared) and the same streaming and tool-call plumbing (`streamChat`, `ThinkFilter`). `LlmGate` runs pursuit calls one at a time across all sessions, so with `LOCAL_LLM_SLOTS=2` one slot is always left for a conversation turn.
- `pursuit-manager.ts`: `PursuitManager`, one session per avatar. `start(avatarId, stationId)` checks the station, the character (`characters`), the station's tools (enabled, no approval needed) and the voice, then runs in the background. Bounds (constants): `MAX_SESSION_STEPS` 60, `MAX_ITEMS_PER_SESSION` 5, `MAX_TOOL_CALLS` 30, `SESSION_TIMEOUT_MS` 20 min. A session that ends does not stop the character from starting another.
- `reading-memory.ts`: how a note is stored, and the `my_reading_notes` tool.

### Notes

A note is written twice:

- SQLite table `reading_notes` (migration 12, `MemoryStore.addReadingNote/listReadingNotes`), so the Characters pop-up lists notes even when the memory engine is down.
- The memory engine, through the outbox like every other write. The engine has no "reading" kind, so a note is a **fact**: `author: 'agent'`, `agent` = the character, `subject: 'reading'`, `private: true` (so it does not fill the brief that opens every conversation; it is still found by search), with the title, link, takeaway, opinion, link to Kevin and open questions in its text.

A session cut short keeps what it has: if an item was read but not noted yet, a note marked "cut short" is saved from the summary so far.

## The body

`StationTrips.beginAt(avatarId, station)` makes the same trip a tool call would (walk to the object in the same room, a move to a place that shows the room, or an errand next door) and returns a visit. The session sends `station:use` `phase: 'activity'` events with the step's activity ("browses the bookshelf", "reads", "jots down notes"); the renderer (`rooms/station-walks.ts`) acts them as `{move:}` gestures where the avatar stands. When the session ends, `phase: 'end'` follows and, after an errand, the avatar goes back. The body of reading (phase 3) is below.

### The body of reading (phase 3)

A station's optional `body` (see [stations.md](./stations.md)) says what to take (`prop`), where to read (`seat`) and three gesture texts (`browse`, `read`, `note`). The bookshelf default: take the `book`, read in the `armchair`. Main marks a pursuit's `station:use` events with `source: 'pursuit'`, the `step` (want, act, choose, consume, note, next) and the `body`; a voice tool call has no `source` and keeps phase 1 behaviour. The renderer maps them in `rooms/station-body.ts` (pure planner) and `rooms/station-walks.ts`:

- **start**: `{go:bookshelf}`, `{look:bookshelf}`; arrival is reported as before.
- **want / act / choose**: the `browse` gesture (the same text is not replayed within 8 s). While seated nothing is played.
- **consume**: `{pick:book}`, then `{sit:armchair}` (each planned when its turn comes through `submitPlan`, so a failed pick means no sitting), then the `read` gesture. Seated, gestures are skipped (the executor refuses `{move:}` while seated, a standing-start clip would break the pose), so the seated avatar holding a book is the reading; if the avatar stands (no seat, failed sit) the `read` gesture repeats every `READ_REPEAT_MS` (20 s) until the next step.
- **note**: the `note` gesture when standing; nothing when seated.
- **Another item (act/choose again) while seated**: the avatar stays seated and keeps the book (robust, no walking back and forth). The book returns at the end.
- **end**: `stand`, `{put:book@bookshelf}` (the shelf has a `surface` tag; else the nearest surface), then the idle director takes over. When the session was cut short (Kevin started talking, `ok: false`) a `{come}` follows, so the conversation finds the avatar at its spot.
- **Degrading**: a prop or seat the room lacks (or without the book, no seat) is dropped by `resolveBodyPlan`; the avatar then stands at the shelf and plays gestures, as in phase 2. A station event without a `body` is phase 2 exactly.
- Station gestures pass the `{move:}` repeat filter on purpose (`MoveRequestFilter.forget`).
- Interruption: the pursuit aborts and `end` arrives with `ok: false`. The executor's `interrupt()` lets a sit/pick finish and keeps a seated avatar seated; the idle director's talk-start reaction only runs for avatars that wandered, so a reading avatar is released by the `end` event, not by the director.

The Reading room has a dynamic `book` (0.22 x 0.03 x 0.16 m, grab tag) lying on the 1 m shelf board of the bookshelf, in a gap left beside the blue books; the bookshelf has a `surface` tag at 1.025 m and its stand/look tags moved to that gap, so a put-back lands on the free board.

## Lookups in a conversation (2026-11-22)

Reading as a pursuit keeps using the station's individual tools (`PursuitManager.toolsAt`). Kevin's questions in a conversation do not: the conversation model is offered the station as ONE tool, `go_to_bookshelf` with a `question`, and the lookup runs a bounded loop with the station's tools on the same chat client (`stations/station-lookup.ts`, see [stations.md](./stations.md)). It uses the phase 1 body (walk to the shelf, browse gesture), not a seated reading session, and writes no reading notes. The pursuit's step and tool-call lines are logged (`Reading: step`, `Reading: tool call`).

## Starting a session

Only the character decides, through the idle director (`rooms/idle-director.ts`):

- The idle prompt lists "read something at the bookshelf: {read:bookshelf}" for every station of the room that the character may use (`characters`) and that has tools to read with (`pursuits:offers`). The answer `{read:bookshelf}` is read by `parseIdleReply` as a `read` tag. The random fallback picker can choose it too.
- The director then calls `pursuits:start {avatarId, stationId}` and does not run any scene tags: main walks the body.
- While a session runs, the avatar is not picked to act on its own and is not offered reading again (`pursuits:running`, `pursuits:changed`).
- There is no voice tool to start reading.

## Kevin starts talking

`runVoiceTurn` in main interrupts the avatar's session when a real turn starts for it (not a preview, a system update or silent chatter between avatars). The session aborts its current model call (the request is dropped at once), saves what it has and ends. Kevin speaking to another avatar does not interrupt this one, but note that the live turn of that avatar shares the model server: only one pursuit call runs at a time.

## Asking about it

`my_reading_notes` (built-in, read-only) returns the calling character's recent notes (it is told who is calling through `ToolContext`, `avatarTools()` in main). "What have you been reading?" is answered from what it wrote down.

## Characters pop-up

Each character's card has a "Reading" section (`avatar/reading-notes.tsx`): the latest 10 notes, each with date, title and takeaway; open one for the link, opinion, link to Kevin and open questions. Read-only. IPC `pursuits:notes {avatarId, limit}`.

## IPC

`pursuits:start`, `pursuits:stop`, `pursuits:offers`, `pursuits:running`, `pursuits:notes`; event `pursuits:changed`. On a satellite, start, offers and running go to bija, the event is pushed, and notes and stop stay on bija.

## Not yet

Gestures while seated, a different book per item, links that open in the browser (the app blocks navigation, so a note's link is shown as text and as a link that does nothing yet), pursuits other than reading, a spoken "go and read" command.
