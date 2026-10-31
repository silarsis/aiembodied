"""Local, finite MediaPipe inference. No network access or fallback landmarks."""
import argparse
import json
import runpy
import sys
from pathlib import Path

import mediapipe as mp
import numpy as np
from PIL import Image, ImageDraw


def detect(image_path, model_path):
    image = Image.open(image_path).convert("RGB")
    rgb = np.asarray(image)
    background = runpy.run_path(str(Path(__file__).with_name('reference-background.py')))
    left, top, right, bottom = background['reference_body_bounds'](rgb)
    options = mp.tasks.vision.FaceLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        num_faces=2, min_face_detection_confidence=.45,
        min_face_presence_confidence=.45, output_face_blendshapes=True,
    )
    # Upscale the upper body crop: a full-body reference gives the face few pixels.
    crop = image.crop((int(left), int(top), int(right + 1), int(top + .38 * (bottom-top))))
    scale = min(4, 1600 / max(crop.size))
    crop = crop.resize((round(crop.width*scale), round(crop.height*scale)))
    with mp.tasks.vision.FaceLandmarker.create_from_options(options) as detector:
        result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(crop)))
    if len(result.face_landmarks) != 1:
        raise ValueError("Need one clearly visible human face, with open eyes and closed lips. Try a less stylised front view.")
    landmarks = [[(p.x*crop.width/scale+left)/image.width,
                  (p.y*crop.height/scale+top)/image.height,
                  p.z*crop.width/scale/image.width] for p in result.face_landmarks[0]]
    points = np.asarray(landmarks)
    eye_width = abs(points[263, 0]-points[33, 0])
    if eye_width < .015 or abs(points[33, 1]-points[263, 1]) > .25*eye_width:
        raise ValueError("Face is too small or tilted to fit reliably. Use a larger front-facing reference.")
    nose = points[1, 0]
    eye_mid = (points[33, 0]+points[263, 0])/2
    if abs(nose-eye_mid) > eye_width*.25:
        raise ValueError("Use a front-facing face rather than a profile.")
    return image, {"version": 1, "detector": "mediapipe-face-landmarker-local",
        "imageSize": list(image.size), "bodyBounds": [left,top,right,bottom],
        "landmarks": landmarks,
        "sourceExpression": {b.category_name: b.score for b in result.face_blendshapes[0]}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        image, data = detect(args.image, args.model)
    except Exception as error:
        print('FACE_FITTING_ERROR: '+str(error),file=sys.stderr)
        sys.exit(2)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, indent=2))
    draw = ImageDraw.Draw(image)
    for x,y,_ in data["landmarks"][:468]:
        x,y = x*image.width,y*image.height
        draw.ellipse((x-1,y-1,x+1,y+1), fill=(0,255,180))
    image.save(output.with_suffix(".png"))
    print("FACE_LANDMARKS_READY", output)
