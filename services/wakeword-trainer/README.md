# Wake word trainer

Trains an [openWakeWord](https://github.com/dscripka/openWakeWord) model for any phrase. The app
runs it from **Settings → Wake word → Train a new wake word**. It uses the same pipeline and
settings that made the bundled "Hey Echo" model (v4 in `experiments/wakeword/README.md`).
Everything runs on the CPU inside WSL (Ubuntu 24.04 by default); no GPU is needed.

| File | What it does |
| --- | --- |
| `train_wake_word.py` | The whole run for one phrase. It needs only the system `python3`, and runs each stage in the training venv. |
| `setup.sh` | Installs uv, clones openWakeWord and piper-sample-generator (v2.0.0) into `~/wakeword`, builds the Python 3.10 venv with CPU torch, and fetches the Piper voice. |
| `download_data.py` | Fetches the training data into `~/wakeword/data` (about 20 GB, once): ACAV100M negative features, the validation features, AudioSet and FMA background audio, MIT impulse responses. |
| `generate_extra_clips.py` | Adds near-miss sentences ("the echo was really loud") and the paused form ("Hey, Echo.") to the clips. On its own, train.py gives them almost no clips. |

## Stages

Each stage skips work already on disk, so running the same phrase again resumes an interrupted run.

1. **setup:** `setup.sh`, once.
2. **download:** `download_data.py`, once.
3. **generate:** 30,000 + 2,000 spoken clips of the phrase and as many adversarial ones (Piper), about 2.5 h.
4. **extra:** about 14,000 targeted near-miss and paused clips.
5. **augment:** background noise and reverb, turned into features, about 1 h.
6. **train:** a 64-unit DNN, 100,000 steps, about 30 min.
7. **export:** copies `<slug>.onnx` and a `<slug>.json` description (phrase, validation recall, false wakes per hour) to the output folder.

Clips and features stay in `~/wakeword/models/<slug>/`. Delete that folder to start a phrase from scratch.

## How the app runs it

The app starts `wsl.exe -d Ubuntu-24.04 -- bash -lc "setsid --wait python3 train_wake_word.py …"`,
detached, so a run carries on after the app closes. The script writes `status.json` (stage,
progress, heartbeat) and `train.log` into `%APPDATA%\…\wake-words\jobs\<slug>\`. The app reads
`status.json`, so it picks a run up again when it restarts. A run whose heartbeat stops for two
minutes (the PC slept, or WSL shut down) shows as interrupted, with a Resume button. Cancelling
sends SIGTERM to the script's process group.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WAKE_WORD_TRAINER_DISTRO` | `Ubuntu-24.04` | The WSL distro to train in |
| `WAKE_WORD_TRAINER_DIR` | `services/wakeword-trainer` in the checkout | Where the scripts are |

## By hand

```bash
python3 services/wakeword-trainer/train_wake_word.py --phrase "hey computer" \
  --job-dir /tmp/hey_computer --output-dir /tmp/models          # add --quick for a small test run
```

`--quick` makes a run of minutes rather than hours: 2,000 clips and 5,000 steps. It checks the
pipeline end to end. The model it makes is weak; the app labels it "test run".

## Tests

```bash
cd services/wakeword-trainer && python3 -m pytest tests
```
