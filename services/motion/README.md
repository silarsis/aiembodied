# Local motion service

A small HTTP service that keeps NVIDIA's text-to-motion model loaded and returns animations in
the app's VRMA JSON format, retargeted to VRM humanoid bones. The HTTP contract is in
[API.md](./API.md).

There are two backends. You pick one per process, and each needs its own venv because they pin
different `transformers` versions.

| Backend | Model | Behaviour | Measured on a Radeon 8060S (ROCm), via HTTP |
|---|---|---|---|
| `ardy` (recommended) | `nvidia/ARDY-SOMA-RP-30FPS-Horizon60` | Autoregressive. `/stream` sends each 2 s chunk as soon as it is generated | First chunk in **~0.6 s**, then one more 2 s chunk every ~0.4 s. A 3 s `/clip` takes ~1.0 s |
| `kimodo` | `nvidia/Kimodo-SOMA-RP-v1.2` | Whole-clip diffusion. `/stream` sends a single chunk. Default 25 steps | A 3 s clip takes ~2 s at 25 steps |

The text encoder (LLM2Vec on Llama-3-8B-Instruct) dominates memory: it needs about 16.5 GB of
GPU memory, or less than 2 GB with `--text-encoder-device cpu`. On the CPU it costs about
+0.5 s per prompt. Loading takes 30–90 s. `/health` reports `ready: false` until loading is
done.

Limitations:
- Fingers never animate. The models generate 30 body joints and fill the hands with a static
  relaxed pose.
- The output is in-place-ish humanoid motion. Hips translation is kept, in rest-hips-height
  units, so walking travels.

## Windows setup (PowerShell)

These steps assume a Strix Halo / Radeon 8060S (gfx1151). For other AMD GPUs, change the
`device-gfx…` extra. With an NVIDIA GPU, install a normal CUDA torch build instead. Python 3.10
or later is required; ComfyUI Desktop's bundled 3.13 works.

```powershell
cd services\motion
$py = 'C:\Users\you\AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\standalone-env\python.exe'  # or any Python >= 3.10
$rocm = @('--index-url', 'https://repo.amd.com/rocm/whl-multi-arch/', '--extra-index-url', 'https://pypi.org/simple',
          '--index-strategy', 'unsafe-best-match')
git clone https://github.com/nv-tlabs/ardy.git ..\..\..\ardy      # anywhere outside the repo
git clone https://github.com/nv-tlabs/kimodo.git ..\..\..\kimodo

# ARDY venv. numpy<2 has no Python 3.13 wheels; ARDY works fine with numpy 2.
uv venv --python $py .venv-ardy
'numpy>=2' | Set-Content -Encoding ascii ardy-overrides.txt
uv pip install --python .venv-ardy\Scripts\python.exe @rocm --override ardy-overrides.txt `
  "torch[device-gfx1151]==2.12.0+rocm7.14.0" -e ..\..\..\ardy -e ".[test]"

# Kimodo venv (optional)
uv venv --python $py .venv-kimodo
uv pip install --python .venv-kimodo\Scripts\python.exe @rocm `
  "torch[device-gfx1151]==2.12.0+rocm7.14.0" -e "..\..\..\kimodo[soma]" -e ".[test]"
```

Model weights download into the Hugging Face cache automatically on first start. They are not
gated: ARDY is about 0.3 GB and Kimodo about 1.1 GB.

### Text encoder (Llama-3-8B-Instruct)

Both models encode prompts with LLM2Vec (`McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp` plus
`…-mntp-supervised`, both ungated) on top of **`meta-llama/Meta-Llama-3-8B-Instruct`, which is
gated**. Pick one of these:

1. **Official access.** Request access on the model page, then put a read token in
   `%USERPROFILE%\.cache\huggingface\token`. Kimodo then works out of the box. ARDY still needs
   option 2's merged folder, because transformers 5.8 doesn't resolve the base model through the
   mntp adapter config.
