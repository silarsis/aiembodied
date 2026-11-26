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
| **Wake-word worker** | openWakeWord models on onnxruntime-node, fed from the microphone in 80 ms frames, with cooldown and threshold filtering. Fully local: no account or key. |
| **Future integrations** | Optional metrics exporter, Unity avatar client consuming the same viseme stream, packaging for appliance deployment. |

## Roadmap Snapshot

The implementation plan progresses through the major subsystems required for the MVP and eventual appliance delivery.

- ✅ Foundations: repository scaffolding, configuration/secrets, logging and crash guard, wake-word service, audio graph, realtime client, viseme driver.
- 🚧 In Progress: 2D canvas avatar renderer, transcript overlay/UI shell.
- ⏭️ Upcoming: persistent memory store, full conversation loop persistence, observability, packaging/auto-launch, appliance validation, and Unity integration prep.

Current feature status lives in [`docs/features/`](docs/features/README.md); the dated decision log is [`docs/history.md`](docs/history.md).

## Getting Started

### Prerequisites

- **Node.js 22.12+** (required by Electron 45 and better-sqlite3 13; CI uses Node 24).
- **pnpm 10+** (the repo pins `pnpm@10.34.9`; enable via `corepack enable`).
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

#### Windows: install the whole local stack

`pnpm install:windows` (or `.\scripts\install-windows.ps1`) goes further than the bootstrap above:
it sets up what `pnpm dev:run` needs for the local stack (uv and git, llama.cpp, Kokoro, the speech,
memory, coder, switchboard and Laya venvs, Qwen3-ASR, the pi agent, the motion service, avatar face
fitting). It is safe to re-run: whatever is already present is skipped, and `.env` is only ever
appended to, never edited. Use `-Only a,b` or `-Skip a,b` to pick components, `-LlamaBackend
vulkan|cuda`, and `-Force` to reinstall. `-With coder-model,avatar-paint` adds the opt-in components
(the Qwen3-Coder-Next GGUF is about 45 GB; avatar paint needs ComfyUI's Python). It does not install
the Thinking model or the vision model (pick them in Models and servers), Docker or wslc, or Comfy
Desktop. See the header of the script for the full list.

A second desktop that only draws one room of bija's world (no models) installs with
`.\scripts\install-windows.ps1 -Role satellite`, then starts with `pnpm satellite`. See
[docs/features/satellite.md](docs/features/satellite.md#set-up-a-second-desktop).

No C++ toolchain (Visual Studio Build Tools, Xcode, Python for node-gyp) is needed:
better-sqlite3, keytar and the Picovoice packages all ship prebuilt N-API binaries that
load in both Node and Electron.

### Clone & Install

```bash
git clone <your-fork-url>
cd aiembodied
pnpm install
pnpm --filter @aiembodied/main exec install-electron
```

Electron 45 no longer downloads its binary during install, so the second command fetches
it (`pnpm dev:run` also does this for you).

> ℹ️ The monorepo hosts multiple workspaces (`app/main`, `app/renderer`). `pnpm install` bootstraps all of them.

### Configure Secrets & Environment

Create a `.env` file at the repository root (loaded automatically in development) or set the variables in your shell:

```ini
REALTIME_API_KEY=sk-...
# Optional overrides
AUDIO_INPUT_DEVICE_ID=default
AUDIO_OUTPUT_DEVICE_ID=default
WAKE_WORD_MODEL=hey_echo
WAKE_WORD_THRESHOLD=0.5
WAKE_WORD_COOLDOWN_MS=1500
COMFYUI_BASE_URL=http://127.0.0.1:8188
MOTION_SERVICE_URL=http://127.0.0.1:8190
```

**Wake word.** Detection uses [openWakeWord](https://github.com/dscripka/openWakeWord) and runs entirely on the machine. `WAKE_WORD_MODEL` picks a bundled model or takes a path to a custom `.onnx` model trained with openWakeWord. The default is `hey_echo` ("Hey Echo"), trained for this project with the scripts in `experiments/wakeword/`. openWakeWord's pre-trained `hey_jarvis`, `alexa`, `hey_mycroft` and `hey_rhasspy` are bundled too. `WAKE_WORD_KEYWORD_LABEL` overrides the displayed name, and `WAKE_WORD_DEVICE_INDEX` picks the microphone. Settings → Wake word picks the wake word and threshold without a restart, and can train a new phrase in WSL (a few hours on the CPU; see `services/wakeword-trainer/`).

Additional knobs include `FEATURE_FLAGS` (JSON or comma syntax) for experimental toggles.

**Local image and avatar generation.** Controls > Characters > Create an avatar opens the avatar studio pop-up, which keeps every take and lets you go back to any stage. It defaults to **New 3D character (experimental)**. Qwen draws a reference, TRELLIS.2 generates new textured geometry, and headless Blender adds a humanoid skeleton and fits the visible reference face locally with speech/emotion morphs before exporting VRM 1.0. This does not use the bundled avatar mesh. The first version supports adult stylised humanoids with short/swept-back hair and close-fitting clothes; no articulated fingers, loose garments or hair physics yet. Shoulder deformation is still rough. Choose **Recolour the base avatar** for the previous texture-only pipeline. Start from a text description or upload a PNG/JPEG/WebP image. For text-to-image, choose an installed **Image model**; the app detects its family and selects the compatible workflow and supporting models automatically. Refresh models finds newly added compatible weights, and the selection is remembered. On the image step, choose the **3D model** (TRELLIS.2 variants found in ComfyUI) and the **Rig and animation** method. Generation pauses for explicit image approval before any 3D or texture work. The finished VRM is shown beside its image, where you can spin it and try poses and expressions; Keep is enabled only after the actual model loads.

New character generation also needs the local face detector: run `pnpm avatar:face:setup` once. It runs on the CPU and needs no external service; see [face fitting setup and five-character demo](services/avatar-face/README.md). Face/hair and jaw seams, approximate lips and imperfect likeness remain experimental limitations. New character generation needs Blender (automatically found under Program Files/Blender Foundation on Windows, or set `BLENDER_EXE`). See [the pipeline and MVP evidence](docs/features/new-avatar-generation.md). It needs a local ComfyUI server (default `http://127.0.0.1:8188`, override with `COMFYUI_BASE_URL`) with the Qwen-Image 2.1 models installed (`qwen_image_2.1_int8_convrot`, `qwen3vl_8b_int8_convrot`, `qwen_image_2.1_vae_bf16`). Background generation in Controls > Backgrounds uses the same server and models. On Windows the app starts Comfy Desktop on demand, waits up to three minutes for readiness, and reuses it for both generators. It stays running after the app closes. For a nonstandard installation set `COMFYUI_DIR` (folder containing `main.py`), `COMFYUI_PYTHON` (environment Python executable), and optionally `COMFYUI_MODEL_PATHS` (extra-model-paths YAML). Default Desktop discovery requires exactly one instance model-paths YAML. Server logs are `logs/comfyui.log` and `logs/comfyui.err.log` inside the app user-data folder; Windows launcher failures are recorded separately in `logs/comfyui-startup.err.log`. Remote servers and non-Windows installations must already be running. Nothing is sent to a cloud service.

**Models and servers.** Controls → Voice & engine → Open models and servers sets, for every job (hearing, thinking, speaking, moving, web search, concept image, 3D model and the helper jobs), which server runs it, which model it asks for, and which servers to try if it is busy or down. Add your own machines (any OpenAI-compatible chat or transcription server, ComfyUI, SearXNG, or this repo's speech and motion services) under Servers and pick them for any job; ComfyUI jobs can also go to whichever server has the shortest queue. The OpenAI, Brave and server keys are set there too and kept in the system credential store. Without saved choices everything follows the env vars above. See [docs/features/models-and-servers.md](docs/features/models-and-servers.md).

**Quick decisions.** A small local model (Laya, `services/laya`, port 8197) makes fast typed judgements without writing text: who a line is for, who wants to reply, what to do with an incoming message, and whether it is a good moment for the avatar to speak unprompted. It is the `decide` use in Models and servers; when it is off the app falls back to the chat model or stays quiet. See [docs/features/quick-decisions.md](docs/features/quick-decisions.md).

**Local motion generation.** With the local motion service running (`services/motion/`, NVIDIA ARDY or Kimodo; default `http://127.0.0.1:8190`, override with `MOTION_SERVICE_URL`), "Generate animation" in the Avatar tab uses it instead of the OpenAI keyframe pipeline, and the assistant can perform any movement on the fly by writing `{move:<description>}`; ARDY streams it in 2-second chunks so the avatar starts moving in under a second. See `services/motion/API.md` for the protocol.

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
   - Or, on macOS/Linux:
     ```bash
     ./scripts/run-dev.sh
     ```

   `pnpm dev:run` installs dependencies into an isolated store under `.dev-home/`, builds both
   bundles, downloads the Electron binary if needed and launches the app. It skips the install
   and build on later runs until the lockfile or sources change; pass `--force-deps` to redo them.

During renderer UI work you can also run the Vite dev server in parallel:

```bash
pnpm --filter @aiembodied/renderer dev
```

This serves the UI on http://localhost:5173 with hot reloading; rebuild before returning to the Electron flow.

While running in development, a lightweight system tray menu appears. Use it to bring the kiosk window to the foreground or to
toggle the "Launch on Login" checkbox, which exercises the auto-launch flow without touching your OS login items permanently.

### Running with aicontroller (shared model controller)

On a PC that runs [aicontroller](https://github.com/silarsis/aicontroller) (bija runs it from the tray), the controller owns
the GPU servers, and the app leases them instead of starting and stopping them itself. When the controller is not in use
(`AICONTROLLER_ENABLED=0`, or it does not answer in `auto` mode) everything works as it always did.

Backends the app expects in the controller's `config.yaml` (see its `config.example.yaml`; names and ports must match):

| Backend | Port | Used for | Leased |
|---|---|---|---|
| `echo-llm` | 1234 | Echo's language model (Thinking) | `interactive`, while the app runs; released on quit, suspend and hibernate |
| `coder-llm` | 1236 | The coding model | for a coding task, in place of `echo-llm` |
| `motion` | 8190 | The motion service (ARDY), when Moving runs on this PC's own motion service | `interactive`, while the app runs and motion is enabled |
| `comfyui` | 8188 | Avatar, scenery and pose generation, when the ComfyUI server is the built-in "ComfyUI on this PC" | per job, kept for 60 s after the last one |
| `vision` | 1237 | Describe the avatar, Check poses | per use, kept for 60 s after the last one |

Leave out any you do not want the controller to run: a backend it does not list (or answers 404 for) is logged once and the
app runs its own server for that one, as without the controller. ASR (:1235) and the speech service are still started by the app.

- Echo holds an `interactive` lease (client `aiembodied`) on `echo-llm` while the app runs, heartbeats it, and chats on the
  lease's URL. The lease is released on quit, hibernate and suspend, and taken again on resume.
- If the controller revokes a lease (a game needs the GPU, or the model is evicted), Status shows "Local LLM paused by the
  model controller (reason)" (or "Motion paused ..."). The next turn (or motion request) leases again; if that fails the turn
  errors with that message.
- A coding task that needs the coder model gives Echo's lease up, leases `coder-llm` (the controller evicts `echo-llm` if the
  two don't fit) and Echo chats on the coder meanwhile. When the task has been idle for a while (`CODER_SWAP_BACK_S`) the
  coder lease is released and `echo-llm` is leased again. The Coding memory mode and GGUF settings are ignored then.
- **ComfyUI**: each generation request (avatar, backgrounds, poses, scenery objects) leases `comfyui` and uses the lease's URL;
  jobs in a row share the lease, which is released 60 s after the last request, also after a failure or cancel. The app never
  starts, kills or calls `/free` on ComfyUI then. Remote ComfyUI servers configured in Models and servers are left alone.
- **Motion**: the lease's URL replaces the motion service's address while it is held; turning Moving off in Models and servers
  gives the lease back.
- **Vision**: leased for each use and released 60 s after the last one.
- The controller never evicts a leased backend, so while `comfyui` or `vision` is leased Echo's `echo-llm` lease is given back
  and taken again afterwards (the controller evicts the idle model only if it needs the memory, and `echo-llm` should list
  `comfyui` in `evictable_by`). A chat turn in that time errors with "Echo's model is unloaded while comfyui uses the GPU",
  unless the model is still loaded. `motion` is leased all the time, so the controller's `gpu_budget_gb` must fit it
  alongside `echo-llm` (and `vision`).
- **Thinking model picker**: with the controller in use, picking a local model (Settings, Thinking) finds the file in the
  controller's catalog (`GET /v1/models`), releases `echo-llm` and leases it again with that model's catalog id; the controller
  loads it. The model has to be in a folder listed under `model_store.dirs.llm` (the app downloads to
  `~/.cache/aiembodied/llm-models`, so list that folder; the controller adopts new files when it scans). Otherwise the picker
  says "the model controller doesn't have this model; add its folder to the controller's model_store". Hugging Face downloads
  are still made by the app itself, not through the controller's download endpoint.
- Quitting or hibernating leaves the servers the controller started running (their `llm.pid`, `coder-llm.pid`, `motion.pid`,
  `vision.pid` and `comfyui.pid` files are skipped, for the motion, vision and ComfyUI ones only if the controller has that
  backend). `pnpm dev:run` logs "using aicontroller" instead of starting Echo's llama-server, and the motion service when the
  controller lists a `motion` backend (`GET /v1/status`).
- The Model controller line in Status lists the leases held, for example "echo-llm, motion leased; comfyui, vision idle".

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `AICONTROLLER_URL` | `http://127.0.0.1:8200` | The controller's address. |
| `AICONTROLLER_ENABLED` | `auto` | `auto`: use the controller if `GET /health` answers at startup (and after resume), else everything works as before. `1`: require it; turns fail with a message while it is down. `0`: never use it. |
| `AICONTROLLER_TOKEN` | none | Bearer token, only needed for a controller on another machine. |

The app never starts the controller. The controller's backends are configured in its own `config.yaml`.

### Diagnostics & Debug Logging

When troubleshooting a blank window or startup failures (common on fresh Windows installs), enable the global diagnostics
instrumentation to capture detailed lifecycle logs:

```bash
AIEMBODIED_ENABLE_DIAGNOSTICS=1 pnpm dev:run
```

`pnpm dev:run` already turns this on; set it yourself when launching another way.

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

#### Windows installer (built on GitHub)

The **Windows installer** workflow builds a per-user setup exe and a portable exe that run on a PC with no dev setup
(no Python services or models inside; see [docs/windows-installer.md](docs/windows-installer.md) for what still needs
setting up there).

To build a new one:

- **Release (a link you can send):** change the number in `RELEASE.txt` (e.g. `0.0.3` → `0.0.4`) and merge it to main.
  The workflow publishes GitHub release `v<number>` with both exes under the repo's Releases.
- **By hand:** GitHub → Actions → Windows installer → Run workflow on `main`. Tick "release" to publish a release;
  otherwise the exes are in the run's artifacts (GitHub sign-in needed). You can type a version instead of using `RELEASE.txt`.
- **Locally on Windows:** `pnpm install --frozen-lockfile`, then `python scripts\build_windows_installer.py` (output in `release\`).

The exes are not signed: SmartScreen asks once (More info → Run anyway).

#### Other platforms

Electron bundles for macOS and Linux are generated with `electron-builder`.

```bash
pnpm build            # compile main + renderer bundles
pnpm dist             # emit installers into release/
```

Artifacts land in `release/`. Packaged builds open full screen (Escape leaves it); `AIEMBODIED_KIOSK=1` makes them a locked
kiosk, and `ENABLE_AUTO_LAUNCH=1` registers them to start at login.

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
