#!/usr/bin/env bash
# Set up openWakeWord training in WSL (CPU only). Run: bash setup.sh
set -euo pipefail
W=~/wakeword
mkdir -p $W && cd $W
command -v uv >/dev/null || [ -x ~/.local/bin/uv ] || { curl -LsSf https://astral.sh/uv/install.sh | sh; }
export PATH="$HOME/.local/bin:$PATH"
[ -d openWakeWord ] || git clone -q https://github.com/dscripka/openWakeWord
[ -d piper-sample-generator ] || git clone -q https://github.com/rhasspy/piper-sample-generator
# openWakeWord expects the v2 layout (generate_samples.py at the top), matching the v2.0.0 voice model.
git -C piper-sample-generator checkout -q v2.0.0
mkdir -p openWakeWord/openwakeword/resources/models
# The feature models are not in the git checkout; the app bundles the same v0.5.1 files.
cp /mnt/c/Users/kevin/repos/github/silarsis/aiembodied/app/main/assets/wake-word/{melspectrogram,embedding_model}.onnx openWakeWord/openwakeword/resources/models/
[ -d .venv ] || uv venv -q --python 3.10 .venv
source .venv/bin/activate
uv pip install -q --index-url https://download.pytorch.org/whl/cpu torch==2.1.2 torchaudio==2.1.2
uv pip install -q -e ./openWakeWord
uv pip install -q piper-phonemize webrtcvad-wheels mutagen==1.47.0 torchinfo==1.8.0 torchmetrics==1.2.0 \
  speechbrain==0.5.14 audiomentations==0.33.0 torch-audiomentations==0.11.0 acoustics==0.2.6 \
  tensorflow-cpu==2.8.1 tensorflow_probability==0.16.0 onnx_tf==1.10.0 pronouncing==0.2.0 \
  datasets==2.14.6 "pyarrow<15" "setuptools<70" deep-phonemizer==0.0.19 "numpy<2" scipy tqdm pyyaml soundfile onnx onnxruntime
mkdir -p piper-sample-generator/models
[ -f piper-sample-generator/models/en_US-libritts_r-medium.pt ] || wget -q -O piper-sample-generator/models/en_US-libritts_r-medium.pt \
  https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt
python -c "import openwakeword, torch, piper_phonemize; print('ok', torch.__version__)"
