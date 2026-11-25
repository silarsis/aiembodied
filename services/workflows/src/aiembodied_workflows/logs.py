"""Logging: one readable line for everything that happens.

    2026-11-26 01:23:45.678 INFO  life:echo        decision: SAY "Morning!" (think 4.2 s)

The middle column is the workflow id when the line is about a workflow (set with `extra={"wfid": ...}`),
else the short logger name. Lines go to stdout and to a rotating file.
"""

from __future__ import annotations

import logging
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

ID_WIDTH = 22
ROOT_NAME = "aiembodied"
_NOISY = ("httpx", "httpcore", "websockets", "uvicorn.access")


class LineFormatter(logging.Formatter):
    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:  # noqa: N802
        return f"{time.strftime('%Y-%m-%d %H:%M:%S', self.converter(record.created))}.{int(record.msecs):03d}"

    def format(self, record: logging.LogRecord) -> str:
        who = getattr(record, "wfid", None)
        if not who:
            name = record.name
            who = name[len(ROOT_NAME) + 1 :] if name.startswith(ROOT_NAME + ".") else name.rsplit(".", 1)[-1]
        text = record.getMessage()
        if record.exc_info and not record.exc_text:
            record.exc_text = self.formatException(record.exc_info)
        if record.exc_text:
            text = f"{text}\n{record.exc_text}"
        return f"{self.formatTime(record)} {record.levelname:<5} {who:<{ID_WIDTH}} {text}"


def setup_logging(level: str = "INFO", log_file: str | None = None, stream=None) -> list[logging.Handler]:
    """Install the handlers on the root logger. Safe to call more than once (it replaces its own handlers)."""
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, "_aiembodied", False):
            root.removeHandler(h)
    handlers: list[logging.Handler] = []
    console = logging.StreamHandler(stream or sys.stdout)
    handlers.append(console)
    if log_file:
        try:
            path = Path(log_file)
            path.parent.mkdir(parents=True, exist_ok=True)
            handlers.append(RotatingFileHandler(path, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8"))
        except OSError as exc:
            print(f"Could not open the log file {log_file}: {exc}", file=sys.stderr)
    fmt = LineFormatter()
    for h in handlers:
        h.setFormatter(fmt)
        h._aiembodied = True  # type: ignore[attr-defined]
        root.addHandler(h)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    for name in _NOISY:
        logging.getLogger(name).setLevel(logging.WARNING)
    # Our own uvicorn lines go through the same handlers.
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
    return handlers


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"{ROOT_NAME}.{name}")
