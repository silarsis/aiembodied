"""MV-Adapter: draw six views of the head that agree with each other, from head-paint-blender.py's renders.

Runs on ComfyUI's Python and PyTorch, with services/avatar-paint/deps and repo on PYTHONPATH.
"""
import argparse
import importlib.util
import os
import sys
import traceback
from pathlib import Path
from unittest.mock import MagicMock


def fail(kind, value, trace):
    # Printed for the app, then straight out: a normal exit after running out of memory hangs
    # on ROCm and keeps the GPU memory.
    traceback.print_exception(kind, value, trace)
    print(f"HEAD_PAINT_ERROR: {value}", file=sys.stderr, flush=True)
    os._exit(1)


sys.excepthook = fail

parser = argparse.ArgumentParser()
parser.add_argument("--dir", required=True, help="head-paint-blender.py's output; the views go here too")
parser.add_argument("--reference", required=True, help="Character on white, front view")
parser.add_argument("--paint-root", required=True, help="services/avatar-paint")
parser.add_argument("--checkpoint", required=True, help="An SDXL checkpoint in ComfyUI's checkpoints folder, or a path")
parser.add_argument("--comfy-dir", required=True)
parser.add_argument("--model-paths")
parser.add_argument("--prompt", default="")
parser.add_argument("--negative", default="watermark, ugly, deformed, noisy, blurry, low contrast, text, signature")
parser.add_argument("--steps", type=int, default=30)
parser.add_argument("--guidance", type=float, default=3.0)
parser.add_argument("--seed", type=int, default=7)
parser.add_argument("--min-free-gb", type=float, default=40)
args = parser.parse_args()


def check_memory():
    """Generating needs about 30 GB of commit. Without it, it fails slowly at best, or takes the PC down."""
    if sys.platform != "win32":
        return
    import ctypes

    class Status(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong if name != "dwLength" and name != "dwMemoryLoad" else ctypes.c_ulong) for name in (
            "dwLength", "dwMemoryLoad", "ullTotalPhys", "ullAvailPhys", "ullTotalPageFile", "ullAvailPageFile",
            "ullTotalVirtual", "ullAvailVirtual", "ullAvailExtendedVirtual")]

    status = Status()
    status.dwLength = ctypes.sizeof(Status)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
    free = status.ullAvailPageFile / 2**30
    if free < args.min_free_gb:
        raise RuntimeError(f"Only {free:.0f} GB of memory is free and this needs {args.min_free_gb:.0f} GB. Close other large models and try again.")


def find_checkpoint(name):
    if Path(name).is_file():
        return name
    sys.path.insert(0, str(Path(args.comfy_dir).resolve()))
    import folder_paths
    if args.model_paths:
        from utils.extra_config import load_extra_path_config
        load_extra_path_config(args.model_paths)
    path = folder_paths.get_full_path("checkpoints", name)
    if not path:
        raise RuntimeError(f"The SDXL checkpoint {name} isn't on this computer.")
    return path


check_memory()
checkpoint = find_checkpoint(args.checkpoint)
root = Path(args.paint_root).resolve()
sys.path.insert(0, str(root / "repo"))

import numpy as np
import torch
from diffusers import StableDiffusionXLPipeline
from PIL import Image
from scipy import ndimage

# mvadapter.utils imports its mesh tools, some NVIDIA-only, on import; none of them is used here.
for name in ("nvdiffrast", "nvdiffrast.torch", "cvcuda", "open3d", "pymeshlab", "gltflib", "imageio", "trimesh", "cv2", "matplotlib", "matplotlib.cm", "matplotlib.colors", "matplotlib.pyplot", "spandrel", "kornia"):
    top = name.split(".")[0]
    if top in sys.modules or top == "nvdiffrast" or importlib.util.find_spec(top) is None:
        sys.modules[name] = MagicMock()

from mvadapter.models.attention_processor import DecoupledMVRowColSelfAttnProcessor2_0
from mvadapter.pipelines.pipeline_mvadapter_i2mv_sdxl import MVAdapterI2MVSDXLPipeline
from mvadapter.schedulers.scheduling_shift_snr import ShiftSNRScheduler

