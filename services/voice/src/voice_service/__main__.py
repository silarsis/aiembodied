"""python -m voice_service --backend local|fake [--host 127.0.0.1] [--port 8191] ..."""

from __future__ import annotations

import argparse
import logging
import os

from .backends import make_backends


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="voice_service", description=__doc__)
    ap.add_argument("--backend", choices=["local", "fake"], default="local")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8191)
    ap.add_argument("--stt-model", default=os.environ.get("STT_MODEL", "small.en"),
                    help="faster-whisper model name or path (tiny.en, base.en, small.en, distil-large-v3, ...)")
    ap.add_argument("--stt-device", default="cpu", help="cpu (CTranslate2 has no ROCm build)")
    ap.add_argument("--stt-compute-type", default="int8")
    ap.add_argument("--language", default="en", help="spoken language, or 'auto' to detect")
    ap.add_argument("--kokoro-model", default=os.environ.get("KOKORO_MODEL", "models/kokoro-v1.0.onnx"))
    ap.add_argument("--kokoro-voices", default=os.environ.get("KOKORO_VOICES", "models/voices-v1.0.bin"))
    ap.add_argument("--voice", default=os.environ.get("TTS_VOICE", "af_heart"), help="default Kokoro voice")
    ap.add_argument("--log-level", default="info")
    a = ap.parse_args(argv)

    logging.basicConfig(level=a.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    stt, tts = make_backends(
        a.backend, stt_model=a.stt_model, stt_device=a.stt_device, stt_compute_type=a.stt_compute_type,
        language=None if a.language == "auto" else a.language, kokoro_model=a.kokoro_model,
        kokoro_voices=a.kokoro_voices, voice=a.voice,
    )

    import uvicorn

    from .app import create_app

    uvicorn.run(create_app(stt, tts), host=a.host, port=a.port, log_level=a.log_level.lower())


if __name__ == "__main__":
    main()
