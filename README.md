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

#### Automated environment bootstrap

To streamline installing the runtime prerequisites, run the helper script for your
platform from the repository root:

```powershell
# Windows PowerShell
.\scripts\setup-windows.ps1
```

```bash
# macOS Terminal
./scripts/setup-macos.sh
```

The scripts verify existing installations of Node.js and pnpm, upgrading them when
necessary via the native package manager (`winget`/Chocolatey on Windows, Homebrew on
macOS). When the checks pass you can continue with `pnpm install`.

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
2. **Build and launch the Electron main process** (loads the bundled renderer and starts the wake-word worker):
   - One-shot cross-platform command:
     ```bash
     pnpm dev:run
     ```
   - Or using platform scripts:
     ```powershell
     .\scripts\run-dev.ps1
     ```
     ```bash
     ./scripts/run-dev.sh
     ```

   The run scripts rebuild native deps for Electron automatically. Note: this can temporarily break Node-based unit tests that touch SQLite. Reinstall or rebuild for Node when you return to test runs.

During renderer UI work you can also run the Vite dev server in parallel:

```bash
pnpm --filter @aiembodied/renderer dev
```

This serves the UI on http://localhost:5173 with hot reloading; rebuild before returning to the Electron flow.

While running in development, a lightweight system tray menu appears. Use it to bring the kiosk window to the foreground or to
toggle the "Launch on Login" checkbox, which exercises the auto-launch flow without touching your OS login items permanently.

### Diagnostics & Debug Logging

When troubleshooting a blank window or startup failures (common on fresh Windows installs), enable the global diagnostics
instrumentation to capture detailed lifecycle logs:

```bash
AIEMBODIED_ENABLE_DIAGNOSTICS=1 pnpm dev:run
```

Setting the environment variable (or alternatively `AIEMBODIED_DEBUG=1`) causes the Electron main process to log every app,
window, and renderer milestone — including renderer console output — to both the terminal and the rotating log files under the
standard platform log directory (e.g., `%APPDATA%/AI Embodied Assistant/logs/aiembodied` on Windows, `~/Library/Logs/AI
Embodied Assistant/aiembodied` on macOS). Use these logs to confirm that the renderer bundle loads, the wake-word service
boots, or to spot navigation/IPC errors that would otherwise leave the window blank.

### Realtime call configuration

Realtime calls post an SDP offer to `/v1/realtime/calls` with a JSON payload that includes a `session` object. When selecting
text-only versus audio responses, set `session.output_modalities` accordingly. The field accepts either `['audio']` (default,
includes audio plus transcripts) or `['text']` (text responses only). The legacy `session.modalities` attribute applies only to
deprecated `realtime.session` handshakes and should not be used with the current call flow.

### Package for Distribution

Electron bundles for Windows, macOS, and Linux are generated with `electron-builder`.

```bash
pnpm build            # compile main + renderer bundles
pnpm dist             # emit installers into release/
```

Artifacts land in `release/` with platform-specific installers (`.dmg`, `.zip`, `.exe`, `.AppImage`, `.deb`). Production builds
boot directly into kiosk mode and automatically register themselves to launch at login. To opt into the auto-launch flow from a
development build, run with `ENABLE_AUTO_LAUNCH=1 pnpm --filter @aiembodied/main dev`.

### Intel N100 Deployment Tips

For the reference Intel N100 mini-PC (Ubuntu/Debian-based):

1. Copy the generated `.deb` or `.AppImage` from `release/` onto the device.
2. Install the `.deb` via `sudo dpkg -i <package>.deb` (or mark the AppImage as executable and launch once to verify).
3. Provide the production `.env` or environment variables under `/etc/aiembodied.env` and load them via your preferred shell
   profile or systemd service wrapper.
4. On first run the assistant enables auto-launch; confirm it appears under **Startup Applications**. Remove it there if you need
   to temporarily disable kiosk startup.
5. For kiosk-style boot, create a systemd user service that runs the installed binary at login (the `.deb` places the executable
   under `/opt/AI Embodied Assistant/ai-embodied-assistant`). Combine with display manager auto-login targeting the kiosk user.

## Quality Gates

Run the shared project checks from the repo root:

```bash
pnpm lint        # ESLint across all workspaces
pnpm typecheck   # TypeScript project references
pnpm test        # Vitest unit/integration suites
pnpm build       # Compile production-ready main and renderer output
```

When preparing installers, run `pnpm dist` after the checks to exercise the electron-builder configuration locally.

## Further Reading

- [Product Requirements Document](prd.md) – goals, non-goals, and acceptance criteria for the assistant.
- [Architecture Specification](archspec.md) – detailed component responsibilities, data contracts, and latency budgets.
- [Implementation Plan](plan.md) – phased rollout of features, validation steps, and testing expectations.

Contributions should stay aligned with these documents to preserve the kiosk-focused, low-latency assistant vision.
