"""python -m aiembodied_workflows [serve] [--host 127.0.0.1] [--port 8198]  (settings come from environment variables)"""

from __future__ import annotations

import argparse
import logging

from .logs import setup_logging
from .settings import Settings


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="aiembodied_workflows", description=__doc__)
    sub = ap.add_subparsers(dest="cmd")
    serve = sub.add_parser("serve", help="run the service (the default)")
    env = Settings.from_env()
    for p in (ap, serve):
        p.add_argument("--host", default=env.host)
        p.add_argument("--port", type=int, default=env.port)
    a = ap.parse_args(argv)

    settings = Settings.from_env()
    setup_logging(settings.log_level, settings.log_file)
    log = logging.getLogger("aiembodied.main")

    import uvicorn

    from .api import create_app

    if a.host not in ("127.0.0.1", "localhost", "::1"):
        log.warning("Listening on %s: anyone who can reach this port can start and stop workflows.", a.host)
    log.info(
        "workflows service starting on http://%s:%s (Temporal %s, namespace %s, agent life %s)",
        a.host,
        a.port,
        settings.temporal_address,
        settings.namespace,
        "on" if settings.agent_life else "off",
    )
    uvicorn.run(create_app(settings), host=a.host, port=a.port, log_config=None, log_level=settings.log_level.lower())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
