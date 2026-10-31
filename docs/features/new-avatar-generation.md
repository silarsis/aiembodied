# New 3D character generation: experimental MVP

The new-character option generates a new mesh instead of repainting the bundled avatar. The previous recolour option remains separate. This is an early, constrained character pipeline, not a finished arbitrary-character modeller.

## Use

Restart the rebuilt app. In Controls > Character > Create an avatar, choose **New 3D character (experimental)**. Choose **Text description** or **Upload an image**. Uploads accept PNG, JPEG or WebP up to 4096 x 4096 pixels and 25 MB, and skip image generation. For text input, describe an adult stylised humanoid with short or swept-back hair and close-fitting clothes. For example: “A friendly woman explorer with swept-back auburn hair, a rounded face, a sage-green jumpsuit with orange shoulder panels, and tan boots.”

The pipeline deliberately generates an A-pose reference with an uncovered blank face so separate animated facial parts can be added. Eyes and mouth currently have a simple cartoon style; fine facial design and eye colour are not controlled by the prompt. Clothing and hair shapes come from the generated mesh, rather than the old avatar. Long hair, skirts, capes and similar surfaces that bridge body parts are outside the first version. Fingers do not articulate. Gaze and spring-bone physics are not implemented. Shoulder and elbow deformation still need improvement.

The concept or uploaded reference appears as a small thumbnail; click it to open a full-size modal popup. Escape or Close dismisses the popup without closing the drawer. Generation stops at image review, including for recolouring: only **Use this image** starts geometry/rigging or texture work. While a text-generated image is awaiting approval, edit the prompt and select **Regenerate image** to discard the pending job and generate a replacement. The replacement requires its own approval. If replacement generation fails, the edited prompt remains available to retry. Discard deletes the pending reference job. If a dependency is unavailable when continuing, the reference remains available to retry. Uploads can be reviewed while ComfyUI is offline.

After that work finishes, review the **finished model**, rather than the concept illustration. Keep imports that candidate and activates it. Discard leaves the previous avatar selected. A failed generation is reported as a failure; it never falls back to a recoloured original avatar.

## Dependencies and ownership

- Shared local ComfyUI server with Qwen-Image 2.1 and the TRELLIS.2/BiRefNet/DINO models used by `character/trellis2.graph.json`.
- Blender, found under Program Files/Blender Foundation on Windows or selected with `BLENDER_EXE`. No Blender extension is installed or required.
- The existing named avatar-generation IPC bridge; completed candidates are read through `avatar:generation-preview` without importing them.
- Main owns job files and persistence. Blender runs in a finite subprocess with a five-minute timeout and an abort signal. Comfy cancellation targets the individual prompt; older servers can remove the queued job without globally interrupting other work. The pipeline never calls `/free`.

## Stages

1. Qwen generates an animation-friendly reference from the description, or the renderer converts a selected PNG/JPEG/WebP to PNG and main validates it.
2. The job stops in `awaiting_confirmation`. `avatar:generation-confirm-concept` is the only entry to subsequent generation; the UI cannot accidentally advance by polling or opening the preview.
3. TRELLIS.2 generates new geometry, UVs and texture maps; the shared Comfy client downloads its saved GLB.
4. Blender normalises the model, fits an anatomical skeleton, creates region-constrained movement weights and bakes the generated A-pose to T-pose.
5. Blender locates the front head surface and adds separate eyes, irises, highlights, eyebrows and mouth meshes. Shape keys implement speech and emotion controls.
6. The exporter writes the humanoid mapping and expression bindings into VRM 1.0, preserving the generated skin and textures. It rejects empty or implausibly proportioned meshes, missing facial placement and unweighted vertices.
7. The renderer loads the VRM to create its review image. Keep is disabled until that succeeds. Acceptance passes those exact VRM bytes through the model service.

The first rig uses geometric landmarks, not an ML rigging model. It can still produce poor deformation even when structural checks pass. Visual review is necessary. The next development work is better joint fitting/weights and semantic topology repair, followed by a richer face rig and prompt-driven facial parameters.

