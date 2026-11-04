"""Expressions for a stylised (anime, furry or cartoon) head, made from the head's own painted face.

Executed inside Blender by rig-character.py --face-style stylised. Coordinates: +Z up, -Y face forward.

The landmark-fitted face needs MediaPipe's human topology, which drawn anime eyes and animal muzzles
don't have. Here stylised-face-landmarks.py only reports where the eyes, mouth and nose are, and every
expression deforms the generated head itself, so its painted eyes and mouth move with it:
- a blink squashes everything inside the eye's box onto a lid line, so the painted lashes meet;
- the mouth is a slit cut along the painted mouth line, with a dark interior behind it, and opens
  by lowering the lip and jaw below it;
- smiles, frowns and brows bend the painted features around them.
Gaze slides the eye's contents sideways within the eye. There are no separate eyeballs or teeth.
"""
import json
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

PRESETS = ['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight',
           'happy', 'sad', 'angry', 'relaxed', 'surprised', 'fear', 'disgust',
           'lookLeft', 'lookRight', 'lookUp', 'lookDown']

# Per expression: eye closure (negative opens wider), closed-lid curve (positive arches the
# middle up, as in a smiling ^ eye), inner and outer brow lift (in eye heights), mouth opening
# (in mouth half-widths), mouth width factor, corner lift (in mouth half-widths) and nose lift.
SHAPES = {
    'aa': dict(mouth=.55),
    'ih': dict(mouth=.16, width=1.12),
    'ou': dict(mouth=.3, width=.72),
    'ee': dict(mouth=.13, width=1.22),
    'oh': dict(mouth=.44, width=.82),
    'blink': dict(close=1., curve=-.12),
    'happy': dict(close=.6, curve=.45, inner=.05, outer=.05, mouth=.1, width=1.1, corners=.32),
    'relaxed': dict(close=.4, curve=.1, corners=.12),
    'sad': dict(close=.18, inner=.16, outer=-.05, corners=-.28),
    'angry': dict(close=.22, curve=-.25, inner=-.18, outer=.06, corners=-.14, width=.94),
    'surprised': dict(close=-.18, inner=.22, outer=.22, mouth=.42, width=.76),
    'fear': dict(close=-.12, inner=.2, outer=.04, mouth=.18, width=1.08, corners=-.1),
    'disgust': dict(close=.28, inner=-.1, corners=-.08, upper=.12, nose=.035),
}
LOOK = {'lookLeft': (1, 0), 'lookRight': (-1, 0), 'lookUp': (0, 1), 'lookDown': (0, -1)}


def smoothstep(edge0, edge1, x):
    t = np.clip((x - edge0) / (edge1 - edge0), 0, 1)
    return t * t * (3 - 2 * t)


def ramp(z, xs, ys):
    """Piecewise-linear remap of each z through its own row of knots (xs -> ys); z outside them is unchanged."""
    out = z.copy()
    for k in range(xs.shape[1] - 1):
        a, b = xs[:, k], xs[:, k + 1]
        inside = (z >= a) & (z < b)
        t = (z - a) / np.maximum(b - a, 1e-9)
        out = np.where(inside, ys[:, k] + t * (ys[:, k + 1] - ys[:, k]), out)
    return out


