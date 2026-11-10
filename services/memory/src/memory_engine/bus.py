"""A tiny fire-and-forget publisher to the switchboard (POST /v1/events).

`publish(event)` never blocks and never raises: events go into a bounded queue (the oldest is
dropped when it is full) and a background thread posts them in batches every ~250 ms. A failure
is logged once per outage. SWITCHBOARD_URL (default http://127.0.0.1:8196) says where the
switchboard is; SWITCHBOARD_ENABLED=0 turns publishing off.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections import deque
from typing import Any, Mapping, Optional
from urllib import request

log = logging.getLogger("memory_engine.bus")

DEFAULT_URL = "http://127.0.0.1:8196"
QUEUE_SIZE = 500
BATCH_SECONDS = 0.25
TIMEOUT = 3.0


class Publisher:
    def __init__(self, url: str = DEFAULT_URL, enabled: bool = True):
        self.url = url.rstrip("/")
        self.enabled = enabled
        self._queue: deque[dict[str, Any]] = deque(maxlen=QUEUE_SIZE)
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._down = False

    @classmethod
    def from_env(cls, environ: Mapping[str, str] = os.environ) -> "Publisher":
        enabled = (environ.get("SWITCHBOARD_ENABLED") or "1").strip().lower() not in ("0", "false", "no", "off")
        return cls(environ.get("SWITCHBOARD_URL") or DEFAULT_URL, enabled)

    def publish(self, event: dict[str, Any]) -> None:
        if not self.enabled:
            return
        try:
            with self._lock:
                self._queue.append(event)  # a full deque drops its oldest
                if self._thread is None:
                    self._thread = threading.Thread(target=self._run, name="switchboard-bus", daemon=True)
                    self._thread.start()
            self._wake.set()
        except Exception:  # noqa: BLE001 - publishing must never reach the caller
            pass

    def _run(self) -> None:
        while True:
            self._wake.wait()
            self._wake.clear()
            threading.Event().wait(BATCH_SECONDS)  # let a burst gather into one batch
            with self._lock:
                batch = list(self._queue)
                self._queue.clear()
            if batch:
                self._post(batch)

    def _post(self, batch: list[dict[str, Any]]) -> None:
        try:
            body = json.dumps({"events": batch}).encode()
            req = request.Request(self.url + "/v1/events", data=body, headers={"Content-Type": "application/json"})
            with request.urlopen(req, timeout=TIMEOUT):
                pass
            if self._down:
                log.info("The switchboard is reachable again")
            self._down = False
        except Exception as error:  # noqa: BLE001
            if not self._down:
                log.warning("Could not publish to the switchboard at %s: %s", self.url, str(error).splitlines()[0] if str(error) else type(error).__name__)
            self._down = True


_default: Optional[Publisher] = None


def default() -> Publisher:
    global _default
    if _default is None:
        _default = Publisher.from_env()
    return _default


def set_default(publisher: Optional[Publisher]) -> None:
    """Replace the shared publisher (tests); None makes the next call read the environment again."""
    global _default
    _default = publisher


def publish(event: dict[str, Any]) -> None:
    try:
        default().publish(event)
    except Exception:  # noqa: BLE001
        pass
