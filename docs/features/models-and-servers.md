# Models and servers

**Status:** Shipped (untested on bija at merge time)

Controls → Voice & engine → **Open models and servers** opens one pop-up that covers every job a model does in the app. Each job says which server runs it, which model it asks for, and which servers to try if that one is busy or down. Changes apply straight away; there is no Save button.

## Jobs

| Group | Job | Server kinds | Backups | Notes |
|---|---|---|---|---|
| Talking | Hearing (`stt`) | Speech service, transcription server, OpenAI | Yes | The speech service uses the recogniser it was started with. |
| Talking | Thinking (`llm`) | Chat model server, OpenAI | Yes | No retry once a reply has started streaming, or after the user stops it. |
| Talking | Speaking (`tts`) | Speech service (Kokoro voices), OpenAI (Realtime voices, speaking style) | Yes | |
| Talking | Moving (`motion`) | Motion service, OpenAI | No | OpenAI here means keyframe clips from the Animation clips job. `pnpm dev:run` starts this PC's motion service with the picked model (ardy or kimodo), and restarts one that answers but reports its model failed to load (`/health` status `error`). |
| Talking | Web search (`search`) | SearXNG, Brave Search | Yes | "Off" removes the `web_search` tool. |
| Creating an avatar | Concept image (`image`) | ComfyUI | Yes, plus spread | Also texture repaints and backgrounds, and the pictures of room objects made for 3D rooms (see [3D rooms](3d-rooms.md)). Model is the image model picker from the studio. |
| Creating an avatar | 3D model (`mesh`) | ComfyUI | Yes, plus spread | Hunyuan3D 2mv (default) or TRELLIS.2 picker. Painting and rigging always run in Blender on this PC. Room objects made for 3D rooms use this job too, from a single picture: TRELLIS.2 when it is installed, else Hunyuan3D 2mv from the front image alone; no Blender step. |
| Helpers | Describe the avatar (`describe`) | Chat model server, OpenAI | No | Needs a model that reads images. Starts out on the built-in **Vision model on this PC** (`local-vision`, Qwen3-VL 8B), which the app starts only while a description is made (see [Vision model](#vision-model-on-this-pc)). The request asks for at most 300 tokens at temperature 0.3, so any chat model replies with a short description. |
| Helpers | Make poses (`posegen`) | Chat model server, OpenAI | No | Not listed in the dialog: nothing in the app makes poses since the sidebar pose controls went. The route stays in the config. |
| Helpers | Check poses (`posecheck`) | Chat model server, OpenAI | No | Needs a model that reads images. Not listed in the dialog, as for Make poses. Its default route is the same local vision model as Describe the avatar, started the same way. |
| Helpers | Animation clips (`clips`) | Chat model server, OpenAI | No | Only Moving's fallback: animation requests use the motion service (ARDY) whenever it is ready. Starts out on the same server and model as Thinking and follows it until you pick something else here. |
| Rooms | Idle thoughts (`idle`) | Chat model server, OpenAI | Yes | Picks what the avatar does next on its own in a 3D room (see [3D rooms](3d-rooms.md)). Starts out on the same server and model as Thinking, backups included, and follows Thinking until you pick something else here. A small, fast model is enough: it gets one short prompt, no history, memory or tools, and answers in under 80 tokens. A failure or a 15 s timeout falls back to a random pick, so a slow or missing model never freezes the avatar. |
| Rooms | Room layout (`scenelayout`) | Chat model server, OpenAI | Yes | Writes the furniture list and layout when you describe a 3D room (see [3D rooms](3d-rooms.md)). Starts out on the same server and model as Thinking, backups included, and follows Thinking until you pick something else here. One request (temperature 0.4, about 2500 tokens) that asks for a JSON object; a bigger model gives better rooms. An unusable reply is retried once with the problem, then the build fails with a message. |

The Conversation engine item (step by step or OpenAI Realtime, and the Realtime voice) sits at the top of the rail. The wake word stays under Devices & wake word.

## Servers

Built in: Language model on this PC (`local-llm`), Speech service on this PC (`local-speech`), Motion service on this PC (`local-motion`), ComfyUI on this PC (`local-comfy`), SearXNG on this PC (`local-searxng`), Vision model on this PC (`local-vision`, http://127.0.0.1:1237/v1), OpenAI (`openai`), Brave Search (`brave`) and Civitai (`civitai`, only a key for model downloads). A built-in server's name and address can be changed; one pointed away from 127.0.0.1/localhost is no longer started by the app or `pnpm dev:run`.

Setup → Servers → **Add a server** adds a machine of your own: a chat model server (any OpenAI-compatible `/v1`: llama-server, LM Studio, vLLM, Ollama), a transcription server, a speech service or motion service from this repo, ComfyUI, or SearXNG. **Test** (and **Refresh list** on the server or job page) reads the server's model list (`/v1/models`, ComfyUI's `/models/{folder}`, the speech service's `/health`) so the model fields can suggest names. Adding from a job's "Runs on" list picks the new server for that job. A job's Model list only shows what its picked server reports (image and 3D lists come from the step's first ComfyUI), with "Type a name…" for anything else. A chat or transcription address with no path gets /v1 added.

## Vision model on this PC

Describe the avatar sends an avatar screenshot to a model that reads images. By default that is **Qwen3-VL-8B-Instruct** (Q4_K_M, with its F16 vision projector), about 6 GB on disk and a little more in memory. The main language model already holds around 86 GB of bija's unified memory, so a small model that only runs when needed was chosen over keeping a second one loaded. The built-in server `local-vision` (type chat, `http://127.0.0.1:1237/v1`, model alias `qwen3-vl`) is the default route for `describe` and `posecheck`; a route you saved wins, and a route to OpenAI or a server on another PC never starts anything.

- **Download.** On the Describe the avatar page, while it runs on this PC's vision model, a status line reads Not downloaded, Downloading 43% or Ready with the file names and size. **Download vision model (~6 GB)** fetches the model GGUF and the mmproj GGUF from `ggml-org/Qwen3-VL-8B-Instruct-GGUF` (falling back to `unsloth/Qwen3-VL-8B-Instruct-GGUF`) with the same resumable, SHA-256 checked downloader as Thinking models, into `<LOCAL_LLM_MODELS_DIR or ~/.cache/aiembodied/llm-models>/vision/<owner>--<repo>/`. File names are read from the repo listing: the `Q4_K_M` model (never an mmproj file) and the mmproj, preferring F16, then BF16, then Q8_0. The Hugging Face account's token (Servers → Hugging Face) is used if set. Cancelling keeps the partial file, and downloading again resumes.
- **Another model.** **Use another model…** takes a link, `owner/repo` or `owner/repo:QUANT`, as on the Thinking page. A repo without an mmproj file is rejected ("has no mmproj file, so it can't read images"). The pick is saved as `{repo, model, mmproj, alias}` (absolute file paths) in `<userData>/local-vision.json`.
- **Starting.** `app/main/src/local-vision/vision-server.ts` starts it when a job needs it: if `127.0.0.1:1237` already answers it is used as is, otherwise `scripts/start-local-vision.ps1` runs in a hidden console (`-Model`, `-Mmproj`, `--alias qwen3-vl`, context 8192, `--parallel 1`, `-ngl -1`, `--jinja`, device `Vulkan0`; llama-server from `LLAMA_SERVER_EXE` or the Unsloth build folder). Output goes to `vision.log` and `vision.err.log`, and the process id to `vision.pid`, in the app's logs folder, so the app stops it when it quits. The app waits up to 180 s for `/health` (llama-server answers 503 while loading). Jobs that arrive together share one start. Without the downloaded files the job fails with "Download the vision model in Models and servers → Describe the avatar first."
- **Stopping.** Each job releases the server when it ends; ten minutes with no job stops a server the app started (the timer restarts with every job). One that was already running is left alone.
- **`pnpm dev:run`** never starts it (`scripts/local-services.mjs` has no entry for it, and Describe the avatar on `local-vision` does not keep the language model on).

## Backups and spreading

Backups are tried in the order they were picked. A backup of the same kind as the first server asks for the same model; a backup of another kind (for example OpenAI behind a local chat server) uses its own default.

For ComfyUI jobs, each stage picks its server when it starts: the first that answers, or with **Send each job to whichever of these has the shortest queue** the one with the shortest `/queue`. Every ComfyUI server in the list needs the same models and custom nodes installed. This PC's ComfyUI is started on demand as before; remote ones must already be running.

## Downloading models from Civitai

Open a ComfyUI server (Setup → Servers → the server), paste a Civitai link or AIR under **Download a model**, and press **Look up**. The app asks Civitai's API for the model and shows the file, its type, base model, size and the ComfyUI folder it goes in (checkpoints, loras, vae, embeddings, controlnet, upscale_models). Pick a version if there are several, then **Download to <server>**. Progress shows on the page; when it finishes the server's model list is read again.

Accepted: `https://civitai.com/models/4201/name?modelVersionId=130072`, `https://civitai.com/models/4201` (newest version), `https://civitai.com/api/download/models/130072` (with `?fileId=` it takes that file), `urn:air:sdxl:checkpoint:civitai:4201@130072`, or `4201@130072`. civitai.green and civitai.red links work the same. Many models need a Civitai API key: add it on Setup → Servers → Civitai (or set `CIVITAI_API_KEY`).

Files are written as `<name>.part` and renamed once complete and, when Civitai lists one, once the SHA-256 matches, so ComfyUI never lists a half-downloaded file. Only an image checkpoint whose base model the app has a workflow for (SDXL, Pony, Illustrious, NoobAI, SD 1.x) shows up under Concept image; LoRAs and other types still download, with a note saying the image step won't use them.

- **This PC:** the app runs `aiembodied_downloader.py` with ComfyUI's own Python, so files land in the folders ComfyUI reads (including Comfy Desktop's extra model paths).
- **Another machine:** install the aiembodied ComfyUI add-on there once. Copy `app/main/assets/avatar-generation/comfyui-aiembodied` (the server page shows the full path) into that machine's `ComfyUI/custom_nodes/` and restart its ComfyUI. It adds no nodes, only `/aiembodied/*` routes: ping, model descriptions, and start, follow and cancel a download. The Civitai key is sent with each download request and not stored there. Like ComfyUI itself, anyone who can reach that ComfyUI can use the routes, so keep it on your own network or Tailscale; `AIEMBODIED_DOWNLOADS=0` in its environment turns downloads off.
- With the add-on installed, the app also gets that machine's model kinds from the file contents, as it does on this PC, instead of guessing from file names (Pony and Illustrious checkpoints are SDXL but their names often don't say so).

