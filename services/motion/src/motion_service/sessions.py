"""In-memory store of finished streams, so a later request can `continue_from` one of them."""

from __future__ import annotations

import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable, Optional

from .backends.base import StreamHistory
from .retarget import RootFrame


@dataclass
class Session:
    history: StreamHistory
    root_frame: RootFrame  # the first stream's, shared by every continuation so the hips track keeps its origin
    carry: tuple[float, float] = (0.0, 0.0)  # root snap offset (model units) at the end of the stream
    id: str = ""
    stored_at: float = field(default=0.0, repr=False)


class SessionStore:
    """Keeps the last `max_entries` sessions for `ttl_s` seconds after they were stored."""

    def __init__(self, max_entries: int = 8, ttl_s: float = 600.0, clock: Callable[[], float] = time.monotonic):
        self.max_entries = max_entries
        self.ttl_s = ttl_s
        self.clock = clock
        self._items: "OrderedDict[str, Session]" = OrderedDict()
        self._lock = threading.Lock()

    def _expire(self) -> None:
        now = self.clock()
        for sid in [k for k, v in self._items.items() if now - v.stored_at > self.ttl_s]:
            del self._items[sid]

    def put(self, session: Session) -> str:
        with self._lock:
            self._expire()
            sid = "s-" + secrets.token_hex(3)
            while sid in self._items:
                sid = "s-" + secrets.token_hex(3)
            session.id, session.stored_at = sid, self.clock()
            self._items[sid] = session
            while len(self._items) > self.max_entries:
                self._items.popitem(last=False)
            return sid

    def get(self, sid: str) -> Optional[Session]:
        with self._lock:
            self._expire()
            return self._items.get(sid)

    def __len__(self) -> int:
        with self._lock:
            self._expire()
            return len(self._items)
