# Models and servers

**Status:** Shipped (untested on bija at merge time)

Controls → Voice & engine → **Open models and servers** opens one pop-up that covers every job a model does in the app. Each job says which server runs it, which model it asks for, and which servers to try if that one is busy or down. Changes apply straight away; there is no Save button.

## Jobs

| Group | Job | Server kinds | Backups | Notes |
|---|---|---|---|---|
| Talking | Hearing (`stt`) | Speech service, transcription server, OpenAI | Yes | The speech service uses the recogniser it was started with. |
| Talking | Thinking (`llm`) | Chat model server, OpenAI | Yes | No retry once a reply has started streaming, or after the user stops it. |
| Talking | Speaking (`tts`) | Speech service (Kokoro voices), OpenAI (Realtime voices, speaking style) | Yes | |
| Talking | Moving (`motion`) | Motion service, OpenAI | No | OpenAI here means keyframe clips from the Animation clips job. `pnpm dev:run` starts this PC's motion service with the picked model (ardy or kimodo). |
| Talking | Web search (`search`) | SearXNG, Brave Search | Yes | "Off" removes the `web_search` tool. |
| Creating an avatar | Concept image (`image`) | ComfyUI | Yes, plus spread | Also texture repaints and backgrounds. Model is the image model picker from the studio. |
| Creating an avatar | 3D model (`mesh`) | ComfyUI | Yes, plus spread | TRELLIS.2 picker. Rigging always runs in Blender on this PC. |
| Helpers | Describe the avatar (`describe`) | Chat model server, OpenAI | No | Needs a model that reads images. |
| Helpers | Make poses (`posegen`) | Chat model server, OpenAI | No | |
| Helpers | Check poses (`posecheck`) | Chat model server, OpenAI | No | Needs a model that reads images. |
| Helpers | Animation clips (`clips`) | Chat model server, OpenAI | No | |

The Conversation engine item (step by step or OpenAI Realtime, and the Realtime voice) sits at the top of the rail. The wake word stays under Devices & wake word.

## Servers

Built in: Language model on this PC (`local-llm`), Speech service on this PC (`local-speech`), Motion service on this PC (`local-motion`), ComfyUI on this PC (`local-comfy`), SearXNG on this PC (`local-searxng`), OpenAI (`openai`), Brave Search (`brave`) and Civitai (`civitai`, only a key for model downloads). A built-in server's name and address can be changed; one pointed away from 127.0.0.1/localhost is no longer started by the app or `pnpm dev:run`.

Setup → Servers → **Add a server** adds a machine of your own: a chat model server (any OpenAI-compatible `/v1`: llama-server, LM Studio, vLLM, Ollama), a transcription server, a speech service or motion service from this repo, ComfyUI, or SearXNG. **Test** (and **Refresh list** on the server or job page) reads the server's model list (`/v1/models`, ComfyUI's `/models/{folder}`, the speech service's `/health`) so the model fields can suggest names. Adding from a job's "Runs on" list picks the new server for that job. A job's Model list only shows what its picked server reports (image and 3D lists come from the step's first ComfyUI), with "Type a name…" for anything else. A chat or transcription address with no path gets /v1 added.

## Backups and spreading

Backups are tried in the order they were picked. A backup of the same kind as the first server asks for the same model; a backup of another kind (for example OpenAI behind a local chat server) uses its own default.

For ComfyUI jobs, each stage picks its server when it starts: the first that answers, or with **Send each job to whichever of these has the shortest queue** the one with the shortest `/queue`. Every ComfyUI server in the list needs the same models and custom nodes installed. This PC's ComfyUI is started on demand as before; remote ones must already be running.

## Downloading models from Civitai

Open a ComfyUI server (Setup → Servers → the server), paste a Civitai link or AIR under **Download a model**, and press **Look up**. The app asks Civitai's API for the model and shows the file, its type, base model, size and the ComfyUI folder it goes in (checkpoints, loras, vae, embeddings, controlnet, upscale_models). Pick a version if there are several, then **Download to <server>**. Progress shows on the page; when it finishes the server's model list is read again.

Accepted: `https://civitai.com/models/4201/name?modelVersionId=130072`, `https://civitai.com/models/4201` (newest version), `https://civitai.com/api/download/models/130072`, `urn:air:sdxl:checkpoint:civitai:4201@130072`, or `4201@130072`. Many models need a Civitai API key: add it on Setup → Servers → Civitai (or set `CIVITAI_API_KEY`).

Files are written as `<name>.part` and renamed once complete and, when Civitai lists one, once the SHA-256 matches, so ComfyUI never lists a half-downloaded file. Only an image checkpoint whose base model the app has a workflow for (SDXL, Pony, Illustrious, NoobAI, SD 1.x) shows up under Concept image; LoRAs and other types still download, with a note saying the image step won't use them.

- **This PC:** the app runs `aiembodied_downloader.py` with ComfyUI's own Python, so files land in the folders ComfyUI reads (including Comfy Desktop's extra model paths).
- **Another machine:** install the aiembodied ComfyUI add-on there once. Copy `app/main/assets/avatar-generation/comfyui-aiembodied` (the server page shows the full path) into that machine's `ComfyUI/custom_nodes/` and restart its ComfyUI. It adds no nodes, only `/aiembodied/*` routes: ping, model descriptions, and start, follow and cancel a download. The Civitai key is sent with each download request and not stored there. Like ComfyUI itself, anyone who can reach that ComfyUI can use the routes, so keep it on your own network or Tailscale; `AIEMBODIED_DOWNLOADS=0` in its environment turns downloads off.
- With the add-on installed, the app also gets that machine's model kinds from the file contents, as it does on this PC, instead of guessing from file names (Pony and Illustrious checkpoints are SDXL but their names often don't say so).

ComfyUI-Manager's install-model call isn't used: it only accepts models already on Manager's own curated list, and it reads the whole file into memory before writing it.

## Keys

- OpenAI: the existing `REALTIME_API_KEY` secret (environment variable first, then the system credential store).
- Brave Search: `BRAVE_SEARCH_API_KEY` from the environment, else the credential store.
- Civitai: `CIVITAI_API_KEY` from the environment, else the credential store. Used only for model lookups and downloads.
- Added servers: credential store entry `MODEL_SERVER_KEY:<server id>`, sent as `Authorization: Bearer`.

Keys never reach the renderer; the pop-up only sees whether one is set and whether it comes from the environment. ComfyUI keys are not supported yet.

## Storage and code

The servers and routes are saved under `models` in the preferences file (`StoredModels`: `servers` and `routes`). Anything not saved is derived from the provider settings and `WEB_SEARCH_PROVIDER`, so an upgrade changes nothing.

- `app/main/src/config/model-routing.ts`: types, built-in servers, default routes, `resolveModelRouting`, `routeTargets`.
- `app/main/src/config/model-server-probe.ts`: Test.
- `app/main/src/local-voice/voice-engines.ts`: Hearing, Thinking and Speaking with failover.
- `app/main/src/openai/chat-completions-responses.ts`: lets the helper jobs (written for OpenAI's Responses API) run on any chat server.
- `app/main/src/avatar/generation/comfyui-pool.ts`: ComfyUI server choice per stage.
- `app/renderer/src/settings/models-dialog.tsx`: the pop-up.
- IPC: `models:get`, `models:probe`, `models:save-server`, `models:remove-server`, `models:set-route`, `models:set-key`.
