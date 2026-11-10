"""`python -m switchboard send "text"`: put one message in an avatar's inbox, for trying the bus by hand."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from typing import Any, Optional


def build_event(text: str, *, to: str, source: str, urgent: bool, type_: str, producer: str) -> dict[str, Any]:
    kind, _, ident = producer.partition(":")
    return {
        "type": type_,
        "producer": {"kind": kind or "person", "id": ident or kind or "cli"},
        "to": [to],
        "priority": "urgent" if urgent else "normal",
        "payload": {"text": text, "source": source},
    }


def run(url: str, text: str, *, to: str, source: str, urgent: bool, type_: str, producer: str,
        out: Optional[Any] = None) -> int:
    out = out or sys.stdout
    body = json.dumps({"events": [build_event(text, to=to, source=source, urgent=urgent, type_=type_, producer=producer)]})
    request = urllib.request.Request(url.rstrip("/") + "/v1/events", data=body.encode(),
                                     headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            ids = json.load(response).get("ids", [])
    except urllib.error.HTTPError as error:
        print(f"The switchboard refused it: HTTP {error.code} {error.read().decode(errors='replace')[:300]}", file=out)
        return 1
    except OSError as error:
        print(f"Could not reach the switchboard at {url}: {error}", file=out)
        return 1
    print(f"Sent {ids[0] if ids else 'it'} to {to} ({type_}, {'urgent' if urgent else 'normal'}).", file=out)
    return 0
