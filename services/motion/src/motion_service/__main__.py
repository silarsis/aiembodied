"""python -m motion_service --backend ardy|kimodo [--host 127.0.0.1] [--port 8190] ..."""

from __future__ import annotations

import argparse
import logging
import os

from .backends import BackendOptions, make_backend


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="motion_service", description=__doc__)
    ap.add_argument("--backend", choices=["ardy", "kimodo", "fake"], required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8190)
    ap.add_argument("--model", default=None, help="model name (default: ARDY-SOMA-RP-30FPS-Horizon60 / Kimodo-SOMA-RP-v1.2)")
    ap.add_argument("--device", default=None, help="torch device for the motion model (default: cuda:0 if available)")
    ap.add_argument("--text-encoder-device", choices=["gpu", "cpu"],
                    default=os.environ.get("MOTION_TEXT_ENCODER_DEVICE", "gpu"),
                    help="cpu saves ~15 GB of GPU memory at ~0.5 s extra per prompt")
    ap.add_argument("--text-encoders-dir", default=os.environ.get("TEXT_ENCODERS_DIR"),
                    help="LLM2Vec encoder folder (TEXT_ENCODERS_DIR); default: Hugging Face cache (gated Llama)")
    ap.add_argument("--no-postprocess", action="store_true", help="Kimodo: skip foot-skate cleanup")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--log-level", default="info")
    a = ap.parse_args(argv)

    logging.basicConfig(level=a.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    options = BackendOptions(model=a.model, device=a.device, text_encoder_device=a.text_encoder_device,
                             text_encoders_dir=a.text_encoders_dir, postprocess=not a.no_postprocess, seed=a.seed)
    backend = make_backend(a.backend, options)

    import uvicorn

    from .app import create_app

    uvicorn.run(create_app(backend), host=a.host, port=a.port, log_level=a.log_level.lower())


if __name__ == "__main__":
    main()
