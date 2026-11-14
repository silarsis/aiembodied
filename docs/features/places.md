# Places

Status: In Progress (step 1: bija alone; step 2: the hub, pairing and the Places settings page for desktop rooms; step 3: the satellite app, see [satellite.md](satellite.md)).

## What a place is

A place is somewhere an avatar can be. Every screen shows exactly one place, and every avatar is in exactly one place. bija (the big PC) runs the whole app and keeps the truth: which avatar is where.

Today there are two places:

| Id | Default name | Node | Meaning |
|----|--------------|------|---------|
| `home` | the lounge | `local` | The room drawn on this PC's screen. |
| `next-door` | next door | `offscreen` | A place nobody draws. Avatars can go there ("Sage, give us a minute"). |

Places drawn by another desktop ("desktop rooms") have the device id of that PC as their `node`. See "Desktop rooms" below. Names can be changed in Settings > Places (`PlaceManager.rename`).

An avatar that is not in the place on screen is not drawn. It does not hear what is said, and it does not answer by itself. It only comes back when it is called.

## Where the truth lives

`app/main/src/places/place-manager.ts` (no Electron imports; the store, clock and bus are injected).

- Places are kept in the memory store under `places.list` (JSON). Built-in places are filled in when missing.
- Locations are kept under `avatars.locations` (`{ avatarId: placeId }`). An avatar with no entry, or one naming an unknown place, is at `home`. Avatars that are not in the registry are ignored.
- `locationOf`, `avatarsAt` (registry order), `isPresent` (at the local place and not in transit), `resolvePlace` (by id or name; ignores case, "the", and hyphens or underscores against spaces).

### Moves

A move has two phases so the screen that will show the avatar can confirm it.

1. `startMove(avatarId, toPlaceId, reason)` puts the avatar in transit. It is now present nowhere (the hallway).
2. It arrives:
   - at an offscreen place, by itself after 1.5 s (`HALLWAY_MS`);
   - at the place drawn here, when the renderer calls `places:arrived`. The renderer does that once the body is loaded and standing at the door, not after the walk in.
3. If nothing confirms the arrival within 10 s (`MOVE_DEADLINE_MS`), the move fails and the avatar is back where it was. The stored location only changes on arrival.

A move to the place the avatar is already at is refused ("already there"). A second move while one is under way is refused ("already moving").

### What is journaled

Each move is one switchboard transaction `move:<avatarId>:<time>:<n>` with events of type `avatar.move` (`scene` = the target place, producer = the avatar, payload `{ avatarId, from, to, reason }`). The transaction is `open` at the start, `done` on arrival and `failed` at the deadline (payload reason "not confirmed in time"). Journaling is fire-and-forget, like the floor journal.

## How avatars move

### The `{room:<place name>}` tag

The places note at the end of every prompt says:

> You are in the lounge. Other places: next door (Sage is there). To go to another place, write {room:<place name>} at the end of what you say: you finish speaking, walk out, and arrive a few seconds later. You only hear and see what happens in the place you are in.

When an avatar writes the tag:

- In a 3D room with live motion, it walks to the first door of the room (`exit` scene action, planned by `planExit`; it stops 0.35 m inside the room). When the walk is over (or was skipped because there is no door) the renderer calls `places:move`.
- In 2D, or without live motion, the move starts after an estimate of how long the line takes to say. The app does not know when the audio of a line ends, so it estimates from the text (about 15 characters a second, at most 8 s).
- An unknown place makes `places:move` return `{ ok: false }`. The renderer logs a warning and nothing else.
- If Kevin speaks while the avatar is still walking to the door, the queued move is dropped like any queued scene action, and the avatar stays.

### Summons

When Kevin speaks, an avatar that is away can be called over, and its turn waits until it is here (`places/summon.ts`):

- Nobody at the local place: the avatar Kevin last talked with (within the partner window), else Echo, else the first avatar, is summoned and answers.
- Kevin names an avatar that is away (`payload.avatarId`): it is summoned first.
- Kevin's line is aimed at an avatar that is away, without naming it in the request: no code reads the words. The floor's chat-model intent step is also told which avatars are away ("In another place right now, and Kevin can call them over") and may pick one. Away avatars are never part of "everyone". If the plan names an away avatar, it is summoned before its turn runs.
- The fine-tuned quick model was trained on "Avatars in the room", so it never sees away avatars. While anyone is away, the quick model is skipped and the chat model reads the line. With nobody away nothing changes.
- If the avatar does not arrive in time, Kevin gets the usual reply error ("Sage did not come over.") and no turn runs.

