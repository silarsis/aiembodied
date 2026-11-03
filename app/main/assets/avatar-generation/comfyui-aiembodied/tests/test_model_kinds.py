"""Run with: python -m unittest discover -s app/main/assets/avatar-generation/comfyui-aiembodied/tests"""
import json
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import aiembodied_model_kinds as model_kinds  # noqa: E402


def write_safetensors(path, header):
    raw = json.dumps(header).encode()
    with open(path, "wb") as out:
        out.write(struct.pack("<Q", len(raw)))
        out.write(raw)


class FakeFolderPaths:
    def __init__(self, root, files):
        self.root = root
        self.files = files

    def get_filename_list(self, folder):
        return self.files.get(folder, [])

    def get_full_path(self, folder, name):
        return os.path.join(self.root, name)


class ModelKindTests(unittest.TestCase):
    def test_tells_the_multi_view_hunyuan3d_model_by_its_name(self):
        header = {"model.latent_in.weight": {"shape": [1024, 64]}, "model.cond_in.weight": {"shape": [1024, 1024]}}
        self.assertEqual(model_kinds.signature(header, "hunyuan3d-dit-v2-mv.safetensors")["kind"], "hunyuan3d-2mv")
        self.assertEqual(model_kinds.signature(header, "hunyuan3d-dit-v2-mv-turbo.safetensors")["kind"], "hunyuan3d-2mv")
        self.assertEqual(model_kinds.signature(header, "hunyuan3d-dit-v2.safetensors")["kind"], "hunyuan3d-2")
        self.assertEqual(model_kinds.signature(header, "hunyuan3d-dit-v2-mini.safetensors")["kind"], "hunyuan3d-2")

    def test_reads_the_kind_from_tensors_not_the_name(self):
        root = tempfile.mkdtemp()
        # An SDXL checkpoint (like Pony) whose name doesn't say "xl".
        write_safetensors(os.path.join(root, "ponyRealism.safetensors"), {
            "model.diffusion_model.x.attn2.to_k.weight": {"shape": [640, 2048]},
            "first_stage_model.decoder.weight": {},
            "conditioner.embedders.0.x": {},
            "conditioner.embedders.1.x": {},
        })
        write_safetensors(os.path.join(root, "wan2.2_ti2v_5B_fp16.safetensors"), {"blocks.0.weight": {}})
        with open(os.path.join(root, "half.safetensors"), "wb") as out:
            out.write(b"\x01")
        paths = FakeFolderPaths(root, {
            "checkpoints": ["ponyRealism.safetensors", "half.safetensors"],
            "diffusion_models": ["wan2.2_ti2v_5B_fp16.safetensors"],
        })
        result = model_kinds.scan(paths)
        self.assertEqual([(entry["name"], entry["kind"]) for entry in result], [("ponyRealism.safetensors", "sdxl")])
        self.assertEqual(result[0]["title"], "")
        model_kinds.write_info(os.path.join(root, "ponyRealism.safetensors"), {"name": "Pony Realism", "baseModel": "Pony"})
        described = model_kinds.scan(paths)[0]
        self.assertEqual((described["title"], described["baseModel"]), ("Pony Realism", "Pony"))
        self.assertTrue(result[0]["embeddedClip2"])

    def test_lists_loras_with_their_family_and_saved_details(self):
        root = tempfile.mkdtemp()
        write_safetensors(os.path.join(root, "cyberpunk.safetensors"), {
            "lora_unet_down_blocks_0_attentions_0_transformer_blocks_0_attn2_to_k.lora_down.weight": {"shape": [32, 768]},
        })
        model_kinds.write_info(os.path.join(root, "cyberpunk.safetensors"), {
            "name": "Cyberpunk style", "baseModel": "SD 1.5", "triggerWords": ["cyberpunk", "  ", 7], "modelId": 1, "junk": "x",
        })
        write_safetensors(os.path.join(root, "xl_style.safetensors"), {
            "__metadata__": {"ss_base_model_version": "sdxl_base_v1-0"}, "lora_unet_x.lora_down.weight": {"shape": [4, 4]},
        })
        write_safetensors(os.path.join(root, "mystery.safetensors"), {"x": {"shape": [1]}})
        paths = FakeFolderPaths(root, {"loras": ["cyberpunk.safetensors", "mystery.safetensors", "xl_style.safetensors"]})
        result = {entry["name"]: entry for entry in model_kinds.scan(paths)}
        self.assertEqual(result["cyberpunk.safetensors"], {
            "folder": "loras", "name": "cyberpunk.safetensors", "kind": "lora", "family": "sd1",
            "baseModel": "SD 1.5", "triggerWords": ["cyberpunk"], "modelId": 1, "title": "Cyberpunk style",
        })
        self.assertEqual(result["xl_style.safetensors"]["family"], "sdxl")
        self.assertNotIn("family", result["mystery.safetensors"])
        with open(os.path.join(root, "cyberpunk.aiembodied.json")) as stream:
            self.assertNotIn("junk", json.load(stream))


if __name__ == "__main__":
    unittest.main()
