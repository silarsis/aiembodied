# Runbook: fine-tune the Laya floor-routing model on the NVIDIA PC

For a small local model working as an agent, and for a person. Follow the steps in order. Each step has the command for Linux (bash) and Windows (PowerShell), the line that means success, and what to do when it fails. Do not improvise: if a failure is not covered, stop and report.

```
HARD RULES (read first, obey always)
 1. Never open, read, edit, print, copy or train on these files:
      services/laya/training/holdout_floor.jsonl
      services/laya/training/holdout_fresh.jsonl
    The pipeline reads them by itself. You do not.
 2. Never change any file outside the run folder. The only allowed change to the repo is `git pull`.
 3. When a step fails, follow only the fixes listed for that step. If they do not work, STOP and report.
    Do not retry more than the listed fallbacks. At most 4 runs of run_finetune.py in total
    (the --trial run counts as one).
 4. Report EVERY run's scores (the table in REPORT.md), not just the best one.
 5. Hugging Face needs network access once, to download the base model (about 1.7 GB).
 6. GPU with under 8 GB of memory: use --precision fp16 --micro-batch 4 (see "Memory note").
```

## What the pipeline does

`run_finetune.py` is one command that does everything and keeps all its files in one run folder:

1. Preflight: checks Python, PyTorch, laya, the GPU and the free disk space.
2. Data: generates about 7,200 training rows and 800 validation rows of made-up room conversations. Any sentence that matches a hold-out sentence is dropped, so the hold-out sets stay unseen.
3. Baseline: scores the untouched base model on validation and on both hold-out sets, so you can see what training changed.
4. Train: fine-tunes the model (4 epochs). It stops at once, and renames the result to `checkpoint.FAILED`, if any number turns into NaN or infinity, or if most updates had bad gradients (the run would not have learned), so a broken model is never saved as good.
5. Score: scores the new model the same way and measures speed on the GPU and on the CPU.
6. Report: writes `REPORT.md` with the score table, the 15 worst hold-out misses and a verdict: PASS (95% or better on all three answers together, on both hold-out sets) or NEEDS WORK.

Expected duration: the download takes a few minutes. Training is roughly 15 minutes per epoch on a mid-range NVIDIA card for 7,200 rows, so about an hour for 4 epochs. This is an estimate; the `--trial` run prints a better one for your card. Scoring adds a few minutes.

## Step 0: prerequisites

Check the GPU driver.

- Linux: `nvidia-smi`
- Windows: `nvidia-smi`

Success: a table that names your GPU and shows "CUDA Version: 12.x" (any 12.x; 13.x is also fine). Note the memory figure.
On failure: stop and report "NVIDIA driver not working". Do not install drivers.

Check Python 3.11 or 3.12 and git.

- Linux: `python3 --version ; git --version`
- Windows: `py -3.12 --version ; git --version` (if that fails try `py -3.11 --version`)

Success: `Python 3.11.x` or `Python 3.12.x`, and a git version.
On failure: Python 3.10 works too; 3.13 or newer may lack PyTorch wheels, so use 3.11 or 3.12. If none is present, stop and report; ask the person to install Python 3.12 (python.org on Windows, the package manager on Linux) and git.

## Step 1: get the repo on the right branch

The repo lives wherever the person keeps it. If it is not on this PC, clone it (the commands below use the home folder).

- Linux:
  ```
  git clone https://github.com/silarsis/aiembodied.git ~/aiembodied   # skip if the folder exists
  cd ~/aiembodied && git fetch origin && git checkout claude/project-thread-10gmrb && git pull --ff-only
  ```
- Windows:
  ```
  git clone https://github.com/silarsis/aiembodied.git $HOME\aiembodied   # skip if the folder exists
  cd $HOME\aiembodied ; git fetch origin ; git checkout claude/project-thread-10gmrb ; git pull --ff-only
  ```

Success: `git status` says "On branch claude/project-thread-10gmrb" and `services/laya/training/run_finetune.py` exists.
On failure: if `git pull --ff-only` refuses, stop and report. Never use `git reset`, `git stash` or `git checkout -- file`.

## Step 2: create the virtual environment (outside the repo)

- Linux: `python3 -m venv ~/laya-train && source ~/laya-train/bin/activate`
- Windows:
  ```
  py -3.12 -m venv $HOME\laya-train
  Set-ExecutionPolicy -Scope Process Bypass
  & $HOME\laya-train\Scripts\Activate.ps1
  ```

Success: the prompt starts with `(laya-train)`.
On failure: if Windows says scripts are disabled, run the `Set-ExecutionPolicy` line again in the same window. Otherwise stop and report. Every later command must run with this environment active; after opening a new terminal, activate it again.

## Step 3: install PyTorch with CUDA, then laya

- Linux:
  ```
  pip install torch --index-url https://download.pytorch.org/whl/cu128
  pip install "laya[serve]==0.4.31"
  ```
- Windows:
  ```
  python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
  python -m pip install "laya[serve]==0.4.31"
  ```

