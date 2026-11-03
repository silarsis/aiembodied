"""Headless Blender: untextured character mesh (Hunyuan3D) + front/left/back images -> textured GLB.

Each image is projected straight onto the mesh from its own side (orthographic, like the views were
drawn). A point takes its colour from the views that can see it, weighted towards the one it faces;
the result is baked into one texture on a fresh UV layout. The mesh is also turned to face -Y, the
way rig-character.py expects, by matching its outline against the front and side images.

The left image is the character's left side (they face the left edge of the image), as Hunyuan3D 2mv
expects. The right side is painted from the same image, which assumes a roughly symmetric character.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix
from mathutils.bvhtree import BVHTree

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--front", required=True)
parser.add_argument("--left")
parser.add_argument("--back")
parser.add_argument("--texture-size", type=int, default=2048)
# Degrees about the up axis; skips the outline match (for testing).
parser.add_argument("--turn", type=float)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])

# With only a front image, front and back outlines can't be told apart; this is the turn that
# ComfyUI's Hunyuan3D output needs to face -Y.
DEFAULT_TURN = 0


def load_view(path):
    """Pixels top row first (RGB float), the character mask, and its bounding box in pixels."""
    image = bpy.data.images.load(str(Path(path).resolve()))
    w, h = image.size
    buffer = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(buffer)
    pixels = buffer.reshape(h, w, 4)[::-1]
    bpy.data.images.remove(image)
    rgb = pixels[..., :3]
    light = rgb.min(axis=2) > 0.9
    neutral = (rgb.max(axis=2) - rgb.min(axis=2)) < 0.08
    mask = ~(light & neutral) & (pixels[..., 3] > 0.5)
    rows, cols = np.nonzero(mask)
    if len(rows) < 0.002 * w * h:
        raise RuntimeError(f"No character was found in {Path(path).name}; it should be on a plain white background.")
    # Percentiles ignore stray specks on the background.
    top, bottom = np.percentile(rows, [0.05, 99.95])
    left, right = np.percentile(cols, [0.05, 99.95])
    return {"rgb": rgb.copy(), "mask": mask, "w": w, "h": h, "box": (float(left), float(top), float(right), float(bottom))}


def bleed(rgb, mask, passes=24):
    """Spread the character's edge colours over the background so edges never pick up white."""
    rgb = rgb.copy()
    filled = mask.copy()
    for _ in range(passes):
        total = np.zeros_like(rgb)
        count = np.zeros(mask.shape, dtype=np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted = np.roll(np.roll(filled, dy, axis=0), dx, axis=1)
            colours = np.roll(np.roll(rgb, dy, axis=0), dx, axis=1)
            total += colours * shifted[..., None]
            count += shifted
        grow = ~filled & (count > 0)
        if not grow.any():
            break
        rgb[grow] = total[grow] / count[grow][:, None]
        filled |= grow
    return rgb


def silhouette(horizontal, vertical, rows=96, cols=192):
    """Points (metres) -> a filled outline scaled to `rows` high, centred horizontally."""
    grid = np.zeros((rows, cols), dtype=bool)
    lo, hi = vertical.min(), vertical.max()
    scale = (rows - 1) / max(hi - lo, 1e-6)
    centre = (horizontal.min() + horizontal.max()) / 2
    u = np.clip(np.round((horizontal - centre) * scale + cols / 2), 0, cols - 1).astype(int)
    v = np.clip(np.round((hi - vertical) * scale), 0, rows - 1).astype(int)
    grid[v, u] = True
    # Close the gaps between projected vertices.
    for _ in range(2):
        grid = grid | np.roll(grid, 1, 0) | np.roll(grid, -1, 0) | np.roll(grid, 1, 1) | np.roll(grid, -1, 1)
    return grid


def image_silhouette(view, rows=96, cols=192):
    left, top, right, bottom = view["box"]
    scale = (rows - 1) / max(bottom - top, 1)
    grid = np.zeros((rows, cols), dtype=bool)
    ys, xs = np.nonzero(view["mask"])
    keep = (ys >= top) & (ys <= bottom)
    u = np.clip(np.round((xs[keep] - (left + right) / 2) * scale + cols / 2), 0, cols - 1).astype(int)
    v = np.clip(np.round((ys[keep] - top) * scale), 0, rows - 1).astype(int)
    grid[v, u] = True
    return grid


def iou(a, b):
    union = np.count_nonzero(a | b)
    return np.count_nonzero(a & b) / union if union else 0.0


# Horizontal image axis for each view, as a function of mesh x and y once the mesh faces -Y.
AXES = {"front": lambda p: p[:, 0], "left": lambda p: p[:, 1], "back": lambda p: -p[:, 0]}
# The direction from the mesh towards each view's camera.
DIRECTIONS = {"front": (0, -1, 0), "left": (1, 0, 0), "back": (0, 1, 0), "right": (-1, 0, 0)}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve()))
parts = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not parts:
    raise RuntimeError("The 3D model came back with no mesh.")
