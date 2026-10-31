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

Rigging attempts now keep `blender.log` beside the job files and surface Python
exceptions even if Blender returns zero. The human template's face-width guard
is 6%-22% of normalized character height; its error includes the measured value.
A large-headed stylised character can pass landmark detection but fail that
template check. Relaxing the cap alone does not calibrate the fixed neck/shoulder
positions: supporting those shapes requires proportion-aware body/head fitting.

## Stitched face boundary follow-up

New exports weld coincident input vertices before weighting (UVs remain per face
corner), then cut one connected front-head region. `face-seams.py` cleans branched
cut edges and disconnected fragments while preserving independent input parts.
It connects the fitted perimeter to the actual ordered head boundary instead of
covering the cut with an overlapping enlarged oval. Both sides have the same
head-only weights; the outer facial shape-key displacements are pinned to zero.
The exported geometry is checked for coincident joins, matching skin weights and
two triangles at each join edge across the five controlled examples.

The replacement is inset slightly to leave space for that bridge and its depth is
resampled onto the head. A skin-colour correction is fitted from corresponding
forehead/cheek/nose samples. Visible texture around the seam shares reference
coordinates; boundary baking preserves the reference's pixel detail instead of
replacing it with interpolated flat vertex colours. Hair and ears remain
approximate, especially in side views. This is positional continuity across
separate skinned mesh primitives, not a claim of one indexed watertight mesh.

`artifacts/face-seam-review-2026-10-31/seam-comparison.html` compares the same five
references and source meshes before/after, with fixed camera framing, smiles,
three-quarter views and head turns during speech. Existing saved models are not
rewritten. Regenerate a character or upload a rebuilt review VRM to use the result.

Reproduce by copying each original demo's `source.glb`, `concept.png`,
`face-landmarks.json` and `request.json`, plus `characters.json`, to a new output
directory. Set `FACE_DEMO_OUTPUT` to that directory and use the fit/review/report
commands below. For the baseline views, copy the previous exported VRMs and
landmarks into `before/<id>/`, set `FACE_DEMO_OUTPUT` to `before/`, and run the
review command. Then reset the output directory and run
`python scripts/avatar-face-demo/seam-report.py` in the face environment.

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
