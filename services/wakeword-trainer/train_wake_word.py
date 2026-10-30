"""Train an openWakeWord model for any phrase, end to end, inside WSL.

The app starts this detached (setsid nohup) so a run of several hours survives the app closing.
It needs only the system python3: setup.sh builds the training venv, and each stage runs in it.

    python3 train_wake_word.py --phrase "hey echo" --job-dir /mnt/c/.../jobs/hey_echo \
        --output-dir /mnt/c/.../wake-words

Stages: setup, download, generate, extra, augment, train, export. Each one skips work already on
disk, so re-running the same phrase resumes an interrupted run. Progress goes to
<job-dir>/status.json (rewritten atomically every few seconds), output to <job-dir>/train.log.
The model lands in <output-dir>/<slug>.onnx with <slug>.json beside it.

These are the settings of the shipped "hey echo" model (v4 in experiments/wakeword/README.md).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = Path.home() / "wakeword"
DATA = ROOT / "data"
VENV_PYTHON = ROOT / ".venv" / "bin" / "python"
SETUP_MARKER = ROOT / ".setup-done"
DATA_MARKER = DATA / ".downloads-done"
TRAIN_PY = ROOT / "openWakeWord" / "openwakeword" / "train.py"

# Share of the whole run each stage takes, for one overall progress figure (CPU timings on bija).
STAGES = [
    ("setup", "Setting up the training environment", 0.02),
    ("download", "Downloading training data (about 20 GB, once)", 0.08),
    ("generate", "Generating spoken clips", 0.45),
    ("extra", "Generating near-miss clips", 0.08),
    ("augment", "Adding background noise and reverb", 0.15),
    ("train", "Training the model", 0.20),
    ("export", "Saving the model", 0.02),
]
COMMON_WAKE_WORDS = ["hey jarvis", "alexa", "hey google", "hey siri", "ok google", "hey mycroft"]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(phrase: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", phrase.lower()).strip("_")
    if not slug:
        raise SystemExit("The phrase needs at least one letter or digit.")
    return slug


def near_misses(phrase: str) -> list[str]:
    """Phrases that sound like the wake word but must not trigger it. openWakeWord adds its own
    phoneme-based ones; these are the everyday sentences those miss (v1/v2 woke on "the echo...")."""
    words = phrase.lower().split()
    first, last = words[0], words[-1]
    out = [last, f"the {last}", f"a {last}", f"an {last}", f"that {last}", f"this {last}", f"they {last}",
           f"{last}s", f"{last} {last}", f"there's a {last}", f"the {last} was really loud", f"I said {last}",
           f"the {last} in here", f"say {last}"]
    if len(words) > 1:
        rest = " ".join(words[1:])
        head = " ".join(words[:-1])
        out += [first, head, f"{first} you", f"{first} there", f"{first} let's go", f"the {rest}", f"they {rest}"]
    out += [w for w in COMMON_WAKE_WORDS if w != phrase.lower()]
    return list(dict.fromkeys(out))


def positive_variants(phrase: str) -> list[str]:
    """The phrase as people say it: straight through, and with a pause after the first word."""
    words = phrase.split()
    if len(words) == 1:
        return [phrase, f"{phrase}.", f"{phrase}!"]
    rest = " ".join(words[1:])
    return [phrase, f"{words[0]}, {rest}", f"{words[0]}... {rest}"]


class Job:
    def __init__(self, args: argparse.Namespace) -> None:
        self.phrase = " ".join(args.phrase.split())
        self.quick = args.quick
        # A quick run keeps its clips and features apart, so a full run never reuses them.
        self.slug = slugify(self.phrase) + ("_quick" if self.quick else "")
        self.job_dir = Path(args.job_dir)
        self.output_dir = Path(args.output_dir)
        self.model_root = ROOT / "models"
        self.clip_dir = self.model_root / self.slug
        self.config_path = self.clip_dir.with_suffix(".yml")
        self.log_path = self.job_dir / "train.log"
        self.child: subprocess.Popen[str] | None = None
        self.lock = threading.Lock()
        self.status: dict = {
            "slug": self.slug,
            "phrase": self.phrase,
            "state": "running",
            "stage": "setup",
            "stageLabel": STAGES[0][1],
            "stageProgress": 0.0,
            "progress": 0.0,
            "message": "",
            "startedAt": now(),
            "updatedAt": now(),
            "pid": os.getpid(),
            "quick": self.quick,
        }
        self.n_samples = 2000 if self.quick else 30000
        self.n_val = 200 if self.quick else 2000
        self.steps = 5000 if self.quick else 100000

    # -- status -----------------------------------------------------------------------------
    def write_status(self, **changes) -> None:
        with self.lock:
            self.status.update(changes)
            self.status["updatedAt"] = now()
            names = [name for name, _, _ in STAGES]
            stage = self.status["stage"]
            if stage in names:
                index = names.index(stage)
                done = sum(weight for _, _, weight in STAGES[:index])
                self.status["progress"] = round(min(1.0, done + STAGES[index][2] * self.status["stageProgress"]), 4)
            tmp = self.job_dir / "status.json.tmp"
            tmp.write_text(json.dumps(self.status, indent=2))
            tmp.replace(self.job_dir / "status.json")

    def enter(self, stage: str, message: str = "") -> None:
        label = next(label for name, label, _ in STAGES if name == stage)
        self.log(f"== {stage}: {label}")
        self.write_status(stage=stage, stageLabel=label, stageProgress=0.0, message=message)

    def log(self, line: str) -> None:
        with self.log_path.open("a") as log:
            log.write(f"[{now()}] {line}\n")

    # -- running commands -------------------------------------------------------------------
    def run(self, command: list[str], progress=None, cwd: Path = ROOT) -> int:
        """Run a command with its output appended to the log. `progress(line)` sees each output line
        (tqdm's carriage-return updates included); the heartbeat keeps status.json fresh meanwhile."""
        self.log("$ " + " ".join(command))
        with self.log_path.open("a") as log:
            self.child = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                          text=True, bufsize=1, env={**os.environ, "PYTHONUNBUFFERED": "1"})
            assert self.child.stdout is not None
            buffer = ""
            while True:
                chunk = self.child.stdout.read(1)
                if not chunk:
                    break
                buffer += chunk
                if chunk in "\r\n":
                    if chunk == "\n":  # tqdm's \r redraws stay out of the log
                        log.write(buffer)
                    if progress:
                        progress(buffer.strip())
                    buffer = ""
            code = self.child.wait()
        self.child = None
        self.log(f"exit {code}")
        return code

    def heartbeat(self) -> None:
        while self.status["state"] == "running":
            time.sleep(10)
            if self.status["stage"] == "generate":
                self.write_status(stageProgress=self.generated_fraction())
            else:
                self.write_status()

    def generated_fraction(self) -> float:
        targets = {"positive_train": self.n_samples, "positive_test": self.n_val,
                   "negative_train": self.n_samples, "negative_test": self.n_val}
        counts = [min(target, len(list((self.clip_dir / name).glob("*.wav"))) if (self.clip_dir / name).exists() else 0)
                  for name, target in targets.items()]
        return sum(counts) / sum(targets.values())

    # -- stages -----------------------------------------------------------------------------
    def setup(self) -> None:
        self.enter("setup")
        if SETUP_MARKER.exists() and VENV_PYTHON.exists():
            return
        if self.run(["bash", str(HERE / "setup.sh")]) != 0:
            raise RuntimeError("Setting up the training environment failed; see train.log.")
        SETUP_MARKER.touch()

    def download(self) -> None:
        self.enter("download")
        if DATA_MARKER.exists():
            return
        if self.run([str(VENV_PYTHON), str(HERE / "download_data.py")]) != 0:
            raise RuntimeError("Downloading the training data failed; see train.log.")
        DATA_MARKER.touch()

    def write_config(self) -> None:
        q = json.dumps
        negatives = "\n".join(f"  - {q(p)}" for p in near_misses(self.phrase))
        self.model_root.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(f"""# Written by train_wake_word.py for {q(self.phrase)}.
model_name: {q(self.slug)}
target_phrase:
  - {q(self.phrase.lower())}
custom_negative_phrases:
{negatives}
n_samples: {self.n_samples}
n_samples_val: {self.n_val}
tts_batch_size: 50
augmentation_batch_size: 16
piper_sample_generator_path: {q(str(ROOT / "piper-sample-generator"))}
output_dir: {q(str(self.model_root))}
rir_paths:
  - {q(str(DATA / "mit_rirs"))}
background_paths:
  - {q(str(DATA / "audioset_16k"))}
  - {q(str(DATA / "fma"))}
background_paths_duplication_rate:
  - 1
  - 1
false_positive_validation_data_path: {q(str(DATA / "validation_set_features.npy"))}
augmentation_rounds: 1
feature_data_files:
  "ACAV100M_sample": {q(str(DATA / "openwakeword_features_ACAV100M_2000_hrs_16bit.npy"))}
batch_n_per_class:
  "ACAV100M_sample": 1024
  "adversarial_negative": 50
  "positive": 50
model_type: "dnn"
layer_size: 64
steps: {self.steps}
max_negative_weight: 500
target_false_positives_per_hour: 1.0
""")

    def train_py(self, flag: str, progress=None) -> int:
        return self.run([str(VENV_PYTHON), str(TRAIN_PY), "--training_config", str(self.config_path), flag], progress)

    def generate(self) -> None:
        self.enter("generate", f"{self.n_samples * 2 + self.n_val * 2:,} clips")
        self.write_config()
        if self.generated_fraction() >= 1.0:
            return
        if self.train_py("--generate_clips") != 0 and self.generated_fraction() < 0.95:
            raise RuntimeError("Generating clips failed; see train.log.")

    def extra(self) -> None:
        """train.py mixes custom_negative_phrases into ~30,000 phoneme-based phrases, so on their own
        they get almost no clips. Synthesize the near-misses and the paused form directly."""
        self.enter("extra")
        marker = self.clip_dir / ".extra-done"
        if marker.exists():
            return
        scale = 0.1 if self.quick else 1.0
        script = HERE / "generate_extra_clips.py"
        code = self.run([str(VENV_PYTHON), str(script), "--clip-dir", str(self.clip_dir),
                         "--negatives", json.dumps(near_misses(self.phrase)),
                         "--positives", json.dumps(positive_variants(self.phrase)),
                         "--scale", str(scale)],
                        progress=lambda line: self.batch_progress(line))
        if code != 0:
            raise RuntimeError("Generating near-miss clips failed; see train.log.")
        marker.touch()

    def batch_progress(self, line: str) -> None:
        match = re.search(r"progress (\d+)/(\d+)", line)
        if match:
            self.write_status(stageProgress=int(match[1]) / max(1, int(match[2])))

    def augment(self) -> None:
        self.enter("augment")
        features = [self.clip_dir / f"{kind}_features_{split}.npy" for kind in ("positive", "negative")
                    for split in ("train", "test")]
        if all(path.exists() for path in features):
            return

        def progress(_line: str) -> None:
            self.write_status(stageProgress=sum(path.exists() for path in features) / len(features))

        if self.train_py("--augment_clips", progress) != 0 or not all(path.exists() for path in features):
            raise RuntimeError("Augmenting clips failed; see train.log.")

    def train(self) -> dict:
        self.enter("train")
        metrics: dict = {}
        # train.py runs the full step count, then two shorter refinement passes of steps/10.
        total = self.steps * 1.2
        phase = {"done": 0, "last": 0}

        def progress(line: str) -> None:
            for name, key in (("Accuracy", "accuracy"), ("Recall", "recall"),
                              ("False Positives per Hour", "falsePositivesPerHour")):
                match = re.search(rf"Final Model {name}:\s*([0-9.]+)", line)
                if match:
                    metrics[key] = float(match[1])
            match = re.search(r"(\d+)/(\d+) \[", line)
            if match:
                step, steps = int(match[1]), int(match[2])
                if step < phase["last"]:
                    phase["done"] += phase["last"]
                phase["last"] = step
                self.write_status(stageProgress=min(0.99, (phase["done"] + step) / total), message=f"step {step:,} of {steps:,}")

        started = time.time()
        code = self.train_py("--train_model", progress)
        model = self.model_root / f"{self.slug}.onnx"
        # The TFLite export at the very end fails on a protobuf mismatch; the ONNX file is written first.
        if not model.exists() or model.stat().st_mtime < started:
            raise RuntimeError(f"Training failed (exit {code}); see train.log.")
        return metrics

    def export(self, metrics: dict) -> dict:
        self.enter("export")
        self.output_dir.mkdir(parents=True, exist_ok=True)
        target = self.output_dir / f"{self.slug}.onnx"
        shutil.copyfile(self.model_root / f"{self.slug}.onnx", target)
        meta = {"phrase": self.phrase, "slug": self.slug, "trainedAt": now(), "quick": self.quick, "metrics": metrics}
        (self.output_dir / f"{self.slug}.json").write_text(json.dumps(meta, indent=2))
        return {"model": str(target), **meta}

    # -- main -------------------------------------------------------------------------------
    def main(self) -> int:
        self.job_dir.mkdir(parents=True, exist_ok=True)
        self.write_status()
        signal.signal(signal.SIGTERM, self.cancelled)
        threading.Thread(target=self.heartbeat, daemon=True).start()
        try:
            self.setup()
            self.download()
            self.generate()
            self.extra()
            self.augment()
            result = self.export(self.train())
        except Exception as error:  # report every failure through status.json, which the app reads
            self.log(f"failed: {error}")
            self.write_status(state="failed", error=str(error))
            return 1
        self.write_status(state="done", stageProgress=1.0, progress=1.0, result=result, message="")
        self.log("done")
        return 0

    def cancelled(self, *_args) -> None:
        if self.child and self.child.poll() is None:
            self.child.terminate()
        self.write_status(state="cancelled", message="Cancelled")
        self.log("cancelled")
        sys.exit(130)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--phrase", required=True)
    parser.add_argument("--job-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--quick", action="store_true", help="a small run (minutes, not hours) to test the pipeline")
    sys.exit(Job(parser.parse_args()).main())
