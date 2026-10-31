# New 3D character generation: experimental MVP

The new-character option generates a new mesh instead of repainting the bundled avatar. The previous recolour option remains separate. This is an early, constrained character pipeline, not a finished arbitrary-character modeller.

## Use

Restart the rebuilt app. In Controls > Character > Create an avatar, choose **New 3D character (experimental)**. Choose **Text description** or **Upload an image**. Uploads accept PNG, JPEG or WebP up to 4096 x 4096 pixels and 25 MB, and skip image generation. For text input, describe an adult stylised humanoid with short or swept-back hair. Clothing is optional; keep limbs clearly separated. For example: “A friendly woman explorer with swept-back auburn hair, a rounded face, a sage-green jumpsuit with orange shoulder panels, and tan boots.”

The pipeline now generates a visible neutral face in the A-pose reference, then fits it for animation locally. Use one full-body adult human character on a plain white background, with open eyes, closed lips and an uncovered front-facing face. Local MediaPipe landmarks fit a known facial surface to the reference and generated head; its skin appearance and iris colours come from that reference. Face/hair and jaw seams, approximate lips, coarse surfaces and imperfect likeness remain visible. Teeth and tongue are not implemented. Clothing and hair shapes come from the generated mesh. Long hair, skirts, capes and similar surfaces bridging body parts remain unsupported. Fingers do not articulate; hair physics and shoulder/elbow deformation still need work. The generated face has iris gaze morphs; automatic conversational gaze targeting is separate future work.

The concept or uploaded reference appears as a small thumbnail; click it to open a full-size modal popup. Escape or Close dismisses the popup without closing the drawer. Generation stops at image review, including for recolouring: only **Use this image** starts geometry/rigging or texture work. While a text-generated image is awaiting approval, edit the prompt and select **Regenerate image** to discard the pending job and generate a replacement. The replacement requires its own approval. If replacement generation fails, the edited prompt remains available to retry. Discard deletes the pending reference job. If a dependency is unavailable when continuing, the reference remains available to retry. Uploads can be reviewed while ComfyUI is offline.

After that work finishes, review the **finished model**, rather than the concept illustration. Keep imports that candidate and activates it. Discard leaves the previous avatar selected. A failed generation is reported as a failure; it never falls back to a recoloured original avatar.

Click the finished-model thumbnail to open the interactive 3D inspector. Drag to orbit, scroll or pinch to zoom, and right-drag or use two fingers to pan. Front / reset, Side and Back restore full-body views; Expression tests the expression controls actually present in that VRM. Close or Escape returns to Keep/Discard. The viewer uses the exact candidate bytes and a separate scene, so inspecting never changes the active avatar. Its graphics resources are released on close. Concept thumbnails continue to open a still-image popup.

Generation currently consumes one front reference, not a front/side/back set. Consistent additional views could help a future multi-view mesh/texture pipeline recover unseen surfaces, but do not themselves provide animation topology, skin weights or a calibrated skeleton. Multi-view conditioning and fitting remain separate future work.

The inspector code is bundled with the renderer, while model loading and graphics allocation wait until its popup opens. This avoids a stale open app trying to fetch a hashed viewer chunk removed by a later development rebuild. Restart an already-open older build once to load this change; reopening its popup alone cannot update the loaded interface code.

New-character image wrappers do not mention clothing or particular garments, including in fixed negative prompts. Appearance comes from the user's description; anatomy guidance asks for separated limbs and clear gaps. This prevents hidden apparel instructions from competing with the description, but does not guarantee how an image model interprets it. The separate recolour workflow still operates on the bundled model's existing outfit textures.

New-character prompts across all image families also request smooth continuous facial surfaces, hair clear of the cheeks/jaw, fully closed lips, shallow eye sockets and even lighting. These hints reduce image ambiguity; they cannot guarantee the geometry model produces a simple head surface. A “Head cut produced more than one boundary” failure means the replacement region has multiple separate edge loops. It remains blocking because the current stitcher requires one loop; a prompt alone cannot repair an existing mesh. Regenerating may help, while reliable recovery requires separate mesh cleanup or more capable face transfer.

Image workflows for every supported model family request moderate humanoid proportions, a head around one sixth of full height, a visible neck and separated limbs. On image confirmation, local landmark measurements check face width, height and vertical placement before geometry starts. References outside the tested template show their compatibility warnings in the Character controls. Edit and regenerate the image, discard and upload another, or explicitly select **Accept warnings — continue anyway** to attempt the rig. The first image approval cannot also accept unseen warnings. This choice applies only to that job; it does not calibrate body joints. Missing faces, invalid geometry, failed face cuts and invalid exports still stop generation. Keep remains a separate final review decision.

The main-process preflight and Python fitter share `app/main/assets/avatar-generation/template-policy.json`. Warning acceptance is recorded in job-local `review.json` and the exported VRM's `extras.aiembodiedGeneration` metadata.

The local detector accepts white and mildly shaded off-white neutral backgrounds. It samples the border rather than rejecting a single grey corner, and excludes the estimated background when measuring the figure. Dark or coloured scene backgrounds and blank references remain unsupported; this check does not segment arbitrary scenes.

