# Local avatar face fitting

Run `pnpm avatar:face:setup` once from the repository root. This creates a separate
Python environment, installs the pinned CPU detector dependencies, and downloads
the versioned MediaPipe Face Landmarker model with SHA-256 verification. Python
3.13 and Blender 5.2 were used for the Windows MVP. No cloud service or resident
face server is used during fitting or avatar playback.

Main's `BlenderCharacterRunner` discovers `.venv/Scripts/python.exe` on Windows
(`.venv/bin/python` elsewhere) and `models/face_landmarker.task` here. Override
`AVATAR_FACE_DIR`, or set `AVATAR_FACE_PYTHON` and `AVATAR_FACE_MODEL` explicitly.
Packaged installations must provision this environment separately and configure
absolute paths; the Electron package does not bundle Python. `BLENDER_EXE` selects
Blender when automatic Windows discovery is unsuitable.

After image approval, the finite detector checks the reference before any mesh
generation. It requires one front-facing adult humanoid in full-body view on a
white background, open eyes, closed lips, and an uncovered face. Failure stops the
job; it does not substitute the old generic eyes/mouth. A successful check writes
478 landmarks and an annotated reference to the job directory. Blender then fits
known face topology to those landmarks and the generated front head surface,
replaces the underlying face, projects the reference appearance, and authors the
speech/emotion/blink/gaze morphs. Face fitting runs on the CPU; image and body mesh
generation still use the shared ComfyUI runtime.

The template is Google's MediaPipe canonical face surface (Apache 2.0 asset and
notice in `app/main/assets/avatar-generation/face-template`). It is modified in
memory to remove its eye and mouth caps. This is a front-surface replacement,
not full anatomical head reconstruction: the generated rear head, ears, body and
hair remain. Eyeballs/irises and a lip-following recessed mouth interior are added.
There are no teeth or tongue yet. Source shading is projected, not recovered as
lighting-independent skin. A single image cannot reveal unseen facial detail.

The MVP is intentionally constrained. Hair/face and jaw seams, coarse topology,
approximate lips and imperfect likeness remain visible. Strong profiles,
occluded/nonhuman faces, extreme proportions and arbitrary backgrounds are not
supported. The detector can fail on stylised faces. An exported expression is
checked structurally and in the demonstration, but visual acceptance is still
required. Existing avatars and shoulder/motion calibration are unchanged.

## Reproduce the five-character demonstration

From the root, after `pnpm build` and setup:

1. `node scripts/avatar-face-demo/generate.mjs` — ComfyUI image and TRELLIS.2
   generation with recorded prompts/seeds. Resumes existing outputs. No library
   import, active-avatar change or user configuration write occurs.
2. `node scripts/avatar-face-demo/fit.mjs` — local detection, fitting and VRM export.
   Set `BLENDER_EXE` outside the tested Windows installation. The script can wait
   for geometry while generation proceeds. It also saves inspectable Blender scenes
   and diagnostic renders locally; those intermediate scenes are not checked in.
3. `node scripts/avatar-face-demo/review.mjs` — hidden, isolated Electron review
   using the same three-vrm library as the app. Loads the exported VRMs, exercises
   all six emotions, five speech shapes, blink and iris gaze, verifies vertex
   movement, and renders 48 interpolation frames per avatar. Export defaults must
   be zero so a neutral face stays neutral when expression controls reset.
4. `services/avatar-face/.venv/Scripts/python.exe scripts/avatar-face-demo/report.py`
   (use `.venv/bin/python` on other systems) — comparison HTML, a five-row emotion
   table and five animation GIFs from the actual exported runtime renders.

Evidence lives in `artifacts/local-face-mvp-2026-10-31/`. Open `comparison.html`.
The five VRMs can be uploaded using the existing model upload control when desired.

References: [MediaPipe local Python inference](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/python),
[canonical geometry](https://github.com/google-ai-edge/mediapipe/tree/master/mediapipe/modules/face_geometry/data),
[VRM expression contract](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/expressions.md).
