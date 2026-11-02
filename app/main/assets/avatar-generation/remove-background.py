"""Cut the character out of a concept image and put it on plain white, on request.

Runs in the face-fitting environment (services/avatar-face/.venv) with rembg's
isnet-general-use model, which handles illustrated and 3D-rendered characters. The
model lives under U2NET_HOME (services/avatar-face/models/rembg); `pnpm avatar:face:setup`
downloads it, so this runs offline.

    python remove-background.py --image concept.png --output cutout.png

Face fitting needs a light, neutral border to find the body; when the character
reaches the edge, the canvas is padded with white so there is a margin.
"""
import argparse
import sys

import numpy as np
from PIL import Image, ImageFilter

MODEL = "isnet-general-use"


def character_mask(alpha):
    """Keep the character, drop thin background shapes the model kept (neon lines, rays).

    Opening the mask removes strokes thinner than about 1% of the image; the largest
    piece left is the character. Growing that piece back a little and intersecting it
    with the model's own mask keeps fine edges (hair, fingers) that touch the body.
    """
    size = max(3, round(0.01 * max(alpha.size)) | 1)
    solid = alpha.point(lambda a: 255 if a > 32 else 0)
    opened = solid.filter(ImageFilter.MinFilter(size)).filter(ImageFilter.MaxFilter(size))
    try:
        from scipy import ndimage
    except ImportError:
        return alpha
    labels, count = ndimage.label(np.asarray(opened) > 0)
    if count == 0:
        return alpha
    sizes = ndimage.sum(np.ones_like(labels), labels, range(1, count + 1))
    body = Image.fromarray(((labels == int(np.argmax(sizes)) + 1) * 255).astype(np.uint8))
    grown = body.filter(ImageFilter.MaxFilter(size * 2 + 1))
    return Image.fromarray(np.minimum(np.asarray(alpha), np.asarray(grown)))


def cut_out(image, remove_fn):
    """The image with everything but the character replaced by white (RGB)."""
    image = image.convert("RGB")
    cut = remove_fn(image).convert("RGBA")
    alpha = character_mask(cut.getchannel("A"))
    bbox = alpha.point(lambda a: 255 if a > 32 else 0).getbbox()
    if not bbox:
        raise ValueError("No character was found to cut out.")
    white = Image.new("RGB", image.size, (255, 255, 255))
    white.paste(cut.convert("RGB"), mask=alpha)
    left, top, right, bottom = bbox
    margin = round(0.04 * max(image.size))
    if left < margin or top < margin or image.width - right < margin or image.height - bottom < margin:
        padded = Image.new("RGB", (image.width + 2 * margin, image.height + 2 * margin), (255, 255, 255))
        padded.paste(white, (margin, margin))
        white = padded
    return white


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        try:
            from rembg import new_session, remove
        except ImportError:
            raise ValueError("Background removal isn't installed. Run `pnpm avatar:face:setup` again.")
        session = new_session(MODEL)
        result = cut_out(Image.open(args.image), lambda image: remove(image, session=session))
        result.save(args.output)
    except Exception as error:
        print("BACKGROUND_ERROR: " + str(error), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
