"""Headless Blender steps of the head close-up: render what MV-Adapter needs, and apply its texture.

--prepare: find the head, render MV-Adapter's six position and normal views of it (views.npz, with
frame.json), and bake each texel's position and normal on the mesh's own UVs (uv.npz), and save the
current texture (base.png). Blender's axes are MV-Adapter's: z up, facing -y.
--apply: put a new texture on the mesh and export the GLB.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--dir", help="--prepare: where the renders go")
parser.add_argument("--prepare", action="store_true")
parser.add_argument("--texture", help="--apply: the new texture")
parser.add_argument("--output", help="--apply: the GLB to write")
parser.add_argument("--size", type=int, default=768)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])

AZIMUTH = [-90, 0, 90, 180, 180, 180]
ELEVATION = [0, 0, 0, 0, 89.99, -89.99]
DISTANCE = 1.8
HALF = 0.55
# How far below the crown to look for the neck, as fractions of the height.
NECK_SEARCH = (0.08, 0.45)
NECK_MARGIN = 0.04


def camera_matrix(azimuth, elevation):
    """MV-Adapter's get_c2w."""
    a, e = math.radians(azimuth), math.radians(elevation)
    position = DISTANCE * np.array([math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)])
    look = -position / np.linalg.norm(position)
    right = np.cross(look, (0, 0, 1))
    right /= np.linalg.norm(right)
    up = np.cross(right, look)
    return np.column_stack([right, up, -look, position])


def head_fraction(points):
    """The top of the character down to just below its neck: the narrowest band under the head."""
    top, bottom = points[:, 2].max(), points[:, 2].min()
    height = top - bottom
    depth = (top - points[:, 2]) / height
    best, best_width = None, np.inf
    bands = np.arange(NECK_SEARCH[0], NECK_SEARCH[1], 0.01)
    for start in bands:
        band = points[(depth >= start) & (depth < start + 0.01), 0]
        if len(band) < 8:
            continue
        width = np.ptp(band)
        if width < best_width:
            best, best_width = start, width
    if best is None:
        raise RuntimeError("Could not find the character's neck.")
    return float(best + 0.005 + NECK_MARGIN)


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve()))
parts = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not parts:
    raise RuntimeError("The painted model has no mesh.")
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
original = mesh.materials[0]
texture_node = next(n for n in original.node_tree.nodes if n.type == "TEX_IMAGE")

if not args.prepare:
    image = bpy.data.images.load(str(Path(args.texture).resolve()))
    image.colorspace_settings.name = "sRGB"
    image.pack()
    texture_node.image = image
    output = Path(args.output).resolve()
    bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", export_yup=True)
    print("HEAD_PAINT_APPLIED " + str(output))
    sys.exit(0)

out = Path(args.dir).resolve()
out.mkdir(parents=True, exist_ok=True)
texture_node.image.filepath_raw = str(out / "base.png")
texture_node.image.file_format = "PNG"
texture_node.image.save()
texture_size = texture_node.image.size[0]

points = np.empty(len(mesh.vertices) * 3)
mesh.vertices.foreach_get("co", points)
points = points.reshape(-1, 3)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 1
scene.cycles.use_denoising = False
scene.cycles.max_bounces = 0
scene.render.bake.margin = 0


