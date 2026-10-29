"""python -m speech_service [--host 127.0.0.1] [--port 8192] [--stt server|whisper] [--tts kokoro|chatterbox] ..."""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

DEFAULT_VOICES_DIR = Path(__file__).resolve().parents[2] / "voices"


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="speech_service", description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8192)
    ap.add_argument("--engines", choices=["real", "fake"], default="real",
                    help="fake: no models; a canned transcript and a tone, for wiring up the app")
    ap.add_argument("--stt", choices=["server", "whisper"], default=os.environ.get("STT_ENGINE", "server"),
                    help="server: an OpenAI-compatible endpoint taking input_audio (default: Qwen3-ASR on "
                         "llama-server, scripts/start-local-asr.ps1); whisper: faster-whisper in this process")
    ap.add_argument("--stt-url", default=os.environ.get("STT_URL", "http://127.0.0.1:1235/v1"),
                    help="base URL of the STT server (independent of the LLM's)")
    ap.add_argument("--stt-model", default=os.environ.get("STT_MODEL", "qwen3-asr"),
                    help="model name sent to the STT server")
    ap.add_argument("--whisper-model", default=os.environ.get("WHISPER_MODEL", "small.en"),
                    help="faster-whisper model name or path (large-v3-turbo is more accurate, ~4x slower on CPU)")
    ap.add_argument("--whisper-device", default=os.environ.get("WHISPER_DEVICE", "auto"))
    ap.add_argument("--whisper-compute-type", default=os.environ.get("WHISPER_COMPUTE_TYPE", "default"))
    ap.add_argument("--language", default="en", help="spoken language code, or 'auto' to detect")
    ap.add_argument("--kokoro-model", default=os.environ.get("KOKORO_MODEL"), help="path to kokoro-v1.0.onnx")
    ap.add_argument("--kokoro-voices", default=os.environ.get("KOKORO_VOICES"), help="path to voices-v1.0.bin")
    ap.add_argument("--voice", default=os.environ.get("KOKORO_VOICE", "bf_lily"), help="default Kokoro voice")
    ap.add_argument("--style-row", type=int, default=int(os.environ.get("KOKORO_STYLE_ROW", "120")),
                    help="Kokoro style row used for every sentence, so the voice stays consistent "
                         "(-1: let kokoro-onnx pick by text length)")
    ap.add_argument("--tts", choices=["kokoro", "chatterbox"], default=os.environ.get("TTS_ENGINE", "kokoro"),
                    help="chatterbox: an expressive voice cloned from a reference clip, with Kokoro "
                         "still serving its presets and standing in if Chatterbox fails to load")
    ap.add_argument("--chatterbox-model", default=os.environ.get("CHATTERBOX_MODEL", "onnx-community/chatterbox-ONNX"),
                    help="Hugging Face repo or local folder: onnx-community/chatterbox-ONNX (emotion dial) "
                         "or ResembleAI/chatterbox-turbo-ONNX (faster, [laugh]/[sigh] tags)")
    ap.add_argument("--chatterbox-voices", default=os.environ.get("CHATTERBOX_VOICES", str(DEFAULT_VOICES_DIR)),
                    help="folder of reference WAV clips; each file is a voice named by its stem")
    ap.add_argument("--chatterbox-voice", default=os.environ.get("CHATTERBOX_VOICE", "isabella"),
                    help="default Chatterbox voice (a file stem in --chatterbox-voices)")
    ap.add_argument("--chatterbox-dtype", default=os.environ.get("CHATTERBOX_DTYPE", "fp32"),
                    choices=["fp32", "fp16", "q8", "q4", "q4f16"])
    ap.add_argument("--chatterbox-providers", default=os.environ.get("CHATTERBOX_PROVIDERS", "cpu"),
                    help="ONNX Runtime providers in order: cpu, dml (DirectML, needs onnxruntime-directml)")
    ap.add_argument("--chatterbox-threads", type=int, default=int(os.environ.get("CHATTERBOX_THREADS", "0")))
    ap.add_argument("--exaggeration", type=float, default=float(os.environ.get("CHATTERBOX_EXAGGERATION", "0.6")),
                    help="default Chatterbox emotion dial: 0.5 neutral, 0.7+ animated")
    ap.add_argument("--log-level", default="info")
    a = ap.parse_args(argv)

    logging.basicConfig(level=a.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    from .engines import (ChatAudioTranscriber, ChatterboxSynthesizer, FakeSynthesizer, FakeTranscriber,
                          KokoroSynthesizer, RoutingSynthesizer, WhisperTranscriber)

    if a.engines == "fake":
        transcriber, synthesizer, voice = FakeTranscriber(), FakeSynthesizer(), "fake_voice"
    else:
        if not a.kokoro_model or not a.kokoro_voices:
            ap.error("--kokoro-model and --kokoro-voices (or KOKORO_MODEL / KOKORO_VOICES) are required")
        if a.stt == "server":
            transcriber = ChatAudioTranscriber(a.stt_url, a.stt_model)
        else:
            transcriber = WhisperTranscriber(a.whisper_model, a.whisper_device, a.whisper_compute_type)
        synthesizer = KokoroSynthesizer(a.kokoro_model, a.kokoro_voices,
                                        style_row=None if a.style_row < 0 else a.style_row)
        voice = a.voice
        if a.tts == "chatterbox":
            chatterbox = ChatterboxSynthesizer(
                a.chatterbox_model, a.chatterbox_voices, dtype=a.chatterbox_dtype, exaggeration=a.exaggeration,
                providers=a.chatterbox_providers, threads=a.chatterbox_threads)
            synthesizer = RoutingSynthesizer(chatterbox, synthesizer, fallback_voice=a.voice)
            voice = a.chatterbox_voice

    import uvicorn

    from .app import create_app

    language = None if a.language == "auto" else a.language
    uvicorn.run(create_app(transcriber, synthesizer, voice, language), host=a.host, port=a.port,
                log_level=a.log_level.lower())


if __name__ == "__main__":
    main()
