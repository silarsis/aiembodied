"""ARDY backend: autoregressive diffusion, streamed one generation window (2 s) at a time.

Each step calls `autoregressive_step` on top of the previously generated motion (cropped to the
model's trained 10 s window), exactly as ARDY's interactive demo does, and decodes history + new
window together so root/heading integration stays continuous across chunks.
Needs the `ardy` package in this venv.
"""

from __future__ import annotations

import time
from typing import Iterator

import numpy as np

from .base import Backend, Chunk, Motion

DEFAULT_MODEL = "ARDY-SOMA-RP-30FPS-Horizon60"


class ArdyBackend(Backend):
    name = "ardy"
    default_steps = 10

    def load(self) -> None:
        self.options.apply_env()
        import torch
        from ardy.model.load_model import load_model

        device = self.options.device or ("cuda:0" if torch.cuda.is_available() else "cpu")
        self.model = load_model(self.options.model or DEFAULT_MODEL, device=device)
        self.fps = float(self.model.motion_rep.fps)
        self.horizon = int(self.model.gen_horizon_len)
        patch = int(self.model.num_frames_per_token)
        max_window = (int(10 * self.fps) // patch) * patch
        self.max_history = ((max_window - self.horizon) // patch) * patch
        self.max_steps = int(self.model.diffusion.num_base_steps)
        self.default_steps = self.max_steps
        self.device_label = device + (f" {torch.cuda.get_device_name(0)}" if device.startswith("cuda") else "")
        list(self.stream(self.encode("A person stands still."), self.horizon, 2))  # warmup

    def encode(self, prompt: str):
        import torch

        with torch.no_grad():
            return self.model._encode_text([prompt])

    def _decode(self, features) -> Motion:
        from ardy.skeleton.definitions import SOMASkeleton30

        out = self.model.motion_rep.inverse(features, is_normalized=True)
        if isinstance(self.model.skeleton, SOMASkeleton30):
            out = self.model.skeleton.output_to_SOMASkeleton77(out)
        g = out["global_rot_mats"][0].float().cpu().numpy()
        p = out["posed_joints"][0].float().cpu().numpy()
        r = out["root_positions"][0].float().cpu().numpy()
        return Motion(g, p, r)

    def stream(self, text, frames: int, steps: int) -> Iterator[Chunk]:
        import torch

        if self.options.seed is not None:
            torch.manual_seed(self.options.seed)
        text_feat, text_pad_mask = text
        device = self.model.device
        history = None  # normalized ARDY features [1, T, D], global frame
        for start in range(0, frames, self.horizon):
            t0 = time.perf_counter()
            hist = None if history is None else history[:, -self.max_history:]
            hist_len = 0 if hist is None else hist.shape[1]
            first = hist is None
            with torch.no_grad():
                window = self.model.autoregressive_step(
                    num_frames=hist_len + self.horizon,
                    num_denoising_steps=steps,
                    motion_mask=None,
                    observed_motion=None,
                    cfg_weight=(2.0, 2.0),
                    text_feat=text_feat,
                    text_pad_mask=text_pad_mask,
                    init_history_sequence=hist,
                    init_global_translation=torch.zeros(1, 3, device=device) if first else None,
                    init_first_heading_angle=torch.zeros(1, device=device) if first else None,
                )
                new = window[:, hist_len : hist_len + self.horizon]
                history = new if history is None else torch.cat([history, new], dim=1)
                decoded = self._decode(window[:, : hist_len + self.horizon])
            n = min(self.horizon, frames - start)
            chunk = decoded.slice(hist_len, hist_len + n)
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            yield Chunk(chunk, start, generate_ms=(time.perf_counter() - t0) * 1000)

    def generate(self, text, frames: int, steps: int) -> Motion:
        return Motion.concat([c.motion for c in self.stream(text, frames, steps)])
