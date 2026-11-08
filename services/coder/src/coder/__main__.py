"""python -m coder [--host 127.0.0.1] [--port 8195]  (settings come from CODER_* environment variables)"""

from __future__ import annotations

import argparse
import logging

from .config import Config


def main(argv=None) -> None:
    cfg = Config.from_env()
    ap = argparse.ArgumentParser(prog="coder", description=__doc__)
    ap.add_argument("--host", default=cfg.host)
    ap.add_argument("--port", type=int, default=cfg.port)
    ap.add_argument("--log-level", default="info")
    a = ap.parse_args(argv)
    cfg.host, cfg.port = a.host, a.port
    logging.basicConfig(level=a.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    import uvicorn

    from .app import create_app

    if cfg.host not in ("127.0.0.1", "localhost", "::1"):
        logging.getLogger("coder").warning(
            "Listening on %s: anyone who can reach this port can run code on this machine.", cfg.host)
    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port, log_level=a.log_level.lower())


if __name__ == "__main__":
    main()