2. **Local folder** via `TEXT_ENCODERS_DIR` / `--text-encoders-dir`. The folder must contain
   `McGill-NLP\LLM2Vec-Meta-Llama-3-8B-Instruct-mntp` as a **pre-merged** checkpoint (Llama base
   plus mntp LoRA saved as `model.safetensors`, with `config.json`
   `_name_or_path = "meta-llama/Meta-Llama-3-8B-Instruct"` so the Llama-3 prompt template is
   used), next to a copy of `…-mntp-supervised`. One folder works for **both** backends.
   - `scripts/build_text_encoder.py` builds it (15 GB) from either the official weights or the
     ungated `NousResearch/Meta-Llama-3-8B-Instruct` mirror (same weights; the Llama 3 Community
     License still applies). Run it in the Kimodo venv:
     `.venv-kimodo\Scripts\python scripts\build_text_encoder.py --base NousResearch/Meta-Llama-3-8B-Instruct --out D:\models\text_encoders_merged`.
   - Transformers' "MISSING lora weights … newly initialized" load report is harmless. PEFT
     applies the adapters afterwards.

## Run

```powershell
.\scripts\start.ps1 -TextEncodersDir D:\models\text_encoders_merged              # ARDY on :8190
.\scripts\start.ps1 -Backend kimodo -Port 8191 -TextEncoderDevice cpu
# or directly:
.venv-ardy\Scripts\python -m motion_service --backend ardy --host 127.0.0.1 --port 8190 --text-encoders-dir D:\models\text_encoders_merged
```

The app finds the service through `MOTION_SERVICE_URL` (default `http://127.0.0.1:8190`).

Other flags:
- `--model` picks a different checkpoint.
- `--device cpu` runs the motion model on the CPU (slow).
- `--no-postprocess` turns off Kimodo's foot-skate cleanup.
- `--seed N` makes generation repeatable.
- `--keep-warm SECONDS` (default 120; `0` turns it off): after that much idle time, the service
  runs a tiny generation so the weights stay resident. Without it, the first request after hours
  idle spent about 11 s re-loading the text encoder on bija, instead of about 0.15 s.
- `--backend fake` runs a GPU-free stub that produces a synthetic wave, for wiring up the app
  without models.

## Test

```powershell
.venv-ardy\Scripts\python -m pytest -q          # HTTP contract + retargeting, fake backend, no GPU
python scripts\smoke_test.py --url http://127.0.0.1:8190 --out out   # against a running service
```

`smoke_test.py` prints wall-clock latency for `/clip` and for `/stream` (time to the first chunk
and to `done`), and with `--out` it saves each returned VRMA JSON. The app's own
`parseVrmaSchema` can then check those files.

## How retargeting works

The code is in `src/motion_service/retarget.py`.

- SOMA's rest pose (identity rotations) is a Y-up T-pose facing +Z, with the character's left on
  +X. That is the same convention as VRM 1.0 normalized bones, so each bone's local rotation is
  `G[vrm_parent]ᵀ · G[bone]`, computed from SOMA global rotations. No axis conversion is needed.
- VRM 0.x avatars are handled by three-vrm-animation at load time.
- Hips translation is divided by SOMA's rest hips height above the toe joints (0.989 m), relative to the floor and the
  motion's start. The app's `.vrma` encoder writes hips rest at `[0, 1, 0]`, and three-vrm
  rescales to each avatar.
- upperChest gets a constant forward lean, 7° by default (`MOTION_CHEST_FORWARD_DEG`; `0` turns it off).
  ARDY's upper arms hang straight down from a torso that leans back a few degrees, and the bundled
  avatar attaches its shoulders and neck further back on the chest than SOMA does, so without it the
  arms look pulled back. The neck and head lean with the chest once. The shoulders cancel the lean,
  because a chest pitch swings hanging arms backwards.
- The whole arm then swings forward about the shoulder, by an angle calibrated to the avatar
  (`calibration.py`). Avatars attach their shoulders and proportion their spines differently from
  SOMA, so the same rotations leave the hands somewhere else; the bundled avatar's sit 3–4 cm behind
  ARDY's. When a request carries `avatar_rest`, the service poses that skeleton in a reference ARDY
  standing frame (`reference_stand.json`, with the chest lean), measures how far behind ARDY's its
  hands fall, scaled to its hips height, and swings the arms by the angle that closes the gap at its
  arm length. On top of that it adds `MOTION_ARM_FORWARD_BIAS_DEG` (1.5° by default) so the hands sit
  a touch forward. The bundled avatar comes out at 4.25° + 1.5° = 5.75°.
- Without `avatar_rest` the swing is 6°. `MOTION_ARM_FORWARD_DEG` is a manual override: when it is
  set, it is used for every request and the calibration is skipped (`0` keeps ARDY's arm directions exactly).
- Stream chunks share one floor/origin, so they are continuous. Each chunk's keyframes restart at
  `t = 0`.
