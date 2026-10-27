"""Kimodo backend: whole-clip diffusion (no early start). Needs the `kimodo` package in this venv."""

from __future__ import annotations

import numpy as np

from .base import Backend, Motion

DEFAULT_MODEL = "Kimodo-SOMA-RP-v1.2"


class _CachedTextEncoder:
    """Wraps Kimodo's text encoder so encode() can be timed separately from generate()."""

    def __init__(self, inner):
        self.inner = inner
        self.cache: dict[str, tuple] = {}

    def __call__(self, texts):
        texts = [texts] if isinstance(texts, str) else list(texts)
        missing = [t for t in texts if t not in self.cache]
        if missing:
            feats, lengths = self.inner(missing)
            for i, t in enumerate(missing):
                self.cache[t] = (feats[i : i + 1, : lengths[i]], lengths[i])
        import torch

        maxlen = max(self.cache[t][1] for t in texts)
        out = torch.zeros(len(texts), maxlen, self.cache[texts[0]][0].shape[-1], dtype=self.cache[texts[0]][0].dtype,
                          device=self.cache[texts[0]][0].device)
        for i, t in enumerate(texts):
            f, n = self.cache[t]
            out[i, :n] = f[0]
        return out, [self.cache[t][1] for t in texts]

    def __getattr__(self, item):
        return getattr(self.inner, item)


class KimodoBackend(Backend):
    name = "kimodo"
    default_steps = 25
    max_steps = 1000

    def load(self) -> None:
        self.options.apply_env()
        import torch
        from kimodo import load_model

        device = self.options.device or ("cuda:0" if torch.cuda.is_available() else "cpu")
        self.model = load_model(self.options.model or DEFAULT_MODEL, device=device)
        self.model.text_encoder = _CachedTextEncoder(self.model.text_encoder)
        self.fps = float(self.model.fps)
        self.device_label = device + (f" {torch.cuda.get_device_name(0)}" if device.startswith("cuda") else "")
        self._warmup()

    def _warmup(self) -> None:
        self.generate(self.encode("A person stands still."), 30, 2)

    def encode(self, prompt: str):
        self.model.text_encoder([prompt])  # fills the cache
        self.model.text_encoder.cache = {prompt: self.model.text_encoder.cache[prompt]}
        return prompt

    def generate(self, text, frames: int, steps: int) -> Motion:
        import torch

        if self.options.seed is not None:
            torch.manual_seed(self.options.seed)
        out = self.model(text, frames, num_denoising_steps=steps, num_samples=1,
                         post_processing=self.options.postprocess, return_numpy=True, progress_bar=lambda x: x)
        return Motion(np.asarray(out["global_rot_mats"][0]), np.asarray(out["posed_joints"][0]),
                      np.asarray(out["root_positions"][0]))
