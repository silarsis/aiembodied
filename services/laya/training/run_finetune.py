#!/usr/bin/env python3
"""One-command fine-tuning pipeline for the Laya floor-routing model.

    python run_finetune.py --work DIR [--n 8000] [--seed 0] [--epochs 4]
        [--precision auto|fp16|bf16|fp32] [--loss rlcd|soft-ce] [--base convaiinnovations/laya]
        [--device auto|cuda|cpu] [--math-attention] [--plain-layernorm auto|on|off] [--trial] [--skip-baseline] [--micro-batch 8]

Everything is written under the run folder DIR:

    data/            train.jsonl and val.jsonl from floor_data.py (hold-out sentences excluded)
    baseline.json    the untouched base model scored on val (first 200 rows) and both hold-out files
    checkpoint/      the fine-tuned model (checkpoint.FAILED if training went non-finite or learned nothing)
    train.log        everything training printed
    results.json     the fine-tuned model scored the same way
    REPORT.md        a short plain-English report with a PASS / NEEDS WORK verdict

Exit codes: 0 every step passed (a NEEDS WORK verdict is still 0); 1 a step failed; 2 preflight
failed; 3 training or scoring produced non-finite numbers, or most updates had bad gradients (the checkpoint is renamed to
checkpoint.FAILED).

The hold-out files are only ever read as rows to exclude and to score; they are never written
and never trained on. This module imports with the standard library only; torch and laya are
imported inside the steps that need them.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import platform
import shutil
import statistics
import sys
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import floor_data  # noqa: E402
import score  # noqa: E402

HOLDOUT_FILES = (os.path.join(HERE, "holdout_floor.jsonl"), os.path.join(HERE, "holdout_fresh.jsonl"))
EXPECTED_LAYA = "0.4.31"
MIN_FREE_GB = 6.0
VAL_ROWS = 200
TRIAL_ROWS = 200
LATENCY_LINES = 50
PASS_THRESHOLD = 0.95
# (key in results, label, file name or None for val, row limit)
DATASETS = (
    ("val", "val (first 200)", "val"),
    ("holdout_floor", "hold-out floor", "holdout_floor"),
    ("holdout_fresh", "hold-out fresh", "holdout_fresh"),
)
HOLDOUT_KEYS = ("holdout_floor", "holdout_fresh")
QIDS = score.QIDS
PRECISIONS = ("auto", "fp16", "bf16", "fp32")


class StepFailed(Exception):
    def __init__(self, reason, code=1):
        super().__init__(reason)
        self.reason = reason
        self.code = code


class NonFiniteError(RuntimeError):
    """Raised the moment a loss, parameter or model output is NaN or infinite."""


class BadGradientsError(NonFiniteError):
    """Raised when too many optimizer updates had non-finite gradients (the run did not learn)."""


# ------------------------------------------------------------------ pure helpers (no torch)

def bad_run(updates, skipped, steps, bad_grad_steps, precision):
    """A reason string when the gradients were bad on too many updates, else None.

    fp16 uses a GradScaler, which silently skips an update whose gradients are infinite, so the
    skipped count is the evidence. Without a scaler (fp32, bf16) bad gradients go into the weights,
    so the count of steps with non-finite gradients is the evidence.
    """
    if precision == "fp16":
        limit = max(5, updates // 10)
        if skipped > limit:
            return ("the GPU produced bad gradients on most updates: %d of %d updates were skipped "
                    "(limit %d); the run did not learn" % (skipped, updates, limit))
        return None
    limit = max(5, steps // 10)
    if bad_grad_steps > limit:
        return ("the GPU produced bad gradients on most updates: %d of %d steps had non-finite "
                "gradients (limit %d); the run did not learn" % (bad_grad_steps, steps, limit))
    return None

def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description="Fine-tune the Laya floor-routing model end to end: data, baseline, training, scoring, report.")
    ap.add_argument("--work", required=True, help="run folder; everything is written here (use a new one per run)")
    ap.add_argument("--n", type=int, default=8000, help="total generated rows, 10%% become val (default 8000)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--precision", choices=PRECISIONS, default="auto",
                    help="auto = bf16 if the GPU supports it, else fp16; fp32 on CPU")
    ap.add_argument("--loss", choices=("rlcd", "soft-ce"), default="rlcd")
    ap.add_argument("--base", default="convaiinnovations/laya", help="base checkpoint: Hub id or local folder")
    ap.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    ap.add_argument("--math-attention", action="store_true",
                    help="force PyTorch's plain math attention kernel (slower; a fallback if training goes NaN)")
    ap.add_argument("--plain-layernorm", choices=("auto", "on", "off"), default="auto",
                    help="replace torch LayerNorm forward with plain ops; works around ROCm's wrong LayerNorm "
                         "backward kernel. auto = on for ROCm (AMD) builds of torch, off otherwise")
    ap.add_argument("--trial", action="store_true",
                    help="train on %d rows for 1 epoch, print the time estimate, score it, then stop" % TRIAL_ROWS)
    ap.add_argument("--skip-baseline", action="store_true", help="do not score the untouched base model")
    ap.add_argument("--micro-batch", type=int, default=8,
                    help="rows per forward pass (default 8); gradient accumulation keeps the batch at 64. "
                         "Lower it (4, 2) if the GPU runs out of memory")
    a = ap.parse_args(argv)
    if a.n < 100:
        ap.error("--n must be at least 100")
    if a.epochs < 1:
        ap.error("--epochs must be at least 1")
    if a.micro_batch < 1 or 64 % a.micro_batch:
        ap.error("--micro-batch must divide 64 (1, 2, 4, 8, 16, 32, 64)")
    return a


def want_plain_layernorm(flag, hip_version):
    """Decide whether to use the plain LayerNorm forward. `hip_version` is torch.version.hip (None off ROCm)."""
    if flag == "on":
        return True
    if flag == "off":
        return False
    return bool(hip_version)


def choose_precision(requested, cuda_available, bf16_supported):
    """Return 'fp16', 'bf16' or 'fp32'. Half precision only makes sense on a CUDA device."""
    if requested not in PRECISIONS:
        raise ValueError("precision must be one of %s, got %r" % (", ".join(PRECISIONS), requested))
    if not cuda_available:
        return "fp32"
    if requested == "auto":
        return "bf16" if bf16_supported else "fp16"
    if requested == "bf16" and not bf16_supported:
        return "fp16"
    return requested


def next_try(precision, math_attention, loss, bf16_supported=True):
    """The next fallback to try after a non-finite failure, as extra command-line flags; None when exhausted.

    Order: bf16 -> fp32 -> --math-attention -> --loss soft-ce.
    """
    if precision == "fp16":
        return "--precision bf16" if bf16_supported else "--precision fp32"
    if precision == "bf16":
        return "--precision fp32"
    if not math_attention:
        return "--math-attention"
    if loss != "soft-ce":
        return "--loss soft-ce"
    return None


def verdict(results):
    """PASS when all-three accuracy is >= 0.95 on both hold-out sets, else NEEDS WORK."""
    for key in HOLDOUT_KEYS:
        acc = ((results or {}).get(key) or {}).get("all_three")
        if acc is None or not acc >= PASS_THRESHOLD:
            return "NEEDS WORK"
    return "PASS"


def estimate_full_run(trial_epoch_seconds, trial_train_rows, full_rows, epochs, calib_max=400, calib_frac=0.1):
    """Estimated seconds for the full run from one trial epoch. Returns (seconds_per_epoch, total_seconds).

    Trial and full runs both set aside a calibration slice (laya: min(calib_max, calib_frac of rows)).
    The trial epoch includes start-up cost, so this leans high.
    """
    train_items = max(1, full_rows - min(calib_max, int(full_rows * calib_frac)))
    per_row = trial_epoch_seconds / max(1, trial_train_rows)
    per_epoch = per_row * train_items
    return per_epoch, per_epoch * epochs


def build_exclude_file(paths, dest):
    """Concatenate the hold-out files into `dest` (one JSON row per line); returns the row count."""
    n = 0
    with open(dest, "w", encoding="utf-8") as out:
        for p in paths:
            with open(p, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        out.write(line + "\n")
                        n += 1
    return n


def count_lines(path):
    with open(path, encoding="utf-8") as f:
        return sum(1 for line in f if line.strip())


def read_rows(path, limit=None):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
                if limit and len(rows) >= limit:
                    break
    return rows


def install_help(plat=None):
    plat = plat or sys.platform
    if plat.startswith("win"):
        return ('py -3.12 -m venv "$HOME\\laya-train" ; & "$HOME\\laya-train\\Scripts\\Activate.ps1" ; '
                'python -m pip install torch --index-url https://download.pytorch.org/whl/cu128 ; '
                'python -m pip install "laya[serve]==%s"' % EXPECTED_LAYA)
    return ('python3 -m venv ~/laya-train && source ~/laya-train/bin/activate && '
            'pip install torch --index-url https://download.pytorch.org/whl/cu128 && '
            'pip install "laya[serve]==%s"' % EXPECTED_LAYA)


def finite_number(x):
    return isinstance(x, (int, float)) and math.isfinite(x)


def result_nonfinite(res):
    """A reason string when a scoring result holds NaN or infinite probabilities, else None."""
    for k in ("mean_top_prob_right", "mean_top_prob_wrong", "latency_median"):
        v = res.get(k)
        if v is not None and not finite_number(v):
            return "%s is %r" % (k, v)
    for m in res.get("misses", []):
        for q, a in (m.get("raw") or {}).items():
            vals = [a.get("top")] + list((a.get("probabilities") or {}).values())
            if any(v is not None and not finite_number(v) for v in vals):
                return "the model returned non-finite probabilities for %s on %r" % (q, m.get("text"))
    return None


def _exp_text(want):
    return ", ".join("%s=%s" % (q, "/".join(str(x) for x in v)) for q, v in want.items())


def _got_text(have):
    return ", ".join("%s=%s" % (q, have.get(q)) for q in QIDS)


def worst_misses(results, k=15):
    """The k most confident wrong answers over both hold-out sets (counted rows only)."""
    out = []
    for key in HOLDOUT_KEYS:
        for m in (results.get(key) or {}).get("misses", []):
            if not m.get("counted", True):
                continue
            conf = 0.0
            for q in QIDS:
                exp = [str(x).lower() for x in m["expected"].get(q, [])]
                got = m["got"].get(q)
                if got is None or str(got).lower() not in exp:
                    top = ((m.get("raw") or {}).get(q) or {}).get("top")
                    conf = max(conf, top if finite_number(top) else 0.0)
            out.append({"set": key, "text": m["text"], "expected": _exp_text(m["expected"]),
                        "got": _got_text(m["got"]), "conf": conf})
    out.sort(key=lambda r: -r["conf"])
    return out[:k]


def pct(x):
    return "n/a" if x is None else "%.1f%%" % (100 * x)


def num(x, digits=3):
    return "n/a" if x is None or not finite_number(x) else ("%." + str(digits) + "f") % x


def _cell(s):
    return str(s).replace("|", "/").replace("\n", " ")


def score_table(baseline, results):
    """Markdown table: per set and field, baseline versus tuned accuracy."""
    lines = ["| Set | Field | Baseline | Tuned |", "| --- | --- | --- | --- |"]
    for key, label, _ in DATASETS:
        b = (baseline or {}).get(key) or {}
        t = (results or {}).get(key) or {}
        if not t and not b:
            continue
        for q in QIDS:
            lines.append("| %s | %s | %s | %s |" % (label, q, pct((b.get("accuracy") or {}).get(q)),
                                                   pct((t.get("accuracy") or {}).get(q))))
        lines.append("| %s | **all three** | %s | **%s** |" % (label, pct(b.get("all_three")), pct(t.get("all_three"))))
    return lines


def confidence_lines(baseline, results):
    lines = ["| Set | Mean confidence, right (base / tuned) | Mean confidence, wrong (base / tuned) |",
             "| --- | --- | --- |"]
    for key, label, _ in DATASETS:
        b = (baseline or {}).get(key) or {}
        t = (results or {}).get(key) or {}
        if not t:
            continue
        lines.append("| %s | %s / %s | %s / %s |" % (
            label, num(b.get("mean_top_prob_right")), num(t.get("mean_top_prob_right")),
            num(b.get("mean_top_prob_wrong")), num(t.get("mean_top_prob_wrong"))))
    return lines


def fmt_duration(sec):
    sec = int(round(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return "%dh %02dm" % (h, m) if h else ("%dm %02ds" % (m, s) if m else "%ds" % s)


def render_report(info):
    """REPORT.md text from a plain dict (see step_report). No torch needed."""
    res = info["results"]
    base = info.get("baseline")
    v = verdict(res)
    args = info.get("args", {})
    lat = res.get("latency", {})
    L = ["# Laya floor-routing fine-tune report", "", "**Verdict: %s**" % v, ""]
    if v == "PASS":
        L.append("Both hold-out sets reach at least %.0f%% on all three answers together." % (100 * PASS_THRESHOLD))
    else:
        L.append("At least one hold-out set is below %.0f%% on all three answers together." % (100 * PASS_THRESHOLD))
    L += ["", "## What ran", "",
          "- Precision: %s, loss: %s, epochs: %s, rows generated: %s, seed: %s%s" % (
              info.get("precision"), args.get("loss"), args.get("epochs"), args.get("n"), args.get("seed"),
              ", plain math attention" if args.get("math_attention") else ""),
          "- Base model: %s" % args.get("base"),
          "- Device: %s" % info.get("device_text", "unknown"),
          "- Software: %s" % ", ".join("%s %s" % kv for kv in sorted((info.get("versions") or {}).items())),
          "", "## Timings", ""]
    for name, sec in info.get("timings", {}).items():
        L.append("- %s: %s" % (name, fmt_duration(sec)))
    if info.get("epoch_seconds"):
        L.append("- Training epochs: %s" % ", ".join(fmt_duration(s) for s in info["epoch_seconds"]))
    gh = info.get("grad_health") or {}
    if gh.get("updates") is not None:
        L.append("- Gradient health: %s scaler updates, %s skipped, %s steps with non-finite gradients"
                 % (gh.get("updates"), gh.get("skipped"), gh.get("bad_grad_steps")))
    L += ["", "## Scores (higher is better)", ""]
    L += score_table(base, res)
    L += ["", "Hold-out rows marked debatable are shown in the miss list but not counted.", "",
          "## Confidence", ""]
    L += confidence_lines(base, res)
    L += ["", "## Speed (median time per line)", ""]
    L.append("- This device: %s s" % num(lat.get("device_median")))
    L.append("- CPU: %s s" % num(lat.get("cpu_median")))
    L += ["", "## The 15 most confident hold-out misses", ""]
    worst = info.get("worst") or []
    if not worst:
        L.append("None.")
    else:
        L += ["| Set | Text | Expected | Got |", "| --- | --- | --- | --- |"]
        for w in worst:
            L.append("| %s | %s | %s | %s |" % (w["set"], _cell(w["text"])[:140], _cell(w["expected"]), _cell(w["got"])))
    ck = info.get("checkpoint") or {}
    L += ["", "## Checkpoint", "", "- Folder: `%s`" % ck.get("path"),
          "- Size: %s MB" % ck.get("size_mb")]
    L.append("")
    return "\n".join(L)


# ------------------------------------------------------------------------ output tee

class _Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, s):
        for st in self.streams:
            try:
                st.write(s)
            except Exception:
                pass
        return len(s)

    def flush(self):
        for st in self.streams:
            try:
                st.flush()
            except Exception:
                pass

    def isatty(self):
        return False

    def fileno(self):
        return self.streams[0].fileno()

    def __getattr__(self, name):
        return getattr(self.streams[0], name)


@contextlib.contextmanager
def tee_output(path):
    """Copy stdout and stderr to `path` while still printing to the console."""
    f = open(path, "a", encoding="utf-8", errors="replace", buffering=1)
    old = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = _Tee(old[0], f), _Tee(old[1], f)
    try:
        yield
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        sys.stdout, sys.stderr = old
        f.close()


# ----------------------------------------------------------- torch-side helpers (lazy imports)

def set_math_attention():
    """Force PyTorch's math scaled-dot-product kernel; each switch is optional on older torch."""
    import torch
    done = []
    for name, value in (("enable_flash_sdp", False), ("enable_mem_efficient_sdp", False),
                        ("enable_cudnn_sdp", False), ("enable_math_sdp", True)):
        fn = getattr(torch.backends.cuda, name, None)
        if fn is None:
            continue
        try:
            fn(value)
            done.append("%s(%s)" % (name, value))
        except Exception as e:  # never let a missing switch stop the run
            print("note: %s failed: %s" % (name, e))
    print("math attention forced: " + ", ".join(done))


