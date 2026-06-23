"""Append-only, resumable cache of agent results (results.ndjson)."""
from __future__ import annotations

import json
import os
import threading
from dataclasses import asdict, fields
from typing import Dict, Optional

from .agent import AgentResult


def default_runs_dir() -> str:
    return os.environ.get("CWF_RUNS_DIR") or os.path.expanduser("~/.copilot/workflows/runs")


_RESULT_FIELDS = {f.name for f in fields(AgentResult)}


def _result_from_dict(data: dict) -> AgentResult:
    clean = {k: v for k, v in data.items() if k in _RESULT_FIELDS}
    return AgentResult(**clean)


class CheckpointStore:
    """Append-only, thread-safe cache of agent results keyed by a stable key."""

    def __init__(self, run_dir: str, resume: bool = False):
        self.run_dir = run_dir
        os.makedirs(run_dir, exist_ok=True)
        self._path = os.path.join(run_dir, "results.ndjson")
        self._lock = threading.Lock()
        self._cache: Dict[str, AgentResult] = {}
        self._prior_spent = 0.0
        if resume and os.path.isfile(self._path):
            self._load()

    def _load(self) -> None:
        with open(self._path) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                    key, data = rec["key"], rec["result"]
                    if key in self._cache:  # dedupe: first write wins
                        continue
                    result = _result_from_dict(data)
                except Exception:
                    continue
                result.cached = True
                self._cache[key] = result
                self._prior_spent += result.premium_requests

    @property
    def prior_spent(self) -> float:
        return self._prior_spent

    @property
    def count(self) -> int:
        with self._lock:
            return len(self._cache)

    def get(self, key: str) -> Optional[AgentResult]:
        with self._lock:
            return self._cache.get(key)

    def put(self, key: str, result: AgentResult) -> None:
        with self._lock:
            if key in self._cache:
                return
            self._cache[key] = result
            with open(self._path, "a") as fh:
                fh.write(json.dumps({"key": key, "result": asdict(result)}) + "\n")
                fh.flush()
