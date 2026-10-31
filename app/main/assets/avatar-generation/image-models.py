"""List ComfyUI's configured weights and classify supported image architectures without loading them."""
import argparse
import json
import struct
import sys
from pathlib import Path


def signature(header, filename=""):
    # Quantised Comfy weights expose per-row scales in place of some weight tensors.
    tensors = {k.replace(".weight_scale", ".weight"): v for k, v in header.items() if k != "__metadata__" and isinstance(v, dict)}
    keys = set(tensors)
    meta = header.get("__metadata__", {})
    if not isinstance(meta, dict):
        meta = {}
    title = meta.get("modelspec.title", "")
    if not isinstance(title, str):
        title = ""
    hint = (filename + " " + str(meta.get("ss_base_model_version", "")) + " " + title).lower()
    shape = lambda key: tensors.get(key, {}).get("shape", [])
    kind = None
    if "img_in.weight" in keys and "txt_in.text_norm.weight" in keys and any(k in keys for k in (
            "transformer_blocks.0.img_mlp.gate_up.weight", "transformer_blocks.0.img_mlp.proj.weight")):
        kind = "qwen-image-2.1"
    elif shape("cap_embedder.1.weight")[:1] == [3840] and "noise_refiner.0.attention.k_norm.weight" in keys:
        kind = "z-image-turbo" if "turbo" in hint else "z-image-unknown"
    elif any(k.startswith("model.diffusion_model.") for k in keys):
        attention = next((v.get("shape", []) for k, v in tensors.items() if "attn2.to_k.weight" in k), [])
        if len(attention) == 2 and attention[1] == 2048:
            kind = "sdxl"
        elif len(attention) == 2 and attention[1] == 768:
            kind = "sd1"
    elif any(k.endswith("visual.patch_embed.proj.weight") for k in keys) and shape("model.norm.weight") == [4096]:
        kind = "qwen3-vl"
    elif shape("model.embed_tokens.weight") == [151936, 2560]:
        kind = "qwen3-4b"
    elif len(shape("conv1.weight")) == 5 and shape("decoder.head.2.weight")[:1] == [4]:
        kind = "qwen-image-vae"
    elif shape("decoder.conv_in.weight")[:2] == [512, 16] and "decoder.conv_out.weight" in keys:
        kind = "flux-ae"
    return {
        "kind": kind,
        "title": title[:120] if isinstance(title, str) else "",
        "embeddedVae": any(k.startswith("first_stage_model.") for k in keys),
        "embeddedClip": any(k.startswith("cond_stage_model.") for k in keys) or any(k.startswith("conditioner.embedders.0.") for k in keys),
        "embeddedClip2": any(k.startswith("conditioner.embedders.1.") for k in keys),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-dir", required=True)
    parser.add_argument("--model-paths")
    args = parser.parse_args()
    sys.path.insert(0, str(Path(args.comfy_dir).resolve()))
    import folder_paths
    if args.model_paths:
        from utils.extra_config import load_extra_path_config
        load_extra_path_config(args.model_paths)
    result = []
    for folder in ("diffusion_models", "checkpoints", "text_encoders", "vae"):
        for name in sorted(folder_paths.get_filename_list(folder)):
            if not name.lower().endswith(".safetensors"):
                continue
            try:
                file = folder_paths.get_full_path(folder, name)
                with open(file, "rb") as stream:
                    size = struct.unpack("<Q", stream.read(8))[0]
                    if size > 32 * 1024 * 1024:
                        continue
                    header = json.loads(stream.read(size))
                if not isinstance(header, dict):
                    continue
                info = signature(header, name)
                if info["kind"]:
                    result.append({"folder": folder, "name": name.replace("\\", "/"), **info})
            except (OSError, ValueError, struct.error):
                # Incomplete downloads are not selectable models.
                continue
    print(json.dumps(result))


if __name__ == "__main__":
    main()
