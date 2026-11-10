"""ARDY backend: autoregressive diffusion, streamed one generation window (2 s) at a time.

Each step calls `autoregressive_step` on top of the last 2 s of generated motion, as ARDY's interactive
demo does, and decodes history + new window together so root/heading integration stays continuous across
chunks. Paths, targets and hand reaches go in as `motion_mask` / `observed_motion` (see constraints.py and
the research in the step 3 spec); this part cannot run without the ardy package and a GPU.
Needs the `ardy` package in this venv.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Iterator, Optional, Sequence

import numpy as np

from ..constraints import Targets, window_frames
from .base import Backend, Chunk, Motion, StreamHistory

DEFAULT_MODEL = "ARDY-SOMA-RP-30FPS-Horizon60"
HISTORY_S = 2.0  # history shown to each step: REPORT.md found 240 frames leave no room for future targets
FUTURE_CROP = 160  # frames of future context beyond history + horizon when constraints are visible
TEXT_CACHE = 32


def build_conditions(rep, tg: Targets, win_start: int, gen_start: int, num_frames: int, device, joint_index):
    """observed_motion / motion_mask [1, num_frames, D] for the window [win_start, win_start + num_frames).

    Port of steer_test.py `build_conditions` (the demo's `create_conditions` call). Only frames >= gen_start
    (not history) are constrained. `joint_index` maps SOMA30 joint names to indices. Returns (None, None)
    when nothing falls in the window."""
    import math

    import torch

    lo, hi = gen_start, win_start + num_frames
    idx = {"root_2d": [], "global_root_heading": [], "root_y_pos": [], "global_joints_positions": [],
           "global_joints_rots": []}
    dat = {k: [] for k in idx}
    r2 = sorted(f for f in tg.root2d if lo <= f < hi)
    if r2:
        idx["root_2d"].append(torch.tensor([f - win_start for f in r2]))
        dat["root_2d"].append(torch.tensor([tg.root2d[f] for f in r2], dtype=torch.float32))
    hd = sorted(f for f in tg.heading if lo <= f < hi)
    if hd:
        idx["global_root_heading"].append(torch.tensor([f - win_start for f in hd]))
        dat["global_root_heading"].append(
            torch.tensor([[math.cos(tg.heading[f]), math.sin(tg.heading[f])] for f in hd], dtype=torch.float32))
    ry = sorted(f for f in tg.root_y if lo <= f < hi)
    if ry:
        idx["root_y_pos"].append(torch.tensor([f - win_start for f in ry]))
        dat["root_y_pos"].append(torch.tensor([tg.root_y[f] for f in ry], dtype=torch.float32))
    jk = sorted(k for k in tg.joints if lo <= k[0] < hi)
    if jk:
        missing = [k for k in jk if k[0] not in tg.root2d]
        if missing:
            raise ValueError(f"joint targets need root2d on the same frame: {missing[:3]}")
        idx["global_joints_positions"].append(torch.tensor([[k[0] - win_start, joint_index[k[1]]] for k in jk]))
        dat["global_joints_positions"].append(torch.tensor([tg.joints[k] for k in jk], dtype=torch.float32))
    rk = sorted(k for k in tg.rots if lo <= k[0] < hi)
    if rk:
        idx["global_joints_rots"].append(torch.tensor([[k[0] - win_start, joint_index[k[1]]] for k in rk]))
        dat["global_joints_rots"].append(torch.tensor(np.array([tg.rots[k] for k in rk]), dtype=torch.float32))
    if not any(idx.values()):
        return None, None
    index_dict = {k: v for k, v in idx.items() if v}
    data_dict = {k: v for k, v in dat.items() if v}
    obs, mask = rep.create_conditions(index_dict, data_dict, num_frames, to_normalize=False, device=device)
    obs = rep.normalize(obs) * mask
    return mask[None], obs[None]


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
        self.patch = patch
        self.max_window = (int(10 * self.fps) // patch) * patch
        self.history_frames = max(patch, (int(HISTORY_S * self.fps) // patch) * patch)
        self.joint_index = {n: i for i, n in enumerate(self.model.motion_rep.skeleton.bone_order_names)}
        self._texts: "OrderedDict[str, tuple]" = OrderedDict()
        self.max_steps = int(self.model.diffusion.num_base_steps)
        self.default_steps = self.max_steps
        self.device_label = device + (f" {torch.cuda.get_device_name(0)}" if device.startswith("cuda") else "")
        list(self.stream(self.encode("A person stands still."), self.horizon, 2))  # warmup

    supports_constraints = True

    def encode(self, prompt: str):
        import torch

        if prompt in self._texts:  # phase prompts are encoded once and reused
            self._texts.move_to_end(prompt)
            return self._texts[prompt]
        with torch.no_grad():
            self._texts[prompt] = self.model._encode_text([prompt])
        while len(self._texts) > TEXT_CACHE:
            self._texts.popitem(last=False)
        return self._texts[prompt]

    def _decode(self, features) -> Motion:
        from ardy.skeleton.definitions import SOMASkeleton30

        out = self.model.motion_rep.inverse(features, is_normalized=True)
        if isinstance(self.model.skeleton, SOMASkeleton30):
            out = self.model.skeleton.output_to_SOMASkeleton77(out)
        g = out["global_rot_mats"][0].float().cpu().numpy()
        p = out["posed_joints"][0].float().cpu().numpy()
        r = out["root_positions"][0].float().cpu().numpy()
        return Motion(g, p, r)

    def stream(self, text, frames: int, steps: int, *, plan=None, phase_texts: Optional[Sequence] = None,
               history: Optional[StreamHistory] = None, constraint_weight: float = 2.0) -> Iterator[Chunk]:
        """One 60-frame `autoregressive_step` per chunk, as in steer_test.py (verified on the real model).

        Each chunk sees HISTORY_S of history, the new horizon and, when constraints are visible, up to
        FUTURE_CROP frames of future context. `plan.visible(start)` decides which constraints it may see
        (reveal per phase); `phase_texts` switches the prompt at chunk boundaries; `history` continues an
        earlier stream in its global frame."""
        import torch

        if self.options.seed is not None:
            torch.manual_seed(self.options.seed)
        device = self.model.device
        phases = sorted(phase_texts or [], key=lambda p: p[0])
        feats = None if history is None else history.payload  # normalized ARDY features [1, T, D], global frame
        base = 0 if history is None else history.total_frames
        for start in range(0, frames, self.horizon):
            t0 = time.perf_counter()
            text_feat, text_pad_mask = text
            for phase_start, phase_text in phases:
                if phase_start <= start:
                    text_feat, text_pad_mask = phase_text
            hist = None if feats is None else feats[:, -self.history_frames:]
            hist_len = 0 if hist is None else hist.shape[1]
            win_start = start - hist_len
            n_window = hist_len + self.horizon
            mask = observed = None
            tg = None if plan is None else plan.visible(start)
            if tg is not None and not tg.empty:
                n_window = window_frames(hist_len, win_start, tg.max_frame(start), FUTURE_CROP, self.horizon,
                                         self.patch, self.max_window)
                mask, observed = build_conditions(self.model.motion_rep, tg, win_start, start, n_window, device,
                                                  self.joint_index)
            first = hist is None
            with torch.no_grad():
                window = self.model.autoregressive_step(
                    num_frames=n_window,
                    num_denoising_steps=steps,
                    motion_mask=mask,
                    observed_motion=observed,
                    cfg_weight=(2.0, constraint_weight),
                    text_feat=text_feat,
                    text_pad_mask=text_pad_mask,
                    init_history_sequence=hist,
                    init_global_translation=torch.zeros(1, 3, device=device) if first else None,
                    init_first_heading_angle=torch.zeros(1, device=device) if first else None,
                )
                n = min(self.horizon, frames - start)
                # Keep only the frames that will be played (a multiple of the patch size), so a later
                # continue_from resumes where the avatar stopped, not at the end of the horizon.
                keep = self.horizon if n == self.horizon else (n // self.patch) * self.patch
                new = window[:, hist_len : hist_len + keep]
                feats = new if feats is None else torch.cat([feats, new], dim=1)
                feats = feats[:, -self.history_frames:]
                decoded = self._decode(window[:, : hist_len + self.horizon])
            chunk = decoded.slice(hist_len, hist_len + n)
            if torch.cuda.is_available():
                torch.cuda.synchronize()
            yield Chunk(chunk, start, generate_ms=(time.perf_counter() - t0) * 1000,
                        history=StreamHistory(base + start + keep, feats, emitted_ahead=n - keep))

    def generate(self, text, frames: int, steps: int) -> Motion:
        return Motion.concat([c.motion for c in self.stream(text, frames, steps)])
