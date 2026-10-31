"""Bounds for isolated figures on white or lightly shaded neutral backgrounds.

This is a constrained background check, not general scene segmentation. Sampling
the border avoids treating one slightly grey corner as a failed face detector.
The same estimated background is excluded when measuring the character bounds.
"""
import numpy as np


def reference_body_bounds(rgb):
    pixels = np.asarray(rgb, dtype=np.float32)
    border = np.concatenate((pixels[0], pixels[-1], pixels[:, 0], pixels[:, -1]))
    neutral = (border.max(axis=1) - border.min(axis=1)) <= 24
    light = border.min(axis=1) >= 210
    if np.mean(neutral & light) < .98:
        raise ValueError(
            'The reference background is not light and neutral around the image border. '
            'Use an isolated full-body character with a margin on a white or off-white background.'
        )
    background = np.median(border[neutral & light], axis=0)
    # A slightly warm/grey background must not become the figure's bounding box.
    difference = np.max(np.abs(pixels - background), axis=2)
    foreground = (difference > 32) & (pixels.min(axis=2) < 225)
    # Ignore isolated border speckles when estimating the figure's extent.
    foreground[[0, -1], :] = False
    foreground[:, [0, -1]] = False
    ys, xs = np.where(foreground)
    if len(xs) < 100:
        raise ValueError('No distinct character found against the reference background.')
    return list(map(float, (xs.min(), ys.min(), xs.max(), ys.max())))
