"""Per-avatar arm calibration: how far to swing the arms forward so this avatar's hands land where
ARDY's do.

Avatars attach their shoulders and size their spines differently from SOMA, so the same rotations
leave the hands somewhere else. The app sends the avatar's rest skeleton with a motion request.
This poses it in a reference ARDY standing frame (with the retarget's chest lean) and measures how
far its hands fall behind ARDY's, scaled to the avatar's size. The swing that closes that gap at
the avatar's arm length is the calibrated angle; a small bias on top keeps the hands a touch forward.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Mapping, Sequence

import numpy as np
from scipy.spatial.transform import Rotation

from .retarget import SOMA_REST_HIPS_HEIGHT, _env_degrees

# The bones the app sends: normalized rest positions in metres, Y up, facing +Z, left on +X.
REST_BONES = (
    "hips", "spine", "chest", "upperChest",
    "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
    "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
)
# Extra forward swing on top of the calibrated angle: Kevin wanted the hands "a little more" forward
# than exact. Override with MOTION_ARM_FORWARD_BIAS_DEG.
DEFAULT_ARM_FORWARD_BIAS_DEG = 1.5
MAX_ARM_FORWARD_DEG = 15.0

_REFERENCE = json.loads((Path(__file__).parent / "reference_stand.json").read_text())
_CHAIN = (("spine", "hips", "Hips"), ("chest", "spine", "Spine1"), ("upperChest", "chest", "Spine2"))


def arm_forward_bias_deg() -> float:
    return _env_degrees("MOTION_ARM_FORWARD_BIAS_DEG", DEFAULT_ARM_FORWARD_BIAS_DEG)


def _rot(joint: str) -> np.ndarray:
    return Rotation.from_quat(_REFERENCE["rotations_xyzw"][joint]).as_matrix()


def hand_gap(rest: Mapping[str, Sequence[float]], chest_forward: float) -> dict[str, float]:
    """Metres each hand sits behind ARDY's (positive = behind) in the reference pose, relative to
    the hips, with ARDY scaled to the avatar's hips height; plus the avatar's mean arm length."""
    p = {bone: np.asarray(rest[bone], dtype=np.float64) for bone in REST_BONES}
    scale = p["hips"][1] / SOMA_REST_HIPS_HEIGHT
    lean = Rotation.from_euler("x", chest_forward, degrees=True).as_matrix()
    hips_ref = np.asarray(_REFERENCE["positions_m"]["Hips"])

    # FK of the avatar's bone offsets. Below upperChest the globals are ARDY's; upperChest adds the
    # lean; the shoulders cancel it, so shoulder and arm globals are ARDY's again.
    pos = {"hips": np.zeros(3)}
    for bone, parent, soma_parent in _CHAIN:
        pos[bone] = pos[parent] + _rot(soma_parent) @ (p[bone] - p[parent])
    chest_global = _rot("Chest") @ lean
    out: dict[str, float] = {}
    lengths = []
    for side, S in (("left", "Left"), ("right", "Right")):
        shoulder = pos["upperChest"] + chest_global @ (p[f"{side}Shoulder"] - p["upperChest"])
        upper = shoulder + _rot(f"{S}Shoulder") @ (p[f"{side}UpperArm"] - p[f"{side}Shoulder"])
        lower = upper + _rot(f"{S}Arm") @ (p[f"{side}LowerArm"] - p[f"{side}UpperArm"])
        hand = lower + _rot(f"{S}ForeArm") @ (p[f"{side}Hand"] - p[f"{side}LowerArm"])
        ardy = (np.asarray(_REFERENCE["positions_m"][f"{S}Hand"]) - hips_ref) * scale
        out[side] = float(ardy[2] - hand[2])
        lengths.append(float(np.linalg.norm(p[f"{side}Hand"] - p[f"{side}UpperArm"])))
    out["arm_length"] = float(np.mean(lengths))
    return out


def calibrated_arm_forward(rest: Mapping[str, Sequence[float]], chest_forward: float) -> float:
    """The forward arm swing, degrees, that puts this avatar's hands where ARDY's are."""
    gap = hand_gap(rest, chest_forward)
    behind = (gap["left"] + gap["right"]) / 2
    ratio = max(-1.0, min(1.0, behind / gap["arm_length"]))
    return math.degrees(math.asin(ratio))


@lru_cache(maxsize=16)
def _cached(rest: tuple, chest_forward: float, bias: float) -> float:
    angle = calibrated_arm_forward(dict(rest), chest_forward) + bias
    return max(-MAX_ARM_FORWARD_DEG, min(MAX_ARM_FORWARD_DEG, angle))


def arm_forward_for_avatar(rest: Mapping[str, Sequence[float]], chest_forward: float) -> float:
    """Calibrated angle plus the bias, clamped to ±15°. Cached per skeleton: the app sends the same
    one with every request until the avatar changes."""
    key = tuple((bone, tuple(round(float(v), 5) for v in rest[bone])) for bone in REST_BONES)
    return _cached(key, chest_forward, arm_forward_bias_deg())
