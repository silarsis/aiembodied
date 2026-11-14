# Satellite mode

Status: Built (Places steps 3, 4 and 6).

A satellite is a second PC that shows one room of bija's world. bija stays the only brain: the models, the memory and the keys stay there. The satellite draws the room and the avatars that are in it, plays their voices, and lets Kevin type to them.

## Starting one

- Set `AIEMBODIED_ROLE=satellite`, or put `{"role":"satellite"}` in `satellite.json` in the app's data folder. `AIEMBODIED_ROLE=full` forces the normal app.
- `AIEMBODIED_USER_DATA=<folder>` moves the data folder, so two copies can run on one PC. The single-instance lock is kept per data folder.
- `pnpm dev:satellite` starts a satellite with its own home (`.dev-home-satellite`) and no local services. It can run beside `pnpm dev:run`.

## First run

The window shows "Connect to bija": bija's address (default `ws://bija:8791`), the 6-digit code from bija's Settings > Places > "Add a desktop room", a name for the room and a name for this PC. The token that comes back is kept in the system keychain (service `aiembodied-room-link`). If the keychain is not available it is kept in memory only, and the status says so; the PC must be paired again after a restart.

## What the window shows

- The room that bija gave this place (`Place.room`), with the avatars that are there. Avatars elsewhere show in the Elsewhere chip.
- A typed box. It runs the same turn as speech: the answer is spoken, tagged and lip-synced.
- Status, with the pairing and the link, and "Forget this pairing".
- A banner when the link is down. The avatars keep their idle clips. When bija refuses this PC (removed there) the banner offers Forget.
- Two small dots in the top right corner: microphone and camera. Green is live, amber is doorbell only, grey is off. They have words for screen readers and a tooltip that says why the mic is off.
- The listening button shows the gate ("Mic off · Nobody is in this room"). Kevin can still turn listening off by hand.
- No camera yet, no settings, characters, rooms or tools. Quit is hidden too: use F11 for full screen and close the window to leave.
- No OpenAI Realtime.

## How it works

- `satellite/satellite.ts` registers the IPC channels the renderer expects. `satellite/channels.ts` sorts each one: forwarded to bija, answered locally, unavailable, or an event from bija. A test checks that every preload channel is sorted.
- `satellite/room-link.ts` is the client: it reconnects with a 1 s to 30 s backoff, pings every 2 s and treats 6 s of silence as a lost link. Refusals (bad token, removed, replaced, protocol) stop the retries.
- Room files come through an asset protocol with an on-disk cache of up to 500 MB (oldest used leaves first). The cache is keyed by URL, so a room file that changes under the same URL is not refreshed until it leaves the cache. VRM bytes are cached by model id and file hash.
- A few cheap channels (wake word list, approvals, metrics, talk shortcut) are answered locally with empty answers.
- bija keeps one floor per place, so the avatars at a satellite talk there. See [places.md](places.md).

## The microphone and the privacy rules

The mic is live only while all of these are true:

1. At least one avatar is in this room (in transit does not count).
2. The screen is unlocked.
3. The link to bija is up.
4. The room is open (Kevin has not closed it).
5. No other app is full screen on any monitor.

The rule lives in the satellite's main process (`satellite/device-gate.ts`, wired in `device-runtime.ts`), not in the page, and it fails closed: a fact that is not known yet counts as "no". bija can ask devices off (`device.off`) but can never turn them on. The camera stays off until a later update.

When the gate closes:

- The page is told (`device-gate:changed`), stops every capture track at once and answers `device-gate:capture-stopped`.
- If the page has not answered within 1 second, main reloads the page. That drops every media stream.
- `media` permission requests are refused (and `getUserMedia` fails) while the gate is closed, so a new capture cannot start.
- The tray icon, its tooltip and bija are updated (`device.state`).

Full-screen check: on Windows one long-lived PowerShell process answers once every 3 seconds (foreground window covers its monitor; our own window, the desktop and the shell are ignored). If it does not answer, the room counts as full screen until it does. Other systems are never "full screen".

### The camera

The camera follows the same gate as the mic, with one more fact: the room's "Camera presence" setting (kept on bija, on by default for a desktop room, shown read-only in the Status panel). The camera is live only when an avatar is in the room, the screen is unlocked, the link is up, the room is open, no other app is full screen, bija has not held the devices off, and the setting is on. A setting that has not arrived yet counts as off.

