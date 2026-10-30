"""Synthesize targeted clips into a model's clip folders before augmentation (runs in the training venv).

train_wake_word.py calls this after train.py --generate_clips. It adds near-miss sentences as
negatives and the paused forms of the phrase ("Hey, Echo.") as positives, which train.py's own
generation barely covers. Prints "progress done/total" lines for the app's progress bar.
"""
import argparse
import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path.home() / "wakeword" / "piper-sample-generator"))
from generate_samples import generate_samples  # noqa: E402

CHUNK = 500


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clip-dir", required=True)
    parser.add_argument("--negatives", required=True, help="JSON list of near-miss phrases")
    parser.add_argument("--positives", required=True, help="JSON list of ways to say the phrase")
    parser.add_argument("--scale", type=float, default=1.0)
    args = parser.parse_args()
    root = Path(args.clip_dir)
    negatives, positives = json.loads(args.negatives), json.loads(args.positives)
    # The counts that fixed "hey echo" (v3/v4): 8,600 near-misses and 5,300 paused positives.
    plan = [(negatives, "negative_train", 8000, 25), (negatives, "negative_test", 600, 25),
            (positives, "positive_train", 5000, 50), (positives, "positive_test", 300, 50)]
    plan = [(texts, folder, max(1, int(n * args.scale)), batch) for texts, folder, n, batch in plan]
    total, done = sum(n for _, _, n, _ in plan), 0
    for texts, folder, n, batch in plan:
        out = root / folder
        out.mkdir(parents=True, exist_ok=True)
        for start in range(0, n, CHUNK):
            count = min(CHUNK, n - start)
            generate_samples(text=texts, max_samples=count, batch_size=batch, noise_scales=[0.98],
                             noise_scale_ws=[0.98], length_scales=[0.75, 1.0, 1.25], output_dir=str(out),
                             auto_reduce_batch_size=True,
                             file_names=[f"extra_{uuid.uuid4().hex}.wav" for _ in range(count)])
            done += count
            print(f"progress {done}/{total}", flush=True)
    print({d.name: len(list(d.glob("*.wav"))) for d in root.iterdir() if d.is_dir()}, flush=True)


if __name__ == "__main__":
    main()