Success: both commands end with "Successfully installed ...".
On failure: open https://pytorch.org/get-started/locally/, choose Stable, your OS, Pip, and CUDA 12.x, and run the exact command it shows (it may say `cu126` or `cu130` instead of `cu128`). Then run the `laya` line again. If that also fails, stop and report. The `laya` line must come after the `torch` line, otherwise pip installs a CPU-only torch.

## Step 4: check that PyTorch sees the GPU

- Linux and Windows: `python -c "import torch;print(torch.cuda.is_available())"`

Success: prints `True`.
On failure (`False`): run `pip uninstall -y torch`, then repeat Step 3 using the command from pytorch.org. Try this at most once. If it still prints `False`, stop and report together with the output of `nvidia-smi`.

## Step 5: run the unit tests

From the repo folder:

- Linux: `python -m unittest discover -s services/laya/training`
- Windows: `python -m unittest discover -s services/laya/training`

Success: the last lines are `Ran NN tests` and `OK`.
On failure: stop and report the output. Do not edit any file.

## Step 6: the trial run (a quick end-to-end test)

This trains on 200 rows for 1 epoch, takes a few minutes, and prints a time estimate. It uses its own run folder.

- Linux: `python services/laya/training/run_finetune.py --work ~/laya-runs/trial --trial`
- Windows: `python services/laya/training/run_finetune.py --work $HOME\laya-runs\trial --trial`

If the GPU has under 8 GB, add `--precision fp16 --micro-batch 4`.

Success: every step ends with `OK`, and you see two lines starting `TRIAL:` and `TRIAL ESTIMATE for the full run:`. The final line says `Trial finished`. Write down the estimate. Scores in a trial are poor on purpose; ignore them.
If the estimate is more than 6 hours: stop and report before starting the full run.

On failure, find the first line starting with `FAILED:` and use this table.

| Exit code / message | What to do |
| --- | --- |
| `2`, "torch cannot be imported" or "laya cannot be imported" | Repeat Steps 2 and 3, once. Then stop and report. |
| `2`, "no CUDA GPU found" | Repeat Step 4's fix, once. Then stop and report. |
| `2`, "only N GB free" | Stop and report. Do not delete anything. |
| "cannot get the base model" | Check the network (Hugging Face must be reachable). Run the same command once more. Then stop and report. |
| `3`, "training went non-finite" or "non-finite answers" | The output lists "suggested next try". Run once with exactly that extra flag, in a new `--work` folder. The order is: `--precision bf16`, then `--precision fp32`, then add `--math-attention`, then add `--loss soft-ce`. Each flag is added to the previous ones. |
| `3`, "the GPU produced bad gradients on most updates" | The run did not learn: the gradients went infinite while the loss stayed finite, and the fp16 scaler silently skipped those updates. Run once with `--precision fp32` in a new `--work` folder. If that also fails, this GPU's library computes wrong gradients for this model. Stop and report: training must move to another machine (this is what happened on an AMD ROCm card). |
| "ran out of memory" | Re-run with `--micro-batch 4`; if it fails again `--micro-batch 2`. Then stop and report. |
| anything else | Stop and report the last 40 lines of output. |

## Step 7: the full run

Use the same flags that made the trial pass. Use a new run folder name for every run (`run1`, `run2`, ...).

- Linux: `python services/laya/training/run_finetune.py --work ~/laya-runs/run1`
- Windows: `python services/laya/training/run_finetune.py --work $HOME\laya-runs\run1`

Optional flags: `--epochs 4` (default), `--precision auto|fp16|bf16|fp32`, `--loss rlcd|soft-ce`, `--math-attention`, `--micro-batch N`, `--skip-baseline`, `--n 8000`, `--seed 0`.

This takes about an hour or more. Training prints a line every 100 steps (`epoch 1/4 step 100 loss ...`). It is normal to be quiet for minutes. Do not interrupt it.

Success: all six steps end with `OK`, then `All steps passed ... Verdict: PASS` or `Verdict: NEEDS WORK`. The exit code is 0 either way.
On failure: use the table in Step 6. Stop after 4 runs of run_finetune.py in total.

## Step 8: read the report

- Linux: `cat ~/laya-runs/run1/REPORT.md`
- Windows: `Get-Content $HOME\laya-runs\run1\REPORT.md`

Report to the person, for every run: the run folder, the flags used, the verdict, and the score table (baseline versus tuned, per field and all three, for val and both hold-out sets), the median latency, the checkpoint size and the 15 misses. A hold-out miss list is the one place hold-out text appears; it is allowed because the pipeline wrote it.

- PASS: the checkpoint is `~/laya-runs/run1/checkpoint`. Go on to Step 9.
- NEEDS WORK: report the table and the misses. Do not start more runs than the rules allow. Do not copy the checkpoint to bija unless the person says so.

Other files in the run folder: `train.log` (all training output), `baseline.json`, `results.json`, `train-summary.json`, `data/` (the generated rows; do not commit them).

