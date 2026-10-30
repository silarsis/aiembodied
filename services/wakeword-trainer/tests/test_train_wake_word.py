import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import train_wake_word as t  # noqa: E402


def test_slugify():
    assert t.slugify("Hey, Echo!") == "hey_echo"
    assert t.slugify("  Computer ") == "computer"


def test_near_misses_cover_everyday_uses_of_the_last_word():
    misses = t.near_misses("hey echo")
    for phrase in ("echo", "the echo", "they echo", "the echo was really loud", "hey", "hey jarvis"):
        assert phrase in misses
    assert "hey echo" not in misses
    assert len(misses) == len(set(misses))


def test_near_misses_leave_out_the_phrase_itself():
    assert "hey jarvis" not in t.near_misses("hey jarvis")


def test_positive_variants_include_the_paused_form():
    assert t.positive_variants("hey echo") == ["hey echo", "hey, echo", "hey... echo"]
    assert t.positive_variants("computer")[0] == "computer"


def test_status_and_config(tmp_path, monkeypatch):
    monkeypatch.setattr(t, "ROOT", tmp_path)
    job = t.Job(argparse.Namespace(phrase="Hey  Echo", job_dir=str(tmp_path / "job"),
                                   output_dir=str(tmp_path / "out"), quick=True))
    job.model_root = tmp_path / "models"
    job.config_path = job.model_root / f"{job.slug}.yml"
    job.job_dir.mkdir()
    job.enter("augment")
    status = json.loads((job.job_dir / "status.json").read_text())
    assert status["slug"] == "hey_echo_quick"
    assert status["phrase"] == "Hey Echo"
    assert status["stage"] == "augment"
    # setup, download, generate and extra are done: 2 + 8 + 45 + 8 percent.
    assert abs(status["progress"] - 0.63) < 1e-6
    job.write_config()
    config = job.config_path.read_text()
    assert 'model_name: "hey_echo_quick"' in config
    assert '  - "the echo was really loud"' in config
    assert "steps: 5000" in config
