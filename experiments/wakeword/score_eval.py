"""Score wake-word models on eval/{pos,neg}: peak score per clip (with a second of silence either
side), then recall and false accepts at a few thresholds. Run in the WSL training venv:
python score_eval.py model1.onnx [model2.onnx ...]"""
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import soundfile
import torch
import torchaudio
from openwakeword.model import Model

here = Path(__file__).parent / "eval"


def load(path: Path) -> np.ndarray:
    audio, rate = soundfile.read(path, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if rate != 16000:
        audio = torchaudio.functional.resample(torch.from_numpy(audio), rate, 16000).numpy()
    pad = np.zeros(16000, dtype=np.float32)
    return (np.concatenate([pad, audio, pad]) * 32767).astype(np.int16)


clips = {kind: sorted((here / kind).glob("*.wav")) for kind in ("pos", "neg")}
audio = {p: load(p) for kind in clips for p in clips[kind]}
for model_path in sys.argv[1:]:
    model = Model(wakeword_models=[model_path], inference_framework="onnx")
    name = next(iter(model.models))
    peaks = {}
    for path, samples in audio.items():
        model.reset()
        scores = [model.predict(samples[i:i + 1280])[name] for i in range(0, len(samples) - 1280, 1280)]
        peaks[path] = max(scores)
    print(f"\n{model_path}")
    for threshold in (0.3, 0.5, 0.7):
        hits = sum(peaks[p] >= threshold for p in clips["pos"])
        false = [p for p in clips["neg"] if peaks[p] >= threshold]
        print(f"  threshold {threshold}: recall {hits}/{len(clips['pos'])} ({100 * hits / len(clips['pos']):.0f}%),"
              f" false accepts {len(false)}/{len(clips['neg'])}")
        if threshold == 0.5 and false:
            by_text = Counter(p.stem.split("_")[-1] for p in false)
            print("    false accepts by sentence index:", dict(sorted(by_text.items())))
    misses = Counter(p.stem.split("_")[-1] for p in clips["pos"] if peaks[p] < 0.5)
    print("  misses at 0.5 by positive phrase index:", dict(sorted(misses.items())))
