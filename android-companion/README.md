# Phone companion (Android)

Makes a phone the avatar when you're away from the desk. The phone shows the desktop's active
avatar on its active background, listens when you tap it, and plays the reply with lip sync,
animations and live motion. It has no editing or settings of its own beyond the connection.
The desktop app stays the brain: speech-to-text, the language model, tools, memory,
text-to-speech and motion all run there, in the same conversation as the desktop window.

```
 phone (this app)                             desktop (app/main/src/companion)
 ┌──────────────────────────┐   HTTP on LAN   ┌──────────────────────────────────────┐
 │ WebView: phone page      │ ─────────────── │ GET /            phone page (renderer│
 │  (three.js VRM renderer, │                 │                  companion.html)     │
 │   same code as desktop)  │                 │ GET /api/scene   avatar, background, │
 │ Kotlin: mic, screen on,  │  POST /api/turn │                  animations, poses   │
 │   connection settings    │ ──── WAV ─────▶ │ STT → LLM → TTS (LocalVoiceService)  │
 │                          │ ◀─ NDJSON ───── │ transcript, sentences (WAV), done    │
 │                          │ GET /api/events │ push stream: scene changes and       │
 │                          │ ◀────────────── │ messages the desktop sends           │
 └──────────────────────────┘                 └──────────────────────────────────────┘
```

## Why this stack

A thin Kotlin app around a WebView, loading a page the desktop serves:

- **The avatar renderer is reused, not rewritten.** The desktop renders VRM avatars with
  three.js and three-vrm, plus a lot of tuning: idle motion, IK, VRMA clips, poses, live
  motion chunks, lip sync and ground alignment with the background. Android has no
  maintained native VRM renderer, so a Kotlin port (Filament or SceneView) would be months of
  work and would drift from the desktop. The phone page imports the same
  `VrmAvatarRenderer`, so it always matches the desktop.
- **The page comes from the desktop**, so updating the desktop app updates the phone. The APK
  only changes when the Kotlin shell does.
- **Kotlin does what a page served over plain HTTP can't.** Browsers only allow the
  microphone on secure origins (https or localhost), and a LAN address is neither, so the app
  records the mic natively (16 kHz, `VOICE_RECOGNITION` source) and hands the audio to the
  page. It also keeps the screen on, goes full screen, and holds the connection settings.
- No AndroidX or other dependencies: the APK is small and builds with only the Android Gradle
  plugin and Kotlin.

Capacitor was the other option. It would bundle the page in the APK (a secure context, so
`getUserMedia` works), but then every renderer change needs a new APK, and the build drags in
Node tooling for the Android side. Not worth it for one sideloaded phone.

## Set up

1. **Desktop:** Settings (the controls drawer) → *Voice & engine* → **Phone companion**. Tick
   *Let a phone be the avatar*, save, and note the address (e.g. `192.168.1.20:8790`) and the
   pairing code shown there. Windows may ask to let the app through the firewall the first time:
   allow it on **private** networks only.
2. **APK:** download `aiembodied-companion-debug-apk` from the latest *Android companion*
   workflow run on GitHub Actions (or build it, below), copy it to the phone, and install it
   (allow installs from that source when Android asks).
3. **Phone:** open *Avatar*, enter the desktop address, the pairing code and a name for the
   phone, and tap *Connect*. Allow the microphone the first time you tap to talk.

Tap anywhere to talk. It sends when you pause (or tap again to send straight away). After a
reply it listens for a few more seconds, so you can carry on without tapping. Tapping while it
is thinking or speaking interrupts it and listens. The small gear opens the connection
settings.

The phone shows up on the desktop under Phone companion, with a green dot while it is
connected. *New code* changes the pairing code and disconnects every phone; *Forget* removes
one from the list.

## Away from home

The companion server is plain HTTP protected by the pairing code. That is fine on a home
network, but **do not port-forward it to the internet.** For use away from home, put the phone
and the desktop on the same private network:

- **Tailscale (recommended).** Install Tailscale on bija and on the phone, signed in to the
  same tailnet. Use bija's Tailscale address in the app (the desktop lists its `100.x.y.z`
  address alongside the LAN ones), or its MagicDNS name, e.g. `bija:8790`. Traffic is
  encrypted by WireGuard end to end, nothing is exposed publicly, and it works on mobile
  data. Optionally `tailscale serve --bg 8790` gives an `https://bija.<tailnet>.ts.net` URL,
  which the app also accepts.
- **WireGuard** to the home router, or any other VPN, works the same way: use the LAN address.
- **Cloudflare Tunnel or Tailscale Funnel** would make it public. Don't, unless you put real
  authentication in front of it: the pairing code alone is not meant for the open internet.

The app allows cleartext HTTP (see `res/xml/network_security_config.xml`) because LAN and
Tailscale addresses don't have certificates. Every API call still needs the pairing code.

## Sending messages to the phone

The desktop can speak on the phone unprompted, and the phone listens for a reply afterwards:

- **From the desktop app:** Settings → Phone companion → *Say something on the phone*.
- **From another program** (Home Assistant, a script, majordomo):

  ```sh
  curl -X POST http://192.168.1.20:8790/api/say \
    -H "Authorization: Bearer ABCD-EFGH-JKMN" \
    -H "X-Companion-Device: my-script" \
    -d '{"text": "The washing is done."}'
  ```

  Add `"deviceId": "android-…"` to target one phone; without it every connected phone speaks.
  The reply is `{"delivered": [device ids]}`, empty when no phone is connected. The message
  joins the conversation history, so the assistant knows what it said.

## Build it yourself

Needs JDK 17 and the Android SDK (Android Studio installs both).

```sh
cd android-companion
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or open `android-companion/` in Android Studio and run it. Logs from the page appear in
`adb logcat -s CompanionPage`.

To try the phone page without a phone, open `http://localhost:8790/` in a browser on the
desktop (localhost counts as secure, so the browser's own microphone works) and enter the
pairing code.

## Protocol

See `app/main/src/companion/types.ts`. In short, every `/api/*` request carries
`Authorization: Bearer <pairing code>` and `X-Companion-Device: <id>`
(`X-Companion-Name` is optional, URL-encoded).

| Request | What it does |
| --- | --- |
| `GET /`, `/assets/*` | The phone page (renderer `companion.html`), no code needed |
| `GET /api/hello` | Checks the code; the app's *Connect* button |
| `GET /api/scene` | Active avatar, background (with ground line), animations, poses, whether live motion is up |
| `GET /api/avatar/:id`, `/api/background/:id`, `/api/animations/:id`, `/api/poses/:id` | The files |
| `GET /api/events` | NDJSON push stream: `scene`, `say` + `sentence`… + `done`, `ping` every 15 s |
| `POST /api/turn` (WAV body) | NDJSON: `transcript`, `sentence` (base64 WAV, text with avatar tags), `tool`, `error`, `done` |
| `POST /api/motion` | Live motion for a `{move:…}` tag: NDJSON `motion` chunks (base64 VRMA) |
| `POST /api/cancel` | Stop the reply in progress |
| `POST /api/say` | Speak a message on the phone(s) |

Ten wrong codes from one address in a minute lock that address out for a minute.

## Limits and next steps

- **Tap to talk only.** There is no wake word on the phone yet. openWakeWord runs on
  onnxruntime, which has an Android build, so "Hey Echo" on the phone is a reasonable next step.
- **Foreground only.** The mic stops when the app is in the background, and the screen stays
  on while it is open. It is meant to sit on a stand as the avatar.
- **One conversation.** The phone and the desktop share one conversation and one memory.
  Talking to both at once interrupts whichever started first.
- **The desktop must be on**, with the local services running (`pnpm dev:run`). The app shows
  "Waiting for the desktop" and retries until it answers.
