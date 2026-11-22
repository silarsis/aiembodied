# Stations

Status: In Progress (phase 1: walk to the object while the tool runs). Reading as a character's own pursuit builds on it: see [reading.md](./reading.md).

A station binds a tool source to an object in a 3D room. The reading library (the DAIR Academy papers MCP server) is kept on the bookshelf of the Reading room: when an avatar uses it, it walks to the bookshelf and acts reading, instead of standing still while the tool runs.

## The model

`app/main/src/stations/` (no Electron imports).

```
Station { id, roomId, objectId,
          source: { kind: 'mcp', serverId?, preset? } | { kind: 'builtin', toolNames: [] },
          verb, activity, trip: 'all' | 'writes', characters: 'all' | [avatarIds],
          body?: { prop?, seat?, browse?, read?, note? } }
```

- Saved in the settings store under `rooms.stations` (`StationRegistry`). A preset source (`preset: 'dair-academy-papers'`) finds its server by matching the server's web address to the preset's.
- Default: when the papers server exists and no station holds it, `bookshelf` in `room:builtin:reading-room` holds it (`DEFAULT_STATIONS`). Removing it keeps it removed.
- `trip: 'all'` means every use is a trip; `'writes'` means only tools that change things. A tool only reads when Kevin said so (Tools pop-up, `mcp_tools.read_only`), else when the server said so (`annotations.readOnlyHint`, `mcp_tools.read_only_hint`), else it is assumed to change things.

- `body` (phase 3) is how a pursuit uses the object: `prop` (object id to take, `book`), `seat` (object id to read at, `armchair`) and the gesture texts `browse`, `read`, `note`. The default bookshelf station has prop `book`, seat `armchair`, browse "runs a finger along the book spines", read "reads a book, turning a page now and then", note "pauses and jots something down"; a default saved earlier gets it filled in. Voice tool uses ignore it. See [reading.md](./reading.md).

## What happens in a turn

1. The voice offers each station tool with " (kept on the bookshelf in the Reading room)" added to its description (the stored description is not changed) and, when the tool has no notice of its own, says "Let me check the bookshelf." while it runs.
2. When the tool starts, `StationTrips` (`station-trips.ts`) decides from where the speaking avatar is:
   - **In the room that holds the station:** main sends `station:use` `{ useId, avatarId, stationId, roomId, objectId, activity, phase: 'start' }` to the screen that draws the avatar. The renderer (`rooms/station-walks.ts`) queues `{go:<object>}` and then the activity as a `{move:}` gesture on that avatar's scene executor, and answers `station:arrived` when the walk is over (at once if it cannot walk). The tool is not delayed. After the tool returns, the answer waits for the arrival, at most `STATION_ARRIVAL_HOLD_MS` (6 s). `phase: 'end'` follows; nothing special happens then and the avatar is not sent back.
   - **In another 3D room:** if a place shows the station's room (a desktop room, or this PC's stage), the avatar moves there (`startMove`, reason "went to the bookshelf"), that place's renderer walks it to the object, and when the tool is done it moves back. If no place shows it, the avatar goes next door as an errand and comes back. The avatar first says "I'll go and check the bookshelf.", and the answer waits for the way back (the whole errand is capped at `2 * MOVE_DEADLINE_MS + 5 s`).
   - **Not in a 3D room** (a 2D background, away, already moving) or nobody can receive the event: no trip and no wait.
3. A cancelled turn stops waiting at once.

## One tool per reading station (2026-11-22)

A small local model (Gemma 4 E4B, 4B) offered 20+ tools at once (the 12 DAIR Academy tools, memory, coding, `web_search`, `my_reading_notes`) never called one, so no trip happened. Now the conversation is not offered the individual tools of a reading station:

