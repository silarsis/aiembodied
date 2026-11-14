# RoomLink protocol v1

Status: built on both sides. The hub is `app/main/src/room-hub/`; the satellite client is `app/main/src/satellite/room-link.ts` (see [satellite.md](satellite.md)). `scripts/room-link-client.mjs` is a small test client.

The link between bija's RoomHub (`app/main/src/room-hub/`) and a satellite's RoomLink.

One WebSocket per satellite, opened by the satellite to `ws://<bija tailscale name or IP>:<port>/v1/link`.
Default port 8791 (`ROOM_HUB_PORT`). Pairing is one HTTP call on the same server: `POST /v1/pair`.

## Frames
- Text frames: JSON objects `{ "op": "<name>", ... }`.
- Binary frames: `[4-byte big-endian header length N][N bytes UTF-8 JSON header][payload bytes]`. The header is a normal
  op object (e.g. `{"op":"turn.audio","requestId":"r1"}`); the payload is raw bytes (WAV, VRM, GLB, JSON file...).
- Max frame 64 MB (VRMs can be ~10-20 MB). Text frames max 1 MB.

## Pairing (HTTP, before any socket)
`POST /v1/pair` body `{ "code": "123456", "deviceName": "Kevin's desk", "placeName": "the study" }` ->
`200 { "deviceId", "token", "placeId", "protocol": 1 }`. `401` wrong/expired code, `403` the peer failed the Tailscale check (below), `409` too many paired rooms (20), `429` locked out (10 wrong codes from
one address within a minute -> that address is refused for 60 s). The code is 6 digits, one-time, valid 5 minutes,
made on bija in Settings -> Places -> "Add a desktop room". If `placeName` was typed on bija, that name wins; the satellite's `placeName` is the fallback. The token is 32 random bytes, base64url; bija stores only its
SHA-256. The satellite keeps the token in keytar (service `aiembodied-room-link`, account = hub URL).

## Connection
1. Client -> `{"op":"hello","protocol":1,"deviceId","token","appVersion"}`. Must be the first message within 5 s.
2. Hub checks: protocol == 1 (else `{"op":"error","code":"protocol","hub":1,"client":N}` and close 1008); token hash
   matches the device (else `error code:"auth"`, close 1008); peer check (below). Then
   `{"op":"welcome","protocol":1,"placeId","place":{...},"snapshot":<places snapshot>,"avatars":[AvatarProfile...],
     "settings":{ "wakeWord": {...} | null, "pushToTalk": {...} | null }}`.
3. Heartbeat: client sends `{"op":"ping","t":<ms>}` every 2 s; hub answers `{"op":"pong","t"}`. Either side treats 6 s
   without traffic as a dropped link. The hub marks the place offline; the satellite turns its devices off.
4. Requests that expect an answer carry `"ref"` (string); the answer echoes it. Failures: `{"op":"error","ref","code",
   "message"}`.

## Peer check (hub side, every connection)
Loopback peers (127.0.0.1/::1) are accepted without it (a satellite run on bija itself, for testing). For any other
peer the hub runs `tailscale whois --json <ip>` (tailscale CLI from PATH, else `%ProgramFiles%\Tailscale\tailscale.exe`)
and accepts only if the peer's node name equals the node name recorded for that device at pairing time and the peer's
user login equals the login of bija's own node (`tailscale status --json` -> Self). If the CLI is missing or fails, a
non-loopback peer is refused (`error code:"peer"`). Pairing records the node name the same way.

## Ops after welcome

The satellite runs the same renderer as bija. Its renderer talks to its own main process over the usual IPC channels,
and the satellite's main process forwards an **allowlisted** set of those channels to bija with `call`. On bija the hub
runs the very same handler functions that `ipcMain.handle` registered (main.ts keeps them in a map as it registers
them), with a fake `event.sender` whose `send(channel, ...args)` is forwarded back to that satellite as `ipc`. So
`local-voice:respond`, `avatar-motion:stream` and friends work unchanged, and their streamed events reach the satellite.

Binary values: any `Uint8Array`/`ArrayBuffer`/Buffer inside `args` or a result is replaced in the JSON by
`{"$bin": <index>}` and sent in a binary frame: header `{op, ..., bins: [len0, len1, ...]}`, payload = the byte arrays
concatenated in order. A message with no binary values is a text frame.