class Face:
    """The detected features in model space, and the expression fields built from them."""

    def __init__(self, data, height):
        width, image_height = data['imageSize']
        if 'modelFrame' in data:
            # rig-character.py --render-head: an orthographic front view of the model itself.
            (frame_x, frame_z), size = data['modelFrame']['center'], data['modelFrame']['size']
            self.to_model = lambda x, y: np.array([frame_x + (x / width - .5) * size, frame_z + (.5 - y / image_height) * size])
        else:
            # A full-body reference, mapped onto the model as the fitted face does.
            left, top, right, bottom = data['bodyBounds']
            scale = height / (bottom - top)
            self.to_model = lambda x, y: np.array([(x - (left + right) / 2) * scale, (bottom - y) * scale])
        l, t, r, b = data['face']
        (self.fx0, self.fz1), (self.fx1, self.fz0) = self.to_model(l, t), self.to_model(r, b)
        self.eyes = []
        for box in data['eyes']:
            (x0, z1), (x1, z0) = self.to_model(box[0], box[1]), self.to_model(box[2], box[3])
            # The model's boxes are loose by a few pixels either way; a little extra squashes skin
            # instead of leaving an eye corner open.
            cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
            self.eyes.append({'cx': cx, 'cz': cz, 'a': (x1 - x0) / 2 * 1.12, 'b': (z1 - z0) / 2 * 1.12})
        mouth = data['mouth']
        (mx0, mz), (mx1, _) = self.to_model(*mouth['left']), self.to_model(*mouth['right'])
        self.mx, self.mz, self.hw = (mx0 + mx1) / 2, mz, (mx1 - mx0) / 2
        self.nose = self.to_model(*data['nose']) if data.get('nose') else np.array([self.mx, mz + self.hw])
        self.face_cx, self.face_cz = (self.fx0 + self.fx1) / 2, (self.fz0 + self.fz1) / 2
        self.face_a, self.face_b = (self.fx1 - self.fx0) / 2, (self.fz1 - self.fz0) / 2

    def face_weight(self, co):
        """1 over the face, fading to 0 at the edge of the (slightly enlarged) face box ellipse."""
        r = np.sqrt(((co[:, 0] - self.face_cx) / (self.face_a * 1.15)) ** 2 + ((co[:, 2] - self.face_cz) / (self.face_b * 1.15)) ** 2)
        return 1 - smoothstep(.85, 1., r)

    def close_line(self, eye, x, curve):
        """Height the lids meet at: a little below the eye's middle, arched by `curve`."""
        u = np.clip((x - eye['cx']) / eye['a'], -1, 1)
        return eye['cz'] - .35 * eye['b'] + curve * eye['b'] * (1 - u * u) - .1 * eye['b'] * u * u

    def eye_field(self, co, eye, close, curve):
        """z offsets that close an eye (close=1), part-close it, or open it wider (close<0)."""
        x, z = co[:, 0], co[:, 2]
        top, bottom, h = eye['cz'] + eye['b'], eye['cz'] - eye['b'], 2 * eye['b']
        line = self.close_line(eye, x, curve)
        sides = 1 - smoothstep(eye['a'], eye['a'] * 1.5, np.abs(x - eye['cx']))
        # Everything in the box lands in a thin band on the lid line; the skin above stretches
        # down after it and the skin below is pulled up a little.
        ones = np.ones_like(z)
        xs = np.stack([ones * (bottom - .5 * h), ones * bottom, line, ones * top, ones * (top + .9 * h)], axis=1)
        ys = np.stack([ones * (bottom - .5 * h), line - .04 * h, line, line + .05 * h, ones * (top + .9 * h)], axis=1)
        return (ramp(z, xs, ys) - z) * close * sides

    def brow_field(self, co, eye, inner, outer):
        x, z = co[:, 0], co[:, 2]
        h = 2 * eye['b']
        centre = eye['cz'] + eye['b'] + .45 * h
        towards_nose = np.sign(self.face_cx - eye['cx'])
        side = np.clip((x - eye['cx']) * towards_nose / eye['a'], -1, 1)  # +1 at the inner end
        lift = (inner * (1 + side) + outer * (1 - side)) / 2
        weight = np.exp(-.5 * ((x - eye['cx']) / (eye['a'] * 1.1)) ** 2 - .5 * ((z - centre) / (.55 * h)) ** 2)
        return lift * h * weight

    def mouth_field(self, co, opening, width, corners, upper):
        """Offsets that open the slit along the mouth line, widen it and lift its corners."""
        x, z = co[:, 0], co[:, 2]
        hw = self.hw
        # Anime mouths are drawn tiny: open them at least as far as a third of an eye's width.
        size = max(hw, .7 * np.mean([e['a'] for e in self.eyes]))
        u = (x - self.mx) / hw
        across = 1 - smoothstep(1., 1.7, np.abs(u))
        below = z < self.mz
        # The lower lip drops most at the middle; the chin follows, fading out towards the neck.
        lens = np.clip(1 - u * u, 0, 1) ** .7 * .8 + .2 * across
        jaw = np.where(below, 1 - smoothstep(0, 2.2 * size, self.mz - z), 0) * across
        lip = np.where(~below, np.exp(-.5 * ((z - self.mz) / (.45 * size)) ** 2), 0) * across
        dz = -opening * size * lens * jaw * .8 + opening * size * lens * lip * .2 + upper * size * lip
        near = np.exp(-.5 * (u / 1.3) ** 2 - .5 * ((z - self.mz) / (.9 * hw)) ** 2)
        dx = (x - self.mx) * (width - 1) * near
        dz = dz + corners * hw * np.clip(np.abs(u), 0, 1.4) ** 2 * near
        return dx, dz

    def look_field(self, co, eye, dx, dz):
        x, z = co[:, 0], co[:, 2]
        r2 = ((x - eye['cx']) / eye['a']) ** 2 + ((z - eye['cz']) / eye['b']) ** 2
        inside = np.clip(1 - r2, 0, 1) ** 1.5
        return dx * .16 * eye['a'] * inside, dz * .12 * eye['b'] * inside

    def offsets(self, name, co):
        """The (n, 3) displacement of every rest position `co` for one expression."""
        delta = np.zeros_like(co)
        if name in LOOK:
            for eye in self.eyes:
                dx, dz = self.look_field(co, eye, *LOOK[name])
                delta[:, 0] += dx
                delta[:, 2] += dz
            return delta * self.face_weight(co)[:, None]
        shape = SHAPES['blink' if name.startswith('blink') else name]
        for eye in self.eyes:
            # blinkLeft is the character's left eye, on the +X side (the image's right).
            if name == 'blinkLeft' and eye['cx'] < self.face_cx or name == 'blinkRight' and eye['cx'] > self.face_cx:
                continue
            if shape.get('close'):
                delta[:, 2] += self.eye_field(co, eye, shape['close'], shape.get('curve', 0))
            if shape.get('inner') or shape.get('outer'):
                delta[:, 2] += self.brow_field(co, eye, shape.get('inner', 0), shape.get('outer', 0))
        if any(shape.get(key) for key in ('mouth', 'width', 'corners', 'upper')):
            dx, dz = self.mouth_field(co, shape.get('mouth', 0), shape.get('width', 1), shape.get('corners', 0), shape.get('upper', 0))
            delta[:, 0] += dx
            delta[:, 2] += dz
        if shape.get('nose'):
            weight = np.exp(-.5 * ((co[:, 0] - self.nose[0]) / (self.hw * .9)) ** 2 - .5 * ((co[:, 2] - self.nose[1]) / (self.hw * .7)) ** 2)
            delta[:, 2] += shape['nose'] * self.face_a * weight
        return delta * self.face_weight(co)[:, None]