## Step 9: copy the checkpoint to bija (Windows PC)

The checkpoint folder holds `model.safetensors` (about 0.6 GB), `rl_agent_config.json`, `encoder/` and `tokenizer/`. Copy the whole folder. Use the name `laya-floor-v1` (lower-case letters, digits, `.`, `_`, `-` only).

- Linux, bija has OpenSSH (replace `USER`):
  ```
  scp -r ~/laya-runs/run1/checkpoint USER@bija:C:/laya/laya-floor-v1
  ```
- Windows to bija over a share:
  ```
  Copy-Item -Recurse "$HOME\laya-runs\run1\checkpoint" '\\bija\C$\laya\laya-floor-v1'
  ```
- Any OS: copy the folder to a USB stick and paste it on bija as `C:\laya\laya-floor-v1`.

Success: on bija, `C:\laya\laya-floor-v1\model.safetensors` and `C:\laya\laya-floor-v1\rl_agent_config.json` exist.
On failure: use the USB stick method, or stop and report.

## Step 10: make the app on bija serve it

How the server loads a local folder (read from the laya 0.4.31 source): `laya-serve` reads `LAYA_EXTRA_MODELS`, a JSON object `{name: source}` where the source may be "a Hub repo id, a local checkpoint directory, or a [repo, subfolder] pair" (`serve.py`: the table near line 46 and `_extra_models_option` near lines 826-869). The name then works as the `model` in a request, like a built-in. `LAYA_MODELS` and `LAYA_DEFAULT_MODEL` may also name it (`_default_model_option`, near lines 880-903, accepts an extra name as default). `services/laya/scripts/start.ps1` already passes the environment through (it only sets `LAYA_MODELS` and `LAYA_DEFAULT_MODEL` when they are unset), and `pnpm dev:run` hands the values in the repo's `.env` to that script. So no code change is needed.

On bija, add these three lines to `.env` in the repo root (use forward slashes in the path; no quotes around the JSON):

```
LAYA_EXTRA_MODELS={"laya-floor-v1":"C:/laya/laya-floor-v1"}
LAYA_MODELS=laya-floor-v1
LAYA_DEFAULT_MODEL=laya-floor-v1
```

Optional: `LAYA_DEVICE=cuda` to run it on bija's GPU (the default is `cpu`, which is fast enough).

Then, in the app, open Models and servers, find the **Quick decisions** use, and set its model field to exactly `laya-floor-v1`. If the field names a model that the server did not load, requests fail. Restart with `pnpm dev:run`; the first start may reinstall the Laya environment.

Check it: `pnpm laya:check` (set `LAYA_CHECK_MODEL=laya-floor-v1` first so it asks for the new model), or open `http://127.0.0.1:8197/health` and look for `laya-floor-v1` in `loaded`.

To test serving on this PC before copying (Linux example; the server must be started with the venv active):

```
LAYA_EXTRA_MODELS='{"laya-floor-v1":"'$HOME'/laya-runs/run1/checkpoint"}' LAYA_MODELS=laya-floor-v1 LAYA_DEFAULT_MODEL=laya-floor-v1 LAYA_HOST=127.0.0.1 LAYA_PORT=8197 laya-serve
```

then, in another terminal, `python services/laya/training/score.py --data ~/laya-runs/run1/data/val.jsonl --model laya-floor-v1`. In PowerShell set the same variables with `$env:NAME = 'value'` first.

## Memory note

Training sends `--micro-batch` rows through the model at once (default 8) and accumulates gradients so the effective batch stays 64. A smaller micro-batch uses less GPU memory and gives the same learning, only slower. With under 8 GB use `--precision fp16 --micro-batch 4`; if it says out of memory try `--micro-batch 2`. Values must divide 64.

## Why the fallbacks exist

A first attempt on an AMD card went to NaN (fp16 after about 250 steps; bf16 and fp32 later). NVIDIA should be fine. The pipeline checks the loss at every step and all weights after every epoch, so a bad run stops within one epoch and is renamed `checkpoint.FAILED`. The fallback order is: bf16, fp32, `--math-attention` (plain attention kernel), `--loss soft-ce` (simpler objective). A trial can pass and the full run can still go non-finite later; treat that as a normal failure and follow the table.

## Known problem: bija's AMD Radeon

On bija's AMD Radeon (ROCm PyTorch) the backward pass gives wrong gradients for this model. The forward pass and the loss match the CPU, but the norm-layer gradients come out huge or infinite. It cannot be trained there. Serving a trained checkpoint on its CPU is fine. Train on an NVIDIA machine and copy the checkpoint over.

## Hand-made JSONL files on Windows

Any JSONL file you write by hand on Windows must be UTF-8 without a byte-order mark. PowerShell 5's `Set-Content -Encoding utf8` adds a BOM, and laya-train then fails with "Unexpected UTF-8 BOM". The pipeline itself writes its files from Python, so it is not affected.
