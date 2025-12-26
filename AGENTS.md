# Agent Operating Guide

## Project Context
This repository implements the **Embodied ChatGPT Assistant MVP**, as outlined in the high-level documents:
- Product requirements: see [`prd.md`](./prd.md).
- Architecture specification: see [`archspec.md`](./archspec.md).
- Phased implementation roadmap: see [`plan.md`](./plan.md).

Always cross-check planned work against these references before making changes. When adding or modifying features, verify that the resulting behavior satisfies the PRD goals (wake-word driven, low-latency, kiosk-ready assistant) while conforming to the architecture boundaries and module responsibilities in the spec.

## Development Workflow
1. Read the relevant section in `plan.md` for the feature you are implementing.
2. Confirm functional expectations against `prd.md` and architectural constraints in `archspec.md`.
3. Implement and update tests in the scoped package (prefer colocated unit/integration tests).
4. Run the full verification commands listed below before committing.
5. Update this guide whenever architectural decisions or workflow expectations change.

## Development Startup
To run the application in development mode:
- `pnpm dev:run` — build packages, rebuild native dependencies, and launch Electron app (uses `scripts/run-dev.mjs`)

The development script (`scripts/run-dev.mjs`) is cross-platform and handles:
- Building renderer and main packages
- Rebuilding native dependencies (better-sqlite3, keytar) for Electron
- Environment isolation using `.dev-home` to avoid Windows permission issues
- API key validation (requires `PORCUPINE_ACCESS_KEY`, warns if `REALTIME_API_KEY` missing)
- Launching Electron with diagnostics enabled

Alternative platform-specific scripts exist (`run-dev.ps1`, `run-dev.sh`) but the `.mjs` version is preferred for consistency.

## Testing & Verification
Run these commands from the repository root unless a task specifies otherwise:
- `pnpm install` — ensure dependencies resolve from a clean checkout.
- `pnpm lint` — enforce linting rules across packages.
- `pnpm typecheck` — run TypeScript project-wide type analysis.
- `pnpm test` — execute automated unit/integration tests.
- `pnpm test:coverage` — run tests with coverage measurement and reporting.
- `pnpm build` — (as needed) validate production builds for Electron targets.

### OpenAI Responses API usage
- When crafting requests, ensure every content chunk conforms to the Responses API schema (e.g., text prompts must use `{ type: 'input_text', text: '...' }`).
- Structured outputs must configure `text.format` with `{ type: 'json_schema', name: <identifier>, schema: <definition> }`. Do not send the deprecated `response_format` field or the unsupported `response` wrapper.
- Responses API requests should omit the deprecated `modalities` array; rely on the presence of `text.format` to request structured JSON payloads. Realtime call handshakes now negotiate response media via `session.output_modalities` (e.g., `['audio']` or `['text']`).
- Avatar component schemas must mark `slot`, `mimeType`, and `data` as required in each item definition to satisfy the Responses API validator.

Document any deviations or additional checks in your PR description, especially if a module introduces new tooling.

## Architectural Decisions

Refer to `plan.md`, `archspec.md`, and `prd.md` for the authoritative product and implementation roadmap. The highlights below capture the architectural choices that guide current and future development:

### System composition
- **Electron main process** owns kiosk window lifecycle, crash recovery, configuration, and persistence. It validates environment secrets with Zod, hydrates runtime config via the preload bridge, and manages the synchronous `better-sqlite3` memory store.
- **Renderer process (Vite + React)** delivers the user interface, WebRTC client, Web Audio capture/processing graph, and 2D avatar canvas. Renderer code consumes main-process services through contextBridge APIs exposed in `app/preload` and exchanges realtime state via typed IPC channels.
- **Worker processes** are dedicated to latency-sensitive tasks. A Porcupine wake-word worker streams microphone data, applies cooldown/confidence logic, and notifies the main process. Optional viseme workers can offload PCM analysis if the renderer frame budget is constrained.

### Frontend ↔ backend linkage
- The preload script acts as the contract boundary: configuration, logging, and memory APIs are marshalled from the main process into the renderer with strict channel whitelists to preserve Electron security best practices.
- Wake events, realtime session status, and persistence updates flow through structured IPC events so renderer state machines stay synchronized with main-process orchestration.
- SQLite updates initiated in the renderer (e.g., transcript overlay interactions) are funneled back to the main process, which persists data and mirrors relevant state to the UI.

