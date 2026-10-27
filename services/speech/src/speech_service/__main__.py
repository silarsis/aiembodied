"""python -m speech_service [--host 127.0.0.1] [--port 8192] [--whisper-model small.en] ..."""

from __future__ import annotations

import argparse
import logging
import os


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="speech_service", description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8192)
    ap.add_argument("--engines", choices=["real", "fake"], default="real",
                    help="fake: no models; a canned transcript and a tone, for wiring up the app")
    ap.add_argument("--whisper-model", default=os.environ.get("WHISPER_MODEL", "small.en"),
                    help="faster-whisper model name or path (large-v3-turbo is more accurate, ~4x slower on CPU)")
    ap.add_argument("--whisper-device", default=os.environ.get("WHISPER_DEVICE", "auto"))
    ap.add_argument("--whisper-compute-type", default=os.environ.get("WHISPER_COMPUTE_TYPE", "default"))
    ap.add_argument("--language", default="en", help="spoken language code, or 'auto' to detect")
    ap.add_argument("--kokoro-model", default=os.environ.get("KOKORO_MODEL"), help="path to kokoro-v1.0.onnx")
    ap.add_argument("--kokoro-voices", default=os.environ.get("KOKORO_VOICES"), help="path to voices-v1.0.bin")
    ap.add_argument("--voice", default=os.environ.get("KOKORO_VOICE", "bm_george"), help="default Kokoro voice")
    ap.add_argument("--log-level", default="info")
    a = ap.parse_args(argv)

    logging.basicConfig(level=a.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    from .engines import FakeSynthesizer, FakeTranscriber, KokoroSynthesizer, WhisperTranscriber

    if a.engines == "fake":
        transcriber, synthesizer, voice = FakeTranscriber(), FakeSynthesizer(), "fake_voice"
    else:
        if not a.kokoro_model or not a.kokoro_voices:
            ap.error("--kokoro-model and --kokoro-voices (or KOKORO_MODEL / KOKORO_VOICES) are required")
        transcriber = WhisperTranscriber(a.whisper_model, a.whisper_device, a.whisper_compute_type)
        synthesizer = KokoroSynthesizer(a.kokoro_model, a.kokoro_voices)
        voice = a.voice

    import uvicorn

    from .app import create_app

    language = None if a.language == "auto" else a.language
    uvicorn.run(create_app(transcriber, synthesizer, voice, language), host=a.host, port=a.port,
                log_level=a.log_level.lower())


if __name__ == "__main__":
    main()
