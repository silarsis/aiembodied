"""Text embeddings for semantic search.

The default is BAAI/bge-small-en-v1.5 through fastembed on the CPU: 384 dimensions, about
130 MB, a few milliseconds a sentence. The model name is stored with every vector, and only
vectors from the configured model are searched, so a model change never mixes spaces (the
backlog is simply re-embedded). The schema's column is vector(384); a model of another size
needs a migration.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import threading
import time
from typing import Optional, Protocol, Sequence

DIMENSION = 384


class Embedder(Protocol):
    name: str
    dimension: int

    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


class FastEmbedEmbedder:
    """A local ONNX model on the CPU. Loaded on first use (downloading it once, about 130 MB).
    After a failed load it waits RETRY_SECONDS before trying again, so a missing model costs
    searches nothing: they fall back to full text straight away."""

    RETRY_SECONDS = 300.0

    def __init__(self, model: str = "BAAI/bge-small-en-v1.5", cache_dir: Optional[str] = None):
        self.name = model
        self.dimension = DIMENSION
        self._cache_dir = cache_dir or default_cache_dir()
        self._model = None
        self._failed_at: Optional[float] = None
        self._failure: Optional[str] = None
        self._lock = threading.Lock()

    def _load(self):
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is not None:
                return self._model
            if self._failed_at is not None and time.monotonic() - self._failed_at < self.RETRY_SECONDS:
                raise RuntimeError(f"embedding model unavailable: {self._failure}")
            try:
                from fastembed import TextEmbedding

                model = TextEmbedding(model_name=self.name, cache_dir=self._cache_dir)
                size = getattr(model, "embedding_size", DIMENSION)
                if size != DIMENSION:
                    raise ValueError(f"{self.name} makes {size}-dimension vectors; the schema holds {DIMENSION}")
            except Exception as error:
                self._failed_at = time.monotonic()
                self._failure = str(error).strip().splitlines()[0] if str(error).strip() else type(error).__name__
                raise
            self._model = model
            self._failed_at = None
            return model

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        model = self._load()
        return [[float(x) for x in vector] for vector in model.embed(list(texts), batch_size=64)]


def default_cache_dir() -> str:
    """MEMORY_EMBED_CACHE, else a folder that survives reboots (fastembed's default is in temp)."""
    configured = os.environ.get("MEMORY_EMBED_CACHE")
    if configured:
        return configured
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "aiembodied", "memory", "models")


class FakeEmbedder:
    """Deterministic bag of hashed words, for tests and for wiring without a model. Texts that
    share words come out similar, which is enough to exercise hybrid ranking."""

    name = "fake-hash-384"
    dimension = DIMENSION

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._one(text) for text in texts]

    def _one(self, text: str) -> list[float]:
        vector = [0.0] * DIMENSION
        for word in re.findall(r"[a-z0-9]+", text.lower()):
            digest = hashlib.sha256(word.encode()).digest()
            index = int.from_bytes(digest[:4], "little") % DIMENSION
            vector[index] += 1.0 if digest[4] % 2 == 0 else -1.0
        norm = math.sqrt(sum(x * x for x in vector)) or 1.0
        return [x / norm for x in vector]


def make_embedder(kind: str, model: Optional[str] = None) -> Optional[Embedder]:
    """kind: fastembed (default), fake, or off (full-text search only)."""
    if kind == "off":
        return None
    if kind == "fake":
        return FakeEmbedder()
    if kind == "fastembed":
        return FastEmbedEmbedder(model or "BAAI/bge-small-en-v1.5")
    raise ValueError(f"unknown embedder {kind!r}")


def to_pgvector(vector: Sequence[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in vector) + "]"
