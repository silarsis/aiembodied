"""A pi process speaking the RPC protocol: JSON lines on stdin and stdout."""

from __future__ import annotations

import json
import subprocess
import threading
from pathlib import Path
from typing import Callable, Mapping, Optional

from .procs import kill_tree, popen_flags


class PiProcess:
    def __init__(self, argv: list[str], cwd: Path, env: Mapping[str, str],
                 on_event: Callable[[dict], None], on_log: Callable[[str, str], None],
                 on_exit: Optional[Callable[[int], None]] = None):
        self.argv, self.cwd, self.env = argv, cwd, dict(env)
        self.on_event, self.on_log, self.on_exit = on_event, on_log, on_exit
        self.proc: Optional[subprocess.Popen] = None
        self._wlock = threading.Lock()
        self.exited = threading.Event()

    def start(self) -> None:
        self.proc = subprocess.Popen(
            self.argv, cwd=str(self.cwd), env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, **popen_flags())
        t1 = threading.Thread(target=self._read, args=(self.proc.stdout, "stdout"), daemon=True)
        t2 = threading.Thread(target=self._read, args=(self.proc.stderr, "stderr"), daemon=True)
        t1.start(); t2.start()
        threading.Thread(target=self._watch, args=(t1, t2), daemon=True).start()

    def _read(self, stream, name: str) -> None:
        for raw in iter(stream.readline, b""):
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            if name == "stdout":
                try:
                    obj = json.loads(line)
                except ValueError:
                    obj = None
                if isinstance(obj, dict):
                    try:
                        self.on_event(obj)
                    except Exception as e:  # never let a handler bug stop the reader
                        self.on_log("runner", f"event handler error: {e}")
                    continue
            self.on_log(name, line)

    def _watch(self, *readers: threading.Thread) -> None:
        assert self.proc
        code = self.proc.wait()
        for r in readers:
            r.join(timeout=2)
        self.exited.set()
        if self.on_exit:
            try:
                self.on_exit(code)
            except Exception:
                pass

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def send(self, obj: dict) -> bool:
        if not self.alive or not self.proc or not self.proc.stdin:
            return False
        data = (json.dumps(obj) + "\n").encode("utf-8")
        with self._wlock:
            try:
                self.proc.stdin.write(data)
                self.proc.stdin.flush()
                return True
            except (OSError, ValueError):
                return False

    def stop(self, grace: float = 2.0) -> None:
        """Close stdin, wait a little, then kill the process tree."""
        if not self.proc:
            return
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            pass
        kill_tree(self.proc)

    def kill(self) -> None:
        if self.proc:
            kill_tree(self.proc)
