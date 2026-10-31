"""Headless Blender: generated A-pose textured GLB -> expressive, skinned VRM 1 humanoid.

Experimental MVP: adult proportions, short hair, close clothing, separated limbs, visible neutral face.
The generated body/hair/outfit geometry is preserved; a landmark-fitted facial surface replaces the front head.
No bundled avatar geometry or textures are used. No third-party Blender add-on is required.
"""
import argparse
import json
import math
import struct
import sys
import runpy
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--name", default="Generated character")
parser.add_argument("--render", action="store_true")
parser.add_argument("--reference", required=True)
parser.add_argument("--landmarks", required=True)
parser.add_argument("--emotion-renders", action="store_true")
parser.add_argument("--allow-template-warnings", action="store_true")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
args.reference = str(Path(args.reference).resolve())
args.landmarks = str(Path(args.landmarks).resolve())
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve()))
parts = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not parts:
    raise RuntimeError("The generator returned no character mesh.")
bpy.ops.object.select_all(action="DESELECT")
for o in parts:
    o.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
if len(parts) > 1:
    bpy.ops.object.join()
body = bpy.context.object
body.name = "GeneratedBody"
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
points = np.array([v.co[:] for v in body.data.vertices])
lo, hi = points.min(axis=0), points.max(axis=0)
height = hi[2] - lo[2]
if height < 1e-5 or len(points) < 100:
    raise RuntimeError("The generated geometry is too small or empty to rig.")
H = 1.6
points = (points - np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])) * (H / height)
for v, p in zip(body.data.vertices, points):
    v.co = p
body.data.update()
width = float(np.ptp(points[:, 0]))
if not 0.35 * H < width < 1.3 * H:
    raise RuntimeError("The mesh is not an A-pose humanoid. Regenerate with straight separated arms and legs.")
if len(body.data.polygons) > 80000:
    dec = body.modifiers.new("RuntimeBudget", "DECIMATE")
    dec.ratio = 80000 / len(body.data.polygons)
    bpy.ops.object.modifier_apply(modifier=dec.name)
    points = np.array([v.co[:] for v in body.data.vertices])

# GLB atlas charts duplicate vertex positions along UV seams. Weld only coincident
# geometry before weighting; BMesh retains each face corner's original UVs.
import bmesh
weld=bmesh.new();weld.from_mesh(body.data)
source_vertex_count=len(weld.verts)
bmesh.ops.remove_doubles(weld,verts=list(weld.verts),dist=H*1e-6)
weld.to_mesh(body.data);weld.free();body.data.update()
merged_duplicate_vertices=source_vertex_count-len(body.data.vertices)
points=np.array([v.co[:] for v in body.data.vertices])

# TRELLIS often paints high metallic values. These are matte stylised characters.
for material in body.data.materials:
    if material and material.use_nodes:
        for node in material.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                for key, value in (("Metallic", 0.0), ("Roughness", 0.8)):
                    socket = node.inputs[key]
                    for link in list(socket.links):
                        material.node_tree.links.remove(link)
                    socket.default_value = value

P = lambda x, z, y=0: Vector((x * H, y * H, z * H))
bones = {
    "hips": (P(0, .51), P(0, .57), None),
    "spine": (P(0, .57), P(0, .64), "hips"),
    "chest": (P(0, .64), P(0, .72), "spine"),
    "upperChest": (P(0, .72), P(0, .79), "chest"),
    "neck": (P(0, .79), P(0, .84), "upperChest"),
    "head": (P(0, .84), P(0, .98), "neck"),
}
for side, sign in (("left", 1), ("right", -1)):
    candidates = points[(points[:, 0] * sign > .12 * H) & (points[:, 2] > .30 * H) & (points[:, 2] < .80 * H)]
    if len(candidates) < 10:
        raise RuntimeError("An arm is missing or fused to the torso; regenerate the A-pose reference.")
    tip = Vector(candidates[np.argmax(candidates[:, 0] * sign)])
    shoulder, arm = P(sign * .025, .77), P(sign * .09, .77)
    elbow, wrist = arm.lerp(tip, .46), arm.lerp(tip, .84)
    leg = points[(points[:, 0] * sign > .02 * H) & (abs(points[:, 2] - .26 * H) < .02 * H)]
    knee = Vector(leg.mean(axis=0)) if len(leg) else P(sign * .065, .26)
    ankle = Vector((knee.x, knee.y, .07 * H))
    toes = Vector((knee.x, knee.y - .05 * H, .015 * H))
    bones.update({
        f"{side}Shoulder": (shoulder, arm, "upperChest"),
        f"{side}UpperArm": (arm, elbow, f"{side}Shoulder"),
        f"{side}LowerArm": (elbow, wrist, f"{side}UpperArm"),
        f"{side}Hand": (wrist, tip, f"{side}LowerArm"),
        f"{side}UpperLeg": (P(sign * .065, .51), knee, "hips"),
        f"{side}LowerLeg": (knee, ankle, f"{side}UpperLeg"),
        f"{side}Foot": (ankle, toes, f"{side}LowerLeg"),
        f"{side}Toes": (toes, toes + Vector((0, -.035 * H, 0)), f"{side}Foot"),
    })
