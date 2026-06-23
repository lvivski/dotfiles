"""Per-agent detached git worktrees: serialized, idempotent, auto-cleaned."""
from __future__ import annotations

import os
import re
import subprocess
import threading
from typing import List, Optional

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _git(args: List[str], cwd: str, check: bool = True) -> str:
    proc = subprocess.run(
        ["git"] + args, cwd=cwd,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if check and proc.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), proc.stderr.strip()))
    return proc.stdout.strip()


def find_repo_root(start: str) -> Optional[str]:
    try:
        return _git(["rev-parse", "--show-toplevel"], cwd=start)
    except Exception:
        return None


class WorktreeManager:
    def __init__(self, repo_root: str, base_dir: str, logger=None, base_ref: str = "HEAD"):
        self.repo_root = repo_root
        self.base_dir = base_dir
        self.base_ref = base_ref
        self._log = logger or (lambda *a, **k: None)
        self._lock = threading.Lock()
        self._created: List[str] = []

    def create(self, name: str, base_ref: Optional[str] = None) -> str:
        safe = _SAFE.sub("-", name).strip("-") or "wt"
        path = os.path.join(self.base_dir, safe)
        ref = base_ref or self.base_ref
        with self._lock:
            os.makedirs(self.base_dir, exist_ok=True)
            if os.path.exists(path):
                return path  # idempotent: resume reuses an existing worktree
            _git(["worktree", "add", "--detach", path, ref], cwd=self.repo_root)
            self._created.append(path)
            self._log("  worktree + %s" % os.path.basename(path))
        return path

    def remove(self, path: str) -> None:
        with self._lock:
            if path in self._created:
                self._created.remove(path)
            if not os.path.exists(path):
                return
            _git(["worktree", "remove", "--force", path], cwd=self.repo_root, check=False)
            self._log("  worktree - %s" % os.path.basename(path))

    def cleanup_all(self) -> None:
        for path in list(self._created):
            self.remove(path)
        _git(["worktree", "prune"], cwd=self.repo_root, check=False)