Satellite -> hub:
| op | fields | answer |
|---|---|---|
| `ping` | t | `pong` |
| `call` | ref, channel, args[] | `result` {ref, value} or `error` {ref, code, message} |
| `asset.get` | ref, url (a room asset URL as the renderer's asset protocol sees it) | binary `asset` {ref, mime} or error |
| `presence` | listening?, voicePhase?, faceSeenAt?, userSpokeAt?, assistantSpokeAt?, activeAt? | - |
| `device.state` | mic, camera: 'off'\|'live'\|'doorbell'; speakers: 'off'\|'live'; locked: bool; closed: bool; fullscreen: bool | - |
| `room.close` / `room.open` | - (the kill switch) | - |
| `wake.heard` | model, score | - |

Hub -> satellite:
| op | fields |
|---|---|
| `welcome`, `pong`, `error`, `result`, `asset` | see above |
| `ipc` | channel, args[] (an event for the satellite's renderer, e.g. `local-voice:event`, `avatar-motion:chunk`, `places:changed`) |
| `device.off` | reason (the hub may ask devices off; it can never turn them on) |

The hub keeps the allowlist (`room-hub/allowlist.ts`) and refuses every other channel with `error code:"denied"`. It
grows per PR: PR 2 = read-only fetches the satellite needs to draw a room and avatars (avatar models list/load, room
list/load, backgrounds, animation and pose lists/loads, avatars list, idle settings, places snapshot/move/arrived);
PR 3 adds talking and moving (local-voice respond/cancel/status/transcribe/system-status/voice-options,
avatar-motion stream/cancel/status, floor:interrupt, avatars:set-tag-instructions scoped to the satellite's place,
conversation history, presence:update, rooms:idle-pick, and other read-only getters the renderer needs). Settings,
models, keys, coding, generation, uploads, deletes and app:* are never allowed.

Events bija pushes on its own (not as a reply to a call): `places:changed`, `avatars:changed` (if such an event exists),
and turn events for avatars at the satellite's place that bija started itself (chatter, summons, announcements): those
are routed by the avatar's location: an avatar at a device place gets its `local-voice:event`s on that satellite, not on
bija's window.

## Notes on what is built (PR 2)

- Code: `frames.ts` (wire format), `room-hub.ts` (server), `room-devices.ts` (device file, code, lockout), `tailscale.ts` (peer check), `allowlist.ts`, `ipc-registry.ts` (main.ts registers every handler through `handleIpc`, which also stores it there).
- Extra error codes the hub uses: `hello-timeout`, `bad-frame`, `bad-request`, `unknown-op`, `denied`, `unavailable` (no handler on bija), `failed` (the handler threw), `too-large`, `not-found` (asset), `revoked`, `replaced`.
- `asset.get` answers with a binary frame `{op:"asset", ref, mime}` whose payload is the file. It has no `bins` list.
- `places:snapshot` from a satellite is answered by the hub itself (relative to the satellite's place). `places:arrived` is only passed on when the avatar is on its way to that satellite's place.
- `presence`, `device.state` and `wake.heard` are accepted and handed to the owner of the hub (`onSatelliteMessage`); PR 3 gives them a meaning.
- A satellite's place is offline until it says hello. When the link drops, its avatars stay for 60 s, then walk in at the local place as a move with the reason `room closed`.
- The hub never sends `device.off` by itself yet; `RoomHub.deviceOff(deviceId, reason)` exists for later steps.

## Notes on what is built (PR 3)

- The allowlist also has the talk, move and getter channels a satellite needs, plus `conversation:append-message` and `conversation:announce` (so a turn on a satellite is saved in bija's history). Each call carries the satellite's place; handlers use it to pick the floor and the screen.
- The hub fake event has a `placeId`. `RoomHub.sendToPlace` and `sendToAll` push an `ipc` event to one place or to every satellite.
- Presence from a satellite is kept per place (`presence/place-presence.ts`).
- `RoomHub.stop()` now terminates open sockets first. Before, a connected satellite kept it waiting for ever.
- The satellite waits up to 6 s for the first connection before a call fails, and has no timeout on `local-voice:respond` and `avatar-motion:stream`. Other calls time out after 60 s.
- Room assets and VRM bytes are cached on the satellite (see satellite.md).

## Notes on what is built (PR 4)

- `device.state` also carries `fullscreen`. `room.close` / `room.open` are the kill switch: bija moves the avatars at that place home (reason `room closed`) and refuses moves to it until `room.open`. The `closed` flag of `device.state` has the same effect, so a restart of either side agrees.
- Clocks on bija (`room-hub/place-devices.ts`): locked for 5 minutes and full screen for 2 minutes send the avatars home. Changes are journaled as `place.device`.
- `places:summon` is allowlisted. The ping round trip is logged on the satellite every 30 seconds.
