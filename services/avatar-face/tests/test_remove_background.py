"""Run with the face service's Python environment: python -m unittest discover -s tests.

The cut-out is tested with a stand-in for the model, so no model download is needed.
"""
import runpy
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

cut_out = runpy.run_path(str(Path(__file__).resolve().parents[3] /
    'app/main/assets/avatar-generation/remove-background.py'))['cut_out']


def scene():
    image = np.full((400, 300, 3), (20, 25, 40), dtype=np.uint8)
    image[60:380, 110:190] = (90, 90, 100)          # the character
    image[:, 40:42] = (200, 40, 120)                # a thin neon line the model keeps
    return Image.fromarray(image)


def fake_model(image):
    pixels = np.asarray(image)
    alpha = np.where((pixels != (20, 25, 40)).any(axis=2), 255, 0).astype(np.uint8)
    return Image.fromarray(np.dstack([pixels, alpha]), "RGBA")


class RemoveBackgroundTests(unittest.TestCase):
    def test_puts_the_character_on_white_without_thin_strokes(self):
        result = np.asarray(cut_out(scene(), fake_model))
        self.assertEqual(result.shape[:2], (400, 300))
        self.assertTrue((result[10, 10] == 255).all())
        self.assertTrue((result[200, 41] == 255).all(), "the neon line is gone")
        self.assertTrue((result[200, 150] == (90, 90, 100)).all(), "the character is kept")

    def test_pads_when_the_character_touches_the_edge(self):
        image = np.full((200, 100, 3), (20, 25, 40), dtype=np.uint8)
        image[0:200, 30:70] = (90, 90, 100)
        result = cut_out(Image.fromarray(image), fake_model)
        self.assertGreater(result.height, 200)
        self.assertEqual(result.getpixel((0, 0)), (255, 255, 255))

    def test_says_when_there_is_nothing_to_cut_out(self):
        empty = Image.new("RGB", (50, 50), (20, 25, 40))
        with self.assertRaises(ValueError):
            cut_out(empty, fake_model)


if __name__ == "__main__":
    unittest.main()