def cut_mouth(bm, face, front):
    """Cut a thin slit along the mouth line and close it at rest; returns the rim's upper and lower vertices."""
    from_face = {f for f in bm.faces if all(front[v.index] for v in f.verts)}
    gap = max(face.hw * .06, .0012)
    chosen = set()
    for f in from_face:
        c = f.calc_center_median()
        if abs(c.x - face.mx) < face.hw * .97 and abs(c.z - face.mz) < gap:
            chosen.add(f)
        else:
            zs = [v.co.z - face.mz for v in f.verts]
            if min(zs) < 0 < max(zs) and abs(c.x - face.mx) < face.hw * .9:
                chosen.add(f)
    if not chosen:
        raise RuntimeError('The head has no surface along the mouth line.')
    # Keep one simple hole: the largest connected run of faces, grown wherever its rim pinches.
    groups, seen = [], set()
    for start in chosen:
        if start in seen:
            continue
        group, stack = set(), [start]
        while stack:
            f = stack.pop()
            if f in seen:
                continue
            seen.add(f)
            group.add(f)
            stack.extend(n for e in f.edges for n in e.link_faces if n in chosen and n not in seen)
        groups.append(group)
    picked = max(groups, key=len)
    for _ in range(8):
        degree = {}
        for f in picked:
            for e in f.edges:
                if sum(other in picked for other in e.link_faces) == 1:
                    for v in e.verts:
                        degree[v] = degree.get(v, 0) + 1
        bad = [v for v, n in degree.items() if n != 2]
        if not bad:
            break
        for v in bad:
            picked.update(f for f in v.link_faces if f in from_face)
    rim_candidates = {v for f in picked for v in f.verts}
    bmesh.ops.delete(bm, geom=list(picked), context='FACES')
    rim = [v for v in rim_candidates if v.is_valid and v.link_faces]
    if len(rim) < 6:
        raise RuntimeError('The mouth opening on the head is too small.')
    for v in rim:
        if sum(1 for e in v.link_edges if len(e.link_faces) == 1) != 2:
            raise RuntimeError('The mouth opening on the head is not a simple hole.')
    # Snap the rim onto the line, the two lips just apart, closing to points at the corners.
    upper, lower = [], []
    xs = np.array([v.co.x for v in rim])
    x0, x1 = xs.min(), xs.max()
    half = max((x1 - x0) / 2, 1e-6)
    centre = (x0 + x1) / 2
    for v in rim:
        u = (v.co.x - centre) / half
        lip = face.hw * .004 * max(0., 1 - u * u)
        above = v.co.z >= face.mz
        v.co.z = face.mz + (lip if above else -lip)
        (upper if above else lower).append(v)
    return upper, lower


