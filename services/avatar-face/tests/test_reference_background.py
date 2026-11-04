"""Run with the face service's Python environment: python -m unittest discover -s tests."""
import runpy
import unittest
from pathlib import Path
import numpy as np

module = runpy.run_path(str(Path(__file__).resolve().parents[3] /
    'app/main/assets/avatar-generation/reference-background.py'))
bounds = module['reference_body_bounds']
count_figures = module['count_figures']


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
        for color in (100, [180, 220, 255], [210, 210, 234], [210, 234, 210], [225, 240, 249]):
            with self.subTest(color=color), self.assertRaisesRegex(ValueError, 'background'):
                bounds(self.figure(color))


if __name__ == '__main__':
    unittest.main()


class FigureCountTests(unittest.TestCase):
    def person(self, image, x):
        image[10:30, x + 12:x + 28] = [60, 40, 30]  # head
        image[30:110, x:x + 40] = [80, 140, 70]  # body and spread arms

    def test_one_character_is_one_figure(self):
        image = np.full((120, 200, 3), 255, dtype=np.uint8)
        self.person(image, 80)
        self.assertEqual(count_figures(image), 1)

    def test_a_turnaround_of_three_is_three(self):
        image = np.full((120, 200, 3), 255, dtype=np.uint8)
        for x in (10, 80, 150):
            self.person(image, x)
        self.assertEqual(count_figures(image), 3)

    def test_wing_outlines_beside_the_head_are_not_figures(self):
        image = np.full((120, 200, 3), 255, dtype=np.uint8)
        self.person(image, 80)
        for row in range(4, 40, 6):  # thin outline strokes level with the head
            image[row, 20:70] = image[row, 130:180] = [190, 190, 190]
        self.assertEqual(count_figures(image), 1)
