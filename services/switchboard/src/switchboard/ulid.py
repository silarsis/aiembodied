"""ULIDs: 48-bit millisecond time + 80 random bits, 26 characters of Crockford base32. Sortable by creation time."""

from __future__ import annotations

import os
import threading
import time
from typing import Optional

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

_lock = threading.Lock()
_last = (0, 0)  # (ms, random) of the previous id, so ids made in the same millisecond still increase


def encode(ms: int, rand: int) -> str:
    n = (ms << 80) | rand
    return "".join(ALPHABET[(n >> shift) & 31] for shift in range(125, -1, -5))


def new_ulid(ms: Optional[int] = None) -> str:
    global _last
    ms = int(time.time() * 1000) if ms is None else ms
    with _lock:
        last_ms, last_rand = _last
        if ms <= last_ms:
            ms, rand = last_ms, (last_rand + 1) & ((1 << 80) - 1)
        else:
            rand = int.from_bytes(os.urandom(10), "big")
        _last = (ms, rand)
    return encode(ms, rand)
