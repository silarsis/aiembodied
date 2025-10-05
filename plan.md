# Implementation Plan for Embodied ChatGPT Assistant MVP

The following phased plan covers the MVP described in the PRD and architecture specification. Each step lists the primary implementation work and the validation checks that should pass before progressing.

## 0. Repo Scaffolding & Tooling
- Initialize monorepo structure with Electron + Vite TypeScript template following the architecture layout (`app/main`, `app/renderer`, etc.).
- Configure pnpm workspaces, linting (ESLint + Prettier), TypeScript config, and testing harness (Vitest + Playwright for renderer smoke tests).
- Add continuous integration pipeline (GitHub Actions) running lint, type-check, unit tests.
- Tests to pass:
  - `pnpm install` succeeds on clean clone.
  - `pnpm lint`, `pnpm typecheck`, and `pnpm test` green on CI.

## 1. Configuration & Secrets Foundation
- Implement `ConfigManager` in Electron main process with Zod validation for environment variables (Realtime API key, device IDs, feature toggles).
- Integrate `dotenv` for development, scaffold keytar storage for production secrets.
- Expose validated config to renderer via preload script (contextBridge) with secure IPC channels.
- Tests to pass:
  - Unit tests covering config schema validation and preload exposure.
  - Manual verification: launching dev build without required env should show descriptive error dialog.

## 2. Logging & Crash Guard Infrastructure
- Set up Winston logger with file rotation and console transports; integrate debug namespace for verbose logging.
- Implement `CrashGuard` to relaunch renderer on crash/hang and log incidents.
- Ensure single-instance lock and graceful shutdown behavior.
- Tests to pass:
  - Unit tests for logger initialization and crash guard re-launch logic (mocked).
  - Manual smoke: force renderer crash in dev mode and confirm auto relaunch + log entry.

## 3. Wake Word Service (Porcupine Worker)
- Integrate Porcupine Node bindings in a dedicated worker process.
- Wire IPC from worker to main/renderer using typed `WakeEvent` contract; include configuration for model path and sensitivity.
- Implement cooldown and confidence threshold logic.
- Tests to pass:
  - Unit tests for cooldown/conference filtering logic (mocked audio events).
  - Manual acceptance: speak wake word and confirm event emission & UI indicator; background noise should not trigger.

## 4. Audio Graph & Device Management
- Build renderer-side Web Audio capture pipeline with echo cancellation, VAD meter, and routing to (a) WebRTC upstream and (b) VisemeDriver stub.
- Implement device selector UI and persistence of preferred devices using ConfigManager/SQLite KV.
- Provide VAD-triggered activation gating for microphone streaming.
- Tests to pass:
  - Integration test using Playwright to ensure device list loads and selection persists across reloads.
  - Manual latency spot-check: confirm capture start <80ms after wake event (log timestamps).

## 5. Realtime Client (WebRTC Loop)
- Implement SDP negotiation with OpenAI Realtime API, handling ICE candidates, renegotiation, and reconnection.
- Stream microphone audio and play back remote TTS audio with adjustable jitter buffer (50–150ms).
- Handle barge-in by signaling stop events on user speech detection.
- Tests to pass:
  - Automated integration test hitting mocked Realtime API (use test harness) validating state machine transitions.
  - Manual end-to-end call with real API: speak after wake, receive response with <1s round trip.

## 6. Viseme Driver MVP
- Implement RMS-based viseme detection from decoded PCM in AudioWorklet.
- Map intensity buckets to 5 viseme indices with smoothing and blink heuristics.
- Emit `VisemeFrame` events at 60Hz for avatar consumption.
- Tests to pass:
  - Unit tests covering RMS computation, smoothing, and viseme mapping.
  - Manual visual check: verify viseme transitions correspond to sample audio tracks.

## 7. Avatar Renderer (2D Canvas)
- Create sprite atlas assets for neutral head, mouth shapes, eyes, and idle animations.
- Build Canvas/WebGL renderer applying viseme frames, idle loops, and subtle secondary motions.
- Add fallback placeholder avatar for early testing.
- Tests to pass:
  - Snapshot/visual regression tests using Playwright for avatar states.
  - Manual evaluation: run conversation and confirm lip-sync quality subjectively acceptable.

