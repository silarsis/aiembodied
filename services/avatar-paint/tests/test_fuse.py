"""The head close-up's bake, on a made-up flat head facing the front camera. Needs numpy, scipy and PIL."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

ASSETS = Path(__file__).resolve().parents[3] / "app/main/assets/avatar-generation"
spec = importlib.util.spec_from_file_location("head_paint_fuse", ASSETS / "head-paint-fuse.py")
fuse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fuse)

SIZE = 64


def camera(position, right, up):
    position = np.array(position, dtype=float)
    return np.column_stack([right, up, position / np.linalg.norm(position), position]).tolist()


def write_scene(work, points, normals):
    """Six cameras, a front view all red on a blue-grey drawing, and a green base texture."""
    cameras = [
        camera((0, -1.8, 0), (1, 0, 0), (0, 0, 1)),
        camera((1.8, 0, 0), (0, 1, 0), (0, 0, 1)),
        camera((0, 1.8, 0), (-1, 0, 0), (0, 0, 1)),
        camera((-1.8, 0, 0), (0, -1, 0), (0, 0, 1)),
        camera((0, 0, 1.8), (0, -1, 0), (1, 0, 0)),
        camera((0, 0, -1.8), (0, -1, 0), (-1, 0, 0)),
    ]
    frame = {"centre": [0, 0, 0], "scale": 1.0, "lo": [-0.5, -0.5, -0.5], "hi": [0.5, 0.5, 0.5], "half": 0.55, "size": SIZE, "cameras": cameras}
    (work / "frame.json").write_text(json.dumps(frame))
    pos = np.full((6, SIZE, SIZE, 3), 0.5, dtype=np.float32)
    mask = np.zeros((6, SIZE, SIZE), dtype=bool)
    # The front camera sees a square wall at y = -0.4.
    mask[0, 4:60, 4:60] = True
    rows, cols = np.nonzero(mask[0])
    half = frame["half"]
    x = (cols + 0.5) / SIZE * 2 * half - half
    z = half - (rows + 0.5) / SIZE * 2 * half
    pos[0, rows, cols] = np.stack([x, np.full_like(x, -0.4), z], axis=1) + 0.5
    np.savez(work / "views.npz", pos=pos, normal=np.full_like(pos, 0.5), mask=mask)
    size = 8
    covered = np.zeros((size, size), dtype=bool)
    covered.flat[: len(points)] = True
    uv_pos = np.zeros((size, size, 3), dtype=np.float32)
    uv_normal = np.zeros((size, size, 3), dtype=np.float32)
    uv_pos[covered] = points
    uv_normal[covered] = normals
    np.savez(work / "uv.npz", pos=uv_pos, normal=uv_normal, covered=covered)
    Image.new("RGB", (size, size), (0, 200, 0)).save(work / "base.png")
    for index in range(6):
        Image.new("RGB", (SIZE, SIZE), (200, 40, 40)).save(work / f"view{index}.png")
    reference = np.full((SIZE, SIZE, 3), 127, dtype=np.uint8)
    reference[8:56, 8:56] = (200, 40, 40)
    Image.fromarray(reference).save(work / "reference.png")


class FuseTest(unittest.TestCase):
    def run_fuse(self, points, normals):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            work = Path(folder)
            write_scene(work, np.array(points, dtype=np.float32), np.array(normals, dtype=np.float32))
            fuse.fuse(work)
            return np.asarray(Image.open(work / "texture.png").convert("RGB")).reshape(-1, 3)

    def test_front_takes_the_view_and_back_keeps_the_painting(self):
        texture = self.run_fuse(
            [(0, -0.4, 0.2), (0.1, -0.4, 0.3), (0, 0.45, 0.2)],
            [(0, -1, 0), (0, -1, 0), (0, 1, 0)],
        )
        self.assertGreater(texture[0][0], texture[0][1], "the front should be repainted red")
        self.assertGreater(texture[1][0], texture[1][1])
        self.assertGreater(texture[2][1], texture[2][0], "the back should stay green")

    def test_below_the_neck_keeps_the_painting(self):
        texture = self.run_fuse(
            [(0, -0.4, 0.2), (0, -0.4, -0.45)],
            [(0, -1, 0), (0, -1, 0)],
        )
        self.assertGreater(texture[0][0], texture[0][1])
        self.assertGreater(texture[1][1], texture[1][0], "below the fade should stay green")

    def test_crown_keeps_the_painting(self):
        texture = self.run_fuse(
            [(0, -0.4, 0.2), (0, -0.2, 0.45)],
            [(0, -1, 0), (0, 0, 1)],
        )
        self.assertGreater(texture[1][1], texture[1][0], "a surface facing up should stay green")

    def test_a_close_up_that_misses_the_model_fails(self):
        with self.assertRaises(RuntimeError):
            self.run_fuse([(0, 0.45, 0.2)], [(0, 1, 0)])


if __name__ == "__main__":
    unittest.main()
