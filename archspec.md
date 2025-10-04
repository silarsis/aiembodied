# Embodied ChatGPT Assistant — Architecture Spec (v0.1)

Author: Kevin  
Target: Coding agent & engineers  
Scope: MVP on dev PC → migrate to mini‑PC appliance

---

## 1) System Overview
A desktop “companion” app that runs full‑screen (kiosk). It listens for a wake word, talks to OpenAI’s **Realtime API** over WebRTC for ultra‑low‑latency two‑way audio, renders a **2D cartoon avatar** (Phase 1) with mouth movement synced to speech, and stores conversation state locally (persistent memory). Later we can swap the avatar layer for a **Unity** character without touching the voice loop.

**Key qualities:** sub‑second voice round‑trip, reliable wake word/barge‑in, crash‑resilient kiosk, offline‑ish except for model calls.

---

## 2) Preferred Tech & Libraries

### Runtime & Packaging
- **Electron** (Node 20+ / Chromium) for kiosk app
- **TypeScript** + **Vite** for front-end bundling
- **electron-builder** for packaging; auto‑launch at login

### Voice & Transport
- **OpenAI Realtime API** over **WebRTC** (browser peer inside Electron)
- **Web Audio API** for capture/playback in renderer process
- **AEC/NS/AGC** via Chromium’s built‑in audio constraints
- **Barge‑in**: full‑duplex WebRTC + app‑level interrupt semantics

### Wake Word (Local)
- **Picovoice Porcupine** (Node/Electron binding) — preferred
- Alternative: **openWakeWord** (Python) via IPC bridge (fallback)

### Avatar & Sync
- **Phase 1:** HTML5 Canvas/WebGL 2D avatar; sprite‑based visemes + blink/idle
- Viseme driver: **audio envelope + phoneme estimates** (see §7)
- **Phase 2:** Unity (URP) as a separate process with IPC (gRPC/Protobuf or WebSocket) consuming the same viseme stream

### Persistence & Config
- **SQLite** via **better-sqlite3** (synchronous, stable) for chats/state
- **Zod** for runtime config validation
- **dotenv** for local secrets; prod via OS keychain (keytar)

### Observability
- **Winston** logs (file rolling); **debug** for dev
- Optional metrics: lightweight **Prometheus** exporter (localhost)

---

## 3) High‑Level Architecture

```
+------------------------+        WebRTC        +---------------------------+
| Electron Renderer (UI) |<-------------------->|  OpenAI Realtime (Cloud)  |
|  - Canvas/WebGL Avatar |  audio in/out, data  +---------------------------+
|  - Web Audio capture   |
|  - Realtime Client     |        IPC (Electron)
+-----------^------------+--------------------+----------------------------+
            |                                     
            | IPC (contextBridge / MessagePort)   
            v                                     
+------------------------+      Native Addons      +------------------------+
| Electron Main Process  |<---------------------->| Wake Word (Porcupine)  |
|  - Window, Kiosk, Logs |                        +------------------------+
|  - App Lifecycle       |
|  - SQLite (better-sql) |<----> State/Memory
+------------------------+
```

**Swap path to Unity:** replace Canvas avatar with a Unity app that subscribes to a **VisemeStream** over IPC/WebSocket; everything else unchanged.

---

## 4) Processes & Threads
- **Main process (Electron):** window creation, single‑instance lock, crash recovery, SQLite, config/secrets, spawning wake‑word worker.
- **Renderer process:** UI, WebRTC peer, audio capture/playback, avatar render, viseme generation, hotkeys.
- **Wake‑word worker:** native Porcupine loop on mic tap (or shared RT audio), sends `wake` events to main/renderer.
- **(Optional) Viseme worker:** if CPU heavy, move phoneme estimation here.

---

## 5) Key Modules & Responsibilities

1. **AppLifecycle** (main)
   - Single instance, auto‑update (optional), auto‑start on login
   - Kiosk mode (frameless, always‑on‑top, cursor hidden after idle)

2. **ConfigManager** (main)
   - Load `.env`, validate with Zod, provide to renderer via secure preload
   - Secret storage via keytar (API keys)

3. **MemoryStore** (main)
   - SQLite schema: `sessions`, `messages`, `kv`
   - CRUD + compaction; export/import JSON for backup

4. **WakeWordService** (worker)
   - Porcupine model load, continuous listen
   - Emits `wake` with timestamp + confidence; low false‑positive tuning

5. **RealtimeClient** (renderer)
   - WebRTC SDP negotiation with OpenAI Realtime endpoint
   - Tracks call state (idle/listening/speaking/interrupt)
   - Sends mic `MediaStream` up; receives TTS audio down
   - Optional data channel for tokens/metadata (if provided)

6. **AudioGraph** (renderer)
   - `getUserMedia` with echoCancel/noiseSuppression/autoGain
   - VAD level meter; split to: (a) Realtime upstream, (b) VisemeDriver
   - Output sink selection + latency buffer (configurable ~50–150ms)

7. **VisemeDriver** (renderer or worker)
   - **MVP:** compute RMS envelope + zero‑crossing→ clamp to 5 viseme indices
   - **If available:** consume phoneme timing metadata from TTS; map to visemes
   - Emits `VisemeFrame {time, index, intensity, blink}` @ 60 Hz