def plain_layernorm_forward(module, x):
    """LayerNorm written with plain ops, so autograd does not use the backend's LayerNorm backward kernel."""
    import torch
    n = len(module.normalized_shape)
    dims = tuple(range(x.dim() - n, x.dim()))
    out_dtype = x.dtype
    if out_dtype in (torch.float16, torch.bfloat16):
        x = x.float()
    mean = x.mean(dim=dims, keepdim=True)
    var = ((x - mean) ** 2).mean(dim=dims, keepdim=True)
    y = (x - mean) * torch.rsqrt(var + module.eps)
    weight = getattr(module, "weight", None)
    bias = getattr(module, "bias", None)
    if weight is not None:
        y = y * (weight.float() if y.dtype != weight.dtype else weight)
    if bias is not None:
        y = y + (bias.float() if y.dtype != bias.dtype else bias)
    return y.to(out_dtype)


def apply_plain_layernorm(model):
    """Patch every torch.nn.LayerNorm in `model` to use plain_layernorm_forward; returns the count."""
    import torch
    count = 0
    for m in model.modules():
        if isinstance(m, torch.nn.LayerNorm):
            m.forward = types.MethodType(plain_layernorm_forward, m)
            count += 1
    return count


def apply_plain_layernorm_to_agent(agent):
    """Patch the model(s) held by a laya agent (or the agent itself if it is a module); returns the count."""
    import torch
    if isinstance(agent, torch.nn.Module):
        return apply_plain_layernorm(agent)
    return sum(apply_plain_layernorm(v) for v in vars(agent).values() if isinstance(v, torch.nn.Module))