armature = bpy.data.armatures.new("GeneratedSkeleton")
rig = bpy.data.objects.new("GeneratedSkeleton", armature)
bpy.context.scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
body.select_set(False)
bpy.ops.object.mode_set(mode="EDIT")
for name, (head, tail, parent) in bones.items():
    b = armature.edit_bones.new(name)
    b.head, b.tail = head, tail
    if parent:
        b.parent = armature.edit_bones[parent]
bpy.ops.object.mode_set(mode="OBJECT")

# Region-constrained segment-distance weights avoid assigning one leg to the other leg.
names = list(bones)
distances = []
for name, (a, b, _) in bones.items():
    a, b = np.array(a), np.array(b)
    d = b - a
    t = np.clip(((points - a) @ d) / max(float(d @ d), 1e-10), 0, 1)
    distance = np.linalg.norm(points - a - t[:, None] * d, axis=1)
    allowed = np.ones(len(points), dtype=bool)
    if "Leg" in name or "Foot" in name or "Toes" in name:
        allowed &= (points[:, 2] < .55 * H)
        allowed &= points[:, 0] * (1 if name.startswith("left") else -1) > -.005 * H
    elif "Arm" in name or "Hand" in name or "Shoulder" in name:
        allowed &= (points[:, 2] > .30 * H)
        allowed &= points[:, 0] * (1 if name.startswith("left") else -1) > .055 * H
        if "Shoulder" in name:
            distance *= 1 + np.maximum(.74 * H - points[:, 2], 0) / (.03 * H) * 5
        else:
            distance *= 1 + (np.maximum(.14 * H - abs(points[:, 0]), 0) / (.04 * H)) * (np.maximum(.75 * H - points[:, 2], 0) / (.05 * H)) * 8
    else:
        allowed &= (points[:, 2] > .45 * H) | (abs(points[:, 0]) < .045 * H)
    if name == "head":
        distance[points[:, 2] > .845 * H] *= .02
    distance[~allowed] = 1e4
    distances.append(distance)
distances = np.array(distances).T
nearest = np.argsort(distances, axis=1)[:, :4]
weights = 1 / np.maximum(np.take_along_axis(distances, nearest, axis=1), .006 * H) ** 4
weights /= weights.sum(axis=1)[:, None]
groups = [body.vertex_groups.new(name=name) for name in names]
for index, (ids, ws) in enumerate(zip(nearest, weights)):
    for bone, weight in zip(ids, ws):
        if weight > .0001:
            groups[int(bone)].add([index], float(weight), "REPLACE")
mod = body.modifiers.new("GeneratedRig", "ARMATURE")
mod.object = rig
body.parent = rig

# Fit known open-eye/open-mouth topology to the detected reference and generated head.
face_module = runpy.run_path(str(Path(__file__).with_name("fitted-face.py")))
face_parts, face_report = face_module["build_fitted_face"](
    body, rig, H, args.landmarks, args.reference, allow_template_warnings=args.allow_template_warnings)
for part in face_parts:
    if part.data.shape_keys:
        for key in part.data.shape_keys.key_blocks:
            key.value = 0

