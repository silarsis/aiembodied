from types import SimpleNamespace

import numpy as np
from fastapi.testclient import TestClient

from speech_service.app import create_app
from speech_service.engines import ChatterboxSynthesizer, RoutingSynthesizer, strip_tags


class FakeSession:
    """Stands in for one ONNX Runtime session; `run` is given the input dict to answer."""

    def __init__(self, inputs, run):
        self._inputs = [SimpleNamespace(name=n, shape=["b", 2, "s", 4], type="tensor(float)") for n in inputs]
        self._run = run
        self.calls = []

    def get_inputs(self):
        return self._inputs

    def run(self, _outputs, feed):
        self.calls.append(feed)
        return self._run(feed)


def make_chatterbox(variant: str, speech_tokens=(7, 8, 9)) -> ChatterboxSynthesizer:
    synth = ChatterboxSynthesizer(voices_dir="unused")
    synth.variant = variant
    synth.voices = ["ref"]
    synth._conditioning["ref"] = (np.zeros((1, 2, 3), np.float32), np.array([[1, 2]], np.int64),
                                  np.zeros((1, 5), np.float32), np.zeros((1, 4, 5), np.float32))
    synth._tokenizer = lambda text, return_tensors: {"input_ids": np.array([[10, 11, 12]])}
    script = list(speech_tokens) + [ChatterboxSynthesizer.STOP_SPEECH]

    def lm(feed):
        token = script[len(lm_session.calls) - 1]
        logits = np.zeros((1, 1, 6600), np.float32)
        logits[0, -1, token] = 10.0
        grown = (np.concatenate([v, np.zeros((1, 2, 1, 4), v.dtype)], axis=2) for k, v in feed.items() if "past" in k)
        return [logits, *grown]

    lm_inputs = ["inputs_embeds", "attention_mask", "past_key_values.0.key", "past_key_values.0.value"]
    if variant == "turbo":
        lm_inputs.append("position_ids")
    lm_session = FakeSession(lm_inputs, lm)
    synth._sessions = {
        "embed_tokens": FakeSession([], lambda feed: [np.zeros((1, feed["input_ids"].shape[1], 3), np.float32)]),
        "language_model": lm_session,
        "conditional_decoder": FakeSession([], lambda feed: [np.ones((1, 100 * feed["speech_tokens"].shape[1]))]),
    }
    return synth


def test_original_generates_until_stop_and_passes_exaggeration():
    synth = make_chatterbox("original")
    samples, rate = synth.synthesize("Hello there.", "ref", 1.0, exaggeration=0.9)
    assert rate == 24000
    decoder_feed = synth._sessions["conditional_decoder"].calls[0]
    assert decoder_feed["speech_tokens"].tolist() == [[1, 2, 7, 8, 9]]  # prompt + generated, no stop
    assert len(samples) == 500
    embeds = synth._sessions["embed_tokens"].calls
    assert all(float(call["exaggeration"][0]) == np.float32(0.9) for call in embeds)
    assert [int(call["position_ids"][0, 0]) for call in embeds[1:]] == [1, 2, 3]
    lm_calls = synth._sessions["language_model"].calls
    assert lm_calls[0]["attention_mask"].shape == (1, 5)  # 2 conditioning + 3 text
    assert lm_calls[-1]["attention_mask"].shape == (1, 8)
    assert lm_calls[-1]["past_key_values.0.key"].shape == (1, 2, 3, 4)  # cache carried forward


def test_turbo_appends_silence_and_feeds_positions():
    synth = make_chatterbox("turbo")
    synth.synthesize("Ha! [laugh] Yes.", "ref", 1.0)
    decoder_feed = synth._sessions["conditional_decoder"].calls[0]
    silence = ChatterboxSynthesizer.SILENCE
    assert decoder_feed["speech_tokens"].tolist() == [[1, 2, 7, 8, 9, silence, silence, silence]]
    assert "exaggeration" not in synth._sessions["embed_tokens"].calls[0]
    lm_calls = synth._sessions["language_model"].calls
    assert lm_calls[0]["position_ids"].tolist() == [[0, 1, 2, 3, 4]]
    assert lm_calls[1]["position_ids"].tolist() == [[5]]


def test_strip_tags_for_engines_that_would_read_them():
    assert strip_tags("Oh, brilliant! [laugh] Let's go. [sigh]") == "Oh, brilliant! Let's go."
    assert strip_tags("Item [1] stays") == "Item [1] stays"


class RecordingSynth:
    def __init__(self, voices, fail=False):
        self.voices = list(voices)
        self.fail = fail
        self.calls = []
        self.description = {"engine": "recording"}

    def load(self):
        if self.fail:
            raise RuntimeError("no model")

    def scan_voices(self):
        return self.voices

    def synthesize(self, text, voice, speed, exaggeration=None):
        self.calls.append((voice, exaggeration))
        return np.zeros(2400, np.float32), 24000


def test_router_sends_presets_to_kokoro_and_references_to_chatterbox():
    chatterbox, kokoro = RecordingSynth(["isabella"]), RecordingSynth(["bf_lily", "bf_emma"])
    router = RoutingSynthesizer(chatterbox, kokoro, fallback_voice="bf_lily")
    router.load()
    assert router.voices == ["bf_emma", "bf_lily", "isabella"]
    assert router.description["engine"] == "chatterbox"
    router.synthesize("Hi.", "isabella", 1.0, 0.8)
    router.synthesize("Hi.", "bf_emma", 1.0)
    assert chatterbox.calls == [("isabella", 0.8)]
    assert kokoro.calls == [("bf_emma", None)]


def test_router_falls_back_to_kokoro_when_chatterbox_fails():
    chatterbox, kokoro = RecordingSynth(["isabella"], fail=True), RecordingSynth(["bf_lily"])
    router = RoutingSynthesizer(chatterbox, kokoro, fallback_voice="bf_lily")
    router.load()
    assert "no model" in router.description["chatterbox_error"]
    router.synthesize("Hi.", "isabella", 1.0)
    assert chatterbox.calls == []
    assert kokoro.calls == [("bf_lily", None)]


def test_tts_passes_exaggeration_through():
    synth = RecordingSynth(["isabella"])
    app = create_app(RecordingSynth([]), synth, "isabella", load_in_background=False)
    with TestClient(app) as client:
        assert client.post("/v1/tts", json={"text": "Wonderful!", "exaggeration": 0.8}).status_code == 200
        assert client.post("/v1/tts", json={"text": "Hi", "exaggeration": 5}).status_code == 400
    assert synth.calls == [("isabella", 0.8)]
