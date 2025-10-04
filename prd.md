Product Requirements Document (PRD)

Project: Embodied ChatGPT Assistant
Author: Kevin
Version: 0.1 (MVP draft)

1. Overview

We are building a voice-enabled AI assistant with a visual avatar, intended as a “desktop companion” that can later be deployed on dedicated hardware (mini-PC + display).

The assistant should:

Listen for a wake word (hands-free activation).

Support low-latency speech conversation with ChatGPT Realtime API.

Display a cartoon avatar face that syncs visually with speech output.

Run in full-screen kiosk mode with persistent memory (chat history + state).

Be designed so the avatar layer can later be swapped for a 3D Unity character without rewriting the core conversation pipeline.

2. Goals

Deliver a proof of concept on a standard PC (Windows/Linux/Mac).

Support migration to a mini-PC appliance (e.g., Intel N100 box with attached display, mic, speaker).

Achieve <1s round-trip latency for voice interaction.

Provide a pleasant, “alive” avatar experience without heavy GPU requirements for MVP.

3. Non-Goals

Not aiming for photorealism at MVP.

No cloud avatar rendering (all visuals rendered locally).

No requirement for multiple users or account system.

No mobile deployment at this stage.

4. Functional Requirements
4.1 Audio Input

Always-on microphone listening.

Local wake word detection (e.g., Porcupine, Coqui STT, or similar).

On wake, stream audio to ChatGPT Realtime API via WebRTC.

Barge-in handling (user can interrupt AI mid-speech).

4.2 Speech Output

Use ChatGPT Realtime API’s streaming TTS for responses.

Audio should play back with minimal buffering (<200ms delay).

4.3 Avatar Rendering

Phase 1 (MVP): Cartoon 2D avatar (static head + 3–5 mouth shapes + idle/blink animations).

Mouth animation driven by:

Audio amplitude OR

Phoneme/viseme timings if available from TTS stream.

Phase 2 (Future): Replace with Unity or WebGL 3D avatar.

Core pipeline must allow viseme/mouth movement data to be reused.

4.4 User Interface

Full-screen kiosk window with:

Avatar in center.

(Optional) speech transcript overlay toggle.

Persistent memory of conversation (store locally in SQLite/JSON).

Auto-start on boot (when migrated to mini-PC).

4.5 Deployment

Stage 1: Dev PC environment (run with npm start or Docker).

Stage 2: Auto-launch in kiosk mode on Intel N100 mini-PC.

System should be restart-resilient (auto relaunch if it crashes).

5. Technical Requirements
5.1 Core Stack

Language: TypeScript or Python (choose one for main pipeline).

Backend: ChatGPT Realtime API (WebRTC).

Frontend rendering:

Browser canvas / Electron for Phase 1.

Unity or WebGL for Phase 2.

5.2 Wake Word

Library options: Porcupine (preferred), open-source alternatives acceptable.

Must run locally without cloud calls.

5.3 Memory

Store conversations locally (SQLite or simple JSON file).

Reload memory at startup.

Expose memory to LLM via context injection.

5.4 Performance Targets

Round-trip latency (user speech → AI response): ≤ 1 second average.

Avatar frame rate: 30 FPS target.

Startup time: ≤ 10 seconds to ready.

6. Milestones
Milestone 1: Audio Loop MVP

Mic input → ChatGPT Realtime → TTS output (no avatar).

Wake word activation.

Milestone 2: Avatar MVP

Add cartoon avatar with 3–5 mouth sprites + blinking.

Sync mouth with TTS audio.

Run in fullscreen kiosk window.

Milestone 3: Persistence

Add local memory store (SQLite/JSON).

Reload chat history at startup.

Milestone 4: Appliance Migration

Package app for auto-boot on mini-PC.

Test on Intel N100 box + external screen, mic, speaker.

Milestone 5 (Future Upgrade): 3D Avatar

Replace sprite avatar with Unity/WebGL character.

Keep same viseme sync interface.

7. Acceptance Criteria

System responds to wake word reliably.

Latency ≤ 1s average for conversational loop.

Avatar lips move in sync with AI voice output.

Conversation history persists across restarts.

App runs in fullscreen kiosk mode without manual interaction.
