"""Deterministic GPU-free backend for tests: SOMA rest pose with a waving right arm."""

from __future__ import annotations

import time
from typing import Iterator, Optional, Sequence

import numpy as np
from scipy.spatial.transform import Rotation

from ..constraints import Targets, ang_diff
from ..retarget import SOMA77
from .base import Backend, Chunk, Motion, StreamHistory

# Joint offsets (metres, rest pose, relative to Hips) for the joints the tests look at; others sit at the hips.
_REST = {
    "Hips": (0, 0, 0), "Spine1": (0, 0.05, 0), "Spine2": (0, 0.12, 0), "Chest": (0, 0.2, 0),
    "Neck1": (0, 0.46, 0), "Head": (0, 0.6, 0.03),
    "LeftLeg": (0.1, -0.08, 0), "LeftShin": (0.1, -0.52, 0), "LeftFoot": (0.1, -0.94, 0),
    "LeftToeBase": (0.1, -0.989, 0.12), "RightLeg": (-0.1, -0.08, 0), "RightShin": (-0.1, -0.52, 0),
    "RightFoot": (-0.1, -0.94, 0), "RightToeBase": (-0.1, -0.989, 0.12),
}
HIPS_HEIGHT = 0.99


def synthetic_motion(frames: int, fps: float = 30.0, start_frame: int = 0) -> Motion:
    """Right upper arm raised 80 degrees and waving about Z; hips sway 2 cm on X."""
    J = len(SOMA77)
    idx = {n: i for i, n in enumerate(SOMA77)}
    t = (np.arange(frames) + start_frame) / fps
    G = np.tile(np.eye(3), (frames, J, 1, 1))
    raise_arm = Rotation.from_euler("z", -80, degrees=True)  # right arm (on -X) up
    wave = Rotation.from_euler("z", 25 * np.sin(2 * np.pi * 1.5 * t)[:, None], degrees=True)
    arm = (raise_arm * Rotation.identity(frames)).as_matrix()
    forearm = (raise_arm * wave).as_matrix()
    G[:, idx["RightArm"]] = arm
    for n in ("RightForeArm", "RightHand"):
        G[:, idx[n]] = forearm
    root = np.stack([0.02 * np.sin(2 * np.pi * 0.5 * t), np.full(frames, HIPS_HEIGHT), np.zeros(frames)], axis=1)
    P = np.repeat(root[:, None, :], J, axis=1).copy()
    for n, off in _REST.items():
        P[:, idx[n]] = root + np.array(off)
    return Motion(G, P, root)


def _yaw(theta: np.ndarray) -> np.ndarray:
    """[T,3,3] rotations about +Y taking +Z to (sin theta, 0, cos theta)."""
    c, sn = np.cos(theta), np.sin(theta)
    R = np.zeros((len(theta), 3, 3))
    R[:, 0, 0], R[:, 0, 2], R[:, 1, 1], R[:, 2, 0], R[:, 2, 2] = c, sn, 1.0, -sn, c
    return R


def _approach(cur: float, frames: range, targets: dict, wrap: bool = False) -> np.ndarray:
    """Per-frame values moving linearly from `cur` so that each target is reached on its frame."""
    out = []
    keys = sorted(targets)
    for f in frames:
        nxt = next((k for k in keys if k >= f), None)
        if nxt is not None:
            gap = targets[nxt] - cur
            if wrap:
                gap = float(ang_diff(targets[nxt], cur))
            cur = cur + gap / (nxt - f + 1)
        out.append(cur)
    return np.asarray(out)


class FakeBackend(Backend):
    name = "fake"
    default_steps = 10
    max_steps = 50
    chunk_frames = 60
    supports_constraints = True

    def __init__(self, options=None, load_delay: float = 0.0, fail_after_chunks: int | None = None):
        super().__init__(options)
        self.load_delay = load_delay
        self.fail_after_chunks = fail_after_chunks
        self.calls: list[dict] = []  # what each stream() was given, for plumbing tests

    def load(self) -> None:
        time.sleep(self.load_delay)
        self.device_label = "cpu (fake)"

    def encode(self, prompt: str):
        return prompt

    def generate(self, text, frames: int, steps: int) -> Motion:
        return synthetic_motion(frames, self.fps)

    def _track(self, m: Motion, state: dict, tg, start: int, fresh: bool = False) -> Motion:
        """Crude steering: move the root linearly to the next visible root, height and heading target."""
        frames = range(start, start + m.frames)
        x = _approach(state["x"], frames, {f: v[0] for f, v in tg.root2d.items()})
        z = _approach(state["z"], frames, {f: v[1] for f, v in tg.root2d.items()})
        y = _approach(state["y"], frames, tg.root_y)
        yaw = _approach(state["yaw"], frames, tg.heading, wrap=True)
        if fresh:  # a new stream starts exactly at the origin, like the real model's first frame
            x[0], z[0], y[0], yaw[0] = 0.0, 0.0, HIPS_HEIGHT, 0.0
        state.update(x=float(x[-1]), z=float(z[-1]), y=float(y[-1]), yaw=float(yaw[-1]))
        state["_per_frame"] = (x, y, z, yaw)  # stream() rewinds to the kept frames and drops this
        R = _yaw(yaw)
        old = m.root_positions
        root = np.stack([x, y, z], axis=1)
        offs = np.einsum("tij,tkj->tki", R, m.posed_joints - old[:, None, :])
        return Motion(np.einsum("tij,tkjl->tkil", R, m.global_rot_mats), root[:, None, :] + offs, root)

    def stream(self, text, frames: int, steps: int, *, plan=None, phase_texts: Optional[Sequence] = None,
               history: Optional[StreamHistory] = None, constraint_weight: float = 2.0) -> Iterator[Chunk]:
        self.calls.append({"text": text, "frames": frames, "plan": plan, "phase_texts": list(phase_texts or []),
                           "history": history, "constraint_weight": constraint_weight, "visible": {}, "texts": []})
        call = self.calls[-1]
        tracked = plan is not None or history is not None
        state = dict(history.payload) if history is not None else {"x": 0.0, "z": 0.0, "y": HIPS_HEIGHT, "yaw": 0.0}
        base = history.total_frames if history is not None else 0
        phases = sorted(phase_texts or [], key=lambda p: p[0])
        for i, start in enumerate(range(0, frames, self.chunk_frames)):
            if self.fail_after_chunks is not None and i >= self.fail_after_chunks:
                raise RuntimeError("fake backend failure")
            n = min(self.chunk_frames, frames - start)
            # Like ARDY, a stream cut short keeps whole 4-frame groups: a continuation resumes there.
            keep = n if n == self.chunk_frames else (n // 4) * 4
            m = synthetic_motion(n, self.fps, base + start)
            before = dict(state)
            if tracked:
                tg = plan.visible(start) if plan is not None else None
                call["visible"][start] = tg
                m = self._track(m, state, tg if tg is not None else Targets(), start,
                                fresh=history is None and start == 0)
                per_frame = state.pop("_per_frame", None)
                if keep < n:
                    if keep == 0 or per_frame is None:
                        state.update({k: before[k] for k in ("x", "y", "z", "yaw")})
                    else:
                        x, y, z, yaw = per_frame
                        state.update(x=float(x[keep - 1]), y=float(y[keep - 1]), z=float(z[keep - 1]), yaw=float(yaw[keep - 1]))
            call["texts"].append(next((t for f, t in reversed(phases) if f <= start), text))
            yield Chunk(m, start, generate_ms=1.0,
                        history=StreamHistory(base + start + keep, dict(state), emitted_ahead=n - keep))
