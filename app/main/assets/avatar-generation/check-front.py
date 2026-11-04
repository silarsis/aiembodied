"""Quick checks on a drawn or uploaded front image, before anything slow runs on it.

Runs in the face-fitting environment and prints one JSON line:
  {"backgroundOk": true|false, "figures": <count, or null when the background isn't usable>}

    python check-front.py --image concept.png
"""
import argparse
import json
import runpy
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def check(image_path):
    background = runpy.run_path(str(Path(__file__).with_name('reference-background.py')))
    rgb = np.asarray(Image.open(image_path).convert('RGB'))
    try:
        background['reference_body_bounds'](rgb)
    except ValueError as error:
        if 'background' not in str(error):
            raise
        return {'backgroundOk': False, 'figures': None}
    return {'backgroundOk': True, 'figures': background['count_figures'](rgb)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.image)))
    except Exception as error:
        print('FRONT_CHECK_ERROR: ' + str(error), file=sys.stderr)
        sys.exit(2)
