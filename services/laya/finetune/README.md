# Fine-tuning Laya (quick decisions)

This is a runbook for fine-tuning the Laya quick-decision model on a machine with an NVIDIA GPU, then serving the
result from `services/laya` on the PC that runs the app. It is written to be followed step by step, by a person or
by a coding agent. Each step says what to run, what you should see, and when to stop.

## How it works

**The model.** Laya (`convaiinnovations/laya`, the `english` checkpoint) is a ModernBERT-large text encoder (395M
parameters) with a small decision head on top (2 transformer layers and a scorer), 421M in all. It never writes text.
For each question it builds one token sequence:

```
[CLS] <question type> <instructions> [SEP] [MASK] option 1 [MASK] option 2 ... [SEP] <state> [SEP]
```

The encoder reads the whole sequence at once, the head gives each `[MASK]` a score, and a softmax over a question's
options gives its probabilities. Options are defined per request, so the same weights can answer any question you can
phrase. Out of the box it is close to chance on our floor questions (about 3–9% all-three right on the hold-outs).
Its makers describe it as a fast base to specialise, not a zero-shot decision engine.

**Fine-tuning** is ordinary supervised training on examples with known answers:

1. **Data.** Each row is a state (plain text: who is in the room, who Kevin last spoke with, recent lines, then
   Kevin's line), the questions with their options, and the expected answer per question. `services/laya/training/floor_data.py`
   generates them from templates and word banks, so the labels are right by construction. Some phrasing is held back
   from training and used only for validation (`val.jsonl`).
2. **Training.** `laya-train` runs the rows through the model, compares its probabilities with the expected answers
   and nudges all 421M weights (AdamW optimiser, learning rate 2.5e-5 for the encoder and 1e-4 for the head, cosine
   decay). The default objective, `rlcd`, is cross-entropy plus a small reinforcement term that rewards honest
   probabilities; `--loss soft-ce` is cross-entropy alone. `--shuffle-options` shows the options in a random order
   each time, so the model can't learn "the answer is usually the first option". Rows go through in batches of 8,
   and the weights are updated every 8 batches (64 items). One pass over the data is an epoch; the default is 4.
3. **Calibration.** 10% of the rows (at most 400) are held back from the training loop. After training it fits one
   "temperature" per question type, so a 0.9 means right about 90% of the time. That is what makes a confidence
   threshold in the app meaningful.
4. **Output.** A folder holding a whole new copy of the model (about 0.85 GB): encoder weights, head weights,
   tokenizer, config with the fitted temperatures. There is no small adapter; the base model isn't needed beside it.
5. **Scoring.** The checkpoint is served like the stock one and scored with `score.py` on two hold-out files that were
   never used for training: `holdout_floor.jsonl` (47 counted lines) and `holdout_fresh.jsonl` (110 counted lines).

**One checkpoint for every use.** Because questions come with each request, one checkpoint can learn the floor
questions and the app's other quick decisions (floor bids, the switchboard's ignore/remember/say, the proactive
check) at the same time. Add their rows to the same training file. Training on one use only tends to make the
model worse at the others.

**Speed.** Serving is unchanged: one call with three questions takes about 150–350 ms on the CPU of the app PC.
Training needs a GPU. On an NVIDIA T4-class card, 8,000 rows × 4 epochs should take well under an hour; on the CPU it
would take days.

## What went wrong on the AMD PC (bija)

On the Radeon 8060S with ROCm PyTorch 2.12, the backward pass gives wrong gradients. One batch of 8 items, same
weights, plain fp32: on the CPU every gradient is finite and small (`head.layers.1.norm2.bias` around 1e-6); on the
GPU the forward pass and loss agree with the CPU, but that bias gets gradients of -234 and -349, and the LayerNorm
weights of 11 encoder layers get infinite gradients. So it is the ROCm kernels, not laya or the data, and fp16, bf16
and fp32 all fail the same way. laya's loss scaler skipped almost every update, and the few that slipped through
turned the weights into NaN after 1,600–2,300 batches. Zeroing the bad gradients is not a fix here, because the
finite ones can't be trusted either. Train on NVIDIA (or the CPU, which is far too slow at this size).

`train.py` in this folder names parameters with non-finite gradients and stops the run as soon as a weight goes
non-finite, so a broken run fails in minutes instead of an hour. Expect an NVIDIA card with CUDA PyTorch to be clean;
check the log anyway (step 5).

## Runbook