def emitting(kind):
    """Position or normal as a colour in 0..1; a quarter scale keeps either in range."""
    material = bpy.data.materials.new(kind)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    geometry = nodes.new("ShaderNodeNewGeometry")
    scale = nodes.new("ShaderNodeVectorMath")
    scale.operation = "SCALE"
    links.new(geometry.outputs["Position" if kind == "pos" else "Normal"], scale.inputs[0])
    scale.inputs["Scale"].default_value = 0.25
    add = nodes.new("ShaderNodeVectorMath")
    add.operation = "ADD"
    links.new(scale.outputs["Vector"], add.inputs[0])
    add.inputs[1].default_value = (0.5, 0.5, 0.5)
    emission = nodes.new("ShaderNodeEmission")
    links.new(add.outputs["Vector"], emission.inputs["Color"])
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def bake_uv(kind):
    material = emitting(kind)
    image = bpy.data.images.new(kind, texture_size, texture_size, alpha=False, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    target = material.node_tree.nodes.new("ShaderNodeTexImage")
    target.image = image
    material.node_tree.nodes.active = target
    mesh.materials.clear()
    mesh.materials.append(material)
    bpy.ops.object.bake(type="EMIT", margin=0)
    buffer = np.empty(texture_size * texture_size * 4, dtype=np.float32)
    image.pixels.foreach_get(buffer)
    return buffer.reshape(texture_size, texture_size, 4)[::-1, :, :3].copy()


baked_pos = bake_uv("pos")
baked_normal = bake_uv("normal")
covered = baked_pos.max(axis=2) > 0
np.savez_compressed(out / "uv.npz", pos=(baked_pos - 0.5) * 4, normal=(baked_normal - 0.5) * 4, covered=covered)

# Frame the head; MV-Adapter wants the subject filling a box of +-0.5.
fraction = head_fraction(points)
top, bottom = points[:, 2].max(), points[:, 2].min()
selected = points[points[:, 2] > top - fraction * (top - bottom)]
lo, hi = selected.min(axis=0), selected.max(axis=0)
centre = (lo + hi) / 2
scale_factor = 0.5 / np.abs(selected - centre).max()
mesh.transform(Matrix.Translation(-centre))
mesh.transform(Matrix.Scale(scale_factor, 4))
mesh.update()
# The rest of the body would still show below an orthographic frame.
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.bisect(plane_co=(0, 0, (lo[2] - centre[2]) * scale_factor), plane_no=(0, 0, 1), use_fill=False, clear_inner=True)
bpy.ops.object.mode_set(mode="OBJECT")

scene.cycles.pixel_filter_type = "BOX"
scene.cycles.filter_width = 0.01
scene.render.resolution_x = scene.render.resolution_y = args.size
scene.render.film_transparent = True
scene.render.image_settings.file_format = "OPEN_EXR"
scene.render.image_settings.color_depth = "32"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Raw"
data = bpy.data.cameras.new("Cam")
data.type = "ORTHO"
data.ortho_scale = 2 * HALF
data.clip_start = 0.1
data.clip_end = 100
camera = bpy.data.objects.new("Cam", data)
scene.collection.objects.link(camera)
scene.camera = camera


def encode(kind):
    """MV-Adapter's encoding: position + 0.5, normal / 2 + 0.5."""
    material = bpy.data.materials.new(f"view-{kind}")
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    geometry = nodes.new("ShaderNodeNewGeometry")
    scale = nodes.new("ShaderNodeVectorMath")
    scale.operation = "SCALE"
    links.new(geometry.outputs["Position" if kind == "pos" else "Normal"], scale.inputs[0])
    scale.inputs["Scale"].default_value = 1 if kind == "pos" else 0.5
    add = nodes.new("ShaderNodeVectorMath")
    add.operation = "ADD"
    links.new(scale.outputs["Vector"], add.inputs[0])
    add.inputs[1].default_value = (0.5, 0.5, 0.5)
    emission = nodes.new("ShaderNodeEmission")
    links.new(add.outputs["Vector"], emission.inputs["Color"])
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


materials = {"pos": encode("pos"), "normal": encode("normal")}
stacks = {"pos": [], "normal": [], "mask": []}
for azimuth, elevation in zip(AZIMUTH, ELEVATION):
    camera.matrix_world = Matrix([list(row) for row in camera_matrix(azimuth, elevation)] + [[0, 0, 0, 1]])
    for kind, material in materials.items():
        mesh.materials.clear()
        mesh.materials.append(material)
        path = out / f"_{kind}.exr"
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(str(path))
        buffer = np.empty(args.size * args.size * 4, dtype=np.float32)
        image.pixels.foreach_get(buffer)
        bpy.data.images.remove(image)
        path.unlink()
        pixels = buffer.reshape(args.size, args.size, 4)[::-1]
        mask = pixels[..., 3] > 0.5
        stacks[kind].append(np.where(mask[..., None], pixels[..., :3], 0.5))
    stacks["mask"].append(mask)
np.savez_compressed(out / "views.npz", pos=np.stack(stacks["pos"]), normal=np.stack(stacks["normal"]), mask=np.stack(stacks["mask"]))

(out / "frame.json").write_text(json.dumps({
    "centre": centre.tolist(),
    "scale": float(scale_factor),
    "lo": lo.tolist(),
    "hi": hi.tolist(),
    "headFraction": fraction,
    # The same box as fractions of the whole character, to crop the reference image alike.
    "referenceCrop": [
        float((top - hi[2]) / (top - bottom)),
        float((top - lo[2]) / (top - bottom)),
        float((lo[0] - points[:, 0].min()) / np.ptp(points[:, 0])),
        float((hi[0] - points[:, 0].min()) / np.ptp(points[:, 0])),
    ],
    "half": HALF,
    "size": args.size,
    "cameras": [camera_matrix(a, e).tolist() for a, e in zip(AZIMUTH, ELEVATION)],
}, indent=1))
print("HEAD_PAINT_PREPARED " + json.dumps({"headFraction": fraction}))
