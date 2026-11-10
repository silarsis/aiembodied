"""Backend interface: a loaded text-to-motion model producing SOMA motion."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional, Sequence

import numpy as np

log = logging.getLogger("motion_service")


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

    def translated(self, delta: np.ndarray) -> "Motion":
        """Every joint and the root moved by `delta` ([T, 3] metres)."""
        d = np.asarray(delta, dtype=self.posed_joints.dtype)
        return Motion(self.global_rot_mats, self.posed_joints + d[:, None, :], self.root_positions + d)

    @staticmethod
    def concat(parts: list["Motion"]) -> "Motion":
        return Motion(
            np.concatenate([p.global_rot_mats for p in parts]),
            np.concatenate([p.posed_joints for p in parts]),
            np.concatenate([p.root_positions for p in parts]),
        )


@dataclass
class StreamHistory:
    """What a backend needs to carry on a stream later (`continue_from`): opaque to app.py.

    total_frames counts the frames generated so far across the stream and the ones it continued.
    emitted_ahead is how many frames the stream already sent beyond total_frames: the history is cut to
    whole patches, so a continuation starts that many frames before the last one the client played."""

    total_frames: int = 0
    payload: Any = None
    emitted_ahead: int = 0


@dataclass
class Chunk:
    motion: Motion
    start_frame: int
    encode_ms: float = 0.0
    generate_ms: float = 0.0
    history: Optional[StreamHistory] = None  # state after this chunk; the last one of a stream is what to keep


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

    def warm(self) -> None:
        """Run a tiny generation so the text encoder and model weights stay resident on the GPU."""
        self.generate(self.encode("A person stands still."), 30, 2)

    supports_constraints = False
    _warned_constraints = False

    def stream(self, text, frames: int, steps: int, *, plan=None, phase_texts: Optional[Sequence] = None,
               history: Optional[StreamHistory] = None, constraint_weight: float = 2.0) -> Iterator[Chunk]:
        """Yield continuous chunks covering `frames` frames. Default: one chunk, constraints ignored.

        plan: a `ConstraintPlan` (model units, request-relative frames) or None.
        phase_texts: [(start_frame, text)] later prompts; each applies from the first chunk starting at or
            after its frame.
        history: a `StreamHistory` from an earlier stream to continue in the same frame."""
        import time

        if (plan is not None or phase_texts or history is not None) and not type(self)._warned_constraints:
            type(self)._warned_constraints = True
            log.warning("the %s backend ignores paths, targets, phases and continue_from (they need ARDY)", self.name)
        t = time.perf_counter()
        motion = self.generate(text, frames, steps)
        yield Chunk(motion, 0, generate_ms=(time.perf_counter() - t) * 1000)