- **Which stations**: MCP stations with `pursuit` not `'none'` and `trip: 'all'` (the bookshelf). Home Assistant panels (`trip: 'writes'`, `pursuit: 'none'`), built-in tools and tools needing approval are offered one by one, unchanged. `STATION_SINGLE_TOOL=0` offers every tool on its own as before (read at each turn).
- **The tool** (`stations/station-lookup.ts`, `StationLookup.offer`): named `go_to_<object id>` (sanitised, made unique: `go_to_bookshelf`), one argument `question`, read-only, spoken notice "Let me check the bookshelf.". Its description is built from the station verb, the object and room names, the MCP server name (and the preset's one-line blurb) and the tool names ("DAIR Academy papers, a reading library of AI research papers ... It can: latest papers of the week, search papers, ...").
- **Running it** (`StationLookup.run`, called by the voice instead of the registry): the lookup tool carries the real server id, so `StationTrips.begin` makes the usual phase 1 trip (walk while it runs, arrival hold, other place or errand); it is not a reading session (no seat, no book). Meanwhile a bounded loop runs on the avatar's own chat client with ONLY the station's tools (`PursuitLlm.useTools`: at most 4 tool calls, 4 model rounds, 60 s, no queue behind pursuit calls since the turn already holds the slot). The system prompt says to call the tools, not answer from memory, and return at most ~120 words with titles and links. The summary is the tool result; the conversation model speaks it in character.
- **Fallback**: if the model made no tool call, the first tool with no required argument whose name starts with `latest` (else `list`) is called with `{}` (DAIR: `latest_papers_of_the_week`), and the model summarises that; if that fails too the raw result is returned. The answer is never empty.
- **Logs** (main log): `Local voice: tools offered` (count, names) per turn; `Local voice: tool call` per call (avatarId, name, args cut to 300 characters, durationMs, ok, resultLength or error); `Stations: lookup start/tool call/end`; `Stations: trip start/arrived/held/end` with the station id and the case (`same-room`, `other-place`, `errand`) and `Stations: trip none` with `why` ("the avatar is not in a 3D room", "the avatar is already moving", ...). Reading steps and tool calls log as `Reading: step` and `Reading: tool call`.

## Settings

- Backgrounds, 3D rooms tab, "Things kept in the room": for each object an avatar can stand at, a "Holds" choice (None, each MCP server, Web search) and "Every use / Only changes"; for a station also "Read at" (the room's seats) and "Take" (its dynamic objects with a grab tag).
- Tools / MCP: a server held by a station says "Kept on the bookshelf in the Reading room"; each MCP tool has "Changes things / Only reads".

## Home Assistant panel (phase 4)

Kevin's rule: reads come in from anywhere, changes need a walk to the panel.

- **Room object**: `home-panel` ("a wall panel that controls the house", 0.3 x 0.2 x 0.03 m at 1.4 m, collider none) on the east wall of the Studio flat (z 0.5) and the Reading room (z -0.6), with a stand tag 0.7 m in front and a look tag. Tests check the spot is free and reachable.
- **Ready-made servers**: Tools / MCP, "Ready-made servers" lists "Home Assistant: <home name>" for each `homeassistant` server of Models and servers (`MCPManager` options `homeAssistantHomes`, `modelServerToken`; ids `home-assistant:<model server id>`). Adding makes an http server "Home Assistant (<home name>)" at `<home url>/api/mcp`, header `Authorization`, once per address. The token is **not copied**: the server keeps `tokenFromModelServer` (the Models and servers id) and main reads the token (keytar or env) at connect time and sends `Bearer <token>`; the renderer never sees it, and a changed token flows through on the next connect. Homes configured only by `HA_URL`/`HA_TOKEN` for the memory engine are not in Models and servers, so they are not listed.
- **Read-only defaults**: tool read-only = the person's choice, else the server's `readOnlyHint`, else the preset default (Home Assistant: names starting `Get` and `HOME_ASSISTANT_READ_TOOLS` in `mcp/presets.ts`), else changes things. `HassTurnOn`, `HassLightSet` etc. count as changes.
- **Confirmation**: on first discovery, Home Assistant tools whose name or description mentions lock, unlock, alarm, arm, disarm or garage get confirmation level `confirm` (spoken approval). Later changes by the person win.
- **Default station**: the first Home Assistant server no station holds goes on the Studio flat `home-panel` (`default:home-assistant`: verb use, activity "taps at the home panel", `trip: 'writes'`). One default only; further homes and other rooms' panels are set with the Holds picker. A default whose server is deleted is replaced by the next home; a removed one stays removed.
- **Trips**: "turn on the lamp" walks the avatar to the panel (hold up to 6 s for arrival); "what's the temperature" does not.
- **Pursuits**: Home Assistant stations carry `pursuit: 'none'`, so `PursuitManager.offers()` and `start()` skip them; only other stations (the bookshelf) are read at.

## Not in phase 1

Per-character activities, stations for several avatars at once at one object (each avatar walks to the same spot; the room's occupancy rules decide who goes first), and a settings page on a satellite (stations are set up on bija; `station:use` and `station:arrived` do cross to a satellite).
