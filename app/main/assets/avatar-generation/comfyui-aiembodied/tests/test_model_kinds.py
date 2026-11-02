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
        self.assertTrue(result[0]["embeddedClip2"])


if __name__ == "__main__":
    unittest.main()
