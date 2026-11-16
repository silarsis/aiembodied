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

## Settings

- Backgrounds, 3D rooms tab, "Things kept in the room": for each object an avatar can stand at, a "Holds" choice (None, each MCP server, Web search) and "Every use / Only changes"; for a station also "Read at" (the room's seats) and "Take" (its dynamic objects with a grab tag).
- Tools / MCP: a server held by a station says "Kept on the bookshelf in the Reading room"; each MCP tool has "Changes things / Only reads".

## Not in phase 1

Per-character activities, stations for several avatars at once at one object (each avatar walks to the same spot; the room's occupancy rules decide who goes first), and a settings page on a satellite (stations are set up on bija; `station:use` and `station:arrived` do cross to a satellite).
