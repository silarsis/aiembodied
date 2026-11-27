# Architecture

How aiembodied is put together, and how to decide where a new feature goes. This describes the system as it is now
(late 2026). The original MVP documents (`docs/history/mvp-*.md`) are background only. Each feature's details live in
its own doc in [`docs/features/`](features/README.md), and the coding rules are in [`AGENTS.md`](../AGENTS.md).

## The shape of it

```
                 ┌──────────────────────── bija (Windows, 128 GB) ───────────────────────────┐
                 │                                                                           │
 mic / camera ──►│  Renderer (Vite + React + three.js)     Electron main (Node)              │
 screen      ◄───│  stage, VRM avatars, 3D rooms,  ◄─IPC─► config, SQLite, model routing,    │
                 │  audio capture/playback,       preload  voice turns, floor, places,       │
                 │  settings pop-ups               bridge  stations, pursuits, MCP/tools,    │
                 │                                         wake word worker, room hub        │
                 │                                              │ HTTP / WebSocket           │
                 │        ┌──────────────┬───────────────┬──────┴───────┬──────────────┐     │
                 │   model servers   speech :8192   motion :8190   memory :8194   switchboard │
                 │   llama-server    (STT/TTS)      (text→motion)  (Postgres     :8196       │
                 │   :1234 LLM                                     +pgvector)                │
                 │   :1235 STT       workflows :8198 + Temporal :7233   coder :8195          │
                 │   :1237 vision    laya :8197 (quick decisions)       searxng :8888        │
                 │   ComfyUI :8188   aicontroller :8200 (optional GPU lease manager)         │
                 └──────────────────────────────▲────────────────────────────────────────────┘
                                                │ room link (WebSocket :8791, Tailscale only)
                           other PCs (satellite Electron), phones (Android shell), browsers
```

Three kinds of process, each with a fixed job:

1. **Electron main** (`app/main/src/`) owns everything stateful and everything that talks to the outside: config and
   secrets, the SQLite store, which server does each model job, the voice loop, who speaks, where avatars are, tools,
   and the clients for every service. It is the only process that holds keys.
2. **Renderer** (`app/renderer/src/`) draws and plays: the avatars and rooms, the mic graph, audio output, lip-sync,
   motion playback and the settings UI. It holds no secrets and reaches main only through the preload bridge.
3. **Python services** (`services/*`) are small HTTP servers, each doing one heavy or model-bound job with its own
   venv, README, tests and port. `pnpm dev:run` (`scripts/local-services.mjs`) starts the ones this PC's model routes
   use; main itself starts only a few on demand (ComfyUI, and llama-server swaps for coding or head painting). The
   app keeps working, with less, when one is down.

Model servers (llama-server, ComfyUI, STT, vision) are not ours. They are reached through **model routing**
(`shared/config/model-routing.ts`): each *use* (thinking, speaking, motion, image, idle, decide ...) has an ordered
list of servers with backups, set in the Models and servers pop-up. Any server can live on another machine.

## Boundaries that are enforced

- **main ↔ renderer**: the renderer imports main only as types. Runtime code both need is in
  `app/main/src/shared/<feature>/`, which is pure TypeScript: no Electron, no Node, no npm packages. ESLint enforces it.
- **The preload bridge** (`shared/bridge/create-bridge.ts`) is the one list of calls and events the page can use.
  The Electron preload builds it on `ipcRenderer`, and the web satellite builds the same API over the room link.
- **IPC handlers** live in each feature's `ipc.ts` (`registerXIpc({ handle, ...deps })`). `main.ts` builds services and
  wires features; it holds no handlers. `handle` remembers each handler, so the room hub can run the same function
  for a satellite.
- **Satellites**: every channel is sorted once in `shared/satellite/channels.ts` (forward to bija, answer locally,
  unavailable, or event), and bija's hub allowlist (`room-hub/allowlist.ts`) decides what a satellite may call. A test
  fails for an unsorted channel.
- CI also checks formatting, import cycles, unused exports (against a baseline), Python types and file sizes (see
  AGENTS.md, Testing & Verification).

## How things flow

