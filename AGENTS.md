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

## Testing & Verification
Run these commands from the repository root unless a task specifies otherwise:
- `pnpm install` — ensure dependencies resolve from a clean checkout.
- `pnpm lint` — enforce linting rules across packages.
- `pnpm typecheck` — run TypeScript project-wide type analysis.
- `pnpm test` — execute automated unit/integration tests.
- `pnpm build` — (as needed) validate production builds for Electron targets.

### OpenAI Responses API usage
- When crafting requests, ensure every content chunk conforms to the Responses API schema (e.g., text prompts must use `{ type: 'input_text', text: '...' }`).
- Structured outputs must set the top-level `modalities` array (e.g., `['text']`) and configure `text: { format: 'json_schema', schema: <definition> }`. Do not send the deprecated `response_format` field or the unsupported `response` wrapper.
- Structured outputs must use the modern `response` object. For JSON-schema responses, set `response: { modalities: ['text'], text: { format: 'json_schema', schema: <definition> } }` instead of the legacy `response_format` field.

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

### Observability, packaging, and environment
- Winston logging (with rolling files) captures lifecycle diagnostics across processes, supplemented by optional Prometheus metrics exporters for latency tracking.
- Avatar face generation requests must log non-2xx OpenAI responses with status metadata and the trimmed, truncated response body (max 500 characters) to aid debugging while preventing log bloat.
- Electron Builder packages the kiosk app with auto-launch hooks. Device setup scripts and systemd instructions live in the repo to support deployment on Intel N100-class mini PCs.
- Development relies on pnpm workspaces, ESLint/Prettier, Vitest, and Playwright smoke tests; CI must keep `pnpm lint`, `pnpm typecheck`, and `pnpm test` green to honor the plan’s gating criteria.

### Module system
- **Pure ESM**: This codebase uses ES Modules exclusively. No CommonJS allowed except for configuration files (`.eslintrc.cjs`, `prettier.config.cjs`).
- All packages have `"type": "module"` in package.json, TypeScript uses `"module": "ESNext"`, and source files use `.js` extensions in import paths.
- Electron preload scripts are compiled as ESM and loaded directly by Electron's ESM support.

## Recent Updates

- 2025-02-14 — Realtime voice preference changes now emit explicit console instrumentation (`[RealtimeClient] Voice change …`) before disconnecting and after reconnecting. Watch for these logs when validating that a new session was negotiated for a voice swap.
- 2025-02-15 — ~~Realtime sessions are negotiated via `POST /v1/realtime/calls` with a `FormData` payload containing the SDP offer and a `session` JSON blob (`{ type: 'realtime', model, audio: { output: { voice }}}`). Voice preferences are only applied during this handshake; `session.update` messages now exclude the `voice` field per OpenAI guidance.~~ **DEPRECATED - See 2025-10-18 update**
- 2025-02-19 — Main-process OpenAI client factory now has dedicated unit tests verifying API key normalization and cache behavior; extend this suite when tweaking dependency injection or credential handling.
- 2025-02-20 — Avatar face services must obtain OpenAI access via `getOpenAIClient` and inject the resulting Responses client; main-process tests assert no raw API key or fetch wiring leaks outside the face upload flow. Keep related assertions up to date when refactoring avatar handling.
- 2025-02-18 — Dependency lockfile normalization confirmed all Electron `@electron/node-gyp` references use HTTPS (`https://github.com/electron/node-gyp.git`). Run `pnpm install --lockfile-only` followed by `pnpm install` when adjusting Git-based dependencies to avoid SSH fallbacks.
- 2025-02-21 — ConfigManager secret testing now depends on an injected OpenAI client factory; production code should pass `getOpenAIClient` so realtime key validation uses `client.models.list({ limit: 1 })` instead of raw fetch calls.
- 2025-02-21 — ~~Renderer realtime handshake must `POST` JSON to `/v1/realtime/calls` with `rtc_connection: { sdp }` plus a `session` object containing `model`, `modalities`, `input_audio_format`, and `session_parameters` (instructions/turn detection). Responses now return JSON (`{ rtc_connection: { sdp } }`); ensure the renderer parses this shape and leaves the long-lived API key available until a hardened SDK/WebRTC helper replaces the direct fetch wiring.~~ **DEPRECATED - See 2025-10-18 update**
- 2025-10-18 — Realtime WebRTC handshake now uses correct SDP negotiation format: `POST /v1/realtime?model={model}` with `Content-Type: application/sdp` and raw SDP string body. Response is also raw SDP. Session parameters (voice, turn detection) are configured via WebRTC data channel after connection using `session.update` messages.
- 2025-02-22 — Realtime client tests now assert control-channel `session.updated` payload parsing for `session_parameters`-driven instructions, voice, and turn detection. Keep these unit tests in sync with future schema adjustments to maintain coverage for all negotiated fields.
- 2025-02-23 — Renderer Vitest config now runs `tests/vite-config.test.ts` with the Node environment to satisfy esbuild's encoding invariants while keeping UI specs on jsdom. Preserve this match glob when adding new config-focused tests.