### Voice and interaction pipeline
- Wake detection gates microphone streaming. Once active, the renderer’s Web Audio graph splits capture into (a) the WebRTC peer connection to OpenAI’s Realtime API and (b) the viseme driver for lip-sync.
- The realtime client handles SDP negotiation, ICE management, jitter buffering, and barge-in semantics. Downstream TTS audio is decoded for playback while simultaneously feeding viseme computation at ~60 Hz.
- Conversation turns and audio metadata are appended to the SQLite memory store so transcript overlays and future sessions can restore context on launch.
- Renderer voice selection must use the baked-in voice list. Tests in `app/renderer/tests/App.test.tsx` assert the dropdown renders the static options and that no network fetch is attempted on mount; update the list and expectations together when adding or removing voices.

### Rendering & avatar
- The initial avatar implementation is a Canvas/WebGL sprite renderer mapping viseme intensity to discrete mouth shapes and idle animations. Future Unity integration will consume the same `VisemeFrame` stream via IPC without altering upstream audio or persistence layers.
- When using the OpenAI Images API from the avatar face service, always convert base64 source portraits to a `File` with `toFile` from `openai/uploads` and pass that `File` to `images.edit`/`images.edits.create` so uploads are handled as media payloads.
- Idle animation helpers live in `app/renderer/src/avatar/animations`. Use `createVrmAnimationClip` and `IdleAnimationScheduler` to register background motions, ensure the scheduler is updated every frame, and add unit tests alongside any new idle clips.

### Observability, packaging, and environment
- Winston logging (with rolling files) captures lifecycle diagnostics across processes, supplemented by optional Prometheus metrics exporters for latency tracking.
- Avatar face generation requests must log non-2xx OpenAI responses with status metadata and the trimmed, truncated response body (max 500 characters) to aid debugging while preventing log bloat.
- Electron Builder packages the kiosk app with auto-launch hooks. Device setup scripts and systemd instructions live in the repo to support deployment on Intel N100-class mini PCs.
- Development relies on pnpm workspaces, ESLint/Prettier, Vitest, and Playwright smoke tests; CI must keep `pnpm lint`, `pnpm typecheck`, and `pnpm test` green to honor the plan’s gating criteria.

### Module system
- **Pure ESM**: This codebase uses ES Modules exclusively. No CommonJS allowed except for legacy configuration files (`.eslintrc.cjs`, `prettier.config.cjs`).
- All packages have `"type": "module"` in package.json, TypeScript uses `"module": "ESNext"`, and source files use `.js` extensions in import paths.
- Electron preload scripts are compiled as ESM and loaded directly by Electron's ESM support.
- Even pnpm configuration uses ESM format (`.pnpmfile.mjs`) to maintain consistency.

## Recent Updates