## 8. Transcript Overlay & UI Shell
- Implement fullscreen kiosk window with hidden cursor after idle, overlay toggles, and status indicators (network, wake state).
- Add transcript overlay tied to memory store toggled via hotkey or config.
- Ensure accessibility fallbacks (keyboard shortcuts) for exiting kiosk mode in dev.
- Tests to pass:
  - Playwright UI tests verifying kiosk window layout, status indicators, and transcript toggle behavior.
  - Manual QA: confirm kiosk mode and auto-hide cursor on idle.

## 9. Memory Store (SQLite)
- Set up better-sqlite3 database with migrations for `sessions`, `messages`, and `kv` tables.
- Implement CRUD operations, import/export, and conversation replay into renderer on startup.
- Integrate with Realtime pipeline to append conversation turns and audio paths.
- Tests to pass:
  - Unit tests for database operations and migration runner.
  - Integration test simulating conversation storing & restoring history.

## 10. Persistence in Conversation Loop
- Wire Realtime client, MemoryStore, and UI so each session is created post-wake, messages appended, and history displayed in overlay.
- Implement retention policies and memory compaction (e.g., limit audio storage, prune oldest sessions).
- Tests to pass:
  - End-to-end automated test using mocked Realtime verifying message persistence across app restarts.
  - Manual test: run conversation, restart app, confirm history loads.

## 11. Observability & Metrics
- Add optional Prometheus exporter for latency metrics (wake-to-capture, capture-to-first-token, etc.).
- Expose developer HUD overlay to display latency numbers during testing.
- Tests to pass:
  - Unit tests for metrics collectors.
  - Manual soak test logging metrics during 30-minute session, ensuring resource usage stable (<100MB growth).

## 12. Packaging & Auto-Launch
- Configure electron-builder for Windows, macOS, and Linux targets with kiosk flags.
- Implement auto-launch on login and system tray controls for dev builds.
- Document installation steps for Intel N100 mini-PC, including systemd/service configuration.
- Tests to pass:
  - `pnpm build` and `pnpm dist` succeed on CI for target platforms.
  - Manual installation test on reference device verifying auto-start and kiosk behavior.

## 13. Appliance Readiness Validation
- Conduct end-to-end appliance rehearsal: boot mini-PC, confirm auto-launch, wake word reliability, and <1s latency.
- Execute 2-hour soak test ensuring stability, memory footprint, and reconnection handling.
- Gather stakeholder sign-off on MVP acceptance criteria.
- Tests to pass:
  - Soak test logs showing no crashes and latency within targets.
  - Checklist review covering PRD acceptance criteria and architecture DoD items.

## 14. Home Assistant Integration
- Implement Home Assistant client module using WebSocket API for event subscriptions and REST API for control commands.
- Define configuration schema for Home Assistant endpoint, authentication tokens, and allowed device/entity whitelist.
- Wire event notifications into conversation context so AI agents can react to state changes (e.g., door sensors, lights).
- Expose intent routing from AI responses to control approved devices with safeguards and audit logging.
- Tests to pass:
  - Unit tests covering event subscription handling, reconnection, and command dispatch restrictions.
  - Integration test using mocked Home Assistant server verifying bidirectional communication.
  - Manual QA: validate AI receives sample event notifications and can toggle a permitted device.

## 15. Avatar Configuration Tool
- Build a configuration tool allowing upload of a single cartoon face image and auto-generate required avatar sprite components (eyes, mouth shapes, idle frames).
- Integrate asset slicing and viseme mapping so generated components align with Viseme Driver expectations.
- Update renderer pipeline to consume generated assets dynamically via configuration output.
- Tests to pass:
  - Unit tests covering asset slicing logic and configuration schema validation.
  - Integration test ensuring uploaded face produces functional animation in avatar renderer with sample viseme stream.
  - Manual QA: import sample cartoon face and verify end-to-end animation with wake word conversation.

## 16. Future Unity Integration Prep (Stretch)
- Define IPC contract (WebSocket or gRPC) for viseme stream transmission to Unity process.
- Provide reference Unity stub consuming `VisemeFrame` to render simple 3D mouth movement.
- Tests to pass:
  - Contract tests ensuring Unity stub receives consistent data stream.
  - Manual demo showing swap from Canvas to Unity without altering voice pipeline.