### LoRAs

A download from Civitai also saves what Civitai says about the file beside it, as `<name>.aiembodied.json`: its name, base model ("SD 1.5", "Pony"…), family (`sd1`, `sdxl`, `z-image-turbo`) and trigger words. The add-on and this PC's scan list LoRAs with that family; for a LoRA without the file the family is read from its tensors (the cross-attention width, or kohya's `ss_base_model_version`), and its trigger words are unknown.

In the avatar studio, **LoRAs** under the image model lists them. Only a LoRA of the chosen model's family can be ticked; a ticked LoRA has a strength (0–2, default 0.8) and its trigger words lead the prompt. The choice is kept across restarts (`avatar.imageLoras`), and a ticked LoRA of another family is skipped rather than applied. Checkpoints get `LoraLoader` (model and text encoder); diffusion models get `LoraLoaderModelOnly`.

A LoRA whose family has no model on the image step's server offers **Suggest a model**: the most downloaded Civitai checkpoints for its base model, with the ones that fit the server's GPU (file size under 85% of `vram_total` from ComfyUI's `/system_stats`) first and the rest marked "too big for the GPU". **Download** sends one to that server the same way as the server page. Free disk space isn't reported by ComfyUI, so only the file size is shown.

Without the add-on (version 2 or later) a remote server's LoRAs are listed by name only, with no family, and can't be ticked.

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
- `app/main/src/rooms/room-layout-llm.ts`: the Room layout request (`generateRoomLayout`), failing over like Thinking.
- `app/main/src/rooms/asset-library/generated-source.ts`: room objects made from the Concept image and 3D model jobs (picks each stage's server through `comfyui-pool.ts`).
- `app/main/src/rooms/idle-thoughts.ts`: the Idle thoughts request (`pickIdleActions`, IPC `rooms:idle-pick`), failing over like Thinking.
- `app/main/src/openai/chat-completions-responses.ts`: lets the helper jobs (written for OpenAI's Responses API) run on any chat server; `max_output_tokens` and `temperature` are passed on as `max_tokens` and `temperature`.
- `app/main/src/local-vision/vision-model.ts` (download and `local-vision.json`) and `vision-server.ts` (on-demand start, idle stop): the vision model. IPC: `models:vision-status`, `models:vision-download`, `models:vision-cancel`. UI: `app/renderer/src/settings/vision-download.tsx`.
- `app/main/src/avatar/generation/comfyui-pool.ts`: ComfyUI server choice per stage.
- `app/renderer/src/settings/models-dialog.tsx`: the pop-up.
- IPC: `models:get`, `models:probe`, `models:save-server`, `models:remove-server`, `models:set-route`, `models:set-key`.