def nonfinite_grad_names(torch, params):
    """Names of parameters whose gradient holds NaN or infinity. `params` is an iterable of (name, tensor)."""
    return [n for n, p in params if p.grad is not None and not bool(torch.isfinite(p.grad).all())]


def first_nonfinite_param(torch, model):
    for name, p in model.named_parameters():
        if not bool(torch.isfinite(p).all()):
            return name
    return None


@contextlib.contextmanager
def patched_training(lt, torch, precision, state, plain_layernorm=False):
    """Install the precision choice and the non-finite guards into laya.train, and restore it after."""
    names = ("_forward", "soft_ce_loss", "rlcd_loss", "train_model")
    saved = {n: getattr(lt, n) for n in names}
    state.update(updates=0, skipped=0, steps=0, bad_grad_steps=0, grads_checked=False, model=None)
    scaler_cls = torch.amp.GradScaler
    opt_cls = torch.optim.AdamW
    # (class, attribute, original, was defined on the class itself)
    class_saved = [(c, n, getattr(c, n), n in vars(c))
                   for c, n in ((scaler_cls, "update"), (scaler_cls, "unscale_"), (opt_cls, "step"))]

    def note_bad_grads():
        model = state.get("model")
        if model is None:
            return
        state["grads_checked"] = True
        names = nonfinite_grad_names(torch, model.named_parameters())
        if names:
            state["bad_grad_steps"] += 1
            k = state["bad_grad_steps"]
            if k <= 5 or k % 100 == 0:
                print("bad gradients (occurrence %d, step %d): %d parameters, first %d: %s"
                      % (k, state["step"], len(names), min(10, len(names)), ", ".join(names[:10])), flush=True)

    orig_update = scaler_cls.update
    orig_unscale = scaler_cls.unscale_
    orig_step = opt_cls.step

    def update(self, *a, **kw):
        found = 0
        try:
            found = sum(v.item() for st in self._per_optimizer_states.values()
                        for v in st["found_inf_per_device"].values())
        except Exception:
            found = 0
        state["updates"] += 1
        if found > 0:
            state["skipped"] += 1
        out = orig_update(self, *a, **kw)
        if state["updates"] % 50 == 0:
            print("scaler: %d updates, %d skipped, scale %s"
                  % (state["updates"], state["skipped"], self.get_scale()), flush=True)
        return out

    def unscale_(self, optimizer, *a, **kw):
        out = orig_unscale(self, optimizer, *a, **kw)
        note_bad_grads()
        return out

    def step(self, *a, **kw):
        if not state["grads_checked"]:  # no scaler unscaled the gradients first (fp32, bf16)
            note_bad_grads()
        state["grads_checked"] = False
        out = orig_step(self, *a, **kw)
        state["steps"] += 1
        model = state.get("model")
        if model is not None:
            bad = first_nonfinite_param(torch, model)
            if bad:
                raise NonFiniteError("parameter %s is not finite after optimizer step %d" % (bad, state["steps"]))
            if precision != "fp16":
                why = bad_run(state["updates"], state["skipped"], state["steps"], state["bad_grad_steps"], precision)
                if why:
                    raise BadGradientsError(why)
        return out
    scaler_cls.update = update
    scaler_cls.unscale_ = unscale_
    opt_cls.step = step

    if precision in ("bf16", "fp32"):
        dtype = torch.bfloat16 if precision == "bf16" else None

        def _forward(model, batch, device, amp, detach_encoder):
            args = (batch["input_ids"].to(device), batch["attention_mask"].to(device),
                    batch["marker_pos"].to(device), batch["marker_mask"].to(device), batch["qtype"].to(device))
            kwargs = {"detach_encoder": detach_encoder}
            if "option_ids" in batch:
                kwargs.update(position_ids=batch["position_ids"].to(device), option_ids=batch["option_ids"].to(device))
            if amp and dtype is not None:
                with torch.autocast(device.type, dtype=dtype):
                    logits, _act = model(*args, **kwargs)
            else:
                logits, _act = model(*args, **kwargs)
            return logits.float()
        lt._forward = _forward

    def wrap_loss(fn):
        def wrapped(*a, **kw):
            state["depth"] += 1
            try:
                loss = fn(*a, **kw)
            finally:
                state["depth"] -= 1
            if state["depth"] == 0:
                state["step"] += 1
                if not bool(torch.isfinite(loss).all()):
                    raise NonFiniteError("loss is %s at epoch %d, step %d"
                                         % (float(loss), state["epoch"], state["step"]))
            return loss
        return wrapped
    lt.soft_ce_loss = wrap_loss(saved["soft_ce_loss"])
    lt.rlcd_loss = wrap_loss(saved["rlcd_loss"])

    orig_train = saved["train_model"]

    def guarded_train(model, tok, items, config, device, max_len, head_max_len, **kw):
        user_hook = kw.pop("on_epoch_end", None)
        if plain_layernorm:
            print("plain LayerNorm: patched %d modules in the model being trained" % apply_plain_layernorm(model),
                  flush=True)
        state.update(epoch=1, step=0, depth=0, t0=time.perf_counter(), train_rows=len(items), model=model)

        def hook(epoch, mean):
            now = time.perf_counter()
            secs = now - state["t0"]
            state["epoch_seconds"].append(secs)
            if not finite_number(mean):
                raise NonFiniteError("mean loss is %r after epoch %d" % (mean, epoch + 1))
            bad = first_nonfinite_param(torch, model)
            if bad:
                raise NonFiniteError("parameter %s is not finite after epoch %d" % (bad, epoch + 1))
            print("epoch %d done in %s (all parameters finite)" % (epoch + 1, fmt_duration(secs)), flush=True)
            state.update(epoch=epoch + 2, step=0, t0=time.perf_counter())
            if user_hook is not None:
                user_hook(epoch, mean)
        history = orig_train(model, tok, items, config, device, max_len, head_max_len, on_epoch_end=hook, **kw)
        bad = first_nonfinite_param(torch, model)
        if bad:
            raise NonFiniteError("parameter %s is not finite at the end of training" % bad)
        return history
    lt.train_model = guarded_train
    try:
        yield
    finally:
        state["model"] = None
        for n, v in saved.items():
            setattr(lt, n, v)
        for c, n, orig, own in class_saved:
            if own:
                setattr(c, n, orig)
            else:
                delattr(c, n)


