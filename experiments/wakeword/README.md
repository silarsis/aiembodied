# "Hey Echo" wake-word training

openWakeWord has no pre-trained "hey echo", so `app/main/assets/wake-word/hey_echo_v0.1.onnx` was
trained here with openWakeWord's own training pipeline (`openwakeword/train.py`). Everything runs on
the CPU inside WSL (Ubuntu 24.04) on bija; no GPU is needed.

| File | What it does |
| --- | --- |
| `setup.sh` | Installs uv, clones openWakeWord and piper-sample-generator (pinned to v2.0.0, the layout openWakeWord expects) into `~/wakeword`, makes a Python 3.10 venv with CPU torch, and downloads the Piper LibriTTS-R voice used to synthesize clips. |
| `download_data.py` | Fetches the training data into `~/wakeword/data`: MIT impulse responses (reverb), two AudioSet balanced-train shards and an hour of FMA music (background noise), openWakeWord's ACAV100M negative features (17 GB) and its validation features. |
| `hey_echo.yml` | The training config: 30,000 synthetic "hey echo" clips, 30,000 adversarial clips (near-misses such as "echo", "hey ego", "the echo", "hey jarvis", plus openWakeWord's phoneme-based ones), 50,000 training steps, a target of 0.2 false wakes per hour. |
| `run_training.sh` | Runs the three stages: generate clips, augment them into features, then train and export ONNX. Each stage skips work already on disk. |
| `extra_clips.py` | Adds 8,600 targeted near-miss clips ("the echo", "they echo", "echoes"…) and 5,300 paused "Hey, Echo." clips to the generated set. train.py mixes `custom_negative_phrases` into ~30,000 auto-generated phrases, so on their own they get almost no clips. |
| `hey_echo_v2.yml` … `hey_echo_v4.yml` | The tuning runs below; v4 is the shipped model. |
| `make_eval.py`, `score_eval.py` | An independent test set from the app's Kokoro TTS (a different engine from training): 200 "hey echo" clips and 750 near-miss sentences over 25 voices at two speeds. The scorer reports recall and false accepts per threshold. |

To retrain (from Windows):

```bash
wsl -d Ubuntu-24.04 -- bash /mnt/c/Users/kevin/repos/github/silarsis/aiembodied/experiments/wakeword/setup.sh
wsl -d Ubuntu-24.04 -- bash -lc "cd ~/wakeword && .venv/bin/python /mnt/c/Users/kevin/repos/github/silarsis/aiembodied/experiments/wakeword/download_data.py"
wsl -d Ubuntu-24.04 -- bash /mnt/c/Users/kevin/repos/github/silarsis/aiembodied/experiments/wakeword/run_training.sh
```

The model lands in `~/wakeword/hey_echo_model/hey_echo.onnx`. Copy it to
`app/main/assets/wake-word/hey_echo_v0.1.onnx`, or point `WAKE_WORD_MODEL` at it.

## Results

Validation is openWakeWord's own split: recall on augmented synthetic clips, and false wakes per hour on ~11 h of general audio. The Kokoro columns use the independent test set at threshold 0.5.

| Model | Change | Validation recall | False wakes / h | Kokoro recall | Kokoro false accepts |
| --- | --- | --- | --- | --- | --- |
| v1 | `hey_echo.yml`: 32-unit DNN, 50k steps | 39% | 0.09 | 48% | 11 / 750 |
| v2 | 64 units, 100k steps, max negative weight 1000 | 54% | 0.62 | 68% | 47 / 750 |
| v3 | + `extra_clips.py`, negative weight 1500 | 43% | 0.18 | 44% | 2 / 750 |
| **v4 (shipped)** | v3's data, negative weight 500 | 52% | 0.80 | **83%** | 20 / 750 |

v4's false accepts are mostly one sentence, "the echo was really loud" (17 of 50 renditions). "Hey, Echo." with a pause is still the weakest positive (18 of 50 missed). Raising `WAKE_WORD_THRESHOLD` to 0.7 trades a little recall (78%) for slightly fewer false accepts (17).

To reproduce v4 after `run_training.sh`: run `extra_clips.py`, then `train.py --training_config hey_echo_v3.yml --augment_clips --overwrite`, then `train.py --training_config hey_echo_v4.yml --train_model`.

Version pins that matter: `pyarrow<15` (datasets 2.14 uses `pa.PyExtensionType`), `setuptools<70`
(`pronouncing` imports `pkg_resources`), `webrtcvad-wheels` (WSL has no C compiler). The git checkout of openWakeWord lacks its feature models, so `setup.sh` copies the app's bundled `melspectrogram.onnx` and `embedding_model.onnx` into it. The TFLite export at the end of training fails on a protobuf mismatch. That doesn't matter: the ONNX model is saved first, and the app only uses ONNX.