- 2025-02-14 — Realtime voice preference changes now emit explicit console instrumentation (`[RealtimeClient] Voice change …`) before disconnecting and after reconnecting. Watch for these logs when validating that a new session was negotiated for a voice swap.
- 2025-02-15 — ~~Realtime sessions are negotiated via `POST /v1/realtime/calls` with a `FormData` payload containing the SDP offer and a `session` JSON blob (`{ type: 'realtime', model, audio: { output: { voice }}}`). Voice preferences are only applied during this handshake; `session.update` messages now exclude the `voice` field per OpenAI guidance.~~ **DEPRECATED - See 2025-10-18 update**
- 2025-02-19 — Main-process OpenAI client factory now has dedicated unit tests verifying API key normalization and cache behavior; extend this suite when tweaking dependency injection or credential handling.
- 2025-02-20 — Avatar face services must obtain OpenAI access via `getOpenAIClient` and inject the resulting Responses client; main-process tests assert no raw API key or fetch wiring leaks outside the face upload flow. Keep related assertions up to date when refactoring avatar handling.
- 2025-02-18 — Dependency lockfile normalization confirmed all Electron `@electron/node-gyp` references use HTTPS (`https://github.com/electron/node-gyp.git`). Run `pnpm install --lockfile-only` followed by `pnpm install` when adjusting Git-based dependencies to avoid SSH fallbacks.
- 2025-02-21 — ConfigManager secret testing now depends on an injected OpenAI client factory; production code should pass `getOpenAIClient` so realtime key validation uses `client.models.list({ limit: 1 })` instead of raw fetch calls.
- 2025-02-21 — ~~Renderer realtime handshake must `POST` JSON to `/v1/realtime/calls` with `rtc_connection: { sdp }` plus a `session` object containing `model`, `modalities`, `input_audio_format`, and `session_parameters` (instructions/turn detection). Responses now return JSON (`{ rtc_connection: { sdp } }`); ensure the renderer parses this shape and leaves the long-lived API key available until a hardened SDK/WebRTC helper replaces the direct fetch wiring.~~ **DEPRECATED - See 2025-10-18 update**
- 2025-10-25 — Realtime WebRTC handshake now uses `POST /v1/realtime/calls` with a JSON payload containing the SDP offer (`{ sdp: <offer>, session: { type: 'realtime', model, audio, output_modalities, instructions, ... } }`). The response returns JSON with the answer SDP (`{ sdp: <answer> }`). Voice, instructions, turn detection, and output modalities are seeded in the session payload and mirrored over the control channel with `session.update` messages for runtime changes.
- 2025-10-26 — Some Realtime deployments still require `Content-Type: application/sdp`. The renderer now retries the handshake with SDP when the JSON payload is rejected (error code `unsupported_content_type`) and caches the fallback for the session.
- 2025-02-22 — Realtime client tests now assert control-channel `session.updated` payload parsing for `session_parameters`-driven instructions, voice, and turn detection. Keep these unit tests in sync with future schema adjustments to maintain coverage for all negotiated fields.
- 2025-02-23 — Renderer Vitest config now runs `tests/vite-config.test.ts` with the Node environment to satisfy esbuild's encoding invariants while keeping UI specs on jsdom. Preserve this match glob when adding new config-focused tests.
- 2025-02-24 — Diagnostics listeners should read console log metadata from `Event<WebContentsConsoleMessageEventParams>` instead of the deprecated positional arguments when handling `webContents` `console-message` events.
- 2025-10-18 — Native dependency rebuild: Dev scripts now set `PREBUILD_INSTALL_FORBID=1` to force better-sqlite3 source compilation instead of using prebuilt binaries that may have Node.js version mismatches. If tests fail with MODULE_VERSION errors, manually run: `PREBUILD_INSTALL_FORBID=1 pnpm --filter @aiembodied/main reinstall better-sqlite3`
- 2025-10-18 — Development script enhancement: `scripts/run-dev.mjs` is now the primary cross-platform development script (replacing platform-specific alternatives). Fixed Windows compatibility by enabling shell execution, added comprehensive environment validation, and enhanced error handling. Use `pnpm dev:run` as the standard command for launching the development environment.
- 2025-10-18 — Test coverage implementation: Added comprehensive test coverage measurement using vitest with v8 provider. Run `pnpm test:coverage` to generate coverage reports. GitHub Actions workflow automatically reports coverage on pull requests. Some sqlite-dependent tests are temporarily excluded due to Node.js version compatibility issues.
- 2025-10-18 — Renderer status bar now exposes a listening toggle next to the transcript control. UI tests (`app/renderer/tests/App.test.tsx`) assert the button renders with the correct label/`aria-pressed` state and that disabling listening forces the mocked realtime client to disconnect. Keep these assertions in sync when adjusting realtime gating or status chip messaging.
- 2025-10-19 — Development script now resolves the Electron CLI directly instead of relying on `pnpm exec`, preventing Windows shutdown errors when exiting the dev app. Ensure dependencies are installed so the CLI path exists before launching.
- 2025-10-19 — Diagnostics cleanup guards against calling `removeListener` on destroyed `webContents` instances so the Electron app can exit without spurious warnings on Windows.
- 2025-10-19 — `scripts/run-dev.mjs` now reads the installed Electron version and re-runs `pnpm --filter @aiembodied/main rebuild better-sqlite3 keytar` inside the isolated dev HOME with `npm_config_runtime=electron`, `npm_config_target`, and `npm_config_disturl=https://electronjs.org/headers` to ensure native modules target the Electron ABI.
- 2025-10-20 — Development script preserves the original pnpm store path inside the `.dev-home` isolation so Windows users avoid `Unexpected store location` errors during native rebuilds. The store is detected via `pnpm store path` and exported through `PNPM_STORE_PATH`.
- 2025-10-20 — Avatar face generation prompts share the `ALIGNMENT_GUIDANCE` constant in `app/main/src/avatar/avatar-face-service.ts`.
  Update that string if alignment expectations change so all layer prompts stay consistent.
