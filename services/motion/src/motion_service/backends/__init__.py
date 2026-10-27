from .base import Backend, BackendOptions, Chunk, Motion


def make_backend(name: str, options: BackendOptions) -> Backend:
    if name == "ardy":
        from .ardy_backend import ArdyBackend

        return ArdyBackend(options)
    if name == "kimodo":
        from .kimodo_backend import KimodoBackend

        return KimodoBackend(options)
    if name == "fake":
        from .fake import FakeBackend

        return FakeBackend(options)
    raise ValueError(f"unknown backend {name!r} (expected ardy, kimodo or fake)")


__all__ = ["Backend", "BackendOptions", "Chunk", "Motion", "make_backend"]
