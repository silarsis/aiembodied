"""Bake MV-Adapter's head views onto the front of the head, over the texture already on the model.

Only the front and side views are used, on the front of the head above the neck. On stylised heads
the back, top and bottom views grow extra faces, so those parts keep the existing painting. A texel
takes its colour from the views that see it, weighted sharply towards the one it faces and away from
each view's outline, where the drawing and the shape don't quite line up.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

FRONT, LEFT, RIGHT = 0, 1, 3
RGB_TO_YCC = np.array([[0.299, 0.587, 0.114], [-0.1687, -0.3313, 0.5], [0.5, -0.4187, -0.0813]])
YCC_TO_RGB = np.linalg.inv(RGB_TO_YCC)


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def colour_match(front, reference):
    """Match the front view to the reference: brightness by histogram, saturation by a scale.

    The model paints far more saturated than the drawing. Matching each channel separately tints
    whatever isn't the dominant colour (it turned dark hair purple), and scaling chroma about zero
    leaves neutral colours neutral.
    """
    source = front @ RGB_TO_YCC.T
    target = reference @ RGB_TO_YCC.T
    levels = np.linspace(0, 1, 256)
    source_cdf = np.searchsorted(np.sort(source[:, 0]), levels) / len(source)
    target_cdf = np.searchsorted(np.sort(target[:, 0]), levels) / len(target)
    table = ndimage.gaussian_filter1d(np.interp(source_cdf, target_cdf, levels), 3)
    chroma = np.sqrt((target[:, 1:] ** 2).mean(axis=0) / np.maximum((source[:, 1:] ** 2).mean(axis=0), 1e-6))

    def apply(image):
        ycc = image @ RGB_TO_YCC.T
        ycc[..., 0] = np.interp(ycc[..., 0], levels, table)
        ycc[..., 1:] *= chroma
        return np.clip(ycc @ YCC_TO_RGB.T, 0, 1)

    return apply


def project(points, normals, work, frame, data, recolour, edge=14, disagree=0.2, min_facing=0.1, sharpness=6):
    """Each point's colour from the front and side views, and whether any of them saw it."""
    n = frame["size"]
    half = frame["half"]
    p = (points - frame["centre"]) * frame["scale"]
    used = (FRONT, LEFT, RIGHT)
    weights = np.zeros((len(p), len(used)), dtype=np.float32)
    colours = np.zeros((len(p), len(used), 3), dtype=np.float32)
    for slot, index in enumerate(used):
        camera = np.array(frame["cameras"][index])
        right, up, back = camera[:, 0], camera[:, 1], camera[:, 2]
        cos = normals @ back
        weight = np.where(cos > min_facing, cos, 0) ** sharpness
        col = (p @ right + half) / (2 * half) * n - 0.5
        row = (half - p @ up) / (2 * half) * n - 0.5
        ri, ci = np.clip(np.round(row).astype(int), 0, n - 1), np.clip(np.round(col).astype(int), 0, n - 1)
        mask = data["mask"][index]
        inside = ndimage.distance_transform_edt(mask)
        # Seen from this camera: the surface it renders at this pixel is the point itself.
        depth = (data["pos"][index] - 0.5) @ back
        visible = mask[ri, ci] & (np.abs(depth[ri, ci] - p @ back) < 0.012)
        weight = weight * visible * np.clip((inside[ri, ci] - 2) / edge, 0.02, 1)
        image = recolour(np.asarray(Image.open(work / f"view{index}.png").convert("RGB"), dtype=np.float64) / 255)
        use = weight > 0
        colours[use, slot] = np.stack([ndimage.map_coordinates(image[..., c], [row[use], col[use]], order=1, mode="nearest") for c in range(3)], axis=1)
        weights[:, slot] = weight
    best = colours[np.arange(len(p)), weights.argmax(axis=1)]
    # A view that disagrees with the texel's best view is usually painting past its outline.
    weights[np.abs(colours - best[:, None]).mean(axis=2) > disagree] = 0
    total = weights.sum(axis=1)
    seen = total > 0
    colour = np.zeros((len(p), 3))
    colour[seen] = (colours[seen] * weights[seen, :, None]).sum(axis=1) / total[seen, None]
    return colour, seen


def blend_amount(points, normals, seen, frame, floor=0.1, fade=0.15):
    """How much of the close-up to use: above the neck, on the front of the head, off the crown."""
    lo, hi = frame["lo"], frame["hi"]
    height = hi[2] - lo[2]
    depth = hi[1] - lo[1]
    above_neck = smooth((points[:, 2] - lo[2] - floor * height) / (fade * height))
    # Front is -y. Fade from just in front of the ears towards the back.
    in_front = smooth(((hi[1] + lo[1]) / 2 + 0.12 * depth - points[:, 1]) / (0.2 * depth))
    off_crown = smooth((0.8 - normals[:, 2]) / 0.3)
    return above_neck * in_front * off_crown * seen


def fuse(work):
    frame = json.loads((work / "frame.json").read_text())
    data = np.load(work / "views.npz")
    uv = np.load(work / "uv.npz")
    covered = uv["covered"]
    points = uv["pos"][covered].astype(np.float64)
    normals = uv["normal"][covered].astype(np.float64)
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-6)
    size = covered.shape[0]

    front = np.asarray(Image.open(work / "view0.png").convert("RGB"), dtype=np.float64)[data["mask"][FRONT]] / 255
    reference = np.asarray(Image.open(work / "reference.png").convert("RGB"), dtype=np.float64) / 255
    drawn = reference[np.abs(reference - 0.5).max(axis=2) > 0.025]
    layer, seen = project(points, normals, work, frame, data, colour_match(front, drawn))

    base = np.asarray(Image.open(work / "base.png").convert("RGB").resize((size, size), Image.LANCZOS), dtype=np.float64) / 255
    colour = base[covered]
    alpha = blend_amount(points, normals, seen, frame)
    # Pull the close-up towards the painting it meets, so the join doesn't show.
    ring = (alpha > 0) & (alpha < 1)
    if ring.any():
        layer = np.clip(layer + 0.7 * (colour[ring] - layer[ring]).mean(axis=0), 0, 1)
    colour = colour * (1 - alpha[:, None]) + layer * alpha[:, None]

    texture = base.copy()
    texture[covered] = colour
    # Bleed the new colours past the UV islands: filtered lookups at an island's edge otherwise
    # reach the old painting, which shows as thin cracks across the face.
    _, indices = ndimage.distance_transform_edt(~covered, return_indices=True)
    texture = texture[indices[0], indices[1]]
    Image.fromarray((np.clip(texture, 0, 1) * 255 + 0.5).astype(np.uint8)).save(work / "texture.png")
    painted = float((alpha > 0.5).mean())
    if painted < 0.002:
        raise RuntimeError("The head close-up didn't land on the model.")
    print(f"HEAD_PAINT_FUSED {painted:.3f} of the texels")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True)
    try:
        fuse(Path(parser.parse_args().dir).resolve())
    except Exception as error:  # noqa: BLE001
        print(f"HEAD_PAINT_ERROR: {error}", flush=True)
        raise
