from .base import SpeechToText, Synthesis, TextToSpeech, Transcript


def make_backends(name: str, **options) -> tuple[SpeechToText, TextToSpeech]:
    if name == "local":
        from .local import KokoroTTS, WhisperSTT

        return (
            WhisperSTT(options.get("stt_model", "small.en"), options.get("stt_device", "cpu"),
                       options.get("stt_compute_type", "int8"), options.get("language", "en")),
            KokoroTTS(options["kokoro_model"], options["kokoro_voices"], options.get("voice", "af_heart")),
        )
    if name == "fake":
        from .fake import FakeSTT, FakeTTS

        return FakeSTT(), FakeTTS()
    raise ValueError(f"unknown backend {name!r} (expected local or fake)")


__all__ = ["SpeechToText", "Synthesis", "TextToSpeech", "Transcript", "make_backends"]