def agent_fetch(agent):
    def fetch(payload):
        return agent.predict(payload["state"], payload["questions"])
    return fetch


def score_dataset(fetch, path, limit=None):
    rows = read_rows(path, limit)
    if not rows:
        raise StepFailed("no rows in %s" % path)
    res = score.run(rows, fetch)
    if res["errors"]:
        first = next((m["error"] for m in res["misses"] if m.get("error")), "unknown error")
        raise StepFailed("the model raised an error on %d of %d rows (first: %s)" % (res["errors"], res["rows"], first))
    bad = result_nonfinite(res)
    if bad:
        raise NonFiniteError(bad)
    return res


def time_lines(fetch, path, n=LATENCY_LINES):
    rows = read_rows(path, n + 3)
    payloads = [score.build_payload(r) for r in rows]
    for p in payloads[:3]:  # warm-up, not timed
        fetch(p)
    times = []
    for p in payloads[3:3 + n]:
        t0 = time.perf_counter()
        fetch(p)
        times.append(time.perf_counter() - t0)
    return statistics.median(times) if times else None


def dir_size_mb(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            total += os.path.getsize(os.path.join(root, f))
    return round(total / 1e6, 1)


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)


def score_all(fetch, ctx, label):
    """Score val (first 200 rows) and both hold-out files; prints a one-line summary each."""
    paths = {"val": os.path.join(ctx["data"], "val.jsonl"),
             "holdout_floor": HOLDOUT_FILES[0], "holdout_fresh": HOLDOUT_FILES[1]}
    out = {}
    for key, name, _ in DATASETS:
        t0 = time.time()
        res = score_dataset(fetch, paths[key], VAL_ROWS if key == "val" else None)
        out[key] = res
        print("  %s %-15s rows %4d  addressed %s  wants %s  other %s  all three %s  (%ds)" % (
            label, name, res["counted"], pct(res["accuracy"]["addressed"]), pct(res["accuracy"]["wants"]),
            pct(res["accuracy"]["other"]), pct(res["all_three"]), time.time() - t0), flush=True)
    return out


