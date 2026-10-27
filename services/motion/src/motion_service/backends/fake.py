"""Deterministic GPU-free backend for tests: SOMA rest pose with a waving right arm."""

from __future__ import annotations

import time
from typing import Iterator

import numpy as np
from scipy.spatial.transform import Rotation

from ..retarget import SOMA77
from .base import Backend, Chunk, Motion

# Joint offsets (metres, rest pose, relative to Hips) for the joints the tests look at; others sit at the hips.
_REST = {
    "Hips": (0, 0, 0), "Spine1": (0, 0.05, 0), "Spine2": (0, 0.12, 0), "Chest": (0, 0.2, 0),
    "Neck1": (0, 0.46, 0), "Head": (0, 0.6, 0.03),
    "LeftLeg": (0.1, -0.08, 0), "LeftShin": (0.1, -0.52, 0), "LeftFoot": (0.1, -0.94, 0),
    "LeftToeBase": (0.1, -0.99, 0.12), "RightLeg": (-0.1, -0.08, 0), "RightShin": (-0.1, -0.52, 0),
    "RightFoot": (-0.1, -0.94, 0), "RightToeBase": (-0.1, -0.99, 0.12),
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


class FakeBackend(Backend):
    name = "fake"
    default_steps = 10
    max_steps = 50
    chunk_frames = 60

    def __init__(self, options=None, load_delay: float = 0.0, fail_after_chunks: int | None = None):
        super().__init__(options)
        self.load_delay = load_delay
        self.fail_after_chunks = fail_after_chunks

    def load(self) -> None:
        time.sleep(self.load_delay)
        self.device_label = "cpu (fake)"

    def encode(self, prompt: str):
        return prompt

    def generate(self, text, frames: int, steps: int) -> Motion:
        return synthetic_motion(frames, self.fps)

    def stream(self, text, frames: int, steps: int) -> Iterator[Chunk]:
        for i, start in enumerate(range(0, frames, self.chunk_frames)):
            if self.fail_after_chunks is not None and i >= self.fail_after_chunks:
                raise RuntimeError("fake backend failure")
            n = min(self.chunk_frames, frames - start)
            yield Chunk(synthetic_motion(n, self.fps, start), start, generate_ms=1.0)
