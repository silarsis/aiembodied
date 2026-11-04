"""Eyes, mouth and nose of a stylised (anime, furry or cartoon) face.

MediaPipe's human face model misses drawn anime eyes and animal muzzles, so this asks the Qwen3-VL
vision model (the Qwen-Image text encoder, run by ComfyUI's TextGenerate node) where they are:
first the face, then each feature in a crop of that face. Its boxes are good to a few pixels for
eyes but can put the mouth on the bottom of a nose, so the mouth line is then snapped to the
darkest horizontal line near it.

The rig looks at rig-character.py --render-head's front render of the painted model (--frame), so
the features are where they are painted on the 3D head. A full-body reference also works, for
checking a drawing.

Output (image pixels, plus the render's frame in metres): face box, one box per eye (image left
first), nose point, mouth corners and line. rig-character.py --face-style stylised turns them into
expressions on the head itself.
"""
import argparse
import io
import json
import re
import runpy
import sys
import time
import urllib.request
import uuid
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

CROP = 768
FACE_PROMPT = (
    'Locate the face of the character: from the eyebrows down to the chin, including any muzzle or '
    'snout, but not the hair or the ears. Report bbox coordinates in JSON format as a list of '
    '{"bbox_2d": [x1, y1, x2, y2], "label": "face"}.')
FEATURE_PROMPT = (
    'Locate the left eye, the right eye, the nose and the mouth of the character. Each eye box must '
    'tightly enclose the whole visible eye, from the upper lashes to the lower lid and corner to '
    'corner, but not the eyebrow. The mouth box encloses the lips, or the line where they meet, '
    'which is below the nose. Report bbox coordinates in JSON format as a list of '
    '{"bbox_2d": [x1, y1, x2, y2], "label": "..."} with the labels "left eye", "right eye", "nose" '
    'and "mouth". Left and right mean the left and right of the image.')


class Comfy:
    def __init__(self, url, clip, timeout):
        self.url, self.clip, self.timeout = url.rstrip('/'), clip, timeout

    def _json(self, path, data=None, headers=None):
        request = urllib.request.Request(self.url + path, data, headers or {})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def upload(self, image):
        buffer = io.BytesIO()
        image.save(buffer, 'PNG')
        boundary = uuid.uuid4().hex
        name = f'stylised-face-{uuid.uuid4().hex[:12]}.png'
        parts = [
            f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\n'
            'Content-Type: image/png\r\n\r\n'.encode() + buffer.getvalue() + b'\r\n',
            f'--{boundary}\r\nContent-Disposition: form-data; name="subfolder"\r\n\r\naiembodied\r\n'.encode(),
            f'--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'.encode(),
            f'--{boundary}--\r\n'.encode(),
        ]
        info = self._json('/upload/image', b''.join(parts), {'Content-Type': f'multipart/form-data; boundary={boundary}'})
        return f"{info['subfolder']}/{info['name']}" if info.get('subfolder') else info['name']

    def ask(self, image, prompt):
        """Greedy Qwen3-VL answer about one image."""
        graph = {
            'clip': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': self.clip, 'type': 'qwen_image', 'device': 'default'}},
            'image': {'class_type': 'LoadImage', 'inputs': {'image': self.upload(image)}},
            'text': {'class_type': 'TextGenerate', 'inputs': {'clip': ['clip', 0], 'prompt': prompt, 'max_length': 400,
                                                                'sampling_mode': 'off', 'image': ['image', 0]}},
            'show': {'class_type': 'PreviewAny', 'inputs': {'source': ['text', 0]}},
        }
        queued = self._json('/prompt', json.dumps({'prompt': graph, 'client_id': 'aiembodied'}).encode(),
                            {'Content-Type': 'application/json'})
        prompt_id = queued['prompt_id']
        # The app stops this process to cancel; it prints the id so the prompt can be cancelled too.
        print('COMFY_PROMPT ' + prompt_id, flush=True)
        deadline = time.time() + self.timeout
        try:
            while time.time() < deadline:
                entry = self._json('/history/' + prompt_id).get(prompt_id)
                status = (entry or {}).get('status') or {}
                if status.get('status_str') == 'error':
                    raise ValueError('ComfyUI could not run the vision model: ' + json.dumps(status.get('messages'))[:300])
                if status.get('completed'):
                    for output in entry.get('outputs', {}).values():
                        if output.get('text'):
                            return output['text'][0]
                    raise ValueError('The vision model returned no text.')
                time.sleep(.5)
            raise ValueError('The vision model did not answer in time.')
        except BaseException:
            try:
                self._json(f'/api/jobs/{prompt_id}/cancel', b'')
            except Exception:
                pass
            raise