# --------------------------------------------------------------------------------- steps

def step_preflight(ctx):
    a = ctx["args"]
    if sys.version_info < (3, 10):
        raise StepFailed("Python 3.10 or newer is needed, this is %s" % platform.python_version(), 2)
    print("python %s on %s" % (platform.python_version(), platform.platform()))
    hint = "install with:\n  " + install_help()
    try:
        import torch
    except Exception as e:
        print(hint)
        raise StepFailed("torch cannot be imported (%s)" % e, 2)
    try:
        import laya
        import laya.train  # noqa: F401
    except Exception as e:
        print(hint)
        raise StepFailed("laya cannot be imported (%s)" % e, 2)
    lv = getattr(laya, "__version__", "unknown")
    print("torch %s (cuda build %s), laya %s" % (torch.__version__, torch.version.cuda, lv))
    ctx["versions"] = {"python": platform.python_version(), "torch": torch.__version__, "laya": lv}
    if lv != EXPECTED_LAYA:
        print("WARNING: laya %s is installed but this pipeline was written for %s" % (lv, EXPECTED_LAYA))
    cuda = torch.cuda.is_available()
    if a.device == "cuda" and not cuda:
        print(hint)
        raise StepFailed("--device cuda was asked for but torch.cuda.is_available() is False "
                         "(check nvidia-smi and install the CUDA build of torch)", 2)
    if a.device == "auto" and not cuda:
        print(hint)
        raise StepFailed("no CUDA GPU found by torch; fix the install, or pass --device cpu to train very slowly", 2)
    dev = "cuda" if (cuda and a.device != "cpu") else "cpu"
    ctx["device"] = dev
    bf16 = bool(dev == "cuda" and torch.cuda.is_bf16_supported())
    ctx["bf16"] = bf16
    if dev == "cuda":
        p = torch.cuda.get_device_properties(0)
        mem = p.total_memory / 1e9
        ctx["device_text"] = "%s, %.1f GB, bf16 %s" % (p.name, mem, "yes" if bf16 else "no")
        print("GPU: %s" % ctx["device_text"])
        if mem < 8:
            print("WARNING: under 8 GB of GPU memory; use --precision fp16 and, if it runs out of memory, "
                  "--micro-batch 4 or 2")
    else:
        ctx["device_text"] = "CPU (slow)"
        print("device: CPU. Training will be very slow.")
    ctx["precision"] = choose_precision(a.precision, dev == "cuda", bf16)
    if a.precision not in ("auto", ctx["precision"]):
        print("note: --precision %s is not usable here, using %s" % (a.precision, ctx["precision"]))
    print("precision: %s%s" % (ctx["precision"], " (auto)" if a.precision == "auto" else ""))
    hip = getattr(torch.version, "hip", None)
    ctx["plain_layernorm"] = want_plain_layernorm(a.plain_layernorm, hip)
    print("plain LayerNorm: %s (--plain-layernorm %s)" % ("on" if ctx["plain_layernorm"] else "off", a.plain_layernorm))
    if hip:
        print("ROCm build (HIP %s): the plain LayerNorm fix will be used, because ROCm's LayerNorm backward "
              "kernel gives wrong weight and bias gradients for this model%s"
              % (hip, "" if ctx["plain_layernorm"] else " (but --plain-layernorm off was given, so it is NOT used)"))
    os.makedirs(ctx["work"], exist_ok=True)
    free = shutil.disk_usage(ctx["work"]).free / 1e9
    print("free disk in %s: %.1f GB" % (ctx["work"], free))
    if free < MIN_FREE_GB:
        raise StepFailed("only %.1f GB free in %s, need at least %.0f GB" % (free, ctx["work"], MIN_FREE_GB), 2)
    for p in HOLDOUT_FILES:
        if not os.path.isfile(p):
            raise StepFailed("missing hold-out file %s (run from a full checkout)" % p, 2)


