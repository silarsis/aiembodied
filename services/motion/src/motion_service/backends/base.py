"""Backend interface: a loaded text-to-motion model producing SOMA motion."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Iterator, Optional

import numpy as np


@dataclass
class Motion:
    """SOMA motion for one sample (no batch dim): global_rot_mats [T,J,3,3], posed_joints [T,J,3], root [T,3]."""

    global_rot_mats: np.ndarray
    posed_joints: np.ndarray
    root_positions: np.ndarray

    @property
    def frames(self) -> int:
        return int(self.global_rot_mats.shape[0])

    def slice(self, start: int, end: int) -> "Motion":
        return Motion(self.global_rot_mats[start:end], self.posed_joints[start:end], self.root_positions[start:end])

    @staticmethod
    def concat(parts: list["Motion"]) -> "Motion":
        return Motion(
            np.concatenate([p.global_rot_mats for p in parts]),
            np.concatenate([p.posed_joints for p in parts]),
            np.concatenate([p.root_positions for p in parts]),
        )


@dataclass
class Chunk:
    motion: Motion
    start_frame: int
    encode_ms: float = 0.0
    generate_ms: float = 0.0


@dataclass
class BackendOptions:
    model: Optional[str] = None
    device: Optional[str] = None
    text_encoder_device: str = "gpu"  # gpu | cpu
    text_encoders_dir: Optional[str] = None
    postprocess: bool = True
    seed: Optional[int] = None
    extra: dict = field(default_factory=dict)

    def apply_env(self) -> None:
        """Kimodo/ARDY read their text-encoder settings from the environment."""
        if self.text_encoders_dir:
            os.environ["TEXT_ENCODERS_DIR"] = self.text_encoders_dir
        os.environ.setdefault("TEXT_ENCODER_MODE", "local")
        if self.text_encoder_device == "cpu":
            os.environ["TEXT_ENCODER_DEVICE"] = "cpu"


class Backend:
    """Subclasses load one model and generate SOMA motion. Calls are serialized by the app."""

    name = "base"
    fps: float = 30.0
    default_steps: int = 25
    max_steps: Optional[int] = None

    def __init__(self, options: Optional[BackendOptions] = None):
        self.options = options or BackendOptions()
        self.device_label = "unloaded"

    def load(self) -> None:
        raise NotImplementedError

    def encode(self, prompt: str):
        """Return an opaque text-conditioning object for the prompt."""
        raise NotImplementedError

    def generate(self, text, frames: int, steps: int) -> Motion:
        """Generate a whole clip of `frames` frames."""
        raise NotImplementedError

    def stream(self, text, frames: int, steps: int) -> Iterator[Chunk]:
        """Yield continuous chunks covering `frames` frames. Default: one chunk."""
        import time

        t = time.perf_counter()
        motion = self.generate(text, frames, steps)
        yield Chunk(motion, 0, generate_ms=(time.perf_counter() - t) * 1000)