def parse_boxes(text):
    """The labelled 0-1000 boxes in a Qwen grounding answer, which may be wrapped in a code fence."""
    match = re.search(r'\[.*\]', text, re.S)
    if not match:
        raise ValueError('The vision model did not report any boxes: ' + text[:200])
    try:
        items = json.loads(match.group(0))
    except json.JSONDecodeError:
        items = [{'label': label, 'bbox_2d': [float(v) for v in box.split(',')]}
                 for box, label in re.findall(r'"bbox_2d"\s*:\s*\[([^\]]+)\][^}]*?"label"\s*:\s*"([^"]+)"', text)]
    boxes = []
    for item in items if isinstance(items, list) else []:
        box = item.get('bbox_2d') if isinstance(item, dict) else None
        if isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box):
            x1, y1, x2, y2 = box
            boxes.append((str(item.get('label', '')).lower(), [min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)]))
    return boxes


def square_crop(image, cx, cy, side):
    """A CROP x CROP view of a square around (cx, cy), and how to map its 0-1000 boxes back."""
    left, top = cx - side / 2, cy - side / 2
    view = image.crop((round(left), round(top), round(left + side), round(top + side))).resize((CROP, CROP), Image.LANCZOS)
    def to_image(box):
        return [left + box[0] * side / 1000, top + box[1] * side / 1000, left + box[2] * side / 1000, top + box[3] * side / 1000]
    return view, to_image


def mouth_line(gray, box, nose, face):
    """Image row of the mouth line: the darkest thin horizontal line near the model's mouth box."""
    l, t, r, b = box
    width = r - l
    height = max(b - t, .04 * (face[3] - face[1]))
    cx = (l + r) / 2
    x0, x1 = int(round(cx - .3 * width)), int(round(cx + .3 * width)) + 1
    top = int(max(t - .6 * height, (nose[1] + 2) if nose is not None else 0, face[1]))
    # The chin is a strong edge too: stay above the bottom of the face.
    bottom = int(min(b + 1.2 * height, face[1] + .88 * (face[3] - face[1])))
    if bottom - top < 5 or x1 - x0 < 3:
        return (t + b) / 2
    rows = gray[top:bottom, x0:x1].mean(axis=1)
    # A line is darker than the rows just above and below it.
    band = max(2, int(round(height * .35)))
    padded = np.pad(rows, band, mode='edge')
    around = np.array([(padded[i:i + band].mean() + padded[i + band + 1:i + 2 * band + 1].mean()) / 2 for i in range(len(rows))])
    contrast = around - rows
    prior = np.exp(-.5 * ((np.arange(top, bottom) - (t + b) / 2) / height) ** 2)
    score = contrast * (.35 + .65 * prior)
    best = int(np.argmax(score))
    return float(top + best) if contrast[best] > 2 else (t + b) / 2