- The camera dot is green only while that is true. There is no doorbell level for the camera.
- `media` permission requests are answered by what they ask for: video needs the camera to be allowed, audio needs the mic, both need both. A request that cannot be read is refused.
- When the camera closes (setting off, or the gate closes) the page stops and releases every track at once and tells main. If it does not confirm within 1 s, main reloads the page, the same as for the mic.
- What is sent to bija: `device.state` (camera `live` or `off`), and `presence` with `faceSeenAt`. What is never sent: video, frames, pictures, or anything about who the face is. Nothing is stored on the satellite either.
- Pick the camera in the Status panel. The choice is kept on this PC only.

### Kill switch

Tray menu "Close this room" / "Open this room", the same button in Status, or the global shortcut Ctrl+Alt+Shift+R (set `closeShortcut` in `satellite.json` to change it). Closing sends `room.close`: bija moves every avatar there home (reason "room closed") and refuses moves to the room until `room.open`. A closed room stays closed after a restart (`closed` in `satellite.json`).

### What bija does with the state

- Locked for 5 minutes: the avatars there walk home (reason "screen locked").
- A full-screen app for 2 minutes: the avatars walk home (reason "full screen app"). This is not saved.
- Every change of mic, camera, speakers, lock, close or full screen is journaled as `place.device`. bija's Status panel and Settings > Places show each room's mic and camera.

### Tray and notification

The tray icon has a coloured dot and the tooltip says "Study: mic live", "Study: doorbell only" or "Study: off". The first time the mic goes live in a session Windows shows "Echo is here: the mic is on in the study".

### The doorbell and the wake word

The doorbell is a setting of the place, kept on bija (Settings > Places, "Doorbell"; off by default for a desktop room). The satellite reads it from the places snapshot, and it is off until the first snapshot has arrived. The `doorbell` field of `satellite.json` is no longer read.

The wake word worker (openWakeWord, the same service as on bija) runs in this PC's main process exactly when `gate.micAllowed || gate.doorbell`:

| Avatar here | Doorbell on | Other gate facts | Worker | Mic dot |
|---|---|---|---|---|
| yes | any | all true | runs | green |
| no | yes | all true | runs | amber (doorbell) |
| no | no | all true | off | grey |
| any | any | one is false | off | grey |

It stops the moment the gate closes (events are thrown away at once; the microphone is released after). If the model cannot be had it does not listen and tries again every 30 seconds while the gate stays open (`satellite/wake-runner.ts`).

- In doorbell mode a wake sends `wake.heard` (model name and score) and nothing else. bija calls an avatar into the room if its doorbell is on and nobody is there. The page's own microphone is not opened for the doorbell (`allowsMedia('audio')` is false), so audio never leaves this PC.
- With an avatar in the room a wake goes to this PC's page like on bija. The satellite still does not require the wake word for a turn: while the mic is live anything said is a turn.
- The model: a built-in one is on every PC. A trained one is fetched from bija (`wake-word:model`) each time the worker starts, and kept by hash in `<userData>/wake-word-cache/`.

### Activity

Every 15 seconds the PC checks `powerMonitor.getSystemIdleTime()`. When it is under 60 seconds the PC sends `presence` with `activeAt`. bija stamps it with its own clock. That is all it says: "someone used this PC". No microphone or camera is involved. It is what lets avatars wander here (see [places.md](places.md)).

### Voice on the satellite

The satellite uses the same voice pipeline as bija: voice detection, end of speech, transcription on bija (forwarded `local-voice:transcribe`), answer. While the mic is live anything said is a turn (the wake word is not required here, see above). Speakers are picked in Status and saved in `satellite.json`; every speech audio element uses them.

### Talk key and taps

The global push-to-talk key (Settings on bija, or `pushToTalk` in `satellite.json`) and a tap on the screen work as on bija when a character is here. With nobody in the room (and everything else fine) they are a summons: the mic stays closed, bija moves the recent partner (else Echo, else the first avatar) to this room (`places:summon`) and the screen says "Calling Echo…". bija's own window uses the same call.

### Latency

For each spoken turn the renderer measures, from the end of speech: transcript back, first sentence of audio received, playback started. The numbers go to the main log ("Satellite turn timing") and the last turn is shown in Status. The link ping round trip is logged every 30 seconds.

### If the mic does not work

- Look at the dot and the listening button: the reason is written there ("The screen is locked", "Another app is full screen", "Nobody is in this room", ...).
- "Nobody is in this room": call a character over from bija, or press the talk key.
- "Another app is full screen" with nothing full screen: the PowerShell check may be blocked. Look in the main log for "full-screen check".
- A closed room stays closed after a restart. Use the tray menu or Ctrl+Alt+Shift+R.
- The mic still stays off after all of this: the page may be refused the `media` permission while the gate was closed; reload with Ctrl+R.

## Not yet

Requiring the wake word for a turn on the satellite, and showing the wake word's score in its Status panel.