- 2025-10-21 — Avatar face Responses prompts now send system+user message arrays with the reference portrait attached as an `input_image`. Update related tests/tooling if the schema changes again.
- 2025-10-22 — Avatar configurator uploads now start async processing via an IIFE to keep the submit handler synchronous; renderer tests assert the "Generating…" state appears while generation is pending and that other controls remain interactive.
- 2025-10-21 — Renderer realtime client now mirrors `sessionConfig.instructions` onto both `session.session_parameters.instructions` and `session.instructions` for backward compatibility; update realtime client tests when adjusting instruction handling.
- 2025-10-22 — Renderer pre-connect staging now pushes voice, instructions, and VAD preferences to the realtime client before any connection attempt. Tests in `app/renderer/tests/App.test.tsx` ensure `updateSessionConfig` runs prior to `connect`; keep them green when adjusting session config sequencing.
- 2025-10-23 — TypeScript base config targets `ES2022` with DOM library definitions to support modern array helpers (e.g., `Array.prototype.at`) while preserving browser globals relied on by renderer code and tests. Update downstream tsconfig references if custom overrides diverge.
- 2025-10-23 — Secret submission handlers in the renderer now flush success/error status updates synchronously so Vitest can observe the confirmation message. Renderer tests use `findByText` when asserting the success notice to avoid timing flake in CI. The "Test key" action remains enabled while configuration is loading so wake-word key validation can run immediately in tests and during slow bridge initialization.
- 2025-10-27 — Renderer realtime client now logs JSON handshake payloads (including voice/session config) and detailed WebRTC events. The `/v1/realtime/calls` handshake no longer retries with `application/sdp`; maintain this instrumentation when changing negotiation logic.
- 2025-10-28 — Realtime handshake logs now include serialized JSON strings for payloads, and any HTTP 400 response from realtime endpoints logs the target URI plus request body for easier debugging. Renderer console logging prefers these serialized payloads when available.
- 2025-10-25 — Renderer kiosk layout now presents ChatGPT, Character, and Local panels via a left-rail tablist. Update renderer tests to activate the appropriate tab before querying controls.
- 2025-10-26 — Renderer kiosk tab panels must remain mounted (use data-state toggles instead of conditional rendering) so avatar configuration loads immediately on launch. Tests should assert the character panel fetches its active face even when the tab starts inactive.
- 2025-10-27 — When wiring global keyboard shortcuts in the renderer, use DOM `KeyboardEvent` types for window listeners and keep React synthetic `KeyboardEvent` typings scoped to component handlers so `pnpm typecheck` remains happy.
- 2025-10-30 — VRM avatar models now persist under `userData/vrm-models` with metadata stored in the `vrm_models` table (`id`, `name`, `created_at`, `file_path`, `file_sha`, `version`, `thumbnail`). The active model key lives at `avatar.activeVrmId` in the memory store. Preload exposes `listModels`, `uploadModel`, `deleteModel`, `setActiveModel`, and `getActiveModel` bridges; update renderer code to use these IPC channels when managing VRM assets.
- 2025-10-31 — VRM avatar renderer now ships alongside the sprite renderer. When touching renderer avatar code:
  - Prefer updating `app/renderer/src/avatar/display-mode.ts` when adding new display toggles so tests in `tests/avatar/display-mode.test.ts` stay authoritative.
  - VRM viseme/blink handling lives in `app/renderer/src/avatar/vrm-avatar-renderer.tsx`; keep helper functions exported for unit tests and extend `avatar-renderers.smoke.test.tsx` if the WebGL boot flow changes.
  - Renderer IPC for VRM binaries flows through `avatar-model:load`; mocks in renderer tests should patch `window.aiembodied.avatar.loadModelBinary` when VRM coverage is required.
- 2025-11-01 — Avatar configurator now surfaces VRM model management, display mode selection, and manual wave testing. Update `avatar-configurator.test.tsx` when adjusting VRM uploads, display preferences, or behavior cue plumbing.
- 2025-11-02 — Behavior cues now flow through the camera detection bridge. When simulating gestures in renderer tests, prefer stubbing `window.aiembodied.camera.emitDetection`/`onDetection` so `BehaviorCueProvider` observes the event instead of calling `avatar.triggerBehaviorCue` directly.
- 2025-11-03 — **Stub workflow:** Vitest suites that validate avatar gestures should wrap renders with `BehaviorCueProvider` (already applied in `App.tsx`) and patch the preload bridge via `vi.stubGlobal('aiembodied', { camera: { onDetection: fn, emitDetection: fn }})`. Emit normalized detections using `{ cue: 'greet_face', timestamp: Date.now() }` so cue listeners fire without touching legacy behavior triggers.
- 2025-11-04 — Dependabot auto-merge now waits for the `CI` workflow to complete successfully and only queues squash merges for Dependabot patch updates.
- 2025-11-05 — VRMA animations now persist under `userData/vrma-animations` with metadata in the `vrma_animations` table; IPC bridges expose list/upload/delete/load. Verify with `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:coverage`.
- 2025-11-06 — VRM renderer now loads VRMA clips into a slug-keyed registry and processes queued pose/play requests through the animation bus.
