"""Run `laya-train` with guards and timing (see README.md in this folder).

Use it exactly like `laya-train`; every argument is passed through:

    python train.py --data train.jsonl --eval val.jsonl --base convaiinnovations/laya --out ckpt/run1 --shuffle-options

What it adds:

- Mixed precision: `LAYA_AMP_DTYPE=fp16` (laya's default), `bf16`, or `off` (plain fp32). Default `fp16`.
- Every optimizer step checks the gradients. Parameters with non-finite gradients are named in the log
  (`NONFINITE_GRAD_PARAMS ...`). With `LAYA_ZERO_BAD_GRADS=1` those gradients are set to zero so the step can
  go ahead; without it the step is left to laya (its GradScaler skips the step).
- `SCALER updates N skipped M scale S` every 50 updates. If most updates are skipped, the run is not learning.
- If a step leaves any weight non-finite, the run stops at once (exit 3) instead of training on garbage.
- If more than about a tenth of the updates were skipped, it prints a WARNING and exits 4: don't use the checkpoint.
- At the end: `TRAIN_LOOP_SECONDS`, `WALL_SECONDS` and `PEAK_CUDA_GB`.
"""
import os
import sys
import time

import torch
import laya.train as T

AMP_DTYPE = os.environ.get("LAYA_AMP_DTYPE", "fp16").lower()
ZERO_BAD_GRADS = os.environ.get("LAYA_ZERO_BAD_GRADS") == "1"
_state = {"model": None, "steps": 0, "updates": 0, "skipped": 0, "bad_grad_steps": 0}

# --- precision ---------------------------------------------------------------------------------
_orig_train_model = T.train_model


def _train_model(*a, **k):
    model = a[0]
    cfg = a[3] if len(a) > 3 else k["config"]
    if AMP_DTYPE == "off":
        cfg.amp = False
    _state["model"] = model
    print("CONFIG amp_dtype=%s amp=%s checkpointing=%s encoder_lr=%g head_lr=%g epochs=%d"
          % (AMP_DTYPE, cfg.amp, cfg.gradient_checkpointing, cfg.encoder_lr, cfg.head_lr, cfg.epochs), flush=True)
    t = time.time()
    r = _orig_train_model(*a, **k)
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    print("TRAIN_LOOP_SECONDS %.1f" % (time.time() - t), flush=True)
    return r


T.train_model = _train_model

if AMP_DTYPE == "bf16":
    def _forward(model, batch, device, amp, detach_encoder):
        args = tuple(batch[k].to(device) for k in ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"))
        kw = {"detach_encoder": detach_encoder}
        if "option_ids" in batch:
            kw.update(position_ids=batch["position_ids"].to(device), option_ids=batch["option_ids"].to(device))
        if amp:
            with torch.autocast(device.type, dtype=torch.bfloat16):
                logits, _ = model(*args, **kw)
        else:
            logits, _ = model(*args, **kw)
        return logits.float()

    T._forward = _forward

# --- a non-finite loss on one batch is skipped without touching the graph ------------------------


def _guard(fn):
    def g(logits, *a, **k):
        loss = fn(logits, *a, **k)
        if not torch.isfinite(loss):
            print("NONFINITE_LOSS_SKIPPED (logits finite: %s)" % bool(torch.isfinite(logits).all()), flush=True)
            return torch.zeros((), device=logits.device, requires_grad=True)
        return loss
    return g


T.rlcd_loss = _guard(T.rlcd_loss)
T.soft_ce_loss = _guard(T.soft_ce_loss)

# --- gradient and weight checks around every optimizer step -------------------------------------
_orig_unscale = torch.amp.GradScaler.unscale_


def _named_bad_grads():
    model = _state["model"]
    if model is None:
        return []
    return [(n, p) for n, p in model.named_parameters() if p.grad is not None and not torch.isfinite(p.grad).all()]


def _report_and_fix(where):
    bad = _named_bad_grads()
    if bad:
        _state["bad_grad_steps"] += 1
        if _state["bad_grad_steps"] <= 5 or _state["bad_grad_steps"] % 100 == 0:
            print("NONFINITE_GRAD_PARAMS (%s, step %d, %d so far): %s"
                  % (where, _state["steps"] + 1, _state["bad_grad_steps"], [n for n, _ in bad][:10]), flush=True)
        if ZERO_BAD_GRADS:
            for _, p in bad:
                p.grad.nan_to_num_(nan=0.0, posinf=0.0, neginf=0.0)


def _unscale(self, optimizer):
    r = _orig_unscale(self, optimizer)
    if _named_bad_grads():
        _report_and_fix("after unscale")
        if ZERO_BAD_GRADS:
            # The scaler already recorded an inf for this step; clear it so the cleaned step is taken.
            for v in self._per_optimizer_states[id(optimizer)]["found_inf_per_device"].values():
                v.zero_()
    return r


torch.amp.GradScaler.unscale_ = _unscale

_orig_update = torch.amp.GradScaler.update


def _update(self, *a, **k):
    states = self._per_optimizer_states.values() if self._per_optimizer_states else []
    found = sum(v.item() for st in states for v in st["found_inf_per_device"].values())
    _state["updates"] += 1
    _state["skipped"] += int(found > 0)
    if _state["updates"] % 50 == 0:
        print("SCALER updates %d skipped %d scale %g" % (_state["updates"], _state["skipped"], self.get_scale()), flush=True)
    return _orig_update(self, *a, **k)


torch.amp.GradScaler.update = _update

_orig_step = torch.optim.AdamW.step


def _step(self, *a, **k):
    _report_and_fix("before step")
    r = _orig_step(self, *a, **k)
    _state["steps"] += 1
    model = _state["model"]
    if model is not None:
        bad = [n for n, p in model.named_parameters() if not torch.isfinite(p).all()]
        if bad:
            print("NONFINITE_WEIGHTS after optimizer step %d: %s" % (_state["steps"], bad[:10]), flush=True)
            sys.exit(3)
    return r


torch.optim.AdamW.step = _step

if __name__ == "__main__":
    from laya.train_cli import main

    t0 = time.time()
    rc = main(sys.argv[1:])
    print("WALL_SECONDS %.1f" % (time.time() - t0), flush=True)
    print("OPTIMIZER_STEPS %d SCALER_SKIPPED %d BAD_GRAD_STEPS %d"
          % (_state["steps"], _state["skipped"], _state["bad_grad_steps"]), flush=True)
    # With fp16 a few skipped updates are normal while the loss scale settles; many are not.
    if _state["skipped"] > max(5, _state["updates"] // 10):
        print("WARNING: this run did not train cleanly (%d of %d updates skipped for non-finite gradients); "
              % (_state["skipped"], _state["updates"]) +
              "do not use the checkpoint. See README.md, step 5.", flush=True)
        rc = rc or 4
    if torch.cuda.is_available():
        print("PEAK_CUDA_GB %.2f" % (torch.cuda.max_memory_allocated() / 2 ** 30), flush=True)
    sys.exit(rc or 0)