## Dependencies and ownership

- Shared local ComfyUI server with Qwen-Image 2.1 and the TRELLIS.2/BiRefNet/DINO models used by `character/trellis2.graph.json`.
- Blender, found under Program Files/Blender Foundation on Windows or selected with `BLENDER_EXE`. No Blender extension is installed or required.
- Run `pnpm avatar:face:setup` once for the separate local CPU detector environment and checksum-verified model. `AVATAR_FACE_DIR`, or `AVATAR_FACE_PYTHON` and `AVATAR_FACE_MODEL`, override discovery. See [local face setup and reproduction](../../services/avatar-face/README.md). The environment is installed on the development machine; packaged installs must provision it separately with absolute paths.
- The existing named avatar-generation IPC bridge; completed candidates are read through `avatar:generation-preview` without importing them.
- Main owns job files and persistence. Blender runs in a finite subprocess with a five-minute timeout and an abort signal. Comfy cancellation targets the individual prompt; older servers can remove the queued job without globally interrupting other work. The pipeline never calls `/free`.

Windows ComfyUI startup uses asynchronous PowerShell with ignored launcher stdio, matching the local-service launcher. Piped stdio can remain inherited by the background server and falsely time out even after it starts. `Start-Process` still provides the hidden console needed by the Python environment; do not use Node's detached mode as a substitute. Server output is redirected to `comfyui.log`/`comfyui.err.log`; launcher failures go to `comfyui-startup.err.log`. The app polls server health separately and shows a concise launch failure rather than an encoded command.

Each rigging attempt saves Blender stdout/stderr to `blender.log` in its job directory. Python exceptions are treated as failures even when Blender returns exit code zero, and the actual exception is shown in the app. A missing model without a specific exception points to that log instead of guessing that limbs were fused. The tested face-width range is 6%-22% of normalized character height; detected faces outside that range report the measured percentage as an advisory warning with explicit override. Passing face landmark detection alone does not guarantee that the fixed human body/head template supports a stylised character's proportions.

## Stages

1. Qwen generates an animation-friendly reference from the description, or the renderer converts a selected PNG/JPEG/WebP to PNG and main validates it.
2. The job stops in `awaiting_confirmation`. `avatar:generation-confirm-concept` is the only entry to subsequent generation; the UI cannot accidentally advance by polling or opening the preview.
3. A finite local detector checks the approved reference before expensive geometry generation. A missing/obscured/unsupported face fails clearly; no generic face is substituted. TRELLIS.2 then generates geometry, UVs and textures; the shared Comfy client downloads the GLB.
4. Blender normalises the model, fits an anatomical skeleton, creates region-constrained movement weights and bakes the generated A-pose to T-pose.
5. Blender fits the known facial topology to the detected landmarks and sampled head depth, replaces the underlying front face, removes eye/mouth caps, projects reference appearance, and adds recessed eyeballs/irises and a lip-following mouth interior. Shape keys implement speech, real eyelid closure, gaze, and six emotions. Fear/disgust are custom VRM expressions. The generated rear head, ears and hair remain.
6. The exporter writes the humanoid mapping and expression bindings into VRM 1.0, preserving the generated skin and textures. It rejects empty or implausibly proportioned meshes, missing facial placement and unweighted vertices.
7. The renderer loads the VRM to create its review image. Keep is disabled until that succeeds. Acceptance passes those exact VRM bytes through the model service.

The body still uses geometric joint fitting. The face now uses ML landmarks and known topology, with an approximate orthographic image-to-mesh alignment. Fitting checks surface coverage, open neutral eyes, closed blink boundaries, expression bindings and zero exported default morph weights. These checks do not guarantee good likeness or deformation. Visual review remains necessary. Next work: seam repair, richer lip/eyelid topology, teeth/tongue, improved head fitting, better body joints/weights and semantic segmentation.

## Local face MVP evidence

`artifacts/local-face-mvp-2026-10-31/comparison.html` contains five distinct ComfyUI characters, their references, six emotions per exported avatar, and animated speech/blink/smile previews. These are actual three-vrm renders from the generated VRMs, not separately generated expression pictures. The same runtime check exercises five speech shapes and gaze, verifies movement, and records fitting diagnostics. The five VRMs are included for optional model upload. The review never changes the user's active model or saved preferences. Reproduction commands and limits: `services/avatar-face/README.md`.

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

## Face seam refinement

The replacement now has a connected bridge to the actual head cut, with matching head weights and a fixed expression perimeter. The original overlapping strip is removed. A small inset is resampled onto the head, and boundary appearance is matched using skin calibration and reference texture detail. The same five source characters were rebuilt and compared at identical camera framing, including expressions, three-quarter views and head turns during speech. See `artifacts/face-seam-review-2026-10-31/seam-comparison.html`. Exported geometry checks verify the shared positions, two triangles per join edge, head weights and zero expression drift. This is continuity across separate skinned primitives, not a single indexed watertight mesh. Single-view hair/ear/neck shading still has visible limits. Existing saved avatars are unchanged; regenerate or upload a rebuilt review VRM.
