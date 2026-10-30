#!/usr/bin/env bash
# Train "hey echo" in WSL: generate clips, augment them into features, train, export ONNX.
# Each stage skips work already on disk, so it can be re-run after an interruption.
# Run: bash run_training.sh   (log in ~/wakeword/train.log)
set -euo pipefail
CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hey_echo.yml"
cd ~/wakeword
source .venv/bin/activate
stage() { echo "== $(date '+%H:%M:%S') $1"; }

stage "generate clips"
python openWakeWord/openwakeword/train.py --training_config "$CONFIG" --generate_clips
stage "augment clips"
python openWakeWord/openwakeword/train.py --training_config "$CONFIG" --augment_clips
stage "train model"
python openWakeWord/openwakeword/train.py --training_config "$CONFIG" --train_model
stage "done"
ls -la hey_echo_model/*.onnx
