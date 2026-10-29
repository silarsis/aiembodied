"""Make a Chatterbox reference clip from a Kokoro preset, so Chatterbox speaks with that preset's
accent (British for bf_*) while adding its own expressiveness. A real recording of a person (10-15 s,
one speaker, no music, read with some feeling) clones better; drop it in voices/ as <name>.wav.

python -m speech_service.make_voice --kokoro-dir <dir> --voice bf_isabella --out voices/isabella.wav
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

# About 15 s, with questions and exclamations, so the clip carries some range.
REFERENCE_TEXT = (
    "Oh, hello! I wasn't expecting you quite so early, but honestly, I'm delighted. "
    "Come in, sit down. Did you manage to get any sleep last night? "
    "I tried that new recipe, and it was an absolute disaster. Still, we live and learn, don't we?"
)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="speech_service.make_voice", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kokoro-dir", default=os.environ.get("KOKORO_DIR"),
                    help="folder with kokoro-v1.0.onnx and voices-v1.0.bin")
    ap.add_argument("--voice", default="bf_isabella", help="Kokoro preset, or a blend such as bf_isabella:60,bf_emma:40")
    ap.add_argument("--out", required=True, help="WAV to write, e.g. voices/isabella.wav")
    ap.add_argument("--speed", type=float, default=0.95)
    ap.add_argument("--text", default=REFERENCE_TEXT)
    a = ap.parse_args(argv)
    if not a.kokoro_dir:
        ap.error("--kokoro-dir (or KOKORO_DIR) is required")

    import numpy as np
    from kokoro_onnx import Kokoro

    from .app import encode_wav

    kokoro = Kokoro(str(Path(a.kokoro_dir) / "kokoro-v1.0.onnx"), str(Path(a.kokoro_dir) / "voices-v1.0.bin"))
    style = a.voice
    if ":" in a.voice:  # weighted blend of presets
        parts = [part.split(":") for part in a.voice.split(",")]
        total = sum(float(weight) for _, weight in parts)
        style = sum(kokoro.get_voice_style(name) * (float(weight) / total) for name, weight in parts)
    lang = "en-gb" if a.voice.startswith("b") else "en-us"
    samples, rate = kokoro.create(a.text, voice=style, speed=a.speed, lang=lang)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(encode_wav(np.asarray(samples, dtype=np.float32), int(rate)))
    print(f"wrote {out} ({len(samples) / rate:.1f} s)")


if __name__ == "__main__":
    main()
