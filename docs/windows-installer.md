# Windows installer

A GitHub Actions workflow (`.github/workflows/windows-installer.yml`) builds the desktop app for Windows as:

- `AIEmbodied-<version>-win-x64-setup.exe`: installs for the current user (no admin), adds Start menu and
  desktop shortcuts **AI Embodied Assistant** and **AI Embodied Room (satellite)**, and has an uninstaller.
- `AIEmbodied-<version>-win-x64-portable.exe`: one file that runs without installing.

Neither is code-signed, so Windows SmartScreen warns the first time: **More info > Run anyway**.

## Getting a build

- **From a release:** bump `RELEASE.txt` on main. The workflow builds and publishes GitHub release
  `v<version>` with both files.
- **By hand:** Actions > Windows installer > Run workflow. Tick "release" to publish a GitHub release; otherwise
  download the files from the run's artifacts (a zip, kept 90 days; needs a GitHub login).
- **Locally on Windows:** `pnpm install --frozen-lockfile`, then `python scripts\build_windows_installer.py`.
  Output in `release\`. `--target dir` builds just the unpacked folder (works on Linux too, for a quick check).

## What is in it, and what is not

The package is the Electron app only: the window, avatar, rooms, wake word ("Hey Echo", runs on the CPU), the
microphone, the local SQLite history and the keychain. About 300 MB installed.

It does **not** contain the services `pnpm dev:run` starts from the repo, or any model:

| Not included | Used for | Without it |
| --- | --- | --- |
| llama-server + the Qwen Thinking model | Thinking (chat) | Pick OpenAI, or another server, in Models and servers |
| services/speech (Qwen3-ASR, Kokoro/Kitten/Piper) | Hearing, Speaking | Pick OpenAI |
| services/motion (ARDY/Kimodo) | Moving | Pick OpenAI (keyframe clips) or the idle clips only |
| services/memory (Postgres + pgvector in wslc/Docker) | Long-term memory | Only this PC's short history; memory tools fail |
| SearXNG | `web_search` | Search is off |
| services/laya, switchboard, coder | Quick decisions, event bus, coding tool | Off |
| ComfyUI, Blender, avatar-face/paint | New avatars | Point a ComfyUI server at Comfy Desktop, or use the bundled avatar |
| WSL + services/wakeword-trainer | Training new wake words | The bundled wake words still work |

The installed app does not read a `.env` file. Keys go in through the app (Models and servers), which keeps them
in Windows Credential Manager.

Two behaviours differ from dev on purpose: the installed app does **not** add itself to start at sign-in
(`ENABLE_AUTO_LAUNCH=1` turns that on), and it opens full screen with Escape to leave, not as a locked kiosk
(`AIEMBODIED_KIOSK=1` for an appliance).

## Setting up a second PC (mutiara)

There are two ways to use it. The satellite is the one that needs nothing on the PC but Tailscale.

### A. As a room of bija (recommended)

bija stays the brain (models, memory, keys); this PC draws one room, plays the voices and uses its own
microphone. See [features/satellite.md](features/satellite.md).

1. Install Tailscale (https://tailscale.com/download) and sign in to the same tailnet as bija.
2. Run the setup exe and start **AI Embodied Room (satellite)**.
3. On bija: Settings > Places > "Add a desktop room" shows a 6-digit code.
4. In the room window: bija's address (`ws://bija:8791`), the code, a name for the room and for this PC.
5. Optional: Status > "Start when I sign in".

bija must be running the app at the time, and Windows on bija may ask to allow it through the firewall (private
networks only).

### B. On its own

Start **AI Embodied Assistant**. Then open **Models and servers** in the controls:

1. Give the built-in OpenAI server an API key.
2. Route Thinking, Hearing, Speaking and Moving to OpenAI.

That gives a talking avatar with the wake word. Long-term memory, web search and avatar generation stay off
unless their services are set up by hand (see `scripts/install-windows.ps1`, which needs the repo).

## How the build works

`scripts/build_windows_installer.py`:

1. `pnpm build` (main and renderer).
2. Stages a self-contained copy of the app in `build/windows-stage`: `pnpm deploy --prod` with a hoisted
   (flat) `node_modules` at the lockfile's versions, the built main and renderer, and the assets.
3. Runs electron-builder with `packaging/windows/electron-builder.yml` on the stage.

Notes:

- No asar: the wake word and retexture code run in worker threads, and onnxruntime reads its models from disk.
- No native rebuild: keytar, better-sqlite3, onnxruntime-node and pvrecorder all ship N-API prebuilds.
- The repo-root `electron-builder.yml` (used by `pnpm dist` and the Linux AppImage workflow) is unchanged.