## Verified sample

`artifacts/new-avatar-mvp-2026-10-31/` contains the live Qwen concept, TRELLIS source mesh, final `explorer.vrm`, the generation prompt/seed, rig report and renderer images. The sample has approximately 60,000 body triangles, 22 humanoid bones, zero unweighted body vertices and 13 expression controls: five vowels, three blink controls and five emotions.

The isolated Electron review fixture replayed those live image/mesh outputs through the production generation service, the real Blender runner and the real model importer. It verified that preview left the original active, Keep activated the new model, and the rendered soles matched the scene ground anchor. `app-verification.json` records that distinction; this fixture does not modify live app preferences or the user's avatar library.

Renderer checks load the actual VRM, apply the base stance, speech shapes, blinking, emotions and a raised-arm gesture. Unit tests cover the new-geometry route, failed rigging without a recolour fallback, mesh download, targeted cancellation and VRM 0/1 pose conversion. The original VRM 0 base stance remains unchanged apart from a coordinate-convention tag.

## Image model selection

For text-to-image, the **Image model** selector lists supported installed weights and remembers the chosen model. Refresh models rescans the configured local ComfyUI folders, including the Desktop shared library and instance-local checkpoints. While reviewing an image, another model can be selected before Regenerate image. Each job captures the model and workflow it started with; changing the preference cannot alter an existing concept or its later geometry job. Uploads bypass the picture-model selector entirely.

Main discovers models through `assets/avatar-generation/image-models.py` using the same Python environment, ComfyUI root and extra-model-paths YAML as the shared server launcher. Discovery reads bounded safetensors JSON headers, not tensor data, and does not load GPU models or start the server. It recognises supported architectures and supporting encoder/VAE weights; unreadable files, unsupported architectures, LoRAs and 3D/audio models are excluded. A known image model missing required supporting components is shown as unavailable. The current Z-Image profile requires a Turbo identifier in its filename or training metadata; ambiguous non-Turbo variants are not guessed. Discovery currently requires a local ComfyUI installation; a remote-only server has no local weight headers to inspect.

`image-workflows.ts` is the family registry. The UI chooses a model ID and main selects the workflow:

| Family | Workflow |
| --- | --- |
| Qwen-Image 2.1 | Qwen conditioning/cache, compatible Qwen3-VL encoder and RGBA VAE, 25-step sampling. |
| Z-Image Turbo | Lumina conditioning, Qwen3-4B encoder and Flux AE, shifted sampling with the installed template's eight-step settings. |
| SDXL | Bundled checkpoint/dual text encoders/VAE, 1024-pixel image workflow. |
| SD 1.x | Bundled checkpoint/text encoder/VAE, 512 x 768 image workflow. |

Compatible checkpoints use the same family implementation with different filenames. CLIP-based families receive shorter positive framing and explicit negative conditioning; Qwen/Z-Image retain the instruction-style prompt. New architectures need a detector and workflow adapter, without adding controls for encoders, VAEs or samplers. The same ComfyUI process executes all families; no additional permanent GPU server or model copy is started per choice. Texture repainting still uses its specialised Qwen editing graph, and the picture selector does not change TRELLIS or the facial rig.

The preference is stored under MemoryStore key `avatar.imageModel`. Its default is the previously selected available model, otherwise an available Qwen model, otherwise the first compatible choice. An explicitly requested missing model fails rather than silently generating with a different one. The named bridges are `avatar:image-models` and `avatar:image-model-select`.

Verification in `artifacts/image-model-review-2026-10-31/` includes live output and API graphs from all five installed model choices, plus an isolated Electron check of detection, selection persistence and regeneration using a different family. Output style and instruction adherence vary; producing an image is not evidence it is suitable for automatic rigging, so image approval remains mandatory. Architecture signature tests execute a small stdlib-only Python script (`python` on Windows, `python3` elsewhere); app discovery uses ComfyUI's own Python environment.
