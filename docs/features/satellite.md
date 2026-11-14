# Satellite mode

Status: Built (Places steps 3, 4, 6 and 7).

A satellite is a second PC that shows one room of bija's world. bija stays the only brain: the models, the memory and the keys stay there. The satellite draws the room and the avatars that are in it, plays their voices, and lets Kevin type to them.

## Starting one

- Set `AIEMBODIED_ROLE=satellite`, or put `{"role":"satellite"}` in `satellite.json` in the app's data folder. `AIEMBODIED_ROLE=full` forces the normal app.
- `AIEMBODIED_USER_DATA=<folder>` moves the data folder, so two copies can run on one PC. The single-instance lock is kept per data folder.
- `pnpm satellite` builds and starts a satellite for daily use (normal data folder, no local services). See "Set up a second desktop".
- `pnpm dev:satellite` starts a satellite with its own home (`.dev-home-satellite`) and no local services. It can run beside `pnpm dev:run`.

## Set up a second desktop

Do this on the second PC (Windows). It runs no models.

1. Install Tailscale from https://tailscale.com/download and sign in to the same tailnet as bija.
2. Clone the repo, then in PowerShell from the repo folder: `.\scripts\install-windows.ps1 -Role satellite`. It installs Node.js, pnpm and git if they are missing, runs `pnpm install`, and writes `AIEMBODIED_ROLE=satellite` to `.env` if it is not set. It installs nothing else: no models, no Python services. It warns if Tailscale is missing or not logged in.
3. On bija, open Settings > Places > "Add a desktop room". It shows a 6-digit code.
4. On the second PC run `pnpm satellite`. It builds the app and starts it as a satellite, with the normal app data folder and no local services.
5. Enter bija's Tailscale name, for example `ws://bija:8791`, the code, and a name for the room.
6. Test the link: `tailscale ping bija`. Look for "via <LAN address>" (a direct connection). "via DERP(...)" means a relay: it works, but voices will lag more.
7. Optional: Status panel > "Start when I sign in". It is off by default. On Windows it adds a per-user start-up entry (`HKCU\...\Run`, named "AI Embodied Assistant Satellite") that starts Electron on the built `app/main/dist/main.js` with `--satellite`, so run `pnpm satellite` once first and keep the repo where it is. Turn the checkbox off to remove the entry.

`pnpm satellite` is for daily use. `pnpm dev:satellite` is for development: it has its own home (`.dev-home-satellite`).

### Windows firewall on bija

The first time the room hub listens on Windows, the log says so and the Places page shows a note: Windows may ask to allow Electron through the firewall. Allow private networks only, not public. The note comes once per PC (the marker is `room-hub-firewall-noted` in the data folder).

### Suggested Tailscale ACL

Let a satellite reach bija's room hub and nothing else. Tag the satellites (for example `tag:satellite`) and bija (`tag:bija`), then in the tailnet policy file:

```json
{
  "tagOwners": { "tag:satellite": ["autogroup:admin"], "tag:bija": ["autogroup:admin"] },
  "acls": [
    { "action": "accept", "src": ["tag:satellite"], "dst": ["tag:bija:8791"] }
  ]
}
```

Your own PCs keep their usual access through your other rules. Replace 8791 if you set `ROOM_HUB_PORT`.

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
- `satellite/link-core.ts` is the client (`RoomLinkCore`): it reconnects with a 1 s to 30 s backoff, pings every 2 s and treats 6 s of silence as a lost link. Refusals (bad token, removed, replaced, protocol) stop the retries. It takes its socket from a factory: `room-link.ts` gives it the `ws` package, the web satellite gives it the browser's WebSocket. The one list of calls and events the page can use is `bridge/create-bridge.ts`; the preload builds it on `ipcRenderer`, the web satellite on the link.
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

## Web and phone rooms

A room can also be a web page. bija serves the app at `http://<bija>:8791/app/`, the page pairs and talks to bija over the same `/v1/link` WebSocket as the desktop satellite, and it draws one room with its own mic, camera and speakers. The Android app ("AI Embodied Room", `android-room/`) wraps the same page: see "Phone room" below.

### Open it

1. Build the app once: `pnpm --filter @aiembodied/renderer build`. `pnpm dev:run` and `pnpm satellite` already do. The hub serves the same `app/renderer/dist` the window loads (found the way `main.ts` finds it). If it is missing, `/app/` answers 503 and says so.
2. On bija, open Settings > Places > "Add a desktop room" and note the 6-digit code. The hub listens while a code is active.
3. On bija itself, open Chrome at `http://127.0.0.1:8791/app/`. Localhost counts as a secure context, so the mic and camera work.
4. The page shows "Connect to bija" with its own address filled in. Type the code and a name for the room and press Connect. The device is listed on the Places page as a "Browser".

On another machine on the tailnet, `http://bija:8791/app/` works for the display and for typed turns. A browser only allows the mic and camera on a secure origin (https or localhost), so for voice there put https in front of the hub with `tailscale serve` on bija:

```
tailscale serve --bg --https=443 http://127.0.0.1:8791
```

then open `https://<bija name>.<tailnet>.ts.net/app/`. `tailscale serve` forwards to the hub from loopback and keeps the tailnet name in the Host header, so the Origin rule below accepts the page because the page and the hub share that host. Behind `tailscale serve` every request looks like loopback to the hub, so the hub's own Tailscale login check does not run for them: who can reach the https address is then decided by your tailnet ACL, and the device token is still required for every piece of data. Names that are not `*.ts.net`, an IP or a single word are refused as a Host (a defence against DNS rebinding); list others in `ROOM_HUB_ALLOWED_HOSTS` (comma separated) if you need one.

