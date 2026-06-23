"""Live progress panel + progress.ndjson persistence/replay for cwf runs."""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import threading
import time
from collections import deque
from typing import Optional

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


def format_agent_line(rec: dict) -> str:
    """One tidy line for a finished-agent record. Shared by the reporter's line
    mode and the Runtime's no-reporter fallback (single source of truth)."""
    label = _clip(rec.get("label", "agent"), 24)
    cr = float(rec.get("cr") or 0.0)
    if rec.get("cached"):
        return "  HIT  %-24s %.2f cr  (cached)" % (label, cr)
    if rec.get("skipped"):
        return "  SKIP %-24s (budget reached)" % label
    if rec.get("ok"):
        return "  OK   %-24s %.2f cr  %d tok  [%s]" % (
            label, cr, int(rec.get("tok") or 0), _san(rec.get("model") or ""))
    return "  ERR  %-24s ERROR: %s" % (label, _san(rec.get("error") or "?"))


class ProgressReporter:
    def __init__(
        self,
        stream=None,
        ndjson_path: Optional[str] = None,
        live: Optional[bool] = None,
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
        self._cr = 0.0
        self._tok = 0
        self._phase = None
        self._t0 = time.time()
        self._last_render = 0.0
        self._drawn = 0
        self._spin = 0
        self._closed = False

        self._fh = None
        if write and ndjson_path:
            try:
                os.makedirs(os.path.dirname(ndjson_path), exist_ok=True)
                self._fh = open(ndjson_path, "a")
            except Exception:
                self._fh = None

    # -- public ----------------------------------------------------------
    def __call__(self, rec: dict) -> None:
        with self._lock:
            if self._fh is not None:
                try:
                    self._fh.write(json.dumps(rec) + "\n")
                    self._fh.flush()
                except Exception:
                    pass
            self._apply(rec)
            try:
                if self.live:
                    self._render(force=rec.get("ev") in ("end", "run_end"))
                elif rec.get("ev") == "end":
                    self.stream.write(self._fmt_line(rec) + "\n")
                    self.stream.flush()
            except Exception:
                pass

    @property
    def stats(self) -> dict:
        with self._lock:
            return {
                "running": len(self._running), "done": self._done,
                "failed": self._failed, "cached": self._cached,
                "skipped": self._skipped, "cr": round(self._cr, 4), "tok": self._tok,
            }

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self.live and self._drawn:
                try:
                    self.stream.write("\n")
                    self.stream.flush()
                except Exception:
                    pass
            if self._fh is not None:
                try:
                    self._fh.close()
                except Exception:
                    pass

    # -- state -----------------------------------------------------------
    def _apply(self, rec: dict) -> None:
        ev = rec.get("ev")
        if ev == "start":
            self._running[rec.get("seq")] = rec
            if rec.get("phase"):
                self._phase = rec["phase"]
        elif ev == "end":
            self._running.pop(rec.get("seq"), None)
            self._cr += float(rec.get("cr") or 0.0)
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
            parts.append("phase: %s" % self._phase)
        parts.append("%ds" % el)
        parts.append("run %d" % len(self._running))
        parts.append("done %d" % self._done)
        if self._failed:
            parts.append("failed %d" % self._failed)
        if self._cached:
            parts.append("cached %d" % self._cached)
        if self._skipped:
            parts.append("skipped %d" % self._skipped)
        parts.append("%.2f cr" % self._cr)
        return " \u00b7 ".join(parts)

    def _fmt_done(self, r: dict) -> str:
        label = _clip(r.get("label", "agent"), 22)
        if r.get("cached"):
            return "\u21ba %-22s cached" % label
        if r.get("skipped"):
            return "\u2014 %-22s skipped" % label
        if r.get("ok"):
            return "\u2713 %-22s %.2f cr" % (label, float(r.get("cr") or 0))
        return "\u2717 %-22s %s" % (label, _clip(r.get("error") or "error", 28))

    def _fmt_line(self, r: dict) -> str:
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
            lines.append("  %s %-22s %-16s %ds" % (
                _SPIN[self._spin], _clip(r.get("label", "agent"), 22),
                _clip(r.get("model") or "", 16), age))
        extra = len(self._running) - len(run_items)
        if extra > 0:
            lines.append("  \u2026 +%d more running" % extra)
        for r in list(self._recent):
            lines.append("  " + self._fmt_done(r))

        lines = [_clip(ln, width) for ln in lines]
        self._blit(lines)

    def _blit(self, lines) -> None:
        buf = []
        if self._drawn:
            buf.append("\x1b[%dA" % self._drawn)  # cursor up to panel top
        buf.append("\x1b[0J")                      # clear from cursor to end of screen
        buf.append("\n".join(lines))
        buf.append("\n")
        self._drawn = len(lines)
        try:
            self.stream.write("".join(buf))
            self.stream.flush()
        except Exception:
            pass


def replay(path: str, follow: bool = True, reporter: Optional[ProgressReporter] = None,
           poll: float = 0.2) -> ProgressReporter:
    """Feed a progress.ndjson into a reporter; optionally tail until run_end.

    Used by ``cwf watch``. Returns the reporter (already closed).
    """
    rep = reporter or ProgressReporter(live=None, write=False, title=os.path.basename(os.path.dirname(path)))
    ended = False
    try:
        with open(path, "r") as fh:
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
