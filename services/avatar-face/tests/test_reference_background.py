"""Run with the face service's Python environment: python -m unittest discover -s tests."""
import runpy
import unittest
from pathlib import Path
import numpy as np

bounds = runpy.run_path(str(Path(__file__).resolve().parents[3] /
    'app/main/assets/avatar-generation/reference-background.py'))['reference_body_bounds']


class ReferenceBackgroundTests(unittest.TestCase):
    def figure(self, background):
        image = np.full((120, 100, 3), background, dtype=np.uint8)
        image[10:110, 30:70] = [80, 140, 70]
        return image

    def test_white_background(self):
        self.assertEqual(bounds(self.figure(255)), [30., 10., 69., 109.])

    def test_warm_offwhite_and_original_rejected_corner(self):
        image = self.figure([244, 242, 240])
        image[0, 0] = [230, 226, 222]
        self.assertEqual(bounds(image), [30., 10., 69., 109.])

    def test_gentle_background_gradient_does_not_expand_bounds(self):
        image = self.figure(255)
        for row in range(120):
            image[row, :30] = image[row, 70:] = 225 + row // 4
        self.assertEqual(bounds(image), [30., 10., 69., 109.])

    def test_blank_reference_has_no_character(self):
        with self.assertRaisesRegex(ValueError, 'No distinct character'):
            bounds(np.full((120, 100, 3), 240, dtype=np.uint8))

    def test_dark_or_coloured_background_is_rejected(self):
        for color in (100, [180, 220, 255]):
            with self.subTest(color=color), self.assertRaisesRegex(ValueError, 'background'):
                bounds(self.figure(color))


if __name__ == '__main__':
    unittest.main()
