"""Per-agent detached git worktrees: serialized, idempotent, auto-cleaned."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _git(args: list[str], cwd: str, check: bool = True) -> str:
    proc = subprocess.run(
        ["git"] + args, cwd=cwd,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def find_repo_root(start: str) -> str | None:
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
        self._created: list[str] = []

    def create(self, name: str, base_ref: str | None = None) -> str:
        safe = _SAFE.sub("-", name).strip("-.") or "wt"  # strip dots too: "." / ".." alias base_dir
        path = os.path.join(self.base_dir, safe)
        real_base = os.path.realpath(self.base_dir)
        real_path = os.path.realpath(path)
        if real_path == real_base or not real_path.startswith(real_base + os.sep):
            raise RuntimeError(
                f"unsafe worktree name {name!r} resolves outside the worktree base")
        ref = base_ref or self.base_ref
        with self._lock:
            if path in self._created:
                raise RuntimeError(
                    f"worktree {name!r} is already active — use a unique name per concurrent branch")
            os.makedirs(self.base_dir, exist_ok=True)
            # A real worktree has a `.git` file at its root. Reuse a valid leftover from a
            # crashed run, but rebuild crash debris that isn't a worktree (a bare/partial dir).
            if os.path.exists(path) and not os.path.exists(os.path.join(path, ".git")):
                _git(["worktree", "remove", "--force", path], cwd=self.repo_root, check=False)
                shutil.rmtree(path, ignore_errors=True)
            if not os.path.exists(path):
                _git(["worktree", "add", "--detach", path, ref], cwd=self.repo_root)
            self._created.append(path)
            self._log(f"  worktree + {os.path.basename(path)}")
        return path

    def remove(self, path: str) -> None:
        with self._lock:
            if path in self._created:
                self._created.remove(path)
            if not os.path.exists(path):
                return
            _git(["worktree", "remove", "--force", path], cwd=self.repo_root, check=False)
            self._log(f"  worktree - {os.path.basename(path)}")

    def cleanup_all(self) -> None:
        for path in list(self._created):
            self.remove(path)
        _git(["worktree", "prune"], cwd=self.repo_root, check=False)