# Bake just the generated body into T-pose. Face parts stay bound rigidly to the head.
bpy.context.view_layer.objects.active = rig
for side in ("left", "right"):
    pb = rig.pose.bones[side + "UpperArm"]
    vector = pb.tail - pb.head
    target = Vector((1 if side == "left" else -1, 0, 0))
    world_rotation = vector.rotation_difference(target)
    local_rotation = pb.bone.matrix_local.to_quaternion().inverted() @ world_rotation @ pb.bone.matrix_local.to_quaternion()
    pb.rotation_mode = "QUATERNION"
    pb.rotation_quaternion = local_rotation
bpy.context.view_layer.update()
bpy.context.view_layer.objects.active = body
bpy.ops.object.modifier_apply(modifier=mod.name)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.armature_apply(selected=False)
bpy.ops.object.mode_set(mode="OBJECT")
mod = body.modifiers.new("GeneratedRig", "ARMATURE")
mod.object = rig
bpy.context.view_layer.update()

glb_path = output.with_suffix(".glb")
bpy.ops.object.select_all(action="DESELECT")
for o in (body, rig, *face_parts):
    o.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(filepath=str(glb_path), export_format="GLB", use_selection=True,
                          export_animations=False, export_morph=True, export_skins=True, export_yup=True)

# Add the VRM extension directly, preserving the exported skin and facial morph accessors.
raw = glb_path.read_bytes()
json_size = struct.unpack_from("<I", raw, 12)[0]
doc = json.loads(raw[20:20 + json_size])
doc.setdefault('extras', {})['aiembodiedGeneration'] = {
    'templatePolicyVersion': face_report['templatePolicyVersion'],
    'templateWarnings': face_report['templateWarnings'],
    'warningsAccepted': face_report['templateWarningsAccepted'],
}
for mesh in doc.get("meshes", []):
    if "weights" in mesh and any(abs(w) > 1e-8 for w in mesh["weights"]):
        raise RuntimeError("Exported face is not neutral: nonzero default expression weights")
remaining = raw[20 + json_size:]
node_ids = {n.get("name"): i for i, n in enumerate(doc["nodes"])}
human = {name: {"node": node_ids[name]} for name in bones}
expressions = {}
for preset in face_module["PRESETS"]:
    binds = []
    for node_index, node in enumerate(doc["nodes"]):
        if "mesh" not in node:
            continue
        mesh = doc["meshes"][node["mesh"]]
        for index, target in enumerate(mesh.get("extras", {}).get("targetNames", [])):
            match = target in ("blinkLeft", "blinkRight") if preset == "blink" else target == preset
            if match:
                binds.append({"node": node_index, "index": index, "weight": 1.0})
    if not binds:
        raise RuntimeError("Missing facial deformation: " + preset)
    expressions[preset] = {"morphTargetBinds": binds, "isBinary": False}
doc.setdefault("extensionsUsed", []).append("VRMC_vrm")
doc.setdefault("extensions", {})["VRMC_vrm"] = {
    "specVersion": "1.0",
    "meta": {"name": args.name, "version": "0.1", "authors": ["AI Embodied local generator"],
             "licenseUrl": "https://vrm.dev/licenses/1.0/",
             "thirdPartyLicenses": "Face topology derived from Google MediaPipe canonical_face_model.obj. Copyright Google LLC.\n" + (Path(__file__).parent / 'face-template' / 'LICENSE').read_text(encoding='utf-8')},
    "humanoid": {"humanBones": human},
    "expressions": {"preset": {k: v for k, v in expressions.items() if k not in ("fear", "disgust")},
                    "custom": {k: expressions[k] for k in ("fear", "disgust")}},
    "lookAt": {"type": "expression", "offsetFromHeadBone": [0, .06, 0],
               **{key: {"inputMaxValue": 90, "outputScale": 1} for key in ("rangeMapHorizontalInner", "rangeMapHorizontalOuter", "rangeMapVerticalDown", "rangeMapVerticalUp")}},
}
doc.setdefault("extensionsUsed", []).append("KHR_materials_unlit")
for mat in doc.get("materials", []):
    mat.setdefault("extensions", {})["KHR_materials_unlit"] = {}
    pbr = mat.setdefault("pbrMetallicRoughness", {})
    pbr["metallicFactor"] = 0
    pbr["roughnessFactor"] = .8
encoded = json.dumps(doc, separators=(",", ":"), ensure_ascii=True).encode()
encoded += b" " * (-len(encoded) % 4)
output.write_bytes(struct.pack("<III", 0x46546C67, 2, 20 + len(encoded) + len(remaining))
                   + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded + remaining)
