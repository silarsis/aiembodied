# Avatar head close-up (MV-Adapter)

`paint-views.py` projects three separately drawn images onto a Hunyuan3D mesh. Where they disagree you
get doubled noses, doubled mouths and seams across the face. This step repaints the front of the head
afterwards with [MV-Adapter](https://github.com/huanngzh/MV-Adapter) (Apache 2.0), which draws its views
together, from the mesh's geometry and the front image, so they agree.

Run `pnpm avatar:paint:setup` once from the repository root. It puts MV-Adapter's code (pinned commit) in
`repo/`, its Python packages in `deps/`, and its weights (3.6 GB, checksum verified) and SDXL's config
files in `models/`. It needs ComfyUI on this computer and an SDXL checkpoint in ComfyUI's models. Without
setup, avatars still build, with today's painting. `AVATAR_PAINT_DIR` moves this folder.

It runs on ComfyUI's Python and PyTorch, in its own process, not inside ComfyUI, so it works with ROCm.
MV-Adapter's own rasteriser needs NVIDIA, so Blender renders the geometry instead
(`app/main/assets/avatar-generation/head-paint-blender.py`). `head-paint-views.py` does the diffusion and
`head-paint-fuse.py` the bake.

A run takes about 6 minutes on a Radeon 8060S and peaks at about 20 GB of GPU memory. It won't start with
under 40 GB of memory free, because on bija too many GPU jobs at once crashed the PC. With the local LLM
server loaded it usually won't have that, so the build keeps today's painting and says so. Any failure
does the same: this step never stops a build.

## Why only the front of the head

- The full-body pass was worse than `paint-views.py` on clothes and shoes. At 768 pixels a whole figure has
  little detail to work with.
- On stylised heads the back, top and bottom views grow extra faces, so those parts keep the existing
  painting.
- The model paints much more saturated than the drawing, so colours are matched back to the front image.
  It still exaggerates lighting in the drawing, such as a dark side of the hair.

Check the bake without a GPU: `python services/avatar-paint/tests/test_fuse.py`, using ComfyUI's Python.