### What the hub serves

- `GET /app/...`: the renderer build. Read-only, no directory listing, `index.html` for `/app/`, content types for `.wasm`, `.tflite`, `.vrm`, `.glb` and the rest. Paths are checked twice (the request path, then the real path, so a symlink cannot lead out of the folder). It needs no token: it is only the app shell. Over the network the peer must still be a node of bija's own Tailscale login. The copy of `index.html` it sends adds the hub's own address to the CSP `connect-src` for the WebSocket, and nothing else.
- `GET /v1/asset?url=<aiembodied-asset URL>`: room files for a page that loads them by URL (three.js, images). It needs the device token (`Authorization: Bearer`) or the key from the link's `welcome` (`?k=`, valid only while that link is open and only from the address it connected from). The path rules are the asset protocol's.
- The WebSocket upgrade checks `Origin`: none (the desktop satellite), the hub itself (`http(s)://127.0.0.1:<port>` or its own host), or `https://appassets.androidplatform.net`. Any other page is refused, so a web page in bija's own browser cannot drive the link. The device token is still needed after that.
- The existing bind rules are unchanged: 127.0.0.1 and Tailscale addresses only, and the Tailscale peer check for everything that is not loopback.

### What the page does differently

- It boots the web satellite when there is no Electron preload bridge (`renderer/src/web-satellite/`). `window.aiembodied` is built by the same `createBridge` as the preload, so every call and event exists on both. The channels are sorted by the same `satellite/channels.ts`; the link, the pairing request, the config and the gate logic are shared code, not copies.
- The token is kept in the page's `localStorage` (so is the closed switch and the speaker choice; the camera choice was already there). Anyone who can run script on that page's origin can read it, so only open the hub's page on devices you trust. "Forget this pairing" clears it. Revoke the room on bija to cancel a token for good.
- The gate uses the same pure rules (`evaluateGate`). The facts: occupied (from bija's snapshot), unlocked = the page is visible (`document.visibilityState`), link up, open (the "Close this room" button in the Status panel, kept in `localStorage`), no full-screen app (always true, a page cannot tell), not held off by bija, and the room's camera setting. When any fact fails, the page stops every capture track at once and confirms it; if it does not, the page reloads itself. Unknown counts as off.
- A plain browser enforces this in the page only, so it is as strong as the page. The Android app adds native enforcement (see "Phone room").
- No wake word and no doorbell on the web: a browser has no wake word worker. Wake word is unavailable there; talk with the talk button or by typing.
- No "Start when I sign in", no global shortcut, no native tray.

### For the Android shell

The shell sets `window.__AIEMBODIED_SHELL__` before the page loads; the page reads it once at boot (`web-satellite/shell-hook.ts`):

- `hubUrl`, `deviceId`, `token`, `deviceName`: the pairing the shell already holds. With a token and device id the page never shows the connect screen, and never writes that token to storage. `kind: 'phone'` makes a pair request say phone.
- `foreground` (a boolean or a function) and `onForeground(listener)`: the shell's own foreground fact. It is combined with the page's visibility.
- `onGate(state)`: called after every change of the gate, so the shell can stop its own capture natively.

The shell serves the page from `https://appassets.androidplatform.net` and proxies HTTP (`/app/`, `/v1/pair`, `/v1/asset`) to bija, so those are same-origin for the page. The WebSocket goes straight to `ws://<hub>/v1/link`.

### Phone room (the Android app)

`android-room/` is a small Kotlin WebView app (no AndroidX) around the page above. Its README has the build, install and pairing steps. In short:

- Pairing is native: a setup screen (hub host `bija`, port 8791, the 6-digit code, room name "the phone", device name) posts `/v1/pair` with `kind: "phone"`. The token is encrypted with an Android Keystore AES key; the ciphertext sits in SharedPreferences. "Forget pairing" is in the app menu.
- The page is served from `https://appassets.androidplatform.net/app/`. The shell answers every request on that origin by fetching `http://<hub>:8791/...` (only `GET /app/...` and `GET /v1/asset`, which gets the device token). The WebSocket goes direct to `ws://<hub>:8791/v1/link`, allowed by a network security config for `bija`, `*.ts.net` and `localhost`, and by mixed content being allowed in the WebView.
- The shell script it adds to `index.html` sets `window.__AIEMBODIED_SHELL__` (see above) before boot. It needed no change on the page side. Closing the room natively is reported to the page as "not in the foreground".
- The native gate: foreground = resumed + screen interactive + keyguard not locked, told to the page on every change. "Close this room" (always-visible button and menu) is kept across restarts. The mic and camera are granted only while the page's last gate report allows that device, the app is in front and the room is open; otherwise denied. On leaving the foreground or closing, the page must report the devices off within 1 second or the WebView is reloaded. No foreground service and no background listening.
- No wake word, no doorbell, camera presence off unless the room's setting says on, avatars do not wander into the phone unprompted, and avatars walk home 2 minutes after the app closes (the hub side comes in the next update).

### Device kind

A pair request may say `kind: 'desktop' | 'phone' | 'browser'` (default `desktop`; anything else counts as desktop). It is stored with the device in `room-devices.json` and shown on the Places page. Nothing else depends on it yet.

### Not on the web yet

Model bytes and room files are fetched again on every load (no disk cache like the desktop satellite's), the page cannot run the wake word, and an http page on another machine cannot use the mic or camera.

## Not yet

Requiring the wake word for a turn on the satellite, and showing the wake word's score in its Status panel.