glb_path.unlink()
unweighted = sum(1 for v in body.data.vertices if not v.groups)
report = {"pipeline": "generated-mesh-and-landmark-fitted-face-v1", "source": str(Path(args.input).resolve()),
          "vertices": len(body.data.vertices), "triangles": sum(len(p.vertices) - 2 for p in body.data.polygons),
          "bones": len(human), "unweightedVertices": unweighted,
          "expressions": list(expressions), "facialParts": len(face_parts), "faceFit": face_report, "mergedDuplicateVertices": merged_duplicate_vertices,
          "limits": ["Adult stylised humanoids only", "Close clothing and short/swept-back hair", "Frontal source-projected face, visual review required", "No articulated fingers or hair physics"]}
output.with_suffix(".report.json").write_text(json.dumps(report, indent=2))
if unweighted:
    output.unlink()
    raise RuntimeError("Unweighted character vertices: " + str(unweighted))
print("CHARACTER_READY " + str(output), flush=True)

if args.render:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 640, 900
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new("World")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (.15, .15, .18, 1)
    for xyz, energy, size in (((-3, -4, 5), 500, 5), ((3, -1, 3), 250, 4)):
        light = bpy.data.objects.new("Light", bpy.data.lights.new("Light", "AREA"))
        scene.collection.objects.link(light)
        light.location = xyz
        light.data.energy, light.data.shape, light.data.size = energy, "DISK", size
        light.rotation_euler = (Vector((0, 0, .9)) - light.location).to_track_quat('-Z', 'Y').to_euler()
    camera = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.location = (0, -4, .85)
    camera.rotation_euler = (Vector((0, 0, .85)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type, camera.data.ortho_scale = "ORTHO", 1.95
    scene.render.filepath = str(output.with_suffix(".png"))
    bpy.ops.render.render(write_still=True)

if args.emotion_renders:
    scene = bpy.context.scene
    # Match the exported VRM's unlit materials, including its baked reference shading.
    for mat in bpy.data.materials:
        if mat.use_nodes:
            shader=mat.node_tree.nodes.get('Principled BSDF')
            if shader:
                color=shader.inputs['Base Color']
                emission=shader.inputs['Emission Color']
                if color.is_linked:
                    mat.node_tree.links.new(color.links[0].from_socket,emission)
                else:emission.default_value=color.default_value
                shader.inputs['Emission Strength'].default_value=1
                shader.inputs['Base Color'].default_value=(0,0,0,1)
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = scene.render.resolution_y = 320
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.world = bpy.data.worlds.new("FaceReviewWorld")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (.07,.09,.13,1)
    scene.world.node_tree.nodes["Background"].inputs[1].default_value = .7
    camera = bpy.data.objects.new("FaceReviewCamera",bpy.data.cameras.new("FaceReviewCamera"))
    scene.collection.objects.link(camera);scene.camera=camera
    face = next(o for o in face_parts if o.name == "FittedFace")
    coords = np.array([v.co[:] for v in face.data.vertices])
    center = Vector(coords.mean(axis=0));center.z = float((coords[:,2].min()+coords[:,2].max())/2)
    camera.location=(center.x,-3,center.z)
    camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
    camera.data.type='ORTHO';camera.data.ortho_scale=float(np.ptp(coords[:,2]))*1.65
    scene.view_settings.view_transform='Standard'
    renders=output.parent/'expressions';renders.mkdir(exist_ok=True)
    for expression in ('neutral','happy','sad','angry','fear','disgust','surprised','blink','aa','ih','ou','ee','oh','lookLeft','lookRight'):
        for obj in face_parts:
            if obj.data.shape_keys:
                for key in obj.data.shape_keys.key_blocks:
                    if key.name != 'Basis':key.value=1 if key.name==expression else 0
        bpy.context.view_layer.update()
        scene.render.filepath=str(renders/(expression+'.png'))
        bpy.ops.render.render(write_still=True)
    # Store an inspectable source scene with the actual fitted mesh and shape keys.
    for obj in face_parts:
        if obj.data.shape_keys:
            for key in obj.data.shape_keys.key_blocks:key.value=0
    bpy.ops.wm.save_as_mainfile(filepath=str(output.with_suffix('.blend')))