A summon is a move with the reason `summoned`. The **Call** button on the Elsewhere chip is a move with the reason `called`.

## What the screen shows

- Avatars at the local place and not in transit are on stage. Others are not drawn, are not in the idle director's roster, and are left out of the scene text the others read.
- Echo can be away. Her body stays loaded, but is hidden: she is out of the 2D layout, her physics capsule is parked far away, her spots and seat are released, and her executor is reset. The rest of the app (status, settings, microphone) keeps working. A plain hide is used, not a fade.
- An avatar walking in has its body loaded out of sight first. When it is ready the renderer calls `places:arrived`; the avatar is then shown just inside the room's door, facing in, and walks to its spot (`{come}`, which also nudges it off a spot someone else holds). In 2D, or with no door, it simply appears where it stands.
- A small **Elsewhere** chip lists who is not on stage ("Echo is next door", "Sage is on the way to the lounge") with a **Call** button for each. The button is off while the avatar is already on the move.

## Prompts

Every avatar's system prompt ends with the places note (also chatter turns; never a preview turn). The paragraph is only added when at least two places exist.

## What each desktop room shows

A place has an optional `room`: the id of the room or background its screen draws (`room:builtin:studio-flat`, `room:<id>`, or a plain background id). Places without one use `DEFAULT_DESKTOP_ROOM` (in `places/default-room.ts`). Change it in Settings > Places, "Room shown there" (`room-hub:set-room`, `PlaceManager.setRoom`). The lounge uses the active background of this PC as before.

## One floor per place

Each place has its own `FloorController`, so avatars talk to Kevin and to each other where they are. Chatter, summons and announcements go to the screen of the place the avatar is in. The tag instructions an avatar gets list only the places and people it can reach from its own place.

## Desktop rooms

A second desktop can draw one place. It is paired once, then it keeps a WebSocket open to bija over Tailscale. The protocol is in [room-link-protocol.md](room-link-protocol.md). bija's side is `app/main/src/room-hub/`; the satellite app is described in [satellite.md](satellite.md). `scripts/room-link-client.mjs` is still a small test client.

### Pairing

1. On bija: Settings > Places > **Add a desktop room**. Type the room's name (default "the study"). bija shows a 6-digit code, a 5-minute countdown and the address(es) to type on the other PC (`http://<bija or its Tailscale IP>:8791`), and a **Cancel** button.
2. The other PC sends the code to `POST /v1/pair`. The code works once. Ten wrong codes from one address within a minute lock that address out for a minute.
3. bija creates the device, a new place (`id` = a slug of the name, made unique; `node` = the device id) and a token. The token goes to the other PC once. bija keeps only its SHA-256 in `<userData>/room-devices.json`.
4. **Revoke** (same page) stops the token, closes the link, removes the place and sends its avatars to the lounge.

### Online and offline

A desktop room is online from the moment its satellite says hello until the link drops (closed, or 6 s without traffic). The snapshot says so (`online` on desktop rooms only; the lounge and next door are always online). Moving to a closed room is refused ("the study is closed").

When a room goes offline its avatars stay for 60 seconds, in case it was only a blip. After that they are sent home as a move with the reason `room closed`. The move is to the local place, so the lounge walks them in through the door like any arrival. At start-up no desktop room is connected, so the same 60 seconds apply to avatars left in one.

An avatar walking to a desktop room is confirmed by that satellite with `places:arrived`, like the local renderer does for the lounge.

### Journal

The hub writes `place.paired`, `place.online`, `place.offline`, `place.revoked` and `place.refused` (payload `{ address, code }`, where `code` is `pairing-code`, `peer`, `auth` or `protocol`) to the switchboard. Fire and forget.

### Security