work = Path(args.dir).resolve()
frame = __import__("json").loads((work / "frame.json").read_text())


def reference_image(path, size, crop):
    """MV-Adapter's framing: the head at 90% of the frame on mid grey."""
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255
    light = (rgb.min(axis=2) > 0.9) & ((rgb.max(axis=2) - rgb.min(axis=2)) < 0.08)
    labels, _ = ndimage.label(light)
    border = set(labels[0]) | set(labels[-1]) | set(labels[:, 0]) | set(labels[:, -1])
    background = np.isin(labels, [v for v in border if v])
    alpha = ndimage.gaussian_filter((~background).astype(np.float32), 0.7)
    ys, xs = np.nonzero(~background)
    if not len(ys):
        raise RuntimeError("No character was found in the front image.")
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    top_, bottom, left, right = crop
    h, w = y1 - y0, x1 - x0
    y0, y1, x0, x1 = int(y0 + top_ * h), int(y0 + bottom * h), int(x0 + left * w), int(x0 + right * w)
    rgba = np.dstack([rgb, alpha])[y0:y1, x0:x1]
    h, w = rgba.shape[:2]
    k = 0.9 * size / max(h, w)
    small = np.asarray(Image.fromarray((rgba * 255).astype(np.uint8)).resize((int(w * k), int(h * k)), Image.LANCZOS), dtype=np.float32) / 255
    h, w = small.shape[:2]
    canvas = np.zeros((size, size, 4), dtype=np.float32)
    canvas[(size - h) // 2 : (size - h) // 2 + h, (size - w) // 2 : (size - w) // 2 + w] = small
    composed = canvas[..., :3] * canvas[..., 3:] + 0.5 * (1 - canvas[..., 3:])
    return Image.fromarray((composed * 255).astype(np.uint8))


views = np.load(work / "views.npz")
size = views["pos"].shape[1]
count = views["pos"].shape[0]
device = "cuda" if torch.cuda.is_available() else "cpu"
if device == "cpu":
    raise RuntimeError("ComfyUI's PyTorch can't see a GPU.")
control = torch.from_numpy(np.concatenate([views["pos"], views["normal"]], axis=-1)).permute(0, 3, 1, 2).to(device, torch.float16)
reference = reference_image(args.reference, size, frame["referenceCrop"])
reference.save(work / "reference.png")

base = StableDiffusionXLPipeline.from_single_file(checkpoint, torch_dtype=torch.float16, config=str(root / "models" / "sdxl-config"), local_files_only=True)
pipe = MVAdapterI2MVSDXLPipeline(**base.components)
pipe.scheduler = ShiftSNRScheduler.from_scheduler(pipe.scheduler, shift_mode="interpolated", shift_scale=8.0)
pipe.init_custom_adapter(num_views=count, self_attn_processor=DecoupledMVRowColSelfAttnProcessor2_0)
pipe.load_custom_adapter(str(root / "models"), weight_name="mvadapter_ig2mv_sdxl.safetensors")
pipe.to(device=device, dtype=torch.float16)
pipe.cond_encoder.to(device=device, dtype=torch.float16)
pipe.vae.enable_slicing()

images = pipe(
    f"high quality, {args.prompt}, head portrait, detailed face" if args.prompt else "high quality, head portrait, detailed face",
    height=size,
    width=size,
    num_inference_steps=args.steps,
    guidance_scale=args.guidance,
    num_images_per_prompt=count,
    control_image=control,
    control_conditioning_scale=1.0,
    reference_image=reference,
    reference_conditioning_scale=1.0,
    negative_prompt=args.negative,
    generator=torch.Generator(device=device).manual_seed(args.seed),
    cross_attention_kwargs={"scale": 1.0},
).images
for index, image in enumerate(images):
    image.save(work / f"view{index}.png")
print(f"HEAD_PAINT_VIEWS peak {torch.cuda.max_memory_allocated() / 2**30:.1f} GB", flush=True)
os._exit(0)
