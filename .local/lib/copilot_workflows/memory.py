"""Durable cross-run memory (`wf.memory`): a text file shared across `cwf loop` ticks."""
from __future__ import annotations

import os
import threading
from collections.abc import Callable

from ._util import noop


class Memory:
    """A durable text file shared across runs and loop ticks; thread-safe, no-op when unset."""

    def __init__(self, path: str | None = None, *, read_only: bool = False,
                 logger: Callable[..., None] | None = None):
        self.path = os.path.abspath(os.path.expanduser(path)) if path else None
        self._read_only = read_only
        self._log = logger or noop
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        """True when a memory file is configured (``--memory PATH`` was passed)."""
        return self.path is not None

    def __bool__(self) -> bool:
        return self.enabled

    def read(self) -> str:
        """Return the file's full contents, or ``""`` if memory is unset or absent."""
        if not self.path:
            return ""
        with self._lock:
            try:
                with open(self.path, encoding="utf-8") as fh:
                    return fh.read()
            except FileNotFoundError:
                return ""
            except OSError as e:
                self._log(f"  ! memory read failed: {e}")
                return ""

    def write(self, text: str) -> None:
        """Overwrite memory with ``text``. No-op when unset or in dry-run."""
        self._put(str(text), append=False)

    def append(self, text: str) -> None:
        """Append ``text`` (newline-terminated) to memory. No-op when unset or in dry-run."""
        self._put(str(text), append=True)

    def clear(self) -> None:
        """Truncate memory to empty. No-op when unset or in dry-run."""
        self._put("", append=False)

    def _put(self, text: str, *, append: bool) -> None:
        if not self.path:
            return
        if self._read_only:
            verb = "append" if append else "write"
            self._log(f"  memory: [dry-run] skipped {verb} ({len(text)} chars)")
            return
        with self._lock:
            try:
                os.makedirs(os.path.dirname(self.path), exist_ok=True)
                with open(self.path, "a" if append else "w", encoding="utf-8") as fh:
                    fh.write(text)
                    if append and text and not text.endswith("\n"):
                        fh.write("\n")  # keep each note on its own line
                    fh.flush()
                    os.fsync(fh.fileno())  # durable across a tick crash, like checkpoints
            except OSError as e:
                self._log(f"  ! memory write failed: {e}")