8. **AvatarRenderer** (renderer)
   - Sprite atlas of mouth shapes (AA, EE, IY, OH, FV) + idle layers
   - Idle loop: subtle head-nod, eye saccades, blink RNG
   - Applies `VisemeFrame` to mouth layer with easing

9. **TranscriptOverlay** (renderer)
   - Optional text overlay; persists to MemoryStore

10. **CrashGuard** (main)
    - Relaunch on crash; watch‑dog for renderer unresponsive

---

## 6) Data Contracts (IPC / Internal)

### 6.1 Wake events
```ts
// from WakeWordService → main/renderer
interface WakeEvent {
  ts: number;           // epoch ms
  conf: number;         // 0..1
  source: 'porcupine';
}
```

### 6.2 Realtime state
```ts
// renderer internal
type CallState = 'idle' | 'listening' | 'speaking' | 'interrupted' | 'error';
```

### 6.3 Viseme stream
```ts
// renderer → AvatarRenderer (or IPC to Unity)
interface VisemeFrame {
  t: number;            // audio timeline ms
  index: number;        // 0..N-1 (5 for MVP)
  intensity: number;    // 0..1 mouth openness
  blink?: boolean;
}
```

### 6.4 Message persistence
```ts
// MemoryStore schema (SQLite)
Table sessions(id TEXT PK, started_at INT, title TEXT);
Table messages(id TEXT PK, session_id TEXT, role TEXT, ts INT, content TEXT, audio_path TEXT NULL);
Table kv(key TEXT PK, value TEXT);
```

---

## 7) Lip‑Sync Strategy (Phase 1)
- **No phoneme metadata required for MVP**. Use audio envelope from the TTS buffer:
  1) Tap the decoded PCM (AudioWorklet) → compute short‑window RMS (10–15 ms)
  2) Map RMS to discrete viseme indices (e.g., silence→closed; low→FV; mid→EE/IY; high→AA/OH)
  3) Apply smoothing (attack 30 ms, release 60 ms) to avoid chatter
  4) Blendshape weight = intensity; clamp rapid toggles
- If TTS/Realtime exposes phoneme timings later, replace with explicit **phoneme→viseme** mapping (ARPABET→Disney 10‑viseme set) and keep the same `VisemeFrame` interface.

---

## 8) Latency Budget (Targets)
- Wake detection → capture start: **< 80 ms**
- Mic to Realtime ingress (network): **< 120 ms** typical
- Model first‑token to TTS start: **< 300 ms**
- Audio playout buffer: **50–150 ms** (config)
- Viseme compute/render: **< 8 ms** per frame
- **End‑to‑end conversational RT:** **≤ 1,000 ms** avg (stretch ≤ 1,500 ms)

---

## 9) Error Handling & Recovery
- Network loss: show subtle status LED; auto‑reconnect exponential backoff
- Realtime session drop: renegotiate SDP automatically
- Wake false positives: cool‑down window (e.g., 2 s) and confidence threshold
- Audio device change: hot‑reload device list; remember preferred IDs
- CrashGuard relaunch on uncaught exceptions

---

## 10) Security & Privacy
- API keys stored via **keytar**; never hard‑code
- Minimize data at rest: only store transcripts if enabled (default: on)
- Provide a one‑click “Wipe history” action (deletes DB)
- Microphone is only streamed post‑wake (VAD gate) unless user opts always‑on

---

## 11) Build, Run, Deploy

### Dev (PC)
- `pnpm i && pnpm dev` → launches Electron with hot‑reload
- `.env` for API key; `keytar` for persisted secrets

### Package
- `pnpm build && pnpm dist` → platform installer
- Kiosk flags: `--kiosk --fullscreen --disable-pinch --overscroll-history-navigation=0`

### Appliance (mini‑PC)
- Install as login item; auto‑start on boot
- Optional: systemd unit on Linux (Restart=always)
- Disable screen sleep; hide cursor after 5s idle

---

## 12) Directory Layout
```
/ app
  /main          # Electron main process
  /preload       # contextBridge APIs
  /renderer      # React UI, AvatarRenderer, RealtimeClient
  /workers       # wake word, visemes
  /assets        # sprite atlases, sounds
  /store         # SQLite migrations
  /types         # shared interfaces
```

---

## 13) Milestones & Deliverables (mirror PRD)
1. **M1 Audio Loop:** WebRTC to Realtime; mic→TTS audio; wake word; barge‑in.
2. **M2 Avatar:** Canvas avatar with 5 visemes + blink; envelope‑driven lip‑sync.
3. **M3 Persistence:** SQLite conversation history; reload on boot.
4. **M4 Appliance:** Kiosk packaging; auto‑start; device selection UI; resiliency.
5. **M5 (Future):** Unity avatar process consuming `VisemeFrame` over IPC.

**Definition of Done per milestone** is identical to PRD acceptance criteria.

---

## 14) Test Plan (MVP)
- **Unit:** viseme mapper, config loader, SQLite ops
- **Integration:** wake→listen→speak loop; network drop/recover
- **Latency measurement:** log timestamps at capture, first‑audio, playout
- **Soak test:** 2‑hour continuous conversation; memory growth < 100 MB

---

## 15) Future Extensions
- Local fallback STT/TTS (edge mode)
- Emotions → facial blendshapes
- Gaze tracking (camera) → avatar eye contact
- Multi‑voice switching; per‑persona memories
- OTA updates

