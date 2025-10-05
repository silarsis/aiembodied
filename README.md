# Embodied ChatGPT Assistant

An Electron-based kiosk prototype that turns ChatGPT's Realtime API into a hands-free, always-on desktop companion. The project couples wake-word listening, low-latency voice exchange, and a lively on-screen avatar so the assistant feels present while remaining lightweight enough for mini-PC hardware.

## Project Overview

This MVP is designed to:

- **Listen and respond instantly.** A local wake-word service keeps the microphone dormant until the user speaks, then hands the stream to OpenAI's Realtime API for sub-second turnarounds.
- **Show an expressive avatar.** A 2D canvas renderer animates mouth shapes, blinks, and idle motion based on viseme frames so the character looks alive without expensive 3D assets.
- **Persist context locally.** Conversations, device preferences, and configuration live on device (SQLite/JSON) so history survives restarts and the app can run offline aside from model calls.
- **Operate as an appliance.** Crash-guarding, kiosk mode, and packaging work make it suitable for an Intel N100-style box that boots directly into the assistant.

The longer-term vision keeps the core voice loop intact while swapping in richer avatars (e.g., Unity) or extending observability, memory, and deployment automation. Refer to the detailed [PRD](prd.md), [architecture spec](archspec.md), and [implementation plan](plan.md) for the full context.

## Architecture at a Glance

| Layer | Responsibilities |
| --- | --- |
| **Electron main process** | Window lifecycle, crash guard, wake-word worker orchestration, secrets/config validation (`ConfigManager`), SQLite memory store. |
| **Renderer process** | WebRTC session with the Realtime API, Web Audio capture/playback, viseme generation, 2D avatar rendering, transcript overlay. |
| **Wake-word worker** | Picovoice Porcupine loop for low-latency keyword detection with cooldown and confidence filtering. |
| **Future integrations** | Optional metrics exporter, Unity avatar client consuming the same viseme stream, packaging for appliance deployment. |

## Roadmap Snapshot

The implementation plan progresses through the major subsystems required for the MVP and eventual appliance delivery.

- ✅ Foundations: repository scaffolding, configuration/secrets, logging and crash guard, wake-word service, audio graph, realtime client, viseme driver.
- 🚧 In Progress: 2D canvas avatar renderer, transcript overlay/UI shell.
- ⏭️ Upcoming: persistent memory store, full conversation loop persistence, observability, packaging/auto-launch, appliance validation, and Unity integration prep.

Check `AGENTS.md` for the authoritative status checklist that mirrors these milestones.

## Getting Started

### Prerequisites

- **Node.js 20+** (matches Electron runtime expectations).
- **pnpm 9+** (the repo pins `pnpm@9.12.0`; enable via `corepack enable`).
- Picovoice Porcupine access key (free tier available) for wake-word detection.
- OpenAI Realtime API access with a corresponding key.

### Clone & Install

```bash
git clone <your-fork-url>
cd aiembodied
pnpm install
```

> ℹ️ The monorepo hosts multiple workspaces (`app/main`, `app/renderer`). `pnpm install` bootstraps all of them.

### Configure Secrets & Environment

Create a `.env` file at the repository root (loaded automatically in development) or set the variables in your shell:

```ini
REALTIME_API_KEY=sk-...
PORCUPINE_ACCESS_KEY=...
# Optional overrides
AUDIO_INPUT_DEVICE_ID=default
AUDIO_OUTPUT_DEVICE_ID=default
WAKE_WORD_BUILTIN=porcupine
WAKE_WORD_SENSITIVITY=0.6
WAKE_WORD_MIN_CONFIDENCE=0.5
WAKE_WORD_COOLDOWN_MS=1500
```

Additional knobs include `WAKE_WORD_KEYWORD_PATH`/`WAKE_WORD_KEYWORD_LABEL` for custom models and `FEATURE_FLAGS` (JSON or comma syntax) for experimental toggles.

### Run the App in Development

1. **Build the renderer bundle** (Electron loads the static output):
   ```bash
   pnpm --filter @aiembodied/renderer build
   ```
2. **Launch the Electron main process** (loads the bundled renderer and starts the wake-word worker):
   ```bash
   pnpm --filter @aiembodied/main dev
   ```

During renderer UI work you can also run the Vite dev server in parallel:

```bash
pnpm --filter @aiembodied/renderer dev
```

This serves the UI on http://localhost:5173 with hot reloading; rebuild before returning to the Electron flow.

## Quality Gates

Run the shared project checks from the repo root:

```bash
pnpm lint        # ESLint across all workspaces
pnpm typecheck   # TypeScript project references
pnpm test        # Vitest unit/integration suites
```

> For production packaging targets, add `pnpm build` once the renderer and main bundles are ready.

## Further Reading

- [Product Requirements Document](prd.md) – goals, non-goals, and acceptance criteria for the assistant.
- [Architecture Specification](archspec.md) – detailed component responsibilities, data contracts, and latency budgets.
- [Implementation Plan](plan.md) – phased rollout of features, validation steps, and testing expectations.

Contributions should stay aligned with these documents to preserve the kiosk-focused, low-latency assistant vision.
