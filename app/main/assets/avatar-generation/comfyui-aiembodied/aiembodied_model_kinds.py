"""Classify ComfyUI model files by their tensors (or, for TRELLIS.2, their published names).

Shared by image-models.py (this PC) and the aiembodied ComfyUI add-on (other machines).
"""
import json
import os
import struct

# Saved beside a downloaded model: what Civitai said about it (family, trigger words, name).
INFO_SUFFIX = ".aiembodied.json"
INFO_KEYS = ("modelId", "versionId", "name", "type", "baseModel", "family", "triggerWords")


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


def lora_family(header):
    """sd1 or sdxl for a LoRA, from its cross-attention width or its trainer's metadata."""
    tensors = {k: v for k, v in header.items() if k != "__metadata__" and isinstance(v, dict)}
    for key, value in tensors.items():
        lower = key.lower()
        if "attn2" in lower and "to_k" in lower and ("lora_down" in lower or "lora_a" in lower):
            shape = value.get("shape", [])
            if len(shape) == 2 and shape[1] == 768:
                return "sd1"
            if len(shape) == 2 and shape[1] == 2048:
                return "sdxl"
    meta = header.get("__metadata__", {})
    version = str(meta.get("ss_base_model_version", "") if isinstance(meta, dict) else "").lower()
    if "sdxl" in version:
        return "sdxl"
    if version.startswith("sd_v1") or version.startswith("sd_1"):
        return "sd1"
    if any(k.startswith(("lora_te1_", "lora_te2_")) for k in tensors):
        return "sdxl"
    if any(k.startswith("lora_te_") for k in tensors):
        return "sd1"
    return None


def info_path(full_path):
    return os.path.splitext(full_path)[0] + INFO_SUFFIX


def clean_info(info):
    """Only the fields the app uses, with sane sizes; None when there is nothing usable."""
    if not isinstance(info, dict):
        return None
    result = {}
    for key in INFO_KEYS:
        value = info.get(key)
        if key == "triggerWords":
            if isinstance(value, list):
                words = [str(word).strip()[:200] for word in value if isinstance(word, str) and word.strip()]
                if words:
                    result[key] = words[:20]
        elif isinstance(value, bool):
            continue
        elif isinstance(value, int):
            result[key] = value
        elif isinstance(value, str) and value.strip():
            result[key] = value.strip()[:200]
    return result or None


def read_info(full_path):
    try:
        with open(info_path(full_path), encoding="utf-8") as stream:
            return clean_info(json.load(stream)) or {}
    except (OSError, ValueError):
        return {}


def write_info(full_path, info):
    info = clean_info(info)
    if not info:
        return
    with open(info_path(full_path), "w", encoding="utf-8") as stream:
        json.dump(info, stream, indent=2)


def trellis_kind(folder, name):
    """TRELLIS.2 weights are recognised by their published file names."""
    lower = name.lower().replace("-", "_")
    if "trellis" not in lower:
        return None
    if folder == "vae" and "shape" in lower:
        return "trellis2-shape-vae"
    if folder == "vae" and "tex" in lower:
        return "trellis2-texture-vae"
    if folder == "diffusion_models":
        return "trellis2"
    return None


def describe(folder, name, full_path):
    """The app's description of one model file, or None when it isn't a kind the app uses."""
    if not name.lower().endswith(".safetensors"):
        return None
    try:
        with open(full_path, "rb") as stream:
            size = struct.unpack("<Q", stream.read(8))[0]
            if size > 32 * 1024 * 1024:
                return None
            header = json.loads(stream.read(size))
        if not isinstance(header, dict):
            return None
        if folder == "loras":
            saved = read_info(full_path)
            entry = {"folder": folder, "name": name.replace("\\", "/"), "kind": "lora"}
            family = saved.get("family") or lora_family(header)
            if family:
                entry["family"] = family
            for key in ("baseModel", "triggerWords", "modelId", "versionId"):
                if key in saved:
                    entry[key] = saved[key]
            if saved.get("name"):
                entry["title"] = saved["name"]
            return entry
        info = signature(header, name)
        if not info["kind"]:
            info["kind"] = trellis_kind(folder, name)
        if not info["kind"]:
            return None
        return {"folder": folder, "name": name.replace("\\", "/"), **info}
    except (OSError, ValueError, struct.error):
        # Incomplete downloads are not selectable models.
        return None


def scan(folder_paths):
    result = []
    for folder in ("diffusion_models", "checkpoints", "text_encoders", "vae", "loras"):
        try:
            names = folder_paths.get_filename_list(folder)
        except KeyError:
            continue
        for name in sorted(names):
            entry = describe(folder, name, folder_paths.get_full_path(folder, name))
            if entry:
                result.append(entry)
    return result