Paths below are relative to the repository root. Commands are shown for PowerShell on Windows; on Linux use
`python3`, `source .venv/bin/activate` and `/` paths.

### 1. Requirements

- An NVIDIA GPU with at least 12 GB of memory, a recent driver (`nvidia-smi` lists the card), about 10 GB of free disk.
- Python 3.12 (3.10–3.13 work), git, and this repository cloned, with `services/laya/training/` present. If it is
  not on `main` yet, get it without switching branches:
  `git fetch origin claude/project-thread-10gmrb` then
  `git archive origin/claude/project-thread-10gmrb services/laya/training | tar -x -C .`
- Internet access to PyPI, the PyTorch wheel index and Hugging Face (the base checkpoint is about 1.7 GB).

### 2. Make the training environment

Use a new folder outside `services/laya/.venv` (that one is the app's server and has a CPU-only PyTorch).

```powershell
python -m venv .laya-train
.laya-train\Scripts\python -m pip install --upgrade pip
.laya-train\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
.laya-train\Scripts\python -m pip install "laya[serve]==0.4.31"
.laya-train\Scripts\python -c "import torch, laya; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

You should see a `+cu128` version, `True` and the card's name. If you see `False`, PyTorch is a CPU build: reinstall
it from the CUDA index (pick the `cuXXX` that the driver supports; `nvidia-smi` shows the highest CUDA version). If
installing `laya` replaced torch with a CPU build, reinstall torch from the CUDA index afterwards.

Add `.laya-train/` to `.git/info/exclude` (or put the folder outside the repo) so it is never committed.

### 3. Generate the data

```powershell
mkdir .laya-train\data
Get-Content services\laya\training\holdout_floor.jsonl, services\laya\training\holdout_fresh.jsonl | Set-Content -Encoding ascii .laya-train\holdouts.jsonl
.laya-train\Scripts\python services\laya\training\floor_data.py --out .laya-train\data --n 8000 --seed 0 --exclude .laya-train\holdouts.jsonl
```

You should get `train.jsonl` (about 7,200 rows) and `val.jsonl` (about 800 rows) and a summary of counts. Rules:

- Never put lines from either hold-out file, or close copies of them, into training data.
- JSONL files must be UTF-8 **without** a byte-order mark. Windows PowerShell 5's `Set-Content -Encoding utf8` adds
  one and `laya-train` then fails with "Unexpected UTF-8 BOM". Use `-Encoding ascii` for these files, or Python.

### 4. Score the stock model first (baseline)

Serve the stock checkpoint on a spare port, score both hold-outs, stop it:

```powershell
$env:LAYA_PORT = '8297'; $env:LAYA_HOST = '127.0.0.1'; $env:LAYA_MODELS = 'english'; $env:LAYA_DEVICE = 'cpu'; $env:LAYA_PRELOAD = '1'
Start-Process .laya-train\Scripts\laya-serve.exe -PassThru   # note the Id; wait until http://127.0.0.1:8297/health says ok
.laya-train\Scripts\python services\laya\training\score.py --data services\laya\training\holdout_floor.jsonl --url http://127.0.0.1:8297 --model english --out .laya-train\results\base_floor.json
.laya-train\Scripts\python services\laya\training\score.py --data services\laya\training\holdout_fresh.jsonl --url http://127.0.0.1:8297 --model english --out .laya-train\results\base_fresh.json
Stop-Process -Id <that Id>
```

Expect all-three accuracy below 10%. (Serving on `cpu` measures the latency the app PC will see.)

### 5. Time a short trial

```powershell
Get-Content .laya-train\data\train.jsonl -TotalCount 600 | Set-Content -Encoding ascii .laya-train\data\trial.jsonl
.laya-train\Scripts\python services\laya\finetune\train.py --data .laya-train\data\trial.jsonl --eval .laya-train\data\val.jsonl --base convaiinnovations/laya --out .laya-train\ckpt\trial --shuffle-options --epochs 1 --device cuda
```

Read the log:

- The last lines say `OPTIMIZER_STEPS n SCALER_SKIPPED m`. With fp16 a handful of early skips (and matching
  `NONFINITE_GRAD_PARAMS` lines) are normal while the loss scale settles. If more than about a tenth of the updates
  are skipped, `train.py` prints `WARNING: this run did not train cleanly` and exits with code 4: the run did not
  learn, so don't use the checkpoint. `NONFINITE_WEIGHTS` (exit code 3) means the weights were corrupted.
- `TRAIN_LOOP_SECONDS` × (7,200 / 600) × 4 estimates the full run.
- `PEAK_CUDA_GB` must fit the card. If you run out of memory, add `--micro-batch 4 --grad-accum 16`.

If the gradients are not finite, try in order: `$env:LAYA_AMP_DTYPE='bf16'`, then `'off'` (plain fp32, slower).
`$env:LAYA_ZERO_BAD_GRADS='1'` zeroes the bad gradients and lets updates go ahead. Use it only if the log names one
or two small parameters (a bias or norm), and say so in the results. Delete `.laya-train\ckpt\trial` afterwards.

### 6. Train

```powershell
.laya-train\Scripts\python services\laya\finetune\train.py --data .laya-train\data\train.jsonl --eval .laya-train\data\val.jsonl --base convaiinnovations/laya --out .laya-train\ckpt\run1 --shuffle-options --device cuda *> .laya-train\run1.log
```

Done when the log has `WALL_SECONDS`. Check that the epoch mean losses fall (`epoch N/4 mean loss`), that no line
says `NONFINITE`, and the eval accuracy `laya-train` prints at the end. The checkpoint is `.laya-train\ckpt\run1`.

### 7. Score the fine-tuned model

Serve the checkpoint from its folder under the name `english` on 8297 (`LAYA_EXTRA_MODELS` maps a name to a local
folder), then score `val.jsonl` and both hold-outs:

```powershell
$env:LAYA_PORT = '8297'; $env:LAYA_HOST = '127.0.0.1'; $env:LAYA_MODELS = 'english'; $env:LAYA_DEVICE = 'cpu'; $env:LAYA_PRELOAD = '1'
$env:LAYA_EXTRA_MODELS = '{"english": "' + ((Resolve-Path .laya-train\ckpt\run1).Path -replace '\\', '\\') + '"}'
Start-Process .laya-train\Scripts\laya-serve.exe -PassThru
.laya-train\Scripts\python services\laya\training\score.py --data .laya-train\data\val.jsonl --url http://127.0.0.1:8297 --model english --out .laya-train\results\run1_val.json
.laya-train\Scripts\python services\laya\training\score.py --data services\laya\training\holdout_floor.jsonl --url http://127.0.0.1:8297 --model english --out .laya-train\results\run1_floor.json
.laya-train\Scripts\python services\laya\training\score.py --data services\laya\training\holdout_fresh.jsonl --url http://127.0.0.1:8297 --model english --out .laya-train\results\run1_fresh.json
Stop-Process -Id <that Id>
```

The target is at least 95% all-three on **both** hold-outs, with the mean top probability on wrong answers clearly
below that on right ones (so the app can set a threshold).

### 8. If it falls short

- Do not edit the hold-out files and do not add their lines (or close copies) to training.
- Group the misses by kind (wrong addressee, converse vs relay, named-but-not-addressed, misheard name, no name, …)
  and improve `floor_banks.py` / `floor_data.py` for those kinds, with new wording of your own.
- Training settings worth trying, one at a time, scoring every run: `--epochs 6`; `--loss soft-ce`;
  `--n 16000 --seed 1` when generating. Keep a table of every run's scores, not only the best.

### 9. Use it on the app PC

Copy the checkpoint folder (all of it) to the app PC, for example to `C:\laya-checkpoints\floor-run1`. Then start
`services/laya` with it under the name the app asks for. To replace the stock model under the same name:

```powershell
$env:LAYA_MODELS = 'english'
$env:LAYA_EXTRA_MODELS = '{"english": "C:\\laya-checkpoints\\floor-run1"}'
services\laya\scripts\start.ps1
```

Or keep both: `LAYA_MODELS=english,floor` and `LAYA_EXTRA_MODELS={"floor": "C:\\laya-checkpoints\\floor-run1"}`,
then put `floor` in the Quick decisions model field. Each loaded checkpoint costs about 1.7 GB of memory. Names must
be lowercase letters, digits, `.`, `_` or `-`. The app must send the plain-text state and the exact questions built by
`services/laya/training/floor_prompt.py`; the checkpoint's own `questions.json` is not a usable default (laya-train
keeps only the first row's options).

## Files

- `train.py`: runs `laya-train` with the checks and timings described above. Environment: `LAYA_AMP_DTYPE`
  (`fp16` default, `bf16`, `off`) and `LAYA_ZERO_BAD_GRADS=1`.