def step_data(ctx):
    a = ctx["args"]
    data = os.path.join(ctx["work"], "data")
    ctx["data"] = data
    os.makedirs(data, exist_ok=True)
    exclude = os.path.join(data, "_exclude_tmp.jsonl")
    try:
        n_hold = build_exclude_file(HOLDOUT_FILES, exclude)
        print("hold-out rows to exclude: %d" % n_hold)
        floor_data.main(["--out", data, "--n", str(a.n), "--seed", str(a.seed), "--exclude", exclude])
    finally:
        with contextlib.suppress(OSError):
            os.remove(exclude)
    ctx["train_path"] = os.path.join(data, "train.jsonl")
    ctx["val_path"] = os.path.join(data, "val.jsonl")
    ctx["train_rows"] = count_lines(ctx["train_path"])
    n_val = count_lines(ctx["val_path"])
    print("train rows: %d, val rows: %d" % (ctx["train_rows"], n_val))
    if ctx["train_rows"] < 50 or n_val < 10:
        raise StepFailed("the generator produced too few rows (train %d, val %d)" % (ctx["train_rows"], n_val))
    if a.trial:
        trial_path = os.path.join(data, "trial_train.jsonl")
        with open(trial_path, "w", encoding="utf-8") as f:
            for r in read_rows(ctx["train_path"], TRIAL_ROWS):
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        ctx["fit_path"] = trial_path
    else:
        ctx["fit_path"] = ctx["train_path"]


def step_baseline(ctx):
    a = ctx["args"]
    if a.trial:
        print("skipped in --trial")
        return
    if a.skip_baseline:
        print("skipped (--skip-baseline)")
        return
    import laya
    import laya.train as lt
    try:
        ctx["base_dir"] = lt.resolve_checkpoint_dir(a.base)
    except Exception as e:
        raise StepFailed("cannot get the base model %r: %s (Hugging Face needs network access once, ~1.7 GB)"
                         % (a.base, e))
    print("base model folder: %s" % ctx["base_dir"])
    agent = laya.load(ctx["base_dir"], device=ctx["device"])
    if ctx.get("plain_layernorm"):
        print("plain LayerNorm: patched %d modules in the baseline model" % apply_plain_layernorm_to_agent(agent))
    try:
        baseline = score_all(agent_fetch(agent), ctx, "base ")
    except NonFiniteError as e:
        raise StepFailed("the base model gave non-finite output: %s" % e)
    finally:
        del agent
    write_json(os.path.join(ctx["work"], "baseline.json"), baseline)
    ctx["baseline"] = baseline


def _fail_checkpoint(ctx, ckpt):
    """Move a bad checkpoint out of the way so nothing mistakes it for a good one."""
    if os.path.isdir(ckpt):
        failed = ckpt + ".FAILED"
        shutil.rmtree(failed, ignore_errors=True)
        os.replace(ckpt, failed)
        print("the checkpoint was renamed to %s" % failed)


