"""Download the openWakeWord training data into ~/wakeword/data (run in the WSL training venv).

Same sources as openWakeWord's automatic_model_training notebook:
  - MIT environmental impulse responses (reverb)           ~0.3 GB
  - one AudioSet balanced-train shard (background noise)   ~1-2 GB
  - one hour of FMA music (background)                     ~0.2 GB
  - ACAV100M precomputed features (negative training data) ~17 GB
  - validation set features (false-wake measurement)       ~0.2 GB
Each step is skipped when its output already exists, so the script can be re-run after a failure.
"""
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import scipy.io.wavfile
from tqdm import tqdm

DATA = Path.home() / "wakeword" / "data"
DATA.mkdir(parents=True, exist_ok=True)
HF = "https://huggingface.co/datasets"


def wget(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    tmp = dest.with_suffix(dest.suffix + ".part")
    ok = subprocess.run(["wget", "-q", "--show-progress", "--progress=dot:giga", "-c", "-O", str(tmp), url]).returncode == 0
    if ok:
        tmp.rename(dest)
    else:
        tmp.unlink(missing_ok=True)
    return ok


def save16k(path: Path, audio: np.ndarray, rate: int) -> None:
    import torch
    import torchaudio
    t = torch.from_numpy(np.asarray(audio, dtype=np.float32))
    if t.ndim > 1:
        t = t.mean(dim=-1 if t.shape[-1] <= 2 else 0)
    if rate != 16000:
        t = torchaudio.functional.resample(t, rate, 16000)
    scipy.io.wavfile.write(path, 16000, (t.clamp(-1, 1).numpy() * 32767).astype(np.int16))


def rirs() -> None:
    out = DATA / "mit_rirs"
    if out.exists() and any(out.iterdir()):
        return
    out.mkdir(exist_ok=True)
    import datasets
    ds = datasets.load_dataset("davidscripka/MIT_environmental_impulse_responses", split="train", streaming=True)
    for row in tqdm(ds, desc="MIT RIRs"):
        a = row["audio"]
        save16k(out / Path(a["path"]).name, a["array"], a["sampling_rate"])


def audioset(shards: int = 2) -> None:
    """AudioSet balanced-train clips as background noise. The HF dataset now ships Parquet shards
    (~700 MB, ~1000 ten-second clips each) with the audio bytes inline."""
    out = DATA / "audioset_16k"
    if out.exists() and any(out.iterdir()):
        return
    out.mkdir(exist_ok=True)
    import io
    import pyarrow.parquet as pq
    import soundfile
    for i in range(shards):
        shard = DATA / f"audioset_{i:02d}.parquet"
        if not wget(f"{HF}/agkphysics/AudioSet/resolve/main/data/bal_train/{i:02d}.parquet", shard):
            print(f"AudioSet shard {i:02d} unavailable; continuing without it", file=sys.stderr)
            continue
        table = pq.read_table(shard)
        audio_col = next(c for c in table.column_names if c.lower().startswith("audio") or c == "flac")
        ids = table.column("video_id").to_pylist() if "video_id" in table.column_names else None
        for row, item in enumerate(tqdm(table.column(audio_col).to_pylist(), desc=f"AudioSet {i:02d} -> 16k wav")):
            data = item.get("bytes") if isinstance(item, dict) else item
            try:
                audio, rate = soundfile.read(io.BytesIO(data))
                save16k(out / f"{ids[row] if ids else f'{i:02d}_{row:05d}'}.wav", audio, rate)
            except Exception as error:  # a few clips are corrupt or in a format soundfile cannot read
                print(f"skip clip {row} of shard {i:02d}: {error}", file=sys.stderr)
        shard.unlink()


def fma(hours: float = 1.0) -> None:
    out = DATA / "fma"
    if out.exists() and any(out.iterdir()):
        return
    out.mkdir(exist_ok=True)
    try:
        import datasets
        ds = datasets.load_dataset("rudraml/fma", name="small", split="train", streaming=True)
        ds = iter(ds.cast_column("audio", datasets.Audio(sampling_rate=16000)))
        for i in tqdm(range(int(hours * 3600 // 30)), desc="FMA"):
            a = next(ds)["audio"]
            save16k(out / f"fma_{i:04d}.wav", a["array"], a["sampling_rate"])
    except Exception as error:
        print(f"FMA unavailable ({error}); continuing without it", file=sys.stderr)


def features() -> None:
    base = f"{HF}/davidscripka/openwakeword_features/resolve/main"
    for name in ("validation_set_features.npy", "openwakeword_features_ACAV100M_2000_hrs_16bit.npy"):
        if not wget(f"{base}/{name}", DATA / name):
            sys.exit(f"failed to download {name}")


if __name__ == "__main__":
    os.chdir(DATA)
    for step in (rirs, audioset, fma, features):
        print(f"== {step.__name__}", flush=True)
        step()
    print("downloads done", flush=True)
    subprocess.run(["du", "-sh", *[str(p) for p in sorted(DATA.iterdir())]])