bpy.ops.object.select_all(action="DESELECT")
for o in parts:
    o.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
if len(parts) > 1:
    bpy.ops.object.join()
body = bpy.context.object
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
mesh = body.data

views = {"front": load_view(args.front)}
for name in ("left", "back"):
    path = getattr(args, name)
    if path:
        views[name] = load_view(path)

count = len(mesh.vertices)
points = np.empty(count * 3, dtype=np.float64)
mesh.vertices.foreach_get("co", points)
points = points.reshape(-1, 3)

# Turn the mesh to face -Y: the quarter turn whose outlines best match the images.
scores = {}
targets = {name: image_silhouette(view) for name, view in views.items()}
for turn in (0, 90, 180, 270):
    r = math.radians(turn)
    turned = points @ np.array([[math.cos(r), math.sin(r), 0], [-math.sin(r), math.cos(r), 0], [0, 0, 1]])
    scores[turn] = sum(iou(silhouette(AXES[name](turned), turned[:, 2]), target) for name, target in targets.items())
if args.turn is not None:
    turn = args.turn
elif "left" in views:
    turn = max(scores, key=scores.get)
else:
    # Front and back outlines mirror each other; only a sideways mistake can be ruled out.
    turn = max((DEFAULT_TURN, (DEFAULT_TURN + 90) % 360, (DEFAULT_TURN + 180) % 360, (DEFAULT_TURN + 270) % 360),
               key=lambda t: round(scores[t], 2) + (0.001 if t == DEFAULT_TURN else 0))
mesh.transform(Matrix.Rotation(math.radians(turn), 4, "Z"))
mesh.update()
mesh.vertices.foreach_get("co", points.reshape(-1))
lo, hi = points.min(axis=0), points.max(axis=0)
height = float(hi[2] - lo[2])
if height < 1e-5:
    raise RuntimeError("The 3D model is empty.")

# How much each view should colour each vertex: facing it, and not hidden behind another part.
normals = np.empty(count * 3, dtype=np.float64)
mesh.vertices.foreach_get("normal", normals)
normals = normals.reshape(-1, 3)
polygons = [tuple(p.vertices) for p in mesh.polygons]
tree = BVHTree.FromPolygons([tuple(p) for p in points], polygons)
eps = height * 0.003
available = {"front": "front" in views, "left": "left" in views, "back": "back" in views, "right": "left" in views}
weights = np.zeros((count, 4))  # front, left, back, right
facing = np.zeros((count, 4))
for index, name in enumerate(("front", "left", "back", "right")):
    if not available[name]:
        continue
    d = np.array(DIRECTIONS[name], dtype=np.float64)
    cos = normals @ d
    facing[:, index] = np.clip(cos, 0, None) ** 2
    for i in np.nonzero(cos > 0.05)[0]:
        origin = points[i] + d * eps + normals[i] * eps
        hit = tree.ray_cast(origin, d)
        if hit[0] is None:
            weights[i, index] = cos[i] ** 2
# Hidden everywhere (between the legs, under the arms): use the views it faces anyway.
hidden = weights.sum(axis=1) < 1e-6
weights[hidden] = facing[hidden]
still = weights.sum(axis=1) < 1e-6
weights[still, 0] = 1.0
weights /= weights.sum(axis=1, keepdims=True)
painted = {
    "front": float((weights[:, 0] > 0.5).mean()),
    "side": float((weights[:, 1] + weights[:, 3] > 0.5).mean()),
    "back": float((weights[:, 2] > 0.5).mean()),
}
attribute = mesh.color_attributes.new("ViewWeights", "FLOAT_COLOR", "POINT")
rgba = np.column_stack([weights[:, 0], weights[:, 1] + weights[:, 3], weights[:, 2], np.ones(count)])
attribute.data.foreach_set("color", rgba.astype(np.float32).ravel())

# A fresh UV layout for the baked texture.
for layer in list(mesh.uv_layers):
    mesh.uv_layers.remove(layer)
mesh.uv_layers.new(name="Painted")
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.002)
bpy.ops.object.mode_set(mode="OBJECT")

