"""Retarget SOMA motion (Kimodo/ARDY output) to the app's VRMA JSON format.

The SOMA rest pose (all local rotations = identity) is a T-pose, Y-up, facing +Z with the
character's left on +X: the same convention as VRM 1.0 normalized humanoid bones, whose rest
rotations are identity in world-aligned frames. So the retarget is

    local_vrm[bone] = G[vrm_parent(bone)]^T @ G[bone]

with G the SOMA *global* rotation matrices of the mapped joints. SOMA joints without a VRM
counterpart (Neck2, finger metacarpals) fold into the next mapped child automatically.

Hips translation is written in "rest hips height = 1" units: the app's encodeVrmaGlb gives the
hips node a rest translation of [0, 1, 0] and three-vrm-animation rescales by the avatar's own
hips height.
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass
from typing import Optional

import numpy as np
from scipy.spatial.transform import Rotation

SOMA77 = [
    "Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2", "Head", "HeadEnd", "Jaw", "LeftEye", "RightEye",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "LeftHandThumb1", "LeftHandThumb2", "LeftHandThumb3", "LeftHandThumbEnd",
    "LeftHandIndex1", "LeftHandIndex2", "LeftHandIndex3", "LeftHandIndex4", "LeftHandIndexEnd",
    "LeftHandMiddle1", "LeftHandMiddle2", "LeftHandMiddle3", "LeftHandMiddle4", "LeftHandMiddleEnd",
    "LeftHandRing1", "LeftHandRing2", "LeftHandRing3", "LeftHandRing4", "LeftHandRingEnd",
    "LeftHandPinky1", "LeftHandPinky2", "LeftHandPinky3", "LeftHandPinky4", "LeftHandPinkyEnd",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "RightHandThumb1", "RightHandThumb2", "RightHandThumb3", "RightHandThumbEnd",
    "RightHandIndex1", "RightHandIndex2", "RightHandIndex3", "RightHandIndex4", "RightHandIndexEnd",
    "RightHandMiddle1", "RightHandMiddle2", "RightHandMiddle3", "RightHandMiddle4", "RightHandMiddleEnd",
    "RightHandRing1", "RightHandRing2", "RightHandRing3", "RightHandRing4", "RightHandRingEnd",
    "RightHandPinky1", "RightHandPinky2", "RightHandPinky3", "RightHandPinky4", "RightHandPinkyEnd",
    "LeftLeg", "LeftShin", "LeftFoot", "LeftToeBase", "LeftToeEnd",
    "RightLeg", "RightShin", "RightFoot", "RightToeBase", "RightToeEnd",
]
SOMA30 = [
    "Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2", "Head", "Jaw", "LeftEye", "RightEye",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "LeftHandThumbEnd", "LeftHandMiddleEnd",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand", "RightHandThumbEnd", "RightHandMiddleEnd",
    "LeftLeg", "LeftShin", "LeftFoot", "LeftToeBase",
    "RightLeg", "RightShin", "RightFoot", "RightToeBase",
]

# (vrm bone, soma joint, vrm parent) in parent-before-child order
BODY_MAP: list[tuple[str, str, Optional[str]]] = [
    ("hips", "Hips", None),
    ("spine", "Spine1", "hips"),
    ("chest", "Spine2", "spine"),
    ("upperChest", "Chest", "chest"),
    ("neck", "Neck1", "upperChest"),
    ("head", "Head", "neck"),
]
FINGER_MAP: list[tuple[str, str, Optional[str]]] = []
for _side, _S in (("left", "Left"), ("right", "Right")):
    BODY_MAP += [
        (f"{_side}Shoulder", f"{_S}Shoulder", "upperChest"),
        (f"{_side}UpperArm", f"{_S}Arm", f"{_side}Shoulder"),
        (f"{_side}LowerArm", f"{_S}ForeArm", f"{_side}UpperArm"),
        (f"{_side}Hand", f"{_S}Hand", f"{_side}LowerArm"),
        (f"{_side}UpperLeg", f"{_S}Leg", "hips"),
        (f"{_side}LowerLeg", f"{_S}Shin", f"{_side}UpperLeg"),
        (f"{_side}Foot", f"{_S}Foot", f"{_side}LowerLeg"),
        (f"{_side}Toes", f"{_S}ToeBase", f"{_side}Foot"),
    ]
    FINGER_MAP += [
        (f"{_side}ThumbMetacarpal", f"{_S}HandThumb1", f"{_side}Hand"),
        (f"{_side}ThumbProximal", f"{_S}HandThumb2", f"{_side}ThumbMetacarpal"),
        (f"{_side}ThumbDistal", f"{_S}HandThumb3", f"{_side}ThumbProximal"),
    ]
    for _vf, _sf in (("Index", "Index"), ("Middle", "Middle"), ("Ring", "Ring"), ("Little", "Pinky")):
        # SOMA <Finger>1 is the in-palm metacarpal; VRM has none for these fingers.
        FINGER_MAP += [
            (f"{_side}{_vf}Proximal", f"{_S}Hand{_sf}2", f"{_side}Hand"),
            (f"{_side}{_vf}Intermediate", f"{_S}Hand{_sf}3", f"{_side}{_vf}Proximal"),
            (f"{_side}{_vf}Distal", f"{_S}Hand{_sf}4", f"{_side}{_vf}Intermediate"),
        ]

# SOMA rest-pose hips height above the toe-base joints (somaskel77 neutral joints: LeftToeBase y = -0.989),
# metres. The floor is estimated from the same joints, so a standing rest pose maps to exactly 1.
SOMA_REST_HIPS_HEIGHT = 0.989

# Forward lean added at upperChest, degrees: ARDY's torso leans back a few degrees, and VRoid-style
# avatars attach shoulders and neck further back on the chest than SOMA does. The neck and head lean
# with the chest; the shoulders are turned back by the same amount, so the arms keep ARDY's world
# orientation (a chest pitch alone swings hanging arms backwards). Override with MOTION_CHEST_FORWARD_DEG.
DEFAULT_CHEST_FORWARD_DEG = 7.0

# Forward swing of the whole arm about the shoulder, degrees. The bundled avatar's shoulders sit about
# 2.5 cm further back on its chest than SOMA's, which leaves the hands ~4 cm behind ARDY's (~5 deg of
# its 48 cm arm); 6 cancels that with a little to spare. It depends on the avatar's build. Override
# with MOTION_ARM_FORWARD_DEG.
DEFAULT_ARM_FORWARD_DEG = 6.0

SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def slugify(text: str, max_len: int = 40) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:max_len].strip("-")
    return slug or "motion"


@dataclass
class RootFrame:
    """Reference for hips translation, shared by all chunks of one stream so they line up."""

    floor_y: float
    origin_x: float
    origin_z: float

    @classmethod
    def from_motion(cls, posed_joints: np.ndarray, root_positions: np.ndarray, names: list[str]) -> "RootFrame":
        idx = {n: i for i, n in enumerate(names)}
        toes = posed_joints[:, [idx["LeftToeBase"], idx["RightToeBase"]], 1]
        return cls(floor_y=float(np.percentile(toes, 5)), origin_x=float(root_positions[0, 0]),
                   origin_z=float(root_positions[0, 2]))


def joint_names(num_joints: int) -> list[str]:
    if num_joints == 77:
        return SOMA77
    if num_joints == 30:
        return SOMA30
    raise ValueError(f"unsupported SOMA joint count {num_joints} (expected 77 or 30)")


def _env_degrees(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        value = float(raw) if raw else default
    except ValueError:
        return default
    return value if math.isfinite(value) else default


def chest_forward_deg() -> float:
    """The upperChest forward lean from MOTION_CHEST_FORWARD_DEG, else the default."""
    return _env_degrees("MOTION_CHEST_FORWARD_DEG", DEFAULT_CHEST_FORWARD_DEG)


def arm_forward_deg() -> float:
    """The forward arm swing from MOTION_ARM_FORWARD_DEG, else the default."""
    return _env_degrees("MOTION_ARM_FORWARD_DEG", DEFAULT_ARM_FORWARD_DEG)


def _squeeze_batch(a: np.ndarray, ndim: int) -> np.ndarray:
    a = np.asarray(a)
    return a[0] if a.ndim == ndim + 1 else a


def to_vrma(
    global_rot_mats: np.ndarray,
    posed_joints: np.ndarray,
    root_positions: Optional[np.ndarray],
    name: str,
    fps: float = 30.0,
    kind: str = "motion",
    loop: bool = False,
    root_frame: Optional[RootFrame] = None,
    fingers: bool = True,
    in_place: bool = False,
    chest_forward: Optional[float] = None,
    arm_forward: Optional[float] = None,
) -> dict:
    """Build a VRMA JSON dict (app schema) from SOMA global rotations [T,J,3,3] and joints [T,J,3]."""
    G = _squeeze_batch(global_rot_mats, 4).astype(np.float64)
    P = _squeeze_batch(posed_joints, 3).astype(np.float64)
    T, J = G.shape[:2]
    names = joint_names(J)
    idx = {n: i for i, n in enumerate(names)}
    root = _squeeze_batch(root_positions, 2).astype(np.float64) if root_positions is not None else P[:, idx["Hips"]]
    rf = root_frame or RootFrame.from_motion(P, root, names)

    p = np.empty_like(root)
    p[:, 1] = (root[:, 1] - rf.floor_y) / SOMA_REST_HIPS_HEIGHT
    p[:, 0] = (root[:, 0] - (root[:, 0] if in_place else rf.origin_x)) / SOMA_REST_HIPS_HEIGHT
    p[:, 2] = (root[:, 2] - (root[:, 2] if in_place else rf.origin_z)) / SOMA_REST_HIPS_HEIGHT

    mapping = BODY_MAP + (FINGER_MAP if fingers and J == 77 else [])
    glob = {vrm: G[:, idx[soma]] for vrm, soma, _ in mapping}
    times = [round(i / fps, 5) for i in range(T)]
    # A constant pitch about upperChest's own +X (forward for a Y-up, +Z-facing rest). The neck keeps
    # its local rotation, so neck and head lean with the chest exactly once. The shoulders undo it,
    # since the pitch carries hanging arms backwards, then swing the whole arm forward by arm_forward
    # (about -X: that takes a hanging hand towards +Z).
    chest = chest_forward_deg() if chest_forward is None else chest_forward
    arm = arm_forward_deg() if arm_forward is None else arm_forward
    lean = Rotation.from_euler("x", chest, degrees=True).as_matrix()
    shoulder = Rotation.from_euler("x", -(chest + arm), degrees=True).as_matrix()
    tracks = []
    for vrm, _soma, parent in mapping:
        g = glob[vrm]
        local = g if parent is None else np.einsum("tji,tjk->tik", glob[parent], g)  # parent^T @ g
        if vrm == "upperChest":
            local = local @ lean
        elif parent == "upperChest" and vrm != "neck":
            local = shoulder @ local
        q = Rotation.from_matrix(local).as_quat()  # x, y, z, w
        flip = np.cumsum(np.r_[False, np.einsum("ij,ij->i", q[1:], q[:-1]) < 0]) % 2 == 1
        q[flip] = -q[flip]  # sign continuity so LINEAR sampling never takes the long way round
        tracks.append({"bone": vrm, "keyframes": [
            {"t": times[t], "q": [round(float(v), 6) for v in q[t]]} for t in range(T)
        ]})

    if not SLUG_RE.match(name):
        name = slugify(name)
    return {
        "meta": {"name": name, "fps": fps, "loop": loop, "duration": round((T - 1) / fps, 5), "kind": kind},
        "tracks": tracks,
        "hips": {"position": {"keyframes": [
            {"t": times[t], "p": [round(float(v), 5) for v in p[t]]} for t in range(T)
        ]}},
        "expressions": [],
    }
