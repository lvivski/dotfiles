"""Live progress panel + progress.jsonl persistence/replay for cwf runs."""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import threading
import time
from collections import deque
from contextlib import suppress
from typing import TypedDict

_SPIN = "|/-\\"

# Control chars (C0/C7 incl. ESC/newline/CR) and the C1 range — any of these in a
# subagent-supplied field (label/model/error/phase) would corrupt the live panel:
# ANSI escapes move the cursor, and embedded newlines desync the repaint row count.
_CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _san(s) -> str:
    return _CTRL.sub(" ", str(s))


def _clip(s, n: int) -> str:
    s = _san(s)
    if n <= 0:
        return ""
    return s if len(s) <= n else s[: n - 1] + "\u2026"


class ProgressEvent(TypedDict, total=False):
    """Wire schema for one progress NDJSON record (consumed by ``cwf watch`` and the cwf
    extension). Heterogeneous by ``ev`` — run_start/start/end/run_end populate different
    subsets — so every key is optional. Mirror any change in ``Runtime._emit``/``_finish``.
    """

    ev: str
    seq: int
    label: str
    model: str | None
    phase: str | None
    ok: bool
    cached: bool
    skipped: bool
    nano_aiu: int
    tok: int
    error: str | None
    t: float
    run_id: str
    harness: str
    meta: dict
    agents: int
    launched: int
    cached: int
    skipped: int
    failed: int
    launched_nano_aiu: int
    elapsed: float


def format_agent_line(rec: ProgressEvent) -> str:
    """One tidy line for a finished-agent record. Shared by the reporter's line
    mode and the Runtime's no-reporter fallback (single source of truth)."""
    label = _clip(rec.get("label", "agent"), 24)
    aic = _aic(rec)
    if rec.get("cached"):
        return f"  HIT  {label:<24} {aic:.4f} AIC  (cached)"
    if rec.get("skipped"):
        return f"  SKIP {label:<24} ({_san(rec.get('error') or 'skipped')})"
    if rec.get("ok"):
        return f"  OK   {label:<24} {aic:.4f} AIC  {int(rec.get('tok') or 0)} tok  [{_san(rec.get('model') or '')}]"
    return f"  ERR  {label:<24} {aic:.4f} AIC  ERROR: {_san(rec.get('error') or '?')}"


def _aic(rec: ProgressEvent) -> float:
    return float(rec.get("nano_aiu") or 0) / 1_000_000_000