# Projection material: texture coordinates from the mesh position, one image per view.
projection = bpy.data.materials.new("ViewProjection")
projection.use_nodes = True
nodes, links = projection.node_tree.nodes, projection.node_tree.links
nodes.clear()
coords = nodes.new("ShaderNodeTexCoord")
xyz = nodes.new("ShaderNodeSeparateXYZ")
links.new(coords.outputs["Object"], xyz.inputs["Vector"])
weights_node = nodes.new("ShaderNodeVertexColor")
weights_node.layer_name = "ViewWeights"
split = nodes.new("ShaderNodeSeparateColor")
links.new(weights_node.outputs["Color"], split.inputs["Color"])
total = None
mapping = {}
for name, channel in (("front", "Red"), ("left", "Green"), ("back", "Blue")):
    if name not in views:
        continue
    view = views[name]
    left, top, right, bottom = view["box"]
    scale = (bottom - top) / height  # pixels per metre
    sign = -1.0 if name == "back" else 1.0
    axis = "Y" if name == "left" else "X"
    horizontal = AXES[name](points)
    centre = (horizontal.min() + horizontal.max()) / 2
    w, h = view["w"], view["h"]
    # u = (cx + (coord - centre) * scale) / w, with coord = sign * axis; v counts up from the bottom.
    a, b = sign * scale / w, ((left + right) / 2 - centre * scale) / w
    c, d = scale / h, (h - bottom - lo[2] * scale) / h
    mapping[name] = {"box": [round(v, 1) for v in view["box"]], "pixelsPerMetre": round(scale, 1)}
    u = nodes.new("ShaderNodeMath")
    u.operation = "MULTIPLY_ADD"
    links.new(xyz.outputs[axis], u.inputs[0])
    u.inputs[1].default_value, u.inputs[2].default_value = a, b
    v = nodes.new("ShaderNodeMath")
    v.operation = "MULTIPLY_ADD"
    links.new(xyz.outputs["Z"], v.inputs[0])
    v.inputs[1].default_value, v.inputs[2].default_value = c, d
    uv = nodes.new("ShaderNodeCombineXYZ")
    links.new(u.outputs[0], uv.inputs["X"])
    links.new(v.outputs[0], uv.inputs["Y"])
    image = bpy.data.images.new(f"View_{name}", view["w"], view["h"], alpha=False)
    rgb = bleed(view["rgb"], view["mask"])
    flat = np.concatenate([rgb[::-1], np.ones((h, w, 1), dtype=np.float32)], axis=2)
    image.pixels.foreach_set(flat.astype(np.float32).ravel())
    image.update()
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.extension = "EXTEND"
    links.new(uv.outputs["Vector"], texture.inputs["Vector"])
    scaled = nodes.new("ShaderNodeVectorMath")
    scaled.operation = "SCALE"
    links.new(texture.outputs["Color"], scaled.inputs[0])
    links.new(split.outputs[channel], scaled.inputs["Scale"])
    if total is None:
        total = scaled
    else:
        add = nodes.new("ShaderNodeVectorMath")
        add.operation = "ADD"
        links.new(total.outputs["Vector"], add.inputs[0])
        links.new(scaled.outputs["Vector"], add.inputs[1])
        total = add
emission = nodes.new("ShaderNodeEmission")
links.new(total.outputs["Vector"], emission.inputs["Color"])
out = nodes.new("ShaderNodeOutputMaterial")
links.new(emission.outputs["Emission"], out.inputs["Surface"])
baked = bpy.data.images.new("PaintedViews", args.texture_size, args.texture_size, alpha=False)
target = nodes.new("ShaderNodeTexImage")
target.image = baked
nodes.active = target
mesh.materials.clear()
mesh.materials.append(projection)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 1
scene.render.bake.margin = 16
bpy.ops.object.bake(type="EMIT", margin=16)

# The exported material: the baked texture, matte.
material = bpy.data.materials.new("PaintedCharacter")
material.use_nodes = True
shader = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
shader.inputs["Metallic"].default_value = 0.0
shader.inputs["Roughness"].default_value = 0.8
colour = material.node_tree.nodes.new("ShaderNodeTexImage")
colour.image = baked
material.node_tree.links.new(colour.outputs["Color"], shader.inputs["Base Color"])
baked.file_format = "PNG"
baked.pack()
mesh.materials.clear()
mesh.materials.append(material)
mesh.color_attributes.remove(mesh.color_attributes["ViewWeights"])
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", export_yup=True)
print("PAINT_VIEWS " + json.dumps({
    "turn": turn,
    "outlineScores": {str(k): round(v, 3) for k, v in scores.items()},
    "views": sorted(views),
    "painted": painted,
    "mapping": mapping,
    "vertices": count,
}))
