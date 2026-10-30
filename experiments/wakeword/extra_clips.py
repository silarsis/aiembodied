"""Add targeted clips to the generated training set (run in the WSL venv, from ~/wakeword).

train.py puts custom_negative_phrases into one list with ~30,000 phoneme-based adversarial texts
and cycles through it, so a handful of custom phrases get almost no clips. v1/v2 then woke on
"the echo ..." / "they echo ...". This synthesizes those near-misses (and the paused "Hey, Echo."
form that both models missed) directly into the clip folders before augmentation."""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path.home() / "wakeword" / "piper-sample-generator"))
from generate_samples import generate_samples  # noqa: E402

ROOT = Path.home() / "wakeword" / "hey_echo_model" / "hey_echo"
NEAR_MISSES = [
    "the echo", "the echo was loud", "the echo was really loud", "they echo", "they echo each other",
    "they echo that", "an echo", "that echo", "this echo", "the echo chamber", "echo", "echoes",
    "she echoed it", "a gecko", "the deck", "hey ego", "hey eco", "hay echo is", "may echo", "say echo",
    "the eco mode", "they go", "hey you go", "the echo in here", "there's an echo", "echo echo",
]
POSITIVE = ["hey, echo", "hey... echo", "hey echo"]


def add(texts, folder, n, batch):
    out = ROOT / folder
    generate_samples(text=texts, max_samples=n, batch_size=batch, noise_scales=[0.98], noise_scale_ws=[0.98],
                     length_scales=[0.75, 1.0, 1.25], output_dir=str(out), auto_reduce_batch_size=True,
                     file_names=[f"extra_{uuid.uuid4().hex}.wav" for _ in range(n)])


add(NEAR_MISSES, "negative_train", 8000, 25)
add(NEAR_MISSES, "negative_test", 600, 25)
add(POSITIVE, "positive_train", 5000, 50)
add(POSITIVE, "positive_test", 300, 50)
print({d.name: len(list(d.glob("*.wav"))) for d in ROOT.iterdir() if d.is_dir()})