def mouth_corners(gray, box, line):
    """Where the mouth line ends: the model's box is often twice the width of the drawn lips.
    Walk out from the middle while the row stays darker than the rows just above and below it."""
    l, t, r, b = box
    y = int(round(line))
    band = max(2, int(round((b - t) * .35)))
    if y - band < 0 or y + band >= gray.shape[0]:
        return l, r
    columns = np.arange(int(l), int(r) + 1)
    columns = columns[(columns >= 0) & (columns < gray.shape[1])]
    around = (gray[y - band:y - 1, columns].mean(axis=0) + gray[y + 2:y + band + 1, columns].mean(axis=0)) / 2
    contrast = around - gray[y - 1:y + 2, columns].min(axis=0)
    contrast = np.convolve(contrast, np.ones(5) / 5, mode='same')
    middle = len(columns) // 2
    strong = contrast[max(0, middle - len(columns) // 8):middle + len(columns) // 8 + 1].max()
    if strong <= 4:
        return l, r
    ends = []
    for step in (-1, 1):
        i = middle
        while 0 < i < len(columns) - 1 and contrast[i + step] > .3 * strong:
            i += step
        ends.append(float(columns[i]))
    half = (r - l) / 2
    centre = (l + r) / 2
    # Never narrower than half the box: a faint line should not shrink the mouth to a dot.
    return min(ends[0], centre - .5 * half), max(ends[1], centre + .5 * half)


def detect(image_path, comfy, frame=None):
    """Features of a full-body front reference, or (with `frame`) of rig-character.py's head render."""
    image = Image.open(image_path).convert('RGB')
    rgb = np.asarray(image)
    if frame:
        figure = image.height
        view, to_image = square_crop(image, image.width / 2, image.height / 2, image.width)
    else:
        background = runpy.run_path(str(Path(__file__).with_name('reference-background.py')))
        left, top, right, bottom = background['reference_body_bounds'](rgb)
        figure = bottom - top
        # The head is near the top of the figure: centre the first crop on the figure's top fifth.
        pixels = rgb[int(top):int(top + .2 * figure) + 1, int(left):int(right) + 1].astype(float)
        ink = (pixels.min(axis=2) < 225) & (np.ptp(pixels, axis=2) + (255 - pixels.min(axis=2)) > 40)
        columns = np.nonzero(ink)[1]
        head_x = left + (float(np.median(columns)) if len(columns) else (right - left) / 2)
        side = .42 * figure
        view, to_image = square_crop(image, head_x, top + side / 2 - .02 * figure, side)
    face_answer = comfy.ask(view, FACE_PROMPT)
    faces = [box for label, box in parse_boxes(face_answer) if 'face' in label or 'head' in label]
    if not faces:
        raise ValueError('The vision model found no face on the character.')
    face = to_image(max(faces, key=lambda box: (box[2] - box[0]) * (box[3] - box[1])))
    face_w, face_h = face[2] - face[0], face[3] - face[1]
    if face_w < (.15 if frame else .02) * figure or face_h < (.15 if frame else .02) * figure:
        raise ValueError('The face is too small to animate. Use a larger front view.')
    side = 1.45 * max(face_w, face_h)
    view, to_image = square_crop(image, (face[0] + face[2]) / 2, (face[1] + face[3]) / 2, side)
    feature_answer = comfy.ask(view, FEATURE_PROMPT)
    found = {}
    for label, box in parse_boxes(feature_answer):
        key = 'eye' if 'eye' in label else 'nose' if 'nose' in label or 'snout' in label else 'mouth' if 'mouth' in label or 'lip' in label else None
        if key:
            found.setdefault(key, []).append(to_image(box))
    eyes = sorted(found.get('eye', []), key=lambda box: box[0] + box[2])
    if len(eyes) != 2:
        raise ValueError(f'Need two visible eyes on a front-facing face; the vision model found {len(eyes)}.')
    if not found.get('mouth'):
        raise ValueError('The vision model found no mouth. Use a front view with a visible mouth.')
    eye_w = [box[2] - box[0] for box in eyes]
    eye_h = [box[3] - box[1] for box in eyes]
    centres = [((box[0] + box[2]) / 2, (box[1] + box[3]) / 2) for box in eyes]
    if eyes[0][2] > eyes[1][0] + .1 * min(eye_w):
        raise ValueError('The two eyes overlap. Use a front-facing view.')
    if abs(centres[0][1] - centres[1][1]) > .6 * max(eye_h):
        raise ValueError('The eyes are not level. Use a straight front view.')
    if max(eye_w) > 1.8 * min(eye_w):
        raise ValueError('The eyes differ too much in size; the face may be turned. Use a straight front view.')
    nose_box = found['nose'][0] if found.get('nose') else None
    nose = [(nose_box[0] + nose_box[2]) / 2, (nose_box[1] + nose_box[3]) / 2] if nose_box else None
    mouth = max(found['mouth'], key=lambda box: box[3])
    eye_bottom = max(box[3] for box in eyes)
    if (mouth[1] + mouth[3]) / 2 < eye_bottom:
        raise ValueError('The mouth was found above the eyes. Use a straight front view.')
    gray = rgb.astype(float) @ [.299, .587, .114]
    line = mouth_line(gray, mouth, nose, face)
    left_x, right_x = mouth_corners(gray, mouth, line)
    return image, {
        'version': 1, 'detector': 'qwen3-vl-stylised', 'imageSize': list(image.size),
        **({'modelFrame': frame} if frame else {'bodyBounds': [left, top, right, bottom]}),
        'face': face, 'eyes': eyes, 'nose': nose,
        'mouth': {'box': mouth, 'left': [left_x, line], 'right': [right_x, line], 'line': line},
        'answers': {'face': face_answer, 'features': feature_answer},
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    parser.add_argument('--comfy', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--clip', default='qwen3vl_8b_int8_convrot.safetensors')
    parser.add_argument('--timeout', type=float, default=600)
    # The image is rig-character.py --render-head's render; this is its frame (centre, size in metres).
    parser.add_argument('--frame')
    args = parser.parse_args()
    try:
        frame = json.loads(Path(args.frame).read_text()) if args.frame else None
        image, data = detect(args.image, Comfy(args.comfy, args.clip, args.timeout), frame)
    except Exception as error:
        print('FACE_FITTING_ERROR: ' + str(error), file=sys.stderr)
        sys.exit(2)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, indent=2))
    draw = ImageDraw.Draw(image)
    draw.rectangle(data['face'], outline=(255, 160, 0), width=2)
    for box in data['eyes']:
        draw.rectangle(box, outline=(0, 120, 255), width=2)
    draw.rectangle(data['mouth']['box'], outline=(255, 0, 200), width=1)
    draw.line([tuple(data['mouth']['left']), tuple(data['mouth']['right'])], fill=(255, 0, 60), width=2)
    if data['nose']:
        x, y = data['nose']
        draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill=(0, 200, 80))
    image.save(output.with_suffix('.png'))
    print('FACE_LANDMARKS_READY', output)