**A voice turn.** The wake word worker in main (openWakeWord on onnxruntime-node), push-to-talk or a tap opens
listening. The renderer captures and segments speech and sends a WAV through `local-voice:transcribe` (speech service
or a separate STT server). `local-voice:respond` goes to the **floor** (`floor/`), which picks which avatar answers
(quick-decision model first, then the chat model, then a default). That avatar's `LocalVoiceService` builds the prompt
(persona, places note, scene text, memory brief and recall). It streams the LLM with tools, speaks each sentence
through TTS and sends `local-voice:event`s back. The renderer plays each avatar's audio on its own output, drives
visemes from it, and turns `{move:}` / scene tags into motion (motion service) and scene actions. Messages are
saved in SQLite and queued for the memory engine through an outbox.

**Memory.** SQLite (`memory/memory-store.ts`) is the app's own store: settings, history, outbox, reading notes. Long-term
memory is the memory engine (`services/memory`), which handles turns, facts, summaries, hybrid search and an optional
mirror. Main writes to it only through the outbox, so the engine may be down. It reads directly for the brief, recall
and the Memory panel.

**Places.** Every screen is a place. `places/place-manager.ts` knows which avatar is where. bija's own screen is `home`,
and other PCs and phones are paired places that draw one room each over the room link. Moves are two-phase (walk out, arrive).

**Agent time.** Each avatar has a life workflow on Temporal (`services/workflows`). The workflow calls back into the app
with `agent.act` (think, say, use a tool, ask, start a pursuit, sleep), and `agent-time/` answers it. Pursuits
(`pursuits/`, e.g. reading at a station) run on the avatar's own model, one at a time, so conversation always has a slot.

**Events.** The switchboard (`services/switchboard`) journals events (turns, tool calls, approvals, decisions). For now
the app only mirrors onto it, and nothing waits for it.

## Deciding where a new feature goes

Work through these in order; the first that fits decides.

1. **Is it a fast fixed-choice judgement** (route, triage, yes/no, gate an LLM call)? Use the Quick decisions route and
   `SystemOneClient` (`decide/system-one.ts`), with a threshold and a fallback. Don't write a new LLM prompt for it.
2. **Does it need a model or a heavy library** (PyTorch, ONNX models, Blender, Postgres, a long-running worker)?
   - A model someone else serves (chat, vision, image): add a *use* to model routing and call the routed server. Don't
     hard-code a URL or a provider.
   - Our own heavy or Python-only work: a service in `services/<name>/` with its README, tests, start script and port,
     added to `scripts/local-services.mjs`. The app must keep working when it is down, and say so in the status panel.
3. **Does it own state or talk to the outside** (files, keys, network, the OS)? It goes in main, in
   `app/main/src/<feature>/`, with a small public surface (rule 1). If it needs settings, they go in preferences, and keys go
   in the key store, never to the renderer.
4. **Does the UI need it?**
   - Add calls to the bridge (`create-bridge.ts`), register the handlers in `<feature>/ipc.ts`, and sort each new
     channel in `shared/satellite/channels.ts`. Ask whether a satellite should forward it (it then also needs the hub
     allowlist), answer it locally, or treat it as unavailable.
   - Types and pure logic both sides use go in `shared/<feature>/`.
   - UI goes in `app/renderer/src/<feature>/`, with effects in named hooks.
5. **Does an avatar use it as a tool?** Register it in the `ToolRegistry` with a confirmation level (none, notify,
   confirm, block) chosen by what it can change; Home Assistant tools that touch locks, alarms or garages get `confirm`,
   for example. If it belongs to a room object, make it a station.
6. **Does it run on its own, over time** (reminders, watching, plans)? It is agent time: a workflow or a tool of
   `services/workflows`, not a timer in main.
7. **Does it differ per avatar or per place?** Key it by avatar id (`avatars/avatar-settings.ts`) or place id from the
   start. One avatar and one place are just the common case.

Then:

- Write or update `docs/features/<feature>.md` (what it does, how it fits, decisions and limits).
- If the change moves a boundary (a new layer, a new service, a new kind of IPC), put a before/after sketch in the PR and
  update this file.
- Prefer extending an existing pattern to adding a second one beside it. If the pattern is wrong, fix it first.

## Where to find more

- Feature docs: [`docs/features/`](features/README.md).
- Service docs: each `services/<name>/README.md`.
- Satellites and the room link: [`satellite.md`](features/satellite.md),
  [`room-link-protocol.md`](features/room-link-protocol.md).
- Why things are the way they are: [`history/decisions.md`](history/decisions.md). The original MVP spec is in `history/mvp-*.md`.
- Open work: [`TODO.md`](TODO.md).