class ProgressReporter:
    def __init__(
        self,
        stream=None,
        jsonl_path: str | None = None,
        live: bool | None = None,
        title: str = "workflow",
        max_running: int = 8,
        max_recent: int = 5,
        write: bool = True,
    ):
        self.stream = stream or sys.stderr
        self.title = title
        self.max_running = max_running
        self.max_recent = max_recent
        try:
            tty = self.stream.isatty()
        except Exception:
            tty = False
        self.live = tty if live is None else live

        self._lock = threading.RLock()
        self._running: "dict[int, dict]" = {}
        self._recent: "deque[dict]" = deque(maxlen=max_recent)
        self._done = 0
        self._failed = 0
        self._cached = 0
        self._skipped = 0
        self._nano_aiu = 0
        self._tok = 0
        self._phase = None
        self._t0 = time.time()
        self._last_render = 0.0
        self._drawn = 0
        self._spin = 0
        self._closed = False

        self._fh = None
        if write and jsonl_path:
            try:
                directory = os.path.dirname(jsonl_path)
                if directory:
                    os.makedirs(directory, exist_ok=True)
                self._fh = open(jsonl_path, "a", encoding="utf-8")
            except Exception:
                self._fh = None

    # -- public ----------------------------------------------------------
    def __call__(self, rec: ProgressEvent) -> None:
        with self._lock:
            if self._fh is not None:
                with suppress(Exception):  # best-effort persist; must never crash the run
                    self._fh.write(json.dumps(rec) + "\n")
                    self._fh.flush()
            self._apply(rec)
            with suppress(Exception):  # best-effort display; rendering never crashes the run
                if self.live:
                    self._render(force=rec.get("ev") in ("end", "run_end"))
                elif rec.get("ev") == "end":
                    self.stream.write(self._fmt_line(rec) + "\n")
                    self.stream.flush()

    @property
    def stats(self) -> dict:
        with self._lock:
            return {
                "running": len(self._running), "done": self._done,
                "failed": self._failed, "cached": self._cached,
                "skipped": self._skipped, "nano_aiu": self._nano_aiu,
                "aic": self._nano_aiu / 1_000_000_000, "tok": self._tok,
            }

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self.live and self._drawn:
                with suppress(Exception):
                    self.stream.write("\n")
                    self.stream.flush()
            if self._fh is not None:
                with suppress(Exception):
                    self._fh.close()

    # -- state -----------------------------------------------------------
    def _apply(self, rec: ProgressEvent) -> None:
        ev = rec.get("ev")
        if ev == "start":
            self._running[rec.get("seq")] = rec
            if rec.get("phase"):
                self._phase = rec["phase"]
        elif ev == "end":
            self._running.pop(rec.get("seq"), None)
            self._nano_aiu += int(rec.get("nano_aiu") or 0)
            self._tok += int(rec.get("tok") or 0)
            if rec.get("skipped"):
                self._skipped += 1
            elif rec.get("cached"):
                self._cached += 1
            elif rec.get("ok"):
                self._done += 1
            else:
                self._failed += 1
            self._recent.append(rec)
            if rec.get("phase"):
                self._phase = rec["phase"]

    # -- rendering -------------------------------------------------------
    def _summary(self) -> str:
        el = int(time.time() - self._t0)
        parts = [self.title]
        if self._phase:
            parts.append(f"phase: {self._phase}")
        parts.append(f"{el}s")
        parts.append(f"run {len(self._running)}")
        parts.append(f"done {self._done}")
        if self._failed:
            parts.append(f"failed {self._failed}")
        if self._cached:
            parts.append(f"cached {self._cached}")
        if self._skipped:
            parts.append(f"skipped {self._skipped}")
        parts.append(f"{self._nano_aiu / 1_000_000_000:.1f} AIC")
        return " \u00b7 ".join(parts)

    def _fmt_done(self, r: ProgressEvent) -> str:
        label = _clip(r.get("label", "agent"), 22)
        if r.get("cached"):
            return f"\u21ba {label:<22} cached"
        if r.get("skipped"):
            return f"\u2014 {label:<22} skipped"
        if r.get("ok"):
            return f"\u2713 {label:<22} {_aic(r):.1f} AIC"
        return f"\u2717 {label:<22} {_clip(r.get('error') or 'error', 28)}"

    def _fmt_line(self, r: ProgressEvent) -> str:
        return format_agent_line(r)

    def _render(self, force: bool = False) -> None:
        if self._closed or not self.live:
            return
        now = time.time()
        if not force and (now - self._last_render) < 0.1:
            return
        self._last_render = now
        self._spin = (self._spin + 1) % len(_SPIN)
        try:
            width = shutil.get_terminal_size((100, 20)).columns
        except Exception:
            width = 100

        lines = [self._summary()]
        run_items = list(self._running.values())[: self.max_running]
        for r in run_items:
            age = int(now - (r.get("t") or now))
            lines.append(
                f"  {_SPIN[self._spin]} {_clip(r.get('label', 'agent'), 22):<22} "
                f"{_clip(r.get('model') or '', 16):<16} {age}s")
        extra = len(self._running) - len(run_items)
        if extra > 0:
            lines.append(f"  \u2026 +{extra} more running")
        for r in list(self._recent):
            lines.append("  " + self._fmt_done(r))

        lines = [_clip(ln, width) for ln in lines]
        self._blit(lines)

    def _blit(self, lines) -> None:
        buf = []
        if self._drawn:
            buf.append(f"\x1b[{self._drawn}A")  # cursor up to panel top
        buf.append("\x1b[0J")                      # clear from cursor to end of screen
        buf.append("\n".join(lines))
        buf.append("\n")
        self._drawn = len(lines)
        with suppress(Exception):
            self.stream.write("".join(buf))
            self.stream.flush()


def replay(path: str, follow: bool = True, reporter: ProgressReporter | None = None,
           poll: float = 0.2) -> ProgressReporter:
    """Feed a progress.jsonl into a reporter; optionally tail until run_end.

    Used by ``cwf watch``. Returns the reporter (already closed).
    """
    rep = reporter or ProgressReporter(live=None, write=False, title=os.path.basename(os.path.dirname(path)))
    ended = False
    try:
        with open(path, "r", encoding="utf-8") as fh:
            while True:
                line = fh.readline()
                if line:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    rep(rec)
                    if rec.get("ev") == "run_end":
                        ended = True
                        break
                else:
                    if not follow or ended:
                        break
                    time.sleep(poll)
    except FileNotFoundError:
        pass
    except KeyboardInterrupt:
        pass
    finally:
        rep.close()
    return rep
