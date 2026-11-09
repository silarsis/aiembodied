"""Steering helpers for the ARDY backend: pure numpy (no torch, no ardy), so they run in CI.

Conventions (see API.md): the motion frame has its origin on the floor under the hips where the stream
started, +Y up, facing +Z. Heading theta means facing (sin theta, 0, cos theta). Requests are in the
avatar's metres; the model works in SOMA metres, so everything entering a `ConstraintPlan` is divided by
`scale` (avatar hips height / SOMA rest hips height) and everything leaving it is multiplied by it.

`Targets` and `ConstraintPlan.visible` mirror `Targets` in the verified research script steer_test.py:
absolute frame -> value dicts, with joint and rotation targets keyed (frame, joint name).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Mapping, Optional, Sequence

import numpy as np

from .retarget import SOMA_REST_HIPS_HEIGHT

HAND_LENGTH_M = 0.18  # SOMA wrist -> middle fingertip, measured on generated frames (REPORT.md)
DEFAULT_CORNER_RADIUS = 0.6
ARC_SPACING_M = 0.05
PATH_END_HOLD_S = 0.5


# ----------------------------------------------------------------------------------------------
# Units and angles
# ----------------------------------------------------------------------------------------------


def scale_for(avatar_rest: Optional[Mapping[str, Sequence[float]]]) -> float:
    """Avatar metres per SOMA metre: the avatar's hips height over SOMA's rest hips height (1.0 without a skeleton)."""
    if not avatar_rest:
        return 1.0
    return float(avatar_rest["hips"][1]) / SOMA_REST_HIPS_HEIGHT


def to_model_units(value_m, scale: float):
    """Request (avatar) metres -> SOMA metres. Accepts a number or any array-like; returns float or ndarray."""
    v = np.asarray(value_m, dtype=float) / scale
    return float(v) if v.ndim == 0 else v


def from_model_units(value, scale: float):
    """SOMA metres -> avatar metres."""
    v = np.asarray(value, dtype=float) * scale
    return float(v) if v.ndim == 0 else v


def ang_diff(a, b):
    """a - b wrapped to [-pi, pi)."""
    return (np.asarray(a) - np.asarray(b) + math.pi) % (2 * math.pi) - math.pi


def heading_of(joints: np.ndarray, jidx: Mapping[str, int]) -> np.ndarray:
    """Facing angle per frame from the hip line (RightLeg - LeftLeg): theta = atan2(dz, -dx), so 0 = +Z.
    `joints` is [T, J, 3] (or [J, 3] for one frame); `jidx` maps joint name -> index."""
    j = np.asarray(joints)
    d = j[..., jidx["RightLeg"], :] - j[..., jidx["LeftLeg"], :]
    return np.arctan2(d[..., 2], -d[..., 0])


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def yaw_matrix(theta: float) -> np.ndarray:
    """Rotation about +Y taking +Z to (sin theta, 0, cos theta)."""
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


# ----------------------------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------------------------


def _dedupe(points, eps: float = 1e-6) -> np.ndarray:
    pts = np.asarray(points, dtype=float).reshape(-1, 2)
    keep = [pts[0]]
    for p in pts[1:]:
        if np.linalg.norm(p - keep[-1]) > eps:
            keep.append(p)
    return np.asarray(keep)


def smooth_path(points, corner_radius: float = DEFAULT_CORNER_RADIUS, spacing: float = ARC_SPACING_M) -> np.ndarray:
    """Round each interior corner of a polyline with a circular arc (sampled about every `spacing` metres).

    The arc has radius `corner_radius`, unless that would need more than half of the shorter adjacent
    segment: then the tangent length is clamped to that half and the arc gets tighter. Straight vertices
    and 180 degree reversals are left alone. The start and end points are kept exactly."""
    pts = _dedupe(points)
    if len(pts) < 3 or corner_radius <= 0:
        return pts.copy()
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        a, b, c = pts[i - 1], pts[i], pts[i + 1]
        lu, lv = np.linalg.norm(a - b), np.linalg.norm(c - b)
        u, v = (a - b) / lu, (c - b) / lv
        theta = math.acos(float(np.clip(np.dot(u, v), -1.0, 1.0)))  # interior angle
        turn = math.pi - theta
        if turn < 1e-3 or theta < 1e-3:
            out.append(b)
            continue
        d = min(corner_radius / math.tan(theta / 2), 0.5 * min(lu, lv))
        r = d * math.tan(theta / 2)
        bis = u + v
        center = b + bis / np.linalg.norm(bis) * (r / math.sin(theta / 2))
        r0 = (b + u * d) - center
        r2 = (b + v * d) - center
        sign = 1.0 if (r0[0] * r2[1] - r0[1] * r2[0]) > 0 else -1.0
        n = max(2, math.ceil(r * turn / spacing))
        for k in range(n + 1):
            ang = sign * turn * k / n
            ca, sa = math.cos(ang), math.sin(ang)
            out.append(center + np.array([ca * r0[0] - sa * r0[1], sa * r0[0] + ca * r0[1]]))
    out.append(pts[-1])
    return _dedupe(out)


def path_length(points) -> float:
    pts = np.asarray(points, dtype=float).reshape(-1, 2)
    return float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum()) if len(pts) > 1 else 0.0


def schedule_path(points, speed: float, start_s: float, fps: float, mode: str = "dense",
                  hold_s: float = PATH_END_HOLD_S) -> list[tuple[int, float, float]]:
    """Time the polyline at `speed` (m/s), starting at `start_s`. Returns (frame, x, z).

    dense: every frame from the start to the end point, then every frame of a `hold_s` hold at the end point.
    waypoints: the vertices after the first (at their arrival frames), then one hold frame at the end."""
    if mode not in ("dense", "waypoints"):
        raise ValueError(f"unknown path mode {mode!r}")
    if speed <= 0:
        raise ValueError("speed must be positive")
    pts = _dedupe(points)
    start_f = int(round(start_s * fps))
    hold_f = int(round(hold_s * fps))
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    end_f = start_f + int(round(cum[-1] / speed * fps))
    end = pts[-1]
    out: dict[int, tuple[float, float]] = {}
    if mode == "waypoints":
        for p, s in zip(pts[1:], cum[1:]):
            out[start_f + int(round(s / speed * fps))] = (float(p[0]), float(p[1]))
        out[end_f + hold_f] = (float(end[0]), float(end[1]))
    else:
        for f in range(start_f, end_f + 1):
            s = min((f - start_f) / fps * speed, cum[-1])
            if len(pts) == 1:
                p = pts[0]
            else:
                k = min(int(np.searchsorted(cum, s, side="right") - 1), len(seg) - 1)
                p = pts[k] + (s - cum[k]) / max(seg[k], 1e-9) * (pts[k + 1] - pts[k])
            out[f] = (float(p[0]), float(p[1]))
        for f in range(end_f + 1, end_f + hold_f + 1):
            out[f] = (float(end[0]), float(end[1]))
    return [(f, x, z) for f, (x, z) in sorted(out.items())]


# ----------------------------------------------------------------------------------------------
# Targets and the plan
# ----------------------------------------------------------------------------------------------


@dataclass
class Targets:
    """Constraints at absolute frames (the form ARDY's condition builder wants)."""

    root2d: dict = field(default_factory=dict)  # frame -> (x, z) pelvis
    heading: dict = field(default_factory=dict)  # frame -> radians
    root_y: dict = field(default_factory=dict)  # frame -> pelvis height
    joints: dict = field(default_factory=dict)  # (frame, joint name) -> (x, y, z)
    rots: dict = field(default_factory=dict)  # (frame, joint name) -> 3x3 global rotation

    def frames(self) -> set:
        return (set(self.root2d) | set(self.heading) | set(self.root_y) | {k[0] for k in self.joints}
                | {k[0] for k in self.rots})

    def max_frame(self, from_frame: int = 0) -> Optional[int]:
        """The last constrained frame at or after `from_frame` (None if there is none)."""
        later = [f for f in self.frames() if f >= from_frame]
        return max(later) if later else None

    @property
    def empty(self) -> bool:
        return not self.frames()


@dataclass
class Entry:
    """Everything constrained on one frame, shown to the model from chunk `reveal` (frame) on."""

    frame: int
    reveal: int = 0
    root: Optional[tuple[float, float]] = None
    height: Optional[float] = None
    heading: Optional[float] = None
    joints: dict = field(default_factory=dict)  # joint name -> (x, y, z)
    rots: dict = field(default_factory=dict)  # joint name -> 3x3


@dataclass
class SnapTarget:
    """A root target the decoded motion is pulled onto exactly (frames t..until inclusive)."""

    t: int
    until: int
    x: float
    z: float


@dataclass
class ConstraintPlan:
    """Per-frame constraints (SOMA metres, request-relative frames) plus the root snap targets."""

    fps: float = 30.0
    entries: list = field(default_factory=list)
    snaps: list = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.entries and not self.snaps

    def visible(self, chunk_start_frame: int) -> Targets:
        """The constraints the model may see for the chunk starting at `chunk_start_frame`: entries whose
        reveal frame has come. Later entries override earlier ones on the same frame and channel."""
        tg = Targets()
        for e in self.entries:
            if chunk_start_frame < e.reveal:
                continue
            f = e.frame
            if e.root is not None:
                tg.root2d[f] = e.root
            if e.height is not None:
                tg.root_y[f] = e.height
            if e.heading is not None:
                tg.heading[f] = e.heading
            for name, xyz in e.joints.items():
                tg.joints[(f, name)] = xyz
            for name, rot in e.rots.items():
                tg.rots[(f, name)] = rot
        return tg


@dataclass
class PathParams:
    points: Sequence[Sequence[float]]
    corner_radius: float = DEFAULT_CORNER_RADIUS
    speed: float = 1.0
    start_s: float = 0.3
    mode: str = "dense"


@dataclass
class TargetParams:
    t: float
    until: Optional[float] = None
    root: Optional[Sequence[float]] = None
    height: Optional[float] = None
    heading: Optional[float] = None
    hand: Optional[str] = None  # "left" | "right"
    position: Optional[Sequence[float]] = None  # wrist, with hand
    reveal_s: float = 0.0


def seconds_to_frame_ceil(seconds: float, fps: float) -> int:
    """First frame at or after `seconds` (tolerant of float noise: 2.0 * 30 stays 60)."""
    return max(0, int(math.ceil(seconds * fps - 1e-6)))


def hand_bundle(hand: str, wrist_xyz: Sequence[float], heading: float, hand_length: float = HAND_LENGTH_M):
    """The demo's end-effector bundle for one frame: wrist and middle-fingertip positions and the palm-down
    wrist rotation, for a hand pointing along the pelvis heading (REPORT section 3c, where heading 0 gave
    wrist err 6 cm). Returns (joints, rots), keyed by SOMA joint name."""
    side = "Right" if hand == "right" else "Left"
    wrist = np.asarray(wrist_xyz, dtype=float)
    fwd = np.array([math.sin(heading), 0.0, math.cos(heading)])
    tip = wrist + fwd * hand_length
    # yaw +90 takes the right arm (-X in the T-pose) to +Z palm down, yaw -90 does the same for the left arm
    rot = yaw_matrix(heading) @ yaw_matrix(math.pi / 2 if hand == "right" else -math.pi / 2)
    return ({f"{side}Hand": tuple(float(v) for v in wrist), f"{side}HandMiddleEnd": tuple(float(v) for v in tip)},
            {f"{side}Hand": rot})


def build_plan(path: Optional[PathParams], targets: Sequence[TargetParams], fps: float, scale: float = 1.0,
               total_frames: Optional[int] = None, hand_length: float = HAND_LENGTH_M) -> ConstraintPlan:
    """Turn the request's path and targets (avatar metres) into per-frame model-unit constraints.

    Path frames come first so that explicit targets override them. Frames at or beyond `total_frames` are dropped."""
    plan = ConstraintPlan(fps=fps)
    limit = total_frames if total_frames is not None else 10**9

    if path is not None:
        pts = to_model_units(np.asarray(path.points, dtype=float), scale)
        radius = to_model_units(path.corner_radius, scale)
        speed = to_model_units(path.speed, scale)
        if path.mode == "dense":
            pts = smooth_path(pts, radius)
        for f, x, z in schedule_path(pts, speed, path.start_s, fps, path.mode):
            if f < limit:
                plan.entries.append(Entry(frame=f, root=(x, z)))

    for tp in targets:
        t_f = max(0, int(round(tp.t * fps)))
        u_f = max(t_f, int(round((tp.until if tp.until is not None else tp.t) * fps)))
        reveal = seconds_to_frame_ceil(tp.reveal_s, fps)
        root = None if tp.root is None else tuple(float(v) for v in to_model_units(np.asarray(tp.root), scale))
        height = None if tp.height is None else to_model_units(tp.height, scale)
        joints: dict = {}
        rots: dict = {}
        if tp.hand is not None:
            if tp.position is None or root is None or height is None or tp.heading is None:
                raise ValueError("a hand target needs position, root, height and heading")
            wrist = to_model_units(np.asarray(tp.position), scale)
            joints, rots = hand_bundle(tp.hand, wrist, tp.heading, hand_length)
        for f in range(t_f, min(u_f, limit - 1) + 1):
            plan.entries.append(Entry(frame=f, reveal=reveal, root=root, height=height, heading=tp.heading,
                                      joints=dict(joints), rots=dict(rots)))
        if root is not None:
            plan.snaps.append(SnapTarget(t_f, u_f, root[0], root[1]))
    plan.snaps.sort(key=lambda s: s.t)
    return plan


# ----------------------------------------------------------------------------------------------
# Window size for ARDY (ported from steer_test.py)
# ----------------------------------------------------------------------------------------------


def window_frames(hist_len: int, win_start: int, max_constraint: Optional[int], future_crop: int,
                  horizon: int, patch: int, max_window: int) -> int:
    """Frames in the model window: history + the new horizon, widened to show constraints up to
    `future_crop` frames beyond them (capped at `max_window`, a multiple of the patch size)."""
    n = hist_len + horizon
    if max_constraint is not None:
        n = max(n, max_constraint - win_start + 1)
        n = min(n, future_crop + hist_len + horizon)
        n = math.ceil(n / patch) * patch
    return max(min(n, max_window), hist_len + horizon)


# ----------------------------------------------------------------------------------------------
# Post-processing: snap the root onto exact targets
# ----------------------------------------------------------------------------------------------


def snap_weights(frames: np.ndarray, snap: SnapTarget, n: int) -> np.ndarray:
    """1 on t..until, a smooth ramp over the `n` frames before t and the `n` frames after until, else 0."""
    f = np.asarray(frames, dtype=float)
    w = np.zeros_like(f)
    w[(f >= snap.t) & (f <= snap.until)] = 1.0
    if n > 0:
        rise = (f < snap.t) & (f >= snap.t - n)
        w[rise] = smoothstep((f[rise] - (snap.t - n) + 1) / (n + 1))
        fall = (f > snap.until) & (f <= snap.until + n)
        w[fall] = 1.0 - smoothstep((f[fall] - snap.until) / (n + 1))
    return w


def snap_root(root_positions: np.ndarray, plan: Optional[ConstraintPlan], fps: float, snap_s: float,
              start_frame: int = 0, carry: Optional[Sequence[float]] = None) -> tuple[np.ndarray, np.ndarray]:
    """Pull the decoded root x/z onto the plan's root targets.

    `root_positions` is [T, 3] for the frames start_frame.. of the request (model units). Each frame is
    blended towards a target with weight 1 on t..until and a smoothstep ramp over `snap_s` before t (and
    back to the raw motion after until, so nothing pops). The blend is per frame, so it is the same
    whichever chunk a frame lands in. `carry` (x, z) is an offset still applied from an earlier stream; it
    fades out over `snap_s`. snap_s <= 0 turns everything off.

    Returns (snapped [T, 3], delta [T, 3]); apply `delta` to every joint so the body moves with the root."""
    root = np.asarray(root_positions, dtype=float)
    delta = np.zeros_like(root)
    n = int(round(snap_s * fps))
    if n <= 0:
        return root.copy(), delta
    frames = start_frame + np.arange(len(root))
    cur = root.copy()
    if carry is not None and (carry[0] != 0 or carry[1] != 0):
        fade = 1.0 - smoothstep((frames + 1) / (n + 1))
        cur[:, 0] += carry[0] * fade
        cur[:, 2] += carry[1] * fade
    if plan is not None:
        for s in plan.snaps:
            w = snap_weights(frames, s, n)
            if not w.any():
                continue
            cur[:, 0] += w * (s.x - cur[:, 0])
            cur[:, 2] += w * (s.z - cur[:, 2])
    delta = cur - root
    return cur, delta


def end_pose(root_positions: np.ndarray, posed_joints: np.ndarray, names: Sequence[str],
             origin_xz: Sequence[float], scale: float = 1.0) -> dict:
    """The last frame as the contract's `end_pose`: pelvis x/z (relative to the stream origin), height,
    heading and both wrists, in avatar metres."""
    idx = {n: i for i, n in enumerate(names)}
    root = np.asarray(root_positions, dtype=float)[-1]
    joints = np.asarray(posed_joints, dtype=float)[-1]
    ox, oz = origin_xz

    def point(p):
        return [round(float((p[0] - ox) * scale), 4), round(float(p[1] * scale), 4), round(float((p[2] - oz) * scale), 4)]

    return {
        "root": [round(float((root[0] - ox) * scale), 4), round(float((root[2] - oz) * scale), 4)],
        "height": round(float(root[1] * scale), 4),
        "heading": round(float(heading_of(joints, idx)), 5),
        "left_hand": point(joints[idx["LeftHand"]]),
        "right_hand": point(joints[idx["RightHand"]]),
    }
