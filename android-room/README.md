# AI Embodied Room (Android)

A phone as a room in bija's world. The app is a thin shell around a WebView. The page it shows is the web satellite that bija's room hub serves at `/app/`, so the avatar, the room and the conversation are the same code as on the desktop. The shell adds what a page cannot be trusted with: the secure origin, the pairing token, and the privacy gate for the mic and camera.

The folder is `android-room/` (the old draft was `android-companion/`, which used a different hub and is gone). App name "AI Embodied Room", package `com.silarsis.aiembodied.room`.

Not compiled in the cloud container that wrote it (it cannot reach Google Maven). The pure logic was compiled and its JUnit tests run on a plain JVM there. The Android parts are built and tested by the "Android room" GitHub workflow. Treat the first APK as untested on a real phone.

## Build and install

- GitHub: run the "Android room" workflow (it also runs on changes under `android-room/`). It runs `./gradlew test assembleDebug` and uploads `aiembodied-room-debug-apk`.
- Locally: install JDK 17 and the Android SDK (platform 35), then `cd android-room && ./gradlew test assembleDebug`. The APK is `app/build/outputs/apk/debug/app-debug.apk`.
- Copy the APK to the phone and open it. Android will ask you to allow installs from that source.

## Pair

1. Install Tailscale on the phone and sign in to the same account as bija. Turn it on.
2. On bija, build the renderer once (`pnpm --filter @aiembodied/renderer build`; `pnpm dev:run` does it). Open Settings, Places, "Add a desktop room" and note the 6-digit code.
3. Open the app. The setup screen asks for:
   - Hub host: `bija` (the MagicDNS name of bija's PC). No `http://`, no port.
   - Port: `8791`.
   - The code.
   - Room name (default "the phone") and this phone's name (default the phone's model).
4. Press Pair. The app posts to `/v1/pair` with `kind: "phone"`. The device token is encrypted with an Android Keystore key (AES-GCM, key never leaves the Keystore). Only the ciphertext is stored.
5. The page loads and shows the room. The phone is listed on bija's Places page as a "Phone".

Menu, top right: close or open this room, keep the screen on, full screen, reload, pair again, forget pairing. "Forget pairing" removes the token from the phone. The room stays listed on bija until you revoke it on the Places page.

If the hub's name is not `bija`, `*.ts.net`, `localhost` or the emulator's `10.0.2.2`, add it to `app/src/main/res/xml/network_security_config.xml` and rebuild (see below). A bare Tailscale address such as `100.64.0.7` is not allowed, because Android cannot express the `100.64.0.0/10` range.

## How the page reaches bija

A browser only allows the mic and camera on a secure origin, and bija's hub speaks plain http. So:

- The WebView loads `https://appassets.androidplatform.net/app/`. This host is not real: the shell answers it. It is the same origin Android's own `WebViewAssetLoader` uses, and the hub's Origin rule already allows it.
- `shouldInterceptRequest` (hand written, no AndroidX) fetches each request from `http://<hub>:8791/...` with `HttpURLConnection` and streams the body back. It forwards only `GET /app/...` and `GET /v1/asset` (with the device token added as `Authorization: Bearer`). Everything else on that origin, and every other web host, is refused. It does not follow redirects.
- The shell adds one script tag to `index.html` (`/__aiembodied_shell.js`, made in the app, same origin so the page's CSP allows it). The script sets `window.__AIEMBODIED_SHELL__` before the page boots: hub address, device id, token, device name, `kind: 'phone'`, a `foreground()` function, `onForeground(listener)` and `onGate(state)`. They call a narrow Java object (`AiembodiedShell`: `pairing()`, `foreground()`, `reportGate(json)`).
- The room link WebSocket goes straight to `ws://<hub>:8791/v1/link`. Two settings make that possible:
  - `network_security_config.xml` allows cleartext only for `bija`, `ts.net`, `localhost` and `10.0.2.2`. Traffic over Tailscale is encrypted by WireGuard anyway.
  - `WebSettings.MIXED_CONTENT_ALWAYS_ALLOW`, because an https page opening a `ws://` socket is mixed content, and the WebView blocks it by default. This is how the Android documentation describes the setting; it has not been tried on a device yet. If the socket never connects, check `adb logcat` for the page's console messages.

## The privacy gate

Same rule as the desktop: the mic is live only while an avatar is in the room, the screen is unlocked, the link is up, the room is open and nothing else is full screen. The page keeps its own gate with those rules. The shell enforces the parts it can see, and does not trust the page alone.

- Foreground = the activity is resumed, `PowerManager.isInteractive` is true and `KeyguardManager.isKeyguardLocked` is false. The shell tells the page on every change (screen off, screen on, unlock, pause, resume).
- "Close this room" (the always-visible button, or the menu) is kept in preferences, so a closed room stays closed after a restart. The page is told the app left the foreground.
- `onPermissionRequest` grants the mic or camera only when all of these hold: the request comes from `https://appassets.androidplatform.net`, the page's last reported gate allows that device, the app is in the foreground, and the room is not closed. Anything else, and every other resource, is denied. Nothing reported yet counts as no. Android's own `RECORD_AUDIO` and `CAMERA` permissions are asked for the first time they are needed; the decision is made again when Android answers.
- When the app leaves the foreground, or the room is closed, the page is told to stop capture. If the page has not reported both devices off within 1 second, the shell reloads the WebView, which drops any media. The WebView is paused when the app is in the background.
- No foreground service, no boot receiver, no wake lock, no background listening. If you leave the app, the room is deaf and blind.
- The page cannot see other apps, so the "no full screen app" fact is always true in the page.
- The screen stays on only while an avatar is in the room and the app is in front (switch it off in the menu).

Known limits: the page's token is readable by script running on the page (the shell hands it over). Only open the hub's page. The shell treats "the page reported both devices off" as the confirmation; the page's own gate reloads itself if its tracks do not stop.

## Tests

`app/src/test/` has JUnit 4 tests for the pure logic: the gate decision and stop tracker (`GateLogic.kt`), the URL mapping and shell script (`ProxyMapping.kt`) and the pairing request and answer (`PairingLogic.kt`). They have no Android classes in them, so `./gradlew test` runs them on the JVM.