def _explain_nonfinite(ctx, reason, bad_grads=False):
    a = ctx["args"]
    print(("BAD GRADIENTS: %s" if bad_grads else "NON-FINITE VALUES: %s") % reason)
    print("precision used: %s, loss: %s, math attention: %s" % (ctx["precision"], a.loss, a.math_attention))
    if bad_grads:
        if ctx["precision"] != "fp32":
            print("suggested next try (new --work folder): --precision fp32")
        print("if fp32 also fails, this GPU's library computes wrong gradients for this model and "
              "training must move to another machine (this is what happened on an AMD ROCm card).")
        return
    nxt = next_try(ctx["precision"], a.math_attention, a.loss, ctx.get("bf16", True))
    if nxt:
        print("suggested next try (new --work folder): add or change to %s" % nxt)
        print("fallback order: bf16 -> fp32 -> --math-attention -> --loss soft-ce")
    else:
        print("no fallbacks are left. Stop and report this failure with the full train.log.")


def step_train(ctx):
    import torch
    import laya.train as lt
    a = ctx["args"]
    name = "trial-checkpoint" if a.trial else "checkpoint"
    ckpt = os.path.join(ctx["work"], name)
    ctx["ckpt"] = ckpt
    if os.path.exists(ckpt):
        raise StepFailed("%s already exists; use a new --work folder for each run" % ckpt)
    if "base_dir" not in ctx:
        try:
            ctx["base_dir"] = lt.resolve_checkpoint_dir(a.base)
        except Exception as e:
            raise StepFailed("cannot get the base model %r: %s (Hugging Face needs network access once, ~1.7 GB)"
                             % (a.base, e))
    if a.math_attention:
        set_math_attention()
    epochs = 1 if a.trial else a.epochs
    cfg = lt.TrainConfig(
        epochs=epochs, micro_batch=a.micro_batch, grad_accum=64 // a.micro_batch, loss=a.loss,
        shuffle_options=("choice",), seed=a.seed,
        amp=(ctx["precision"] in ("fp16", "bf16")),
        gradient_checkpointing=(ctx["device"] == "cuda"),
        eval_data=ctx["val_path"])
    state = {"epoch": 1, "step": 0, "depth": 0, "t0": 0.0, "epoch_seconds": [], "train_rows": 0}
    ctx["train_state"] = state
    print("training: %d rows, %d epoch(s), precision %s, loss %s, micro-batch %d x accumulation %d"
          % (count_lines(ctx["fit_path"]), epochs, ctx["precision"], a.loss, cfg.micro_batch, cfg.grad_accum))
    log = os.path.join(ctx["work"], "train.log")
    try:
        with tee_output(log), patched_training(lt, torch, ctx["precision"], state,
                                                       ctx["plain_layernorm"]):
            summary = lt.finetune(ctx["fit_path"], ctx["base_dir"], ckpt, config=cfg, device=ctx["device"])
        for x in summary.get("epoch_loss", []):
            if not finite_number(x):
                raise NonFiniteError("epoch loss history holds %r" % (x,))
        why = bad_run(state["updates"], state["skipped"], state["steps"], state["bad_grad_steps"],
                      ctx["precision"])
        if why:
            raise BadGradientsError(why)
        _check_saved(torch, ckpt)
    except NonFiniteError as e:
        bad = isinstance(e, BadGradientsError)
        _explain_nonfinite(ctx, str(e), bad)
        _fail_checkpoint(ctx, ckpt)
        raise StepFailed(("training failed: %s" if bad else "training went non-finite (%s)") % e, 3)
    except StepFailed:
        _fail_checkpoint(ctx, ckpt)
        raise
    except Exception as e:
        _fail_checkpoint(ctx, ckpt)
        if type(e).__name__ == "OutOfMemoryError" or "out of memory" in str(e).lower():
            print("The GPU ran out of memory. Try --micro-batch 4, then 2, then --precision fp16.")
        raise StepFailed("training stopped with %s: %s" % (type(e).__name__, e))
    latest = os.path.join(ckpt, "checkpoint_latest")
    shutil.rmtree(latest, ignore_errors=True)  # a duplicate of the final weights
    ctx["epoch_seconds"] = list(state["epoch_seconds"])
    ctx["train_summary"] = {"epoch_loss": summary.get("epoch_loss"), "train_items": summary.get("train_items"),
                            "calibration_items": summary.get("calibration_items"),
                            "temperature": summary.get("temperature"), "epoch_seconds": ctx["epoch_seconds"],
                            "updates": state["updates"], "skipped": state["skipped"],
                            "bad_grad_steps": state["bad_grad_steps"]}
    write_json(os.path.join(ctx["work"], "train-summary.json"), ctx["train_summary"])
    if a.trial and state["epoch_seconds"]:
        per_epoch, total = estimate_full_run(state["epoch_seconds"][0], summary.get("train_items") or TRIAL_ROWS,
                                             ctx["train_rows"], a.epochs)
        ctx["trial_estimate"] = (state["epoch_seconds"][0], per_epoch, total)
        print("TRIAL: %.0f s for the trial epoch (%d rows)." % (state["epoch_seconds"][0], summary.get("train_items", 0)))
        print("TRIAL ESTIMATE for the full run: about %s per epoch, %s for %d epochs (an estimate; the trial "
              "includes start-up time so it leans high)" % (fmt_duration(per_epoch), fmt_duration(total), a.epochs))


def _check_saved(torch, ckpt):
    need = ("model.safetensors", "rl_agent_config.json")
    for n in need:
        if not os.path.isfile(os.path.join(ckpt, n)):
            raise StepFailed("training finished but %s is missing from %s" % (n, ckpt))
    from safetensors.torch import load_file
    for k, v in load_file(os.path.join(ckpt, "model.safetensors")).items():
        if not bool(torch.isfinite(v.float()).all()):
            raise NonFiniteError("saved weight %s is not finite" % k)


