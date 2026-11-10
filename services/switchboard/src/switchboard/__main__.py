"""python -m switchboard [serve] [--host 127.0.0.1] [--port 8196]   |   python -m switchboard tail   |   python -m switchboard send "text"  (settings come from SWITCHBOARD_* environment variables)"""

from __future__ import annotations

import argparse
import logging

from .models import Config

DEFAULT_PORT = 8196


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="switchboard", description=__doc__)
    sub = ap.add_subparsers(dest="cmd")
    serve = sub.add_parser("serve", help="run the service (the default)")
    tail = sub.add_parser("tail", help="print events from a running switchboard")
    send = sub.add_parser("send", help="put a message in an avatar's inbox (to try the bus by hand)")
    for p in (ap, serve):
        p.add_argument("--host", default="127.0.0.1")
        p.add_argument("--port", type=int, default=DEFAULT_PORT)
        p.add_argument("--log-level", default="info")
    tail.add_argument("--url", default=f"ws://127.0.0.1:{DEFAULT_PORT}")
    tail.add_argument("--type", action="append", default=[], metavar="GLOB", help="only these types (repeatable)")
    tail.add_argument("--txn", help="only events of this transaction")
    tail.add_argument("--since", metavar="ID", help="replay events after this id first")
    send.add_argument("text", help="what the avatar is told")
    send.add_argument("--url", default=f"http://127.0.0.1:{DEFAULT_PORT}")
    send.add_argument("--to", default="avatar:echo")
    send.add_argument("--source", default="the command line", help="who the update is from, as the avatar hears it")
    send.add_argument("--urgent", action="store_true", help="speak at the next gap instead of when idle")
    send.add_argument("--type", dest="type_", default="avatar.inbox", help="event type, e.g. home.alert")
    send.add_argument("--from", dest="producer", default="person:cli")
    a = ap.parse_args(argv)

    if a.cmd == "send":
        from .send import run as send_run

        return send_run(a.url, a.text, to=a.to, source=a.source, urgent=a.urgent, type_=a.type_, producer=a.producer)

    if a.cmd == "tail":
        from .tail import run

        return run(a.url, a.type, a.txn, a.since)

    logging.basicConfig(level=a.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    import uvicorn

    from .app import create_app

    if a.host not in ("127.0.0.1", "localhost", "::1"):
        logging.getLogger("switchboard").warning(
            "Listening on %s: anyone who can reach this port can read and publish every event.", a.host)
    uvicorn.run(create_app(Config.from_env()), host=a.host, port=a.port, log_level=a.log_level.lower())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
