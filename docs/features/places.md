# Places

Status: In Progress (step 1: bija alone; step 2: the hub, pairing and the Places settings page for desktop rooms; step 3: the satellite app, see [satellite.md](satellite.md); step 6: wandering, doorbell and urgent news).

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
- **Setting.** Each place has "Camera presence" in Settings > Places. A desktop room defaults to on; a phone or browser room defaults to off. This PC (bija's own place) defaults to off, because it films Kevin's main desk. An offscreen place has no camera. The value is saved in the place record only when Kevin changes it and goes to a satellite in its places snapshot.
- **When it runs on bija:** the setting is on and at least one avatar stands at this screen. A small green dot shows in the corner while it is live. Pick the camera in Devices and wake words.
- **When it runs on a satellite:** only while the device gate says so (see [satellite.md](satellite.md)).
- **Arrival.** When an avatar arrives at a place and a face was seen there in the last 30 s, it waves. Main sends `greet_face` with the avatar's id (`presence/arrival-greeting.ts`), so any avatar can wave, not only Echo.
- **Presence text.** A satellite's `faceSeenAt` is stored per place in bija, stamped with bija's clock when it arrives. The decision step's presence text gets one extra line per desktop room, for example "The study: a face was seen 2 min ago; Echo is there." Bija's own lines are unchanged, and with no desktop room nothing is added.
- If the model file is missing or the camera cannot open, the camera stays off and the reason is logged (shown in the satellite's Status panel). Run `node scripts/fetch-face-model.mjs` to fetch the model again.

## Activity: "someone used this PC"

Each place reports when its PC was last used. `app/main/src/presence/activity-monitor.ts` reads Electron's `powerMonitor.getSystemIdleTime()` every 15 seconds; an idle time under 60 seconds means the PC is in use right now. bija keeps the time per place (`PlacePresence`, field `activeAt`): its own straight from its monitor, a satellite's through a `presence` message with `activeAt`. A satellite's value is stamped with bija's clock when it arrives, like `faceSeenAt`.

No microphone or camera is involved, so this works for an empty place too. It is what makes wandering sensible: an avatar only goes where someone sits. The places snapshot carries `activeAt` per place, `movedAt` per avatar (when it last arrived anywhere, since bija started) and `now` (bija's clock), so a reader never compares clocks of two PCs.

## Wandering between places

An idle avatar may walk to another place on its own. All the rules live in `places/wander.ts` (`wanderRefusal`), and they are enforced in code, not only in the prompt:

- **(a)** it has not changed place in the last 10 minutes (a summon, a call or a wander all count);
- **(b)** the target is online and open (not closed with the kill switch);
- **(c)** someone used that PC in the last 10 minutes, or another avatar is standing there;
- **(d)** it is not speaking, and Kevin did not talk with it in the last 2 minutes (it was his last partner).

How it runs:

1. The idle prompt (`rooms/idle-prompt.ts`) gains the other places, who is in each, and whether that PC was used in the last 10 minutes, plus the tag `{room:<place>}`. Only open places where someone used the PC or an avatar stands are listed, and nothing is listed for an avatar that moved in the last 10 minutes. So with one place, or while nobody is anywhere else, the prompt is exactly what it was.
2. The idle director reads a fresh snapshot from bija before it decides. `parseIdleReply` keeps a `{room:}` only for a place that was offered, and only as the last tag.
3. Before running it the director asks bija (`places:can-wander`, with whether the avatar is speaking). A refused tag is dropped, whatever the model wrote, and the usual fallback picks something else.
4. The avatar walks to the door like for any `{room:}` and the renderer calls `places:move` with the reason `wandered`. bija checks the rules once more with fresh facts, then moves it. The move is journaled with the reason `wandered`.

**Next door.** An avatar next door has no screen, so no idle life. Every 60 seconds bija (`places/next-door-return.ts`) looks at the avatars there. If one may come back (the same rules) and the restlessness setting rolls it (calm 5 %, normal 10 %, restless 20 % per minute; nothing when idle wandering is switched off), it walks to the place used most recently. At most one avatar per roll.

## Doorbell

A place's **Doorbell** (Settings > Places) says what its wake word does while nobody is there. On for bija's own place by default, off for a desktop room, none for next door. It is saved in the place record only when Kevin changes it (`Place.doorbell`, `doorbellOn`).

- **bija.** With an avatar at this screen the wake word listens when listening is on, as always. With nobody here and the doorbell on it still listens; hearing it calls an avatar (the recent partner, else Echo, else the first one, like the talk key) and the turn starts once it has arrived: only then does the renderer get the wake event and listen for the follow-up. With nobody here and the doorbell off the wake word stops and the microphone is released; it comes back when an avatar has arrived (walking in does not count). `WakeWordListeningController.setGate` does this without touching what the page asked for. See `places/doorbell.ts`.
- **A satellite** runs the same openWakeWord worker in its own main process (`satellite/wake-runner.ts`), but only while the privacy gate allows it: an avatar is in the room and the gate is open (mic live), or the doorbell is on and every other gate fact is true (mic `doorbell`, amber). Anything else, or anything not yet known, and it is not running. In doorbell mode a wake sends `wake.heard` (model name and score) and bija calls an avatar into that place if its doorbell is on and nobody is there. Audio never leaves the satellite, and the page's own microphone stays closed in doorbell mode. With an avatar in the room the wake goes to that PC's own page, as on bija.
- **Models.** Built-in models ship with the app. A trained model comes from bija: the satellite asks `wake-word:model` each time its worker starts and gets the settings picked on bija plus, for a trained model, the .onnx bytes (only from the trained folder, `.onnx`, up to 16 MB). It keeps the file by hash in `<userData>/wake-word-cache/`. bija's own microphone index is never used there.

## Phone and browser rooms

A place drawn by a phone or a browser has a kind (`Place.kind`: `phone` or `browser`; a desktop room has none). It is set when the device pairs (`kind` in the pair request) and shown in Settings > Places. Kevin's rules, by kind (`places/place-kind.ts`):

| Rule | desktop | browser | phone |
|---|---|---|---|
| Doorbell default | off | off | off (the toggle stays) |
| Camera presence default | on | off | off |
| Wanders in unprompted | yes | yes | no |
| Avatars go home after the link drops | 60 s | 60 s | 2 min |
| Avatars go home after the screen is locked or the app is not in front | 5 min | 5 min | 2 min |
| New room starts in | Studio flat (3D) | Studio flat (3D) | a 2D background (`builtin:garden`) |

A saved Camera presence or Doorbell setting always wins over the default.

- **No unprompted wandering into a phone.** The idle prompt does not list a phone room, `wanderRefusal` refuses a `wandered` move into one ("a phone is not for wandering"), and the next-door tick never picks one. A summon (the talk key, the doorbell), a `{room:}` in a conversation turn and urgent news still may go there. A browser room follows the desktop rules.
- **Opening the app counts as activity.** A web page (browser or phone) reports `presence {activeAt}` while it is visible and in the foreground: once at start, then every 15 seconds, and on any touch, pointer or key (throttled to one per 15 seconds). Nothing is sent while the page is hidden. bija stamps it with its own clock, like a desktop's. So a phone someone is holding counts as "a PC in use" for wandering, and for urgent news (it is "active" if `activeAt` is within 2 minutes, the same as any place).
- **Walking home.** When a phone's link goes offline (`PlaceManager.setOnline`, grace 2 minutes instead of 60 seconds), or its gate reports "locked" (the app is not in the foreground; `PlaceDevices`, 2 minutes instead of 5), its avatars walk home to bija. Both clocks stop if the phone comes back in time. The page sends its gate state again every time the link comes up, so a stale "locked" is cleared.

## Urgent news walks to Kevin

When an urgent `avatar.inbox` event (priority high or urgent) or a `home.alert` is about to be spoken, and nobody used the PC at the avatar's place in the last 2 minutes while another place's PC was used in that time, the avatar walks there first (`places/urgent-walk.ts`, hooked into the inbox as `beforeUrgent`). The news waits for it to arrive, at most 10 seconds, then is spoken either way. The announcement is delivered to the screen that shows the avatar at that moment. Anything else is unchanged.

## Rooms closing

A room that is closed, a screen locked for 5 minutes, or a full-screen app for 2 minutes sends its avatars home (`PlaceDevices`). They are moves to the local place, so each avatar walks in through bija's door and the renderer confirms the arrival.

## Limits

- The OpenAI Realtime conversation engine is Echo-only and not place-aware. Places work with the local voice engine.
- A desktop room has a microphone and a camera (both behind the privacy gate, see [satellite.md](satellite.md); the camera is presence only, see below). Its presence and its device state (mic, camera, speakers, locked, closed, full screen) are kept per place in bija (`presence/place-presence.ts`) and shown in Settings > Places and the Status panel. A closed room, a screen locked for 5 minutes or a full-screen app for 2 minutes send its avatars home (`room-hub/place-devices.ts`).
- `places:summon` (the talk key with nobody in the room) calls the recent partner, else Echo, else the first avatar to the caller's place. It works for bija's own window too.
- Chatter between avatars happens only among avatars in the same place.
- A move away from this PC that is never confirmed brings the avatar back on screen, but a body that was unloaded appears at its normal spot, not at the door.
- Revoking a desktop room puts its avatars back in the lounge at once (they appear where they stand, without the door walk), because the place is gone.