def build_stylised_face(body, rig, height, landmarks_path, reference_path, allow_template_warnings=False, wrap=True):
    data = json.loads(Path(landmarks_path).read_text())
    if data.get('detector') != 'qwen3-vl-stylised' or len(data.get('eyes', [])) != 2:
        raise RuntimeError('These landmarks are not from the stylised face detector. Run its detection again.')
    face = Face(data, height)
    bpy.context.view_layer.update()
    surface = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())

    def depth(x, z):
        hit, _, _, _ = surface.ray_cast(Vector((x, -height, z)), Vector((0, 1, 0)), 2 * height)
        return None if hit is None else hit.y

    probes = [(e['cx'], e['cz']) for e in face.eyes] + [(face.mx, face.mz), (face.mx - face.hw * .8, face.mz), (face.mx + face.hw * .8, face.mz)]
    if any(depth(x, z) is None for x, z in probes):
        raise RuntimeError('The detected face does not line up with the generated head. Regenerate a straight front view.')
    mesh = body.data
    co = np.array([v.co[:] for v in mesh.vertices])
    in_face = face.face_weight(co) > 0
    if in_face.sum() < 100:
        raise RuntimeError('Too little head surface behind the detected face.')
    centre_y = float((co[in_face, 1].min() + co[in_face, 1].max()) / 2)
    bm = bmesh.new()
    bm.from_mesh(mesh)

    def front_mask():
        pts = np.array([v.co[:] for v in bm.verts])
        return (face.face_weight(pts) > 0) & (pts[:, 1] < centre_y), pts

    # The generated face is coarse. Split it once, then again around the eyes and mouth, so a
    # squashed eye or an opening lip moves the painted texture smoothly.
    front, _ = front_mask()
    region = [f for f in bm.faces if all(front[v.index] for v in f.verts)]
    bmesh.ops.subdivide_edges(bm, edges=list({e for f in region for e in f.edges}), cuts=1, use_grid_fill=True)
    bm.verts.index_update()
    front, pts = front_mask()

    def near_features(p):
        near = (np.abs(p[:, 0] - face.mx) < face.hw * 1.8) & (np.abs(p[:, 2] - face.mz) < face.hw * 1.2)
        for e in face.eyes:
            near |= (np.abs(p[:, 0] - e['cx']) < e['a'] * 1.6) & (p[:, 2] > e['cz'] - e['b'] * 1.8) & (p[:, 2] < e['cz'] + e['b'] * 2.6)
        return near

    detail = front & near_features(pts)
    region = [f for f in bm.faces if all(detail[v.index] for v in f.verts)]
    bmesh.ops.subdivide_edges(bm, edges=list({e for f in region for e in f.edges}), cuts=1, use_grid_fill=True)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bm.verts.index_update()
    bm.faces.index_update()
    bm.verts.ensure_lookup_table()
    front, _ = front_mask()
    faces_before = len(bm.faces)
    upper, lower = cut_mouth(bm, face, front)
    removed = faces_before - len(bm.faces)
    bm.verts.index_update()
    rim_ids = [v.index for v in upper + lower]
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()

    co = np.array([v.co[:] for v in mesh.vertices])
    front = (face.face_weight(co) > 0) & (co[:, 1] < centre_y)
    body.shape_key_add(name='Basis', from_mix=False)
    deltas = {}
    for name in PRESETS:
        delta = np.zeros_like(co)
        delta[front] = face.offsets(name, co[front])
        deltas[name] = delta
        key = body.shape_key_add(name=name, from_mix=False)
        key.data.foreach_set('co', (co + delta).ravel())

    # A closed eye leaves only a thin band of what was inside its box.
    closure = []
    for eye in face.eyes:
        inside = front & (np.abs(co[:, 0] - eye['cx']) < eye['a'] * .8) & (np.abs(co[:, 2] - eye['cz']) < eye['b'] * .9)
        if inside.sum() < 4:
            raise RuntimeError('The head has too little surface where an eye is painted.')
        closed = co[inside, 2] + deltas['blink'][inside, 2] - face.close_line(eye, co[inside, 0], SHAPES['blink']['curve'])
        closure.append(float(np.ptp(closed) / (2 * eye['b'])))
    if max(closure) > .15:
        raise RuntimeError('The eyelids do not close: ' + str(closure))
    opened = co[rim_ids, 2] + deltas['aa'][rim_ids, 2]
    mouth_open = float(opened[:len(upper)].min() - opened[len(upper):].min()) if lower else 0.

    # A dark interior behind the slit follows the lips in every expression: a fan from the rim
    # (upper lip left to right, then lower lip back) to a point inside the head.
    top_ids, bottom_ids = np.array(rim_ids[:len(upper)]), np.array(rim_ids[len(upper):])
    ring_ids = list(top_ids[np.argsort(co[top_ids, 0])]) + list(bottom_ids[np.argsort(-co[bottom_ids, 0])])

    def cavity(points):
        ring = points[ring_ids].copy()
        ring[:, 1] += face.hw * .04
        middle = ring.mean(axis=0)
        middle[1] += face.hw * .5
        return np.vstack([ring, middle])

    count = len(ring_ids)
    cm = bpy.data.meshes.new('MouthCavityTopology')
    cm.from_pydata(cavity(co).tolist(), [], [(i, (i + 1) % count, count) for i in range(count)])
    cm.update()
    mouth = bpy.data.objects.new('MouthInterior', cm)
    bpy.context.scene.collection.objects.link(mouth)
    material = bpy.data.materials.new('MouthInteriorMaterial')
    material.use_nodes = True
    material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (.045, .009, .015, 1)
    mouth.data.materials.append(material)
    group = mouth.vertex_groups.new(name='head')
    group.add(list(range(len(cm.vertices))), 1, 'REPLACE')
    mouth.parent = rig
    modifier = mouth.modifiers.new('FaceRig', 'ARMATURE')
    modifier.object = rig
    mouth.shape_key_add(name='Basis')
    for name in PRESETS:
        key = mouth.shape_key_add(name=name, from_mix=False)
        for v, p in zip(key.data, cavity(co + deltas[name])):
            v.co = p

    policy = json.loads(Path(__file__).with_name('template-policy.json').read_text(encoding='utf-8'))
    span = max(face.face_a, face.face_b)
    report = {
        'pipeline': 'stylised-head-v1', 'detector': data['detector'],
        'templatePolicyVersion': policy['version'], 'templateWarnings': [], 'templateWarningsAccepted': False,
        'expressions': PRESETS, 'boundVertices': int(front.sum()), 'mouthRimVertices': len(rim_ids),
        'removedFaces': removed, 'eyeBoxesMeters': [[e['cx'], e['cz'], 2 * e['a'], 2 * e['b']] for e in face.eyes],
        'mouthWidthMeters': 2 * face.hw, 'blinkResidualFraction': closure, 'aaOpeningMeters': mouth_open,
        'frame': [face.face_cx, face.face_cz, 2.3 * span],
        'limits': ['Front view with two visible eyes and a mouth', 'Expressions bend the painted face; no eyeballs, teeth or tongue',
                   'Feature boxes come from a vision model; review the result'],
    }
    return [mouth], report
