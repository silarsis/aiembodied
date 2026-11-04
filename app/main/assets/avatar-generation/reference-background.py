"""Bounds for isolated figures on white or lightly shaded neutral backgrounds.

This is a constrained background check, not general scene segmentation. Sampling
the border avoids treating one slightly grey corner as a failed face detector.
The same estimated background is excluded when measuring the character bounds.
"""
import numpy as np


def _foreground(rgb):
    """The figure's pixels, against a background that must be light and neutral at the border."""
    pixels = np.asarray(rgb, dtype=np.float32)
    border = np.concatenate((pixels[0], pixels[-1], pixels[:, 0], pixels[:, -1]))
    neutral = (border.max(axis=1) - border.min(axis=1)) <= 12
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
    return foreground


def reference_body_bounds(rgb):
    ys, xs = np.where(_foreground(rgb))
    if len(xs) < 100:
        raise ValueError('No distinct character found against the reference background.')
    return list(map(float, (xs.min(), ys.min(), xs.max(), ys.max())))


def count_figures(rgb):
    """How many characters stand side by side: separate heads across the top tenth of the figure.

    A turnaround or a group puts several heads at about the same height; one character's
    head (hair, ears and all) is a single run of columns. Runs closer than 2% of the image
    width are joined. A run only counts when it is solid (at least a quarter of its band
    filled, so outlines such as wings or a halo don't) and at least a third as wide as the
    widest solid run.
    """
    foreground = _foreground(rgb)
    ys, xs = np.where(foreground)
    if len(xs) < 100:
        raise ValueError('No distinct character found against the reference background.')
    top, bottom = ys.min(), ys.max()
    band = foreground[top:top + max(4, int(.1 * (bottom - top))) + 1]
    columns = np.flatnonzero(band.any(axis=0))
    gap = max(2, int(.02 * foreground.shape[1]))
    runs = []
    start = previous = columns[0]
    for column in list(columns[1:]) + [None]:
        if column is None or column - previous > gap:
            runs.append((start, previous + 1))
            if column is None:
                break
            start = column
        previous = column
    solid = [right - left for left, right in runs if band[:, left:right].mean() >= .25]
    if not solid:
        return 1
    return sum(1 for width in solid if width >= max(solid) / 3)