def step_score(ctx):
    import torch
    import laya
    a = ctx["args"]
    ckpt = ctx["ckpt"]
    results = {}
    try:
        agent = laya.load(ckpt, device=ctx["device"])
        if ctx.get("plain_layernorm"):
            print("plain LayerNorm: patched %d modules in the scored model" % apply_plain_layernorm_to_agent(agent))
        fetch = agent_fetch(agent)
        results = score_all(fetch, ctx, "tuned")
        dev_lat = time_lines(fetch, ctx["val_path"])
        del agent, fetch
        if ctx["device"] == "cuda":
            torch.cuda.empty_cache()
        cpu_lat = dev_lat
        if ctx["device"] != "cpu":
            cpu_agent = laya.load(ckpt, device="cpu")
            if ctx.get("plain_layernorm"):
                apply_plain_layernorm_to_agent(cpu_agent)
            cpu_lat = time_lines(agent_fetch(cpu_agent), ctx["val_path"])
            del cpu_agent
    except NonFiniteError as e:
        _explain_nonfinite(ctx, "scoring the new checkpoint gave %s" % e)
        _fail_checkpoint(ctx, ckpt)
        raise StepFailed("the new checkpoint gives non-finite answers (%s)" % e, 3)
    results["latency"] = {"device": ctx["device"], "device_median": dev_lat, "cpu_median": cpu_lat,
                          "lines_timed": LATENCY_LINES}
    ctx["results"] = results
    name = "results-trial.json" if a.trial else "results.json"
    write_json(os.path.join(ctx["work"], name), results)
    print_comparison(ctx.get("baseline"), results)


def print_comparison(baseline, results):
    print("\nper-field accuracy, base -> tuned")
    for key, label, _ in DATASETS:
        t = results.get(key)
        if not t:
            continue
        b = (baseline or {}).get(key) or {}
        print("  %s (%d rows)" % (label, t["counted"]))
        for q in QIDS + ("all three",):
            tv = t["all_three"] if q == "all three" else t["accuracy"][q]
            bv = b.get("all_three") if q == "all three" else (b.get("accuracy") or {}).get(q)
            print("    %-10s %8s -> %8s" % (q, pct(bv) if b else "n/a", pct(tv)))
        print("    confidence right %s -> %s, wrong %s -> %s" % (
            num(b.get("mean_top_prob_right")), num(t["mean_top_prob_right"]),
            num(b.get("mean_top_prob_wrong")), num(t["mean_top_prob_wrong"])))
    lat = results.get("latency", {})
    print("median latency per line: %s s on %s, %s s on CPU" % (
        num(lat.get("device_median"), 4), lat.get("device"), num(lat.get("cpu_median"), 4)))


def step_report(ctx):
    a = ctx["args"]
    ck = ctx["ckpt"]
    info = {
        "args": {"loss": a.loss, "epochs": a.epochs, "n": a.n, "seed": a.seed, "base": a.base,
                 "math_attention": a.math_attention},
        "precision": ctx["precision"], "device_text": ctx.get("device_text"), "versions": ctx.get("versions"),
        "timings": {k: v for k, v in ctx["timings"].items()}, "epoch_seconds": ctx.get("epoch_seconds"),
        "grad_health": {k: (ctx.get("train_summary") or {}).get(k) for k in ("updates", "skipped", "bad_grad_steps")},
        "baseline": ctx.get("baseline"), "results": ctx["results"], "worst": worst_misses(ctx["results"]),
        "checkpoint": {"path": ck, "size_mb": dir_size_mb(ck)},
    }
    text = render_report(info)
    path = os.path.join(ctx["work"], "REPORT.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    ctx["verdict"] = verdict(ctx["results"])
    print("report: %s" % path)
    print("checkpoint: %s (%s MB)" % (ck, info["checkpoint"]["size_mb"]))
    print("VERDICT: %s" % ctx["verdict"])


STEPS = (("Preflight", step_preflight), ("Data", step_data), ("Baseline", step_baseline),
         ("Train", step_train), ("Score", step_score), ("Report", step_report))


def main(argv=None):
    args = parse_args(argv)
    work = os.path.abspath(args.work)
    os.makedirs(work, exist_ok=True)
    try:
        for stream in (sys.stdout, sys.stderr):
            stream.reconfigure(errors="replace")
    except Exception:
        pass
    ctx = {"args": args, "work": work, "timings": {}}
    last = 5 if args.trial else len(STEPS)
    t_all = time.time()
    for i, (name, fn) in enumerate(STEPS[:last], 1):
        print("\n== STEP %d: %s ==" % (i, name), flush=True)
        t0 = time.time()
        try:
            fn(ctx)
        except StepFailed as e:
            print("FAILED: %s" % e.reason, flush=True)
            return e.code
        except KeyboardInterrupt:
            print("FAILED: interrupted", flush=True)
            return 1
        except Exception as e:
            import traceback
            traceback.print_exc()
            print("FAILED: step %d raised %s: %s" % (i, type(e).__name__, e), flush=True)
            return 1
        ctx["timings"][name] = time.time() - t0
        print("OK (%s)" % fmt_duration(ctx["timings"][name]), flush=True)
    if args.trial:
        print("\nTrial finished in %s. Scores above are from a 1-epoch, %d-row model and mean little."
              % (fmt_duration(time.time() - t_all), TRIAL_ROWS))
    else:
        print("\nAll steps passed in %s. Verdict: %s" % (fmt_duration(time.time() - t_all), ctx["verdict"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