- The server listens only on `127.0.0.1` and on this PC's own Tailscale addresses (100.64.0.0/10). Never `0.0.0.0`. It checks again every 60 s, because Tailscale may come up after the app.
- It runs only while a PC is paired or a code is active. `ROOM_HUB_ENABLED=1` keeps it on, `ROOM_HUB_ENABLED=0` keeps it off. `ROOM_HUB_PORT` changes the port (default 8791).
- Every connection must send the device token. Only the SHA-256 is stored, and the compare takes constant time.
- Every connection from another PC must also pass a Tailscale check (`tailscale whois --json <ip>`): the peer's node name must be the one recorded at pairing, and its login must be the login of bija's own node. If the Tailscale command is missing or fails, the peer is refused. A satellite on bija itself (127.0.0.1) skips the check, for testing.
- A satellite can only call the channels in `room-hub/allowlist.ts`: read-only fetches for drawing a room and avatars, plus `places:*`. Settings, models, keys, coding, generation, uploads, deletes and `app:*` are never allowed.
- Never expose the port with Tailscale Funnel or a router port forward.
- A suggested Tailscale ACL: let only your own devices reach bija on port 8791.

```json
{
  "acls": [
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:bija:8791"] }
  ]
}
```

(Tag bija as `tag:bija`, or use its Tailscale IP in `dst`. Use `src` with your own user or tag if other people share the tailnet.)

### Trying it on one PC

```
node scripts/room-link-client.mjs pair http://127.0.0.1:8791 123456 "the study"
node scripts/room-link-client.mjs connect http://127.0.0.1:8791
```

Make the code first in Settings > Places. `connect` prints the welcome and every message, and pings every 2 seconds. Add `--call <channel> '[args]'` or `--asset <url>` to try a request.

## Camera presence

Any place can note that a face is there. The camera only ever produces "a face was seen at t". No frame leaves the PC and nothing is stored. There is no recognition: it does not know who it is.

- The detector is MediaPipe's BlazeFace short-range model, run in the renderer at 2 frames a second on a hidden video (`app/renderer/src/camera/`). The model is in `app/renderer/public/models/` (Apache-2.0, see the README there). The WASM files are copied from `@mediapipe/tasks-vision` at build time. Nothing is fetched from the internet when the app runs, and the page's content policy would block it.
- A face that appears after none was seen for 30 s sends the `greet_face` cue. While a face stays in view `faceSeenAt` is reported every 5 s.
- **Setting.** Each place has "Camera presence" in Settings > Places. A desktop room defaults to on. This PC (bija's own place) defaults to off, because it films Kevin's main desk. An offscreen place has no camera. The value is saved in the place record only when Kevin changes it and goes to a satellite in its places snapshot.
- **When it runs on bija:** the setting is on and at least one avatar stands at this screen. A small green dot shows in the corner while it is live. Pick the camera in Devices and wake words.
- **When it runs on a satellite:** only while the device gate says so (see [satellite.md](satellite.md)).
- **Arrival.** When an avatar arrives at a place and a face was seen there in the last 30 s, it waves. Main sends `greet_face` with the avatar's id (`presence/arrival-greeting.ts`), so any avatar can wave, not only Echo.
- **Presence text.** A satellite's `faceSeenAt` is stored per place in bija, stamped with bija's clock when it arrives. The decision step's presence text gets one extra line per desktop room, for example "The study: a face was seen 2 min ago; Echo is there." Bija's own lines are unchanged, and with no desktop room nothing is added.
- If the model file is missing or the camera cannot open, the camera stays off and the reason is logged (shown in the satellite's Status panel). Run `node scripts/fetch-face-model.mjs` to fetch the model again.

## Limits

- The OpenAI Realtime conversation engine is Echo-only and not place-aware. Places work with the local voice engine.
- A desktop room has a microphone and a camera (both behind the privacy gate, see [satellite.md](satellite.md); the camera is presence only, see below). Its presence and its device state (mic, camera, speakers, locked, closed, full screen) are kept per place in bija (`presence/place-presence.ts`) and shown in Settings > Places and the Status panel. A closed room, a screen locked for 5 minutes or a full-screen app for 2 minutes send its avatars home (`room-hub/place-devices.ts`).
- `places:summon` (the talk key with nobody in the room) calls the recent partner, else Echo, else the first avatar to the caller's place. It works for bija's own window too.
- Chatter between avatars happens only among avatars in the same place.
- A move away from this PC that is never confirmed brings the avatar back on screen, but a body that was unloaded appears at its normal spot, not at the door.
- Revoking a desktop room puts its avatars back in the lounge at once (they appear where they stand, without the door walk), because the place is gone.
