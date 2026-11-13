"""`python -m switchboard tail`: print events as they happen, one line each."""

from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from fnmatch import fnmatchcase
from typing import Any, Iterator, Optional

from .ulid import new_ulid

POLL_S = 1.0


def format_event(ev: dict[str, Any], width: int = 100) -> str:
    p = ev["producer"]
    to = ",".join(ev.get("to") or []) or "-"
    txn = f" [{ev['txn']['id']}{' ' + ev['txn']['state'] if ev['txn'].get('state') else ''}]" if ev.get("txn") else ""
    payload = json.dumps(ev.get("payload") or {}, ensure_ascii=False, separators=(",", ":"))
    if len(payload) > width:
        payload = payload[:width - 1] + "…"
    return f"{ev['at'][11:23]} {ev['type']} {p['kind']}:{p['id']} -> {to}{txn} {payload}"


def _stream(base: str, types: list[str], since: Optional[str]) -> Iterator[dict[str, Any]]:
    from websockets.sync.client import connect

    with connect(base.replace("http", "ws", 1) + "/v1/stream") as ws:
        ws.send(json.dumps({"op": "hello", "actor": None, "since": since,
                            "subscribe": {"types": types or ["*"], "observe": True}}))
        while True:
            msg = json.loads(ws.recv())
            if msg["op"] == "event":
                yield msg["event"]


def _poll(base: str, txn: Optional[str], since: Optional[str]) -> Iterator[dict[str, Any]]:
    # Without --since start from now: a ULID made now sorts after everything already journaled.
    cursor = since or new_ulid()
    while True:
        query = urllib.parse.urlencode({k: v for k, v in (("since", cursor), ("txn", txn), ("limit", 1000)) if v})
        with urllib.request.urlopen(f"{base}/v1/events?{query}", timeout=10) as r:
            found = json.load(r)["events"]
        yield from found
        if found:
            cursor = found[-1]["id"]
        else:
            time.sleep(POLL_S)


def run(url: str, types: list[str], txn: Optional[str], since: Optional[str]) -> int:
    base = url.rstrip("/").replace("ws", "http", 1) if url.startswith("ws") else url.rstrip("/")
    closed: tuple[type[BaseException], ...] = ()
    try:
        from websockets.exceptions import ConnectionClosed
        closed = (ConnectionClosed,)
        source = _stream(base, types, since)
    except ImportError:
        print("websockets is not installed; polling every second instead", file=sys.stderr)
        source = _poll(base, txn, since)
    try:
        for ev in source:
            if txn and (ev.get("txn") or {}).get("id") != txn:
                continue
            if types and not any(fnmatchcase(ev["type"], g) for g in types):
                continue
            print(format_event(ev), flush=True)
    except KeyboardInterrupt:
        return 0
    except closed:
        # The switchboard went away (usually because the app quit): not an error for a tail.
        print("switchboard closed", file=sys.stderr)
        return 0
    except OSError as e:
        print(f"lost the switchboard at {base}: {e}", file=sys.stderr)
        return 1
    return 0
