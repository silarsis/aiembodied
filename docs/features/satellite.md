# Satellite mode

Status: Built (Places step 3).

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
- No microphone, camera, settings, characters, rooms or tools. Quit is hidden too: use F11 for full screen and close the window to leave.
- No OpenAI Realtime.

## How it works

- `satellite/satellite.ts` registers the IPC channels the renderer expects. `satellite/channels.ts` sorts each one: forwarded to bija, answered locally, unavailable, or an event from bija. A test checks that every preload channel is sorted.
- `satellite/room-link.ts` is the client: it reconnects with a 1 s to 30 s backoff, pings every 2 s and treats 6 s of silence as a lost link. Refusals (bad token, removed, replaced, protocol) stop the retries.
- Room files come through an asset protocol with an on-disk cache of up to 500 MB (oldest used leaves first). The cache is keyed by URL, so a room file that changes under the same URL is not refreshed until it leaves the cache. VRM bytes are cached by model id and file hash.
- A few cheap channels (wake word list, approvals, metrics, talk shortcut) are answered locally with empty answers.
- bija keeps one floor per place, so the avatars at a satellite talk there. See [places.md](places.md).

## Not yet

Microphone, wake word, camera and speakers-as-devices on the satellite.
